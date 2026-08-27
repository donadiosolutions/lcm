import { describe, it, expect } from "vitest";
import { enqueue } from "../../src/daemon/project-queue.js";
import { isAbortError } from "../../src/daemon/cancellation.js";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForEntryBeforeSettlement<T>(entry: Promise<void>, operation: Promise<T>): Promise<void> {
  const outcome = await Promise.race([
    entry.then(() => "entered" as const),
    operation.then(() => "settled" as const, () => "settled" as const),
  ]);
  if (outcome === "settled") {
    throw new Error("queue operation settled before entering its test gate");
  }
}

describe("enqueue", () => {
  it("returns the result of fn", async () => {
    const result = await enqueue("proj-result", () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("operations on the same projectId run sequentially", async () => {
    const order: number[] = [];
    const entered: string[] = [];
    const firstEntry = deferred();
    const releaseFirst = deferred();
    const secondEntry = deferred();

    const first = enqueue("proj-seq", async () => {
      entered.push("first");
      firstEntry.resolve();
      await releaseFirst.promise;
      order.push(1);
    });
    const second = enqueue("proj-seq", async () => {
      entered.push("second");
      secondEntry.resolve();
      order.push(2);
    });

    try {
      await waitForEntryBeforeSettlement(firstEntry.promise, first);
      expect(entered).toEqual(["first"]);
      releaseFirst.resolve();
      await waitForEntryBeforeSettlement(secondEntry.promise, second);
      await Promise.all([first, second]);
      expect(entered).toEqual(["first", "second"]);
      expect(order).toEqual([1, 2]);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it("operations on different projectIds run in parallel", async () => {
    const started: string[] = [];
    const aEntry = deferred();
    const releaseA = deferred();
    const bEntry = deferred();
    const releaseB = deferred();

    const a = enqueue("proj-a", async () => {
      started.push("a");
      aEntry.resolve();
      await releaseA.promise;
    });
    const b = enqueue("proj-b", async () => {
      started.push("b");
      bEntry.resolve();
      await releaseB.promise;
    });

    try {
      await Promise.all([
        waitForEntryBeforeSettlement(aEntry.promise, a),
        waitForEntryBeforeSettlement(bEntry.promise, b),
      ]);
      expect(started).toHaveLength(2);
      expect(started).toEqual(expect.arrayContaining(["a", "b"]));
      releaseA.resolve();
      releaseB.resolve();
      await Promise.all([a, b]);
    } finally {
      releaseA.resolve();
      releaseB.resolve();
      await Promise.allSettled([a, b]);
    }
  });

  it("a failed operation does not block subsequent operations on the same project", async () => {
    const projectId = "proj-fail";

    const failing = enqueue(projectId, () => Promise.reject(new Error("boom")));
    const subsequent = enqueue(projectId, () => Promise.resolve("ok"));

    // The failing promise rejects…
    await expect(failing).rejects.toThrow("boom");
    // …but the subsequent one still resolves
    await expect(subsequent).resolves.toBe("ok");
  });

  it("queue cleans up after all operations complete", async () => {
    const projectId = "proj-cleanup";

    const op1 = enqueue(projectId, () => Promise.resolve(1));
    const op2 = enqueue(projectId, () => Promise.resolve(2));

    await Promise.all([op1, op2]);

    // After all ops complete, a new enqueue should still work correctly,
    // meaning the queue entry was removed and re-created fresh.
    const result = await enqueue(projectId, () => Promise.resolve("fresh"));
    expect(result).toBe("fresh");
  });

  it("propagates rejection from fn to the caller", async () => {
    const err = new Error("test-error");
    await expect(
      enqueue("proj-reject", () => Promise.reject(err))
    ).rejects.toThrow("test-error");
  });

  it("rejects pre-aborted work without entering its callback", async () => {
    const controller = new AbortController();
    controller.abort();
    let entered = false;

    const operation = enqueue("proj-pre-aborted", async () => {
      entered = true;
      return "unexpected";
    }, controller.signal);

    await expect(operation).rejects.toSatisfy(error => isAbortError(error));
    expect(entered).toBe(false);
  });

  it("rejects canceled work while waiting without entering its callback", async () => {
    const firstEntry = deferred();
    const releaseFirst = deferred();
    const controller = new AbortController();
    let entered = false;

    const first = enqueue("proj-wait-cancel", async () => {
      firstEntry.resolve();
      await releaseFirst.promise;
    });
    const second = enqueue("proj-wait-cancel", async () => {
      entered = true;
      return "unexpected";
    }, controller.signal);

    await firstEntry.promise;
    controller.abort();
    await expect(second).rejects.toSatisfy(error => isAbortError(error));
    expect(entered).toBe(false);

    releaseFirst.resolve();
    await expect(first).resolves.toBeUndefined();
  });

  it("keeps callback-owned settlement after abort and isolates callback rejection", async () => {
    const entry = deferred();
    const release = deferred();
    const controller = new AbortController();
    const operation = enqueue("proj-abort-after-start", async () => {
      entry.resolve();
      await release.promise;
      return "finished";
    }, controller.signal);

    await entry.promise;
    controller.abort();
    release.resolve();
    await expect(operation).resolves.toBe("finished");

    const failed = enqueue("proj-callback-reject", async () => {
      throw new Error("callback failed");
    });
    const following = enqueue("proj-callback-reject", async () => "following");
    await expect(failed).rejects.toThrow("callback failed");
    await expect(following).resolves.toBe("following");
  });

  it("settles a pre-aborted queue operation at claim time and keeps chain cleanup", async () => {
    let listener!: () => void;
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener: (_type: string, callback: () => void) => { listener = callback; },
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;
    let entered = false;
    const operation = enqueue("proj-claim-abort", async () => {
      entered = true;
      return "unexpected";
    }, signal);
    signal.aborted = true;
    listener();
    await expect(operation).rejects.toSatisfy(error => isAbortError(error));
    expect(entered).toBe(false);
    await expect(enqueue("proj-claim-abort", async () => "next")).resolves.toBe("next");
  });

  it("removes the abort listener when cancellation wins before callback entry", async () => {
    let listener!: () => void;
    let removed = 0;
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener: (_type: string, callback: () => void) => { listener = callback; },
      removeEventListener: (_type: string, callback: () => void) => {
        if (callback === listener) removed += 1;
      },
    } as unknown as AbortSignal;
    const operation = enqueue("proj-claim-listener-cleanup", async () => "unexpected", signal);
    signal.aborted = true;
    listener();

    await expect(operation).rejects.toSatisfy(error => isAbortError(error));
    expect(removed).toBeGreaterThan(0);
  });
});
