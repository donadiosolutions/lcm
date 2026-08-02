import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type {
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
  PostgreSqlTransactionScopeExecutor,
} from "../../src/storage/postgresql/contracts.js";
import { PostgreSqlCommitOutcomeUnknownError } from "../../src/storage/postgresql/errors.js";
import {
  acquirePostgreSqlProjectMutationGuard,
  acquirePostgreSqlProjectPublicationLock,
  type PostgreSqlBackendPublicationControlExecutor,
  PostgreSqlBackendPublicationGuard,
  PostgreSqlBackendPublicationGuardError,
} from "../../src/storage/postgresql/publication-guard.js";

const PROJECT = "018f0000-0000-7000-8000-000000000001";
const MACHINE = "018f0000-0000-7000-8000-000000000002";
const PUBLICATION = "migration-generation-1";
const EVIDENCE = "a".repeat(64);

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function leaseRow(input: {
  token?: string;
  expiresAt?: string;
  releasedAt?: string | null;
  publicationId?: string;
  machineId?: string;
  expired?: boolean;
  targetBackend?: "postgresql" | "sqlite";
  evidenceSha256?: string;
} = {}) {
  return {
    project_id: PROJECT,
    owner_machine_id: input.machineId ?? MACHINE,
    owner_process_id: input.publicationId ?? PUBLICATION,
    operation: `backend-publication:${input.targetBackend ?? "postgresql"}:${
      input.evidenceSha256 ?? EVIDENCE
    }`,
    fencing_token: input.token ?? "7",
    acquired_at: "2026-08-01T00:00:00.000Z",
    renewed_at: "2026-08-01T00:00:00.000Z",
    expires_at: input.expiresAt ?? "2099-08-01T00:10:00.000Z",
    released_at: input.releasedAt ?? null,
    expired: input.expired ?? false,
  };
}

const OPTIONS = {
  domain: "coordination",
  operation: "test",
  projectId: PROJECT,
} as const;

function transaction(
  queryImplementation: (
    config: QueryConfig<unknown[]>,
    options: PostgreSqlQueryOptions,
  ) => QueryResult<QueryResultRow> | Promise<QueryResult<QueryResultRow>>,
): PostgreSqlTransactionScopeExecutor {
  return {
    transactionScope: "active",
    query: async <R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
      config: QueryConfig<I>,
      options: PostgreSqlQueryOptions,
    ) => queryImplementation(
      config as QueryConfig<unknown[]>,
      options,
    ) as Promise<QueryResult<R>>,
    savepoint: async (callback) => callback({
      query: async <R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
        config: QueryConfig<I>,
        options: PostgreSqlQueryOptions,
      ) => queryImplementation(
        config as QueryConfig<unknown[]>,
        options,
      ) as Promise<QueryResult<R>>,
    }),
  };
}

function executor(input: {
  transactionQuery: (
    config: QueryConfig<unknown[]>,
    options: PostgreSqlQueryOptions,
  ) => QueryResult<QueryResultRow> | Promise<QueryResult<QueryResultRow>>;
  readbackRows?: QueryResultRow[];
  transactionStartError?: unknown;
  transactionError?: unknown;
}) {
  const projectPublicationTransaction = vi.fn(async <T>(
    _projectId: string,
    callback: (scope: PostgreSqlTransactionScopeExecutor) => Promise<T>,
  ) => {
    if (input.transactionStartError !== undefined) {
      throw input.transactionStartError;
    }
    const candidate = await callback(transaction(input.transactionQuery));
    if (input.transactionError !== undefined) throw input.transactionError;
    return candidate;
  });
  const projectPublicationReadback = vi.fn(async () => result(input.readbackRows ?? []));
  return {
    query: vi.fn(async () => result([])),
    projectPublicationTransaction,
    projectPublicationReadback,
  } as unknown as PostgreSqlBackendPublicationControlExecutor & {
    projectPublicationTransaction: typeof projectPublicationTransaction;
    projectPublicationReadback: typeof projectPublicationReadback;
  };
}

describe("PostgreSQL backend publication guard", () => {
  it("takes the shared advisory lock before reading the durable row", async () => {
    const query = vi.fn(async (config: QueryConfig<unknown[]>) => {
      if (config.text.includes("pg_advisory_xact_lock_shared")) return result([]);
      return result([]);
    });
    await expect(acquirePostgreSqlProjectMutationGuard(
      { query } as PostgreSqlQueryExecutor,
      PROJECT,
      OPTIONS,
    )).resolves.toBeUndefined();
    expect(query.mock.calls.map(([config]) => config.text)).toEqual([
      expect.stringContaining("pg_advisory_xact_lock_shared"),
      expect.stringContaining("released_at IS NULL"),
    ]);
  });

  it("fails closed on every unresolved row without treating expiry as release", async () => {
    const query = vi.fn(async (config: QueryConfig<unknown[]>) => {
      if (config.text.includes("pg_advisory_xact_lock_shared")) return result([]);
      return result([{ unresolved: 1, expires_at: "2000-01-01T00:00:00.000Z" }]);
    });
    await expect(acquirePostgreSqlProjectMutationGuard(
      { query } as PostgreSqlQueryExecutor,
      PROJECT,
      OPTIONS,
    )).rejects.toMatchObject({
      name: "PostgreSqlBackendPublicationGuardError",
      reason: "publication-unresolved",
    });
  });

  it("rejects duplicate durable rows and takes the exclusive stable project lock", async () => {
    const duplicate = vi.fn(async (config: QueryConfig<unknown[]>) => {
      if (config.text.includes("pg_advisory_xact_lock_shared")) return result([]);
      return result([{ unresolved: 1 }, { unresolved: 1 }]);
    });
    await expect(acquirePostgreSqlProjectMutationGuard(
      { query: duplicate } as PostgreSqlQueryExecutor,
      PROJECT,
      OPTIONS,
    )).rejects.toMatchObject({ reason: "invalid-row" });

    const exclusive = vi.fn(async () => result([]));
    await expect(acquirePostgreSqlProjectPublicationLock(
      { query: exclusive } as PostgreSqlQueryExecutor,
      PROJECT.toUpperCase(),
      OPTIONS,
    )).resolves.toBeUndefined();
    expect(exclusive).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("pg_advisory_xact_lock("),
        values: [expect.stringContaining(PROJECT)],
      }),
      OPTIONS,
    );
  });

  it("validates every generation, identity, evidence, duration, and token input", async () => {
    const e = executor({ transactionQuery: () => result([]) });
    const guard = new PostgreSqlBackendPublicationGuard(e);
    const valid = {
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql" as const,
      evidenceSha256: EVIDENCE,
      ttlMs: 60_000,
    };
    for (const input of [
      { ...valid, projectId: "bad" },
      { ...valid, machineId: "bad" },
      { ...valid, publicationId: "" },
      { ...valid, targetBackend: "other" as never },
      { ...valid, evidenceSha256: "bad" },
      { ...valid, ttlMs: Number.NaN },
      { ...valid, ttlMs: 0 },
      { ...valid, ttlMs: 24 * 60 * 60 * 1000 + 1 },
      { ...valid, expectedFencingToken: 0n },
    ]) {
      await expect(guard.acquire(input)).rejects.toMatchObject({ reason: "invalid-input" });
    }
    await expect(guard.renew({
      ...valid,
      fencingToken: 0n,
    })).rejects.toMatchObject({ reason: "invalid-input" });
  });

  it("creates a generation-bound fence and maps only authenticated row fields", async () => {
    const e = executor({
      transactionQuery: (config) => {
        if (config.text.includes("FOR UPDATE")) return result([]);
        if (config.text.includes("INSERT INTO")) return result([leaseRow()]);
        throw new Error("unexpected query");
      },
    });
    const guard = new PostgreSqlBackendPublicationGuard(e);
    const signal = new AbortController().signal;
    await expect(guard.acquire({
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
      ttlMs: 60_000,
      signal,
    })).resolves.toMatchObject({
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      fencingToken: 7n,
      releasedAt: null,
    });
    expect(e.projectPublicationTransaction).toHaveBeenCalledWith(
      PROJECT,
      expect.any(Function),
      expect.objectContaining({ signal }),
    );
  });

  it("authenticates every readback field and rejects malformed or duplicate rows", async () => {
    const input = {
      projectId: PROJECT,
      targetBackend: "postgresql" as const,
      evidenceSha256: EVIDENCE,
    };
    const valid = leaseRow();
    const invalidRows = [
      { ...valid, project_id: 1 },
      { ...valid, project_id: "018f0000-0000-7000-8000-000000000099" },
      { ...valid, owner_machine_id: 1 },
      { ...valid, owner_machine_id: "bad" },
      { ...valid, owner_process_id: 1 },
      { ...valid, owner_process_id: "" },
      { ...valid, operation: 1 },
      { ...valid, operation: "other" },
      leaseRow({ evidenceSha256: "b".repeat(64) }),
      { ...valid, expired: "false" },
      { ...valid, fencing_token: 1 },
      { ...valid, fencing_token: "not-a-number" },
      { ...valid, fencing_token: "0" },
      { ...valid, acquired_at: 1 },
      { ...valid, acquired_at: "not-a-date" },
      { ...valid, released_at: "not-a-date" },
    ];
    for (const row of invalidRows) {
      const e = executor({ transactionQuery: () => result([]), readbackRows: [row] });
      await expect(new PostgreSqlBackendPublicationGuard(e).read(input))
        .rejects.toMatchObject({ reason: "invalid-row" });
    }

    const dates = new Date("2026-08-01T00:00:00.000Z");
    const dated = executor({
      transactionQuery: () => result([]),
      readbackRows: [{
        ...valid,
        project_id: PROJECT.toUpperCase(),
        owner_machine_id: MACHINE.toUpperCase(),
        fencing_token: 7n,
        acquired_at: dates,
        renewed_at: dates,
        expires_at: new Date("2099-08-01T00:10:00.000Z"),
      }],
    });
    await expect(new PostgreSqlBackendPublicationGuard(dated).read(input))
      .resolves.toMatchObject({ projectId: PROJECT, fencingToken: 7n });

    const absent = executor({ transactionQuery: () => result([]), readbackRows: [] });
    await expect(new PostgreSqlBackendPublicationGuard(absent).read(input))
      .resolves.toBeNull();
    const duplicate = executor({
      transactionQuery: () => result([]),
      readbackRows: [valid, valid],
    });
    await expect(new PostgreSqlBackendPublicationGuard(duplicate).read(input))
      .rejects.toMatchObject({ reason: "invalid-row" });
  });

  it("requires the exact prior token to recover an expired same-generation fence", async () => {
    const expired = leaseRow({
      token: "7",
      expiresAt: "2000-08-01T00:10:00.000Z",
      expired: true,
    });
    const withoutToken = executor({
      transactionQuery: (config) => config.text.includes("FOR UPDATE")
        ? result([expired])
        : result([]),
    });
    await expect(new PostgreSqlBackendPublicationGuard(withoutToken).acquire({
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
      ttlMs: 60_000,
    })).rejects.toMatchObject({ reason: "fence-expired" });

    const recovered = executor({
      transactionQuery: (config) => {
        if (config.text.includes("FOR UPDATE")) return result([expired]);
        if (config.text.includes("fencing_token = DEFAULT")) {
          return result([leaseRow({ token: "8" })]);
        }
        throw new Error("unexpected query");
      },
    });
    await expect(new PostgreSqlBackendPublicationGuard(recovered).acquire({
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
      ttlMs: 60_000,
      expectedFencingToken: 7n,
    })).resolves.toMatchObject({ fencingToken: 8n });
  });

  it("handles every existing, conflicting, released, and divergent acquire state", async () => {
    const input = {
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql" as const,
      evidenceSha256: EVIDENCE,
      ttlMs: 60_000,
    };
    const cases: Array<{
      rows: QueryResultRow[];
      expectedToken?: bigint;
      reason: string;
    }> = [
      { rows: [leaseRow(), leaseRow()], reason: "invalid-row" },
      { rows: [], expectedToken: 7n, reason: "fence-mismatch" },
      { rows: [leaseRow({ machineId: "018f0000-0000-7000-8000-000000000099" })], reason: "publication-conflict" },
      { rows: [leaseRow({ publicationId: "other-generation" })], reason: "publication-conflict" },
      { rows: [leaseRow({ evidenceSha256: "b".repeat(64) })], reason: "publication-conflict" },
      { rows: [leaseRow()], expectedToken: 8n, reason: "fence-mismatch" },
      {
        rows: [leaseRow({ releasedAt: "2026-08-01T00:01:00.000Z" })],
        expectedToken: 7n,
        reason: "fence-mismatch",
      },
    ];
    for (const entry of cases) {
      const e = executor({
        transactionQuery: (config) => config.text.includes("FOR UPDATE")
          ? result(entry.rows)
          : result([]),
      });
      await expect(new PostgreSqlBackendPublicationGuard(e).acquire({
        ...input,
        ...(entry.expectedToken === undefined
          ? {}
          : { expectedFencingToken: entry.expectedToken }),
      })).rejects.toMatchObject({ reason: entry.reason });
    }

    const active = executor({
      transactionQuery: (config) => config.text.includes("FOR UPDATE")
        ? result([leaseRow()])
        : result([]),
    });
    await expect(new PostgreSqlBackendPublicationGuard(active).acquire(input))
      .resolves.toMatchObject({ fencingToken: 7n });

    const released = executor({
      transactionQuery: (config) => {
        if (config.text.includes("FOR UPDATE")) {
          return result([leaseRow({ releasedAt: "2026-08-01T00:01:00.000Z" })]);
        }
        if (config.text.includes("fencing_token = DEFAULT")) {
          return result([leaseRow({ token: "8" })]);
        }
        throw new Error("unexpected query");
      },
    });
    await expect(new PostgreSqlBackendPublicationGuard(released).acquire(input))
      .resolves.toMatchObject({ fencingToken: 8n });

    const releasedPriorGeneration = executor({
      transactionQuery: (config) => {
        if (config.text.includes("FOR UPDATE")) {
          return result([leaseRow({
            releasedAt: "2026-08-01T00:01:00.000Z",
            targetBackend: "sqlite",
            evidenceSha256: "b".repeat(64),
          })]);
        }
        if (config.text.includes("fencing_token = DEFAULT")) {
          return result([leaseRow({ token: "8" })]);
        }
        throw new Error("unexpected query");
      },
    });
    await expect(new PostgreSqlBackendPublicationGuard(
      releasedPriorGeneration,
    ).acquire(input)).resolves.toMatchObject({
      fencingToken: 8n,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
    });

    for (const transactionQuery of [
      (config: QueryConfig<unknown[]>) => config.text.includes("FOR UPDATE")
        ? result([])
        : result([]),
      (config: QueryConfig<unknown[]>) => config.text.includes("FOR UPDATE")
        ? result([leaseRow({ releasedAt: "2026-08-01T00:01:00.000Z" })])
        : result([]),
    ]) {
      const e = executor({ transactionQuery });
      await expect(new PostgreSqlBackendPublicationGuard(e).acquire(input))
        .rejects.toMatchObject({ reason: expect.stringMatching(/invalid-row|fence-mismatch/u) });
    }
  });

  it("uses exact authoritative readback after an uncertain acquire commit", async () => {
    const unknown = new PostgreSqlCommitOutcomeUnknownError({
      domain: "coordination",
      operation: "acquireBackendPublication",
      projectId: PROJECT,
    });
    const e = executor({
      transactionQuery: (config) => config.text.includes("FOR UPDATE")
        ? result([])
        : result([leaseRow({ token: "9" })]),
      transactionError: unknown,
      readbackRows: [leaseRow({ token: "9" })],
    });
    await expect(new PostgreSqlBackendPublicationGuard(e).acquire({
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
      ttlMs: 60_000,
    })).resolves.toMatchObject({ fencingToken: 9n });

    const mismatch = executor({
      transactionQuery: (config) => config.text.includes("FOR UPDATE")
        ? result([])
        : result([leaseRow({ token: "9" })]),
      transactionError: unknown,
      readbackRows: [leaseRow({ publicationId: "other-generation" })],
    });
    await expect(new PostgreSqlBackendPublicationGuard(mismatch).acquire({
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
      ttlMs: 60_000,
    })).rejects.toBeInstanceOf(PostgreSqlBackendPublicationGuardError);

    const recovered = executor({
      transactionQuery: (config) => config.text.includes("FOR UPDATE")
        ? result([leaseRow({ token: "7", expired: true })])
        : result([leaseRow({ token: "8" })]),
      transactionError: unknown,
      readbackRows: [leaseRow({ token: "8" })],
    });
    await expect(new PostgreSqlBackendPublicationGuard(recovered).acquire({
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
      ttlMs: 60_000,
      expectedFencingToken: 7n,
    })).resolves.toMatchObject({ fencingToken: 8n });

    const absent = executor({
      transactionQuery: (config) => config.text.includes("FOR UPDATE")
        ? result([])
        : result([leaseRow({ token: "9" })]),
      transactionError: unknown,
      readbackRows: [],
    });
    await expect(new PostgreSqlBackendPublicationGuard(absent).acquire({
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
      ttlMs: 60_000,
    })).rejects.toMatchObject({ reason: "readback-mismatch" });

    const ordinary = executor({
      transactionQuery: () => result([]),
      transactionStartError: new Error("ordinary failure"),
    });
    await expect(new PostgreSqlBackendPublicationGuard(ordinary).acquire({
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
      ttlMs: 60_000,
    })).rejects.toThrow("ordinary failure");

    const unknownBeforeCandidate = executor({
      transactionQuery: () => result([]),
      transactionStartError: unknown,
      readbackRows: [leaseRow({ token: "9" })],
    });
    await expect(new PostgreSqlBackendPublicationGuard(
      unknownBeforeCandidate,
    ).acquire({
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
      ttlMs: 60_000,
    })).rejects.toMatchObject({ reason: "readback-mismatch" });
  });

  it("uses authoritative database-clock readback after an uncertain renewal", async () => {
    const unknown = new PostgreSqlCommitOutcomeUnknownError({
      domain: "coordination",
      operation: "renewBackendPublication",
      projectId: PROJECT,
    });
    const renewed = executor({
      transactionQuery: () => result([leaseRow()]),
      transactionError: unknown,
      readbackRows: [leaseRow()],
    });
    const input = {
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql" as const,
      evidenceSha256: EVIDENCE,
      fencingToken: 7n,
      ttlMs: 60_000,
    };
    const normal = executor({ transactionQuery: () => result([leaseRow()]) });
    await expect(new PostgreSqlBackendPublicationGuard(normal).renew(input))
      .resolves.toMatchObject({ fencingToken: 7n });

    const missing = executor({ transactionQuery: () => result([]) });
    await expect(new PostgreSqlBackendPublicationGuard(missing).renew(input))
      .rejects.toMatchObject({ reason: "fence-mismatch" });

    const ordinary = executor({
      transactionQuery: () => { throw new Error("ordinary renewal failure"); },
    });
    await expect(new PostgreSqlBackendPublicationGuard(ordinary).renew(input))
      .rejects.toThrow("ordinary renewal failure");

    await expect(new PostgreSqlBackendPublicationGuard(renewed).renew(input))
      .resolves.toMatchObject({ fencingToken: 7n, databaseExpired: false });

    const unknownBeforeCandidate = executor({
      transactionQuery: () => result([]),
      transactionStartError: unknown,
      readbackRows: [leaseRow()],
    });
    await expect(new PostgreSqlBackendPublicationGuard(
      unknownBeforeCandidate,
    ).renew(input)).rejects.toMatchObject({ reason: "readback-mismatch" });

    const expired = executor({
      transactionQuery: () => result([leaseRow()]),
      transactionError: unknown,
      readbackRows: [leaseRow({ expired: true })],
    });
    await expect(new PostgreSqlBackendPublicationGuard(expired).renew(input))
      .rejects.toMatchObject({ reason: "readback-mismatch" });
  });

  it("releases only the exact unexpired fence and verifies uncertain release by readback", async () => {
    const released = leaseRow({
      token: "7",
      releasedAt: "2026-08-01T00:01:00.000Z",
    });
    const e = executor({
      transactionQuery: () => result([released]),
    });
    const input = {
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql" as const,
      evidenceSha256: EVIDENCE,
      fencingToken: 7n,
    };
    await expect(new PostgreSqlBackendPublicationGuard(e).release(input))
      .resolves.toMatchObject({ releasedAt: "2026-08-01T00:01:00.000Z" });

    const unknown = new PostgreSqlCommitOutcomeUnknownError({
      domain: "coordination",
      operation: "releaseBackendPublication",
      projectId: PROJECT,
    });
    const readback = executor({
      transactionQuery: () => result([released]),
      transactionError: unknown,
      readbackRows: [released],
    });
    await expect(new PostgreSqlBackendPublicationGuard(readback).release(input))
      .resolves.toMatchObject({ fencingToken: 7n });

    const resumed = executor({
      transactionQuery: () => result([]),
      readbackRows: [released],
    });
    await expect(new PostgreSqlBackendPublicationGuard(resumed).release(input))
      .resolves.toMatchObject({ releasedAt: "2026-08-01T00:01:00.000Z" });

    const mismatch = executor({
      transactionQuery: () => result([]),
      readbackRows: [],
    });
    await expect(new PostgreSqlBackendPublicationGuard(mismatch).release(input))
      .rejects.toMatchObject({ reason: "fence-mismatch" });

    const unknownMismatch = executor({
      transactionQuery: () => result([released]),
      transactionError: unknown,
      readbackRows: [],
    });
    await expect(
      new PostgreSqlBackendPublicationGuard(unknownMismatch).release(input),
    ).rejects.toMatchObject({ reason: "readback-mismatch" });

    const ordinary = executor({
      transactionQuery: () => { throw new Error("ordinary release failure"); },
    });
    await expect(new PostgreSqlBackendPublicationGuard(ordinary).release(input))
      .rejects.toThrow("ordinary release failure");
  });
});
