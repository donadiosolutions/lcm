import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POSTGRESQL_MIGRATION_SCHEMA_MANIFEST_SHA256,
  POSTGRESQL_MIGRATION_TABLE_NAMES,
  POSTGRESQL_MIGRATION_TEST_SEAMS,
  PostgreSqlMigrationAdapter,
  type PostgreSqlMigrationFence,
  type PostgreSqlMigrationIdentity,
  type PostgreSqlMigrationRuntime,
} from "../../src/storage/postgresql/migration-adapter.js";
import type {
  PostgreSqlOperationContext,
  PostgreSqlQueryOptions,
  PostgreSqlTransactionScopeExecutor,
} from "../../src/storage/postgresql/contracts.js";
import { PostgreSqlWorkCoordinator } from "../../src/storage/postgresql/coordination.js";
import { PostgreSqlCommitOutcomeUnknownError } from "../../src/storage/postgresql/errors.js";
import type { MigrationRow } from "../../src/storage/sqlite/migration-adapter.js";

const localProjectId = "a".repeat(64);
const remoteProjectId = "018f1234-5678-7abc-8def-0123456789ab";
const machineId = "018f1234-5678-7abc-8def-0123456789ac";
const now = "2026-08-01T12:00:00.000Z";
const identity: PostgreSqlMigrationIdentity = {
  localProjectId,
  remoteProjectId,
  machineId,
  aliases: ["/workspace/project", "/workspace/alias"],
};
const fence: PostgreSqlMigrationFence = {
  resourceType: "storage-migration",
  resourceKey: "generation",
  processId: "migration-test",
  operation: "reversible-storage-migration",
  fencingToken: 7n,
};
const roots: string[] = [];

function queryResult<R extends QueryResultRow>(rows: R[], command = "SELECT"): QueryResult<R> {
  return { rows, rowCount: rows.length, command, oid: 0, fields: [] };
}

type QueryInput = { readonly text: string; readonly values?: readonly unknown[] };
type Handler = (config: QueryInput, options: PostgreSqlQueryOptions) => QueryResultRow[];

function fakeRuntime(handler: Handler, transactionHandler: Handler = handler): PostgreSqlMigrationRuntime {
  const query = async <R extends QueryResultRow>(config: QueryConfig, options: PostgreSqlQueryOptions): Promise<QueryResult<R>> => queryResult(handler(config as QueryInput, options) as R[]);
  const transactionQuery = async <R extends QueryResultRow>(config: QueryConfig, options: PostgreSqlQueryOptions): Promise<QueryResult<R>> => queryResult(transactionHandler(config as QueryInput, options) as R[]);
  const transaction = {
    transactionScope: "active" as const,
    query: transactionQuery,
    savepoint: async <T>(callback: (savepoint: PostgreSqlTransactionScopeExecutor) => Promise<T>): Promise<T> => callback(transaction),
  } as unknown as PostgreSqlTransactionScopeExecutor;
  return {
    query,
    transaction: async <T>(callback: (scope: PostgreSqlTransactionScopeExecutor) => Promise<T>): Promise<T> => callback(transaction),
  };
}

class MemoryRuntime {
  readonly stored = new Map<string, QueryResultRow>();
  readonly pending = new Map<string, string>();
  readonly operations: string[] = [];
  uncertainAfterCommit = false;
  discardBeforeUncertainReadback = false;
  suppressInsertedReadback = false;

  private key(table: string, values: readonly unknown[] | undefined): string {
    return `${table}:${JSON.stringify(values ?? [])}`;
  }

  private rows(config: QueryInput, options: PostgreSqlQueryOptions): QueryResultRow[] {
    this.operations.push(options.operation);
    const table = options.operation.split(":")[1] ?? "";
    if (options.operation === "migrationResolveConversation") return [{ conversation_id: "1" }];
    if (options.operation.startsWith("migrationReadExisting:")) {
      const key = this.key(table, config.values);
      this.pending.set(table, key);
      const existing = this.stored.get(key);
      return existing ? [existing] : [];
    }
    if (options.operation.startsWith("migrationInsert:")) {
      const columns = /\(([^)]+)\) VALUES/u.exec(config.text)?.[1]?.split(", ") ?? [];
      const values = config.values ?? [];
      const row = Object.fromEntries(columns.map((column, index) => {
        const value = values[index];
        return [column, column === "metadata" && typeof value === "string" ? JSON.parse(value) as unknown : value];
      }));
      this.stored.set(this.pending.get(table)!, row);
      return [];
    }
    if (options.operation.startsWith("migrationReadInserted:")) {
      if (this.suppressInsertedReadback) return [];
      const row = this.stored.get(this.key(table, config.values));
      return row ? [row] : [];
    }
    if (options.operation.startsWith("migrationAuthoritativeReadback:")) {
      const row = this.stored.get(this.key(table, config.values));
      return row ? [row] : [];
    }
    return [];
  }

  asRuntime(): PostgreSqlMigrationRuntime {
    const rootQuery = async <R extends QueryResultRow>(config: QueryConfig, options: PostgreSqlQueryOptions): Promise<QueryResult<R>> => queryResult(this.rows(config as QueryInput, options) as R[]);
    const scope = {
      transactionScope: "active" as const,
      query: rootQuery,
      savepoint: async <T>(callback: (savepoint: PostgreSqlTransactionScopeExecutor) => Promise<T>): Promise<T> => callback(scope),
    } as unknown as PostgreSqlTransactionScopeExecutor;
    return {
      query: rootQuery,
      transaction: async <T>(callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>, options: PostgreSqlOperationContext): Promise<T> => {
        const value = await callback(scope);
        if (this.uncertainAfterCommit) {
          if (this.discardBeforeUncertainReadback) this.stored.clear();
          throw new PostgreSqlCommitOutcomeUnknownError(options);
        }
        return value;
      },
    };
  }
}

function allRows(): Readonly<Record<string, readonly MigrationRow[]>> {
  return {
    conversations: [{ conversation_id: 1, session_id: "session", title: null, bootstrapped_at: null, created_at: now, updated_at: now }],
    messages: [{ message_id: 1, conversation_id: 1, seq: 0, role: "user", content: "hello", token_count: 1, created_at: now }],
    message_parts: [{ part_id: "018f1234-5678-7abc-8def-0123456789ad", message_id: 1, session_id: "session", part_type: "text", ordinal: 0, text_content: "hello", is_ignored: false, is_synthetic: false, tool_call_id: null, tool_name: null, tool_status: null, tool_input: null, tool_output: null, tool_error: null, tool_title: null, patch_hash: null, patch_files: null, file_mime: null, file_name: null, file_url: null, subtask_prompt: null, subtask_desc: null, subtask_agent: null, step_reason: null, step_cost: null, step_tokens_in: null, step_tokens_out: null, snapshot_hash: null, compaction_auto: null, metadata: null }],
    summaries: [{ summary_id: "summary", conversation_id: 1, kind: "leaf", depth: 0, content: "summary", token_count: 1, earliest_at: now, latest_at: now, descendant_count: 0, descendant_token_count: 0, source_message_token_count: 1, created_at: now }],
    summary_messages: [{ summary_id: "summary", message_id: 1, ordinal: 0 }],
    summary_parents: [{ summary_id: "summary", parent_summary_id: "parent", ordinal: 0 }],
    context_items: [{ conversation_id: 1, ordinal: 0, item_type: "message", message_id: 1, summary_id: null, created_at: now }],
    large_files: [{ file_id: "file", conversation_id: 1, file_name: null, mime_type: null, byte_size: null, storage_uri: "private://file", exploration_summary: null, created_at: now }],
    summary_large_files: [{ summary_id: "summary", file_ids: ["file"] }],
    promoted_memories: [{ memory_id: "018f1234-5678-7abc-8def-0123456789ae", content: "memory", metadata: { safe: true }, source_summary_id: null, source_project_id: localProjectId, session_id: null, depth: 0, confidence: 1, created_at: now, archived_at: null }],
    promoted_memory_tags: [{ memory_id: "018f1234-5678-7abc-8def-0123456789ae", tags: ["one", "two"] }],
    recall_surfacing: [{ surfacing_id: 1, memory_id: "018f1234-5678-7abc-8def-0123456789ae", session_id: null, surfaced_at: now }],
    redaction_counters: [{ project_id: localProjectId, category: "built_in", count: 1 }],
    session_ingest_log: [{ session_id: "session", message_count: 1, completed_at: now }],
    session_instructions: [{ project_id: localProjectId, scope_hash: "b".repeat(64), client_name: "codex", session_id: "session", worktree_path: "/workspace", cwd_path: "/workspace", content: "instructions", content_hash: "c".repeat(64), updated_at: now }],
  };
}

function privateDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "lcm-postgresql-migration-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PostgreSQL migration normalization and planning", () => {
  it("normalizes driver scalar, temporal, JSON, bigint, and binary values", () => {
    const seam = POSTGRESQL_MIGRATION_TEST_SEAMS;
    expect(seam.text("safe", "field")).toBe("safe");
    expect(seam.safeInteger(1, "field")).toBe(1);
    expect(seam.safeInteger("2", "field")).toBe(2);
    expect(seam.finite(1.5, "field")).toBe(1.5);
    expect(seam.finite("1.5", "field")).toBe(1.5);
    expect(seam.timestamp(null, "field")).toBeNull();
    expect(seam.timestamp(new Date(now), "field")).toBe(now);
    expect(seam.timestamp(now, "field")).toBe(now);
    expect(seam.jsonValue('{"z":1,"a":2}')).toEqual({ a: 2, z: 1 });
    expect(seam.jsonValue({ z: 1, a: 2 })).toEqual({ a: 2, z: 1 });
    expect(seam.uuid(remoteProjectId.toUpperCase(), "field")).toBe(remoteProjectId);
    expect(seam.baseRow({
      conversation_id: "1",
      confidence: "1.5",
      created_at: new Date(now),
      archived_at: null,
      tags: '["tag"]',
      nil: null,
      text: "text",
      boolean: true,
      number: 3,
      bigint: 4n,
      date: new Date(now),
      buffer: Buffer.from("ab", "hex"),
      object: { z: 1, a: 2 },
    })).toEqual({ conversation_id: 1, confidence: 1.5, created_at: now, archived_at: null, tags: ["tag"], nil: null, text: "text", boolean: true, number: 3, bigint: { $integer: "4" }, date: now, buffer: "ab", object: { a: 2, z: 1 } });
    expect(seam.baseRow({ conversation_id: null, confidence: null, tags: null })).toEqual({ conversation_id: null, confidence: null, tags: null });

    expect(() => seam.text(1, "field")).toThrow("field is not valid text");
    expect(() => seam.text("bad\0text", "field")).toThrow("field is not valid text");
    expect(() => seam.safeInteger("1.5", "field")).toThrow("field exceeds SQLite's safe integer migration range");
    expect(() => seam.safeInteger(Number.MAX_SAFE_INTEGER + 1, "field")).toThrow("field exceeds SQLite's safe integer migration range");
    expect(() => seam.finite("bad", "field")).toThrow("field is not finite");
    expect(() => seam.finite(null, "field")).toThrow("field is not finite");
    expect(() => seam.timestamp("bad", "field")).toThrow("field is not a timestamp");
    expect(() => seam.timestamp(1, "field")).toThrow("field is not valid text");
    expect(() => seam.jsonValue("bad-json")).toThrow();
    expect(() => seam.uuid("bad", "field")).toThrow("field is not a UUID");
  });

  it("builds stable plans for every dependency-ordered logical table", async () => {
    const executor = fakeRuntime((_config, options) => options.operation === "migrationResolveConversation" ? [{ conversation_id: "1" }] : []);
    for (const table of POSTGRESQL_MIGRATION_TABLE_NAMES) {
      const plans = await POSTGRESQL_MIGRATION_TEST_SEAMS.plansForRow(executor, identity, table, allRows()[table]![0]!);
      expect(plans.length, table).toBeGreaterThan(0);
      expect(plans.every((plan) => plan.table.length > 0), table).toBe(true);
    }
    const summaryContext = await POSTGRESQL_MIGRATION_TEST_SEAMS.plansForRow(executor, identity, "context_items", { ...allRows().context_items![0]!, message_id: null, summary_id: "summary" });
    expect(summaryContext[0]?.values).toContain(POSTGRESQL_MIGRATION_TEST_SEAMS.deterministicUuid(remoteProjectId, "summary", "summary"));
    const summaryFiles = await POSTGRESQL_MIGRATION_TEST_SEAMS.plansForRow(executor, identity, "summary_large_files", { summary_id: "summary", file_ids: [] });
    const tags = await POSTGRESQL_MIGRATION_TEST_SEAMS.plansForRow(executor, identity, "promoted_memory_tags", { memory_id: "018f1234-5678-7abc-8def-0123456789ae", tags: [] });
    expect(summaryFiles).toEqual([]);
    expect(tags).toEqual([]);
    expect(POSTGRESQL_MIGRATION_TEST_SEAMS.deterministicUuid(remoteProjectId, "summary", "summary")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("rejects malformed rows, arrays, tables, and missing dependencies", async () => {
    const executor = fakeRuntime(() => []);
    const resolved = fakeRuntime((_config, options) => options.operation === "migrationResolveConversation" ? [{ conversation_id: "1" }] : []);
    await expect(POSTGRESQL_MIGRATION_TEST_SEAMS.plansForRow(executor, identity, "summary_messages", allRows().summary_messages![0]!)).rejects.toThrow("missing migration dependency in summaries");
    await expect(POSTGRESQL_MIGRATION_TEST_SEAMS.plansForRow(executor, identity, "message_parts", allRows().message_parts![0]!)).rejects.toThrow("missing migration dependency in messages");
    await expect(POSTGRESQL_MIGRATION_TEST_SEAMS.plansForRow(resolved, identity, "summary_large_files", { summary_id: "summary", file_ids: [1] })).rejects.toThrow("file_ids is not a text array");
    await expect(POSTGRESQL_MIGRATION_TEST_SEAMS.plansForRow(executor, identity, "promoted_memory_tags", { memory_id: "018f1234-5678-7abc-8def-0123456789ae", tags: [1] })).rejects.toThrow("tags is not a text array");
    await expect(POSTGRESQL_MIGRATION_TEST_SEAMS.plansForRow(executor, identity, "unknown", {})).rejects.toThrow("unknown PostgreSQL migration table: unknown");
    expect(() => POSTGRESQL_MIGRATION_TEST_SEAMS.rowValue({}, "missing")).toThrow("migration row is missing missing");
    expect(() => POSTGRESQL_MIGRATION_TEST_SEAMS.logical("unknown")).toThrow("unknown PostgreSQL migration table: unknown");
  });

  it("compares exact plans across numeric, timestamp, bigint, date, buffer, and JSON driver representations", () => {
    const seam = POSTGRESQL_MIGRATION_TEST_SEAMS;
    const plan = seam.makePlan("example", ["number", "timestamp", "bigint", "date", "buffer", "json"], [1, now, 2n, new Date(now), Buffer.from("ab", "hex"), { a: 1 }], ["number"], [1], ["timestamp"]);
    expect(seam.selectPlan(plan)).toBe("SELECT number, timestamp, bigint, date, buffer, json FROM lcm.example WHERE number = $1");
    expect(seam.matches(plan, { number: "1", timestamp: new Date(now), bigint: "2", date: now, buffer: "ab", json: { a: 1 } })).toBe(true);
    expect(seam.matches(plan, undefined)).toBe(false);
    expect(seam.matches(plan, { number: "2", timestamp: now, bigint: "2", date: now, buffer: "ab", json: { a: 1 } })).toBe(false);
    expect(seam.comparable(null, false)).toBeNull();
  });

  it("reads an exact single stable plan and rejects duplicate keys", async () => {
    const plan = POSTGRESQL_MIGRATION_TEST_SEAMS.makePlan("example", ["id"], [1], ["id"], [1]);
    const single = fakeRuntime(() => [{ id: 1 }]);
    await expect(POSTGRESQL_MIGRATION_TEST_SEAMS.readPlan(single, identity, plan, "read")).resolves.toEqual({ id: 1 });
    const duplicate = fakeRuntime(() => [{ id: 1 }, { id: 1 }]);
    await expect(POSTGRESQL_MIGRATION_TEST_SEAMS.readPlan(duplicate, identity, plan, "read", AbortSignal.abort())).rejects.toThrow("duplicate PostgreSQL migration key in example");
  });
});

describe("PostgreSQL migration destination and writes", () => {
  it("validates constructor identities", () => {
    expect(() => new PostgreSqlMigrationAdapter(fakeRuntime(() => []), { ...identity, localProjectId: "bad" })).toThrow("invalid local project identity hash");
    expect(() => new PostgreSqlMigrationAdapter(fakeRuntime(() => []), { ...identity, remoteProjectId: "bad" })).toThrow("remoteProjectId is not a UUID");
    expect(() => new PostgreSqlMigrationAdapter(fakeRuntime(() => []), { ...identity, machineId: "bad" })).toThrow("machineId is not a UUID");
  });

  it("accepts a project-specific empty destination while ignoring other projects", async () => {
    const adapter = new PostgreSqlMigrationAdapter(fakeRuntime((config) => config.text.includes("FROM lcm.projects") ? [{ identity_key: localProjectId }] : [{ count: "0" }]), identity);
    const state = await adapter.destinationState(AbortSignal.abort());
    expect(state.projectExists).toBe(true);
    expect(state.stateRows).toBe(0);
    expect(Object.keys(state.tableCounts)).toHaveLength(20);
    await expect(adapter.assertEmptyDestination()).resolves.toBeUndefined();
  });

  it("fails closed for missing, duplicate, divergent, occupied, and malformed destinations", async () => {
    const missing = new PostgreSqlMigrationAdapter(fakeRuntime((config) => config.text.includes("FROM lcm.projects") ? [] : [{ count: "0" }]), identity);
    await expect(missing.assertEmptyDestination()).rejects.toThrow("remote project identity is not registered");
    const absentCounts = new PostgreSqlMigrationAdapter(fakeRuntime(() => []), identity);
    expect((await absentCounts.destinationState()).stateRows).toBe(0);
    const duplicate = new PostgreSqlMigrationAdapter(fakeRuntime((config) => config.text.includes("FROM lcm.projects") ? [{ identity_key: localProjectId }, { identity_key: localProjectId }] : [{ count: "0" }]), identity);
    await expect(duplicate.destinationState()).rejects.toThrow("duplicate remote project identity");
    const divergent = new PostgreSqlMigrationAdapter(fakeRuntime((config) => config.text.includes("FROM lcm.projects") ? [{ identity_key: "b".repeat(64) }] : [{ count: "0" }]), identity);
    await expect(divergent.destinationState()).rejects.toThrow("remote project binding does not match the canonical local identity");
    const occupied = new PostgreSqlMigrationAdapter(fakeRuntime((config) => config.text.includes("FROM lcm.projects") ? [{ identity_key: localProjectId }] : [{ count: config.text.includes("FROM lcm.messages ") ? "2" : "0" }]), identity);
    await expect(occupied.assertEmptyDestination()).rejects.toThrow("remote project destination is not empty (messages:2)");
    const malformed = new PostgreSqlMigrationAdapter(fakeRuntime((config) => config.text.includes("FROM lcm.projects") ? [{ identity_key: localProjectId }] : [{ count: "unsafe" }]), identity);
    await expect(malformed.destinationState()).rejects.toThrow("exceeds SQLite's safe integer migration range");
  });

  it("verifies canonical aliases and the packaged schema ledger", async () => {
    const adapter = new PostgreSqlMigrationAdapter(fakeRuntime((_config, options) => {
      if (options.operation === "migrationVerifyAliases") return [{ path: "/workspace/alias" }, { path: "/workspace/project" }];
      if (options.operation === "migrationSchemaHistory") return [{ migration_id: "0001", sha256: "a".repeat(64) }];
      return [];
    }), { ...identity, aliases: [...identity.aliases, identity.aliases[0]!] });
    await expect(adapter.verifyAliases()).resolves.toBeUndefined();
    await expect(adapter.schemaHistory()).resolves.toEqual([{ id: "0001", sha256: "a".repeat(64) }]);
    const mismatch = new PostgreSqlMigrationAdapter(fakeRuntime((_config, options) => options.operation === "migrationVerifyAliases" ? [{ path: "/other" }] : []), identity);
    await expect(mismatch.verifyAliases()).rejects.toThrow("remote aliases do not match");
    const malformed = new PostgreSqlMigrationAdapter(fakeRuntime((_config, options) => options.operation === "migrationVerifyAliases" ? [{ path: 1 }] : [{ migration_id: 1, sha256: 2 }]), identity);
    await expect(malformed.verifyAliases()).rejects.toThrow("alias.path is not valid text");
    await expect(malformed.schemaHistory()).rejects.toThrow("migration_id is not valid text");
  });

  it("copies stable IDs exactly, converges on rerun, and fences each transaction", async () => {
    const memory = new MemoryRuntime();
    const assertFence = vi.spyOn(PostgreSqlWorkCoordinator.prototype, "assertLeaseFence").mockResolvedValue({} as never);
    const adapter = new PostgreSqlMigrationAdapter(memory.asRuntime(), identity);
    expect(await adapter.writeBatch("conversations", [], fence)).toEqual({ rows: 0, uncertainCommitRecovered: false });
    for (const table of POSTGRESQL_MIGRATION_TABLE_NAMES) {
      await expect(adapter.writeBatch(table, allRows()[table]!, fence)).resolves.toEqual({ rows: 1, uncertainCommitRecovered: false });
    }
    const insertCount = memory.operations.filter((operation) => operation.startsWith("migrationInsert:")).length;
    await expect(adapter.writeBatch("conversations", allRows().conversations!, { ...fence, signal: AbortSignal.abort() })).resolves.toEqual({ rows: 1, uncertainCommitRecovered: false });
    expect(memory.operations.filter((operation) => operation.startsWith("migrationInsert:")).length).toBe(insertCount);
    expect(assertFence).toHaveBeenCalledTimes(POSTGRESQL_MIGRATION_TABLE_NAMES.length * 2 + 2);
  });

  it("rejects divergent IDs, readback mismatches, and ordinary transaction failures", async () => {
    vi.spyOn(PostgreSqlWorkCoordinator.prototype, "assertLeaseFence").mockResolvedValue({} as never);
    const memory = new MemoryRuntime();
    const adapter = new PostgreSqlMigrationAdapter(memory.asRuntime(), identity);
    await adapter.writeBatch("conversations", allRows().conversations!, fence);
    const stored = [...memory.stored.values()][0]!;
    stored.session_id = "divergent";
    await expect(adapter.writeBatch("conversations", allRows().conversations!, fence)).rejects.toThrow("divergent stable-ID conflict in conversations");

    const noReadback = new MemoryRuntime();
    noReadback.suppressInsertedReadback = true;
    await expect(new PostgreSqlMigrationAdapter(noReadback.asRuntime(), identity).writeBatch("conversations", allRows().conversations!, fence)).rejects.toThrow("PostgreSQL readback mismatch in conversations");

    const failure = new Error("transaction failed");
    const runtime = fakeRuntime(() => []);
    runtime.transaction = async () => { throw failure; };
    await expect(new PostgreSqlMigrationAdapter(runtime, identity).writeBatch("conversations", allRows().conversations!, fence)).rejects.toBe(failure);
  });

  it("reconciles uncertain commits only after authoritative exact readback", async () => {
    vi.spyOn(PostgreSqlWorkCoordinator.prototype, "assertLeaseFence").mockResolvedValue({} as never);
    const recovered = new MemoryRuntime();
    recovered.uncertainAfterCommit = true;
    await expect(new PostgreSqlMigrationAdapter(recovered.asRuntime(), identity).writeBatch("conversations", allRows().conversations!, fence)).resolves.toEqual({ rows: 1, uncertainCommitRecovered: true });
    const missing = new MemoryRuntime();
    missing.uncertainAfterCommit = true;
    missing.discardBeforeUncertainReadback = true;
    await expect(new PostgreSqlMigrationAdapter(missing.asRuntime(), identity).writeBatch("conversations", allRows().conversations!, fence)).rejects.toThrow("authoritative PostgreSQL readback mismatch in conversations");
  });

  it("repairs shared sequences monotonically in the fenced transaction", async () => {
    const statements: string[] = [];
    vi.spyOn(PostgreSqlWorkCoordinator.prototype, "assertLeaseFence").mockResolvedValue({} as never);
    const adapter = new PostgreSqlMigrationAdapter(fakeRuntime(() => [], (config) => { statements.push(config.text); return []; }), identity);
    await adapter.repairSharedSequences(fence);
    expect(statements).toHaveLength(4);
    expect(statements.every((statement) => statement.includes("GREATEST") && statement.includes("last_value") && statement.includes("max("))).toBe(true);
  });
});

describe("PostgreSQL migration verification and sidecars", () => {
  it("normalizes bounded reads, validates offsets, samples, and inventories pagination", async () => {
    const richRow = { conversation_id: "1", session_id: "session", title: null, bootstrapped_at: null, created_at: new Date(now), updated_at: now, extra_bigint: 4n, extra_buffer: Buffer.from("ab", "hex"), extra_json: { safe: true } };
    const adapter = new PostgreSqlMigrationAdapter(fakeRuntime((config, options) => {
      if (options.operation === "migrationReadBatch:conversations") {
        const offset = config.values?.at(-1);
        if (offset === 0 && config.values?.at(-2) === 1_000) return Array.from({ length: 1_000 }, () => richRow);
        if (offset === 1_000) return [richRow];
        return [richRow];
      }
      return [];
    }), identity);
    expect(await adapter.readBatch("conversations", 0, 1)).toEqual([{ conversation_id: 1, session_id: "session", title: null, bootstrapped_at: null, created_at: now, updated_at: now, extra_bigint: { $integer: "4" }, extra_buffer: "ab", extra_json: { safe: true } }]);
    expect(await adapter.sample("conversations", 1)).toHaveLength(1);
    const promoted = new PostgreSqlMigrationAdapter(fakeRuntime((_config, options) => options.operation === "migrationReadBatch:promoted_memories" ? [{ memory_id: "018f1234-5678-7abc-8def-0123456789ae", content: "memory", metadata: '{"safe":true}', source_summary_id: null, source_project_id: localProjectId, session_id: null, depth: "0", confidence: "1", created_at: now, archived_at: null }] : []), identity);
    expect((await promoted.readBatch("promoted_memories", 0, 1))[0]?.metadata).toEqual({ safe: true });
    const inventory = await adapter.inventory();
    expect(inventory).toHaveLength(POSTGRESQL_MIGRATION_TABLE_NAMES.length);
    expect(inventory[0]).toMatchObject({ table: "conversations", rows: 1_001 });
    await expect(adapter.readBatch("conversations", -1, 1)).rejects.toThrow("offset must be non-negative");
    await expect(adapter.readBatch("conversations", 0.5, 1)).rejects.toThrow("offset must be non-negative");
    await expect(adapter.readBatch("conversations", 0, 0)).rejects.toThrow("limit must be positive");
    await expect(adapter.readBatch("conversations", 0, 1.5)).rejects.toThrow("limit must be positive");
    await expect(adapter.readBatch("unknown", 0, 1)).rejects.toThrow("unknown PostgreSQL migration table: unknown");
  });

  it("verifies FK, DAG, and transcript coverage", async () => {
    const healthy = new PostgreSqlMigrationAdapter(fakeRuntime(() => [{ violations: "0" }]), identity);
    await expect(healthy.verifyRelationalIntegrity(AbortSignal.abort())).resolves.toBeUndefined();
    const violated = new PostgreSqlMigrationAdapter(fakeRuntime(() => [{ violations: "2" }]), identity);
    await expect(violated.verifyRelationalIntegrity()).rejects.toThrow("PostgreSQL FK, DAG, or transcript coverage verification failed");
    const missing = new PostgreSqlMigrationAdapter(fakeRuntime(() => []), identity);
    await expect(missing.verifyRelationalIntegrity()).resolves.toBeUndefined();
  });

  it("writes private, durable, idempotent operational sidecars and rejects divergence", async () => {
    const root = privateDirectory();
    const paths = {
      nativeTranscriptSidecar: join(root, "native.jsonl"),
      passiveEventSidecar: join(root, "passive.jsonl"),
      checkpointSidecar: join(root, "checkpoints.jsonl"),
    };
    const adapter = new PostgreSqlMigrationAdapter(fakeRuntime((config, options) => {
      if (!options.operation.startsWith("migrationSidecar:")) return [];
      const offset = config.values?.[2];
      if (options.operation.endsWith("nativeTranscriptSidecar")) {
        if (offset === 0) return Array.from({ length: 1_000 }, (_unused, transcript_id) => ({ transcript_id, native_payload: { scrubbed: true } }));
        if (offset === 1_000) return [{ transcript_id: 1_000, native_payload: { scrubbed: true } }];
        return [];
      }
      if (offset !== 0) return [];
      if (options.operation.endsWith("passiveEventSidecar")) return [{ inbox_id: 1, payload: { safe: true } }];
      return [{ machine_id: machineId, checkpoint: { ordinal: 1 } }];
    }), identity);
    const first = await adapter.exportOperationalSidecars(paths, AbortSignal.abort());
    expect(Object.values(first).every(({ sha256 }) => /^[a-f0-9]{64}$/u.test(sha256))).toBe(true);
    for (const path of Object.values(paths)) expect(readFileSync(path, "utf8")).toMatch(/\n$/u);
    await expect(adapter.exportOperationalSidecars(paths)).resolves.toEqual(first);
    writeFileSync(paths.nativeTranscriptSidecar, "divergent\n", { mode: 0o600 });
    await expect(adapter.exportOperationalSidecars(paths)).rejects.toThrow("existing PostgreSQL operational sidecar diverges");
  });

  it("fails closed when sidecar writes stall or publication links fail", () => {
    const stalled = vi.fn(() => 0);
    expect(() => POSTGRESQL_MIGRATION_TEST_SEAMS.writeFully(1, Buffer.from("line"), stalled)).toThrow("sidecar write made no progress");
    const partial = vi.fn((_fd: number, _buffer: Uint8Array, offset: number, length: number) => Math.min(length, offset === 0 ? 1 : length));
    expect(() => POSTGRESQL_MIGRATION_TEST_SEAMS.writeFully(1, Buffer.from("line"), partial)).not.toThrow();
    const failure = Object.assign(new Error("link failed"), { code: "EPERM" });
    expect(() => POSTGRESQL_MIGRATION_TEST_SEAMS.linkSidecar("temporary", "destination", () => { throw failure; })).toThrow(failure);
    expect(() => POSTGRESQL_MIGRATION_TEST_SEAMS.linkSidecar("temporary", "destination", () => { throw Object.assign(new Error("exists"), { code: "EEXIST" }); })).not.toThrow();
  });

  it("exports stable manifest metadata", () => {
    expect(POSTGRESQL_MIGRATION_TABLE_NAMES).toHaveLength(15);
    expect(POSTGRESQL_MIGRATION_SCHEMA_MANIFEST_SHA256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
