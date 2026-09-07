import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  exportKnowledge,
  importKnowledge,
  type ExportDocument,
  type ExportEntry,
} from "../../src/portable-knowledge.js";
import { StorageIdentityConfigurationError, UNBOUND_POSTGRESQL_PROJECT_MESSAGE } from "../../src/storage/identity-context.js";
import { PostgreSqlPromotedMemoryRepository } from "../../src/storage/postgresql/memory-repositories.js";
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

async function persistedRows({ administrator, project }: SelectedPostgreSqlProject) {
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
    values: [project.projectId],
  }, { domain: "promoted-memory", operation: "verifyKnowledgeImport" });
  return result.rows;
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
});
