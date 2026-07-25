import { join } from "node:path";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { projectIdentity } from "../../src/daemon/project.js";
import { sqliteStorageCapabilities, requireStorageCapability } from "../../src/storage/capabilities.js";
import {
  createStorageBackendFactory,
  UnavailablePostgreSqlStorageBackendFactory,
} from "../../src/storage/factory.js";
import { normalizeStorageError, StorageOperationError } from "../../src/storage/errors.js";
import { SqliteStorageBackendFactory } from "../../src/storage/sqlite/factory.js";
import { SqliteExecutor } from "../../src/storage/sqlite/executor.js";
import { assertSqliteReady } from "../../src/storage/sqlite/health.js";
import { closeLcmConnection, getPoolStats, isLcmConnectionOpen } from "../../src/db/connection.js";
import { createTemporaryDirectory } from "../fixtures/runtime.js";
import { defineCoreStorageConformance, type StorageContractHarness } from "./conformance.js";

function harness(): StorageContractHarness {
  const root = createTemporaryDirectory("lcm-storage-contract-");
  const identities = new Map<string, ReturnType<typeof projectIdentity>>();
  const factory = new SqliteStorageBackendFactory({
    resolveProject: (identity) => ({ id: identity.id, dbPath: join(root, identity.id, "db.sqlite") }),
  });
  return {
    factory,
    identity: (label) => {
      const identity = identities.get(label) ?? projectIdentity(join(root, label));
      identities.set(label, identity);
      return identity;
    },
    open: async (label) => {
      const identity = identities.get(label) ?? projectIdentity(join(root, label));
      identities.set(label, identity);
      return factory.openProject(identity);
    },
  };
}

describe("SQLite storage backend conformance", () => {
  defineCoreStorageConformance(harness);

  it("selects SQLite and exposes a cause-free staged PostgreSQL boundary", async () => {
    expect(createStorageBackendFactory({ backend: "sqlite" })).toBeInstanceOf(SqliteStorageBackendFactory);
    const factory = createStorageBackendFactory({
      backend: "postgresql",
      postgresql: {
        poolMax: 5,
        connectionTimeoutMs: 10_000,
        idleTimeoutMs: 30_000,
        statementTimeoutMs: 60_000,
        url: "postgresql://example.test/lcm",
        caFile: "/safe/ca.pem",
      },
    });
    expect(factory).toBeInstanceOf(UnavailablePostgreSqlStorageBackendFactory);
    expect(factory.backend).toBe("postgresql");
    expect(factory.capabilities).toEqual({
      transactions: false,
      lexicalSearch: false,
      regexSearch: false,
      nativeFullTextSearch: "unavailable",
      coordination: "distributed",
    });
    expect(Object.isFrozen(factory.capabilities)).toBe(true);
    await expect(factory.health()).resolves.toMatchObject({
      status: "unavailable",
      backend: "postgresql",
      error: {
        code: "STORAGE_INITIALIZATION_FAILED",
        backend: "postgresql",
        projectId: undefined,
        domain: "factory",
        operation: "health",
      },
    });

    const identity = {
      id: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      localProjectId: "local-hash",
      canonical: "/work/project",
      remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      machineId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012",
    };
    await expect(factory.projectExists(identity)).rejects.toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      projectId: identity.id,
      operation: "projectExists",
    });
    await expect(factory.openExistingProject(identity)).rejects.toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      projectId: identity.id,
      operation: "openExistingProject",
    });
    await expect(factory.openProject(identity)).rejects.toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      projectId: identity.id,
      operation: "openProject",
    });

    await factory.close();
    await factory.close();
    await expect(factory.health()).resolves.toEqual({ status: "closed", backend: "postgresql" });
    await expect(factory.projectExists(identity)).rejects.toMatchObject({
      code: "STORAGE_CLOSED",
      projectId: identity.id,
    });
  });

  it("exposes frozen capabilities and normalized cause-free errors", () => {
    const capabilities = sqliteStorageCapabilities(false);
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(() => requireStorageCapability(capabilities, "nativeFullTextSearch", "sqlite", "abc"))
      .toThrowError(StorageOperationError);
    expect(() => requireStorageCapability(sqliteStorageCapabilities("unknown"), "nativeFullTextSearch", "sqlite"))
      .toThrowError(StorageOperationError);
    expect(() => requireStorageCapability(sqliteStorageCapabilities(true), "nativeFullTextSearch", "sqlite"))
      .not.toThrow();
    expect(() => requireStorageCapability(capabilities, "transactions", "sqlite")).not.toThrow();
    expect(() => requireStorageCapability({ ...capabilities, regexSearch: false }, "regexSearch", "sqlite"))
      .toThrowError(StorageOperationError);
    const normalized = normalizeStorageError(
      new Error("/secret/path postgresql://user:pass@example.test/db"),
      { backend: "sqlite", projectId: "abc", domain: "conversations", operation: "create" },
    );
    expect(JSON.stringify(normalized)).not.toContain("secret");
    expect(normalized.toJSON()).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      backend: "sqlite",
      projectId: "abc",
      retryable: false,
    });
    expect(normalizeStorageError(normalized, {
      backend: "sqlite",
      domain: "factory",
      operation: "ignored",
    })).toBe(normalized);
    const retryable = new StorageOperationError(
      "STORAGE_OPERATION_FAILED",
      "sqlite",
      undefined,
      "factory",
      "probe",
      { retryable: true },
    );
    expect(retryable.retryable).toBe(true);
    for (const code of [
      "STORAGE_CLOSED",
      "STORAGE_INITIALIZATION_FAILED",
      "STORAGE_UNSUPPORTED_CAPABILITY",
      "STORAGE_NESTED_TRANSACTION",
      "STORAGE_TRANSACTION_SCOPE",
    ] as const) {
      expect(new StorageOperationError(code, "sqlite", undefined, "factory", "probe").message)
        .not.toContain("undefined");
    }
  });

  it("fails closed when the resolved project identity changes", async () => {
    const root = createTemporaryDirectory("lcm-storage-mismatch-");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: () => ({ id: "different", dbPath: join(root, "db.sqlite") }),
    });
    await expect(factory.openProject(projectIdentity(root))).rejects.toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
    });
    await factory.close();
  });

  it("sanitizes project resolution failures before open or existence checks", async () => {
    const root = createTemporaryDirectory("lcm-storage-resolution-failure-");
    const identity = projectIdentity(root);
    const factory = new SqliteStorageBackendFactory({
      resolveProject: () => {
        throw new Error("resolver exposed /secret/project postgresql://user:pass@example.test/lcm");
      },
    });
    for (const operation of [
      factory.projectExists(identity),
      factory.openExistingProject(identity),
      factory.openProject(identity),
    ]) {
      const error = await operation.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(StorageOperationError);
      expect(JSON.stringify(error)).not.toContain("secret");
      expect(JSON.stringify(error)).not.toContain("user:pass");
    }
    await factory.close();
  });

  it("normalizes open and health failures without leaking paths", async () => {
    const root = createTemporaryDirectory("lcm-storage-failures-");
    const invalidFactory = new SqliteStorageBackendFactory({
      resolveProject: (identity) => ({ id: identity.id, dbPath: root }),
    });
    await expect(invalidFactory.openProject(projectIdentity(root))).rejects.toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
    });

    const malformedPath = join(root, "malformed.db");
    const malformed = new DatabaseSync(malformedPath);
    malformed.exec("CREATE VIEW conversations AS SELECT 1 AS value");
    malformed.close();
    const migrationFactory = new SqliteStorageBackendFactory({
      resolveProject: (identity) => ({ id: identity.id, dbPath: malformedPath }),
    });
    await expect(migrationFactory.openProject(projectIdentity(root))).rejects.toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
    });

    const dbPath = join(root, "health.db");
    const healthFactory = new SqliteStorageBackendFactory({
      resolveProject: (identity) => ({ id: identity.id, dbPath }),
    });
    const storage = await healthFactory.openProject(projectIdentity(root));
    closeLcmConnection(dbPath);
    expect(await storage.health()).toMatchObject({ status: "unavailable" });
    expect(await healthFactory.health()).toMatchObject({ status: "unavailable" });
    await storage.close();
    await healthFactory.close();
  });

  it("opens existing projects without creating missing database files", async () => {
    const root = createTemporaryDirectory("lcm-storage-open-existing-");
    const identity = projectIdentity(root);
    const dbPath = join(root, "existing.db");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath }),
    });

    await expect(factory.openExistingProject(identity)).resolves.toBeNull();
    expect(existsSync(dbPath)).toBe(false);
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    const created = await factory.openProject(identity);
    await created.close();
    const existing = await factory.openExistingProject(identity);
    expect(existing).not.toBeNull();
    await existing?.close();
    await factory.close();
  });

  it("reports project existence only for regular non-symlink database leaves", async () => {
    const root = createTemporaryDirectory("lcm-storage-project-exists-");
    const identity = projectIdentity(root);
    const dbPath = join(root, "project.db");
    const victimPath = join(root, "victim.db");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath }),
    });

    expect(await factory.projectExists(identity)).toBe(false);
    mkdirSync(dbPath);
    await expect(factory.projectExists(identity)).rejects.toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      operation: "projectExists",
    });
    rmSync(dbPath, { recursive: true });
    writeFileSync(victimPath, "preserve");
    symlinkSync(victimPath, dbPath);
    await expect(factory.projectExists(identity)).rejects.toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      operation: "projectExists",
    });
    rmSync(dbPath);

    const project = await factory.openProject(identity);
    expect(await factory.projectExists(identity)).toBe(true);
    await project.close();
    await factory.close();
  });

  it("probes known project databases after their request scope closes", async () => {
    const root = createTemporaryDirectory("lcm-storage-idle-health-");
    const identity = projectIdentity(root);
    const dbPath = join(root, "idle-health.db");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath }),
    });
    const storage = await factory.openProject(identity);
    await storage.close();
    expect(await factory.health()).toMatchObject({ status: "healthy" });

    const originalPrepare = DatabaseSync.prototype.prepare;
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "PRAGMA quick_check(1)") {
        return { all: () => [{ quick_check: "corrupt" }] } as never;
      }
      return originalPrepare.call(this, sql);
    });
    try {
      expect(await factory.health()).toMatchObject({ status: "unavailable", backend: "sqlite" });
    } finally {
      prepareSpy.mockRestore();
    }

    const originalExec = DatabaseSync.prototype.exec;
    const writeExecSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql.startsWith("CREATE TABLE main.\"__lcm_storage_health_probe_")) {
        throw new Error("readonly /secret/idle-health.db postgresql://user:pass@example.test/lcm");
      }
      return originalExec.call(this, sql);
    });
    try {
      const health = await factory.health();
      expect(health).toMatchObject({ status: "unavailable", backend: "sqlite" });
      expect(JSON.stringify(health)).not.toContain("secret");
      expect(JSON.stringify(health)).not.toContain("user:pass");
    } finally {
      writeExecSpy.mockRestore();
    }

    const rollbackExecSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "ROLLBACK") {
        throw new Error("rollback failed /secret/idle-health.db");
      }
      return originalExec.call(this, sql);
    });
    try {
      const health = await factory.health();
      expect(health).toMatchObject({ status: "unavailable", backend: "sqlite" });
      expect(JSON.stringify(health)).not.toContain("secret");
    } finally {
      rollbackExecSpy.mockRestore();
    }
    expect(isLcmConnectionOpen(dbPath)).toBe(false);

    expect(await factory.health()).toMatchObject({ status: "healthy", backend: "sqlite" });
    const inspection = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = inspection.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE '__lcm_storage_health_probe_%'",
      ).get() as {
        count: number;
      };
      expect(row.count).toBe(0);
    } finally {
      inspection.close();
    }

    rmSync(dbPath);
    expect(await factory.health()).toMatchObject({ status: "unavailable", backend: "sqlite" });
    writeFileSync(dbPath, "not a SQLite database");
    expect(await factory.health()).toMatchObject({ status: "unavailable", backend: "sqlite" });
    await factory.close();
  });

  it("probes active projects for integrity and serialized write readiness", async () => {
    const root = createTemporaryDirectory("lcm-storage-active-health-");
    const identity = projectIdentity(root);
    const dbPath = join(root, "active-health.db");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath }),
    });
    const storage = await factory.openProject(identity);
    expect(await storage.health()).toMatchObject({ status: "healthy", backend: "sqlite" });

    const originalPrepare = DatabaseSync.prototype.prepare;
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "PRAGMA quick_check(1)") {
        return { all: () => [{ quick_check: "corrupt /secret/active-health.db" }] } as never;
      }
      return originalPrepare.call(this, sql);
    });
    try {
      const health = await storage.health();
      expect(health).toMatchObject({ status: "unavailable", backend: "sqlite" });
      expect(JSON.stringify(health)).not.toContain("secret");
      expect(await factory.health()).toMatchObject({ status: "unavailable", backend: "sqlite" });
    } finally {
      prepareSpy.mockRestore();
    }

    const originalExec = DatabaseSync.prototype.exec;
    const writeExecSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql.startsWith("CREATE TABLE main.\"__lcm_storage_health_probe_")) {
        throw new Error("readonly /secret/active-health.db postgresql://user:pass@example.test/lcm");
      }
      return originalExec.call(this, sql);
    });
    try {
      const health = await storage.health();
      expect(health).toMatchObject({ status: "unavailable", backend: "sqlite" });
      expect(JSON.stringify(health)).not.toContain("secret");
      expect(JSON.stringify(health)).not.toContain("user:pass");
    } finally {
      writeExecSpy.mockRestore();
    }

    let markEntered!: () => void;
    let releaseTransaction!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    const transaction = storage.transaction(async () => {
      markEntered();
      await release;
    });
    await entered;
    let healthSettled = false;
    const serializedHealth = storage.health().then((health) => {
      healthSettled = true;
      return health;
    });
    await Promise.resolve();
    expect(healthSettled).toBe(false);
    releaseTransaction();
    await transaction;
    await expect(serializedHealth).resolves.toMatchObject({ status: "healthy", backend: "sqlite" });

    await factory.close();
  });

  it("poisons and evicts a shared handle when readiness rollback fails", async () => {
    const root = createTemporaryDirectory("lcm-storage-health-rollback-failure-");
    const identity = projectIdentity(root);
    const dbPath = join(root, "rollback-failure.db");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath }),
    });
    const storage = await factory.openProject(identity);
    const shared = await factory.openProject(identity);
    expect(getPoolStats().connections.find((entry) => entry.path === dbPath))
      .toMatchObject({ path: dbPath, refs: 2 });

    let markEntered!: () => void;
    let releaseTransaction!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    const transaction = storage.transaction(async () => {
      markEntered();
      await release;
    });
    await entered;

    const originalExec = DatabaseSync.prototype.exec;
    const rollbackExecSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "ROLLBACK") {
        throw new Error("rollback failed /secret/active-health.db");
      }
      return originalExec.call(this, sql);
    });
    const health = storage.health();
    const queuedOperation = shared.conversations.listConversations();
    const queuedAssertion = expect(queuedOperation).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      domain: "conversations",
    });
    try {
      releaseTransaction();
      await transaction;
      const healthResult = await health;
      expect(healthResult).toMatchObject({ status: "unavailable", backend: "sqlite" });
      expect(JSON.stringify(healthResult)).not.toContain("secret");
      await queuedAssertion;
    } finally {
      rollbackExecSpy.mockRestore();
    }

    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    await expect(storage.conversations.listConversations()).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
    });
    await expect(shared.conversations.listConversations()).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
    });
    await expect(storage.transaction(async () => undefined)).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      domain: "transaction",
    });
    expect(await factory.health()).toMatchObject({ status: "unavailable", backend: "sqlite" });

    const replacement = await factory.openProject(identity);
    expect(getPoolStats().connections.find((entry) => entry.path === dbPath))
      .toMatchObject({ path: dbPath, refs: 1 });
    const firstClose = storage.close();
    expect(storage.close()).toBe(firstClose);
    const sharedClose = shared.close();
    expect(shared.close()).toBe(sharedClose);
    await Promise.all([firstClose, sharedClose]);
    expect(getPoolStats().connections.find((entry) => entry.path === dbPath))
      .toMatchObject({ path: dbPath, refs: 1 });

    await replacement.conversations.createConversation({ sessionId: "replacement" });
    expect(await replacement.conversations.listConversations()).toHaveLength(1);
    const inspection = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(inspection.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE '__lcm_storage_health_probe_%'",
      ).get()).toMatchObject({ count: 0 });
    } finally {
      inspection.close();
    }

    await replacement.close();
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    await factory.close();
  });

  it("poisons and evicts a shared handle when transaction rollback fails", async () => {
    const root = createTemporaryDirectory("lcm-storage-transaction-rollback-failure-");
    const identity = projectIdentity(root);
    const dbPath = join(root, "rollback-failure.db");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath }),
    });
    const storage = await factory.openProject(identity);
    const shared = await factory.openProject(identity);
    const conversation = await storage.conversations.createConversation({ sessionId: "preserved" });
    expect(getPoolStats().connections.find((entry) => entry.path === dbPath))
      .toMatchObject({ path: dbPath, refs: 2 });

    let markEntered!: () => void;
    let releaseTransaction!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    const originalExec = DatabaseSync.prototype.exec;
    const rollbackExecSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "ROLLBACK") {
        throw new Error("rollback failed /secret/transaction.db");
      }
      return originalExec.call(this, sql);
    });
    const transaction = storage.transaction(async (tx) => {
      markEntered();
      await release;
      await tx.conversations.createMessage({
        conversationId: conversation.conversationId,
        seq: 0,
        role: "invalid" as "user",
        content: "driver failure /secret/message postgresql://user:pass@example.test/lcm",
        tokenCount: 1,
      });
    });
    const transactionResult = transaction.catch((error: unknown) => error);
    await entered;
    const queuedOperation = shared.conversations.listConversations();
    const queuedAssertion = expect(queuedOperation).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      domain: "conversations",
    });
    try {
      releaseTransaction();
      const transactionError = await transactionResult;
      expect(transactionError).toMatchObject({
        code: "STORAGE_OPERATION_FAILED",
        domain: "conversations",
      });
      expect(JSON.stringify(transactionError)).not.toContain("secret");
      expect(JSON.stringify(transactionError)).not.toContain("user:pass");
      await queuedAssertion;
    } finally {
      rollbackExecSpy.mockRestore();
    }

    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    await expect(storage.conversations.listConversations()).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
    });
    await expect(shared.conversations.listConversations()).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
    });

    const replacement = await factory.openProject(identity);
    expect(getPoolStats().connections.find((entry) => entry.path === dbPath))
      .toMatchObject({ path: dbPath, refs: 1 });
    const firstClose = storage.close();
    expect(storage.close()).toBe(firstClose);
    const sharedClose = shared.close();
    expect(shared.close()).toBe(sharedClose);
    await Promise.all([firstClose, sharedClose]);
    expect(getPoolStats().connections.find((entry) => entry.path === dbPath))
      .toMatchObject({ path: dbPath, refs: 1 });

    expect(await replacement.conversations.getMessages(conversation.conversationId)).toEqual([]);
    await replacement.conversations.createConversation({ sessionId: "replacement" });
    expect(await replacement.conversations.listConversations()).toHaveLength(2);
    await replacement.close();
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    await factory.close();
  });

  it("rejects a real read-only SQLite connection without leaving probe schema objects", async () => {
    const root = createTemporaryDirectory("lcm-storage-readonly-health-");
    const identity = projectIdentity(root);
    const dbPath = join(root, "readonly-health.db");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath }),
    });
    const storage = await factory.openProject(identity);
    await storage.close();
    await factory.close();

    const readOnly = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // SQLite admits the write transaction on a read-only connection; the
      // main-schema DDL is the operation that proves writability.
      readOnly.exec("BEGIN IMMEDIATE");
      expect(readOnly.isTransaction).toBe(true);
      readOnly.exec("ROLLBACK");
      expect(() => assertSqliteReady(readOnly, identity.id)).toThrow("readonly");
      expect(readOnly.isTransaction).toBe(false);
      const row = readOnly.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE '__lcm_storage_health_probe_%'",
      ).get() as {
        count: number;
      };
      expect(row.count).toBe(0);
    } finally {
      readOnly.close();
    }
  });

  it("detects a full database after BEGIN succeeds and rolls back probe DDL", () => {
    const root = createTemporaryDirectory("lcm-storage-full-health-");
    const dbPath = join(root, "full-health.db");
    const database = new DatabaseSync(dbPath);
    try {
      database.exec("PRAGMA journal_mode = DELETE; CREATE TABLE application_data (value TEXT); VACUUM");
      const pageCountRow = database.prepare("PRAGMA page_count").get() as Record<string, number>;
      const pageCount = Object.values(pageCountRow)[0];
      database.prepare(`PRAGMA max_page_count = ${pageCount}`).get();

      database.exec("BEGIN IMMEDIATE");
      expect(database.isTransaction).toBe(true);
      database.exec("ROLLBACK");
      expect(() => assertSqliteReady(database, "full-project")).toThrow("full");
      expect(database.isTransaction).toBe(false);
      expect(database.prepare("SELECT COUNT(*) AS count FROM application_data").get())
        .toMatchObject({ count: 0 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE '__lcm_storage_health_probe_%'",
      ).get()).toMatchObject({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("uses the production per-project resolver", async () => {
    const fakeHome = createTemporaryDirectory("lcm-storage-home-");
    const project = createTemporaryDirectory("lcm-storage-project-");
    const priorHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const factory = new SqliteStorageBackendFactory();
      const storage = await factory.openProject(projectIdentity(project));
      expect(await storage.health()).toMatchObject({ status: "healthy" });
      await factory.close();
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });

  it("reports native FTS conservatively and preserves lexical fallback behavior", async () => {
    const root = createTemporaryDirectory("lcm-storage-no-fts-");
    const identity = projectIdentity(root);
    const dbPath = join(root, "no-fts.db");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath }),
      detectFeatures: () => ({ fts5Available: false }),
    });
    expect(factory.capabilities).toMatchObject({
      lexicalSearch: true,
      nativeFullTextSearch: "unknown",
    });
    const storage = await factory.openProject(identity);
    expect(storage.capabilities).toMatchObject({
      lexicalSearch: true,
      nativeFullTextSearch: "unavailable",
    });
    const conversation = await storage.conversations.createConversation({ sessionId: "fallback" });
    await storage.conversations.createMessage({
      conversationId: conversation.conversationId,
      seq: 0,
      role: "user",
      content: "fallback message needle",
      tokenCount: 3,
    });
    await storage.summaries.insertSummary({
      summaryId: "fallback-summary",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "fallback summary needle",
      tokenCount: 3,
    });
    const memoryId = await storage.promotedMemory.insert({
      content: "fallback promoted needle",
      tags: ["fallback"],
      confidence: 0.5,
    });
    expect(await storage.lexicalSearch.searchMessages({ query: "needle", mode: "full_text" })).toHaveLength(1);
    expect(await storage.lexicalSearch.searchSummaries({ query: "needle", mode: "full_text" })).toHaveLength(1);
    expect(await storage.lexicalSearch.searchPromoted("needle", 5, ["fallback"]))
      .toMatchObject([{ id: memoryId, rank: 4 }]);
    expect(await storage.lexicalSearch.searchPromoted("_%", 5)).toEqual([]);
    await storage.promotedMemory.update(memoryId, { tags: ["updated"] });
    await storage.promotedMemory.update(memoryId, { content: "changed fallback", confidence: 0.8 });
    expect(await storage.lexicalSearch.searchPromoted("changed", 5, ["updated"])).toHaveLength(1);
    await storage.promotedMemory.archive(memoryId);
    expect(await storage.lexicalSearch.searchPromoted("changed", 5)).toEqual([]);
    await storage.promotedMemory.revive(memoryId);
    expect(await storage.lexicalSearch.searchPromoted("changed", 5)).toHaveLength(1);
    await storage.promotedMemory.deleteById(memoryId);
    expect(await storage.promotedMemory.getById(memoryId)).toBeNull();
    await factory.close();
  });

  it("closes a queued open without returning a project or leaking its pooled reference", async () => {
    const root = createTemporaryDirectory("lcm-storage-close-pending-open-");
    const identity = projectIdentity(root);
    const dbPath = join(root, "pending-open.db");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath }),
    });
    const first = await factory.openProject(identity);
    let releaseTransaction!: () => void;
    let markEntered!: () => void;
    const releasePromise = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    const enteredPromise = new Promise<void>((resolve) => { markEntered = resolve; });
    const transaction = first.transaction(async () => {
      markEntered();
      await releasePromise;
    });
    await enteredPromise;

    let pendingSettled = false;
    const pendingOpen = factory.openProject(identity);
    void pendingOpen.then(
      () => { pendingSettled = true; },
      () => { pendingSettled = true; },
    );
    const healthDuringPendingOpen = factory.health();
    const closing = factory.close();
    await Promise.resolve();
    expect(pendingSettled).toBe(false);

    releaseTransaction();
    await transaction;
    await expect(pendingOpen).rejects.toMatchObject({ code: "STORAGE_CLOSED" });
    await expect(healthDuringPendingOpen).resolves.toMatchObject({ status: "closed" });
    await closing;
    expect(await first.health()).toMatchObject({ status: "closed" });
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it("settles repeated factory closes after every project close attempt", async () => {
    const root = createTemporaryDirectory("lcm-storage-best-effort-close-");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath: join(root, `${project.id}.db`) }),
    });
    const failing = await factory.openProject(projectIdentity(join(root, "failing")));
    const successful = await factory.openProject(projectIdentity(join(root, "successful")));

    let enterFailing!: () => void;
    let releaseFailing!: () => void;
    let enterSuccessful!: () => void;
    let releaseSuccessful!: () => void;
    const failingEntered = new Promise<void>((resolve) => { enterFailing = resolve; });
    const failingGate = new Promise<void>((resolve) => { releaseFailing = resolve; });
    const successfulEntered = new Promise<void>((resolve) => { enterSuccessful = resolve; });
    const successfulGate = new Promise<void>((resolve) => { releaseSuccessful = resolve; });
    const originalSuccessfulClose = successful.close.bind(successful);
    const failingClose = vi.spyOn(failing, "close").mockImplementation(async () => {
      enterFailing();
      await failingGate;
      throw new Error("injected project close failure");
    });
    const successfulClose = vi.spyOn(successful, "close").mockImplementation(async () => {
      enterSuccessful();
      await successfulGate;
      await originalSuccessfulClose();
    });

    const firstClose = factory.close();
    const repeatedClose = factory.close();
    expect(repeatedClose).toBe(firstClose);
    await Promise.all([failingEntered, successfulEntered]);

    let factorySettled = false;
    void firstClose.then(() => { factorySettled = true; });
    releaseFailing();
    await Promise.resolve();
    expect(factorySettled).toBe(false);
    releaseSuccessful();
    await expect(firstClose).resolves.toBeUndefined();
    expect(factorySettled).toBe(true);
    expect(failingClose).toHaveBeenCalledOnce();
    expect(successfulClose).toHaveBeenCalledOnce();
    expect(await factory.health()).toMatchObject({ status: "closed" });
    await expect(factory.openProject(projectIdentity(join(root, "after-close"))))
      .rejects.toMatchObject({ code: "STORAGE_CLOSED" });
    await expect(factory.close()).resolves.toBeUndefined();
    expect(failingClose).toHaveBeenCalledOnce();
    expect(successfulClose).toHaveBeenCalledOnce();

    failingClose.mockRestore();
    successfulClose.mockRestore();
    await failing.close();
  });

  it("stays healthy while a normally closing project drains queued work", async () => {
    const root = createTemporaryDirectory("lcm-storage-health-during-close-");
    const identity = projectIdentity(root);
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath: join(root, "health-close.db") }),
    });
    const storage = await factory.openProject(identity);
    let releaseTransaction!: () => void;
    let markEntered!: () => void;
    const releasePromise = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    const enteredPromise = new Promise<void>((resolve) => { markEntered = resolve; });
    const transaction = storage.transaction(async () => {
      markEntered();
      await releasePromise;
    });
    await enteredPromise;

    const closing = storage.close();
    expect(await storage.health()).toMatchObject({ status: "closed" });
    expect(await factory.health()).toMatchObject({ status: "healthy" });
    releaseTransaction();
    await transaction;
    await closing;
    await factory.close();
  });

  it("preserves scoped failures and poisons the executor when rollback itself fails", async () => {
    const calls: string[] = [];
    const database = {
      exec: (sql: string): void => {
        calls.push(sql);
        if (sql === "ROLLBACK") throw new Error("rollback /secret/path");
      },
    } as unknown as DatabaseSync;
    const executor = new SqliteExecutor(database, "safe-project");
    await expect(executor.transaction(async (token) => executor.runScoped(
      token,
      "conversations",
      "createConversation",
      () => { throw new Error("driver /secret/path"); },
    ))).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      domain: "conversations",
    });
    expect(calls).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
    await expect(executor.run("conversations", "listConversations", () => undefined))
      .rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    executor.poison();
  });

  it("rolls back and poisons an outer transaction when scoped savepoint recovery fails", async () => {
    const calls: string[] = [];
    const onPoison = vi.fn();
    const database = {
      exec: (sql: string): void => {
        calls.push(sql);
        if (sql.startsWith("ROLLBACK TO SAVEPOINT")) {
          throw new Error("savepoint rollback /secret/path");
        }
      },
    } as unknown as DatabaseSync;
    const executor = new SqliteExecutor(database, "safe-project", onPoison);

    await expect(executor.transaction(async (token) => {
      await expect(executor.runAtomicScoped(
        token,
        "conversations",
        "createMessagesBulk",
        () => { throw new Error("batch failure /secret/path"); },
      )).rejects.toMatchObject({
        code: "STORAGE_OPERATION_FAILED",
        domain: "conversations",
        operation: "createMessagesBulk",
      });
      // Even though the callback catches the operation failure, the failed
      // savepoint recovery must prevent an outer COMMIT.
      return "caught";
    })).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      domain: "transaction",
      operation: "transaction",
    });
    expect(calls).toEqual([
      "BEGIN IMMEDIATE",
      "SAVEPOINT lcm_atomic_0",
      "ROLLBACK TO SAVEPOINT lcm_atomic_0",
      "ROLLBACK",
    ]);
    expect(calls).not.toContain("COMMIT");
    expect(onPoison).toHaveBeenCalledOnce();
    await expect(executor.run("conversations", "listConversations", () => undefined))
      .rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
  });

  it("keeps the outer transaction usable when savepoint release fails after rollback", async () => {
    const calls: string[] = [];
    const onPoison = vi.fn();
    const database = {
      exec: (sql: string): void => {
        calls.push(sql);
        if (sql.startsWith("RELEASE SAVEPOINT")) {
          throw new Error("savepoint release /secret/path");
        }
      },
    } as unknown as DatabaseSync;
    const executor = new SqliteExecutor(database, "safe-project", onPoison);

    await expect(executor.transaction(async (token) => {
      const failure = await executor.runAtomicScoped(
        token,
        "conversations",
        "createMessagesBulk",
        () => { throw new Error("batch failure /secret/path"); },
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "STORAGE_OPERATION_FAILED",
        domain: "conversations",
        operation: "createMessagesBulk",
      });
      expect(JSON.stringify(failure)).not.toContain("/secret/");
      await expect(executor.runScoped(
        token,
        "conversations",
        "listConversations",
        () => "still usable",
      )).resolves.toBe("still usable");
      return "caught";
    })).resolves.toBe("caught");

    expect(calls).toEqual([
      "BEGIN IMMEDIATE",
      "SAVEPOINT lcm_atomic_0",
      "ROLLBACK TO SAVEPOINT lcm_atomic_0",
      "RELEASE SAVEPOINT lcm_atomic_0",
      "COMMIT",
    ]);
    expect(onPoison).not.toHaveBeenCalled();
    await expect(executor.run(
      "conversations",
      "listConversations",
      () => "open",
    )).resolves.toBe("open");
  });

  it("rejects atomic roots and every invalid scoped-atomic transaction context", async () => {
    const firstDatabase = { exec: vi.fn() } as unknown as DatabaseSync;
    const secondDatabase = { exec: vi.fn() } as unknown as DatabaseSync;
    const first = new SqliteExecutor(firstDatabase, "first-project");
    const second = new SqliteExecutor(secondDatabase, "second-project");

    await expect(first.runAtomicScoped(
      Symbol("missing-context"),
      "conversations",
      "createMessagesBulk",
      () => undefined,
    )).rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });

    await first.transaction(async (token) => {
      await expect(first.runAtomic(
        "conversations",
        "createMessagesBulk",
        () => undefined,
      )).rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
      await expect(second.runAtomicScoped(
        token,
        "conversations",
        "createMessagesBulk",
        () => undefined,
      )).rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
      await expect(first.runAtomicScoped(
        Symbol("wrong-token"),
        "conversations",
        "createMessagesBulk",
        () => undefined,
      )).rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });

      const activeTokens = (
        first as unknown as { activeTokens: Set<symbol> }
      ).activeTokens;
      activeTokens.delete(token);
      await expect(first.runAtomicScoped(
        token,
        "conversations",
        "createMessagesBulk",
        () => undefined,
      )).rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
      activeTokens.add(token);
    });
  });

  it("poisons a root atomic executor when rollback fails and preserves the sanitized operation", async () => {
    const calls: string[] = [];
    const onPoison = vi.fn();
    const database = {
      exec: (sql: string): void => {
        calls.push(sql);
        if (sql === "ROLLBACK") throw new Error("rollback /secret/atomic.db");
      },
    } as unknown as DatabaseSync;
    const executor = new SqliteExecutor(database, "safe-project", onPoison);

    const failure = await executor.runAtomic(
      "conversations",
      "createMessagesBulk",
      () => { throw new Error("driver /secret/messages.jsonl"); },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      backend: "sqlite",
      projectId: "safe-project",
      domain: "conversations",
      operation: "createMessagesBulk",
    });
    expect(JSON.stringify(failure)).not.toContain("/secret/");
    expect(calls).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
    expect(calls).not.toContain("COMMIT");
    expect(onPoison).toHaveBeenCalledOnce();
    await expect(executor.run("conversations", "listConversations", () => undefined))
      .rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
  });

  it("prioritizes transaction-scope contracts over a poisoned executor", async () => {
    const liveDatabase = { exec: vi.fn() } as unknown as DatabaseSync;
    const poisonedDatabase = { exec: vi.fn() } as unknown as DatabaseSync;
    const live = new SqliteExecutor(liveDatabase, "live-project");
    const poisoned = new SqliteExecutor(poisonedDatabase, "poisoned-project");
    poisoned.poison();

    await live.transaction(async () => {
      await expect(poisoned.run("conversations", "listConversations", () => undefined))
        .rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
      await expect(poisoned.transaction(async () => undefined))
        .rejects.toMatchObject({ code: "STORAGE_NESTED_TRANSACTION" });
      await expect(poisoned.runScoped(
        Symbol("invalid"),
        "conversations",
        "listConversations",
        () => undefined,
      )).rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
    });

    await expect(poisoned.runScoped(
      Symbol("escaped"),
      "conversations",
      "listConversations",
      () => undefined,
    )).rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
    await expect(poisoned.run("conversations", "listConversations", () => undefined))
      .rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    await expect(poisoned.transaction(async () => undefined))
      .rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
  });
});
