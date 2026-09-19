import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  it("is satisfied with authoritative absence when no pid file names a daemon", async () => {
    const root = newRoot();
    const result = await checkActivationRestartAdmission({
      selectedBackend: "sqlite",
      pidFilePath: pidFileIn(root),
      port: await unusedPort(),
    });
    expect(result).toEqual({
      status: "satisfied",
      reason: "no-pid-file",
      detail: expect.stringContaining("no usable pid file"),
      pid: null,
      observedBackend: null,
      selectedBackend: "sqlite",
    });
  });

  it("is satisfied with authoritative absence when the pid file content is unusable", async () => {
    const root = newRoot();
    const result = await checkActivationRestartAdmission({
      selectedBackend: "postgresql",
      pidFilePath: pidFileIn(root, "not-a-pid\n"),
      port: await unusedPort(),
    });
    expect(result.status).toBe("satisfied");
    expect(result.reason).toBe("no-pid-file");
    expect(result.pid).toBeNull();
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
    const readPidFile = () => 4242;
    const isProcessAlive = (pid: number) => pid === 4242;
    const fetchFn = (async () =>
      new Response(JSON.stringify({ status: "ok", storageBackend: "postgresql" }), { status: 200 })) as typeof globalThis.fetch;
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

  it("uses an injected isProcessAlive override to attribute a stale pid file", async () => {
    const readPidFile = () => 9999;
    const isProcessAlive = () => false;
    const result = await checkActivationRestartAdmission(
      { selectedBackend: "sqlite", pidFilePath: "/unused", port: 1 },
      { readPidFile, isProcessAlive },
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

  it("propagates a real non-ENOENT pid file read failure from the default reader", async () => {
    const root = newRoot();
    const target = join(root, "elsewhere.pid");
    writeFileSync(target, "123");
    const pidFilePath = join(root, "daemon.pid");
    symlinkSync(target, pidFilePath);
    await expect(
      checkActivationRestartAdmission({
        selectedBackend: "sqlite",
        pidFilePath,
        port: await unusedPort(),
      }),
    ).rejects.toThrow();
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
    const readPidFile = () => process.pid;
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
