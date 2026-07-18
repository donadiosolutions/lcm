import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __diagnoseTestUtils, diagnose, formatDiagnoseResult, scanSession, type DiagnoseResult } from "../src/diagnose.js";
import { cwdToProjectHash } from "../src/import.js";
import { legacyLcmSlug } from "../src/legacy-names.js";

const roots: string[] = [];
const tempRoot = () => { const root = mkdtempSync(join(tmpdir(), "lcm-coverage-diagnose-")); roots.push(root); return root; };
const writeLines = (path: string, lines: unknown[]) => writeFileSync(path, lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n") + "\n");
const hook = (command: string, hookEvent?: string, id?: string, timestamp?: string) => ({
  type: "progress", timestamp,
  data: { type: "hook_progress", hookEvent, command },
  ...(id ? { parent_tool_use_id: id } : {}),
});

describe("diagnose service coverage", () => {
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("never matches pending hooks outside the structured-error time window", () => {
    const pending = [{
      command: "lcm compact",
      hookEvent: "PreCompact",
      lineNumber: 1,
      parentToolUseID: "old-hook",
      timestamp: "2026-01-01T00:00:00Z",
    }];

    expect(__diagnoseTestUtils.matchPendingHook(
      pending,
      { toolUseID: "old-hook" },
      1 + 5 + 1,
    )).toBeUndefined();
    expect(pending).toHaveLength(1);
  });

  it("scans malformed, structured, legacy, duplicate, matching, and expired transcript boundaries", async () => {
    const root = tempRoot();
    const path = join(root, "abcdefgh-session.jsonl");
    const old = legacyLcmSlug();
    writeLines(path, [
      "", "{bad", "null", "\"primitive\"",
      { type: "custom-title", customTitle: "Coverage session", timestamp: "2026-01-01T00:00:00Z" },
      { type: "custom-title", customTitle: "   " },
      { type: "system", content: "ordinary notice" },
      { type: "system", content: "disconnect from unrelated server" },
      { type: "system", message: { text: `MCP ${old} disconnect happened` } },
      { type: "system", message: { content: `MCP ${old} disconnect happened` }, timestamp: "2026-01-01T00:00:02Z" },
      { type: "progress", data: null },
      { type: "progress", data: { type: "other", command: "lcm ignored" } },
      hook("echo lcm-is-not-a-command", "Nope"),
      hook(`/usr/local/bin/${old}`, "SessionStart", "old", "2026-01-01T00:00:02Z"),
      hook(`/opt/bin/${old}`, "SessionStart", "old-two", "2026-01-01T00:00:02Z"),
      hook("/usr/local/bin/lcm restore", "SessionStart", "dup", "2026-01-01T00:00:03Z"),
      hook("/usr/local/bin/lcm restore", "SessionStart", "dup", "2026-01-01T00:00:03Z"),
      hook("lcm user-prompt", "UserPromptSubmit", "snake", "2026-01-01T00:00:04Z"),
      { type: "user", message: { content: [{ type: "tool_result", is_error: true, tool_use_id: "snake", content: [{ text: "failure text" }, { content: "more" }, 4] }] } },
      hook("lcm session-end", undefined, undefined, "2026-01-01T00:00:05Z"),
      { type: "system", level: "error", message: [{ content: "system failure" }] },
      hook("lcm compact", "PreCompact", "camel", "2026-01-01T00:00:06Z"),
      { type: "user", toolUseResult: "fallback result", message: { content: [{ type: "tool_result", is_error: true, toolUseID: "camel", content: [] }] } },
      hook("lcm compact", "PreCompact", "stderr"),
      { type: "assistant", parentToolUseID: "stderr", stderr: "x".repeat(200) },
      hook("lcm compact", "PreCompact", "exit"),
      { type: "assistant", tool_use_id: "exit", exitCode: 2 },
      hook("lcm compact", "PreCompact", "exit-alt"),
      { type: "assistant", parent_tool_use_id: "exit-alt", exit_code: 3 },
      hook("lcm compact", "PreCompact", "system-pattern"),
      { type: "system", toolUseID: "system-pattern", content: "command timed out" },
      hook("lcm compact", "PreCompact", "nested"),
      { type: "assistant", message: { content: [{ parentToolUseID: "nested" }, null] }, stderr: "nested stderr" },
      hook("lcm compact", "PreCompact", "expired"),
      {}, {}, {}, {}, {}, {},
      { type: "assistant", toolUseID: "expired", stderr: "too late" },
      { type: "user", message: null },
      { type: "user", message: { content: "not-array" } },
      { type: "user", message: { content: [null, { type: "tool_result", is_error: false }] } },
      hook("lcm string-array", "StringArray"),
      { type: "user", message: { content: [{ type: "tool_result", is_error: true, content: ["string failure"] }] } },
      hook("lcm default-error", "DefaultError"),
      { type: "user", message: { content: [{ type: "tool_result", is_error: true }] } },
      hook("lcm no-item-id", "NoItemId", "top-id"),
      { type: "assistant", toolUseID: "top-id", message: { content: [{ text: "no id" }] }, stderr: "top stderr" },
      hook("lcm parentless", "Parentless"),
      { type: "assistant", toolUseID: "some-id", stderr: "parentless failure" },
      hook("lcm mismatch", "Mismatch", "wanted-id"),
      { type: "assistant", toolUseID: "different-id", stderr: "mismatched failure" },
      hook("lcm duplicate-a", undefined), hook("lcm duplicate-a", undefined),
      hook("lcm duplicate-b", undefined), hook("lcm duplicate-b", undefined),
      { type: "system", content: ["array system content"] },
    ]);

    const result = await scanSession(path);
    expect(result).toMatchObject({ sessionId: "abcdefgh-session", sessionName: "Coverage session" });
    expect(result.errors.some((error) => error.type === "mcp-disconnect")).toBe(true);
    expect(result.errors.some((error) => error.type === "old-binary")).toBe(true);
    expect(result.errors.some((error) => error.type === "duplicate-hook" && error.count === 2)).toBe(true);
    expect(result.errors.filter((error) => error.type === "hook-error").length).toBeGreaterThanOrEqual(3);
  });

  it("discovers current/all projects, filters age, sorts timestamp and mtime, and aggregates totals", async () => {
    const root = tempRoot();
    const cwd = "/coverage/current";
    const current = join(root, cwdToProjectHash(cwd));
    const other = join(root, "other-project");
    mkdirSync(current, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeLines(join(root, "not-a-project"), ["file"]);
    const currentFile = join(current, "current-session.jsonl");
    const otherFile = join(other, "other-session.jsonl");
    const cleanFile = join(other, "clean-session.jsonl");
    const oldFile = join(other, "old-session.jsonl");
    writeLines(currentFile, [hook("lcm restore", "SessionStart", undefined, "2026-01-09T01:00:00Z"), hook("lcm restore", "SessionStart")]);
    writeLines(otherFile, [hook(`/bin/${legacyLcmSlug()}`, "SessionStart", undefined, "2026-01-09T02:00:00Z"), { type: "system", content: "lcm disconnect" }]);
    writeLines(cleanFile, [hook("lcm clean", "Clean"), { type: "system", level: "error", content: "clean failed" }]);
    writeLines(oldFile, [hook("lcm old", "Old")]);
    const now = new Date("2026-01-10T00:00:00Z");
    const recent = new Date("2026-01-09T00:00:00Z");
    const old = new Date("2025-01-01T00:00:00Z");
    for (const file of [currentFile, otherFile]) utimesSync(file, recent, recent);
    const slightlyOlder = new Date("2026-01-08T00:00:00Z");
    utimesSync(cleanFile, slightlyOlder, slightlyOlder);
    utimesSync(oldFile, old, old);

    const currentOnly = await diagnose({ cwd, _claudeProjectsDir: root, _nowMs: now.getTime() });
    expect(currentOnly).toMatchObject({ sessionsScanned: 1, sessionsWithErrors: 1, totalErrors: 2, totalWarnings: 0 });

    const all = await diagnose({ all: true, days: 7, _claudeProjectsDir: root, _nowMs: now.getTime() });
    expect(all.sessionsScanned).toBe(3);
    expect(all.sessionsWithErrors).toBe(3);
    expect(all.totalWarnings).toBe(1);
    expect(all.mostCommon).toBeDefined();

    expect(await diagnose({ cwd: "/missing", _claudeProjectsDir: root, _nowMs: now.getTime() })).toMatchObject({ sessionsScanned: 0 });
    expect(await diagnose({ all: true, _claudeProjectsDir: join(root, "absent"), _nowMs: now.getTime() })).toMatchObject({ sessionsScanned: 0 });
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    mkdirSync(join(root, ".claude", "projects"), { recursive: true });
    try {
      await diagnose();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("formats empty results and every issue line, metadata, verbosity, counts, and duplicate hints", () => {
    expect(formatDiagnoseResult({ sessionsScanned: 0, sessionsWithErrors: 0, totalErrors: 0, totalWarnings: 0, sessions: [] }, { days: 1 }))
      .toContain("No issues found");
    const result: DiagnoseResult = {
      sessionsScanned: 2, sessionsWithErrors: 2, totalErrors: 7, totalWarnings: 2,
      mostCommon: { type: "Hook error", count: 3 },
      sessions: [
        {
          sessionId: "abcdefghijk", sessionName: "named", lastTimestamp: "2026-01-02T00:00:00Z", filePath: "/one",
          errors: [
            { type: "hook-error", hookEvent: "Stop", details: "detail", count: 2 },
            { type: "hook-error", count: 1 },
            { type: "mcp-disconnect", count: 2 },
            { type: "old-binary", command: "old-command", count: 2 },
            { type: "duplicate-hook", hookEvent: "Stop", command: "lcm stop", count: 2 },
          ],
        },
        {
          sessionId: "short", filePath: "/two",
          errors: [
            { type: "mcp-disconnect", count: 1 },
            { type: "old-binary", count: 1 },
            { type: "duplicate-hook", count: 1 },
          ],
        },
      ],
    };
    const output = formatDiagnoseResult(result, { days: 2, verbose: true });
    expect(output).toContain("abcdefgh");
    expect(output).toContain("detail");
    expect(output).toContain("warnings");
    expect(output).toContain("duplicate `Stop` hook entry");

    const noDuplicate = formatDiagnoseResult({
      ...result, sessions: [{ ...result.sessions[1], errors: [{ type: "mcp-disconnect", count: 1 }] }], totalWarnings: 0, mostCommon: undefined,
    }, { verbose: false });
    expect(noDuplicate).toContain("Suggestion: Run `lcm doctor`");
    expect(noDuplicate).not.toContain("detail");

    const multipleDuplicates = formatDiagnoseResult({
      ...result,
      sessions: [{ ...result.sessions[0], errors: [
        { type: "duplicate-hook", hookEvent: "One", count: 1 },
        { type: "duplicate-hook", hookEvent: "Two", count: 1 },
      ] }],
    });
    expect(multipleDuplicates).toContain("hook entries");
  });
});
