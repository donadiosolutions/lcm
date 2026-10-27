import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { createStorageBackendFactory } from "../../../src/storage/index.js";
import {
  CODEX_LINEAGE_METADATA_KEY,
  createIngestHandler,
  encodeCodexLineageMarker,
  parseCodexLineageMarker,
  persistCodexLineage,
} from "../../../src/daemon/routes/ingest.js";
import { createCompactHandler } from "../../../src/daemon/routes/compact.js";
import { createSessionCompleteHandler } from "../../../src/daemon/routes/session-complete.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { closeLcmConnection, getLcmConnection } from "../../../src/db/connection.js";
import { withBackendPublicationConsumerLockAsync } from "../../../src/storage/backend-publication.js";

const logs = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../../../src/hooks/hook-errors.js", () => ({ safeLogError: logs.error }));
afterEach(() => vi.restoreAllMocks());

type Role = "user" | "assistant";

const message = (role: Role, text: string, ordinal?: number): string => JSON.stringify({
  type: "response_item",
  ...(ordinal === undefined ? {} : { ordinal }),
  payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
});
const tool = (): string => JSON.stringify({
  type: "response_item", payload: { type: "function_call", name: "exec", arguments: "{}" },
});
const fork = (payload: Record<string, unknown> = {}): string => JSON.stringify({
  type: "session_meta",
  payload: { id: "child-thread", forked_from_id: "parent-thread", cwd: "/work", ...payload },
});
const settings = (threadId?: unknown): string => JSON.stringify({
  type: "event_msg",
  payload: { type: "thread_settings_applied", ...(threadId === undefined ? {} : { thread_id: threadId }) },
});
const lines = (...records: string[]): string => records.map((record) => record + "\n").join("");
const EVENT = "LCM compaction leaf pass (normal): 10 -> 5";
const newestConversation = "(SELECT MAX(conversation_id) FROM conversations)";
const COMPACTION_PART = "EXISTS (SELECT 1 FROM message_parts p WHERE p.message_id = m.message_id AND p.part_type = 'compaction')";
/** A compaction event row in the newest conversation, with an optional slot marker. */
const eventRow = (seq: number, marker: string | null): string =>
  "INSERT INTO messages(conversation_id, seq, role, content, token_count) VALUES("
  + newestConversation + ", " + seq + ", 'system', '" + EVENT + "', 1);"
  + "INSERT INTO message_parts(part_id, message_id, session_id, part_type, ordinal, metadata) "
  + "VALUES('event-' || last_insert_rowid(), last_insert_rowid(), 'child-thread', 'compaction', 0, '{}');"
  + (marker === null ? "" : "INSERT INTO message_parts(part_id, message_id, session_id, part_type, ordinal, metadata) "
    + "SELECT 'marker-' || message_id, message_id, 'child-thread', 'snapshot', 1, '" + marker + "' "
    + "FROM message_parts WHERE part_id LIKE 'event-%' AND message_id = (SELECT MAX(message_id) FROM messages);");
const unconsumed = JSON.stringify({ lcmTranscriptSlot: { version: 1, consumed: false } });
const transcriptRow = (seq: number, role: Role, content: string): string =>
  "INSERT INTO messages(conversation_id, seq, role, content, token_count) VALUES("
  + newestConversation + ", " + seq + ", '" + role + "', '" + content + "', 1);";
const laterConversation = "INSERT INTO conversations(session_id, created_at) VALUES('child-thread', '2999-01-01 00:00:00')";

/** A copied fork: parent history, the fork's own settings event, then its own messages. */
const copied = (parent: string[], own: string[], extra: Record<string, unknown> = {}): string => lines(
  fork(extra),
  ...parent,
  settings("child-thread"),
  ...own,
);

interface World {
  cwd: string;
  source: string;
  write(text: string, path?: string): void;
  append(text: string): void;
  ingest(extra?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  ingestWith(patterns: string[]): Promise<{ status: number; body: Record<string, unknown> }>;
  compact(extra?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  complete(): Promise<{ status: number; body: Record<string, unknown> }>;
  seed(client: "codex" | "claude", ...rows: Array<[Role, string]>): Promise<void>;
  exec(sql: string): void;
  parent(): string | null | undefined;
  messages(): string[];
  allMessages(): string[];
  links(): string[];
  nativeRecords(): number;
  markers(): Array<{ content: string; metadata: string }>;
  completions(): number;
}

async function withWorld(run: (world: World) => Promise<void>, patterns: string[] = []): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "copied-fork-"));
  const source = join(cwd, "child.jsonl");
  const factories: Array<{ close(): Promise<void> }> = [];
  const handlersFor = async (sensitivePatterns: string[]) => {
    const config = loadDaemonConfig(join(cwd, "nonexistent"), {
      security: { sensitivePatterns },
      summarizer: { mock: true },
    });
    const factory = await createStorageBackendFactory(config.storage);
    factories.push(factory);
    return {
      ingest: createIngestHandler(config, factory),
      compact: createCompactHandler(config, factory),
      complete: createSessionCompleteHandler(config, factory),
    };
  };
  const handlers = await handlersFor(patterns);
  const callWith = async (route: ReturnType<typeof createIngestHandler>, payload: Record<string, unknown>) => {
    let status = 0;
    let body = "";
    const res = { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; } };
    await route(
      {} as never,
      res as never,
      JSON.stringify({ cwd, client: "codex", session_id: "child-thread", ...payload }),
      { withPublicationAdmission: (operation: never) => withBackendPublicationConsumerLockAsync(undefined, operation, { allowUnresolved: true }) } as never,
    );
    return { status, body: JSON.parse(body) as Record<string, unknown> };
  };
  const query = <T>(sql: string): T[] => {
    const dbPath = projectDbPath(cwd);
    const db = getLcmConnection(dbPath);
    try { return db.prepare(sql).all() as T[]; } finally { closeLcmConnection(dbPath); }
  };
  logs.error.mockClear();
  try {
    await run({
      cwd,
      source,
      write: (text, path = source) => writeFileSync(path, text, { mode: 0o600 }),
      append: (text) => appendFileSync(source, text),
      ingest: (extra = {}) => callWith(handlers.ingest, { transcript_path: source, ...extra }),
      ingestWith: async (other) => callWith((await handlersFor(other)).ingest, { transcript_path: source }),
      compact: (extra = {}) => callWith(handlers.compact, { transcript_path: source, ...extra }),
      complete: () => callWith(handlers.complete, {}),
      seed: async (client, ...rows) => {
        const result = await callWith(handlers.ingest, {
          client,
          messages: rows.map(([role, content]) => ({ role, content, tokenCount: 1 })),
        });
        expect(result.status).toBe(200);
      },
      exec: (sql) => {
        const dbPath = projectDbPath(cwd);
        const db = getLcmConnection(dbPath);
        try { db.exec(sql); } finally { closeLcmConnection(dbPath); }
      },
      parent: () => query<{ parent_session_id: string | null }>(
        "SELECT parent_session_id FROM conversations ORDER BY conversation_id DESC",
      )[0]?.parent_session_id,
      messages: () => query<{ content: string }>(
        "SELECT m.content AS content FROM messages m WHERE NOT " + COMPACTION_PART + " ORDER BY m.conversation_id, m.seq",
      ).map((row) => row.content),
      allMessages: () => query<{ content: string }>("SELECT content FROM messages ORDER BY conversation_id, seq")
        .map((row) => row.content),
      links: () => query<{ content: string }>(
        "SELECT m.content AS content FROM runtime_native_transcript_messages l JOIN messages m ON m.message_id = l.message_id ORDER BY l.source_ordinal",
      ).map((row) => row.content),
      nativeRecords: () => query<{ n: number }>("SELECT count(*) AS n FROM runtime_native_transcripts")[0]!.n,
      markers: () => query<{ content: string; metadata: string }>(
        "SELECT m.content AS content, p.metadata AS metadata FROM message_parts p JOIN messages m ON m.message_id = p.message_id WHERE p.metadata LIKE '%" + CODEX_LINEAGE_METADATA_KEY + "%' ORDER BY p.message_id, p.ordinal",
      ),
      completions: () => query<{ n: number }>("SELECT count(*) AS n FROM session_ingest_log")[0]!.n,
    });
  } finally {
    for (const factory of factories) await factory.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

const NOTHING = { status: 200, body: { ingested: 0, totalTokens: 0 } };
const boundaryMarker = encodeCodexLineageMarker("boundary");

describe("Codex copied fork history on ingest", () => {
  it("stores only the fork's own messages, links only their records, and resumes after an append", async () => {
    await withWorld(async (world) => {
      world.write(copied(
        [message("user", "parent question"), tool(), message("assistant", "parent answer")],
        [message("user", "child task"), tool(), message("assistant", "child result")],
      ));
      expect((await world.ingest()).body).toMatchObject({ ingested: 2 });
      expect(world.messages()).toEqual(["child task", "child result"]);
      expect(world.links()).toEqual(["child task", "child result"]);
      expect(world.nativeRecords()).toBe(8);
      expect(world.markers()).toEqual([{ content: "child task", metadata: boundaryMarker }]);

      expect(await world.ingest()).toEqual(NOTHING);

      world.append(lines(message("assistant", "child final")));
      expect((await world.ingest()).body).toMatchObject({ ingested: 1 });
      expect(world.messages()).toEqual(["child task", "child result", "child final"]);
      expect(world.links()).toEqual(["child task", "child result", "child final"]);
      expect(world.markers()).toHaveLength(1);
      expect(logs.error).not.toHaveBeenCalled();
    });
  });

  it("leaves a rollout that was not forked untouched", async () => {
    await withWorld(async (world) => {
      world.write(lines(
        fork({ forked_from_id: undefined }),
        message("user", "one"),
        settings("child-thread"),
        message("assistant", "two"),
      ));
      await world.ingest();
      expect(world.messages()).toEqual(["one", "two"]);
      expect(world.links()).toEqual(["one", "two"]);
      expect(world.markers()).toEqual([]);
      world.append(lines(message("user", "three")));
      await world.ingest();
      expect(world.messages()).toEqual(["one", "two", "three"]);
    });
  });

  it.each([
    ["a referenced fork", { history_base: "parent-thread" }, [settings("child-thread")]],
    ["a fork of itself", { forked_from_id: "child-thread" }, [settings("child-thread")]],
    ["an earlier settings event without a thread", {}, [settings(), settings("child-thread")]],
    ["an earlier settings event with an empty thread", {}, [settings(""), settings("child-thread")]],
  ])("stores everything for %s", async (_name, payload, events) => {
    await withWorld(async (world) => {
      world.write(lines(fork(payload), message("user", "parent"), ...events, message("assistant", "child")));
      await world.ingest();
      expect(world.messages()).toEqual(["parent", "child"]);
      expect(world.links()).toEqual(["parent", "child"]);
      expect(world.markers()).toEqual([]);
    });
  });

  it("does not look past a malformed first line for the fork's session_meta", async () => {
    await withWorld(async (world) => {
      world.write("{broken\n" + copied([message("user", "parent")], [message("assistant", "child")]));
      await world.ingest();
      expect(world.messages()).toEqual(["parent", "child"]);
      expect(world.markers()).toEqual([]);
    });
  });

  it("lets a valid subagent ordinal win, and a malformed one fall through to the copied cut", async () => {
    await withWorld(async (world) => {
      world.write(copied(
        [message("user", "A", 0), message("assistant", "B", 1), message("user", "C", 2)],
        [message("assistant", "D", 3)],
        { subagent_history_start_ordinal: 2, history_mode: "paginated" },
      ));
      await world.ingest();
      // The ordinal cut keeps C and D; the settings event would keep only D.
      expect(world.messages()).toEqual(["C", "D"]);
      expect(world.markers()).toEqual([]);
    });
    await withWorld(async (world) => {
      world.write(copied(
        [message("user", "A", 0), message("assistant", "B", 1), message("user", "C", 2)],
        [message("assistant", "D", 3)],
        { subagent_history_start_ordinal: "2", history_mode: "paginated" },
      ));
      await world.ingest();
      expect(world.messages()).toEqual(["D"]);
      expect(world.markers()).toHaveLength(1);
    });
  });

  it("ignores each record's own ordinal when classifying a copied fork", async () => {
    await withWorld(async (world) => {
      world.write(copied(
        [message("user", "parent", 40)],
        [message("assistant", "child", 0), message("user", "child 2")],
      ));
      await world.ingest();
      expect(world.messages()).toEqual(["child", "child 2"]);
      expect(world.links()).toEqual(["child", "child 2"]);
    });
  });

  it("archives the records of a fork that has not written its settings event, then stores its messages", async () => {
    await withWorld(async (world) => {
      world.write(lines(fork(), message("user", "parent 1"), settings("parent-thread"), message("assistant", "parent 2")));
      expect(await world.ingest()).toEqual(NOTHING);
      expect(world.messages()).toEqual([]);
      expect(world.markers()).toEqual([]);
      expect(world.nativeRecords()).toBe(4);
      expect(world.links()).toEqual([]);
      expect(logs.error).not.toHaveBeenCalled();
      // Only /session-complete records a completion, and ingest never does.
      expect(world.completions()).toBe(0);

      world.append(lines(settings("child-thread"), message("user", "child 1")));
      expect((await world.ingest()).body).toMatchObject({ ingested: 1 });
      expect(world.messages()).toEqual(["child 1"]);
      expect(world.links()).toEqual(["child 1"]);
      expect(world.nativeRecords()).toBe(6);
      expect(world.markers()).toEqual([{ content: "child 1", metadata: boundaryMarker }]);
      expect(world.completions()).toBe(0);
      expect((await world.complete()).body).toEqual({ recorded: true });
      expect(world.completions()).toBe(1);
    });
  });

  it("records a rollout with only its session_meta and no messages", async () => {
    await withWorld(async (world) => {
      world.write(lines(fork({ parent_thread_id: "real-parent" })));
      expect(await world.ingest()).toEqual(NOTHING);
      expect(world.nativeRecords()).toBe(1);
      expect(world.messages()).toEqual([]);
      // No conversation is created for it, so no parent link either.
      expect(world.parent()).toBeUndefined();
    });
  });

  it("keeps the immediate parent link and never takes it from forked_from_id", async () => {
    await withWorld(async (world) => {
      world.write(copied([message("user", "parent")], [message("assistant", "child")]));
      await world.ingest();
      expect(world.parent()).toBeNull();
    });
    await withWorld(async (world) => {
      world.write(copied([message("user", "parent")], [message("assistant", "child")], { parent_thread_id: "real-parent" }));
      await world.ingest();
      expect(world.parent()).toBe("real-parent");
    });
    // An empty fork over an existing conversation still links its parent.
    await withWorld(async (world) => {
      await world.seed("claude", ["user", "A"]);
      world.write(lines(fork({ parent_thread_id: "real-parent" })));
      await world.ingest();
      expect(world.parent()).toBe("real-parent");
    });
  });

  it("keeps a legacy session on the full reading when the child repeats the stored prefix", async () => {
    await withWorld(async (world) => {
      await world.seed("claude", ["user", "A"]);
      world.write(copied([message("user", "A")], [message("user", "A"), message("assistant", "B")]));
      expect((await world.ingest()).body).toMatchObject({ ingested: 2 });
      // The child reading ["A", "B"] extends ["A"] as well, but the stored rows follow the full one.
      expect(world.messages()).toEqual(["A", "A", "B"]);
      expect(world.links()).toEqual(["A", "A", "B"]);
      expect(world.markers()).toEqual([]);
      expect(await world.ingest()).toEqual(NOTHING);
      expect(logs.error).not.toHaveBeenCalled();
    });
  });

  it("keeps a legacy session on the full reading across a path change and with no links", async () => {
    await withWorld(async (world) => {
      await world.seed("claude", ["user", "P1"], ["assistant", "P2"]);
      const moved = join(world.cwd, "moved.jsonl");
      world.write(copied([message("user", "P1"), message("assistant", "P2")], [message("user", "own")]), moved);
      expect((await world.ingest({ transcript_path: moved })).body).toMatchObject({ ingested: 1 });
      expect(world.messages()).toEqual(["P1", "P2", "own"]);
      expect(world.links()).toEqual(["P1", "P2", "own"]);
      expect(world.markers()).toEqual([]);
    });
  });

  it("stops a legacy session whose stored rows are not a prefix of the full reading", async () => {
    await withWorld(async (world) => {
      await world.seed("claude", ["user", "unrelated"]);
      world.write(copied([message("user", "P1")], [message("assistant", "own")]));
      expect(await world.ingest()).toEqual(NOTHING);
      expect(world.messages()).toEqual(["unrelated"]);
      expect(world.nativeRecords()).toBe(0);
      expect(logs.error).toHaveBeenCalledTimes(1);
      expect(String(logs.error.mock.calls[0]![1])).toContain("does not continue");
    });
  });

  it("does not move a legacy session onto the child reading when its rollout is still pending", async () => {
    await withWorld(async (world) => {
      await world.seed("claude", ["user", "P1"]);
      world.write(lines(fork(), message("user", "P1"), message("assistant", "P2")));
      expect((await world.ingest()).body).toMatchObject({ ingested: 1 });
      expect(world.messages()).toEqual(["P1", "P2"]);
    });
  });

  it("stays on the child reading when the child's own messages equal the inherited prefix", async () => {
    await withWorld(async (world) => {
      world.write(copied(
        [message("user", "A"), message("assistant", "B")],
        [message("user", "A"), message("assistant", "B")],
      ));
      expect((await world.ingest()).body).toMatchObject({ ingested: 2 });
      expect(world.messages()).toEqual(["A", "B"]);
      world.append(lines(message("user", "C")));
      expect((await world.ingest()).body).toMatchObject({ ingested: 1 });
      expect(world.messages()).toEqual(["A", "B", "C"]);
      expect(world.links()).toEqual(["A", "B", "C"]);
      expect(await world.ingest()).toEqual(NOTHING);
      expect(logs.error).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["distinct", "parent text", "child text"],
    ["equal", "same text", "same text"],
  ])("stops a message-list session when a copied fork file arrives (%s text)", async (_name, parentText, childText) => {
    await withWorld(async (world) => {
      await world.seed("codex", ["user", childText]);
      expect(world.markers()).toEqual([{ content: childText, metadata: encodeCodexLineageMarker("array") }]);
      world.write(copied([message("user", parentText)], [message("user", childText)]));
      expect(await world.ingest()).toEqual(NOTHING);
      expect(world.messages()).toEqual([childText]);
      expect(world.nativeRecords()).toBe(0);
      expect(logs.error).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ["distinct", "parent text", "child text"],
    ["equal", "same text", "same text"],
  ])("stops a copied fork session when a message list arrives (%s text)", async (_name, parentText, childText) => {
    await withWorld(async (world) => {
      world.write(copied([message("user", parentText)], [message("user", childText)]));
      await world.ingest();
      expect(world.messages()).toEqual([childText]);
      await world.seed("codex", ["user", parentText], ["user", childText]);
      expect(world.messages()).toEqual([childText]);
      expect(logs.error).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps a message-list session on the cumulative list for further lists and plain files", async () => {
    await withWorld(async (world) => {
      await world.seed("codex", ["user", "A"]);
      await world.seed("codex", ["user", "A"], ["assistant", "B"]);
      expect(world.messages()).toEqual(["A", "B"]);
      world.write(lines(fork({ forked_from_id: undefined }), message("user", "A"), message("assistant", "B"), message("user", "C")));
      expect((await world.ingest()).body).toMatchObject({ ingested: 1 });
      expect(world.messages()).toEqual(["A", "B", "C"]);
      expect(world.markers()).toHaveLength(1);
      expect(logs.error).not.toHaveBeenCalled();
    });
  });

  it("stops a copied fork session when the rollout no longer reads as a fork", async () => {
    await withWorld(async (world) => {
      world.write(copied([message("user", "parent")], [message("assistant", "child")]));
      await world.ingest();
      world.write(lines(fork({ history_base: "x" }), message("user", "parent"), settings("child-thread"), message("assistant", "child"), message("user", "more")));
      expect(await world.ingest()).toEqual(NOTHING);
      expect(world.messages()).toEqual(["child"]);
      expect(logs.error).toHaveBeenCalledTimes(1);
    });
  });

  it("reads a split session's array marker from its first row", async () => {
    await withWorld(async (world) => {
      await world.seed("codex", ["user", "A"]);
      world.exec(laterConversation);
      world.write(lines(fork({ forked_from_id: undefined }), message("user", "A"), message("assistant", "B")));
      expect((await world.ingest()).body).toMatchObject({ ingested: 1 });
      expect(world.messages()).toEqual(["A", "B"]);
    });
  });

  it("stops a message list or plain rollout once a boundary session splits across conversations", async () => {
    await withWorld(async (world) => {
      world.write(copied([message("user", "parent")], [message("user", "own 1")]));
      await world.ingest();
      world.exec(laterConversation);
      const links = world.links();
      const records = world.nativeRecords();
      // The Codex cumulative list still holds the parent's message and the stored own one.
      await world.seed("codex", ["user", "parent"], ["user", "own 1"], ["assistant", "own 2"]);
      expect(world.messages()).toEqual(["own 1"]);
      expect(logs.error).toHaveBeenCalledTimes(1);
      world.write(lines(fork({ forked_from_id: undefined }), message("user", "parent"), message("user", "own 1"), message("assistant", "own 2")));
      expect(await world.ingest()).toEqual(NOTHING);
      expect(world.messages()).toEqual(["own 1"]);
      expect(world.links()).toEqual(links);
      expect(world.nativeRecords()).toBe(records);
      expect(logs.error).toHaveBeenCalledTimes(2);
    });
  });

  it("skips other sessions and empty conversations when looking for a split session's first row", async () => {
    await withWorld(async (world) => {
      world.write(copied([message("user", "parent")], [message("user", "own 1")]));
      await world.ingest();
      world.exec("INSERT INTO conversations(session_id, created_at) VALUES('other-thread', '1998-01-01 00:00:00')");
      world.exec("INSERT INTO conversations(session_id, created_at) VALUES('child-thread', '1999-01-01 00:00:00')");
      world.exec(laterConversation);
      world.exec(transcriptRow(1, "assistant", "own 2"));
      await world.seed("codex", ["user", "parent"], ["user", "own 1"]);
      expect(world.messages()).toEqual(["own 1", "own 2"]);
      expect(logs.error).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the child reading across a fresh compaction event", async () => {
    await withWorld(async (world) => {
      world.write(copied([message("user", "parent")], [message("user", "own 1"), message("assistant", "own 2")]));
      await world.ingest();
      world.exec(eventRow(2, unconsumed));
      world.append(lines(message("user", "own 3")));
      expect((await world.ingest()).body).toMatchObject({ ingested: 1 });
      expect(world.allMessages()).toEqual(["own 1", "own 2", EVENT, "own 3"]);
      expect(world.links()).toEqual(["own 1", "own 2", "own 3"]);
      expect(logs.error).not.toHaveBeenCalled();
    });
  });

  it("stops a copied fork whose compaction event already took a transcript slot", async () => {
    await withWorld(async (world) => {
      world.write(copied([message("user", "parent")], [message("user", "own 1")]));
      await world.ingest();
      world.exec(eventRow(1, null));
      world.exec(transcriptRow(2, "assistant", "own 2"));
      world.append(lines(message("assistant", "own 2"), message("user", "own 3")));
      expect(await world.ingest()).toEqual(NOTHING);
      expect(world.messages()).toEqual(["own 1", "own 2"]);
      expect(logs.error).toHaveBeenCalledTimes(1);
    });
  });

  it("stops a copied fork whose session is split across conversations", async () => {
    await withWorld(async (world) => {
      world.write(copied([message("user", "parent")], [message("user", "own 1")]));
      await world.ingest();
      world.exec(laterConversation);
      world.append(lines(message("assistant", "own 2")));
      expect(await world.ingest()).toEqual(NOTHING);
      expect(world.messages()).toEqual(["own 1"]);
      expect(logs.error).toHaveBeenCalledTimes(1);
    });
  });

  it("stops a copied fork when a scrub pattern added after storage changes the stored text", async () => {
    await withWorld(async (world) => {
      world.write(copied([message("user", "parent")], [message("user", "SENSITIVE1234")]));
      await world.ingest();
      world.append(lines(message("assistant", "next")));
      expect(await world.ingestWith(["SENSITIVE[0-9]+"])).toEqual(NOTHING);
      expect(world.messages()).toEqual(["SENSITIVE1234"]);
      expect(logs.error).toHaveBeenCalledTimes(1);
    });
  });

  it("classifies from the raw record when a scrub pattern renames thread_id", async () => {
    await withWorld(async (world) => {
      world.write(copied([message("user", "parent")], [message("user", "own 1")]));
      await world.ingest();
      world.append(lines(message("assistant", "own 2")));
      expect((await world.ingest()).body).toMatchObject({ ingested: 1 });
      expect(world.links()).toEqual(["own 1", "own 2"]);
      expect(world.messages()).toEqual(["own 1", "own 2"]);
    }, ["thread_id", "forked_from_id"]);
  });

  it("stops on a malformed, contradictory or unreadable marker and ignores other metadata", async () => {
    const attempts: Array<[string, string, boolean]> = [
      ["a malformed marker", JSON.stringify({ [CODEX_LINEAGE_METADATA_KEY]: "boundary" }), true],
      ["another version", JSON.stringify({ [CODEX_LINEAGE_METADATA_KEY]: { version: 2, mode: "boundary" } }), true],
      ["another mode", JSON.stringify({ [CODEX_LINEAGE_METADATA_KEY]: { version: 1, mode: "other" } }), true],
      ["a contradicting marker", encodeCodexLineageMarker("array"), true],
      ["the same marker twice", boundaryMarker, false],
      ["unrelated JSON", JSON.stringify({ other: 1 }), false],
      ["plain text", "not json", false],
      ["an array", "[]", false],
    ];
    for (const [name, metadata, stops] of attempts) {
      logs.error.mockClear();
      await withWorld(async (world) => {
        world.write(copied([message("user", "parent")], [message("user", "own 1")]));
        await world.ingest();
        world.exec("INSERT INTO message_parts(part_id, message_id, session_id, part_type, ordinal, metadata) SELECT 'extra', message_id, 'child-thread', 'snapshot', 5, '" + metadata.replaceAll("'", "''") + "' FROM messages");
        world.append(lines(message("assistant", "own 2")));
        const result = await world.ingest();
        expect([name, result.body.ingested]).toEqual([name, stops ? 0 : 1]);
        expect([name, logs.error.mock.calls.length]).toEqual([name, stops ? 1 : 0]);
      });
    }
  });

  it("stops a message-list or plain session whose marker is malformed", async () => {
    await withWorld(async (world) => {
      await world.seed("codex", ["user", "A"]);
      world.exec("UPDATE message_parts SET metadata = '{\"" + CODEX_LINEAGE_METADATA_KEY + "\":null}'");
      await world.seed("codex", ["user", "A"], ["assistant", "B"]);
      expect(world.messages()).toEqual(["A"]);
      expect(logs.error).toHaveBeenCalledTimes(1);
    });
  });

  it("stops a copied fork whose stored rows are not a prefix of its child reading", async () => {
    await withWorld(async (world) => {
      world.write(copied([message("user", "parent")], [message("user", "own 1")]));
      await world.ingest();
      world.write(copied([message("user", "parent")], [message("user", "changed 1"), message("assistant", "own 2")]));
      expect(await world.ingest()).toEqual(NOTHING);
      expect(world.messages()).toEqual(["own 1"]);
      expect(logs.error).toHaveBeenCalledTimes(1);
    });
  });

  it("stops a pending rollout over stored rows and an emptied rollout over stored rows", async () => {
    await withWorld(async (world) => {
      world.write(copied([message("user", "parent")], [message("user", "own 1")]));
      await world.ingest();
      world.write(lines(fork(), message("user", "parent")));
      expect(await world.ingest()).toEqual(NOTHING);
      world.write(lines(fork()));
      expect(await world.ingest()).toEqual(NOTHING);
      expect(world.messages()).toEqual(["own 1"]);
      expect(logs.error).toHaveBeenCalledTimes(2);
    });
  });

  it("stops a boundary session on a rollout with no messages and no copied-fork boundary", async () => {
    await withWorld(async (world) => {
      world.write(copied([message("user", "parent")], [message("user", "own 1")]));
      await world.ingest();
      world.exec(eventRow(1, unconsumed));
      const records = world.nativeRecords();
      const other = join(world.cwd, "other.jsonl");
      world.write(lines(fork({ forked_from_id: undefined })), other);
      expect(await world.ingest({ transcript_path: other })).toEqual(NOTHING);
      expect(world.nativeRecords()).toBe(records);
      expect(world.messages()).toEqual(["own 1"]);
      expect(logs.error).toHaveBeenCalledTimes(1);
      expect(String(logs.error.mock.calls[0]![0])).toBe("ingest");

      expect((await world.compact({ transcript_path: other })).status).toBe(200);
      expect(logs.error).toHaveBeenCalledTimes(2);
      expect(String(logs.error.mock.calls[1]![0])).toBe("compact");
    });
  });

  it("still records an empty plain rollout over an array or legacy session", async () => {
    for (const client of ["codex", "claude"] as const) {
      await withWorld(async (world) => {
        await world.seed(client, ["user", "stored"]);
        world.write(lines(fork({ forked_from_id: undefined })));
        expect(await world.ingest()).toEqual(NOTHING);
        expect(world.nativeRecords()).toBe(1);
        expect(logs.error).not.toHaveBeenCalled();
      });
    }
  });

  it("stops an empty plain rollout when the stored marker is unreadable", async () => {
    await withWorld(async (world) => {
      await world.seed("codex", ["user", "stored"]);
      world.exec("UPDATE message_parts SET metadata = '{\"lcmCodexLineage\":1}' WHERE metadata LIKE '%lcmCodexLineage%'");
      world.write(lines(fork({ forked_from_id: undefined })));
      expect(await world.ingest()).toEqual(NOTHING);
      expect(world.nativeRecords()).toBe(0);
      expect(logs.error).toHaveBeenCalledTimes(1);
    });
  });

  it("accepts an empty fork over a conversation that holds no transcript rows", async () => {
    await withWorld(async (world) => {
      await world.seed("claude", ["user", "x"]);
      world.exec("DELETE FROM context_items; DELETE FROM messages;");
      world.write(lines(fork()));
      expect(await world.ingest()).toEqual(NOTHING);
      expect(world.nativeRecords()).toBe(1);
      expect(logs.error).not.toHaveBeenCalled();
    });
  });

  it("counts the lines native ingest counts, so stored messages and links agree", async () => {
    await withWorld(async (world) => {
      const weird = [
        "\u000b", "\u00a0", "{broken", "null", "[]", "7", '{"a":1,"a":2}',
        "x".repeat(10 * 1024 * 1024 + 1),
      ];
      world.write(lines(
        fork(),
        message("user", "X"),
        " \t\r",
        ...weird,
        settings("child-thread"),
        message("user", "X"),
        message("assistant", "Y"),
      ));
      expect((await world.ingest()).body).toMatchObject({ ingested: 2 });
      expect(world.messages()).toEqual(["X", "Y"]);
      expect(world.links()).toEqual(["X", "Y"]);
      // Records are session_meta, the parent message, the [] line, the settings event and two messages; the rest are quarantined.
      expect(world.nativeRecords()).toBe(6);
    });
  });

  it("fails closed instead of linking a repeated child message to the wrong row after a quarantined line", async () => {
    await withWorld(async (world) => {
      world.write(lines(
        fork(),
        "{broken",
        message("user", "parent"),
        settings("child-thread"),
        message("user", "X"),
        message("user", "X"),
      ));
      expect((await world.ingest()).status).toBe(500);
      expect(world.messages()).toEqual(["X", "X"]);
      expect(world.links()).toEqual([]);
    });
  });

  it("does not run the lineage rules for a Claude message list", async () => {
    await withWorld(async (world) => {
      await world.seed("claude", ["user", "A"]);
      expect(world.markers()).toEqual([]);
    });
  });
});

describe("Codex copied fork history on compact", () => {
  it("does not store inherited messages after ingest, and stays idempotent", async () => {
    await withWorld(async (world) => {
      world.write(copied([message("user", "parent")], [message("user", "own 1"), message("assistant", "own 2")]));
      await world.ingest();
      expect((await world.compact()).status).toBe(200);
      expect(world.messages()).toEqual(["own 1", "own 2"]);
      expect((await world.ingest()).status).toBe(200);
      expect(world.messages()).toEqual(["own 1", "own 2"]);
      expect(world.links()).toEqual(["own 1", "own 2"]);
      expect(logs.error).not.toHaveBeenCalled();
    });
  });

  it("stores only the fork's own messages when compact runs first, then lets ingest link them", async () => {
    await withWorld(async (world) => {
      world.write(copied([message("user", "parent")], [message("user", "own 1"), message("assistant", "own 2")]));
      expect((await world.compact()).status).toBe(200);
      expect(world.messages()).toEqual(["own 1", "own 2"]);
      expect(world.markers()).toEqual([{ content: "own 1", metadata: boundaryMarker }]);
      expect((await world.ingest()).status).toBe(200);
      expect(world.messages()).toEqual(["own 1", "own 2"]);
      expect(world.links()).toEqual(["own 1", "own 2"]);
      expect(logs.error).not.toHaveBeenCalled();
    });
  });

  it("stops an unmarked copied-fork session whose compaction event consumed a slot", async () => {
    await withWorld(async (world) => {
      await world.seed("claude", ["user", "P1"]);
      world.exec(eventRow(1, null));
      world.exec(transcriptRow(2, "assistant", "P2"));
      world.write(copied([message("user", "P1"), message("assistant", "P2")], [message("user", "own 1"), message("assistant", "own 2")]));
      // The event took a list position, so a count cannot show the full reading continues the rows.
      expect((await world.compact()).status).toBe(200);
      expect(world.messages()).toEqual(["P1", "P2"]);
      expect(world.markers()).toEqual([]);
      expect(world.nativeRecords()).toBe(0);
      expect(logs.error).toHaveBeenCalledTimes(1);
      expect(String(logs.error.mock.calls[0]![0])).toBe("compact");
      expect(await world.ingest()).toEqual(NOTHING);
      expect(world.messages()).toEqual(["P1", "P2"]);
      expect(world.links()).toEqual([]);
      expect(logs.error).toHaveBeenCalledTimes(2);
    });
  });

  it("does not parse the rollout when asked to skip ingestion", async () => {
    await withWorld(async (world) => {
      world.write(copied([message("user", "parent")], [message("user", "own 1")]));
      expect((await world.compact({ skip_ingest: true })).status).toBe(200);
      expect(world.messages()).toEqual([]);
    });
  });

  it("stores nothing for a pending fork and keeps a legacy session on the full reading", async () => {
    await withWorld(async (world) => {
      world.write(lines(fork(), message("user", "parent")));
      expect((await world.compact()).status).toBe(200);
      expect(world.messages()).toEqual([]);
    });
    await withWorld(async (world) => {
      await world.seed("claude", ["user", "parent"]);
      world.write(copied([message("user", "parent")], [message("assistant", "own")]));
      expect((await world.compact()).status).toBe(200);
      expect(world.messages()).toEqual(["parent", "own"]);
      expect(world.markers()).toEqual([]);
    });
  });

  it("logs and leaves a session alone when its stored reading is not continued", async () => {
    await withWorld(async (world) => {
      await world.seed("codex", ["user", "from a list"]);
      world.write(copied([message("user", "parent")], [message("assistant", "own")]));
      expect((await world.compact()).status).toBe(200);
      expect(world.messages()).toEqual(["from a list"]);
      expect(logs.error).toHaveBeenCalledTimes(1);
      expect(String(logs.error.mock.calls[0]![0])).toBe("compact");
    });
  });

  it("appends a plain Codex rollout and tolerates an unreadable or empty one", async () => {
    await withWorld(async (world) => {
      world.write(lines(fork({ forked_from_id: undefined }), message("user", "one")));
      expect((await world.compact()).status).toBe(200);
      expect(world.messages()).toEqual(["one"]);
    });
    await withWorld(async (world) => {
      world.write("");
      expect((await world.compact()).status).toBe(200);
      expect(world.messages()).toEqual([]);
      expect((await world.compact({ transcript_path: world.cwd })).status).toBe(200);
    });
  });

  it("keeps the Claude path on the cumulative list", async () => {
    await withWorld(async (world) => {
      world.write(lines(JSON.stringify({ message: { role: "user", content: "hello" } })));
      expect((await world.compact({ client: "claude" })).status).toBe(200);
      expect(world.messages()).toEqual(["hello"]);
    });
  });
});

describe("Codex lineage marker", () => {
  it("round-trips both modes", () => {
    expect(JSON.parse(encodeCodexLineageMarker("boundary"))).toEqual({ [CODEX_LINEAGE_METADATA_KEY]: { version: 1, mode: "boundary" } });
    expect(parseCodexLineageMarker(encodeCodexLineageMarker("boundary"))).toBe("boundary");
    expect(parseCodexLineageMarker(encodeCodexLineageMarker("array"))).toBe("array");
  });

  it.each([
    ["no metadata", null],
    ["text", "nope"],
    ["a scalar", "1"],
    ["a null", "null"],
    ["an array", "[]"],
    ["another key", JSON.stringify({ lcmTranscriptSlot: { version: 1, consumed: true } })],
  ])("does not read %s as a marker", (_name, metadata) => {
    expect(parseCodexLineageMarker(metadata)).toBeNull();
  });

  it.each([
    ["a null value", { [CODEX_LINEAGE_METADATA_KEY]: null }],
    ["a scalar value", { [CODEX_LINEAGE_METADATA_KEY]: 1 }],
    ["an array value", { [CODEX_LINEAGE_METADATA_KEY]: [] }],
    ["another version", { [CODEX_LINEAGE_METADATA_KEY]: { version: 2, mode: "array" } }],
    ["an unknown mode", { [CODEX_LINEAGE_METADATA_KEY]: { version: 1, mode: "x" } }],
    ["no mode", { [CODEX_LINEAGE_METADATA_KEY]: { version: 1 } }],
  ])("reads %s as malformed", (_name, value) => {
    expect(parseCodexLineageMarker(JSON.stringify(value))).toBe("malformed");
  });

  it("stops an empty plain rollout when no first transcript row can be found for a stored session", async () => {
    const conversation = { conversationId: 7, sessionId: "s", parentSessionId: null };
    const conversations = {
      getConversationBySessionId: async () => conversation,
      getTranscriptSlotSnapshot: async () => ({ transcriptCount: 2, events: [] }),
      getMessageCount: async () => 1,
      getMessageCountBySessionId: async () => 2,
      listConversations: async () => [],
      getMessages: vi.fn(),
      appendMessages: vi.fn(),
    };
    const result = await persistCodexLineage(
      { conversations } as never,
      "s",
      { source: "file", full: [] },
      undefined,
      async () => undefined,
    );
    expect(result).toEqual({ persisted: null, history: "lineage-mismatch" });
    expect(conversations.getMessages).not.toHaveBeenCalled();
    expect(conversations.appendMessages).not.toHaveBeenCalled();
  });

  it("stops a message list when no first transcript row can be found for a stored session", async () => {
    const conversation = { conversationId: 7, sessionId: "s", parentSessionId: null };
    const conversations = {
      getOrCreateConversation: async () => conversation,
      getTranscriptSlotSnapshot: async () => ({ transcriptCount: 2, events: [] }),
      getMessageCount: async () => 1,
      getMessageCountBySessionId: async () => 2,
      listConversations: async () => [],
      getMessages: vi.fn(),
      appendMessages: vi.fn(),
    };
    const result = await persistCodexLineage(
      { conversations } as never,
      "s",
      { source: "array", full: [{ role: "user", content: "a", tokenCount: 1 }] },
      undefined,
      async () => undefined,
    );
    expect(result).toEqual({ persisted: null, history: "lineage-mismatch" });
    expect(conversations.getMessages).not.toHaveBeenCalled();
    expect(conversations.appendMessages).not.toHaveBeenCalled();
  });
});
