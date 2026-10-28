import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { createDaemon, type DaemonInstance, type DaemonOptions } from "../../../src/daemon/server.js";
import { PrivateMutationLockContentionError } from "../../../src/private-mutation-lock.js";
import {
  BackendPublicationJournalError,
  type BackendPublicationLockToken,
} from "../../../src/storage/backend-publication.js";

const liveContention = (pid = process.pid + 1): PrivateMutationLockContentionError => new PrivateMutationLockContentionError(
  "backend publication mutation is already in progress (owned by live PID)",
  {
    contendedLock: {
      path: "/lcm/publication.lock",
      owner: { version: 1, pid, processStartTime: null, nonce: "owner" },
    },
  },
);

type Harness = {
  daemon: DaemonInstance;
  lockCalls: () => number;
  cwd: string;
  post: (path: string, body?: Record<string, unknown>) => Promise<Response>;
};

/**
 * A daemon whose consumer lock throws the refusal chosen for each attempt
 * before it grants the lock. Requests carry an empty body, so a built-in route
 * that is admitted answers 400 or 200 and one that is not answers 500 or 503.
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
  const home = mkdtempSync(join(tmpdir(), "lcm-admission-retry-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const lcmDir = join(home, ".lcm");
  mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
  const configPath = join(lcmDir, "config.json");
  writeFileSync(configPath, "{}\n", { mode: 0o600 });
  const cwd = join(home, "project");
  mkdirSync(cwd, { mode: 0o700 });
  let attempts = 0;
  let daemon: DaemonInstance | undefined;
  try {
    daemon = await createDaemon(loadDaemonConfig(configPath, {
      daemon: { port: 0, idleTimeoutMs: 0 },
    }), {
      publicationConfigPath: configPath,
      _assertBackendPublication: () => undefined,
      _withBackendPublicationConsumerLockAsync: (async (
        _homeDir: string | undefined,
        callback: (token: BackendPublicationLockToken) => Promise<unknown> | unknown,
      ) => {
        attempts += 1;
        const refusal = settings.refusal(attempts);
        if (refusal !== undefined) throw refusal;
        return callback({} as BackendPublicationLockToken);
      }) as DaemonOptions["_withBackendPublicationConsumerLockAsync"],
      ...settings.options,
    });
    const running = daemon;
    await scenario({
      daemon: running,
      lockCalls: () => attempts,
      cwd,
      post: (path, body = {}) => fetch("http://127.0.0.1:" + running.address().port + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
  } finally {
    await daemon?.stop();
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
}

afterEach(() => vi.restoreAllMocks());

describe("capture route admission while a live process holds the publication lock", () => {
  it.each(["/ingest", "/restore"])("admits %s after the owner releases the lock", async (path) => {
    await withDaemon({ refusal: (attempt) => (attempt <= 2 ? liveContention() : undefined) }, async (harness) => {
      const response = await harness.post(path);

      expect(response.status).toBeLessThan(500);
      // Two refused attempts and the one that was granted, all before the handler ran.
      expect(harness.lockCalls()).toBeGreaterThanOrEqual(3);
    });
  });

  it.each(["/ingest", "/restore"])("admits %s after a live owner in the daemon's own process releases the lock", async (path) => {
    await withDaemon({ refusal: (attempt) => (attempt <= 2 ? liveContention(process.pid) : undefined) }, async (harness) => {
      const response = await harness.post(path);

      expect(response.status).toBeLessThan(500);
      expect(harness.lockCalls()).toBeGreaterThanOrEqual(3);
    });
  });

  it.each(["/ingest", "/restore"])("stops waiting for %s once its allowance is spent", async (path) => {
    // Each refused attempt moves the clock 50 ms, as one pause would.
    let now = 0;
    await withDaemon({
      refusal: () => {
        now += 50;
        return liveContention();
      },
      options: { _routeAdmissionWaitMs: 100, _routeAdmissionNow: () => now },
    }, async (harness) => {
      const response = await harness.post(path);

      expect(response.status).toBe(500);
      expect(harness.lockCalls()).toBe(3);
    });
  });

  it("counts the allowance from the first wait across the preflight and the handler admission", async () => {
    let now = 0;
    await withDaemon({
      refusal: (attempt) => {
        // Attempt 1 is refused (the clock starts), attempt 2 is the preflight's
        // admission. The handler's admission comes after 5 s of request work.
        if (attempt === 2) return undefined;
        if (attempt >= 3) now += 5_000;
        return liveContention();
      },
      options: { _routeAdmissionNow: () => now },
    }, async (harness) => {
      await harness.post("/restore", { cwd: harness.cwd, session_id: "s1" });

      // The deadline passed during the request work, so the handler gets no pause.
      expect(harness.lockCalls()).toBe(3);
    });
  });

  it("still waits in a later scope while the deadline from the first wait has not passed", async () => {
    let now = 0;
    await withDaemon({
      refusal: (attempt) => {
        if (attempt === 1 || attempt === 3 || attempt === 4) {
          now += 100;
          return liveContention();
        }
        return undefined;
      },
      options: { _routeAdmissionNow: () => now },
    }, async (harness) => {
      await harness.post("/restore", { cwd: harness.cwd, session_id: "s1" });

      // Preflight: refused then admitted; handler: refused twice, then admitted.
      expect(harness.lockCalls()).toBeGreaterThanOrEqual(5);
    });
  });

  it("does not wait for operation-scoped routes that did not opt in", async () => {
    await withDaemon({ refusal: () => liveContention() }, async (harness) => {
      expect((await harness.post("/promote")).status).toBe(500);
      expect(harness.lockCalls()).toBe(1);
    });
  });

  it.each([
    ["ambiguous contention", () => new PrivateMutationLockContentionError("owner state is ambiguous"), 500],
    ["a publication journal error", () => new BackendPublicationJournalError("unresolved-publication", "unresolved"), 503],
  ])("does not wait for %s", async (_name, refusal, status) => {
    await withDaemon({ refusal }, async (harness) => {
      expect((await harness.post("/ingest")).status).toBe(status);
      expect(harness.lockCalls()).toBe(1);
    });
  });

  it("never replays an admission whose callback has started", async () => {
    // Startup also runs the assertion, so it only refuses once requests begin.
    let requestsBegan = false;
    await withDaemon({
      refusal: () => undefined,
      options: { _assertBackendPublication: () => { if (requestsBegan) throw liveContention(); } },
    }, async (harness) => {
      requestsBegan = true;
      expect((await harness.post("/ingest")).status).toBe(500);
      expect(harness.lockCalls()).toBe(1);
    });
  });

  it("ends the wait when the daemon shuts down", async () => {
    await withDaemon({ refusal: () => liveContention() }, async (harness) => {
      const response = harness.post("/ingest").catch(() => undefined);
      await vi.waitFor(() => expect(harness.lockCalls()).toBeGreaterThanOrEqual(2), { timeout: 3_000 });

      await harness.daemon.stop();
      await response;
    });
  });
});
