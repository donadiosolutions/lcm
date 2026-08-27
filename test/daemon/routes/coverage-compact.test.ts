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
  queuedSignals: [] as Array<AbortSignal | undefined>,
  queueSerialize: false,
  queueChains: new Map<string, Promise<void>>(),
  beforeQueuedWork: undefined as (() => void) | undefined,
  transactionActive: false,
  scrubber: vi.fn(async () => ({ scrubWithCounts: (content: string) => ({ text: content, gitleaks: 0, builtIn: 0, global: 0, project: 0 }) })),
  openProject: vi.fn(),
  projectClose: vi.fn(async () => undefined),
  projectHealth: vi.fn(async () => ({ status: "healthy" })),
  factoryClose: vi.fn(async () => undefined),
  openProjectError: undefined as unknown,
  compactInputObserver: undefined as ((input: unknown) => void | Promise<void>) | undefined,
  compactInput: undefined as unknown,
  writeFileSync: vi.fn(),
  compactionStorageProbe: undefined as ((storage: {
    health: () => Promise<unknown>;
    close: () => Promise<void>;
    largeFiles: { scalar: string };
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
  enqueue: (id: string, work: () => unknown, signal?: AbortSignal) => {
    state.queuedKeys.push(id);
    state.queuedSignals.push(signal);
    const run = async (): Promise<unknown> => {
      state.beforeQueuedWork?.();
      if (signal?.aborted) throw createAbortError(signal.reason);
      return work();
    };
    if (!state.queueSerialize) return run();
    const previous = state.queueChains.get(id) ?? Promise.resolve();
    const current = previous.then(run, run);
    state.queueChains.set(id, current.then(() => undefined, () => undefined));
    if (signal === undefined) return current;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(createAbortError(signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      current.then(
        value => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        error => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
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
  createStorageBackendFactory: async () => ({
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
        largeFiles: { scalar: "large-files-scalar" },
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
      largeFiles: { scalar: string };
    }) {}

    compact = async (input: unknown) => {
      state.compactInput = input;
      await state.compactInputObserver?.(input);
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
  writeFileSync: state.writeFileSync,
}));

// Keep this route unit isolated from the daemon's eager route-registration graph.
// The production route only needs the response seam from server.ts here.
vi.mock("../../../src/daemon/server.js", async () => {
  const { sanitizeError } = await import("../../../src/daemon/safe-error.js");
  return {
    sendJson: (
      res: {
        writeHead: (status: number, headers: Record<string, string>) => void;
        end: (body: string) => void;
      },
      status: number,
      data: unknown,
    ): void => {
      const safe =
        data !== null
        && typeof data === "object"
        && "error" in data
        && typeof (data as Record<string, unknown>).error === "string"
          ? {
              ...(data as Record<string, unknown>),
              error: sanitizeError((data as Record<string, unknown>).error as string),
            }
          : data;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(safe));
    },
  };
});

import { loadDaemonConfig } from "../../../src/daemon/config.js";
import {
  buildCompactionMessage,
  createCompactHandler as createCompactHandlerProduction,
  justCompactedMap,
} from "../../../src/daemon/routes/compact.js";
import type {
  RouteExecutionContext,
  RouteHandler,
  RoutePublicationAdmission,
} from "../../../src/daemon/server.js";
import type { StorageBackendFactory } from "../../../src/storage/index.js";
import { makeStagedPostgreSqlStorageFactory } from "./mock-storage-factory.js";
import { StorageIdentityConfigurationError } from "../../../src/storage/identity-context.js";
import { BackendPublicationJournalError } from "../../../src/storage/backend-publication.js";
import {
  createAbortError,
} from "../../../src/daemon/cancellation.js";
import {
  createInvocationCoordinator,
  InvocationCoordinatorError,
  type InvocationCoordinator,
} from "../../../src/daemon/invocation-coordinator.js";

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
  let status = 200;
  return {
    res: {
      writeHead: vi.fn((code: number) => { status = code; }),
      end: vi.fn((body?: string) => { payload = body ?? ""; }),
    } as never,
    status: () => status,
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
    state.queuedSignals = [];
    state.queueSerialize = false;
    state.queueChains.clear();
    state.beforeQueuedWork = undefined;
    state.transactionActive = false;
    state.scrubber.mockClear();
    state.openProject.mockClear();
    state.projectClose.mockClear();
    state.projectHealth.mockClear();
    state.factoryClose.mockClear();
    state.openProjectError = undefined;
    state.compactInputObserver = undefined;
    state.compactInput = undefined;
    state.writeFileSync.mockReset();
    state.writeFileSync.mockImplementation(() => undefined);
    justCompactedMap.clear();
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

  it("closes the long-lived project when the request signal aborts during inference", async () => {
    const controller = new AbortController();
    let inferenceStarted!: () => void;
    const started = new Promise<void>(resolve => { inferenceStarted = resolve; });
    state.compactionStorageProbe = async () => {
      inferenceStarted();
      await new Promise<void>(resolve => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await Promise.resolve();
      expect(state.projectClose).toHaveBeenCalledOnce();
    };
    const output = response();
    const request = createCompactHandler(config());
    const compact = request(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "abort-during-inference", cwd: "/tmp" }),
      { ...testCompactContext, signal: controller.signal },
    );

    await started;
    controller.abort();
    await compact;

    expect(state.projectClose).toHaveBeenCalledOnce();
  });

  it("closes a project when admission observes an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const output = response();

    await createCompactHandler(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "already-aborted", cwd: "/tmp" }),
      { ...testCompactContext, signal: controller.signal },
    );

    expect(state.projectClose).toHaveBeenCalledOnce();
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

  it("rejects an unknown invocation before opening project storage", async () => {
    const coordinator = createInvocationCoordinator({
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    const output = response();

    await createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({
        session_id: "unknown-invocation",
        cwd: "/tmp",
        invocation_id: "22222222-2222-4222-8222-222222222222",
      }),
      { ...testCompactContext, invocationCoordinator: coordinator },
    );

    expect(output.json()).toMatchObject({ error: expect.stringMatching(/unknown|invocation/i) });
    expect(state.openProject).not.toHaveBeenCalled();
    await coordinator.shutdown();
  });

  it("rejects malformed invocation identifiers before control lookup", async () => {
    const output = response();
    await createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "malformed-invocation", cwd: "/tmp", invocation_id: "not-a-uuid" }),
      testCompactContext,
    );

    expect(output.status()).toBe(400);
    expect(output.json()).toEqual({ error: "invocation_id must be a canonical UUID" });
    expect(state.openProject).not.toHaveBeenCalled();
  });

  it("fails closed when an invocation id has no coordinator context", async () => {
    const output = response();
    await createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({
        session_id: "missing-invocation-context",
        cwd: "/tmp",
        invocation_id: "22222222-2222-4222-8222-222222222222",
      }),
      testCompactContext,
    );

    expect(output.status()).toBe(503);
    expect(output.json()).toEqual({ error: "invocation control unavailable" });
    expect(state.openProject).not.toHaveBeenCalled();
  });

  it("returns cancellation when an admitted request is already aborted", async () => {
    const invocationId = "77777777-7777-4777-8777-777777777777";
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    requestController.abort();
    const output = response();

    await createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "already-aborted-invocation", cwd: "/tmp", invocation_id: invocationId }),
      {
        ...testCompactContext,
        signal: requestController.signal,
        invocationCoordinator: coordinator,
      },
    );

    expect(output.status()).toBe(499);
    expect(output.json()).toMatchObject({ status: "cancelled" });
    expect(state.openProject).not.toHaveBeenCalled();
    expect(coordinator.snapshot(invocationId)).toMatchObject({ state: "cancelled", activeCount: 0 });
    await coordinator.shutdown();
  });

  it("returns coordinator cancellation errors from initial admission", async () => {
    const invocationId = "88888888-8888-4888-8888-888888888888";
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const output = response();
    const admission: RoutePublicationAdmission = async () => {
      throw new InvocationCoordinatorError("cancelled", "invocation is cancelling", 409);
    };

    await createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "initial-commit-cancel", cwd: "/tmp", invocation_id: invocationId }),
      { withPublicationAdmission: admission, invocationCoordinator: coordinator },
    );

    expect(output.status()).toBe(409);
    expect(output.json()).toEqual({ error: "invocation admission failed" });
    expect(state.openProject).not.toHaveBeenCalled();
    await coordinator.shutdown();
  });

  it("uses a bounded fallback when invocation admission throws a non-Error", async () => {
    const invocationId = "99999999-9999-4999-8999-999999999999";
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const base = createInvocationCoordinator({ daemonInstanceId });
    base.start({ invocationId, command: "compact", daemonInstanceId });
    const coordinator = {
      ...base,
      heartbeat: () => { throw "not-an-error"; },
    } as unknown as InvocationCoordinator;
    const output = response();

    await createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "non-error-admission", cwd: "/tmp", invocation_id: invocationId }),
      { ...testCompactContext, invocationCoordinator: coordinator },
    );

    expect(output.status()).toBe(409);
    expect(output.json()).toEqual({ error: "invocation admission failed" });
    expect(state.openProject).not.toHaveBeenCalled();
    await base.shutdown();
  });

  it("cancels the invocation when an abort-ignoring provider returns", async () => {
    const invocationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    const cancel = vi.spyOn(coordinator, "cancel");
    state.compactInputObserver = async () => {
      requestController.abort();
    };
    const output = response();

    await createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "provider-return-cancel", cwd: "/tmp", invocation_id: invocationId }),
      {
        ...testCompactContext,
        signal: requestController.signal,
        invocationCoordinator: coordinator,
      },
    );

    expect(output.status()).toBe(499);
    expect(cancel).toHaveBeenCalledOnce();
    expect(state.writeFileSync).not.toHaveBeenCalled();
    expect(justCompactedMap.has("provider-return-cancel")).toBe(false);
    expect(coordinator.snapshot(invocationId)).toMatchObject({ state: "cancelled", activeCount: 0 });
    await coordinator.shutdown();
  });

  it("cancels an invocation through the request signal listener", async () => {
    const invocationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    const cancel = vi.spyOn(coordinator, "cancel");
    cancel.mockRejectedValueOnce(new Error("cancel control unavailable"));
    const output = response();
    let releaseGate!: () => void;
    state.summarizerGate = new Promise<void>(resolve => { releaseGate = resolve; });

    const pending = createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "listener-cancel", cwd: "/tmp", invocation_id: invocationId }),
      {
        ...testCompactContext,
        signal: requestController.signal,
        invocationCoordinator: coordinator,
      },
    );
    await Promise.resolve();
    requestController.abort();
    releaseGate();
    await pending;

    expect(cancel).toHaveBeenCalledOnce();
    expect(output.status()).toBe(499);
    await coordinator.shutdown();
  });

  it("does not write a cancellation response after response headers are sent", async () => {
    const invocationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    state.compactInputObserver = () => { requestController.abort(); };
    const output = response();
    Object.defineProperty(output.res, "headersSent", { value: true, configurable: true });

    await createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "headers-sent-cancel", cwd: "/tmp", invocation_id: invocationId }),
      {
        ...testCompactContext,
        signal: requestController.signal,
        invocationCoordinator: coordinator,
      },
    );

    expect(output.status()).toBe(200);
    expect(output.res.end).not.toHaveBeenCalled();
    await coordinator.shutdown();
  });

  it("propagates intentional metadata cancellation without setting justCompacted", async () => {
    const invocationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    state.writeFileSync.mockImplementation(() => { throw createAbortError(); });
    const output = response();

    await createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "metadata-abort", cwd: "/tmp", invocation_id: invocationId }),
      { ...testCompactContext, invocationCoordinator: coordinator },
    );

    expect(output.status()).toBe(499);
    expect(state.writeFileSync).toHaveBeenCalledOnce();
    expect(justCompactedMap.has("metadata-abort")).toBe(false);
    await coordinator.shutdown();
  });

  it("admits invocation work before queue entry and releases it after settlement", async () => {
    const invocationId = "33333333-3333-4333-8333-333333333333";
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const output = response();

    await createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "admitted-invocation", cwd: "/tmp", invocation_id: invocationId }),
      { ...testCompactContext, invocationCoordinator: coordinator },
    );

    expect(output.status()).toBe(200);
    expect(state.queuedKeys).toEqual(["pid"]);
    expect(state.queuedSignals).toHaveLength(1);
    expect(state.queuedSignals[0]?.aborted).toBe(false);
    expect(state.compactInput).toMatchObject({
      signal: expect.objectContaining({ aborted: false }),
      acquireCommit: expect.any(Function),
    });
    expect(coordinator.snapshot(invocationId)).toMatchObject({
      state: "active",
      activeCount: 0,
      workCount: 0,
      commitCount: 0,
    });
    await coordinator.shutdown();
  });

  it("cancels the matching invocation on request disconnect before project open", async () => {
    const invocationId = "44444444-4444-4444-8444-444444444444";
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    let releaseSummarizer!: () => void;
    state.summarizerGate = new Promise<void>(resolve => { releaseSummarizer = resolve; });
    const requestController = new AbortController();
    const output = response();

    const pending = createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "disconnect-before-open", cwd: "/tmp", invocation_id: invocationId }),
      {
        ...testCompactContext,
        signal: requestController.signal,
        invocationCoordinator: coordinator,
      },
    );
    await Promise.resolve();
    requestController.abort();
    releaseSummarizer();
    await pending;

    expect(output.status()).toBe(499);
    expect(output.json()).toMatchObject({ status: "cancelled" });
    expect(state.openProject).not.toHaveBeenCalled();
    expect(coordinator.snapshot(invocationId)).toMatchObject({ state: "cancelled", activeCount: 0 });
    await coordinator.shutdown();
  });

  it("waits for an opened project to close before releasing queued cancellation", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    const requestController = new AbortController();
    const closeStarted = vi.fn();
    let releaseClose!: () => void;
    const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
    state.projectClose.mockImplementation(async () => {
      closeStarted();
      await closeGate;
    });
    state.queueSerialize = true;
    let releaseFirstCompact!: () => void;
    const firstCompactGate = new Promise<void>(resolve => { releaseFirstCompact = resolve; });
    let compactCalls = 0;
    state.compactInputObserver = async () => {
      compactCalls += 1;
      if (compactCalls === 1) await firstCompactGate;
    };
    const first = response();
    const pending = createCompactHandlerProduction(config())(
      {} as never,
      first.res,
      JSON.stringify({ session_id: "queue-close-first", cwd: "/tmp" }),
      testCompactContext,
    );
    await vi.waitFor(() => expect(compactCalls).toBe(1));
    const secondInvocationId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    coordinator.start({ invocationId: secondInvocationId, command: "compact", daemonInstanceId });
    const duplicate = response();
    const duplicatePending = createCompactHandlerProduction(config())(
      {} as never,
      duplicate.res,
      JSON.stringify({ session_id: "queue-close-second", cwd: "/tmp", invocation_id: secondInvocationId }),
      { ...testCompactContext, signal: requestController.signal, invocationCoordinator: coordinator },
    );
    await vi.waitFor(() => expect(state.openProject).toHaveBeenCalledTimes(2));
    requestController.abort();
    await vi.waitFor(() => expect(closeStarted).toHaveBeenCalled());
    expect(coordinator.snapshot(secondInvocationId).activeCount).toBeGreaterThan(0);
    let duplicateSettled = false;
    void duplicatePending.then(() => { duplicateSettled = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(duplicateSettled).toBe(false);
    releaseClose();
    releaseFirstCompact();
    await Promise.allSettled([pending, duplicatePending]);
    expect(duplicate.status()).toBe(499);
    expect(coordinator.snapshot(secondInvocationId)).toMatchObject({ state: "cancelled", activeCount: 0 });
    await coordinator.shutdown();
  });

  it("classifies cancellation and detaches duplicate PostgreSQL listeners", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const value = config();
    value.storage = {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://runtime@example.invalid/lcm",
        poolMax: 1,
        connectionTimeoutMs: 100,
        idleTimeoutMs: 100,
        statementTimeoutMs: 100,
      },
    };
    state.paths.mockImplementation((cwd: string) => ({
      id: "pid",
      dir: "/tmp/project",
      dbPath: "/tmp/project/lcm.db",
      metaPath: "/tmp/project/meta.json",
      canonical: cwd,
      remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
    }));
    let releaseFirstCompact!: () => void;
    const firstCompactGate = new Promise<void>(resolve => { releaseFirstCompact = resolve; });
    const firstCompactStarted = new Promise<void>(resolve => {
      state.compactInputObserver = async () => {
        resolve();
        await firstCompactGate;
      };
    });
    const requestController = new AbortController();
    state.openProject.mockImplementation(() => {
      if (state.openProject.mock.calls.length === 2) requestController.abort();
    });
    const addListener = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const removeListener = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    let firstPending: Promise<unknown> | undefined;
    let duplicatePending: Promise<unknown> | undefined;

    try {
      const handler = createCompactHandlerProduction(value);
      const first = response();
      firstPending = handler(
        {} as never,
        first.res,
        JSON.stringify({ session_id: "postgres-duplicate-cancel", cwd: "/tmp" }),
        testCompactContext,
      );
      await firstCompactStarted;

      const duplicate = response();
      duplicatePending = handler(
        {} as never,
        duplicate.res,
        JSON.stringify({
          session_id: "postgres-duplicate-cancel",
          cwd: "/tmp",
          invocation_id: invocationId,
        }),
        {
          ...testCompactContext,
          signal: requestController.signal,
          invocationCoordinator: coordinator,
        },
      );
      await duplicatePending;

      const projectListener = addListener.mock.calls.at(-1)?.[1];
      expect(projectListener).toBeDefined();
      expect(duplicate.status()).toBe(499);
      expect(duplicate.json()).toMatchObject({ status: "cancelled" });
      expect(state.projectClose).toHaveBeenCalledOnce();
      expect(removeListener.mock.calls.some(([, listener]) => listener === projectListener)).toBe(true);
      expect(coordinator.snapshot(invocationId)).toMatchObject({ state: "cancelled", activeCount: 0 });
    } finally {
      releaseFirstCompact();
      await Promise.allSettled([firstPending, duplicatePending].filter(
        (pending): pending is Promise<unknown> => pending !== undefined,
      ));
      await coordinator.shutdown();
      addListener.mockRestore();
      removeListener.mockRestore();
    }
  });

  it("awaits targeted cancellation when a duplicate invocation is skipped", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "12121212-1212-4121-8121-121212121212";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const actualCancel = coordinator.cancel.bind(coordinator);
    let releaseFirstCompact!: () => void;
    const firstCompactGate = new Promise<void>(resolve => { releaseFirstCompact = resolve; });
    const firstCompactStarted = new Promise<void>(resolve => {
      state.compactInputObserver = async () => {
        resolve();
        await firstCompactGate;
      };
    });
    let releaseCancellation!: () => void;
    const cancellationGate = new Promise<ReturnType<typeof coordinator.snapshot>>(resolve => {
      releaseCancellation = () => resolve({
          invocationId,
          command: "compact",
          daemonInstanceId,
          state: "cancelled",
          activeCount: 0,
          workCount: 0,
          commitCount: 0,
          leaseExpiresAt: null,
        });
    });
    const cancel = vi.spyOn(coordinator, "cancel").mockImplementation(async () => await cancellationGate);
    const handler = createCompactHandlerProduction(config());
    const first = response();
    const firstPending = handler(
      {} as never,
      first.res,
      JSON.stringify({ session_id: "duplicate-await", cwd: "/tmp" }),
      testCompactContext,
    );
    await firstCompactStarted;

    const duplicate = response();
    const duplicatePending = handler(
      {} as never,
      duplicate.res,
      JSON.stringify({ session_id: "duplicate-await", cwd: "/tmp", invocation_id: invocationId }),
      { ...testCompactContext, invocationCoordinator: coordinator },
    );

    let duplicateSettled = false;
    void duplicatePending.then(() => { duplicateSettled = true; });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith({ invocationId, command: "compact", daemonInstanceId }));
    expect(cancel).toHaveBeenCalledWith({ invocationId, command: "compact", daemonInstanceId });
    expect(duplicateSettled).toBe(false);
    releaseCancellation();
    await expect(duplicatePending).resolves.toBeUndefined();
    expect(duplicate.json()).toMatchObject({ skipped: true, actionTaken: false });

    releaseFirstCompact();
    await firstPending;
    cancel.mockRestore();
    await actualCancel({ invocationId, command: "compact", daemonInstanceId });
    await coordinator.shutdown();
  });

  it("finishes a pre-latched metadata commit but rejects later writes", async () => {
    const invocationId = "55555555-5555-4555-8555-555555555555";
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const base = createInvocationCoordinator({ daemonInstanceId });
    base.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    let abortOnCommit = true;
    const coordinator = {
      ...base,
      acquireCommit: (target: Parameters<typeof base.acquireCommit>[0]) => {
        const permit = base.acquireCommit(target);
        if (abortOnCommit) {
          abortOnCommit = false;
          requestController.abort();
        }
        return permit;
      },
    } as unknown as InvocationCoordinator;
    const output = response();

    await createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "metadata-latch", cwd: "/tmp", invocation_id: invocationId }),
      {
        ...testCompactContext,
        signal: requestController.signal,
        invocationCoordinator: coordinator,
      },
    );

    expect(output.status()).toBe(499);
    expect(state.writeFileSync).toHaveBeenCalledOnce();
    expect(justCompactedMap.has("metadata-latch")).toBe(false);
    expect(base.snapshot(invocationId)).toMatchObject({ state: "cancelled", activeCount: 0 });
    await base.shutdown();
  });

  it("returns a bounded response when commit admission reports cancellation", async () => {
    const invocationId = "66666666-6666-4666-8666-666666666666";
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const base = createInvocationCoordinator({ daemonInstanceId });
    base.start({ invocationId, command: "compact", daemonInstanceId });
    const coordinator = {
      ...base,
      acquireCommit: () => {
        throw new InvocationCoordinatorError("cancelled", "invocation is cancelling", 409);
      },
    } as unknown as InvocationCoordinator;
    const output = response();

    await createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "commit-cancel-error", cwd: "/tmp", invocation_id: invocationId }),
      { ...testCompactContext, invocationCoordinator: coordinator },
    );

    expect(output.status()).toBe(409);
    expect(output.json()).toEqual({ error: "invocation admission failed" });
    expect(justCompactedMap.has("commit-cancel-error")).toBe(false);
    await base.shutdown();
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

  it("authenticates selected PostgreSQL storage when summarization is disabled", async () => {
    const value = config();
    value.storage = {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://runtime@example.invalid/lcm",
        poolMax: 1,
        connectionTimeoutMs: 100,
        idleTimeoutMs: 100,
        statementTimeoutMs: 100,
      },
    };
    state.summarizer = undefined;

    const body = await call(JSON.stringify({ session_id: "disabled-postgresql", cwd: "/tmp" }), value);

    expect(body).toMatchObject({
      actionTaken: false,
      summary: "Summarization disabled — no summarizer configured.",
    });
    expect(state.openProject).toHaveBeenCalledOnce();
    expect(state.projectClose).toHaveBeenCalledOnce();
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
      makeStagedPostgreSqlStorageFactory(),
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

  it("sanitizes a publication failure during metadata persistence after compaction", async () => {
    const privateDetail = "private meta persistence details";
    const compactCompleted = vi.fn();
    state.compactionStorageProbe = async () => {
      compactCompleted();
    };
    state.metaError = new BackendPublicationJournalError("unexpected-state", privateDetail);
    const output = response();

    await createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "meta-publication-failure", cwd: "/tmp" }),
      testCompactContext,
    );

    expect(compactCompleted).toHaveBeenCalledOnce();
    expect(output.json()).toEqual({
      status: "blocked",
      error: "backend publication admission blocked",
    });
    expect(JSON.stringify(output.json())).not.toContain(privateDetail);
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

  it("passes scalar repository properties through admitted compaction storage", async () => {
    state.compactionStorageProbe = async storage => {
      expect(storage.largeFiles.scalar).toBe("large-files-scalar");
    };
    const output = response();

    await createCompactHandlerProduction(config())(
      {} as never,
      output.res,
      JSON.stringify({ session_id: "compaction-storage-scalar", cwd: "/tmp" }),
      testCompactContext,
    );

    expect(output.json()).toMatchObject({ actionTaken: false });
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
