import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cwdError: undefined as unknown,
  policyError: undefined as unknown,
  provider: undefined as string | undefined,
  summarizer: (async () => "summary") as ((...args: unknown[]) => Promise<string>) | undefined,
  summarizerError: undefined as unknown,
  summarizerGate: undefined as Promise<void> | undefined,
  tokenCount: 1,
  messages: [] as Array<{ role: string; content: string; tokenCount: number }>,
  summaries: [] as Array<{ summaryId?: string; content: string; depth: number }>,
  compactResult: { actionTaken: false, tokensBefore: 10, tokensAfter: 10 } as Record<string, unknown>,
  existingMeta: false,
  metaText: "{}",
  metaError: undefined as unknown,
  identityError: undefined as unknown,
  paths: vi.fn((cwd: string) => ({
    id: "pid",
    dir: "/tmp/project",
    dbPath: "/tmp/project/lcm.db",
    metaPath: "/tmp/project/meta.json",
    canonical: cwd,
  })),
  identity: vi.fn((
    _cwd: string,
    _config?: unknown,
    local?: { id: string; canonical: string; remoteProjectId?: string },
  ) => local?.remoteProjectId
    ? {
        id: local.remoteProjectId,
        localProjectId: local.id,
        canonical: local.canonical,
        remoteProjectId: local.remoteProjectId,
        machineId: "machine-id",
      }
    : {
        ...local,
        id: local?.id ?? "pid",
        localProjectId: local?.id ?? "pid",
      }),
  ensureProject: vi.fn(),
  queuedKeys: [] as string[],
  beforeQueuedWork: undefined as (() => void) | undefined,
  transactionActive: false,
  scrubber: vi.fn(async () => ({ scrubWithCounts: (content: string) => ({ text: content, gitleaks: 0, builtIn: 0, global: 0, project: 0 }) })),
  openProject: vi.fn(),
  projectClose: vi.fn(async () => undefined),
  projectHealth: vi.fn(async () => ({ status: "healthy" })),
  factoryClose: vi.fn(async () => undefined),
  openProjectError: undefined as unknown,
  compactionStorageProbe: undefined as ((storage: {
    health: () => Promise<unknown>;
    close: () => Promise<void>;
  }) => Promise<void>) | undefined,
}));

vi.mock("../../../src/daemon/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/daemon/config.js")>();
  return {
    ...actual,
    resolveLlmRequestPolicy: (...args: Parameters<typeof actual.resolveLlmRequestPolicy>) => {
      if (state.policyError !== undefined) throw state.policyError;
      return actual.resolveLlmRequestPolicy(...args);
    },
  };
});

vi.mock("../../../src/daemon/validate-cwd.js", () => ({
  validateCwd: (cwd: string) => {
    if (state.cwdError !== undefined) throw state.cwdError;
    return cwd;
  },
}));

vi.mock("../../../src/daemon/summarizer.js", () => ({
  resolveEffectiveProvider: (_config: unknown, client?: string) => state.provider ?? (client === "codex" ? "codex-process" : "openai"),
  makeSummarizerCache: () => async () => {
    if (state.summarizerGate) await state.summarizerGate;
    if (state.summarizerError !== undefined) throw state.summarizerError;
    return state.summarizer;
  },
}));

vi.mock("../../../src/daemon/project.js", () => ({
  projectIdentity: (cwd: string, storageConfig: unknown) => {
    if (state.identityError !== undefined) throw state.identityError;
    const local = state.paths(cwd);
    return state.identity(cwd, storageConfig, local);
  },
  projectPaths: state.paths,
  ensureProjectDirForIdentity: state.ensureProject,
  isSafeTranscriptPath: () => true,
}));

vi.mock("../../../src/daemon/project-queue.js", () => ({
  enqueue: (id: string, work: () => unknown) => {
    state.queuedKeys.push(id);
    state.beforeQueuedWork?.();
    return work();
  },
}));
vi.mock("../../../src/db/connection.js", () => ({
  getLcmConnection: () => ({}),
  closeLcmConnection: vi.fn(),
  withYieldingLcmConnectionLock: (
    _path: string,
    work: (lock: { yieldWhile: (operation: () => Promise<unknown>) => Promise<unknown> }) => unknown,
  ) => work({ yieldWhile: (operation) => operation() }),
}));
vi.mock("../../../src/db/migration.js", () => ({ runLcmMigrations: vi.fn() }));
vi.mock("../../../src/db/redaction-stats.js", () => ({ upsertRedactionCounts: vi.fn() }));
vi.mock("../../../src/transcript-provider.js", () => ({
  normalizeTranscriptClient: (client?: string) => client ?? "claude",
  parseTranscriptForClient: () => state.messages,
}));
vi.mock("../../../src/scrub.js", () => ({
  ScrubEngine: { forProject: state.scrubber },
}));
vi.mock("../../../src/store/conversation-store.js", () => ({
  ConversationStore: class {
    getOrCreateConversation = async () => ({ conversationId: "conversation" });
    getMessageCount = async () => 0;
    withTransaction = async (work: () => unknown) => work();
    createMessagesBulk = async () => [];
  },
}));
vi.mock("../../../src/store/summary-store.js", () => ({
  SummaryStore: class {
    appendContextMessages = async () => undefined;
    getContextTokenCount = async () => state.tokenCount;
    getSummariesByConversation = async () => state.summaries;
    getSummary = async () => ({ content: "created summary" });
  },
}));
vi.mock("../../../src/storage/index.js", () => ({
  resolveStorageIdentityContext: (storageConfig: unknown, local: {
    id: string;
    canonical: string;
    remoteProjectId?: string;
  }) => {
    if (state.identityError !== undefined) throw state.identityError;
    return state.identity(local.canonical, storageConfig, local);
  },
  createStorageBackendFactory: () => ({
    openProject: async (...args: unknown[]) => {
      state.openProject(...args);
      if (state.openProjectError !== undefined) throw state.openProjectError;
      const conversations = {
        getOrCreateConversation: async () => ({ conversationId: "conversation" }),
        getMessageCount: async () => 0,
        createMessagesBulk: async () => [],
      };
      const summaries = {
        getSummariesByConversation: async () => state.summaries,
        getSummary: async () => ({ content: "created summary" }),
      };
      const context = {
        appendContextMessages: async () => undefined,
        getContextTokenCount: async () => state.tokenCount,
      };
      const repositories = {
        conversations,
        summaries,
        context,
        largeFiles: {},
        promotedMemory: {},
        recall: {},
        redactionAdmin: { upsertCounts: async () => undefined },
        lexicalSearch: {},
        coordination: {},
      };
      return {
        ...repositories,
        transaction: async (callback: (value: typeof repositories) => Promise<unknown>) => {
          state.transactionActive = true;
          try {
            return await callback(repositories);
          } finally {
            state.transactionActive = false;
          }
        },
        close: state.projectClose,
        health: state.projectHealth,
      };
    },
    close: state.factoryClose,
  }),
}));
vi.mock("../../../src/compaction.js", () => ({
  MANUAL_COMPACT_FRESH_TAIL_COUNT: 8,
  CompactionEngine: class {
    constructor(private readonly storage: {
      health: () => Promise<unknown>;
      close: () => Promise<void>;
    }) {}

    compact = async () => {
      await state.compactionStorageProbe?.(this.storage);
      return state.compactResult;
    };
  },
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => state.existingMeta,
  readFileSync: () => {
    if (state.metaError !== undefined) throw state.metaError;
    return state.metaText;
  },
  writeFileSync: vi.fn(),
}));

import { loadDaemonConfig } from "../../../src/daemon/config.js";
import {
  buildCompactionMessage,
  createCompactHandler as createCompactHandlerProduction,
} from "../../../src/daemon/routes/compact.js";
import type {
  RouteExecutionContext,
  RouteHandler,
  RoutePublicationAdmission,
} from "../../../src/daemon/server.js";
import type { StorageBackendFactory } from "../../../src/storage/index.js";
import { UnavailablePostgreSqlStorageBackendFactory } from "../../../src/storage/factory.js";
import { StorageIdentityConfigurationError } from "../../../src/storage/identity-context.js";
import { BackendPublicationJournalError } from "../../../src/storage/backend-publication.js";

// Intentional unit-test admission seam: the production route receives a live
// token from the daemon server; this mocked boundary supplies an explicit
// token-shaped authority while project/storage modules are mocked below.
const testPublicationAdmission: RoutePublicationAdmission = async operation => operation({});
const testCompactContext: RouteExecutionContext = {
  withPublicationAdmission: testPublicationAdmission,
};

function createCompactHandler(
  value: ReturnType<typeof loadDaemonConfig>,
  factory?: StorageBackendFactory,
): RouteHandler {
  const handler = createCompactHandlerProduction(value, factory);
  return (req, res, body, context = testCompactContext) => handler(req, res, body, context);
}

function config() {
  const value = loadDaemonConfig("/does-not-exist");
  value.llm.provider = "openai";
  return value;
}

function response() {
  let payload = "";
  return {
    res: { writeHead: vi.fn().mockReturnThis(), end: vi.fn((body?: string) => { payload = body ?? ""; }) } as never,
    json: () => JSON.parse(payload || "{}") as Record<string, unknown>,
  };
}

async function call(body: string, value = config()) {
  const output = response();
  await createCompactHandler(value)({} as never, output.res, body);
  return output.json();
}

describe("compact route coverage", () => {
  beforeEach(() => {
    state.cwdError = undefined;
    state.policyError = undefined;
    state.provider = undefined;
    state.summarizer = async () => "summary";
    state.summarizerError = undefined;
    state.summarizerGate = undefined;
    state.tokenCount = 1;
    state.messages = [];
    state.summaries = [];
    state.compactResult = { actionTaken: false, tokensBefore: 10, tokensAfter: 10 };
    state.existingMeta = false;
    state.metaText = "{}";
    state.metaError = undefined;
    state.identityError = undefined;
    state.paths.mockReset();
    state.paths.mockImplementation((cwd: string) => ({
      id: "pid",
      dir: "/tmp/project",
      dbPath: "/tmp/project/lcm.db",
      metaPath: "/tmp/project/meta.json",
      canonical: cwd,
    }));
    state.identity.mockReset();
    state.identity.mockImplementation((_cwd, _storageConfig, local) => (
      local?.remoteProjectId
        ? {
            id: local.remoteProjectId,
            localProjectId: local.id,
            canonical: local.canonical,
            remoteProjectId: local.remoteProjectId,
            machineId: "machine-id",
          }
        : {
            ...local,
            id: local?.id ?? "pid",
            localProjectId: local?.id ?? "pid",
          }
    ));
    state.ensureProject.mockClear();
    state.ensureProject.mockReturnValue("/tmp/project");
    state.queuedKeys = [];
    state.beforeQueuedWork = undefined;
    state.transactionActive = false;
    state.scrubber.mockClear();
    state.openProject.mockClear();
    state.projectClose.mockClear();
    state.projectHealth.mockClear();
    state.factoryClose.mockClear();
    state.openProjectError = undefined;
    state.compactionStorageProbe = undefined;
  });

  it("formats million-token and zero-input compactions", () => {
    expect(buildCompactionMessage({ tokensBefore: 1_000_000, tokensAfter: 0, messageCount: 0, summaryCount: 0, maxDepth: 0, promotedCount: 0 }))
      .toContain("1.0M");
    expect(buildCompactionMessage({ tokensBefore: 0, tokensAfter: 0, messageCount: 0, summaryCount: 0, maxDepth: 0, promotedCount: 0 }))
      .toContain("0.0% saved");
  });

  it("fails PostgreSQL identity before local directory, scrubber, or storage effects", async () => {
    state.identityError = new Error("PostgreSQL project binding is required");

    await expect(call(JSON.stringify({ session_id: "identity", cwd: "/tmp" })))
      .resolves.toEqual({ error: "PostgreSQL project binding is required" });
    expect(state.ensureProject).not.toHaveBeenCalled();
    expect(state.scrubber).not.toHaveBeenCalled();
    expect(state.openProject).not.toHaveBeenCalled();
  });

  it("uses a generic message for a non-error PostgreSQL identity failure", async () => {
    state.identityError = "identity failed";

    await expect(call(JSON.stringify({ session_id: "identity-primitive", cwd: "/tmp" })))
      .resolves.toEqual({ error: "compact failed" });
    expect(state.ensureProject).not.toHaveBeenCalled();
    expect(state.scrubber).not.toHaveBeenCalled();
    expect(state.openProject).not.toHaveBeenCalled();
  });

  it("admits successful SQLite storage ahead of local compaction setup", async () => {
    await expect(call(JSON.stringify({ session_id: "sqlite-order", cwd: "/tmp" })))
      .resolves.toMatchObject({ actionTaken: false });
    expect(state.ensureProject).toHaveBeenCalledOnce();
    expect(state.scrubber).toHaveBeenCalledOnce();
    expect(state.openProject).toHaveBeenCalledOnce();
    expect(state.identity.mock.invocationCallOrder[0])
      .toBeLessThan(state.openProject.mock.invocationCallOrder[0]);
    expect(state.openProject.mock.invocationCallOrder[0])
      .toBeLessThan(state.ensureProject.mock.invocationCallOrder[0]);
    expect(state.ensureProject.mock.invocationCallOrder[0])
      .toBeLessThan(state.scrubber.mock.invocationCallOrder[0]);
  });

  it("closes a project when admission fails after opening it", async () => {
    const closeAfterAdmissionFailure = vi.fn(async () => undefined);
    const repositories = {
      conversations: {},
      summaries: {},
      context: {},
      largeFiles: {},
      promotedMemory: {},
      recall: {},
      redactionAdmin: {},
      lexicalSearch: {},
      coordination: {},
    };
    const factory = {
      openProject: vi.fn(async () => ({
        ...repositories,
        transaction: async () => undefined,
        close: closeAfterAdmissionFailure,
      })),
      close: vi.fn(async () => undefined),
    } as unknown as StorageBackendFactory;
    let admissions = 0;
    const context: RouteExecutionContext = {
      withPublicationAdmission: async operation => {
        admissions += 1;
        const value = await operation({});
        if (admissions === 2) {
          throw new BackendPublicationJournalError(
            "unexpected-state",
            "admission changed after project open",
          );
        }
        return value;
      },
    };
    const output = response();

    await createCompactHandler(config(), factory)(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "open-admission-failure", cwd: "/tmp" }),
      context,
    );

    expect(output.json()).toEqual({
      status: "blocked",
      error: "backend publication admission blocked",
    });
    expect(closeAfterAdmissionFailure).toHaveBeenCalledOnce();
  });

  it("keeps transcript transaction repositories inside one admission", async () => {
    state.existingMeta = true;
    state.messages = [{ role: "user", content: "transcript", tokenCount: 1 }];
    const admissionCalls = vi.fn();
    const context: RouteExecutionContext = {
      withPublicationAdmission: async operation => {
        admissionCalls();
        if (state.transactionActive) throw new Error("nested publication admission");
        return operation({});
      },
    };
    const output = response();

    await createCompactHandler(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "transaction-scope", cwd: "/tmp", transcript_path: "/tmp/transcript" }),
      context,
    );

    expect(output.json()).toMatchObject({ actionTaken: false });
    expect(admissionCalls).toHaveBeenCalled();
    expect(state.transactionActive).toBe(false);
  });

  it.each([
    [
      "local project directory",
      () => state.ensureProject.mockImplementationOnce(() => {
        throw new Error("local project setup failed");
      }),
      "local project setup failed",
    ],
    [
      "scrubber",
      () => state.scrubber.mockRejectedValueOnce(new Error("scrubber setup failed")),
      "scrubber setup failed",
    ],
  ])("closes shared admitted storage when %s setup fails", async (
    label,
    failSetup,
    expectedError,
  ) => {
    const closeProject = vi.fn(async () => undefined);
    const closeFactory = vi.fn(async () => undefined);
    const repositories = {
      conversations: {},
      summaries: {},
      context: {},
      largeFiles: {},
      promotedMemory: {},
      recall: {},
      redactionAdmin: {},
      lexicalSearch: {},
      coordination: {},
    };
    const sharedFactory = {
      openProject: vi.fn(async () => ({
        ...repositories,
        transaction: async () => undefined,
        close: closeProject,
      })),
      close: closeFactory,
    };
    failSetup();
    const output = response();

    await createCompactHandler(config(), sharedFactory as never)(
      {} as never,
      output.res,
      JSON.stringify({ session_id: `setup-${label}`, cwd: "/tmp" }),
    );

    expect(output.json()).toEqual({ error: expectedError });
    expect(closeProject).toHaveBeenCalledOnce();
    expect(closeFactory).not.toHaveBeenCalled();
  });

  it("revalidates local and remote identity before queued storage setup", async () => {
    const first = {
      id: "local-hash-a",
      canonical: "/work/project",
      remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      dir: "/lcm/projects/local-hash-a",
      dbPath: "/lcm/projects/local-hash-a/db.sqlite",
      metaPath: "/lcm/projects/local-hash-a/meta.json",
    };
    const concurrent = {
      ...first,
      id: "local-hash-b",
      remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021",
      dir: "/lcm/projects/local-hash-b",
      dbPath: "/lcm/projects/local-hash-b/db.sqlite",
      metaPath: "/lcm/projects/local-hash-b/meta.json",
    };
    state.paths.mockReturnValueOnce(first).mockReturnValueOnce(first);
    state.ensureProject.mockReturnValue(first.dir);
    state.beforeQueuedWork = () => {
      state.paths.mockReturnValue(concurrent);
    };
    const value = config();
    value.storage = {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://user:secret@db.example/lcm",
        poolMax: 5,
        connectionTimeoutMs: 10_000,
        idleTimeoutMs: 30_000,
        statementTimeoutMs: 60_000,
      },
    };

    await expect(call(JSON.stringify({
      session_id: "queued-snapshot",
      cwd: first.canonical,
    }), value)).resolves.toEqual({
      status: "blocked",
      error: "backend publication admission blocked",
    });

    expect(state.paths).toHaveBeenCalledTimes(3);
    expect(state.queuedKeys).toEqual([first.id]);
    expect(state.ensureProject).not.toHaveBeenCalled();
    expect(state.scrubber).not.toHaveBeenCalled();
    expect(state.projectClose).toHaveBeenCalledOnce();
    expect(state.openProject).toHaveBeenCalledWith({
      id: first.remoteProjectId,
      localProjectId: first.id,
      canonical: first.canonical,
      remoteProjectId: first.remoteProjectId,
      machineId: "machine-id",
    }, expect.any(Object));
  });

  it.each([
    [{ session_id: "s", cwd: "/tmp", fast_mode: "yes" }, "fast_mode must be a boolean"],
    [{ session_id: "s", cwd: "/tmp", request_timeout_ms: "slow" }, "request_timeout_ms must be a number"],
    [{ session_id: "s", cwd: "/tmp", retry: null }, "retry must be an object"],
    [{ session_id: "s", cwd: "/tmp", retry: [] }, "retry must be an object"],
  ])("rejects boundary field %j", async (body, error) => {
    expect(await call(JSON.stringify(body))).toEqual({ error });
  });

  it("uses the empty-body fallback", async () => {
    expect(await call("")).toEqual({ error: "session_id must be a non-empty string" });
  });

  it("fails closed when no route admission context is supplied", async () => {
    const output = response();
    await createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "missing-admission", cwd: "/tmp" }),
    );
    expect(output.json()).toEqual({
      status: "blocked",
      error: "backend publication admission blocked",
    });
  });

  it("sanitizes an initial publication admission failure", async () => {
    const output = response();
    const context: RouteExecutionContext = {
      withPublicationAdmission: async () => {
        throw new BackendPublicationJournalError("unexpected-state", "private publication details");
      },
    };

    await createCompactHandler(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "initial-admission-failure", cwd: "/tmp" }),
      context,
    );

    expect(output.json()).toEqual({
      status: "blocked",
      error: "backend publication admission blocked",
    });
  });

  it("uses the non-Error cwd fallback", async () => {
    state.cwdError = "invalid";
    expect(await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }))).toEqual({ error: "invalid cwd" });
  });

  it("reports an Error cwd message", async () => {
    state.cwdError = new Error("cwd exploded");
    expect(await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }))).toEqual({ error: "cwd exploded" });
  });

  it("uses the generic request-policy fallback", async () => {
    state.policyError = "bad policy";
    expect(await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }))).toEqual({ error: "Invalid request policy" });
  });

  it("returns the effective timeout without retry diagnostics for an auto-resolved process provider", async () => {
    const value = config();
    value.llm.provider = "auto";
    value.llm.requestTimeoutMs = 75_000;
    state.provider = "codex-process";
    state.summarizer = undefined;
    const body = await call(JSON.stringify({
      session_id: "auto-process-timeout",
      cwd: "/tmp",
      client: "codex",
    }), value);
    expect(body).toMatchObject({
      providerLabel: "Codex (process)",
      requestTimeoutMs: 75_000,
      retry: null,
    });
  });

  it("labels an unknown runtime provider through the defensive fallback", async () => {
    state.provider = "future-provider";
    state.summarizer = undefined;
    const body = await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }));
    expect(body.providerLabel).toBe("future-provider");
  });

  it("rejects a concurrent compaction for the same session", async () => {
    let release!: () => void;
    state.summarizerGate = new Promise<void>((resolve) => { release = resolve; });
    const handler = createCompactHandler(config());
    const first = response();
    const firstCall = handler({} as never, first.res, JSON.stringify({ session_id: "same", cwd: "/tmp" }));
    await vi.waitFor(() => expect(state.summarizerGate).toBeDefined());
    const second = response();
    await handler({} as never, second.res, JSON.stringify({ session_id: "same", cwd: "/tmp" }));
    expect(second.json()).toEqual({ skipped: true, actionTaken: false, summary: "Compaction already in progress for this session." });
    release();
    await firstCall;
  });

  it("closes an owned factory on the duplicate early return", async () => {
    let release!: () => void;
    state.summarizerGate = new Promise<void>((resolve) => { release = resolve; });
    const handler = createCompactHandler(config());
    const first = response();
    const firstCall = handler(
      {} as never,
      first.res,
      JSON.stringify({ session_id: "owned-factory-duplicate", cwd: "/tmp" }),
    );

    const duplicate = response();
    await handler(
      {} as never,
      duplicate.res,
      JSON.stringify({ session_id: "owned-factory-duplicate", cwd: "/tmp" }),
    );

    expect(duplicate.json()).toEqual({
      skipped: true,
      actionTaken: false,
      summary: "Compaction already in progress for this session.",
    });
    expect(state.factoryClose).toHaveBeenCalledOnce();

    release();
    await firstCall;
    expect(state.factoryClose).toHaveBeenCalledTimes(2);
  });

  it("admits PostgreSQL identity before returning the duplicate shortcut", async () => {
    let release!: () => void;
    state.summarizerGate = new Promise<void>((resolve) => { release = resolve; });
    state.identityError = new StorageIdentityConfigurationError("project is unbound");
    const value = config();
    value.storage = {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://runtime@example.invalid/lcm",
        caFile: "/ca.pem",
        poolMax: 1,
        connectionTimeoutMs: 1,
        idleTimeoutMs: 1,
        statementTimeoutMs: 1,
      },
    };
    const handler = createCompactHandler(value);
    const first = response();
    const firstCall = handler(
      {} as never,
      first.res,
      JSON.stringify({ session_id: "postgres-duplicate-identity", cwd: "/tmp" }),
    );
    const duplicate = response();
    await handler(
      {} as never,
      duplicate.res,
      JSON.stringify({ session_id: "postgres-duplicate-identity", cwd: "/tmp" }),
    );

    expect(duplicate.json()).toMatchObject({
      code: "STORAGE_IDENTITY_REQUIRED",
      storageBackend: "postgresql",
    });
    release();
    await firstCall;
  });

  it("admits PostgreSQL staging before returning the duplicate shortcut", async () => {
    let release!: () => void;
    state.summarizerGate = new Promise<void>((resolve) => { release = resolve; });
    state.paths.mockImplementation((cwd: string) => ({
      id: "pid",
      dir: "/tmp/project",
      dbPath: "/tmp/project/lcm.db",
      metaPath: "/tmp/project/meta.json",
      canonical: cwd,
      remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
    }));
    const value = config();
    value.storage = {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://runtime@example.invalid/lcm",
        caFile: "/ca.pem",
        poolMax: 1,
        connectionTimeoutMs: 1,
        idleTimeoutMs: 1,
        statementTimeoutMs: 1,
      },
    };
    const handler = createCompactHandler(
      value,
      new UnavailablePostgreSqlStorageBackendFactory(),
    );
    const first = response();
    const firstCall = handler(
      {} as never,
      first.res,
      JSON.stringify({ session_id: "postgres-duplicate-staged", cwd: "/tmp" }),
    );
    const duplicate = response();
    await handler(
      {} as never,
      duplicate.res,
      JSON.stringify({ session_id: "postgres-duplicate-staged", cwd: "/tmp" }),
    );

    expect(duplicate.json()).toMatchObject({
      code: "STORAGE_BACKEND_STAGED",
      storageBackend: "postgresql",
    });
    release();
    await firstCall;
  });

  it("returns the duplicate shortcut only after successful PostgreSQL admission", async () => {
    let release!: () => void;
    state.summarizerGate = new Promise<void>((resolve) => { release = resolve; });
    state.paths.mockImplementation((cwd: string) => ({
      id: "pid",
      dir: "/tmp/project",
      dbPath: "/tmp/project/lcm.db",
      metaPath: "/tmp/project/meta.json",
      canonical: cwd,
      remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
    }));
    const value = config();
    value.storage = {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://runtime@example.invalid/lcm",
        caFile: "/ca.pem",
        poolMax: 1,
        connectionTimeoutMs: 1,
        idleTimeoutMs: 1,
        statementTimeoutMs: 1,
      },
    };
    const handler = createCompactHandler(value);
    const first = response();
    const firstCall = handler(
      {} as never,
      first.res,
      JSON.stringify({ session_id: "postgres-duplicate-success", cwd: "/tmp" }),
    );
    const duplicate = response();
    await handler(
      {} as never,
      duplicate.res,
      JSON.stringify({ session_id: "postgres-duplicate-success", cwd: "/tmp" }),
    );

    expect(duplicate.json()).toEqual({
      skipped: true,
      actionTaken: false,
      summary: "Compaction already in progress for this session.",
    });
    expect(state.openProject).toHaveBeenCalledTimes(1);
    release();
    await firstCall;
  });

  it.each([
    ["Error", new Error("storage open failed"), "storage open failed"],
    ["non-Error", "storage open failed", "compact failed"],
  ])("reports a %s PostgreSQL duplicate-admission failure", async (
    _label,
    openProjectError,
    expectedError,
  ) => {
    let release!: () => void;
    state.summarizerGate = new Promise<void>((resolve) => { release = resolve; });
    const value = config();
    value.storage = {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://runtime@example.invalid/lcm",
        caFile: "/ca.pem",
        poolMax: 1,
        connectionTimeoutMs: 1,
        idleTimeoutMs: 1,
        statementTimeoutMs: 1,
      },
    };
    const handler = createCompactHandler(value);
    const first = response();
    const firstCall = handler(
      {} as never,
      first.res,
      JSON.stringify({ session_id: "postgres-duplicate-error", cwd: "/tmp" }),
    );
    state.openProjectError = openProjectError;
    const duplicate = response();
    await handler(
      {} as never,
      duplicate.res,
      JSON.stringify({ session_id: "postgres-duplicate-error", cwd: "/tmp" }),
    );

    expect(duplicate.json()).toEqual({ error: expectedError });
    state.openProjectError = undefined;
    release();
    await firstCall;
  });

  it("classifies a PostgreSQL duplicate storage identity failure", async () => {
    let release!: () => void;
    state.summarizerGate = new Promise<void>((resolve) => { release = resolve; });
    const value = config();
    value.storage = {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://runtime@example.invalid/lcm",
        caFile: "/ca.pem",
        poolMax: 1,
        connectionTimeoutMs: 1,
        idleTimeoutMs: 1,
        statementTimeoutMs: 1,
      },
    };
    const handler = createCompactHandler(value);
    const first = response();
    const firstCall = handler(
      {} as never,
      first.res,
      JSON.stringify({ session_id: "postgres-duplicate-storage-identity", cwd: "/tmp" }),
    );
    state.openProjectError = new StorageIdentityConfigurationError("project binding changed");
    const duplicate = response();
    await handler(
      {} as never,
      duplicate.res,
      JSON.stringify({ session_id: "postgres-duplicate-storage-identity", cwd: "/tmp" }),
    );

    expect(duplicate.json()).toMatchObject({
      code: "STORAGE_IDENTITY_REQUIRED",
      storageBackend: "postgresql",
    });
    state.openProjectError = undefined;
    release();
    await firstCall;
  });

  it("sanitizes a PostgreSQL duplicate publication admission failure", async () => {
    let release!: () => void;
    state.summarizerGate = new Promise<void>((resolve) => { release = resolve; });
    state.openProjectError = new BackendPublicationJournalError(
      "unexpected-state",
      "private duplicate admission details",
    );
    const value = config();
    value.storage = {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://runtime@example.invalid/lcm",
        caFile: "/ca.pem",
        poolMax: 1,
        connectionTimeoutMs: 1,
        idleTimeoutMs: 1,
        statementTimeoutMs: 1,
      },
    };
    const handler = createCompactHandler(value);
    const first = response();
    const firstCall = handler(
      {} as never,
      first.res,
      JSON.stringify({ session_id: "postgres-duplicate-publication-failure", cwd: "/tmp" }),
    );
    const duplicate = response();
    await handler(
      {} as never,
      duplicate.res,
      JSON.stringify({ session_id: "postgres-duplicate-publication-failure", cwd: "/tmp" }),
    );

    expect(duplicate.json()).toEqual({
      status: "blocked",
      error: "backend publication admission blocked",
    });
    state.openProjectError = undefined;
    release();
    await firstCall;
  });

  it("classifies a storage identity failure after PostgreSQL admission", async () => {
    state.paths.mockImplementation((cwd: string) => ({
      id: "pid",
      dir: "/tmp/project",
      dbPath: "/tmp/project/lcm.db",
      metaPath: "/tmp/project/meta.json",
      canonical: cwd,
      remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
    }));
    state.openProjectError = new StorageIdentityConfigurationError("project binding changed");
    const value = config();
    value.storage = {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://runtime@example.invalid/lcm",
        caFile: "/ca.pem",
        poolMax: 1,
        connectionTimeoutMs: 1,
        idleTimeoutMs: 1,
        statementTimeoutMs: 1,
      },
    };

    await expect(call(
      JSON.stringify({ session_id: "postgres-storage-identity", cwd: "/tmp" }),
      value,
    )).resolves.toMatchObject({
      code: "STORAGE_IDENTITY_REQUIRED",
      storageBackend: "postgresql",
    });
  });

  it("handles no newly parsed transcript messages without security config", async () => {
    const value = config();
    delete (value as Partial<typeof value>).security;
    state.existingMeta = true;
    state.metaText = "not json";
    const body = await call(JSON.stringify({ session_id: "s", cwd: "/tmp", transcript_path: "/tmp/transcript.jsonl" }), value);
    expect(body.summary).toBe("No compaction needed.");
    expect(body.actionTaken).toBe(false);
  });

  it("initializes metadata when the metadata file is absent", async () => {
    state.metaError = Object.assign(new Error("missing"), { code: "ENOENT" });
    const body = await call(JSON.stringify({ session_id: "missing-meta", cwd: "/tmp" }));
    expect(body.summary).toBe("No compaction needed.");
  });

  it("falls back to the latest existing summary", async () => {
    state.summaries = [{ content: "older", depth: 1 }, { content: "latest", depth: 2 }];
    const body = await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }));
    expect(body.latestSummaryContent).toBe("latest");
  });

  it("returns actionTaken when compaction creates a summary", async (): Promise<void> => {
    state.compactResult = { actionTaken: true, tokensBefore: 100, tokensAfter: 10, createdSummaryId: "sum-1" };
    state.summaries = [{ summaryId: "sum-1", content: "created", depth: 0 }];
    const body = await call(JSON.stringify({ session_id: "compacted", cwd: "/tmp" }));
    expect(body.actionTaken).toBe(true);
    expect(body.summary).toContain("compaction complete");
  });

  it("admits ProjectStorage health and preserves raw close cleanup through CompactionEngine", async () => {
    const admissionCalls = vi.fn();
    state.compactionStorageProbe = async storage => {
      const beforeHealth = admissionCalls.mock.calls.length;
      await expect(storage.health()).resolves.toEqual({ status: "healthy" });
      expect(admissionCalls).toHaveBeenCalledTimes(beforeHealth + 1);

      const afterHealth = admissionCalls.mock.calls.length;
      await storage.close();
      expect(admissionCalls).toHaveBeenCalledTimes(afterHealth);
    };
    const context: RouteExecutionContext = {
      withPublicationAdmission: async operation => {
        admissionCalls();
        return operation({});
      },
    };
    const output = response();

    await createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "compaction-storage-health-close", cwd: "/tmp" }),
      context,
    );

    expect(output.json()).toMatchObject({ actionTaken: false });
    expect(state.projectHealth).toHaveBeenCalledOnce();
    expect(state.projectClose).toHaveBeenCalledTimes(2);
  });

  it("uses the non-Error internal-failure fallback", async () => {
    state.summarizerError = "provider exploded";
    expect(await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }))).toEqual({ error: "compact failed" });
  });

  it("reports an Error internal-failure message", async () => {
    state.summarizerError = new Error("provider exploded");
    expect(await call(JSON.stringify({ session_id: "s", cwd: "/tmp" }))).toEqual({ error: "provider exploded" });
  });
});
