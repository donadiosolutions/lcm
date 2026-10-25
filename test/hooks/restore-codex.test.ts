import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSessionStart, sessionLockPathForTesting } from "../../src/hooks/restore.js";
import { LCM_RESTORATION_MARKER } from "../../src/codex-transcript.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({ ensureDaemon: vi.fn() }));
vi.mock("../../src/db/events-path.js", () => ({ eventsDbPath: vi.fn().mockReturnValue("/tmp/test-events.db") }));
vi.mock("../../src/hooks/session-end.js", () => ({ firePromoteEventsRequest: vi.fn() }));

import { ensureDaemon } from "../../src/daemon/lifecycle.js";

const mockEnsureDaemon = vi.mocked(ensureDaemon);
const OUTPUT = "<memory-orientation>\nMemory active\n</memory-orientation>";
const MARKED_OUTPUT = `${LCM_RESTORATION_MARKER}\n${OUTPUT}`;

function developer(text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "developer", content: [{ type: "input_text", text }] },
  });
}

const block = developer(MARKED_OUTPUT);
const compacted = JSON.stringify({ type: "compacted", payload: { message: "", replacement_history: [] } });
const rolledBack = JSON.stringify({ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } });

describe("handleSessionStart for Codex", () => {
  let codexHome: string;
  let rollout: string;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousClient = process.env.LCM_CLIENT;
  let sessionId: string;
  let counter = 0;

  function writeRollout(lines: string[]): void {
    writeFileSync(rollout, `${lines.join("\n")}\n`);
  }

  async function start(
    overrides: Record<string, unknown> = {},
    context = OUTPUT,
  ): Promise<{ exitCode: number; stdout: string }> {
    return handleSessionStart(
      JSON.stringify({
        session_id: sessionId,
        cwd: "/proj",
        client: "codex",
        transcript_path: rollout,
        ...overrides,
      }),
      { post: vi.fn().mockResolvedValue({ context }) },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    codexHome = mkdtempSync(join(tmpdir(), "lcm-restore-codex-"));
    const directory = join(codexHome, "sessions", "2026", "01", "01");
    mkdirSync(directory, { recursive: true });
    rollout = join(directory, "rollout-t.jsonl");
    process.env.CODEX_HOME = codexHome;
    delete process.env.LCM_CLIENT;
    sessionId = `codex-restore-${counter++}`;
  });

  afterEach(() => {
    rmSync(sessionLockPathForTesting(sessionId), { force: true });
    rmSync(codexHome, { recursive: true, force: true });
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousClient === undefined) delete process.env.LCM_CLIENT;
    else process.env.LCM_CLIENT = previousClient;
  });

  it.each(["startup", "clear", "unknown", undefined])(
    "prints source %s with the restoration marker even when a live block exists",
    async (source) => {
      writeRollout([block]);
      await expect(start(source === undefined ? {} : { source })).resolves.toEqual({
        exitCode: 0,
        stdout: MARKED_OUTPUT,
      });
    },
  );

  it("leaves empty output empty", async () => {
    writeRollout([]);
    await expect(start({ source: "startup" }, "")).resolves.toEqual({ exitCode: 0, stdout: "" });
    await expect(start({ source: "resume" }, "")).resolves.toEqual({ exitCode: 0, stdout: "" });
  });

  it.each(["resume", "fork", "compact"])("skips %s when the rollout holds a live restoration", async (source) => {
    writeRollout([block]);
    await expect(start({ source })).resolves.toEqual({ exitCode: 0, stdout: "" });
  });

  it.each(["resume", "fork", "compact"])("prints %s with the marker when there is no live restoration", async (source) => {
    writeRollout([developer(`quoted ${LCM_RESTORATION_MARKER}`)]);
    await expect(start({ source })).resolves.toEqual({ exitCode: 0, stdout: MARKED_OUTPUT });
    writeRollout([block, compacted]);
    await expect(start({ source })).resolves.toEqual({ exitCode: 0, stdout: MARKED_OUTPUT });
    writeRollout([block, rolledBack]);
    await expect(start({ source })).resolves.toEqual({ exitCode: 0, stdout: MARKED_OUTPUT });
  });

  describe("referenced (paginated-history) forks", () => {
    const parentId = "01980000-0000-7000-8000-000000000001";
    let parentOffsets: number[];

    function ordered(ordinal: number, item: Record<string, unknown>): string {
      return JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", ordinal, ...item });
    }

    function writeParent(items: Array<Record<string, unknown>>): void {
      let content = "";
      parentOffsets = [];
      items.forEach((item, index) => {
        content += `${ordered(index, item)}\n`;
        parentOffsets.push(Buffer.byteLength(content));
      });
      writeFileSync(join(codexHome, "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${parentId}.jsonl`), content);
    }

    /** The fork's rollout: a session_meta referencing the first count parent records, then its own. */
    function writeFork(count: number, own: Array<Record<string, unknown>> = []): void {
      const meta = {
        type: "session_meta",
        payload: {
          id: "01980000-0000-7000-8000-000000000002",
          forked_from_id: parentId,
          forked_from_ordinal_exclusive: count,
          history_mode: "paginated",
          history_base: { thread_id: parentId, end_ordinal_exclusive: count, end_byte_offset: parentOffsets[count - 1] },
        },
      };
      writeRollout([meta, ...own].map((item, index) => ordered(count + index, item)));
    }

    const meta = { type: "session_meta", payload: { id: parentId, history_mode: "paginated" } };
    const parentBlock = JSON.parse(block) as Record<string, unknown>;
    const filler = JSON.parse(developer("filler")) as Record<string, unknown>;

    it.each(["fork", "resume"])("skips %s when the parent history the fork references holds a live restoration", async (source) => {
      writeParent([meta, parentBlock, filler]);
      writeFork(3, [filler]);
      await expect(start({ source })).resolves.toEqual({ exitCode: 0, stdout: "" });
    });

    it("prints a fork whose referenced history holds no live restoration", async () => {
      writeParent([meta, filler, parentBlock]);
      writeFork(2, [filler]);
      await expect(start({ source: "fork" })).resolves.toEqual({ exitCode: 0, stdout: MARKED_OUTPUT });
      writeParent([meta, parentBlock, JSON.parse(compacted) as Record<string, unknown>]);
      writeFork(3);
      await expect(start({ source: "fork" })).resolves.toEqual({ exitCode: 0, stdout: MARKED_OUTPUT });
      writeParent([meta, parentBlock]);
      writeFork(2, [JSON.parse(rolledBack) as Record<string, unknown>]);
      await expect(start({ source: "fork" })).resolves.toEqual({ exitCode: 0, stdout: MARKED_OUTPUT });
    });

    it("prints a fork whose referenced parent is missing", async () => {
      writeParent([meta, parentBlock]);
      writeFork(2, [filler]);
      rmSync(join(codexHome, "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${parentId}.jsonl`));
      await expect(start({ source: "fork" })).resolves.toEqual({ exitCode: 0, stdout: MARKED_OUTPUT });
    });

    it("prints a startup session even when the referenced history holds a restoration", async () => {
      writeParent([meta, parentBlock]);
      writeFork(2);
      await expect(start({ source: "startup" })).resolves.toEqual({ exitCode: 0, stdout: MARKED_OUTPUT });
    });
  });


  it("prints a resume when the transcript path is unusable", async () => {
    const outsideDirectory = mkdtempSync(join(tmpdir(), "lcm-restore-outside-"));
    const outside = join(outsideDirectory, "rollout-o.jsonl");
    writeFileSync(outside, block);
    const link = join(codexHome, "sessions", "link.jsonl");
    symlinkSync(outside, link);
    const innerLink = join(codexHome, "sessions", "inner-link.jsonl");
    writeRollout([block]);
    symlinkSync(rollout, innerLink);
    try {
      for (const transcript_path of [null, undefined, "", join(codexHome, "missing.jsonl"), outside, link, innerLink, join(codexHome, "sessions")]) {
        await expect(start({ source: "resume", transcript_path })).resolves.toEqual({
          exitCode: 0,
          stdout: MARKED_OUTPUT,
        });
      }
      writeRollout([block, "{broken"]);
      await expect(start({ source: "resume" })).resolves.toEqual({ exitCode: 0, stdout: MARKED_OUTPUT });
    } finally {
      rmSync(outsideDirectory, { recursive: true, force: true });
    }
  });

  it("follows [resume, compact] and [compact, compact] drains through the rollout", async () => {
    // Pre-drain compaction dropped the old block: resume prints and its block is recorded.
    writeRollout([block, compacted]);
    await expect(start({ source: "resume" })).resolves.toEqual({ exitCode: 0, stdout: MARKED_OUTPUT });
    writeRollout([block, compacted, block]);
    await expect(start({ source: "compact" })).resolves.toEqual({ exitCode: 0, stdout: "" });

    // Two compactions in one drain: the first prints, the second sees its block.
    writeRollout([compacted, compacted]);
    await expect(start({ source: "compact" })).resolves.toEqual({ exitCode: 0, stdout: MARKED_OUTPUT });
    writeRollout([compacted, compacted, block]);
    await expect(start({ source: "compact" })).resolves.toEqual({ exitCode: 0, stdout: "" });
  });

  it("prints in the same drain when the first hook of a pair printed nothing", async () => {
    writeRollout([block, compacted]);
    await expect(start({ source: "resume" }, "")).resolves.toEqual({ exitCode: 0, stdout: "" });
    await expect(start({ source: "compact" })).resolves.toEqual({ exitCode: 0, stdout: MARKED_OUTPUT });
  });

  it("treats a garbage line as a reset and skips the next resume once a block is recorded", async () => {
    writeRollout(["{garbage", block]);
    await expect(start({ source: "resume" })).resolves.toEqual({ exitCode: 0, stdout: "" });
    writeRollout([block, "{garbage"]);
    await expect(start({ source: "resume" })).resolves.toEqual({ exitCode: 0, stdout: MARKED_OUTPUT });
    writeRollout([block, "{garbage", block]);
    await expect(start({ source: "resume" })).resolves.toEqual({ exitCode: 0, stdout: "" });
  });

  it("resolves the client from LCM_CLIENT when the payload names none", async () => {
    writeRollout([block]);
    process.env.LCM_CLIENT = "codex";
    await expect(start({ client: undefined, source: "resume" })).resolves.toEqual({ exitCode: 0, stdout: "" });
    await expect(start({ client: undefined, source: "startup" })).resolves.toEqual({
      exitCode: 0,
      stdout: MARKED_OUTPUT,
    });
  });

  it("does not mark or read the transcript for Claude", async () => {
    writeRollout([block]);
    process.env.CODEX_HOME = join(codexHome, "does-not-exist");
    for (const source of ["startup", "resume", "compact"]) {
      await expect(start({ client: "claude", source })).resolves.toEqual({ exitCode: 0, stdout: OUTPUT });
    }
    await expect(start({ client: undefined, source: "resume" })).resolves.toEqual({ exitCode: 0, stdout: OUTPUT });
  });

  it("still contacts the daemon and releases the lock when a Codex resume is skipped", async () => {
    writeRollout([block]);
    const post = vi.fn().mockResolvedValue({ context: OUTPUT });
    const stdin = JSON.stringify({ session_id: sessionId, cwd: "/proj", client: "codex", source: "resume", transcript_path: rollout });
    await expect(handleSessionStart(stdin, { post })).resolves.toEqual({ exitCode: 0, stdout: "" });
    expect(post).toHaveBeenCalledTimes(1);
    await expect(start({ source: "startup" })).resolves.toEqual({ exitCode: 0, stdout: MARKED_OUTPUT });
  });
});
