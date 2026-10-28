import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { ensureProjectDir, projectDbPath } from "../../../src/daemon/project.js";
import { createDaemon, type DaemonInstance, type DaemonOptions } from "../../../src/daemon/server.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { PrivateMutationLockContentionError } from "../../../src/private-mutation-lock.js";
import { clearProjectMapCache } from "../../../src/project-map.js";
import {
  BackendPublicationJournalError,
  withBackendPublicationConsumerLockAsync,
} from "../../../src/storage/backend-publication.js";

// #1774: /store waits for a live lock owner instead of failing with a 500.
const BUSY = {
  status: "busy",
  error: "backend publication work is in progress; retry the store",
};

const contention = (pid: number): PrivateMutationLockContentionError => new PrivateMutationLockContentionError(
  "backend publication mutation is already in progress (owned by live PID)",
  {
    contendedLock: {
      path: "/lcm/publication.lock",
      owner: { version: 1, pid, processStartTime: null, nonce: "owner" },
    },
  },
);
const foreignOwner = (): PrivateMutationLockContentionError => contention(process.pid + 1);
const sameProcessOwner = (): PrivateMutationLockContentionError => contention(process.pid);

type Harness = {
  cwd: string;
  lockCalls: () => number;
  storedCount: () => number;
  /** Resolves once the request lifecycle observer saw the request cancelled. */
  cancelled: Promise<void>;
  post: (signal?: AbortSignal) => Promise<Response>;
};

/**
 * A real daemon over a seeded project. `refusal` chooses, per consumer-lock
 * attempt made after startup, an error to throw before the real lock is taken
 * (undefined grants it).
 */
async function withDaemon(
  settings: {
    refusal: (attempt: number) => unknown;
    options?: Partial<DaemonOptions>;
  },
  scenario: (harness: Harness) => Promise<void>,
): Promise<void> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "lcm-store-admission-"));
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
  const seed = new DatabaseSync(projectDbPath(cwd));
  runLcmMigrations(seed);
  seed.close();
  let attempts = 0;
  let armed = false;
  let markCancelled!: () => void;
  const cancelled = new Promise<void>(resolve => { markCancelled = resolve; });
  let daemon: DaemonInstance | undefined;
  try {
    daemon = await createDaemon(loadDaemonConfig(configPath, {
      daemon: { port: 0, idleTimeoutMs: 0 }, summarizer: { mock: true },
    }), {
      publicationConfigPath: configPath,
      _withBackendPublicationConsumerLockAsync: (async (...args: Parameters<typeof withBackendPublicationConsumerLockAsync>) => {
        if (!armed) return withBackendPublicationConsumerLockAsync(...args);
        attempts += 1;
        const refusal = settings.refusal(attempts);
        if (refusal !== undefined) throw refusal;
        return withBackendPublicationConsumerLockAsync(...args);
      }) as DaemonOptions["_withBackendPublicationConsumerLockAsync"],
      _onRequestLifecycle: event => { if (event === "cancelled") markCancelled(); },
      ...settings.options,
    });
    const running = daemon;
    await scenario({
      cwd,
      lockCalls: () => attempts,
      storedCount: () => {
        const db = new DatabaseSync(projectDbPath(cwd));
        try {
          return (db.prepare("SELECT COUNT(*) AS n FROM promoted").get() as { n: number }).n;
        } finally {
          db.close();
        }
      },
      cancelled,
      post: signal => {
        armed = true;
        return fetch(`http://127.0.0.1:${running.address().port}/store`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "Store waits for a live lock owner", tags: ["decision"], cwd }),
          ...(signal === undefined ? {} : { signal }),
        });
      },
    });
  } finally {
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

describe("POST /store while a live process holds the publication lock (#1774)", () => {
  it.each([
    ["another process", foreignOwner],
    ["this daemon", sameProcessOwner],
  ])("stores once %s releases the lock", async (_name, owner) => {
    await withDaemon({ refusal: attempt => (attempt <= 2 ? owner() : undefined) }, async harness => {
      const response = await harness.post();

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ stored: true });
      expect(harness.storedCount()).toBe(1);
      // Two refused attempts and the granted one, plus the later admissions of the same request.
      expect(harness.lockCalls()).toBeGreaterThanOrEqual(3);
    });
  });

  it.each([
    ["the preflight admission", 0],
    ["the identity admission", 1],
    ["the storage admission", 2],
  ])("answers a retryable busy 503 once the wait is spent at %s", async (_name, admitted) => {
    // Each refused attempt moves the clock 50 ms, as one pause would. The first
    // `admitted` admissions are granted; every later attempt is refused.
    let now = 0;
    let granted = 0;
    await withDaemon({
      refusal: () => {
        if (granted < admitted) {
          granted += 1;
          return undefined;
        }
        now += 50;
        return foreignOwner();
      },
      options: { _routeAdmissionWaitMs: 100, _routeAdmissionNow: () => now },
    }, async harness => {
      const response = await harness.post();

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(BUSY);
      expect(harness.storedCount()).toBe(0);
      // Granted admissions, then at most two refused attempts and the one that ended the wait.
      expect(harness.lockCalls()).toBe(admitted + 3);
    });
  });

  it("does not wait for an ambiguous owner", async () => {
    await withDaemon({
      refusal: () => new PrivateMutationLockContentionError("owner state is ambiguous"),
    }, async harness => {
      const response = await harness.post();

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(BUSY);
      expect(harness.lockCalls()).toBe(1);
    });
  });

  it("keeps the blocked-journal answer for a publication journal error", async () => {
    await withDaemon({
      refusal: () => new BackendPublicationJournalError("unresolved-publication", "unresolved"),
    }, async harness => {
      const response = await harness.post();

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "blocked", error: "backend publication admission blocked" });
      expect(harness.lockCalls()).toBe(1);
    });
  });

  it("ends the wait as a cancellation, without storing, when the client goes away", async () => {
    await withDaemon({ refusal: () => foreignOwner() }, async harness => {
      const controller = new AbortController();
      const response = harness.post(controller.signal).catch(() => undefined);
      await vi.waitFor(() => expect(harness.lockCalls()).toBeGreaterThanOrEqual(2), { timeout: 3_000 });

      controller.abort();
      await harness.cancelled;
      await response;
      expect(harness.storedCount()).toBe(0);
    });
  });
});
