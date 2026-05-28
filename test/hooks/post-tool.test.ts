// test/hooks/post-tool.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handlePostToolUse } from "../../src/hooks/post-tool.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectMetaPath } from "../../src/daemon/project.js";

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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "post-tool-test-"));
    homeDir = mkdtempSync(join(tmpdir(), "post-tool-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
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
});
