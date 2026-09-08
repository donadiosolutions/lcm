import { describe, expect, it, vi } from "vitest";
import { createPublicationQueue } from "../../src/daemon/publication-queue.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("queue did not settle")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const signal = () => new AbortController().signal;

describe("createPublicationQueue", () => {
  it("runs callbacks in FIFO order and preserves their return values", async () => {
    const enqueue = createPublicationQueue();
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondEntered = deferred();
    const releaseSecond = deferred();
    const order: string[] = [];
    const first = enqueue(async () => {
      order.push("first");
      firstEntered.resolve();
      await releaseFirst.promise;
      return 1;
    }, signal());
    await bounded(firstEntered.promise);
    const second = enqueue(async () => {
      order.push("second");
      secondEntered.resolve();
      await releaseSecond.promise;
      return 2;
    }, signal());
    const third = enqueue(() => { order.push("third"); return 3; }, signal());
    try {
      expect(order).toEqual(["first"]);
      releaseFirst.resolve();
      await bounded(secondEntered.promise);
      expect(order).toEqual(["first", "second"]);
      releaseSecond.resolve();
      await expect(bounded(Promise.all([first, second, third]))).resolves.toEqual([1, 2, 3]);
      expect(order).toEqual(["first", "second", "third"]);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
    }
  });

  it("never invokes an already aborted callback", async () => {
    const enqueue = createPublicationQueue();
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn();
    await expect(bounded(enqueue(operation, controller.signal).then(() => "resolved", () => "rejected"))).resolves.toBe("rejected");
    await expect(enqueue(() => "next", signal())).resolves.toBe("next");
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects a pending caller before the active slot settles and skips its callback", async () => {
    const enqueue = createPublicationQueue();
    const entered = deferred();
    const release = deferred();
    const first = enqueue(async () => { entered.resolve(); await release.promise; }, signal());
    await bounded(entered.promise);
    const controller = new AbortController();
    const operation = vi.fn();
    const pending = enqueue(operation, controller.signal);
    const rejected = expect(bounded(pending.then(() => "resolved", () => "rejected"))).resolves.toBe("rejected");
    const next = vi.fn(() => "next");
    const third = enqueue(next, signal());
    try {
      controller.abort();
      await rejected;
      expect(operation).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await bounded(first);
    await expect(bounded(third)).resolves.toBe("next");
    expect(operation).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"] as const)("retains an aborted active slot until its callback actually %ss", async (settlement) => {
    const enqueue = createPublicationQueue();
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    const first = enqueue(async () => { entered.resolve(); await release.promise; }, controller.signal);
    let callerSettled = false;
    const outcome = first.then(
      () => { callerSettled = true; return "resolved"; },
      () => { callerSettled = true; return "rejected"; },
    );
    await bounded(entered.promise);
    const next = vi.fn(() => "next");
    const second = enqueue(next, signal());
    try {
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(callerSettled).toBe(false);
      expect(next).not.toHaveBeenCalled();
    } finally {
      if (settlement === "resolve") release.resolve();
      else release.reject(new Error("late callback failure"));
    }
    await expect(bounded(outcome)).resolves.toBe(settlement === "resolve" ? "resolved" : "rejected");
    await expect(bounded(second)).resolves.toBe("next");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("keeps the caller pending when the callback synchronously aborts at queue entry", async () => {
    const enqueue = createPublicationQueue();
    const controller = new AbortController();
    const entered = deferred();
    const release = deferred();
    let callerSettled = false;
    const operation = enqueue(async () => {
      controller.abort();
      entered.resolve();
      await release.promise;
      return "actual callback result";
    }, controller.signal);
    const outcome = operation.then(
      value => { callerSettled = true; return { value }; },
      error => { callerSettled = true; return { error }; },
    );
    const successor = vi.fn(() => "successor");
    const next = enqueue(successor, signal());
    try {
      await bounded(entered.promise);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(controller.signal.aborted).toBe(true);
      expect(callerSettled).toBe(false);
      expect(successor).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await bounded(next);
    }
    await expect(bounded(outcome)).resolves.toEqual({ value: "actual callback result" });
    expect(successor).toHaveBeenCalledOnce();
  });

  it.each(["synchronous", "asynchronous"] as const)("recovers after a %s callback failure", async (kind) => {
    const enqueue = createPublicationQueue();
    const failure = new Error("publication failed");
    const first = enqueue(() => {
      if (kind === "synchronous") throw failure;
      return Promise.reject(failure);
    }, signal());
    const rejected = expect(first).rejects.toBe(failure);
    const second = enqueue(() => 42, signal());
    await rejected;
    await expect(bounded(second)).resolves.toBe(42);
  });

  it("rejects nested untokened admission promptly and permits later work", async () => {
    const enqueue = createPublicationQueue();
    const nested = vi.fn();
    await bounded(enqueue(async () => {
      await Promise.resolve();
      await expect(bounded(enqueue(nested, signal()))).rejects.toBeInstanceOf(PrivateMutationLockContentionError);
    }, signal()));
    expect(nested).not.toHaveBeenCalled();
    await expect(bounded(enqueue(() => "recovered", signal()))).resolves.toBe("recovered");
  });

  it("allows inherited asynchronous context to enqueue after its original callback settles", async () => {
    const enqueue = createPublicationQueue();
    const continueDetached = deferred();
    let detached!: Promise<string>;
    await enqueue(() => {
      detached = continueDetached.promise.then(() => enqueue(() => "detached", signal()));
    }, signal());
    continueDetached.resolve();
    await expect(bounded(detached)).resolves.toBe("detached");
  });

  it("does not serialize separate instances or treat cross-instance calls as nested", async () => {
    const firstQueue = createPublicationQueue();
    const secondQueue = createPublicationQueue();
    const entered = deferred();
    const release = deferred();
    const first = firstQueue(async () => {
      await expect(secondQueue(() => "nested independent", signal())).resolves.toBe("nested independent");
      entered.resolve();
      await release.promise;
    }, signal());
    try {
      await bounded(entered.promise);
      await expect(bounded(secondQueue(() => "independent", signal()))).resolves.toBe("independent");
    } finally {
      release.resolve();
    }
    await bounded(first);
  });
});
