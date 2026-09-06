import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertBackendPublicationConfigAccess,
  backendPublicationDirectory,
  backendPublicationHomeForConfigPath,
  openBackendPublicationReadRoot,
  withBackendPublicationConfigLock,
  withBackendPublicationConsumerLock,
  withBackendPublicationConsumerLockAsync,
  withBackendPublicationReadRoot,
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

type DescriptorLifetime = Readonly<{
  id: number;
  path: string;
  fd: number;
  closed: boolean;
}>;

type DescriptorProbeOptions = Readonly<{
  readonly openErrorCode?: "EACCES" | "ENOTDIR" | "ELOOP";
  readonly openFailure?: Readonly<{ path: string; error: NodeJS.ErrnoException }>;
  readonly realpathFailure?: Readonly<{ path: string; error: NodeJS.ErrnoException }>;
  readonly closeFailure?: Readonly<{ path: string; error: Error }>;
  readonly validationFailure?: boolean;
}>;

type ConsumerAction = (home: string, onRun: () => void) => unknown | Promise<unknown>;

async function observeConsumerDescriptorLifetimes(
  home: string,
  action: () => unknown | Promise<unknown>,
  options: DescriptorProbeOptions = {},
): Promise<Readonly<{
  readonly injected: boolean;
  readonly closeFailureInjected: boolean;
  readonly unrelatedDelegated: boolean;
  readonly error: unknown;
  readonly lifetimes: readonly DescriptorLifetime[];
}>> {
  const root = join(home, ".lcm");
  const publication = backendPublicationDirectory(home);
  const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
  const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
  const originalClose = nodeFs.closeSync as (fd: number) => void;
  const originalRealpath = nodeFs.realpathSync as (...args: unknown[]) => unknown;
  const live = new Map<number, DescriptorLifetime>();
  const lifetimes: DescriptorLifetime[] = [];
  let nextId = 0;
  let injected = false;
  let closeFailureInjected = false;
  let unrelatedDelegated = false;
  let error: unknown;
  const targetPaths = new Set([root, publication]);
  try {
    nodeFs.openSync = ((path: unknown, ...args: unknown[]) => {
      const pathString = typeof path === "string" ? path : undefined;
      if (pathString !== undefined && !targetPaths.has(pathString)) unrelatedDelegated = true;
      if (options.openFailure !== undefined && pathString === options.openFailure.path && !injected) {
        injected = true;
        throw options.openFailure.error;
      }
      if (pathString === publication && options.openErrorCode !== undefined && !injected) {
        injected = true;
        const failure = new Error(`injected ${options.openErrorCode}`) as NodeJS.ErrnoException;
        failure.code = options.openErrorCode;
        throw failure;
      }
      const fd = originalOpen(path, ...args);
      if (pathString !== undefined && targetPaths.has(pathString)) {
        const lifetime = { id: nextId++, path: pathString, fd, closed: false };
        lifetimes.push(lifetime);
        live.set(fd, lifetime);
      }
      return fd;
    }) as never;
    nodeFs.closeSync = ((fd: number) => {
      const lifetime = live.get(fd);
      const result = originalClose(fd);
      if (lifetime !== undefined) {
        lifetime.closed = true;
        live.delete(fd);
      }
      if (
        options.closeFailure !== undefined
        && lifetime?.path === options.closeFailure.path
        && !closeFailureInjected
      ) {
        closeFailureInjected = true;
        throw options.closeFailure.error;
      }
      return result;
    }) as never;
    if (options.validationFailure) {
      nodeFs.realpathSync = ((path: unknown, ...args: unknown[]) => {
        if (path === publication && !injected) {
          injected = true;
          throw new Error("injected publication validation failure");
        }
        return originalRealpath(path, ...args);
      }) as never;
    }
    if (options.realpathFailure !== undefined) {
      nodeFs.realpathSync = ((path: unknown, ...args: unknown[]) => {
        if (path === options.realpathFailure?.path && !injected) {
          injected = true;
          throw options.realpathFailure.error;
        }
        return originalRealpath(path, ...args);
      }) as never;
    }
    syncBuiltinESMExports();
    const unrelatedFd = nodeFs.openSync(join(home, "unrelated-seam-check"), "w") as number;
    nodeFs.closeSync(unrelatedFd);
    try {
      await action();
    } catch (caught) {
      error = caught;
    }
  } finally {
    // Snapshot before restoring the seam; helper cleanup must never count as
    // production cleanup in the lifetime observations.
    const outstanding = [...live.values()];
    nodeFs.openSync = originalOpen;
    nodeFs.closeSync = originalClose;
    nodeFs.realpathSync = originalRealpath;
    syncBuiltinESMExports();
    for (const lifetime of outstanding) originalClose(lifetime.fd);
  }
  return { injected, closeFailureInjected, unrelatedDelegated, error, lifetimes };
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

  it("classifies root ENOENT after descriptor acquisition as unsafe storage", async () => {
    const home = makeHome();
    const root = join(home, ".lcm");
    const rootValidationError = new Error("injected root validation ENOENT") as NodeJS.ErrnoException;
    rootValidationError.code = "ENOENT";
    const observed = await observeConsumerDescriptorLifetimes(home, () => {
      const handle = openBackendPublicationReadRoot(home);
      handle?.close();
    }, {
      realpathFailure: { path: root, error: rootValidationError },
    });

    expect(observed.injected).toBe(true);
    expect(observed.error).toMatchObject({
      name: "BackendPublicationJournalError",
      reason: "unsafe-storage",
    });
    expect(observed.error).not.toMatchObject({ reason: "publication-evidence-missing" });
    expect(observed.lifetimes.filter(({ path }) => path === root)).toEqual([
      expect.objectContaining({ closed: true }),
    ]);
    expect(observed.lifetimes.filter(({ path }) => path === backendPublicationDirectory(home))).toEqual([]);
  });

  it("fails closed when root authentication and descriptor cleanup both fail", async () => {
    const home = makeHome();
    const root = join(home, ".lcm");
    const authenticationFailure = new Error("injected root authentication failure") as NodeJS.ErrnoException;
    authenticationFailure.code = "ENOENT";
    const cleanupFailure = new Error("injected root descriptor cleanup failure");
    const observed = await observeConsumerDescriptorLifetimes(home, () => {
      const handle = openBackendPublicationReadRoot(home);
      handle?.close();
    }, {
      realpathFailure: { path: root, error: authenticationFailure },
      closeFailure: { path: root, error: cleanupFailure },
    });

    expect(observed.injected).toBe(true);
    expect(observed.closeFailureInjected).toBe(true);
    expect(observed.error).toMatchObject({
      name: "BackendPublicationJournalError",
      reason: "unsafe-storage",
    });
    expect(observed.lifetimes.filter(({ path }) => path === root)).toEqual([
      expect.objectContaining({ closed: true }),
    ]);
  });

  it.each([
    ["synchronous", (home: string, onRun: () => void) => withBackendPublicationConsumerLock(home, () => {
      onRun();
      return "never";
    })],
    ["asynchronous", (home: string, onRun: () => void) => withBackendPublicationConsumerLockAsync(home, () => {
      onRun();
      return "never";
    })],
  ] satisfies readonly [string, ConsumerAction][]) (
    "fails closed when root authentication raises ENOENT (%s)",
    async (_label, action) => {
      const home = makeHome();
      const root = join(home, ".lcm");
      const rootValidationError = new Error("injected root validation ENOENT") as NodeJS.ErrnoException;
      rootValidationError.code = "ENOENT";
      let callbackRan = false;
      const observed = await observeConsumerDescriptorLifetimes(home, () => action(home, () => {
        callbackRan = true;
      }), {
        realpathFailure: { path: root, error: rootValidationError },
      });

      expect(observed.injected).toBe(true);
      expect(observed.error).toMatchObject({
        name: "BackendPublicationJournalError",
        reason: "unsafe-storage",
      });
      expect(callbackRan).toBe(false);
      expect(observed.lifetimes.filter(({ path }) => path === root)).toEqual([
        expect.objectContaining({ closed: true }),
      ]);
      expect(observed.lifetimes.filter(({ path }) => path === backendPublicationDirectory(home))).toEqual([]);
    },
  );

  it("fails closed through lock-free read admission after root authentication ENOENT", async () => {
    const home = makeHome();
    const root = join(home, ".lcm");
    const rootValidationError = new Error("injected root validation ENOENT") as NodeJS.ErrnoException;
    rootValidationError.code = "ENOENT";
    let callbackEntered = false;
    let workAfterAssertionRan = false;
    const observed = await observeConsumerDescriptorLifetimes(home, () => withBackendPublicationReadRoot(
      home,
      assertReadRoot => {
        callbackEntered = true;
        assertReadRoot();
        workAfterAssertionRan = true;
      },
    ), {
      realpathFailure: { path: root, error: rootValidationError },
    });

    expect(observed.injected).toBe(true);
    expect(callbackEntered).toBe(true);
    expect(workAfterAssertionRan).toBe(false);
    expect(observed.error).toMatchObject({
      name: "BackendPublicationJournalError",
      reason: "unsafe-storage",
    });
    expect((observed.error as Error).message).not.toContain("changed during validation");
    expect(observed.lifetimes.filter(({ path }) => path === root)).toEqual([
      expect.objectContaining({ closed: true }),
    ]);
  });

  it("preserves optional root compatibility and refreshes after initial absence", async () => {
    const absentHome = mkdtempSync(join(tmpdir(), "lcm-backend-consumer-absent-"));
    homes.push(absentHome);
    expect(openBackendPublicationReadRoot(absentHome)).toBeUndefined();

    const legacyHome = makeHome();
    chmodSync(join(legacyHome, ".lcm"), 0o755);
    expect(openBackendPublicationReadRoot(legacyHome)).toBeUndefined();

    const legacyEvidenceHome = makeHome(true);
    chmodSync(join(legacyEvidenceHome, ".lcm"), 0o755);
    expectReason(() => openBackendPublicationReadRoot(legacyEvidenceHome), "unsafe-storage");

    const healthyHome = makeHome();
    const healthyRoot = openBackendPublicationReadRoot(healthyHome);
    expect(healthyRoot).toBeDefined();
    healthyRoot?.close();

    const refreshHome = makeHome();
    const refreshRoot = join(refreshHome, ".lcm");
    const initialAbsence = new Error("injected initial root absence") as NodeJS.ErrnoException;
    initialAbsence.code = "ENOENT";
    let assertions = 0;
    const observed = await observeConsumerDescriptorLifetimes(refreshHome, () => withBackendPublicationReadRoot(
      refreshHome,
      assertReadRoot => {
        assertReadRoot();
        assertions += 1;
        assertReadRoot();
      },
    ), {
      openFailure: { path: refreshRoot, error: initialAbsence },
    });
    expect(observed.injected).toBe(true);
    expect(observed.error).toBeUndefined();
    expect(assertions).toBe(1);
    expect(observed.lifetimes.filter(({ path }) => path === refreshRoot)).toHaveLength(1);
    expect(observed.lifetimes.filter(({ path }) => path === refreshRoot).every(({ closed }) => closed)).toBe(true);
  });

  it.each([
    ["synchronous", (home: string, onRun: () => void) => withStorageBackendConsumerLock(home, () => {
      onRun();
      return "never";
    })],
    ["asynchronous", (home: string, onRun: () => void) => withStorageBackendConsumerLockAsync(home, () => {
      onRun();
      return "never";
    })],
  ] satisfies readonly [string, ConsumerAction][])("releases the root descriptor when publication opening fails (%s)", async (_label, action) => {
    const home = makeHome(true);
    let callbackRan = false;
    const observed = await observeConsumerDescriptorLifetimes(home, () => action(home, () => {
      callbackRan = true;
    }), {
      openErrorCode: "EACCES",
    });

    expect(observed.injected).toBe(true);
    expect(observed.unrelatedDelegated).toBe(true);
    expect(observed.error).toMatchObject({ name: "BackendPublicationJournalError", reason: "unsafe-storage" });
    expect(callbackRan).toBe(false);
    const rootLifetimes = observed.lifetimes.filter(({ path }) => path === join(home, ".lcm"));
    const publicationLifetimes = observed.lifetimes.filter(({ path }) => path === backendPublicationDirectory(home));
    expect(rootLifetimes).toHaveLength(1);
    expect(rootLifetimes.every(({ closed }) => closed)).toBe(true);
    expect(publicationLifetimes).toHaveLength(0);
  });

  it.each([
    ["synchronous", (home: string, onRun: () => void) => withStorageBackendConsumerLock(home, () => {
      onRun();
      return "never";
    })],
    ["asynchronous", (home: string, onRun: () => void) => withStorageBackendConsumerLockAsync(home, () => {
      onRun();
      return "never";
    })],
  ] satisfies readonly [string, ConsumerAction][])("releases descriptors after publication validation fails (%s)", async (_label, action) => {
    const home = makeHome(true);
    let callbackRan = false;
    const observed = await observeConsumerDescriptorLifetimes(home, () => action(home, () => {
      callbackRan = true;
    }), {
      validationFailure: true,
    });

    expect(observed.injected).toBe(true);
    expect(observed.error).toMatchObject({ name: "BackendPublicationJournalError", reason: "unsafe-storage" });
    expect(callbackRan).toBe(false);
    expect(observed.lifetimes.filter(({ path }) => path === join(home, ".lcm"))).toEqual([
      expect.objectContaining({ closed: true }),
    ]);
    expect(observed.lifetimes.filter(({ path }) => path === backendPublicationDirectory(home))).toEqual([
      expect.objectContaining({ closed: true }),
    ]);
  });

  it.each([
    ["synchronous", (home: string, onRun: () => void) => withBackendPublicationConsumerLock(home, () => {
      onRun();
      return "admitted";
    }, { allowUnresolved: true })],
    ["asynchronous", (home: string, onRun: () => void) => withBackendPublicationConsumerLockAsync(home, () => {
      onRun();
      return "admitted";
    }, { allowUnresolved: true })],
  ] satisfies readonly [string, ConsumerAction][])("closes one handle for each initial probe (%s)", async (_label, action) => {
    const home = makeHome(true);
    let callbackRan = false;
    const observed = await observeConsumerDescriptorLifetimes(home, () => action(home, () => {
      callbackRan = true;
    }));

    expect(observed.error).toBeUndefined();
    expect(callbackRan).toBe(true);
    expect(observed.lifetimes.filter(({ path }) => path === join(home, ".lcm"))).toEqual([
      expect.objectContaining({ closed: true }),
    ]);
    expect(observed.lifetimes.filter(({ path }) => path === backendPublicationDirectory(home))).toEqual([
      expect.objectContaining({ closed: true }),
    ]);
  });

  it.each([
    ["synchronous", (home: string, onRun: () => void) => withBackendPublicationConsumerLock(home, () => {
      onRun();
      return "legacy";
    }, { allowUnresolved: true })],
    ["asynchronous", (home: string, onRun: () => void) => withBackendPublicationConsumerLockAsync(home, () => {
      onRun();
      return "legacy";
    }, { allowUnresolved: true })],
  ] satisfies readonly [string, ConsumerAction][])("does not probe descriptors for a missing root (%s)", async (_label, action) => {
    const home = makeHome();
    rmSync(join(home, ".lcm"), { recursive: true, force: true });
    let callbackRan = false;
    const observed = await observeConsumerDescriptorLifetimes(home, () => action(home, () => {
      callbackRan = true;
    }));

    expect(observed.error).toBeUndefined();
    expect(callbackRan).toBe(true);
    expect(observed.lifetimes).toEqual([]);
  });

  it.each([
    ["synchronous", (home: string, onRun: () => void) => withStorageBackendConsumerLock(home, () => {
      onRun();
      return "never";
    })],
    ["asynchronous", (home: string, onRun: () => void) => withStorageBackendConsumerLockAsync(home, () => {
      onRun();
      return "never";
    })],
  ] satisfies readonly [string, ConsumerAction][])("releases descriptors for unsafe publication modes (%s)", async (_label, action) => {
    const home = makeHome(true);
    chmodSync(join(home, ".lcm", "backend-publication"), 0o755);
    let callbackRan = false;
    const observed = await observeConsumerDescriptorLifetimes(home, () => action(home, () => {
      callbackRan = true;
    }));

    expect(observed.error).toMatchObject({ name: "BackendPublicationJournalError", reason: "unsafe-storage" });
    expect(callbackRan).toBe(false);
    expect(observed.lifetimes.filter(({ path }) => path === join(home, ".lcm"))).toEqual([
      expect.objectContaining({ closed: true }),
    ]);
    expect(observed.lifetimes.filter(({ path }) => path === backendPublicationDirectory(home))).toEqual([
      expect.objectContaining({ closed: true }),
    ]);
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
