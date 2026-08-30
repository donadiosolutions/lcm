import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedStorageConfig } from "../../src/daemon/config.js";
import { projectIdentity } from "../../src/daemon/project.js";
import { sqliteStorageCapabilities, requireStorageCapability } from "../../src/storage/capabilities.js";
import { createStorageBackendFactory } from "../../src/storage/factory.js";
import type { StorageBackendFactory } from "../../src/storage/contracts.js";
import { normalizeStorageError, StorageOperationError } from "../../src/storage/errors.js";
import { SqliteStorageBackendFactory } from "../../src/storage/sqlite/factory.js";
import { SqliteExecutor } from "../../src/storage/sqlite/executor.js";
import { SqliteProjectStorage } from "../../src/storage/sqlite/project-storage.js";
import { assertSqliteReady } from "../../src/storage/sqlite/health.js";
import {
  createSqliteRepositories,
  createSqliteRepositoryStores,
} from "../../src/storage/sqlite/repositories.js";
import { sessionInstructionsScopeHash } from "../../src/storage/session-instructions.js";
import { closeLcmConnection, getPoolStats, isLcmConnectionOpen } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { createTemporaryDirectory } from "../fixtures/runtime.js";
import { defineCoreStorageConformance, type StorageContractHarness } from "./conformance.js";
import {
  exerciseCoordinationRepositoryConformance,
  exercisePromotedMemoryRepositoryConformance,
  exerciseRecallRepositoryConformance,
  exerciseRedactionAdminRepositoryConformance,
} from "./memory-conformance.js";
import { exerciseSummaryContextRepositoryConformance } from "./summary-context-conformance.js";

const selectedFactoryMock = vi.hoisted(() => ({
  createPostgreSql: vi.fn(),
  constructSqlite: vi.fn(),
}));

vi.mock("../../src/storage/postgresql/factory.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/storage/postgresql/factory.js")>()),
  createPostgreSqlStorageBackendFactoryWithHome: selectedFactoryMock.createPostgreSql,
}));

vi.mock("../../src/storage/sqlite/factory.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/storage/sqlite/factory.js")>();
  return {
    ...actual,
    SqliteStorageBackendFactory: class extends actual.SqliteStorageBackendFactory {
      constructor(...args: ConstructorParameters<typeof actual.SqliteStorageBackendFactory>) {
        selectedFactoryMock.constructSqlite(...args);
        super(...args);
      }
    },
  };
});

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

  it("passes the shared memory and administration repository contracts", async () => {
    const root = createTemporaryDirectory("lcm-storage-memory-contract-");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({
        id: project.id,
        dbPath: join(root, "db.sqlite"),
      }),
    });
    try {
      const storage = await factory.openProject(projectIdentity(root));
      await exercisePromotedMemoryRepositoryConformance(
        storage.promotedMemory,
      );
      await exerciseRecallRepositoryConformance(
        storage.recall,
        storage.promotedMemory,
      );
      await exerciseRedactionAdminRepositoryConformance(
        storage.redactionAdmin,
      );
      await exerciseCoordinationRepositoryConformance(
        storage.coordination,
      );
    } finally {
      await factory.close();
    }
  });

  it("passes the shared summary, context, and large-file repository contracts", async () => {
    const root = createTemporaryDirectory("lcm-storage-summary-context-contract-");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({
        id: project.id,
        dbPath: join(root, "db.sqlite"),
      }),
    });
    try {
      const storage = await factory.openProject(projectIdentity(root));
      await exerciseSummaryContextRepositoryConformance(storage);
    } finally {
      await factory.close();
    }
  });

  it("short-circuits empty repository atomic operations before invoking the executor", async () => {
    const prepare = vi.fn(() => {
      throw new Error("empty atomic operations must not prepare statements");
    });
    const db = { prepare } as unknown as DatabaseSync;
    const stores = createSqliteRepositoryStores(db, { fts5Available: false });
    const invoke = vi.fn(async () => {
      throw new Error("empty atomic operations must not invoke the executor");
    });
    const repositories = createSqliteRepositories(stores, "safe-project", invoke);

    await expect(repositories.conversations.createMessagesBulk([])).resolves.toEqual([]);
    await expect(repositories.conversations.appendMessages(1, [])).resolves.toEqual([]);
    await expect(repositories.conversations.createMessageParts(1, [])).resolves.toBeUndefined();
    await expect(repositories.conversations.deleteMessages([])).resolves.toBe(0);
    expect(invoke).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("returns empty atomic no-ops while the SQLite executor is locked", async () => {
    const root = createTemporaryDirectory("lcm-storage-empty-locked-");
    const identity = projectIdentity(root);
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath: join(root, "db.sqlite") }),
    });
    let releaseTransaction = (): void => undefined;
    let lockedTransaction: Promise<void> | undefined;
    try {
      const storage = await factory.openProject(identity);
      let markLocked!: () => void;
      const locked = new Promise<void>((resolve) => { markLocked = resolve; });
      const release = new Promise<void>((resolve) => { releaseTransaction = resolve; });
      lockedTransaction = storage.transaction(async () => {
        markLocked();
        await release;
      });
      await locked;

      let settled = false;
      const emptyOperations = Promise.all([
        storage.conversations.createMessagesBulk([]),
        storage.conversations.appendMessages(1, []),
        storage.conversations.createMessageParts(1, []),
        storage.conversations.deleteMessages([]),
      ]).then((results) => {
        settled = true;
        return results;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(settled).toBe(true);
      await expect(emptyOperations).resolves.toEqual([[], [], undefined, 0]);
    } finally {
      releaseTransaction();
      await lockedTransaction;
      await factory.close();
    }
  });

  it("prevalidates conversation batches before invoking the SQLite executor", async () => {
    const prepare = vi.fn(() => {
      throw new Error("invalid batches must not prepare statements");
    });
    const db = { prepare } as unknown as DatabaseSync;
    const stores = createSqliteRepositoryStores(db, { fts5Available: false });
    const invoke = vi.fn(async (
      _domain: unknown,
      _operation: unknown,
      callback: () => unknown,
    ) => callback());
    const repositories = createSqliteRepositories(stores, "safe-project", invoke);

    const bulkFailure = await repositories.conversations.createMessagesBulk([{
      conversationId: 1,
      seq: 0,
      role: "user",
      content: "valid prefix",
      tokenCount: 0,
    }, {
      conversationId: 1,
      seq: 1,
      role: "assistant",
      content: "private\0bulk",
      tokenCount: 1,
    }]).catch((error: unknown) => error);
    const appendFailure = await repositories.conversations.appendMessages(1, [{
      role: "user",
      content: "valid prefix",
      tokenCount: 0,
    }, {
      role: "assistant",
      content: "invalid suffix",
      tokenCount: -1,
    }]).catch((error: unknown) => error);
    const partFailure = await repositories.conversations.createMessageParts(1, [{
      sessionId: "safe-session",
      partType: "text",
      ordinal: 0,
    }, {
      sessionId: "safe-session",
      partType: "reasoning",
      ordinal: 1,
      metadata: "private\0part",
    }]).catch((error: unknown) => error);

    expect(bulkFailure).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      operation: "createMessagesBulk",
    });
    expect(appendFailure).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      operation: "appendMessages",
    });
    expect(partFailure).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      operation: "createMessageParts",
    });
    expect(JSON.stringify([bulkFailure, partFailure])).not.toContain("private");
    expect(invoke).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("validates administrative counters before invocation and fails closed on malformed timestamps", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      runLcmMigrations(db);
      const stores = createSqliteRepositoryStores(db);
      const invoke = vi.fn(async (
        _domain: unknown,
        _operation: unknown,
        callback: () => unknown,
      ) => callback());
      const repositories = createSqliteRepositories(
        stores,
        "safe-project",
        invoke,
      );
      await expect(repositories.redactionAdmin.upsertCounts({
        gitleaks: 0,
        builtIn: 0,
        global: 0,
        project: -1,
      })).rejects.toMatchObject({
        backend: "sqlite",
        domain: "redaction-admin",
        operation: "upsertCounts",
      });
      expect(invoke).not.toHaveBeenCalled();

      db.prepare(
        `INSERT INTO redaction_stats (project_id, category, count)
         VALUES ('safe-project', 'project', -1)`,
      ).run();
      await expect(repositories.redactionAdmin.getCounts())
        .rejects.toThrow(TypeError);
      await expect(repositories.promotedMemory.getAll({
        since: "not-a-date",
      })).rejects.toThrow(TypeError);

      const memoryId = await repositories.promotedMemory.insert({
        content: "malformed timestamp",
        tags: ["one", "two"],
      });
      db.prepare(
        "UPDATE promoted SET created_at = ?, archived_at = ? WHERE id = ?",
      ).run("not-a-date", "2026-01-01 00:00:00", memoryId);
      await expect(repositories.promotedMemory.getById(memoryId))
        .rejects.toThrow("stored timestamp is malformed");
    } finally {
      db.close();
    }
  });

  it("retains exact scope residuals and fails closed on an instruction hash collision", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      runLcmMigrations(db, { fts5Available: false });
      const scope = {
        clientName: "codex" as const,
        sessionId: "target-session",
        worktreePath: "/repo/target",
        cwdPath: "/repo/target/src",
      };
      db.prepare(
        `INSERT INTO session_instruction_cache (
           project_id, scope_hash, client_name, session_id, worktree_path,
           cwd_path, content, content_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "safe-project",
        sessionInstructionsScopeHash(scope),
        "claude",
        "foreign-session",
        "/repo/foreign",
        "/repo/foreign/src",
        "foreign instructions",
        "foreign-hash",
      );
      const stores = createSqliteRepositoryStores(db, { fts5Available: false });
      const repositories = createSqliteRepositories(
        stores,
        "safe-project",
        async (_domain, _operation, callback) => await callback(),
      );

      await expect(repositories.coordination.getSessionInstructions(scope))
        .resolves.toBeNull();
      await expect(repositories.coordination.deleteSessionInstructions(scope))
        .resolves.toBeUndefined();
      expect(db.prepare(
        "SELECT content FROM session_instruction_cache",
      ).get()).toEqual({ content: "foreign instructions" });
      await expect(repositories.coordination.upsertSessionInstructions(
        scope,
        "target instructions",
        "target-hash",
      )).rejects.toThrow("instruction-cache scope hash collision");
      expect(db.prepare(
        "SELECT content FROM session_instruction_cache",
      ).get()).toEqual({ content: "foreign instructions" });
    } finally {
      db.close();
    }
  });

  it("rejects malformed UTF-16 instruction scopes before SQLite binding", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      runLcmMigrations(db, { fts5Available: false });
      const stores = createSqliteRepositoryStores(db, { fts5Available: false });
      const repositories = createSqliteRepositories(
        stores,
        "safe-project",
        async (_domain, _operation, callback) => await callback(),
      );
      const baseScope = {
        clientName: "codex" as const,
        sessionId: "session",
        worktreePath: "/repo/worktree",
        cwdPath: "/repo/worktree/src",
      };

      for (const malformed of [
        "\ud800",
        "\ud801",
        "\udc00",
        "\udc01",
      ]) {
        const candidate = {
          ...baseScope,
          sessionId: `session-${malformed}`,
        };
        await expect(repositories.coordination.getSessionInstructions(candidate))
          .rejects.toThrow("instruction-cache sessionId contains malformed UTF-16");
        await expect(repositories.coordination.upsertSessionInstructions(
          candidate,
          "instructions",
          "hash",
        )).rejects.toThrow("instruction-cache sessionId contains malformed UTF-16");
        await expect(repositories.coordination.deleteSessionInstructions(candidate))
          .rejects.toThrow("instruction-cache sessionId contains malformed UTF-16");
      }

      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM session_instruction_cache",
      ).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("purges all mutable project memory state and its FTS mirror atomically", async () => {
    const root = createTemporaryDirectory("lcm-storage-purge-");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({
        id: project.id,
        dbPath: join(root, "db.sqlite"),
      }),
    });
    try {
      const storage = await factory.openProject(projectIdentity(root));
      const memoryId = await storage.promotedMemory.insert({
        content: "purge needle",
        tags: ["one", "two"],
      });
      await storage.recall.logSurfacing([memoryId], null);
      await storage.redactionAdmin.upsertCounts({
        gitleaks: 1,
        builtIn: 0,
        global: 0,
        project: 0,
      });
      await storage.coordination.recordSessionIngest("session", 1);
      await storage.coordination.upsertSessionInstructions({
        clientName: "claude",
        sessionId: "session-a",
        worktreePath: "/repo",
        cwdPath: "/repo",
      }, "rules", "hash");
      expect(await storage.recall.getFeedback(["missing"])).toEqual(new Map([[
        "missing",
        { usageCount: 0, surfacingCount: 0, lastSurfacedAt: null },
      ]]));
      await storage.promotedMemory.archive(memoryId);
      expect(await storage.promotedMemory.getById(memoryId)).toMatchObject({
        archivedAt: expect.stringMatching(/Z$/u),
      });
      await storage.promotedMemory.revive(memoryId);

      expect(await storage.redactionAdmin.purgeProjectState()).toEqual({
        promotedMemories: 1,
        promotedTags: 2,
        recallSurfacings: 1,
        redactionCounters: 1,
        sessionIngestLogs: 1,
        sessionInstructions: 1,
      });
      expect(await storage.lexicalSearch.searchPromoted("purge", 5)).toEqual([]);
    } finally {
      await factory.close();
    }
  });

  it("keeps a scoped transaction usable after invalid conversation batch inputs", async () => {
    const root = createTemporaryDirectory("lcm-storage-invalid-conversation-integers-");
    const identity = projectIdentity(root);
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath: join(root, "db.sqlite") }),
    });
    try {
      const storage = await factory.openProject(identity);
      const conversation = await storage.conversations.createConversation({
        sessionId: "invalid-integers",
      });
      const seed = await storage.conversations.createMessage({
        conversationId: conversation.conversationId,
        seq: 0,
        role: "system",
        content: "seed",
        tokenCount: 0,
      });

      await storage.transaction(async (tx) => {
        await expect(tx.conversations.createMessage({
          conversationId: conversation.conversationId,
          seq: -1,
          role: "user",
          content: "invalid direct",
          tokenCount: 0,
        })).rejects.toMatchObject({
          code: "STORAGE_OPERATION_FAILED",
          operation: "createMessage",
        });
        await expect(tx.conversations.createMessagesBulk([{
          conversationId: conversation.conversationId,
          seq: 1,
          role: "user",
          content: "bulk prefix",
          tokenCount: 0,
        }, {
          conversationId: conversation.conversationId,
          seq: 2,
          role: "assistant",
          content: "bulk invalid suffix",
          tokenCount: -1,
        }])).rejects.toMatchObject({
          code: "STORAGE_OPERATION_FAILED",
          operation: "createMessagesBulk",
        });
        await expect(tx.conversations.appendMessages(conversation.conversationId, [{
          role: "user",
          content: "append prefix",
          tokenCount: 0,
        }, {
          role: "assistant",
          content: "append invalid suffix",
          tokenCount: -1,
        }])).rejects.toMatchObject({
          code: "STORAGE_OPERATION_FAILED",
          operation: "appendMessages",
        });
        const nulFailure = await tx.conversations.appendMessages(
          conversation.conversationId,
          [{
            role: "user",
            content: "NUL prefix",
            tokenCount: 0,
          }, {
            role: "assistant",
            content: "private\0NUL suffix",
            tokenCount: 1,
          }],
        ).catch((error: unknown) => error);
        expect(nulFailure).toMatchObject({
          code: "STORAGE_OPERATION_FAILED",
          operation: "appendMessages",
        });
        expect(JSON.stringify(nulFailure)).not.toContain("private");
        await expect(tx.conversations.createMessageParts(seed.messageId, [{
          sessionId: "invalid-integers",
          partType: "text",
          ordinal: 0,
        }, {
          sessionId: "invalid-integers",
          partType: "reasoning",
          ordinal: -1,
        }])).rejects.toMatchObject({
          code: "STORAGE_OPERATION_FAILED",
          operation: "createMessageParts",
        });
        await expect(tx.conversations.appendMessages(conversation.conversationId, [{
          role: "user",
          content: "zero",
          tokenCount: 0,
        }, {
          role: "assistant",
          content: "positive",
          tokenCount: 2,
        }])).resolves.toMatchObject([
          { seq: 1, tokenCount: 0 },
          { seq: 2, tokenCount: 2 },
        ]);
      });

      expect((await storage.conversations.getMessages(conversation.conversationId)).map(
        (message) => message.content,
      )).toEqual(["seed", "zero", "positive"]);
      expect(await storage.conversations.getMessageParts(seed.messageId)).toEqual([]);
    } finally {
      await factory.close();
    }
  });

  it("resolves SQLite asynchronously and delegates PostgreSQL to the eager factory", async () => {
    const publicationCheck = vi.fn();
    const sqlitePromise = createStorageBackendFactory(
      { backend: "sqlite" },
      undefined,
      publicationCheck,
    );
    expect(sqlitePromise).toBeInstanceOf(Promise);
    await expect(sqlitePromise).resolves.toBeInstanceOf(SqliteStorageBackendFactory);

    const postgresqlConfig: ResolvedStorageConfig = {
      backend: "postgresql",
      postgresql: {
        poolMax: 5,
        connectionTimeoutMs: 10_000,
        idleTimeoutMs: 30_000,
        statementTimeoutMs: 60_000,
        migrationRole: "lcm_migrator",
        url: "postgresql://example.test/lcm",
        caFile: "/safe/ca.pem",
      },
    };
    const delegatedFactory = { backend: "postgresql" } as StorageBackendFactory;
    selectedFactoryMock.createPostgreSql.mockResolvedValue(delegatedFactory);
    selectedFactoryMock.constructSqlite.mockClear();
    const effectiveHome = homedir();

    await expect(createStorageBackendFactory(
      postgresqlConfig,
      undefined,
      publicationCheck,
    )).resolves.toBe(delegatedFactory);
    expect(publicationCheck).toHaveBeenLastCalledWith({
      backend: "postgresql",
      homeDir: effectiveHome,
    }, undefined);
    expect(selectedFactoryMock.createPostgreSql).toHaveBeenCalledWith(
      postgresqlConfig,
      effectiveHome,
    );
    expect(selectedFactoryMock.constructSqlite).not.toHaveBeenCalled();
  });

  it("preserves sanitized PostgreSQL construction failures without a SQLite fallback", async () => {
    selectedFactoryMock.createPostgreSql.mockReset();
    selectedFactoryMock.constructSqlite.mockClear();
    const failure = new StorageOperationError(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "createFactory",
    );
    selectedFactoryMock.createPostgreSql.mockRejectedValue(failure);
    const publicationCheck = vi.fn();
    const postgresqlConfig: ResolvedStorageConfig = {
      backend: "postgresql",
      postgresql: {
        poolMax: 5,
        connectionTimeoutMs: 10_000,
        idleTimeoutMs: 30_000,
        statementTimeoutMs: 60_000,
        migrationRole: "lcm_migrator",
        url: "postgresql://example.test/lcm",
        caFile: "/safe/ca.pem",
      },
    };

    await expect(createStorageBackendFactory(
      postgresqlConfig,
      "/home/operator",
      publicationCheck,
    )).rejects.toBe(failure);
    expect(selectedFactoryMock.createPostgreSql).toHaveBeenCalledWith(
      postgresqlConfig,
      "/home/operator",
    );
    expect(selectedFactoryMock.constructSqlite).not.toHaveBeenCalled();
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
    expect(await storage.redactionAdmin.purgeProjectState()).toMatchObject({
      promotedMemories: 1,
      promotedTags: 1,
    });
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

  it("pre-aborted opens do not create a file or acquire a connection", async () => {
    const root = createTemporaryDirectory("lcm-storage-preaborted-open-");
    const dbPath = join(root, "preaborted.db");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath }),
    });
    const controller = new AbortController();
    controller.abort();
    await expect(factory.openProject(projectIdentity(root), undefined, controller.signal))
      .rejects.toBeDefined();
    expect(existsSync(dbPath)).toBe(false);
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    await factory.close();
  });

  it("keeps live missing existing opens non-creating and fences cancellation in feature detection", async () => {
    const root = createTemporaryDirectory("lcm-storage-existing-cancel-");
    const missingPath = join(root, "missing.db");
    const missingFactory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath: missingPath }),
    });
    await expect(missingFactory.openExistingProject(projectIdentity(root))).resolves.toBeNull();
    expect(existsSync(missingPath)).toBe(false);
    await missingFactory.close();

    const dbPath = join(root, "cancelled.db");
    const controller = new AbortController();
    let detected = false;
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath }),
      detectFeatures: () => {
        detected = true;
        controller.abort();
        return { fts5Available: false };
      },
    });
    await expect(factory.openProject(projectIdentity(root), undefined, controller.signal))
      .rejects.toBeDefined();
    expect(detected).toBe(true);
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    await factory.close();
  });

  it("closes during feature detection before migration and drains the acquired connection", async () => {
    const root = createTemporaryDirectory("lcm-storage-close-during-detection-");
    const dbPath = join(root, "close-during-detection.db");
    let factory!: SqliteStorageBackendFactory;
    let capturedClose: Promise<void> | undefined;
    let detectCalls = 0;
    factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath }),
      detectFeatures: () => {
        detectCalls += 1;
        capturedClose = factory.close();
        return { fts5Available: false };
      },
    });

    try {
      const error = await factory.openProject(projectIdentity(root))
        .catch((caught: unknown) => caught);

      expect(detectCalls).toBe(1);
      expect(error).toMatchObject({
        code: "STORAGE_CLOSED",
        backend: "sqlite",
        projectId: projectIdentity(root).id,
        domain: "factory",
        operation: "openProject",
      });
      expect(JSON.stringify(error)).not.toContain("detectFeatures");
      expect(capturedClose).toBeDefined();
      await expect(capturedClose).resolves.toBeUndefined();

      const database = new DatabaseSync(dbPath);
      try {
        expect(database.prepare(
          "SELECT name FROM sqlite_schema WHERE type IN ('table', 'index', 'trigger', 'view')",
        ).all()).toEqual([]);
      } finally {
        database.close();
      }
      expect(isLcmConnectionOpen(dbPath)).toBe(false);
      expect(getPoolStats().connections.some(connection => connection.path === dbPath)).toBe(false);
      await expect(factory.close()).resolves.toBeUndefined();
    } finally {
      await factory.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes a post-construction cancelled open once and suppresses cleanup detail", async () => {
    const root = createTemporaryDirectory("lcm-storage-post-construction-cancel-");
    const dbPath = join(root, "post-construction.db");
    let abortedReads = 0;
    const signal = {
      get aborted(): boolean {
        abortedReads += 1;
        return abortedReads === 8;
      },
      reason: undefined,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } as unknown as AbortSignal;
    const factory = new SqliteStorageBackendFactory({
      resolveProject: (project) => ({ id: project.id, dbPath }),
    });
    const originalClose = SqliteProjectStorage.prototype.close;
    const close = vi.spyOn(SqliteProjectStorage.prototype, "close")
      .mockImplementation(async function(this: SqliteProjectStorage): Promise<void> {
        await originalClose.call(this);
        throw new Error("private sqlite cleanup canary");
      });

    try {
      const error = await factory.openProject(projectIdentity(root), undefined, signal)
        .catch((caught: unknown) => caught);

      expect(abortedReads).toBe(8);
      expect(close).toHaveBeenCalledOnce();
      expect(error).toMatchObject({
        code: "STORAGE_INITIALIZATION_FAILED",
        backend: "sqlite",
        operation: "openProject",
      });
      expect(JSON.stringify(error)).not.toContain("private sqlite cleanup canary");
      expect(isLcmConnectionOpen(dbPath)).toBe(false);
      expect(getPoolStats().connections.some(connection => connection.path === dbPath)).toBe(false);
    } finally {
      close.mockRestore();
      await factory.close();
      rmSync(root, { recursive: true, force: true });
    }
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

  it("allows caught savepoint-open failures to release the FIFO and commit later work", async () => {
    const calls: string[] = [];
    const onPoison = vi.fn();
    let openFailed = false;
    const database = {
      exec: (sql: string): void => {
        calls.push(sql);
        if (sql.startsWith("SAVEPOINT") && !openFailed) {
          openFailed = true;
          throw new Error("savepoint open /secret/path");
        }
      },
    } as unknown as DatabaseSync;
    const executor = new SqliteExecutor(database, "safe-project", onPoison);
    let firstCallbackEntered = false;
    let secondCallbackEntered = false;

    await expect(executor.transaction(async (token) => {
      const first = executor.runAtomicScoped(
        token,
        "conversations",
        "createMessagesBulk",
        () => { firstCallbackEntered = true; },
      ).catch((error: unknown) => error);
      const queued = executor.runAtomicScoped(
        token,
        "conversations",
        "createMessageParts",
        () => {
          secondCallbackEntered = true;
          return "queued succeeded";
        },
      );
      const [firstFailure, queuedResult] = await Promise.all([first, queued]);

      expect(firstFailure).toMatchObject({
        code: "STORAGE_OPERATION_FAILED",
        domain: "conversations",
        operation: "createMessagesBulk",
      });
      expect(JSON.stringify(firstFailure)).not.toContain("/secret/");
      expect(queuedResult).toBe("queued succeeded");
      return "caught";
    })).resolves.toBe("caught");

    expect(firstCallbackEntered).toBe(false);
    expect(secondCallbackEntered).toBe(true);
    expect(calls).toEqual([
      "BEGIN IMMEDIATE",
      "SAVEPOINT lcm_atomic_0",
      "SAVEPOINT lcm_atomic_1",
      "RELEASE SAVEPOINT lcm_atomic_1",
      "COMMIT",
    ]);
    expect(calls.some((sql) => sql.startsWith("ROLLBACK"))).toBe(false);
    expect(onPoison).not.toHaveBeenCalled();
    expect((
      executor as unknown as { scopedAtomicTails: Map<symbol, Promise<void>> }
    ).scopedAtomicTails.size).toBe(0);
    await expect(executor.run("conversations", "listConversations", () => "usable"))
      .resolves.toBe("usable");
  });

  it("uses only outer rollback for an uncaught savepoint-open failure", async () => {
    const calls: string[] = [];
    const onPoison = vi.fn();
    const database = {
      exec: (sql: string): void => {
        calls.push(sql);
        if (sql.startsWith("SAVEPOINT")) {
          throw new Error("savepoint open /secret/path");
        }
      },
    } as unknown as DatabaseSync;
    const executor = new SqliteExecutor(database, "safe-project", onPoison);
    let callbackEntered = false;

    const failure = await executor.transaction(async (token) => executor.runAtomicScoped(
      token,
      "conversations",
      "appendMessages",
      () => { callbackEntered = true; },
    )).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      domain: "conversations",
      operation: "appendMessages",
    });
    expect(JSON.stringify(failure)).not.toContain("/secret/");
    expect(callbackEntered).toBe(false);
    expect(calls).toEqual([
      "BEGIN IMMEDIATE",
      "SAVEPOINT lcm_atomic_0",
      "ROLLBACK",
    ]);
    expect(calls.some((sql) =>
      sql.startsWith("ROLLBACK TO") || sql.startsWith("RELEASE"))).toBe(false);
    expect(onPoison).not.toHaveBeenCalled();
    await expect(executor.run("conversations", "listConversations", () => "usable"))
      .resolves.toBe("usable");
  });

  it("poisons only when outer rollback fails after a savepoint-open failure", async () => {
    const calls: string[] = [];
    const onPoison = vi.fn();
    const database = {
      exec: (sql: string): void => {
        calls.push(sql);
        if (sql.startsWith("SAVEPOINT")) {
          throw new Error("savepoint open /secret/path");
        }
        if (sql === "ROLLBACK") {
          throw new Error("outer rollback /secret/path");
        }
      },
    } as unknown as DatabaseSync;
    const executor = new SqliteExecutor(database, "safe-project", onPoison);
    let callbackEntered = false;

    const failure = await executor.transaction(async (token) => executor.runAtomicScoped(
      token,
      "conversations",
      "deleteMessages",
      () => { callbackEntered = true; },
    )).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      domain: "conversations",
      operation: "deleteMessages",
    });
    expect(JSON.stringify(failure)).not.toContain("/secret/");
    expect(callbackEntered).toBe(false);
    expect(calls).toEqual([
      "BEGIN IMMEDIATE",
      "SAVEPOINT lcm_atomic_0",
      "ROLLBACK",
    ]);
    expect(calls.some((sql) =>
      sql.startsWith("ROLLBACK TO") || sql.startsWith("RELEASE"))).toBe(false);
    expect(onPoison).toHaveBeenCalledOnce();
    await expect(executor.run("conversations", "listConversations", () => undefined))
      .rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
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

  it("serializes concurrent scoped savepoints and resets their ordinal per transaction", async () => {
    const calls: string[] = [];
    const database = {
      exec: (sql: string): void => { calls.push(sql); },
    } as unknown as DatabaseSync;
    const executor = new SqliteExecutor(database, "safe-project");
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const order: string[] = [];

    await expect(executor.transaction(async (token) => {
      const first = executor.runAtomicScoped(
        token,
        "conversations",
        "createMessagesBulk",
        async () => {
          order.push("first-enter");
          markFirstEntered();
          await firstRelease;
          order.push("first-fail");
          throw new Error("first batch failed");
        },
      );
      await firstEntered;
      const second = executor.runAtomicScoped(
        token,
        "conversations",
        "createMessageParts",
        () => {
          order.push("second-enter");
          return "second succeeded";
        },
      );
      await Promise.resolve();
      expect(order).toEqual(["first-enter"]);
      releaseFirst();
      await expect(first).rejects.toMatchObject({
        domain: "conversations",
        operation: "createMessagesBulk",
      });
      await expect(second).resolves.toBe("second succeeded");
      return "committed";
    })).resolves.toBe("committed");
    await expect(executor.transaction(async (token) => executor.runAtomicScoped(
      token,
      "conversations",
      "appendMessages",
      () => {
        order.push("reset-enter");
        return "reset succeeded";
      },
    ))).resolves.toBe("reset succeeded");

    expect(order).toEqual([
      "first-enter",
      "first-fail",
      "second-enter",
      "reset-enter",
    ]);
    expect(calls).toEqual([
      "BEGIN IMMEDIATE",
      "SAVEPOINT lcm_atomic_0",
      "ROLLBACK TO SAVEPOINT lcm_atomic_0",
      "RELEASE SAVEPOINT lcm_atomic_0",
      "SAVEPOINT lcm_atomic_1",
      "RELEASE SAVEPOINT lcm_atomic_1",
      "COMMIT",
      "BEGIN IMMEDIATE",
      "SAVEPOINT lcm_atomic_0",
      "RELEASE SAVEPOINT lcm_atomic_0",
      "COMMIT",
    ]);
    await expect(executor.run(
      "conversations",
      "listConversations",
      () => "reusable",
    )).resolves.toBe("reusable");
  });

  it.each([
    Number.NaN,
    -1,
    Number.MAX_SAFE_INTEGER,
  ])("rejects unsafe transaction-local executor savepoint ordinal %s", async (ordinal) => {
    const calls: string[] = [];
    const database = {
      exec: (sql: string): void => { calls.push(sql); },
    } as unknown as DatabaseSync;
    const executor = new SqliteExecutor(database, "safe-project");
    const atomicExecutor = executor as unknown as {
      atomicScoped<T>(
        active: { executor: SqliteExecutor; token: symbol; savepointOrdinal: number },
        domain: "conversations",
        operation: string,
        callback: () => T | Promise<T>,
      ): Promise<T>;
    };
    const active = {
      executor,
      token: Symbol("unsafe-savepoint-ordinal"),
      savepointOrdinal: ordinal,
    };
    let operationEntered = false;

    await expect(atomicExecutor.atomicScoped(
      active,
      "conversations",
      "appendMessages",
      () => { operationEntered = true; },
    )).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      domain: "conversations",
      operation: "appendMessages",
    });
    expect(operationEntered).toBe(false);
    expect(Object.is(active.savepointOrdinal, ordinal)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("rejects recursive same-token atomic scopes without deadlocking the queue", async () => {
    const calls: string[] = [];
    const database = {
      exec: (sql: string): void => { calls.push(sql); },
    } as unknown as DatabaseSync;
    const executor = new SqliteExecutor(database, "safe-project");
    let nestedCallbackEntered = false;

    await expect(executor.transaction(async (token) => executor.runAtomicScoped(
      token,
      "conversations",
      "createMessagesBulk",
      async () => {
        const nestedFailure = await executor.runAtomicScoped(
          token,
          "conversations",
          "deleteMessages",
          () => { nestedCallbackEntered = true; },
        ).catch((error: unknown) => error);
        expect(nestedFailure).toMatchObject({
          code: "STORAGE_TRANSACTION_SCOPE",
          domain: "conversations",
          operation: "deleteMessages",
        });
        expect(JSON.stringify(nestedFailure)).not.toContain("cause");
        return "outer completed";
      },
    ))).resolves.toBe("outer completed");

    expect(nestedCallbackEntered).toBe(false);
    expect(calls).toEqual([
      "BEGIN IMMEDIATE",
      "SAVEPOINT lcm_atomic_0",
      "RELEASE SAVEPOINT lcm_atomic_0",
      "COMMIT",
    ]);
  });

  it("revalidates a queued scoped savepoint before touching SQLite", async () => {
    const calls: string[] = [];
    const database = {
      exec: (sql: string): void => { calls.push(sql); },
    } as unknown as DatabaseSync;
    const executor = new SqliteExecutor(database, "safe-project");
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });

    await executor.transaction(async (token) => {
      const first = executor.runAtomicScoped(
        token,
        "conversations",
        "createMessagesBulk",
        async () => {
          markFirstEntered();
          await firstRelease;
        },
      );
      await firstEntered;
      const queued = executor.runAtomicScoped(
        token,
        "conversations",
        "deleteMessages",
        () => undefined,
      );
      const activeTokens = (
        executor as unknown as { activeTokens: Set<symbol> }
      ).activeTokens;
      activeTokens.delete(token);
      releaseFirst();
      await first;
      await expect(queued).rejects.toMatchObject({
        code: "STORAGE_TRANSACTION_SCOPE",
        operation: "deleteMessages",
      });
      activeTokens.add(token);
    });

    expect(calls).toEqual([
      "BEGIN IMMEDIATE",
      "SAVEPOINT lcm_atomic_0",
      "RELEASE SAVEPOINT lcm_atomic_0",
      "COMMIT",
    ]);
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
