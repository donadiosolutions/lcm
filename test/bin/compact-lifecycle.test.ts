import { describe, expect, it, vi } from "vitest";
import type { InvocationControlResponse } from "../../src/daemon/client.js";
import { createAbortError } from "../../src/daemon/cancellation.js";
import {
  cancelAndDrainCompactInvocation,
  createCompactInvocationLifecycle,
  drainCompactInvocationUntilProved,
  installCompactSignalHandlers,
  isStrictInvocationControlSnapshot,
} from "../../bin/lcm.js";

const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
const invocationId = "22222222-2222-4222-8222-222222222222";

function response(state: InvocationControlResponse["state"], activeCount = 0): InvocationControlResponse {
  return {
    invocationId,
    command: "compact",
    daemonInstanceId,
    state,
    activeCount,
    workCount: activeCount,
    commitCount: 0,
    leaseExpiresAt: null,
  };
}

describe("compact invocation lifecycle", () => {
  it("returns a proved drain when no invocation was registered", async () => {
    const lifecycle = {
      started: () => false,
      stopHeartbeat: vi.fn(),
    };

    await expect(cancelAndDrainCompactInvocation({ lifecycle } as never))
      .resolves.toEqual({ daemonZero: true, localSettled: true });
    expect(lifecycle.stopHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects malformed strict snapshots before inspecting fields", () => {
    const target = { invocationId, command: "compact" as const, daemonInstanceId };
    expect(isStrictInvocationControlSnapshot(null, target, "cancelled")).toBe(false);
    expect(isStrictInvocationControlSnapshot([], target, "cancelled")).toBe(false);
    expect(isStrictInvocationControlSnapshot({ ...response("cancelled"), workCount: 1 }, target, "cancelled")).toBe(false);
    expect(isStrictInvocationControlSnapshot(response("cancelled"), target, "cancelled")).toBe(true);
  });

  it("validates invocation identifiers and timing bounds", () => {
    const base = {
      client: {
        startInvocation: vi.fn(async () => response("active")),
        heartbeatInvocation: vi.fn(async () => response("active")),
        cancelInvocation: vi.fn(async () => response("cancelled")),
        finishInvocation: vi.fn(async () => response("finished")),
      },
      daemonInstanceId,
    };
    expect(() => createCompactInvocationLifecycle({ ...base, invocationId: "bad" })).toThrow(/invocation ID/);
    expect(() => createCompactInvocationLifecycle({ ...base, daemonInstanceId: "bad" })).toThrow(/daemon instance ID/);
    expect(() => createCompactInvocationLifecycle({ ...base, heartbeatMs: 0 })).toThrow(/heartbeat interval/);
    expect(() => createCompactInvocationLifecycle({ ...base, heartbeatMs: 30_000 })).toThrow(/heartbeat interval/);
    expect(() => createCompactInvocationLifecycle({ ...base, startTimeoutMs: 0 })).toThrow(/start timeout/);
  });

  it("handles repeated starts, pre-start cancellation, and invalid start snapshots", async () => {
    const heartbeatInvocation = vi.fn(async () => response("active"));
    const client = {
      startInvocation: vi.fn(async () => response("active")),
      heartbeatInvocation,
      cancelInvocation: vi.fn(async () => response("cancelled")),
      finishInvocation: vi.fn(async () => response("finished")),
    };
    const lifecycle = createCompactInvocationLifecycle({
      client,
      daemonInstanceId,
      invocationId,
      setInterval: vi.fn(() => 19 as unknown as ReturnType<typeof globalThis.setInterval>),
      clearInterval: vi.fn(),
    });
    await expect(lifecycle.cancel()).resolves.toBeUndefined();
    await lifecycle.start();
    await expect(lifecycle.start()).resolves.toMatchObject({ state: "active" });
    expect(heartbeatInvocation).toHaveBeenCalledOnce();

    const invalid = createCompactInvocationLifecycle({
      client: {
        ...client,
        startInvocation: vi.fn(async () => null as never),
      },
      daemonInstanceId,
      invocationId,
      setInterval: vi.fn(() => 20 as unknown as ReturnType<typeof globalThis.setInterval>),
      clearInterval: vi.fn(),
    });
    await expect(invalid.start()).rejects.toThrow(/invalid snapshot/);

    const invalidArray = createCompactInvocationLifecycle({
      client: {
        ...client,
        startInvocation: vi.fn(async () => [] as never),
      },
      daemonInstanceId,
      invocationId,
      setInterval: vi.fn(() => 20 as unknown as ReturnType<typeof globalThis.setInterval>),
      clearInterval: vi.fn(),
    });
    await expect(invalidArray.start()).rejects.toThrow(/invalid snapshot/);
    await expect(invalid.finish()).resolves.toBeUndefined();
  });

  it("returns no heartbeat after abort and reports non-abort heartbeat errors", async () => {
    const command = new AbortController();
    const onHeartbeatError = vi.fn();
    const lifecycle = createCompactInvocationLifecycle({
      client: {
        startInvocation: vi.fn(async () => response("active")),
        heartbeatInvocation: vi.fn(async () => { throw new Error("heartbeat failed"); }),
        cancelInvocation: vi.fn(async () => response("cancelled")),
        finishInvocation: vi.fn(async () => response("finished")),
      },
      daemonInstanceId,
      invocationId,
      signal: command.signal,
      onHeartbeatError,
      setInterval: vi.fn(() => 21 as unknown as ReturnType<typeof globalThis.setInterval>),
      clearInterval: vi.fn(),
    });
    expect(await lifecycle.heartbeat()).toBeUndefined();
    await lifecycle.start();
    await expect(lifecycle.heartbeat()).rejects.toThrow("heartbeat failed");
    expect(onHeartbeatError).toHaveBeenCalledWith(expect.any(Error));
    command.abort();
    expect(await lifecycle.heartbeat()).toBeUndefined();
  });

  it("ignores abort heartbeat failures and safely cleans up twice", async () => {
    const command = new AbortController();
    const onHeartbeatError = vi.fn();
    const abortError = createAbortError("aborted");
    const lifecycle = createCompactInvocationLifecycle({
      client: {
        startInvocation: vi.fn(async () => response("active")),
        heartbeatInvocation: vi.fn(async () => { throw abortError; }),
        cancelInvocation: vi.fn(async () => response("cancelled")),
        finishInvocation: vi.fn(async () => response("finished")),
      },
      daemonInstanceId,
      invocationId,
      signal: command.signal,
      onHeartbeatError,
      setInterval: vi.fn(() => 22 as unknown as ReturnType<typeof globalThis.setInterval>),
      clearInterval: vi.fn(),
    });
    await lifecycle.start();
    await expect(lifecycle.heartbeat()).rejects.toMatchObject({ name: "AbortError" });
    expect(onHeartbeatError).not.toHaveBeenCalled();
    lifecycle.stopHeartbeat();
    lifecycle.stopHeartbeat();
    await expect(lifecycle.finish()).resolves.toMatchObject({ state: "finished" });
  });

  it("latches repeated automatic drains and preserves rejection through drainPromise", async () => {
    const handlers = new Map<string, () => void>();
    const processLike = {
      on: vi.fn((event: string, handler: () => void) => { handlers.set(event, handler); return processLike; }),
      removeListener: vi.fn((event: string) => { handlers.delete(event); return processLike; }),
    };
    const onDrain = vi.fn(() => { throw new Error("drain failed"); });
    const onRepeatSignal = vi.fn();
    const lifecycle = installCompactSignalHandlers({ processLike, onDrain, onRepeatSignal });
    lifecycle.beginDrain("automatic");
    lifecycle.beginDrain("duplicate");
    handlers.get("SIGTERM")?.();
    expect(onRepeatSignal).toHaveBeenCalledWith(143, "SIGTERM");
    await expect(lifecycle.drainPromise).rejects.toThrow("drain failed");
    lifecycle.cleanup();
    lifecycle.cleanup();
  });

  it("uses the default reason for an automatic drain", async () => {
    const handlers = new Map<string, () => void>();
    const processLike = {
      on: vi.fn((event: string, handler: () => void) => { handlers.set(event, handler); return processLike; }),
      removeListener: vi.fn(),
    };
    const lifecycle = installCompactSignalHandlers({ processLike });
    lifecycle.beginDrain();
    expect(lifecycle.signal.reason).toMatchObject({ name: "AbortError" });
    expect(handlers.get("SIGINT")).toBeDefined();
  });
  it("starts before heartbeat and finishes after stopping the heartbeat", async () => {
    const signal = new AbortController().signal;
    const startInvocation = vi.fn(async () => response("active"));
    const heartbeatInvocation = vi.fn(async () => response("active"));
    const finishInvocation = vi.fn(async () => response("finished"));
    const setInterval = vi.fn(() => 17 as unknown as ReturnType<typeof globalThis.setInterval>);
    const clearInterval = vi.fn();
    const client = { startInvocation, heartbeatInvocation, finishInvocation };
    const lifecycle = createCompactInvocationLifecycle({
      client,
      daemonInstanceId,
      invocationId,
      signal,
      setInterval,
      clearInterval,
    });

    expect(startInvocation).not.toHaveBeenCalled();
    await lifecycle.start();
    expect(startInvocation).toHaveBeenCalledWith(
      { invocationId, command: "compact", daemonInstanceId },
      { signal: expect.any(AbortSignal), timeoutMs: 10_000 },
    );
    expect(setInterval).toHaveBeenCalledOnce();

    await expect(lifecycle.finish()).resolves.toMatchObject({ state: "finished" });
    expect(clearInterval).toHaveBeenCalledWith(17);
    expect(finishInvocation).toHaveBeenCalledWith(
      { invocationId, command: "compact", daemonInstanceId },
      { signal },
    );
    expect(heartbeatInvocation).not.toHaveBeenCalled();
  });

  it("keeps an accepted start request alive when the command signal aborts", async () => {
    const command = new AbortController();
    let resolveStart!: (value: InvocationControlResponse) => void;
    let rejectStart!: (error: unknown) => void;
    const startInvocation = vi.fn((_target: unknown, options: { signal?: AbortSignal }) => new Promise<InvocationControlResponse>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
      options.signal?.addEventListener("abort", () => reject(createAbortError()), { once: true });
    }));
    const lifecycle = createCompactInvocationLifecycle({
      client: {
        startInvocation,
        heartbeatInvocation: vi.fn(async () => response("active")),
        cancelInvocation: vi.fn(async () => response("cancelling")),
        finishInvocation: vi.fn(async () => response("finished")),
      },
      daemonInstanceId,
      invocationId,
      signal: command.signal,
      startTimeoutMs: 1000,
    } as never);

    const pending = lifecycle.start();
    const startSignal = startInvocation.mock.calls[0]?.[1]?.signal as AbortSignal;
    command.abort();
    expect(startSignal.aborted).toBe(false);
    resolveStart(response("active"));
    await expect(pending).resolves.toMatchObject({ state: "active" });
    expect(lifecycle.started()).toBe(true);
    expect(rejectStart).toBeDefined();
  });

  it("latches the first signal status, aborts dispatch, and reports repeats without exiting", async () => {
    const handlers = new Map<string, () => void>();
    const processLike = {
      on: vi.fn((event: string, handler: () => void) => {
        handlers.set(event, handler);
        return processLike;
      }),
      removeListener: vi.fn((event: string) => {
        handlers.delete(event);
        return processLike;
      }),
    };
    const first = vi.fn(async () => undefined);
    const repeated = vi.fn();
    const rendererState = { aborted: false };
    const lifecycle = installCompactSignalHandlers({
      processLike,
      onFirstSignal: first,
      onRepeatSignal: repeated,
    });
    lifecycle.bindRenderer(rendererState);

    handlers.get("SIGTERM")?.();
    handlers.get("SIGINT")?.();
    expect(lifecycle.status).toBe(143);
    expect(lifecycle.draining).toBe(true);
    expect(lifecycle.signal.aborted).toBe(true);
    expect(rendererState.aborted).toBe(true);
    expect(first).toHaveBeenCalledWith(143, "SIGTERM");
    expect(repeated).toHaveBeenCalledWith(143, "SIGINT");
    await expect(lifecycle.drainPromise).resolves.toBeUndefined();
    lifecycle.cleanup();
    expect(processLike.removeListener).toHaveBeenCalledTimes(2);
  });

  it("rechecks the original daemon and retries cancel once after a deadline", async () => {
    vi.useFakeTimers();
    const cancelInvocation = vi
      .fn()
      .mockImplementationOnce(() => new Promise<InvocationControlResponse>(() => undefined))
      .mockResolvedValueOnce(response("cancelled"));
    const health = vi.fn(async () => ({
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite" as const,
      daemonInstanceId,
      pid: 9,
      uptime: 1,
    }));
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;

    const pending = (await import("../../bin/lcm.js")).cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation, health }),
      originalHealth: await health(),
      health,
      proveProviderWitnessGone: async () => true,
      timeoutMs: 10,
      awaitLocalWork: async () => undefined,
    } as never);
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toMatchObject({ daemonZero: true, localSettled: true });
    expect(cancelInvocation).toHaveBeenCalledTimes(2);
    expect(health).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("requires old-instance and provider disappearance proof before accepting restart", async () => {
    const oldHealth = {
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite" as const,
      daemonInstanceId,
      runtimeDigest: "old-runtime",
      pid: 9,
      uptime: 1,
    };
    const replacementHealth = { ...oldHealth, daemonInstanceId: "33333333-3333-4333-8333-333333333333", runtimeDigest: "new-runtime" };
    const cancelInvocation = vi.fn(async () => response("cancelling", 1));
    const health = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(replacementHealth);
    const restart = vi.fn(async () => ({ connected: true, restarted: true, stoppedPid: 9, pid: 10 }));
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;

    const result = await (await import("../../bin/lcm.js")).cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation, health }),
      originalHealth: oldHealth,
      health,
      restart,
      proveOldInstanceGone: async () => true,
      proveProviderWitnessGone: async () => true,
      expectedRuntimeDigest: "new-runtime",
      expectedStorageBackend: "sqlite",
      timeoutMs: 10_000,
      awaitLocalWork: async () => undefined,
    } as never);

    expect(result).toMatchObject({ daemonZero: true, localSettled: true, restartAttempted: true, replacementVerified: true });
    expect(restart).toHaveBeenCalledOnce();
    expect(health).toHaveBeenCalledTimes(2);
  });

  it("stays unproved when managed restart cannot prove provider disappearance", async () => {
    const oldHealth = {
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite" as const,
      daemonInstanceId,
      pid: 9,
      uptime: 1,
    };
    const cancelInvocation = vi.fn(async () => response("cancelling", 1));
    const health = vi.fn(async () => oldHealth);
    const restart = vi.fn(async () => ({ connected: true, restarted: true, stoppedPid: 9, pid: 10 }));
    const diagnostic = vi.fn();
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;

    const result = await (await import("../../bin/lcm.js")).cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation, health }),
      originalHealth: oldHealth,
      health,
      restart,
      proveOldInstanceGone: async () => true,
      proveProviderWitnessGone: async () => false,
      onDiagnostic: diagnostic,
      awaitLocalWork: async () => undefined,
    } as never);

    expect(result.daemonZero).toBe(false);
    expect(result.replacementVerified).toBe(false);
    expect(restart).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalled();
  });

  it("keeps retrying an unproved drain until a later proof settles", async () => {
    const cancelInvocation = vi.fn()
      .mockResolvedValueOnce(response("cancelling", 1))
      .mockResolvedValueOnce(response("cancelled", 0));
    const waits: number[] = [];
    const diagnostics = vi.fn();
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;

    const result = await drainCompactInvocationUntilProved({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation }),
      awaitLocalWork: async () => undefined,
      proveProviderWitnessGone: async () => true,
      retryDelayMs: 25,
      waitForRetry: async delayMs => { waits.push(delayMs); },
      onDiagnostic: diagnostics,
    } as never);

    expect(result).toMatchObject({ daemonZero: true, localSettled: true });
    expect(cancelInvocation).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([25]);
    expect(diagnostics).toHaveBeenCalledOnce();
  });

  it("validates the drain retry delay before starting cancellation", async () => {
    const lifecycle = {
      started: () => false,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;

    await expect(drainCompactInvocationUntilProved({ lifecycle, retryDelayMs: 0 } as never))
      .rejects.toThrow(/retry delay/i);
  });

  it("stops the lease heartbeat before starting cancellation drain", async () => {
    const clearInterval = vi.fn();
    const client = {
      startInvocation: vi.fn(async () => response("active")),
      heartbeatInvocation: vi.fn(async () => response("active")),
      cancelInvocation: vi.fn(async () => response("cancelling")),
      finishInvocation: vi.fn(async () => response("finished")),
    };
    const lifecycle = createCompactInvocationLifecycle({
      client,
      daemonInstanceId,
      invocationId,
      setInterval: vi.fn(() => 12 as unknown as ReturnType<typeof globalThis.setInterval>),
      clearInterval,
    });
    await lifecycle.start();

    await (await import("../../bin/lcm.js")).cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => client,
      awaitLocalWork: async () => undefined,
    });

    expect(clearInterval).toHaveBeenCalledWith(12);
  });

  it("requires a strict terminal cancel snapshot and an available empty provider witness", async () => {
    const cancelInvocation = vi.fn(async () => ({
      ...response("cancelled"),
      workCount: 1,
    }));
    const proveProviderWitnessGone = vi.fn(async () => true);
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;

    const result = await cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation }),
      originalHealth: {
        status: "healthy",
        version: "1.4.2",
        storageBackend: "sqlite",
        daemonInstanceId,
        pid: 9,
        uptime: 1,
      },
      proveProviderWitnessGone,
      awaitLocalWork: async () => undefined,
    });

    expect(result.daemonZero).toBe(false);
    expect(proveProviderWitnessGone).toHaveBeenCalledWith({ daemonInstanceId });
  });

  it("bounds a retry when provider proof is unavailable and the snapshot stays non-terminal", async () => {
    const oldHealth = {
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite" as const,
      daemonInstanceId,
      pid: 9,
      uptime: 1,
    };
    const cancelInvocation = vi.fn()
      .mockResolvedValueOnce(response("cancelling", 1))
      .mockResolvedValueOnce(response("cancelling", 1));
    const health = vi.fn(async () => oldHealth);
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;

    const result = await cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation, health }),
      originalHealth: oldHealth,
      health,
      awaitLocalWork: async () => undefined,
      timeoutMs: 100,
    } as never);

    expect(result).toMatchObject({ daemonZero: false, localSettled: true });
    expect(cancelInvocation).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable provider proof after a strict retry snapshot", async () => {
    const oldHealth = {
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite" as const,
      daemonInstanceId,
      pid: 9,
      uptime: 1,
    };
    const cancelInvocation = vi.fn()
      .mockResolvedValueOnce(response("cancelling", 1))
      .mockResolvedValueOnce(response("cancelled"));
    const health = vi.fn(async () => oldHealth);
    const proveProviderWitnessGone = vi.fn(async () => false);
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;

    const result = await cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation, health }),
      originalHealth: oldHealth,
      health,
      proveProviderWitnessGone,
      awaitLocalWork: async () => undefined,
      timeoutMs: 100,
    } as never);

    expect(result).toMatchObject({ daemonZero: false, localSettled: true });
    expect(cancelInvocation).toHaveBeenCalledTimes(2);
    expect(proveProviderWitnessGone).toHaveBeenCalledTimes(2);
  });

  it("evaluates restart identity fallbacks for every managed restart result", async () => {
    const restartResults = [
      { connected: true, restarted: false, stoppedPid: undefined, pid: 10 },
      { connected: true, restarted: true, stoppedPid: undefined, pid: 10 },
      { connected: true, restarted: true, stoppedPid: 9, pid: 10 },
    ] as const;

    for (const restartResult of restartResults) {
      const restart = vi.fn(async () => restartResult);
      const lifecycle = {
        started: () => true,
        stopHeartbeat: vi.fn(),
        target: { invocationId, command: "compact" as const, daemonInstanceId },
      } as never;
      const result = await cancelAndDrainCompactInvocation({
        lifecycle,
        createFreshClient: () => ({ cancelInvocation: vi.fn(async () => response("cancelling", 1)) }),
        health: async () => null,
        restart,
        timeoutMs: 100,
      } as never);

      expect(result).toMatchObject({ daemonZero: false, restartAttempted: true });
      expect(restart).toHaveBeenCalledOnce();
    }
  });

  it("passes an omitted original health through restart and proof callbacks", async () => {
    const replacementHealth = {
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite" as const,
      daemonInstanceId: "33333333-3333-4333-8333-333333333333",
    };
    const health = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(replacementHealth);
    const restart = vi.fn(async ({ originalHealth }: { originalHealth?: unknown }) => {
      expect(originalHealth).toBeUndefined();
      return { connected: true, restarted: true, stoppedPid: 9, pid: 10 };
    });
    const proveOldInstanceGone = vi.fn(async ({ originalHealth }: { originalHealth?: unknown }) => {
      expect(originalHealth).toBeUndefined();
      return true;
    });
    const proveProviderWitnessGone = vi.fn(async () => true);
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;

    const result = await cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation: vi.fn(async () => response("cancelling", 1)) }),
      health,
      restart,
      proveOldInstanceGone,
      proveProviderWitnessGone,
      timeoutMs: 100,
    } as never);

    expect(result).toMatchObject({ daemonZero: true, replacementVerified: true });
    expect(restart).toHaveBeenCalledOnce();
    expect(proveOldInstanceGone).toHaveBeenCalledOnce();
    expect(proveProviderWitnessGone).toHaveBeenCalledWith({ daemonInstanceId: undefined });
  });

  it("does not repeat a managed restart when a prior session has no result", async () => {
    const restart = vi.fn(async () => ({ connected: true, restarted: true, stoppedPid: 9, pid: 10 }));
    const session = { restartAttempted: true };
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;

    const result = await cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation: vi.fn(async () => response("cancelling", 1)) }),
      health: async () => null,
      restart,
      session,
      timeoutMs: 100,
    } as never);

    expect(result).toMatchObject({ daemonZero: false, restartAttempted: true });
    expect(restart).not.toHaveBeenCalled();
  });

  it("validates cancellation timeout and preserves primitive/error diagnostics", async () => {
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;
    await expect(cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation: vi.fn(async () => response("cancelled")) }),
      timeoutMs: 0,
    } as never)).rejects.toThrow(/cancellation timeout/);

    const onDiagnostic = vi.fn();
    const result = await cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation: vi.fn(async () => { throw "primitive failure"; }) }),
      awaitLocalWork: async () => { throw new Error("local failed"); },
      onDiagnostic,
    } as never);
    expect(result).toMatchObject({ daemonZero: false, localSettled: false });
    expect(onDiagnostic).toHaveBeenCalledWith(expect.stringContaining("daemon cancellation request failed"));

    const errorDiagnostic = vi.fn();
    const errorResult = await cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation: vi.fn(async () => { throw new Error("daemon failed"); }) }),
      onDiagnostic: errorDiagnostic,
    } as never);
    expect(errorResult.diagnostic).toBe("daemon failed");
    expect(errorDiagnostic).toHaveBeenCalledWith("daemon failed");
  });

  it("handles a timer seam that does not return a handle", async () => {
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;
    const clearTimer = vi.fn();
    const result = await cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation: vi.fn(async () => response("cancelled")) }),
      proveProviderWitnessGone: async () => true,
      setTimeout: (() => undefined) as never,
      clearTimeout: clearTimer,
    } as never);
    expect(result).toMatchObject({ daemonZero: true, localSettled: true });
    expect(clearTimer).not.toHaveBeenCalled();
  });

  it("retains the daemon diagnostic when local work fails after cancellation", async () => {
    const diagnostic = vi.fn();
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;
    const result = await cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation: vi.fn(async () => response("cancelled")) }),
      proveProviderWitnessGone: async () => true,
      awaitLocalWork: async () => { throw "local primitive"; },
      onDiagnostic: diagnostic,
    } as never);
    expect(result.localSettled).toBe(false);
    expect(diagnostic).toHaveBeenCalledWith("daemon cancellation deadline exceeded");
  });

  it("reports local timeout and local primitive failure while bounding operations", async () => {
    vi.useFakeTimers();
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;
    const diagnostic = vi.fn();
    const pending = cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation: vi.fn(async () => response("cancelling", 1)) }),
      awaitLocalWork: async () => { throw "local primitive"; },
      timeoutMs: 5,
      onDiagnostic: diagnostic,
    } as never);
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toMatchObject({ daemonZero: false, localSettled: false });
    expect(diagnostic).toHaveBeenCalled();

    const hanging = cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation: vi.fn(async () => new Promise<never>(() => undefined)) }),
      timeoutMs: 5,
    } as never);
    await vi.advanceTimersByTimeAsync(5);
    await expect(hanging).resolves.toMatchObject({ daemonZero: false, localSettled: true });
    vi.useRealTimers();
  });

  it("normalizes managed restart rejection and incomplete restart results", async () => {
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;
    const base = {
      lifecycle,
      createFreshClient: () => ({ cancelInvocation: vi.fn(async () => response("cancelling", 1)), health: vi.fn(async () => null) }),
      awaitLocalWork: async () => undefined,
      originalHealth: { status: "healthy", version: "1.4.2", storageBackend: "sqlite" as const, daemonInstanceId, pid: 9, uptime: 1 },
      proveProviderWitnessGone: async () => false,
      proveOldInstanceGone: async () => false,
      onDiagnostic: vi.fn(),
    };
    const rejected = await cancelAndDrainCompactInvocation({
      ...base,
      restart: async () => { throw "restart primitive"; },
    } as never);
    expect(rejected.diagnostic).toBe("managed daemon restart was not verified");
    const incomplete = await cancelAndDrainCompactInvocation({
      ...base,
      restart: async () => undefined as never,
    } as never);
    expect(incomplete.diagnostic).toMatch(/managed daemon restart did not settle/);
  });

  it("treats a missing provider witness reader as unavailable proof", async () => {
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;

    const result = await cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation: vi.fn(async () => response("cancelled")) }),
      originalHealth: {
        status: "healthy",
        version: "1.4.2",
        storageBackend: "sqlite",
        daemonInstanceId,
        pid: 9,
        uptime: 1,
      },
      awaitLocalWork: async () => undefined,
    });

    expect(result.daemonZero).toBe(false);
  });

  it("marks an accepted start request as possibly registered when its response is lost", async () => {
    const startInvocation = vi.fn(async () => { throw new Error("start response lost"); });
    const cancelInvocation = vi.fn(async () => response("cancelled"));
    const lifecycle = createCompactInvocationLifecycle({
      client: {
        startInvocation,
        heartbeatInvocation: vi.fn(async () => response("active")),
        cancelInvocation,
        finishInvocation: vi.fn(async () => response("finished")),
      },
      daemonInstanceId,
      invocationId,
      setInterval: vi.fn(() => 13 as unknown as ReturnType<typeof globalThis.setInterval>),
      clearInterval: vi.fn(),
    });

    await expect(lifecycle.start()).rejects.toThrow("start response lost");
    const possiblyRegistered = (lifecycle as unknown as { possiblyRegistered: () => boolean }).possiblyRegistered;
    expect(possiblyRegistered()).toBe(true);
    await expect(lifecycle.cancel()).resolves.toMatchObject({ state: "cancelled" });
    expect(cancelInvocation).toHaveBeenCalledOnce();
  });

  it("does not mark or send a start request when already aborted", async () => {
    const command = new AbortController();
    command.abort(createAbortError("pre-aborted"));
    const startInvocation = vi.fn(async () => response("active"));
    const lifecycle = createCompactInvocationLifecycle({
      client: {
        startInvocation,
        heartbeatInvocation: vi.fn(async () => response("active")),
        cancelInvocation: vi.fn(async () => response("cancelled")),
        finishInvocation: vi.fn(async () => response("finished")),
      },
      daemonInstanceId,
      invocationId,
      signal: command.signal,
      setInterval: vi.fn(() => 13 as unknown as ReturnType<typeof globalThis.setInterval>),
      clearInterval: vi.fn(),
    });

    await expect(lifecycle.start()).rejects.toMatchObject({ name: "AbortError" });
    expect(startInvocation).not.toHaveBeenCalled();
    expect(lifecycle.possiblyRegistered()).toBe(false);
  });

  it("serializes overlapping heartbeat requests", async () => {
    let release!: (value: InvocationControlResponse) => void;
    const heartbeatInvocation = vi.fn(() => new Promise<InvocationControlResponse>(resolve => { release = resolve; }));
    const lifecycle = createCompactInvocationLifecycle({
      client: {
        startInvocation: vi.fn(async () => response("active")),
        heartbeatInvocation,
        cancelInvocation: vi.fn(async () => response("cancelled")),
        finishInvocation: vi.fn(async () => response("finished")),
      },
      daemonInstanceId,
      invocationId,
      setInterval: vi.fn(() => 14 as unknown as ReturnType<typeof globalThis.setInterval>),
      clearInterval: vi.fn(),
    });

    await lifecycle.start();
    const first = lifecycle.heartbeat();
    const second = lifecycle.heartbeat();
    await Promise.resolve();
    expect(heartbeatInvocation).toHaveBeenCalledOnce();
    expect(heartbeatInvocation).toHaveBeenCalledWith(
      { invocationId, command: "compact", daemonInstanceId },
      { signal: expect.any(AbortSignal), timeoutMs: 10_000 },
    );
    release(response("active"));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ state: "active" }),
      expect.objectContaining({ state: "active" }),
    ]);
  });

  it("does not clear a newer heartbeat after a reentrant transport call", async () => {
    let lifecycle!: ReturnType<typeof createCompactInvocationLifecycle>;
    let resolveFirst!: (value: InvocationControlResponse) => void;
    let resolveSecond!: (value: InvocationControlResponse) => void;
    let nested!: Promise<InvocationControlResponse | undefined>;
    let heartbeatCalls = 0;
    const heartbeatInvocation = vi.fn(() => {
      if (heartbeatCalls++ === 0) {
        nested = lifecycle.heartbeat();
        return new Promise<InvocationControlResponse>(resolve => { resolveFirst = resolve; });
      }
      return new Promise<InvocationControlResponse>(resolve => { resolveSecond = resolve; });
    });
    lifecycle = createCompactInvocationLifecycle({
      client: {
        startInvocation: vi.fn(async () => response("active")),
        heartbeatInvocation,
        cancelInvocation: vi.fn(async () => response("cancelled")),
        finishInvocation: vi.fn(async () => response("finished")),
      },
      daemonInstanceId,
      invocationId,
      setInterval: vi.fn(() => 14 as unknown as ReturnType<typeof globalThis.setInterval>),
      clearInterval: vi.fn(),
    });

    await lifecycle.start();
    const outer = lifecycle.heartbeat();
    await Promise.resolve();
    expect(heartbeatInvocation).toHaveBeenCalledTimes(2);
    resolveFirst(response("active"));
    await outer;
    resolveSecond(response("active"));
    await nested;
  });

  it("latches and reports a signal that arrives during an automatic drain", async () => {
    const handlers = new Map<string, () => void>();
    const processLike = {
      on: vi.fn((event: string, handler: () => void) => { handlers.set(event, handler); return processLike; }),
      removeListener: vi.fn((event: string) => { handlers.delete(event); return processLike; }),
    };
    const repeated = vi.fn();
    const lifecycle = installCompactSignalHandlers({ processLike, onRepeatSignal: repeated });

    lifecycle.beginDrain("automatic cancellation");
    handlers.get("SIGINT")?.();

    expect(lifecycle.status).toBe(130);
    expect(repeated).toHaveBeenCalledWith(130, "SIGINT");
  });

  it("rejects a non-terminal finish snapshot", async () => {
    const lifecycle = createCompactInvocationLifecycle({
      client: {
        startInvocation: vi.fn(async () => response("active")),
        heartbeatInvocation: vi.fn(async () => response("active")),
        cancelInvocation: vi.fn(async () => response("cancelled")),
        finishInvocation: vi.fn(async () => ({ ...response("finished"), commitCount: 1 })),
      },
      daemonInstanceId,
      invocationId,
      setInterval: vi.fn(() => 15 as unknown as ReturnType<typeof globalThis.setInterval>),
      clearInterval: vi.fn(),
    });

    await lifecycle.start();
    await expect(lifecycle.finish()).rejects.toThrow(/finish|snapshot|zero/i);
  });

  it("reuses one managed restart while later drain attempts poll replacement proof", async () => {
    const oldHealth = {
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite" as const,
      daemonInstanceId: daemonInstanceId,
      runtimeDigest: "runtime",
      pid: 9,
      uptime: 1,
    };
    const replacementHealth = {
      ...oldHealth,
      daemonInstanceId: "33333333-3333-4333-8333-333333333333",
    };
    const cancelInvocation = vi.fn()
      .mockResolvedValue(response("cancelling", 1));
    const health = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(oldHealth)
      .mockResolvedValueOnce(replacementHealth)
      .mockResolvedValueOnce(replacementHealth);
    const restart = vi.fn(async () => ({ connected: true, restarted: true, stoppedPid: 9, pid: 10 }));
    const waits: number[] = [];
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;

    const result = await drainCompactInvocationUntilProved({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation, health }),
      originalHealth: oldHealth,
      health,
      restart,
      proveOldInstanceGone: async () => true,
      proveProviderWitnessGone: async () => true,
      expectedRuntimeDigest: "runtime",
      expectedStorageBackend: "sqlite",
      awaitLocalWork: async () => undefined,
      retryDelayMs: 1,
      waitForRetry: async delay => { waits.push(delay); },
    });

    expect(result).toMatchObject({ daemonZero: true, localSettled: true, replacementVerified: true });
    expect(restart).toHaveBeenCalledOnce();
    expect(waits).toEqual([1]);
  });

  it("bounds replacement health when restart does not return a replacement", async () => {
    vi.useFakeTimers();
    const oldHealth = {
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite" as const,
      daemonInstanceId,
      pid: 9,
      uptime: 1,
    };
    const cancelInvocation = vi.fn(async () => response("cancelling", 1));
    let replacementHealthStarted = false;
    const health = vi.fn()
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async () => {
        replacementHealthStarted = true;
        return await new Promise<null>(() => undefined);
      });
    const lifecycle = {
      started: () => true,
      stopHeartbeat: vi.fn(),
      target: { invocationId, command: "compact" as const, daemonInstanceId },
    } as never;

    const pending = cancelAndDrainCompactInvocation({
      lifecycle,
      createFreshClient: () => ({ cancelInvocation, health }),
      originalHealth: oldHealth,
      health,
      restart: async () => ({ connected: true, restarted: true, stoppedPid: 9, pid: 10 }),
      proveOldInstanceGone: async () => true,
      proveProviderWitnessGone: async () => true,
      timeoutMs: 10,
      awaitLocalWork: async () => undefined,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(replacementHealthStarted).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toMatchObject({ daemonZero: false, replacementVerified: false });
    vi.useRealTimers();
  });

  it("stops and awaits an in-flight heartbeat during outer cleanup", async () => {
    let release!: (value: InvocationControlResponse) => void;
    const heartbeatInvocation = vi.fn(() => new Promise<InvocationControlResponse>(resolve => { release = resolve; }));
    const clearInterval = vi.fn();
    const lifecycle = createCompactInvocationLifecycle({
      client: {
        startInvocation: vi.fn(async () => response("active")),
        heartbeatInvocation,
        cancelInvocation: vi.fn(async () => response("cancelled")),
        finishInvocation: vi.fn(async () => response("finished")),
      },
      daemonInstanceId,
      invocationId,
      setInterval: vi.fn(() => 16 as unknown as ReturnType<typeof globalThis.setInterval>),
      clearInterval,
    });

    await lifecycle.start();
    const heartbeat = lifecycle.heartbeat();
    let cleanupSettled = false;
    const cleanup = lifecycle.settleHeartbeat().then(() => { cleanupSettled = true; });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);
    expect(clearInterval).toHaveBeenCalledWith(16);
    release(response("active"));
    await cleanup;
    await heartbeat;
  });
});
