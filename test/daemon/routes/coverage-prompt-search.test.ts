import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import type { SearchResult } from "../../../src/db/promoted.js";
import type { RecallFeedback } from "../../../src/db/recall.js";
import type { DaemonConfig } from "../../../src/daemon/config.js";
import type { ProjectStorage, StorageBackendFactory } from "../../../src/storage/index.js";
import { StorageOperationError } from "../../../src/storage/errors.js";
import { makeMockStorageFactory } from "./mock-storage-factory.js";

const state = vi.hoisted(() => ({
  exists: true,
  validateError: undefined as unknown,
  migrationError: undefined as unknown,
  connectionError: undefined as unknown,
  searchResults: [] as SearchResult[],
  feedback: new Map<string, RecallFeedback>(),
  logError: undefined as unknown,
  closed: [] as string[],
  factoryClosed: 0,
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => state.exists,
}));

vi.mock("../../../src/daemon/validate-cwd.js", () => ({
  validateCwd: (cwd: string) => {
    if (state.validateError !== undefined) throw state.validateError;
    return cwd;
  },
}));

vi.mock("../../../src/daemon/project.js", () => ({
  projectDbPath: (cwd: string) => `${cwd}/memory.db`,
  projectIdentity: (cwd: string) => ({ id: cwd, canonical: cwd }),
}));

vi.mock("../../../src/storage/index.js", () => ({
  createStorageBackendFactory: async () => {
    const openProject = async () => {
      if (state.connectionError !== undefined) throw state.connectionError;
      return {
        lexicalSearch: {
          searchPromoted: async () => {
            if (state.migrationError !== undefined) throw state.migrationError;
            return state.searchResults;
          },
        },
        recall: {
          getFeedback: async () => state.feedback,
          logSurfacing: async () => {
            if (state.logError !== undefined) throw state.logError;
          },
        },
        close: async () => { state.closed.push("project"); },
      };
    };
    return {
      projectExists: async () => state.exists,
      openExistingProject: async () => state.exists ? openProject() : null,
      openProject,
      close: async () => { state.factoryClosed += 1; },
    };
  },
}));

import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { createPromptSearchHandler } from "../../../src/daemon/routes/prompt-search.js";

type DebugCandidate = {
  id: string;
  baseScore: number;
  finalScore: number;
  usageBoost: number;
  stalePenalty: number;
  cooledDown: boolean;
  surfaced: boolean;
};

type PromptSearchDebugBody = {
  hints: string[];
  ids: string[];
  debug: { candidates: DebugCandidate[] };
};

type PromptSearchResponse = {
  hints: string[];
  ids?: string[];
  debug?: PromptSearchDebugBody["debug"];
};

type MockResponse = {
  res: ServerResponse;
  json: () => PromptSearchResponse;
  status: () => number;
};

function response(): MockResponse {
  let payload = "";
  let statusCode = 200;
  return {
    res: {
      writeHead: vi.fn((status: number) => {
        statusCode = status;
        return undefined;
      }),
      end: vi.fn((body?: string) => { payload = body ?? ""; }),
    } as unknown as ServerResponse,
    json: () => JSON.parse(payload || "{}") as PromptSearchResponse,
    status: () => statusCode,
  };
}

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  const id = overrides.id ?? "memory-1";
  return {
    id,
    content: `remember unique implementation decision ${id}`,
    tags: [],
    projectId: "project",
    sessionId: "session",
    confidence: 0.5,
    createdAt: new Date().toISOString(),
    rank: -10,
    ...overrides,
  };
}

function config(): DaemonConfig {
  const value = loadDaemonConfig("/does-not-exist");
  value.restoration.promptSearchMinScore = -100;
  value.restoration.maxInjectedMemoryBytes = 10_000;
  value.restoration.reservedForLearningInstruction = 0;
  value.restoration.maxInjectedMemoryItems = 20;
  return value;
}

async function call(
  body: string,
  mutate?: (value: DaemonConfig) => void,
  factory?: Parameters<typeof createPromptSearchHandler>[1],
): Promise<PromptSearchResponse> {
  const value = config();
  mutate?.(value);
  const output = response();
  await createPromptSearchHandler(value, factory)({} as never, output.res, body);
  return output.json();
}

describe("prompt-search route coverage", () => {
  beforeEach(() => {
    state.exists = true;
    state.validateError = undefined;
    state.migrationError = undefined;
    state.connectionError = undefined;
    state.searchResults = [];
    state.feedback = new Map();
    state.logError = undefined;
    state.closed = [];
    state.factoryClosed = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["", "null", JSON.stringify({ query: 1, cwd: "/tmp" }), JSON.stringify({ query: "q", cwd: 1 })])(
    "treats invalid request %j as no suggestions",
    async (body) => expect(await call(body)).toEqual({ hints: [] }),
  );

  it("normalizes a non-numeric learning instruction size", async () => {
    expect(await call(JSON.stringify({ query: "q", cwd: "/tmp", learningInstructionBytes: "bad" })))
      .toEqual({ hints: [], ids: [] });
  });

  it.each([
    { query: "", cwd: "/tmp" },
    { query: "q", cwd: "" },
  ])("defensively rejects empty query/cwd", async (body) => {
    expect(await call(JSON.stringify(body))).toEqual({ hints: [] });
  });

  it("returns no suggestions for an invalid cwd", async () => {
    state.validateError = "bad cwd";
    expect(await call(JSON.stringify({ query: "q", cwd: "/tmp" }))).toEqual({ hints: [] });
  });

  it("honors the disabled prompt-search limit before opening storage", async () => {
    expect(await call(
      JSON.stringify({ query: "q", cwd: "/tmp" }),
      (value) => { value.restoration.promptSearchMaxResults = 0; },
    )).toEqual({ hints: [], ids: [] });
    expect(state.closed).toEqual([]);
  });

  it("admits PostgreSQL storage before returning a disabled empty result", async () => {
    const projectClose = vi.fn(async () => undefined);
    const project = {
      lexicalSearch: { searchPromoted: vi.fn(async () => []) },
      recall: {
        getFeedback: vi.fn(async () => new Map()),
        logSurfacing: vi.fn(async () => undefined),
      },
      close: projectClose,
    };
    const factory = makeMockStorageFactory({
      projectExists: vi.fn(async () => true),
      openProject: vi.fn(async () => project as unknown as ProjectStorage),
    });

    expect(await call(
      JSON.stringify({ query: "q", cwd: "/tmp" }),
      (value) => {
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
        value.restoration.promptSearchMaxResults = 0;
      },
      factory,
    )).toEqual({ hints: [], ids: [] });
    expect(projectClose).toHaveBeenCalledOnce();
  });

  it("returns no suggestions without opening a missing database", async () => {
    state.exists = false;
    expect(await call(JSON.stringify({ query: "q", cwd: "/tmp" }))).toEqual({ hints: [] });
    expect(state.closed).toEqual([]);
  });

  it("keeps the disabled PostgreSQL response shape when the project is absent", async () => {
    state.exists = false;
    expect(await call(
      JSON.stringify({ query: "q", cwd: "/tmp" }),
      (value) => {
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
        value.restoration.promptSearchMaxResults = 0;
      },
    )).toEqual({ hints: [], ids: [] });
  });

  it("closes an opened database after an internal failure", async () => {
    state.migrationError = new Error("migration failed");
    expect(await call(JSON.stringify({ query: "q", cwd: "/tmp" }))).toEqual({ hints: [] });
    expect(state.closed).toEqual(["project"]);
    expect(state.factoryClosed).toBe(1);
  });

  it("returns a cause-free 503 for PostgreSQL lexical-search failure", async () => {
    const failure = new StorageOperationError(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      "/tmp",
      "lexical-search",
      "search-promoted",
    );
    const projectClose = vi.fn(async () => undefined);
    const factory = makeMockStorageFactory({
      projectExists: vi.fn(async () => true),
      openProject: vi.fn(async () => ({
        lexicalSearch: { searchPromoted: vi.fn().mockRejectedValue(failure) },
        recall: { getFeedback: vi.fn(async () => new Map()), logSurfacing: vi.fn(async () => undefined) },
        close: projectClose,
      } as unknown as ProjectStorage)),
    });
    const postgres = config();
    postgres.storage = {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://user:secret@db.example/lcm",
        poolMax: 5,
        connectionTimeoutMs: 10_000,
        idleTimeoutMs: 30_000,
        statementTimeoutMs: 60_000,
      },
    };
    const output = response();
    await createPromptSearchHandler(postgres, { ...factory, backend: "postgresql" })(
      {} as never,
      output.res,
      JSON.stringify({ query: "q", cwd: "/tmp" }),
    );
    expect(output.status()).toBe(503);
    expect(output.json()).toEqual(failure.toJSON());
    expect(projectClose).toHaveBeenCalledOnce();
  });

  it("does not close a database when opening it fails", async () => {
    state.connectionError = new Error("open failed");
    expect(await call(JSON.stringify({ query: "q", cwd: "/tmp" }))).toEqual({ hints: [] });
    expect(state.closed).toEqual([]);
    expect(state.factoryClosed).toBe(1);
  });

  it("keeps an injected process-lifetime factory open", async () => {
    const close = vi.fn(async () => undefined);
    const projectClose = vi.fn(async () => undefined);
    const project = {
      lexicalSearch: { searchPromoted: vi.fn(async () => []) },
      recall: { getFeedback: vi.fn(async () => new Map()), logSurfacing: vi.fn(async () => undefined) },
      close: projectClose,
    };
    const factory: StorageBackendFactory = makeMockStorageFactory({
      projectExists: vi.fn(async () => true),
      openProject: vi.fn(async () => project as unknown as ProjectStorage),
      close,
    });
    expect(await call(JSON.stringify({ query: "q", cwd: "/tmp" }), undefined, factory))
      .toEqual({ hints: [], ids: [] });
    expect(projectClose).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it("ranks ties through every comparator and scoring boundary", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(now);
    const defensiveUsageCount = {
      [Symbol.toPrimitive]: (hint: string) => hint === "number" ? 1 : -1,
      toJSON: () => 1,
    } as unknown as number;
    state.searchResults = [
      result({ id: "base-high", rank: -2, confidence: 1, createdAt: now.toISOString() }),
      result({ id: "boosted-base-low", rank: -1, confidence: 1, createdAt: now.toISOString() }),
      result({ id: "confidence-low", rank: -3, confidence: 0.1, createdAt: now.toISOString() }),
      result({ id: "confidence-high", rank: -3, confidence: 0.9, createdAt: now.toISOString() }),
      result({ id: "created-z", rank: -4, createdAt: "z-invalid" }),
      result({ id: "created-a", rank: -4, createdAt: "a-invalid" }),
      result({ id: "invalid-surfaced", rank: -5, createdAt: now.toISOString() }),
      result({ id: "defensive-denominator", rank: -6, createdAt: now.toISOString() }),
    ];
    state.feedback.set("boosted-base-low", { usageCount: 1, surfacingCount: 0, lastSurfacedAt: null });
    state.feedback.set("invalid-surfaced", { usageCount: 0, surfacingCount: 0, lastSurfacedAt: "invalid" });
    // A malformed persistence value with deterministic numeric coercion proves
    // the defensive denominator fallback without modifying process-wide math.
    state.feedback.set("defensive-denominator", { usageCount: defensiveUsageCount, surfacingCount: 0, lastSurfacedAt: null });

    const body = await call(
      JSON.stringify({ query: "q", cwd: "/tmp", session_id: "session", debug: true, logSurfacing: false }),
      (value) => {
        value.restoration.recallUsageBoost = 1;
        value.restoration.recallUsageSmoothing = 0;
      },
    );
    expect(body.debug).toBeDefined();
    const debugBody = body as PromptSearchDebugBody;
    expect(debugBody.ids).toEqual([
      "defensive-denominator",
      "invalid-surfaced",
      "created-a",
    ]);
    expect(debugBody.debug.candidates.map(({ id, baseScore, finalScore, usageBoost }) => ({ id, baseScore, finalScore, usageBoost })))
      .toEqual([
        { id: "defensive-denominator", baseScore: 6, finalScore: 6, usageBoost: 1 },
        { id: "invalid-surfaced", baseScore: 5, finalScore: 5, usageBoost: 1 },
        { id: "created-a", baseScore: 4, finalScore: 4, usageBoost: 1 },
        { id: "created-z", baseScore: 4, finalScore: 4, usageBoost: 1 },
        { id: "confidence-high", baseScore: 3, finalScore: 3, usageBoost: 1 },
        { id: "confidence-low", baseScore: 3, finalScore: 3, usageBoost: 1 },
        { id: "base-high", baseScore: 2, finalScore: 2, usageBoost: 1 },
        { id: "boosted-base-low", baseScore: 1, finalScore: 2, usageBoost: 2 },
      ]);
  });

  it("applies cross-session affinity to a memory from another session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    state.searchResults = [result({ id: "other", sessionId: "other-session", rank: -2 })];
    const body = await call(
      JSON.stringify({ query: "q", cwd: "/tmp", session_id: "current", debug: true }),
      (value) => { value.restoration.crossSessionAffinity = 0.7; },
    );
    expect(body.debug?.candidates[0]?.baseScore).toBe(1.4);
  });

  it("truncates a memory hint longer than the configured snippet", async () => {
    state.searchResults = [result({ content: "abcdefgh" })];
    expect(await call(
      JSON.stringify({ query: "q", cwd: "/tmp" }),
      (value) => { value.restoration.promptSnippetLength = 4; },
    )).toMatchObject({ hints: ["abcd..."] });
  });

  it("keeps a best cooled result and tolerates surfacing-log failures", async () => {
    state.searchResults = [result()];
    state.feedback.set("memory-1", {
      usageCount: 0,
      surfacingCount: 1,
      lastSurfacedAt: new Date().toISOString(),
    });
    state.logError = new Error("read-only database");
    const body = await call(JSON.stringify({ query: "q", cwd: "/tmp" }));
    expect(body).toEqual({
      hints: ["remember unique implementation decision memory-1"],
      ids: ["memory-1"],
    });
  });

  it("filters cooled results against the best non-cooled score", async () => {
    state.searchResults = [
      result({ id: "fresh", rank: -10 }),
      result({ id: "cooled-weak", rank: -1 }),
      result({ id: "cooled-strong", rank: -20 }),
    ];
    const cooled: RecallFeedback = { usageCount: 0, surfacingCount: 1, lastSurfacedAt: new Date().toISOString() };
    state.feedback.set("cooled-weak", cooled);
    state.feedback.set("cooled-strong", cooled);
    const body = await call(JSON.stringify({ query: "q", cwd: "/tmp" }));
    expect(body).toEqual({
      hints: [
        "remember unique implementation decision cooled-strong",
        "remember unique implementation decision fresh",
      ],
      ids: ["cooled-strong", "fresh"],
    });
  });

  it("applies staleness suppression and exposes exact debug scores", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    state.searchResults = [
      result({ id: "fresh", rank: -2, createdAt: "2026-01-01T00:00:00.000Z" }),
      result({ id: "stale", rank: -4, createdAt: "2025-01-01T00:00:00.000Z" }),
    ];
    const body = await call(
      JSON.stringify({ query: "q", cwd: "/tmp", debug: true }),
      (value) => {
        value.restoration.staleAfterDays = 30;
        value.restoration.staleSurfacingWithoutUseLimit = 0;
        value.restoration.stalePenalty = 0.5;
        value.restoration.allowStaleOnStrongMatch = false;
      },
    );
    expect(body.debug).toBeDefined();
    const debugBody = body as PromptSearchDebugBody;
    expect(debugBody.ids).toEqual(["fresh", "stale"]);
    expect(debugBody.debug.candidates.map(({ id, finalScore, stalePenalty, surfaced }) => ({ id, finalScore, stalePenalty, surfaced })))
      .toEqual([
        { id: "fresh", finalScore: 2, stalePenalty: 0, surfaced: true },
        { id: "stale", finalScore: -0.5, stalePenalty: 0.5, surfaced: true },
      ]);
  });

  it("breaks equal final scores by base score", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const createdAt = "2025-12-31T23:59:59.000Z";
    state.searchResults = [
      result({ id: "base-one", rank: -1, createdAt }),
      result({ id: "base-two", rank: -2, createdAt }),
    ];
    const body = await call(
      JSON.stringify({ query: "q", cwd: "/tmp", debug: true }),
      (value) => {
        value.restoration.staleAfterDays = 0;
        value.restoration.staleSurfacingWithoutUseLimit = 0;
        value.restoration.allowStaleOnStrongMatch = false;
      },
    );
    expect(body.debug).toBeDefined();
    const debugBody = body as PromptSearchDebugBody;
    expect(debugBody.ids).toEqual(["base-two", "base-one"]);
    expect(debugBody.debug.candidates.map(({ id, finalScore, baseScore }) => ({ id, finalScore, baseScore })))
      .toEqual([
        { id: "base-two", finalScore: 0, baseScore: expect.closeTo(1.999_983_955, 8) },
        { id: "base-one", finalScore: 0, baseScore: expect.closeTo(0.999_991_977, 8) },
      ]);
  });
});
