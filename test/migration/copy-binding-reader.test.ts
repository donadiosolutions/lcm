import { describe, expect, it } from "vitest";
import { StorageOperationError } from "../../src/storage/errors.js";
import type { PostgreSqlQueryExecutor } from "../../src/storage/postgresql/contracts.js";
import { migrationCopyTargetGeneration } from "../../src/migration/copy-source.js";
import {
  MigrationCopyBindingReadError,
  readMigrationCopyBindingSha256,
  type ReadMigrationCopyBindingInput,
} from "../../src/migration/copy-binding-reader.js";

const PROJECT = "019a1b2c-3d4e-7f50-8a9b-0c1d2e3f4a5b";
const GENERATION = "generation-1";
const BINDING = "a".repeat(64);

function executor(
  respond: (text: string, values: readonly unknown[]) => unknown[] | Promise<unknown[]>,
): { executor: PostgreSqlQueryExecutor; calls: Array<{ text: string; values: readonly unknown[]; options: unknown }> } {
  const calls: Array<{ text: string; values: readonly unknown[]; options: unknown }> = [];
  const query = async (config: { text: string; values?: readonly unknown[] }, options: unknown) => {
    calls.push({ text: config.text, values: config.values ?? [], options });
    return { rows: await respond(config.text, config.values ?? []), rowCount: null, command: "SELECT", oid: 0, fields: [] };
  };
  return { executor: { query } as unknown as PostgreSqlQueryExecutor, calls };
}

async function read(rows: unknown[] | (() => Promise<unknown[]>), overrides: Partial<ReadMigrationCopyBindingInput> = {}) {
  const fake = executor(typeof rows === "function" ? rows : () => rows);
  const result = await readMigrationCopyBindingSha256({ executor: fake.executor, projectId: PROJECT, generationId: GENERATION, ...overrides });
  return { result, calls: fake.calls };
}

describe("readMigrationCopyBindingSha256 (A5)", () => {
  it("resolves bindingSha256 from the completed run's run_id, keyed by remote project uuid and migrationCopyTargetGeneration", async () => {
    const signal = new AbortController().signal;
    const { result, calls } = await read([{ run_id: "migration-copy-" + BINDING, state: "completed" }], { signal });
    const targetGenerationId = migrationCopyTargetGeneration(GENERATION);
    expect(result).toEqual({ state: "resolved", evidenceSha256: BINDING, runId: "migration-copy-" + BINDING, targetGenerationId });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("FROM lcm.transfer_runs WHERE project_id = $1::uuid AND target_generation = $2");
    expect(calls[0]!.values).toEqual([PROJECT, targetGenerationId]);
    expect(calls[0]!.options).toEqual({ domain: "factory", operation: "readMigrationCopyBinding", signal });
  });

  it("normalizes the project uuid to lowercase before querying, as the project map does", async () => {
    const { calls } = await read([{ run_id: "migration-copy-" + BINDING, state: "completed" }], { projectId: PROJECT.toUpperCase() });
    expect(calls[0]!.values[0]).toBe(PROJECT);
  });

  it("is unresolvable (no-run) when no row exists", async () => {
    const { result } = await read([]);
    expect(result).toMatchObject({ state: "unresolvable", reason: "no-run", targetGenerationId: migrationCopyTargetGeneration(GENERATION) });
  });

  it("is unresolvable (run-not-completed) when the run is still active: an unfinished copy's digest is not evidence", async () => {
    const { result } = await read([{ run_id: "migration-copy-" + BINDING, state: "active" }]);
    expect(result).toMatchObject({ state: "unresolvable", reason: "run-not-completed" });
    expect((result as { detail: string }).detail).toContain("active");
  });

  it.each([
    ["wrong prefix", "copy-" + BINDING],
    ["short digest", "migration-copy-" + "a".repeat(63)],
    ["uppercase digest", "migration-copy-" + "A".repeat(64)],
    ["trailing junk", "migration-copy-" + BINDING + "x"],
    ["non-string", 42],
  ])("is unresolvable (run-id-malformed) for a completed run whose run_id is %s", async (_name, runId) => {
    const { result } = await read([{ run_id: runId, state: "completed" }]);
    expect(result).toMatchObject({ state: "unresolvable", reason: "run-id-malformed" });
  });

  it("is unresolvable (query-failed) for a storage-layer failure, naming only sanitized fields", async () => {
    const failure = new StorageOperationError("STORAGE_OPERATION_FAILED", "postgresql", undefined, "factory", "readMigrationCopyBinding");
    const { result } = await read(() => Promise.reject(failure));
    expect(result).toMatchObject({ state: "unresolvable", reason: "query-failed" });
    expect((result as { detail: string }).detail).toContain("STORAGE_OPERATION_FAILED");
  });

  it("propagates an unrecognized rejection raw rather than attributing it", async () => {
    await expect(read(() => Promise.reject(new RangeError("boom")))).rejects.toBeInstanceOf(RangeError);
  });

  it.each([
    ["non-object input", null],
    ["executor without query", { executor: {}, projectId: PROJECT, generationId: GENERATION }],
    ["non-uuid projectId (a local hash is not accepted)", { executor: executor(() => []).executor, projectId: "f".repeat(64), generationId: GENERATION }],
    ["invalid generationId", { executor: executor(() => []).executor, projectId: PROJECT, generationId: "-bad" }],
  ])("rejects %s as invalid-input before any query", async (_name, input) => {
    await expect(readMigrationCopyBindingSha256(input as unknown as ReadMigrationCopyBindingInput)).rejects.toBeInstanceOf(MigrationCopyBindingReadError);
  });
});

