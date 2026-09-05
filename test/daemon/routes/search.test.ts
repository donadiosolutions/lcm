import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createDaemon } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { PromotedStore } from "../../../src/db/promoted.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";
import { SummaryStore } from "../../../src/store/summary-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("POST /search", () => {
  const timestampFor = (seconds: number): string => {
    const value = new Date(Date.UTC(2025, 0, 1, 0, 0, seconds));
    return value.toISOString().replace("T", " ").slice(0, 19);
  };

  it("finds promoted memories via FTS5", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-search-"));
    tempDirs.push(tempDir);

    // Pre-populate promoted table
    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    store.insert({ content: "We decided to use React for the frontend", tags: ["decision"], projectId: "p1" });
    store.insert({ content: "Database is PostgreSQL", tags: ["decision"], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "React", cwd: tempDir }),
      });
      const data = await res.json() as { episodic: unknown[]; semantic: unknown[]; promoted: unknown[] };
      expect(res.status).toBe(200);
      expect(data.promoted.length).toBeGreaterThanOrEqual(1);
    } finally {
      await daemon.stop();
    }
  });

  it("applies all supplied tags to promoted results", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-search-promoted-tags-"));
    tempDirs.push(tempDir);
    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    store.insert({ content: "bug864 promoted match", tags: ["type:decision", "scope:project"], projectId: "p1" });
    store.insert({ content: "bug864 promoted partial", tags: ["type:decision"], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.address().port}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "bug864 promoted", cwd: tempDir, layers: ["promoted"], tags: ["type:decision", "scope:project"] }),
      });
      expect(response.status).toBe(200);
      const result = await response.json() as { promoted: Array<{ content: string }> };
      expect(result.promoted).toHaveLength(1);
      expect(result.promoted[0]?.content).toBe("bug864 promoted match");
    } finally {
      await daemon.stop();
    }
  });

  it("returns all three layers in response", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-search-layers-"));
    tempDirs.push(tempDir);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test", cwd: tempDir }),
      });
      const data = await res.json() as Record<string, unknown>;
      expect(data).toHaveProperty("episodic");
      expect(data).toHaveProperty("promoted");
    } finally {
      await daemon.stop();
    }
  });

  it("recalls the oldest message candidate beyond the fifty-row store default with tags", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-search-message-recall-"));
    tempDirs.push(tempDir);
    mkdirSync(dirname(projectDbPath(tempDir)), { recursive: true });
    const db = new DatabaseSync(projectDbPath(tempDir));
    runLcmMigrations(db);
    const conversations = new ConversationStore(db);
    const conversation = await conversations.createConversation({ sessionId: "bug-864-message" });
    const messages = await conversations.createMessagesBulk(Array.from({ length: 51 }, (_, index) => ({
      conversationId: conversation.conversationId,
      seq: index,
      role: "user" as const,
      content: "bug864-message-candidate",
      tokenCount: 1,
    })));
    const update = db.prepare("UPDATE messages SET created_at = ? WHERE message_id = ?");
    messages.forEach((message, index) => update.run(timestampFor(index), message.messageId));
    const targetId = messages[0].messageId;
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.address().port}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "bug864-message-candidate", cwd: tempDir, limit: 51, tags: ["type:solution"], layers: ["episodic"] }),
      });
      expect(response.status).toBe(200);
      const result = await response.json() as { episodic: Array<{ messageId: number }> };
      expect(result.episodic).toHaveLength(51);
      expect(result.episodic.at(-1)?.messageId).toBe(targetId);
    } finally {
      await daemon.stop();
    }
  });

  it("recalls the oldest summary candidate beyond the fifty-row store default with tags", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-search-summary-recall-"));
    tempDirs.push(tempDir);
    mkdirSync(dirname(projectDbPath(tempDir)), { recursive: true });
    const db = new DatabaseSync(projectDbPath(tempDir));
    runLcmMigrations(db);
    const conversations = new ConversationStore(db);
    const summaries = new SummaryStore(db);
    const conversation = await conversations.createConversation({ sessionId: "bug-864-summary" });
    const conversationId = conversation.conversationId;
    const summaryIds: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      const summaryId = `bug864-summary-${index}`;
      summaryIds.push(summaryId);
      await summaries.insertSummary({
        summaryId,
        conversationId,
        kind: "leaf",
        content: "bug864-summary-candidate",
        tokenCount: 1,
      });
    }
    const update = db.prepare("UPDATE summaries SET created_at = ? WHERE summary_id = ?");
    summaryIds.forEach((summaryId, index) => update.run(timestampFor(index), summaryId));
    const targetId = summaryIds[0];
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.address().port}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "bug864-summary-candidate", cwd: tempDir, limit: 51, tags: ["type:solution"], layers: ["episodic"] }),
      });
      expect(response.status).toBe(200);
      const result = await response.json() as { episodic: Array<{ summaryId: string }> };
      expect(result.episodic).toHaveLength(51);
      expect(result.episodic.at(-1)?.summaryId).toBe(targetId);
    } finally {
      await daemon.stop();
    }
  });
});
