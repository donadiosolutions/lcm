import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUserPromptSubmit } from "../../src/hooks/user-prompt.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn(),
}));

vi.mock("../../src/hooks/extractors.js", () => ({
  extractUserPromptEvents: vi.fn(),
}));

vi.mock("../../src/hooks/events-db.js", () => ({
  EventsDb: vi.fn(),
}));

vi.mock("../../src/db/events-path.js", () => ({
  eventsDbPath: vi.fn().mockReturnValue("/tmp/test-events.db"),
}));

vi.mock("../../src/daemon/project.js", () => ({
  ensureProjectDir: vi.fn(),
}));

vi.mock("../../src/hooks/session-end.js", () => ({
  firePromoteEventsNotifyRequest: vi.fn(),
}));

import { ensureDaemon } from "../../src/daemon/lifecycle.js";
import { eventsDbPath } from "../../src/db/events-path.js";
import { ensureProjectDir } from "../../src/daemon/project.js";
import { extractUserPromptEvents } from "../../src/hooks/extractors.js";
import { EventsDb } from "../../src/hooks/events-db.js";
import { firePromoteEventsNotifyRequest } from "../../src/hooks/session-end.js";

const mockEnsureDaemon = vi.mocked(ensureDaemon);
const mockEventsDbPath = vi.mocked(eventsDbPath);
const mockEnsureProjectDir = vi.mocked(ensureProjectDir);
const mockExtractUserPromptEvents = vi.mocked(extractUserPromptEvents);
const MockEventsDb = vi.mocked(EventsDb);

describe("handleUserPromptSubmit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(firePromoteEventsNotifyRequest).mockImplementation(() => {});
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  it("returns hint when daemon returns matches", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({
        hints: ["Decided to use PostgreSQL for storage", "Fixed race condition in compaction"],
        ids: ["uuid-1", "uuid-2"],
      }),
    };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ session_id: "s1", cwd: "/proj", prompt: "what database do we use?" }),
      client as any,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<memory-context>");
    expect(result.stdout).toContain("PostgreSQL");
    expect(client.post).toHaveBeenCalledWith("/prompt-search", expect.objectContaining({
      learningInstructionBytes: expect.any(Number),
    }));
  });

  it("includes surfaced-memory-ids comment when ids are returned", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({
        hints: ["Use React for frontend"],
        ids: ["abc-123"],
      }),
    };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ session_id: "s1", cwd: "/proj", prompt: "what framework?" }),
      client as any,
    );
    expect(result.stdout).toContain("<!-- surfaced-memory-ids: abc-123 -->");
  });

  it("omits surfaced-memory-ids comment when ids are absent", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({
        hints: ["Use React for frontend"],
      }),
    };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ session_id: "s1", cwd: "/proj", prompt: "what framework?" }),
      client as any,
    );
    expect(result.stdout).not.toContain("surfaced-memory-ids");
  });

  it("returns empty when daemon returns no matches", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: [] }),
    };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ session_id: "s1", cwd: "/proj", prompt: "hello" }),
      client as any,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<learning-instruction>");
    expect(result.stdout).not.toContain("<memory-context>");
  });

  it("returns learning-instruction when daemon unreachable", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: false, port: 3737, spawned: false });
    const client = { health: vi.fn(), post: vi.fn() };
    const result = await handleUserPromptSubmit("{}", client as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<learning-instruction>");
  });

  it("returns learning-instruction when prompt is missing", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: [] }),
    };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ session_id: "s1", cwd: "/proj" }),
      client as any,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<learning-instruction>");
  });

  it.each([null, 42, "   "])("returns learning instruction for invalid prompt %j", async (prompt) => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const result = await handleUserPromptSubmit(JSON.stringify({ prompt }), { post: vi.fn() } as any);
    expect(result.stdout).toContain("<learning-instruction>");
  });

  it("falls back to process cwd and skips sidecar persistence without a session", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    mockExtractUserPromptEvents.mockReturnValue([
      { type: "decision", category: "decision", data: "choice", priority: 1 },
    ]);
    const client = { post: vi.fn().mockResolvedValue({ hints: [] }) };
    await handleUserPromptSubmit(JSON.stringify({ prompt: "always choose this" }), client as any);
    expect(client.post).toHaveBeenCalledWith("/prompt-search", expect.objectContaining({ cwd: process.cwd() }));
    expect(MockEventsDb).not.toHaveBeenCalled();
  });

  it("handles a missing hints property and prompt-search failure", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    mockExtractUserPromptEvents.mockReturnValue([]);
    const missing = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "hello", session_id: "s1" }),
      { post: vi.fn().mockResolvedValue({}) } as any,
    );
    expect(missing.stdout).toContain("<learning-instruction>");

    const failed = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "hello", session_id: "s1" }),
      { post: vi.fn().mockRejectedValue(new Error("failed")) } as any,
    );
    expect(failed.stdout).toContain("<learning-instruction>");
  });

  it("handles empty stdin and logs extraction errors using the environment cwd", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    expect((await handleUserPromptSubmit("", { post: vi.fn() } as any)).stdout).toContain("<learning-instruction>");
    process.env.CLAUDE_PROJECT_DIR = "/env-project";
    mockExtractUserPromptEvents.mockImplementationOnce(() => { throw new Error("failed"); });
    await handleUserPromptSubmit(
      JSON.stringify({ prompt: "hello", session_id: "s1" }),
      { post: vi.fn().mockResolvedValue({ hints: [] }) } as any,
    );
  });

  it("includes learning-instruction block in output", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const mockClient = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: ["some context hint"] }),
    };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "test query", cwd: "/tmp/test", session_id: "s1" }),
      mockClient as any,
    );
    expect(result.stdout).toContain("<learning-instruction>");
    expect(result.stdout).toContain("lcm_store");
    expect(result.stdout).toContain("type:decision");
    expect(result.stdout).toContain("</learning-instruction>");
  });

  it("includes signal:memory_used recall instruction", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const mockClient = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: ["some hint"], ids: ["uuid-1"] }),
    };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "test", cwd: "/tmp/test", session_id: "s1" }),
      mockClient as any,
    );
    expect(result.stdout).toContain("signal:memory_used");
    expect(result.stdout).toContain("memory_id:<id>");
  });

  it("includes learning-instruction even when no memory-context hints", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const mockClient = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: [] }),
    };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "test query", cwd: "/tmp/test", session_id: "s1" }),
      mockClient as any,
    );
    expect(result.stdout).toContain("<learning-instruction>");
    expect(result.stdout).not.toContain("<memory-context>");
  });

  it("extracts decision events to sidecar before prompt-search", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const mockInsertEvent = vi.fn();
    const mockClose = vi.fn();
    MockEventsDb.mockImplementation(function () {
      return {
        insertEvent: mockInsertEvent,
        getHealthStats: vi.fn().mockReturnValue({ unprocessed: 1 }),
        close: mockClose,
      } as any;
    });
    mockExtractUserPromptEvents.mockReturnValue([
      { type: "decision", category: "decision", data: "use SQLite", priority: 1 },
    ]);
    const mockClient = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: ["some hint"] }),
    };

    const result = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "we decided to use SQLite", cwd: "/proj", session_id: "s1" }),
      mockClient as any,
    );

    expect(result.exitCode).toBe(0);
    expect(mockExtractUserPromptEvents).toHaveBeenCalledWith("we decided to use SQLite");
    expect(mockInsertEvent).toHaveBeenCalledWith(
      "s1",
      { type: "decision", category: "decision", data: "use SQLite", priority: 1 },
      "UserPromptSubmit",
    );
    expect(mockClose).toHaveBeenCalled();
    expect(firePromoteEventsNotifyRequest).toHaveBeenCalledWith(3737, {
      cwd: "/proj",
      priority: 1,
      pendingCount: 1,
      sourceHook: "UserPromptSubmit",
    });
    // prompt-search still called
    expect(mockClient.post).toHaveBeenCalledWith("/prompt-search", expect.any(Object));
  });

  it("falls back to CLAUDE_PROJECT_DIR when input cwd is blank for sidecar writes", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const mockInsertEvent = vi.fn();
    const mockClose = vi.fn();
    MockEventsDb.mockImplementation(function () {
      return {
        insertEvent: mockInsertEvent,
        getHealthStats: vi.fn().mockReturnValue({ unprocessed: 1 }),
        close: mockClose,
      } as any;
    });
    mockExtractUserPromptEvents.mockReturnValue([
      { type: "decision", category: "decision", data: "use SQLite", priority: 1 },
    ]);
    process.env.CLAUDE_PROJECT_DIR = "/env-project";
    const mockClient = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: [] }),
    };

    await handleUserPromptSubmit(
      JSON.stringify({ prompt: "we decided to use SQLite", cwd: "   ", session_id: "s1" }),
      mockClient as any,
    );

    expect(mockEnsureProjectDir).toHaveBeenCalledWith("/env-project");
    expect(mockEventsDbPath).toHaveBeenCalledWith("/env-project");
    expect(mockClient.post).toHaveBeenCalledWith("/prompt-search", expect.objectContaining({
      cwd: "/env-project",
    }));
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  it("trims cwd before sidecar writes and prompt search", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const mockClose = vi.fn();
    MockEventsDb.mockImplementation(function () {
      return {
        insertEvent: vi.fn(),
        getHealthStats: vi.fn().mockReturnValue({ unprocessed: 1 }),
        close: mockClose,
      } as any;
    });
    mockExtractUserPromptEvents.mockReturnValue([
      { type: "decision", category: "decision", data: "use SQLite", priority: 1 },
    ]);
    const mockClient = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: [] }),
    };

    await handleUserPromptSubmit(
      JSON.stringify({ prompt: "we decided to use SQLite", cwd: "  /trimmed-project  ", session_id: "s1" }),
      mockClient as any,
    );

    expect(mockEnsureProjectDir).toHaveBeenCalledWith("/trimmed-project");
    expect(mockEventsDbPath).toHaveBeenCalledWith("/trimmed-project");
    expect(mockClient.post).toHaveBeenCalledWith("/prompt-search", expect.objectContaining({
      cwd: "/trimmed-project",
    }));
  });

  it("continues prompt search if daemon notify fails", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    MockEventsDb.mockImplementation(function () {
      return {
        insertEvent: vi.fn(),
        getHealthStats: vi.fn().mockReturnValue({ unprocessed: 1 }),
        close: vi.fn(),
      } as any;
    });
    mockExtractUserPromptEvents.mockReturnValue([
      { type: "decision", category: "decision", data: "use SQLite", priority: 1 },
    ]);
    vi.mocked(firePromoteEventsNotifyRequest).mockImplementation(() => {
      throw new Error("notify failed");
    });
    const mockClient = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: ["recovered hint"] }),
    };

    const result = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "we decided to use SQLite", cwd: "/proj", session_id: "s1" }),
      mockClient as any,
    );

    expect(result.stdout).toContain("recovered hint");
    expect(mockClient.post).toHaveBeenCalledWith("/prompt-search", expect.any(Object));
  });

  it("continues normally if sidecar extraction fails", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    mockExtractUserPromptEvents.mockImplementation(() => {
      throw new Error("extraction exploded");
    });
    const mockClient = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: ["recovered hint"] }),
    };

    const result = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "hello world", cwd: "/proj", session_id: "s2" }),
      mockClient as any,
    );

    expect(result.exitCode).toBe(0);
    // prompt-search still called despite extraction failure
    expect(mockClient.post).toHaveBeenCalledWith("/prompt-search", expect.any(Object));
    expect(result.stdout).toContain("<memory-context>");
    expect(result.stdout).toContain("recovered hint");
  });

  it("preserves surfaced-memory-ids only for hints returned by prompt-search", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const mockClient = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({
        hints: ["Use Bun for scripts"],
        ids: ["memory-1"],
      }),
    };

    const result = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "scripts", cwd: "/tmp/test", session_id: "s1" }),
      mockClient as any,
    );

    expect(result.stdout).toContain("<!-- surfaced-memory-ids: memory-1 -->");
    expect(result.stdout).not.toContain("memory-2");
  });
});
