import { describe, it, expect } from "vitest";
import { enqueue } from "../../src/daemon/project-queue.js";

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
      await firstEntry.promise;
      expect(entered).toEqual(["first"]);
      releaseFirst.resolve();
      await secondEntry.promise;
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
      await Promise.all([aEntry.promise, bEntry.promise]);
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
});
