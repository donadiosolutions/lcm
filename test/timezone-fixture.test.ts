import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { PromotedStore } from "../src/db/promoted.js";
import { ConversationStore } from "../src/store/conversation-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), "lcm-timezone-fixture-"));
  tempDirs.push(dir);
  const db = getLcmConnection(join(dir, "test.db"));
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

describe("spawned timezone fixtures", () => {
  it("proves the host zone is effective before checking conversation timestamps", async () => {
    const local = new Date("2024-03-10 02:30:00").getTime();
    const utc = new Date("2024-03-10T02:30:00Z").getTime();
    if (Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC") {
      expect(local).toBe(utc);
    } else {
      expect(local).not.toBe(utc);
    }

    const db = makeDb();
    const store = new ConversationStore(db, { fts5Available: false });
    const before = Date.now();
    const created = await store.createConversation({ sessionId: "timezone" });
    const after = Date.now();
    expect(created.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(created.createdAt.getTime()).toBeLessThanOrEqual(after + 1000);
    db.prepare(
      "UPDATE conversations SET created_at = ?, updated_at = ?, bootstrapped_at = ? WHERE conversation_id = ?",
    ).run("2024-03-10 02:30:00", "2024-03-10T02:30:00+02:00", "2024-03-10 02:30:00", created.conversationId);

    const record = await store.getConversation(created.conversationId);
    expect(record?.createdAt.toISOString()).toBe("2024-03-10T02:30:00.000Z");
    expect(record?.updatedAt.toISOString()).toBe("2024-03-10T00:30:00.000Z");
    expect(record?.bootstrappedAt?.toISOString()).toBe("2024-03-10T02:30:00.000Z");
    expect((await store.listConversations())[0]?.createdAt.toISOString())
      .toBe("2024-03-10T02:30:00.000Z");
  });

  it("computes promoted age from SQLite UTC text", () => {
    const now = new Date("2026-09-07T08:20:00.000Z");
    vi.setSystemTime(now);
    const db = makeDb();
    const store = new PromotedStore(db, false);
    const ids = [
      ["2026-09-05 08:20:00.000", 2],
      ["2026-09-05 08:19:59.999", 1],
      ["2026-09-05 08:20:00.001", 2],
    ].map(([createdAt]) => {
      const id = store.insert({ content: String(createdAt), projectId: "project", tags: [] });
      db.prepare("UPDATE promoted SET created_at = ? WHERE id = ?").run(createdAt, id);
      return id;
    });
    const rows = store.findStale({ staleAfterDays: 1, staleSurfacingWithoutUseLimit: 5 });
    expect(ids.map((id) => rows.find((row) => row.id === id)?.daysSinceCreated)).toEqual([2, 2, 1]);
  });

  it("derives and preserves summary bounds across migration reruns", () => {
    const db = makeDb();
    db.prepare("INSERT INTO conversations (session_id) VALUES (?)").run("migration");
    db.prepare(
      "INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at) VALUES (1, 1, 'user', 'hello', 1, ?)",
    ).run("2024-03-10 02:30:00");
    db.prepare(
      "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids, created_at) VALUES ('leaf', 1, 'leaf', 'summary', 1, '[]', ?)",
    ).run("2024-03-10 02:30:00");
    db.prepare(
      "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids, created_at) VALUES ('orphan', 1, 'condensed', 'orphan', 1, '[]', ?)",
    ).run("2024-03-10 02:30:00");
    db.prepare("INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES ('leaf', 1, 0)").run();

    runLcmMigrations(db, { fts5Available: false });
    const first = db.prepare("SELECT earliest_at, latest_at FROM summaries WHERE summary_id = 'leaf'").get() as {
      earliest_at: string;
      latest_at: string;
    };
    expect(first).toEqual({
      earliest_at: "2024-03-10T02:30:00.000Z",
      latest_at: "2024-03-10T02:30:00.000Z",
    });
    expect(db.prepare("SELECT earliest_at, latest_at FROM summaries WHERE summary_id = 'orphan'").get())
      .toEqual({
        earliest_at: "2024-03-10T02:30:00.000Z",
        latest_at: "2024-03-10T02:30:00.000Z",
      });

    runLcmMigrations(db, { fts5Available: false });
    expect(db.prepare("SELECT earliest_at, latest_at FROM summaries WHERE summary_id = 'leaf'").get())
      .toEqual(first);
  });
});
