import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createDaemon,
  type DaemonInstance,
  type RouteExecutionContext,
  type RouteHandler,
  type RoutePublicationAdmission,
} from "../../../src/daemon/server.js";
import { ensureAuthToken, readAuthToken } from "../../../src/daemon/auth.js";
import { loadDaemonConfig, parseDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath, projectId, projectIdentity } from "../../../src/daemon/project.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";
import {
  SqliteStorageBackendFactory,
  StorageOperationError,
  type ProjectStorage,
  type StorageBackendFactory,
} from "../../../src/storage/index.js";
import { createInvocationCoordinator } from "../../../src/daemon/invocation-coordinator.js";
import {
  assertBackendPublicationConsumerAccess,
  BackendPublicationJournalError,
  withBackendPublicationConsumerLockAsync,
} from "../../../src/storage/backend-publication.js";
import type { BackendPublicationLockToken } from "../../../src/storage/backend-publication.js";

// --- Summarizer branching unit tests ---

vi.mock("../../../src/llm/anthropic.js", () => ({
  createAnthropicSummarizer: vi.fn().mockReturnValue(async () => "anthropic-summary"),
}));

vi.mock("../../../src/llm/openai.js", () => ({
  createOpenAISummarizer: vi.fn().mockReturnValue(async () => "openai-summary"),
}));

vi.mock("../../../src/llm/claude-process.js", () => ({
  createClaudeProcessSummarizer: vi.fn().mockReturnValue(async () => "claude-process-summary"),
}));

vi.mock("../../../src/llm/codex-process.js", () => ({
  createCodexProcessSummarizer: vi.fn().mockReturnValue(async () => "codex-process-summary"),
}));

import { createClaudeProcessSummarizer } from "../../../src/llm/claude-process.js";
import { createCodexProcessSummarizer } from "../../../src/llm/codex-process.js";
import { createAnthropicSummarizer } from "../../../src/llm/anthropic.js";
import { createOpenAISummarizer } from "../../../src/llm/openai.js";
import { createCompactHandler as createCompactHandlerProduction, buildCompactionMessage } from "../../../src/daemon/routes/compact.js";
import type { DaemonConfig } from "../../../src/daemon/config.js";

function mockRes() {
  let body = "";
  const res = {
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn((data?: string) => { body = data ?? ""; }),
  } as any;
  return { res, getBody: () => JSON.parse(body || "{}") };
}

function mockReq(): IncomingMessage {
  return new IncomingMessage(new Socket());
}

function makeConfig(provider: DaemonConfig["llm"]["provider"]): DaemonConfig {
  return {
    version: 1,
    storage: { backend: "sqlite" },
    daemon: { port: 3737, socketPath: "/tmp/test.sock", logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7, idleTimeoutMs: 1800000 },
    compaction: {
      leafTokens: 1000, maxDepth: 5, autoCompactMinTokens: 10000,
      promotionThresholds: { minDepth: 2, compressionRatio: 0.3, keywords: {}, architecturePatterns: [], dedupBm25Threshold: 15, dedupCandidateLimit: 3 },
    },
    restoration: { recentSummaries: 3, promptSearchMinScore: 10, promptSearchMaxResults: 3, promptSnippetLength: 200, recencyHalfLifeHours: 24, crossSessionAffinity: 0.5 },
    llm: {
      provider,
      model: "test-model",
      apiKey: "sk-test",
      baseUrl: "http://localhost:11435/v1",
      requestTimeoutMs: 600_000,
      retry: { maxAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 30_000, multiplier: 2 },
    },
    claudeCliProxy: { enabled: true, port: 3456, startupTimeoutMs: 10000, model: "claude-haiku-4-5" },
    cipher: { configPath: "/tmp/cipher.yml", collection: "test" },
    security: { sensitivePatterns: [] },
    summarizer: { mock: false },
  } as unknown as DaemonConfig;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

// Intentional test admission seam: each direct handler invocation acquires a
// real publication lock and supplies its live token through route context.
const testPublicationAdmission: RoutePublicationAdmission = operation =>
  withBackendPublicationConsumerLockAsync(undefined, operation, { allowUnresolved: true });
const testCompactContext: RouteExecutionContext = {
  withPublicationAdmission: testPublicationAdmission,
};
const FULL_SUITE_DAEMON_TEST_TIMEOUT_MS = 15_000;

function createCompactHandler(
  config: DaemonConfig,
  storageFactory?: StorageBackendFactory,
): RouteHandler {
  const handler = createCompactHandlerProduction(config, storageFactory);
  return (req, res, body, context = testCompactContext) => handler(req, res, body, context);
}

async function readMessageCount(cwd: string, sessionId: string): Promise<number> {
  const db = new DatabaseSync(projectDbPath(cwd));

  try {
    const conversationStore = new ConversationStore(db);
    const conversation = await conversationStore.getOrCreateConversation(sessionId);
    return conversationStore.getMessageCount(conversation.conversationId);
  } finally {
    db.close();
  }
}

async function readMessageContents(cwd: string, sessionId: string): Promise<string[]> {
  const db = new DatabaseSync(projectDbPath(cwd));

  try {
    const conversationStore = new ConversationStore(db);
    const conversation = await conversationStore.getOrCreateConversation(sessionId);
    const messages = await conversationStore.getMessages(conversation.conversationId);
    return messages.map((m) => m.content);
  } finally {
    db.close();
  }
}

function readSummaryCount(cwd: string): number {
  const db = new DatabaseSync(projectDbPath(cwd));
  try {
    return Number((db.prepare("SELECT COUNT(*) AS count FROM summaries").get() as { count: number }).count);
  } finally {
    db.close();
  }
}

describe("buildCompactionMessage", () => {
  const base = {
    tokensBefore: 10_000, tokensAfter: 1_000,
    messageCount: 50, summaryCount: 3,
    maxDepth: 2, promotedCount: 0,
  };

  it("contains the header and closing motto", () => {
    const msg = buildCompactionMessage(base);
    expect(msg).toContain("lcm · compaction complete");
    expect(msg).toContain("Nothing was lost. Everything is remembered.");
  });

  it("calculates correct compression percentage (90% for 10x)", () => {
    const msg = buildCompactionMessage(base);
    expect(msg).toContain("90.0% saved");
  });

  it("shows message and summary counts", () => {
    const msg = buildCompactionMessage(base);
    expect(msg).toContain("messages  →  3 summaries");
    expect(msg).toContain("DAG layers deep");
  });

  it("shows promoted insight (singular) when promotedCount is 1", () => {
    const msg = buildCompactionMessage({ ...base, promotedCount: 1 });
    expect(msg).toContain("insight promoted to long-term memory");
    expect(msg).not.toContain("insights promoted");
  });

  it("shows promoted insights (plural) when promotedCount > 1", () => {
    const msg = buildCompactionMessage({ ...base, promotedCount: 3 });
    expect(msg).toContain("insights promoted to long-term memory");
  });

  it("omits promoted row when promotedCount is 0", () => {
    const msg = buildCompactionMessage({ ...base, promotedCount: 0 });
    expect(msg).not.toContain("promoted");
  });

  it("shows dash for ratio when tokensAfter is 0", () => {
    const msg = buildCompactionMessage({ ...base, tokensAfter: 0 });
    expect(msg).toContain("–");
  });

  it("bar is fully filled when all tokens are saved", () => {
    // tokensBefore > 0, tokensAfter = 0 → filled = 30, empty = 0
    const msg = buildCompactionMessage({ ...base, tokensAfter: 0 });
    expect(msg).toContain("█".repeat(30));
    expect(msg).not.toContain("░");
  });

  it("bar is fully empty when nothing is saved", () => {
    // tokensBefore === tokensAfter → saved = 0
    const msg = buildCompactionMessage({ ...base, tokensBefore: 1000, tokensAfter: 1000 });
    expect(msg).toContain("░".repeat(30));
    expect(msg).not.toContain("█");
  });

  it("formats token counts with K suffix for large numbers", () => {
    const msg = buildCompactionMessage({ ...base, tokensBefore: 50_000, tokensAfter: 5_000 });
    expect(msg).toContain("50.0K");
    expect(msg).toContain("5.0K");
  });

  it("border is 46 ━ characters wide", () => {
    const msg = buildCompactionMessage(base);
    expect(msg).toContain("━".repeat(46));
  });
});

describe("createCompactHandler — summarizer branching", () => {
  // Use tmpdir() which always exists; these tests mock all summarizers and don't need unique project dirs
  const testCwd = tmpdir();

  it("returns 400 for a malformed JSON body", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("openai"));
    const req = new IncomingMessage(new Socket());
    const { res, getBody } = mockRes();

    await handler(req, res, '{"session_id":');

    expect(res.writeHead).toHaveBeenCalledWith(400, { "Content-Type": "application/json" });
    expect(getBody()).toEqual({ error: "Invalid JSON body" });
    expect(createOpenAISummarizer).not.toHaveBeenCalled();
  });

  it.each(["null", "[]", "42", "true", '"string"'])(
    "returns 400 when the JSON body is not an object: %s",
    async (body) => {
      vi.clearAllMocks();
      const handler = createCompactHandler(makeConfig("openai"));
      const req = new IncomingMessage(new Socket());
      const { res, getBody } = mockRes();

      await handler(req, res, body);

      expect(res.writeHead).toHaveBeenCalledWith(400, { "Content-Type": "application/json" });
      expect(getBody()).toEqual({ error: "Invalid JSON body" });
      expect(createOpenAISummarizer).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ cwd: testCwd }, "session_id must be a non-empty string"],
    [{ session_id: 42, cwd: testCwd }, "session_id must be a non-empty string"],
    [{ session_id: "", cwd: testCwd }, "session_id must be a non-empty string"],
    [{ session_id: "s1" }, "cwd must be a non-empty string"],
    [{ session_id: "s1", cwd: false }, "cwd must be a non-empty string"],
    [{ session_id: "s1", cwd: testCwd, transcript_path: 42 }, "transcript_path must be a string"],
    [{ session_id: "s1", cwd: testCwd, skip_ingest: "false" }, "skip_ingest must be a boolean"],
    [{ session_id: "s1", cwd: testCwd, client: "other" }, "client must be one of: claude, codex"],
    [{ session_id: "s1", cwd: testCwd, previous_summary: {} }, "previous_summary must be a string"],
    [{ session_id: "s1", cwd: testCwd, reasoning_effort: true }, "reasoning_effort must be a string"],
  ])("rejects invalid compact request fields: %j", async (request, error) => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("openai"));
    const { res, getBody } = mockRes();

    await handler({} as any, res, JSON.stringify(request));

    expect(res.writeHead).toHaveBeenCalledWith(400, { "Content-Type": "application/json" });
    expect(getBody()).toEqual({ error });
    expect(createOpenAISummarizer).not.toHaveBeenCalled();
  });

  it("uses createClaudeProcessSummarizer when provider is claude-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("claude-process"));
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd }));
    expect(createClaudeProcessSummarizer).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }));
    expect(createCodexProcessSummarizer).not.toHaveBeenCalled();
  });

  it("uses createCodexProcessSummarizer when provider is codex-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("codex-process"));
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd }));
    expect(createCodexProcessSummarizer).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }));
    expect(createClaudeProcessSummarizer).not.toHaveBeenCalled();
  });

  it("uses createAnthropicSummarizer when provider is anthropic", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("anthropic"));
    // Trigger the handler to resolve the lazy import
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd }));
    expect(createAnthropicSummarizer).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }));
    expect(createOpenAISummarizer).not.toHaveBeenCalled();
  });

  it("uses createOpenAISummarizer when provider is openai", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("openai"));
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd }));
    expect(createOpenAISummarizer).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        baseUrl: "http://localhost:11435/v1",
        requestTimeoutMs: 600_000,
        retry: { maxAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 30_000, multiplier: 2 },
      })
    );
    expect(createAnthropicSummarizer).not.toHaveBeenCalled();
  });

  it("returns no-op when provider is 'disabled' — no summarizer created", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("disabled"));
    const { res, getBody } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd }));
    expect(createClaudeProcessSummarizer).not.toHaveBeenCalled();
    expect(createCodexProcessSummarizer).not.toHaveBeenCalled();
    expect(createAnthropicSummarizer).not.toHaveBeenCalled();
    expect(createOpenAISummarizer).not.toHaveBeenCalled();
    expect(getBody().summary).toContain("disabled");
    expect(getBody().actionTaken).toBe(false);
  });

  it("auto + client=claude resolves to claude-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("auto"));
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd, client: "claude" }));
    expect(createClaudeProcessSummarizer).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }));
    expect(createCodexProcessSummarizer).not.toHaveBeenCalled();
  });

  it("forwards LCM_SUMMARY_MODEL through auto + Claude resolution", async () => {
    vi.clearAllMocks();
    const config = loadDaemonConfig("/nonexistent/config.json", { llm: { provider: "auto" } }, {
      LCM_SUMMARY_MODEL: "claude-opus-4-1",
    });
    const handler = createCompactHandler(config);
    const { res } = mockRes();

    await handler({} as any, res, JSON.stringify({ session_id: "s1-env-model", cwd: testCwd, client: "claude" }));

    expect(createClaudeProcessSummarizer).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-opus-4-1" }));
  });

  it.each([
    ["claude", createClaudeProcessSummarizer],
    ["codex", createCodexProcessSummarizer],
  ] as const)("does not forward a persisted remote model through auto + %s resolution", async (client, factory) => {
    vi.clearAllMocks();
    const config = parseDaemonConfig(JSON.stringify({
      llm: {
        provider: "openai",
        model: "remote-openai-model",
        baseUrl: "http://localhost:11435/v1",
      },
    }), {}, { LCM_SUMMARY_PROVIDER: "auto" });
    const handler = createCompactHandler(config);
    const { res } = mockRes();

    await handler(
      new IncomingMessage(new Socket()),
      res,
      JSON.stringify({ session_id: `s1-${client}-default-model`, cwd: testCwd, client }),
    );

    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ model: "" }));
  });

  it("auto + client=codex resolves to codex-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("auto"));
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd, client: "codex" }));
    expect(createCodexProcessSummarizer).toHaveBeenCalled();
    expect(createClaudeProcessSummarizer).not.toHaveBeenCalled();
  });

  it("auto + no client falls back to claude-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("auto"));
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd }));
    expect(createClaudeProcessSummarizer).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }));
    expect(createCodexProcessSummarizer).not.toHaveBeenCalled();
  });

  it("explicit provider ignores client override", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("openai"));
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd, client: "codex" }));
    expect(createOpenAISummarizer).toHaveBeenCalled();
    expect(createClaudeProcessSummarizer).not.toHaveBeenCalled();
    expect(createCodexProcessSummarizer).not.toHaveBeenCalled();
  });

  it("memoizes concrete providers across requests", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("auto"));
    const { res: res1 } = mockRes();
    const { res: res2 } = mockRes();

    await handler({} as any, res1, JSON.stringify({ session_id: "s1", cwd: testCwd, client: "codex" }));
    await handler({} as any, res2, JSON.stringify({ session_id: "s2", cwd: testCwd, client: "codex" }));

    expect(createCodexProcessSummarizer).toHaveBeenCalledTimes(1);
  });

  it("passes a request reasoning override to an OpenAI Responses summarizer", async () => {
    vi.clearAllMocks();
    const config = makeConfig("openai");
    config.llm.apiMode = "responses";
    config.llm.reasoningEffort = "medium";
    const handler = createCompactHandler(config);
    const { res, getBody } = mockRes();

    await handler(mockReq(), res, JSON.stringify({
      session_id: "reasoning-high",
      cwd: testCwd,
      reasoning_effort: "high",
    }));

    expect(createOpenAISummarizer).toHaveBeenCalledWith(expect.objectContaining({
      apiMode: "responses",
      reasoningEffort: "high",
    }));
    expect(getBody()).toMatchObject({ apiMode: "responses", reasoningEffort: "high" });
    expect(config.llm.reasoningEffort).toBe("medium");
  });

  it("passes provider-native reasoning and fast-mode overrides to process summarizers", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("claude-process"));
    const { res, getBody } = mockRes();

    await handler(mockReq(), res, JSON.stringify({
      session_id: "reasoning-unsupported",
      cwd: testCwd,
      reasoning_effort: "max",
      fast_mode: true,
    }));

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    expect(createClaudeProcessSummarizer).toHaveBeenCalledWith(expect.objectContaining({
      reasoningEffort: "max",
      fastMode: true,
    }));
    expect(getBody()).toMatchObject({ reasoningEffort: "max", fastMode: true });
  });

  it("rejects unknown reasoning effort values", async () => {
    vi.clearAllMocks();
    const config = makeConfig("openai");
    config.llm.apiMode = "responses";
    const handler = createCompactHandler(config);
    const { res, getBody } = mockRes();

    await handler(mockReq(), res, JSON.stringify({
      session_id: "reasoning-invalid",
      cwd: testCwd,
      reasoning_effort: "extreme",
    }));

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.anything());
    expect(getBody().error).toContain("Valid values: none, minimal, low, medium, high, xhigh");
    expect(createOpenAISummarizer).not.toHaveBeenCalled();
  });

  it.each([
    ["anthropic", undefined, "reasoning_effort is not supported by anthropic"],
    ["openai", "chat-completions", 'reasoning_effort is not supported by openai with apiMode "chat-completions"'],
  ] as const)("reports unsupported reasoning controls for %s without suggesting a value named none", async (
    provider,
    apiMode,
    expectedError,
  ) => {
    vi.clearAllMocks();
    const config = makeConfig(provider);
    config.llm.apiMode = apiMode;
    const handler = createCompactHandler(config);
    const { res, getBody } = mockRes();

    await handler(mockReq(), res, JSON.stringify({
      session_id: `reasoning-unsupported-${provider}`,
      cwd: testCwd,
      reasoning_effort: "high",
    }));

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.anything());
    expect(getBody().error).toBe(expectedError);
    expect(getBody().error).not.toContain("Valid values: none");
    expect(createAnthropicSummarizer).not.toHaveBeenCalled();
    expect(createOpenAISummarizer).not.toHaveBeenCalled();
  });

  it("validates reasoning against the resolved auto provider", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("auto"));
    const { res, getBody } = mockRes();

    await handler(mockReq(), res, JSON.stringify({
      session_id: "reasoning-auto-codex",
      cwd: testCwd,
      client: "codex",
      reasoning_effort: "minimal",
    }));

    expect(createCodexProcessSummarizer).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: "minimal" }));
    expect(getBody()).toMatchObject({ reasoningEffort: "minimal", fastMode: false });
  });

  it("rejects process-only controls for API providers", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("anthropic"));
    const { res, getBody } = mockRes();

    await handler(mockReq(), res, JSON.stringify({
      session_id: "fast-api",
      cwd: testCwd,
      fast_mode: true,
    }));

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.anything());
    expect(getBody().error).toContain("fast_mode requires");
    expect(createAnthropicSummarizer).not.toHaveBeenCalled();
  });

  it("isolates cached process summarizers by fast mode", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("codex-process"));
    const { res: fast } = mockRes();
    const { res: standard } = mockRes();

    await handler(mockReq(), fast, JSON.stringify({ session_id: "fast-cache", cwd: testCwd, fast_mode: true }));
    await handler(mockReq(), standard, JSON.stringify({ session_id: "standard-cache", cwd: testCwd, fast_mode: false }));

    expect(createCodexProcessSummarizer).toHaveBeenCalledTimes(2);
    expect(createCodexProcessSummarizer).toHaveBeenNthCalledWith(1, expect.objectContaining({ fastMode: true }));
    expect(createCodexProcessSummarizer).toHaveBeenNthCalledWith(2, expect.objectContaining({ fastMode: false }));
  });

  it("isolates cached OpenAI summarizers by effective reasoning effort", async () => {
    vi.clearAllMocks();
    const config = makeConfig("openai");
    config.llm.apiMode = "responses";
    const handler = createCompactHandler(config);
    const { res: lowRes } = mockRes();
    const { res: highRes } = mockRes();

    await handler({} as any, lowRes, JSON.stringify({
      session_id: "reasoning-low",
      cwd: testCwd,
      reasoning_effort: "low",
    }));
    await handler({} as any, highRes, JSON.stringify({
      session_id: "reasoning-high-cache",
      cwd: testCwd,
      reasoning_effort: "high",
    }));

    expect(createOpenAISummarizer).toHaveBeenCalledTimes(2);
    expect(createOpenAISummarizer).toHaveBeenNthCalledWith(1, expect.objectContaining({ reasoningEffort: "low" }));
    expect(createOpenAISummarizer).toHaveBeenNthCalledWith(2, expect.objectContaining({ reasoningEffort: "high" }));
  });

  it("validates and applies one-invocation OpenAI timeout and retry overrides", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("openai"));
    const { res, getBody } = mockRes();
    await handler({} as any, res, JSON.stringify({
      session_id: "policy-override",
      cwd: testCwd,
      request_timeout_ms: 45_000,
      retry: { max_attempts: 5, initial_delay_ms: 250, max_delay_ms: 2_000, multiplier: 1.5 },
    }));

    expect(createOpenAISummarizer).toHaveBeenCalledWith(expect.objectContaining({
      requestTimeoutMs: 45_000,
      retry: { maxAttempts: 5, initialDelayMs: 250, maxDelayMs: 2_000, multiplier: 1.5 },
    }));
    expect(getBody()).toMatchObject({
      requestTimeoutMs: 45_000,
      retry: { maxAttempts: 5, initialDelayMs: 250, maxDelayMs: 2_000, multiplier: 1.5 },
    });
  });

  it("applies process timeouts while rejecting invalid or unsupported request policy overrides", async () => {
    vi.clearAllMocks();
    const openaiHandler = createCompactHandler(makeConfig("openai"));
    const { res: invalidRes, getBody: getInvalidBody } = mockRes();
    await openaiHandler({} as any, invalidRes, JSON.stringify({
      session_id: "policy-invalid",
      cwd: testCwd,
      retry: { max_attempts: 0 },
    }));
    expect(invalidRes.writeHead).toHaveBeenCalledWith(400, expect.anything());
    expect(getInvalidBody().error).toContain("maxAttempts");

    const processHandler = createCompactHandler(makeConfig("claude-process"));
    const { res: processRes, getBody: getProcessBody } = mockRes();
    await processHandler({} as any, processRes, JSON.stringify({
      session_id: "policy-process-timeout",
      cwd: testCwd,
      request_timeout_ms: 30_000,
    }));
    expect(processRes.writeHead).toHaveBeenCalledWith(200, expect.anything());
    expect(createClaudeProcessSummarizer).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
    expect(getProcessBody()).toMatchObject({ requestTimeoutMs: 30_000, retry: null });

    const { res: retryRes, getBody: getRetryBody } = mockRes();
    await processHandler({} as any, retryRes, JSON.stringify({
      session_id: "policy-process-retry",
      cwd: testCwd,
      retry: { max_attempts: 2 },
    }));
    expect(retryRes.writeHead).toHaveBeenCalledWith(400, expect.anything());
    expect(getRetryBody().error).toContain('retry requires llm.provider="openai"');

    const anthropicHandler = createCompactHandler(makeConfig("anthropic"));
    const { res: unsupportedRes, getBody: getUnsupportedBody } = mockRes();
    await anthropicHandler({} as any, unsupportedRes, JSON.stringify({
      session_id: "policy-unsupported-timeout",
      cwd: testCwd,
      request_timeout_ms: 30_000,
    }));
    expect(unsupportedRes.writeHead).toHaveBeenCalledWith(400, expect.anything());
    expect(getUnsupportedBody().error).toContain("request_timeout_ms is not supported");
    expect(createOpenAISummarizer).not.toHaveBeenCalled();
    expect(createAnthropicSummarizer).not.toHaveBeenCalled();
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects prototype-sensitive retry key %s without resolving inherited mappings",
    async (key) => {
      vi.clearAllMocks();
      const handler = createCompactHandler(makeConfig("openai"));
      const { res, getBody } = mockRes();
      const retry = JSON.parse(`{${JSON.stringify(key)}:1}`) as Record<string, unknown>;
      await handler({} as any, res, JSON.stringify({
        session_id: `policy-${key}`,
        cwd: testCwd,
        retry,
      }));

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.anything());
      expect(getBody().error).toContain(`retry.${key}`);
      expect(getBody().error).toContain("unknown retry policy key");
      expect(createOpenAISummarizer).not.toHaveBeenCalled();
    },
  );

  it("isolates cached OpenAI summarizers by effective request policy", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("openai"));
    const { res: first } = mockRes();
    const { res: second } = mockRes();
    await handler({} as any, first, JSON.stringify({
      session_id: "policy-cache-one", cwd: testCwd, request_timeout_ms: 10_000,
    }));
    await handler({} as any, second, JSON.stringify({
      session_id: "policy-cache-two", cwd: testCwd, request_timeout_ms: 20_000,
    }));
    expect(createOpenAISummarizer).toHaveBeenCalledTimes(2);
    expect(createOpenAISummarizer).toHaveBeenNthCalledWith(1, expect.objectContaining({ requestTimeoutMs: 10_000 }));
    expect(createOpenAISummarizer).toHaveBeenNthCalledWith(2, expect.objectContaining({ requestTimeoutMs: 20_000 }));
  });
});

describe("POST /compact", () => {
  let daemon: DaemonInstance | undefined;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts compact request and returns summary", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 }, llm: { apiKey: "sk-test" } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "test-sess", cwd: mkdtempSync(join(tmpdir(), "lcm-compact-proj-")), hook_event_name: "PreCompact" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("summary");
    expect(body).toHaveProperty("actionTaken", false);
    expect(typeof body.summary).toBe("string");
  });

  it("does not retain publication admission while the summarizer is pending", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-compact-admission-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const lcmDir = join(tempHome, ".lcm");
    const projectDir = join(tempHome, "project");
    const configPath = join(lcmDir, "config.json");
    const tokenPath = join(tempHome, "daemon.token");
    mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    ensureAuthToken(tokenPath);
    const summarizeStarted = deferred<void>();
    const releaseSummary = deferred<string>();
    vi.mocked(createOpenAISummarizer).mockReturnValueOnce(async () => {
      summarizeStarted.resolve();
      return releaseSummary.promise;
    });
    let daemon: DaemonInstance | undefined;
    let compactPromise: Promise<Response> | undefined;

    try {
      daemon = await createDaemon(loadDaemonConfig(configPath, {
        daemon: { port: 0, idleTimeoutMs: 0 },
        llm: {
          provider: "openai",
          model: "test-model",
          apiKey: "sk-test",
          baseUrl: "http://localhost:11435/v1",
        },
      }), {
        tokenPath,
        publicationConfigPath: configPath,
        _testIdentity: {
          ownerId: "compact-admission-test",
          entrypoint: join(tempHome, "daemon.mjs"),
        },
      });
      const baseUrl = `http://127.0.0.1:${daemon.address().port}`;
      const messages = Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `pending compact message ${index}`,
        tokenCount: 1_000,
      }));
      const ingestResponse = await fetch(`${baseUrl}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${readAuthToken(tokenPath)}` },
        body: JSON.stringify({ session_id: "pending-compact", cwd: projectDir, messages }),
      });
      expect(ingestResponse.status).toBe(200);

      compactPromise = fetch(`${baseUrl}/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${readAuthToken(tokenPath)}` },
        body: JSON.stringify({ session_id: "pending-compact", cwd: projectDir, skip_ingest: true }),
      });
      await summarizeStarted.promise;

      let publicationEntered = false;
      await withBackendPublicationConsumerLockAsync(tempHome, async () => {
        publicationEntered = true;
      });
      expect(publicationEntered).toBe(true);
      const healthResponse = await fetch(`${baseUrl}/health`, {
        headers: { Authorization: `Bearer ${readAuthToken(tokenPath)}` },
      });
      expect(healthResponse.status).toBe(200);

      releaseSummary.resolve("pending compact summary");
      await expect(compactPromise).resolves.toMatchObject({ status: 200 });
    } finally {
      releaseSummary.resolve("cleanup summary");
      await compactPromise?.catch(() => undefined);
      if (daemon) await daemon.stop();
      rmSync(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("revalidates config before post-model storage mutation", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalPostgresUrl = process.env.LCM_POSTGRES_URL;
    const originalPostgresCaFile = process.env.LCM_POSTGRES_CA_FILE;
    const originalPostgresMigrationRole = process.env.LCM_POSTGRES_MIGRATION_ROLE;
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-compact-config-admission-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const lcmDir = join(tempHome, ".lcm");
    const projectDir = join(tempHome, "project");
    const configPath = join(lcmDir, "config.json");
    const caFile = join(tempHome, "postgres-ca.pem");
    mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    writeFileSync(caFile, "test-ca\n", { mode: 0o600 });
    process.env.LCM_POSTGRES_URL = "postgresql://user:password@localhost/lcm";
    process.env.LCM_POSTGRES_CA_FILE = caFile;
    process.env.LCM_POSTGRES_MIGRATION_ROLE = "lcm_test_migrator";
    const summarizeStarted = deferred<void>();
    const releaseSummary = deferred<string>();
    vi.mocked(createOpenAISummarizer).mockReturnValueOnce(async () => {
      summarizeStarted.resolve();
      return releaseSummary.promise;
    });
    let daemon: DaemonInstance | undefined;
    let compactPromise: Promise<Response> | undefined;

    try {
      daemon = await createDaemon(loadDaemonConfig(configPath, {
        daemon: { port: 0, idleTimeoutMs: 0 },
        llm: {
          provider: "openai",
          model: "test-model",
          apiKey: "sk-test",
          baseUrl: "http://localhost:11435/v1",
        },
      }), { publicationConfigPath: configPath });
      const baseUrl = `http://127.0.0.1:${daemon.address().port}`;
      const messages = Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `config-race message ${index}`,
        tokenCount: 1_000,
      }));
      const ingestResponse = await fetch(`${baseUrl}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "config-race", cwd: projectDir, messages }),
      });
      expect(ingestResponse.status).toBe(200);

      compactPromise = fetch(`${baseUrl}/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "config-race", cwd: projectDir, skip_ingest: true }),
      });
      await summarizeStarted.promise;

      writeFileSync(
        configPath,
        JSON.stringify({ storage: { backend: "postgresql" } }) + "\n",
        { mode: 0o600 },
      );
      releaseSummary.resolve("config-race summary");

      const response = await compactPromise;
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        status: "blocked",
        error: "backend publication admission blocked",
      });
      expect(await readMessageCount(projectDir, "config-race")).toBe(messages.length);
      expect(readSummaryCount(projectDir)).toBe(0);
    } finally {
      releaseSummary.resolve("cleanup summary");
      await compactPromise?.catch(() => undefined);
      if (daemon) await daemon.stop();
      rmSync(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      if (originalPostgresUrl === undefined) delete process.env.LCM_POSTGRES_URL;
      else process.env.LCM_POSTGRES_URL = originalPostgresUrl;
      if (originalPostgresCaFile === undefined) delete process.env.LCM_POSTGRES_CA_FILE;
      else process.env.LCM_POSTGRES_CA_FILE = originalPostgresCaFile;
      if (originalPostgresMigrationRole === undefined) delete process.env.LCM_POSTGRES_MIGRATION_ROLE;
      else process.env.LCM_POSTGRES_MIGRATION_ROLE = originalPostgresMigrationRole;
    }
  });

  it("revokes the operation token after compact admission exits", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-compact-token-lifetime-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    mkdirSync(join(tempHome, ".lcm"), { recursive: true, mode: 0o700 });
    const projectDir = join(tempHome, "project");
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    let capturedToken: BackendPublicationLockToken | undefined;
    const context: RouteExecutionContext = {
      withPublicationAdmission: async operation =>
        withBackendPublicationConsumerLockAsync(tempHome, async token => {
          capturedToken = token;
          return operation(token);
        }, { allowUnresolved: true }),
    };
    const output = mockRes();

    try {
      await createCompactHandlerProduction(makeConfig("disabled"))(
        {} as never,
        output.res,
        JSON.stringify({ session_id: "token-lifetime", cwd: projectDir }),
        context,
      );

      expect(output.getBody()).toMatchObject({ actionTaken: false });
      expect(capturedToken).toBeDefined();
      expect(() => assertBackendPublicationConsumerAccess({
        homeDir: tempHome,
        lockToken: capturedToken,
      })).toThrow(BackendPublicationJournalError);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("cancels a pending project open through the composed invocation signal", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-compact-open-cancel-"));
    tempDirs.push(tempDir);
    const baseFactory = new SqliteStorageBackendFactory();
    const openEntered = deferred<void>();
    const cleanupRelease = deferred<void>();
    const factoryClose = vi.fn(() => baseFactory.close());
    let capturedSignal: AbortSignal | undefined;
    const cancelledOpenError = (): StorageOperationError => new StorageOperationError(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "openProject",
    );
    const factory: StorageBackendFactory = {
      backend: baseFactory.backend,
      capabilities: baseFactory.capabilities,
      projectExists: (identity, publicationLockToken) =>
        baseFactory.projectExists(identity, publicationLockToken),
      openExistingProject: (identity, publicationLockToken, signal) =>
        baseFactory.openExistingProject(identity, publicationLockToken, signal),
      openProject: async (_identity, _publicationLockToken, signal) => {
        capturedSignal = signal;
        openEntered.resolve();
        if (signal === undefined) {
          await cleanupRelease.promise;
          throw cancelledOpenError();
        }
        await new Promise<never>((_resolve, reject) => {
          let settled = false;
          const cleanup = (): void => signal.removeEventListener("abort", rejectCancellation);
          const rejectCancellation = (): void => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(cancelledOpenError());
          };
          signal.addEventListener("abort", rejectCancellation, { once: true });
          void cleanupRelease.promise.then(rejectCancellation);
          if (signal.aborted) rejectCancellation();
        });
      },
      health: () => baseFactory.health(),
      close: factoryClose,
    };
    const invocationId = "77777777-7777-4777-8777-777777777777";
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationTarget = { invocationId, command: "compact" as const, daemonInstanceId };
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start(invocationTarget);
    const invocationSourceAdmission = coordinator.admitWork(invocationTarget);
    const invocationSourceSignal = invocationSourceAdmission.signal;
    invocationSourceAdmission.release();
    const requestController = new AbortController();
    const output = mockRes();
    let handlerSettled = false;
    const pending = createCompactHandlerProduction(makeConfig("openai"), factory)(
      {} as never,
      output.res,
      JSON.stringify({
        session_id: "pending-open-cancel",
        cwd: tempDir,
        invocation_id: invocationId,
      }),
      {
        ...testCompactContext,
        signal: requestController.signal,
        invocationCoordinator: coordinator,
      },
    ).finally(() => {
      handlerSettled = true;
    });

    try {
      await openEntered.promise;
      const initialTopology = {
        defined: capturedSignal !== undefined,
        isRequestSource: capturedSignal === requestController.signal,
        isInvocationSource: capturedSignal === invocationSourceSignal,
        aborted: capturedSignal?.aborted,
      };
      const activeDuringOpen = coordinator.snapshot(invocationId);

      requestController.abort();
      const nextTurn = deferred<boolean>();
      setImmediate(() => nextTurn.resolve(false));
      const settledWithinOneTurn = await Promise.race([
        pending.then(() => true),
        nextTurn.promise,
      ]);
      const finalInvocation = coordinator.snapshot(invocationId);

      expect({
        initialTopology,
        activeDuringOpen: {
          state: activeDuringOpen.state,
          activeCount: activeDuringOpen.activeCount,
          workCount: activeDuringOpen.workCount,
          commitCount: activeDuringOpen.commitCount,
        },
        requestSourceAborted: requestController.signal.aborted,
        invocationSourceAborted: invocationSourceSignal.aborted,
        composedSignalAborted: capturedSignal?.aborted,
        settledWithinOneTurn,
        handlerSettled,
        responseStatus: output.res.writeHead.mock.calls.at(-1)?.[0],
        responseBody: output.getBody(),
        finalInvocation: {
          state: finalInvocation.state,
          activeCount: finalInvocation.activeCount,
          workCount: finalInvocation.workCount,
          commitCount: finalInvocation.commitCount,
        },
      }).toEqual({
        initialTopology: {
          defined: true,
          isRequestSource: false,
          isInvocationSource: false,
          aborted: false,
        },
        activeDuringOpen: {
          state: "active",
          activeCount: 1,
          workCount: 1,
          commitCount: 0,
        },
        requestSourceAborted: true,
        invocationSourceAborted: true,
        composedSignalAborted: true,
        settledWithinOneTurn: true,
        handlerSettled: true,
        responseStatus: 499,
        responseBody: { status: "cancelled", error: "compact cancelled" },
        finalInvocation: {
          state: "cancelled",
          activeCount: 0,
          workCount: 0,
          commitCount: 0,
        },
      });
      expect(factoryClose).not.toHaveBeenCalled();
    } finally {
      cleanupRelease.resolve();
      await pending;
      await coordinator.shutdown();
      await baseFactory.close();
    }
  });

  it("skips transcript ingestion when skip_ingest is true", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-compact-"));
    tempDirs.push(tempDir);

    const transcriptPath = join(tempDir, "session.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ message: { role: "user", content: "transcript user 1" } }),
        JSON.stringify({ message: { role: "assistant", content: "transcript assistant 1" } }),
        JSON.stringify({ message: { role: "user", content: "transcript user 2" } }),
        JSON.stringify({ message: { role: "assistant", content: "transcript assistant 2" } }),
        JSON.stringify({ message: { role: "user", content: "transcript user 3" } }),
        JSON.stringify({ message: { role: "assistant", content: "transcript assistant 3" } }),
      ].join("\n"),
    );

    daemon = await createDaemon(loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "openai", model: "test-model", apiKey: "sk-test", baseURL: "http://localhost:11435/v1" },
    }));

    const baseUrl = `http://127.0.0.1:${daemon.address().port}`;
    const sessionId = "skip-ingest-session";

    const ingestRes = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        messages: [
          { role: "user", content: "stored user 1", tokenCount: 3 },
          { role: "assistant", content: "stored assistant 1", tokenCount: 4 },
          { role: "user", content: "stored user 2", tokenCount: 3 },
          { role: "assistant", content: "stored assistant 2", tokenCount: 4 },
        ],
      }),
    });

    expect(ingestRes.status).toBe(200);
    expect(await ingestRes.json()).toMatchObject({ ingested: 4 });
    expect(await readMessageCount(tempDir, sessionId)).toBe(4);

    const compactRes = await fetch(`${baseUrl}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        transcript_path: transcriptPath,
        skip_ingest: true,
      }),
    });

    expect(compactRes.status).toBe(200);
    expect(await readMessageCount(tempDir, sessionId)).toBe(4);
  });

  it("keeps transcript checkpoints and inserts atomic with concurrent ingestion", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-compact-ingest-race-"));
    tempDirs.push(tempDir);
    const transcriptPath = join(tempDir, "session.jsonl");
    const transcriptContents = ["race user", "race assistant", "race follow-up"];
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ message: { role: "user", content: transcriptContents[0] } }),
        JSON.stringify({ message: { role: "assistant", content: transcriptContents[1] } }),
        JSON.stringify({ message: { role: "user", content: transcriptContents[2] } }),
      ].join("\n"),
    );

    const sessionId = "compact-ingest-race";
    const dbPath = join(tempDir, "race.db");
    const baseFactory = new SqliteStorageBackendFactory({
      resolveProject: (identity) => ({ id: identity.id, dbPath }),
    });
    const identity = projectIdentity(tempDir);
    const concurrentProject = await baseFactory.openProject(identity);
    const conversation = await concurrentProject.conversations.getOrCreateConversation(sessionId);
    let injectedConcurrentIngest = false;

    const wrapProject = (project: ProjectStorage): ProjectStorage => new Proxy(project, {
      get(target, property) {
        if (property === "transaction") {
          return async <T>(callback: Parameters<ProjectStorage["transaction"]>[0]): Promise<T> => {
            if (!injectedConcurrentIngest) {
              injectedConcurrentIngest = true;
              await concurrentProject.transaction(async (repositories) => {
                const record = await repositories.conversations.createMessage({
                  conversationId: conversation.conversationId,
                  seq: 0,
                  role: "user",
                  content: transcriptContents[0],
                  tokenCount: 2,
                });
                await repositories.context.appendContextMessage(
                  conversation.conversationId,
                  record.messageId,
                );
              });
            }
            return target.transaction(callback) as Promise<T>;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const racingFactory: StorageBackendFactory = {
      backend: baseFactory.backend,
      capabilities: baseFactory.capabilities,
      projectExists: (project) => baseFactory.projectExists(project),
      openExistingProject: async (project) => {
        const opened = await baseFactory.openExistingProject(project);
        return opened ? wrapProject(opened) : null;
      },
      openProject: async (project) => wrapProject(await baseFactory.openProject(project)),
      health: () => baseFactory.health(),
      close: () => baseFactory.close(),
    };

    try {
      const output = mockRes();
      await createCompactHandler(makeConfig("openai"), racingFactory)(
        mockReq(),
        output.res,
        JSON.stringify({ session_id: sessionId, cwd: tempDir, transcript_path: transcriptPath }),
      );

      expect(output.getBody()).toMatchObject({ actionTaken: false });
      expect(injectedConcurrentIngest).toBe(true);
      expect((await concurrentProject.conversations.getMessages(conversation.conversationId))
        .map((message) => message.content)).toEqual(transcriptContents);
    } finally {
      await concurrentProject.close();
      await baseFactory.close();
    }
  });

  it("accepts previous_summary and returns latestSummaryContent", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-compact-prev-summary-"));
    tempDirs.push(tempDir);

    // Use mock summarizer so compact actually produces a summary
    daemon = await createDaemon(loadDaemonConfig("/x", {
      daemon: { port: 0 },
      summarizer: { mock: true },
    }));

    const baseUrl = `http://127.0.0.1:${daemon.address().port}`;
    const sessionId = "prev-summary-session";

    // Ingest enough messages to trigger compaction
    const messages: Array<{ role: string; content: string; tokenCount: number }> = [];
    for (let i = 0; i < 50; i++) {
      messages.push({ role: "user", content: `msg ${i}`, tokenCount: 100 });
      messages.push({ role: "assistant", content: `resp ${i}`, tokenCount: 100 });
    }
    const ingestRes = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, cwd: tempDir, messages }),
    });
    expect(ingestRes.status).toBe(200);

    // Compact with previous_summary — verify it doesn't reject and returns latestSummaryContent
    const compactRes = await fetch(`${baseUrl}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        previous_summary: "prior context from previous session",
      }),
    });

    expect(compactRes.status).toBe(200);
    const body = await compactRes.json();
    // Verify latestSummaryContent is returned (proves previous_summary was accepted and compact ran)
    expect(typeof body.latestSummaryContent).toBe("string");
    expect(body.latestSummaryContent.length).toBeGreaterThan(0);
  }, FULL_SUITE_DAEMON_TEST_TIMEOUT_MS);

  it("returns latestSummaryContent when summary is created", async () => {
    // Setup: create a real daemon with mock summarizer so compact produces a real summary
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-compact-latest-content-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(loadDaemonConfig("/x", {
      daemon: { port: 0 },
      summarizer: { mock: true },
    }));

    const baseUrl = `http://127.0.0.1:${daemon.address().port}`;
    const sessionId = "latest-content-session";

    // Ingest a substantial amount of messages to trigger compaction
    const messageData: Array<{ role: string; content: string; tokenCount: number }> = [];
    for (let i = 1; i <= 6; i++) {
      messageData.push({ role: "user" as const, content: `user message ${i}`, tokenCount: 100 });
      messageData.push({ role: "assistant" as const, content: `assistant response ${i}`, tokenCount: 100 });
    }

    const ingestRes = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        messages: messageData,
      }),
    });
    expect(ingestRes.status).toBe(200);

    // Compact with sufficient data to trigger actual summarization
    const compactRes = await fetch(`${baseUrl}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
      }),
    });

    expect(compactRes.status).toBe(200);
    const body = await compactRes.json();

    // Mock summarizer guarantees a summary is created — assert unconditionally
    expect(typeof body.latestSummaryContent).toBe("string");
    expect(body.latestSummaryContent.length).toBeGreaterThan(0);
  });

  it("updates redaction_stats when transcript ingestion contains secrets", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-compact-redact-"));
    tempDirs.push(tempDir);

    const transcriptPath = join(tempDir, "session.jsonl");
    writeFileSync(
      transcriptPath,
      [
        // ghp_ + 36 alphanumeric chars → matches built-in GitHub token pattern
        JSON.stringify({ message: { role: "user", content: "token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA here" } }),
        JSON.stringify({ message: { role: "assistant", content: "noted" } }),
        JSON.stringify({ message: { role: "user", content: "ok" } }),
      ].join("\n"),
    );

    // createAnthropicSummarizer is mocked at the top of this file
    daemon = await createDaemon(loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "anthropic", model: "claude-haiku-4-5-20251001", apiKey: "sk-test" },
    }));

    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "compact-redact-stats",
        cwd: tempDir,
        transcript_path: transcriptPath,
      }),
    });

    expect(res.status).toBe(200);

    const db = new DatabaseSync(projectDbPath(tempDir));
    try {
      const rows = db.prepare(
        "SELECT category, count FROM redaction_stats ORDER BY category"
      ).all() as Array<{ category: string; count: number }>;
      const byCategory = Object.fromEntries(rows.map((r) => [r.category, r.count]));
      // ghp_ token is matched by gitleaks github-pat pattern (gitleaks takes priority over native)
      expect(byCategory["gitleaks"]).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe("POST /compact with disabled provider", () => {
  let daemon: DaemonInstance | undefined;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = undefined; } });

  it("returns early with message when provider is disabled", async () => {
    const config = loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "disabled" },
    });
    daemon = await createDaemon(config);
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "test-sess", cwd: mkdtempSync(join(tmpdir(), "lcm-disabled-proj-")) }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toContain("disabled");
    expect(body.actionTaken).toBe(false);
  });
});

describe("POST /compact — scrub redaction during transcript ingestion", () => {
  let daemon: DaemonInstance | undefined;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts sensitive patterns from transcript messages during compaction", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-compact-scrub-"));
    tempDirs.push(tempDir);

    const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const transcriptPath = join(tempDir, "session.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ message: { role: "user", content: `my key is ${secret}` } }),
        JSON.stringify({ message: { role: "assistant", content: "I see your key" } }),
        JSON.stringify({ message: { role: "user", content: "thanks" } }),
        JSON.stringify({ message: { role: "assistant", content: "you're welcome" } }),
      ].join("\n"),
    );

    // Create daemon with sensitivePatterns configured (built-in patterns already cover sk-ant-*)
    daemon = await createDaemon(loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "openai", model: "test-model", apiKey: "sk-test", baseURL: "http://localhost:11435/v1" },
      security: { sensitivePatterns: [] },
    }));

    const baseUrl = `http://127.0.0.1:${daemon.address().port}`;
    const sessionId = "scrub-compact-session";

    // Compact with transcript (not skip_ingest) — scrubber should redact the secret
    const compactRes = await fetch(`${baseUrl}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        transcript_path: transcriptPath,
      }),
    });

    expect(compactRes.status).toBe(200);

    // Verify messages were ingested
    const msgCount = await readMessageCount(tempDir, sessionId);
    expect(msgCount).toBe(4);

    // Verify the secret was redacted in stored message content
    const contents = await readMessageContents(tempDir, sessionId);
    const userMsg = contents[0];
    expect(userMsg).toContain("[REDACTED]");
    expect(userMsg).not.toContain(secret);

    // Verify redaction_stats table was updated
    const db = new DatabaseSync(projectDbPath(tempDir));
    try {
      runLcmMigrations(db);
      const pid = projectId(tempDir);
      const row = db.prepare(
        "SELECT count FROM redaction_stats WHERE project_id = ? AND category = 'built_in'",
      ).get(pid) as { count: number } | undefined;
      expect(row).toBeDefined();
      expect(row!.count).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
