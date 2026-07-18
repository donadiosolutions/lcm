import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseCodexTranscript,
  extractCodexSessionCwd,
  findCodexSessionFiles,
  findAllCodexTranscripts,
  type CodexSessionFile,
} from "../src/codex-transcript.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lcm-codex-test-"));
  dirs.push(d);
  return d;
}

function makeSessionLine(role: "user" | "assistant", text: string): string {
  const contentType = role === "user" ? "input_text" : "output_text";
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: contentType, text }],
    },
  });
}

function makeSessionMeta(id: string, cwd: string): string {
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "session_meta",
    payload: { id, cwd, cli_version: "0.100.0", model_provider: "openai" },
  });
}

function makeEventLine(eventType: string): string {
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "event_msg",
    payload: { type: eventType },
  });
}

// ---------------------------------------------------------------------------
// parseCodexTranscript
// ---------------------------------------------------------------------------

describe("parseCodexTranscript", () => {
  it("returns empty array for nonexistent file", () => {
    expect(parseCodexTranscript("/nonexistent/path/session.jsonl")).toEqual([]);
  });

  it("parses user message with input_text block", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(file, makeSessionLine("user", "What is the capital of France?") + "\n");

    const msgs = parseCodexTranscript(file);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("What is the capital of France?");
    expect(msgs[0].tokenCount).toBeGreaterThan(0);
  });

  it("parses assistant message with output_text block", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(file, makeSessionLine("assistant", "Paris is the capital of France.") + "\n");

    const msgs = parseCodexTranscript(file);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].content).toBe("Paris is the capital of France.");
  });

  it("skips session_meta and event_msg lines", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    const content = [
      makeSessionMeta("abc-123", "/some/path"),
      makeEventLine("task_started"),
      makeSessionLine("user", "Hello"),
      makeEventLine("task_completed"),
    ].join("\n");
    writeFileSync(file, content + "\n");

    const msgs = parseCodexTranscript(file);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
  });

  it("skips response_item lines with non-user/assistant roles (developer, system)", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    const devLine = JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Some system instruction" }],
      },
    });
    writeFileSync(file, devLine + "\n" + makeSessionLine("user", "Hello") + "\n");

    const msgs = parseCodexTranscript(file);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
  });

  it("skips lines with empty content after extraction", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    const emptyLine = JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [] },
    });
    writeFileSync(file, emptyLine + "\n");

    expect(parseCodexTranscript(file)).toHaveLength(0);
  });

  it("skips malformed JSON lines without throwing", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(file, "not-json\n" + makeSessionLine("user", "Valid") + "\n");

    const msgs = parseCodexTranscript(file);
    expect(msgs).toHaveLength(1);
  });

  it("handles string content (non-array) in response_item payload", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    const line = JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: "Plain string content" },
    });
    writeFileSync(file, line + "\n");

    const msgs = parseCodexTranscript(file);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Plain string content");
  });

  it("handles malformed payload and every supported content-block shape", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "response_item" }),
      JSON.stringify({ type: "response_item", payload: { type: "message" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            { type: "input_text" },
            { type: "output_text", text: "output" },
            { type: "text", text: "plain" },
            { type: "text", text: 42 },
            { type: "unknown", text: "ignored" },
          ],
        },
      }),
    ].join("\n"));

    expect(parseCodexTranscript(file).map((message) => message.content)).toEqual(["output\nplain"]);
  });

  it("parses a full conversation (multiple turns)", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    const content = [
      makeSessionMeta("sess-1", "/workspace"),
      makeSessionLine("user", "Fix the bug"),
      makeSessionLine("assistant", "I found the issue on line 42."),
      makeEventLine("tool_call"),
      makeSessionLine("user", "Great, thanks!"),
      makeSessionLine("assistant", "You're welcome."),
    ].join("\n");
    writeFileSync(file, content + "\n");

    const msgs = parseCodexTranscript(file);
    expect(msgs).toHaveLength(4);
    expect(msgs.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});

// ---------------------------------------------------------------------------
// extractCodexSessionCwd
// ---------------------------------------------------------------------------

describe("extractCodexSessionCwd", () => {
  it("returns undefined for nonexistent file", () => {
    expect(extractCodexSessionCwd("/nonexistent/path.jsonl")).toBeUndefined();
  });

  it("extracts cwd from session_meta line", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(
      file,
      makeSessionMeta("abc-123", "/Users/pedro/Developer/myproject") + "\n",
    );

    expect(extractCodexSessionCwd(file)).toBe("/Users/pedro/Developer/myproject");
  });

  it("returns undefined when no session_meta line is present", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(file, makeSessionLine("user", "Hello") + "\n");

    expect(extractCodexSessionCwd(file)).toBeUndefined();
  });

  it("returns first session_meta cwd when multiple are present", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(
      file,
      [
        makeSessionMeta("sess-1", "/first/path"),
        makeSessionMeta("sess-2", "/second/path"),
      ].join("\n") + "\n",
    );

    expect(extractCodexSessionCwd(file)).toBe("/first/path");
  });

  it("skips blank, malformed, and incomplete session metadata", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(file, [
      "",
      "not-json",
      JSON.stringify({ type: "session_meta" }),
      JSON.stringify({ type: "session_meta", payload: { cwd: "" } }),
      JSON.stringify({ type: "session_meta", payload: { cwd: 42 } }),
    ].join("\n"));
    expect(extractCodexSessionCwd(file)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findCodexSessionFiles
// ---------------------------------------------------------------------------

describe("findCodexSessionFiles", () => {
  it("returns empty array for nonexistent directory", () => {
    expect(findCodexSessionFiles("/nonexistent")).toEqual([]);
  });

  it("discovers flat .jsonl files", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "session-abc.jsonl"), "");
    writeFileSync(join(dir, "session-def.jsonl"), "");
    writeFileSync(join(dir, "readme.txt"), "");

    const files = findCodexSessionFiles(dir);
    const ids = files.map(f => f.sessionId).sort();
    expect(ids).toEqual(["session-abc", "session-def"]);
  });

  it("discovers nested layout: <dir>/<id>/<id>.jsonl", () => {
    const dir = makeTmpDir();
    const sessionDir = join(dir, "session-xyz");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "session-xyz.jsonl"), "");

    const files = findCodexSessionFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0].sessionId).toBe("session-xyz");
    expect(files[0].path).toBe(join(sessionDir, "session-xyz.jsonl"));
  });

  it("ignores symlinks, missing nested transcripts, and nested non-files", () => {
    const dir = makeTmpDir();
    const target = join(dir, "target.jsonl");
    writeFileSync(target, "");
    symlinkSync(target, join(dir, "linked.jsonl"));
    mkdirSync(join(dir, "missing"));
    mkdirSync(join(dir, "nested-dir"));
    mkdirSync(join(dir, "nested-dir", "nested-dir.jsonl"));
    mkdirSync(join(dir, "nested-link"));
    symlinkSync(target, join(dir, "nested-link", "nested-link.jsonl"));

    expect(findCodexSessionFiles(dir).map((file) => file.sessionId)).toEqual(["target"]);
  });

  it("returns files sorted by mtime ascending", async () => {
    const dir = makeTmpDir();
    const older = join(dir, "old-session.jsonl");
    const newer = join(dir, "new-session.jsonl");
    writeFileSync(newer, "");
    writeFileSync(older, "");
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(older, oldTime, oldTime);

    const files = findCodexSessionFiles(dir);
    expect(files.map(f => f.sessionId)).toEqual(["old-session", "new-session"]);
  });

  it("uses session IDs as a deterministic tie-breaker for equal mtimes", (): void => {
    const dir = makeTmpDir();
    const alpha = join(dir, "alpha-session.jsonl");
    const beta = join(dir, "beta-session.jsonl");
    writeFileSync(beta, "");
    writeFileSync(alpha, "");
    const sameTime = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(alpha, sameTime, sameTime);
    utimesSync(beta, sameTime, sameTime);

    expect(findCodexSessionFiles(dir).map((file: CodexSessionFile): string => file.sessionId)).toEqual([
      "alpha-session",
      "beta-session",
    ]);
  });
});

// ---------------------------------------------------------------------------
// findAllCodexTranscripts
// ---------------------------------------------------------------------------

describe("findAllCodexTranscripts", () => {
  it("returns empty array when codexDir has no sessions", () => {
    const dir = makeTmpDir();
    expect(findAllCodexTranscripts(dir)).toEqual([]);
  });

  it("uses the default Codex home when no directory is supplied", () => {
    expect(findAllCodexTranscripts()).toEqual(expect.any(Array));
  });

  it("collects from archived_sessions/ (flat) and sessions/ (nested)", () => {
    const codexDir = makeTmpDir();

    // archived_sessions flat layout
    const archived = join(codexDir, "archived_sessions");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "rollout-session-1.jsonl"), "");

    // sessions nested layout
    const sessions = join(codexDir, "sessions");
    const sessionDir = join(sessions, "session-2");
    mkdirSync(sessionDir, { recursive: true });
    const activeSession = join(sessionDir, "session-2.jsonl");
    writeFileSync(activeSession, "");

    const sameTime = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(join(archived, "rollout-session-1.jsonl"), sameTime, sameTime);
    utimesSync(activeSession, sameTime, sameTime);

    const files = findAllCodexTranscripts(codexDir);
    const ids = files.map((file: CodexSessionFile): string => file.sessionId);
    expect(ids).toEqual(["rollout-session-1", "session-2"]);
  });

  it("deduplicates sessions present in both archived_sessions and sessions/", () => {
    const codexDir = makeTmpDir();

    const archived = join(codexDir, "archived_sessions");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "dup-session.jsonl"), "archived");

    const sessions = join(codexDir, "sessions");
    const sessionDir = join(sessions, "dup-session");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "dup-session.jsonl"), "active");

    const files = findAllCodexTranscripts(codexDir);
    const matches = files.filter(f => f.sessionId === "dup-session");
    expect(matches).toHaveLength(1);
    // archived_sessions is added first, so it wins
    expect(matches[0].path).toBe(join(archived, "dup-session.jsonl"));
  });

  it("sorts collected transcripts by distinct modification times", () => {
    const codexDir = makeTmpDir();
    const archived = join(codexDir, "archived_sessions");
    mkdirSync(archived, { recursive: true });
    const newer = join(archived, "newer.jsonl");
    const older = join(archived, "older.jsonl");
    writeFileSync(newer, "");
    writeFileSync(older, "");
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(older, oldTime, oldTime);
    expect(findAllCodexTranscripts(codexDir).map((file) => file.sessionId)).toEqual(["older", "newer"]);
  });
});
