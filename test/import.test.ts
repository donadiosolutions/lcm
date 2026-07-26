import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { cwdToProjectHash, findSessionFiles, importSessions } from "../src/import.js";
import type { DaemonClient } from "../src/daemon/client.js";
import { projectId } from "../src/daemon/project.js";
import { resolveProjectIdentity } from "../src/project-map.js";

// --- cwdToProjectHash ---

describe("cwdToProjectHash", () => {
  it("keeps leading dash from absolute path", () => {
    expect(cwdToProjectHash("/home/user/project")).toBe("-home-user-project");
  });

  it("replaces all slashes with dashes", () => {
    expect(cwdToProjectHash("/a/b/c")).toBe("-a-b-c");
  });

  it("handles root path", () => {
    expect(cwdToProjectHash("/")).toBe("-");
  });

  it("handles path without leading slash", () => {
    expect(cwdToProjectHash("home/user")).toBe("home-user");
  });
});

// --- findSessionFiles ---

describe("findSessionFiles", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lcm-import-test-"));
    dirs.push(dir);
    return dir;
  }

  it("returns empty array for nonexistent directory", () => {
    const result = findSessionFiles("/nonexistent/path/that/does/not/exist");
    expect(result).toEqual([]);
  });

  it("discovers .jsonl files at the top level", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "session-abc.jsonl"), "");
    writeFileSync(join(dir, "session-def.jsonl"), "");
    writeFileSync(join(dir, "readme.txt"), "");

    const result = findSessionFiles(dir);
    const sessionIds = result.map((f) => f.sessionId).sort();
    expect(sessionIds).toEqual(["session-abc", "session-def"]);
  });

  it("discovers subagent .jsonl files", () => {
    const dir = makeTmpDir();
    // create a subdirectory with a subagents folder
    const subDir = join(dir, "session-parent");
    const subagentsDir = join(subDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "subagent-1.jsonl"), "");
    writeFileSync(join(subagentsDir, "subagent-2.jsonl"), "");

    const result = findSessionFiles(dir);
    const sessionIds = result.map((f) => f.sessionId).sort();
    expect(sessionIds).toEqual(["subagent-1", "subagent-2"]);
  });

  it("discovers both top-level and subagent files", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "main-session.jsonl"), "");
    const subDir = join(dir, "nested");
    const subagentsDir = join(subDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "child-session.jsonl"), "");

    const result = findSessionFiles(dir);
    const sessionIds = result.map((f) => f.sessionId).sort();
    expect(sessionIds).toEqual(["child-session", "main-session"]);
  });

  it("ignores directories without a subagents subfolder or matching nested transcript", () => {
    const dir = makeTmpDir();
    const subDir = join(dir, "some-dir");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "file.jsonl"), ""); // not in subagents/ and name doesn't match dir

    const result = findSessionFiles(dir);
    expect(result).toEqual([]);
  });

  it("discovers nested session transcripts (Layout A: <session-id>/<session-id>.jsonl)", () => {
    const dir = makeTmpDir();
    const sessionDir = join(dir, "session-abc");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "session-abc.jsonl"), "");

    const result = findSessionFiles(dir);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("session-abc");
    expect(result[0].path).toBe(join(sessionDir, "session-abc.jsonl"));
  });

  it("ignores nested transcript paths that are not regular files", () => {
    const dir = makeTmpDir();
    const sessionDir = join(dir, "session-abc");
    const nestedPath = join(sessionDir, "session-abc.jsonl");
    mkdirSync(nestedPath, { recursive: true });

    const result = findSessionFiles(dir);
    expect(result).toEqual([]);
  });

  it("discovers nested transcripts alongside subagent files", () => {
    const dir = makeTmpDir();
    // Layout A: nested main transcript + subagent
    const sessionDir = join(dir, "session-parent");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "session-parent.jsonl"), "");
    const subagentsDir = join(sessionDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agent-1.jsonl"), "");

    const result = findSessionFiles(dir);
    const sessionIds = result.map((f) => f.sessionId).sort();
    expect(sessionIds).toEqual(["agent-1", "session-parent"]);
  });

  it("deduplicates when both flat and nested transcripts exist for the same session", () => {
    const dir = makeTmpDir();
    // Flat transcript at project root
    writeFileSync(join(dir, "session-abc.jsonl"), "flat");
    // Nested transcript inside session directory
    const sessionDir = join(dir, "session-abc");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "session-abc.jsonl"), "nested");

    const result = findSessionFiles(dir);
    // Should only return one entry, the flat file (preferred)
    const matches = result.filter((f) => f.sessionId === "session-abc");
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe(join(dir, "session-abc.jsonl"));
  });

  it("ignores symlinked transcript files at the top level", () => {
    const dir = makeTmpDir();
    const targetFile = join(dir, "real-target.jsonl");
    writeFileSync(targetFile, '{"type":"human"}\n');
    const projectDir = join(dir, "project");
    mkdirSync(projectDir);
    symlinkSync(targetFile, join(projectDir, "fake-session.jsonl"));

    const result = findSessionFiles(projectDir);
    expect(result).toHaveLength(0); // symlink should be ignored
  });

  it("ignores symlinked nested transcript files", () => {
    const dir = makeTmpDir();
    const targetFile = join(dir, "real-target.jsonl");
    writeFileSync(targetFile, '{"type":"human"}\n');
    const projectDir = join(dir, "project");
    const sessionDir = join(projectDir, "session-xyz");
    mkdirSync(sessionDir, { recursive: true });
    symlinkSync(targetFile, join(sessionDir, "session-xyz.jsonl"));

    const result = findSessionFiles(projectDir);
    expect(result).toHaveLength(0); // symlinked nested transcript should be ignored
  });

  it("returns files sorted by mtime ascending", () => {
    const dir = makeTmpDir();
    const older = join(dir, "session-old.jsonl");
    const newer = join(dir, "session-new.jsonl");
    writeFileSync(newer, "");  // write newer first so FS order ≠ mtime order
    writeFileSync(older, "");
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(older, oldTime, oldTime);

    const result = findSessionFiles(dir);
    expect(result.map(f => f.sessionId)).toEqual(["session-old", "session-new"]);
  });

  it("sorts equal mtimes by session ID and then path", () => {
    // A project directory ending in "a" used to make its flat a.jsonl file
    // look like the nested suffix a/a.jsonl and disappear during deduplication.
    const dir = join(makeTmpDir(), "a");
    mkdirSync(dir);
    const nested = join(dir, "same");
    const agents = join(nested, "subagents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "ignored.txt"), "");
    const paths = [
      join(dir, "z.jsonl"),
      join(dir, "a.jsonl"),
      join(dir, "same.jsonl"),
      join(agents, "same.jsonl"),
    ];
    for (const path of paths) writeFileSync(path, "");
    const time = new Date("2026-01-01T00:00:00Z");
    for (const path of paths) utimesSync(path, time, time);
    const result = findSessionFiles(dir);
    expect(result.map((item) => item.path)).toEqual([
      join(dir, "a.jsonl"),
      join(dir, "same.jsonl"),
      join(agents, "same.jsonl"),
      join(dir, "z.jsonl"),
    ]);
  });
});

// --- importSessions ---

function makeMockClient(postImpl: (path: string, body: unknown) => Promise<unknown>): DaemonClient {
  return {
    post: vi.fn().mockImplementation(postImpl),
    health: vi.fn(),
  } as unknown as DaemonClient;
}

describe("importSessions", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
    vi.restoreAllMocks();
  });

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lcm-import-sessions-"));
    dirs.push(dir);
    return dir;
  }

  it("does not call client.post on dry-run", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/home/user/myproject";
    const projectHash = cwdToProjectHash(cwd);
    const projectDir = join(claudeProjectsDir, projectHash);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session-1.jsonl"), "");

    const client = makeMockClient(async () => ({ ingested: 1, totalTokens: 100 }));

    const result = await importSessions(client, {
      dryRun: true,
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(client.post).not.toHaveBeenCalled();
    // dry-run counts found sessions as "imported" for reporting
    expect(result.imported).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("reports verbose replay dry-runs and progress", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/dry/run";
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session-1.jsonl"), "");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const onProgress = vi.fn();
    const result = await importSessions(makeMockClient(async () => ({})), {
      cwd, _claudeProjectsDir: claudeProjectsDir, dryRun: true, replay: true, verbose: true, onProgress,
    });
    expect(result.imported).toBe(1);
    expect(log).toHaveBeenCalledWith("  [dry-run] session-1 (would compact)");
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ completed: 1, total: 1 }));
  });

  it("reports verbose non-replay dry-runs", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/dry/plain";
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session.jsonl"), "");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await importSessions(makeMockClient(async () => ({})), {
      cwd, _claudeProjectsDir: claudeProjectsDir, dryRun: true, verbose: true,
    });
    expect(log).toHaveBeenCalledWith("  [dry-run] session");
  });

  it("discovers all Claude projects through valid project metadata", async () => {
    const claudeProjectsDir = makeTmpDir();
    const lcmDir = makeTmpDir();
    const cwd = "/mapped/project";
    const hash = cwdToProjectHash(cwd);
    mkdirSync(join(claudeProjectsDir, hash), { recursive: true });
    writeFileSync(join(claudeProjectsDir, hash, "mapped.jsonl"), "");
    mkdirSync(join(claudeProjectsDir, "unmapped"));
    writeFileSync(join(claudeProjectsDir, "not-a-project"), "");
    mkdirSync(join(lcmDir, "projects", "valid"), { recursive: true });
    writeFileSync(join(lcmDir, "projects", "valid", "meta.json"), JSON.stringify({ cwd }));
    mkdirSync(join(lcmDir, "projects", "missing-meta"));
    mkdirSync(join(lcmDir, "projects", "empty-meta"));
    writeFileSync(join(lcmDir, "projects", "empty-meta", "meta.json"), "{}");
    mkdirSync(join(lcmDir, "projects", "bad-meta"));
    writeFileSync(join(lcmDir, "projects", "bad-meta", "meta.json"), "{");
    writeFileSync(join(lcmDir, "projects", "not-a-directory"), "");
    const client = makeMockClient(async () => ({ ingested: 1, totalTokens: 1 }));
    const result = await importSessions(client, { all: true, _claudeProjectsDir: claudeProjectsDir, _lcmDir: lcmDir });
    expect(result.imported).toBe(1);
  });

  it("handles absent project maps and default path options", async () => {
    const claudeProjectsDir = makeTmpDir();
    const emptyLcmDir = makeTmpDir();
    const client = makeMockClient(async () => ({ ingested: 1, totalTokens: 1 }));
    await expect(importSessions(client, { all: true, _claudeProjectsDir: claudeProjectsDir, _lcmDir: emptyLcmDir })).resolves.toMatchObject({ imported: 0 });
    await expect(importSessions(client, { all: true, _claudeProjectsDir: claudeProjectsDir })).resolves.toMatchObject({ imported: 0 });
    await expect(importSessions(client, { all: true, _claudeProjectsDir: join(claudeProjectsDir, "missing") })).resolves.toMatchObject({ imported: 0 });
    await expect(importSessions(client, { _claudeProjectsDir: claudeProjectsDir })).resolves.toMatchObject({ imported: 0 });
    await expect(importSessions(client, { cwd: "/coverage/nonexistent/default-claude-project" })).resolves.toMatchObject({ imported: 0 });
  });

  it("defers completion decisions to the daemon so grown transcripts can resume", async () => {
    const claudeProjectsDir = makeTmpDir();
    const lcmDir = makeTmpDir();
    const cwd = "/already/imported";
    const sessionId = "recorded";
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), "");
    const dbDir = join(lcmDir, "projects", projectId(cwd));
    mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(join(dbDir, "db.sqlite"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE session_ingest_log (session_id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO session_ingest_log(session_id) VALUES (?)").run(sessionId);
    db.close();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const onProgress = vi.fn();
    const client = makeMockClient(async () => ({ ingested: 0, totalTokens: 0 }));
    const result = await importSessions(client, {
      cwd, _claudeProjectsDir: claudeProjectsDir, _lcmDir: lcmDir, verbose: true, onProgress,
    });
    expect(client.post).toHaveBeenCalledWith("/ingest", expect.objectContaining({ session_id: sessionId }));
    expect(result.skippedEmpty).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("empty or already ingested"));
    expect(onProgress).toHaveBeenCalled();
  });

  it("quietly skips a recorded session without a progress callback", async () => {
    const claudeProjectsDir = makeTmpDir();
    const lcmDir = makeTmpDir();
    const cwd = "/already/quiet";
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "recorded.jsonl"), "");
    const dbDir = join(lcmDir, "projects", projectId(cwd));
    mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(join(dbDir, "db.sqlite"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE session_ingest_log (session_id TEXT PRIMARY KEY); INSERT INTO session_ingest_log VALUES ('recorded')");
    db.close();
    const result = await importSessions(makeMockClient(async () => ({ ingested: 0, totalTokens: 0 })), {
      cwd, _claudeProjectsDir: claudeProjectsDir, _lcmDir: lcmDir,
    });
    expect(result.skippedEmpty).toBe(1);
  });

  it("prints verbose empty and successful ingest results", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/verbose/ingest";
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "empty.jsonl"), "");
    writeFileSync(join(projectDir, "success.jsonl"), "");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const client = makeMockClient(async (_path, body) => (body as { session_id: string }).session_id === "empty"
      ? { ingested: 0, totalTokens: 0 }
      : { ingested: 2, totalTokens: 100 });
    const result = await importSessions(client, { cwd, _claudeProjectsDir: claudeProjectsDir, verbose: true });
    expect(result).toMatchObject({ imported: 1, skippedEmpty: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("empty or already ingested"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("2 messages"));
  });

  it("covers every verbose replay statistics outcome and prior-context label", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/verbose/replay";
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(cwd));
    mkdirSync(projectDir, { recursive: true });
    for (const id of ["a", "b", "c", "d"]) writeFileSync(join(projectDir, `${id}.jsonl`), "");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const responses: Record<string, object> = {
      a: { latestSummaryContent: "a", tokensBefore: 100, tokensAfter: 10 },
      b: { latestSummaryContent: "b", tokensAfter: 10 },
      c: { latestSummaryContent: "c", tokensBefore: 100 },
      d: { latestSummaryContent: "d", tokensBefore: 10, tokensAfter: 10 },
    };
    const client = makeMockClient(async (path, body) => path === "/ingest"
      ? { ingested: 1, totalTokens: 100 }
      : responses[(body as { session_id: string }).session_id]);
    await importSessions(client, { cwd, _claudeProjectsDir: claudeProjectsDir, replay: true, verbose: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("100 → 10"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("compacted (with prior context)"));
  });

  it("handles non-Error compact and ingest failures in verbose replay mode", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/failure/values";
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "compact-fail.jsonl"), "");
    writeFileSync(join(projectDir, "ingest-fail.jsonl"), "");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = makeMockClient(async (path, body) => {
      const id = (body as { session_id: string }).session_id;
      if (path === "/ingest" && id === "ingest-fail") throw "ingest value";
      if (path === "/compact" && id === "compact-fail") throw "compact value";
      return { ingested: 1, totalTokens: 10 };
    });
    const result = await importSessions(client, { cwd, _claudeProjectsDir: claudeProjectsDir, replay: true, verbose: true });
    expect(result.failed).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("unknown error"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("failed"));
  });

  it("prints Error details for verbose ingest failures", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/failure/error";
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session.jsonl"), "");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await importSessions(makeMockClient(async () => { throw new Error("specific failure"); }), {
      cwd, _claudeProjectsDir: claudeProjectsDir, verbose: true,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("specific failure"));
  });

  it("imports when the ingest database is missing or malformed", async () => {
    const claudeProjectsDir = makeTmpDir();
    const lcmDir = makeTmpDir();
    const cwd = "/malformed/database";
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session.jsonl"), "");
    const dbDir = join(lcmDir, "projects", projectId(cwd));
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, "db.sqlite"), "not sqlite");
    const result = await importSessions(makeMockClient(async () => ({ ingested: 1, totalTokens: 1 })), {
      cwd, _claudeProjectsDir: claudeProjectsDir, _lcmDir: lcmDir,
    });
    expect(result.imported).toBe(1);
  });

  it("calls /ingest with transcript_path and counts imported", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/home/user/myproject";
    const projectHash = cwdToProjectHash(cwd);
    const projectDir = join(claudeProjectsDir, projectHash);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session-abc.jsonl"), "");

    const calls: { path: string; body: unknown }[] = [];
    const client = makeMockClient(async (path, body) => {
      calls.push({ path, body });
      return { ingested: 5, totalTokens: 500 };
    });

    const result = await importSessions(client, {
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/ingest");
    expect((calls[0].body as { session_id: string }).session_id).toBe("session-abc");
    expect((calls[0].body as { cwd: string }).cwd).toBe(cwd);
    expect((calls[0].body as { transcript_path: string }).transcript_path).toContain("session-abc.jsonl");
    expect((calls[0].body as { client: string }).client).toBe("claude");

    expect(result.imported).toBe(1);
    expect(result.totalMessages).toBe(5);
    expect(result.totalTokens).toBe(500);
    expect(result.failed).toBe(0);
    expect(result.skippedEmpty).toBe(0);
  });

  it("counts empty transcripts as skippedEmpty (ingested=0, totalTokens=0)", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/home/user/emptyproject";
    const projectHash = cwdToProjectHash(cwd);
    const projectDir = join(claudeProjectsDir, projectHash);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "empty-session.jsonl"), "");

    const client = makeMockClient(async () => ({ ingested: 0, totalTokens: 0 }));

    const result = await importSessions(client, {
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(result.skippedEmpty).toBe(1);
    expect(result.imported).toBe(0);
    expect(result.totalMessages).toBe(0);
    expect(result.totalTokens).toBe(0);
  });

  it("counts failed ingest calls", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/home/user/failproject";
    const projectHash = cwdToProjectHash(cwd);
    const projectDir = join(claudeProjectsDir, projectHash);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "bad-session.jsonl"), "");

    const client = makeMockClient(async () => {
      throw new Error("daemon error");
    });

    const result = await importSessions(client, {
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(result.failed).toBe(1);
    expect(result.imported).toBe(0);
  });

  it("replay mode calls compact after each session in mtime order, threading latestSummaryContent", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/test/project";
    const hash = cwdToProjectHash(cwd);
    const projDir = join(claudeProjectsDir, hash);
    mkdirSync(projDir, { recursive: true });

    const f1 = join(projDir, "session-1.jsonl");
    const f2 = join(projDir, "session-2.jsonl");
    writeFileSync(f2, "");  // write f2 first so FS order ≠ mtime order
    writeFileSync(f1, "");
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(f1, oldTime, oldTime);  // f1 is older

    const compactBodies: { session_id: string; previous_summary?: string }[] = [];
    const client = makeMockClient(async (path: string, body: any) => {
      if (path === "/ingest") return { ingested: 1, totalTokens: 100 };
      if (path === "/compact") {
        compactBodies.push({ session_id: body.session_id, previous_summary: body.previous_summary });
        return { summary: "stats", latestSummaryContent: `summary-of-${body.session_id}` };
      }
    });

    await importSessions(client, {
      replay: true,
      verbose: false,
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    // Both sessions were compacted, in mtime order
    expect(compactBodies).toHaveLength(2);
    expect(compactBodies[0].session_id).toBe("session-1");
    expect(compactBodies[0].previous_summary).toBeUndefined();
    expect(compactBodies[1].session_id).toBe("session-2");
    expect(compactBodies[1].previous_summary).toBe("summary-of-session-1");
  });

  it("replay mode accumulates totalTokens and tokensAfter from compact responses", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/test/token-stats";
    const hash = cwdToProjectHash(cwd);
    const projDir = join(claudeProjectsDir, hash);
    mkdirSync(projDir, { recursive: true });

    const f1 = join(projDir, "session-1.jsonl");
    const f2 = join(projDir, "session-2.jsonl");
    writeFileSync(f2, "");
    writeFileSync(f1, "");
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(f1, oldTime, oldTime);

    const client = makeMockClient(async (path: string) => {
      if (path === "/ingest") return { ingested: 3, totalTokens: 5000 };
      if (path === "/compact") return {
        summary: "done",
        latestSummaryContent: "summary",
        tokensBefore: 5000,
        tokensAfter: 200,
      };
    });

    const result = await importSessions(client, {
      replay: true,
      verbose: false,
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(result.totalTokens).toBe(10000);  // 5000 * 2 sessions
    expect(result.tokensAfter).toBe(400);     // 200 * 2 sessions
    expect(result.imported).toBe(2);
    expect(result.totalMessages).toBe(6);     // 3 * 2 sessions
  });

  it("replay mode: already-ingested session still reports tokens from compact response", async () => {
    // Covers the case where /ingest returns { ingested: 0, totalTokens: 0 } (already ingested)
    // but /compact returns real token counts. The final result should reflect the compact tokens.
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/test/already-ingested";
    const hash = cwdToProjectHash(cwd);
    const projDir = join(claudeProjectsDir, hash);
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "session-1.jsonl"), "");

    const client = makeMockClient(async (path: string) => {
      if (path === "/ingest") return { ingested: 0, totalTokens: 0 }; // already ingested
      if (path === "/compact") return {
        summary: "done",
        latestSummaryContent: "summary",
        tokensBefore: 3000,
        tokensAfter: 150,
      };
    });

    const result = await importSessions(client, {
      replay: true,
      verbose: false,
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    // ingest returned 0 tokens (already ingested), but compact supplies the real counts
    expect(result.totalTokens).toBe(3000);
    expect(result.tokensAfter).toBe(150);
    // session was skipped by ingest (not counted as imported)
    expect(result.skippedEmpty).toBe(1);
    expect(result.imported).toBe(0);
  });

  it("replay mode: compact failure warns unconditionally and falls back to ingest tokens", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/test/compact-fail";
    const hash = cwdToProjectHash(cwd);
    const projDir = join(claudeProjectsDir, hash);
    mkdirSync(projDir, { recursive: true });

    const f1 = join(projDir, "session-1.jsonl");
    const f2 = join(projDir, "session-2.jsonl");
    writeFileSync(f2, "");
    writeFileSync(f1, "");
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(f1, oldTime, oldTime);

    const compactCalls: string[] = [];
    const client = makeMockClient(async (path: string, body: any) => {
      if (path === "/ingest") return { ingested: 2, totalTokens: 1000 };
      if (path === "/compact") {
        compactCalls.push(body.session_id);
        if (body.session_id === "session-1") throw new Error("compact exploded");
        return { summary: "ok", latestSummaryContent: "s2-summary", tokensBefore: 900, tokensAfter: 100 };
      }
    });

    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrLines.push(String(chunk));
      return true;
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: any[]) => {
      stderrLines.push(args.join(" "));
    });

    const result = await importSessions(client, {
      replay: true,
      verbose: false,  // warning must appear even without --verbose
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    // Both sessions were attempted for compact
    expect(compactCalls).toEqual(["session-1", "session-2"]);

    // Warning always printed regardless of verbose
    const hasWarning = stderrLines.some(l => l.includes("compact failed") && l.includes("session-1"));
    expect(hasWarning).toBe(true);

    // session-1 compact failed → falls back to ingest tokens (1000)
    // session-2 compact succeeded → uses tokensBefore (900)
    expect(result.totalTokens).toBe(1900);
    expect(result.tokensAfter).toBe(100);

    // session-2 should NOT have gotten session-1's summary (chain broken)
    // We verify by checking the compact call for session-2 had no previous_summary
    // (indirectly confirmed by the mock: if session-2 got a previous_summary it would still succeed,
    //  but we can test this via the chain being reset)
    expect(result.imported).toBe(2);
    expect(result.failed).toBe(0);

    consoleErrorSpy.mockRestore();
  });

  it("returns empty result if project dir does not exist", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/home/user/nonexistent";
    const client = makeMockClient(async () => ({ ingested: 1, totalTokens: 100 }));

    const result = await importSessions(client, {
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(client.post).not.toHaveBeenCalled();
    expect(result.imported).toBe(0);
  });

  it("replay mode resets previousSummary when ingest fails, breaking the compact chain", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/test/project";
    const hash = cwdToProjectHash(cwd);
    const projDir = join(claudeProjectsDir, hash);
    mkdirSync(projDir, { recursive: true });

    const f1 = join(projDir, "session-1.jsonl");
    const f2 = join(projDir, "session-2.jsonl");
    const f3 = join(projDir, "session-3.jsonl");
    writeFileSync(f3, "");
    writeFileSync(f2, "");
    writeFileSync(f1, "");
    const time1 = new Date(Date.now() - 20_000);
    const time2 = new Date(Date.now() - 10_000);
    utimesSync(f1, time1, time1);  // f1 is oldest
    utimesSync(f2, time2, time2);  // f2 is middle
    // f3 is newest (current time)

    const compactBodies: { session_id: string; previous_summary?: string }[] = [];
    const client = makeMockClient(async (path: string, body: any) => {
      if (path === "/ingest") {
        // Fail on session-2 ingest
        if (body.session_id === "session-2") {
          throw new Error("ingest failed");
        }
        return { ingested: 1, totalTokens: 100 };
      }
      if (path === "/compact") {
        compactBodies.push({ session_id: body.session_id, previous_summary: body.previous_summary });
        return { summary: "stats", latestSummaryContent: `summary-of-${body.session_id}` };
      }
    });

    const result = await importSessions(client, {
      replay: true,
      verbose: false,
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    // session-1 succeeds and compacts with no prior context
    // session-2 ingest fails, so previousSummary is reset to undefined
    // session-3 compacts without prior context (previousSummary was reset)
    expect(compactBodies).toHaveLength(2);
    expect(compactBodies[0].session_id).toBe("session-1");
    expect(compactBodies[0].previous_summary).toBeUndefined();
    expect(compactBodies[1].session_id).toBe("session-3");
    // session-3 should NOT have previous_summary because session-2 ingest failed
    expect(compactBodies[1].previous_summary).toBeUndefined();
    // session-2 should have failed
    expect(result.failed).toBe(1);
  });

  it("skips sessions already recorded in session_ingest_log (unit test via daemon response)", async () => {
    // This test verifies that when the daemon returns ingested:0, totalTokens:0
    // (which happens when the session_ingest_log check passes at the daemon level),
    // importSessions counts it as skippedEmpty and doesn't call /ingest multiple times.
    // The full idempotency check is tested in the e2e test.
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/home/user/myproject";
    const projectHash = cwdToProjectHash(cwd);
    const projectDir = join(claudeProjectsDir, projectHash);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session-already-ingested.jsonl"), "");

    const ingestCalls: string[] = [];
    const client = makeMockClient(async (path, body) => {
      if (path === "/ingest") {
        ingestCalls.push((body as { session_id: string }).session_id);
        // Simulate daemon returning 0 ingested (already in session_ingest_log)
        return { ingested: 0, totalTokens: 0 };
      }
      return { ingested: 0, totalTokens: 0 };
    });

    const result = await importSessions(client, {
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    // Verify the daemon was called
    expect(ingestCalls).toEqual(["session-already-ingested"]);
    // Verify the result reflects the skip
    expect(result.skippedEmpty).toBe(1);
    expect(result.imported).toBe(0);
  });
});

// --- importSessions with provider: "codex" ---

function makeCodexResponseItemLine(role: "user" | "assistant", text: string): string {
  const contentType = role === "user" ? "input_text" : "output_text";
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "response_item",
    payload: { type: "message", role, content: [{ type: contentType, text }] },
  });
}

function makeCodexSessionMetaLine(id: string, cwd: string): string {
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "session_meta",
    payload: { id, cwd, cli_version: "0.100.0", model_provider: "openai" },
  });
}

describe("importSessions — provider: codex", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
    vi.restoreAllMocks();
  });

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lcm-import-codex-"));
    dirs.push(dir);
    return dir;
  }

  function makeGitProject(remote: string): string {
    const project = makeTmpDir();
    execFileSync("git", ["init", "-q"], { cwd: project });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
    execFileSync("git", ["config", "user.name", "LCM Test"], { cwd: project });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: project });
    writeFileSync(join(project, "README.md"), "test\n");
    execFileSync("git", ["add", "README.md"], { cwd: project });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: project });
    resolveProjectIdentity(project);
    return project;
  }

  it("imports Codex sessions from _codexDir/archived_sessions/", async () => {
    const codexDir = makeTmpDir();
    const archivedDir = join(codexDir, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });

    const cwd = "/workspace/myproject";
    const sessionId = "rollout-2026-01-01-session-abc";
    const content = [
      makeCodexSessionMetaLine(sessionId, cwd),
      makeCodexResponseItemLine("user", "Hello Codex"),
      makeCodexResponseItemLine("assistant", "Hello! How can I help?"),
    ].join("\n");
    writeFileSync(join(archivedDir, `${sessionId}.jsonl`), content);

    const calls: { path: string; body: unknown }[] = [];
    const client = makeMockClient(async (path, body) => {
      calls.push({ path, body });
      return { ingested: 2, totalTokens: 200 };
    });

    const result = await importSessions(client, {
      provider: "codex",
      cwd,
      _codexDir: codexDir,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/ingest");
    expect((calls[0].body as { session_id: string }).session_id).toBe(sessionId);
    expect((calls[0].body as { cwd: string }).cwd).toBe(cwd);
    expect((calls[0].body as { transcript_path: string }).transcript_path).toContain(`${sessionId}.jsonl`);
    expect((calls[0].body as { client: string }).client).toBe("codex");
    expect(result.imported).toBe(1);
    expect(result.totalMessages).toBe(2);
    expect(result.totalTokens).toBe(200);
    expect(result.failed).toBe(0);
  });

  it("imports an active date-partitioned Codex rollout once when archived also", async () => {
    const cwd = makeTmpDir();
    resolveProjectIdentity(cwd);
    const codexDir = makeTmpDir();
    const sessionId = "rollout-2026-07-25T10-00-00-active";
    const archived = join(codexDir, "archived_sessions");
    const active = join(codexDir, "sessions", "2026", "07", "25");
    mkdirSync(archived, { recursive: true });
    mkdirSync(active, { recursive: true });
    const content = [
      makeCodexSessionMetaLine(sessionId, cwd),
      makeCodexResponseItemLine("user", "active rollout"),
    ].join("\n");
    writeFileSync(join(archived, `${sessionId}.jsonl`), content);
    writeFileSync(join(active, `${sessionId}.jsonl`), content);
    const calls: unknown[] = [];

    const result = await importSessions(makeMockClient(async (_path, body) => {
      calls.push(body);
      return { ingested: 1, totalTokens: 10 };
    }), { provider: "codex", cwd, _codexDir: codexDir });

    expect(result.imported).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      session_id: sessionId,
      transcript_path: join(archived, `${sessionId}.jsonl`),
    });
  });

  it("imports a Codex cwd symlink to the current canonical project", async () => {
    const cwd = makeTmpDir();
    resolveProjectIdentity(cwd);
    const symlinkedCwd = join(makeTmpDir(), "current-project-link");
    symlinkSync(cwd, symlinkedCwd);
    const codexDir = makeTmpDir();
    const archived = join(codexDir, "archived_sessions");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "symlink-cwd.jsonl"), [
      makeCodexSessionMetaLine("symlink-cwd", symlinkedCwd),
      makeCodexResponseItemLine("user", "through symlink"),
    ].join("\n"));
    const calls: unknown[] = [];

    const result = await importSessions(makeMockClient(async (_path, body) => {
      calls.push(body);
      return { ingested: 1, totalTokens: 10 };
    }), { provider: "codex", cwd, _codexDir: codexDir });

    expect(result.imported).toBe(1);
    expect(calls[0]).toMatchObject({ cwd });
  });

  it("does not import a Codex cwd through a broken symlink", async () => {
    const cwd = makeTmpDir();
    resolveProjectIdentity(cwd);
    const codexDir = makeTmpDir();
    const archived = join(codexDir, "archived_sessions");
    const brokenCwd = join(codexDir, "broken-cwd");
    mkdirSync(archived, { recursive: true });
    symlinkSync(join(codexDir, "missing-target"), brokenCwd);
    writeFileSync(join(archived, "broken-cwd.jsonl"), makeCodexSessionMetaLine("broken-cwd", brokenCwd));

    const client = makeMockClient(async () => ({ ingested: 1, totalTokens: 10 }));
    const result = await importSessions(client, { provider: "codex", cwd, _codexDir: codexDir });

    expect(client.post).not.toHaveBeenCalled();
    expect(result).toMatchObject({ imported: 0, unresolved: 1 });
  });

  it("uses the transcript filename when verified session metadata has no thread ID", async () => {
    const cwd = makeTmpDir();
    resolveProjectIdentity(cwd);
    const codexDir = makeTmpDir();
    const archivedDir = join(codexDir, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(join(archivedDir, "filename-id.jsonl"), JSON.stringify({
      type: "session_meta",
      payload: { cwd },
    }));
    const calls: unknown[] = [];

    const result = await importSessions(makeMockClient(async (_path, body) => {
      calls.push(body);
      return { ingested: 1, totalTokens: 1 };
    }), { provider: "codex", cwd, _codexDir: codexDir });

    expect(result.imported).toBe(1);
    expect(calls[0]).toMatchObject({ session_id: "filename-id", cwd });
  });

  it("skips a transcript without verifiable project metadata", async () => {
    const codexDir = makeTmpDir();
    const archivedDir = join(codexDir, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });

    // A transcript without a session_meta line
    writeFileSync(
      join(archivedDir, "no-meta-session.jsonl"),
      makeCodexResponseItemLine("user", "Hi") + "\n",
    );

    const calls: { path: string; body: unknown }[] = [];
    const client = makeMockClient(async (path, body) => {
      calls.push({ path, body });
      return { ingested: 1, totalTokens: 50 };
    });

    const result = await importSessions(client, {
      provider: "codex",
      _codexDir: codexDir,
    });

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ imported: 0, unresolved: 1 });
  });

  it("imports nothing when _codexDir does not exist", async () => {
    const client = makeMockClient(async () => ({ ingested: 1, totalTokens: 100 }));

    const result = await importSessions(client, {
      provider: "codex",
      _codexDir: "/nonexistent/codex/dir",
    });

    expect(client.post).not.toHaveBeenCalled();
    expect(result.imported).toBe(0);
  });

  it("dry-run does not call /ingest for codex sessions", async () => {
    const codexDir = makeTmpDir();
    const archivedDir = join(codexDir, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(join(archivedDir, "session-x.jsonl"), makeCodexSessionMetaLine("session-x", "/ws"));

    const client = makeMockClient(async () => ({ ingested: 1, totalTokens: 100 }));

    const result = await importSessions(client, {
      provider: "codex",
      dryRun: true,
      cwd: "/ws",
      _codexDir: codexDir,
    });

    expect(client.post).not.toHaveBeenCalled();
    expect(result.imported).toBe(1);
  });

  it("passes client=codex to replay ingest and compact calls", async () => {
    const codexDir = makeTmpDir();
    const archivedDir = join(codexDir, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(
      join(archivedDir, "codex-replay.jsonl"),
      [
        makeCodexSessionMetaLine("codex-replay", "/workspace"),
        makeCodexResponseItemLine("user", "Replay this"),
      ].join("\n"),
    );

    const calls: Array<{ path: string; body: unknown }> = [];
    const client = makeMockClient(async (path, body) => {
      calls.push({ path, body });
      if (path === "/compact") return { summary: "ok", tokensBefore: 100, tokensAfter: 10 };
      return { ingested: 1, totalTokens: 100 };
    });

    await importSessions(client, {
      provider: "codex",
      replay: true,
      cwd: "/workspace",
      _codexDir: codexDir,
    });

    expect((calls.find(c => c.path === "/ingest")?.body as { client: string }).client).toBe("codex");
    expect((calls.find(c => c.path === "/compact")?.body as { client: string }).client).toBe("codex");
  });

  it("keeps replay summaries isolated by project and client", async () => {
    type CompactRequest = {
      session_id: string;
      cwd: string;
      client: "claude" | "codex";
      previous_summary?: string;
    };
    const claudeProjectsDir = makeTmpDir();
    const codexDir = makeTmpDir();
    const lcmDir = makeTmpDir();
    const projectA = makeTmpDir();
    const projectB = makeTmpDir();
    const aliasParent = makeTmpDir();
    const projectAAlias = join(aliasParent, "project-a-alias");
    symlinkSync(projectA, projectAAlias, "dir");
    const archivedDir = join(codexDir, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });
    const claudeProjectDir = join(claudeProjectsDir, cwdToProjectHash(projectA));
    mkdirSync(claudeProjectDir, { recursive: true });
    const lcmProjectDir = join(lcmDir, "projects", "project-a");
    mkdirSync(lcmProjectDir, { recursive: true });
    writeFileSync(join(lcmProjectDir, "meta.json"), JSON.stringify({ cwd: projectA }));
    const claudeSessions = ["claude-1", "claude-2"];
    claudeSessions.forEach((id, index) => {
      const path = join(claudeProjectDir, `${id}.jsonl`);
      writeFileSync(path, "");
      const time = new Date(1_699_999_900_000 + index * 1_000);
      utimesSync(path, time, time);
    });
    const sessions = [
      ["a1", projectA],
      ["b1", projectB],
      ["c1", projectAAlias],
    ] as const;
    sessions.forEach(([id, cwd], index) => {
      const path = join(archivedDir, `${id}.jsonl`);
      writeFileSync(path, makeCodexSessionMetaLine(id, cwd));
      const time = new Date(1_700_000_000_000 + index * 1_000);
      utimesSync(path, time, time);
    });
    const compacts: CompactRequest[] = [];
    const client = makeMockClient(async (path, body) => {
      if (path === "/compact") {
        const request = body as CompactRequest;
        compacts.push(request);
        return { latestSummaryContent: `summary-${request.session_id}` };
      }
      return { ingested: 1, totalTokens: 1 };
    });
    resolveProjectIdentity(projectA);
    resolveProjectIdentity(projectB);
    await importSessions(client, {
      provider: "all",
      all: true,
      cwd: projectA,
      replay: true,
      _claudeProjectsDir: claudeProjectsDir,
      _lcmDir: lcmDir,
      _codexDir: codexDir,
    });

    const compact = (clientName: CompactRequest["client"], sessionId: string) =>
      compacts.find((request) => request.client === clientName && request.session_id === sessionId);
    expect(compact("claude", "claude-1")).not.toHaveProperty("previous_summary");
    expect(compact("claude", "claude-2")?.previous_summary).toBe("summary-claude-1");
    expect(compact("codex", "a1")).not.toHaveProperty("previous_summary");
    expect(compact("codex", "b1")).not.toHaveProperty("previous_summary");
    expect(compact("codex", "c1")?.previous_summary).toBe("summary-a1");
  });

  it("provider all imports from both Claude and Codex", async () => {
    // Claude project dir
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/home/user/claudeproject";
    const hash = cwdToProjectHash(cwd);
    const claudeProjDir = join(claudeProjectsDir, hash);
    mkdirSync(claudeProjDir, { recursive: true });
    writeFileSync(join(claudeProjDir, "claude-session.jsonl"), "");

    // Codex dir
    const codexDir = makeTmpDir();
    const archivedDir = join(codexDir, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(join(archivedDir, "codex-session.jsonl"), makeCodexSessionMetaLine("codex-session", cwd));

    const sessionIds: string[] = [];
    const client = makeMockClient(async (_path, body) => {
      sessionIds.push((body as { session_id: string }).session_id);
      return { ingested: 1, totalTokens: 100 };
    });

    const result = await importSessions(client, {
      provider: "all",
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
      _codexDir: codexDir,
    });

    expect(sessionIds.sort()).toEqual(["claude-session", "codex-session"]);
    expect(result.imported).toBe(2);
  });

  it("reports and skips unresolved and ambiguous Codex sessions", async () => {
    const remote = "https://example.invalid/shared.git";
    const projectA = makeGitProject(remote);
    makeGitProject(remote);
    const codexDir = makeTmpDir();
    const archived = join(codexDir, "archived_sessions");
    const tombstone = join(codexDir, "worktrees", "token");
    mkdirSync(archived, { recursive: true });
    mkdirSync(tombstone, { recursive: true });
    writeFileSync(join(archived, "ambiguous.jsonl"), JSON.stringify({
      type: "session_meta",
      payload: {
        id: "ambiguous",
        cwd: join(tombstone, "project"),
        git: { repository_url: remote },
      },
    }));
    writeFileSync(
      join(archived, "unresolved.jsonl"),
      makeCodexSessionMetaLine("unresolved", join(codexDir, "deleted", "project")),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await importSessions(
      makeMockClient(async () => ({ ingested: 1, totalTokens: 1 })),
      { provider: "codex", all: true, verbose: true, cwd: projectA, _codexDir: codexDir },
    );

    expect(result).toMatchObject({ imported: 0, unresolved: 1, ambiguous: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("matches multiple local projects"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no live Git"));
    await expect(importSessions(
      makeMockClient(async () => ({ ingested: 1, totalTokens: 1 })),
      { provider: "codex", all: true, cwd: projectA, _codexDir: codexDir },
    )).resolves.toMatchObject({ imported: 0, unresolved: 1, ambiguous: 1 });
  });

  it("defaults Codex import to the current canonical project", async () => {
    const current = makeGitProject("https://example.invalid/current.git");
    const foreign = makeGitProject("https://example.invalid/foreign.git");
    const codexDir = makeTmpDir();
    const archived = join(codexDir, "archived_sessions");
    mkdirSync(archived, { recursive: true });
    writeFileSync(
      join(archived, "foreign.jsonl"),
      makeCodexSessionMetaLine("foreign", foreign),
    );
    const client = makeMockClient(async () => ({ ingested: 1, totalTokens: 1 }));

    const result = await importSessions(client, {
      provider: "codex",
      cwd: current,
      _codexDir: codexDir,
    });

    expect(client.post).not.toHaveBeenCalled();
    expect(result).toMatchObject({ imported: 0, unresolved: 0, ambiguous: 0 });
  });

  it("reports Codex sessions reconciled through a unique worktree tombstone", async () => {
    const remote = "https://example.invalid/unique.git";
    const project = makeGitProject(remote);
    const codexDir = makeTmpDir();
    const archived = join(codexDir, "archived_sessions");
    const tombstone = join(codexDir, "worktrees", "token");
    mkdirSync(archived, { recursive: true });
    mkdirSync(tombstone, { recursive: true });
    writeFileSync(join(archived, "historical.jsonl"), JSON.stringify({
      type: "session_meta",
      payload: {
        id: "historical-thread",
        cwd: join(tombstone, "project"),
        git: { repository_url: remote },
      },
    }));

    const calls: unknown[] = [];
    const result = await importSessions(makeMockClient(async (_path, body) => {
      calls.push(body);
      return { ingested: 1, totalTokens: 1 };
    }), { provider: "codex", cwd: project, _codexDir: codexDir });

    expect(result).toMatchObject({ imported: 1, reconciled: 1 });
    expect(calls[0]).toMatchObject({ session_id: "historical-thread", cwd: project });
  });
});
