import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAuthToken, readAuthToken } from "../../../src/daemon/auth.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { createDaemon, type DaemonInstance, type DaemonOptions } from "../../../src/daemon/server.js";
import { clearProjectMapCache } from "../../../src/project-map.js";
import { PrivateMutationLockContentionError } from "../../../src/private-mutation-lock.js";
import { withBackendPublicationConsumerLockAsync } from "../../../src/storage/backend-publication.js";
import { createStorageBackendFactory } from "../../../src/storage/index.js";

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

async function bounded<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("terminal ingest test did not settle")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

const identity = { ownerId: "terminal-ingest-http", entrypoint: "/lcm-tests/terminal-daemon.mjs" } as const;

function codexLine(role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  });
}

type Fixture = {
  home: string;
  cwd: string;
  transcript: string;
  daemon: DaemonInstance;
  token: string;
  events: string[];
  post: (body: unknown, token?: string | null) => Promise<Response>;
  messageCount: () => number;
  holdPublication: () => Promise<{ release: () => void; done: Promise<void> }>;
  gates: { open?: Gate; projectClose?: Gate; openEntered: Gate; openIgnoresSignal?: boolean };
  idle: ReturnType<typeof vi.fn>;
};

async function withTerminalDaemon(
  settings: { idleTimeoutMs?: number; token?: boolean; daemonOptions?: Partial<DaemonOptions> },
  operation: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "lcm-terminal-http-"));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  clearProjectMapCache();
  const root = join(home, ".lcm");
  const cwd = join(home, "project");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(cwd, { mode: 0o700 });
  const configPath = join(root, "config.json");
  writeFileSync(configPath, "{}\n", { mode: 0o600 });
  const tokenPath = join(root, "daemon.token");
  if (settings.token !== false) ensureAuthToken(tokenPath);
  const transcript = join(cwd, "rollout.jsonl");
  writeFileSync(transcript, [codexLine("user", "first question"), codexLine("assistant", "first answer")].join("\n") + "\n");

  // Resolved before any test holds the publication lock, which path lookup needs.
  const dbPath = projectDbPath(cwd);
  const events: string[] = [];
  const gates: Fixture["gates"] = { openEntered: gate() };
  const idle = vi.fn();
  let runScan!: () => Promise<void>;
  let scanOperation: NonNullable<DaemonOptions["_scanForTranscripts"]> = async () => undefined;
  const realSetInterval = globalThis.setInterval;
  const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 600_000 && typeof callback === "function") runScan = () => Promise.resolve(callback(...args));
    return realSetInterval(callback, delay, ...args);
  }) as typeof setInterval);
  const releases: Array<() => void> = [];
  const scans: Promise<void>[] = [];
  let daemon: DaemonInstance | undefined;
  try {
    daemon = await createDaemon(loadDaemonConfig(configPath, {
      daemon: { port: 0, idleTimeoutMs: settings.idleTimeoutMs ?? 0 }, summarizer: { mock: true },
    }), {
      publicationConfigPath: configPath,
      ...(settings.token === false ? {} : { tokenPath, _testIdentity: identity }),
      onIdle: idle,
      _scanForTranscripts: (admission, _signal) => scanOperation(admission),
      _createStorageBackendFactory: async (...args) => {
        const factory = await createStorageBackendFactory(...args);
        const open = factory.openProject.bind(factory);
        vi.spyOn(factory, "openProject").mockImplementation(async (...openArgs) => {
          events.push("open:start");
          gates.openEntered.open();
          if (gates.open) await gates.open.promise;
          // openIgnoresSignal models an open that resolves despite cancellation.
          const project = await open(...(gates.openIgnoresSignal ? openArgs.slice(0, 2) as typeof openArgs : openArgs));
          events.push("open:end");
          const close = project.close.bind(project);
          vi.spyOn(project, "close").mockImplementation(async (...closeArgs) => {
            events.push("project.close:start");
            if (gates.projectClose) await gates.projectClose.promise;
            await close(...closeArgs);
            events.push("project.close:end");
          });
          return project;
        });
        const closeFactory = factory.close.bind(factory);
        vi.spyOn(factory, "close").mockImplementation(async () => {
          events.push("factory.close");
          await closeFactory();
        });
        return factory;
      },
      ...settings.daemonOptions,
    });
    const running = daemon;
    const token = settings.token === false ? "" : readAuthToken(tokenPath)!;
    await operation({
      home, cwd, transcript, daemon: running, token, events, gates, idle,
      post: (body, bearer = token) => fetch(`http://127.0.0.1:${running.address().port}/ingest/terminal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
      }),
      messageCount: () => {
        // The project database does not exist until the first ingest opens it.
        try {
          const database = new DatabaseSync(dbPath, { readOnly: true });
          try { return (database.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n; }
          finally { database.close(); }
        } catch { return 0; }
      },
      holdPublication: async () => {
        const entered = gate();
        const release = gate();
        releases.push(release.open);
        scanOperation = (admission) => admission(async () => { entered.open(); await release.promise; });
        const done = runScan();
        scans.push(done);
        await bounded(entered.promise);
        return { release: release.open, done };
      },
    });
  } finally {
    for (const release of releases) release();
    gates.open?.open();
    gates.projectClose?.open();
    await Promise.allSettled(scans);
    await daemon?.stop();
    intervalSpy.mockRestore();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    clearProjectMapCache();
    rmSync(home, { recursive: true, force: true });
  }
}

afterEach(() => vi.restoreAllMocks());

const body = (fixture: Pick<Fixture, "cwd" | "transcript">, extra: Record<string, unknown> = {}) => ({
  session_id: "terminal-session",
  cwd: fixture.cwd,
  transcript_path: fixture.transcript,
  client: "codex",
  event: "SessionEnd",
  ...extra,
});

describe("POST /ingest/terminal", () => {
  const liveContention = (): PrivateMutationLockContentionError => new PrivateMutationLockContentionError(
    "backend publication mutation is already in progress (owned by live PID)",
    {
      contendedLock: {
        path: "/lcm/publication.lock",
        owner: { version: 1, pid: process.pid + 1, processStartTime: null, nonce: "owner" },
      },
    },
  );

  it("ingests exactly once after a live process releases the publication lock following the 202", async () => {
    let armed = false;
    let refused = 0;
    const lock: typeof withBackendPublicationConsumerLockAsync = (...args) => {
      if (armed && refused < 3) {
        refused += 1;
        throw liveContention();
      }
      return withBackendPublicationConsumerLockAsync(...args);
    };
    await withTerminalDaemon({ daemonOptions: { _withBackendPublicationConsumerLockAsync: lock } }, async (fixture) => {
      armed = true;
      expect((await bounded(fixture.post(body(fixture)))).status).toBe(202);
      await vi.waitFor(() => expect(fixture.messageCount()).toBe(2), { timeout: 5_000 });
      await vi.waitFor(() => expect(fixture.events.filter((event) => event === "project.close:end")).toHaveLength(1), { timeout: 5_000 });
      expect(refused).toBe(3);
      expect(fixture.events.filter((event) => event === "open:start")).toHaveLength(1);
    });
  });

  it("stops waiting for the publication lock when the daemon shuts down", async () => {
    let armed = false;
    let refused = 0;
    const lock: typeof withBackendPublicationConsumerLockAsync = (...args) => {
      if (!armed) return withBackendPublicationConsumerLockAsync(...args);
      refused += 1;
      throw liveContention();
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await withTerminalDaemon({ daemonOptions: { _withBackendPublicationConsumerLockAsync: lock } }, async (fixture) => {
      armed = true;
      expect((await bounded(fixture.post(body(fixture)))).status).toBe(202);
      await vi.waitFor(() => expect(refused).toBeGreaterThanOrEqual(2), { timeout: 5_000 });

      await bounded(fixture.daemon.stop());

      expect(fixture.events).not.toContain("open:start");
      expect(fixture.messageCount()).toBe(0);
      // A wait ended by shutdown is a cancellation, not a failed ingest.
      expect(warn).toHaveBeenCalledWith("[lcm] terminal ingest cancelled");
      expect(warn).not.toHaveBeenCalledWith("[lcm] terminal ingest failed");
    });
  });

  it("answers 202 while ordinary publication work is running and ingests once it finishes", async () => {
    await withTerminalDaemon({}, async (fixture) => {
      const hold = await fixture.holdPublication();
      const response = await bounded(fixture.post(body(fixture)));
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true });
      expect(fixture.events).toEqual([]);
      expect(fixture.messageCount()).toBe(0);

      hold.release();
      await hold.done;
      await vi.waitFor(() => expect(fixture.messageCount()).toBe(2), { timeout: 5_000 });
    });
  });

  it("keeps ingesting after the hook has disconnected", async () => {
    await withTerminalDaemon({}, async (fixture) => {
      const payload = JSON.stringify(body(fixture));
      await bounded(new Promise<void>((resolve, reject) => {
        const request = httpRequest({
          hostname: "127.0.0.1",
          port: fixture.daemon.address().port,
          path: "/ingest/terminal",
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${fixture.token}`, "Content-Length": Buffer.byteLength(payload) },
        }, (response) => {
          expect(response.statusCode).toBe(202);
          // The hook process exits as soon as it has the acknowledgment.
          request.destroy();
          response.destroy();
          resolve();
        });
        request.on("error", () => undefined);
        request.on("error", reject);
        request.end(payload);
      }).catch(() => undefined));
      await vi.waitFor(() => expect(fixture.messageCount()).toBe(2), { timeout: 5_000 });
    });
  });

  it("re-runs for a request that arrives mid-run so the newest tail is stored once", async () => {
    await withTerminalDaemon({}, async (fixture) => {
      fixture.gates.open = gate();
      expect((await fixture.post(body(fixture, { event: "Interrupt" }))).status).toBe(202);
      await bounded(fixture.gates.openEntered.promise);
      // The first run has already read the transcript; the session then continues.
      // The ordinary ingest notices the changed source and re-reads it itself,
      // so that first run stores the newest tail (two opens). The queued request
      // still re-runs afterwards and finds nothing new (a third open).
      appendFileSync(fixture.transcript, [codexLine("user", "second question"), codexLine("assistant", "second answer")].join("\n") + "\n");
      expect((await fixture.post(body(fixture))).status).toBe(202);
      fixture.gates.open.open();
      await vi.waitFor(() => expect(fixture.messageCount()).toBe(4), { timeout: 5_000 });
      // Stopping the daemon cancels a run that has not finished, so wait for all three.
      await vi.waitFor(() => expect(fixture.events.filter((event) => event === "project.close:end")).toHaveLength(3), { timeout: 5_000 });
      await bounded(fixture.daemon.stop());
      expect(fixture.messageCount()).toBe(4);
      expect(fixture.events.filter((event) => event === "open:start")).toHaveLength(3);
    });
  });

  it.each([
    ["no daemon token", { token: false }, undefined],
    ["a missing bearer token", {}, null],
    ["a wrong bearer token", {}, "wrong"],
  ])("answers 401 for %s and enqueues nothing", async (_name, settings, bearer) => {
    await withTerminalDaemon(settings, async (fixture) => {
      const response = await fixture.post(body(fixture), bearer);
      expect(response.status).toBe(401);
      await fixture.daemon.stop();
      expect(fixture.events.filter((event) => event !== "factory.close")).toEqual([]);
    });
  });

  it("answers 400, never 202, for an unsafe or missing transcript", async () => {
    await withTerminalDaemon({}, async (fixture) => {
      for (const transcript_path of ["/etc/hostname", join(fixture.cwd, "missing.jsonl")]) {
        expect((await fixture.post(body(fixture, { transcript_path }))).status).toBe(400);
      }
      expect(fixture.events).toEqual([]);
    });
  });

  it("answers 503 once the daemon is shutting down", async () => {
    await withTerminalDaemon({}, async (fixture) => {
      const stopping = fixture.daemon.stop();
      const response = await fixture.post(body(fixture)).catch(() => undefined);
      if (response !== undefined) expect([503, 404]).toContain(response.status);
      await stopping;
    });
  });

  it("keeps the daemon alive while accepted work is queued, then lets it go idle", async () => {
    await withTerminalDaemon({ idleTimeoutMs: 100 }, async (fixture) => {
      fixture.gates.open = gate();
      expect((await fixture.post(body(fixture))).status).toBe(202);
      await bounded(fixture.gates.openEntered.promise);
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(fixture.idle).not.toHaveBeenCalled();
      expect(fixture.daemon.idleTriggered).toBe(false);

      fixture.gates.open.open();
      await vi.waitFor(() => expect(fixture.idle).toHaveBeenCalled(), { timeout: 5_000 });
      expect(fixture.messageCount()).toBe(2);
    });
  });

  it("waits for a running ingest's storage cleanup before the shared factory closes and cancels what was only queued", async () => {
    await withTerminalDaemon({}, async (fixture) => {
      fixture.gates.projectClose = gate();
      expect((await fixture.post(body(fixture, { session_id: "running" }))).status).toBe(202);
      await vi.waitFor(() => expect(fixture.events).toContain("project.close:start"), { timeout: 5_000 });
      expect((await fixture.post(body(fixture, { session_id: "queued" }))).status).toBe(202);

      const stopping = fixture.daemon.stop();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fixture.events).not.toContain("factory.close");

      fixture.gates.projectClose.open();
      await bounded(stopping);
      expect(fixture.events).toEqual([
        "open:start", "open:end", "project.close:start", "project.close:end", "factory.close",
      ]);
    });
  });

  it("waits for a cancelled ingest's pending project open before the shared factory closes", async () => {
    await withTerminalDaemon({}, async (fixture) => {
      fixture.gates.open = gate();
      fixture.gates.openIgnoresSignal = true;
      expect((await fixture.post(body(fixture))).status).toBe(202);
      await bounded(fixture.gates.openEntered.promise);

      let stopped = false;
      const stopping = fixture.daemon.stop().then(() => { stopped = true; });
      // Let every already-resolved continuation of stop() run to a standstill.
      for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(fixture.events).toEqual(["open:start"]);
      expect(stopped).toBe(false);

      fixture.gates.open.open();
      await bounded(stopping);
      expect(fixture.events).toEqual([
        "open:start", "open:end", "project.close:start", "project.close:end", "factory.close",
      ]);
    });
  });
});

describe("terminal ingest queue during daemon construction failure", () => {
  async function failingConstruction(
    port: number,
    failAt?: string,
  ): Promise<{ error: unknown; events: string[] }> {
    const home = mkdtempSync(join(tmpdir(), "lcm-terminal-start-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    clearProjectMapCache();
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const configPath = join(home, ".lcm", "config.json");
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    const events: string[] = [];
    try {
      await createDaemon(loadDaemonConfig(configPath, { daemon: { port, idleTimeoutMs: 0 } }), {
        publicationConfigPath: configPath,
        _onBuiltInRouteRegistered: (key) => { if (key === failAt) throw new Error("registration failed"); },
        _createStorageBackendFactory: async (...args) => {
          const factory = await createStorageBackendFactory(...args);
          const close = factory.close.bind(factory);
          vi.spyOn(factory, "close").mockImplementation(async () => { events.push("factory.close"); await close(); });
          return factory;
        },
      });
      return { error: undefined, events };
    } catch (error) {
      return { error, events };
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      clearProjectMapCache();
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("settles the queue and closes storage when the listener cannot start", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    try {
      const { error, events } = await failingConstruction((blocker.address() as AddressInfo).port);
      expect((error as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
      expect(events).toEqual(["factory.close"]);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it.each([
    ["before the queue exists", "GET /health"],
    ["after the queue exists", "POST /ingest/terminal"],
  ])("settles the queue and closes storage when construction fails %s", async (_name, failAt) => {
    const { error, events } = await failingConstruction(0, failAt);
    expect((error as Error).message).toBe("registration failed");
    expect(events).toEqual(["factory.close"]);
  });
});
