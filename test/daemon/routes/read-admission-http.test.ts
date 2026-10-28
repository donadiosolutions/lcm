import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDaemon,
  sendJson,
  type DaemonInstance,
  type DaemonOptions,
  type RouteExecutionContext,
} from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { recoverMachineIdentity } from "../../../src/machine-identity.js";
import { clearProjectMapCache, resolveProjectIdentity, setRemoteProjectBinding } from "../../../src/project-map.js";
import { PrivateMutationLockContentionError } from "../../../src/private-mutation-lock.js";
import { withBackendPublicationConsumerLockAsync } from "../../../src/storage/backend-publication.js";
import type { ProjectStorage, StorageBackendFactory } from "../../../src/storage/index.js";
import { makeMockStorageFactory, makeStagedPostgreSqlStorageFactory } from "./mock-storage-factory.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("read admission test did not settle")), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

afterEach(() => vi.restoreAllMocks());

const liveContention = (pid: number): PrivateMutationLockContentionError => new PrivateMutationLockContentionError(
  "backend publication mutation is already in progress (owned by live PID)",
  {
    contendedLock: {
      path: "/lcm/publication.lock",
      owner: { version: 1, pid, processStartTime: null, nonce: "owner" },
    },
  },
);
/** Another process, such as a hook, holds the lock. */
const foreignOwner = (): PrivateMutationLockContentionError => liveContention(process.pid + 1);
/** This daemon holds the lock through an unqueued flow of its own. */
const sameProcessOwner = (): PrivateMutationLockContentionError => liveContention(process.pid);

/**
 * A PostgreSQL factory for /search whose unadmitted prefix always contends, as
 * it does while the daemon's own publication work holds the lock, and whose
 * admitted open (one that carries a publication token) succeeds.
 */
function makeSearchFactory(storage: { unadmitted: number; admitted: number }): StorageBackendFactory {
  const project = {
    lexicalSearch: { searchPromoted: async () => [{ id: "memory-1" }] },
    close: async () => undefined,
  } as unknown as ProjectStorage;
  const base = makeMockStorageFactory({ openProject: async () => project });
  return {
    ...base,
    backend: "postgresql",
    openExistingProject: async (_identity, token) => {
      if (token === undefined) {
        storage.unadmitted += 1;
        throw foreignOwner();
      }
      storage.admitted += 1;
      return project;
    },
  };
}

/**
 * Capture the daemon's queue deadline timers (exact delay) so a test can move
 * the injected clock and deliver the timers that clock makes due, together.
 */
function trackDeadlineTimers(clock: { now: number }, delay: number) {
  type Tracked = { callback: () => void; fireAt: number; handle: unknown; settled: boolean };
  const tracked: Tracked[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
    const handle = realSetTimeout(callback, ms, ...args);
    if (ms === delay && typeof callback === "function") {
      tracked.push({ callback: () => callback(...args), fireAt: clock.now + delay, handle, settled: false });
      for (const waiter of waiters) if (tracked.length >= waiter.count) waiter.resolve();
    }
    return handle;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle?: Parameters<typeof clearTimeout>[0]) => {
    for (const timer of tracked) if (timer.handle === handle) timer.settled = true;
    return realClearTimeout(handle);
  }) as typeof clearTimeout);
  return {
    /** Resolves once `count` deadline timers have been armed in total. */
    registered: (count: number): Promise<void> => new Promise(resolve => {
      if (tracked.length >= count) resolve();
      else waiters.push({ count, resolve });
    }),
    /** Advance the injected clock, then deliver every armed timer it makes due. */
    elapse: (milliseconds: number): void => {
      clock.now += milliseconds;
      for (const timer of tracked) {
        if (timer.settled || timer.fireAt > clock.now) continue;
        timer.settled = true;
        timer.callback();
      }
    },
  };
}

type Probe = (
  context: RouteExecutionContext,
  request: { aborted: () => void },
) => Promise<unknown>;

type Fixture = {
  home: string;
  daemon: DaemonInstance;
  /** Run a probe inside a registered "read" route; resolves with its outcome. */
  probe: (probe: Probe, signal?: AbortSignal) => Promise<{ outcome: unknown; contextSeen: RouteExecutionContext }>;
  waitForCancellation: () => Promise<void>;
  /** Hold one background publication phase; the optional follow-up is requested on release. */
  holdBackground: (options?: {
    releaseOnShutdown?: boolean;
    followUp?: (admission: Parameters<NonNullable<DaemonOptions["_scanForTranscripts"]>>[0]) => Promise<unknown>;
  }) => Promise<{ release: () => void; done: Promise<void> }>;
  events: string[];
  /** Project bound to a remote id, for /search (present with `bound`). */
  search: (signal?: AbortSignal) => Promise<Response>;
  /** Scripted consumer-lock attempts; assigning `refusal` arms the script. */
  lock: {
    attempts: number;
    refusal?: (attempt: number) => unknown;
    onAttempt?: (attempt: number) => void;
    onGrant?: () => void;
  };
  /** Prefix opens the search factory saw, with and without a publication token. */
  storage: { unadmitted: number; admitted: number };
  /** Injected clock (present with `clock`). */
  clock: { now: number };
};

async function withDaemon(
  options: {
    postgresql: boolean;
    readAdmissionWaitMs?: number;
    daemonOptions?: DaemonOptions;
    /** Bind a project and serve /search from a factory whose unadmitted prefix always contends. */
    bound?: boolean;
    /** Drive the read and capture waits from `clock` instead of the monotonic clock. */
    clock?: boolean;
  },
  operation: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "lcm-read-admission-"));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  clearProjectMapCache();
  const root = join(home, ".lcm");
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  const configPath = join(root, "config.json");
  writeFileSync(configPath, "{}\n", { mode: 0o600 });
  const caPath = join(home, "postgres-ca.pem");
  writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n", { mode: 0o600 });
  let runScan!: () => Promise<void>;
  let scanOperation: NonNullable<DaemonOptions["_scanForTranscripts"]> = async () => undefined;
  const cancellation = { current: deferred() };
  const events: string[] = [];
  const releases: (() => void)[] = [];
  const scans: Promise<void>[] = [];
  let daemon: DaemonInstance | undefined;
  const lock: Fixture["lock"] = { attempts: 0 };
  const storage = { unadmitted: 0, admitted: 0 };
  const clock = { now: 0 };
  const cwd = join(home, "project");
  const realSetInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 600_000 && typeof callback === "function") runScan = () => Promise.resolve(callback(...args));
    return realSetInterval(callback, delay, ...args);
  }) as typeof setInterval);
  try {
    const config = options.postgresql
      ? loadDaemonConfig("/nonexistent", {
        storage: { backend: "postgresql" },
        daemon: { port: 0, idleTimeoutMs: 0 },
        summarizer: { mock: true },
      }, {
        LCM_POSTGRES_URL: "postgresql://user:secret@db.example.test/lcm",
        LCM_POSTGRES_CA_FILE: caPath,
        LCM_POSTGRES_MIGRATION_ROLE: "lcm_test_migrator",
      })
      : loadDaemonConfig(configPath, { daemon: { port: 0, idleTimeoutMs: 0 }, summarizer: { mock: true } });
    if (options.bound) {
      mkdirSync(cwd, { mode: 0o700 });
      recoverMachineIdentity({
        version: 1,
        identityKey: `machine:${"a".repeat(64)}`,
        machineId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012",
        displayName: "Test machine",
      });
      setRemoteProjectBinding("018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020", { hash: resolveProjectIdentity(cwd).id });
    }
    daemon = await createDaemon(config, {
      publicationConfigPath: configPath,
      _assertBackendPublication: () => undefined,
      ...(options.postgresql
        ? {
          _createStorageBackendFactory: async () => options.bound
            ? makeSearchFactory(storage)
            : makeStagedPostgreSqlStorageFactory(),
          _withBackendPublicationConsumerLockAsync: (async (...args: Parameters<typeof withBackendPublicationConsumerLockAsync>) => {
            if (lock.refusal === undefined) return withBackendPublicationConsumerLockAsync(...args);
            lock.attempts += 1;
            lock.onAttempt?.(lock.attempts);
            const refusal = lock.refusal(lock.attempts);
            if (refusal !== undefined) throw refusal;
            lock.onGrant?.();
            return withBackendPublicationConsumerLockAsync(...args);
          }) as DaemonOptions["_withBackendPublicationConsumerLockAsync"],
        }
        : {}),
      ...(options.clock ? { _routeAdmissionNow: () => clock.now } : {}),
      ...(options.readAdmissionWaitMs === undefined ? {} : { _readAdmissionWaitMs: options.readAdmissionWaitMs }),
      _scanForTranscripts: (admission, signal) => scanOperation(admission, signal),
      _onRequestLifecycle: event => { if (event === "cancelled") cancellation.current.resolve(); },
      ...options.daemonOptions,
    });
    const activeDaemon = daemon;
    let activeProbe!: Probe;
    let observed: { outcome: unknown; contextSeen: RouteExecutionContext } | undefined;
    activeDaemon.registerRoute("POST", "/probe", async (req, res, _body, context) => {
      const contextSeen = context ?? {};
      let outcome: unknown;
      try {
        outcome = { value: await activeProbe(contextSeen, { aborted: () => { req.emit("aborted"); } }) };
      } catch (error) {
        outcome = { error };
      }
      observed = { outcome, contextSeen };
      sendJson(res, 200, { done: true });
    }, "read");
    await operation({
      home, daemon: activeDaemon, events,
      lock, storage, clock,
      search: signal => fetch("http://127.0.0.1:" + activeDaemon.address().port + "/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "memory", cwd, layers: ["promoted"] }),
        ...(signal === undefined ? {} : { signal }),
      }),
      probe: async (probe, signal) => {
        activeProbe = probe;
        observed = undefined;
        await fetch("http://127.0.0.1:" + activeDaemon.address().port + "/probe", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal,
        }).catch(() => undefined);
        // An aborted client never receives a body; wait for the handler to record its outcome.
        for (let attempt = 0; observed === undefined && attempt < 500; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (observed === undefined) throw new Error("probe handler did not finish");
        return observed;
      },
      waitForCancellation: () => bounded(cancellation.current.promise).then(() => { cancellation.current = deferred(); }),
      holdBackground: async (hold = {}) => {
        const entered = deferred();
        const release = deferred();
        releases.push(release.resolve);
        scanOperation = async (admission, signal) => {
          await admission(async () => {
            if (hold.releaseOnShutdown) signal?.addEventListener("abort", release.resolve, { once: true });
            events.push("bg-held");
            entered.resolve();
            await release.promise;
          });
          if (hold.followUp) await hold.followUp(admission);
        };
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

function isContention(error: unknown): boolean {
  return error instanceof PrivateMutationLockContentionError;
}

describe("daemon PostgreSQL read admission", () => {
  it("offers the bounded read admission only to PostgreSQL read routes", async () => {
    await withDaemon({ postgresql: true }, async ({ probe }) => {
      const { outcome, contextSeen } = await probe(async () => "ran");
      expect(outcome).toEqual({ value: "ran" });
      expect(contextSeen.withReadAdmission).toBeTypeOf("function");
      expect(contextSeen.withPublicationAdmission).toBeUndefined();
      expect(contextSeen.publicationLockToken).toBeUndefined();
    });
  });

  it("does not offer the read admission on SQLite", async () => {
    await withDaemon({ postgresql: false }, async ({ probe }) => {
      const { outcome, contextSeen } = await probe(async () => "ran");
      expect(outcome).toEqual({ value: "ran" });
      expect(contextSeen.withReadAdmission).toBeUndefined();
    });
  });

  it("runs an uncontended admitted prefix with a publication token", async () => {
    await withDaemon({ postgresql: true }, async ({ probe }) => {
      const { outcome } = await probe(context => context.withReadAdmission!(async token => typeof token));
      expect(outcome).toEqual({ value: "object" });
    });
  });

  it("waits behind a background phase and runs before the next background phase", async () => {
    await withDaemon({ postgresql: true, readAdmissionWaitMs: 30_000 }, async ({ probe, holdBackground, events }) => {
      const hold = await holdBackground({
        // Requested only after the held phase releases: the queued read is already ahead of it.
        followUp: admission => admission(async () => { events.push("bg-next"); }),
      });
      const queued = deferred();
      const read = probe(async context => {
        const admitted = context.withReadAdmission!(async () => { events.push("read-prefix"); return "read"; });
        queued.resolve();
        return admitted;
      });
      await bounded(queued.promise);
      expect(events).toEqual(["bg-held"]);
      hold.release();
      expect((await bounded(read)).outcome).toEqual({ value: "read" });
      await hold.done;
      expect(events).toEqual(["bg-held", "read-prefix", "bg-next"]);
    });
  });

  it("returns contention when the turn is not granted in time, keeping the request signal and queue usable", async () => {
    await withDaemon({ postgresql: true, readAdmissionWaitMs: 25 }, async ({ probe, holdBackground }) => {
      const hold = await holdBackground();
      const { outcome } = await probe(async context => {
        try {
          await context.withReadAdmission!(async () => "must not run");
        } catch (error) {
          return { error, aborted: context.signal?.aborted };
        }
        return "unexpected";
      });
      const result = (outcome as { value: { error: Error; aborted: boolean } }).value;
      expect(isContention(result.error)).toBe(true);
      expect(result.error.message).toBe("daemon publication work is in progress; retry the read");
      expect(result.aborted).toBe(false);
      hold.release();
      await hold.done;
      const { outcome: later } = await probe(context => context.withReadAdmission!(async () => "usable"));
      expect(later).toEqual({ value: "usable" });
    });
  });

  it("does not cancel a prefix that entered before the deadline", async () => {
    await withDaemon({ postgresql: true, readAdmissionWaitMs: 20 }, async ({ probe }) => {
      const { outcome } = await probe(context => context.withReadAdmission!(async () => {
        await new Promise(resolve => setTimeout(resolve, 120));
        return "finished after the budget";
      }));
      expect(outcome).toEqual({ value: "finished after the budget" });
    });
  });

  it("leaves a failure after entry unchanged even when it lands past the deadline", async () => {
    await withDaemon({ postgresql: true, readAdmissionWaitMs: 20 }, async ({ probe }) => {
      const failure = new Error("prefix failed after entry");
      const { outcome } = await probe(context => context.withReadAdmission!(async () => {
        await new Promise(resolve => setTimeout(resolve, 120));
        throw failure;
      }));
      expect((outcome as { error: unknown }).error).toBe(failure);
    });
  });

  it("answers the lock's contention, not the queue expiry, when a live owner outlasts the allowance", async () => {
    await withDaemon({ postgresql: true, readAdmissionWaitMs: 100 }, async ({ home, probe }) => {
      await withBackendPublicationConsumerLockAsync(home, async () => {
        const { outcome } = await probe(async context => {
          try {
            await context.withReadAdmission!(async () => "must not run");
          } catch (error) {
            return error;
          }
          return "unexpected";
        });
        const error = (outcome as { value: Error }).value;
        expect(isContention(error)).toBe(true);
        expect(error.message).toContain("owned by live PID");
        expect(error.message).not.toBe("daemon publication work is in progress; retry the read");
      });
    });
  });

  it("reports a client abort while queued as an abort, not as contention", async () => {
    await withDaemon({ postgresql: true, readAdmissionWaitMs: 30_000 }, async ({ probe, holdBackground, waitForCancellation }) => {
      const hold = await holdBackground();
      const controller = new AbortController();
      const queued = deferred();
      const read = probe(async context => {
        const admitted = context.withReadAdmission!(async () => "must not run");
        queued.resolve();
        return admitted;
      }, controller.signal);
      await bounded(queued.promise);
      controller.abort();
      await waitForCancellation();
      const { outcome } = await bounded(read);
      const error = (outcome as { error: Error }).error;
      expect(error.name).toBe("AbortError");
      expect(isContention(error)).toBe(false);
      hold.release();
      await hold.done;
    });
  });

  it("aborts a queued read when the daemon shuts down", async () => {
    await withDaemon({ postgresql: true, readAdmissionWaitMs: 30_000 }, async ({ daemon, probe, holdBackground }) => {
      await holdBackground({ releaseOnShutdown: true });
      const queued = deferred();
      const read = probe(async context => {
        const admitted = context.withReadAdmission!(async () => "must not run");
        queued.resolve();
        return admitted;
      });
      await bounded(queued.promise);
      await bounded(daemon.stop());
      const { outcome } = await bounded(read);
      const error = (outcome as { error: Error }).error;
      expect(error.name).toBe("AbortError");
      expect(isContention(error)).toBe(false);
    });
  });

  it("lets a client abort win when it lands after the deadline fired but before the rejection is observed", async () => {
    const budget = 7_777;
    const deadlines: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === budget && typeof callback === "function") deadlines.push(() => callback(...args));
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    // A fixed injected clock keeps the timer's delay exactly the budget.
    await withDaemon({ postgresql: true, readAdmissionWaitMs: budget, clock: true }, async ({ probe, holdBackground }) => {
      const hold = await holdBackground();
      const queued = deferred();
      let abortRequest!: () => void;
      const read = probe(async (context, request) => {
        abortRequest = request.aborted;
        const admitted = context.withReadAdmission!(async () => "must not run").catch((error: unknown) => ({
          error,
          aborted: context.signal?.aborted,
        }));
        queued.resolve();
        return admitted;
      });
      await bounded(queued.promise);
      expect(deadlines).toHaveLength(1);
      // Same task: the deadline fires first, then the client goes away.
      deadlines[0]!();
      abortRequest();
      const result = (await bounded(read)).outcome as { value: { error: Error; aborted: boolean } };
      expect(result.value.error.name).toBe("AbortError");
      expect(isContention(result.value.error)).toBe(false);
      expect(result.value.aborted).toBe(true);
      hold.release();
      await hold.done;
    });
  });
});

describe("daemon PostgreSQL read admission waits for a live lock owner (#1774)", () => {
  const search = { postgresql: true, bound: true, clock: true } as const;
  const searchBody = { episodic: [], promoted: [{ id: "memory-1" }] };

  it("answers /search 200 once a live foreign owner and then a live owner in this process release the lock", async () => {
    await withDaemon(search, async ({ lock, storage, search: post }) => {
      lock.refusal = attempt => attempt === 1 ? foreignOwner() : attempt === 2 ? sameProcessOwner() : undefined;

      const response = await bounded(post());

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(searchBody);
      // Two refused acquisitions and the granted one: the prefix entered once, admitted.
      expect(lock.attempts).toBe(3);
      expect(storage).toEqual({ unadmitted: 1, admitted: 1 });
    });
  });

  it("answers a retryable 503 from /search once the live owner outlasts the allowance", async () => {
    await withDaemon({ ...search, readAdmissionWaitMs: 100 }, async ({ lock, storage, clock, search: post }) => {
      // Each refused attempt moves the clock 50 ms, as one pause would.
      lock.refusal = () => {
        clock.now += 50;
        return foreignOwner();
      };

      const response = await bounded(post());

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ backend: "postgresql", operation: "search", retryable: true });
      expect(lock.attempts).toBe(2);
      expect(storage.admitted).toBe(0);
    });
  });

  it("serves two overlapping reads through a live holder that outlasts the old one-second budget", async () => {
    await withDaemon({ ...search, readAdmissionWaitMs: 4_321 }, async ({ lock, storage, clock, search: post }) => {
      const timers = trackDeadlineTimers(clock, 4_321);
      const holder = { live: true };
      const firstWaiting = deferred();
      lock.refusal = () => holder.live ? foreignOwner() : undefined;
      // The third refusal shows the first read waiting inside its acquisition, holding the slot.
      lock.onAttempt = attempt => { if (attempt === 3) firstWaiting.resolve(); };

      const first = post();
      await bounded(firstWaiting.promise);
      const second = post();
      // The second read's queue deadline is armed: it is enqueued behind the first.
      await bounded(timers.registered(2));
      // The holder lasts 2 s: past the old 1 s queue budget, inside the 4.321 s allowance.
      timers.elapse(2_000);
      holder.live = false;

      const [firstResponse, secondResponse] = await Promise.all([bounded(first), bounded(second)]);
      expect([firstResponse.status, secondResponse.status]).toEqual([200, 200]);
      expect(await firstResponse.json()).toEqual(searchBody);
      expect(await secondResponse.json()).toEqual(searchBody);
      expect(storage).toEqual({ unadmitted: 2, admitted: 2 });
    });
  });

  it("answers a retryable 503 without entering the prefix when the turn is not granted within the allowance", async () => {
    await withDaemon({ ...search, readAdmissionWaitMs: 4_321 }, async ({ lock, storage, clock, holdBackground, search: post }) => {
      const hold = await holdBackground();
      const timers = trackDeadlineTimers(clock, 4_321);
      lock.refusal = () => undefined;

      const read = post();
      await bounded(timers.registered(1));
      timers.elapse(5_000);

      const response = await bounded(read);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ backend: "postgresql", operation: "search", retryable: true });
      expect(storage.admitted).toBe(0);
      expect(lock.attempts).toBe(0);

      hold.release();
      await hold.done;
      // The queue is still usable after the expired wait.
      expect((await bounded(post())).status).toBe(200);
    });
  });

  it("starts the allowance at the first admission and gives a later admission of the request no fresh one", async () => {
    await withDaemon({ postgresql: true, clock: true, readAdmissionWaitMs: 4_000 }, async ({ lock, clock, probe }) => {
      lock.refusal = attempt => {
        if (attempt === 1) return undefined;
        clock.now += 50;
        return foreignOwner();
      };

      const { outcome } = await probe(async context => {
        // The first admission itself uses 3.9 s of the shared 4 s allowance.
        await context.withReadAdmission!(async () => { clock.now += 3_900; });
        return context.withReadAdmission!(async () => "must not run").catch((error: unknown) => error);
      });

      const error = (outcome as { value: Error }).value;
      expect(isContention(error)).toBe(true);
      expect(error.message).toContain("owned by live PID");
      // The second admission was refused at 3.95 s and at 4 s, where nothing was left to wait for.
      expect(lock.attempts).toBe(3);
    });
  });

  it("arms the default allowance at four seconds from the first admission", async () => {
    await withDaemon({ postgresql: true, clock: true }, async ({ probe }) => {
      const { outcome } = await probe(async context => {
        const spy = vi.spyOn(globalThis, "setTimeout");
        // The deadline timer is armed synchronously by the admission call.
        const admitted = context.withReadAdmission!(async () => "ran");
        const delays = spy.mock.calls.map(call => call[1]);
        spy.mockRestore();
        return { delays, result: await admitted };
      });

      expect(outcome).toEqual({ value: { delays: [4_000], result: "ran" } });
    });
  });

  it.each([
    ["is available at once", undefined],
    ["is refused", foreignOwner()],
  ])("lets an admission that starts past the allowance make one attempt when the lock %s", async (_name, refusal) => {
    await withDaemon({ postgresql: true, clock: true, readAdmissionWaitMs: 4_000 }, async ({ lock, clock, probe }) => {
      lock.refusal = attempt => attempt === 1 ? undefined : refusal;

      const { outcome } = await probe(async context => {
        await context.withReadAdmission!(async () => { clock.now += 5_000; });
        return context.withReadAdmission!(async () => "second").catch((error: unknown) => error);
      });

      const result = (outcome as { value: unknown }).value;
      if (refusal === undefined) expect(result).toBe("second");
      else expect(result).toBe(refusal);
      expect(lock.attempts).toBe(2);
    });
  });

  it("answers the queue expiry when an admission that starts past the allowance finds the queue busy", async () => {
    await withDaemon({ postgresql: true, clock: true, readAdmissionWaitMs: 4_000 }, async ({ lock, clock, probe, holdBackground }) => {
      lock.refusal = () => undefined;

      const { outcome } = await probe(async context => {
        await context.withReadAdmission!(async () => { clock.now += 5_000; });
        const hold = await holdBackground();
        const second = await context.withReadAdmission!(async () => "must not run").catch((error: unknown) => error);
        hold.release();
        await hold.done;
        return second;
      });

      const error = (outcome as { value: Error }).value;
      expect(isContention(error)).toBe(true);
      expect(error.message).toBe("daemon publication work is in progress; retry the read");
    });
  });

  it("reports the request's cancellation, not contention, when it ends during the wait for the lock", async () => {
    await withDaemon({ postgresql: true, clock: true }, async ({ lock, probe }) => {
      const waiting = deferred();
      lock.refusal = () => foreignOwner();
      lock.onAttempt = attempt => { if (attempt === 2) waiting.resolve(); };

      const { outcome } = await probe(async (context, request) => {
        const admitted = context.withReadAdmission!(async () => "must not run").catch((error: unknown) => ({
          error,
          aborted: context.signal?.aborted,
        }));
        await waiting.promise;
        request.aborted();
        return admitted;
      });

      const result = (outcome as { value: { error: Error; aborted: boolean } }).value;
      expect(result.error.name).toBe("AbortError");
      expect(isContention(result.error)).toBe(false);
      expect(result.aborted).toBe(true);
    });
  });

  it("reports the operation's cancellation, not contention, when only its own signal ends during the wait", async () => {
    await withDaemon({ postgresql: true, clock: true }, async ({ lock, probe }) => {
      const waiting = deferred();
      const operation = new AbortController();
      lock.refusal = () => foreignOwner();
      lock.onAttempt = attempt => { if (attempt === 2) waiting.resolve(); };

      const { outcome } = await probe(async context => {
        const admitted = context.withReadAdmission!(async () => "must not run", operation.signal).catch((error: unknown) => ({
          error,
          aborted: context.signal?.aborted,
        }));
        await waiting.promise;
        operation.abort();
        return admitted;
      });

      const result = (outcome as { value: { error: Error; aborted: boolean } }).value;
      expect(result.error.name).toBe("AbortError");
      expect(isContention(result.error)).toBe(false);
      expect(result.aborted).toBe(false);
    });
  });

  it("does not enter the prefix when the request ends between the acquisition and the callback", async () => {
    await withDaemon({ postgresql: true, clock: true }, async ({ lock, probe }) => {
      const operation = new AbortController();
      let entries = 0;
      lock.refusal = () => undefined;
      lock.onGrant = () => operation.abort();

      const { outcome } = await probe(context => context.withReadAdmission!(async () => {
        entries += 1;
      }, operation.signal).catch((error: unknown) => error));

      expect((outcome as { value: Error }).value.name).toBe("AbortError");
      expect(entries).toBe(0);
      expect(lock.attempts).toBe(1);
    });
  });

  it("never replays a prefix that failed with contention after it entered", async () => {
    await withDaemon({ postgresql: true, clock: true }, async ({ lock, probe }) => {
      const failure = foreignOwner();
      let entries = 0;
      lock.refusal = () => undefined;

      const { outcome } = await probe(context => context.withReadAdmission!(async () => {
        entries += 1;
        throw failure;
      }).catch((error: unknown) => error));

      expect((outcome as { value: unknown }).value).toBe(failure);
      expect(entries).toBe(1);
      expect(lock.attempts).toBe(1);
    });
  });

  it("rejects a nested admission at once instead of waiting for it", async () => {
    await withDaemon({ postgresql: true, clock: true }, async ({ lock, probe }) => {
      lock.refusal = () => undefined;

      const { outcome } = await probe(context => context.withReadAdmission!(
        async () => context.withReadAdmission!(async () => "inner"),
      ).catch((error: unknown) => error));

      const error = (outcome as { value: Error }).value;
      expect(isContention(error)).toBe(true);
      expect(error.message).toContain("nested daemon admission");
      expect(lock.attempts).toBe(1);
    });
  });
});
