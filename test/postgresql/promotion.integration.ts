import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueryConfig, QueryResultRow } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import {
  deduplicateAndInsert,
  deduplicateAndInsertInRepositories,
} from "../../src/promotion/dedup.js";
import type { TransactionRepositories } from "../../src/storage/contracts.js";
import type {
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
} from "../../src/storage/postgresql/contracts.js";
import {
  PostgreSqlPromotedMemoryRepository,
  type PostgreSqlMemoryScopedExecutor,
} from "../../src/storage/postgresql/memory-repositories.js";
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
        const otherOwnerContentId = await otherStorage.promotedMemory.insert({
          content,
          sourceProjectId: projectId,
        });
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
        const otherOwnerCandidates = await otherStorage.lexicalSearch.searchPromoted(
          content,
          100,
          undefined,
          undefined,
        );
        expect(otherOwnerCandidates).toHaveLength(1);
        expect(otherOwnerCandidates[0]?.id).toBe(otherOwnerContentId);
        expect(otherOwnerCandidates[0]?.projectId).toBe(projectId);

        const id = await deduplicateAndInsert({
          transaction: (callback) => storage.transaction(async repositories => {
            const bounded = await repositories.lexicalSearch.searchPromoted(
              content,
              1,
              undefined,
              undefined,
            );
            expect(bounded).toHaveLength(1);
            expect([localId, manualId]).toContain(bounded[0]?.id);
            return callback(repositories);
          }),
          content,
          sourceProjectId: projectId,
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
        const canonicalTags = ownerCandidates[0]?.id === localId
          ? ["local", "manual", "passive"]
          : ["manual", "local", "passive"];
        expect(rows[0].tags).toEqual(canonicalTags);

        const remoteOnlyContent = "Remote UUID provenance converges";
        const remoteOnlyId = await storage.promotedMemory.insert({
          content: remoteOnlyContent,
          sourceProjectId: projectId,
          tags: ["remote"],
          confidence: 0.6,
        });
        const remoteConvergedId = await deduplicateAndInsert({
          transaction: callback => storage.transaction(callback),
          content: remoteOnlyContent,
          sourceProjectId: projectId,
          candidateScope: "owner",
          backend: "postgresql",
          tags: ["passive"],
          depth: 0,
          confidence: 0.7,
          thresholds: { dedupBm25Threshold: 15, dedupCandidateLimit: 100 },
        });
        expect(remoteConvergedId).toBe(remoteOnlyId);

        const isolated = await deduplicateAndInsert({
          transaction: (callback) => storage.transaction(callback),
          content: "Only exists in another owner",
          sourceProjectId: projectId,
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
        expect(provenance.rows[0].source_project_id).toBe(projectId);
      } finally {
        await storage.close();
        await otherStorage.close();
        await runtime.close();
      }
    });
  });
});

type CapturedMemoryQuery = {
  readonly text: string;
  readonly values: readonly unknown[];
};

function captureMemoryQueryExecutor(
  executor: PostgreSqlQueryExecutor,
  captured: CapturedMemoryQuery[],
): PostgreSqlQueryExecutor {
  return {
    async query<
      R extends QueryResultRow = QueryResultRow,
      I extends unknown[] = unknown[],
    >(config: QueryConfig<I>, options: PostgreSqlQueryOptions) {
      if (config.text.includes("FROM lcm.promoted_memories AS memory")) {
        captured.push({
          text: config.text,
          values: [...(config.values ?? [])],
        });
      }
      return executor.query<R, I>(config, options);
    },
  };
}

function captureMemoryScopedExecutor(
  executor: PostgreSqlMemoryScopedExecutor,
  captured: CapturedMemoryQuery[],
): PostgreSqlMemoryScopedExecutor {
  const direct = captureMemoryQueryExecutor(executor, captured);
  return {
    transactionScope: "active",
    query: direct.query,
    savepoint: (callback, options) =>
      executor.savepoint(
        (savepoint) => callback(captureMemoryQueryExecutor(savepoint, captured)),
        options,
      ),
  };
}

function planNodes(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(planNodes);
  if (value === null || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  return [node, ...Object.values(node).flatMap(planNodes)];
}

describe("PostgreSQL exact promoted-content digest index", { timeout: 120_000 }, () => {
  const machineId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9099";

  it("finds exact promoted content through the digest candidate with a raw-equality residual guard", async () => {
    await withPostgreSqlTestDatabase("promotion-exact-content", async (database) => {
      await grantRuntime(database);
      const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl));
      const projectId = await createProject(database, "exact-content owner");
      const foreignProjectId = await createProject(database, "exact-content foreign owner");
      const storage = new PostgreSqlProjectStorage(runtime, projectId, machineId, () => undefined);
      const foreignStorage = new PostgreSqlProjectStorage(
        runtime,
        foreignProjectId,
        machineId,
        () => undefined,
      );
      try {
        await expect(storage.promotedMemory.findExactContent("absent exact content"))
          .resolves.toBeNull();

        const punctuationContent = "!!! ??? --- ### @@@ %%% &&&";
        const punctuationId = await storage.promotedMemory.insert({
          content: punctuationContent,
          sourceProjectId: "source-a",
        });
        await expect(storage.promotedMemory.findExactContent(punctuationContent, "source-a"))
          .resolves.toMatchObject({ id: punctuationId, content: punctuationContent });
        await expect(storage.promotedMemory.findExactContent(punctuationContent, "source-b"))
          .resolves.toBeNull();

        const largeContent = "lorem-ipsum-digest-candidate-".repeat(2000);
        const largeId = await storage.promotedMemory.insert({ content: largeContent });
        await expect(storage.promotedMemory.findExactContent(largeContent))
          .resolves.toMatchObject({ id: largeId });

        const sharedContent = "Shared exact content across owners";
        const ownerMemoryId = await storage.promotedMemory.insert({ content: sharedContent });
        const foreignMemoryId = await foreignStorage.promotedMemory.insert({
          content: sharedContent,
        });
        await expect(storage.promotedMemory.findExactContent(sharedContent))
          .resolves.toMatchObject({ id: ownerMemoryId });
        await expect(foreignStorage.promotedMemory.findExactContent(sharedContent))
          .resolves.toMatchObject({ id: foreignMemoryId });

        const archivedContent = "Archived exact content excluded from lookup";
        const archivedId = await storage.promotedMemory.insert({ content: archivedContent });
        await storage.promotedMemory.archive(archivedId);
        await expect(storage.promotedMemory.findExactContent(archivedContent))
          .resolves.toBeNull();

        const raceContent = "Race content for newest canonical selection";
        const olderRace = await storage.promotedMemory.insert({ content: raceContent });
        const newerRace = await storage.promotedMemory.insert({ content: raceContent });
        await database.migrator.query({
          text: `UPDATE lcm.promoted_memories SET created_at = '2026-01-01T00:00:00Z'
                 WHERE project_id = $1 AND memory_id = $2`,
          values: [projectId, olderRace],
        }, { domain: "promoted-memory", operation: "backdateOlderRaceRow" });
        await database.migrator.query({
          text: `UPDATE lcm.promoted_memories SET created_at = '2026-01-02T00:00:00Z'
                 WHERE project_id = $1 AND memory_id = $2`,
          values: [projectId, newerRace],
        }, { domain: "promoted-memory", operation: "dateNewerRaceRow" });
        await expect(storage.promotedMemory.findExactContent(raceContent))
          .resolves.toMatchObject({ id: newerRace });

        const tieContent = "Tie content for memory id canonical ordering";
        const tieA = await storage.promotedMemory.insert({ content: tieContent });
        const tieB = await storage.promotedMemory.insert({ content: tieContent });
        await database.migrator.query({
          text: `UPDATE lcm.promoted_memories SET created_at = '2026-01-03T00:00:00Z'
                 WHERE project_id = $1 AND memory_id IN ($2, $3)`,
          values: [projectId, tieA, tieB],
        }, { domain: "promoted-memory", operation: "tieRaceRowCreatedAt" });
        const expectedTieWinner = tieA > tieB ? tieA : tieB;
        await expect(storage.promotedMemory.findExactContent(tieContent))
          .resolves.toMatchObject({ id: expectedTieWinner });

        const originalContent = "Original content before generated digest update";
        const updatedContent = "Updated content after generated digest mutation";
        const updateId = await storage.promotedMemory.insert({ content: originalContent });
        await expect(storage.promotedMemory.findExactContent(originalContent))
          .resolves.toMatchObject({ id: updateId });
        await storage.promotedMemory.update(updateId, { content: updatedContent });
        await expect(storage.promotedMemory.findExactContent(originalContent))
          .resolves.toBeNull();
        await expect(storage.promotedMemory.findExactContent(updatedContent))
          .resolves.toMatchObject({ id: updateId });
        const digest = await database.migrator.query<{ content_sha256: string }>({
          text: `SELECT pg_catalog.encode(content_sha256, 'hex') AS content_sha256
                 FROM lcm.promoted_memories WHERE project_id = $1 AND memory_id = $2`,
          values: [projectId, updateId],
        }, { domain: "promoted-memory", operation: "verifyDigestRecomputed" });
        expect(digest.rows[0]?.content_sha256).toBe(
          createHash("sha256").update(updatedContent).digest("hex"),
        );
      } finally {
        await storage.close();
        await foreignStorage.close();
        await runtime.close();
      }
    });
  });

  it("uses the promoted_memories_content_sha256_idx candidate for exact-content query plans", async () => {
    await withPostgreSqlTestDatabase("promotion-exact-content-plan", async (database) => {
      await grantRuntime(database);
      const projectId = await createProject(database, "exact-content plan owner");
      const foreignProjectId = await createProject(database, "exact-content plan foreign");

      const corpusSize = 40;
      for (let index = 0; index < corpusSize; index += 1) {
        await database.migrator.query({
          text: `INSERT INTO lcm.promoted_memories (project_id, content)
                 VALUES ($1, $2)`,
          values: [projectId, `bounded corpus row ${index}`],
        }, { domain: "promoted-memory", operation: "seedPlanCorpusRow" });
      }

      const hitContent = "Exact hit content for query plan verification";
      const hitId = (await database.migrator.query<{ memory_id: string }>({
        text: `INSERT INTO lcm.promoted_memories (project_id, content, source_project_id)
               VALUES ($1, $2, 'source-a') RETURNING memory_id`,
        values: [projectId, hitContent],
      }, { domain: "promoted-memory", operation: "seedPlanHitRow" })).rows[0]!.memory_id;

      await database.migrator.query({
        text: `INSERT INTO lcm.promoted_memories (project_id, content)
               VALUES ($1, $2)`,
        values: [foreignProjectId, hitContent],
      }, { domain: "promoted-memory", operation: "seedPlanForeignRow" });

      const archivedRowId = (await database.migrator.query<{ memory_id: string }>({
        text: `INSERT INTO lcm.promoted_memories (project_id, content)
               VALUES ($1, $2) RETURNING memory_id`,
        values: [projectId, hitContent],
      }, { domain: "promoted-memory", operation: "seedPlanArchivedRow" })).rows[0]!.memory_id;
      await database.migrator.query({
        text: `UPDATE lcm.promoted_memories SET archived_at = pg_catalog.now()
               WHERE project_id = $1 AND memory_id = $2`,
        values: [projectId, archivedRowId],
      }, { domain: "promoted-memory", operation: "archivePlanRow" });

      const provenanceContent = "Provenance-scoped exact content for query plan";
      await database.migrator.query({
        text: `INSERT INTO lcm.promoted_memories (project_id, content, source_project_id)
               VALUES ($1, $2, 'source-mismatch')`,
        values: [projectId, provenanceContent],
      }, { domain: "promoted-memory", operation: "seedPlanProvenanceDecoyRow" });
      const provenanceHitId = (await database.migrator.query<{ memory_id: string }>({
        text: `INSERT INTO lcm.promoted_memories (project_id, content, source_project_id)
               VALUES ($1, $2, 'source-match') RETURNING memory_id`,
        values: [projectId, provenanceContent],
      }, { domain: "promoted-memory", operation: "seedPlanProvenanceHitRow" })).rows[0]!.memory_id;

      const oldestContent = "Oldest-position exact content for canonical selection";
      const oldestOlder = (await database.migrator.query<{ memory_id: string }>({
        text: `INSERT INTO lcm.promoted_memories (project_id, content)
               VALUES ($1, $2) RETURNING memory_id`,
        values: [projectId, oldestContent],
      }, { domain: "promoted-memory", operation: "seedPlanOldestOlderRow" })).rows[0]!.memory_id;
      const oldestNewer = (await database.migrator.query<{ memory_id: string }>({
        text: `INSERT INTO lcm.promoted_memories (project_id, content)
               VALUES ($1, $2) RETURNING memory_id`,
        values: [projectId, oldestContent],
      }, { domain: "promoted-memory", operation: "seedPlanOldestNewerRow" })).rows[0]!.memory_id;
      await database.migrator.query({
        text: `UPDATE lcm.promoted_memories SET created_at = '2026-01-01T00:00:00Z'
               WHERE project_id = $1 AND memory_id = $2`,
        values: [projectId, oldestOlder],
      }, { domain: "promoted-memory", operation: "datePlanOldestOlderRow" });
      await database.migrator.query({
        text: `UPDATE lcm.promoted_memories SET created_at = '2026-01-02T00:00:00Z'
               WHERE project_id = $1 AND memory_id = $2`,
        values: [projectId, oldestNewer],
      }, { domain: "promoted-memory", operation: "datePlanOldestNewerRow" });

      const punctuationContent = "!!! ??? --- ### plan verification punctuation";
      const punctuationId = (await database.migrator.query<{ memory_id: string }>({
        text: `INSERT INTO lcm.promoted_memories (project_id, content)
               VALUES ($1, $2) RETURNING memory_id`,
        values: [projectId, punctuationContent],
      }, { domain: "promoted-memory", operation: "seedPlanPunctuationRow" })).rows[0]!.memory_id;

      const largeContent = "plan-verification-large-content-".repeat(1500);
      const largeId = (await database.migrator.query<{ memory_id: string }>({
        text: `INSERT INTO lcm.promoted_memories (project_id, content)
               VALUES ($1, $2) RETURNING memory_id`,
        values: [projectId, largeContent],
      }, { domain: "promoted-memory", operation: "seedPlanLargeContentRow" })).rows[0]!.memory_id;

      const missContents = [
        "bounded batch miss content one",
        "bounded batch miss content two",
        "bounded batch miss content three",
      ];

      await database.migrator.transaction(async (transaction) => {
        await transaction.query({
          text: "SET LOCAL enable_seqscan = off",
        }, { domain: "promoted-memory", operation: "pinPlanVerificationPlanner" });

        const explainFindExactContent = async (
          content: string,
          sourceProjectId: string | undefined,
          operation: string,
        ) => {
          const captured: CapturedMemoryQuery[] = [];
          const repository = new PostgreSqlPromotedMemoryRepository(
            captureMemoryScopedExecutor(transaction, captured),
            projectId,
          );
          const found = await repository.findExactContent(content, sourceProjectId);
          expect(captured).toHaveLength(1);
          const explained = await transaction.query<{ "QUERY PLAN": unknown }>({
            text: `EXPLAIN (
                   ANALYZE, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF
                 ) ${captured[0]!.text}`,
            values: [...captured[0]!.values],
          }, { domain: "promoted-memory", operation });
          return { found, plan: explained.rows[0]!["QUERY PLAN"] };
        };

        const scanNode = (plan: unknown): Record<string, unknown> => {
          const nodes = planNodes(plan).filter(
            (node) => node["Index Name"] === "promoted_memories_content_sha256_idx",
          );
          expect(nodes.length).toBeGreaterThan(0);
          return nodes[0]!;
        };

        const hasResidualContentFilter = (plan: unknown): boolean =>
          planNodes(plan).some((node) =>
            typeof node["Filter"] === "string" && node["Filter"].includes("content"));

        const miss = await explainFindExactContent(
          "content that was never promoted",
          undefined,
          "explainExactContentMiss",
        );
        expect(miss.found).toBeNull();
        const missNode = scanNode(miss.plan);
        expect(missNode["Actual Rows"]).toBe(0);
        expect(String(missNode["Index Cond"])).toContain("project_id");
        expect(String(missNode["Index Cond"])).toContain("content_sha256");

        const hit = await explainFindExactContent(
          hitContent,
          "source-a",
          "explainExactContentHit",
        );
        expect(hit.found).toMatchObject({ id: hitId });
        const hitNode = scanNode(hit.plan);
        expect(hitNode["Actual Rows"]).toBe(1);
        expect(Number(hitNode["Actual Rows"])).toBeLessThan(corpusSize);
        expect(String(hitNode["Index Cond"])).toContain("project_id");
        expect(String(hitNode["Index Cond"])).toContain("content_sha256");
        expect(hasResidualContentFilter(hit.plan)).toBe(true);

        const provenanceHit = await explainFindExactContent(
          provenanceContent,
          "source-match",
          "explainExactContentProvenance",
        );
        expect(provenanceHit.found).toMatchObject({ id: provenanceHitId });
        expect(scanNode(provenanceHit.plan)["Actual Rows"]).toBe(1);

        const positional = await explainFindExactContent(
          oldestContent,
          undefined,
          "explainExactContentPositional",
        );
        expect(positional.found).toMatchObject({ id: oldestNewer });
        expect(scanNode(positional.plan)["Actual Rows"]).toBe(1);

        const punctuation = await explainFindExactContent(
          punctuationContent,
          undefined,
          "explainExactContentPunctuation",
        );
        expect(punctuation.found).toMatchObject({ id: punctuationId });
        expect(scanNode(punctuation.plan)["Actual Rows"]).toBe(1);

        const large = await explainFindExactContent(
          largeContent,
          undefined,
          "explainExactContentLarge",
        );
        expect(large.found).toMatchObject({ id: largeId });
        expect(scanNode(large.plan)["Actual Rows"]).toBe(1);
        expect(large.found).not.toMatchObject({ id: archivedRowId });

        for (const [index, missContent] of missContents.entries()) {
          const batchMiss = await explainFindExactContent(
            missContent,
            undefined,
            `explainExactContentBatchMiss${index}`,
          );
          expect(batchMiss.found).toBeNull();
          expect(scanNode(batchMiss.plan)["Actual Rows"]).toBe(0);
        }
      }, { domain: "promoted-memory", operation: "explainExactContentTransaction", projectId });
    });
  });
});


describe("PostgreSQL concurrent promoted-content deduplication", { timeout: 120_000 }, () => {
  it("serializes two concurrent lookup-and-insert decisions for identical content", async () => {
    await withPostgreSqlTestDatabase("promotion-concurrent-dedup", async (database) => {
      await grantRuntime(database);
      const projectId = await createProject(database, "concurrent dedup owner");
      const machineId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012";
      const firstRuntime = new PostgreSqlRuntime(settings(database.runtimeUrl));
      const secondRuntime = new PostgreSqlRuntime(settings(database.runtimeUrl));
      const first = new PostgreSqlProjectStorage(
        firstRuntime,
        projectId,
        machineId,
        () => undefined,
      );
      const second = new PostgreSqlProjectStorage(
        secondRuntime,
        projectId,
        machineId,
        () => undefined,
      );
      const content = "Two concurrent imports of one new promoted memory";
      const input = {
        content,
        tags: ["concurrent"],
        sourceProjectId: "a".repeat(64),
        candidateScope: "source" as const,
        backend: "postgresql" as const,
        depth: 0,
        confidence: 0.9,
        thresholds: { dedupBm25Threshold: 0.5, dedupCandidateLimit: 10 },
      };

      // Deterministic seam: hold the first transaction between the real
      // candidate read and the real insert, start the second transaction,
      // observe it waiting on the serialized decision, then release the
      // first. Without serialization the second reads an empty candidate
      // set, never waits, and inserts a second row.
      let releaseFirstInsert!: () => void;
      const firstInsertReleased = new Promise<void>((resolve) => {
        releaseFirstInsert = resolve;
      });
      let reportFirstDecided!: () => void;
      const firstDecided = new Promise<void>((resolve) => {
        reportFirstDecided = resolve;
      });

      try {
        const firstPromise = first.transaction(async (repositories) => {
          const paused: TransactionRepositories = {
            ...repositories,
            promotedMemory: {
              ...repositories.promotedMemory,
              insert: async (value) => {
                reportFirstDecided();
                await firstInsertReleased;
                return repositories.promotedMemory.insert(value);
              },
            },
          };
          return await deduplicateAndInsertInRepositories(paused, input);
        });

        await firstDecided;
        let secondSettled = false;
        const secondPromise = second
          .transaction(async (repositories) =>
            await deduplicateAndInsertInRepositories(repositories, input))
          .finally(() => {
            secondSettled = true;
          });

        // Observe the block directly in pg_locks rather than sleeping for a
        // fixed interval. An ungranted advisory lock in this test's own
        // database proves the second transaction is waiting on the first
        // transaction's serialized decision, not merely slow to start.
        let observedWait = false;
        for (let attempt = 0; attempt < 200 && !observedWait; attempt++) {
          const waiting = await database.migrator.query<{ waiting: number }>({
            text: `SELECT count(*)::pg_catalog.int4 AS waiting
                   FROM pg_catalog.pg_locks
                   WHERE locktype OPERATOR(pg_catalog.=) 'advisory'
                     AND NOT granted
                     AND database OPERATOR(pg_catalog.=) (
                       SELECT oid FROM pg_catalog.pg_database
                       WHERE datname OPERATOR(pg_catalog.=) pg_catalog.current_database()
                     )`,
          }, { domain: "promoted-memory", operation: "observeConcurrentDedupWait" });
          observedWait = waiting.rows[0].waiting > 0;
          if (!observedWait) {
            await new Promise((resolve) => {
              setTimeout(resolve, 25);
            });
          }
        }
        expect(observedWait).toBe(true);
        expect(secondSettled).toBe(false);

        releaseFirstInsert();
        const firstId = await firstPromise;
        const secondId = await secondPromise;
        expect(secondId).toBe(firstId);

        const rows = await database.migrator.query<{ memory_id: string }>({
          text: `SELECT memory_id FROM lcm.promoted_memories
                 WHERE project_id = $1 AND archived_at IS NULL`,
          values: [projectId],
        }, { domain: "promoted-memory", operation: "countConcurrentDedupRows" });
        expect(rows.rows).toEqual([{ memory_id: firstId }]);
      } finally {
        releaseFirstInsert();
        await first.close();
        await second.close();
        await firstRuntime.close();
        await secondRuntime.close();
      }
    });
  });

  it("holds one advisory lock however many entries a transaction decides", async () => {
    await withPostgreSqlTestDatabase("promotion-bounded-locks", async (database) => {
      await grantRuntime(database);
      const projectId = await createProject(database, "bounded lock owner");
      const machineId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012";
      const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl));
      const storage = new PostgreSqlProjectStorage(
        runtime,
        projectId,
        machineId,
        () => undefined,
      );
      const advisoryLocksHeld = async (): Promise<number> => {
        const held = await database.migrator.query<{ held: number }>({
          text: `SELECT count(*)::pg_catalog.int4 AS held
                 FROM pg_catalog.pg_locks
                 WHERE locktype OPERATOR(pg_catalog.=) 'advisory'
                   AND granted
                   AND database OPERATOR(pg_catalog.=) (
                     SELECT oid FROM pg_catalog.pg_database
                     WHERE datname OPERATOR(pg_catalog.=) pg_catalog.current_database()
                   )`,
        }, { domain: "promoted-memory", operation: "countHeldAdvisoryLocks" });
        return held.rows[0].held;
      };

      try {
        // A content-grained key would hold one lock per distinct entry here,
        // which is what exhausted the shared lock table on a large import.
        // Two locks are expected throughout: the shared publication guard
        // this transaction already takes, plus one decision lock for the
        // project. The count after twenty-five entries must equal the count
        // after the first, because neither grows with the number decided.
        let afterFirstEntry = 0;
        const afterAllEntries = await storage.transaction(async (repositories) => {
          for (let entry = 0; entry < 25; entry++) {
            await deduplicateAndInsertInRepositories(repositories, {
              content: `bounded lock probe entry ${entry}`,
              tags: [],
              sourceProjectId: "a".repeat(64),
              candidateScope: "owner" as const,
              backend: "postgresql" as const,
              depth: 0,
              confidence: 0.9,
              thresholds: { dedupBm25Threshold: 0.5, dedupCandidateLimit: 10 },
            });
            if (entry === 0) afterFirstEntry = await advisoryLocksHeld();
          }
          return await advisoryLocksHeld();
        });
        expect({ afterFirstEntry, afterAllEntries }).toEqual({
          afterFirstEntry: 2,
          afterAllEntries: 2,
        });
        await expect(advisoryLocksHeld()).resolves.toBe(0);

        const stored = await database.migrator.query<{ stored: number }>({
          text: `SELECT count(*)::pg_catalog.int4 AS stored
                 FROM lcm.promoted_memories
                 WHERE project_id = $1 AND archived_at IS NULL`,
          values: [projectId],
        }, { domain: "promoted-memory", operation: "countBoundedLockRows" });
        expect(stored.rows[0].stored).toBe(25);
      } finally {
        await storage.close();
        await runtime.close();
      }
    });
  });
});
