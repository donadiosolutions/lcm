import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkActivationRestartAdmission } from "../../src/migration/activation-restart-check.js";

const roots: string[] = [];
const servers: Server[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function pidFileIn(root: string, content?: string): string {
  const path = join(root, "daemon.pid");
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lcm-activation-restart-check-"));
  roots.push(root);
  return root;
}

/** Listen on an ephemeral loopback port and return its number. */
async function listenEphemeral(handler: Parameters<typeof createServer>[0]): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP listener");
  return address.port;
}

/** Reserve a loopback port, then release it so nothing answers there. */
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP listener");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** An injected fetch whose rejection carries the ECONNREFUSED cause Node's
 * real fetch attaches when nothing listens on the port. */
function refusingFetch(): typeof globalThis.fetch {
  return (() => Promise.reject(
    Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }),
  )) as unknown as typeof globalThis.fetch;
}

/** Spawn a process that exits immediately, then return its now-dead pid. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  children.push(child);
  const pid = child.pid;
  if (pid === undefined) throw new Error("expected a spawned pid");
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  return pid;
}

describe("checkActivationRestartAdmission", () => {
  it("is satisfied with authoritative absence when no pid file names a daemon AND the daemon port refuses (R1 independent observation)", async () => {
    const root = newRoot();
    const result = await checkActivationRestartAdmission({
      selectedBackend: "sqlite",
      pidFilePath: pidFileIn(root),
      port: await unusedPort(),
    });
    expect(result).toEqual({
      status: "satisfied",
      reason: "no-pid-file",
      detail: expect.stringContaining("was refused"),
      pid: null,
      observedBackend: null,
      selectedBackend: "sqlite",
    });
  });

  describe("R1: an absent pid file is not absence of a daemon", () => {
    it("is unresolvable (live-daemon-without-pid-file), never satisfied, when no pid file exists but a daemon with the selected backend answers the port", async () => {
      const root = newRoot();
      const port = await listenEphemeral((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok", storageBackend: "postgresql", pid: 4242 }));
      });
      const result = await checkActivationRestartAdmission({ selectedBackend: "postgresql", pidFilePath: pidFileIn(root), port });
      expect(result).toEqual({
        status: "unresolvable",
        reason: "live-daemon-without-pid-file",
        detail: expect.stringContaining("not accounted for by a pid file"),
        pid: null,
        observedBackend: "postgresql",
        selectedBackend: "postgresql",
      });
      expect(result.status).not.toBe("satisfied");
    });

    it("is unsatisfied (backend-stale) when no pid file exists but a daemon with a stale backend answers the port", async () => {
      const root = newRoot();
      const port = await listenEphemeral((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok", storageBackend: "sqlite", pid: 4242 }));
      });
      const result = await checkActivationRestartAdmission({ selectedBackend: "postgresql", pidFilePath: pidFileIn(root), port });
      expect(result).toMatchObject({ status: "unsatisfied", reason: "backend-stale", pid: null, observedBackend: "sqlite" });
    });

    it("is unresolvable (health-unreachable), never satisfied, when no pid file exists and the port accepts but never answers", async () => {
      const root = newRoot();
      const port = await listenEphemeral(() => { /* never respond */ });
      const result = await checkActivationRestartAdmission({
        selectedBackend: "sqlite", pidFilePath: pidFileIn(root), port, healthTimeoutMs: 300,
      });
      expect(result).toMatchObject({ status: "unresolvable", reason: "health-unreachable", pid: null, observedBackend: null });
      expect(result.detail).toContain("neither refused nor answered");
    });

    it("is unresolvable (health-unreachable) when no pid file exists and the port answers with an unrecognized body", async () => {
      const root = newRoot();
      const port = await listenEphemeral((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
      });
      const result = await checkActivationRestartAdmission({ selectedBackend: "sqlite", pidFilePath: pidFileIn(root), port });
      expect(result).toMatchObject({ status: "unresolvable", reason: "health-unreachable", pid: null });
    });

    it("applies the same probe to a stale pid file: a live daemon on another pid with the selected backend is not satisfied", async () => {
      const root = newRoot();
      const pid = await deadPid();
      const port = await listenEphemeral((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok", storageBackend: "sqlite", pid: process.pid }));
      });
      const result = await checkActivationRestartAdmission({ selectedBackend: "sqlite", pidFilePath: pidFileIn(root, String(pid)), port });
      expect(result).toMatchObject({ status: "unresolvable", reason: "live-daemon-without-pid-file", pid, observedBackend: "sqlite" });
    });

    it("applies the same probe to a stale pid file: a live daemon on another pid with a stale backend is unsatisfied", async () => {
      const root = newRoot();
      const pid = await deadPid();
      const port = await listenEphemeral((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok", storageBackend: "sqlite", pid: process.pid }));
      });
      const result = await checkActivationRestartAdmission({ selectedBackend: "postgresql", pidFilePath: pidFileIn(root, String(pid)), port });
      expect(result).toMatchObject({ status: "unsatisfied", reason: "backend-stale", pid, observedBackend: "sqlite" });
    });

    it("keeps a refused connection on the pid-file path as health-unreachable (a live pid with nothing listening is still unresolvable)", async () => {
      const root = newRoot();
      const result = await checkActivationRestartAdmission({
        selectedBackend: "sqlite", pidFilePath: pidFileIn(root, String(process.pid)), port: await unusedPort(),
      });
      expect(result).toMatchObject({ status: "unresolvable", reason: "health-unreachable", pid: process.pid });
    });
  });

  it("is unresolvable (pid-file-malformed), never satisfied, when the pid file exists but its content is unusable (A12 / PA-7)", async () => {
    // A pid file that exists but cannot be parsed is not "no daemon": the
    // daemon may well be running under a pid this verifier failed to read.
    // Collapsing it into no-pid-file would pass a stale daemon silently.
    const root = newRoot();
    const result = await checkActivationRestartAdmission({
      selectedBackend: "postgresql",
      pidFilePath: pidFileIn(root, "not-a-pid\n"),
      port: await unusedPort(),
    });
    expect(result).toEqual({
      status: "unresolvable",
      reason: "pid-file-malformed",
      detail: expect.stringContaining("not a canonical pid"),
      pid: null,
      observedBackend: null,
      selectedBackend: "postgresql",
    });
    expect(result.status).not.toBe("satisfied");
  });

  it.each([
    "123junk",
    "123.5",
    "0x7b",
    "+123",
    "-123",
    "1e3",
    "007",
    "0",
    "123 456",
    "9007199254740993",
  ])("attributes the malformed or out-of-range pid file content %j as pid-file-malformed (unresolvable)", async (content) => {
    const root = newRoot();
    const result = await checkActivationRestartAdmission({
      selectedBackend: "sqlite",
      pidFilePath: pidFileIn(root, content),
      port: await unusedPort(),
    });
    expect(result.status).toBe("unresolvable");
    expect(result.reason).toBe("pid-file-malformed");
    expect(result.pid).toBeNull();
  });

  it("attributes an empty pid file as pid-file-malformed, not as no-pid-file", async () => {
    const root = newRoot();
    const result = await checkActivationRestartAdmission({
      selectedBackend: "sqlite",
      pidFilePath: pidFileIn(root, ""),
      port: await unusedPort(),
    });
    expect(result).toMatchObject({ status: "unresolvable", reason: "pid-file-malformed", pid: null });
  });

  it("accepts a canonical pid surrounded by whitespace", async () => {
    const root = newRoot();
    const pid = await deadPid();
    const result = await checkActivationRestartAdmission({
      selectedBackend: "sqlite",
      pidFilePath: pidFileIn(root, `  ${pid}\n`),
      port: await unusedPort(),
    });
    expect(result.reason).toBe("stale-pid-file");
    expect(result.pid).toBe(pid);
  });

  it("is satisfied with authoritative absence when the pid file names a process that is not running", async () => {
    const root = newRoot();
    const pid = await deadPid();
    const result = await checkActivationRestartAdmission({
      selectedBackend: "sqlite",
      pidFilePath: pidFileIn(root, String(pid)),
      port: await unusedPort(),
    });
    expect(result).toEqual({
      status: "satisfied",
      reason: "stale-pid-file",
      detail: expect.stringContaining(`pid ${pid}`),
      pid,
      observedBackend: null,
      selectedBackend: "sqlite",
    });
    expect(result.detail).toContain("was refused");
  });

  it("is satisfied when a live daemon's startup backend already matches the selection", async () => {
    const root = newRoot();
    const port = await listenEphemeral((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", storageBackend: "sqlite", pid: process.pid }));
    });
    const result = await checkActivationRestartAdmission({
      selectedBackend: "sqlite",
      pidFilePath: pidFileIn(root, String(process.pid)),
      port,
    });
    expect(result).toEqual({
      status: "satisfied",
      reason: "backend-matches",
      detail: expect.stringContaining('startup backend "sqlite"'),
      pid: process.pid,
      observedBackend: "sqlite",
      selectedBackend: "sqlite",
    });
  });

  it("is unsatisfied when a live daemon's startup backend is stale against the completed selection", async () => {
    const root = newRoot();
    const port = await listenEphemeral((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", storageBackend: "sqlite", pid: process.pid }));
    });
    const result = await checkActivationRestartAdmission({
      selectedBackend: "postgresql",
      pidFilePath: pidFileIn(root, String(process.pid)),
      port,
    });
    expect(result).toEqual({
      status: "unsatisfied",
      reason: "backend-stale",
      detail: expect.stringContaining('differs from the selected backend "postgresql"'),
      pid: process.pid,
      observedBackend: "sqlite",
      selectedBackend: "postgresql",
    });
  });

  it("is unresolvable when a live process's pid is named but /health cannot be reached", async () => {
    const root = newRoot();
    const port = await unusedPort();
    const result = await checkActivationRestartAdmission({
      selectedBackend: "sqlite",
      pidFilePath: pidFileIn(root, String(process.pid)),
      port,
      healthTimeoutMs: 500,
    });
    expect(result).toEqual({
      status: "unresolvable",
      reason: "health-unreachable",
      detail: expect.stringContaining(`pid ${process.pid} is running but /health on port ${port} could not be observed`),
      pid: process.pid,
      observedBackend: null,
      selectedBackend: "sqlite",
    });
  });

  it("is unresolvable, not satisfied, when the live process's own pid is used and nothing answers /health (collapse-into-satisfied would fail here)", async () => {
    const root = newRoot();
    const port = await unusedPort();
    const result = await checkActivationRestartAdmission({
      selectedBackend: "sqlite",
      pidFilePath: pidFileIn(root, String(process.pid)),
      port,
      healthTimeoutMs: 500,
    });
    // A two-valued verifier that folds "could not look" into "no live daemon"
    // would report satisfied here, even though the daemon is genuinely
    // running; a two-valued verifier that folds it into "stale" would refuse
    // every restart caused by a transient health hiccup. Neither is this.
    expect(result.status).not.toBe("satisfied");
    expect(result.status).not.toBe("unsatisfied");
    expect(result.status).toBe("unresolvable");
  });

  it("is unresolvable when /health answers with a body that does not name a recognized backend", async () => {
    const root = newRoot();
    const port = await listenEphemeral((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", pid: process.pid }));
    });
    const result = await checkActivationRestartAdmission({
      selectedBackend: "sqlite",
      pidFilePath: pidFileIn(root, String(process.pid)),
      port,
    });
    expect(result.status).toBe("unresolvable");
    expect(result.reason).toBe("health-unreachable");
    expect(result.detail).toContain("did not report a recognized storage backend");
  });

  it("is unresolvable when /health answers with a non-object body", async () => {
    const root = newRoot();
    const port = await listenEphemeral((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(null));
    });
    const result = await checkActivationRestartAdmission({
      selectedBackend: "sqlite",
      pidFilePath: pidFileIn(root, String(process.pid)),
      port,
    });
    expect(result.status).toBe("unresolvable");
    expect(result.reason).toBe("health-unreachable");
  });

  it("is unresolvable when /health answers with a malformed body that cannot be parsed as JSON", async () => {
    const root = newRoot();
    const port = await listenEphemeral((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not json");
    });
    const result = await checkActivationRestartAdmission({
      selectedBackend: "sqlite",
      pidFilePath: pidFileIn(root, String(process.pid)),
      port,
    });
    expect(result.status).toBe("unresolvable");
    expect(result.reason).toBe("health-unreachable");
  });

  it("uses injected dependencies in place of the real pid file, liveness check, and fetch", async () => {
    const readPidFile = () => ({ kind: "present", pid: 4242 } as const);
    const isProcessAlive = (pid: number) => pid === 4242;
    const fetchFn = (async () =>
      new Response(JSON.stringify({ status: "ok", storageBackend: "postgresql", pid: 4242 }), { status: 200 })) as typeof globalThis.fetch;
    const result = await checkActivationRestartAdmission(
      { selectedBackend: "postgresql", pidFilePath: "/unused", port: 1 },
      { readPidFile, isProcessAlive, fetchFn },
    );
    expect(result).toEqual({
      status: "satisfied",
      reason: "backend-matches",
      detail: expect.stringContaining('startup backend "postgresql"'),
      pid: 4242,
      observedBackend: "postgresql",
      selectedBackend: "postgresql",
    });
  });

  it("is unresolvable with health-pid-mismatch when /health reports a different pid than the pid file", async () => {
    const readPidFile = () => ({ kind: "present", pid: 4242 } as const);
    const isProcessAlive = () => true;
    const fetchFn = (async () =>
      new Response(JSON.stringify({ storageBackend: "sqlite", pid: 4243 }), { status: 200 })) as typeof globalThis.fetch;
    const result = await checkActivationRestartAdmission(
      { selectedBackend: "sqlite", pidFilePath: "/unused", port: 7 },
      { readPidFile, isProcessAlive, fetchFn },
    );
    expect(result).toEqual({
      status: "unresolvable",
      reason: "health-pid-mismatch",
      detail: expect.stringContaining("4243"),
      pid: 4242,
      observedBackend: null,
      selectedBackend: "sqlite",
    });
  });

  it.each([
    ["missing", { storageBackend: "sqlite" }],
    ["non-number", { storageBackend: "sqlite", pid: "4242" }],
  ])("is unresolvable with health-pid-mismatch when the /health pid is %s", async (_label, body) => {
    const fetchFn = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof globalThis.fetch;
    const result = await checkActivationRestartAdmission(
      { selectedBackend: "sqlite", pidFilePath: "/unused", port: 7 },
      { readPidFile: () => ({ kind: "present", pid: 4242 } as const), isProcessAlive: () => true, fetchFn },
    );
    expect(result.status).toBe("unresolvable");
    expect(result.reason).toBe("health-pid-mismatch");
    expect(result.observedBackend).toBeNull();
  });

  it("treats only ESRCH from the default liveness probe as a dead process", async () => {
    const calls: Array<[number, number]> = [];
    const killProcess = (pid: number, signal: number): void => {
      calls.push([pid, signal]);
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    };
    const result = await checkActivationRestartAdmission(
      { selectedBackend: "sqlite", pidFilePath: "/unused", port: 7 },
      { readPidFile: () => ({ kind: "present", pid: 4242 } as const), killProcess, fetchFn: refusingFetch() },
    );
    expect(result.status).toBe("satisfied");
    expect(result.reason).toBe("stale-pid-file");
    expect(calls).toEqual([[4242, 0]]);
  });

  it.each(["EPERM", "EINVAL", undefined])(
    "treats a %s failure from the default liveness probe as an alive process and lets /health decide",
    async (code) => {
      const killProcess = (): void => {
        throw Object.assign(new Error("denied"), { code });
      };
      const fetchFn = (async () =>
        new Response(JSON.stringify({ storageBackend: "postgresql", pid: 4242 }), { status: 200 })) as typeof globalThis.fetch;
      const result = await checkActivationRestartAdmission(
        { selectedBackend: "sqlite", pidFilePath: "/unused", port: 7 },
        { readPidFile: () => ({ kind: "present", pid: 4242 } as const), killProcess, fetchFn },
      );
      expect(result.status).toBe("unsatisfied");
      expect(result.reason).toBe("backend-stale");
    },
  );

  it("treats a successful default liveness probe as an alive process", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ storageBackend: "sqlite", pid: 4242 }), { status: 200 })) as typeof globalThis.fetch;
    const result = await checkActivationRestartAdmission(
      { selectedBackend: "sqlite", pidFilePath: "/unused", port: 7 },
      { readPidFile: () => ({ kind: "present", pid: 4242 } as const), killProcess: () => undefined, fetchFn },
    );
    expect(result.reason).toBe("backend-matches");
  });

  it("uses an injected isProcessAlive override to attribute a stale pid file", async () => {
    const readPidFile = () => ({ kind: "present", pid: 9999 } as const);
    const isProcessAlive = () => false;
    const result = await checkActivationRestartAdmission(
      { selectedBackend: "sqlite", pidFilePath: "/unused", port: 1 },
      { readPidFile, isProcessAlive, fetchFn: refusingFetch() },
    );
    expect(result.status).toBe("satisfied");
    expect(result.reason).toBe("stale-pid-file");
    expect(result.pid).toBe(9999);
  });

  it("propagates a non-ENOENT pid file read failure instead of silently reporting absence", async () => {
    const readPidFile = () => {
      throw new Error("permission denied");
    };
    await expect(
      checkActivationRestartAdmission(
        { selectedBackend: "sqlite", pidFilePath: "/unused", port: 1 },
        { readPidFile },
      ),
    ).rejects.toThrow("permission denied");
  });

  it("is unresolvable (pid-file-unreadable), never satisfied and never thrown, when the default reader refuses the file (symlinked pid file)", async () => {
    const root = newRoot();
    const target = join(root, "elsewhere.pid");
    writeFileSync(target, "123");
    const pidFilePath = join(root, "daemon.pid");
    symlinkSync(target, pidFilePath);
    const result = await checkActivationRestartAdmission({
      selectedBackend: "sqlite",
      pidFilePath,
      port: await unusedPort(),
    });
    expect(result).toMatchObject({ status: "unresolvable", reason: "pid-file-unreadable", pid: null, observedBackend: null });
    expect(result.detail).toContain(pidFilePath);
  });

  it("is unresolvable (pid-file-unreadable) when the pid file's permission is genuinely denied", async () => {
    const root = newRoot();
    const pidFilePath = pidFileIn(root, "123");
    chmodSync(pidFilePath, 0o000);
    try {
      const result = await checkActivationRestartAdmission({
        selectedBackend: "sqlite",
        pidFilePath,
        port: await unusedPort(),
      });
      expect(result).toMatchObject({ status: "unresolvable", reason: "pid-file-unreadable", pid: null });
    } finally {
      chmodSync(pidFilePath, 0o600);
    }
  });

  it("is unresolvable (pid-file-unreadable) when a directory occupies the pid file path (a reader refusal without an errno code)", async () => {
    const root = newRoot();
    const pidFilePath = join(root, "daemon.pid");
    mkdirSync(pidFilePath);
    const result = await checkActivationRestartAdmission({
      selectedBackend: "sqlite",
      pidFilePath,
      port: await unusedPort(),
    });
    expect(result).toMatchObject({ status: "unresolvable", reason: "pid-file-unreadable", pid: null });
    expect(result.detail).toContain(pidFilePath);
  });

  it("reports an injected malformed / unreadable attribution verbatim without touching liveness or /health", async () => {
    let probed = false;
    const fetchFn = (() => { probed = true; return Promise.reject(new Error("must not be reached")); }) as unknown as typeof fetch;
    const malformed = await checkActivationRestartAdmission(
      { selectedBackend: "sqlite", pidFilePath: "/unused", port: 1 },
      { readPidFile: () => ({ kind: "malformed", detail: "garbage" }), isProcessAlive: () => { throw new Error("must not be reached"); }, fetchFn },
    );
    expect(malformed).toMatchObject({ status: "unresolvable", reason: "pid-file-malformed", detail: expect.stringContaining("garbage") });
    const unreadable = await checkActivationRestartAdmission(
      { selectedBackend: "sqlite", pidFilePath: "/unused", port: 1 },
      { readPidFile: () => ({ kind: "unreadable", detail: "EIO" }), isProcessAlive: () => { throw new Error("must not be reached"); }, fetchFn },
    );
    expect(unreadable).toMatchObject({ status: "unresolvable", reason: "pid-file-unreadable", detail: expect.stringContaining("EIO") });
    expect(probed).toBe(false);
  });

  it("is unresolvable when /health accepts the connection but never responds before the deadline", async () => {
    const root = newRoot();
    const port = await listenEphemeral(() => {
      // Intentionally never call response.end(); the deadline must fire.
    });
    const result = await checkActivationRestartAdmission({
      selectedBackend: "sqlite",
      pidFilePath: pidFileIn(root, String(process.pid)),
      port,
      healthTimeoutMs: 100,
    });
    expect(result.status).toBe("unresolvable");
    expect(result.reason).toBe("health-unreachable");
  });

  it("attributes a non-Error fetch rejection to health-unreachable without throwing", async () => {
    const readPidFile = () => ({ kind: "present", pid: process.pid } as const);
    const isProcessAlive = () => true;
    // Not every fetch implementation rejects with an Error instance; this
    // exercises the defensive String(error) fallback deliberately.
    const fetchFn = (async () => {
      throw "boom";
    }) as typeof globalThis.fetch;
    const result = await checkActivationRestartAdmission(
      { selectedBackend: "sqlite", pidFilePath: "/unused", port: 1 },
      { readPidFile, isProcessAlive, fetchFn },
    );
    expect(result.status).toBe("unresolvable");
    expect(result.reason).toBe("health-unreachable");
    expect(result.detail).toContain("boom");
  });
});
