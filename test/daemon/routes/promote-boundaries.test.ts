import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(() => true),
  read: vi.fn(() => "{}"),
  write: vi.fn(),
  mkdir: vi.fn(),
  getConnection: vi.fn(() => ({})),
  closeConnection: vi.fn(),
  migrate: vi.fn(),
  conversations: vi.fn(async () => [] as unknown[]),
  summaries: vi.fn(async () => [] as unknown[]),
  prefixes: vi.fn(() => [] as string[]),
  shouldPromote: vi.fn(() => ({ promote: false, tags: [], confidence: 0 })),
  dedup: vi.fn(async () => undefined),
  validate: vi.fn((cwd: string) => cwd),
  send: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: mocks.exists,
  readFileSync: mocks.read,
  writeFileSync: mocks.write,
  mkdirSync: mocks.mkdir,
}));
vi.mock("../../../src/daemon/project.js", () => ({
  projectPaths: (cwd: string) => ({ id: "pid", dbPath: `${cwd}/lcm.db`, metaPath: `${cwd}/meta.json`, canonical: cwd }),
}));
vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.send }));
vi.mock("../../../src/db/connection.js", () => ({ getLcmConnection: mocks.getConnection, closeLcmConnection: mocks.closeConnection }));
vi.mock("../../../src/db/migration.js", () => ({ runLcmMigrations: mocks.migrate }));
vi.mock("../../../src/store/conversation-store.js", () => ({ ConversationStore: class { listConversations = mocks.conversations; } }));
vi.mock("../../../src/store/summary-store.js", () => ({ SummaryStore: class { getSummariesByConversation = mocks.summaries; } }));
vi.mock("../../../src/db/promoted.js", () => ({ PromotedStore: class { listContentPrefixes = mocks.prefixes; } }));
vi.mock("../../../src/promotion/detector.js", () => ({ shouldPromote: mocks.shouldPromote }));
vi.mock("../../../src/promotion/dedup.js", () => ({ deduplicateAndInsert: mocks.dedup }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validate }));

import { createPromoteHandler } from "../../../src/daemon/routes/promote.js";

const config = loadDaemonConfig("/tmp/promote-boundaries");
const response = {} as never;

describe("promote persistence boundaries", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.exists.mockReturnValue(true);
    mocks.read.mockReturnValue("{}");
    mocks.getConnection.mockReturnValue({});
    mocks.conversations.mockResolvedValue([]);
    mocks.summaries.mockResolvedValue([]);
    mocks.prefixes.mockReturnValue([]);
    mocks.shouldPromote.mockReturnValue({ promote: false, tags: [], confidence: 0 });
    mocks.dedup.mockResolvedValue(undefined);
    mocks.validate.mockImplementation((cwd: string) => cwd);
  });

  it("validates cwd and missing databases", async () => {
    const handler = createPromoteHandler(config);
    await handler({} as never, response, "");
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "cwd is required" });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await handler({} as never, response, JSON.stringify({ cwd: "/bad" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "bad cwd" });
    mocks.validate.mockImplementationOnce(() => { throw "failure"; });
    await handler({} as never, response, JSON.stringify({ cwd: "/bad" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "invalid cwd" });
    mocks.exists.mockReturnValueOnce(false);
    await handler({} as never, response, JSON.stringify({ cwd: "/missing" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { processed: 0, promoted: 0 });
  });

  it("skips duplicates and low-signal summaries and counts dry runs", async () => {
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "duplicate", depth: 0, tokenCount: 1, sourceMessageTokenCount: 2 },
      { content: "low signal", depth: 0, tokenCount: 1, sourceMessageTokenCount: 2 },
      { content: "promote", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.prefixes.mockReturnValueOnce(["duplicate"]);
    mocks.shouldPromote
      .mockReturnValueOnce({ promote: false, tags: [], confidence: 0 })
      .mockReturnValueOnce({ promote: true, tags: ["depth"], confidence: 0.25 });
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok", dry_run: true }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { processed: 2, promoted: 1, conversations: 1 });
    expect(mocks.dedup).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("inserts promoted summaries, ignores individual failures, and updates metadata", async () => {
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "first", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
      { content: "second", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.shouldPromote.mockReturnValue({ promote: true, tags: ["depth"], confidence: 0.25 });
    mocks.dedup.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("duplicate failed"));
    mocks.read.mockReturnValueOnce(JSON.stringify({ existing: true }));
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { processed: 2, promoted: 1, conversations: 1 });
    expect(mocks.write).toHaveBeenCalledOnce();

    mocks.exists.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.write).toHaveBeenCalledTimes(2);
    mocks.read.mockImplementationOnce(() => { throw new Error("meta failed"); });
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { processed: 0, promoted: 0, conversations: 0 });
  });

  it("normalizes typed and untyped failures and closes acquired connections", async () => {
    const handler = createPromoteHandler(config);
    mocks.migrate.mockImplementationOnce(() => { throw new Error("migration failed"); });
    await handler({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "migration failed" });
    mocks.getConnection.mockImplementationOnce(() => { throw "failure"; });
    await handler({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "promote failed" });
    expect(mocks.closeConnection).toHaveBeenCalledWith("/ok/lcm.db");
  });
});
