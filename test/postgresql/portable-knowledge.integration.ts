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
import { assertHarnessReady } from "./harness.js";
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

describe("PostgreSQL 18 portable knowledge v1", { timeout: 120_000 }, () => {
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
