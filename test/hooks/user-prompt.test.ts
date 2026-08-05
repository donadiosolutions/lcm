import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { handleUserPromptSubmit } from "../../src/hooks/user-prompt.js";
import type { DaemonClient } from "../../src/daemon/client.js";
import type { EventsDb as EventsDbType } from "../../src/hooks/events-db.js";
import * as storageBackend from "../../src/storage/backend.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn(),
}));

vi.mock("../../src/hooks/extractors.js", () => ({
  extractUserPromptEvents: vi.fn(),
}));

vi.mock("../../src/hooks/event-scrubbing.js", () => ({
  scrubExtractedEvents: vi.fn(async (events: unknown[]) => events),
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

type ClientFixture = {
  health?: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
};

function asDaemonClient(client: ClientFixture): DaemonClient {
  // DaemonClient has private runtime state; these hook tests exercise only its public post seam.
  return client as unknown as DaemonClient;
}

function eventsDbFixture(overrides: Partial<EventsDbType>): EventsDbType {
  // EventsDb has private SQLite state; constructor-mocked tests supply only observed public methods.
  return {
    insertEvent: vi.fn(),
    getHealthStats: vi.fn().mockReturnValue({ unprocessed: 1 }),
    close: vi.fn(),
    ...overrides,
  } as unknown as EventsDbType;
}

describe("handleUserPromptSubmit", () => {
  let originalClaudeProjectDir: string | undefined;

  beforeEach(() => {
    originalClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
    vi.clearAllMocks();
    vi.mocked(firePromoteEventsNotifyRequest).mockImplementation(() => {});
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    if (originalClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalClaudeProjectDir;
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
      asDaemonClient(client),
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
      asDaemonClient(client),
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
      asDaemonClient(client),
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
      asDaemonClient(client),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<learning-instruction>");
    expect(result.stdout).not.toContain("<memory-context>");
  });

  it("returns learning-instruction when daemon unreachable", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: false, port: 3737, spawned: false });
    const client = { health: vi.fn(), post: vi.fn() };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "remember this", cwd: "/proj", session_id: "s1" }),
      asDaemonClient(client),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<learning-instruction>");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("queues local events before checking an unavailable PostgreSQL daemon", async () => {
    const order: string[] = [];
    const mockInsertEvent = vi.fn(() => { order.push("insert"); });
    const mockClose = vi.fn(() => { order.push("close"); });
    MockEventsDb.mockImplementation(function () {
      return eventsDbFixture({
        insertEvent: mockInsertEvent,
        getHealthStats: vi.fn().mockReturnValue({ unprocessed: 1 }),
        close: mockClose,
      });
    });
    mockExtractUserPromptEvents.mockReturnValue([
      { type: "decision", category: "decision", data: "use PostgreSQL", priority: 1 },
    ]);
    mockEnsureDaemon.mockImplementation(async () => {
      order.push("ensure");
      return { connected: false, port: 3737, spawned: false };
    });
    const client = { post: vi.fn() };

    const home = mkdtempSync(join(tmpdir(), "lcm-user-prompt-storage-"));
    const previousHome = process.env.HOME;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.HOME = home;
    let result: Awaited<ReturnType<typeof handleUserPromptSubmit>>;
    try {
      result = await handleUserPromptSubmit(
        JSON.stringify({ prompt: "we decided to use PostgreSQL", cwd: "/proj", session_id: "s1" }),
        asDaemonClient(client),
        3737,
        {
          backend: "postgresql",
        },
      );
      expect(stderrWrite).toHaveBeenCalledWith(
        "lcm daemon unavailable (ambiguous); run 'lcm daemon restart' or 'lcm doctor'.\n",
      );
      expect(stderrWrite.mock.calls.flat().join(" ")).not.toContain("not available in this release");
    } finally {
      stderrWrite.mockRestore();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }

    expect(order).toEqual(["insert", "close"]);
    expect(mockInsertEvent).toHaveBeenCalledWith(
      "s1",
      { type: "decision", category: "decision", data: "use PostgreSQL", priority: 1 },
      "UserPromptSubmit",
    );
    expect(mockClose).toHaveBeenCalled();
    expect(mockEnsureDaemon).not.toHaveBeenCalled();
    expect(firePromoteEventsNotifyRequest).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
    expect(result).toEqual({ exitCode: 0, stdout: expect.stringContaining("<learning-instruction>") });
  });

  it("sanitizes unexpected storage-selection failures before the protocol-safe return", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-user-prompt-storage-throw-"));
    const previousHome = process.env.HOME;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const selectStorageBackend = vi.spyOn(storageBackend, "selectStorageBackend").mockImplementationOnce(() => {
      throw new Error("secret /tmp/private-config pid=4242");
    });
    process.env.HOME = home;
    try {
      const result = await handleUserPromptSubmit(
        JSON.stringify({ prompt: "hello", cwd: "/proj" }),
        asDaemonClient({ post: vi.fn() }),
      );
      expect(result).toEqual({ exitCode: 0, stdout: expect.stringContaining("<learning-instruction>") });
      expect(stderrWrite).toHaveBeenCalledWith(
        "lcm daemon unavailable (ambiguous); run 'lcm daemon restart' or 'lcm doctor'.\n",
      );
      expect(stderrWrite.mock.calls.flat().join(" ")).not.toMatch(/secret|private-config|4242/u);
      expect(mockEnsureDaemon).not.toHaveBeenCalled();
    } finally {
      selectStorageBackend.mockRestore();
      stderrWrite.mockRestore();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns learning-instruction when prompt is missing", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: [] }),
    };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ session_id: "s1", cwd: "/proj" }),
      asDaemonClient(client),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<learning-instruction>");
  });

  it.each([null, 42, "   "])("returns learning instruction for invalid prompt %j", async (prompt) => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const result = await handleUserPromptSubmit(JSON.stringify({ prompt }), asDaemonClient({ post: vi.fn() }));
    expect(result.stdout).toContain("<learning-instruction>");
  });

  it("falls back to process cwd and skips sidecar persistence without a session", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    mockExtractUserPromptEvents.mockReturnValue([
      { type: "decision", category: "decision", data: "choice", priority: 1 },
    ]);
    const client = { post: vi.fn().mockResolvedValue({ hints: [] }) };
    await handleUserPromptSubmit(JSON.stringify({ prompt: "always choose this" }), asDaemonClient(client));
    expect(client.post).toHaveBeenCalledWith("/prompt-search", expect.objectContaining({ cwd: process.cwd() }));
    expect(MockEventsDb).not.toHaveBeenCalled();
  });

  it("handles a missing hints property and prompt-search failure", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    mockExtractUserPromptEvents.mockReturnValue([]);
    const missing = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "hello", session_id: "s1" }),
      asDaemonClient({ post: vi.fn().mockResolvedValue({}) }),
    );
    expect(missing.stdout).toContain("<learning-instruction>");

    const failed = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "hello", session_id: "s1" }),
      asDaemonClient({ post: vi.fn().mockRejectedValue(new Error("failed")) }),
    );
    expect(failed.stdout).toContain("<learning-instruction>");
  });

  it("keeps the prompt hook successful when prompt-search reports staged PostgreSQL", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    mockExtractUserPromptEvents.mockReturnValue([]);
    const stagedError = Object.assign(new Error("request failed with status 503"), {
      status: 503,
      body: {
        code: "STORAGE_BACKEND_STAGED",
        storageBackend: "postgresql",
      },
    });

    const result = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "hello", session_id: "s1", cwd: "/project" }),
      asDaemonClient({ post: vi.fn().mockRejectedValue(stagedError) }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<learning-instruction>");
    expect(result.stdout).not.toContain("STORAGE_BACKEND_STAGED");
  });

  it("handles empty stdin and logs extraction errors using the environment cwd", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    expect((await handleUserPromptSubmit("", asDaemonClient({ post: vi.fn() }))).stdout).toContain("<learning-instruction>");
    process.env.CLAUDE_PROJECT_DIR = "/env-project";
    mockExtractUserPromptEvents.mockImplementationOnce(() => { throw new Error("failed"); });
    await handleUserPromptSubmit(
      JSON.stringify({ prompt: "hello", session_id: "s1" }),
      asDaemonClient({ post: vi.fn().mockResolvedValue({ hints: [] }) }),
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
      asDaemonClient(mockClient),
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
      asDaemonClient(mockClient),
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
      asDaemonClient(mockClient),
    );
    expect(result.stdout).toContain("<learning-instruction>");
    expect(result.stdout).not.toContain("<memory-context>");
  });

  it("extracts decision events to sidecar before prompt-search", async () => {
    const order: string[] = [];
    mockEnsureDaemon.mockImplementation(async () => {
      order.push("ensure");
      return { connected: true, port: 3737, spawned: false };
    });
    const mockInsertEvent = vi.fn(() => { order.push("insert"); });
    const mockClose = vi.fn(() => { order.push("close"); });
    MockEventsDb.mockImplementation(function () {
      return eventsDbFixture({
        insertEvent: mockInsertEvent,
        getHealthStats: vi.fn().mockReturnValue({ unprocessed: 1 }),
        close: mockClose,
      });
    });
    mockExtractUserPromptEvents.mockReturnValue([
      { type: "decision", category: "decision", data: "use SQLite", priority: 1 },
    ]);
    vi.mocked(firePromoteEventsNotifyRequest).mockImplementation(() => { order.push("notify"); });
    const mockClient = {
      health: vi.fn(),
      post: vi.fn().mockImplementation(async () => {
        order.push("search");
        return { hints: ["some hint"] };
      }),
    };

    const result = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "we decided to use SQLite", cwd: "/proj", session_id: "s1" }),
      asDaemonClient(mockClient),
    );

    expect(result.exitCode).toBe(0);
    expect(order).toEqual(["insert", "close", "ensure", "notify", "search"]);
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
      return eventsDbFixture({
        insertEvent: mockInsertEvent,
        getHealthStats: vi.fn().mockReturnValue({ unprocessed: 1 }),
        close: mockClose,
      });
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
      asDaemonClient(mockClient),
    );

    expect(mockEnsureProjectDir).toHaveBeenCalledWith("/env-project");
    expect(mockEventsDbPath).toHaveBeenCalledWith("/env-project");
    expect(mockClient.post).toHaveBeenCalledWith("/prompt-search", expect.objectContaining({
      cwd: "/env-project",
    }));
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  it("preserves cwd whitespace for sidecar writes and prompt search", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const mockClose = vi.fn();
    MockEventsDb.mockImplementation(function () {
      return eventsDbFixture({
        insertEvent: vi.fn(),
        getHealthStats: vi.fn().mockReturnValue({ unprocessed: 1 }),
        close: mockClose,
      });
    });
    mockExtractUserPromptEvents.mockReturnValue([
      { type: "decision", category: "decision", data: "use SQLite", priority: 1 },
    ]);
    const mockClient = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: [] }),
    };

    await handleUserPromptSubmit(
      JSON.stringify({ prompt: "we decided to use SQLite", cwd: "  /distinct-project  ", session_id: "s1" }),
      asDaemonClient(mockClient),
    );

    expect(mockEnsureProjectDir).toHaveBeenCalledWith("  /distinct-project  ");
    expect(mockEventsDbPath).toHaveBeenCalledWith("  /distinct-project  ");
    expect(mockClient.post).toHaveBeenCalledWith("/prompt-search", expect.objectContaining({
      cwd: "  /distinct-project  ",
    }));
  });

  it("continues prompt search if daemon notify fails", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    MockEventsDb.mockImplementation(function () {
      return eventsDbFixture({
        insertEvent: vi.fn(),
        getHealthStats: vi.fn().mockReturnValue({ unprocessed: 1 }),
        close: vi.fn(),
      });
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
      asDaemonClient(mockClient),
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
      asDaemonClient(mockClient),
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
      asDaemonClient(mockClient),
    );

    expect(result.stdout).toContain("<!-- surfaced-memory-ids: memory-1 -->");
    expect(result.stdout).not.toContain("memory-2");
  });

  it("emits sanitized remediation for a refused daemon under a missing state root", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-user-prompt-remediation-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(homedir()).toBe(home);
      rmSync(join(home, ".lcm"), { recursive: true, force: true });
      expect(existsSync(join(home, ".lcm"))).toBe(false);
      mockExtractUserPromptEvents.mockReturnValue([]);
      mockEnsureDaemon.mockResolvedValueOnce({
        connected: false,
        port: 3737,
        spawned: false,
        refusalReason: "live-no-response",
      } as never);
      const result = await handleUserPromptSubmit(
        JSON.stringify({ prompt: "hello", cwd: "/proj" }),
        asDaemonClient({ health: vi.fn(), post: vi.fn() }),
      );
      expect(result.stdout).toContain("<learning-instruction>");

      mockEnsureDaemon.mockResolvedValueOnce({
        connected: false,
        port: 3737,
        spawned: false,
        refusalReason: "attacker supplied reason",
      } as never);
      await handleUserPromptSubmit(
        JSON.stringify({ prompt: "hello", cwd: "/proj" }),
        asDaemonClient({ health: vi.fn(), post: vi.fn() }),
      );

      mockEnsureDaemon.mockRejectedValueOnce(new Error("admission failed"));
      await handleUserPromptSubmit(
        JSON.stringify({ prompt: "hello", cwd: "/proj" }),
        asDaemonClient({ health: vi.fn(), post: vi.fn() }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
