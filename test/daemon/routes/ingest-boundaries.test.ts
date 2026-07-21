import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(() => true),
  read: vi.fn(() => "{}"),
  write: vi.fn(),
  getConnection: vi.fn(),
  closeConnection: vi.fn(),
  sessionGet: vi.fn(() => undefined),
  validate: vi.fn((cwd: string) => cwd),
  safeTranscript: vi.fn((path: string) => path),
  migrate: vi.fn(),
  getConversation: vi.fn(async () => ({ conversationId: 1 })),
  getCount: vi.fn(async () => 0),
  createBulk: vi.fn(async (inputs: unknown[]) => inputs.map((_, index) => ({ messageId: index + 1 }))),
  transaction: vi.fn(async (operation: () => unknown) => operation()),
  append: vi.fn(async () => undefined),
  tokens: vi.fn(async () => 7),
  parse: vi.fn(() => [] as unknown[]),
  normalize: vi.fn((client: unknown) => client ?? "claude"),
  scrubCounts: vi.fn((content: string) => ({ text: content, gitleaks: 0, builtIn: 0, global: 0, project: 0 })),
  forProject: vi.fn(async () => ({ scrubWithCounts: mocks.scrubCounts })),
  send: vi.fn(),
  logError: vi.fn(),
}));

const db = {
  prepare: () => ({ get: mocks.sessionGet }),
};

vi.mock("node:fs", () => ({ existsSync: mocks.exists, readFileSync: mocks.read, writeFileSync: mocks.write }));
vi.mock("../../../src/db/connection.js", () => ({
  getLcmConnection: mocks.getConnection,
  closeLcmConnection: mocks.closeConnection,
  withLcmConnectionLock: (_path: string, work: () => unknown) => work(),
}));
vi.mock("../../../src/daemon/project.js", () => ({
  projectPaths: (cwd: string) => ({ id: "pid", dir: `${cwd}/project`, dbPath: `${cwd}/lcm.db`, metaPath: `${cwd}/meta.json`, canonical: cwd }),
  ensureProjectDir: vi.fn(),
  isSafeTranscriptPath: mocks.safeTranscript,
}));
vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.send }));
vi.mock("../../../src/db/migration.js", () => ({ runLcmMigrations: mocks.migrate }));
vi.mock("../../../src/db/redaction-stats.js", () => ({ upsertRedactionCounts: vi.fn() }));
vi.mock("../../../src/store/conversation-store.js", () => ({
  ConversationStore: class {
    getOrCreateConversation = mocks.getConversation;
    getMessageCount = mocks.getCount;
    createMessagesBulk = mocks.createBulk;
    withTransaction = mocks.transaction;
  },
}));
vi.mock("../../../src/store/summary-store.js", () => ({
  SummaryStore: class { appendContextMessages = mocks.append; getContextTokenCount = mocks.tokens; },
}));
vi.mock("../../../src/storage/index.js", () => ({
  createStorageBackendFactory: () => ({
    openProject: async () => {
      mocks.getConnection();
      const repositories = {
        conversations: {
          getOrCreateConversation: mocks.getConversation,
          getMessageCount: mocks.getCount,
          createMessagesBulk: mocks.createBulk,
        },
        context: { appendContextMessages: mocks.append, getContextTokenCount: mocks.tokens },
        coordination: {
          getSessionIngest: async (sessionId: string) => {
            const row = mocks.sessionGet(sessionId);
            return row ? { sessionId, messageCount: row.message_count, completedAt: "now" } : null;
          },
        },
        redactionAdmin: { upsertCounts: vi.fn(async () => undefined) },
      };
      return {
        ...repositories,
        transaction: (operation: (value: typeof repositories) => Promise<unknown>) =>
          mocks.transaction(() => operation(repositories)),
        close: async () => { mocks.closeConnection(); },
      };
    },
    close: async () => undefined,
  }),
}));
vi.mock("../../../src/transcript-provider.js", () => ({
  normalizeTranscriptClient: mocks.normalize,
  parseTranscriptForClient: mocks.parse,
}));
vi.mock("../../../src/scrub.js", () => ({ ScrubEngine: { forProject: mocks.forProject } }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validate }));
vi.mock("../../../src/hooks/hook-errors.js", () => ({ safeLogError: mocks.logError }));

import { createIngestHandler } from "../../../src/daemon/routes/ingest.js";

const config = loadDaemonConfig("/tmp/ingest-boundaries");
const response = {} as never;
const validMessage = { role: "user", content: "content", tokenCount: 2 };

describe("ingest persistence boundaries", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.getConnection.mockReturnValue(db);
    mocks.exists.mockReturnValue(true);
    mocks.read.mockReturnValue("{}");
    mocks.sessionGet.mockReturnValue(undefined);
    mocks.validate.mockImplementation((cwd: string) => cwd);
    mocks.safeTranscript.mockImplementation((path: string) => path);
    mocks.getConversation.mockResolvedValue({ conversationId: 1 });
    mocks.getCount.mockResolvedValue(0);
    mocks.createBulk.mockImplementation(async (inputs: unknown[]) => inputs.map((_, index) => ({ messageId: index + 1 })));
    mocks.transaction.mockImplementation(async (operation: () => unknown) => operation());
    mocks.tokens.mockResolvedValue(7);
    mocks.parse.mockReturnValue([]);
    mocks.normalize.mockImplementation((client: unknown) => client ?? "claude");
    mocks.scrubCounts.mockImplementation((content: string) => ({ text: content, gitleaks: 0, builtIn: 0, global: 0, project: 0 }));
    mocks.forProject.mockImplementation(async () => ({ scrubWithCounts: mocks.scrubCounts }));
  });

  it("validates required fields and typed cwd failures", async () => {
    const handler = createIngestHandler(config);
    await handler({} as never, response, "");
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "session_id and cwd are required" });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await handler({} as never, response, JSON.stringify({ session_id: "s", cwd: "/bad", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "bad cwd" });
    mocks.validate.mockImplementationOnce(() => { throw "failure"; });
    await handler({} as never, response, JSON.stringify({ session_id: "s", cwd: "/bad", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "invalid cwd" });
  });

  it("filters malformed messages and handles empty transcript paths", async () => {
    const handler = createIngestHandler(config);
    await handler({} as never, response, JSON.stringify({ session_id: "empty", cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 0, totalTokens: 0 });
    await handler({} as never, response, JSON.stringify({
      session_id: "s", cwd: "/ok",
      messages: [null, "x", {}, { role: "bad", content: "x", tokenCount: 1 },
        { role: "user", content: 1, tokenCount: 1 }, { role: "user", content: "x", tokenCount: "1" }],
    }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 0, totalTokens: 0 });
    mocks.safeTranscript.mockReturnValueOnce("");
    await handler({} as never, response, JSON.stringify({ session_id: "s", cwd: "/ok", transcript_path: "/unsafe" }));
    mocks.safeTranscript.mockReturnValueOnce("/missing");
    mocks.exists.mockReturnValueOnce(false);
    await handler({} as never, response, JSON.stringify({ session_id: "s", cwd: "/ok", transcript_path: "/missing" }));
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it("parses transcripts through client, provider, and default precedence", async () => {
    const handler = createIngestHandler(config);
    for (const input of [
      { client: "codex", provider: "ignored" },
      { provider: "codex" },
      {},
    ]) {
      mocks.parse.mockReturnValueOnce([validMessage]);
      await handler({} as never, response, JSON.stringify({ session_id: String(Math.random()), cwd: "/ok", transcript_path: "/safe", ...input }));
    }
    expect(mocks.normalize.mock.calls.map((call) => call[0])).toEqual(["codex", "codex", undefined]);
  });

  it("skips completed sessions and rolls back when coordination lookup fails", async () => {
    const handler = createIngestHandler(config);
    mocks.sessionGet.mockReturnValueOnce({ message_count: 1 });
    await handler({} as never, response, JSON.stringify({ session_id: "complete", cwd: "/ok", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 0, totalTokens: 0 });
    const failure = new Error("coordination failed");
    mocks.sessionGet.mockImplementationOnce(() => { throw failure; });
    await handler({} as never, response, JSON.stringify({ session_id: "failed", cwd: "/ok", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "ingest failed", code: "INGEST_FAILED" });
    expect(mocks.getConversation).not.toHaveBeenCalled();
    expect(mocks.createBulk).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenLastCalledWith("ingest", failure, { cwd: "/ok", sessionId: "failed" });
  });

  it("reports every redaction category and tolerates metadata write failures", async () => {
    const noSecurityConfig = { ...config, security: undefined };
    const handler = createIngestHandler(noSecurityConfig);
    mocks.scrubCounts.mockReturnValueOnce({ text: "redacted", gitleaks: 1, builtIn: 2, global: 3, project: 4 });
    mocks.read.mockReturnValueOnce(JSON.stringify({ existing: true }));
    await handler({} as never, response, JSON.stringify({ session_id: "redacted", cwd: "/ok", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      ingested: 1,
      totalTokens: 7,
      redacted: 10,
      redactedCategories: ["gitleaks", "built_in", "global", "project"],
    });
    mocks.read.mockImplementationOnce(() => { throw new Error("metadata failed"); });
    await handler({} as never, response, JSON.stringify({ session_id: "metadata-failure", cwd: "/ok", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 1, totalTokens: 7 });
    mocks.read.mockImplementationOnce(() => {
      throw Object.assign(new Error("missing metadata"), { code: "ENOENT" });
    });
    await handler({} as never, response, JSON.stringify({ session_id: "metadata-absent", cwd: "/ok", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { ingested: 1, totalTokens: 7 });
  });

  it("returns a stable error without disclosing persistence details and releases connections", async () => {
    const handler = createIngestHandler(config);
    const failure = new Error("database password=hunter2");
    mocks.getConversation.mockRejectedValueOnce(failure);
    await handler({} as never, response, JSON.stringify({ session_id: "error", cwd: "/ok", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "ingest failed", code: "INGEST_FAILED" });
    expect(mocks.logError).toHaveBeenLastCalledWith("ingest", failure, { cwd: "/ok", sessionId: "error" });
    mocks.getConversation.mockRejectedValueOnce("failure");
    await handler({} as never, response, JSON.stringify({ session_id: "error-two", cwd: "/ok", messages: [validMessage] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "ingest failed", code: "INGEST_FAILED" });
    expect(mocks.closeConnection).toHaveBeenCalledTimes(2);
  });
});
