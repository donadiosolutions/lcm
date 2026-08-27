import { describe, expect, it, vi } from "vitest";
import {
  abortableDelay,
  composeAbortSignals,
  createAbortError,
  isAbortError,
  throwIfAborted,
  waitForAbortable,
} from "../../src/daemon/cancellation.js";

type ListenerSignal = AbortSignal & {
  addCount: number;
  removeCount: number;
};

function observeSignal(signal: AbortSignal): ListenerSignal {
  const observed = signal as ListenerSignal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  observed.addCount = 0;
  observed.removeCount = 0;
  observed.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    observed.addCount += 1;
    return add(...args);
  }) as AbortSignal["addEventListener"];
  observed.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    observed.removeCount += 1;
    return remove(...args);
  }) as AbortSignal["removeEventListener"];
  return observed;
}

describe("cancellation utilities", () => {
  it("throws and identifies an intentional AbortError", () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    expect(() => throwIfAborted(controller.signal)).toThrowError(expect.objectContaining({ name: "AbortError" }));
    expect(isAbortError(createAbortError())).toBe(true);
    expect(isAbortError(new Error("ordinary"))).toBe(false);
    expect(isAbortError(Object.assign(new Error("named"), { name: "AbortError" }))).toBe(false);
    const intentional = createAbortError();
    expect(createAbortError(intentional)).toBe(intentional);
  });

  it("composes signals synchronously for pre-aborted input and cleans listeners", () => {
    const first = observeSignal(new AbortController().signal);
    const secondController = new AbortController();
    const second = observeSignal(secondController.signal);
    const firstController = new AbortController();
    firstController.abort(new Error("already stopped"));
    const preAborted = composeAbortSignals([firstController.signal, first]);
    expect(preAborted.signal.aborted).toBe(true);
    expect(first.addCount).toBe(0);
    preAborted.cleanup();

    const composed = composeAbortSignals([first, second]);
    expect(first.addCount).toBe(1);
    expect(second.addCount).toBe(1);
    secondController.abort();
    expect(composed.signal.aborted).toBe(true);
    expect(first.removeCount).toBe(1);
    expect(second.removeCount).toBe(1);
    composed.cleanup();

    const duplicate = observeSignal(new AbortController().signal);
    const deduplicated = composeAbortSignals([duplicate, duplicate]);
    expect(duplicate.addCount).toBe(1);
    deduplicated.cleanup();
    expect(duplicate.removeCount).toBe(1);
  });

  it("cleans delay timers and abort listeners on success and abort", async () => {
    const timers: Array<{ callback: () => void; active: boolean }> = [];
    const setTimer = vi.fn((callback: () => void) => {
      const timer = { callback, active: true };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const clearTimer = vi.fn((timer: ReturnType<typeof setTimeout>) => {
      (timer as unknown as { active: boolean }).active = false;
    }) as typeof clearTimeout;
    const successController = new AbortController();
    const successSignal = observeSignal(successController.signal);
    const success = abortableDelay(2, successSignal, { setTimeout: setTimer, clearTimeout: clearTimer });
    timers[0]!.callback();
    await expect(success).resolves.toBeUndefined();
    expect(successSignal.removeCount).toBe(1);
    successController.abort();

    const abortController = new AbortController();
    const abortSignal = observeSignal(abortController.signal);
    const aborted = abortableDelay(2, abortSignal, { setTimeout: setTimer, clearTimeout: clearTimer });
    abortController.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(clearTimer).toHaveBeenCalled();
    expect(abortSignal.removeCount).toBe(1);
    expect(() => abortableDelay(2, abortController.signal, { setTimeout: setTimer, clearTimeout: clearTimer }))
      .toThrowError(expect.objectContaining({ name: "AbortError" }));
    await expect(abortableDelay(-1)).rejects.toThrow(/delay/i);

    const immediateController = new AbortController();
    const immediateSignal = observeSignal(immediateController.signal);
    const immediateSetTimer = vi.fn((callback: () => void) => {
      callback();
      return { active: true } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const immediateClearTimer = vi.fn((timer: ReturnType<typeof setTimeout>) => {
      (timer as unknown as { active: boolean }).active = false;
    }) as typeof clearTimeout;
    await expect(abortableDelay(2, immediateSignal, {
      setTimeout: immediateSetTimer,
      clearTimeout: immediateClearTimer,
    })).resolves.toBeUndefined();
    (immediateSetTimer as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]();
    expect(immediateSignal.removeCount).toBe(1);
    expect(immediateClearTimer).toHaveBeenCalledOnce();

    const failingController = new AbortController();
    const failingSignal = observeSignal(failingController.signal);
    const timerFailure = new Error("timer failed");
    await expect(abortableDelay(2, failingSignal, {
      setTimeout: vi.fn(() => { throw timerFailure; }) as unknown as typeof setTimeout,
      clearTimeout,
    })).rejects.toBe(timerFailure);
    expect(failingSignal.removeCount).toBe(1);

    await expect(abortableDelay(2, undefined, {
      setTimeout: vi.fn(() => { throw "non-error timer failure"; }) as unknown as typeof setTimeout,
      clearTimeout,
    })).rejects.toThrow(/timer/i);

    const synchronousAbortSignal = {
      aborted: false,
      reason: undefined,
      addEventListener: (_event: string, listener: () => void) => listener(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const synchronousTimer = vi.fn(() => ({ active: true })) as unknown as typeof setTimeout;
    await expect(abortableDelay(2, synchronousAbortSignal, {
      setTimeout: synchronousTimer,
      clearTimeout,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(synchronousTimer).not.toHaveBeenCalled();
    expect(synchronousAbortSignal.removeEventListener).toHaveBeenCalledOnce();
  });

  it("settles an existing operation exactly once and removes wait listeners", async () => {
    const controller = new AbortController();
    const signal = observeSignal(controller.signal);
    const operation = new Promise<string>(resolve => queueMicrotask(() => resolve("done")));
    await expect(waitForAbortable(operation, signal)).resolves.toBe("done");
    expect(signal.removeCount).toBe(1);

    const abortController = new AbortController();
    const abortSignal = observeSignal(abortController.signal);
    const pending = waitForAbortable(new Promise<void>(() => {}), abortSignal);
    abortController.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(abortSignal.removeCount).toBe(1);

    const preAborted = new AbortController();
    preAborted.abort();
    expect(() => waitForAbortable(Promise.resolve("never"), preAborted.signal))
      .toThrowError(expect.objectContaining({ name: "AbortError" }));
    await expect(waitForAbortable(Promise.resolve("ok"))).resolves.toBe("ok");
    await expect(waitForAbortable(Promise.reject(new Error("failed")), signal)).rejects.toThrow("failed");

    const raceController = new AbortController();
    const raceSignal = observeSignal(raceController.signal);
    const race = waitForAbortable(Promise.resolve("late"), raceSignal);
    raceController.abort();
    await expect(race).rejects.toMatchObject({ name: "AbortError" });
    expect(raceSignal.removeCount).toBe(1);
  });
});
