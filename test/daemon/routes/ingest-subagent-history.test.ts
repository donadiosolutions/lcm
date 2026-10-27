import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { createStorageBackendFactory } from "../../../src/storage/index.js";
import { createIngestHandler } from "../../../src/daemon/routes/ingest.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { closeLcmConnection, getLcmConnection } from "../../../src/db/connection.js";
import * as codexTranscript from "../../../src/codex-transcript.js";

const logs = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../../../src/hooks/hook-errors.js", () => ({ safeLogError: logs.error }));
afterEach(() => vi.restoreAllMocks());

type Role = "user" | "assistant";

const message = (ordinal: number | undefined, role: Role, text: string): string => JSON.stringify({
  type: "response_item",
  ...(ordinal === undefined ? {} : { ordinal }),
  payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
});
const tool = (ordinal: number): string => JSON.stringify({
  type: "response_item", ordinal, payload: { type: "function_call", name: "exec", arguments: "{}" },
});
const meta = (payload: Record<string, unknown> = {}): string => JSON.stringify({
  type: "session_meta", payload: { id: "child-thread", cwd: "/work", ...payload },
});
const lines = (...records: string[]): string => records.map((record) => record + "\n").join("");
/** A compaction event row in the newest conversation, as written before slot markers existed. */
const legacyEvent = (conversation: string, seq: number): string => `
  INSERT INTO messages(conversation_id, seq, role, content, token_count)
    VALUES(${conversation}, ${seq}, 'system', 'LCM compaction leaf pass (normal): 10 -> 5', 1);
  INSERT INTO message_parts(part_id, message_id, session_id, part_type, ordinal, metadata)
    VALUES('event-' || last_insert_rowid(), last_insert_rowid(), 'child-thread', 'compaction', 0, '{}');`;
const EVENT = "LCM compaction leaf pass (normal): 10 -> 5";
const newestConversation = "(SELECT MAX(conversation_id) FROM conversations)";

async function withWorld(
  run: (world: {
    cwd: string;
    source: string;
    write(text: string): void;
    append(text: string): void;
    ingest(extra?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
    ingestWith(patterns: string[]): Promise<{ status: number; body: Record<string, unknown> }>;
    seed(...rows: Array<[Role, string]>): Promise<void>;
    exec(sql: string): void;
    parent(): string | null | undefined;
    messages(): string[];
    links(): string[];
    nativeRecords(): number;
  }) => Promise<void>,
  patterns: string[] = [],
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-history-"));
  const source = join(cwd, "child.jsonl");
  const factories: Array<{ close(): Promise<void> }> = [];
  const handlerFor = async (sensitivePatterns: string[]) => {
    const config = loadDaemonConfig(join(cwd, "nonexistent"), { security: { sensitivePatterns } });
    const factory = await createStorageBackendFactory(config.storage);
    factories.push(factory);
    return createIngestHandler(config, factory);
  };
  const handler = await handlerFor(patterns);
  const callWith = async (route: typeof handler, payload: Record<string, unknown>) => {
    let status = 0;
    let body = "";
    const res = { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; } };
    await route({} as never, res as never, JSON.stringify({ cwd, client: "codex", session_id: "child-thread", ...payload }));
    return { status, body: JSON.parse(body) as Record<string, unknown> };
  };
  const call = (payload: Record<string, unknown>) => callWith(handler, payload);
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
      write: (text) => writeFileSync(source, text, { mode: 0o600 }),
      append: (text) => appendFileSync(source, text),
      ingest: (extra = {}) => call({ transcript_path: source, ...extra }),
      ingestWith: async (other) => callWith(await handlerFor(other), { transcript_path: source }),
      seed: async (...rows) => {
        const result = await call({ messages: rows.map(([role, content]) => ({ role, content, tokenCount: 1 })) });
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
      messages: () => query<{ content: string }>("SELECT content FROM messages ORDER BY conversation_id, seq").map((row) => row.content),
      links: () => query<{ content: string }>(
        "SELECT m.content AS content FROM runtime_native_transcript_messages l JOIN messages m ON m.message_id = l.message_id ORDER BY l.source_ordinal",
      ).map((row) => row.content),
      nativeRecords: () => query<{ n: number }>("SELECT count(*) AS n FROM runtime_native_transcripts")[0]!.n,
    });
  } finally {
    for (const factory of factories) await factory.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("Codex forked subagent history on ingest", () => {
  it("stores only the child's own messages, links them exactly, and resumes after an append", async () => {
    await withWorld(async (world) => {
      world.write(lines(
        meta({ subagent_history_start_ordinal: 4, history_mode: "paginated" }),
        message(0, "user", "parent question"),
        tool(1),
        message(2, "assistant", "parent answer"),
        message(3, "user", "parent follow-up"),
        message(4, "user", "child task"),
        tool(5),
        message(6, "assistant", "child result"),
      ));
      expect((await world.ingest()).body).toMatchObject({ ingested: 2 });
      expect(world.messages()).toEqual(["child task", "child result"]);
      expect(world.links()).toEqual(["child task", "child result"]);
      expect(world.nativeRecords()).toBe(8);

      expect(await world.ingest()).toEqual({ status: 200, body: { ingested: 0, totalTokens: 0 } });

      world.append(lines(message(7, "assistant", "child final")));
      expect((await world.ingest()).body).toMatchObject({ ingested: 1 });
      expect(world.messages()).toEqual(["child task", "child result", "child final"]);
      expect(world.links()).toEqual(["child task", "child result", "child final"]);
    });
  });

  it("keeps a fresh child filtered across identical snapshots when its own text repeats inherited text", async () => {
    await withWorld(async (world) => {
      world.write(lines(
        meta({ subagent_history_start_ordinal: 2, history_mode: "paginated" }),
        message(0, "user", "A"),
        message(1, "assistant", "B"),
        message(2, "user", "A"),
      ));
      await world.ingest();
      await world.ingest();
      expect(world.messages()).toEqual(["A"]);
      expect(world.links()).toEqual(["A"]);
      expect(await world.ingest()).toEqual({ status: 200, body: { ingested: 0, totalTokens: 0 } });
      expect(world.messages()).toEqual(["A"]);

      // Growing keeps the tie on the filtered list: only an own record is linked.
      world.append(lines(message(3, "assistant", "C")));
      expect((await world.ingest()).body).toMatchObject({ ingested: 1 });
      expect(world.messages()).toEqual(["A", "C"]);
      expect(world.links()).toEqual(["A", "C"]);
    });
  });

  it("keeps a conversation on its unfiltered list when a committed link sits on inherited history", async () => {
    await withWorld(async (world) => {
      world.write(lines(
        meta({ subagent_history_start_ordinal: 2, history_mode: "paginated" }),
        message(0, "user", "A"),
      ));
      // The first snapshot is what a build without the filter would have stored.
      vi.spyOn(codexTranscript, "readCodexInheritedBoundary").mockReturnValueOnce(undefined);
      await world.ingest();
      expect(world.messages()).toEqual(["A"]);
      expect(world.links()).toEqual(["A"]);

      world.append(lines(message(1, "assistant", "B"), message(2, "user", "A")));
      expect((await world.ingest()).body).toMatchObject({ ingested: 2 });
      expect(world.messages()).toEqual(["A", "B", "A"]);
      expect(world.links()).toEqual(["A", "B", "A"]);
      expect(await world.ingest()).toEqual({ status: 200, body: { ingested: 0, totalTokens: 0 } });

      // A scrubber change rescans the source; the saved links must still agree.
      expect(await world.ingestWith(["never-matches-anything"])).toEqual({ status: 200, body: { ingested: 0, totalTokens: 0 } });
      expect(await world.ingestWith(["never-matches-anything"])).toEqual({ status: 200, body: { ingested: 0, totalTokens: 0 } });
      expect(world.links()).toEqual(["A", "B", "A"]);
      expect(logs.error).not.toHaveBeenCalled();
    });
  });

  it("neither stores nor links a non-extending boundary rollout over existing messages", async () => {
    await withWorld(async (world) => {
      await world.seed(["user", "existing"]);
      world.write(lines(meta({ subagent_history_start_ordinal: 0, history_mode: "paginated" }), tool(0)));
      expect(await world.ingest()).toEqual({ status: 200, body: { ingested: 0, totalTokens: 0 } });
      expect(world.messages()).toEqual(["existing"]);
      expect(world.nativeRecords()).toBe(0);
      expect(logs.error).toHaveBeenCalledTimes(1);
    });
  });

  it("treats a scrub pattern added after storage as a mismatch and appends nothing", async () => {
    await withWorld(async (world) => {
      world.write(lines(
        meta({ subagent_history_start_ordinal: 1, history_mode: "paginated" }),
        message(0, "user", "inherited"),
        message(1, "user", "SENSITIVE1234"),
      ));
      await world.ingest();
      expect(world.messages()).toEqual(["SENSITIVE1234"]);
      world.append(lines(message(2, "assistant", "next")));
      expect(await world.ingestWith(["SENSITIVE[0-9]+"])).toEqual({ status: 200, body: { ingested: 0, totalTokens: 0 } });
      expect(world.messages()).toEqual(["SENSITIVE1234"]);
      expect(logs.error).toHaveBeenCalledTimes(1);
    });
  });

  it("links own messages when a scrub pattern renames the ordinal key", async () => {
    await withWorld(async (world) => {
      world.write(lines(
        meta({ subagent_history_start_ordinal: 1, history_mode: "paginated" }),
        message(0, "user", "inherited"),
        message(1, "user", "own 1"),
      ));
      await world.ingest();
      expect(world.links()).toEqual(["own 1"]);
      world.append(lines(message(2, "assistant", "own 2")));
      expect((await world.ingest()).body).toMatchObject({ ingested: 1 });
      expect(world.messages()).toEqual(["own 1", "own 2"]);
      expect(world.links()).toEqual(["own 1", "own 2"]);
    }, ["ordinal"]);
  });

  it("keeps a previously stored unfiltered child on its legacy list and appends exactly once", async () => {
    await withWorld(async (world) => {
      await world.seed(["user", "P1"], ["assistant", "P2"], ["user", "own 1"]);
      world.write(lines(
        meta({ subagent_history_start_ordinal: 2, history_mode: "paginated" }),
        message(0, "user", "P1"),
        message(1, "assistant", "P2"),
        message(2, "user", "own 1"),
        message(3, "assistant", "own 2"),
      ));
      expect((await world.ingest()).body).toMatchObject({ ingested: 1 });
      expect((await world.ingest()).body).toMatchObject({ ingested: 0 });
      expect(world.messages()).toEqual(["P1", "P2", "own 1", "own 2"]);
      expect(world.links()).toEqual(["P1", "P2", "own 1", "own 2"]);
    });
  });

  it("prefers the filtered list when stored rows are a prefix of both", async () => {
    await withWorld(async (world) => {
      await world.seed(["user", "A"]);
      world.write(lines(
        meta({ subagent_history_start_ordinal: 2, history_mode: "paginated" }),
        message(0, "user", "A"),
        message(1, "assistant", "B"),
        message(2, "user", "A"),
        message(3, "assistant", "C"),
      ));
      await world.ingest();
      expect(world.messages()).toEqual(["A", "C"]);
      expect(world.links()).toEqual(["A", "C"]);
    });
  });

  it("neither appends nor links when stored rows match neither list, and logs a static diagnostic", async () => {
    await withWorld(async (world) => {
      await world.seed(["user", "unrelated"]);
      world.write(lines(
        meta({ subagent_history_start_ordinal: 1, history_mode: "paginated" }),
        message(0, "user", "inherited"),
        message(1, "assistant", "own"),
      ));
      expect(await world.ingest()).toEqual({ status: 200, body: { ingested: 0, totalTokens: 0 } });
      expect(world.messages()).toEqual(["unrelated"]);
      expect(world.nativeRecords()).toBe(0);
      expect(logs.error).toHaveBeenCalledTimes(1);
      expect(String(logs.error.mock.calls[0]![1])).toContain("matches neither");
    });
  });

  it("compares stored rows with the scrubbed transcript text", async () => {
    await withWorld(async (world) => {
      world.write(lines(
        meta({ subagent_history_start_ordinal: 1, history_mode: "paginated" }),
        message(0, "user", "inherited"),
        message(1, "user", "key SECRET-1 here"),
      ));
      await world.ingest();
      const stored = world.messages();
      expect(stored).toHaveLength(1);
      expect(stored[0]).not.toContain("SECRET-1");
      world.append(lines(message(2, "assistant", "next")));
      expect((await world.ingest()).body).toMatchObject({ ingested: 1 });
      expect(world.messages()).toEqual([stored[0], "next"]);
      expect(logs.error).not.toHaveBeenCalled();
    }, ["SECRET-[0-9]"]);
  });

  it("records the transcript without messages when every message is inherited", async () => {
    await withWorld(async (world) => {
      world.write(lines(
        meta({ subagent_history_start_ordinal: 2, history_mode: "paginated" }),
        message(0, "user", "inherited 1"),
        message(1, "assistant", "inherited 2"),
      ));
      expect(await world.ingest()).toEqual({ status: 200, body: { ingested: 0, totalTokens: 0 } });
      expect(world.messages()).toEqual([]);
      expect(world.nativeRecords()).toBe(3);
      expect(logs.error).not.toHaveBeenCalled();
    });
  });

  it("records a child rollout that has a boundary but no messages yet", async () => {
    await withWorld(async (world) => {
      world.write(lines(meta({ subagent_history_start_ordinal: 0, history_mode: "paginated" }), tool(0)));
      expect(await world.ingest()).toEqual({ status: 200, body: { ingested: 0, totalTokens: 0 } });
      expect(world.messages()).toEqual([]);
      expect(world.nativeRecords()).toBe(2);
      expect(logs.error).not.toHaveBeenCalled();
    });
  });

  it("keeps an unfiltered conversation when the filtered list is empty", async () => {
    await withWorld(async (world) => {
      await world.seed(["user", "P1"]);
      world.write(lines(
        meta({ subagent_history_start_ordinal: 1, history_mode: "paginated" }),
        message(0, "user", "P1"),
      ));
      expect((await world.ingest()).body).toMatchObject({ ingested: 0 });
      expect(world.messages()).toEqual(["P1"]);
      expect(world.links()).toEqual(["P1"]);
    });
  });

  it("links the first own message across a quarantined record before it", async () => {
    await withWorld(async (world) => {
      world.write(lines(
        meta({ subagent_history_start_ordinal: 1, history_mode: "paginated" }),
        message(0, "user", "inherited"),
      ) + "{not json\n" + lines(
        message(1, "user", "own 1"),
        message(2, "assistant", "own 2"),
      ));
      expect((await world.ingest())).toMatchObject({ status: 200, body: { ingested: 2 } });
      expect(world.links()).toEqual(["own 1", "own 2"]);
    });
  });

  it.each([
    ["a message before session_meta", lines(
      message(0, "user", "early"),
      meta({ subagent_history_start_ordinal: 5, history_mode: "paginated" }),
      message(1, "assistant", "late"),
    ), ["early", "late"]],
    ["a later session_meta", lines(
      meta({}),
      message(0, "user", "one"),
      meta({ subagent_history_start_ordinal: 5, history_mode: "paginated" }),
      message(1, "assistant", "two"),
    ), ["one", "two"]],
    ["a malformed start ordinal", lines(
      meta({ subagent_history_start_ordinal: "1", history_mode: "paginated" }),
      message(0, "user", "one"),
      message(1, "assistant", "two"),
    ), ["one", "two"]],
    ["a legacy rollout with a start ordinal and ordinal-less records", lines(
      meta({ subagent_history_start_ordinal: 1 }),
      message(undefined, "user", "one"),
      message(undefined, "assistant", "two"),
    ), ["one", "two"]],
    ["a legacy rollout with explicit ordinals", lines(
      meta({ subagent_history_start_ordinal: 1, history_mode: "legacy" }),
      message(0, "user", "inherited"),
      message(1, "assistant", "own"),
    ), ["own"]],
    ["a paginated rollout with an ordinal-less message", lines(
      meta({ subagent_history_start_ordinal: 1, history_mode: "paginated" }),
      message(undefined, "user", "unnumbered"),
      message(1, "assistant", "own"),
    ), ["own"]],
  ])("handles %s", async (_name, transcript, expected) => {
    await withWorld(async (world) => {
      world.write(transcript);
      await world.ingest();
      expect(world.messages()).toEqual(expected);
      expect(world.links()).toEqual(expected);
    });
  });

  it("leaves a root rollout without a boundary untouched", async () => {
    await withWorld(async (world) => {
      world.write(lines(meta({}), message(0, "user", "one"), message(1, "assistant", "two")));
      await world.ingest();
      expect(world.messages()).toEqual(["one", "two"]);
      expect(world.links()).toEqual(["one", "two"]);
    });
  });
});

describe("Codex forked subagent history with compaction events", () => {
  const forked = (...records: string[]): string => lines(
    meta({ parent_thread_id: "parent-thread", subagent_history_start_ordinal: 2, history_mode: "paginated" }),
    message(0, "user", "inherited 1"),
    message(1, "assistant", "inherited 2"),
    ...records,
  );

  it("continues the filtered history after a compaction event row and keeps linking exact", async () => {
    await withWorld(async (world) => {
      world.write(forked(message(2, "user", "own 1"), message(3, "assistant", "own 2")));
      expect((await world.ingest()).body).toMatchObject({ ingested: 2 });
      world.exec(legacyEvent(newestConversation, 2));

      world.append(lines(message(4, "user", "own 3")));
      expect((await world.ingest()).body).toMatchObject({ ingested: 1 });
      expect(world.messages()).toEqual(["own 1", "own 2", EVENT, "own 3"]);
      expect(world.links()).toEqual(["own 1", "own 2", "own 3"]);
      expect(await world.ingest()).toEqual({ status: 200, body: { ingested: 0, totalTokens: 0 } });
      expect(logs.error).not.toHaveBeenCalled();
    });
  });

  it("leaves the session alone when an event already took a transcript slot", async () => {
    await withWorld(async (world) => {
      await world.seed(["user", "own 1"]);
      world.exec(legacyEvent(newestConversation, 1));
      world.exec(`INSERT INTO messages(conversation_id, seq, role, content, token_count)
        VALUES(${newestConversation}, 2, 'user', 'own 2', 1)`);
      world.write(forked(
        message(2, "user", "own 1"), message(3, "user", "own 2"), message(4, "user", "own 3"),
      ));

      expect(await world.ingest()).toEqual({ status: 200, body: { ingested: 0, totalTokens: 0 } });
      expect(world.messages()).toEqual(["own 1", EVENT, "own 2"]);
      expect(world.nativeRecords()).toBe(0);
      expect(logs.error).toHaveBeenCalledTimes(1);
      expect(String(logs.error.mock.calls[0]![1])).toContain("matches neither");
      // The slot was adopted as consumed, and the parent link is still kept.
      expect(world.parent()).toBe("parent-thread");
    });
  });

  it("leaves a session split across conversations alone", async () => {
    await withWorld(async (world) => {
      await world.seed(["user", "own 1"]);
      world.exec(`INSERT INTO conversations(session_id, created_at) VALUES('child-thread', '2999-01-01 00:00:00');
        INSERT INTO messages(conversation_id, seq, role, content, token_count)
          VALUES(${newestConversation}, 0, 'user', 'own 2', 1)`);
      world.write(forked(
        message(2, "user", "own 1"), message(3, "user", "own 2"), message(4, "user", "own 3"),
      ));

      expect(await world.ingest()).toEqual({ status: 200, body: { ingested: 0, totalTokens: 0 } });
      expect(world.messages()).toEqual(["own 1", "own 2"]);
      expect(world.nativeRecords()).toBe(0);
      expect(logs.error).toHaveBeenCalledTimes(1);
      expect(world.parent()).toBe("parent-thread");
    });
  });

  it("ignores a recorded session completion count", async () => {
    await withWorld(async (world) => {
      world.write(lines(meta({ subagent_history_start_ordinal: 0, history_mode: "paginated" })));
      await world.ingest();
      world.exec("INSERT INTO session_ingest_log(session_id, message_count) VALUES('child-thread', 99)");
      world.write(forked(message(2, "user", "own 1"), message(3, "assistant", "own 2")));
      expect((await world.ingest()).body).toMatchObject({ ingested: 2 });
      expect(world.messages()).toEqual(["own 1", "own 2"]);
      expect(world.links()).toEqual(["own 1", "own 2"]);
    });
  });

  it("treats a conversation holding only an event row as an empty child", async () => {
    await withWorld(async (world) => {
      world.write(lines(meta({ subagent_history_start_ordinal: 0, history_mode: "paginated" })));
      await world.ingest();
      world.exec("INSERT INTO conversations(session_id) VALUES('child-thread')");
      world.exec(legacyEvent(newestConversation, 0));
      expect((await world.ingest()).body).toEqual({ ingested: 0, totalTokens: 0 });
      expect(world.messages()).toEqual([EVENT]);
      expect(logs.error).not.toHaveBeenCalled();
    });
  });

  it("does not create a conversation for an empty child", async () => {
    await withWorld(async (world) => {
      world.write(lines(meta({ parent_thread_id: "parent-thread", subagent_history_start_ordinal: 0, history_mode: "paginated" })));
      expect((await world.ingest()).body).toEqual({ ingested: 0, totalTokens: 0 });
      expect(world.parent()).toBeUndefined();
      expect(world.messages()).toEqual([]);
      expect(logs.error).not.toHaveBeenCalled();
    });
  });
});
