import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlLexicalSearchRepository } from "../../src/storage/postgresql/lexical-search-repository.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  exerciseLexicalSearchRepositoryConformance,
  type LexicalSearchConformanceFixtures,
} from "../storage/lexical-search-conformance.js";
import {
  assertHarnessReady,
  type PostgreSqlTestDatabase,
  settings,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

async function grantSearchRuntimePrivileges(
  database: PostgreSqlTestDatabase
): Promise<void> {
  const template = readFileSync(
    join(process.cwd(), "docs", "postgresql-runtime-search-grants.sql"),
    "utf8"
  );
  const sql = template
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await database.migrator.query(
    { text: sql },
    {
      domain: "lexical-search",
      operation: "grantSearchRuntimePrivileges",
    }
  );
}

async function createProject(
  database: PostgreSqlTestDatabase,
  label: string
): Promise<string> {
  const result = await database.migrator.query<{ project_id: string }>(
    {
      text: `INSERT INTO lcm.projects (identity_key, display_name)
           VALUES ($1, $2)
           RETURNING project_id`,
      values: [createHash("sha256").update(label).digest("hex"), label],
    },
    { domain: "identity", operation: "createSearchTestProject" }
  );
  return result.rows[0].project_id;
}

async function createConversation(
  database: PostgreSqlTestDatabase,
  projectId: string,
  sessionId: string
): Promise<number> {
  const result = await database.migrator.query<{
    conversation_id: string;
  }>(
    {
      text: `INSERT INTO lcm.conversations (
             project_id, session_id, title
           )
           VALUES ($1, $2, $3)
           RETURNING conversation_id::pg_catalog.text`,
      values: [projectId, sessionId, sessionId],
    },
    { domain: "conversations", operation: "seedSearchConversation" }
  );
  return Number(result.rows[0].conversation_id);
}

async function seedMessage(
  database: PostgreSqlTestDatabase,
  projectId: string,
  conversationId: number,
  input: {
    readonly seq: number;
    readonly role: "system" | "user" | "assistant" | "tool";
    readonly content: string;
  }
): Promise<{ readonly id: number; readonly createdAt: Date }> {
  const result = await database.migrator.query<{
    message_id: string;
    created_at: Date;
  }>(
    {
      text: `INSERT INTO lcm.messages (
             project_id, conversation_id, seq, role, content, token_count
           )
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING message_id::pg_catalog.text, created_at`,
      values: [
        projectId,
        conversationId,
        input.seq,
        input.role,
        input.content,
        input.content.split(/\s+/u).length,
      ],
    },
    { domain: "conversations", operation: "seedSearchMessage" }
  );
  return {
    id: Number(result.rows[0].message_id),
    createdAt: result.rows[0].created_at,
  };
}

async function seedSummary(
  database: PostgreSqlTestDatabase,
  projectId: string,
  conversationId: number,
  input: {
    readonly id: string;
    readonly kind: "leaf" | "condensed";
    readonly content: string;
  }
): Promise<string> {
  await database.migrator.query(
    {
      text: `INSERT INTO lcm.summaries (
             summary_id, project_id, conversation_id, kind,
             depth, content, token_count
           )
           VALUES ($1, $2, $3, $4, 0, $5, $6)`,
      values: [
        input.id,
        projectId,
        conversationId,
        input.kind,
        input.content,
        input.content.split(/\s+/u).length,
      ],
    },
    { domain: "summaries", operation: "seedSearchSummary" }
  );
  return input.id;
}

async function seedMemory(
  database: PostgreSqlTestDatabase,
  projectId: string,
  input: {
    readonly content: string;
    readonly tags: readonly string[];
    readonly sourceProjectId: string;
    readonly confidence: number;
  }
): Promise<string> {
  const inserted = await database.migrator.query<{ memory_id: string }>(
    {
      text: `INSERT INTO lcm.promoted_memories (
             project_id, content, source_project_id, confidence
           )
           VALUES ($1, $2, $3, $4)
           RETURNING memory_id`,
      values: [
        projectId,
        input.content,
        input.sourceProjectId,
        input.confidence,
      ],
    },
    { domain: "promoted-memory", operation: "seedSearchMemory" }
  );
  const memoryId = inserted.rows[0].memory_id;
  if (input.tags.length > 0) {
    await database.migrator.query(
      {
        text: `INSERT INTO lcm.promoted_memory_tags (
               project_id, memory_id, ordinal, tag
             )
             SELECT
               $1::pg_catalog.uuid,
               $2::pg_catalog.uuid,
               source.ordinality - 1,
               source.tag
             FROM pg_catalog.unnest($3::pg_catalog.text[])
               WITH ORDINALITY AS source(tag, ordinality)`,
        values: [projectId, memoryId, [...input.tags]],
      },
      { domain: "promoted-memory", operation: "seedSearchMemoryTags" }
    );
  }
  return memoryId;
}

async function seedConformanceFixtures(
  database: PostgreSqlTestDatabase,
  projectId: string
): Promise<LexicalSearchConformanceFixtures> {
  const primaryConversationId = await createConversation(
    database,
    projectId,
    "lexical-primary"
  );
  const secondaryConversationId = await createConversation(
    database,
    projectId,
    "lexical-secondary"
  );
  const accented = await seedMessage(
    database,
    projectId,
    primaryConversationId,
    {
      seq: 0,
      role: "user",
      content: "Café βeta foo_bar() C++ needle accented",
    }
  );
  const regex = await seedMessage(database, projectId, primaryConversationId, {
    seq: 1,
    role: "assistant",
    content: "punctuation [ok] needle-2046",
  });
  const isolated = await seedMessage(
    database,
    projectId,
    secondaryConversationId,
    {
      seq: 0,
      role: "tool",
      content: "isolated needle",
    }
  );
  const accentedSummary = await seedSummary(
    database,
    projectId,
    primaryConversationId,
    {
      id: "lexical-summary-accented",
      kind: "leaf",
      content: "Café summary needle",
    }
  );
  const regexSummary = await seedSummary(
    database,
    projectId,
    primaryConversationId,
    {
      id: "lexical-summary-regex",
      kind: "condensed",
      content: "punctuation summary-2047 needle",
    }
  );
  const isolatedSummary = await seedSummary(
    database,
    projectId,
    secondaryConversationId,
    {
      id: "lexical-summary-isolated",
      kind: "leaf",
      content: "isolated summary needle",
    }
  );
  const sourceProjectId = "source-project-a";
  const isolatedSourceProjectId = "source-project-b";
  const contentMemoryId = await seedMemory(database, projectId, {
    content: "primarydurable durable memory",
    tags: ["architecture"],
    sourceProjectId,
    confidence: 0.8,
  });
  const tagMemoryId = await seedMemory(database, projectId, {
    content: "unrelated recollection",
    tags: ["tagonly", "required"],
    sourceProjectId,
    confidence: 0.7,
  });
  const isolatedMemoryId = await seedMemory(database, projectId, {
    content: "isolateddurable durable memory",
    tags: ["isolated"],
    sourceProjectId: isolatedSourceProjectId,
    confidence: 0.6,
  });
  return {
    primaryConversationId,
    secondaryConversationId,
    messageIds: {
      accented: accented.id,
      regex: regex.id,
      isolated: isolated.id,
    },
    summaryIds: {
      accented: accentedSummary,
      regex: regexSummary,
      isolated: isolatedSummary,
    },
    memoryIds: {
      content: contentMemoryId,
      tagOnly: tagMemoryId,
      isolated: isolatedMemoryId,
    },
    sourceProjectId,
    isolatedSourceProjectId,
    searchTimestamp: accented.createdAt,
  };
}

function planText(value: unknown): string {
  return JSON.stringify(value);
}

describe("PostgreSQL 18 lexical search", () => {
  it("requires and admits only the reviewed read-only search grants", async () => {
    await withPostgreSqlTestDatabase("search-grants", async (database) => {
      const projectId = await createProject(database, "Search grants");
      const conversationId = await createConversation(
        database,
        projectId,
        "search-grants"
      );
      await seedMessage(database, projectId, conversationId, {
        seq: 0,
        role: "user",
        content: "granted needle",
      });
      const repository = new PostgreSqlLexicalSearchRepository(
        database.runtime,
        projectId
      );
      await expect(
        repository.searchMessages({
          query: "needle",
          mode: "full_text",
        })
      ).rejects.toMatchObject({
        backend: "postgresql",
        domain: "lexical-search",
        operation: "searchMessages",
        projectId,
      });

      await grantSearchRuntimePrivileges(database);
      await expect(
        repository.searchMessages({
          query: "needle",
          mode: "full_text",
        })
      ).resolves.toHaveLength(1);

      const privileges = await database.migrator.query<{
        schema_usage: boolean;
        schema_create: boolean;
        messages_select: boolean;
        messages_insert: boolean;
        summaries_select: boolean;
        summaries_update: boolean;
        memories_select: boolean;
        memories_delete: boolean;
        tags_select: boolean;
        tags_insert: boolean;
        conversations_select: boolean;
        normalize_execute: boolean;
        normalize_grant_option: boolean;
      }>(
        {
          text: `SELECT
                 has_schema_privilege(
                   'lcm_test_runtime', 'lcm', 'USAGE'
                 ) AS schema_usage,
                 has_schema_privilege(
                   'lcm_test_runtime', 'lcm', 'CREATE'
                 ) AS schema_create,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.messages', 'SELECT'
                 ) AS messages_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.messages', 'INSERT'
                 ) AS messages_insert,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.summaries', 'SELECT'
                 ) AS summaries_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.summaries', 'UPDATE'
                 ) AS summaries_update,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.promoted_memories', 'SELECT'
                 ) AS memories_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.promoted_memories', 'DELETE'
                 ) AS memories_delete,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.promoted_memory_tags', 'SELECT'
                 ) AS tags_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.promoted_memory_tags', 'INSERT'
                 ) AS tags_insert,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.conversations', 'SELECT'
                 ) AS conversations_select,
                 has_function_privilege(
                   'lcm_test_runtime',
                   'lcm.normalize_search_text(text)',
                   'EXECUTE'
                 ) AS normalize_execute,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_proc AS procedure
                   CROSS JOIN LATERAL pg_catalog.aclexplode(
                     procedure.proacl
                   ) AS privilege
                   WHERE procedure.oid
                     = 'lcm.normalize_search_text(text)'::pg_catalog.regprocedure
                     AND privilege.grantee
                       = 'lcm_test_runtime'::pg_catalog.regrole
                     AND privilege.is_grantable
                 ) AS normalize_grant_option`,
        },
        {
          domain: "lexical-search",
          operation: "inspectSearchRuntimePrivileges",
        }
      );
      expect(privileges.rows[0]).toEqual({
        schema_usage: true,
        schema_create: false,
        messages_select: true,
        messages_insert: false,
        summaries_select: true,
        summaries_update: false,
        memories_select: true,
        memories_delete: false,
        tags_select: true,
        tags_insert: false,
        conversations_select: false,
        normalize_execute: true,
        normalize_grant_option: false,
      });
    });
  });

  it("passes golden parity, project isolation, and 2046/2047-byte routing", async () => {
    await withPostgreSqlTestDatabase("search-parity", async (database) => {
      await grantSearchRuntimePrivileges(database);
      const projectId = await createProject(database, "Search parity");
      const otherProjectId = await createProject(
        database,
        "Search parity isolated"
      );
      const fixtures = await seedConformanceFixtures(database, projectId);
      const otherConversationId = await createConversation(
        database,
        otherProjectId,
        "isolated-project"
      );
      await seedMessage(database, otherProjectId, otherConversationId, {
        seq: 0,
        role: "system",
        content: "cross-project needle",
      });
      const otherMemory = await seedMemory(database, otherProjectId, {
        content: "cross-project primarydurable",
        tags: ["tagonly"],
        sourceProjectId: fixtures.sourceProjectId,
        confidence: 1,
      });

      const repository = new PostgreSqlLexicalSearchRepository(
        database.runtime,
        projectId
      );
      await exerciseLexicalSearchRepositoryConformance(repository, fixtures);
      expect(
        await repository.searchMessages({
          query: "cross-project",
          mode: "full_text",
        })
      ).toEqual([]);
      expect(
        (await repository.searchPromoted("cross-project", 10)).map(
          (row) => row.id
        )
      ).not.toContain(otherMemory);

      const boundaryConversationId = await createConversation(
        database,
        projectId,
        "lexeme-boundary"
      );
      const acceptedLexeme = "a".repeat(2_046);
      const fallbackLexeme = "b".repeat(2_047);
      const accepted = await seedMessage(
        database,
        projectId,
        boundaryConversationId,
        {
          seq: 0,
          role: "user",
          content: acceptedLexeme,
        }
      );
      const fallback = await seedMessage(
        database,
        projectId,
        boundaryConversationId,
        {
          seq: 1,
          role: "assistant",
          content: fallbackLexeme,
        }
      );
      const boundary = await database.migrator.query<{
        normalized_bytes: number;
        full_text_matches: boolean;
      }>(
        {
          text: `SELECT
                 pg_catalog.octet_length(
                   lcm.normalize_search_text($1)
                 ) AS normalized_bytes,
                 pg_catalog.to_tsvector(
                   'lcm.search_v1'::pg_catalog.regconfig,
                   lcm.normalize_search_text($1)
                 ) OPERATOR(pg_catalog.@@)
                 pg_catalog.websearch_to_tsquery(
                   'lcm.search_v1'::pg_catalog.regconfig,
                   lcm.normalize_search_text($1)
                 ) AS full_text_matches`,
          values: [acceptedLexeme],
        },
        { domain: "lexical-search", operation: "inspectAcceptedLexeme" }
      );
      expect(boundary.rows[0]).toEqual({
        normalized_bytes: 2_046,
        full_text_matches: true,
      });
      const oversized = await database.migrator.query<{
        normalized_bytes: number;
        vector: string;
      }>(
        {
          text: `SELECT
                 pg_catalog.octet_length(
                   lcm.normalize_search_text($1)
                 ) AS normalized_bytes,
                 pg_catalog.to_tsvector(
                   'lcm.search_v1'::pg_catalog.regconfig,
                   lcm.normalize_search_text($1)
                 )::pg_catalog.text AS vector`,
          values: [fallbackLexeme],
        },
        { domain: "lexical-search", operation: "inspectOversizedLexeme" }
      );
      expect(oversized.rows[0]).toEqual({
        normalized_bytes: 2_047,
        vector: "",
      });
      expect(
        await repository.searchMessages({
          query: acceptedLexeme,
          mode: "full_text",
          conversationId: boundaryConversationId,
          limit: 5,
        })
      ).toMatchObject([{ messageId: accepted.id }]);
      expect(
        await repository.searchMessages({
          query: fallbackLexeme,
          mode: "full_text",
          conversationId: boundaryConversationId,
          limit: 5,
        })
      ).toMatchObject([{ messageId: fallback.id }]);
    });
  });

  it("contains cancellation and restores caller and pooled statement timeouts", async () => {
    await withPostgreSqlTestDatabase("search-timeout", async (database) => {
      await grantSearchRuntimePrivileges(database);
      const projectId = await createProject(database, "Search timeout");
      const conversationId = await createConversation(
        database,
        projectId,
        "search-timeout"
      );
      await database.migrator.query(
        {
          text: `INSERT INTO lcm.messages (
                 project_id, conversation_id, seq, role, content, token_count
               )
               SELECT
                 $1,
                 $2,
                 source.ordinal,
                 'user',
                 pg_catalog.repeat('a', 4000)
                   OPERATOR(pg_catalog.||) source.ordinal::pg_catalog.text,
                 1
               FROM pg_catalog.generate_series(1, 1000) AS source(ordinal)`,
          values: [projectId, conversationId],
        },
        { domain: "lexical-search", operation: "seedTimeoutCorpus" }
      );

      const lowTimeoutRuntime = new PostgreSqlRuntime(
        settings(database.runtimeUrl, { poolMax: 1, statementTimeoutMs: 1 })
      );
      const lowTimeoutRepository = new PostgreSqlLexicalSearchRepository(
        lowTimeoutRuntime,
        projectId
      );
      try {
        await expect(
          lowTimeoutRepository.searchMessages({
            query: "z$",
            mode: "regex",
            limit: 50,
          })
        ).rejects.toMatchObject({
          domain: "lexical-search",
          operation: "searchMessages",
          sqlState: "57014",
          retryable: false,
        });
        const pooled = await lowTimeoutRuntime.query<{
          timeout: string;
          usable: number;
        }>(
          {
            text: `SELECT
                   pg_catalog.current_setting('statement_timeout') AS timeout,
                   1::pg_catalog.int4 AS usable`,
          },
          { domain: "lexical-search", operation: "verifyPoolAfterTimeout" }
        );
        expect(pooled.rows[0]).toEqual({ timeout: "1ms", usable: 1 });
      } finally {
        await lowTimeoutRuntime.close();
      }

      await database.runtime.transaction(async (transaction) => {
        await transaction.query(
          {
            text: "SET LOCAL statement_timeout = '1ms'",
          },
          { domain: "lexical-search", operation: "setCallerTimeout" }
        );
        const scoped = new PostgreSqlLexicalSearchRepository(
          transaction,
          projectId
        );
        await expect(
          scoped.searchMessages({
            query: "z$",
            mode: "regex",
            limit: 50,
          })
        ).rejects.toMatchObject({ sqlState: "57014" });
        const restored = await transaction.query<{ timeout: string }>(
          {
            text: `SELECT pg_catalog.current_setting(
                   'statement_timeout'
                 ) AS timeout`,
          },
          { domain: "lexical-search", operation: "verifyCallerTimeout" }
        );
        expect(restored.rows[0].timeout).toBe("1ms");
        await transaction.query(
          {
            text: "SET LOCAL statement_timeout = '5s'",
          },
          { domain: "lexical-search", operation: "restoreCallerBudget" }
        );
        await expect(
          transaction.query(
            {
              text: "SELECT 1",
            },
            { domain: "lexical-search", operation: "verifyCallerUsable" }
          )
        ).resolves.toMatchObject({ rowCount: 1 });
      });

      const pooled = await database.runtime.query<{
        timeout: string;
        usable: number;
      }>(
        {
          text: `SELECT
                 pg_catalog.current_setting('statement_timeout') AS timeout,
                 1::pg_catalog.int4 AS usable`,
        },
        { domain: "lexical-search", operation: "verifyDefaultPool" }
      );
      expect(pooled.rows[0]).toEqual({ timeout: "5s", usable: 1 });
    });
  });

  it("uses all eight shipped GIN indexes with the default planner", async () => {
    await withPostgreSqlTestDatabase("search-plans", async (database) => {
      const projectId = await createProject(database, "Search plans");
      const conversationId = await createConversation(
        database,
        projectId,
        "search-plans"
      );
      const corpusSize = 4_000;
      await database.migrator.transaction(
        async (transaction) => {
          const context = {
            domain: "lexical-search",
            operation: "seedPlannerCorpus",
          } as const;
          await transaction.query(
            {
              text: "SET LOCAL statement_timeout = '30s'",
            },
            context
          );
          const seeds = [
            {
              text: `INSERT INTO lcm.messages (
                     project_id, conversation_id, seq, role,
                     content, token_count
                   )
                   SELECT
                     $1,
                     $2,
                     source.ordinal,
                     'user',
                     CASE
                       WHEN source.ordinal OPERATOR(pg_catalog.=) $3
                         THEN 'planner_needle message'
                       ELSE 'message filler '
                         OPERATOR(pg_catalog.||)
                         source.ordinal::pg_catalog.text
                     END,
                     1
                   FROM pg_catalog.generate_series(
                     1,
                     $3
                   ) AS source(ordinal)`,
              values: [projectId, conversationId, corpusSize],
            },
            {
              text: `INSERT INTO lcm.summaries (
                     summary_id, project_id, conversation_id, kind,
                     depth, content, token_count
                   )
                   SELECT
                     'planner-summary-'
                       OPERATOR(pg_catalog.||)
                       source.ordinal::pg_catalog.text,
                     $1,
                     $2,
                     'leaf',
                     0,
                     CASE
                       WHEN source.ordinal OPERATOR(pg_catalog.=) $3
                         THEN 'planner_needle summary'
                       ELSE 'summary filler '
                         OPERATOR(pg_catalog.||)
                         source.ordinal::pg_catalog.text
                     END,
                     1
                   FROM pg_catalog.generate_series(
                     1,
                     $3
                   ) AS source(ordinal)`,
              values: [projectId, conversationId, corpusSize],
            },
            {
              text: `INSERT INTO lcm.promoted_memories (
                     project_id, content, source_project_id
                   )
                   SELECT
                     $1,
                     CASE
                       WHEN source.ordinal OPERATOR(pg_catalog.=) $2
                         THEN 'planner_needle memory'
                       ELSE 'memory filler '
                         OPERATOR(pg_catalog.||)
                         source.ordinal::pg_catalog.text
                     END,
                     'planner-source'
                   FROM pg_catalog.generate_series(
                     1,
                     $2
                   ) AS source(ordinal)`,
              values: [projectId, corpusSize],
            },
            {
              text: `WITH ranked AS (
                     SELECT
                       memory.project_id,
                       memory.memory_id,
                       pg_catalog.row_number() OVER (
                         ORDER BY memory.memory_id
                       ) AS ordinal
                     FROM lcm.promoted_memories AS memory
                     WHERE memory.project_id
                       OPERATOR(pg_catalog.=) $1
                   )
                   INSERT INTO lcm.promoted_memory_tags (
                     project_id, memory_id, ordinal, tag
                   )
                   SELECT
                     ranked.project_id,
                     ranked.memory_id,
                     0,
                     CASE
                       WHEN ranked.ordinal OPERATOR(pg_catalog.=) $2
                         THEN 'planner_needle tag'
                       ELSE 'tag filler '
                         OPERATOR(pg_catalog.||)
                         ranked.ordinal::pg_catalog.text
                     END
                   FROM ranked`,
              values: [projectId, corpusSize],
            },
          ];
          for (const seed of seeds) {
            await transaction.query(seed, context);
          }
          for (const table of [
            "messages",
            "summaries",
            "promoted_memories",
            "promoted_memory_tags",
          ]) {
            await transaction.query(
              {
                text: `ANALYZE lcm.${table}`,
              },
              context
            );
          }
        },
        { domain: "lexical-search", operation: "seedPlannerCorpus" }
      );
      for (const table of [
        "messages",
        "summaries",
        "promoted_memories",
        "promoted_memory_tags",
      ]) {
        await database.migrator.query(
          {
            text: `VACUUM (ANALYZE) lcm.${table}`,
          },
          {
            domain: "lexical-search",
            operation: "flushSearchGinPendingList",
          }
        );
      }

      const plans = [
        [
          "messages_search_document_idx",
          `SELECT message_id
          FROM lcm.messages
          WHERE search_document OPERATOR(pg_catalog.@@)
            pg_catalog.websearch_to_tsquery(
              'lcm.search_v1'::pg_catalog.regconfig,
              'planner_needle'
            )`,
        ],
        [
          "messages_content_trgm_idx",
          `SELECT message_id
          FROM lcm.messages
          WHERE lcm.normalize_search_text(content)
            OPERATOR(pg_catalog.~~) '%planner_needle%'`,
        ],
        [
          "summaries_search_document_idx",
          `SELECT summary_id
          FROM lcm.summaries
          WHERE search_document OPERATOR(pg_catalog.@@)
            pg_catalog.websearch_to_tsquery(
              'lcm.search_v1'::pg_catalog.regconfig,
              'planner_needle'
            )`,
        ],
        [
          "summaries_content_trgm_idx",
          `SELECT summary_id
          FROM lcm.summaries
          WHERE lcm.normalize_search_text(content)
            OPERATOR(pg_catalog.~~) '%planner_needle%'`,
        ],
        [
          "promoted_memories_search_document_idx",
          `SELECT memory_id
          FROM lcm.promoted_memories
          WHERE search_document OPERATOR(pg_catalog.@@)
            pg_catalog.websearch_to_tsquery(
              'lcm.search_v1'::pg_catalog.regconfig,
              'planner_needle'
            )`,
        ],
        [
          "promoted_memories_content_trgm_idx",
          `SELECT memory_id
          FROM lcm.promoted_memories
          WHERE lcm.normalize_search_text(content)
            OPERATOR(pg_catalog.~~) '%planner_needle%'`,
        ],
        [
          "promoted_memory_tags_search_document_idx",
          `SELECT memory_id
          FROM lcm.promoted_memory_tags
          WHERE search_document OPERATOR(pg_catalog.@@)
            pg_catalog.websearch_to_tsquery(
              'lcm.search_v1'::pg_catalog.regconfig,
              'planner_needle'
            )`,
        ],
        [
          "promoted_memory_tags_tag_trgm_idx",
          `SELECT memory_id
          FROM lcm.promoted_memory_tags
          WHERE lcm.normalize_search_text(tag)
            OPERATOR(pg_catalog.~~) '%planner_needle%'`,
        ],
      ] as const;
      const evidence: Record<string, unknown> = {};
      for (const [indexName, query] of plans) {
        const explained = await database.migrator.query<{
          "QUERY PLAN": unknown;
        }>(
          {
            text: `EXPLAIN (
                   ANALYZE,
                   BUFFERS,
                   COSTS,
                   FORMAT JSON,
                   TIMING FALSE
                 ) ${query}`,
          },
          { domain: "lexical-search", operation: "explainSearchIndex" }
        );
        const plan = explained.rows[0]["QUERY PLAN"];
        expect(planText(plan)).toContain(indexName);
        evidence[indexName] = plan;
      }
      process.stdout.write(
        `PostgreSQL lexical benchmark evidence: ${JSON.stringify({
          corpusSize,
          plans: evidence,
        })}\n`
      );
    });
  });
});
