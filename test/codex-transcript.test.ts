import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, renameSync, writeFileSync, mkdirSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  LCM_RESTORATION_MARKER,
  readLiveCodexRestoration,
  scanLiveCodexRestoration,
  parseCodexTranscript,
  parseCodexTranscriptText,
  readCodexInheritedBoundary,
  parseCodexCopiedForkMessages,
  readCodexSessionParent,
  isInheritedSubagentRecord,
  extractCodexSessionCwd,
  extractCodexSessionMeta,
  findCodexSessionFiles,
  findAllCodexTranscripts,
  type CodexSessionFile,
} from "../src/codex-transcript.js";

// Test seam: runs a callback just before the module under test resolves a
// path, so a race between its open and its containment check is deterministic.
const fsSeam = vi.hoisted(() => ({
  beforeRealpath: undefined as ((path: string) => void) | undefined,
  beforeRead: undefined as (() => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realpathSync = ((path: string, options?: never) => {
    fsSeam.beforeRealpath?.(String(path));
    return actual.realpathSync(path, options);
  }) as typeof actual.realpathSync;
  realpathSync.native = actual.realpathSync.native;
  const readSync = ((...args: Parameters<typeof actual.readSync>) => {
    fsSeam.beforeRead?.();
    return actual.readSync(...args);
  }) as typeof actual.readSync;
  return { ...actual, realpathSync, readSync };
});

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

  it("extracts bounded thread and Git metadata without reading the conversation", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(file, `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: "thread",
        cwd: "/workspace",
        git: {
          repository_url: "https://example.invalid/repository.git",
          commit_hash: "abc123",
          branch: "feature",
        },
      },
    })}\n${"x".repeat(300 * 1024)}`);
    expect(extractCodexSessionMeta(file)).toEqual({
      threadId: "thread",
      cwd: "/workspace",
      repositoryUrl: "https://example.invalid/repository.git",
      commit: "abc123",
      branch: "feature",
    });
  });

  it("rejects unsafe leaves and empty or invalid metadata fields", () => {
    const dir = makeTmpDir();
    const target = join(dir, "target.jsonl");
    writeFileSync(target, "{}\n");
    symlinkSync(target, join(dir, "linked.jsonl"));
    mkdirSync(join(dir, "directory.jsonl"));
    expect(extractCodexSessionMeta(join(dir, "linked.jsonl"))).toBeUndefined();
    expect(extractCodexSessionMeta(join(dir, "directory.jsonl"))).toBeUndefined();

    const invalid = join(dir, "invalid.jsonl");
    writeFileSync(invalid, [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "",
          cwd: 42,
          git: { repository_url: "", commit_hash: 1, branch: "" },
        },
      }),
    ].join("\n"));
    expect(extractCodexSessionMeta(invalid)).toBeUndefined();

    const nullPayload = join(dir, "null.jsonl");
    writeFileSync(nullPayload, JSON.stringify({ type: "session_meta", payload: null }));
    expect(extractCodexSessionMeta(nullPayload)).toBeUndefined();

    const late = join(dir, "late.jsonl");
    writeFileSync(late, `${" ".repeat(256 * 1024)}\n${makeSessionMeta("late", "/late")}`);
    expect(extractCodexSessionMeta(late)).toBeUndefined();
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
    const sessionsRoot = join(homedir(), ".codex", "sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    const sessionDir = mkdtempSync(join(sessionsRoot, "coverage-default-"));
    dirs.push(sessionDir);
    const sessionId = basename(sessionDir);
    writeFileSync(join(sessionDir, `${sessionId}.jsonl`), "");

    expect(findAllCodexTranscripts().map((file) => file.sessionId)).toContain(sessionId);
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

  it("collects active date-partitioned rollout transcripts without traversing symlinks", () => {
    const codexDir = makeTmpDir();
    const day = join(codexDir, "sessions", "2026", "07", "25");
    mkdirSync(day, { recursive: true });
    const rollout = "rollout-2026-07-25T10-00-00-thread.jsonl";
    writeFileSync(join(day, rollout), "");
    writeFileSync(join(day, "not-a-rollout.jsonl"), "");
    mkdirSync(join(day, "rollout-directory.jsonl"));
    mkdirSync(join(codexDir, "sessions", "2026", "invalid-month"));
    const outside = join(codexDir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "rollout-outside.jsonl"), "");
    symlinkSync(outside, join(codexDir, "sessions", "2026", "07", "26"));

    expect(findAllCodexTranscripts(codexDir).map((file) => file.sessionId))
      .toContain(rollout.slice(0, -".jsonl".length));
    expect(findAllCodexTranscripts(codexDir).map((file) => file.sessionId))
      .not.toContain("rollout-outside");
  });

  it("deduplicates an archived transcript that overlaps an active rollout", () => {
    const codexDir = makeTmpDir();
    const sessionId = "rollout-2026-07-25T10-00-00-duplicate";
    const archived = join(codexDir, "archived_sessions");
    const day = join(codexDir, "sessions", "2026", "07", "25");
    mkdirSync(archived, { recursive: true });
    mkdirSync(day, { recursive: true });
    writeFileSync(join(archived, `${sessionId}.jsonl`), "archived");
    writeFileSync(join(day, `${sessionId}.jsonl`), "active");

    const matches = findAllCodexTranscripts(codexDir)
      .filter((file) => file.sessionId === sessionId);
    expect(matches).toEqual([expect.objectContaining({
      path: join(archived, `${sessionId}.jsonl`),
    })]);
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

// ---------------------------------------------------------------------------
// Inherited subagent history
// ---------------------------------------------------------------------------

describe("inherited subagent history", () => {
  const meta = (payload: Record<string, unknown>): string => JSON.stringify({ type: "session_meta", payload });
  const record = (ordinal: unknown, role: "user" | "assistant", text: string): string => JSON.stringify({
    type: "response_item",
    ...(ordinal === undefined ? {} : { ordinal }),
    payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
  });
  const join_ = (...lines: string[]): string => lines.join("\n") + "\n";

  it.each([
    ["a paginated start", { subagent_history_start_ordinal: 3, history_mode: "paginated" }, { kind: "ordinal", start: 3, paginated: true }],
    ["a zero start", { subagent_history_start_ordinal: 0, history_mode: "paginated" }, { kind: "ordinal", start: 0, paginated: true }],
    ["a legacy mode", { subagent_history_start_ordinal: 3, history_mode: "legacy" }, { kind: "ordinal", start: 3, paginated: false }],
    ["a missing mode", { subagent_history_start_ordinal: 3 }, { kind: "ordinal", start: 3, paginated: false }],
    ["a mode that is not exactly paginated", { subagent_history_start_ordinal: 3, history_mode: "Paginated" }, { kind: "ordinal", start: 3, paginated: false }],
  ])("reads %s", (_name, payload, expected) => {
    expect(readCodexInheritedBoundary(join_("", "  ", meta(payload)))).toEqual(expected);
    expect(readCodexInheritedBoundary(meta(payload))).toEqual(expected);
  });

  it.each([
    ["no start", { history_mode: "paginated" }],
    ["a string start", { subagent_history_start_ordinal: "3" }],
    ["a negative start", { subagent_history_start_ordinal: -1 }],
    ["a fractional start", { subagent_history_start_ordinal: 1.5 }],
    ["an unsafe start", { subagent_history_start_ordinal: 2 ** 60 }],
    ["a null start", { subagent_history_start_ordinal: null }],
  ])("ignores %s", (_name, payload) => {
    expect(readCodexInheritedBoundary(meta(payload))).toBeUndefined();
  });

  it("reads a session's own id and immediate parent independent of any history boundary", () => {
    const payload = { id: "child", parent_thread_id: "parent" };
    expect(readCodexSessionParent(join_("", "  ", meta(payload)))).toEqual({ id: "child", parentThreadId: "parent" });
    expect(readCodexSessionParent(meta({ ...payload, subagent_history_start_ordinal: 3 })))
      .toEqual({ id: "child", parentThreadId: "parent" });
  });

  it("returns no parent unless the first record is a session_meta with string id and parent", () => {
    const good = meta({ id: "child", parent_thread_id: "parent" });
    expect(readCodexSessionParent("")).toBeUndefined();
    expect(readCodexSessionParent(join_("{broken", good))).toBeUndefined();
    expect(readCodexSessionParent(join_(record(0, "user", "x"), good))).toBeUndefined();
    expect(readCodexSessionParent(JSON.stringify({ type: "session_meta", payload: "x" }))).toBeUndefined();
    expect(readCodexSessionParent(meta({ parent_thread_id: "parent" }))).toBeUndefined();
    expect(readCodexSessionParent(meta({ id: 1, parent_thread_id: "parent" }))).toBeUndefined();
    expect(readCodexSessionParent(meta({ id: "child" }))).toBeUndefined();
    expect(readCodexSessionParent(meta({ id: "child", parent_thread_id: null }))).toBeUndefined();
    expect(readCodexSessionParent(join_(meta({ id: "child" }), good))).toBeUndefined();
  });

  it("reads only the first non-blank record", () => {
    const good = meta({ subagent_history_start_ordinal: 2 });
    expect(readCodexInheritedBoundary("")).toBeUndefined();
    expect(readCodexInheritedBoundary("\n  \n")).toBeUndefined();
    expect(readCodexInheritedBoundary(join_(record(0, "user", "x"), good))).toBeUndefined();
    expect(readCodexInheritedBoundary(join_("{broken", good))).toBeUndefined();
    expect(readCodexInheritedBoundary(join_("[]", good))).toBeUndefined();
    expect(readCodexInheritedBoundary(join_("null", good))).toBeUndefined();
    expect(readCodexInheritedBoundary(JSON.stringify({ type: "session_meta", payload: "x" }))).toBeUndefined();
    expect(readCodexInheritedBoundary(JSON.stringify({ type: "session_meta", payload: [] }))).toBeUndefined();
    expect(readCodexInheritedBoundary(join_(meta({}), good))).toBeUndefined();
  });

  it("classifies records by numeric ordinal only", () => {
    const paginated = { kind: "ordinal", start: 2, paginated: true } as const;
    const legacy = { kind: "ordinal", start: 2, paginated: false } as const;
    expect(isInheritedSubagentRecord({ ordinal: 1 }, undefined, 0)).toBe(false);
    expect(isInheritedSubagentRecord({ ordinal: 1 }, paginated, 9)).toBe(true);
    expect(isInheritedSubagentRecord({ ordinal: 2 }, paginated, 0)).toBe(false);
    expect(isInheritedSubagentRecord({ ordinal: 3 }, paginated, 0)).toBe(false);
    expect(isInheritedSubagentRecord({ ordinal: 1 }, legacy, 9)).toBe(true);
    for (const malformed of [{}, { ordinal: "0" }, { ordinal: -1 }, { ordinal: 0.5 }, { ordinal: null }, null, [], "x"]) {
      expect(isInheritedSubagentRecord(malformed, paginated, 0)).toBe(true);
      expect(isInheritedSubagentRecord(malformed, legacy, 0)).toBe(false);
    }
  });

  it("drops the inherited prefix only when asked, keeping the boundary ordinal", () => {
    const raw = join_(
      meta({ subagent_history_start_ordinal: 2, history_mode: "paginated" }),
      record(0, "user", "parent 1"),
      record(1, "assistant", "parent 2"),
      record(2, "user", "own 1"),
      record(3, "assistant", "own 2"),
    );
    expect(parseCodexTranscriptText(raw).map((m) => m.content)).toEqual(["parent 1", "parent 2", "own 1", "own 2"]);
    expect(parseCodexTranscriptText(raw, {}).map((m) => m.content)).toHaveLength(4);
    expect(parseCodexTranscriptText(raw, { excludeInheritedSubagentHistory: true }).map((m) => m.content))
      .toEqual(["own 1", "own 2"]);
    expect(parseCodexTranscriptText(raw, { excludeInheritedSubagentHistory: false })).toHaveLength(4);
  });

  it("leaves a rollout without a boundary unchanged even when asked", () => {
    const raw = join_(meta({ id: "root" }), record(0, "user", "one"), record(undefined, "assistant", "two"));
    expect(parseCodexTranscriptText(raw, { excludeInheritedSubagentHistory: true })).toEqual(parseCodexTranscriptText(raw));
  });
});

// ---------------------------------------------------------------------------
// Copied user forks (#1578)
// ---------------------------------------------------------------------------

describe("copied user fork history", () => {
  const meta = (payload: Record<string, unknown> = {}): string => JSON.stringify({
    type: "session_meta", payload: { id: "child", forked_from_id: "parent", ...payload },
  });
  const settings = (threadId?: unknown): string => JSON.stringify({
    type: "event_msg",
    payload: { type: "thread_settings_applied", ...(threadId === undefined ? {} : { thread_id: threadId }) },
  });
  const message = (role: "user" | "assistant", text: string, ordinal?: number): string => JSON.stringify({
    type: "response_item",
    ...(ordinal === undefined ? {} : { ordinal }),
    payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
  });
  const join_ = (...lines: string[]): string => lines.join("\n") + "\n";
  const contents = (messages: { content: string }[]): string[] => messages.map((m) => m.content);

  it("cuts at the first settings event of the fork's own thread", () => {
    const raw = join_(
      meta(),
      message("user", "parent 1"),
      settings("parent"),
      message("assistant", "parent 2"),
      settings("child"),
      message("user", "child 1"),
      settings("child"),
      message("assistant", "child 2"),
    );
    expect(readCodexInheritedBoundary(raw)).toEqual({ kind: "copied-fork", startRecord: 4 });
    expect(contents(parseCodexTranscriptText(raw))).toEqual(["parent 1", "parent 2", "child 1", "child 2"]);
    expect(contents(parseCodexTranscriptText(raw, { excludeInheritedSubagentHistory: true })))
      .toEqual(["child 1", "child 2"]);
  });

  it("is pending until the fork writes its own settings event", () => {
    const withParentSettings = join_(meta(), message("user", "parent 1"), settings("parent"));
    expect(readCodexInheritedBoundary(withParentSettings)).toEqual({ kind: "copied-fork", pending: true });
    expect(readCodexInheritedBoundary(join_(meta()))).toEqual({ kind: "copied-fork", pending: true });
    expect(parseCodexTranscriptText(withParentSettings, { excludeInheritedSubagentHistory: true })).toEqual([]);
    expect(parseCodexTranscriptText(withParentSettings)).toHaveLength(1);
  });

  it("classifies by position and ignores the record's own ordinal", () => {
    const cut = { kind: "copied-fork", startRecord: 2 } as const;
    const pending = { kind: "copied-fork", pending: true } as const;
    expect(isInheritedSubagentRecord({ ordinal: 9 }, cut, 1)).toBe(true);
    expect(isInheritedSubagentRecord({ ordinal: 0 }, cut, 2)).toBe(false);
    expect(isInheritedSubagentRecord(undefined, cut, 3)).toBe(false);
    expect(isInheritedSubagentRecord({ ordinal: 99 }, pending, 99)).toBe(true);
  });

  it("lets a valid subagent ordinal win and falls through from a malformed one", () => {
    const body = [message("user", "parent", 0), settings("child"), message("assistant", "own", 1)];
    expect(readCodexInheritedBoundary(join_(meta({ subagent_history_start_ordinal: 1 }), ...body)))
      .toEqual({ kind: "ordinal", start: 1, paginated: false });
    // The ordinal cut keeps "own" and drops "parent"; the settings cut agrees on the last message only.
    expect(contents(parseCodexTranscriptText(join_(meta({ subagent_history_start_ordinal: 2 }), ...body), {
      excludeInheritedSubagentHistory: true,
    }))).toEqual([]);
    for (const bad of ["1", -1, 1.5, null, 2 ** 60]) {
      expect(readCodexInheritedBoundary(join_(meta({ subagent_history_start_ordinal: bad }), ...body)))
        .toEqual({ kind: "copied-fork", startRecord: 2 });
    }
  });

  it.each([
    ["a session that was not forked", { forked_from_id: undefined }],
    ["an empty fork parent", { forked_from_id: "" }],
    ["a non-string fork parent", { forked_from_id: 4 }],
    ["a session forked from itself", { forked_from_id: "child" }],
    ["a missing id", { id: undefined }],
    ["an empty id", { id: "" }],
    ["a referenced fork", { history_base: "parent" }],
    ["an object history base", { history_base: {} }],
  ])("keeps the full parse for %s", (_name, payload) => {
    const raw = join_(meta(payload), message("user", "parent"), settings("child"), message("assistant", "child"));
    expect(readCodexInheritedBoundary(raw)).toBeUndefined();
    expect(contents(parseCodexTranscriptText(raw, { excludeInheritedSubagentHistory: true })))
      .toEqual(["parent", "child"]);
  });

  it("accepts a null history base", () => {
    expect(readCodexInheritedBoundary(join_(meta({ history_base: null }), settings("child"))))
      .toEqual({ kind: "copied-fork", startRecord: 1 });
  });

  it.each([
    ["no thread", undefined],
    ["an empty thread", ""],
    ["a numeric thread", 7],
  ])("keeps the full parse when an earlier settings event has %s", (_name, threadId) => {
    const raw = join_(meta(), message("user", "parent"), settings(threadId), settings("child"), message("assistant", "child"));
    expect(readCodexInheritedBoundary(raw)).toBeUndefined();
    // The same event also blocks the pending reading.
    expect(readCodexInheritedBoundary(join_(meta(), settings(threadId)))).toBeUndefined();
  });

  it("ignores settings events after the child's and non-settings events before it", () => {
    const raw = join_(
      meta(),
      JSON.stringify({ type: "event_msg", payload: { type: "other", thread_id: "child" } }),
      JSON.stringify({ type: "event_msg", payload: "x" }),
      JSON.stringify({ type: "turn_context", payload: { type: "thread_settings_applied", thread_id: "child" } }),
      settings("child"),
      settings(undefined),
    );
    expect(readCodexInheritedBoundary(raw)).toEqual({ kind: "copied-fork", startRecord: 4 });
  });

  it("requires the first counted line to be the session_meta", () => {
    const body = [settings("child"), message("user", "x")];
    for (const first of ["{broken", "null", "[]", message("user", "p"), JSON.stringify({ type: "session_meta", payload: "x" }), JSON.stringify({ type: "session_meta", payload: [] })]) {
      expect(readCodexInheritedBoundary(join_(first, meta(), ...body))).toBeUndefined();
    }
    expect(readCodexInheritedBoundary("")).toBeUndefined();
    expect(readCodexInheritedBoundary("\n\t \r\n")).toBeUndefined();
    expect(readCodexInheritedBoundary(join_("\uFEFF" + meta(), ...body))).toEqual({ kind: "copied-fork", startRecord: 1 });
  });

  it("counts lines the way the native reader does", () => {
    const parentLines = [
      "\u000b",
      "\u00a0",
      "{broken",
      "null",
      "[]",
      "7",
      '{"a":1,"a":2}',
      "x".repeat(10 * 1024 * 1024 + 1),
      " ".repeat(10 * 1024 * 1024 + 1),
    ];
    // Tab, carriage return and space are blank; everything else takes one position.
    const raw = "\n" + meta() + "\n \t\r\n\r\n" + parentLines.join("\n") + "\n" + settings("child") + "\n" + message("user", "child");
    expect(readCodexInheritedBoundary(raw)).toEqual({ kind: "copied-fork", startRecord: 1 + parentLines.length + 1 - 1 });
    expect(contents(parseCodexTranscriptText(raw, { excludeInheritedSubagentHistory: true }))).toEqual(["child"]);
  });

  it("walks a copied fork without failing on lines that are not records", () => {
    const cut = { kind: "copied-fork", startRecord: 1 } as const;
    const raw = join_("null", "{broken", "7", "[]", message("user", "kept"), message("assistant", "reply"), JSON.stringify({ type: "response_item", payload: { type: "message", role: "tool" } }));
    expect(contents(parseCodexCopiedForkMessages(raw, cut))).toEqual(["kept", "reply"]);
    expect(() => parseCodexTranscriptText(raw)).toThrow(TypeError);
    expect(parseCodexCopiedForkMessages(raw, { kind: "copied-fork", pending: true })).toEqual([]);
  });

  it("classifies from the raw record, so a settings event is found whatever else it carries", () => {
    const raw = join_(
      meta(),
      message("user", "parent"),
      JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_id: "child", extra: { deep: [1] } } }),
      message("assistant", "child"),
    );
    expect(contents(parseCodexTranscriptText(raw, { excludeInheritedSubagentHistory: true }))).toEqual(["child"]);
  });
});

// ---------------------------------------------------------------------------
// Interrupted turns (#1561): what a rollout written around an Interrupt hook
// exposes to the parser. Codex writes the <turn_aborted> marker before it runs
// the hook and emits the TurnAborted event only afterwards; the marker's role
// is user by default and developer for multi-agent v2. Only user/assistant
// response messages are parsed (and so searchable); everything else is kept
// only by the raw native archive.
// ---------------------------------------------------------------------------

const ABORT_MARKER = "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>";

function makeRoleLine(role: "user" | "assistant" | "developer", text: string): string {
  return role === "assistant" ? makeSessionLine("assistant", text) : JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  });
}

function makeTurnAbortedEvent(): string {
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: "turn-1", reason: "interrupted" },
  });
}

describe("parseCodexTranscript around an interrupted turn", () => {
  const parse = (...lines: string[]) => {
    const file = join(makeTmpDir(), "rollout.jsonl");
    writeFileSync(file, lines.join("\n") + "\n");
    return parseCodexTranscript(file).map((m) => [m.role, m.content]);
  };
  const turn = [makeSessionMeta("abort-1", "/work"), makeRoleLine("user", "run the build"), makeRoleLine("assistant", "starting")];

  it("before the hook: the user-role marker is parsed and there is no TurnAborted event yet", () => {
    expect(parse(...turn, makeRoleLine("user", ABORT_MARKER))).toEqual([
      ["user", "run the build"], ["assistant", "starting"], ["user", ABORT_MARKER],
    ]);
  });

  it("after the hook: the TurnAborted event adds nothing to the parsed messages", () => {
    expect(parse(...turn, makeRoleLine("user", ABORT_MARKER), makeTurnAbortedEvent())).toEqual(
      parse(...turn, makeRoleLine("user", ABORT_MARKER)),
    );
  });

  it("the developer-role marker variant is not parsed", () => {
    expect(parse(...turn, makeRoleLine("developer", ABORT_MARKER), makeTurnAbortedEvent())).toEqual([
      ["user", "run the build"], ["assistant", "starting"],
    ]);
  });

  it("without any marker an interrupted turn looks like a completed one", () => {
    expect(parse(...turn)).toEqual(parse(...turn, makeEventLine("task_complete")));
  });

  it("a continuation turn after the interruption is parsed after the marker", () => {
    expect(parse(...turn, makeRoleLine("user", ABORT_MARKER), makeTurnAbortedEvent(),
      makeRoleLine("user", "continue"), makeRoleLine("assistant", "done"))).toEqual([
      ["user", "run the build"], ["assistant", "starting"], ["user", ABORT_MARKER],
      ["user", "continue"], ["assistant", "done"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// LCM restoration proof
// ---------------------------------------------------------------------------

function developerLine(text: string | Array<{ type: string; text: string }>): string {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: text,
    },
  });
}

const blockText = `${LCM_RESTORATION_MARKER}\nrestored memory`;
const block = developerLine([{ type: "input_text", text: blockText }]);
const compacted = JSON.stringify({ type: "compacted", payload: { message: "", replacement_history: [] } });
const rolledBack = JSON.stringify({ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } });
const scan = (lines: string[]) => scanLiveCodexRestoration(lines.join("\n"));

describe("scanLiveCodexRestoration", () => {
  it("proves a marked developer block and ignores blank lines", () => {
    expect(scan([makeSessionMeta("t", "/p"), "", block, ""])).toBe(true);
    expect(scan([makeSessionMeta("t", "/p")])).toBe(false);
    expect(scan([])).toBe(false);
  });

  it("accepts leading whitespace and joined text blocks", () => {
    expect(scan([developerLine([{ type: "input_text", text: `  \n${blockText}` }])])).toBe(true);
    expect(scan([developerLine([
      { type: "input_text", text: LCM_RESTORATION_MARKER },
      { type: "input_text", text: "more" },
    ])])).toBe(true);
  });

  it("requires the marker to end its line", () => {
    const text = (value: string) => developerLine([{ type: "input_text", text: value }]);
    expect(scan([text(LCM_RESTORATION_MARKER)])).toBe(true);
    expect(scan([text(`${LCM_RESTORATION_MARKER}\nbody`)])).toBe(true);
    expect(scan([text(`${LCM_RESTORATION_MARKER}\r\nbody`)])).toBe(true);
    expect(scan([text(`${LCM_RESTORATION_MARKER} extra\nbody`)])).toBe(false);
    expect(scan([text(`${LCM_RESTORATION_MARKER}x`)])).toBe(false);
    expect(scan([text(`${LCM_RESTORATION_MARKER}\rbody`)])).toBe(false);
  });

  it("resets on a later compacted line and on a later rollback", () => {
    expect(scan([block, compacted])).toBe(false);
    expect(scan([block, compacted, block])).toBe(true);
    expect(scan([block, rolledBack])).toBe(false);
    expect(scan([block, rolledBack, block])).toBe(true);
  });

  it("ignores other event messages and quoted or non-developer markers", () => {
    expect(scan([block, makeEventLine("token_count")])).toBe(true);
    expect(scan([developerLine(`quoted ${LCM_RESTORATION_MARKER}`)])).toBe(false);
    expect(scan([makeSessionLine("user", blockText), makeSessionLine("assistant", blockText)])).toBe(false);
    expect(scan([JSON.stringify({ type: "event_msg", payload: { type: "developer", text: blockText } })])).toBe(false);
    expect(scan([JSON.stringify({ type: "response_item", payload: { type: "function_call", role: "developer", content: blockText } })])).toBe(false);
    expect(scan([JSON.stringify({ type: "response_item" }), JSON.stringify({ type: "event_msg" }), "null", "5", compacted])).toBe(false);
  });

  it("treats malformed JSON shapes as inert without throwing", () => {
    const inert = [
      "[]",
      '"str"',
      "5",
      "null",
      "true",
      JSON.stringify({ type: "response_item", payload: null }),
      JSON.stringify({ type: "response_item", payload: "message" }),
      JSON.stringify({ type: "response_item", payload: [] }),
      JSON.stringify({ type: "event_msg", payload: null }),
      developerLine(blockText),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: null } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: { text: blockText } } }),
      developerLine([null, 5, "str", [], { type: "input_text" }, { type: "input_text", text: 7 }] as never),
    ];
    expect(scan(inert)).toBe(false);
    expect(scan([block, ...inert.slice(0, 9)])).toBe(true);
    expect(scan([developerLine([null as never, { type: "input_text", text: blockText }])])).toBe(true);
  });

  it("treats an unparseable line as a reset and keeps scanning", () => {
    expect(scan([block, "{not json"])).toBe(false);
    expect(scan(["{not json", block])).toBe(true);
    expect(scan([block, "{not json", block])).toBe(true);
    expect(scan([block, "  \t ", ""])).toBe(true);
  });
});

describe("readLiveCodexRestoration", () => {
  function codexHomeWith(lines: string[], root = "sessions"): { home: string; path: string } {
    const home = makeTmpDir();
    const directory = join(home, root, "2026", "01", "01");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "rollout-t.jsonl");
    writeFileSync(path, `${lines.join("\n")}\n`);
    return { home, path };
  }

  const previousCodexHome = process.env.CODEX_HOME;
  afterEach(() => {
    fsSeam.beforeRealpath = undefined;
    fsSeam.beforeRead = undefined;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });

  it("reads rollouts under sessions and archived_sessions", () => {
    const active = codexHomeWith([makeSessionMeta("t", "/p"), block]);
    expect(readLiveCodexRestoration(active.path, { codexHome: active.home })).toBe(true);
    const archived = codexHomeWith([block], "archived_sessions");
    expect(readLiveCodexRestoration(archived.path, { codexHome: archived.home })).toBe(true);
    const none = codexHomeWith([makeSessionMeta("t", "/p")]);
    expect(readLiveCodexRestoration(none.path, { codexHome: none.home })).toBe(false);
  });

  it("honors CODEX_HOME and falls back to the home directory when it is empty", () => {
    const { home, path } = codexHomeWith([block]);
    process.env.CODEX_HOME = home;
    expect(readLiveCodexRestoration(path)).toBe(true);
    process.env.CODEX_HOME = "";
    expect(readLiveCodexRestoration(path)).toBe(false);
    delete process.env.CODEX_HOME;
    expect(readLiveCodexRestoration(path)).toBe(false);
  });

  it("rejects absent, non-string, outside, symlinked, missing and non-regular paths", () => {
    const { home, path } = codexHomeWith([block]);
    expect(readLiveCodexRestoration(undefined, { codexHome: home })).toBe(false);
    expect(readLiveCodexRestoration(null, { codexHome: home })).toBe(false);
    expect(readLiveCodexRestoration("", { codexHome: home })).toBe(false);
    expect(readLiveCodexRestoration(join(home, "missing.jsonl"), { codexHome: home })).toBe(false);

    const outside = join(makeTmpDir(), "rollout-outside.jsonl");
    writeFileSync(outside, block);
    expect(readLiveCodexRestoration(outside, { codexHome: home })).toBe(false);
    const link = join(home, "sessions", "link.jsonl");
    symlinkSync(outside, link);
    expect(readLiveCodexRestoration(link, { codexHome: home })).toBe(false);

    // A symlink leaf is rejected even when it points at a rollout inside sessions.
    const innerLink = join(home, "sessions", "inner-link.jsonl");
    symlinkSync(path, innerLink);
    expect(readLiveCodexRestoration(path, { codexHome: home })).toBe(true);
    expect(readLiveCodexRestoration(innerLink, { codexHome: home })).toBe(false);

    expect(readLiveCodexRestoration(join(home, "sessions", "2026"), { codexHome: home })).toBe(false);
    expect(readLiveCodexRestoration(path, { codexHome: join(home, "elsewhere") })).toBe(false);
  });

  it("rejects a rollout swapped for an in-sessions symlink after it was opened", () => {
    const { home, path } = codexHomeWith([block]);
    const other = join(home, "sessions", "rollout-other.jsonl");
    writeFileSync(other, block);
    let swapped = false;
    fsSeam.beforeRealpath = (target) => {
      if (target !== path || swapped) return;
      swapped = true;
      rmSync(path);
      symlinkSync(other, path);
    };
    expect(readLiveCodexRestoration(path, { codexHome: home })).toBe(false);
    expect(swapped).toBe(true);
  });

  it("rejects a rollout replaced by a different file after it was opened", () => {
    const { home, path } = codexHomeWith([block]);
    const replacement = join(home, "sessions", "rollout-replacement.jsonl");
    writeFileSync(replacement, block);
    fsSeam.beforeRealpath = (target) => {
      if (target === path) renameSync(replacement, path);
    };
    expect(readLiveCodexRestoration(path, { codexHome: home })).toBe(false);
  });

  it("does not treat a sibling directory sharing the sessions prefix as inside it", () => {
    const home = makeTmpDir();
    mkdirSync(join(home, "sessions"));
    mkdirSync(join(home, "sessions-extra"));
    const path = join(home, "sessions-extra", "rollout-t.jsonl");
    writeFileSync(path, block);
    expect(readLiveCodexRestoration(path, { codexHome: home })).toBe(false);
  });

  it("scans the tail window normally after dropping its partial first line", () => {
    const filler = developerLine("x".repeat(400));
    const window = (lines: string[]) => Buffer.byteLength(`${lines.join("\n")}\n`) + 20;

    // A compaction above the window cannot affect a block inside it.
    const compactedAbove = codexHomeWith([block, compacted, filler, block]);
    expect(readLiveCodexRestoration(compactedAbove.path, {
      codexHome: compactedAbove.home,
      maxBytes: window([filler, block]),
    })).toBe(true);

    const rolledBackAbove = codexHomeWith([block, rolledBack, filler, block]);
    expect(readLiveCodexRestoration(rolledBackAbove.path, {
      codexHome: rolledBackAbove.home,
      maxBytes: window([filler, block]),
    })).toBe(true);

    // Resets inside the window still apply.
    const rolledBackInside = codexHomeWith([filler, block, rolledBack]);
    expect(readLiveCodexRestoration(rolledBackInside.path, {
      codexHome: rolledBackInside.home,
      maxBytes: window([block, rolledBack]),
    })).toBe(false);

    // A window holding no line break contributes nothing.
    const noBreak = codexHomeWith([filler]);
    writeFileSync(noBreak.path, filler);
    expect(readLiveCodexRestoration(noBreak.path, { codexHome: noBreak.home, maxBytes: 10 })).toBe(false);

    // The whole file is scanned when it fits.
    expect(readLiveCodexRestoration(compactedAbove.path, { codexHome: compactedAbove.home })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Referenced (paginated-history) forks
// ---------------------------------------------------------------------------

const uuid = (n: number): string => `01980000-0000-7000-8000-${String(n).padStart(12, "0")}`;

interface RolloutFixture {
  readonly path: string;
  readonly rolloutId: string;
  readonly startOrdinal: number;
  /** Byte offset after each line, so offsets[k - 1] ends the first k lines. */
  readonly offsets: number[];
}

const developerItem = (text: string): Record<string, unknown> => ({
  type: "response_item",
  payload: { type: "message", role: "developer", content: [{ type: "input_text", text }] },
});
const markerItem = developerItem(blockText);
const compactedItem = { type: "compacted", payload: { message: "", replacement_history: [] } };
const rolledBackItem = { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } };
const fillerItem = (size = 400): Record<string, unknown> => developerItem("x".repeat(size));
const metaItem = (threadId: string, historyBase?: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "session_meta",
  payload: {
    id: threadId,
    cwd: "/p",
    history_mode: "paginated",
    ...(historyBase === undefined ? {} : { history_base: historyBase }),
    ...extra,
  },
});

/**
 * Write a paginated rollout. Items are stamped with consecutive ordinals from
 * startOrdinal; a string item is written verbatim.
 */
function writeRollout(home: string, spec: {
  rolloutId: string;
  threadId?: string;
  items: Array<Record<string, unknown> | string>;
  startOrdinal?: number;
  root?: string;
  day?: string;
}): RolloutFixture {
  const { rolloutId, threadId = rolloutId, items, startOrdinal = 0, root = "sessions", day = "2026/01/01" } = spec;
  const directory = join(home, root, ...(root === "sessions" ? day.split("/") : []));
  mkdirSync(directory, { recursive: true });
  const suffix = rolloutId === threadId ? "" : `_${rolloutId}`;
  const path = join(directory, `rollout-2026-01-01T00-00-00-${threadId}${suffix}.jsonl`);
  const offsets: number[] = [];
  let content = "";
  items.forEach((item, index) => {
    const line = typeof item === "string"
      ? item
      : JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", ordinal: startOrdinal + index, ...item });
    content += `${line}\n`;
    offsets.push(Buffer.byteLength(content));
  });
  writeFileSync(path, content);
  return { path, rolloutId, startOrdinal, offsets };
}

/** The history_base of a fork taken after the first count lines of a parent. */
function baseAfter(parent: RolloutFixture, count: number): Record<string, unknown> {
  return {
    thread_id: parent.rolloutId,
    end_ordinal_exclusive: parent.startOrdinal + count,
    end_byte_offset: parent.offsets[count - 1],
  };
}

/** A fork of the first count lines of parent whose own records follow its session_meta. */
function writeFork(
  home: string,
  id: number,
  parent: RolloutFixture,
  count: number,
  own: Array<Record<string, unknown> | string>,
  metaExtra: Record<string, unknown> = {},
): RolloutFixture {
  return writeRollout(home, {
    rolloutId: uuid(id),
    startOrdinal: parent.startOrdinal + count,
    items: [metaItem(uuid(id), baseAfter(parent, count), metaExtra), ...own],
  });
}

const liveIn = (home: string, fork: RolloutFixture, options: { maxBytes?: number; maxDirectoryEntries?: number } = {}): boolean =>
  readLiveCodexRestoration(fork.path, { codexHome: home, ...options });

describe("scanLiveCodexRestoration with an inherited state", () => {
  it("starts from the given live state and still resets on later records", () => {
    expect(scanLiveCodexRestoration("", true)).toBe(true);
    expect(scanLiveCodexRestoration("", false)).toBe(false);
    expect(scanLiveCodexRestoration(makeEventLine("token_count"), true)).toBe(true);
    expect(scanLiveCodexRestoration(compacted, true)).toBe(false);
    expect(scanLiveCodexRestoration(rolledBack, true)).toBe(false);
    expect(scanLiveCodexRestoration("{not json", true)).toBe(false);
    expect(scanLiveCodexRestoration(`{not json\n${block}`, true)).toBe(true);
  });
});

/** A fork of every line currently in parent. */
const forkAll = (home: string, id: number, parent: RolloutFixture, own: Array<Record<string, unknown> | string>): RolloutFixture =>
  writeFork(home, id, parent, parent.offsets.length, own);

describe("readLiveCodexRestoration for referenced forks", () => {
  it("treats a read error on an ancestor as a failed link and one on the fork's own file as no proof", () => {
    const home = makeTmpDir();
    const marked = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem] });
    const bare = writeRollout(home, { rolloutId: uuid(2), items: [metaItem(uuid(2)), fillerItem()] });
    const inherited = forkAll(home, 3, marked, [fillerItem()]);
    const own = forkAll(home, 4, bare, [markerItem]);
    expect(liveIn(home, inherited)).toBe(true);
    expect(liveIn(home, own)).toBe(true);

    // Reads in order: the fork's head, the parent's head, the parent's cutoff record,
    // the fork's records, the parent's records.
    const failingRead = (fork: RolloutFixture, failing: number): boolean => {
      let reads = 0;
      fsSeam.beforeRead = () => {
        reads += 1;
        if (reads === failing) throw new Error("EIO");
      };
      try {
        return liveIn(home, fork);
      } finally {
        fsSeam.beforeRead = undefined;
      }
    };
    // The fork's own head or records cannot be read: no proof.
    for (const failing of [1, 4]) {
      expect(failingRead(inherited, failing)).toBe(false);
      expect(failingRead(own, failing)).toBe(false);
    }
    // An ancestor cannot be read: the fork's own marker still proves, an inherited one does not.
    for (const failing of [2, 3, 5]) {
      expect(failingRead(inherited, failing)).toBe(false);
      expect(failingRead(own, failing)).toBe(true);
    }
  });

  it("proves a marker held by the parent prefix before the fork position", () => {
    const home = makeTmpDir();
    const parent = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem, fillerItem()] });
    expect(liveIn(home, forkAll(home, 2, parent, [fillerItem()]))).toBe(true);
    // The same fork without any inherited marker proves nothing.
    const bare = writeRollout(home, { rolloutId: uuid(3), items: [metaItem(uuid(3)), fillerItem(), fillerItem()] });
    expect(liveIn(home, forkAll(home, 4, bare, [fillerItem()]))).toBe(false);
  });

  it("does not prove a marker that only follows the fork position in the parent", () => {
    const home = makeTmpDir();
    const parent = writeRollout(home, {
      rolloutId: uuid(1),
      items: [metaItem(uuid(1)), fillerItem(), markerItem, compactedItem, rolledBackItem],
    });
    expect(liveIn(home, writeFork(home, 2, parent, 2, [fillerItem()]))).toBe(false);
    // A marker live at the cutoff survives resets that only come after it in the parent.
    const grown = writeRollout(home, {
      rolloutId: uuid(3),
      items: [metaItem(uuid(3)), markerItem, fillerItem(), compactedItem, rolledBackItem, "{not json"],
    });
    expect(liveIn(home, writeFork(home, 4, grown, 3, []))).toBe(true);
  });

  it("applies the fork's own compaction, rollback and unparsable records after an inherited marker", () => {
    const home = makeTmpDir();
    const parent = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem] });
    expect(liveIn(home, forkAll(home, 2, parent, [fillerItem()]))).toBe(true);
    expect(liveIn(home, forkAll(home, 3, parent, [compactedItem]))).toBe(false);
    expect(liveIn(home, forkAll(home, 4, parent, [rolledBackItem]))).toBe(false);
    expect(liveIn(home, forkAll(home, 5, parent, ["{not json"]))).toBe(false);
    expect(liveIn(home, forkAll(home, 6, parent, [compactedItem, markerItem]))).toBe(true);
  });

  it("treats a parent compaction or rollback after the marker but before the cutoff as a reset", () => {
    const home = makeTmpDir();
    const parent = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem, compactedItem, fillerItem()] });
    expect(liveIn(home, forkAll(home, 2, parent, []))).toBe(false);
    const rolled = writeRollout(home, { rolloutId: uuid(3), items: [metaItem(uuid(3)), markerItem, rolledBackItem] });
    expect(liveIn(home, forkAll(home, 4, rolled, []))).toBe(false);
  });

  it("keeps a fork's own marker when the parent is missing", () => {
    const home = makeTmpDir();
    const parent = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem] });
    const marked = forkAll(home, 2, parent, [markerItem]);
    const bare = forkAll(home, 3, parent, [fillerItem()]);
    rmSync(parent.path);
    expect(liveIn(home, marked)).toBe(true);
    expect(liveIn(home, bare)).toBe(false);
  });

  it("finds an archived parent and a reverted parent named for a distinct rollout id", () => {
    const home = makeTmpDir();
    const archived = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem], root: "archived_sessions" });
    expect(liveIn(home, forkAll(home, 2, archived, []))).toBe(true);

    // thread/revert keeps the thread id but starts a new rollout file for it.
    const reverted = writeRollout(home, { rolloutId: uuid(4), threadId: uuid(3), items: [metaItem(uuid(3)), markerItem] });
    expect(liveIn(home, forkAll(home, 5, reverted, []))).toBe(true);
    // The thread id is not the rollout id, so a base naming it finds nothing.
    const wrong = writeRollout(home, {
      rolloutId: uuid(6),
      startOrdinal: 2,
      items: [metaItem(uuid(6), { ...baseAfter(reverted, 2), thread_id: uuid(3) })],
    });
    expect(liveIn(home, wrong)).toBe(false);
  });

  it("uses history_base rather than the logical fork boundary", () => {
    const home = makeTmpDir();
    const parent = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), fillerItem(), markerItem] });
    const after = writeFork(home, 2, parent, 3, [], { forked_from_id: uuid(1), forked_from_ordinal_exclusive: 1 });
    expect(liveIn(home, after)).toBe(true);
    const before = writeFork(home, 3, parent, 2, [], { forked_from_id: uuid(1), forked_from_ordinal_exclusive: 3 });
    expect(liveIn(home, before)).toBe(false);
  });

  it("follows a chain of referenced forks to the grandparent", () => {
    const home = makeTmpDir();
    const grandparent = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem, fillerItem()] });
    const parent = forkAll(home, 2, grandparent, [fillerItem()]);
    expect(liveIn(home, forkAll(home, 3, parent, [fillerItem()]))).toBe(true);
    // A compaction in the parent's own records resets the grandparent's marker.
    const reset = forkAll(home, 4, grandparent, [compactedItem]);
    expect(liveIn(home, forkAll(home, 5, reset, []))).toBe(false);
    // A cutoff inside the grandparent bypasses the parent.
    expect(liveIn(home, writeFork(home, 6, grandparent, 2, []))).toBe(true);
  });

  it("follows at most four files", () => {
    const home = makeTmpDir();
    let tip = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem] });
    for (let id = 2; id <= 4; id += 1) tip = forkAll(home, id, tip, [fillerItem()]);
    // The fork, two forks between and the root: four files reach the root marker.
    expect(liveIn(home, tip)).toBe(true);
    expect(liveIn(home, forkAll(home, 5, tip, [fillerItem()]))).toBe(false);
  });

  it("stops at a parent that names itself or names the fork back", () => {
    const home = makeTmpDir();
    const self = writeRollout(home, {
      rolloutId: uuid(1),
      startOrdinal: 1,
      items: [metaItem(uuid(1), { thread_id: uuid(1), end_ordinal_exclusive: 1, end_byte_offset: 1 }), markerItem],
    });
    expect(liveIn(home, forkAll(home, 2, self, []))).toBe(true);

    const loop = writeRollout(home, {
      rolloutId: uuid(3),
      startOrdinal: 1,
      items: [metaItem(uuid(3), { thread_id: uuid(4), end_ordinal_exclusive: 1, end_byte_offset: 1 }), markerItem],
    });
    const fork = forkAll(home, 4, loop, [fillerItem()]);
    expect(liveIn(home, fork)).toBe(true);
  });

  it("gives no proof when the parent is ambiguous, symlinked, compressed or outside the sessions layout", () => {
    const home = makeTmpDir();
    const parent = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem], day: "2026/02/01" });
    const fork = forkAll(home, 2, parent, []);
    expect(liveIn(home, fork)).toBe(true);

    // The same rollout id twice, across date directories or across roots.
    const copy = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem], day: "2026/02/02" });
    expect(liveIn(home, fork)).toBe(false);
    rmSync(copy.path);
    const archivedCopy = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem], root: "archived_sessions" });
    expect(liveIn(home, fork)).toBe(false);
    rmSync(archivedCopy.path);
    expect(liveIn(home, fork)).toBe(true);

    // A symlinked parent file is never followed.
    const outside = makeTmpDir();
    const moved = join(outside, "parent.jsonl");
    renameSync(parent.path, moved);
    symlinkSync(moved, parent.path);
    expect(liveIn(home, fork)).toBe(false);
    rmSync(parent.path);

    // Neither is a symlinked date directory.
    const dateDirectory = join(home, "sessions", "2026", "02", "01");
    const elsewhere = join(outside, "day");
    mkdirSync(elsewhere);
    renameSync(moved, join(elsewhere, basename(parent.path)));
    rmSync(dateDirectory, { recursive: true });
    symlinkSync(elsewhere, dateDirectory);
    expect(liveIn(home, fork)).toBe(false);
    rmSync(dateDirectory);

    // A parent that only exists compressed is not read.
    mkdirSync(dateDirectory);
    renameSync(join(elsewhere, basename(parent.path)), `${join(dateDirectory, basename(parent.path))}.zst`);
    expect(liveIn(home, fork)).toBe(false);
  });

  it("rejects a referenced parent when three canonical files share its rollout id", () => {
    const home = makeTmpDir();
    const day = "2026/02/01";
    const parent = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem], day });
    const fork = forkAll(home, 2, parent, []);
    expect(liveIn(home, fork)).toBe(true);

    writeRollout(home, {
      rolloutId: parent.rolloutId,
      threadId: uuid(3),
      items: [metaItem(uuid(3)), markerItem],
      day,
    });
    writeRollout(home, {
      rolloutId: parent.rolloutId,
      threadId: uuid(4),
      items: [metaItem(uuid(4)), markerItem],
      day,
    });
    expect(liveIn(home, fork)).toBe(false);
  });

  it("matches only canonical rollout names while walking the sessions layout", () => {
    const home = makeTmpDir();
    const parent = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem] });
    const sessions = join(home, "sessions");
    mkdirSync(join(sessions, "notes"));
    mkdirSync(join(sessions, "2026", "01", "01", "nested"));
    mkdirSync(join(sessions, "2026", "extra-dir"));
    writeFileSync(join(sessions, "2026", "01", "01", "notes.txt"), "x");
    writeFileSync(join(sessions, "rollout-not-canonical.jsonl"), "x");
    symlinkSync(sessions, join(sessions, "2027"));
    expect(liveIn(home, forkAll(home, 2, parent, []))).toBe(true);
  });

  it("gives no proof when the lookup exceeds its directory entry budget or a root cannot be read", () => {
    const home = makeTmpDir();
    const parent = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem] });
    const fork = forkAll(home, 2, parent, []);
    // sessions holds the year, month and day directories and the two rollouts: five entries.
    expect(liveIn(home, fork, { maxDirectoryEntries: 5 })).toBe(true);
    expect(liveIn(home, fork, { maxDirectoryEntries: 4 })).toBe(false);
    expect(liveIn(home, fork, { maxDirectoryEntries: 0 })).toBe(false);

    writeFileSync(join(home, "archived_sessions"), "not a directory");
    expect(liveIn(home, fork)).toBe(false);
  });

  it("stops at the first failed ancestor link and keeps the validated newer history", () => {
    const home = makeTmpDir();
    const grandparent = writeRollout(home, { rolloutId: uuid(40), items: [metaItem(uuid(40)), markerItem] });
    const brokenLink = { ...baseAfter(grandparent, 2), end_ordinal_exclusive: 5 };
    const withOwnMarker = writeRollout(home, {
      rolloutId: uuid(41),
      startOrdinal: 2,
      items: [metaItem(uuid(41), brokenLink), markerItem],
    });
    const bare = writeRollout(home, {
      rolloutId: uuid(42),
      startOrdinal: 2,
      items: [metaItem(uuid(42), brokenLink), fillerItem()],
    });
    // The failing link ends the walk, but the validated newer segment still proves its marker.
    expect(liveIn(home, forkAll(home, 43, withOwnMarker, []))).toBe(true);
    expect(liveIn(home, forkAll(home, 44, withOwnMarker, [fillerItem()]))).toBe(true);
    // The marker behind the failing link is unknown, so it cannot carry in.
    expect(liveIn(home, forkAll(home, 45, bare, []))).toBe(false);
    // A reset in the validated newer segment still applies.
    const reset = writeRollout(home, {
      rolloutId: uuid(46),
      startOrdinal: 2,
      items: [metaItem(uuid(46), brokenLink), markerItem, compactedItem],
    });
    expect(liveIn(home, forkAll(home, 47, reset, []))).toBe(false);
  });

  it("rejects a parent that does not match its recorded cutoff", () => {
    const home = makeTmpDir();
    const parent = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem, fillerItem()] });
    const forkWith = (base: Record<string, unknown>): boolean => liveIn(home, writeRollout(home, {
      rolloutId: uuid(2),
      startOrdinal: 3,
      items: [metaItem(uuid(2), base)],
    }));
    expect(forkWith(baseAfter(parent, 3))).toBe(true);
    // Past the end of the file.
    expect(forkWith({ ...baseAfter(parent, 3), end_byte_offset: (parent.offsets[2] as number) + 1 })).toBe(false);
    // In the middle of a record.
    expect(forkWith({ ...baseAfter(parent, 3), end_byte_offset: (parent.offsets[1] as number) + 5 })).toBe(false);
    // Another ordinal than the one after the last record before the offset.
    expect(forkWith({ ...baseAfter(parent, 3), end_ordinal_exclusive: 4 })).toBe(false);
    expect(forkWith({ ...baseAfter(parent, 3), end_ordinal_exclusive: 2 })).toBe(false);

    // The last record is not an ordered object or not JSON at all.
    for (const last of ["{broken", "[]", JSON.stringify({ type: "x" }), JSON.stringify({ ordinal: -1 })]) {
      const odd = writeRollout(home, { rolloutId: uuid(30), items: [metaItem(uuid(30)), markerItem, last] });
      expect(liveIn(home, forkAll(home, 31, odd, []))).toBe(false);
    }

    // A legacy parent has no ordinals.
    const legacy = writeRollout(home, {
      rolloutId: uuid(32),
      items: [JSON.stringify(metaItem(uuid(32))), JSON.stringify(markerItem)],
    });
    expect(liveIn(home, forkAll(home, 33, legacy, []))).toBe(false);

    // A parent without session_meta is not a rollout.
    const headless = writeRollout(home, { rolloutId: uuid(34), items: [markerItem] });
    expect(liveIn(home, forkAll(home, 35, headless, []))).toBe(false);

    // A cutoff after the first record holds only the parent's session_meta.
    expect(liveIn(home, writeFork(home, 36, parent, 1, [markerItem]))).toBe(true);
    expect(liveIn(home, writeFork(home, 37, parent, 1, []))).toBe(false);
  });

  it("keeps the validated parent prefix when the grandparent link fails", () => {
    const home = makeTmpDir();
    const grandparent = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem] });
    const parent = forkAll(home, 2, grandparent, [markerItem]);
    const fork = forkAll(home, 3, parent, [fillerItem()]);
    expect(liveIn(home, fork)).toBe(true);
    // The grandparent cannot be found: the parent's prefix still proves.
    rmSync(grandparent.path);
    expect(liveIn(home, fork)).toBe(true);
    // An unusable history_base on the parent ends the walk there.
    const strange = writeRollout(home, {
      rolloutId: uuid(4),
      startOrdinal: 2,
      items: [metaItem(uuid(4), "bad"), markerItem],
    });
    expect(liveIn(home, forkAll(home, 5, strange, []))).toBe(true);
    // Without a marker after the gap nothing is proven.
    const empty = forkAll(home, 6, forkAll(home, 7, grandparent, [fillerItem()]), [fillerItem()]);
    expect(liveIn(home, empty)).toBe(false);
  });

  it("reads the cutoff record without needing a newline after it", () => {
    const home = makeTmpDir();
    const parent = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem, "", "  ", fillerItem()] });
    const cutoff = (byte: number, ordinal: number): boolean => liveIn(home, writeRollout(home, {
      rolloutId: uuid(2),
      startOrdinal: ordinal,
      items: [metaItem(uuid(2), { thread_id: parent.rolloutId, end_ordinal_exclusive: ordinal, end_byte_offset: byte })],
    }));
    // Right after the marker record, with and without its newline, and past trailing blank lines.
    expect(cutoff((parent.offsets[1] as number) - 1, 2)).toBe(true);
    expect(cutoff(parent.offsets[1] as number, 2)).toBe(true);
    expect(cutoff(parent.offsets[3] as number, 2)).toBe(true);
    // In the middle of a record, or with another ordinal.
    expect(cutoff((parent.offsets[1] as number) - 5, 2)).toBe(false);
    expect(cutoff(parent.offsets[3] as number, 3)).toBe(false);
    // Only blank lines before the offset.
    const blank = writeRollout(home, { rolloutId: uuid(3), items: ["", "  ", metaItem(uuid(3))] });
    expect(liveIn(home, writeRollout(home, {
      rolloutId: uuid(4),
      items: [metaItem(uuid(4), { thread_id: blank.rolloutId, end_ordinal_exclusive: 1, end_byte_offset: blank.offsets[1] })],
    }))).toBe(false);
  });

  it("does not read a cutoff record longer than a native record may be", () => {
    const home = makeTmpDir();
    const parent = writeRollout(home, {
      rolloutId: uuid(1),
      items: [metaItem(uuid(1)), markerItem, fillerItem(11 * 1024 * 1024)],
    });
    expect(liveIn(home, forkAll(home, 2, parent, []))).toBe(false);
  });

  it("validates an ancestor's last record when it spans several read chunks", () => {
    const home = makeTmpDir();
    const parent = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem, fillerItem(150_000)] });
    expect(liveIn(home, forkAll(home, 2, parent, []))).toBe(true);
    expect(liveIn(home, writeFork(home, 3, parent, 2, []))).toBe(true);
  });

  it("ignores a history_base that is invalid or whose first line is not complete in the head", () => {
    const home = makeTmpDir();
    const parent = writeRollout(home, { rolloutId: uuid(1), items: [metaItem(uuid(1)), markerItem] });
    const good = baseAfter(parent, 2);
    const control = writeRollout(home, { rolloutId: uuid(99), startOrdinal: 2, items: [metaItem(uuid(99), good)] });
    expect(liveIn(home, control)).toBe(true);

    const attempts: unknown[] = [
      "base",
      [],
      { ...good, thread_id: undefined },
      { ...good, thread_id: 7 },
      { ...good, thread_id: "../../../../etc/passwd" },
      { ...good, thread_id: `${parent.rolloutId}/../x` },
      { ...good, thread_id: parent.rolloutId.replaceAll("-", "") },
      { ...good, end_ordinal_exclusive: 0 },
      { ...good, end_ordinal_exclusive: -1 },
      { ...good, end_ordinal_exclusive: 1.5 },
      { ...good, end_ordinal_exclusive: "2" },
      { ...good, end_ordinal_exclusive: 2 ** 60 },
      { ...good, end_byte_offset: 0 },
      { ...good, end_byte_offset: undefined },
      { ...good, end_byte_offset: 2 ** 60 },
    ];
    attempts.forEach((base, index) => {
      const fork = writeRollout(home, { rolloutId: uuid(100 + index), startOrdinal: 2, items: [metaItem(uuid(100 + index), base)] });
      expect(liveIn(home, fork)).toBe(false);
      const marked = writeRollout(home, { rolloutId: uuid(200 + index), startOrdinal: 2, items: [metaItem(uuid(200 + index), base), markerItem] });
      expect(liveIn(home, marked)).toBe(true);
    });

    // A null base is an ordinary rollout; a first line beyond the head bound hides the base.
    const plain = writeRollout(home, { rolloutId: uuid(300), items: [metaItem(uuid(300), null), markerItem] });
    expect(liveIn(home, plain)).toBe(true);
    const oversized = writeRollout(home, {
      rolloutId: uuid(301),
      startOrdinal: 2,
      items: [metaItem(uuid(301), good, { base_instructions: "x".repeat(300 * 1024) })],
    });
    expect(liveIn(home, oversized)).toBe(false);
    const empty = join(home, "sessions", "2026", "01", "01", "rollout-empty.jsonl");
    writeFileSync(empty, "");
    expect(readLiveCodexRestoration(empty, { codexHome: home })).toBe(false);
  });

  it("starts the scan with no proof when the byte budget cuts the effective history", () => {
    const home = makeTmpDir();
    const parent = writeRollout(home, {
      rolloutId: uuid(1),
      items: [metaItem(uuid(1)), markerItem, fillerItem(), fillerItem()],
    });
    const lineBytes = (fixture: RolloutFixture, index: number): number =>
      (fixture.offsets[index] as number) - ((fixture.offsets[index - 1] ?? 0) as number);
    const total = (fixture: RolloutFixture): number => fixture.offsets[fixture.offsets.length - 1] as number;
    const plain = forkAll(home, 2, parent, [fillerItem(), fillerItem()]);
    const reset = forkAll(home, 3, parent, [compactedItem, fillerItem(), fillerItem()]);

    // Everything fits.
    expect(liveIn(home, plain)).toBe(true);
    expect(liveIn(home, reset)).toBe(false);

    // Only the fork fits: the parent's marker does not carry across the cut.
    expect(liveIn(home, plain, { maxBytes: total(plain) })).toBe(false);
    // Only the fork's tail fits, so its compaction is not seen and nothing inherited carries in.
    expect(liveIn(home, reset, { maxBytes: lineBytes(reset, 2) + lineBytes(reset, 3) + 20 })).toBe(false);

    // The suffix reaches into the parent: a marker inside it proves, one above it does not.
    const reaching = total(plain) + lineBytes(parent, 1) + lineBytes(parent, 2) + lineBytes(parent, 3) + 20;
    expect(liveIn(home, plain, { maxBytes: reaching })).toBe(true);
    const above = total(plain) + lineBytes(parent, 2) + lineBytes(parent, 3) + 20;
    expect(liveIn(home, plain, { maxBytes: above })).toBe(false);

    // A window that starts inside the parent's last record holds no complete record.
    expect(liveIn(home, plain, { maxBytes: total(plain) + 10 })).toBe(false);
    expect(liveIn(home, plain, { maxBytes: total(plain) + 1 })).toBe(false);
    expect(liveIn(home, plain, { maxBytes: 0 })).toBe(false);
  });
});
