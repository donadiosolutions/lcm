import { createHash } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type {
  PostgreSqlMigration,
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
} from "../../src/storage/postgresql/contracts.js";
import {
  REQUIRED_POSTGRESQL_EXTENSIONS,
} from "../../src/storage/postgresql/extensions.js";
import { runPostgreSqlMigrations } from "../../src/storage/postgresql/migrations.js";
import { PostgreSqlStorageOperationError } from "../../src/storage/postgresql/errors.js";

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function migration(): PostgreSqlMigration {
  const sql = "SELECT 1";
  return {
    id: "0001_extension_preflight",
    filename: "0001_extension_preflight.sql",
    sql,
    sha256: createHash("sha256").update(sql).digest("hex"),
  };
}

function executor(fault: "control-files" | "preload") {
  const operations: string[] = [];
  const query = vi.fn(async <R extends QueryResultRow>(
    _config: unknown,
    context: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> => {
    operations.push(context.operation);
    if (context.operation === "capturePostmasterEpoch") {
      return result([{ postmaster_started_at: new Date("2026-01-01T00:00:00Z") }] as unknown as R[]);
    }
    if (context.operation.endsWith("probePgStatStatements")) {
      if (fault === "preload") {
        throw new PostgreSqlStorageOperationError(
          "STORAGE_OPERATION_FAILED",
          context,
          "55000",
          false,
        );
      }
      return result([{ stats_reset: new Date() }] as unknown as R[]);
    }
    if (context.operation === "preflightServerVersion") {
      return result([{ server_version_num: 180004 }] as unknown as R[]);
    }
    if (context.operation === "preflightRequiredExtensions") {
      return result(REQUIRED_POSTGRESQL_EXTENSIONS.map((name) => ({
        name,
        default_version: fault === "control-files" && name === "pgcrypto" ? null : "1.0",
        installed_version: "1.0",
        installed_schema: "public",
        relocatable: fault === "control-files" && name === "pgcrypto" ? null : true,
        preloaded: name === "pg_stat_statements" ? fault !== "preload" : null,
      })) as unknown as R[]);
    }
    return result([] as R[]);
  });
  const seam = {
    query,
    transaction: vi.fn(async <T>(
      callback: (transaction: PostgreSqlQueryExecutor) => Promise<T>,
    ) => callback({ query })),
  };
  return { seam, operations };
}

describe("PostgreSQL migration extension preflight", () => {
  it.each([
    {
      label: "pg_stat_statements is not preloaded",
      fault: "preload" as const,
      expected: {
        name: "pg_stat_statements",
        preloaded: false,
        status: "not-preloaded",
      },
    },
    {
      label: "an installed extension loses its control files",
      fault: "control-files" as const,
      expected: {
        name: "pgcrypto",
        available: false,
        installedVersion: "1.0",
        installedSchema: "public",
        status: "installed-unavailable",
      },
    },
  ])("blocks before schema inspection when $label", async ({ fault, expected }) => {
    const fake = executor(fault);
    const failure = await runPostgreSqlMigrations(fake.seam, {
      migrations: [migration()],
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      operation: "preflightRequiredExtensions",
      extensions: expect.arrayContaining([
        expect.objectContaining(expected),
      ]),
    });
    if (fault === "control-files") {
      const extension = failure.extensions.find(
        (candidate: { name: string }) => candidate.name === "pgcrypto",
      );
      expect(extension.remediation).not.toContain("CREATE EXTENSION");
    }
    expect(fake.operations).toEqual([
      "capturePostmasterEpoch",
      "preflightRequiredExtensions",
      ...(fault === "preload" || fault === "control-files"
        ? ["preflightRequiredExtensions:probePgStatStatements"]
        : []),
    ]);
  });
});
