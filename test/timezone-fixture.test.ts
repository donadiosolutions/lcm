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
    expect(created.bootstrappedAt).toBeNull();
    expect(created.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(created.createdAt.getTime()).toBeLessThanOrEqual(after + 1000);
    expect(created.updatedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(created.updatedAt.getTime()).toBeLessThanOrEqual(after + 1000);
    db.prepare(
      "UPDATE conversations SET created_at = ?, updated_at = ?, bootstrapped_at = ? WHERE conversation_id = ?",
    ).run("2024-03-10 02:30:00", "2024-03-10T02:30:00+02:00", "2024-03-10 02:30:00", created.conversationId);

    const record = await store.getConversation(created.conversationId);
    expect(record?.createdAt.toISOString()).toBe("2024-03-10T02:30:00.000Z");
    expect(record?.updatedAt.toISOString()).toBe("2024-03-10T00:30:00.000Z");
    expect(record?.bootstrappedAt?.toISOString()).toBe("2024-03-10T02:30:00.000Z");
    const listed = (await store.listConversations())[0];
    expect(listed?.createdAt.toISOString()).toBe("2024-03-10T02:30:00.000Z");
    expect(listed?.updatedAt.toISOString()).toBe("2024-03-10T00:30:00.000Z");
    expect(listed?.bootstrappedAt?.toISOString()).toBe("2024-03-10T02:30:00.000Z");

    db.prepare("UPDATE conversations SET bootstrapped_at = '' WHERE conversation_id = ?")
      .run(created.conversationId);
    const emptyBootstrap = await store.getConversation(created.conversationId);
    expect(emptyBootstrap?.bootstrappedAt).toBeNull();
    const listedEmpty = (await store.listConversations())[0];
    expect(listedEmpty?.createdAt.toISOString()).toBe("2024-03-10T02:30:00.000Z");
    expect(listedEmpty?.updatedAt.toISOString()).toBe("2024-03-10T00:30:00.000Z");
    expect(listedEmpty?.bootstrappedAt).toBeNull();
  });

  it("computes promoted age from SQLite UTC text", () => {
    const now = new Date("2026-09-07T08:20:00.000Z");
    vi.setSystemTime(now);
    const db = makeDb();
    const store = new PromotedStore(db, false);
    const fixtures = [
      { createdAt: "2026-09-06 07:20:00", expected: 1 },
      { createdAt: "2026-09-05 08:20:00.000", expected: 2 },
      { createdAt: "2026-09-05 08:19:59.999", expected: 2 },
      { createdAt: "2026-09-05 08:20:00.001", expected: 1 },
      { createdAt: "2026-09-05T08:20:00Z", expected: 2 },
      { createdAt: "2026-09-05T10:20:00+02:00", expected: 2 },
    ];
    const ids = fixtures.map(({ createdAt }) => {
      const id = store.insert({ content: createdAt, projectId: "project", tags: [] });
      db.prepare("UPDATE promoted SET created_at = ? WHERE id = ?").run(createdAt, id);
      return id;
    });
    const rows = store.findStale({ staleAfterDays: 1, staleSurfacingWithoutUseLimit: 5 });
    expect(ids.map((id) => rows.find((row) => row.id === id)?.daysSinceCreated))
      .toEqual(fixtures.map(({ expected }) => expected));
  });

  it("derives and preserves summary bounds across migration reruns", () => {
    const db = makeDb();
    db.prepare("INSERT INTO conversations (session_id) VALUES (?)").run("migration");
    db.prepare(
      "INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at) VALUES (1, 1, 'user', 'hello', 1, ?)",
    ).run("2024-03-10 02:30:00");
    db.prepare(
      "INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at) VALUES (1, 2, 'assistant', 'offset', 1, ?)",
    ).run("2024-03-10T04:30:00+02:00");
    db.prepare(
      "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids, created_at) VALUES ('leaf', 1, 'leaf', 'summary', 1, '[]', ?)",
    ).run("2024-03-09 00:00:00");
    db.prepare(
      "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids, created_at) VALUES ('orphan', 1, 'condensed', 'orphan', 1, '[]', ?)",
    ).run("2024-03-10 02:30:00");
    db.prepare(
      "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids, created_at) VALUES ('offset-leaf', 1, 'leaf', 'offset', 1, '[]', ?)",
    ).run("2024-03-10T04:30:00+02:00");
    db.prepare(
      "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids, created_at) VALUES ('parent', 1, 'condensed', 'parent', 1, '[]', ?)",
    ).run("2024-03-11 00:00:00");
    db.prepare("INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES ('leaf', 1, 0)").run();
    db.prepare("INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES ('offset-leaf', 2, 0)").run();
    db.prepare("INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal) VALUES ('parent', 'leaf', 0)").run();

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
    expect(db.prepare("SELECT earliest_at, latest_at FROM summaries WHERE summary_id = 'offset-leaf'").get())
      .toEqual({
        earliest_at: "2024-03-10T02:30:00.000Z",
        latest_at: "2024-03-10T02:30:00.000Z",
      });
    expect(db.prepare("SELECT earliest_at, latest_at FROM summaries WHERE summary_id = 'parent'").get())
      .toEqual({
        earliest_at: "2024-03-10T02:30:00.000Z",
        latest_at: "2024-03-10T02:30:00.000Z",
      });

    runLcmMigrations(db, { fts5Available: false });
    expect(db.prepare("SELECT earliest_at, latest_at FROM summaries WHERE summary_id = 'leaf'").get())
      .toEqual(first);
    expect(db.prepare("SELECT earliest_at, latest_at FROM summaries WHERE summary_id = 'parent'").get())
      .toEqual({
        earliest_at: "2024-03-10T02:30:00.000Z",
        latest_at: "2024-03-10T02:30:00.000Z",
      });
  });
});
