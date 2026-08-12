// test/hooks/post-tool.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handlePostToolUse } from "../../src/hooks/post-tool.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectMetaPath } from "../../src/daemon/project.js";
import { eventsDbPath } from "../../src/db/events-path.js";
import { EventsDb } from "../../src/hooks/events-db.js";
import * as eventScrubbing from "../../src/hooks/event-scrubbing.js";
import * as localEnqueue from "../../src/hooks/local-enqueue.js";
import * as projectModule from "../../src/daemon/project.js";
import * as hookErrors from "../../src/hooks/hook-errors.js";
import { BackendPublicationJournalError } from "../../src/storage/backend-publication.js";
import * as backendPublication from "../../src/storage/backend-publication.js";

// Mock eventsDbPath to use temp directory
vi.mock("../../src/db/events-path.js", () => ({
  eventsDbPath: () => join(process.env.TEST_EVENTS_DIR!, "test.db"),
  eventsDir: () => process.env.TEST_EVENTS_DIR!,
}));

describe("handlePostToolUse", () => {
  let dir: string;
  let homeDir: string;
  let extraDirs: string[];
  let originalHome: string | undefined;

  function expectPersistedDecision(inputCwd: string): void {
    const db = new EventsDb(eventsDbPath(inputCwd));
    try {
      expect(db.getUnprocessed()).toEqual([
        expect.objectContaining({
          session_id: "test-session",
          data: expect.stringContaining("Use SQLite?"),
          source_hook: "PostToolUse",
        }),
      ]);
    } finally {
      db.close();
    }
  }

  function readPersistedEvents(inputCwd: string): readonly Record<string, unknown>[] {
    const db = new EventsDb(eventsDbPath(inputCwd));
    try {
      return db.getUnprocessed() as unknown as readonly Record<string, unknown>[];
    } finally {
      db.close();
    }
  }

  async function runNativePersistenceCase(
    payload: Record<string, unknown>,
    includeDefaultClient = true,
  ): Promise<readonly Record<string, unknown>[]> {
    const inputCwd = mkdtempSync(join(tmpdir(), "post-tool-native-cwd-"));
    extraDirs.push(inputCwd);
    process.env.TEST_EVENTS_DIR = inputCwd;
    const request = {
      session_id: "native-codex-session",
      cwd: inputCwd,
      ...payload,
    };
    if (includeDefaultClient && !Object.hasOwn(request, "client")) request.client = "codex";
    await handlePostToolUse(JSON.stringify(request));
    return readPersistedEvents(inputCwd);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "post-tool-test-"));
    homeDir = mkdtempSync(join(tmpdir(), "post-tool-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
    extraDirs = [];
    process.env.TEST_EVENTS_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    for (const extraDir of extraDirs) {
      rmSync(extraDir, { recursive: true, force: true });
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    delete process.env.TEST_EVENTS_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  it("captures AskUserQuestion decision", async () => {
    const stdin = JSON.stringify({
      session_id: "test-session",
      tool_name: "AskUserQuestion",
      tool_input: { question: "Use SQLite?" },
      tool_response: "yes",
    });
    const result = await handlePostToolUse(stdin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("enqueues before selected project metadata and rethrows publication failures after durability", async () => {
    const inputCwd = mkdtempSync(join(tmpdir(), "post-tool-order-cwd-"));
    extraDirs.push(inputCwd);
    const order: string[] = [];
    const append = vi.spyOn(localEnqueue, "appendLocalHookEvents").mockImplementation(async () => {
      order.push("enqueue");
      return { inserted: 1, pendingCount: 1 };
    });
    const ensure = vi.spyOn(projectModule, "ensureProjectDir").mockImplementation(() => {
      order.push("project");
      throw new BackendPublicationJournalError("unresolved-publication", "publication unresolved");
    });
    try {
      await expect(handlePostToolUse(JSON.stringify({
        session_id: "test-session",
        tool_name: "AskUserQuestion",
        cwd: inputCwd,
        tool_input: { question: "Use SQLite?" },
        tool_response: "yes",
      }))).rejects.toBeInstanceOf(BackendPublicationJournalError);
      expect(order).toEqual(["enqueue", "project"]);
      expect(append).toHaveBeenCalledWith(expect.objectContaining({ cwd: inputCwd }));
    } finally {
      append.mockRestore();
      ensure.mockRestore();
    }
  });

  it("fences PostTool project metadata with the coordinator consumer lock after enqueue", async () => {
    const inputCwd = mkdtempSync(join(tmpdir(), "post-tool-fenced-project-cwd-"));
    extraDirs.push(inputCwd);
    const event = { type: "decision", category: "decision", data: "Use SQLite?", priority: 1 } as const;
    const order: string[] = [];
    const scrub = vi.spyOn(eventScrubbing, "scrubExtractedEvents").mockResolvedValue([event]);
    const append = vi.spyOn(localEnqueue, "appendLocalHookEvents").mockImplementation(async () => {
      order.push("enqueue");
      return { inserted: 1, pendingCount: 1 };
    });
    const consumerLock = vi.spyOn(backendPublication, "withBackendPublicationConsumerLock");
    const ensure = vi.spyOn(projectModule, "ensureProjectDir").mockImplementation(() => {
      order.push("project");
      return inputCwd;
    });

    try {
      await expect(handlePostToolUse(JSON.stringify({
        session_id: "test-session",
        tool_name: "AskUserQuestion",
        cwd: inputCwd,
        tool_input: { question: "Use SQLite?" },
        tool_response: "yes",
      }))).resolves.toEqual({ exitCode: 0, stdout: "" });
      expect(order).toEqual(["enqueue", "project"]);
      expect(consumerLock).toHaveBeenCalled();
      expect(append.mock.invocationCallOrder[0]).toBeLessThan(consumerLock.mock.invocationCallOrder[0]!);
      expect(consumerLock.mock.invocationCallOrder[0]).toBeLessThan(ensure.mock.invocationCallOrder[0]!);
    } finally {
      scrub.mockRestore();
      append.mockRestore();
      consumerLock.mockRestore();
      ensure.mockRestore();
    }
  });

  it("uses built-in scrubbing when publication-aware scrubbing is unavailable", async () => {
    const inputCwd = mkdtempSync(join(tmpdir(), "post-tool-scrub-cwd-"));
    extraDirs.push(inputCwd);
    const event = { type: "decision", category: "decision", data: "Use SQLite?", priority: 1 } as const;
    const publicationError = new BackendPublicationJournalError("malformed-journal", "publication journal is malformed");
    const scrub = vi.spyOn(eventScrubbing, "scrubExtractedEvents")
      .mockRejectedValueOnce(publicationError)
      .mockResolvedValueOnce([event]);
    const append = vi.spyOn(localEnqueue, "appendLocalHookEvents").mockResolvedValue({ inserted: 1, pendingCount: 1 });
    const ensure = vi.spyOn(projectModule, "ensureProjectDir").mockImplementation(() => inputCwd);
    try {
      await expect(handlePostToolUse(JSON.stringify({
        session_id: "test-session",
        tool_name: "AskUserQuestion",
        cwd: inputCwd,
        tool_input: { question: "Use SQLite?" },
        tool_response: "yes",
      }))).resolves.toEqual({ exitCode: 0, stdout: "" });
      expect(scrub).toHaveBeenLastCalledWith(expect.any(Array), inputCwd, []);
      expect(append).toHaveBeenCalledWith(expect.objectContaining({ events: [event] }));
    } finally {
      scrub.mockRestore();
      append.mockRestore();
      ensure.mockRestore();
    }
  });

  it("logs ordinary scrubbing failures without treating them as publication control flow", async () => {
    const inputCwd = mkdtempSync(join(tmpdir(), "post-tool-scrub-error-cwd-"));
    extraDirs.push(inputCwd);
    const scrub = vi.spyOn(eventScrubbing, "scrubExtractedEvents").mockRejectedValueOnce(new Error("scrub failed"));
    const log = vi.spyOn(hookErrors, "safeLogError").mockResolvedValueOnce(undefined);
    try {
      await expect(handlePostToolUse(JSON.stringify({
        session_id: "test-session",
        tool_name: "AskUserQuestion",
        cwd: inputCwd,
        tool_input: { question: "Use SQLite?" },
        tool_response: "yes",
      }))).resolves.toEqual({ exitCode: 0, stdout: "" });
      expect(log).toHaveBeenCalledWith("PostToolUse", expect.any(Error), { cwd: inputCwd });
    } finally {
      scrub.mockRestore();
      log.mockRestore();
    }
  });

  it("returns empty stdout (PostToolUse hooks don't produce output)", async () => {
    const stdin = JSON.stringify({
      session_id: "test-session",
      tool_name: "Read",
      tool_input: { file_path: "/some/file.ts" },
    });
    const result = await handlePostToolUse(stdin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits gracefully on invalid stdin", async () => {
    const result = await handlePostToolUse("not json");
    expect(result.exitCode).toBe(0); // silent fail
  });

  it("skips sensitive file paths", async () => {
    const stdin = JSON.stringify({
      session_id: "test-session",
      tool_name: "Read",
      tool_input: { file_path: "/project/.env" },
    });
    const result = await handlePostToolUse(stdin);
    expect(result.exitCode).toBe(0);
  });

  it("falls back to CLAUDE_PROJECT_DIR when input cwd is empty", async () => {
    const envCwd = mkdtempSync(join(tmpdir(), "post-tool-env-cwd-"));
    extraDirs.push(envCwd);
    process.env.CLAUDE_PROJECT_DIR = envCwd;

    const stdin = JSON.stringify({
      session_id: "test-session",
      tool_name: "Read",
      cwd: "",
      tool_input: { file_path: join(envCwd, "src/main.ts") },
    });
    const result = await handlePostToolUse(stdin);

    expect(result.exitCode).toBe(0);
    expect(existsSync(projectMetaPath(envCwd))).toBe(true);
    expect(JSON.parse(readFileSync(projectMetaPath(envCwd), "utf-8")).cwd).toBe(envCwd);
  });

  it("preserves surrounding whitespace in the selected cwd", async () => {
    const parent = mkdtempSync(join(tmpdir(), "post-tool-input-cwd-"));
    const inputCwd = join(parent, " project ");
    mkdirSync(inputCwd);
    extraDirs.push(parent);

    const stdin = JSON.stringify({
      session_id: "test-session",
      tool_name: "Read",
      cwd: inputCwd,
      tool_input: { file_path: join(inputCwd, "src/main.ts") },
    });
    const result = await handlePostToolUse(stdin);

    expect(result.exitCode).toBe(0);
    expect(existsSync(projectMetaPath(inputCwd))).toBe(true);
    expect(JSON.parse(readFileSync(projectMetaPath(inputCwd), "utf-8")).cwd).toBe(inputCwd);
  });

  it("persists captured passive events without trusting a payload daemon port", async () => {
    const inputCwd = mkdtempSync(join(tmpdir(), "post-tool-notify-cwd-"));
    extraDirs.push(inputCwd);

    await handlePostToolUse(JSON.stringify({
      session_id: "test-session",
      tool_name: "AskUserQuestion",
      cwd: inputCwd,
      daemon_port: 4567,
      tool_input: { question: "Use SQLite?" },
      tool_response: "yes",
    }));

    expectPersistedDecision(inputCwd);
  });

  it.each([
    {
      name: "functions.exec command Git event",
      tool_name: "functions.exec",
      tool_input: { command: "git branch capture-test" },
      expected: { type: "git_branch", category: "git", data: "git branch", priority: 2 },
    },
    {
      name: "functions.exec_command cmd environment event",
      tool_name: "functions.exec_command",
      tool_input: { cmd: "npm install capture-test" },
      expected: { type: "env_install", category: "env", data: "npm install capture-test", priority: 2 },
    },
    {
      name: "functions.exec isError error event",
      tool_name: "functions.exec",
      tool_input: { command: "git branch capture-test" },
      tool_output: { isError: true },
      expected: { type: "error_tool", category: "error", data: "Bash error: git branch capture-test", priority: 1 },
    },
    {
      name: "functions.exec_command is_error error event",
      tool_name: "functions.exec_command",
      tool_input: { cmd: "npm install capture-test" },
      tool_output: { is_error: true },
      expected: { type: "error_tool", category: "error", data: "Bash error: npm install capture-test", priority: 1 },
    },
    {
      name: "functions.exec nonzero exit_code error event",
      tool_name: "functions.exec",
      tool_input: { command: "git branch capture-test" },
      tool_response: { exit_code: 2 },
      expected: { type: "error_tool", category: "error", data: "Bash error: git branch capture-test", priority: 1 },
    },
    {
      name: "functions.exec_command nonzero exitCode error event",
      tool_name: "functions.exec_command",
      tool_input: { cmd: "npm install capture-test" },
      tool_response: { exitCode: 2 },
      expected: { type: "error_tool", category: "error", data: "Bash error: npm install capture-test", priority: 1 },
    },
    {
      name: "functions.exec zero exit_code normal event",
      tool_name: "functions.exec",
      tool_input: { command: "git branch capture-test" },
      tool_output: { exit_code: 0 },
      expected: { type: "git_branch", category: "git", data: "git branch", priority: 2 },
    },
    {
      name: "functions.exec_command zero exitCode normal event",
      tool_name: "functions.exec_command",
      tool_input: { cmd: "npm install capture-test" },
      tool_response: { exitCode: 0 },
      expected: { type: "env_install", category: "env", data: "npm install capture-test", priority: 2 },
    },
    {
      name: "functions.exec output status takes precedence over response status",
      tool_name: "functions.exec",
      tool_input: { command: "git branch capture-test", cmd: "npm install ignored" },
      tool_output: { isError: false, is_error: true, exit_code: 2, exitCode: 3 },
      tool_response: { isError: true },
      expected: { type: "git_branch", category: "git", data: "git branch", priority: 2 },
    },
    {
      name: "functions.exec response field precedence uses isError before aliases and codes",
      tool_name: "functions.exec",
      tool_input: { command: "git branch capture-test" },
      tool_response: { isError: true, is_error: false, exit_code: 0, exitCode: 0 },
      expected: { type: "error_tool", category: "error", data: "Bash error: git branch capture-test", priority: 1 },
    },
  ] as const)("persists native Codex $name through EventsDb", async ({ expected, ...payload }) => {
    const rows = await runNativePersistenceCase(payload);
    expect(rows).toEqual([
      expect.objectContaining({
        session_id: "native-codex-session",
        source_hook: "PostToolUse",
        ...expected,
      }),
    ]);
  });

  it.each([
    { name: "functions.exec success", tool_name: "functions.exec", tool_input: { command: "lcm store capture-test" } },
    { name: "functions.exec error", tool_name: "functions.exec", tool_input: { command: "lcm store capture-test" }, tool_output: { isError: true } },
    { name: "functions.exec_command success", tool_name: "functions.exec_command", tool_input: { cmd: "lcm store capture-test" } },
    { name: "functions.exec_command error", tool_name: "functions.exec_command", tool_input: { cmd: "lcm store capture-test" }, tool_response: { exitCode: 1 } },
  ] as const)("does not persist native Codex lcm-store feedback loop: $name", async (payload) => {
    expect(await runNativePersistenceCase(payload)).toEqual([]);
  });

  it("does not persist raw native output, response, or secret sentinels", async () => {
    const rows = await runNativePersistenceCase({
      tool_name: "functions.exec_command",
      tool_input: { cmd: "npm install capture-test" },
      tool_output: {
        isError: true,
        stdout: "RAW_STDOUT_SECRET",
        stderr: "RAW_STDERR_SECRET",
        secret: "RAW_OUTPUT_SECRET",
      },
      tool_response: {
        isError: true,
        stdout: "RAW_RESPONSE_STDOUT_SECRET",
        stderr: "RAW_RESPONSE_STDERR_SECRET",
      },
    });
    expect(rows).toEqual([
      expect.objectContaining({
        type: "error_tool",
        data: "Bash error: npm install capture-test",
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain("RAW_");
  });

  it.each([
    { name: "unknown native function", tool_name: "functions.unknown", tool_input: { command: "git branch capture-test" } },
    { name: "malformed command object", tool_name: "functions.exec", tool_input: "not an object" },
    { name: "missing command", tool_name: "functions.exec_command", tool_input: { unrelated: "value" } },
    { name: "non-Codex native function", client: "claude", tool_name: "functions.exec", tool_input: { command: "git branch capture-test" } },
    { name: "missing client native function", tool_name: "functions.exec", tool_input: { command: "git branch capture-test" } },
  ] as const)("does not persist unsupported native input: $name", async ({ client: _client, ...payload }) => {
    const rows = await runNativePersistenceCase(
      { ...payload, ...(_client === undefined ? {} : { client: _client }) },
      _client !== undefined,
    );
    expect(rows).toEqual([]);
  });

  it.each([
    { name: "missing session ID", payload: { client: "codex", tool_name: "functions.exec", tool_input: { command: "git branch capture-test" } } },
    { name: "numeric session ID", payload: { session_id: 42, client: "codex", tool_name: "functions.exec", tool_input: { command: "git branch capture-test" } } },
    { name: "null session ID", payload: { session_id: null, client: "codex", tool_name: "functions.exec", tool_input: { command: "git branch capture-test" } } },
    { name: "malformed JSON", raw: "not json" },
    { name: "null JSON", raw: "null" },
    { name: "array JSON", raw: "[]" },
  ] as const)("does not persist invalid PostToolUse identity or shape: $name", async ({ payload, raw }) => {
    const inputCwd = mkdtempSync(join(tmpdir(), "post-tool-invalid-native-cwd-"));
    extraDirs.push(inputCwd);
    process.env.TEST_EVENTS_DIR = inputCwd;
    await handlePostToolUse(raw ?? JSON.stringify({ cwd: inputCwd, ...payload }));
    expect(readPersistedEvents(inputCwd)).toEqual([]);
  });

  it("uses persisted scrub patterns when PostgreSQL secrets are not staged yet", async () => {
    const inputCwd = mkdtempSync(join(tmpdir(), "post-tool-postgresql-cwd-"));
    extraDirs.push(inputCwd);
    const configDir = join(homeDir, ".lcm");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
      storage: { backend: "postgresql" },
      security: { sensitivePatterns: ["SQLite"] },
    }), { mode: 0o600 });

    await handlePostToolUse(JSON.stringify({
      session_id: "test-session",
      tool_name: "AskUserQuestion",
      cwd: inputCwd,
      tool_input: { question: "Use SQLite?" },
      tool_response: "yes",
    }));

    const db = new EventsDb(eventsDbPath(inputCwd));
    try {
      expect(db.getUnprocessed()[0]?.data).toContain("Use [REDACTED]?");
    } finally {
      db.close();
    }
  });

  it("ignores daemon_port values even when a caller also supplies a port", async () => {
    const inputCwd = mkdtempSync(join(tmpdir(), "post-tool-invalid-port-cwd-"));
    extraDirs.push(inputCwd);

    await handlePostToolUse(JSON.stringify({
      session_id: "test-session",
      tool_name: "AskUserQuestion",
      cwd: inputCwd,
      daemon_port: "4567",
      tool_input: { question: "Use SQLite?" },
      tool_response: "yes",
    }), 4568);

    expectPersistedDecision(inputCwd);
  });

  it("ignores a non-boolean tool output error marker", async () => {
    const inputCwd = mkdtempSync(join(tmpdir(), "post-tool-output-cwd-"));
    extraDirs.push(inputCwd);

    const result = await handlePostToolUse(JSON.stringify({
      session_id: "test-session",
      tool_name: "AskUserQuestion",
      cwd: inputCwd,
      tool_input: { question: "Use SQLite?" },
      tool_response: "yes",
      tool_output: { isError: "false" },
    }));

    expect(result.exitCode).toBe(0);
  });

  it("handles invalid payload shapes and default cwd/port paths", async () => {
    expect(await handlePostToolUse(JSON.stringify({ session_id: "s1" }))).toEqual({ exitCode: 0, stdout: "" });
    expect(await handlePostToolUse(JSON.stringify({ tool_name: "Read" }))).toEqual({ exitCode: 0, stdout: "" });
    expect(await handlePostToolUse(JSON.stringify({ session_id: "s1", tool_name: "Read", tool_input: [] })))
      .toEqual({ exitCode: 0, stdout: "" });
    expect(await handlePostToolUse(JSON.stringify({
      session_id: "s1", tool_name: "AskUserQuestion", tool_input: {}, tool_output: { isError: true }, daemon_port: 0,
    }))).toEqual({ exitCode: 0, stdout: "" });
  });
});
