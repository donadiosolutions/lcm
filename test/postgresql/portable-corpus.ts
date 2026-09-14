import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import {
  PORTABLE_LIMITS, PORTABLE_RECORD_DOMAIN_ORDER, PORTABLE_RECORD_SCHEMA_SHA256,
  PortableStreamError, PortableTransferError, canonicalJson, canonicalSha256,
  createPortableRecord, createPortableRecordStream, parsePortableCheckpoint,
  parsePortableManifest, parsePortableRecord, serializePortableCheckpoint,
  serializePortableManifest, serializePortableRecord, verifyPortableCheckpoint,
  openSqlitePortableSource, sqlitePortableFileSha256,
  createPostgreSqlPortableSource, createPostgreSqlPortableDestination,
  type PortableCheckpoint, type PortableDomain, type PortableManifest,
  type PortableRecord, type PortableRecordStream, type PortableRecordValueByDomain,
  type PortableRecordWriter, type SqlitePortableIdentityFacts,
} from "../../src/storage/portable.js";
import { createSqliteRepositories, createSqliteRepositoryStores } from "../../src/storage/sqlite/repositories.js";
import type { StorageIdentityContext, PromotedMemoryRepository } from "../../src/storage/contracts.js";
import { seedPortableSqlite, SQLITE_PORTABLE_FIXTURE } from "../storage/sqlite-portable-fixture.js";
import { settings, type PostgreSqlTestDatabase } from "./harness.js";
import { applyAllRuntimeGrants } from "./operational-fixture.js";

const context = { domain: "factory", operation: "portableCrossBackendFixture" } as const;
const capturedAt = "2026-09-06T16:00:00.000000Z";
type Corpus = ReadonlyMap<PortableDomain, readonly PortableRecord[]>;

export async function transferGrants(database: PostgreSqlTestDatabase): Promise<void> {
  await applyAllRuntimeGrants(database);
  const sql = readFileSync(join(process.cwd(), "src/storage/postgresql/reference/postgresql-transfer-grants.sql"), "utf8")
    .split("\n").filter(line => !line.startsWith("\\")).join("\n")
    .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await database.migrator.query({ text: sql }, context);
}

export async function identityFacts(database: PostgreSqlTestDatabase, identity: StorageIdentityContext): Promise<SqlitePortableIdentityFacts> {
  const machines = await database.migrator.query<{ identityKey: string; machineId: string }>({
    text: `SELECT DISTINCT m.identity_key AS "identityKey",m.machine_id::text AS "machineId"
      FROM lcm.machines m JOIN lcm.project_aliases a ON a.machine_id=m.machine_id
      WHERE a.project_id=$1 ORDER BY "identityKey"`, values: [identity.id],
  }, context);
  const aliases = await database.migrator.query<{ machineIdentityKey: string; path: string; normalizedPath: string }>({
    text: `SELECT m.identity_key AS "machineIdentityKey",a.path,a.normalized_path AS "normalizedPath"
      FROM lcm.project_aliases a JOIN lcm.machines m ON m.machine_id=a.machine_id
      WHERE a.project_id=$1 ORDER BY "machineIdentityKey","normalizedPath"`, values: [identity.id],
  }, context);
  return { machines: machines.rows, aliases: aliases.rows };
}

export async function capture(source: PortableRecordStream): Promise<Corpus> {
  const manifest = source.describe();
  expect(manifest.schemaSha256).toBe(PORTABLE_RECORD_SCHEMA_SHA256);
  expect(manifest.limits).toEqual(PORTABLE_LIMITS);
  expect(parsePortableManifest(serializePortableManifest(manifest))).toEqual(manifest);
  expect(canonicalSha256(manifest)).toBe(createHash("sha256").update(canonicalJson(manifest)).digest("hex"));
  expect(canonicalJson({ z: 1, a: [true, null] })).toBe('{"a":[true,null],"z":1}');
  expect(new PortableStreamError("checkpoint-mismatch")).toMatchObject({ code: "checkpoint-mismatch", retryable: false });
  expect(new PortableTransferError("destination-uncertain", true)).toMatchObject({ code: "destination-uncertain", retryable: true });
  expect(manifest.domains.map(domain => domain.domain)).toEqual(PORTABLE_RECORD_DOMAIN_ORDER);
  expect(manifest.domains.every(domain => domain.recordCount > 0)).toBe(true);
  const corpus = new Map<PortableDomain, readonly PortableRecord[]>();
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    const records: PortableRecord[] = [];
    let after: PortableCheckpoint | undefined;
    do {
      const batch = await source.readBatch({ domain, after, maxRecords: 2, maxBytes: PORTABLE_LIMITS.maxBatchBytes });
      for (const record of batch.records) {
        expect(parsePortableRecord(serializePortableRecord(record))).toEqual(record);
        if (record.domain === "machines") {
          expect(createPortableRecord({ domain: "machines", ordinal: record.ordinal,
            value: record.value as PortableRecordValueByDomain["machines"], context: null })).toEqual(record);
        }
      }
      expect(parsePortableCheckpoint(serializePortableCheckpoint(batch.checkpoint))).toEqual(batch.checkpoint);
      expect(verifyPortableCheckpoint(batch.checkpoint, manifest)).toEqual(batch.checkpoint);
      expect(() => verifyPortableCheckpoint({ ...batch.checkpoint, checkpointSha256: "0".repeat(64) }, manifest))
        .toThrow(PortableStreamError);
      records.push(...batch.records);
      after = batch.checkpoint;
    } while (!after.complete);
    expect(records).toHaveLength(manifest.domains.find(entry => entry.domain === domain)!.recordCount);
    corpus.set(domain, records);
  }
  return corpus;
}

export function domainValues<D extends PortableDomain>(corpus: Corpus, domain: D): readonly PortableRecordValueByDomain[D][] {
  return corpus.get(domain)!.map(record => record.value as PortableRecordValueByDomain[D]);
}

export function expectEquivalent(actual: PortableManifest, expected: PortableManifest): void {
  expect(actual.contentSha256).toBe(expected.contentSha256);
  expect(actual.domains.map(({ domain, recordCount, prefixSha256 }) => ({ domain, recordCount, prefixSha256 })))
    .toEqual(expected.domains.map(({ domain, recordCount, prefixSha256 }) => ({ domain, recordCount, prefixSha256 })));
}

export async function assertRuntimeMemory(repository: PromotedMemoryRepository, corpus: Corpus, ownProjectId: string): Promise<void> {
  for (const memory of domainValues(corpus, "promoted-memories")) {
    const tags = domainValues(corpus, "promoted-memory-tags").filter(tag => tag.memoryId === memory.memoryId).map(tag => tag.tag);
    expect(await repository.getById(memory.memoryId)).toMatchObject({
      id: memory.memoryId, content: memory.content, metadata: memory.metadata, tags,
      projectId: memory.sourceProjectId ?? ownProjectId,
      sourceSummaryId: memory.sourceSummaryId, sessionId: memory.sessionId,
      depth: Number(memory.depth.$integer), confidence: memory.confidence,
    });
  }
  const memories = domainValues(corpus, "promoted-memories");
  const activeOwn = memories.filter(memory => memory.sourceProjectId === null && memory.archivedAt === null);
  expect(activeOwn.length).toBeGreaterThan(0);
  expect((await repository.getAll({ sourceProjectId: ownProjectId })).map(memory => memory.id).sort())
    .toEqual(activeOwn.map(memory => memory.memoryId).sort());
  for (const memory of memories.filter(memory => memory.sourceProjectId !== null && memory.archivedAt === null)) {
    const filtered = await repository.getAll({ sourceProjectId: memory.sourceProjectId! });
    expect(filtered.map(row => row.id).sort()).toEqual(memories
      .filter(row => row.sourceProjectId === memory.sourceProjectId && row.archivedAt === null)
      .map(row => row.memoryId).sort());
    expect(filtered).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: memory.memoryId, projectId: memory.sourceProjectId }),
    ]));
  }
}

export async function assertSqliteReadback(path: string, identity: StorageIdentityContext, corpus: Corpus): Promise<void> {
  const source = await openSqlitePortableSource({ databasePath: path,
    projectIdentity: { scope: "shared", projectId: identity.id },
    expectedFileSha256: sqlitePortableFileSha256(path), capturedAt });
  const db = new DatabaseSync(path, { readOnly: true });
  const archive = source.recoveryArchive;
  try {
    const repositories = createSqliteRepositories(createSqliteRepositoryStores(db, { fts5Available: false }), identity.id,
      async (_domain, _operation, callback) => callback());
    await assertRuntimeMemory(repositories.promotedMemory, corpus, identity.id);
    expect(await archive.getProject()).toEqual(domainValues(corpus, "project")[0]);
    expect(await archive.listMachines({ limit: 500 })).toEqual(domainValues(corpus, "machines"));
    for (const machine of domainValues(corpus, "machines")) {
      const scope = { machineIdentityKey: machine.identityKey, limit: 500 };
      expect(await archive.listProjectAliases(scope)).toEqual(domainValues(corpus, "project-aliases").filter(row => row.machineIdentityKey === machine.identityKey));
      expect(await archive.listSessionInstructions(scope)).toEqual(domainValues(corpus, "session-instructions").filter(row => row.machineIdentityKey === machine.identityKey));
      expect(await archive.listPassiveEvents(scope)).toEqual(domainValues(corpus, "passive-events").filter(row => row.machineIdentityKey === machine.identityKey));
      const transcripts = domainValues(corpus, "native-transcripts").filter(row => row.machineIdentityKey === machine.identityKey);
      expect(await archive.listNativeTranscripts(scope)).toEqual(transcripts);
      for (const transcript of transcripts) {
        expect(await archive.getNativeTranscript({ machineIdentityKey: machine.identityKey, ingestKey: transcript.ingestKey })).toEqual(transcript);
        const record = corpus.get("native-transcripts")!.find(row => (row.value as typeof transcript).ingestKey === transcript.ingestKey
          && (row.value as typeof transcript).machineIdentityKey === machine.identityKey)!;
        expect(await archive.listNativeTranscriptLinks({ transcriptIdentitySha256: record.identitySha256, limit: 500 }))
          .toEqual(domainValues(corpus, "native-transcript-message-links").filter(row => row.machineIdentityKey === machine.identityKey && row.ingestKey === transcript.ingestKey));
      }
    }
    for (const checkpoint of domainValues(corpus, "native-transcript-checkpoints")) {
      expect(await archive.getNativeCheckpoint(checkpoint)).toEqual(checkpoint);
    }
    // These independent native queries prove the target contains usable typed
    // rows in addition to matching the canonical export hashes.
    const nativeTables: Record<PortableDomain, string> = {
      machines: "portable_archive_machines", project: "portable_archive_project",
      "project-aliases": "portable_archive_project_aliases", conversations: "conversations",
      messages: "messages", "message-parts": "message_parts", "large-files": "large_files",
      summaries: "summaries", "summary-file-links": "summaries, json_each(summaries.file_ids)",
      "summary-message-links": "summary_messages", "summary-parent-links": "summary_parents",
      "context-items": "context_items", "promoted-memories": "promoted",
      "promoted-memory-tags": "promoted, json_each(promoted.tags)", "recall-surfacings": "recall_surfacing",
      "redaction-counters": "redaction_stats", "session-ingest": "session_ingest_log",
      "session-instructions": "portable_archive_session_instructions",
      "native-transcripts": "portable_archive_native_transcripts",
      "native-transcript-message-links": "portable_archive_native_transcript_message_links",
      "native-transcript-checkpoints": "portable_archive_native_transcript_checkpoints",
      "passive-events": "portable_archive_passive_events",
    };
    for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${nativeTables[domain]}`).get()!.n, domain)
        .toBe(corpus.get(domain)!.length);
    }
    expect(db.prepare("SELECT count(*) AS n FROM messages").get()!.n).toBe(corpus.get("messages")!.length);
    expect(db.prepare("SELECT count(*) AS n FROM message_parts").get()!.n).toBe(corpus.get("message-parts")!.length);
    expect(db.prepare("SELECT count(*) AS n FROM portable_archive_native_transcripts").get()!.n).toBe(corpus.get("native-transcripts")!.length);
    for (const part of domainValues(corpus, "message-parts")) {
      expect(db.prepare("SELECT subtask_desc,metadata FROM message_parts WHERE part_id=?").get(part.partId))
        .toEqual({ subtask_desc: part.subtaskDescription, metadata: part.metadata });
    }
  } finally { db.close(); await source.close(); }
}

export function nativeCapturePaths(path: string, capture: ReturnType<typeof seedPortableSqlite>): string[] {
  const sidecars = capture.capturedSidecars!;
  if ("absent" in sidecars.events || !Array.isArray(sidecars.instructions)) throw new Error("native fixture sidecars required");
  return [path, sidecars.events.databasePath, ...sidecars.instructions.map(file => file.databasePath)];
}
export function nativeCaptureHashes(path: string, capture: ReturnType<typeof seedPortableSqlite>): string[] {
  return nativeCapturePaths(path, capture).map(file => {
    const digest = sqlitePortableFileSha256(file);
    expect(digest).toBe(createHash("sha256").update(readFileSync(file)).digest("hex"));
    return digest;
  });
}
export function assertNativeSqliteScope(path: string, capture: ReturnType<typeof seedPortableSqlite>): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'portable_archive_%'").all()).toEqual([]);
    for (const table of ["redaction_stats", "session_instruction_cache", "runtime_native_transcripts", "runtime_native_transcript_messages", "runtime_native_ingest_checkpoints"]) {
      expect(db.prepare(`SELECT project_id FROM ${table}`).all()).toEqual([{ project_id: capture.sourceLocalProjectId }]);
    }
    expect(db.prepare("SELECT project_id FROM promoted WHERE id=?").get(SQLITE_PORTABLE_FIXTURE.ownProjectMemoryId))
      .toEqual({ project_id: capture.sourceLocalProjectId });
    expect(db.prepare("SELECT project_id FROM promoted WHERE id=?").get(SQLITE_PORTABLE_FIXTURE.externalMemoryId))
      .toEqual({ project_id: SQLITE_PORTABLE_FIXTURE.externalProjectId });
  } finally { db.close(); }
  const instructions = capture.capturedSidecars!.instructions;
  if (!Array.isArray(instructions)) throw new Error("native fixture instruction sidecars required");
  for (const file of instructions) {
    const sidecar = new DatabaseSync(file.databasePath, { readOnly: true });
    try {
      expect(sidecar.prepare("SELECT project_id FROM session_instruction_cache").all()).toEqual([{ project_id: capture.sourceLocalProjectId }]);
    } finally { sidecar.close(); }
  }
}
export async function assertPostgreSqlNativeCounts(database: PostgreSqlTestDatabase, projectId: string, corpus: Corpus): Promise<void> {
  const tables: Record<Exclude<PortableDomain, "machines">, string> = {
    project: "projects", "project-aliases": "project_aliases", conversations: "conversations",
    messages: "messages", "message-parts": "message_parts", "large-files": "large_files",
    summaries: "summaries", "summary-file-links": "summary_large_files",
    "summary-message-links": "summary_messages", "summary-parent-links": "summary_parents",
    "context-items": "context_items", "promoted-memories": "promoted_memories",
    "promoted-memory-tags": "promoted_memory_tags", "recall-surfacings": "recall_surfacing",
    "redaction-counters": "redaction_counters", "session-ingest": "session_ingest_log",
    "session-instructions": "session_instructions", "native-transcripts": "native_transcripts",
    "native-transcript-message-links": "transcript_messages",
    "native-transcript-checkpoints": "ingest_checkpoints", "passive-events": "passive_event_inbox",
  };
  for (const [domain, table] of Object.entries(tables)) {
    expect((await database.migrator.query({ text: `SELECT count(*)::int AS n FROM lcm.${table} WHERE project_id=$1`, values: [projectId] }, context)).rows[0].n, domain)
      .toBe(corpus.get(domain as PortableDomain)!.length);
  }
  expect((await database.migrator.query({ text: "SELECT count(DISTINCT machine_id)::int AS n FROM lcm.project_aliases WHERE project_id=$1", values: [projectId] }, context)).rows[0].n)
    .toBe(corpus.get("machines")!.length);
}

export async function withOwnedHandles<T>(callback: (root: string, own: <H extends { close(): Promise<void> }>(handle: H) => H) => Promise<T>): Promise<T> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lcm-portable-cross-")));
  const handles: { close(): Promise<void> }[] = [];
  try { return await callback(root, handle => { handles.push(handle); return handle; }); }
  finally {
    const results = await Promise.allSettled(handles.reverse().map(handle => handle.close()));
    rmSync(root, { recursive: true, force: true });
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}

export async function pgSource(database: PostgreSqlTestDatabase, expectedIdentity: StorageIdentityContext): Promise<PortableRecordStream> {
  return createPortableRecordStream(await createPostgreSqlPortableSource({ settings: settings(database.runtimeUrl), expectedOwner: "lcm_test_migrator", expectedIdentity, admission: "transfer" }));
}
export async function pgDestination(database: PostgreSqlTestDatabase, expectedIdentity: StorageIdentityContext, scratchParent: string): Promise<PortableRecordWriter> {
  return createPostgreSqlPortableDestination({ settings: settings(database.runtimeUrl), expectedOwner: "lcm_test_migrator", expectedIdentity,
    generationId: randomUUID(), runId: randomUUID(), scratchParent });
}
export async function sqliteSource(path: string, expectedIdentity: StorageIdentityContext, scratchParent: string, nativeCapture?: ReturnType<typeof seedPortableSqlite>): Promise<PortableRecordStream> {
  expect(sqlitePortableFileSha256(path)).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
  return createPortableRecordStream(await openSqlitePortableSource({ ...nativeCapture, databasePath: path,
    projectIdentity: { scope: "shared", projectId: expectedIdentity.id }, expectedFileSha256: sqlitePortableFileSha256(path), capturedAt, scratchParent }));
}


/** Exact semantic probes shared by both independently seeded SQLite transfers. */
export function assertNativeSqliteCorpus(corpus: Corpus, nativeCapture: ReturnType<typeof seedPortableSqlite>): void {
  expect(domainValues(corpus, "messages")[0].tokenCount.$integer).toBe("9007199254740995");
  expect(domainValues(corpus, "message-parts")[0]).toMatchObject({ subtaskDescription: "exact subtask description", isIgnored: false, isSynthetic: true, compactionAuto: true });
  expect(domainValues(corpus, "promoted-memories")[0].createdAt).toBe(SQLITE_PORTABLE_FIXTURE.timestamp);
  expect(domainValues(corpus, "redaction-counters")).toHaveLength(1);
  expect(domainValues(corpus, "session-instructions")).toHaveLength(1 + nativeCapture.identityFacts!.machines.length);
  for (const domain of ["native-transcripts", "native-transcript-message-links", "native-transcript-checkpoints"] as const) {
    expect(domainValues(corpus, domain)).toHaveLength(1);
  }
  expect(domainValues(corpus, "promoted-memories")).toEqual(expect.arrayContaining([
    expect.objectContaining({ memoryId: SQLITE_PORTABLE_FIXTURE.ownProjectMemoryId, sourceProjectId: null }),
    expect.objectContaining({ memoryId: SQLITE_PORTABLE_FIXTURE.externalMemoryId, sourceProjectId: SQLITE_PORTABLE_FIXTURE.externalProjectId }),
  ]));
}
