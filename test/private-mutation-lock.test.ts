import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PrivateMutationLockContentionError,
  withPrivateMutationLock,
} from "../src/private-mutation-lock.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeLock(): { lockPath: string; strandedPath: string } {
  const root = mkdtempSync(join(tmpdir(), "lcm-private-lock-"));
  roots.push(root);
  return {
    lockPath: join(root, "mutation.lock"),
    strandedPath: join(root, "stranded.lock"),
  };
}

function strandOwnedLock(
  lockPath: string,
  strandedPath: string,
  primary: Error,
): AggregateError {
  let changed = false;
  let thrown: unknown;
  try {
    withPrivateMutationLock(lockPath, "test", () => {
      throw primary;
    }, (event, path) => {
      if (event !== "before-main-lock-release-read" || changed) return;
      changed = true;
      renameSync(path, strandedPath);
      mkdirSync(path);
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AggregateError);
  expect((thrown as AggregateError).cause).toBe(primary);
  expect((thrown as AggregateError).errors).toContain(primary);
  return thrown as AggregateError;
}

describe("private mutation lock release recovery", () => {
  it("surfaces the initial cleanup failure after deleting its owned lock", () => {
    const { lockPath } = makeLock();
    const primary = new Error("protected mutation failed");
    const releaseFailure = new Error("release observer failed");
    let thrown: unknown;
    try {
      withPrivateMutationLock(lockPath, "test", () => {
        throw primary;
      }, (event) => {
        if (event === "before-main-lock-release-read") throw releaseFailure;
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).cause).toBe(primary);
    expect((thrown as AggregateError).errors).toEqual([
      primary,
      releaseFailure,
    ]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("recovers an exactly tracked same-process lock on the next mutation", () => {
    const { lockPath, strandedPath } = makeLock();
    const primary = new Error("protected mutation failed");
    const failure = strandOwnedLock(lockPath, strandedPath, primary);
    expect(failure.errors).toHaveLength(3);

    rmSync(lockPath, { recursive: true });
    renameSync(strandedPath, lockPath);
    expect(withPrivateMutationLock(lockPath, "test", () => "recovered"))
      .toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("tracks a lock when recovery deletion fails and reclaims it after access returns", () => {
    const { lockPath } = makeLock();
    const root = join(lockPath, "..");
    const primary = new Error("protected mutation failed");
    let thrown: unknown;
    try {
      withPrivateMutationLock(lockPath, "test", () => {
        throw primary;
      }, (event) => {
        if (event !== "before-main-lock-release-read") return;
        chmodSync(root, 0o500);
        throw new Error("release observer failed");
      });
    } catch (error) {
      thrown = error;
    } finally {
      chmodSync(root, 0o700);
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).cause).toBe(primary);
    expect((thrown as AggregateError).errors).toHaveLength(3);
    expect(existsSync(lockPath)).toBe(true);
    expect(withPrivateMutationLock(lockPath, "test", () => "recovered"))
      .toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("surfaces ownership replacement during release recovery without deleting it", () => {
    const { lockPath } = makeLock();
    const primary = new Error("protected mutation failed");
    let replacementNonce = "";
    let thrown: unknown;
    try {
      withPrivateMutationLock(lockPath, "test", () => {
        throw primary;
      }, (event, path) => {
        if (event !== "before-main-lock-release-read") return;
        const replacement = JSON.parse(readFileSync(path, "utf8")) as {
          nonce: string;
        };
        replacementNonce = replacement.nonce === "f".repeat(32)
          ? "e".repeat(32)
          : "f".repeat(32);
        replacement.nonce = replacementNonce;
        writeFileSync(path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
        throw new Error("release observer failed");
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).cause).toBe(primary);
    expect((thrown as AggregateError).errors).toHaveLength(3);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      nonce: replacementNonce,
    });
  });

  it("never reclaims a replacement owner after a tracked release failure", () => {
    const { lockPath, strandedPath } = makeLock();
    strandOwnedLock(lockPath, strandedPath, new Error("protected mutation failed"));
    const replacement = JSON.parse(readFileSync(strandedPath, "utf8")) as {
      nonce: string;
    };
    replacement.nonce = replacement.nonce === "f".repeat(32)
      ? "e".repeat(32)
      : "f".repeat(32);
    rmSync(lockPath, { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

    expect(() => withPrivateMutationLock(lockPath, "test", () => undefined))
      .toThrow(PrivateMutationLockContentionError);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      nonce: replacement.nonce,
    });
  });
});
