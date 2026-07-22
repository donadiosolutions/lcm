import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { StorageOperationError } from "../errors.js";

export class SqliteReadinessRollbackError extends Error {
  constructor() {
    super("SQLite readiness probe rollback failed");
    this.name = "SqliteReadinessRollbackError";
  }
}

/** Assert that an open SQLite connection is intact and can write to the persistent main schema. */
export function assertSqliteReady(db: DatabaseSync, projectId: string): void {
  const integrity = db.prepare("PRAGMA quick_check(1)").all() as Array<Record<string, unknown>>;
  if (integrity.map((row) => Object.values(row)[0]).join("\n") !== "ok") {
    throw new StorageOperationError(
      "STORAGE_OPERATION_FAILED",
      "sqlite",
      projectId,
      "factory",
      "health",
    );
  }
  const probeTable = `__lcm_storage_health_probe_${randomUUID().replaceAll("-", "")}`;
  db.exec("BEGIN IMMEDIATE");
  let probeFailure: unknown;
  try {
    // BEGIN IMMEDIATE can succeed even when SQLite cannot allocate another
    // database page. Exercise main-schema DDL against a unique internal name;
    // rollback removes the schema object and leaves user tables untouched.
    db.exec(`CREATE TABLE main."${probeTable}" (probe INTEGER NOT NULL)`);
  } catch (error) {
    probeFailure = error;
  }
  try {
    db.exec("ROLLBACK");
  } catch {
    throw new SqliteReadinessRollbackError();
  }
  if (probeFailure !== undefined) throw probeFailure;
}
