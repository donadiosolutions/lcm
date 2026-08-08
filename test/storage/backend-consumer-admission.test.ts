import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertBackendPublicationConfigAccess,
  backendPublicationHomeForConfigPath,
  withBackendPublicationConfigLock,
} from "../../src/storage/backend-publication.js";
import {
  assertStorageBackendPublication,
  selectStorageBackendForConfig,
  withStorageBackendConsumerLock,
  withStorageBackendConsumerLockAsync,
} from "../../src/storage/backend.js";
import { BackendPublicationJournalError } from "../../src/storage/backend-publication.js";

const homes: string[] = [];

function makeHome(publicationDirectory = true): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-backend-consumer-"));
  homes.push(home);
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  if (publicationDirectory) mkdirSync(join(home, ".lcm", "backend-publication"), { mode: 0o700 });
  return home;
}

function configPath(home: string): string {
  return join(home, ".lcm", "config.json");
}

function expectReason(action: () => unknown, reason: BackendPublicationJournalError["reason"]): void {
  expect(action).toThrowError(expect.objectContaining({
    name: "BackendPublicationJournalError",
    reason,
  }));
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("backend publication consumer admission", () => {
  it("recognizes only the canonical config scope", () => {
    const home = makeHome();
    expect(backendPublicationHomeForConfigPath(configPath(home))).toBe(home);
    expect(backendPublicationHomeForConfigPath(join(home, "config.json"))).toBeUndefined();
    expect(backendPublicationHomeForConfigPath(join(home, ".lcm", "other.json"))).toBeUndefined();
    expect(() => assertBackendPublicationConfigAccess(join(home, "config.json"), "sqlite")).not.toThrow();
    expect(() => selectStorageBackendForConfig(join(home, ".lcm", "other.json"), { backend: "sqlite" }))
      .toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));
  });

  it("admits SQLite with and without a publication directory", () => {
    const withDirectory = makeHome();
    const withoutDirectory = makeHome(false);
    expect(withStorageBackendConsumerLock(withDirectory, lockToken => {
      assertStorageBackendPublication({ backend: "sqlite", homeDir: withDirectory }, lockToken);
      return "locked";
    })).toBe("locked");
    expect(withStorageBackendConsumerLock(withoutDirectory, lockToken => {
      assertStorageBackendPublication({ backend: "sqlite", homeDir: withoutDirectory }, lockToken);
      return "unlocked";
    })).toBe("unlocked");
  });

  it("supports asynchronous admission on both lock paths", async () => {
    const withDirectory = makeHome();
    const withoutDirectory = makeHome(false);
    await expect(withStorageBackendConsumerLockAsync(withDirectory, async lockToken => {
      assertStorageBackendPublication({ backend: "sqlite", homeDir: withDirectory }, lockToken);
      return "locked";
    })).resolves.toBe("locked");
    await expect(withStorageBackendConsumerLockAsync(withoutDirectory, async lockToken => {
      assertStorageBackendPublication({ backend: "sqlite", homeDir: withoutDirectory }, lockToken);
      return "unlocked";
    })).resolves.toBe("unlocked");
  });

  it("serializes canonical config reads and activates the callback token", () => {
    const missingRootHome = makeHome(false);
    rmSync(join(missingRootHome, ".lcm"), { recursive: true, force: true });
    expect(withBackendPublicationConfigLock(configPath(missingRootHome), lockToken => {
      assertBackendPublicationConfigAccess(configPath(missingRootHome), "sqlite", undefined, undefined, lockToken);
      return "missing-root";
    })).toBe("missing-root");

    const existingRootHome = makeHome();
    expect(withBackendPublicationConfigLock(configPath(existingRootHome), lockToken => {
      assertBackendPublicationConfigAccess(configPath(existingRootHome), "sqlite", undefined, undefined, lockToken);
      return "existing-root";
    })).toBe("existing-root");

    expect(withBackendPublicationConfigLock(join(existingRootHome, "config.json"), lockToken => {
      expect(lockToken).toEqual({});
      return "unscoped";
    })).toBe("unscoped");
  });

  it("fails closed for unsafe publication directories", async () => {
    const syncHome = makeHome();
    chmodSync(join(syncHome, ".lcm", "backend-publication"), 0o755);
    expectReason(() => withStorageBackendConsumerLock(syncHome, () => "never"), "unsafe-storage");

    const asyncHome = makeHome();
    chmodSync(join(asyncHome, ".lcm", "backend-publication"), 0o755);
    await expect(withStorageBackendConsumerLockAsync(asyncHome, () => "never"))
      .rejects.toMatchObject({ reason: "unsafe-storage" });
  });

  it("rejects inactive and cross-home lock tokens", () => {
    const home = makeHome();
    expectReason(() => assertStorageBackendPublication({ backend: "sqlite", homeDir: home }, {}), "permit-mismatch");

    const otherHome = makeHome();
    expectReason(() => withStorageBackendConsumerLock(home, lockToken =>
      assertStorageBackendPublication({ backend: "sqlite", homeDir: otherHome }, lockToken)), "permit-mismatch");
  });

  it("uses the canonical coordinator token position for config admission", () => {
    const home = makeHome();
    const path = configPath(home);
    expect(withBackendPublicationConfigLock(path, lockToken => {
      expect(() => assertBackendPublicationConfigAccess(
        path,
        "sqlite",
        undefined,
        undefined,
        lockToken,
      )).not.toThrow();
      return "canonical";
    })).toBe("canonical");
  });
});
