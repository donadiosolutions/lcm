import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { batchCompact, findUncompacted, formatLlmDiagnostic } from "../src/batch-compact.js";
import { DaemonClient } from "../src/daemon/client.js";
import { closeLcmConnection, getLcmConnection, getPoolStats } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { addProjectAlias, clearProjectMapCache, projectMapPath } from "../src/project-map.js";
import { ensureProjectDir, projectPaths } from "../src/daemon/project.js";

function resetLcmHome(): void {
  rmSync(join(homedir(), ".lcm"), { recursive: true, force: true });
  mkdirSync(join(homedir(), ".lcm"), { recursive: true });
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

function seedConversations(dbPath: string): void {
  const db = getLcmConnection(dbPath);
  try {
    runLcmMigrations(db);
    for (const id of [1, 2]) {
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

  it("matches current-project filters through project-map aliases", () => {
    const canonical = makeDir("compact-canonical");
    const alias = makeDir("compact-alias");
    const paths = projectPaths(canonical);
    ensureProjectDir(canonical);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }, null, 2) + "\n");
    seedConversation(paths.dbPath);
    addProjectAlias(alias, { canonical });
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec");

    const conversations = findUncompacted(100, true, alias);

    expect(conversations).toHaveLength(1);
    expect(conversations[0].cwd).toBe(paths.canonical);
    expect(conversations[0].sessionId).toBe("session-1");
    expect(execSpy.mock.calls.filter(([sql]) => sql === "PRAGMA busy_timeout = 5000")).toHaveLength(1);
    expect(getPoolStats().totalConnections).toBe(0);

    const victim = makeDir("compact-alias-victim");
    rmSync(alias, { recursive: true });
    symlinkSync(victim, alias, "dir");
    expect(findUncompacted(100, true, alias)).toHaveLength(1);
    expect(findUncompacted(100, true, victim)).toEqual([]);
  });

  it("does not match a current-project filter that is unrelated to the map entry", () => {
    const canonical = makeDir("compact-unmatched");
    const unrelated = makeDir("compact-unrelated");
    const paths = projectPaths(canonical);
    ensureProjectDir(canonical);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }, null, 2) + "\n");
    seedConversation(paths.dbPath);

    expect(findUncompacted(100, true, unrelated)).toEqual([]);
  });

  it("requires at least one raw message outside the manual fresh tail", () => {
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

    expect(findUncompacted(100, true, protectedCwd)).toEqual([]);
    expect(findUncompacted(100, true, eligibleCwd)).toEqual([
      expect.objectContaining({ cwd: eligiblePaths.canonical, messages: 9 }),
    ]);
  });

  it("falls back to canonical comparison for legacy symlink metadata", () => {
    const canonical = makeDir("compact-legacy-canonical");
    const legacyLink = join(homedir(), "compact-legacy-link");
    symlinkSync(canonical, legacyLink, "dir");
    const projectDir = join(homedir(), ".lcm", "projects", "legacy-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd: legacyLink }));
    seedConversation(join(projectDir, "db.sqlite"));

    expect(findUncompacted(100, true, canonical)).toHaveLength(1);
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
    vi.spyOn(console, "log").mockImplementation(() => undefined);
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

  it("counts each successful session once and falls back to discovered input tokens", async () => {
    const cwd = makeDir("compact-aggregate-totals");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }, null, 2) + "\n");
    seedConversations(paths.dbPath);
    const post = vi.spyOn(DaemonClient.prototype, "post")
      .mockResolvedValueOnce({ tokensAfter: 60 })
      .mockResolvedValueOnce({ tokensBefore: 300, tokensAfter: 30 });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
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
      tokensOut: 90,
      lastResult: {
        sessionId: "session-2",
        tokensBefore: 300,
        tokensAfter: 30,
      },
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      "2 sessions compacted, 0.6k → 0.1k tokens (84% reduction, 0.5k freed)",
    ));
    expect(log).toHaveBeenCalledWith(" done  (0.3k → 0.1k tokens, 76% reduction)");
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
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
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
    expect(log).toHaveBeenCalledWith(" unchanged (Summarization disabled — no summarizer configured.)");
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
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
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
    expect(log).toHaveBeenCalledWith(" unchanged (No compaction needed.)");
    expect(progress.at(-1)?.lastResult).toMatchObject({ tokensBefore: 250, tokensAfter: 250 });
  });

  it("sends a process-provider timeout without an implicit retry override", async () => {
    const cwd = makeDir("compact-process-timeout-only");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }, null, 2) + "\n");
    seedConversations(paths.dbPath);
    const post = vi.spyOn(DaemonClient.prototype, "post")
      .mockResolvedValue({ tokensBefore: 250, tokensAfter: 50 });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
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

  it("handles absent, malformed, summarized, and replay discovery entries", () => {
    expect(findUncompacted(100, true)).toEqual([]);

    const projectsDir = join(homedir(), ".lcm", "projects");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(projectsDir, "not-a-directory"), "ignored");
    mkdirSync(join(projectsDir, "missing-db"));

    const corruptMeta = join(projectsDir, "corrupt-meta");
    mkdirSync(corruptMeta);
    writeFileSync(join(corruptMeta, "db.sqlite"), "not sqlite");
    writeFileSync(join(corruptMeta, "meta.json"), "{");

    const missingCwd = join(projectsDir, "missing-cwd");
    mkdirSync(missingCwd);
    writeFileSync(join(missingCwd, "db.sqlite"), "not sqlite");
    writeFileSync(join(missingCwd, "meta.json"), "{}");

    const missingMeta = join(projectsDir, "missing-meta");
    mkdirSync(missingMeta);
    seedConversation(join(missingMeta, "db.sqlite"));

    const corruptDb = join(projectsDir, "corrupt-db");
    mkdirSync(corruptDb);
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

    expect(findUncompacted(100, true, cwd)).toEqual([]);
    expect(findUncompacted(100, true, cwd, true)).toHaveLength(1);
    expect(findUncompacted(100, false, cwd, true)).toHaveLength(1);
    expect(findUncompacted(100, true)).toHaveLength(0);

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
    expect(findUncompacted(100, true, cwd, true)).toEqual([]);

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
    expect(findUncompacted(100, true, cwd, true)).toHaveLength(1);

    const interruptedRunDb = new DatabaseSync(paths.dbPath);
    try {
      interruptedRunDb.exec("PRAGMA journal_mode = WAL");
      interruptedRunDb.exec("PRAGMA foreign_keys = ON");
      interruptedRunDb.prepare("UPDATE summaries SET depth = CASE summary_id WHEN 'summary-1' THEN 1 ELSE 0 END WHERE conversation_id = ?").run(1);
    } finally {
      interruptedRunDb.close();
    }
    expect(findUncompacted(100, true, cwd, true)).toEqual([]);

    const chunkLimitDb = new DatabaseSync(paths.dbPath);
    try {
      chunkLimitDb.exec("PRAGMA journal_mode = WAL");
      chunkLimitDb.exec("PRAGMA foreign_keys = ON");
      chunkLimitDb.prepare("UPDATE summaries SET depth = 0, token_count = CASE summary_id WHEN 'summary-1' THEN 15000 WHEN 'summary-2' THEN 6000 ELSE 1000 END WHERE conversation_id = ?").run(1);
    } finally {
      chunkLimitDb.close();
    }
    expect(findUncompacted(100, true, cwd, true)).toEqual([]);

    const fullChunkDb = new DatabaseSync(paths.dbPath);
    try {
      fullChunkDb.exec("PRAGMA journal_mode = WAL");
      fullChunkDb.exec("PRAGMA foreign_keys = ON");
      fullChunkDb.prepare("UPDATE summaries SET token_count = CASE summary_id WHEN 'summary-1' THEN 20000 ELSE 1000 END WHERE conversation_id = ?").run(1);
    } finally {
      fullChunkDb.close();
    }
    expect(findUncompacted(100, true, cwd, true)).toEqual([]);

    const condensedDb = new DatabaseSync(paths.dbPath);
    try {
      condensedDb.exec("PRAGMA journal_mode = WAL");
      condensedDb.exec("PRAGMA foreign_keys = ON");
      condensedDb.prepare("UPDATE summaries SET depth = 1, token_count = 1000 WHERE conversation_id = ?").run(1);
    } finally {
      condensedDb.close();
    }
    expect(findUncompacted(100, true, cwd, true)).toHaveLength(1);

    const summaryOnlyDb = new DatabaseSync(paths.dbPath);
    try {
      summaryOnlyDb.exec("PRAGMA journal_mode = WAL");
      summaryOnlyDb.exec("PRAGMA foreign_keys = ON");
      summaryOnlyDb.prepare("DELETE FROM context_items WHERE conversation_id = ? AND item_type = 'message'").run(1);
    } finally {
      summaryOnlyDb.close();
    }
    expect(findUncompacted(100, true, cwd, true)).toHaveLength(1);

    writeFileSync(projectMapPath(), "{");
    clearProjectMapCache();
    expect(findUncompacted(100, true, "/unmapped", true)).toEqual([]);
  });

  it("reports empty, dry-run, skipped, and unknown-error batch outcomes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
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
    expect(log).toHaveBeenCalledWith(" skipped (already in progress)");
    expect(log).toHaveBeenCalledWith(" FAILED (unknown error)");
    expect(log).toHaveBeenCalledWith("\nBatch compact complete.");
  });

  it("prints the singular non-verbose success path", async () => {
    const cwd = makeDir("compact-single-success");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    writeFileSync(paths.metaPath, JSON.stringify({ cwd: paths.canonical }));
    seedConversation(paths.dbPath);
    vi.spyOn(DaemonClient.prototype, "post").mockResolvedValue({ tokensBefore: 250 });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    expect(await batchCompact({ minTokens: 100, dryRun: false, port: 3737, cwd })).toEqual({
      compacted: 1,
      unchanged: 0,
      skipped: 0,
      failures: 0,
      compactedProjects: [paths.canonical],
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Found 1 uncompacted conversation ("));
    expect(log).toHaveBeenCalledWith(" done");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("1 session compacted"));
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
