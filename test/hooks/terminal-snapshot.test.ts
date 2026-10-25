import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalDeadline, type TerminalDeadline } from "../../src/cli/terminal-deadline.js";
import { TERMINAL_STDIN_MAX_BYTES } from "../../src/cli/terminal-stdin.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";
import {
  handleTerminalSnapshot,
  reportTerminalOutcome,
  runTerminalSnapshotCommand,
  type TerminalSnapshotDeps,
} from "../../src/hooks/terminal-snapshot.js";

const SILENT = { exitCode: 0, stdout: "" };

describe("Codex terminal snapshot handler", () => {
  let dir: string;
  let transcript: string;
  let elapsed: number;
  let deadline: TerminalDeadline;
  let verify: ReturnType<typeof vi.fn>;
  let fence: ReturnType<typeof vi.fn>;
  let post: ReturnType<typeof vi.fn>;
  let logError: ReturnType<typeof vi.fn>;

  const deps = (): TerminalSnapshotDeps => ({
    verify: verify as unknown as TerminalSnapshotDeps["verify"],
    assertPublicationFence: fence as unknown as TerminalSnapshotDeps["assertPublicationFence"],
    post: post as unknown as TerminalSnapshotDeps["post"],
    logError: logError as unknown as TerminalSnapshotDeps["logError"],
  });
  const payload = (extra: Record<string, unknown> = {}): string => JSON.stringify({
    hook_event_name: "SessionEnd",
    session_id: "s1",
    cwd: dir,
    transcript_path: transcript,
    reason: "other",
    ...extra,
  });
  const run = (stdin: string) => handleTerminalSnapshot(stdin, { deadline }, deps());
  const loggedReasons = (): string[] => logError.mock.calls.map((call) => (call[1] as Error).message);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "terminal-snapshot-"));
    transcript = join(dir, "rollout.jsonl");
    writeFileSync(transcript, "{}\n");
    elapsed = 100;
    deadline = createTerminalDeadline({ elapsedMs: () => elapsed });
    verify = vi.fn(async () => ({ port: 4321, token: "tok" }));
    fence = vi.fn();
    post = vi.fn(async () => ({ statusCode: 202 }));
    logError = vi.fn(async () => undefined);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("hands the snapshot to the verified daemon and stays silent when it is accepted", async () => {
    await expect(run(payload())).resolves.toEqual(SILENT);

    expect(verify).toHaveBeenCalledOnce();
    expect(verify.mock.calls[0]![0]).toMatchObject({ budgetMs: 400 });
    expect(fence).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]![0]).toEqual({ port: 4321, token: "tok" });
    expect(post.mock.calls[0]![1]).toEqual({
      session_id: "s1",
      cwd: dir,
      transcript_path: transcript,
      client: "codex",
      event: "SessionEnd",
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it("reports the Interrupt event and ignores unknown payload fields such as a future reason", async () => {
    await run(payload({ hook_event_name: "Interrupt", reason: "something-new", turn_id: "t1" }));
    expect(post.mock.calls[0]![1]).toMatchObject({ event: "Interrupt" });
  });

  it("uses a fixed event name when the payload names none that is allowed", async () => {
    post.mockResolvedValue({ statusCode: 500 });
    await run(payload({ hook_event_name: "Stop\nforged" }));
    expect(post.mock.calls[0]![1]).toMatchObject({ event: "TerminalSnapshot" });
    expect(logError.mock.calls[0]![0]).toBe("TerminalSnapshot");
  });

  it.each([
    ["malformed JSON", "{"],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["a missing session", JSON.stringify({ cwd: "/x", transcript_path: "/y" })],
    ["an empty session", JSON.stringify({ session_id: "", cwd: "/x", transcript_path: "/y" })],
    ["a missing cwd", JSON.stringify({ session_id: "s", transcript_path: "/y" })],
    ["an empty cwd", JSON.stringify({ session_id: "s", cwd: "", transcript_path: "/y" })],
  ])("logs invalid-input for %s and contacts nothing", async (_name, stdin) => {
    await expect(run(stdin)).resolves.toEqual(SILENT);
    expect(loggedReasons()).toEqual(["invalid-input"]);
    expect(verify).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("logs the diagnostic without a working directory so no project database is touched", async () => {
    await run("{");
    expect(logError).toHaveBeenCalledWith("TerminalSnapshot", expect.any(Error), {});
  });

  it("logs transcript-unavailable for a null, missing, linked or non-file transcript", async () => {
    const link = join(dir, "link.jsonl");
    symlinkSync(transcript, link);
    const directory = join(dir, "folder");
    mkdirSync(directory);
    for (const path of [null, join(dir, "missing.jsonl"), link, directory]) {
      await run(payload({ transcript_path: path }));
    }
    expect(loggedReasons()).toEqual(Array(4).fill("transcript-unavailable"));
    expect(verify).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("logs daemon-unavailable without any bootstrap fallback when no daemon verifies", async () => {
    verify.mockResolvedValue(null);
    await expect(run(payload())).resolves.toEqual(SILENT);
    expect(loggedReasons()).toEqual(["daemon-unavailable"]);
    expect(fence).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("logs ingest-failed when verification itself throws", async () => {
    verify.mockRejectedValue(new Error("boom"));
    await run(payload());
    expect(loggedReasons()).toEqual(["ingest-failed"]);
    expect(post).not.toHaveBeenCalled();
  });

  it("logs deadline-exhausted without verifying once the work cutoff has passed", async () => {
    elapsed = 1400;
    await run(payload());
    expect(loggedReasons()).toEqual(["deadline-exhausted"]);
    expect(verify).not.toHaveBeenCalled();
  });

  it("logs deadline-exhausted without posting when verification used the whole work window", async () => {
    verify.mockImplementation(async () => {
      elapsed = 1400;
      return { port: 4321, token: "tok" };
    });
    await run(payload());
    expect(loggedReasons()).toEqual(["deadline-exhausted"]);
    expect(post).not.toHaveBeenCalled();
  });

  it("logs publication-refused and does not post when the publication fence refuses", async () => {
    fence.mockImplementation(() => { throw new Error("blocked"); });
    await expect(run(payload())).resolves.toEqual(SILENT);
    expect(loggedReasons()).toEqual(["publication-refused"]);
    expect(post).not.toHaveBeenCalled();
  });

  describe("when another process holds the publication lock", () => {
    const liveContention = (): PrivateMutationLockContentionError => new PrivateMutationLockContentionError(
      "publication lock is busy",
      {
        contendedLock: {
          path: "/lcm/publication.lock",
          owner: { version: 1, pid: process.pid + 1, processStartTime: null, nonce: "owner" },
        },
      },
    );

    it("posts once the owner releases the lock within the post phase", async () => {
      fence
        .mockImplementationOnce(() => { throw liveContention(); })
        .mockImplementationOnce(() => { throw liveContention(); });
      await expect(run(payload())).resolves.toEqual(SILENT);
      expect(fence).toHaveBeenCalledTimes(3);
      expect(post).toHaveBeenCalledOnce();
      expect(logError).not.toHaveBeenCalled();
    });

    it("logs publication-refused when the owner outlasts the share of the post phase set aside for waiting", async () => {
      // 100 ms of post budget leave 50 ms of waiting: one pause, then the refusal.
      elapsed = 1250;
      fence.mockImplementation(() => { throw liveContention(); });
      await expect(run(payload())).resolves.toEqual(SILENT);
      expect(fence).toHaveBeenCalledTimes(2);
      expect(loggedReasons()).toEqual(["publication-refused"]);
      expect(post).not.toHaveBeenCalled();
    });

    it("does not wait for contention without a live owner", async () => {
      fence.mockImplementation(() => { throw new PrivateMutationLockContentionError("ambiguous owner"); });
      await run(payload());
      expect(fence).toHaveBeenCalledOnce();
      expect(loggedReasons()).toEqual(["publication-refused"]);
    });
  });

  it.each([400, 401, 500, 503, 200, 204])("logs ingest-failed for HTTP %i", async (statusCode) => {
    post.mockResolvedValue({ statusCode });
    await run(payload());
    expect(loggedReasons()).toEqual(["ingest-failed"]);
  });

  it.each(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"])(
    "logs daemon-unavailable when the daemon is unreachable (%s)",
    async (code) => {
      post.mockRejectedValue(Object.assign(new Error("x"), { code }));
      await run(payload());
      expect(loggedReasons()).toEqual(["daemon-unavailable"]);
    },
  );

  it.each([
    ["a timeout", Object.assign(new Error("x"), { code: "ETIMEDOUT" })],
    ["a reset", Object.assign(new Error("x"), { code: "ECONNRESET" })],
    ["an abort", Object.assign(new Error("x"), { name: "AbortError" })],
    ["a rejection without an error object", null],
  ])("logs unconfirmed after %s because the request may have been received", async (_name, error) => {
    post.mockRejectedValue(error);
    await run(payload());
    expect(loggedReasons()).toEqual(["unconfirmed"]);
  });

  it("aborts a POST that outlives the work window", async () => {
    post.mockImplementation((_endpoint, _body, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    elapsed = 1349;
    await run(payload());
    expect(loggedReasons()).toEqual(["unconfirmed"]);
  });

  it("keeps an acknowledged request accepted when a later local step fails", async () => {
    let phases = 0;
    const failing: TerminalDeadline = {
      outcomeBudgetMs: () => 100,
      openPhase: (phase) => {
        const scope = deadline.openPhase(phase);
        phases += 1;
        return phase === "post"
          ? { ...scope, dispose: () => { scope.dispose(); throw new Error("late failure"); } }
          : scope;
      },
    };
    await expect(handleTerminalSnapshot(payload(), { deadline: failing }, deps())).resolves.toEqual(SILENT);
    expect(phases).toBe(2);
    expect(post).toHaveBeenCalledOnce();
    expect(logError).not.toHaveBeenCalled();
  });

  it("never lets a failing or slow diagnostic escape or outlast the outcome reserve", async () => {
    verify.mockResolvedValue(null);
    logError.mockRejectedValueOnce(new Error("log failed"));
    await expect(run(payload())).resolves.toEqual(SILENT);

    logError.mockImplementationOnce(() => new Promise(() => undefined));
    const slow: TerminalDeadline = { ...deadline, outcomeBudgetMs: () => 5 };
    const started = Date.now();
    await expect(handleTerminalSnapshot(payload(), { deadline: slow }, deps())).resolves.toEqual(SILENT);
    expect(Date.now() - started).toBeLessThan(1000);

    logError.mockImplementationOnce(() => { throw new Error("sync failure"); });
    await expect(run(payload())).resolves.toEqual(SILENT);
  });

  it("does not log an accepted outcome", async () => {
    await reportTerminalOutcome("accepted", "SessionEnd", deadline, logError as unknown as TerminalSnapshotDeps["logError"]);
    expect(logError).not.toHaveBeenCalled();
  });
});

describe("Codex terminal snapshot defaults", () => {
  let dir: string;
  let transcript: string;
  let server: Server | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "terminal-snapshot-default-"));
    transcript = join(dir, "rollout.jsonl");
    writeFileSync(transcript, "{}\n");
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const listen = async (status: number, seen: unknown[]): Promise<number> => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  };

  it("posts to /ingest/terminal with the bearer token and reads 202 as accepted", async () => {
    const seen: unknown[] = [];
    const port = await listen(202, seen);
    const logError = vi.fn(async () => undefined);
    await handleTerminalSnapshot(
      JSON.stringify({ hook_event_name: "Interrupt", session_id: "s", cwd: dir, transcript_path: transcript }),
      { deadline: createTerminalDeadline() },
      {
        verify: async () => ({ port, token: "secret" }),
        assertPublicationFence: () => undefined,
        logError,
      },
    );
    expect(seen).toEqual([{
      url: "/ingest/terminal",
      auth: "Bearer secret",
      body: { session_id: "s", cwd: dir, transcript_path: transcript, client: "codex", event: "Interrupt" },
    }]);
    expect(logError).not.toHaveBeenCalled();
  });

  it("classifies a real unexpected status and a real refused connection", async () => {
    const seen: unknown[] = [];
    const port = await listen(200, seen);
    const logError = vi.fn(async () => undefined);
    const input = JSON.stringify({ session_id: "s", cwd: dir, transcript_path: transcript });
    const base = { assertPublicationFence: () => undefined, logError };
    await handleTerminalSnapshot(input, { deadline: createTerminalDeadline() }, { ...base, verify: async () => ({ port, token: "t" }) });
    // A port nothing listens on, never used by an earlier keep-alive connection.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await handleTerminalSnapshot(input, { deadline: createTerminalDeadline() }, { ...base, verify: async () => ({ port: closedPort, token: "t" }) });
    expect(logError.mock.calls.map((call) => (call[1] as Error).message)).toEqual(["ingest-failed", "daemon-unavailable"]);
  });

  it("refuses without a configured daemon using the real read-only verifier and logger", async () => {
    // The test home has no config.json, so nothing verifies and nothing is created.
    await expect(handleTerminalSnapshot(
      JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s", cwd: dir, transcript_path: transcript }),
      { deadline: createTerminalDeadline() },
    )).resolves.toEqual(SILENT);
  });
});

describe("lcm session-snapshot --terminal entry", () => {
  const input = () => Object.assign(new EventEmitter(), { destroy: vi.fn() });
  let logError: ReturnType<typeof vi.fn>;
  let dispatch: ReturnType<typeof vi.fn>;
  let deadline: TerminalDeadline;
  beforeEach(() => {
    logError = vi.fn(async () => undefined);
    dispatch = vi.fn(async () => SILENT);
    deadline = createTerminalDeadline({ elapsedMs: () => 100 });
  });
  const command = (stdin: ReturnType<typeof input>, env: NodeJS.ProcessEnv = {}) => runTerminalSnapshotCommand({
    env,
    deadline,
    input: stdin,
    dispatch: dispatch as never,
    logError: logError as never,
  });

  it("does nothing, not even reading stdin, when LCM_ENABLED is false", async () => {
    const stdin = input();
    await command(stdin, { LCM_ENABLED: "false" });
    expect(stdin.listenerCount("data")).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it("only an exact false disables it", async () => {
    const stdin = input();
    const done = command(stdin, { LCM_ENABLED: "0" });
    stdin.emit("data", Buffer.from("{}"));
    stdin.emit("end");
    await done;
    expect(dispatch).toHaveBeenCalledWith("{}", { deadline });
  });

  it("logs deadline-exhausted when stdin does not reach EOF in time", async () => {
    deadline = createTerminalDeadline({ elapsedMs: () => 1400 });
    await command(input());
    expect(logError).toHaveBeenCalledWith("TerminalSnapshot", expect.objectContaining({ message: "deadline-exhausted" }), {});
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("logs invalid-input for an oversize payload", async () => {
    const stdin = input();
    const done = command(stdin);
    stdin.emit("data", Buffer.alloc(TERMINAL_STDIN_MAX_BYTES + 1));
    await done;
    expect(logError).toHaveBeenCalledWith("TerminalSnapshot", expect.objectContaining({ message: "invalid-input" }), {});
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("never rejects when dispatch throws, and logs ingest-failed", async () => {
    dispatch.mockRejectedValue(new Error("boom"));
    const stdin = input();
    const done = command(stdin);
    stdin.emit("end");
    await expect(done).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith("TerminalSnapshot", expect.objectContaining({ message: "ingest-failed" }), {});
  });

  it("contains a failure while building its dependencies", async () => {
    // A failure while building the dependencies is contained and has nothing to log with.
    const failing = { get env(): NodeJS.ProcessEnv { throw new Error("construction failed"); } };
    await expect(runTerminalSnapshotCommand(failing as never)).resolves.toBeUndefined();
    expect(logError).not.toHaveBeenCalled();
  });

  it("dispatches through the real hook dispatcher by default", async () => {
    const stdin = input();
    const done = runTerminalSnapshotCommand({ env: {}, deadline, input: stdin, logError: logError as never });
    stdin.emit("data", Buffer.from("not json"));
    stdin.emit("end");
    await expect(done).resolves.toBeUndefined();
  });
});

