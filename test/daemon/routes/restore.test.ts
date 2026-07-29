import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { projectDbPath, projectIdentity } from "../../../src/daemon/project.js";
import { PromotedStore } from "../../../src/db/promoted.js";
import { closeLcmConnection, getLcmConnection } from "../../../src/db/connection.js";
import { sessionInstructionsScopeHash } from "../../../src/storage/session-instructions.js";

describe("POST /restore", () => {
  let daemon: DaemonInstance | undefined;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = undefined; } });

  it("returns empty context for first-ever session (orientation now lives in ~/.claude/lcm.md)", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "new-sess", cwd: tmpdir(), hook_event_name: "SessionStart" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.context).not.toContain("<memory-orientation>");
    expect(body.context).not.toContain("<recent-session-context>");
  });

  it("returns empty context for source=compact with no session_instructions", async () => {
    // Use an isolated dir — shared tmpdir() gets session_instructions written by the
    // "first-ever session" test (non-compact path captures ~/.claude/CLAUDE.md), causing
    // this compact-restore assertion to fail due to test-order contamination.
    const isolatedDir = mkdtempSync(join(tmpdir(), "restore-compact-test-"));
    try {
      daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
      const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "s1", cwd: isolatedDir, source: "compact", hook_event_name: "SessionStart" }),
      });
      const body = await res.json();
      expect(body.context).not.toContain("<memory-orientation>");
      expect(body.context).not.toContain("<recent-session-context>");
      expect(body.context).not.toContain("<project-instructions>");
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  describe("session_instructions persistence", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "restore-test-"));
    });

    afterEach(() => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("injects session_instructions on compact restore", async () => {
      // Pre-populate DB with session_instructions row
      const dbPath = projectDbPath(tmpDir);
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = getLcmConnection(dbPath);
      runLcmMigrations(db);
      const instructionScope = {
        clientName: "claude",
        sessionId: "compact-sess",
        worktreePath: tmpDir,
        cwdPath: tmpDir,
      } as const;
      db.prepare(
        `INSERT INTO session_instruction_cache (
           project_id, scope_hash, client_name, session_id, worktree_path,
           cwd_path, content, content_hash, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).run(
        projectIdentity(tmpDir).id,
        sessionInstructionsScopeHash(instructionScope),
        instructionScope.clientName,
        instructionScope.sessionId,
        instructionScope.worktreePath,
        instructionScope.cwdPath,
        "# ~/.claude/CLAUDE.md\nDo not use emojis.",
        "abc123hash",
      );
      closeLcmConnection(dbPath);

      daemon = await createDaemon(loadDaemonConfig(join(tmpDir, "config.json"), { daemon: { port: 0 } }));
      const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "compact-sess", cwd: tmpDir, source: "compact", hook_event_name: "SessionStart" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.context).not.toContain("<memory-orientation>");
      expect(body.context).toContain("<project-instructions>");
      expect(body.context).toContain("Do not use emojis.");
      expect(body.context).not.toContain("<recent-session-context>");
    });

    it("captures CLAUDE.md on startup restore", async () => {
      // Write a CLAUDE.md into the temp project dir
      writeFileSync(join(tmpDir, "CLAUDE.md"), "# Project Rules\nAlways write tests.", "utf8");

      daemon = await createDaemon(loadDaemonConfig(join(tmpDir, "config.json"), { daemon: { port: 0 } }));
      const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "startup-sess", cwd: tmpDir, source: "startup", hook_event_name: "SessionStart" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.context).not.toContain("<memory-orientation>");

      // Verify session_instruction_cache was written to DB
      const dbPath = projectDbPath(tmpDir);
      const db = getLcmConnection(dbPath);
      const row = db.prepare(
        `SELECT content, content_hash FROM session_instruction_cache
         WHERE client_name = 'claude' AND session_id = 'startup-sess'`,
      ).get() as
        | { content: string; content_hash: string }
        | undefined;
      closeLcmConnection(dbPath);

      expect(row).toBeDefined();
      expect(row!.content).toContain("Always write tests.");
      expect(row!.content_hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("captures Codex AGENTS.md separately from Claude instructions", async () => {
      writeFileSync(join(tmpDir, "CLAUDE.md"), "# Claude Rules\nUse Claude instructions.", "utf8");
      writeFileSync(join(tmpDir, "AGENTS.md"), "# Codex Rules\nUse Codex instructions.", "utf8");
      mkdirSync(join(tmpDir, ".codex"), { recursive: true });
      writeFileSync(join(tmpDir, ".codex", "AGENTS.md"), "Project Codex override.", "utf8");

      daemon = await createDaemon(loadDaemonConfig(join(tmpDir, "config.json"), { daemon: { port: 0 } }));
      const port = daemon.address().port;

      const claudeResponse = await fetch(`http://127.0.0.1:${port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "claude-startup", cwd: tmpDir, source: "startup", client: "claude" }),
      });
      const codexResponse = await fetch(`http://127.0.0.1:${port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "codex-startup", cwd: tmpDir, source: "startup", client: "codex" }),
      });
      expect(claudeResponse.status).toBe(200);
      expect(codexResponse.status).toBe(200);
      const codexBody = await codexResponse.json() as { context: string };
      expect(codexBody.context).toContain("<project-instructions>");
      expect(codexBody.context).toContain("Use Codex instructions.");
      expect(codexBody.context).toContain("Project Codex override.");
      expect(codexBody.context).not.toContain("Use Claude instructions.");

      const codexCompactResponse = await fetch(`http://127.0.0.1:${port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "codex-startup", cwd: tmpDir, source: "compact", client: "codex" }),
      });
      expect(codexCompactResponse.status).toBe(200);
      const codexCompactBody = await codexCompactResponse.json() as { context: string };
      expect(codexCompactBody.context).toContain("Use Codex instructions.");
      expect(codexCompactBody.context).toContain("Project Codex override.");
      expect(codexCompactBody.context).not.toContain("Use Claude instructions.");

      const nestedDir = join(tmpDir, "packages", "worker");
      mkdirSync(nestedDir, { recursive: true });
      const codexNestedResponse = await fetch(`http://127.0.0.1:${port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "codex-nested", cwd: nestedDir, source: "startup", client: "codex" }),
      });
      expect(codexNestedResponse.status).toBe(200);
      const codexNestedBody = await codexNestedResponse.json() as { context: string };
      expect(codexNestedBody.context).toContain("Use Codex instructions.");
      expect(codexNestedBody.context).not.toContain("Use Claude instructions.");

      const dbPath = projectDbPath(tmpDir);
      const db = getLcmConnection(dbPath);
      const rows = db.prepare(
        `SELECT client_name, session_id, content
         FROM session_instruction_cache ORDER BY client_name, session_id`,
      ).all() as Array<{
        client_name: "claude" | "codex";
        session_id: string;
        content: string;
      }>;
      closeLcmConnection(dbPath);

      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(expect.objectContaining({
        client_name: "claude",
        session_id: "claude-startup",
      }));
      expect(rows[0].content).toContain("Use Claude instructions.");
      expect(rows[0].content).not.toContain("Use Codex instructions.");
      expect(rows[1]).toEqual(expect.objectContaining({
        client_name: "codex",
        session_id: "codex-startup",
      }));
      expect(rows[1].content).toContain("Use Codex instructions.");
      expect(rows[1].content).toContain("Project Codex override.");
      expect(rows[1].content).not.toContain("Use Claude instructions.");
    });

    it("ignores symlinked and oversized Codex instruction files", async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), "restore-secret-"));
      try {
        const outsideFile = join(outsideDir, "secret.txt");
        writeFileSync(outsideFile, "DO-NOT-RESTORE-SYMLINKED-SECRET", "utf8");
        symlinkSync(outsideFile, join(tmpDir, "AGENTS.md"));
        mkdirSync(join(tmpDir, ".codex"), { recursive: true });
        writeFileSync(join(tmpDir, ".codex", "AGENTS.md"), `OVERSIZED-${"x".repeat(1024 * 1024)}`, "utf8");

        daemon = await createDaemon(loadDaemonConfig(join(tmpDir, "config.json"), { daemon: { port: 0 } }));
        const response = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: "codex-untrusted-instructions", cwd: tmpDir, source: "startup", client: "codex" }),
        });
        const body = await response.json() as { context: string };

        expect(response.status).toBe(200);
        expect(body.context).not.toContain("DO-NOT-RESTORE-SYMLINKED-SECRET");
        expect(body.context).not.toContain("OVERSIZED-");
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("does not re-upsert session_instructions when content hash unchanged", async () => {
      // Write CLAUDE.md
      writeFileSync(join(tmpDir, "CLAUDE.md"), "Stable content.", "utf8");
      mkdirSync(join(tmpDir, ".lossless"), { recursive: true });

      daemon = await createDaemon(loadDaemonConfig(join(tmpDir, "config.json"), { daemon: { port: 0 } }));
      const port = daemon.address().port;

      // First startup call
      await fetch(`http://127.0.0.1:${port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "s-hash-1", cwd: tmpDir, source: "startup" }),
      });

      const dbPath = projectDbPath(tmpDir);
      const db1 = getLcmConnection(dbPath);
      const row1 = db1.prepare(
        `SELECT updated_at FROM session_instruction_cache
         WHERE client_name = 'claude' AND session_id = 's-hash-1'`,
      ).get() as
        | { updated_at: string }
        | undefined;
      closeLcmConnection(dbPath);
      expect(row1).toBeDefined();

      // Second startup call with identical content — updated_at should not change
      await fetch(`http://127.0.0.1:${port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "s-hash-1", cwd: tmpDir, source: "startup" }),
      });

      const db2 = getLcmConnection(dbPath);
      const row2 = db2.prepare(
        `SELECT updated_at FROM session_instruction_cache
         WHERE client_name = 'claude' AND session_id = 's-hash-1'`,
      ).get() as
        | { updated_at: string }
        | undefined;
      closeLcmConnection(dbPath);

      expect(row2).toBeDefined();
      expect(row2!.updated_at).toBe(row1!.updated_at);
    });
  });

  describe("passive-capture insights", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "restore-insights-test-"));
    });

    afterEach(() => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("includes insights array when passive-capture entries exist in promoted store", async () => {
      // Pre-populate DB with promoted entries tagged source:passive-capture
      const dbPath = projectDbPath(tmpDir);
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = getLcmConnection(dbPath);
      runLcmMigrations(db);
      const store = new PromotedStore(db);
      store.insert({
        content: "Always prefer async/await over callbacks",
        tags: ["source:passive-capture", "type:pattern"],
        projectId: tmpDir,
        confidence: 0.75,
      });
      store.insert({
        content: "Use PromotedStore.search for cross-session queries",
        tags: ["source:passive-capture"],
        projectId: tmpDir,
        confidence: 0.5,
      });
      closeLcmConnection(dbPath);

      daemon = await createDaemon(loadDaemonConfig(join(tmpDir, "config.json"), { daemon: { port: 0 } }));
      const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "ins-sess", cwd: tmpDir, hook_event_name: "SessionStart" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { context: string; insights?: Array<{ content: string; confidence: number; tags: string[] }> };
      expect(body.insights).toBeDefined();
      expect(body.insights!.length).toBeGreaterThan(0);
      expect(body.insights![0]).toHaveProperty("content");
      expect(body.insights![0]).toHaveProperty("confidence");
      expect(body.insights![0]).toHaveProperty("tags");
      // All returned insights should have source:passive-capture tag
      for (const insight of body.insights!) {
        expect(insight.tags).toContain("source:passive-capture");
      }
    });

    it("omits insights array when no passive-capture entries exist", async () => {
      daemon = await createDaemon(loadDaemonConfig(join(tmpDir, "config.json"), { daemon: { port: 0 } }));
      const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "no-ins-sess", cwd: tmpDir, hook_event_name: "SessionStart" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { context: string; insights?: unknown };
      expect(body.insights).toBeUndefined();
    });

    it("filters out insights below confidence 0.3", async () => {
      const dbPath = projectDbPath(tmpDir);
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = getLcmConnection(dbPath);
      runLcmMigrations(db);
      const store = new PromotedStore(db);
      store.insert({
        content: "Low confidence passive insight",
        tags: ["source:passive-capture"],
        projectId: tmpDir,
        confidence: 0.1,
      });
      closeLcmConnection(dbPath);

      daemon = await createDaemon(loadDaemonConfig(join(tmpDir, "config.json"), { daemon: { port: 0 } }));
      const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "low-conf-sess", cwd: tmpDir }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { context: string; insights?: unknown };
      expect(body.insights).toBeUndefined();
    });
  });

  describe("promoted age filtering", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "restore-age-test-"));
    });

    afterEach(() => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("excludes promoted memories older than restoreMaxPromotedAgeDays", async () => {
      const dbPath = projectDbPath(tmpDir);
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = getLcmConnection(dbPath);
      runLcmMigrations(db);
      const store = new PromotedStore(db);

      // Insert a recent memory
      store.insert({
        content: "Recent project knowledge that should surface",
        tags: ["type:knowledge"],
        projectId: tmpDir,
        confidence: 0.9,
      });

      // Insert an old memory by backdating created_at
      store.insert({
        content: "Ancient project knowledge that should be filtered",
        tags: ["type:knowledge"],
        projectId: tmpDir,
        confidence: 0.9,
      });
      // Backdate the second entry to 200 days ago
      const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000)
        .toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
      db.prepare(
        `UPDATE promoted SET created_at = ? WHERE content LIKE '%Ancient%'`
      ).run(oldDate);
      closeLcmConnection(dbPath);

      // Use restoreMaxPromotedAgeDays = 180 (default)
      daemon = await createDaemon(loadDaemonConfig(join(tmpDir, "config.json"), { daemon: { port: 0 } }));
      const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "age-test", cwd: tmpDir, hook_event_name: "SessionStart" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { context: string };

      // Recent memory should be present, old one filtered out
      expect(body.context).toContain("Recent project knowledge");
      expect(body.context).not.toContain("Ancient project knowledge");
    });
  });
});
