import type { DatabaseSync } from "node:sqlite";
import { StorageOperationError } from "../errors.js";

/** Assert that an open SQLite connection is intact and can admit a write transaction. */
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
  db.exec("BEGIN IMMEDIATE");
  db.exec("ROLLBACK");
}
