import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type {
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
  PostgreSqlTransactionOptions,
  PostgreSqlTransactionScopeExecutor,
} from "../../src/storage/postgresql/contracts.js";
import { PostgreSqlCommitOutcomeUnknownError } from "../../src/storage/postgresql/errors.js";
import {
  acquirePostgreSqlProjectMutationGuard,
  acquirePostgreSqlProjectPublicationLock,
  type PostgreSqlBackendPublicationControlExecutor,
  PostgreSqlBackendPublicationGuard,
  PostgreSqlBackendPublicationGuardError,
  POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY,
  POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE,
} from "../../src/storage/postgresql/publication-guard.js";

const PROJECT = "018f0000-0000-7000-8000-000000000001";
const MACHINE = "018f0000-0000-7000-8000-000000000002";
const OTHER_MACHINE = "018f0000-0000-7000-8000-000000000003";
const PUBLICATION = "migration-generation-1";
const EVIDENCE = "a".repeat(64);

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function leaseRow(input: {
  readonly token?: string;
  readonly machineId?: string;
  readonly publicationId?: string;
  readonly targetBackend?: "postgresql" | "sqlite";
  readonly evidenceSha256?: string;
  readonly releasedAt?: string | null;
  readonly expired?: boolean;
  readonly expiresAt?: string;
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
    renewed_at: "2026-08-01T00:00:01.000Z",
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
  implementation: (
    config: QueryConfig<unknown[]>,
    options: PostgreSqlQueryOptions,
  ) => QueryResult<QueryResultRow> | Promise<QueryResult<QueryResultRow>>,
): PostgreSqlTransactionScopeExecutor {
  const query = async <R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
    config: QueryConfig<I>,
    options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> => implementation(
    config as QueryConfig<unknown[]>,
    options,
  ) as Promise<QueryResult<R>>;
  return {
    transactionScope: "active",
    query,
    savepoint: async (callback) => callback({ query }),
  };
}

function executor(input: {
  readonly transactionQuery: (
    config: QueryConfig<unknown[]>,
    options: PostgreSqlQueryOptions,
  ) => QueryResult<QueryResultRow> | Promise<QueryResult<QueryResultRow>>;
  readonly readbackRows?: QueryResultRow[];
  readonly transactionStartError?: unknown;
  readonly transactionError?: unknown;
}): PostgreSqlBackendPublicationControlExecutor & {
  readonly projectPublicationTransaction: ReturnType<typeof vi.fn>;
  readonly projectPublicationReadback: ReturnType<typeof vi.fn>;
  readonly transactionOptions: PostgreSqlTransactionOptions[];
  readonly readbackOptions: PostgreSqlQueryOptions[];
} {
  const transactionOptions: PostgreSqlTransactionOptions[] = [];
  const readbackOptions: PostgreSqlQueryOptions[] = [];
  const projectPublicationTransaction = vi.fn(async <T>(
    _projectId: string,
    callback: (scope: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlTransactionOptions,
  ) => {
    transactionOptions.push(options);
    if (input.transactionStartError !== undefined) throw input.transactionStartError;
    const candidate = await callback(transaction(input.transactionQuery));
    if (input.transactionError !== undefined) throw input.transactionError;
    return candidate;
  });
  const projectPublicationReadback = vi.fn(async (
    _config: QueryConfig<unknown[]>,
    options: PostgreSqlQueryOptions,
  ) => {
    readbackOptions.push(options);
    return result(input.readbackRows ?? []);
  });
  return {
    projectPublicationTransaction,
    projectPublicationReadback,
    transactionOptions,
    readbackOptions,
  } as unknown as PostgreSqlBackendPublicationControlExecutor & {
    readonly projectPublicationTransaction: ReturnType<typeof vi.fn>;
    readonly projectPublicationReadback: ReturnType<typeof vi.fn>;
    readonly transactionOptions: PostgreSqlTransactionOptions[];
    readonly readbackOptions: PostgreSqlQueryOptions[];
  };
}

const validAcquire = {
  projectId: PROJECT,
  machineId: MACHINE,
  publicationId: PUBLICATION,
  targetBackend: "postgresql" as const,
  evidenceSha256: EVIDENCE,
  ttlMs: 60_000,
};

const validMutation = {
  ...validAcquire,
  fencingToken: 7n,
};

describe("PostgreSQL publication admission", () => {
  it("uses the stable shared lock and fails closed for every unresolved row", async () => {
    const query = vi.fn(async (config: QueryConfig<unknown[]>) => {
      if (config.text.includes("pg_advisory_xact_lock_shared")) return result([]);
      return result([]);
    });
    await expect(acquirePostgreSqlProjectMutationGuard(
      { query } as PostgreSqlQueryExecutor,
      PROJECT.toUpperCase(),
      OPTIONS,
    )).resolves.toBeUndefined();
    expect(query.mock.calls.map(([config]) => config.text)).toEqual([
      expect.stringContaining("pg_advisory_xact_lock_shared"),
      expect.stringContaining("released_at IS NULL"),
    ]);
    expect(query.mock.calls[0]?.[0].values?.[0]).toContain(PROJECT);

    const unresolved = vi.fn(async (config: QueryConfig<unknown[]>) =>
      config.text.includes("pg_advisory_xact_lock_shared")
        ? result([])
        : result([{ unresolved: 1 }]));
    await expect(acquirePostgreSqlProjectMutationGuard(
      { query: unresolved } as PostgreSqlQueryExecutor,
      PROJECT,
      OPTIONS,
    )).rejects.toMatchObject({ reason: "publication-unresolved" });

    const duplicate = vi.fn(async (config: QueryConfig<unknown[]>) =>
      config.text.includes("pg_advisory_xact_lock_shared")
        ? result([])
        : result([{ unresolved: 1 }, { unresolved: 1 }]));
    await expect(acquirePostgreSqlProjectMutationGuard(
      { query: duplicate } as PostgreSqlQueryExecutor,
      PROJECT,
      OPTIONS,
    )).rejects.toMatchObject({ reason: "invalid-row" });
  });

  it("takes the exclusive publication lock and exposes reserved resource names", async () => {
    const query = vi.fn(async () => result([]));
    await expect(acquirePostgreSqlProjectPublicationLock(
      { query } as PostgreSqlQueryExecutor,
      PROJECT.toUpperCase(),
      OPTIONS,
    )).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("pg_advisory_xact_lock("),
        values: [expect.stringContaining(PROJECT)],
      }),
      OPTIONS,
    );
    expect(POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE).toBe("backend-publication");
    expect(POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY).toBe("selection");
  });

  it("rejects malformed acquire and mutation identities before opening a transaction", async () => {
    const e = executor({ transactionQuery: () => result([]) });
    const guard = new PostgreSqlBackendPublicationGuard(e);
    for (const input of [
      { ...validAcquire, projectId: "bad" },
      { ...validAcquire, machineId: "bad" },
      { ...validAcquire, publicationId: "" },
      { ...validAcquire, targetBackend: "other" as never },
      { ...validAcquire, evidenceSha256: "bad" },
      { ...validAcquire, ttlMs: Number.NaN },
      { ...validAcquire, ttlMs: 0 },
      { ...validAcquire, ttlMs: 86_400_001 },
      { ...validAcquire, expectedFencingToken: 0n },
    ]) {
      await expect(guard.acquire(input)).rejects.toMatchObject({ reason: "invalid-input" });
    }
    await expect(guard.renew({ ...validMutation, fencingToken: 0n }))
      .rejects.toMatchObject({ reason: "invalid-input" });
    await expect(guard.release({ ...validMutation, machineId: "bad" }))
      .rejects.toMatchObject({ reason: "invalid-input" });
  });

  it("creates an authenticated fence and reserves the exact generation identity", async () => {
    const e = executor({
      transactionQuery: (config) => {
        if (config.text.includes("FOR UPDATE")) return result([]);
        if (config.text.includes("INSERT INTO")) return result([leaseRow()]);
        throw new Error(`unexpected SQL ${config.text}`);
      },
    });
    const signal = new AbortController().signal;
    const fence = await new PostgreSqlBackendPublicationGuard(e).acquire({
      ...validAcquire,
      signal,
    });
    expect(fence).toMatchObject({
      projectId: PROJECT,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
      fencingToken: 7n,
      releasedAt: null,
      databaseExpired: false,
    });
    expect(e.projectPublicationTransaction).toHaveBeenCalledWith(
      PROJECT,
      expect.any(Function),
      expect.objectContaining({
        projectId: PROJECT,
        projectIds: [PROJECT],
        signal,
      }),
    );
  });

  it("re-evaluates takeover expiry after the publication row lock wait", async () => {
    const statements: string[] = [];
    const expiredAfterWait = leaseRow({
      expired: true,
      expiresAt: "2026-08-01T00:00:02.000Z",
    });
    const e = executor({
      transactionQuery: (config) => {
        statements.push(config.text);
        if (config.text.includes("FOR UPDATE")) {
          return result([leaseRow({ expired: false })]);
        }
        if (config.text.includes("fencing_token = DEFAULT")) {
          return result([leaseRow({ token: "8" })]);
        }
        return result([expiredAfterWait]);
      },
    });
    await expect(new PostgreSqlBackendPublicationGuard(e).acquire({
      ...validAcquire,
      expectedFencingToken: 7n,
    })).resolves.toMatchObject({
      fencingToken: 8n,
      databaseExpired: false,
    });
    expect(statements[0]).toContain("FOR UPDATE");
    expect(statements[0]).not.toContain("statement_timestamp");
    expect(statements.some((statement) => statement.includes("statement_timestamp")))
      .toBe(true);
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: (config) => config.text.includes("FOR UPDATE")
        ? result([leaseRow()])
        : result([]),
    })).acquire({ ...validAcquire, expectedFencingToken: 7n }))
      .rejects.toMatchObject({ reason: "invalid-row" });
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: (config) => config.text.includes("FOR UPDATE")
        ? result([leaseRow()])
        : result([]),
    })).renew({ ...validMutation, ttlMs: 60_000 }))
      .rejects.toMatchObject({ reason: "fence-mismatch" });
  });

  it("handles active, conflicting, released, and takeover acquire states", async () => {
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: (config) => config.text.includes("FOR UPDATE")
        ? result([])
        : result([]),
    })).acquire(validAcquire)).rejects.toMatchObject({ reason: "invalid-row" });
    const active = executor({
      transactionQuery: (config) => config.text.includes("FOR UPDATE")
        ? result([leaseRow()])
        : result([leaseRow()]),
    });
    await expect(new PostgreSqlBackendPublicationGuard(active).acquire(validAcquire))
      .resolves.toMatchObject({ fencingToken: 7n });

    const cases: Array<{
      readonly rows: QueryResultRow[];
      readonly expectedToken?: bigint;
      readonly reason: string;
    }> = [
      { rows: [leaseRow(), leaseRow()], reason: "invalid-row" },
      { rows: [], expectedToken: 7n, reason: "fence-mismatch" },
      { rows: [leaseRow({ machineId: OTHER_MACHINE })], reason: "publication-conflict" },
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
          : result(entry.rows),
      });
      await expect(new PostgreSqlBackendPublicationGuard(e).acquire({
        ...validAcquire,
        ...(entry.expectedToken === undefined
          ? {}
          : { expectedFencingToken: entry.expectedToken }),
      })).rejects.toMatchObject({ reason: entry.reason });
    }

    const expired = leaseRow({ expired: true, expiresAt: "2026-08-01T00:00:02.000Z" });
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: (config) => config.text.includes("FOR UPDATE")
        ? result([expired])
        : result([expired]),
    })).acquire(validAcquire)).rejects.toMatchObject({ reason: "fence-expired" });

    const recovered = executor({
      transactionQuery: (config) => {
        if (config.text.includes("FOR UPDATE")) return result([expired]);
        if (config.text.includes("fencing_token = DEFAULT")) return result([leaseRow({ token: "8" })]);
        return result([expired]);
      },
    });
    await expect(new PostgreSqlBackendPublicationGuard(recovered).acquire({
      ...validAcquire,
      expectedFencingToken: 7n,
    })).resolves.toMatchObject({ fencingToken: 8n });

    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: (config) => {
        if (config.text.includes("FOR UPDATE")) return result([expired]);
        if (config.text.includes("fencing_token = DEFAULT")) return result([]);
        return result([expired]);
      },
    })).acquire({ ...validAcquire, expectedFencingToken: 7n }))
      .rejects.toMatchObject({ reason: "fence-mismatch" });

    const released = executor({
      transactionQuery: (config) => {
        if (config.text.includes("FOR UPDATE")) {
          return result([leaseRow({ releasedAt: "2026-08-01T00:02:00.000Z" })]);
        }
        if (config.text.includes("fencing_token = DEFAULT")) {
          return result([leaseRow({ token: "8" })]);
        }
        return result([leaseRow({ releasedAt: "2026-08-01T00:02:00.000Z" })]);
      },
    });
    await expect(new PostgreSqlBackendPublicationGuard(released).acquire(validAcquire))
      .resolves.toMatchObject({ fencingToken: 8n });
  });

  it("rejects malformed authenticated rows and supports authoritative reads", async () => {
    const valid = leaseRow();
    const readInput = {
      projectId: PROJECT,
      targetBackend: "postgresql" as const,
      evidenceSha256: EVIDENCE,
    };
    const malformed: QueryResultRow[] = [
      { ...valid, project_id: 1 },
      { ...valid, project_id: "018f0000-0000-7000-8000-000000000099" },
      { ...valid, owner_machine_id: 1 },
      { ...valid, owner_machine_id: "bad" },
      { ...valid, owner_process_id: 1 },
      { ...valid, owner_process_id: "" },
      { ...valid, operation: 1 },
      { ...valid, operation: "other" },
      { ...valid, expired: "false" },
      { ...valid, fencing_token: 1 },
      { ...valid, fencing_token: "not-a-number" },
      { ...valid, fencing_token: "0" },
      { ...valid, acquired_at: 1 },
      { ...valid, acquired_at: "not-a-date" },
      { ...valid, renewed_at: "2025-01-01T00:00:00.000Z" },
      { ...valid, expires_at: "2026-01-01T00:00:00.000Z" },
      { ...valid, released_at: "not-a-date" },
    ];
    for (const row of malformed) {
      const e = executor({ transactionQuery: () => result([]), readbackRows: [row] });
      await expect(new PostgreSqlBackendPublicationGuard(e).read(readInput))
        .rejects.toMatchObject({ reason: "invalid-row" });
    }
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: () => result([]),
      readbackRows: [],
    })).read(readInput)).resolves.toBeNull();
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: () => result([]),
      readbackRows: [valid, valid],
    })).read(readInput)).rejects.toMatchObject({ reason: "invalid-row" });
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: () => result([]),
      readbackRows: [{
        ...valid,
        project_id: PROJECT.toUpperCase(),
        owner_machine_id: MACHINE.toUpperCase(),
        fencing_token: 7n,
        acquired_at: new Date("2026-08-01T00:00:00.000Z"),
      }],
    })).read(readInput)).resolves.toMatchObject({ fencingToken: 7n });
  });

  it("renews and releases only the exact live fence", async () => {
    const normal = executor({ transactionQuery: () => result([leaseRow()]) });
    await expect(new PostgreSqlBackendPublicationGuard(normal).renew({
      ...validMutation,
      ttlMs: 60_000,
    })).resolves.toMatchObject({ fencingToken: 7n, databaseExpired: false });
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: () => result([]),
    })).renew({ ...validMutation, ttlMs: 60_000 }))
      .rejects.toMatchObject({ reason: "fence-mismatch" });

    const released = leaseRow({ releasedAt: "2026-08-01T00:02:00.000Z" });
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: () => result([released]),
    })).release(validMutation)).resolves.toMatchObject({
      releasedAt: "2026-08-01T00:02:00.000Z",
    });
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: () => result([]),
      readbackRows: [released],
    })).release(validMutation)).resolves.toMatchObject({ releasedAt: expect.any(String) });
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: () => result([]),
      readbackRows: [],
    })).release(validMutation)).rejects.toMatchObject({ reason: "fence-mismatch" });
  });

  it("forwards normalized machine identity through acquire, renew, and release", async () => {
    const queryOptions: PostgreSqlQueryOptions[] = [];
    const e = executor({
      transactionQuery: (_config, options) => {
        queryOptions.push(options);
        return result([leaseRow()]);
      },
    });
    const guard = new PostgreSqlBackendPublicationGuard(e);
    await guard.acquire(validAcquire);
    await guard.renew({ ...validMutation, ttlMs: 60_000 });
    await guard.release(validMutation);
    expect(e.transactionOptions).toHaveLength(3);
    for (const options of e.transactionOptions) {
      expect(options).toMatchObject({
        projectId: PROJECT,
        projectIds: [PROJECT],
        machineId: MACHINE,
      });
    }
    expect(queryOptions.length).toBeGreaterThanOrEqual(6);
    for (const options of queryOptions) {
      expect(options).toMatchObject({ machineId: MACHINE });
    }

    const read = executor({ readbackRows: [], transactionQuery: () => result([]) });
    await new PostgreSqlBackendPublicationGuard(read).read({
      projectId: PROJECT,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE,
    });
    expect(read.readbackOptions).toHaveLength(1);
    expect(read.readbackOptions[0]).not.toHaveProperty("machineId");
  });

  it("reconciles uncertain commits only with exact active or released readback", async () => {
    const unknownAcquire = new PostgreSqlCommitOutcomeUnknownError({
      domain: "coordination",
      operation: "acquireBackendPublication",
      projectId: PROJECT,
    });
    const acquired = leaseRow({ token: "9" });
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: (config) => config.text.includes("FOR UPDATE")
        ? result([])
        : result([acquired]),
      transactionError: unknownAcquire,
      readbackRows: [acquired],
    })).acquire(validAcquire)).resolves.toMatchObject({ fencingToken: 9n });

    const unknownRenew = new PostgreSqlCommitOutcomeUnknownError({
      domain: "coordination",
      operation: "renewBackendPublication",
      projectId: PROJECT,
    });
    const renewed = executor({
      transactionQuery: () => result([leaseRow()]),
      transactionError: unknownRenew,
      readbackRows: [leaseRow()],
    });
    await expect(new PostgreSqlBackendPublicationGuard(renewed).renew({
      ...validMutation,
      ttlMs: 60_000,
    })).resolves.toMatchObject({ fencingToken: 7n });
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: () => result([leaseRow()]),
      transactionError: unknownRenew,
      readbackRows: [leaseRow({ expired: true, expiresAt: "2026-08-01T00:00:02.000Z" })],
    })).renew({ ...validMutation, ttlMs: 60_000 }))
      .rejects.toMatchObject({ reason: "readback-mismatch" });

    const unknownRelease = new PostgreSqlCommitOutcomeUnknownError({
      domain: "coordination",
      operation: "releaseBackendPublication",
      projectId: PROJECT,
    });
    const released = leaseRow({ releasedAt: "2026-08-01T00:02:00.000Z" });
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: () => result([released]),
      transactionError: unknownRelease,
      readbackRows: [released],
    })).release(validMutation)).resolves.toMatchObject({ releasedAt: expect.any(String) });
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: () => result([released]),
      transactionError: unknownRelease,
      readbackRows: [],
    })).release(validMutation)).rejects.toMatchObject({ reason: "readback-mismatch" });

    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: () => { throw new Error("ordinary failure"); },
    })).release(validMutation)).rejects.toThrow("ordinary failure");
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: () => result([]),
      transactionStartError: unknownAcquire,
      readbackRows: [acquired],
    })).acquire(validAcquire)).rejects.toMatchObject({ reason: "readback-mismatch" });
  });

  it("authenticates mutation return rows instead of trusting the SQL result shape", async () => {
    const malformed = {
      ...leaseRow(),
      owner_machine_id: OTHER_MACHINE,
    };
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: () => result([malformed]),
    })).renew({ ...validMutation, ttlMs: 60_000 }))
      .rejects.toMatchObject({ reason: "invalid-row" });
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: () => result([malformed]),
    })).release(validMutation)).rejects.toMatchObject({ reason: "invalid-row" });
  });

  it("keeps ordinary transaction failures distinct from uncertain commits", async () => {
    await expect(new PostgreSqlBackendPublicationGuard(executor({
      transactionQuery: () => result([]),
      transactionStartError: new Error("ordinary failure"),
    })).acquire(validAcquire)).rejects.toThrow("ordinary failure");
    const error = new PostgreSqlBackendPublicationGuardError(
      PROJECT,
      "test",
      "publication-unresolved",
    );
    expect(error.toJSON()).toMatchObject({
      name: "PostgreSqlBackendPublicationGuardError",
      projectId: PROJECT,
      operation: "test",
    });
  });
});
