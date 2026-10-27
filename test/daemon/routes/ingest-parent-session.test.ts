import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { createStorageBackendFactory } from "../../../src/storage/index.js";
import { createIngestHandler } from "../../../src/daemon/routes/ingest.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { closeLcmConnection, getLcmConnection } from "../../../src/db/connection.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";

vi.mock("../../../src/hooks/hook-errors.js", () => ({ safeLogError: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

type Role = "user" | "assistant";
const message = (ordinal: number | undefined, role: Role, text: string): string => JSON.stringify({
  type: "response_item",
  ...(ordinal === undefined ? {} : { ordinal }),
  payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
});
const meta = (payload: Record<string, unknown>): string => JSON.stringify({
  type: "session_meta", payload: { id: "child-thread", cwd: "/work", ...payload },
});
const lines = (...records: string[]): string => records.map((record) => record + "\n").join("");

async function withWorld(
  run: (world: {
    ingest(transcript: string, extra?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
    seed(sessionId: string, ...contents: string[]): Promise<void>;
    exec(sql: string): void;
    parents(): Array<{ session_id: string; parent_session_id: string | null }>;
    messages(): string[];
  }) => Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "parent-session-"));
  const source = join(cwd, "child.jsonl");
  const config = loadDaemonConfig(join(cwd, "nonexistent"), {});
  const factory = await createStorageBackendFactory(config.storage);
  const handler = createIngestHandler(config, factory);
  const call = async (payload: Record<string, unknown>) => {
    let status = 0;
    let body = "";
    const res = { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; } };
    await handler({} as never, res as never, JSON.stringify({ cwd, client: "codex", session_id: "child-thread", ...payload }));
    return { status, body: JSON.parse(body) as Record<string, unknown> };
  };
  const db = <T>(use: (connection: ReturnType<typeof getLcmConnection>) => T): T => {
    const dbPath = projectDbPath(cwd);
    const connection = getLcmConnection(dbPath);
    try { return use(connection); } finally { closeLcmConnection(dbPath); }
  };
  try {
    await run({
      ingest: (transcript, extra = {}) => {
        writeFileSync(source, transcript, { mode: 0o600 });
        return call({ transcript_path: source, ...extra });
      },
      seed: async (sessionId, ...contents) => {
        const result = await call({
          session_id: sessionId,
          messages: contents.map((content) => ({ role: "user", content, tokenCount: 1 })),
        });
        expect(result.status).toBe(200);
      },
      exec: (sql) => db((connection) => { connection.exec(sql); }),
      parents: () => db((connection) => connection
        .prepare("SELECT session_id, parent_session_id FROM conversations ORDER BY conversation_id").all() as never),
      messages: () => db((connection) => (connection
        .prepare("SELECT content FROM messages ORDER BY conversation_id, seq").all() as Array<{ content: string }>)
        .map((row) => row.content)),
    });
  } finally {
    await factory.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

const child = (parent: unknown = "parent-thread", extra: Record<string, unknown> = {}): string => lines(
  meta({ parent_thread_id: parent, ...extra }),
  message(extra.subagent_history_start_ordinal === undefined ? undefined : 2, "user", "child task"),
);

describe("Codex child parent linkage on ingest", () => {
  it("records the immediate parent of a child with no inherited-history ordinal", async () => {
    await withWorld(async (world) => {
      expect((await world.ingest(child())).body).toMatchObject({ ingested: 1 });
      expect(world.parents()).toEqual([{ session_id: "child-thread", parent_session_id: "parent-thread" }]);
    });
  });

  it("records the parent of a forked child that carries a history boundary", async () => {
    await withWorld(async (world) => {
      await world.ingest(lines(
        meta({ parent_thread_id: "parent-thread", subagent_history_start_ordinal: 2, history_mode: "paginated" }),
        message(0, "user", "inherited"),
        message(2, "user", "child task"),
      ));
      expect(world.messages()).toEqual(["child task"]);
      expect(world.parents()).toEqual([{ session_id: "child-thread", parent_session_id: "parent-thread" }]);
    });
  });

  it("keeps the first parent across repeats and ignores a conflicting later value", async () => {
    await withWorld(async (world) => {
      await world.ingest(child("parent-thread"));
      await world.ingest(child("parent-thread"));
      await world.ingest(child("other-parent"));
      expect(world.parents()).toEqual([{ session_id: "child-thread", parent_session_id: "parent-thread" }]);
    });
  });

  it.each([
    ["a rollout whose id is not the request session", child("parent-thread").replace("child-thread", "someone-else")],
    ["a parent equal to the child", child("child-thread")],
    ["an empty parent", child("")],
    ["a parent containing NUL", child("bad\u0000parent")],
    ["a non-string parent", child(7)],
    ["a root rollout", lines(meta({}), message(undefined, "user", "child task"))],
    ["a first record that is not session_meta", lines(message(undefined, "user", "child task"), meta({ parent_thread_id: "p" }))],
  ])("leaves the column null for %s", async (_name, transcript) => {
    await withWorld(async (world) => {
      expect((await world.ingest(transcript)).status).toBe(200);
      expect(world.parents().map((row) => row.parent_session_id)).toEqual([null]);
    });
  });

  it("does not record a parent for a non-Codex client", async () => {
    await withWorld(async (world) => {
      await world.seed("child-thread", "existing");
      expect((await world.ingest(child(), { client: "claude" })).status).toBe(200);
      expect(world.parents().map((row) => row.parent_session_id)).toEqual([null]);
    });
  });

  it("never fills from a messages-array ingest", async () => {
    await withWorld(async (world) => {
      await world.seed("child-thread", "existing");
      expect(world.parents().map((row) => row.parent_session_id)).toEqual([null]);
    });
  });

  it("fills an existing row when nothing new is appended", async () => {
    await withWorld(async (world) => {
      await world.seed("child-thread", "child task");
      expect((await world.ingest(child())).body).toEqual({ ingested: 0, totalTokens: 0 });
      expect(world.parents()).toEqual([{ session_id: "child-thread", parent_session_id: "parent-thread" }]);
    });
  });

  it("fills an existing row when the rollout has no messages and creates none otherwise", async () => {
    await withWorld(async (world) => {
      await world.ingest(lines(meta({ parent_thread_id: "parent-thread" })));
      expect(world.parents()).toEqual([]);
      await world.seed("child-thread", "child task");
      await world.ingest(lines(meta({ parent_thread_id: "parent-thread" })));
      expect(world.parents()).toEqual([{ session_id: "child-thread", parent_session_id: "parent-thread" }]);
    });
  });

  it("fills an existing row when the session-ingest guard returns early", async () => {
    await withWorld(async (world) => {
      await world.seed("child-thread", "child task");
      world.exec("INSERT INTO session_ingest_log(session_id, message_count) VALUES('child-thread', 5)");
      await world.ingest(child());
      expect(world.parents()).toEqual([{ session_id: "child-thread", parent_session_id: "parent-thread" }]);
    });
  });

  it("fills an existing row when the stored history matches neither reading", async () => {
    await withWorld(async (world) => {
      await world.seed("child-thread", "unrelated stored text");
      await world.ingest(lines(
        meta({ parent_thread_id: "parent-thread", subagent_history_start_ordinal: 1, history_mode: "paginated" }),
        message(0, "user", "inherited"),
        message(1, "user", "child task"),
      ));
      expect(world.messages()).toEqual(["unrelated stored text"]);
      expect(world.parents()).toEqual([{ session_id: "child-thread", parent_session_id: "parent-thread" }]);
    });
  });

  it("records the immediate parent of a grandchild, not the tree root", async () => {
    await withWorld(async (world) => {
      await world.ingest(
        lines(meta({ id: "grandchild-thread", parent_thread_id: "child-thread" }), message(undefined, "user", "task")),
        { session_id: "grandchild-thread" },
      );
      expect(world.parents()).toEqual([{ session_id: "grandchild-thread", parent_session_id: "child-thread" }]);
    });
  });

  it("aborts the whole persist transaction when the setter genuinely fails", async () => {
    await withWorld(async (world) => {
      vi.spyOn(ConversationStore.prototype, "setParentSessionIdIfNull").mockRejectedValue(new Error("disk full"));
      expect((await world.ingest(child())).status).toBe(500);
      expect(world.parents()).toEqual([]);
      expect(world.messages()).toEqual([]);
    });
  });
});

