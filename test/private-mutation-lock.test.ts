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
  trustedProcessBirthExecutableForTesting,
  withPrivateMutationLock,
} from "../src/private-mutation-lock.js";
import { deleteRegularFile } from "../src/security-files.js";

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
  it("recovers an owned lock when cleanup fails after a successful mutation", () => {
    const { lockPath } = makeLock();
    const releaseFailure = new Error("release observer failed");

    expect(() => withPrivateMutationLock(lockPath, "test", () => "committed", (event) => {
      if (event === "before-main-lock-release-read") throw releaseFailure;
    })).toThrow(releaseFailure);
    expect(existsSync(lockPath)).toBe(false);
    expect(withPrivateMutationLock(lockPath, "test", () => "next"))
      .toBe("next");
  });

  it("tracks an owned lock when successful-mutation cleanup remains unavailable", () => {
    const { lockPath } = makeLock();
    const cleanupFailure = new Error("injected recovery deletion failure");
    let deleteAttempts = 0;

    expect(() => withPrivateMutationLock(lockPath, "test", () => "committed", (event) => {
      if (event === "before-main-lock-release-read") {
        throw new Error("release observer failed");
      }
    }, {
      deleteRegularFile(path) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw cleanupFailure;
        return deleteRegularFile(path);
      },
    })).toThrow("mutation succeeded but lock cleanup could not be recovered");

    expect(existsSync(lockPath)).toBe(true);
    expect(withPrivateMutationLock(lockPath, "test", () => "recovered"))
      .toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("tracks a successful mutation when the owned lock cannot be reread", () => {
    const { lockPath, strandedPath } = makeLock();
    let changed = false;

    expect(() => withPrivateMutationLock(lockPath, "test", () => "committed", (event, path) => {
      if (event !== "before-main-lock-release-read" || changed) return;
      changed = true;
      renameSync(path, strandedPath);
      mkdirSync(path);
    })).toThrow("mutation succeeded but lock cleanup could not be recovered");

    rmSync(lockPath, { recursive: true });
    renameSync(strandedPath, lockPath);
    expect(withPrivateMutationLock(lockPath, "test", () => "recovered"))
      .toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  });

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
    const primary = new Error("protected mutation failed");
    const cleanupFailure = new Error("injected recovery deletion failure");
    let deleteAttempts = 0;
    let thrown: unknown;
    try {
      withPrivateMutationLock(lockPath, "test", () => {
        throw primary;
      }, (event) => {
        if (event !== "before-main-lock-release-read") return;
        throw new Error("release observer failed");
      }, {
        deleteRegularFile(path) {
          deleteAttempts += 1;
          if (deleteAttempts === 1) throw cleanupFailure;
          return deleteRegularFile(path);
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).cause).toBe(primary);
    expect((thrown as AggregateError).errors).toEqual([
      primary,
      expect.any(Error),
      cleanupFailure,
    ]);
    expect(deleteAttempts).toBe(1);
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

describe("private mutation lock process-birth helpers", () => {
  it.each([
    ["darwin", "/bin/ps"],
    ["freebsd", "/bin/ps"],
    ["netbsd", "/bin/ps"],
    ["openbsd", "/bin/ps"],
    ["aix", "/usr/bin/ps"],
    ["sunos", "/usr/bin/ps"],
  ])("uses a trusted absolute ps path on %s", (currentPlatform, expected) => {
    expect(trustedProcessBirthExecutableForTesting(currentPlatform)).toBe(expected);
  });

  it("builds the PowerShell path only from a drive-absolute SystemRoot", () => {
    expect(trustedProcessBirthExecutableForTesting("win32", "C:\\Windows")).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    for (const systemRoot of [
      undefined,
      "",
      "Windows",
      "\\Windows",
      "\\\\attacker.invalid\\Windows",
    ]) {
      expect(trustedProcessBirthExecutableForTesting("win32", systemRoot)).toBeNull();
    }
    expect(trustedProcessBirthExecutableForTesting("linux", "/")).toBeNull();
  });

  it("never executes PATH or current-directory ps impostors", () => {
    const { lockPath } = makeLock();
    const root = join(lockPath, "..");
    const cwdImpostorDir = join(root, "cwd-impostor");
    const pathImpostorDir = join(root, "path-impostor");
    const markerPath = join(root, "impostor-ran");
    mkdirSync(cwdImpostorDir);
    mkdirSync(pathImpostorDir);
    for (const impostorPath of [
      join(cwdImpostorDir, "ps"),
      join(pathImpostorDir, "ps"),
    ]) {
      writeFileSync(impostorPath, `#!/bin/sh\nprintf compromised > '${markerPath}'\n`);
      chmodSync(impostorPath, 0o700);
    }
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    try {
      process.chdir(cwdImpostorDir);
      process.env.PATH = `.:${pathImpostorDir}`;
      expect(withPrivateMutationLock(
        lockPath,
        "test",
        () => "protected",
        (event, _path, mutable) => {
          if (event === "platform" && mutable) mutable.value = "darwin";
        },
      )).toBe("protected");
    } finally {
      process.chdir(previousCwd);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    expect(existsSync(markerPath)).toBe(false);
  });

  it("treats an unavailable trusted helper as ambiguous for a live owner", () => {
    const { lockPath } = makeLock();
    const observer = (
      event: string,
      _path: string,
      mutable?: { value: string },
    ): void => {
      if (event === "platform" && mutable) mutable.value = "darwin";
      if (event === "before-process-birth-command") {
        throw new Error("trusted helper unavailable");
      }
    };

    expect(withPrivateMutationLock(lockPath, "test", () => {
      expect(() => withPrivateMutationLock(
        lockPath,
        "test",
        () => undefined,
        observer,
      )).toThrowError(/owner state is ambiguous/u);
      return "protected";
    }, observer)).toBe("protected");
  });

  it("treats a platform without a trusted helper as ambiguous for a live owner", () => {
    const { lockPath } = makeLock();
    const observer = (
      event: string,
      _path: string,
      mutable?: { value: string },
    ): void => {
      if (event === "platform" && mutable) mutable.value = "unsupported";
    };

    expect(withPrivateMutationLock(lockPath, "test", () => {
      expect(() => withPrivateMutationLock(
        lockPath,
        "test",
        () => undefined,
        observer,
      )).toThrowError(/owner state is ambiguous/u);
      return "protected";
    }, observer)).toBe("protected");
  });
});
