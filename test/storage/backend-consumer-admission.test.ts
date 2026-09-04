import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertBackendPublicationConfigAccess,
  backendPublicationDirectory,
  backendPublicationHomeForConfigPath,
  withBackendPublicationConfigLock,
  withBackendPublicationConsumerLock,
  withBackendPublicationConsumerLockAsync,
} from "../../src/storage/backend-publication.js";
import {
  assertStorageBackendPublication,
  selectStorageBackendForConfig,
  withStorageBackendConsumerLock,
  withStorageBackendConsumerLockAsync,
} from "../../src/storage/backend.js";
import { BackendPublicationJournalError } from "../../src/storage/backend-publication.js";

const homes: string[] = [];

function makeHome(publicationDirectory = false): string {
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

async function interruptPublicationDirectoryValidation(
  home: string,
  action: () => unknown | Promise<unknown>,
): Promise<Readonly<{ injected: boolean; error: unknown }>> {
  const publicationDirectory = backendPublicationDirectory(home);
  const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
  const originalRealpath = nodeFs.realpathSync as (...args: unknown[]) => unknown;
  let injected = false;
  let error: unknown;
  try {
    nodeFs.realpathSync = ((path: string, ...args: unknown[]) => {
      if (path === publicationDirectory && !injected) {
        injected = true;
        rmSync(publicationDirectory, { recursive: true });
      }
      return originalRealpath(path, ...args);
    }) as never;
    syncBuiltinESMExports();
    try {
      await action();
    } catch (caught) {
      error = caught;
    }
  } finally {
    nodeFs.realpathSync = originalRealpath;
    syncBuiltinESMExports();
  }
  return { injected, error };
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

  it("admits SQLite only when the publication directory is genuinely absent", () => {
    const withDirectory = makeHome(true);
    const withoutDirectory = makeHome();
    expectReason(() => withStorageBackendConsumerLock(withDirectory, lockToken => {
      assertStorageBackendPublication({ backend: "sqlite", homeDir: withDirectory }, lockToken);
      return "locked";
    }), "publication-evidence-missing");
    expect(withStorageBackendConsumerLock(withoutDirectory, lockToken => {
      assertStorageBackendPublication({ backend: "sqlite", homeDir: withoutDirectory }, lockToken);
      return "unlocked";
    })).toBe("unlocked");
  });

  it("supports asynchronous admission on both lock paths", async () => {
    const withDirectory = makeHome(true);
    const withoutDirectory = makeHome();
    await expect(withStorageBackendConsumerLockAsync(withDirectory, async lockToken => {
      assertStorageBackendPublication({ backend: "sqlite", homeDir: withDirectory }, lockToken);
      return "locked";
    })).rejects.toMatchObject({ reason: "publication-evidence-missing" });
    await expect(withStorageBackendConsumerLockAsync(withoutDirectory, async lockToken => {
      assertStorageBackendPublication({ backend: "sqlite", homeDir: withoutDirectory }, lockToken);
      return "unlocked";
    })).resolves.toBe("unlocked");
  });

  it("rejects interrupted synchronous publication-directory authentication", async () => {
    const home = makeHome(true);
    let callbackRan = false;

    const observed = await interruptPublicationDirectoryValidation(home, () => {
      withStorageBackendConsumerLock(home, lockToken => {
        callbackRan = true;
        assertStorageBackendPublication({ backend: "sqlite", homeDir: home }, lockToken);
      });
    });

    expect(observed.injected).toBe(true);
    expect(callbackRan).toBe(false);
    expect(observed.error).toBeInstanceOf(BackendPublicationJournalError);
    expect(observed.error).toMatchObject({ reason: "unsafe-storage" });
  });

  it("rejects interrupted asynchronous publication-directory authentication", async () => {
    const home = makeHome(true);
    let callbackRan = false;

    const observed = await interruptPublicationDirectoryValidation(home, async () => {
      await withStorageBackendConsumerLockAsync(home, async lockToken => {
        callbackRan = true;
        assertStorageBackendPublication({ backend: "sqlite", homeDir: home }, lockToken);
      });
    });

    expect(observed.injected).toBe(true);
    expect(callbackRan).toBe(false);
    expect(observed.error).toBeInstanceOf(BackendPublicationJournalError);
    expect(observed.error).toMatchObject({ reason: "unsafe-storage" });
  });

  it("rejects interrupted publication authentication beneath a non-private root", async () => {
    const home = makeHome(true);
    chmodSync(join(home, ".lcm"), 0o755);
    let callbackRan = false;

    const observed = await interruptPublicationDirectoryValidation(home, () => {
      withStorageBackendConsumerLock(home, lockToken => {
        callbackRan = true;
        assertStorageBackendPublication({ backend: "sqlite", homeDir: home }, lockToken);
      });
    });

    expect(observed.injected).toBe(true);
    expect(callbackRan).toBe(false);
    expect(observed.error).toBeInstanceOf(BackendPublicationJournalError);
    expect(observed.error).toMatchObject({ reason: "unsafe-storage" });
  });

  it("reuses the exact live token for the same canonical home and revokes retained continuations", async () => {
    const home = makeHome();
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    let retainedUse: (() => object) | undefined;
    let releaseDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detachedUse: Promise<object> | undefined;
    try {
      await expect(withBackendPublicationConsumerLockAsync(home, async (outerToken) => {
        retainedUse = () => withBackendPublicationConsumerLock(
          undefined,
          (nestedToken) => nestedToken,
          { lockToken: outerToken },
        );
        expect(retainedUse()).toBe(outerToken);
        detachedUse = detachedGate.then(() => withBackendPublicationConsumerLock(
          undefined,
          (nestedToken) => nestedToken,
          { lockToken: outerToken },
        ));
      })).resolves.toBeUndefined();

      expectReason(() => retainedUse!(), "permit-mismatch");
      releaseDetached();
      await expect(detachedUse).rejects.toMatchObject({
        name: "BackendPublicationJournalError",
        reason: "permit-mismatch",
      });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
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
    const syncHome = makeHome(true);
    chmodSync(join(syncHome, ".lcm", "backend-publication"), 0o755);
    expectReason(() => withStorageBackendConsumerLock(syncHome, () => "never"), "unsafe-storage");

    const asyncHome = makeHome(true);
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
