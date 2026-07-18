import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { closeLcmConnection, getLcmConnection } from "../../../src/db/connection.js";

const tempDirs: string[] = [];

describe("POST /ingest", () => {
  let daemon: DaemonInstance | undefined;

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts messages[] as an alternative to transcript_path", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-test-1",
        cwd: tempDir,
        messages: [
          { role: "user", content: "hello", tokenCount: 1 },
          { role: "assistant", content: "hi", tokenCount: 1 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 2, totalTokens: 2 });
  });

  it("accepts tool messages in structured ingestion mode", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-tool-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-test-tool",
        cwd: tempDir,
        messages: [
          { role: "user", content: "run rg", tokenCount: 2 },
          { role: "assistant", content: "Tool call shell: rg --files", tokenCount: 6 },
          { role: "tool", content: "README.md", tokenCount: 2 },
          { role: "assistant", content: "Done", tokenCount: 1 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 4, totalTokens: 11 });
  });

  it("prefers messages[] over transcript_path when both are present", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-both-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-test-2",
        cwd: tempDir,
        transcript_path: "/definitely/missing.jsonl",
        messages: [
          { role: "user", content: "preferred", tokenCount: 2 },
          { role: "assistant", content: "path", tokenCount: 1 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 2, totalTokens: 3 });
  });

  it("parses Codex transcript_path when client is codex", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-codex-"));
    tempDirs.push(tempDir);
    const transcriptPath = join(tempDir, "codex-session.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "codex-ingest-1", cwd: tempDir },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Hello Codex" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello from Codex" }],
          },
        }),
      ].join("\n"),
    );

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-ingest-1",
        cwd: tempDir,
        transcript_path: transcriptPath,
        client: "codex",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 2, totalTokens: 7 });
  });

  it("scrubs secrets from message content before SQLite write", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-scrub-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(
      loadDaemonConfig("/nonexistent", {
        daemon: { port: 0 },
        security: { sensitivePatterns: ["MY_PROJECT_SECRET"] },
      }),
    );
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "scrub-test-1",
        cwd: tempDir,
        messages: [
          { role: "user", content: "token=MY_PROJECT_SECRET", tokenCount: 5 },
        ],
      }),
    });

    expect(res.status).toBe(200);

    // Verify the stored content was scrubbed
    const dbPath = projectDbPath(tempDir);
    const db = getLcmConnection(dbPath);
    let row: { content: string } | undefined;
    try {
      row = db.prepare("SELECT content FROM messages LIMIT 1").get() as { content: string } | undefined;
    } finally {
      closeLcmConnection(dbPath);
    }
    expect(row?.content).toContain("[REDACTED]");
    expect(row?.content).not.toContain("MY_PROJECT_SECRET");
  });

  it("increments redaction_stats per category when content contains secrets", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-redact-stats-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(
      loadDaemonConfig("/nonexistent", {
        daemon: { port: 0 },
        security: { sensitivePatterns: ["MY_GLOBAL_TOKEN"] },
      }),
    );
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "redact-stats-1",
        cwd: tempDir,
        messages: [
          {
            role: "user",
            // ghp_ + 36 alphanumeric chars → matches built-in GitHub token pattern
            // MY_GLOBAL_TOKEN → matches the global pattern above
            content: "token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and MY_GLOBAL_TOKEN",
            tokenCount: 10,
          },
        ],
      }),
    });

    expect(res.status).toBe(200);

    const dbPath = projectDbPath(tempDir);
    const db = getLcmConnection(dbPath);
    try {
      const rows = db.prepare(
        "SELECT category, count FROM redaction_stats ORDER BY category"
      ).all() as Array<{ category: string; count: number }>;
      const byCategory = Object.fromEntries(rows.map((r) => [r.category, r.count]));
      // ghp_ token is matched by gitleaks github-pat pattern (gitleaks takes priority over native)
      expect(byCategory["gitleaks"]).toBeGreaterThan(0);
      expect(byCategory["global"]).toBeGreaterThan(0);
    } finally {
      closeLcmConnection(dbPath);
    }
  });

  it("returns ingested=0 when transcript_path is missing and messages[] is absent", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-missing-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-test-3",
        cwd: tempDir,
        transcript_path: "/definitely/missing.jsonl",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 0, totalTokens: 0 });
  });

  it("filters malformed structured messages and returns zero when none remain", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-invalid-messages-"));
    tempDirs.push(tempDir);
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "invalid-messages",
        cwd: tempDir,
        messages: [null, "text", {}, { role: "invalid", content: "x", tokenCount: 1 },
          { role: "user", content: 1, tokenCount: 1 },
          { role: "user", content: "x", tokenCount: "1" }],
      }),
    });
    expect(await res.json()).toEqual({ ingested: 0, totalTokens: 0 });
  });

  it("does not append messages already persisted for the session", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-repeat-"));
    tempDirs.push(tempDir);
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const payload = {
      session_id: "repeat-session",
      cwd: tempDir,
      messages: [{ role: "user", content: "once", tokenCount: 1 }],
    };
    const first = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    expect((await first.json()).ingested).toBe(1);
    const second = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    expect(await second.json()).toEqual({ ingested: 0, totalTokens: 0 });
  });

  it("skips a session recorded as fully ingested", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-complete-"));
    tempDirs.push(tempDir);
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const bootstrap = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "bootstrap", cwd: tempDir, messages: [{ role: "user", content: "x", tokenCount: 1 }] }),
    });
    expect(bootstrap.status).toBe(200);
    const dbPath = projectDbPath(tempDir);
    const db = getLcmConnection(dbPath);
    try {
      db.prepare("INSERT INTO session_ingest_log (session_id, message_count) VALUES (?, ?)").run("complete-session", 1);
    } finally {
      closeLcmConnection(dbPath);
    }
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "complete-session", cwd: tempDir, messages: [{ role: "user", content: "ignored", tokenCount: 1 }] }),
    });
    expect(await res.json()).toEqual({ ingested: 0, totalTokens: 0 });
  });
});
