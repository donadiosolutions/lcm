import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventsDb } from "../../../src/hooks/events-db.js";
import { eventsDbPath } from "../../../src/db/events-path.js";
import { createDaemon, type DaemonInstance, type DaemonOptions } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { clearProjectMapCache } from "../../../src/project-map.js";
import { createStorageBackendFactory } from "../../../src/storage/index.js";
import { withBackendPublicationConsumerLockAsync } from "../../../src/storage/backend-publication.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("HTTP publication test did not settle")), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}

afterEach(() => vi.restoreAllMocks());

async function withDaemon(operation: (fixture: {
  home: string;
  cwd: string;
  daemon: DaemonInstance;
  post: (path: string, body: object, signal?: AbortSignal) => Promise<Response>;
  waitForArrival: () => Promise<void>;
  waitForCancellation: () => Promise<void>;
  holdBackground: (releaseOnShutdown?: boolean) => Promise<{ release: () => void; done: Promise<void> }>;
  storageEntries: string[];
}) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "lcm-queue-http-"));
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
  let runScan!: () => Promise<void>;
  let scanOperation: NonNullable<DaemonOptions["_scanForTranscripts"]> = async () => undefined;
  let arrival = deferred();
  let cancellation = deferred();
  let daemon: DaemonInstance | undefined;
  const releases: (() => void)[] = [];
  const scans: Promise<void>[] = [];
  const storageEntries: string[] = [];
  const realSetInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 600_000 && typeof callback === "function") runScan = () => Promise.resolve(callback(...args));
    return realSetInterval(callback, delay, ...args);
  }) as typeof setInterval);
  try {
    daemon = await createDaemon(loadDaemonConfig(configPath, {
      daemon: { port: 0, idleTimeoutMs: 0 }, summarizer: { mock: true },
    }), {
      publicationConfigPath: configPath,
      _scanForTranscripts: (admission, signal) => scanOperation(admission, signal),
      _onRequestLifecycle: (event) => {
        if (event === "received") arrival.resolve();
        if (event === "cancelled") cancellation.resolve();
      },
      _createStorageBackendFactory: async (...args) => {
        const factory = await createStorageBackendFactory(...args);
        for (const method of ["openProject", "openExistingProject"] as const) {
          const original = factory[method].bind(factory);
          vi.spyOn(factory, method).mockImplementation(async (...openArgs) => {
            storageEntries.push(method);
            return original(...openArgs);
          });
        }
        return factory;
      },
    });
    const activeDaemon = daemon;
    await operation({
      home, cwd, daemon: activeDaemon, storageEntries,
      post: (path, body, signal) => fetch(`http://127.0.0.1:${activeDaemon.address().port}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
      }),
      waitForArrival: () => {
        const pending = arrival.promise;
        return bounded(pending).then(() => { arrival = deferred(); });
      },
      waitForCancellation: () => {
        const pending = cancellation.promise;
        return bounded(pending).then(() => { cancellation = deferred(); });
      },
      holdBackground: async (releaseOnShutdown = false) => {
        const entered = deferred();
        const release = deferred();
        releases.push(release.resolve);
        scanOperation = (admission, signal) => admission(async () => {
          if (releaseOnShutdown) signal?.addEventListener("abort", release.resolve, { once: true });
          entered.resolve();
          try { await release.promise; }
          finally { signal?.removeEventListener("abort", release.resolve); }
        });
        const done = runScan();
        scans.push(done);
        await bounded(entered.promise);
        return { release: release.resolve, done };
      },
    });
  } finally {
    for (const release of releases) release();
    await Promise.allSettled(scans);
    await daemon?.stop();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    clearProjectMapCache();
    rmSync(home, { recursive: true, force: true });
  }
}

function query(cwd: string, sql: string): unknown[] {
  const database = new DatabaseSync(projectDbPath(cwd));
  try { return database.prepare(sql).all(); }
  finally { database.close(); }
}

describe("builtin HTTP publication queue", () => {
  it("defers native-shaped mutator fanout behind background ownership and persists completion and memory", async () => {
    await withDaemon(async ({ cwd, post, waitForArrival, holdBackground, storageEntries }) => {
      const events = new EventsDb(eventsDbPath(cwd));
      events.insertEvent("fanout-events", { type: "decision", category: "decision", data: "use deterministic admission for background writes", priority: 1 }, "PostToolUse");
      events.close();
      const hold = await holdBackground();
      const requests: Promise<Response>[] = [];
      let settled = 0;
      const inputs = [
        ["/session-complete", { cwd, session_id: "queued-completion" }],
        ["/promote", { cwd, dry_run: true }],
        ["/store", { cwd, text: "queue regression durable memory" }],
        ["/compact", { cwd, session_id: "queued-compact", skip_ingest: true }],
        ["/promote-events", { cwd }],
      ] as const;
      for (const [path, body] of inputs) {
        const arrived = waitForArrival();
        requests.push(post(path, body).then(response => { settled += 1; return response; }));
        await arrived;
      }
      expect(settled).toBe(0);
      expect(storageEntries).toEqual([]);
      hold.release();
      const responses = await bounded(Promise.all(requests));
      const bodies = await Promise.all(responses.map(response => response.json()));
      expect(responses.map(response => response.status), JSON.stringify(bodies)).toEqual([200, 200, 200, 200, 200]);
      expect(bodies[0]).toEqual({ recorded: true });
      expect(bodies[4]).toMatchObject({ promoted: 1, errors: 0 });
      expect(query(cwd, "SELECT content FROM promoted WHERE content LIKE '%deterministic admission%'"))
        .toHaveLength(1);
      expect(query(cwd, "SELECT session_id FROM session_ingest_log WHERE session_id = 'queued-completion'"))
        .toEqual([{ session_id: "queued-completion" }]);
      expect(query(cwd, "SELECT content FROM promoted WHERE content = 'queue regression durable memory'"))
        .toEqual([{ content: "queue regression durable memory" }]);
      await hold.done;
    });
  });

  it("revalidates publication evidence after waiting before any storage entry", async () => {
    await withDaemon(async ({ home, cwd, post, waitForArrival, holdBackground, storageEntries }) => {
      const hold = await holdBackground();
      const arrived = waitForArrival();
      const response = post("/session-complete", { cwd, session_id: "changed-publication" });
      await arrived;
      const directory = join(home, ".lcm", "backend-publication");
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(join(directory, "journal.json"), "{invalid-publication", { mode: 0o600 });
      hold.release();
      await hold.done;
      const blocked = await bounded(response);
      expect(blocked.status).toBe(503);
      expect(await blocked.json()).toEqual({ status: "blocked", error: "backend publication admission blocked" });
      expect(storageEntries).toEqual([]);
      rmSync(directory, { recursive: true, force: true });
    });
  });

  it("cancels queued completion without entering storage or later writing its row", async () => {
    await withDaemon(async ({ cwd, post, waitForArrival, waitForCancellation, holdBackground, storageEntries }) => {
      const hold = await holdBackground();
      const controller = new AbortController();
      const arrived = waitForArrival();
      const request = post("/session-complete", { cwd, session_id: "cancelled-completion" }, controller.signal);
      const outcome = request.then(() => "responded", () => "aborted");
      await arrived;
      const cancelled = waitForCancellation();
      controller.abort();
      await cancelled;
      await expect(bounded(outcome)).resolves.toBe("aborted");
      expect(storageEntries).toEqual([]);
      hold.release();
      await hold.done;
      const next = await bounded(post("/session-complete", { cwd, session_id: "after-cancellation" }));
      expect(next.status).toBe(200);
      expect(storageEntries).toEqual(["openProject"]);
      expect(query(cwd, "SELECT session_id FROM session_ingest_log ORDER BY session_id"))
        .toEqual([{ session_id: "after-cancellation" }]);
    });
  });

  it("settles stop with pending requests when active background work observes shutdown", async () => {
    await withDaemon(async ({ cwd, daemon, post, waitForArrival, holdBackground, storageEntries }) => {
      await holdBackground(true);
      const arrived = waitForArrival();
      const request = post("/session-complete", { cwd, session_id: "shutdown-completion" }).catch(() => undefined);
      await arrived;
      await bounded(daemon.stop());
      await bounded(request);
      expect(storageEntries).toEqual([]);
    });
  });

  it("answers health and the existing recent fallback while a local background slot remains held", async () => {
    await withDaemon(async ({ cwd, daemon, post, holdBackground, storageEntries }) => {
      const hold = await holdBackground();
      const health = await bounded(fetch(`http://127.0.0.1:${daemon.address().port}/health`));
      expect(health.status).toBe(200);
      const read = await bounded(post("/recent", { cwd }));
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ summaries: [] });
      expect(storageEntries).toEqual([]);
      hold.release();
      await hold.done;
    });
  });

  it("preserves external-lock refusal and keeps health and read admission outside the local write queue", async () => {
    await withDaemon(async ({ home, cwd, daemon, post, storageEntries }) => {
      await withBackendPublicationConsumerLockAsync(home, async () => {
        const response = await bounded(post("/session-complete", { cwd, session_id: "external-owner" }));
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: expect.stringContaining("backend publication mutation is already in progress") });
        const health = await bounded(fetch(`http://127.0.0.1:${daemon.address().port}/health`));
        expect(health.status).toBe(200);
        const read = await bounded(post("/recent", { cwd }));
        expect(read.status).toBe(200);
        expect(await read.json()).toEqual({ summaries: [] });
        expect(storageEntries).toEqual([]);
      });
    });
  });
});
