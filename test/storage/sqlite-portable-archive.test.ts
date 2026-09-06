import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortableRecord, type PortableRecord, type PortableDomain } from "../../src/storage/portable-record.js";
import { buildRecords, postgresGeneration } from "../fixtures/portable-records.js";
import {
  initializePortableArchive, writePortableArchiveRecord, readArchiveDomain,
  readArchiveDomainRow, createSqlitePortableArchiveReader,
} from "../../src/storage/sqlite/portable-archive.js";

const databases: DatabaseSync[] = [];
const records = buildRecords(postgresGeneration());
const domains = ["machines", "project", "project-aliases", "session-instructions", "native-transcripts", "native-transcript-message-links", "native-transcript-checkpoints", "passive-events"] as const;
const fixture = <D extends PortableDomain>(domain: D) => records.get(domain)![0] as PortableRecord<D>;
function database(seed = true) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  initializePortableArchive(db);
  if (seed) for (const domain of domains) for (const record of records.get(domain)!) writePortableArchiveRecord(db, record);
  return db;
}
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });

describe("typed SQLite portable recovery archive", () => {
  it("preserves typed archive facts in SQL columns and reconstructs raw values", () => {
    const db = database();
    const row = db.prepare("SELECT clientName, nativePayload, sourceOrdinal FROM portable_archive_native_transcripts WHERE clientName = 'codex' LIMIT 1").get()!;
    expect(row.clientName).toBe("codex");
    expect(JSON.parse(row.nativePayload as string)).toEqual({ kind: "session", turns: [{ role: "user", text: "hello" }], meta: { scrubbed: true } });
    expect(row.sourceOrdinal).toBe(0);
    for (const domain of domains) {
      const output = [...readArchiveDomain(db, domain)];
      expect(output).toHaveLength(records.get(domain)!.length);
      for (const [i, value] of output.entries()) {
        expect(value.physicalIdentityKey).toBe(records.get(domain)![i].identitySha256);
        expect(readArchiveDomainRow(db, domain, value.physicalIdentityKey)).toEqual(value);
      }
    }
    expect(readArchiveDomainRow(db, "machines", "missing")).toBeUndefined();
  });

  it("returns canonical typed values through every scoped read method", async () => {
    const db = database();
    const reader = createSqlitePortableArchiveReader(db, () => {});
    const transcript = records.get("native-transcripts")!.find(r => "clientName" in r.value && r.value.clientName === "codex")! as PortableRecord<"native-transcripts">;
    const checkpoint = fixture("native-transcript-checkpoints").value;
    const machineIdentityKey = transcript.value.machineIdentityKey;
    expect(await reader.getProject()).toEqual(fixture("project").value);
    expect(await reader.listMachines({ limit: 500 })).toEqual(records.get("machines")!.map(r => r.value));
    expect(await reader.listProjectAliases({ machineIdentityKey, limit: 500 })).toEqual(records.get("project-aliases")!.map(r => r.value).filter(v => "machineIdentityKey" in v && v.machineIdentityKey === machineIdentityKey));
    expect(await reader.getNativeTranscript({ machineIdentityKey, ingestKey: transcript.value.ingestKey })).toEqual(transcript.value);
    expect(await reader.listNativeTranscripts({ machineIdentityKey, limit: 500 })).toEqual(records.get("native-transcripts")!.map(r => r.value));
    expect(await reader.listNativeTranscriptLinks({ transcriptIdentitySha256: transcript.identitySha256, limit: 500 })).toEqual(records.get("native-transcript-message-links")!.map(r => r.value));
    expect(await reader.getNativeCheckpoint({ machineIdentityKey, clientName: checkpoint.clientName, sourceLocator: checkpoint.sourceLocator })).toEqual(checkpoint);
    expect(await reader.listSessionInstructions({ machineIdentityKey, limit: 500 })).toEqual([fixture("session-instructions").value]);
    expect(await reader.listPassiveEvents({ machineIdentityKey, limit: 500 })).toEqual(records.get("passive-events")!.map(r => r.value).filter(v => "machineIdentityKey" in v && v.machineIdentityKey === machineIdentityKey));
    expect(await reader.getNativeTranscript({ machineIdentityKey: "other", ingestKey: transcript.value.ingestKey })).toBeUndefined();
    expect(await reader.getNativeCheckpoint({ machineIdentityKey: "other", clientName: checkpoint.clientName, sourceLocator: checkpoint.sourceLocator })).toBeUndefined();
  });

  it("paginates over more than 500 rows without losing signed or unsigned int64 precision", async () => {
    const db = database(false);
    const projectIdentity = fixture("project").value.identity;
    const base = fixture("passive-events").value;
    for (let i = 0; i < 503; i++) {
      writePortableArchiveRecord(db, createPortableRecord({ domain: "passive-events", ordinal: i,
        context: { projectIdentity }, value: { ...base, eventVersion: 1, sessionSequence: i, priority: -9007199254740991,
          machineSequence: 9007199254740993n + BigInt(i), eventId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` } }));
    }
    const reader = createSqlitePortableArchiveReader(db, () => {});
    const first = await reader.listPassiveEvents({ machineIdentityKey: base.machineIdentityKey, limit: 500 });
    expect(first).toHaveLength(500);
    expect(first[0].machineSequence).toEqual({ $integer: "9007199254740993" });
    expect(first[0].priority).toEqual({ $integer: "-9007199254740991" });
    const second = await reader.listPassiveEvents({ machineIdentityKey: base.machineIdentityKey, afterMachineSequence: first[499].machineSequence, limit: 500 });
    expect(second).toHaveLength(3);
    expect(second[2].machineSequence).toEqual({ $integer: "9007199254741495" });
    expect([...readArchiveDomain(db, "passive-events")]).toHaveLength(503);
  });

  it("enforces row and byte page limits, and refuses an oversized singleton", async () => {
    const reader = createSqlitePortableArchiveReader(database(), () => {});
    const machineIdentityKey = fixture("native-transcripts").value.machineIdentityKey;
    for (const limit of [0, -1, 501, 1.5, NaN]) {
      await expect(reader.listNativeTranscripts({ machineIdentityKey, limit })).rejects.toMatchObject({ code: "invalid-input" });
    }
    await expect(reader.listNativeTranscripts({ machineIdentityKey, limit: 1, maxBytes: 1 })).rejects.toMatchObject({ code: "unsupported-capability" });
    const first = await reader.listNativeTranscripts({ machineIdentityKey, limit: 1 });
    const next = await reader.listNativeTranscripts({ machineIdentityKey, after: first[0].ingestKey, limit: 1 });
    expect(next).toHaveLength(1);
    expect(next[0].ingestKey).not.toBe(first[0].ingestKey);
  });

  it("rechecks revocable authority and handles cancellation before and during reads", async () => {
    const db = database();
    let revoked = false;
    const reader = createSqlitePortableArchiveReader(db, () => { if (revoked) throw new Error("revoked"); });
    expect(await reader.getProject()).toBeDefined();
    revoked = true;
    await expect(reader.getProject()).rejects.toMatchObject({ code: "source-failed" });
    const controller = new AbortController();
    controller.abort();
    await expect(reader.getProject({ signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    const midway = new AbortController();
    let checks = 0;
    const aborting = createSqlitePortableArchiveReader(db, () => { if (++checks === 3) midway.abort(); });
    await expect(aborting.listMachines({ limit: 500, signal: midway.signal })).rejects.toMatchObject({ code: "aborted" });
  });
  it("rejects malformed integer cursors asynchronously and accepts exact integer cursor forms", async () => {
    const reader = createSqlitePortableArchiveReader(database(), () => {});
    const machineIdentityKey = fixture("passive-events").value.machineIdentityKey;
    for (const afterMachineSequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "-1", "01", "9223372036854775808", { $integer: "invalid" }] as const) {
      const result = reader.listPassiveEvents({ machineIdentityKey, afterMachineSequence: afterMachineSequence as never, limit: 1 });
      await expect(result).rejects.toMatchObject({ code: "invalid-input" });
    }
    for (const afterMachineSequence of [0, 0n, "0"]) {
      expect(await reader.listPassiveEvents({ machineIdentityKey, afterMachineSequence, limit: 500 })).toHaveLength(2);
    }
  });

  it("uses scoped keyset continuations for identities, aliases, instructions, and links", async () => {
    const reader = createSqlitePortableArchiveReader(database(), () => {});
    const machines = await reader.listMachines({ limit: 1 });
    const next = await reader.listMachines({ afterIdentityKey: machines[0].identityKey, limit: 500 });
    expect(next).toHaveLength(1);
    const machineIdentityKey = fixture("session-instructions").value.machineIdentityKey;
    const aliases = await reader.listProjectAliases({ machineIdentityKey, limit: 1 });
    expect(await reader.listProjectAliases({ machineIdentityKey, afterNormalizedPath: aliases[0].normalizedPath, limit: 500 })).toEqual([{ machineIdentityKey, normalizedPath: "/srv/repos/project/worktrees/feature", path: "/srv/Repos/Project/Worktrees/Feature" }]);
    const instructions = await reader.listSessionInstructions({ machineIdentityKey, limit: 1 });
    expect(await reader.listSessionInstructions({ machineIdentityKey, afterScopeHash: instructions[0].scopeHash, limit: 500 })).toEqual([]);
    const transcript = records.get("native-transcripts")!.find(r => "clientName" in r.value && r.value.clientName === "codex")!;
    const links = await reader.listNativeTranscriptLinks({ transcriptIdentitySha256: transcript.identitySha256, limit: 1 });
    expect(await reader.listNativeTranscriptLinks({ transcriptIdentitySha256: transcript.identitySha256, afterSourceOrdinal: links[0].sourceOrdinal, limit: 500 })).toHaveLength(1);
  });

  it("returns a byte-bounded prefix and rejects invalid byte limits", async () => {
    const db = database();
    const reader = createSqlitePortableArchiveReader(db, () => {});
    const first = (await reader.listMachines({ limit: 1 }))[0];
    const bytes = Buffer.byteLength(JSON.stringify(first));
    expect(await reader.listMachines({ limit: 500, maxBytes: bytes })).toEqual([first]);
    expect(await reader.listMachines({ limit: 500, maxBytes: bytes + 25 })).toEqual([first]);
    // The SQL text lower bound fits, but JSON keys and quoting do not.
    await expect(reader.listMachines({ limit: 1, maxBytes: bytes - 1 })).rejects.toMatchObject({ code: "unsupported-capability" });
    for (const maxBytes of [0, -1, 1.5, NaN, 151000000]) {
      await expect(reader.listMachines({ limit: 1, maxBytes })).rejects.toMatchObject({ code: "invalid-input" });
    }
    const empty = createSqlitePortableArchiveReader(database(false), () => {});
    expect(await empty.getProject()).toBeUndefined();
  });

  it("preserves null machine bindings and local project identity without installing sidecars", async () => {
    const db = database(false);
    writePortableArchiveRecord(db, createPortableRecord({ domain: "machines", ordinal: 0, context: null, value: { identityKey: "local-machine", machineId: null } }));
    writePortableArchiveRecord(db, createPortableRecord({ domain: "project", ordinal: 0, context: null, value: { identity: { scope: "local", projectId: "a".repeat(64) } } }));
    const reader = createSqlitePortableArchiveReader(db, () => {});
    expect(await reader.listMachines({ limit: 1 })).toEqual([{ identityKey: "local-machine", machineId: null }]);
    expect(await reader.getProject()).toEqual({ identity: { scope: "local", projectId: "a".repeat(64) } });
    expect(() => writePortableArchiveRecord(db, fixture("messages"))).toThrow(expect.objectContaining({ code: "unknown-domain" }));
  });

  it("rejects oversized SQL rows before loading their fields, including on point rereads", async () => {
    const db = database();
    db.prepare("UPDATE portable_archive_native_transcripts SET nativePayload = CAST(zeroblob(?) AS TEXT)").run(128 * 1024 * 1024 + 1);
    const transcript = fixture("native-transcripts");
    expect(() => [...readArchiveDomain(db, "native-transcripts")]).toThrow(expect.objectContaining({ code: "record-unrepresentable" }));
    expect(() => readArchiveDomainRow(db, "native-transcripts", transcript.identitySha256)).toThrow(expect.objectContaining({ code: "record-unrepresentable" }));
    const reader = createSqlitePortableArchiveReader(db, () => {});
    await expect(reader.listNativeTranscripts({ machineIdentityKey: transcript.value.machineIdentityKey, limit: 1 })).rejects.toMatchObject({ code: "unsupported-capability" });
  });

  it("detects a row removed between enumeration and content read", async () => {
    const db = database();
    let calls = 0;
    const reader = createSqlitePortableArchiveReader(db, () => {
      if (++calls === 2) db.exec("DELETE FROM portable_archive_machines");
    });
    await expect(reader.listMachines({ limit: 1 })).rejects.toMatchObject({ code: "source-changed" });
  });

  it("allows event-loop cancellation while enumerating a page", async () => {
    const db = database();
    const reader = createSqlitePortableArchiveReader(db, () => {});
    const controller = new AbortController();
    const pending = reader.listMachines({ limit: 500, signal: controller.signal });
    setImmediate(() => controller.abort());
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("sanitizes closed database, driver SQL, and malformed payload failures", async () => {
    const db = database();
    const reader = createSqlitePortableArchiveReader(db, () => {});
    db.exec("DROP TABLE portable_archive_machines; CREATE VIEW portable_archive_machines AS SELECT secret_sql_canary");
    const sqlError = await reader.listMachines({ limit: 1 }).catch(error => error as Error);
    expect(sqlError).toMatchObject({ name: "PortableTransferError", code: "source-failed" });
    expect(String(sqlError)).not.toContain("secret_sql_canary");
    expect(sqlError).not.toHaveProperty("cause");
    db.exec(`UPDATE portable_archive_native_transcripts SET nativePayload = 'secret_payload_canary'`);
    await expect(reader.listNativeTranscripts({ machineIdentityKey: fixture("native-transcripts").value.machineIdentityKey, limit: 1 })).rejects.toMatchObject({ name: "PortableTransferError", code: "source-failed" });
    db.close();
    databases.splice(databases.indexOf(db), 1);
    await expect(reader.getProject()).rejects.toMatchObject({ name: "PortableTransferError", code: "source-failed" });
  });

});


describe("archive TEXT NUL capability boundary", () => {
  it.each([
    ["machines", "identityKey"], ["machines", "machineId"], ["project", "projectId"],
    ["project-aliases", "path"], ["session-instructions", "content"],
    ["native-transcripts", "sourceLocator"], ["native-transcripts", "nativePayload"],
    ["native-transcript-message-links", "ingestKey"],
    ["native-transcript-checkpoints", "checkpoint"], ["passive-events", "data"],
    ["machines", "_identity_sha256"],
  ] as const)("refuses actual NUL in %s.%s before returning raw values", (domain, column) => {
    const db = database();
    const value = "prefix\0suffix";
    const table = `portable_archive_${domain.replaceAll("-", "_")}`;
    db.prepare(`UPDATE ${table} SET "${column}"=? WHERE _ordinal=0`).run(value);
    const observed = db.prepare(`SELECT length(CAST("${column}" AS BLOB)) AS bytes, "${column}" AS value FROM ${table} WHERE _ordinal=0`).get()!;
    expect(observed).toEqual({ bytes: Buffer.byteLength(value), value: "prefix" });
    const prepare = vi.spyOn(db, "prepare");
    expect(() => [...readArchiveDomain(db, domain)]).toThrow(expect.objectContaining({ code: "unsupported-capability" }));
    expect(() => readArchiveDomainRow(db, domain, column === "_identity_sha256" ? value : fixture(domain).identitySha256))
      .toThrow(expect.objectContaining({ code: "unsupported-capability" }));
    expect(prepare.mock.calls).toHaveLength(2);
    for (const [sql] of prepare.mock.calls) expect(sql).toContain(" AS _nul FROM ");
  });

  it("refuses actual NUL through scoped point and page readers", async () => {
    const db = database();
    db.prepare("UPDATE portable_archive_native_transcripts SET sourceLocator=?").run("prefix\0suffix");
    const reader = createSqlitePortableArchiveReader(db, () => {});
    const { machineIdentityKey, ingestKey } = fixture("native-transcripts").value;
    await expect(reader.getNativeTranscript({ machineIdentityKey, ingestKey })).rejects.toMatchObject({ code: "unsupported-capability" });
    await expect(reader.listNativeTranscripts({ machineIdentityKey, limit: 500 })).rejects.toMatchObject({ code: "unsupported-capability" });
  });

  it("preserves nested JSON NUL in raw helpers for canonical codec refusal", async () => {
    const db = database();
    const nested = { text: "prefix\0suffix", array: [{ literal: "\\u0000", nul: "\0" }] };
    for (const [domain, column] of [["native-transcripts", "nativePayload"], ["native-transcript-checkpoints", "checkpoint"]] as const) {
      db.prepare(`UPDATE portable_archive_${domain.replaceAll("-", "_")} SET ${column}=?`).run(JSON.stringify(nested));
      expect(readArchiveDomainRow(db, domain, fixture(domain).identitySha256)?.value[column]).toEqual(nested);
      expect([...readArchiveDomain(db, domain)][0].value[column]).toEqual(nested);
    }
    db.prepare("UPDATE portable_archive_passive_events SET data=?").run("prefix\\u0000suffix");
    expect([...readArchiveDomain(db, "passive-events")][0].value.data).toBe("prefix\\u0000suffix");
    const reader = createSqlitePortableArchiveReader(db, () => {});
    const transcript = fixture("native-transcripts").value;
    await expect(reader.getNativeTranscript(transcript)).rejects.toMatchObject({ code: "invalid-input" });
    await expect(reader.getNativeCheckpoint(fixture("native-transcript-checkpoints").value)).rejects.toMatchObject({ code: "invalid-input" });
  });
});
