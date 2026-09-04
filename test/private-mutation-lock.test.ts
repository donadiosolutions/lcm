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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PrivateMutationLockContentionError,
  PrivateMutationPermitRevokedError,
  processStartTime,
  readPrivateMutationLockOwner,
  trustedProcessBirthExecutableForTesting,
  withPrivateMutationLock,
  withPrivateMutationLocksAsync,
  withRevocablePrivateMutationPermit,
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

function ownerContent(
  nonce: string,
  overrides: Partial<{
    pid: number;
    processStartTime: string | null;
    createdAtMs: number;
  }> = {},
): string {
  return `${JSON.stringify({
    version: 1,
    pid: process.pid,
    processStartTime: "0",
    nonce,
    createdAtMs: 1,
    ...overrides,
  })}\n`;
}

function currentProcessStartTime(): string {
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
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
  it("reads only an authenticated owner record and treats absence as no owner", () => {
    const { lockPath } = makeLock();
    expect(readPrivateMutationLockOwner(lockPath)).toBeNull();
    writeFileSync(lockPath, ownerContent("a".repeat(32)), { mode: 0o600 });
    expect(readPrivateMutationLockOwner(lockPath)).toMatchObject({
      pid: process.pid,
      processStartTime: "0",
    });
    writeFileSync(lockPath, "{", { mode: 0o600 });
    expect(() => readPrivateMutationLockOwner(lockPath)).toThrow("lock is malformed");
  });

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

  it("reclaims a stale owner through a descriptor-safe successor claim", () => {
    const { lockPath } = makeLock();
    const stale = ownerContent("a".repeat(32));
    writeFileSync(lockPath, stale, { mode: 0o600 });
    const events: string[] = [];

    expect(withPrivateMutationLock(
      lockPath,
      "stale",
      () => "reclaimed",
      (event) => events.push(event),
    )).toBe("reclaimed");
    expect(events).toEqual(expect.arrayContaining([
      "before-claim-mkdir",
      "after-claim-mkdir",
      "before-reclaim-owner-publish",
      "before-claim-removal-read",
      "before-stale-lock-read",
      "before-stale-lock-delete",
      "before-successor-lock-create",
      "before-claim-release-read",
      "before-claim-release-delete",
    ]));
    expect(existsSync(lockPath)).toBe(false);
  });

  it("reclaims a stale claim after moving its old tombstone aside", () => {
    const { lockPath } = makeLock();
    const nonce = "7".repeat(32);
    writeFileSync(lockPath, ownerContent(nonce), { mode: 0o600 });
    const claimPath = `${lockPath}.reclaim-${nonce}`;
    mkdirSync(claimPath);
    writeFileSync(join(claimPath, "owner.json"), ownerContent("8".repeat(32)), { mode: 0o600 });

    expect(withPrivateMutationLock(lockPath, "stale-claim", () => "reclaimed"))
      .toBe("reclaimed");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("rejects malformed and invalid existing lock owners", () => {
    const malformed = makeLock();
    writeFileSync(malformed.lockPath, "{", { mode: 0o600 });
    expect(() => withPrivateMutationLock(malformed.lockPath, "malformed", () => undefined))
      .toThrow("lock is malformed");

    const invalid = makeLock();
    writeFileSync(invalid.lockPath, JSON.stringify({ version: 2 }), { mode: 0o600 });
    expect(() => withPrivateMutationLock(invalid.lockPath, "invalid", () => undefined))
      .toThrow("lock has an invalid owner");
  });

  it("fails closed when process birth evidence is unavailable or probing is ambiguous", () => {
    const unavailable = makeLock();
    writeFileSync(unavailable.lockPath, ownerContent("b".repeat(32)), { mode: 0o600 });
    const unavailableObserver = (event: string): void => {
      if (event === "before-process-stat-read") throw new Error("stat unavailable");
    };
    expect(() => withPrivateMutationLock(
      unavailable.lockPath,
      "unavailable",
      () => undefined,
      unavailableObserver,
    )).toThrow(/owner state is ambiguous/u);

    const ambiguous = makeLock();
    writeFileSync(ambiguous.lockPath, ownerContent("c".repeat(32)), { mode: 0o600 });
    const ambiguousObserver = (event: string): void => {
      if (event === "before-process-probe") throw new Error("probe unavailable");
    };
    expect(() => withPrivateMutationLock(
      ambiguous.lockPath,
      "ambiguous",
      () => undefined,
      ambiguousObserver,
    )).toThrow(/owner state is ambiguous/u);
  });

  it("handles an unreadable reclaim owner and a failed stale-claim rename", () => {
    const unreadable = makeLock();
    const unreadableNonce = "9".repeat(32);
    writeFileSync(unreadable.lockPath, ownerContent(unreadableNonce), { mode: 0o600 });
    const unreadableClaim = `${unreadable.lockPath}.reclaim-${unreadableNonce}`;
    mkdirSync(unreadableClaim);
    mkdirSync(join(unreadableClaim, "owner.json"));
    expect(() => withPrivateMutationLock(unreadable.lockPath, "unreadable-claim", () => undefined))
      .toThrow("regular file");

    const renameFailure = makeLock();
    const renameNonce = "a".repeat(32);
    writeFileSync(renameFailure.lockPath, ownerContent(renameNonce), { mode: 0o600 });
    const renameClaim = `${renameFailure.lockPath}.reclaim-${renameNonce}`;
    mkdirSync(renameClaim);
    writeFileSync(join(renameClaim, "owner.json"), ownerContent("b".repeat(32)), { mode: 0o600 });
    expect(() => withPrivateMutationLock(renameFailure.lockPath, "rename-failure", () => undefined, (event) => {
      if (event === "before-claim-rename") throw new Error("rename unavailable");
    })).toThrow("changed during stale-owner recovery");
  });

  it("reclaims an owner whose PID has disappeared", () => {
    const { lockPath } = makeLock();
    writeFileSync(lockPath, ownerContent("c".repeat(32), { pid: 999_999_999 }), { mode: 0o600 });
    expect(withPrivateMutationLock(lockPath, "dead-owner", () => "reclaimed"))
      .toBe("reclaimed");
  });

  it("retries an owner read that disappears once and succeeds", () => {
    const { lockPath } = makeLock();
    writeFileSync(lockPath, ownerContent("d".repeat(32)), { mode: 0o600 });
    let disappeared = false;

    expect(withPrivateMutationLock(lockPath, "retry", () => "ok", (event, path) => {
      if (event === "before-main-lock-owner-read" && !disappeared) {
        disappeared = true;
        rmSync(path);
      }
    })).toBe("ok");
    expect(disappeared).toBe(true);
  });

  it("reports repeated owner disappearance instead of spinning", () => {
    const { lockPath } = makeLock();
    writeFileSync(lockPath, ownerContent("e".repeat(32)), { mode: 0o600 });
    const observer = (event: string, path: string): void => {
      if (event === "before-main-lock-publish" && !existsSync(path)) {
        writeFileSync(path, ownerContent("f".repeat(32)), { mode: 0o600 });
      }
      if (event === "before-main-lock-owner-read") rmSync(path);
    };

    expect(() => withPrivateMutationLock(lockPath, "repeat", () => undefined, observer))
      .toThrow("changed repeatedly");
  });

  it("handles missing process start fields and the Windows birth-command path", () => {
    const missingField = makeLock();
    writeFileSync(missingField.lockPath, ownerContent("d".repeat(32)), { mode: 0o600 });
    expect(() => withPrivateMutationLock(missingField.lockPath, "missing-start", () => undefined, (event, _path, mutable) => {
      if (event === "after-process-stat-read" && mutable) mutable.value = ")";
    })).toThrow(/owner state is ambiguous/u);

    const windows = makeLock();
    writeFileSync(windows.lockPath, ownerContent("e".repeat(32)), { mode: 0o600 });
    const previousRoot = process.env.SystemRoot;
    process.env.SystemRoot = "C:\\Windows";
    try {
      expect(() => withPrivateMutationLock(windows.lockPath, "windows", () => undefined, (event, _path, mutable) => {
        if (event === "platform" && mutable) mutable.value = "win32";
      })).toThrow(/owner state is ambiguous/u);
    } finally {
      if (previousRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousRoot;
    }
  });

  it("covers release ownership, disappearance, and cleanup failure branches", () => {
    const mismatch = makeLock();
    expect(() => withPrivateMutationLock(mismatch.lockPath, "release-mismatch", () => "ok", (event, path) => {
      if (event === "before-main-lock-release-read") {
        writeFileSync(path, ownerContent("f".repeat(32)), { mode: 0o600 });
      }
    })).toThrow("ownership changed during cleanup");

    const missingAfterSuccess = makeLock();
    const releaseFailure = new Error("release failed after disappearance");
    expect(() => withPrivateMutationLock(missingAfterSuccess.lockPath, "release-missing-success", () => "ok", (event, path) => {
      if (event === "before-main-lock-release-read") {
        rmSync(path);
        throw releaseFailure;
      }
    })).toThrow(releaseFailure);

    const primary = new Error("callback failed");
    const missingAfterFailure = makeLock();
    let thrown: unknown;
    try {
      withPrivateMutationLock(missingAfterFailure.lockPath, "release-missing-failure", () => {
        throw primary;
      }, (event, path) => {
        if (event === "before-main-lock-release-read") {
          rmSync(path);
          throw releaseFailure;
        }
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(primary);

    const deleteFalse = makeLock();
    expect(() => withPrivateMutationLock(deleteFalse.lockPath, "release-delete-false", () => "ok", undefined, {
      deleteRegularFile: () => false,
    })).toThrow("disappeared before release");
  });
});

describe("private mutation lock reclamation boundaries", () => {
  it("distinguishes a missing, live, and ambiguous reclaim claim", () => {
    const missing = makeLock();
    writeFileSync(missing.lockPath, ownerContent("1".repeat(32)), { mode: 0o600 });
    mkdirSync(`${missing.lockPath}.reclaim-${"1".repeat(32)}`);
    expect(() => withPrivateMutationLock(missing.lockPath, "missing-claim", () => undefined))
      .toThrow("changed during acquisition");

    const live = makeLock();
    writeFileSync(live.lockPath, ownerContent("2".repeat(32)), { mode: 0o600 });
    const liveClaim = `${live.lockPath}.reclaim-${"2".repeat(32)}`;
    mkdirSync(liveClaim);
    writeFileSync(join(liveClaim, "owner.json"), ownerContent("3".repeat(32), {
      processStartTime: currentProcessStartTime(),
    }), { mode: 0o600 });
    expect(() => withPrivateMutationLock(live.lockPath, "live-claim", () => undefined))
      .toThrow(PrivateMutationLockContentionError);
    expect(() => withPrivateMutationLock(live.lockPath, "live-claim", () => undefined))
      .toThrow(/owned by live PID/u);

    const ambiguous = makeLock();
    writeFileSync(ambiguous.lockPath, ownerContent("4".repeat(32)), { mode: 0o600 });
    const ambiguousClaim = `${ambiguous.lockPath}.reclaim-${"4".repeat(32)}`;
    mkdirSync(ambiguousClaim);
    writeFileSync(join(ambiguousClaim, "owner.json"), ownerContent("5".repeat(32), {
      processStartTime: null,
    }), { mode: 0o600 });
    expect(() => withPrivateMutationLock(ambiguous.lockPath, "ambiguous-claim", () => undefined))
      .toThrow(/owner state is ambiguous/u);
  });

  it("cleans a partial claim when owner publication fails", () => {
    const { lockPath } = makeLock();
    const nonce = "6".repeat(32);
    writeFileSync(lockPath, ownerContent(nonce), { mode: 0o600 });
    const observer = (event: string, path: string): void => {
      if (event === "before-reclaim-owner-publish") {
        writeFileSync(path, ownerContent("7".repeat(32)), { mode: 0o600 });
      }
    };

    expect(() => withPrivateMutationLock(lockPath, "claim-owner", () => undefined, observer))
      .toThrow("claim owner already exists");
  });

  it("reports claim directory creation failures and removes an empty partial claim", () => {
    const denied = makeLock();
    const deniedNonce = "8".repeat(32);
    writeFileSync(denied.lockPath, ownerContent(deniedNonce), { mode: 0o600 });
    const error = Object.assign(new Error("claim mkdir denied"), { code: "EACCES" });
    expect(() => withPrivateMutationLock(denied.lockPath, "claim-mkdir", () => undefined, (event) => {
      if (event === "before-claim-mkdir") throw error;
    })).toThrow(error);

    const partial = makeLock();
    const partialNonce = "9".repeat(32);
    writeFileSync(partial.lockPath, ownerContent(partialNonce), { mode: 0o600 });
    const partialClaim = `${partial.lockPath}.reclaim-${partialNonce}`;
    expect(() => withPrivateMutationLock(partial.lockPath, "claim-partial", () => undefined, (event) => {
      if (event === "after-claim-mkdir") throw new Error("claim observer failed");
    })).toThrow("claim observer failed");
    expect(existsSync(partialClaim)).toBe(false);
  });

  it("fails closed when a stale claim is renamed concurrently", () => {
    const { lockPath } = makeLock();
    const nonce = "a".repeat(32);
    writeFileSync(lockPath, ownerContent(nonce), { mode: 0o600 });
    const claimPath = `${lockPath}.reclaim-${nonce}`;
    mkdirSync(claimPath);
    writeFileSync(join(claimPath, "owner.json"), ownerContent("b".repeat(32)), { mode: 0o600 });
    expect(() => withPrivateMutationLock(lockPath, "claim-race", () => undefined, (event, path) => {
      if (event === "after-claim-rename") {
        mkdirSync(path);
        writeFileSync(join(path, "owner.json"), ownerContent("b".repeat(32)), { mode: 0o600 });
      }
    })).toThrow("claimed concurrently");
  });

  it("preserves a successor when reclaim evidence is changed or disappears", () => {
    const changedClaim = makeLock();
    const changedNonce = "c".repeat(32);
    writeFileSync(changedClaim.lockPath, ownerContent(changedNonce), { mode: 0o600 });
    expect(() => withPrivateMutationLock(changedClaim.lockPath, "claim-changed", () => undefined, (event, path) => {
      if (event === "before-claim-removal-read") writeFileSync(path, ownerContent("d".repeat(32)), { mode: 0o600 });
    })).toThrow("reclamation ownership changed before release");

    const changedLock = makeLock();
    const changedLockNonce = "e".repeat(32);
    writeFileSync(changedLock.lockPath, ownerContent(changedLockNonce), { mode: 0o600 });
    expect(() => withPrivateMutationLock(changedLock.lockPath, "lock-changed", () => undefined, (event, path) => {
      if (event === "before-stale-lock-read") writeFileSync(path, ownerContent("f".repeat(32)), { mode: 0o600 });
    })).toThrow("changed while checking");

    const disappeared = makeLock();
    const disappearedNonce = "1".repeat(32);
    writeFileSync(disappeared.lockPath, ownerContent(disappearedNonce), { mode: 0o600 });
    expect(() => withPrivateMutationLock(disappeared.lockPath, "lock-disappeared", () => undefined, undefined, {
      deleteRegularFile(path) {
        if (path === disappeared.lockPath) return false;
        return deleteRegularFile(path);
      },
    })).toThrow("disappeared during stale-owner recovery");
  });

  it("suppresses reclaim cleanup failures after publishing an authoritative successor", () => {
    const mismatch = makeLock();
    const mismatchNonce = "2".repeat(32);
    writeFileSync(mismatch.lockPath, ownerContent(mismatchNonce), { mode: 0o600 });
    expect(withPrivateMutationLock(mismatch.lockPath, "claim-release-mismatch", () => "ok", (event, path) => {
      if (event === "before-claim-release-read") writeFileSync(path, ownerContent("3".repeat(32)), { mode: 0o600 });
    })).toBe("ok");

    const deleteFailure = makeLock();
    const deleteFailureNonce = "4".repeat(32);
    writeFileSync(deleteFailure.lockPath, ownerContent(deleteFailureNonce), { mode: 0o600 });
    expect(withPrivateMutationLock(deleteFailure.lockPath, "claim-release-delete", () => "ok", undefined, {
      deleteRegularFile(path) {
        if (path.endsWith("owner.json")) return false;
        return deleteRegularFile(path);
      },
    })).toBe("ok");
  });

  it("reports successor publication races", () => {
    const { lockPath } = makeLock();
    const nonce = "5".repeat(32);
    writeFileSync(lockPath, ownerContent(nonce), { mode: 0o600 });
    expect(() => withPrivateMutationLock(lockPath, "successor-race", () => undefined, (event, path) => {
      if (event === "before-successor-lock-create") writeFileSync(path, ownerContent("6".repeat(32)), { mode: 0o600 });
    })).toThrow("claimed concurrently");
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

  it.each([
    ["darwin", undefined, "/bin/ps", ["-o", "lstart=", "-p", "42"], 7],
    [
      "win32",
      "C:\\Windows",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_Process -Filter 'ProcessId = 42').CreationDate.ToUniversalTime().ToString('O')",
      ],
      9,
    ],
  ] as const)("passes the bounded %s birth-probe timeout to the trusted helper", (
    currentPlatform,
    systemRoot,
    expectedCommand,
    expectedArgs,
    timeoutMs,
  ) => {
    const previousSystemRoot = process.env.SystemRoot;
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
    const execute = vi.fn(() => "birth-time\n");
    try {
      expect(processStartTime(42, (event, _path, mutable) => {
        if (event === "platform" && mutable) mutable.value = currentPlatform;
      }, { timeoutMs, _execFileSyncForTesting: execute })).toBe("birth-time");
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
    }
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expectedCommand, expectedArgs, expect.objectContaining({
      timeout: timeoutMs,
    }));
  });

  it("keeps the process-birth helper bounded by the default two-second maximum", () => {
    const execute = vi.fn(() => "birth-time");
    const observer: Parameters<typeof processStartTime>[1] = (event, _path, mutable) => {
      if (event === "platform" && mutable) mutable.value = "darwin";
    };

    expect(processStartTime(42, observer, {
      timeoutMs: 20_000,
      _execFileSyncForTesting: execute,
    })).toBe("birth-time");
    expect(execute).toHaveBeenLastCalledWith("/bin/ps", ["-o", "lstart=", "-p", "42"], expect.objectContaining({
      timeout: 2_000,
    }));
    expect(processStartTime(42, observer, {
      _execFileSyncForTesting: execute,
    })).toBe("birth-time");
    expect(execute).toHaveBeenLastCalledWith("/bin/ps", ["-o", "lstart=", "-p", "42"], expect.objectContaining({
      timeout: 2_000,
    }));
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses an unusable process-birth timeout %s without invoking the helper",
    (timeoutMs) => {
      const execute = vi.fn(() => "birth-time");
      expect(processStartTime(42, (event, _path, mutable) => {
        if (event === "platform" && mutable) mutable.value = "darwin";
      }, { timeoutMs, _execFileSyncForTesting: execute })).toBeNull();
      expect(execute).not.toHaveBeenCalled();
    },
  );

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

  it("acquires multiple mutation locks in sorted order and collapses duplicates", async () => {
    const { lockPath } = makeLock();
    const root = join(lockPath, "..");
    const first = join(root, "a.lock");
    const second = join(root, "b.lock");
    const published: string[] = [];
    await expect(withPrivateMutationLocksAsync(
      [second, first, second],
      "ordered",
      () => "done",
      (event, path) => {
        if (event === "before-main-lock-publish") published.push(path);
      },
    )).resolves.toBe("done");
    expect(published).toEqual([first, second]);
    await expect(withPrivateMutationLocksAsync([], "empty", () => 42)).resolves.toBe(42);
  });

  it("revokes explicit permits instead of leaking authority into child work", async () => {
    let retained: { assertActive: () => void } | undefined;
    await withRevocablePrivateMutationPermit("ordered", (permit) => {
      retained = permit;
      permit.assertActive();
    });
    expect(() => retained?.assertActive()).toThrow(PrivateMutationPermitRevokedError);
  });

  it("requires a permit label and reports its active state", async () => {
    await expect(withRevocablePrivateMutationPermit("", () => undefined))
      .rejects.toThrow("label is required");
    let active = false;
    let permit: { active: boolean } | undefined;
    await withRevocablePrivateMutationPermit("active", (current) => {
      permit = current;
      active = current.active;
    });
    expect(active).toBe(true);
    expect(permit?.active).toBe(false);
  });
});
