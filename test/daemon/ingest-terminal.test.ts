import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalIngestQueue,
  TERMINAL_INGEST_DEADLINE_MS,
  TERMINAL_INGEST_MAX_KEYS,
  type TerminalIngestOutcome,
  type TerminalIngestQueueOptions,
} from "../../src/daemon/routes/ingest-terminal.js";
import type { RouteExecutionContext, RouteHandler } from "../../src/daemon/server.js";
import { BackendPublicationJournalError } from "../../src/storage/backend-publication.js";

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

type FakeResponse = { status: number; body: string; writeHead: (code: number) => void; end: (data: string) => void };
function response(): FakeResponse {
  const res: FakeResponse = {
    status: 0,
    body: "",
    writeHead: (code) => { res.status = code; },
    end: (data) => { res.body = data; },
  };
  return res;
}

describe("terminal ingest queue", () => {
  let cwd: string;
  let transcripts: Record<string, string>;
  let calls: Array<{ body: Record<string, unknown>; context: RouteExecutionContext | undefined }>;
  let outcomes: TerminalIngestOutcome[];
  let drained: ReturnType<typeof vi.fn>;
  let shutdown: AbortController;
  let behavior: (call: number, res: FakeResponse, context: RouteExecutionContext | undefined) => Promise<void> | void;
  let publicationSignals: AbortSignal[];
  const behaviorDefault: typeof behavior = (_call, res) => { res.writeHead(200); res.end(JSON.stringify({ ingested: 0 })); };

  const ingest: RouteHandler = async (_req, res, body, context) => {
    calls.push({ body: JSON.parse(body), context });
    await behavior(calls.length, res as unknown as FakeResponse, context);
  };
  const make = (overrides: Partial<TerminalIngestQueueOptions> = {}) => createTerminalIngestQueue({
    ingest,
    publicationAdmission: (signal) => {
      publicationSignals.push(signal);
      return (async (operation: (token: never) => unknown) => operation(undefined as never)) as never;
    },
    shutdownSignal: shutdown.signal,
    onDrained: drained as unknown as () => void,
    report: (outcome) => { outcomes.push(outcome); },
    ...overrides,
  });
  const request = (extra: Record<string, unknown> = {}) => ({
    session_id: "s1",
    cwd,
    transcript_path: transcripts.a,
    client: "codex",
    ...extra,
  });
  const post = async (queue: ReturnType<typeof make>, body: unknown, res = response()): Promise<FakeResponse> => {
    await queue.handler({} as never, res as never, typeof body === "string" ? body : JSON.stringify(body));
    return res;
  };

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "terminal-queue-"));
    transcripts = {};
    for (const name of ["a", "b", "c"]) {
      transcripts[name] = join(cwd, `${name}.jsonl`);
      writeFileSync(transcripts[name]!, "{}\n");
    }
    calls = [];
    outcomes = [];
    drained = vi.fn();
    shutdown = new AbortController();
    publicationSignals = [];
    behavior = (_call, res) => { res.writeHead(200); res.end(JSON.stringify({ ingested: 1 })); };
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("answers 202 and ingests through the ordinary handler with an explicit body", async () => {
    const queue = make();
    const res = await post(queue, request({ event: "SessionEnd", messages: [{ ignored: true }] }));
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ accepted: true });
    await queue.drained();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      session_id: "s1",
      cwd,
      transcript_path: transcripts.a,
      client: "codex",
    });
    expect(calls[0]!.context?.signal).toBe(publicationSignals[0]);
    expect(outcomes).toEqual(["captured"]);
    expect(drained).toHaveBeenCalledOnce();
    expect(queue.busy()).toBe(false);
  });

  it("replies before the ingest finishes and keeps working after the client is gone", async () => {
    const release = gate();
    behavior = async (_call, res) => { await release.promise; res.writeHead(200); res.end(JSON.stringify({ ingested: 3 })); };
    const queue = make();
    const res = await post(queue, request());
    expect(res.status).toBe(202);
    expect(queue.busy()).toBe(true);
    expect(outcomes).toEqual([]);
    release.open();
    await queue.drained();
    expect(outcomes).toEqual(["captured"]);
  });

  it("reports what the ingest actually did", async () => {
    const replies: Array<[number, string]> = [
      [200, JSON.stringify({ ingested: 0 })],
      [200, JSON.stringify({ totalTokens: 1 })],
      [200, "not json"],
      [499, JSON.stringify({ status: "cancelled" })],
      [503, JSON.stringify({ status: "blocked" })],
      [500, JSON.stringify({ code: "INGEST_FAILED" })],
      [404, "{}"],
    ];
    behavior = (call, res) => { const [code, body] = replies[call - 1]!; res.writeHead(code); res.end(body); };
    const queue = make();
    for (let index = 0; index < replies.length; index += 1) {
      await post(queue, request());
      await queue.drained();
    }
    expect(outcomes).toEqual([
      "no-new-observations",
      "no-new-observations",
      "failed",
      "cancelled",
      "blocked",
      "failed",
      "failed",
    ]);
  });

  it("logs a thrown ingest as failed, a publication refusal as blocked, and keeps draining", async () => {
    behavior = (call, res) => {
      if (call === 1) throw new Error("boom");
      if (call === 2) throw new BackendPublicationJournalError("unexpected-state", "blocked");
      return behaviorDefault(call, res);
    };
    const queue = make();
    for (let index = 0; index < 3; index += 1) {
      await post(queue, request({ session_id: `s${index}` }));
    }
    await queue.drained();
    expect(outcomes).toEqual(["failed", "blocked", "no-new-observations"]);
  });

  it("coalesces requests that arrive during a run into one newest-tail re-run", async () => {
    const release = [gate(), gate(), gate()];
    behavior = async (call, res) => { await release[call - 1]!.promise; res.writeHead(200); res.end(JSON.stringify({ ingested: call })); };
    const queue = make();
    await post(queue, request());
    expect((await post(queue, request())).status).toBe(202);
    expect((await post(queue, request())).status).toBe(202);
    expect(calls).toHaveLength(1);
    release[0]!.open();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    // Arrivals during the re-run are consumed by the same owned drain.
    expect((await post(queue, request())).status).toBe(202);
    release[1]!.open();
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    release[2]!.open();
    await queue.drained();
    expect(calls).toHaveLength(3);
    expect(outcomes).toEqual(["captured", "captured", "captured"]);
    expect(drained).toHaveBeenCalledOnce();
  });

  it("refuses a different transcript for a key that already has one pending, but accepts the same one", async () => {
    const release = gate();
    behavior = async (call, res) => { if (call === 1) await release.promise; res.writeHead(200); res.end(JSON.stringify({ ingested: 1 })); };
    const queue = make();
    await post(queue, request());
    expect((await post(queue, request({ transcript_path: transcripts.b }))).status).toBe(202);
    const refused = await post(queue, request({ transcript_path: transcripts.c }));
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toEqual({ error: "terminal ingest queue is unavailable" });
    expect((await post(queue, request({ transcript_path: transcripts.b }))).status).toBe(202);
    release.open();
    await queue.drained();
    expect(calls.map((call) => call.body.transcript_path)).toEqual([transcripts.a, transcripts.b]);
  });

  it("accepts at most eight keys and releases capacity once they settle", async () => {
    const release = gate();
    behavior = async (call, res) => { if (call === 1) await release.promise; res.writeHead(200); res.end(JSON.stringify({ ingested: 1 })); };
    const queue = make();
    for (let index = 0; index < TERMINAL_INGEST_MAX_KEYS; index += 1) {
      expect((await post(queue, request({ session_id: `k${index}` }))).status).toBe(202);
    }
    // The running key still occupies capacity, and a known key is not a ninth.
    expect((await post(queue, request({ session_id: "k9" }))).status).toBe(503);
    expect((await post(queue, request({ session_id: "k0" }))).status).toBe(202);
    release.open();
    await queue.drained();
    expect(calls).toHaveLength(TERMINAL_INGEST_MAX_KEYS + 1);
    expect((await post(queue, request({ session_id: "k9" }))).status).toBe(202);
    await queue.drained();
  });

  it("honors a configured key limit", async () => {
    const release = gate();
    behavior = async (_call, res) => { await release.promise; res.writeHead(200); res.end(JSON.stringify({ ingested: 1 })); };
    const queue = make({ maxKeys: 1 });
    expect((await post(queue, request({ session_id: "one" }))).status).toBe(202);
    expect((await post(queue, request({ session_id: "two" }))).status).toBe(503);
    release.open();
    await queue.drained();
  });

  it("runs a key that arrived again during its run behind the other waiting keys", async () => {
    const release = gate();
    behavior = async (call, res) => { if (call === 1) await release.promise; res.writeHead(200); res.end(JSON.stringify({ ingested: 1 })); };
    const queue = make();
    await post(queue, request({ session_id: "first" }));
    await post(queue, request({ session_id: "second" }));
    await post(queue, request({ session_id: "first" }));
    release.open();
    await queue.drained();
    expect(calls.map((call) => call.body.session_id)).toEqual(["first", "second", "first"]);
  });

  it.each([
    ["malformed JSON", () => "{"],
    ["an array", () => "[]"],
    ["null", () => "null"],
    ["a missing session", (dir: string) => ({ cwd: dir, transcript_path: "x", client: "codex" })],
    ["an empty session", (dir: string) => ({ session_id: "", cwd: dir, transcript_path: "x", client: "codex" })],
    ["a non-string cwd", () => ({ session_id: "s", cwd: 1, transcript_path: "x", client: "codex" })],
    ["a missing transcript", (dir: string) => ({ session_id: "s", cwd: dir, client: "codex" })],
    ["another client", (dir: string) => ({ session_id: "s", cwd: dir, transcript_path: "x", client: "claude" })],
    ["a relative cwd", () => ({ session_id: "s", cwd: "relative", transcript_path: "x", client: "codex" })],
    ["a missing cwd directory", (dir: string) => ({ session_id: "s", cwd: join(dir, "absent"), transcript_path: "x", client: "codex" })],
    ["a transcript outside the allowed locations", (dir: string) => ({ session_id: "s", cwd: dir, transcript_path: "/etc/hostname", client: "codex" })],
    ["a transcript that does not exist", (dir: string) => ({ session_id: "s", cwd: dir, transcript_path: join(dir, "none.jsonl"), client: "codex" })],
  ])("answers 400 and enqueues nothing for %s", async (_name, body) => {
    const queue = make();
    const res = await post(queue, body(cwd));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid terminal ingest request" });
    expect(queue.busy()).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("refuses new work while the daemon is shutting down", async () => {
    const queue = make();
    shutdown.abort();
    const res = await post(queue, request());
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "daemon is shutting down" });
    expect(queue.busy()).toBe(false);
  });

  it("cancels the running ingest on shutdown and still settles every accepted request", async () => {
    behavior = async (_call, res, context) => {
      if (!context!.signal!.aborted) {
        await new Promise<void>((resolve) => context!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      }
      res.writeHead(499);
      res.end(JSON.stringify({ status: "cancelled" }));
    };
    const queue = make();
    await post(queue, request({ session_id: "one" }));
    await post(queue, request({ session_id: "two" }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    shutdown.abort();
    await queue.drained();
    expect(outcomes).toEqual(["cancelled", "cancelled"]);
    expect(queue.busy()).toBe(false);
  });

  it("gives each accepted request its own absolute deadline and retires one that expired in the queue", async () => {
    let clock = 0;
    const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    const release = gate();
    behavior = async (call, res, context) => {
      if (call === 1) {
        await release.promise;
        expect(context!.signal!.aborted).toBe(true);
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ingested: 1 }));
    };
    const queue = make({
      now: () => clock,
      setTimeout: ((callback: () => void, delay: number) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
      }) as unknown as typeof setTimeout,
      clearTimeout: ((timer: { cleared: boolean }) => { timer.cleared = true; }) as unknown as typeof clearTimeout,
    });
    await post(queue, request({ session_id: "slow" }));
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(timers[0]!.delay).toBe(TERMINAL_INGEST_DEADLINE_MS);
    await post(queue, request({ session_id: "late" }));
    clock = TERMINAL_INGEST_DEADLINE_MS;
    timers[0]!.callback();
    release.open();
    await queue.drained();
    expect(timers[0]!.cleared).toBe(true);
    expect(calls).toHaveLength(1);
    expect(outcomes).toEqual(["captured", "expired"]);
  });

  it("starts a replacement's deadline when the replacement was accepted", async () => {
    let clock = 0;
    const delays: number[] = [];
    const release = gate();
    behavior = async (call, res) => { if (call === 1) await release.promise; res.writeHead(200); res.end(JSON.stringify({ ingested: 1 })); };
    const queue = make({
      now: () => clock,
      setTimeout: ((_callback: () => void, delay: number) => { delays.push(delay); return 0; }) as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
    });
    await post(queue, request());
    clock = 20_000;
    await post(queue, request());
    clock = 40_000;
    await post(queue, request());
    release.open();
    await queue.drained();
    expect(delays).toEqual([TERMINAL_INGEST_DEADLINE_MS, TERMINAL_INGEST_DEADLINE_MS]);
  });

  it("keeps an accepted request when the 202 reply itself fails", async () => {
    const queue = make();
    const res = response();
    res.writeHead = () => { throw new Error("socket gone"); };
    await post(queue, request(), res);
    await queue.drained();
    expect(calls).toHaveLength(1);
  });

  it("is idle with nothing accepted", async () => {
    const queue = make();
    expect(queue.busy()).toBe(false);
    await expect(queue.drained()).resolves.toBeUndefined();
    expect(drained).not.toHaveBeenCalled();
  });

  it("logs only unsuccessful outcomes by default", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const queue = createTerminalIngestQueue({
        ingest,
        publicationAdmission: () => (async (operation: (token: never) => unknown) => operation(undefined as never)) as never,
        shutdownSignal: shutdown.signal,
        onDrained: () => undefined,
      });
      await post(queue, request());
      await queue.drained();
      expect(warn).not.toHaveBeenCalled();
      behavior = (_call, res) => { res.writeHead(500); res.end("{}"); };
      await post(queue, request());
      await queue.drained();
      expect(warn).toHaveBeenCalledWith("[lcm] terminal ingest failed");
    } finally {
      warn.mockRestore();
    }
  });

  describe("throwing observers", () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    beforeEach(() => { unhandled.length = 0; process.on("unhandledRejection", onUnhandled); });
    afterEach(() => { process.off("unhandledRejection", onUnhandled); });

    it("keeps draining and retires every entry when the reporter throws on results", async () => {
      const reported: TerminalIngestOutcome[] = [];
      const queue = make({ report: (outcome) => { reported.push(outcome); throw new Error("reporter failed"); } });
      behavior = (call) => { if (call === 1) throw new Error("ingest failed"); };
      await post(queue, request({ session_id: "one" }));
      await post(queue, request({ session_id: "two" }));
      await post(queue, request({ session_id: "three" }));
      await expect(queue.drained()).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls.map((call) => call.body.session_id)).toEqual(["one", "two", "three"]);
      expect(reported).toHaveLength(3);
      expect(queue.busy()).toBe(false);
      expect(drained).toHaveBeenCalledOnce();
      expect(unhandled).toEqual([]);
      expect((await post(queue, request({ session_id: "later" }))).status).toBe(202);
      await queue.drained();
      expect(calls).toHaveLength(4);
    });

    it("keeps draining and retires every entry when the reporter throws on expiry", async () => {
      const reported: TerminalIngestOutcome[] = [];
      const queue = make({ deadlineMs: 0, report: (outcome) => { reported.push(outcome); throw new Error("reporter failed"); } });
      await post(queue, request({ session_id: "one" }));
      await post(queue, request({ session_id: "two" }));
      await expect(queue.drained()).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reported).toEqual(["expired", "expired"]);
      expect(calls).toHaveLength(0);
      expect(queue.busy()).toBe(false);
      expect(unhandled).toEqual([]);
    });

    it("settles the owned drain when the drained callback throws", async () => {
      const queue = make({ onDrained: () => { throw new Error("idle timer failed"); } });
      await post(queue, request({ session_id: "one" }));
      await expect(queue.drained()).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(queue.busy()).toBe(false);
      expect(outcomes).toEqual(["captured"]);
      expect(unhandled).toEqual([]);
      expect((await post(queue, request({ session_id: "two" }))).status).toBe(202);
      await queue.drained();
      expect(outcomes).toEqual(["captured", "captured"]);
    });
  });
});
