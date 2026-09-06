import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { batchCompact, findUncompacted, formatLlmDiagnostic, runBatchWorkerPool } from "../src/batch-compact.js";
import * as cliStorage from "../src/cli-storage.js";
import * as daemonConfig from "../src/daemon/config.js";
import { DaemonClient } from "../src/daemon/client.js";
import { closeLcmConnection, getLcmConnection, getPoolStats } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { addProjectAlias, clearProjectMapCache, projectMapPath } from "../src/project-map.js";
import { ensureProjectDir, projectPaths } from "../src/daemon/project.js";

const FULL_SUITE_DISCOVERY_TEST_TIMEOUT_MS = 15_000;

function resetLcmHome(): void {
  rmSync(join(homedir(), ".lcm"), { recursive: true, force: true });
  mkdirSync(join(homedir(), ".lcm"), { recursive: true, mode: 0o700 });
  chmodSync(join(homedir(), ".lcm"), 0o700);
  clearProjectMapCache();
}

function makeDir(name: string): string {
  const path = join(homedir(), name);
  mkdirSync(path, { recursive: true });
  return path;
}

function insertMessages(db: DatabaseSync, conversationId: number, count = 9, totalTokens = 250): void {
  for (let seq = 1; seq <= count; seq++) {
    const result = db.prepare(
      "INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, ?, ?, ?)",
    ).run(conversationId, seq, "user", `hello ${conversationId}-${seq}`, seq === 1 ? totalTokens - count + 1 : 1);
    db.prepare(
      "INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, 'message', ?)",
    ).run(conversationId, seq - 1, Number(result.lastInsertRowid));
  }
}

function seedConversation(dbPath: string, messageCount = 9): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runLcmMigrations(db);
    db.prepare("INSERT INTO conversations (conversation_id, session_id) VALUES (?, ?)").run(1, "session-1");
    insertMessages(db, 1, messageCount);
  } finally {
    db.close();
  }
}

function seedConversations(dbPath: string, ids: readonly number[] = [1, 2]): void {
  const db = getLcmConnection(dbPath);
  try {
    runLcmMigrations(db);
    for (const id of ids) {
      db.prepare("INSERT INTO conversations (conversation_id, session_id) VALUES (?, ?)").run(id, `session-${id}`);
      insertMessages(db, id);
    }
  } finally {
    closeLcmConnection(dbPath);
  }
}

describe("batch compaction discovery", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-batch-home-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    resetLcmHome();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearProjectMapCache();
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it("discovers a persisted project binding without requiring redundant metadata", async () => {
    const cwd = makeDir("compact-bound-without-metadata");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    rmSync(paths.metaPath);

    expect(await findUncompacted(100, true, cwd)).toEqual([
      expect.objectContaining({ cwd: paths.canonical, sessionId: "session-1" }),
    ]);
  });

  it("skips a bound project whose SQLite database does not exist without creating it", async () => {
    const cwd = makeDir("compact-bound-empty");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const dryRun of [true, false]) {
      expect(await batchCompact({ minTokens: 100, dryRun, port: 3737, cwd })).toEqual({
        compacted: 0, unchanged: 0, skipped: 0, failures: 0, compactedProjects: [],
      });
      expect(existsSync(paths.dbPath)).toBe(false);
    }
  });

  it("leaves unmigrated SQLite schema and user version unchanged during preview", async () => {
    const cwd = makeDir("compact-unmigrated-preview");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const db = new DatabaseSync(paths.dbPath);
    db.exec("DROP TABLE session_ingest_log; PRAGMA user_version = 17");
    const schema = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    db.close();
    expect(await findUncompacted(100, true, cwd)).toEqual([
      expect.objectContaining({ sessionId: "session-1", messages: 9, tokens: 250 }),
    ]);
    const reopened = new DatabaseSync(paths.dbPath);
    try {
      expect(reopened.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 17 });
      expect(reopened.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(schema);
    } finally { reopened.close(); }
    expect(getPoolStats().totalConnections).toBe(0);
  });

  it("counts paginated messages and keeps descending token priority", async () => {
    const cwd = makeDir("compact-message-pages");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const db = new DatabaseSync(paths.dbPath);
    db.prepare("INSERT INTO conversations (conversation_id, session_id) VALUES (?, ?)").run(2, "large");
    insertMessages(db, 2, 501, 5010);
    db.close();
    expect(await findUncompacted(100, true, cwd)).toEqual([
      expect.objectContaining({ sessionId: "large", messages: 501, tokens: 5010 }),
      expect.objectContaining({ sessionId: "session-1", messages: 9, tokens: 250 }),
    ]);
  });

  it("rejects symlinked databases during preview without reading the target", async () => {
    const cwd = makeDir("compact-symlink-db");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    const target = join(homedir(), "external.sqlite");
    seedConversation(target);
    symlinkSync(target, paths.dbPath);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await batchCompact({ minTokens: 100, dryRun: true, port: 3737, cwd })).toMatchObject({ failures: 1 });
    expect(getPoolStats().totalConnections).toBe(0);
  });

  it("keeps progress on stderr and hides raw transport errors", async () => {
    const cwd = makeDir("compact-private-output");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const canary = "postgresql://private-user:private-password@private-host/private-db SELECT secret";
    vi.spyOn(DaemonClient.prototype, "post").mockRejectedValue(new Error(canary));
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const progress: Array<Partial<ProgressState>> = [];
    expect(await batchCompact({ minTokens: 100, dryRun: false, port: 3737, cwd,
      onProgress: patch => progress.push(patch),
    })).toMatchObject({ failures: 1 });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("compaction request failed"));
    expect(JSON.stringify([stderr.mock.calls, progress])).not.toContain(canary);
  });

  it("excludes empty conversations and conversations below the token threshold", async () => {
    const cwd = makeDir("compact-threshold");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    const db = new DatabaseSync(paths.dbPath);
    db.prepare("INSERT INTO conversations (conversation_id, session_id) VALUES (?, ?)").run(2, "empty");
    db.close();
    expect(await findUncompacted(251, true, cwd)).toEqual([]);
  });

  it("rejects identities changed or removed after enumeration before opening SQLite", async () => {
    const cwd = makeDir("compact-rebound");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    vi.spyOn(cliStorage, "listCliProjects").mockResolvedValue([
      { id: "0".repeat(64), canonical: cwd, aliases: [] },
      { id: "1".repeat(64), canonical: makeDir("compact-removed"), aliases: [] },
    ]);
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await batchCompact({ minTokens: 100, dryRun: true, port: 3737 })).toMatchObject({ failures: 2 });
    expect(output).toHaveBeenCalledWith(expect.stringContaining("project storage discovery failed"));
    expect(getPoolStats().totalConnections).toBe(0);
  });

  it("rejects a changed backend selection before composing SQLite preview repositories", async () => {
    const cwd = makeDir("compact-selection-change");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    vi.spyOn(cliStorage, "listCliProjects").mockResolvedValue([
      { id: paths.id, canonical: cwd, aliases: [] },
    ]);
    const config = daemonConfig.loadDaemonConfig(join(homedir(), ".lcm", "config.json"));
    vi.spyOn(daemonConfig, "loadDaemonConfig")
      .mockReturnValueOnce(config)
      .mockReturnValueOnce(config)
      .mockReturnValue({ ...config, storage: { ...config.storage, backend: "postgresql" } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await batchCompact({ minTokens: 100, dryRun: true, port: 3737 })).toMatchObject({ failures: 1 });
    expect(getPoolStats().totalConnections).toBe(0);
  });

  it("matches current-project filters through project-map aliases", async () => {
    const canonical = makeDir("compact-canonical");
    const alias = makeDir("compact-alias");
    const paths = projectPaths(canonical);
    ensureProjectDir(canonical);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }, null, 2) + "\n");
    seedConversation(paths.dbPath);
    addProjectAlias(alias, { canonical });
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec");

    const conversations = await findUncompacted(100, true, alias);

    expect(conversations).toHaveLength(1);
    expect(conversations[0].cwd).toBe(paths.canonical);
    expect(conversations[0].sessionId).toBe("session-1");
    expect(execSpy.mock.calls.filter(([sql]) => sql === "PRAGMA busy_timeout = 5000")).toHaveLength(1);
    expect(getPoolStats().totalConnections).toBe(0);

    const victim = makeDir("compact-alias-victim");
    rmSync(alias, { recursive: true });
    symlinkSync(victim, alias, "dir");
    expect(await findUncompacted(100, true, alias)).toHaveLength(1);
    expect(await findUncompacted(100, true, victim)).toEqual([]);
  });

  it("does not match a current-project filter that is unrelated to the map entry", async () => {
    const canonical = makeDir("compact-unmatched");
    const unrelated = makeDir("compact-unrelated");
    const paths = projectPaths(canonical);
    ensureProjectDir(canonical);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }, null, 2) + "\n");
    seedConversation(paths.dbPath);

    expect(await findUncompacted(100, true, unrelated)).toEqual([]);
  });

  it("discovers a linked Git worktree once using the shared canonical project", async () => {
    const canonical = makeDir("compact-git-main");
    const linked = join(homedir(), "compact-git-linked");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: canonical });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false",
      "commit", "--allow-empty", "--signoff", "-qm", "fixture"], { cwd: canonical });
    execFileSync("git", ["worktree", "add", "-q", "-b", "linked", linked], { cwd: canonical });
    const paths = projectPaths(canonical);
    ensureProjectDir(canonical);
    seedConversation(paths.dbPath);
    expect(projectPaths(linked).id).toBe(paths.id);
    expect(await findUncompacted(100, true, linked)).toEqual([
      expect.objectContaining({ cwd: canonical, projectDir: paths.dir, sessionId: "session-1" }),
    ]);
    expect(await findUncompacted(100, true)).toHaveLength(1);
  });

  it("requires at least one raw message outside the manual fresh tail", async () => {
    const protectedCwd = makeDir("compact-protected-tail");
    const protectedPaths = projectPaths(protectedCwd);
    ensureProjectDir(protectedCwd);
    writeFileSync(protectedPaths.metaPath, JSON.stringify({ cwd: protectedPaths.canonical }));
    seedConversation(protectedPaths.dbPath, 8);

    const eligibleCwd = makeDir("compact-outside-tail");
    const eligiblePaths = projectPaths(eligibleCwd);
    ensureProjectDir(eligibleCwd);
    writeFileSync(eligiblePaths.metaPath, JSON.stringify({ cwd: eligiblePaths.canonical }));
    seedConversation(eligiblePaths.dbPath, 9);

    expect(await findUncompacted(100, true, protectedCwd)).toEqual([]);
    expect(await findUncompacted(100, true, eligibleCwd)).toEqual([
      expect.objectContaining({ cwd: eligiblePaths.canonical, messages: 9 }),
    ]);
  });

  it("discovers authenticated legacy hash metadata through canonical symlinks", async () => {
    const canonical = makeDir("compact-legacy-canonical");
    const legacyLink = join(homedir(), "compact-legacy-link");
    symlinkSync(canonical, legacyLink, "dir");
    const projectDir = join(homedir(), ".lcm", "projects", "a".repeat(64));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd: legacyLink }));
    seedConversation(join(projectDir, "db.sqlite"));

    expect(await findUncompacted(100, true, canonical)).toHaveLength(1);
  });

  it("returns failures while continuing to compact later sessions", async () => {
    const cwd = makeDir("compact-partial-failure");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }, null, 2) + "\n");
    seedConversations(paths.dbPath);
    const post = vi.spyOn(DaemonClient.prototype, "post")
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ tokensBefore: 250, tokensAfter: 50 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const progress: Array<Partial<ProgressState>> = [];

    const result = await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      onProgress: patch => progress.push(patch),
    });

    expect(result).toEqual({ compacted: 1, unchanged: 0, skipped: 0, failures: 1, compactedProjects: [paths.canonical] });
    expect(post).toHaveBeenCalledTimes(2);
    expect(progress.find(patch => patch.errors)).toMatchObject({ completed: 0, current: undefined });
    expect(progress.at(-1)).toMatchObject({ completed: 1, current: undefined });
  });

  it("retains SQLite scan failures while compacting readable projects", async () => {
    const healthyCwd = makeDir("compact-readable-project");
    const healthyPaths = projectPaths(healthyCwd);
    ensureProjectDir(healthyCwd);
    writeFileSync(healthyPaths.metaPath, JSON.stringify({ cwd: healthyPaths.canonical }));
    seedConversation(healthyPaths.dbPath);

    const corruptCwd = makeDir("compact-unreadable-project");
    const corruptProjectDir = projectPaths(corruptCwd).dir;
    ensureProjectDir(corruptCwd);
    writeFileSync(join(corruptProjectDir, "meta.json"), JSON.stringify({ cwd: corruptCwd }));
    writeFileSync(join(corruptProjectDir, "db.sqlite"), "not sqlite");

    const post = vi.spyOn(DaemonClient.prototype, "post")
      .mockResolvedValue({ tokensBefore: 250, tokensAfter: 50 });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const progress: Array<Partial<ProgressState>> = [];

    const result = await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      onProgress: patch => progress.push(patch),
    });

    expect(result).toEqual({
      compacted: 1,
      unchanged: 0,
      skipped: 0,
      failures: 1,
      compactedProjects: [healthyPaths.canonical],
    });
    expect(post).toHaveBeenCalledOnce();
    expect(progress[0]).toEqual({
      total: 1,
      phaseErrors: [{
        phase: "Compact",
        target: corruptCwd,
        message: "project storage discovery failed",
      }],
    });
    expect(progress.at(-1)).toMatchObject({ completed: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`compact scan failed for ${corruptCwd}`));
    expect(log).not.toHaveBeenCalledWith("Nothing to compact — no sessions are currently eligible.");
  });

  it("fails an all-unreadable scan without claiming there is nothing to compact", async () => {
    const corruptCwd = makeDir("compact-only-unreadable-project");
    const corruptProjectDir = projectPaths(corruptCwd).dir;
    ensureProjectDir(corruptCwd);
    writeFileSync(join(corruptProjectDir, "meta.json"), JSON.stringify({ cwd: corruptCwd }));
    writeFileSync(join(corruptProjectDir, "db.sqlite"), "not sqlite");

    const post = vi.spyOn(DaemonClient.prototype, "post");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const progress: Array<Partial<ProgressState>> = [];

    expect(await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      onProgress: patch => progress.push(patch),
    })).toEqual({
      compacted: 0,
      unchanged: 0,
      skipped: 0,
      failures: 1,
      compactedProjects: [],
    });
    expect(post).not.toHaveBeenCalled();
    expect(progress).toEqual([{
      total: 0,
      phaseErrors: [{
        phase: "Compact",
        target: corruptCwd,
        message: "project storage discovery failed",
      }],
    }]);
    expect(log).not.toHaveBeenCalledWith("Nothing to compact — no sessions are currently eligible.");
    expect(error).toHaveBeenCalledWith("No sessions were compacted because project discovery failed.");
  });

  it("ignores directories without authenticated project bindings", async () => {
    const projectsDir = join(homedir(), ".lcm", "projects");
    for (const [index, metadata] of [undefined, "{", "{}"].entries()) {
      const projectDir = join(projectsDir, String(index).repeat(64));
      mkdirSync(projectDir, { recursive: true, mode: 0o700 });
      seedConversation(join(projectDir, "db.sqlite"));
      if (metadata !== undefined) writeFileSync(join(projectDir, "meta.json"), metadata);
    }
    const post = vi.spyOn(DaemonClient.prototype, "post");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await batchCompact({ minTokens: 100, dryRun: true, port: 3737 })).toEqual({
      compacted: 0, unchanged: 0, skipped: 0, failures: 0, compactedProjects: [],
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("deduplicates canonical and alias bindings during all-project discovery", async () => {
    const cwd = makeDir("compact-dedup-canonical");
    const alias = makeDir("compact-dedup-alias");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    addProjectAlias(alias, { canonical: cwd });
    const aliasHash = "a".repeat(64);
    const legacyDir = join(homedir(), ".lcm", "projects", aliasHash);
    mkdirSync(legacyDir, { mode: 0o700 });
    writeFileSync(join(legacyDir, "meta.json"), JSON.stringify({ cwd }));
    seedConversation(join(legacyDir, "db.sqlite"));
    expect(await findUncompacted(100, true)).toEqual([
      expect.objectContaining({ cwd, projectDir: paths.dir, sessionId: "session-1" }),
    ]);
  });

  it("fails closed when the project map is malformed instead of trusting metadata", async () => {
    const cwd = makeDir("compact-malformed-map");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    seedConversation(paths.dbPath);
    writeFileSync(projectMapPath(), "{");
    clearProjectMapCache();
    const post = vi.spyOn(DaemonClient.prototype, "post");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const progress: Array<Partial<ProgressState>> = [];
    expect(await batchCompact({ minTokens: 100, dryRun: true, port: 3737, cwd,
      onProgress: patch => progress.push(patch),
    })).toEqual({ compacted: 0, unchanged: 0, skipped: 0, failures: 1, compactedProjects: [] });
    expect(progress).toEqual([{ total: 0, phaseErrors: [
      { phase: "Compact", target: cwd, message: "project discovery failed" },
    ] }]);
    expect(post).not.toHaveBeenCalled();
    expect(await batchCompact({ minTokens: 100, dryRun: true, port: 3737 })).toMatchObject({ failures: 1 });
  });

  it("counts each successful session once and falls back to discovered input tokens", async () => {
    const cwd = makeDir("compact-aggregate-totals");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }, null, 2) + "\n");
    seedConversations(paths.dbPath);
    const firstLabel = `${paths.canonical} conv #1 (9 msgs, 0.3k tokens)`;
    const secondLabel = `${paths.canonical} conv #2 (9 msgs, 0.3k tokens)`;
    const post = vi.spyOn(DaemonClient.prototype, "post")
      .mockResolvedValueOnce({ tokensBefore: 250, tokensAfter: 250 })
      .mockResolvedValueOnce({ tokensBefore: 300, tokensAfter: 30 });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const progress: Array<Record<string, unknown>> = [];

    const result = await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      verbose: true,
      fastMode: false,
      requestPolicy: {
        requestTimeoutMs: 120_000,
        retry: { maxAttempts: 4, initialDelayMs: 500, maxDelayMs: 10_000, multiplier: 2 },
      },
      onProgress: patch => progress.push(patch),
    });

    expect(result).toEqual({ compacted: 2, unchanged: 0, skipped: 0, failures: 0, compactedProjects: [paths.canonical] });
    expect(progress.at(-1)).toMatchObject({
      completed: 2,
      messagesIn: 18,
      tokensIn: 550,
      tokensOut: 280,
      lastResult: {
        sessionId: "session-2",
        tokensBefore: 300,
        tokensAfter: 30,
      },
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      "2 sessions compacted, 0.6k → 0.3k tokens (49% reduction, 0.3k freed)",
    ));
    expect(log).toHaveBeenCalledWith(`${firstLabel} done  (0.3k → 0.3k tokens, 0% reduction)`);
    expect(log).toHaveBeenCalledWith(`${secondLabel} done  (0.3k → 0.0k tokens, 90% reduction)`);
    expect(post).toHaveBeenNthCalledWith(1, "/compact", expect.objectContaining({
      fast_mode: false,
      request_timeout_ms: 120_000,
      retry: {
        max_attempts: 4,
        initial_delay_ms: 500,
        max_delay_ms: 10_000,
        multiplier: 2,
      },
    }));
  });

  it("threads invocation identity and abort signal through compact requests", async () => {
    const cwd = makeDir("compact-invocation-forwarding");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    const signal = new AbortController().signal;
    const post = vi.spyOn(DaemonClient.prototype, "post")
      .mockResolvedValue({ tokensBefore: 250, tokensAfter: 50 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      invocationId: "22222222-2222-4222-8222-222222222222",
      signal,
    });

    expect(post).toHaveBeenCalledWith("/compact", expect.objectContaining({
      invocation_id: "22222222-2222-4222-8222-222222222222",
    }), { signal });
  });

  it("does not create compact requests during dry-run even when an invocation is supplied", async () => {
    const cwd = makeDir("compact-invocation-dry-run");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    const post = vi.spyOn(DaemonClient.prototype, "post");

    await batchCompact({
      minTokens: 100,
      dryRun: true,
      port: 3737,
      cwd,
      invocationId: "22222222-2222-4222-8222-222222222222",
    });

    expect(post).not.toHaveBeenCalled();
  });

  it("reports daemon transport loss to the command drain callback", async () => {
    const cwd = makeDir("compact-transport-loss");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    const transportError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    vi.spyOn(DaemonClient.prototype, "post").mockRejectedValue(transportError);
    const onTransportFailure = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      invocationId: "22222222-2222-4222-8222-222222222222",
      onTransportFailure,
    });

    expect(onTransportFailure).toHaveBeenCalledWith(transportError);
  });

  it("reports daemon no-ops as unchanged and excludes them from promotion projects", async () => {
    const cwd = makeDir("compact-noop-accounting");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversations(paths.dbPath);
    vi.spyOn(DaemonClient.prototype, "post")
      .mockResolvedValueOnce({
        actionTaken: false,
        summary: "Summarization disabled — no summarizer configured.",
        tokensBefore: 125,
        tokensAfter: 120,
      })
      .mockResolvedValueOnce({ actionTaken: true, tokensBefore: 250, tokensAfter: 50 });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const progress: Array<Partial<ProgressState>> = [];

    const result = await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      onProgress: patch => progress.push(patch),
    });

    expect(result).toEqual({ compacted: 1, unchanged: 1, skipped: 0, failures: 0, compactedProjects: [paths.canonical] });
    expect(log).toHaveBeenCalledWith(`${paths.canonical} conv #1 (9 msgs, 0.3k tokens) unchanged (Summarization disabled — no summarizer configured.)`);
    expect(progress.find(patch => patch.lastResult?.sessionId === "session-1")?.lastResult).toMatchObject({
      tokensBefore: 125,
      tokensAfter: 120,
    });
  });

  it("falls back to stored tokens and a generic message for metadata-free daemon no-ops", async () => {
    const cwd = makeDir("compact-noop-fallbacks");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    vi.spyOn(DaemonClient.prototype, "post").mockResolvedValue({ actionTaken: false });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const progress: Array<Partial<ProgressState>> = [];

    const result = await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      onProgress: patch => progress.push(patch),
    });

    expect(result).toEqual({ compacted: 0, unchanged: 1, skipped: 0, failures: 0, compactedProjects: [] });
    expect(log).toHaveBeenCalledWith(`${paths.canonical} conv #1 (9 msgs, 0.3k tokens) unchanged (No compaction needed.)`);
    expect(progress.at(-1)?.lastResult).toMatchObject({ tokensBefore: 250, tokensAfter: 250 });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty object", {}],
  ] as const)("accounts a non-dry-run %s response as a failure", async (_name, response) => {
    const cwd = makeDir("compact-malformed-response");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    const post = vi.spyOn(DaemonClient.prototype, "post").mockResolvedValue(response as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const progress: Array<Partial<ProgressState>> = [];

    const result = await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      onProgress: patch => progress.push(patch),
    });

    expect(result).toEqual({ compacted: 0, unchanged: 0, skipped: 0, failures: 1, compactedProjects: [] });
    expect(post).toHaveBeenCalledOnce();
    expect(progress.find(patch => patch.errors)).toMatchObject({
      errors: [{ sessionId: "session-1", message: "malformed compact response" }],
    });
    expect(progress).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ messagesIn: expect.anything() }),
      expect.objectContaining({ tokensIn: expect.anything() }),
      expect.objectContaining({ tokensOut: expect.anything() }),
    ]));
    expect(log).toHaveBeenCalledWith("\nBatch compact complete.");
  });

  it("accepts a token-after-only compact response with discovered input fallback", async () => {
    const cwd = makeDir("compact-token-after-fallback");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    vi.spyOn(DaemonClient.prototype, "post").mockResolvedValue({ tokensAfter: 50 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(batchCompact({ minTokens: 100, dryRun: false, port: 3737, cwd }))
      .resolves.toMatchObject({ compacted: 1, failures: 0 });
  });

  it("sends a process-provider timeout without an implicit retry override", async () => {
    const cwd = makeDir("compact-process-timeout-only");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }, null, 2) + "\n");
    seedConversations(paths.dbPath);
    const post = vi.spyOn(DaemonClient.prototype, "post")
      .mockResolvedValue({ tokensBefore: 250, tokensAfter: 50 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      requestPolicy: { requestTimeoutMs: 300_000 },
    });

    expect(post).toHaveBeenCalled();
    for (const [, body] of post.mock.calls) {
      expect(body).toMatchObject({ request_timeout_ms: 300_000 });
      expect(body).not.toHaveProperty("retry");
    }
  });

  it("handles absent, malformed, summarized, and replay discovery entries", async () => {
    expect(await findUncompacted(100, true)).toEqual([]);

    const projectsDir = join(homedir(), ".lcm", "projects");
    mkdirSync(projectsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(projectsDir, "not-a-directory"), "ignored");
    mkdirSync(join(projectsDir, "missing-db"), { mode: 0o700 });

    const corruptMeta = join(projectsDir, "corrupt-meta");
    mkdirSync(corruptMeta, { mode: 0o700 });
    writeFileSync(join(corruptMeta, "db.sqlite"), "not sqlite");
    writeFileSync(join(corruptMeta, "meta.json"), "{");

    const missingCwd = join(projectsDir, "missing-cwd");
    mkdirSync(missingCwd, { mode: 0o700 });
    writeFileSync(join(missingCwd, "db.sqlite"), "not sqlite");
    writeFileSync(join(missingCwd, "meta.json"), "{}");

    const missingMeta = join(projectsDir, "missing-meta");
    mkdirSync(missingMeta, { mode: 0o700 });
    seedConversation(join(missingMeta, "db.sqlite"));

    const corruptDb = join(projectsDir, "corrupt-db");
    mkdirSync(corruptDb, { mode: 0o700 });
    writeFileSync(join(corruptDb, "db.sqlite"), "not sqlite");
    writeFileSync(join(corruptDb, "meta.json"), JSON.stringify({ cwd: "/corrupt" }));

    const cwd = makeDir("compact-replay");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    const db = new DatabaseSync(paths.dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare(
      "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids) VALUES (?, ?, ?, ?, ?, '[]')",
    ).run("summary-1", 1, "leaf", "summary", 10);
    db.close();

    expect(await findUncompacted(100, true, cwd)).toEqual([]);
    expect(await findUncompacted(100, true, cwd, true)).toHaveLength(1);
    expect(await findUncompacted(100, false, cwd, true)).toHaveLength(1);
    expect(await findUncompacted(100, true)).toHaveLength(0);

    const replayDb = new DatabaseSync(paths.dbPath);
    try {
      replayDb.exec("PRAGMA journal_mode = WAL");
      replayDb.exec("PRAGMA foreign_keys = ON");
      replayDb.prepare(
        "UPDATE context_items SET item_type = 'summary', message_id = NULL, summary_id = ? WHERE conversation_id = ? AND ordinal = 0",
      ).run("summary-1", 1);
    } finally {
      replayDb.close();
    }
    expect(await findUncompacted(100, true, cwd, true)).toEqual([]);

    const condensationDb = new DatabaseSync(paths.dbPath);
    try {
      condensationDb.exec("PRAGMA journal_mode = WAL");
      condensationDb.exec("PRAGMA foreign_keys = ON");
      condensationDb.exec("BEGIN");
      const insertSummary = condensationDb.prepare(
        "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, depth, file_ids) VALUES (?, ?, ?, ?, ?, ?, '[]')",
      );
      insertSummary.run("summary-2", 1, "leaf", "summary", 1_000, 0);
      insertSummary.run("summary-3", 1, "leaf", "x".repeat(4_000), 0, 0);
      const replaceMessage = condensationDb.prepare(
        "UPDATE context_items SET item_type = 'summary', message_id = NULL, summary_id = ? WHERE conversation_id = ? AND ordinal = ?",
      );
      replaceMessage.run("summary-2", 1, 1);
      replaceMessage.run("summary-3", 1, 2);
      condensationDb.exec("COMMIT");
    } finally {
      condensationDb.close();
    }
    expect(await findUncompacted(100, true, cwd, true)).toHaveLength(1);

    const interruptedRunDb = new DatabaseSync(paths.dbPath);
    try {
      interruptedRunDb.exec("PRAGMA journal_mode = WAL");
      interruptedRunDb.exec("PRAGMA foreign_keys = ON");
      interruptedRunDb.prepare("UPDATE summaries SET depth = CASE summary_id WHEN 'summary-1' THEN 1 ELSE 0 END WHERE conversation_id = ?").run(1);
    } finally {
      interruptedRunDb.close();
    }
    expect(await findUncompacted(100, true, cwd, true)).toEqual([]);

    const chunkLimitDb = new DatabaseSync(paths.dbPath);
    try {
      chunkLimitDb.exec("PRAGMA journal_mode = WAL");
      chunkLimitDb.exec("PRAGMA foreign_keys = ON");
      chunkLimitDb.prepare("UPDATE summaries SET depth = 0, token_count = CASE summary_id WHEN 'summary-1' THEN 15000 WHEN 'summary-2' THEN 6000 ELSE 1000 END WHERE conversation_id = ?").run(1);
    } finally {
      chunkLimitDb.close();
    }
    expect(await findUncompacted(100, true, cwd, true)).toEqual([]);

    const fullChunkDb = new DatabaseSync(paths.dbPath);
    try {
      fullChunkDb.exec("PRAGMA journal_mode = WAL");
      fullChunkDb.exec("PRAGMA foreign_keys = ON");
      fullChunkDb.prepare("UPDATE summaries SET token_count = CASE summary_id WHEN 'summary-1' THEN 20000 ELSE 1000 END WHERE conversation_id = ?").run(1);
    } finally {
      fullChunkDb.close();
    }
    expect(await findUncompacted(100, true, cwd, true)).toEqual([]);

    const condensedDb = new DatabaseSync(paths.dbPath);
    try {
      condensedDb.exec("PRAGMA journal_mode = WAL");
      condensedDb.exec("PRAGMA foreign_keys = ON");
      condensedDb.prepare("UPDATE summaries SET depth = 1, token_count = 1000 WHERE conversation_id = ?").run(1);
    } finally {
      condensedDb.close();
    }
    expect(await findUncompacted(100, true, cwd, true)).toHaveLength(1);

    const summaryOnlyDb = new DatabaseSync(paths.dbPath);
    try {
      summaryOnlyDb.exec("PRAGMA journal_mode = WAL");
      summaryOnlyDb.exec("PRAGMA foreign_keys = ON");
      summaryOnlyDb.prepare("DELETE FROM context_items WHERE conversation_id = ? AND item_type = 'message'").run(1);
    } finally {
      summaryOnlyDb.close();
    }
    expect(await findUncompacted(100, true, cwd, true)).toHaveLength(1);

    writeFileSync(projectMapPath(), "{");
    clearProjectMapCache();
    expect(await findUncompacted(100, true, "/unmapped", true)).toEqual([]);
  }, FULL_SUITE_DISCOVERY_TEST_TIMEOUT_MS);

  it("reports empty, dry-run, skipped, and unknown-error batch outcomes", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await batchCompact({ minTokens: 100, dryRun: true, port: 3737 })).toEqual({
      compacted: 0,
      unchanged: 0,
      skipped: 0,
      failures: 0,
      compactedProjects: [],
    });
    expect(log).toHaveBeenCalledWith("Nothing to compact — no sessions are currently eligible.");

    const cwd = makeDir("compact-boundary-outcomes");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversations(paths.dbPath);
    const progress: Array<Partial<ProgressState>> = [];

    expect(await batchCompact({
      minTokens: 100,
      dryRun: true,
      port: 3737,
      cwd,
      onProgress: patch => progress.push(patch),
    })).toEqual({ compacted: 0, unchanged: 0, skipped: 0, failures: 0, compactedProjects: [] });
    expect(progress).toContainEqual({ total: 2 });
    expect(progress.at(-1)).toEqual({ completed: 2 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Found 2 uncompacted conversations"));

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const post = vi.spyOn(DaemonClient.prototype, "post")
      .mockResolvedValueOnce({ skipped: true })
      .mockRejectedValueOnce("no details");
    progress.length = 0;
    expect(await batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      onProgress: patch => progress.push(patch),
    })).toEqual({ compacted: 0, unchanged: 0, skipped: 1, failures: 1, compactedProjects: [] });
    expect(post).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(`${paths.canonical} conv #1 (9 msgs, 0.3k tokens) skipped (already in progress)`);
    expect(log).toHaveBeenCalledWith(`${paths.canonical} conv #2 (9 msgs, 0.3k tokens) FAILED (unknown error)`);
    expect(log).toHaveBeenCalledWith("\nBatch compact complete.");
  });

  it("prints the singular non-verbose success path", async () => {
    const cwd = makeDir("compact-single-success");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    vi.spyOn(DaemonClient.prototype, "post").mockResolvedValue({ tokensBefore: 250 });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    expect(await batchCompact({ minTokens: 100, dryRun: false, port: 3737, cwd })).toEqual({
      compacted: 1,
      unchanged: 0,
      skipped: 0,
      failures: 0,
      compactedProjects: [paths.canonical],
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Found 1 uncompacted conversation ("));
    expect(log).toHaveBeenCalledWith(`${paths.canonical} conv #1 (9 msgs, 0.3k tokens) done`);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("1 session compacted"));
  });

  it("emits one complete labeled line for each staggered concurrent outcome", async () => {
    const cwd = makeDir("compact-labeled-output");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversations(paths.dbPath, [1, 2, 3, 4, 5]);
    const conversations = await findUncompacted(100, true, cwd);
    const labels = new Map(conversations.map(conv => [
      conv.sessionId,
      `${conv.cwd} conv #${conv.conversationId} (${conv.messages} msgs, ${(conv.tokens / 1000).toFixed(1)}k tokens)`,
    ]));
    const gates = new Map(conversations.map(conv => {
      let release!: () => void;
      const promise = new Promise<void>(resolve => { release = resolve; });
      return [conv.sessionId, { promise, release }] as const;
    }));
    const outcomes = new Map<string, object | Error>([
      ["session-1", { tokensBefore: 250, tokensAfter: 50 }],
      ["session-2", { tokensBefore: 250, tokensAfter: 50 }],
      ["session-3", { actionTaken: false, summary: "No action", tokensBefore: 250, tokensAfter: 250 }],
      ["session-4", { skipped: true }],
      ["session-5", new Error("provider unavailable")],
    ]);
    const post = vi.spyOn(DaemonClient.prototype, "post").mockImplementation(async (_path, body) => {
      const sessionId = String(body.session_id);
      await gates.get(sessionId)!.promise;
      const outcome = outcomes.get(sessionId)!;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => { lines.push(String(line)); });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const pending = batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      maxConcurrency: 5,
    });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(5));
    for (const sessionId of ["session-5", "session-3", "session-2", "session-4", "session-1"]) {
      gates.get(sessionId)!.release();
    }

    await expect(pending).resolves.toEqual({
      compacted: 2,
      unchanged: 1,
      skipped: 1,
      failures: 1,
      compactedProjects: [paths.canonical],
    });

    const completionLines = lines.filter(line => [...labels.values()].some(label => line.includes(label)));
    expect(completionLines).toHaveLength(5);
    expect(completionLines.every(line => !line.includes("\n") && !line.includes("\r"))).toBe(true);
    expect(completionLines.every(line => [...labels.values()].some(label => line.startsWith(`${label} `)))).toBe(true);
    expect(completionLines).toEqual(expect.arrayContaining([
      `${labels.get("session-1")} done`,
      `${labels.get("session-2")} done`,
      `${labels.get("session-3")} unchanged (No action)`,
      `${labels.get("session-4")} skipped (already in progress)`,
      `${labels.get("session-5")} FAILED (compaction request failed)`,
    ]));
    expect(lines).not.toEqual(expect.arrayContaining([
      " done",
      " skipped (already in progress)",
      " unchanged (No action)",
      " FAILED (compaction request failed)",
    ]));
  });

  it("includes the conversation label in verbose completion lines", async () => {
    const cwd = makeDir("compact-verbose-labeled-output");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    const label = `${paths.canonical} conv #1 (9 msgs, 0.3k tokens)`;
    vi.spyOn(DaemonClient.prototype, "post").mockResolvedValue({ tokensBefore: 250, tokensAfter: 50 });
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => { lines.push(String(line)); });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await batchCompact({ minTokens: 100, dryRun: false, port: 3737, cwd, verbose: true });

    expect(lines).toContain(`${label} done  (0.3k → 0.1k tokens, 80% reduction)`);
  });

  it("limits concurrent compaction requests, keeps the oldest active session current, and orders projects by discovery", async () => {
    const firstCwd = makeDir("compact-pool-a");
    const firstPaths = projectPaths(firstCwd);
    ensureProjectDir(firstCwd);
    writeFileSync(firstPaths.metaPath, JSON.stringify({ cwd: firstPaths.canonical }));
    seedConversation(firstPaths.dbPath);

    const secondCwd = makeDir("compact-pool-b");
    const secondPaths = projectPaths(secondCwd);
    ensureProjectDir(secondCwd);
    writeFileSync(secondPaths.metaPath, JSON.stringify({ cwd: secondPaths.canonical }));
    seedConversation(secondPaths.dbPath);

    const expectedProjectOrder = [...new Set((await findUncompacted(100, true)).map(conv => conv.cwd))];
    expect(expectedProjectOrder).toEqual(expect.arrayContaining([
      firstPaths.canonical,
      secondPaths.canonical,
    ]));

    const releases = [0, 1].map(() => {
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      return { pending, release };
    });
    const post = vi.spyOn(DaemonClient.prototype, "post").mockImplementation(async (_path, body) => {
      const index = body.cwd === firstPaths.canonical ? 0 : 1;
      await releases[index]!.pending;
      return { tokensBefore: 250, tokensAfter: 50 };
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const progress: Array<Partial<ProgressState>> = [];

    const pending = batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      maxConcurrency: 2,
      onProgress: patch => progress.push(patch),
    });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const active = progress.filter(patch => patch.activeSessions !== undefined);
    expect(active.at(-1)?.activeSessions).toHaveLength(2);
    expect(active.at(-1)?.current).toMatchObject({ sessionId: "session-1" });

    releases[1]!.release();
    await vi.waitFor(() => expect(progress.at(-1)?.activeSessions).toHaveLength(1));
    expect(progress.at(-1)?.current).toMatchObject({ sessionId: "session-1" });
    releases[0]!.release();

    await expect(pending).resolves.toMatchObject({
      compacted: 2,
      compactedProjects: expectedProjectOrder,
    });
    expect(progress.at(-1)?.activeSessions).toEqual([]);
    expect(progress.at(-1)?.current).toBeUndefined();
    expect(log.mock.calls.filter(([line]) => String(line).includes("done")).length).toBe(2);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("compacting:"));
  });

  it("clamps replay compaction to one in-flight request", async () => {
    const cwd = makeDir("compact-replay-serial");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversations(paths.dbPath);

    const releases = [0, 1].map(() => {
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      return { pending, release };
    });
    let call = 0;
    const post = vi.spyOn(DaemonClient.prototype, "post").mockImplementation(async () => {
      const index = call++;
      await releases[index]!.pending;
      return { tokensBefore: 250, tokensAfter: 50 };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const pending = batchCompact({
      minTokens: 100,
      dryRun: false,
      port: 3737,
      cwd,
      replay: true,
      maxConcurrency: 32,
    });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    releases[0]!.release();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    releases[1]!.release();

    await expect(pending).resolves.toMatchObject({ compacted: 2 });
  });
});

describe("batch worker pool", () => {
  it.each([1, 32])("accepts the %d worker concurrency boundary", async maxConcurrency => {
    let peak = 0;
    let active = 0;
    const results = await runBatchWorkerPool({
      items: [10, 20],
      maxConcurrency,
      worker: async item => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return item * 2;
      },
    });

    expect(peak).toBeLessThanOrEqual(maxConcurrency);
    expect(results.map(result => result.index)).toEqual(expect.arrayContaining([0, 1]));
  });

  it("rejects a non-positive worker concurrency", async () => {
    await expect(runBatchWorkerPool({
      items: [1],
      maxConcurrency: 0,
      worker: item => item,
    })).rejects.toThrow("maxConcurrency");
  });

  it("does not claim work when cancellation is already requested", async () => {
    const controller = new AbortController();
    controller.abort();
    const claimed: number[] = [];

    await expect(runBatchWorkerPool({
      items: [1, 2],
      maxConcurrency: 2,
      signal: controller.signal,
      onClaim: (_item, index) => claimed.push(index),
      worker: item => item,
    })).resolves.toEqual([]);
    expect(claimed).toEqual([]);
  });

  it("caps in-flight workers, reduces settled results synchronously, and preserves indexes", async () => {
    const active = new Set<number>();
    let peak = 0;
    const started: number[] = [];
    const reduced: Array<{ index: number; value?: number; error?: unknown }> = [];
    const gates = [0, 1, 2, 3].map(() => {
      let release!: () => void;
      const promise = new Promise<void>(resolve => { release = resolve; });
      return { promise, release };
    });

    const pending = runBatchWorkerPool({
      items: [10, 20, 30, 40],
      maxConcurrency: 2,
      worker: async (item, index) => {
        started.push(index);
        active.add(index);
        peak = Math.max(peak, active.size);
        await gates[index]!.promise;
        active.delete(index);
        return item * 2;
      },
      onResult: result => reduced.push(result),
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    gates[1]!.release();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    gates[2]!.release();
    gates[0]!.release();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    gates[3]!.release();

    const results = await pending;
    expect(peak).toBe(2);
    expect(results.map(result => result.index)).toEqual([1, 2, 0, 3]);
    expect(reduced).toEqual(results);
  });

  it("drains admitted workers before propagating an onResult callback failure", async () => {
    const callbackError = new Error("onResult failed");
    const started: number[] = [];
    const settled: number[] = [];
    const callbacks: number[] = [];
    const gates = [0, 1].map(() => {
      let release!: () => void;
      const promise = new Promise<void>(resolve => { release = resolve; });
      return { promise, release };
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);

    try {
      const pending = runBatchWorkerPool({
        items: [1, 2],
        maxConcurrency: 2,
        worker: async (_item, index) => {
          started.push(index);
          await gates[index]!.promise;
          settled.push(index);
          return index;
        },
        onResult: result => {
          callbacks.push(result.index);
          throw callbackError;
        },
      });

      await vi.waitFor(() => expect(started).toEqual([0, 1]));
      let rejected = false;
      void pending.catch(() => { rejected = true; });
      gates[0]!.release();
      await vi.waitFor(() => expect(callbacks).toEqual([0]));
      await Promise.resolve();
      expect(rejected).toBe(false);
      expect(settled).toEqual([0]);

      gates[1]!.release();
      await expect(pending).rejects.toBe(callbackError);
      expect(settled).toEqual([0, 1]);
      expect(callbacks).toEqual([0, 1]);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("stops claiming and drains admitted workers before propagating an onClaim failure", async () => {
    const callbackError = new Error("onClaim failed");
    const claimed: number[] = [];
    const started: number[] = [];
    const settled: number[] = [];
    const callbacks: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });

    const pending = runBatchWorkerPool({
      items: [1, 2, 3],
      maxConcurrency: 2,
      onClaim: (_item, index) => {
        claimed.push(index);
        if (index === 1) throw callbackError;
      },
      worker: async (_item, index) => {
        started.push(index);
        await gate;
        settled.push(index);
        return index;
      },
      onResult: result => callbacks.push(result.index),
    });

    let rejected = false;
    void pending.catch(() => { rejected = true; });
    expect(claimed).toEqual([0, 1]);
    await vi.waitFor(() => expect(started).toEqual([0]));
    await Promise.resolve();
    expect(rejected).toBe(false);
    expect(callbacks).toEqual([]);
    release();

    await expect(pending).rejects.toBe(callbackError);
    expect(claimed).toEqual([0, 1]);
    expect(started).toEqual([0]);
    expect(settled).toEqual([0]);
    expect(callbacks).toEqual([0]);
  });

  it("stops claiming immediately after cancellation while awaiting admitted workers", async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const gates = [0, 1].map(() => {
      let release!: () => void;
      const promise = new Promise<void>(resolve => { release = resolve; });
      return { promise, release };
    });

    const pending = runBatchWorkerPool({
      items: [1, 2, 3],
      maxConcurrency: 2,
      signal: controller.signal,
      worker: async (_item, index) => {
        started.push(index);
        await gates[index]!.promise;
        return index;
      },
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    controller.abort();
    gates[0]!.release();
    gates[1]!.release();
    await expect(pending).resolves.toHaveLength(2);
    expect(started).toEqual([0, 1]);
  });
});

describe("formatLlmDiagnostic", () => {
  it("omits diagnostics without a provider and optional controls when absent", () => {
    expect(formatLlmDiagnostic({})).toBeUndefined();
    expect(formatLlmDiagnostic({ providerLabel: "Anthropic API" })).toBe("Anthropic API");
    expect(formatLlmDiagnostic({
      providerLabel: "OpenAI-compatible API",
      apiMode: "chat-completions",
    })).toBe("OpenAI-compatible API · chat-completions");
  });
  it("includes Responses API mode and the effective reasoning effort", () => {
    expect(formatLlmDiagnostic({
      providerLabel: "OpenAI API",
      apiMode: "responses",
      reasoningEffort: "high",
    })).toBe("OpenAI API · responses · reasoning=high");
  });

  it("shows the provider default when Responses reasoning is unset", () => {
    expect(formatLlmDiagnostic({
      providerLabel: "OpenAI API",
      apiMode: "responses",
      reasoningEffort: null,
    })).toBe("OpenAI API · responses · reasoning=default");
  });

  it("shows effective process controls including an explicit false", () => {
    expect(formatLlmDiagnostic({
      providerLabel: "Codex (process)",
      reasoningEffort: null,
      fastMode: false,
      requestTimeoutMs: 600_000,
      retry: null,
    })).toBe("Codex (process) · reasoning=default · fast=off · timeout=600000ms");

    expect(formatLlmDiagnostic({
      providerLabel: "Claude (process)",
      reasoningEffort: "max",
      fastMode: true,
    })).toBe("Claude (process) · reasoning=max · fast=on");
  });

  it("includes the effective request timeout and retry policy", () => {
    expect(formatLlmDiagnostic({
      providerLabel: "OpenAI-compatible API",
      apiMode: "chat-completions",
      requestTimeoutMs: 120_000,
      retry: { maxAttempts: 4, initialDelayMs: 500, maxDelayMs: 10_000, multiplier: 2 },
    })).toBe(
      "OpenAI-compatible API · chat-completions · timeout=120000ms · retry=4 attempts (500-10000ms ×2)",
    );
  });
});
