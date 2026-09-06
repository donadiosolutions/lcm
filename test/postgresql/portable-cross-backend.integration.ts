import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PORTABLE_LIMITS, PORTABLE_RECORD_DOMAIN_ORDER, canonicalSha256, createPortableRecordStream,
  type PortableCheckpoint, type PortableDomain, type PortableManifest,
  type PortableRecord, type PortableRecordStream, type PortableRecordValueByDomain,
} from "../../src/storage/portable-record-stream.js";
import { runPortableTransfer, type PortableRecordWriter } from "../../src/storage/portable-transfer.js";
import { openSqlitePortableDestination } from "../../src/storage/sqlite/portable-destination.js";
import { openSqlitePortableSource, sqlitePortableFileSha256, type SqlitePortableIdentityFacts } from "../../src/storage/sqlite/portable-source.js";
import { createSqliteRepositories, createSqliteRepositoryStores } from "../../src/storage/sqlite/repositories.js";
import { createPostgreSqlPortableSource } from "../../src/storage/postgresql/portable-source.js";
import { createPostgreSqlPortableDestination } from "../../src/storage/postgresql/portable-destination.js";
import { PostgreSqlPromotedMemoryRepository } from "../../src/storage/postgresql/memory-repositories.js";
import type { StorageIdentityContext, PromotedMemoryRepository } from "../../src/storage/contracts.js";
import { seedPortableSqlite, SQLITE_PORTABLE_FIXTURE } from "../storage/sqlite-portable-fixture.js";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase, type PostgreSqlTestDatabase } from "./harness.js";
import { applyAllRuntimeGrants } from "./operational-fixture.js";
import { seedPortablePostgreSql } from "./portable-fixture.js";

beforeAll(assertHarnessReady);

const context = { domain: "factory", operation: "portableCrossBackendFixture" } as const;
const capturedAt = "2026-09-06T16:00:00.000000Z";
type Corpus = ReadonlyMap<PortableDomain, readonly PortableRecord[]>;

async function transferGrants(database: PostgreSqlTestDatabase): Promise<void> {
  await applyAllRuntimeGrants(database);
  const sql = readFileSync(join(process.cwd(), "src/storage/postgresql/reference/postgresql-transfer-grants.sql"), "utf8")
    .split("\n").filter(line => !line.startsWith("\\")).join("\n")
    .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await database.migrator.query({ text: sql }, context);
}

async function identityFacts(database: PostgreSqlTestDatabase, identity: StorageIdentityContext): Promise<SqlitePortableIdentityFacts> {
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

async function capture(source: PortableRecordStream): Promise<Corpus> {
  const manifest = source.describe();
  expect(manifest.domains.map(domain => domain.domain)).toEqual(PORTABLE_RECORD_DOMAIN_ORDER);
  expect(manifest.domains.every(domain => domain.recordCount > 0)).toBe(true);
  const corpus = new Map<PortableDomain, readonly PortableRecord[]>();
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    const records: PortableRecord[] = [];
    let after: PortableCheckpoint | undefined;
    do {
      const batch = await source.readBatch({ domain, after, maxRecords: 2, maxBytes: PORTABLE_LIMITS.maxBatchBytes });
      records.push(...batch.records);
      after = batch.checkpoint;
    } while (!after.complete);
    expect(records).toHaveLength(manifest.domains.find(entry => entry.domain === domain)!.recordCount);
    corpus.set(domain, records);
  }
  return corpus;
}

function domainValues<D extends PortableDomain>(corpus: Corpus, domain: D): readonly PortableRecordValueByDomain[D][] {
  return corpus.get(domain)!.map(record => record.value as PortableRecordValueByDomain[D]);
}

function expectEquivalent(actual: PortableManifest, expected: PortableManifest): void {
  expect(actual.contentSha256).toBe(expected.contentSha256);
  expect(actual.domains.map(({ domain, recordCount, prefixSha256 }) => ({ domain, recordCount, prefixSha256 })))
    .toEqual(expected.domains.map(({ domain, recordCount, prefixSha256 }) => ({ domain, recordCount, prefixSha256 })));
}

async function assertRuntimeMemory(repository: PromotedMemoryRepository, corpus: Corpus): Promise<void> {
  for (const memory of domainValues(corpus, "promoted-memories")) {
    const tags = domainValues(corpus, "promoted-memory-tags").filter(tag => tag.memoryId === memory.memoryId).map(tag => tag.tag);
    expect(await repository.getById(memory.memoryId)).toMatchObject({
      id: memory.memoryId, content: memory.content, metadata: memory.metadata, tags,
      sourceSummaryId: memory.sourceSummaryId, sessionId: memory.sessionId,
      depth: Number(memory.depth.$integer), confidence: memory.confidence,
    });
  }
}

async function assertSqliteReadback(path: string, identity: StorageIdentityContext, corpus: Corpus): Promise<void> {
  const source = await openSqlitePortableSource({ databasePath: path,
    projectIdentity: { scope: "shared", projectId: identity.id },
    expectedFileSha256: sqlitePortableFileSha256(path), capturedAt });
  const db = new DatabaseSync(path, { readOnly: true });
  const archive = source.recoveryArchive;
  try {
    const repositories = createSqliteRepositories(createSqliteRepositoryStores(db, { fts5Available: false }), identity.id,
      async (_domain, _operation, callback) => callback());
    await assertRuntimeMemory(repositories.promotedMemory, corpus);
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
    expect(db.prepare("SELECT count(*) AS n FROM messages").get()!.n).toBe(corpus.get("messages")!.length);
    expect(db.prepare("SELECT count(*) AS n FROM message_parts").get()!.n).toBe(corpus.get("message-parts")!.length);
    expect(db.prepare("SELECT count(*) AS n FROM portable_archive_native_transcripts").get()!.n).toBe(corpus.get("native-transcripts")!.length);
    for (const part of domainValues(corpus, "message-parts")) {
      expect(db.prepare("SELECT subtask_desc,metadata FROM message_parts WHERE part_id=?").get(part.partId))
        .toEqual({ subtask_desc: part.subtaskDescription, metadata: part.metadata });
    }
  } finally { db.close(); await source.close(); }
}

async function withOwnedHandles<T>(callback: (root: string, own: <H extends { close(): Promise<void> }>(handle: H) => H) => Promise<T>): Promise<T> {
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

async function pgSource(database: PostgreSqlTestDatabase, expectedIdentity: StorageIdentityContext): Promise<PortableRecordStream> {
  return createPortableRecordStream(await createPostgreSqlPortableSource({ settings: settings(database.runtimeUrl), expectedOwner: "lcm_test_migrator", expectedIdentity, admission: "transfer" }));
}
async function pgDestination(database: PostgreSqlTestDatabase, expectedIdentity: StorageIdentityContext, scratchParent: string): Promise<PortableRecordWriter> {
  return createPostgreSqlPortableDestination({ settings: settings(database.runtimeUrl), expectedOwner: "lcm_test_migrator", expectedIdentity,
    generationId: randomUUID(), runId: randomUUID(), scratchParent });
}
async function sqliteSource(path: string, expectedIdentity: StorageIdentityContext, scratchParent: string): Promise<PortableRecordStream> {
  return createPortableRecordStream(await openSqlitePortableSource({ databasePath: path,
    projectIdentity: { scope: "shared", projectId: expectedIdentity.id }, expectedFileSha256: sqlitePortableFileSha256(path), capturedAt, scratchParent }));
}

describe("PostgreSQL 18 and SQLite complete canonical transfer", { timeout: 120_000 }, () => {
  it("moves independently seeded PostgreSQL through SQLite archive into a fresh PostgreSQL database with all 22 hashes intact", async () => {
    await withPostgreSqlTestDatabase("portable-origin", async origin => {
      const fixture = await seedPortablePostgreSql(origin.migrator);
      await transferGrants(origin);
      await withPostgreSqlTestDatabase("portable-return", async target => {
        const registered = await seedPortablePostgreSql(target.migrator, { identityOnly: true });
        expect(registered.expectedIdentity).toEqual(fixture.expectedIdentity);
        await transferGrants(target);
        await withOwnedHandles(async (root, own) => {
          const source = own(await pgSource(origin, fixture.expectedIdentity));
          const expected = source.describe();
          const corpus = await capture(source);
          const path = join(root, "pg-import.sqlite");
          const destination = own(await openSqlitePortableDestination({ databasePath: path, mode: "create",
            projectIdentity: { scope: "shared", projectId: fixture.expectedIdentity.id }, generationIdentitySha256: canonicalSha256(randomUUID()), scratchParent: root }));
          expect((await runPortableTransfer({ source, destination, maxRecords: 2 })).contentSha256).toBe(expected.contentSha256);
          await assertSqliteReadback(path, fixture.expectedIdentity, corpus);
          const intermediate = own(await sqliteSource(path, fixture.expectedIdentity, root));
          expectEquivalent(intermediate.describe(), expected);
          const remote = own(await pgDestination(target, registered.expectedIdentity, root));
          expect((await runPortableTransfer({ source: intermediate, destination: remote, maxRecords: 2 })).contentSha256).toBe(expected.contentSha256);
          const readback = own(await pgSource(target, registered.expectedIdentity));
          expectEquivalent(readback.describe(), expected);
          await assertRuntimeMemory(new PostgreSqlPromotedMemoryRepository(target.runtime, registered.expectedIdentity.id), corpus);
          expect((await target.migrator.query({ text: "SELECT count(*)::int AS n FROM lcm.native_transcripts WHERE project_id=$1", values: [registered.expectedIdentity.id] }, context)).rows[0].n)
            .toBe(corpus.get("native-transcripts")!.length);
        });
      });
    });
  });

  it("moves independent native SQLite rows into PostgreSQL and back into a fresh SQLite archive", async () => {
    await withPostgreSqlTestDatabase("portable-from-sqlite", async target => {
      const fixture = await seedPortablePostgreSql(target.migrator, { identityOnly: true });
      await transferGrants(target);
      await withOwnedHandles(async (root, own) => {
        const path = join(root, "independent.sqlite");
        seedPortableSqlite(path, { projectIdentity: { scope: "shared", projectId: fixture.expectedIdentity.id }, identityFacts: await identityFacts(target, fixture.expectedIdentity) });
        const source = own(await sqliteSource(path, fixture.expectedIdentity, root));
        const expected = source.describe();
        const corpus = await capture(source);
        expect(domainValues(corpus, "messages")[0].tokenCount.$integer).toBe("9007199254740995");
        expect(domainValues(corpus, "message-parts")[0]).toMatchObject({ subtaskDescription: "exact subtask description", isIgnored: false, isSynthetic: true, compactionAuto: true });
        expect(domainValues(corpus, "promoted-memories")[0].createdAt).toBe(SQLITE_PORTABLE_FIXTURE.timestamp);
        const remote = own(await pgDestination(target, fixture.expectedIdentity, root));
        expect((await runPortableTransfer({ source, destination: remote, maxRecords: 2 })).contentSha256).toBe(expected.contentSha256);
        await assertRuntimeMemory(new PostgreSqlPromotedMemoryRepository(target.runtime, fixture.expectedIdentity.id), corpus);
        const intermediate = own(await pgSource(target, fixture.expectedIdentity));
        expectEquivalent(intermediate.describe(), expected);
        const finalPath = join(root, "returned.sqlite");
        const finalTarget = own(await openSqlitePortableDestination({ databasePath: finalPath, mode: "create", projectIdentity: { scope: "shared", projectId: fixture.expectedIdentity.id },
          generationIdentitySha256: canonicalSha256(randomUUID()), scratchParent: root }));
        expect((await runPortableTransfer({ source: intermediate, destination: finalTarget, maxRecords: 2 })).contentSha256).toBe(expected.contentSha256);
        await assertSqliteReadback(finalPath, fixture.expectedIdentity, corpus);
        const readback = own(await sqliteSource(finalPath, fixture.expectedIdentity, root));
        expectEquivalent(readback.describe(), expected);
        expect(await capture(readback)).toEqual(corpus);
      });
    });
  });
});
