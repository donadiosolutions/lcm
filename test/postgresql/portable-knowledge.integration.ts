import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  EXPORT_VERSION,
  exportKnowledge,
  importKnowledge,
  type ExportDocument,
  type ExportEntry,
} from "../../src/portable-knowledge.js";
import { StorageIdentityConfigurationError, UNBOUND_POSTGRESQL_PROJECT_MESSAGE } from "../../src/storage/identity-context.js";
import { StorageOperationError } from "../../src/storage/errors.js";
import { PostgreSqlPromotedMemoryRepository } from "../../src/storage/postgresql/memory-repositories.js";
import { PostgreSqlIdentityRepository } from "../../src/storage/postgresql/identity-repository.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase } from "./harness.js";
import { withCliProjectStorage } from "../../src/cli-storage.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createDaemon } from "../../src/daemon/server.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { hashProjectPath } from "../../src/project-map.js";
import { createPostgreSqlPortableSource } from "../../src/storage/postgresql/portable-source.js";
import { createPostgreSqlPortableDestination } from "../../src/storage/postgresql/portable-destination.js";
import { openSqlitePortableDestination } from "../../src/storage/sqlite/portable-destination.js";
import { openSqlitePortableSource, sqlitePortableFileSha256 } from "../../src/storage/sqlite/portable-source.js";
import { createPortableRecordStream, canonicalSha256, PORTABLE_LIMITS, type PortableRecordStream } from "../../src/storage/portable-record-stream.js";
import { runPortableTransfer, type PortableRecordWriter } from "../../src/storage/portable-transfer.js";
import { grantPortablePostgreSql } from "./portable-fixture.js";
import {
  restoreRuntimeGrants,
  withSelectedPostgreSqlProject,
  type SelectedPostgreSqlProject,
} from "./operational-fixture.js";

beforeAll(assertHarnessReady);

const DIGEST_KEY = "lcm.portableKnowledge.v1.entryDigests";

function entry(content: string, tags: string[] = []): ExportEntry {
  return {
    content,
    tags,
    confidence: 0.8,
    createdAt: "2026-01-01T00:00:00.000Z",
    sessionId: "source-session",
  };
}

function document(entries: ExportEntry[]): ExportDocument {
  return {
    version: 1,
    exportedAt: "2026-01-02T00:00:00.000Z",
    projectCwd: "/portable/source-project",
    entries,
  };
}

/** Mirrors importKnowledge's retry-identity digest formula for assertions. */
function computeEntryDigest(doc: ExportDocument, ordinal: number): string {
  const source = doc.entries[ordinal];
  return createHash("sha256").update(JSON.stringify([
    EXPORT_VERSION, doc.projectCwd, ordinal, source.content, source.tags,
    source.confidence, source.createdAt, source.sessionId,
  ])).digest("hex");
}

async function persistedRowsFor(administrator: PostgreSqlRuntime, projectId: string) {
  const result = await administrator.query<{
    memory_id: string;
    content: string;
    confidence: number;
    metadata: Record<string, unknown>;
    archived_at: Date | null;
    tags: string[];
  }>({
    text: `SELECT memory_id, content, confidence, metadata, archived_at,
                  ARRAY(SELECT tag FROM lcm.promoted_memory_tags tags
                         WHERE tags.project_id = memories.project_id
                           AND tags.memory_id = memories.memory_id
                         ORDER BY ordinal) AS tags
             FROM lcm.promoted_memories memories
            WHERE project_id = $1 ORDER BY memory_id`,
    values: [projectId],
  }, { domain: "promoted-memory", operation: "verifyKnowledgeImport" });
  return result.rows;
}

async function persistedRows(fixture: SelectedPostgreSqlProject) {
  return persistedRowsFor(fixture.administrator, fixture.project.projectId);
}

const PROMOTED_CONTENT = "Orchard pruning architecture decision for perennial fruit trees";

/** Exercise the ordinary HTTP promotion route, including selected storage admission. */
async function promoteNormally(fixture: SelectedPostgreSqlProject): Promise<string> {
  await withCliProjectStorage(fixture.projectPath, {}, async ({ storage }) => {
    const conversation = await storage.conversations.createConversation({ sessionId: "knowledge-promotion" });
    await storage.summaries.insertSummary({
      conversationId: conversation.conversationId, summaryId: "knowledge-promotion-summary",
      kind: "condensed", depth: 2, content: PROMOTED_CONTENT,
      tokenCount: 12, sourceMessageTokenCount: 100,
    });
  });
  const configPath = join(fixture.homeDir, ".lcm", "config.json");
  const config = loadDaemonConfig(configPath, {
    daemon: { port: 0, idleTimeoutMs: 0 }, summarizer: { mock: true },
  });
  const daemon = await createDaemon(config, { publicationConfigPath: configPath });
  try {
    const client = new DaemonClient(`http://127.0.0.1:${daemon.address().port}`);
    await expect(client.post("/promote", { cwd: fixture.projectPath }))
      .resolves.toMatchObject({ processed: 1, promoted: 1 });
  } finally { await daemon.stop(); }
  const rows = await fixture.administrator.query<{ memory_id: string; source_project_id: string }>({
    text: "SELECT memory_id, source_project_id FROM lcm.promoted_memories WHERE project_id=$1",
    values: [fixture.project.projectId],
  }, { domain: "promoted-memory", operation: "verifyNormalPromotion" });
  expect(rows.rows).toEqual([{ memory_id: expect.any(String), source_project_id: hashProjectPath(fixture.projectPath) }]);
  expect(hashProjectPath(fixture.projectPath)).not.toBe(fixture.project.projectId);
  return rows.rows[0].memory_id;
}

describe("PostgreSQL 18 portable knowledge v1", { timeout: 120_000 }, () => {
  it("exports normal public promotions from the bound PostgreSQL owner project", async () => {
    await withSelectedPostgreSqlProject("knowledge-normal-export", async fixture => {
      await promoteNormally(fixture);
      const output = join(fixture.projectRoot, "normal.json");
      await expect(exportKnowledge(fixture.projectPath, { output, skipScrub: true }))
        .resolves.toMatchObject({ exported: 1 });
      expect((JSON.parse(readFileSync(output, "utf8")) as ExportDocument).entries)
        .toEqual([expect.objectContaining({ content: PROMOTED_CONTENT, sessionId: null })]);
    });
  });

  it("merges imported knowledge into a normal public promotion and preserves retry metadata", async () => {
    await withSelectedPostgreSqlProject("knowledge-normal-dedup", async fixture => {
      const id = await promoteNormally(fixture);
      await new PostgreSqlPromotedMemoryRepository(fixture.database.runtime, fixture.project.projectId)
        .update(id, { metadata: { promotionNote: "retain normal promotion metadata" } });
      const source = document([entry(PROMOTED_CONTENT, ["imported"])]);
      await expect(importKnowledge(fixture.projectPath, source)).resolves.toMatchObject({ imported: 1, skipped: 0 });
      const rows = await persistedRows(fixture);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ memory_id: id, tags: expect.arrayContaining(["imported"]),
        metadata: { promotionNote: "retain normal promotion metadata", [DIGEST_KEY]: [expect.stringMatching(/^[a-f0-9]{64}$/u)] } });
      await expect(importKnowledge(fixture.projectPath, source)).resolves.toMatchObject({ imported: 0, skipped: 1 });
      expect(await persistedRows(fixture)).toEqual(rows);
    });
  });

  it("merges an owner exact row omitted by a saturated fuzzy page", async () => {
    await withSelectedPostgreSqlProject("knowledge-saturated-exact", async fixture => {
      const repository = new PostgreSqlPromotedMemoryRepository(
        fixture.database.runtime,
        fixture.project.projectId,
      );
      const content = "alpha beta gamma";
      const exactId = await repository.insert({
        content,
        tags: ["existing"],
        sourceProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9031",
        metadata: { canonicalNote: "retain exact metadata" },
        confidence: 0.6,
      });
      const otherOwnerPath = join(fixture.projectRoot, "other-owner");
      mkdirSync(otherOwnerPath);
      const otherProject = await new PostgreSqlIdentityRepository(fixture.database.migrator).createProject({
        machineId: fixture.machine.machineId,
        displayName: "PostgreSQL saturation isolation project",
        path: otherOwnerPath,
        normalizedPath: otherOwnerPath,
      });
      const otherRepository = new PostgreSqlPromotedMemoryRepository(
        fixture.database.runtime,
        otherProject.projectId,
      );
      const otherOwnerId = await otherRepository.insert({
        content,
        tags: ["other-owner"],
        confidence: 0.4,
      });
      const otherOwnerBefore = await persistedRowsFor(fixture.administrator, otherProject.projectId);
      expect(otherOwnerBefore).toEqual([expect.objectContaining({
        memory_id: otherOwnerId,
        tags: ["other-owner"],
      })]);
      for (let index = 0; index < 100; index += 1) {
        await repository.insert({
          content: `${content} !${index}`,
          tags: ["fuzzy"],
          sourceProjectId: `018f22c4-6d2a-7f10-8a4c-6b8d3e5f9${String(index + 100).padStart(3, "0")}`,
          confidence: 0.2,
        });
      }
      await withCliProjectStorage(fixture.projectPath, {}, async ({ storage }) => {
        const page = await storage.lexicalSearch.searchPromoted(content, 100, undefined, undefined);
        expect(page).toHaveLength(100);
        expect(page.some(candidate => candidate.id === exactId)).toBe(false);
      });

      const source = document([entry(content, ["imported"])]);
      const rollbackFailure = new StorageOperationError(
        "STORAGE_OPERATION_FAILED",
        "postgresql",
        fixture.project.projectId,
        "promoted-memory",
        "update",
      );
      const failingUpdate = vi.spyOn(PostgreSqlPromotedMemoryRepository.prototype, "update")
        .mockRejectedValueOnce(rollbackFailure);
      await expect(importKnowledge(fixture.projectPath, source)).rejects.toBe(rollbackFailure);
      expect(rollbackFailure).toMatchObject({
        code: "STORAGE_OPERATION_FAILED",
        backend: "postgresql",
        projectId: fixture.project.projectId,
        domain: "promoted-memory",
        operation: "update",
      });
      failingUpdate.mockRestore();
      expect(await persistedRows(fixture)).toHaveLength(101);
      expect((await persistedRows(fixture)).find(row => row.memory_id === exactId))
        .toMatchObject({
          tags: ["existing"],
          metadata: { canonicalNote: "retain exact metadata" },
        });
      expect(await persistedRowsFor(fixture.administrator, otherProject.projectId))
        .toEqual(otherOwnerBefore);

      await expect(importKnowledge(fixture.projectPath, source)).resolves.toMatchObject({
        imported: 1,
        skipped: 0,
      });
      const rows = await persistedRows(fixture);
      expect(rows.filter(row => row.content === content)).toHaveLength(1);
      expect(rows.find(row => row.memory_id === exactId)).toMatchObject({
        memory_id: exactId,
        tags: expect.arrayContaining(["existing", "imported"]),
        confidence: 0.8,
        metadata: {
          canonicalNote: "retain exact metadata",
          [DIGEST_KEY]: [expect.stringMatching(/^[a-f0-9]{64}$/u)],
        },
      });
      expect(await persistedRowsFor(fixture.administrator, otherProject.projectId))
        .toEqual(otherOwnerBefore);

      await expect(importKnowledge(fixture.projectPath, source)).resolves.toMatchObject({
        imported: 0,
        skipped: 1,
      });
    });
  });

  it("roundtrips normal public promotion self-provenance through PostgreSQL, SQLite, and PostgreSQL", async () => {
    await withSelectedPostgreSqlProject("knowledge-normal-canonical", async fixture => {
      const id = await promoteNormally(fixture);
      const expectedIdentity = {
        id: fixture.project.projectId, remoteProjectId: fixture.project.projectId,
        localProjectId: hashProjectPath(fixture.projectPath), canonical: fixture.projectPath,
        selectedPath: fixture.projectPath, machineId: fixture.machine.machineId,
      };
      const projectIdentity = { scope: "shared" as const, projectId: expectedIdentity.id };
      // Public promotion has completed. The following library transfer uses only
      // the harness credentials, which reject ambient application selection.
      const applicationEnvironment = new Map(["LCM_POSTGRES_URL", "LCM_POSTGRES_CA_FILE", "LCM_POSTGRES_MIGRATION_ROLE"]
        .map(key => [key, process.env[key]]));
      for (const key of applicationEnvironment.keys()) delete process.env[key];
      const handles: Array<PortableRecordStream | PortableRecordWriter> = [];
      const own = <T extends PortableRecordStream | PortableRecordWriter>(handle: T): T => { handles.push(handle); return handle; };
      try {
        const source = own(await createPortableRecordStream(await createPostgreSqlPortableSource({
          settings: settings(fixture.database.runtimeUrl), expectedOwner: "lcm_test_migrator", expectedIdentity,
        })));
        const batch = await source.readBatch({ domain: "promoted-memories", maxRecords: 500, maxBytes: PORTABLE_LIMITS.maxBatchBytes });
        expect(batch.records).toEqual([expect.objectContaining({ value: expect.objectContaining({ memoryId: id, sourceProjectId: null }) })]);
        const expected = source.describe();
        const path = join(fixture.projectRoot, "normal.sqlite");
        const sqlite = own(await openSqlitePortableDestination({ databasePath: path, mode: "create", projectIdentity,
          generationIdentitySha256: canonicalSha256(randomUUID()), scratchParent: fixture.projectRoot }));
        await expect(runPortableTransfer({ source, destination: sqlite, maxRecords: 2 }))
          .resolves.toMatchObject({ contentSha256: expected.contentSha256 });
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          expect(db.prepare("SELECT project_id FROM promoted WHERE id=?").get(id))
            .toMatchObject({ project_id: expectedIdentity.id });
        } finally { db.close(); }
        const intermediate = own(await createPortableRecordStream(await openSqlitePortableSource({
          databasePath: path, projectIdentity, expectedFileSha256: sqlitePortableFileSha256(path),
          capturedAt: "2026-09-07T00:00:00.000000Z", scratchParent: fixture.projectRoot,
        })));
        expect(intermediate.describe().contentSha256).toBe(expected.contentSha256);
        await withPostgreSqlTestDatabase("knowledge-normal-return", async target => {
          // Reproduce only source authority in a fresh private destination; data
          // and provenance must be written exclusively by the canonical transfer.
          for (const table of ["machines", "projects", "project_aliases"] as const) {
            const result = await fixture.administrator.query<{ rows: unknown }>({
              text: `SELECT jsonb_agg(to_jsonb(r)) AS rows FROM lcm.${table} r`,
            }, { domain: "factory", operation: "captureTransferAuthority" });
            await target.migrator.query({ text: `INSERT INTO lcm.${table} SELECT * FROM jsonb_populate_recordset(NULL::lcm.${table},$1::jsonb)`,
              values: [JSON.stringify(result.rows[0].rows)] }, { domain: "factory", operation: "restoreTransferAuthority" });
          }
          await grantPortablePostgreSql(target, { transfer: true });
          const destination = await createPostgreSqlPortableDestination({ settings: settings(target.runtimeUrl),
            expectedOwner: "lcm_test_migrator", expectedIdentity, generationId: randomUUID(), runId: randomUUID(), scratchParent: fixture.projectRoot });
          try {
            await expect(runPortableTransfer({ source: intermediate, destination, maxRecords: 2 }))
              .resolves.toMatchObject({ contentSha256: expected.contentSha256 });
            const repository = new PostgreSqlPromotedMemoryRepository(target.runtime, expectedIdentity.id);
            expect(await repository.getById(id)).toMatchObject({ projectId: expectedIdentity.id, content: PROMOTED_CONTENT });
            const readback = await createPortableRecordStream(await createPostgreSqlPortableSource({
              settings: settings(target.runtimeUrl), expectedOwner: "lcm_test_migrator", expectedIdentity, admission: "transfer",
            }));
            try {
              expect(readback.describe().contentSha256).toBe(expected.contentSha256);
              expect((await readback.readBatch({ domain: "promoted-memories", maxRecords: 500, maxBytes: PORTABLE_LIMITS.maxBatchBytes })).records).toEqual(batch.records);
            } finally { await readback.close(); }
          } finally { await destination.close(); }
        });
      } finally {
        try { for (const handle of handles.reverse()) await handle.close(); }
        finally {
          for (const [key, value] of applicationEnvironment) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
          }
        }
      }
    });
  });

  it("imports and exports through authenticated selection, preserving v1 and retry identity", async () => {
    await withSelectedPostgreSqlProject("knowledge-v1", async (fixture) => {
      const { projectPath, projectRoot } = fixture;
      const source = document([
        entry("Orchard pruning PORTABLEPRIVATE instructions", ["gardening", "PORTABLEPRIVATE"]),
        entry("Ceramic kiln temperature guidance", ["pottery"]),
      ]);
      await expect(importKnowledge(projectPath, source, { _globalPatterns: [] }))
        .resolves.toEqual({ total: 2, imported: 2, skipped: 0, dryRun: false });
      const originalRows = await persistedRows(fixture);
      expect(originalRows).toHaveLength(2);
      for (const row of originalRows) {
        expect(row.archived_at).toBeNull();
        expect(row.metadata[DIGEST_KEY]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/u)]);
      }

      // A fresh selected factory opens on each call; retry identity survives
      // connection closure and a changed scrub configuration.
      await expect(importKnowledge(projectPath, source, {
        _globalPatterns: ["PORTABLEPRIVATE"],
      })).resolves.toEqual({ total: 2, imported: 0, skipped: 2, dryRun: false });
      expect(await persistedRows(fixture)).toEqual(originalRows);

      const output = join(projectRoot, "knowledge.json");
      await expect(exportKnowledge(projectPath, {
        output, _globalPatterns: ["PORTABLEPRIVATE"],
      })).resolves.toEqual({ exported: 2, projectCwd: projectPath });
      const exported = JSON.parse(readFileSync(output, "utf8")) as ExportDocument;
      expect(Object.keys(exported).sort()).toEqual(["entries", "exportedAt", "projectCwd", "version"]);
      expect(exported).toMatchObject({ version: 1, projectCwd: projectPath });
      expect(Number.isFinite(Date.parse(exported.exportedAt))).toBe(true);
      expect(exported.entries).toEqual(expect.arrayContaining([
        {
          content: "Orchard pruning [REDACTED] instructions",
          tags: ["gardening", "[REDACTED]"],
          confidence: 0.8,
          createdAt: expect.any(String),
          sessionId: null,
        },
        {
          content: "Ceramic kiln temperature guidance",
          tags: ["pottery"],
          confidence: 0.8,
          createdAt: expect.any(String),
          sessionId: null,
        },
      ]));
      expect(exported.entries).toHaveLength(2);
      expect(readFileSync(output, "utf8")).not.toContain(DIGEST_KEY);
      expect(await persistedRows(fixture)).toEqual(originalRows);

      const filteredOutput = join(projectRoot, "filtered.json");
      await expect(exportKnowledge(projectPath, {
        output: filteredOutput, tags: ["pottery"], since: "2026-01-01", skipScrub: true,
      })).resolves.toMatchObject({ exported: 1 });
      expect((JSON.parse(readFileSync(filteredOutput, "utf8")) as ExportDocument).entries)
        .toEqual([expect.objectContaining({ content: "Ceramic kiln temperature guidance" })]);

      const unboundPath = join(projectRoot, "unbound");
      mkdirSync(unboundPath);
      await expect(importKnowledge(unboundPath, source)).rejects.toMatchObject({
        name: StorageIdentityConfigurationError.name,
        message: UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
      });
      await expect(exportKnowledge(unboundPath, { output })).rejects.toMatchObject({
        name: StorageIdentityConfigurationError.name,
        message: UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
      });
      expect(await persistedRows(fixture)).toEqual(originalRows);
    });
  });

  it("skips invalid entries before SQL and commits the following valid entry", async () => {
    await withSelectedPostgreSqlProject("knowledge-invalid", async (fixture) => {
      const source = document([
        entry(""),
        entry("invalid\u0000content"),
        entry("Valid telescope calibration guidance", ["astronomy"]),
      ]);
      await expect(importKnowledge(fixture.projectPath, source, { _globalPatterns: [] }))
        .resolves.toEqual({
          total: 3, imported: 1, skipped: 2, dryRun: false,
          errors: ["Invalid knowledge entry at index 0", "Invalid knowledge entry at index 1"],
        });
      expect(await persistedRows(fixture)).toEqual([
        expect.objectContaining({
          content: "Valid telescope calibration guidance", tags: ["astronomy"],
          metadata: { [DIGEST_KEY]: [expect.stringMatching(/^[a-f0-9]{64}$/u)] },
        }),
      ]);
    });
  });

  it("rolls back prior rows, tags and digests on real SQL failure, then retries from the start", async () => {
    await withSelectedPostgreSqlProject("knowledge-atomic", async (fixture) => {
      const { projectPath, administrator } = fixture;
      await importKnowledge(projectPath, document([
        entry("Baseline astronomy reference", ["existing"]),
      ]), { _globalPatterns: [] });
      const baseline = await persistedRows(fixture);
      const source = document([
        entry("Orchard pruning RETRYPRIVATE instructions", ["gardening", "RETRYPRIVATE"]),
        entry("Ceramic kiln permission failure marker", ["pottery"]),
      ]);
      const originalInsert = PostgreSqlPromotedMemoryRepository.prototype.insert;
      let completedInserts = 0;
      const insert = vi.spyOn(PostgreSqlPromotedMemoryRepository.prototype, "insert")
        .mockImplementation(async function (this: PostgreSqlPromotedMemoryRepository, input) {
          if (input.content === source.entries[1].content) {
            expect(completedInserts).toBe(1);
            // Revoke only after the first entry and its retry digest have been
            // written. The next production INSERT fails in PostgreSQL itself.
            await administrator.query({
              text: `REVOKE INSERT (project_id, content, source_summary_id,
                        source_project_id, session_id, depth, confidence, metadata)
                     ON TABLE lcm.promoted_memories FROM lcm_test_runtime`,
            }, { domain: "promoted-memory", operation: "injectKnowledgePermissionFailure" });
          }
          const id = await originalInsert.call(this, input);
          completedInserts++;
          return id;
        });
      try {
        await expect(importKnowledge(projectPath, source, {
          _globalPatterns: ["RETRYPRIVATE"],
        })).rejects.toMatchObject({ backend: "postgresql", sqlState: "42501" });
        expect(completedInserts).toBe(1);
        expect(insert).toHaveBeenCalledTimes(2);
        expect(await persistedRows(fixture)).toEqual(baseline);
      } finally {
        insert.mockRestore();
        await restoreRuntimeGrants(administrator);
      }

      // This retry deliberately has different scrub patterns. Failed work must
      // leave neither a prefix nor a digest that suppresses the first entry.
      await expect(importKnowledge(projectPath, source, { _globalPatterns: [] }))
        .resolves.toEqual({ total: 2, imported: 2, skipped: 0, dryRun: false });
      const committed = await persistedRows(fixture);
      expect(committed).toHaveLength(3);
      expect(committed).toEqual(expect.arrayContaining([
        expect.objectContaining({
          content: source.entries[0].content,
          tags: source.entries[0].tags,
          metadata: { [DIGEST_KEY]: [expect.stringMatching(/^[a-f0-9]{64}$/u)] },
        }),
        expect.objectContaining({ content: source.entries[1].content, tags: ["pottery"] }),
        ...baseline,
      ]));
      await expect(importKnowledge(projectPath, source, {
        _globalPatterns: ["RETRYPRIVATE"],
      })).resolves.toEqual({ total: 2, imported: 0, skipped: 2, dryRun: false });
      expect(await persistedRows(fixture)).toEqual(committed);
    });
  });

  it("merges canonical metadata a second connection commits after the import scan", async () => {
    // Proves the invariant on a real database: the import's own scan
    // statement takes an earlier READ COMMITTED snapshot, a genuinely
    // separate connection commits a concurrent write in between, and the
    // import's live getById read (after its own lock-taking UPDATE) must
    // still observe that committed write. This cannot be modeled by the
    // SQLite-backed unit tests, which have only one physical connection.
    await withSelectedPostgreSqlProject("knowledge-live-canonical-race", async (fixture) => {
      const repository = new PostgreSqlPromotedMemoryRepository(fixture.database.runtime, fixture.project.projectId);
      const content = "Live PostgreSQL canonical metadata race content";
      const rowId = await repository.insert({ content, tags: ["pre-race"], confidence: 0.5 });

      const originalGetAll = PostgreSqlPromotedMemoryRepository.prototype.getAll;
      let release: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      let scanHappened = false;
      const getAllSpy = vi.spyOn(PostgreSqlPromotedMemoryRepository.prototype, "getAll")
        .mockImplementationOnce(async function (this: PostgreSqlPromotedMemoryRepository, options) {
          // Drives the real import scan SQL on the import's own held
          // connection and transaction, then pauses before returning so a
          // genuinely independent second connection can commit meanwhile.
          const rows = await originalGetAll.call(this, options);
          scanHappened = true;
          await blocked;
          return rows;
        });

      const source = document([entry(content, ["imported"])]);
      const importPromise = importKnowledge(fixture.projectPath, source);
      try {
        await vi.waitFor(() => { if (!scanHappened) throw new Error("import scan not yet observed"); }, { timeout: 10_000, interval: 10 });
        // A second, fully independent connection (fixture.database.runtime is
        // its own pool, distinct from the import's held connection) commits a
        // concurrent write on the already-scanned row before the import's
        // later dedup and merge statements run.
        await repository.update(rowId, {
          metadata: { concurrentNote: "committed by a second connection", [DIGEST_KEY]: ["c".repeat(64)] },
        });
        release!();
        await expect(importPromise).resolves.toMatchObject({ imported: 1, skipped: 0 });
        getAllSpy.mockRestore();
        const rows = await persistedRows(fixture);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          memory_id: rowId,
          metadata: { concurrentNote: "committed by a second connection" },
        });
        const digestSet = new Set(rows[0].metadata[DIGEST_KEY] as string[]);
        const newDigest = computeEntryDigest(source, 0);
        expect([...digestSet].sort()).toEqual(["c".repeat(64), newDigest].sort());
      } finally {
        // Release the barrier on every path, including a failed wait or a
        // failed concurrent write, so the import's paused transaction and
        // connection never survive until the suite timeout. Resolving an
        // already-resolved promise is a no-op, so this is safe to call again
        // after the success path already released it above. Await the
        // import to full settlement before the fixture tears down so no
        // in-flight query overlaps that teardown.
        release!();
        await importPromise.catch(() => undefined);
        getAllSpy.mockRestore();
      }
    });
  });

  it("keeps a second connection's metadata on the archived duplicate after the import scan", async () => {
    // Proves the collapse half of the same invariant against a real
    // database: the archive-then-getById ordering must read the archived
    // row's current committed metadata, including a write a genuinely
    // separate connection made after the import's scan but before its
    // archive statement runs. SQLite cannot model this because it has only
    // one physical writer connection; this is the half a live database is
    // required to prove.
    await withSelectedPostgreSqlProject("knowledge-live-collapse-race", async (fixture) => {
      const repository = new PostgreSqlPromotedMemoryRepository(fixture.database.runtime, fixture.project.projectId);
      const content = "Live PostgreSQL collapse race content";
      const idA = await repository.insert({ content, tags: ["variant-a"], confidence: 0.4 });
      const idB = await repository.insert({ content, tags: ["variant-b"], confidence: 0.5 });
      const [rowA, rowB] = [await repository.getById(idA), await repository.getById(idB)];
      // Compute which row real dedup will select as canonical without
      // assuming timing: findExactContent and the fuzzy search both order
      // ties by created_at DESC, memory_id DESC, so mirror that here from
      // the rows' actual persisted timestamps rather than insertion order.
      const canonicalFirst = rowA!.createdAt !== rowB!.createdAt
        ? rowA!.createdAt > rowB!.createdAt
        : idA > idB;
      const canonicalId = canonicalFirst ? idA : idB;
      const archivedId = canonicalFirst ? idB : idA;

      const originalGetAll = PostgreSqlPromotedMemoryRepository.prototype.getAll;
      let release: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      let scanHappened = false;
      const getAllSpy = vi.spyOn(PostgreSqlPromotedMemoryRepository.prototype, "getAll")
        .mockImplementationOnce(async function (this: PostgreSqlPromotedMemoryRepository, options) {
          const rows = await originalGetAll.call(this, options);
          scanHappened = true;
          await blocked;
          return rows;
        });

      const source = document([entry(content, ["imported"])]);
      const importPromise = importKnowledge(fixture.projectPath, source);
      try {
        await vi.waitFor(() => { if (!scanHappened) throw new Error("import scan not yet observed"); }, { timeout: 10_000, interval: 10 });
        // The second connection commits new metadata on the row that will be
        // archived as a duplicate, before the import's own archive-then-
        // getById sequence reads it.
        await repository.update(archivedId, {
          metadata: { concurrentNote: "committed by a second connection", [DIGEST_KEY]: ["d".repeat(64)] },
        });
        release!();
        await expect(importPromise).resolves.toMatchObject({ imported: 1, skipped: 0 });
        getAllSpy.mockRestore();
        const rows = await persistedRows(fixture);
        const archived = rows.find(row => row.memory_id === archivedId)!;
        const canonical = rows.find(row => row.memory_id === canonicalId)!;
        expect(archived.archived_at).not.toBeNull();
        expect(canonical.archived_at).toBeNull();
        expect(canonical.metadata).toMatchObject({ concurrentNote: "committed by a second connection" });
        const digestSet = new Set(canonical.metadata[DIGEST_KEY] as string[]);
        const newDigest = computeEntryDigest(source, 0);
        expect([...digestSet].sort()).toEqual(["d".repeat(64), newDigest].sort());
      } finally {
        // Release the barrier on every path, including a failed wait or a
        // failed concurrent write, so the import's paused transaction and
        // connection never survive until the suite timeout. Resolving an
        // already-resolved promise is a no-op, so this is safe to call again
        // after the success path already released it above. Await the
        // import to full settlement before the fixture tears down so no
        // in-flight query overlaps that teardown.
        release!();
        await importPromise.catch(() => undefined);
        getAllSpy.mockRestore();
      }
    });
  });
});
