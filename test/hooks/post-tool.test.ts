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
