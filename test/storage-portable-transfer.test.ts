import { describe, expect, test } from "vitest";
import { PortableStreamError } from "../src/storage/portable-record.js";
import { normalizePortableTransferError, PortableTransferError } from "../src/storage/portable-transfer.js";

describe("portable transfer errors", () => {
  test("sanitizes arbitrary source failures without driver causes", () => {
    const error = normalizePortableTransferError(new Error("postgres://secret SQL content"), "source-failed");
    expect(error).toBeInstanceOf(PortableTransferError);
    expect(error.code).toBe("source-failed");
    expect(error.retryable).toBe(false);
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(error.message).not.toContain("SQL");
    expect(error).not.toHaveProperty("cause");
  });
  test("normalizes known stream failures using the fixed retry policy", () => {
    const error = normalizePortableTransferError(new PortableStreamError("batch-limit-exceeded", { retryable: true }));
    expect(error.code).toBe("invalid-input");
    expect(error.retryable).toBe(false);
  });
});

import { runPortableTransfer } from "../src/storage/portable-transfer.js";
import type { PortableRecordWriter } from "../src/storage/portable-transfer.js";
import { createPortableRecordStream, PORTABLE_RECORD_DOMAIN_ORDER } from "../src/storage/portable-record-stream.js";
import type { PortableCheckpoint } from "../src/storage/portable-record-stream.js";
import { createGeneration, sqliteBoundGeneration } from "./fixtures/portable-records.js";

async function fixture() {
  const generation = createGeneration(sqliteBoundGeneration());
  const source = await createPortableRecordStream(generation.source);
  const manifest = source.describe();
  let checkpoints: PortableCheckpoint[] = [];
  let closed = false;
  const events: string[] = [];
  const destination: PortableRecordWriter = {
    async preflight(input, stream) {
      expect(input).toEqual(manifest);
      expect(stream.describe()).toEqual(manifest);
      events.push("preflight");
      return { manifestSha256: manifest.manifestSha256, destinationWitnessSha256: "b".repeat(64) };
    },
    async admit() { events.push("admit"); },
    async readProgress() {
      return { generationIdentitySha256: "a".repeat(64), manifestSha256: manifest.manifestSha256, checkpoints, complete: false };
    },
    async applyBatch(batch) {
      events.push(batch.domain);
      checkpoints = [...checkpoints.filter((cp) => cp.domain !== batch.domain), batch.checkpoint];
      return batch.checkpoint;
    },
    async verifyComplete(input) {
      return { manifestSha256: input.manifestSha256, contentSha256: input.contentSha256,
        domains: input.domains.map(({ domain, recordCount, prefixSha256 }) => ({ domain, recordCount, prefixSha256 })), complete: true };
    },
    async close() { closed = true; },
  };
  return { source, destination, manifest, events, closed: () => closed, sourceClosed: generation.source.closed };
}

describe("portable transfer runner", () => {
  test("preflights before mutation and acknowledges all 22 domains", async () => {
    const f = await fixture();
    const progress: string[] = [];
    const result = await runPortableTransfer({ ...f, maxRecords: 1, onProgress: (item) => progress.push(item.domain) });
    expect(f.events.slice(0, 2)).toEqual(["preflight", "admit"]);
    expect(result.checkpoints.map((cp) => cp.domain)).toEqual(PORTABLE_RECORD_DOMAIN_ORDER);
    expect(result.checkpoints.every((cp) => cp.complete)).toBe(true);
    expect(result.recordCount).toBe(f.manifest.domains.reduce((sum, d) => sum + d.recordCount, 0));
    expect(progress.length).toBeGreaterThan(22);
    expect(f.closed()).toBe(true);
    expect(f.sourceClosed()).toBe(true);
  });
  test("closes both handles when preflight refuses without admission", async () => {
    const f = await fixture();
    f.destination.preflight = async () => { throw new PortableTransferError("unsupported-capability"); };
    await expect(runPortableTransfer(f)).rejects.toMatchObject({ code: "unsupported-capability" });
    expect(f.events).toEqual([]);
    expect(f.closed()).toBe(true);
    expect(f.sourceClosed()).toBe(true);
  });
  test("rejects noncontiguous durable progress before applying a batch", async () => {
    const f = await fixture();
    const batch = await f.source.readBatch({domain: "project", maxRecords: 500, maxBytes: 150994944});
    f.destination.readProgress = async () => ({generationIdentitySha256:"a".repeat(64),manifestSha256:f.manifest.manifestSha256, checkpoints:[batch.checkpoint],complete:false});
    await expect(runPortableTransfer(f)).rejects.toMatchObject({code:"checkpoint-mismatch"});
    expect(f.events).toEqual(["preflight","admit"]);
  });
  test("never advances an uncertain destination acknowledgement", async () => {
    const f = await fixture();
    f.destination.applyBatch = async () => { throw new PortableTransferError("destination-uncertain", true); };
    const progress: string[] = [];
    await expect(runPortableTransfer({...f,onProgress:item=>progress.push(item.domain)})).rejects.toMatchObject({code:"destination-uncertain",retryable:true});
    expect(progress).toEqual([]);
  });
  test("preserves primary error when both handles fail cleanup", async () => {
    const f = await fixture();
    const source = {...f.source, close: async () => {throw new Error("source secret")}};
    f.destination.close = async () => {throw new Error("destination secret")};
    f.destination.admit = async () => {throw new PortableTransferError("destination-conflict")};
    await expect(runPortableTransfer({...f, source})).rejects.toMatchObject({code:"destination-conflict"});
  });
  test("fails sanitized when final SQL readback differs", async () => {
    const f = await fixture();
    const verify = f.destination.verifyComplete;
    f.destination.verifyComplete = async (manifest) => ({...await verify(manifest),contentSha256:"f".repeat(64)});
    await expect(runPortableTransfer(f)).rejects.toMatchObject({code:"verification-failed"});
  });
  test("validates limits and aborts before any admission while still closing", async () => {
    for (const options of [{maxRecords:0}, {maxBytes:0}, {signal:AbortSignal.abort()}]) {
      const f = await fixture();
      await expect(runPortableTransfer({...f,...options})).rejects.toBeInstanceOf(PortableTransferError);
      expect(f.events).toEqual([]);
      expect(f.closed()).toBe(true);
    }
  });
});

import { validatePortableTransferBatch } from "../src/storage/portable-transfer.js";
import type { PortableStreamErrorCode } from "../src/storage/portable-record.js";

test("normalizes every stream error code exhaustively", () => {
  const expected: Record<PortableStreamErrorCode, readonly [string, boolean]> = {
    "unsupported-version":["unsupported-capability",false], "unknown-domain":["invalid-input",false],
    "malformed-record":["invalid-input",false], "record-unrepresentable":["unsupported-capability",false],
    "duplicate-identity":["invalid-input",false], "order-regression":["invalid-input",false],
    "dependency-order":["invalid-input",false], "malformed-manifest":["invalid-input",false],
    "incompatible-schema":["unsupported-capability",false], "invalid-limit":["invalid-input",false],
    "batch-limit-exceeded":["invalid-input",false], "checkpoint-mismatch":["checkpoint-mismatch",false],
    "partial-batch":["checkpoint-mismatch",false], "source-changed":["source-changed",false],
    "source-invalid":["source-failed",false], "source-unavailable":["source-failed",true],
    "aborted":["aborted",true], "closed":["source-failed",false],
  };
  for (const [code,[mapped,retryable]] of Object.entries(expected)) {
    expect(normalizePortableTransferError(new PortableStreamError(code as PortableStreamErrorCode))).toMatchObject({code:mapped,retryable});
  }
  expect(new PortableTransferError("secret" as never, true)).toMatchObject({code:"invalid-input",retryable:false});
  expect(new PortableTransferError("destination-conflict",true).retryable).toBe(false);
});

test("validates batch records, contiguous ordinals, framing and chain before writes", async () => {
  const f = await fixture();
  const first = await f.source.readBatch({domain:"messages",maxRecords:2,maxBytes:150994944});
  const next = await f.source.readBatch({domain:"messages",after:first.checkpoint,maxRecords:2,maxBytes:150994944});
  expect(validatePortableTransferBatch(first,f.manifest)).toEqual(first);
  expect(validatePortableTransferBatch(next,f.manifest,first.checkpoint)).toEqual(next);
  const mutations = [
    {...first,version:2}, {...first,manifestSha256:"a".repeat(64)},
    {...first,domain:"conversations"}, {...first,priorCheckpointSha256:"a".repeat(64)},
    {...first,complete:!first.complete}, {...first,records:null},
    {...first,records:Array(501).fill(first.records[0])},
    {...first,records:[],complete:false}, {...first,framedBytes:0},
    {...first,records:[...first.records].reverse()},
    {...first,records:[first.records[0],first.records[0]]},
    {...first,records:[first.records[0]]},
    {...first,checkpoint:{...first.checkpoint,prefixSha256:"a".repeat(64)}},
  ];
  for (const batch of mutations) {
    expect(()=>validatePortableTransferBatch(batch as never,f.manifest)).toThrow(PortableTransferError);
  }
  expect(()=>validatePortableTransferBatch(next,f.manifest)).toThrow(PortableTransferError);
  expect(()=>validatePortableTransferBatch(first,f.manifest,first.checkpoint)).toThrow(PortableTransferError);
  await f.source.close();
});

test("resumes exact persisted prefixes without repeating acknowledged writes", async () => {
  const f = await fixture();
  const first = await f.source.readBatch({domain:"machines",maxRecords:1,maxBytes:150994944});
  f.destination.readProgress = async () => ({generationIdentitySha256:"a".repeat(64),manifestSha256:f.manifest.manifestSha256,checkpoints:[first.checkpoint],complete:false});
  const result = await runPortableTransfer(f);
  expect(result.checkpoints).toHaveLength(22);
  expect(f.events.filter(x=>x==="machines")).toHaveLength(1);
});

test("checks completed progress and still verifies fully completed targets", async () => {
  const f = await fixture();
  const checkpoints = await Promise.all(PORTABLE_RECORD_DOMAIN_ORDER.map(async domain => (await f.source.readBatch({domain,maxRecords:500,maxBytes:150994944})).checkpoint));
  f.destination.readProgress = async () => ({generationIdentitySha256:"a".repeat(64),manifestSha256:f.manifest.manifestSha256,checkpoints,complete:true});
  await runPortableTransfer(f);
  expect(f.events).toEqual(["preflight","admit"]);
});

test("rejects malformed durable states", async () => {
  for (const mutation of [
    {generationIdentitySha256:"secret"}, {manifestSha256:"a".repeat(64)},
    {checkpoints:null}, {checkpoints:Array(23).fill(null)}, {complete:1}, {complete:true},
  ]) {
    const f=await fixture();
    f.destination.readProgress=async()=>({generationIdentitySha256:"a".repeat(64),manifestSha256:f.manifest.manifestSha256,checkpoints:[],complete:false,...mutation} as never);
    await expect(runPortableTransfer(f)).rejects.toMatchObject({code:"checkpoint-mismatch"});
  }
});

test("rejects acknowledgement drift and unrequested source domains", async () => {
  const f=await fixture();
  const other=await f.source.readBatch({domain:"project",maxRecords:500,maxBytes:150994944});
  f.destination.applyBatch=async()=>other.checkpoint;
  await expect(runPortableTransfer(f)).rejects.toMatchObject({code:"checkpoint-mismatch"});
  const g=await fixture();
  const source={...g.source,readBatch:async()=>other};
  g.destination.preflight=async()=>({manifestSha256:g.manifest.manifestSha256,destinationWitnessSha256:"a".repeat(64)});
  await expect(runPortableTransfer({...g,source})).rejects.toMatchObject({code:"invalid-input"});
});

test("successful data verification with failed cleanup is not reported as success", async () => {
  const f=await fixture();
  f.destination.close=async()=>{throw new Error("SQL password")};
  await expect(runPortableTransfer(f)).rejects.toMatchObject({code:"close-failed",retryable:false});
  expect(f.sourceClosed()).toBe(true);
});

test("sanitizes callback and ordinary source failures and closes both handles", async () => {
  const f=await fixture();
  await expect(runPortableTransfer({...f,onProgress:()=>{throw new Error("private source content")}})).rejects.toMatchObject({code:"destination-failed",retryable:false});
  const g=await fixture();
  const source={...g.source,describe:()=>{throw new Error("private SQL")}};
  await expect(runPortableTransfer({...g,source})).rejects.toMatchObject({code:"source-failed"});
  expect(g.closed()).toBe(true);
});

import { createFixtureSource } from "./fixtures/portable-records.js";
test("writes durable terminal checkpoints for every empty domain", async () => {
  const f=await fixture();
  const generation=createGeneration(sqliteBoundGeneration());
  const source=await createPortableRecordStream(createFixtureSource({description:generation.description,records:new Map(PORTABLE_RECORD_DOMAIN_ORDER.map(domain=>[domain,PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain)<3?generation.records.get(domain)!:[]]))}));
  const manifest=source.describe();
  f.destination.preflight=async()=>({manifestSha256:manifest.manifestSha256,destinationWitnessSha256:"a".repeat(64)});
  f.destination.readProgress=async()=>({generationIdentitySha256:"a".repeat(64),manifestSha256:manifest.manifestSha256,checkpoints:[],complete:false});
  const result=await runPortableTransfer({...f,source});
  expect(result.recordCount).toBe(6);
  expect(result.checkpoints.slice(3).every(checkpoint=>checkpoint.complete&&checkpoint.nextOrdinal===0)).toBe(true);
  await f.source.close();
});

test("rejects a source verification response that does not authenticate the requested boundary", async () => {
  const f=await fixture();
  const source={...f.source,verify:async(checkpoint:PortableCheckpoint)=>({...await f.source.verify(checkpoint),authoritative:false as true})};
  f.destination.preflight=async()=>({manifestSha256:f.manifest.manifestSha256,destinationWitnessSha256:"a".repeat(64)});
  await expect(runPortableTransfer({...f,source})).rejects.toMatchObject({code:"verification-failed"});
  expect(f.events).toEqual(["admit"]);
});

test("rejects sparse final domain verification rather than trusting aggregate hashes", async () => {
  const f=await fixture();
  f.destination.verifyComplete=async manifest=>({manifestSha256:manifest.manifestSha256,contentSha256:manifest.contentSha256,domains:new Array(22),complete:true});
  await expect(runPortableTransfer(f)).rejects.toMatchObject({code:"verification-failed"});
});

test("unknown or hostile driver error code properties cannot bypass cleanup", async () => {
  for (const code of ["not-known","__proto__"]) {
    const f=await fixture();
    const error=new PortableStreamError("source-unavailable");
    Object.defineProperty(error,"code",{value:code});
    f.destination.admit=async()=>{throw error};
    await expect(runPortableTransfer(f)).rejects.toMatchObject({code:"destination-failed",retryable:false});
    expect(f.closed()).toBe(true);
    expect(f.sourceClosed()).toBe(true);
  }
  const error=new PortableStreamError("source-unavailable");
  Object.defineProperty(error,"code",{get(){throw new Error("password")}});
  expect(normalizePortableTransferError(error)).toMatchObject({code:"destination-failed"});
});
