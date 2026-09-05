import { describe, expect, it, vi } from "vitest";
import {
  capturePublicationIdentity,
  createPublicationConvergence,
  withPublicationAdmissionRetry,
  type PublicationConvergenceDeps,
} from "../../src/storage/publication-convergence.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";

const identity = {
  pid: 42,
  version: "1.0.0",
  storageBackend: "sqlite" as const,
  entrypoint: "/opt/lcm.mjs",
  runtimeDigest: "a".repeat(64),
};

function healthFetch(pid = 42, overrides: Record<string, unknown> = {}): typeof globalThis.fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({
      status: "ok", pid, version: "1.0.0", storageBackend: "sqlite",
      entrypoint: "/opt/lcm.mjs", runtimeDigest: "a".repeat(64), ...overrides,
    }),
  })) as unknown as typeof globalThis.fetch;
}

function deps(overrides: Partial<PublicationConvergenceDeps> = {}): PublicationConvergenceDeps {
  return {
    fetch: healthFetch(),
    readToken: () => "token",
    readOwner: () => ({ version: 1, pid: 42, processStartTime: "birth", nonce: "a".repeat(32) }),
    processBirth: () => "birth",
    platform: "linux",
    lockPath: "/tmp/lock",
    ...overrides,
  };
}

describe("publication convergence", () => {
  it("captures a fully authenticated identity and rejects drift", async () => {
    await expect(capturePublicationIdentity({
      port: 3737, expectedVersion: undefined, expectedStorageBackend: "sqlite",
      expectedEntrypoint: "/opt/lcm.mjs", expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps(),
    })).resolves.toBeUndefined();
    await expect(capturePublicationIdentity({
      port: 3737, expectedVersion: "1.0.0", expectedStorageBackend: "sqlite",
      expectedEntrypoint: identity.entrypoint, expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps({ fetch: vi.fn(async () => ({ ok: true, json: async () => "malformed" })) as unknown as typeof globalThis.fetch }),
    })).resolves.toBeUndefined();
    await expect(capturePublicationIdentity({
      port: 3737, expectedVersion: "1.0.0", expectedStorageBackend: "sqlite",
      expectedEntrypoint: identity.entrypoint, expectedRuntimeDigest: identity.runtimeDigest,
    })).resolves.toBeUndefined();
    await expect(capturePublicationIdentity({
      port: 3737, expectedVersion: "1.0.0", expectedStorageBackend: "sqlite",
      expectedEntrypoint: "/opt/lcm.mjs", expectedRuntimeDigest: "a".repeat(64),
      deps: deps(),
    })).resolves.toEqual(identity);
    await expect(capturePublicationIdentity({
      port: 3737, expectedVersion: "1.0.0", expectedStorageBackend: "sqlite",
      expectedEntrypoint: "/opt/lcm.mjs", expectedRuntimeDigest: "b".repeat(64),
      deps: deps(),
    })).resolves.toBeUndefined();
    await expect(capturePublicationIdentity({
      port: 3737, expectedVersion: "1.0.0", expectedStorageBackend: "sqlite",
      expectedEntrypoint: "/different", expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps(),
    })).resolves.toBeUndefined();
    await expect(capturePublicationIdentity({
      port: 3737, expectedVersion: "1.0.0", expectedStorageBackend: "sqlite",
      expectedEntrypoint: identity.entrypoint, expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps({ fetch: undefined }),
    })).resolves.toBeUndefined();
  });

  it("uses empty defaults for a convergence without injected dependencies", () => {
    expect(createPublicationConvergence({ port: 3737 }).deps).toEqual({});
  });

  it("accepts an authenticated staged PostgreSQL health response", async () => {
    const staged = {
      status: "unavailable",
      pid: 42,
      version: "1.0.0",
      storageBackend: "postgresql",
      entrypoint: "/opt/lcm.mjs",
      runtimeDigest: "a".repeat(64),
      uptime: 1,
      storage: {
        status: "unavailable",
        error: {
          code: "STORAGE_INITIALIZATION_FAILED",
          backend: "postgresql",
          domain: "factory",
          operation: "health",
        },
      },
    };
    const fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => staged }));
    await expect(capturePublicationIdentity({
      port: 3737, expectedVersion: "1.0.0", expectedStorageBackend: "postgresql",
      expectedEntrypoint: identity.entrypoint, expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps({ fetch: fetch as unknown as typeof globalThis.fetch }),
    })).resolves.toMatchObject({ pid: 42, storageBackend: "postgresql" });
  });

  it("bounds health probes and handles fetch failures", async () => {
    vi.useFakeTimers();
    try {
      const pending = capturePublicationIdentity({
        port: 3737, expectedVersion: identity.version, expectedStorageBackend: identity.storageBackend,
        expectedEntrypoint: identity.entrypoint, expectedRuntimeDigest: identity.runtimeDigest,
        deps: deps({ fetch: vi.fn(() => new Promise<Response>(() => {})) as typeof globalThis.fetch }),
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    await expect(capturePublicationIdentity({
      port: 3737, expectedVersion: identity.version, expectedStorageBackend: identity.storageBackend,
      expectedEntrypoint: identity.entrypoint, expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps({ fetch: vi.fn(async () => { throw new Error("network"); }) as typeof globalThis.fetch }),
    })).resolves.toBeUndefined();
  });

  it("retries contention for the pinned owner and preserves the first error at exhaustion", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const convergence = createPublicationConvergence({
      port: 3737, identity, expectedEntrypoint: identity.entrypoint,
      expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps({ now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } }),
    });
    let attempts = 0;
    await expect(withPublicationAdmissionRetry(() => {
      attempts += 1;
      if (attempts < 3) throw new PrivateMutationLockContentionError("busy");
      return "ok";
    }, convergence)).resolves.toBe("ok");
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([50, 50]);

    let exhaustedNow = 0;
    let exhaustedAttempts = 0;
    const exhaustedErrors = [
      new PrivateMutationLockContentionError("first exhausted"),
      new PrivateMutationLockContentionError("second exhausted"),
      new PrivateMutationLockContentionError("third exhausted"),
    ];
    const exhausted = createPublicationConvergence({
      port: 3737,
      identity,
      expectedEntrypoint: identity.entrypoint,
      expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps({ now: () => exhaustedNow, sleep: async (ms) => { exhaustedNow += ms; } }),
    });
    const exhaustedFirst = exhaustedErrors[0];
    await expect(withPublicationAdmissionRetry(() => {
      const error = exhaustedErrors[Math.min(exhaustedAttempts, exhaustedErrors.length - 1)];
      exhaustedAttempts += 1;
      throw error;
    }, exhausted)).rejects.toBe(exhaustedFirst);
    expect(exhaustedAttempts).toBe(40);
    expect(exhaustedNow).toBe(2_000);
  });

  it("fails closed for foreign owners, missing evidence, and noncontention errors", async () => {
    const foreign = createPublicationConvergence({ port: 3737, identity, expectedEntrypoint: identity.entrypoint, expectedRuntimeDigest: identity.runtimeDigest, deps: deps({
      readOwner: () => ({ version: 1, pid: 99, processStartTime: "birth", nonce: "b".repeat(32) }),
    }) });
    const contention = new PrivateMutationLockContentionError("busy");
    await expect(withPublicationAdmissionRetry(() => { throw contention; }, foreign)).rejects.toBe(contention);
    const absent = createPublicationConvergence({ port: 3737, identity, expectedEntrypoint: identity.entrypoint, expectedRuntimeDigest: identity.runtimeDigest, deps: deps({ readToken: () => null }) });
    await expect(withPublicationAdmissionRetry(() => { throw contention; }, absent)).rejects.toBe(contention);
    const ordinary = new Error("ordinary");
    await expect(withPublicationAdmissionRetry(() => { throw ordinary; }, foreign)).rejects.toBe(ordinary);
    await expect(withPublicationAdmissionRetry(() => "plain", undefined)).resolves.toBe("plain");
    const birthMismatch = createPublicationConvergence({ port: 3737, identity, expectedEntrypoint: identity.entrypoint, expectedRuntimeDigest: identity.runtimeDigest, deps: deps({ processBirth: () => "other" }) });
    await expect(withPublicationAdmissionRetry(() => { throw contention; }, birthMismatch)).rejects.toBe(contention);
    const birthFailure = createPublicationConvergence({ port: 3737, identity, expectedEntrypoint: identity.entrypoint, expectedRuntimeDigest: identity.runtimeDigest, deps: deps({ processBirth: () => { throw new Error("birth"); } }) });
    await expect(withPublicationAdmissionRetry(() => { throw contention; }, birthFailure)).rejects.toBe(contention);
    const malformedOwner = createPublicationConvergence({ port: 3737, identity, expectedEntrypoint: identity.entrypoint, expectedRuntimeDigest: identity.runtimeDigest, deps: deps({ readOwner: () => null }) });
    await expect(withPublicationAdmissionRetry(() => { throw contention; }, malformedOwner)).rejects.toBe(contention);
    const noLockPath = createPublicationConvergence({ port: 3737, identity, expectedEntrypoint: identity.entrypoint, expectedRuntimeDigest: identity.runtimeDigest, deps: deps({ lockPath: undefined, homeDir: undefined }) });
    await expect(withPublicationAdmissionRetry(() => { throw contention; }, noLockPath)).rejects.toBe(contention);
    const homeDerivedPath = createPublicationConvergence({ port: 3737, identity, expectedEntrypoint: identity.entrypoint, expectedRuntimeDigest: identity.runtimeDigest, deps: deps({ lockPath: undefined, homeDir: "/tmp", readOwner: () => null }) });
    await expect(withPublicationAdmissionRetry(() => { throw contention; }, homeDerivedPath)).rejects.toBe(contention);
    const ownerFailure = createPublicationConvergence({ port: 3737, identity, expectedEntrypoint: identity.entrypoint, expectedRuntimeDigest: identity.runtimeDigest, deps: deps({ readOwner: () => { throw new Error("owner"); } }) });
    await expect(withPublicationAdmissionRetry(() => { throw contention; }, ownerFailure)).rejects.toBe(contention);
    const ownerDefault = createPublicationConvergence({ port: 3737, identity, expectedEntrypoint: identity.entrypoint, expectedRuntimeDigest: identity.runtimeDigest, deps: deps({ readOwner: undefined, lockPath: "/tmp/nonexistent-publication.lock" }) });
    await expect(withPublicationAdmissionRetry(() => { throw contention; }, ownerDefault)).rejects.toBe(contention);
    const expired = createPublicationConvergence({ port: 3737, identity, expectedEntrypoint: identity.entrypoint, expectedRuntimeDigest: identity.runtimeDigest, deps: deps({ now: () => 1 }) }) as { deadline?: number };
    expired.deadline = 0;
    expect(expired.deadline).toBe(0);
    await expect(withPublicationAdmissionRetry(() => { throw contention; }, expired as never)).rejects.toBe(contention);
    const sleeps: number[] = [];
    let healthMismatchAttempts = 0;
    const healthMismatch = createPublicationConvergence({
      port: 3737,
      identity,
      expectedEntrypoint: identity.entrypoint,
      expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps({
        fetch: healthFetch(42, { runtimeDigest: "b".repeat(64) }),
        sleep: async (ms) => { sleeps.push(ms); },
      }),
    });
    await expect(withPublicationAdmissionRetry(() => {
      healthMismatchAttempts += 1;
      throw contention;
    }, healthMismatch)).rejects.toBe(contention);
    expect(healthMismatchAttempts).toBe(1);
    expect(sleeps).toEqual([]);
    const sqliteDefault = createPublicationConvergence({
      port: 3737,
      identity,
      expectedEntrypoint: identity.entrypoint,
      expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps({ fetch: healthFetch(42, { storageBackend: undefined }), platform: undefined, sleep: async () => undefined }),
    });
    let sqliteAttempts = 0;
    await expect(withPublicationAdmissionRetry(() => {
      sqliteAttempts += 1;
      if (sqliteAttempts === 1) throw contention;
      return undefined;
    }, sqliteDefault)).resolves.toBeUndefined();
  });

  it.each([
    ["pid", { pid: 43 }],
    ["version", { version: "2.0.0" }],
    ["storage backend", { storageBackend: "postgresql" }],
    ["entrypoint", { entrypoint: "/different.mjs" }],
    ["runtime digest", { runtimeDigest: "b".repeat(64) }],
    ["status", { status: "unavailable" }],
  ])("refuses a single %s health mismatch without retry", async (_label, override) => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const convergence = createPublicationConvergence({
      port: 3737,
      identity,
      expectedEntrypoint: identity.entrypoint,
      expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps({ fetch: healthFetch(42, override), sleep }),
    });
    const contention = new PrivateMutationLockContentionError(`mismatch-${String(_label)}`);
    let attempts = 0;
    await expect(withPublicationAdmissionRetry(() => {
      attempts += 1;
      throw contention;
    }, convergence)).rejects.toBe(contention);
    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("arms lazily after time spent outside contention and bounds retries", async () => {
    let now = 10_000;
    let sleeps = 0;
    const convergence = createPublicationConvergence({
      port: 3737,
      identity,
      expectedEntrypoint: identity.entrypoint,
      expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps({ now: () => now, sleep: async (ms) => { sleeps += ms; now += ms; } }),
    });
    now += 100_000;
    let attempts = 0;
    await expect(withPublicationAdmissionRetry(() => {
      attempts += 1;
      if (attempts === 1) throw new PrivateMutationLockContentionError("busy");
      return 7;
    }, convergence)).resolves.toBe(7);
    expect(sleeps).toBe(50);
  });

  it("preserves the first contention when health crosses the deadline", async () => {
    let now = 0;
    let fetches = 0;
    const first = new PrivateMutationLockContentionError("first");
    const second = new PrivateMutationLockContentionError("second");
    const convergence = createPublicationConvergence({
      port: 3737,
      identity,
      expectedEntrypoint: identity.entrypoint,
      expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps({
        now: () => now,
        sleep: async (ms) => { now += ms; },
        fetch: vi.fn(async () => {
          fetches += 1;
          if (fetches > 1) now = 2_001;
          return {
            ok: true,
            json: async () => ({
              status: "ok", pid: identity.pid, version: identity.version,
              storageBackend: identity.storageBackend, entrypoint: identity.entrypoint,
              runtimeDigest: identity.runtimeDigest,
            }),
          };
        }) as unknown as typeof globalThis.fetch,
      }),
    });
    let attempts = 0;
    await expect(withPublicationAdmissionRetry(() => {
      attempts += 1;
      throw attempts === 1 ? first : second;
    }, convergence)).rejects.toBe(first);
    expect(attempts).toBe(2);
  });

  it("preserves a later identity-mismatch contention after a granted retry", async () => {
    let now = 0;
    const first = new PrivateMutationLockContentionError("first");
    const second = new PrivateMutationLockContentionError("second");
    let ownerReads = 0;
    const convergence = createPublicationConvergence({
      port: 3737,
      identity,
      expectedEntrypoint: identity.entrypoint,
      expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps({
        now: () => now,
        sleep: async (ms) => { now += ms; },
        readOwner: () => ({ version: 1, pid: ownerReads++ === 0 ? identity.pid : 99, processStartTime: "birth", nonce: "a".repeat(32) }),
      }),
    });
    let attempts = 0;
    await expect(withPublicationAdmissionRetry(() => {
      attempts += 1;
      if (attempts === 1) throw first;
      throw second;
    }, convergence)).rejects.toBe(second);
    expect(attempts).toBe(2);
    expect(now).toBe(50);
  });

  it("keeps a later ordinary error unchanged after contention", async () => {
    let now = 0;
    const ordinary = new Error("ordinary later failure");
    const convergence = createPublicationConvergence({
      port: 3737,
      identity,
      expectedEntrypoint: identity.entrypoint,
      expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps({
        now: () => now,
        sleep: async (ms) => { now += ms; },
      }),
    });
    let attempts = 0;
    await expect(withPublicationAdmissionRetry(() => {
      attempts += 1;
      if (attempts === 1) throw new PrivateMutationLockContentionError("first");
      throw ordinary;
    }, convergence)).rejects.toBe(ordinary);
    expect(attempts).toBe(2);
  });

  it("stops before the health probe when the birth check consumes the window", async () => {
    let now = 0;
    const sleep = vi.fn(async (_ms: number) => undefined);
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "ok", pid: identity.pid, version: identity.version,
        storageBackend: identity.storageBackend, entrypoint: identity.entrypoint,
        runtimeDigest: identity.runtimeDigest }),
    })) as unknown as typeof globalThis.fetch;
    const convergence = createPublicationConvergence({
      port: 3737,
      identity,
      expectedEntrypoint: identity.entrypoint,
      expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps({
        now: () => now,
        processBirth: () => { now = 2_000; return "birth"; },
        fetch,
        sleep,
      }),
    });
    const contention = new PrivateMutationLockContentionError("birth deadline");
    await expect(withPublicationAdmissionRetry(() => { throw contention; }, convergence)).rejects.toBe(contention);
    expect(fetch).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("refuses a contention when the armed window has no birth time left", async () => {
    const values = [0, 0, 0, 0, 0, 100, 100, 3_000];
    const now = vi.fn(() => values.shift() ?? 10_000);
    const contention = new PrivateMutationLockContentionError("no birth time");
    const convergence = createPublicationConvergence({
      port: 3737,
      identity,
      expectedEntrypoint: identity.entrypoint,
      expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps({ now, sleep: async () => undefined }),
    });
    await expect(withPublicationAdmissionRetry(() => { throw contention; }, convergence)).rejects.toBe(contention);
  });

  it("fails closed when the default process birth probe cannot authenticate", async () => {
    const contention = new PrivateMutationLockContentionError("birth");
    const convergence = createPublicationConvergence({
      port: 3737,
      identity,
      expectedEntrypoint: identity.entrypoint,
      expectedRuntimeDigest: identity.runtimeDigest,
      deps: deps({ processBirth: undefined }),
    });
    await expect(withPublicationAdmissionRetry(() => { throw contention; }, convergence)).rejects.toBe(contention);
  });

  it("uses the bounded default sleep when no sleep seam is supplied", async () => {
    vi.useFakeTimers();
    try {
      const convergence = createPublicationConvergence({
        port: 3737,
        identity,
        expectedEntrypoint: identity.entrypoint,
        expectedRuntimeDigest: identity.runtimeDigest,
        deps: deps(),
      });
      let attempts = 0;
      const pending = withPublicationAdmissionRetry(() => {
        attempts += 1;
        if (attempts === 1) throw new PrivateMutationLockContentionError("busy");
        return "ok";
      }, convergence);
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });
});
