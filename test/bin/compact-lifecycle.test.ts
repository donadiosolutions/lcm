import { describe, expect, it, vi } from "vitest";
import type { InvocationControlResponse } from "../../src/daemon/client.js";
import {
  createCompactInvocationLifecycle,
  installCompactSignalHandlers,
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
      { signal },
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
      .mockResolvedValueOnce(response("cancelling"));
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
      .mockResolvedValueOnce(oldHealth)
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
    expect(diagnostic).toHaveBeenCalled();
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
});
