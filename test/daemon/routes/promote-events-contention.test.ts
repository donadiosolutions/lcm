import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { ensureProjectDir, projectDbPath } from "../../../src/daemon/project.js";
import { createDaemon, type DaemonInstance, type DaemonOptions } from "../../../src/daemon/server.js";
import { eventsDbPath } from "../../../src/db/events-path.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { EventsDb } from "../../../src/hooks/events-db.js";
import { PrivateMutationLockContentionError } from "../../../src/private-mutation-lock.js";
import { clearProjectMapCache } from "../../../src/project-map.js";
import { withBackendPublicationConsumerLockAsync } from "../../../src/storage/backend-publication.js";

const BUSY = {
  status: "busy",
  error: "backend publication work is in progress; retry the promotion",
};
const PROMOTE_ROUTES = ["/promote-events", "/promote-events/all"];

const contention = (pid: number): PrivateMutationLockContentionError => new PrivateMutationLockContentionError(
  "backend publication mutation is already in progress (owned by live PID)",
  {
    contendedLock: {
      path: "/lcm/publication.lock",
      owner: { version: 1, pid, processStartTime: null, nonce: "owner" },
    },
  },
);
/** Another process, such as a hook, holds the lock: the request may wait for it. */
const foreignOwner = (): PrivateMutationLockContentionError => contention(process.pid + 1);
/** This daemon holds the lock (the sweep's sidecar scan, for example): waiting could never help. */
const sameProcessOwner = (): PrivateMutationLockContentionError => contention(process.pid);

type Harness = {
  cwd: string;
  lockCalls: () => number;
  post: (path: string) => Promise<Response>;
  /** Hold the real consumer lock from this process, as the daemon's own sweep would. */
  holdLock: () => Promise<() => void>;
};

/**
 * A real daemon over a seeded project. `refusal` chooses, per consumer-lock
 * attempt, an error to throw before the real lock is taken (undefined grants it).
 */
async function withDaemon(
  settings: {
    refusal?: (attempt: number) => unknown;
    options?: Partial<DaemonOptions>;
  },
  scenario: (harness: Harness) => Promise<void>,
): Promise<void> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "lcm-promote-contention-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  clearProjectMapCache();
  mkdirSync(join(home, ".lcm"), { recursive: true, mode: 0o700 });
  const configPath = join(home, ".lcm", "config.json");
  writeFileSync(configPath, "{}\n", { mode: 0o600 });
  const cwd = join(home, "project");
  mkdirSync(cwd, { mode: 0o700 });
  execFileSync("git", ["init", "--quiet", cwd]);
  ensureProjectDir(cwd);
  const db = new DatabaseSync(projectDbPath(cwd));
  runLcmMigrations(db);
  db.close();
  // The sidecar exists empty at startup, so the daemon's own startup sweep has
  // nothing to admit; the event is queued after it settles.
  new EventsDb(eventsDbPath(cwd)).close();
  let attempts = 0;
  let armed = false;
  const releases: (() => void)[] = [];
  let daemon: DaemonInstance | undefined;
  try {
    daemon = await createDaemon(loadDaemonConfig(configPath, {
      daemon: { port: 0, idleTimeoutMs: 0 }, summarizer: { mock: true },
    }), {
      publicationConfigPath: configPath,
      ...(settings.refusal === undefined ? {} : {
        _withBackendPublicationConsumerLockAsync: (async (...args: Parameters<typeof withBackendPublicationConsumerLockAsync>) => {
          if (!armed) return withBackendPublicationConsumerLockAsync(...args);
          attempts += 1;
          const refusal = settings.refusal!(attempts);
          if (refusal !== undefined) throw refusal;
          return withBackendPublicationConsumerLockAsync(...args);
        }) as DaemonOptions["_withBackendPublicationConsumerLockAsync"],
      }),
      ...settings.options,
    });
    const running = daemon;
    await new Promise(resolve => setTimeout(resolve, 300));
    const queued = new EventsDb(eventsDbPath(cwd));
    queued.insertEvent("session", {
      type: "decision",
      category: "decision",
      data: "Use a retryable busy answer while publication work holds the lock",
      priority: 1,
    }, "PostToolUse");
    queued.close();
    await scenario({
      cwd,
      lockCalls: () => attempts,
      post: (path) => {
        armed = true;
        return fetch(`http://127.0.0.1:${running.address().port}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, drain: true }),
        });
      },
      holdLock: async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const held = new Promise<void>((entered, failed) => {
          void withBackendPublicationConsumerLockAsync(home, async () => {
            entered();
            await gate;
          }).catch(failed);
        });
        await held;
        releases.push(release);
        return release;
      },
    });
  } finally {
    for (const release of releases) release();
    await daemon?.stop();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    clearProjectMapCache();
    rmSync(home, { recursive: true, force: true });
  }
}

afterEach(() => vi.restoreAllMocks());

describe("promote-events while publication work holds the lock (#1684)", () => {
  it.each(PROMOTE_ROUTES)("%s answers a busy 503 at once while this process holds the lock", async (path) => {
    await withDaemon({}, async (harness) => {
      await harness.holdLock();
      const response = await harness.post(path);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(BUSY);
    });
  });

  it.each(PROMOTE_ROUTES)("%s waits for another process to release the lock, then succeeds", async (path) => {
    await withDaemon({ refusal: (attempt) => (attempt <= 2 ? foreignOwner() : undefined) }, async (harness) => {
      const response = await harness.post(path);

      expect(response.status).toBe(200);
      // Two refused attempts and the granted one, all before the handler ran.
      expect(harness.lockCalls()).toBeGreaterThanOrEqual(3);
    });
  });

  it.each(PROMOTE_ROUTES)("%s answers a busy 503 once the wait for another process is spent", async (path) => {
    // Each refused attempt moves the clock 50 ms, as one pause would.
    let now = 0;
    await withDaemon({
      refusal: () => {
        now += 50;
        return foreignOwner();
      },
      options: { _routeAdmissionWaitMs: 100, _routeAdmissionNow: () => now },
    }, async (harness) => {
      const response = await harness.post(path);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(BUSY);
      expect(harness.lockCalls()).toBe(3);
    });
  });

  it.each(PROMOTE_ROUTES)(
    "%s answers a busy 503, not a result, when a later admission is contended",
    async (path) => {
      // The pre-handler probe is admitted; every admission inside the handler is refused.
      await withDaemon({ refusal: (attempt) => (attempt === 1 ? undefined : sameProcessOwner()) }, async (harness) => {
        const response = await harness.post(path);

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual(BUSY);
        expect(harness.lockCalls()).toBeGreaterThanOrEqual(2);
      });
    },
  );

  it("still admits a later step after the deadline from the first wait has passed", async () => {
    let now = 0;
    await withDaemon({
      refusal: (attempt) => {
        if (attempt === 1) return foreignOwner();
        // The probe is admitted after the first wait, then the request works for 5 s.
        if (attempt === 2) now += 5_000;
        return undefined;
      },
      options: { _routeAdmissionNow: () => now },
    }, async (harness) => {
      expect((await harness.post("/promote-events")).status).toBe(200);
      expect(harness.lockCalls()).toBeGreaterThanOrEqual(3);
    });
  });

  it("gives a later contended step no new wait once the deadline has passed", async () => {
    let now = 0;
    await withDaemon({
      refusal: (attempt) => {
        if (attempt === 1) return foreignOwner();
        if (attempt === 2) {
          now += 5_000;
          return undefined;
        }
        return foreignOwner();
      },
      options: { _routeAdmissionNow: () => now },
    }, async (harness) => {
      const response = await harness.post("/promote-events");

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(BUSY);
      // Refused, probe, then one refused handler admission with no retry.
      expect(harness.lockCalls()).toBe(3);
    });
  });

  it("never replays an admission whose callback has started", async () => {
    // Startup also runs the assertion, so it only refuses once requests begin.
    let requestsBegan = false;
    await withDaemon({
      refusal: () => undefined,
      options: { _assertBackendPublication: () => { if (requestsBegan) throw foreignOwner(); } },
    }, async (harness) => {
      requestsBegan = true;
      const response = await harness.post("/promote-events");

      expect(response.status).toBe(503);
      expect(harness.lockCalls()).toBe(1);
    });
  });

  it("leaves other operation-scoped routes answering 500 for the same contention", async () => {
    await withDaemon({ refusal: () => sameProcessOwner() }, async (harness) => {
      expect((await harness.post("/store")).status).toBe(500);
      expect(harness.lockCalls()).toBe(1);
    });
  });
});
