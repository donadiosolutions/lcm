import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { deduplicateAndInsert } from "../../src/promotion/dedup.js";
import { PostgreSqlProjectStorage } from "../../src/storage/postgresql/project-storage.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  assertHarnessReady,
  settings,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

async function grantRuntime(database: PostgreSqlTestDatabase): Promise<void> {
  for (const fileName of [
    "postgresql-runtime-memory-grants.sql",
    "postgresql-runtime-search-grants.sql",
  ]) {
    const sql = readFileSync(
      join(process.cwd(), "src/storage/postgresql/reference", fileName),
      "utf8",
    ).split("\n").filter((line) => !line.startsWith("\\")).join("\n")
      .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
    await database.migrator.query({ text: sql }, {
      domain: "factory",
      operation: `grantPromotion${fileName}`,
    });
  }
}

async function createProject(database: PostgreSqlTestDatabase, label: string): Promise<string> {
  const result = await database.migrator.query<{ project_id: string }>({
    text: `INSERT INTO lcm.projects (identity_key, display_name)
           VALUES ($1, $2) RETURNING project_id`,
    values: [createHash("sha256").update(label).digest("hex"), label],
  }, { domain: "identity", operation: "createPromotionProject" });
  return result.rows[0].project_id;
}

describe("PostgreSQL passive promotion provenance", { timeout: 120_000 }, () => {
  it("converges local, manual, and remote provenance within one owner", async () => {
    await withPostgreSqlTestDatabase("promotion-dedup", async (database) => {
      await grantRuntime(database);
      const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl));
      const projectId = await createProject(database, "promotion owner");
      const otherProjectId = await createProject(database, "other owner");
      const machineId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012";
      const storage = new PostgreSqlProjectStorage(runtime, projectId, machineId, () => undefined);
      const otherStorage = new PostgreSqlProjectStorage(runtime, otherProjectId, machineId, () => undefined);
      try {
        const content = "Passive promotion provenance converges";
        const localId = await storage.promotedMemory.insert({
          content,
          sourceProjectId: "a".repeat(64),
          tags: ["local"],
          confidence: 0.4,
        });
        const manualId = await storage.promotedMemory.insert({
          content,
          sourceProjectId: "manual",
          tags: ["manual"],
          confidence: 0.8,
        });
        await otherStorage.promotedMemory.insert({ content, sourceProjectId: projectId });
        await otherStorage.promotedMemory.insert({
          content: "Only exists in another owner",
          sourceProjectId: otherProjectId,
        });

        const ownerCandidates = await storage.lexicalSearch.searchPromoted(
          content,
          100,
          undefined,
          undefined,
        );
        const sourceCandidates = await storage.lexicalSearch.searchPromoted(
          content,
          100,
          undefined,
          "a".repeat(64),
        );
        expect(ownerCandidates).toHaveLength(2);
        expect(sourceCandidates).toHaveLength(1);

        const id = await deduplicateAndInsert({
          transaction: (callback) => storage.transaction(callback),
          content,
          sourceProjectId: "remote-owner-uuid",
          candidateScope: "owner",
          backend: "postgresql",
          tags: ["passive"],
          depth: 0,
          confidence: 0.9,
          thresholds: { dedupBm25Threshold: 15, dedupCandidateLimit: 100 },
        });
        expect([localId, manualId]).toContain(id);
        const rows = await storage.promotedMemory.getAll();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id, confidence: 0.9 });
        expect(rows[0].tags).toEqual(["manual", "local", "passive"]);

        const isolated = await deduplicateAndInsert({
          transaction: (callback) => storage.transaction(callback),
          content: "Only exists in another owner",
          sourceProjectId: "remote-owner-uuid",
          candidateScope: "owner",
          backend: "postgresql",
          tags: [],
          depth: 0,
          confidence: 0.5,
          thresholds: { dedupBm25Threshold: 15, dedupCandidateLimit: 100 },
        });
        expect(await storage.promotedMemory.getById(isolated)).not.toBeNull();
        const provenance = await database.migrator.query<{ source_project_id: string }>({
          text: `SELECT source_project_id FROM lcm.promoted_memories
                 WHERE project_id = $1 AND memory_id = $2`,
          values: [projectId, isolated],
        }, { domain: "promoted-memory", operation: "verifyPromotionProvenance" });
        expect(provenance.rows[0].source_project_id).toBe("remote-owner-uuid");
      } finally {
        await storage.close();
        await otherStorage.close();
        await runtime.close();
      }
    });
  });
});
