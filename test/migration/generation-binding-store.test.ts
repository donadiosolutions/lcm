import { afterEach, describe, expect, it } from "vitest";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MigrationBindingConflictError,
  MigrationBindingUnresolvableError,
  MigrationBindingUnsafeStorageError,
  MigrationBindingValidationError,
  migrationGenerationBindingDirectory,
  migrationGenerationBindingStoreDirectory,
  migrationSelectionBindingPath,
  migrationWitnessBindingPath,
  recordMigrationSelectionBinding,
  recordMigrationWitnessBinding,
  type MigrationSelectionBinding,
  type MigrationWitnessBinding,
} from "../../src/migration/generation-binding-store.js";
import {
  BoundedFileIdentityChangedError,
  type BoundedFileOptions,
  type BoundedFileResult,
  readBoundedRegularFileWithStat,
} from "../../src/security-files.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Best-effort mode restoration: a permission-denial fixture may leave a
    // 0o000 file or directory behind, which would otherwise block recursive
    // removal's own directory traversal.
    try { chmodSync(root, 0o700); } catch { /* best-effort */ }
    try { chmodSync(join(root, ".lcm"), 0o700); } catch { /* best-effort */ }
    try {
      chmodSync(join(root, ".lcm", "migration-generation-bindings"), 0o700);
    } catch { /* best-effort */ }
    rmSync(root, { recursive: true, force: true });
  }
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-generation-binding-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

/** A home directory whose private .lcm root deliberately does not exist yet,
 * to exercise the fail-closed directory-bootstrap path. */
function homeWithoutLcmRoot(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-generation-binding-noroot-"));
  roots.push(value);
  return value;
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const GENERATION_ID = "generation-1";

function selectionBinding(
  overrides: Partial<MigrationSelectionBinding> = {},
): MigrationSelectionBinding {
  return {
    kind: "activation",
    epochId: "epoch-1",
    attemptId: "attempt-1",
    manifestRevision: 1,
    witnessChecksumSha256: HASH_A,
    publicationId: "pub-1",
    ...overrides,
  };
}

function witnessBinding(
  overrides: Partial<MigrationWitnessBinding> = {},
): MigrationWitnessBinding {
  return {
    kind: "activation",
    epochId: "epoch-1",
    attemptId: "attempt-1",
    manifestRevision: 1,
    witnessChecksumSha256: HASH_A,
    ...overrides,
  };
}

/** Build the exact crash state atomicWritePrivateFileDurable's requireAbsent
 * path can leave behind (security-files.ts:1909-1924): linkSync(scratch,
 * final) succeeded but the matching unlinkSync(scratch) did not run, so the
 * final name and its scratch twin are two links to one inode, both
 * nlink=2. Returns both paths. */
function buildCrashTwin(
  homeDir: string,
  generationId: string,
  fileName: string,
  content: string,
): Readonly<{ finalPath: string; scratchPath: string }> {
  const directory = migrationGenerationBindingDirectory(homeDir, generationId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const finalPath = join(directory, fileName);
  const scratchPath = join(directory, `.${fileName}.${randomBytes(12).toString("hex")}.tmp`);
  writeFileSync(scratchPath, content, { mode: 0o600 });
  linkSync(scratchPath, finalPath);
  return { finalPath, scratchPath };
}

/** Capture real, byte-identical wire bytes for a binding via a clean write
 * on an independent, throwaway home -- never hand-built -- so every
 * crash-twin fixture below reconstructs the exact state a genuine crash
 * would leave, not an approximation. */
function captureCleanSelectionBytes(binding: MigrationSelectionBinding): string {
  const cleanHome = home();
  recordMigrationSelectionBinding({ homeDir: cleanHome, generationId: GENERATION_ID, binding });
  return readFileSync(migrationSelectionBindingPath(cleanHome, GENERATION_ID, binding.kind), "utf8");
}

function captureCleanWitnessBytes(binding: MigrationWitnessBinding): string {
  const cleanHome = home();
  recordMigrationWitnessBinding({ homeDir: cleanHome, generationId: GENERATION_ID, binding });
  return readFileSync(
    migrationWitnessBindingPath(cleanHome, GENERATION_ID, binding.witnessChecksumSha256),
    "utf8",
  );
}

/** Monkey-patch a single node:fs export for the duration of callback, then
 * restore it. A local duplicate of the identical helper already established
 * across this codebase's own test suite (e.g.
 * test/migration/manifest-store.test.ts, test/security-files.test.ts):
 * createRequire's CJS view of a Node builtin is the same shared module
 * object ESM named imports read from, so this reaches calls made through
 * this module's own `import { fsyncSync } from "node:fs"` too. */
function withPatchedFs<T>(name: string, replacement: unknown, callback: () => T): T {
  const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
  const original = nodeFs[name];
  nodeFs[name] = replacement;
  syncBuiltinESMExports();
  try {
    return callback();
  } finally {
    nodeFs[name] = original;
    syncBuiltinESMExports();
  }
}

describe("path helpers", () => {
  it("computes the generation-binding store directory beneath the private LCM root", () => {
    const homeDir = home();
    expect(migrationGenerationBindingStoreDirectory(homeDir)).toBe(
      join(homeDir, ".lcm", "migration-generation-bindings"),
    );
  });

  it("computes the per-generation directory as sha256hex(generationId) beneath the store", () => {
    const homeDir = home();
    const directory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    expect(directory).toBe(
      join(migrationGenerationBindingStoreDirectory(homeDir), "6b598d3d55679cadfaa60ffa00eaae588211fd2dee326eaf855bbd1f8653c398"),
    );
  });

  it("computes the selection binding path from kind", () => {
    const homeDir = home();
    expect(migrationSelectionBindingPath(homeDir, GENERATION_ID, "rollback")).toBe(
      join(migrationGenerationBindingDirectory(homeDir, GENERATION_ID), "selection-rollback.binding"),
    );
  });

  it("computes the witness binding path from the checksum, never the kind", () => {
    const homeDir = home();
    expect(migrationWitnessBindingPath(homeDir, GENERATION_ID, HASH_B)).toBe(
      join(migrationGenerationBindingDirectory(homeDir, GENERATION_ID), `witness-${HASH_B}.binding`),
    );
  });
});

describe("recordMigrationSelectionBinding: synchronous return", () => {
  it("returns undefined synchronously (never a Promise) and is not an async function", () => {
    const homeDir = home();
    expect(recordMigrationSelectionBinding.constructor.name).toBe("Function");
    const result = recordMigrationSelectionBinding({
      homeDir,
      generationId: GENERATION_ID,
      binding: selectionBinding(),
    });
    expect(result).toBeUndefined();
    expect(result instanceof Promise).toBe(false);
  });
});

describe("recordMigrationWitnessBinding: synchronous return", () => {
  it("returns undefined synchronously (never a Promise) and is not an async function", () => {
    const homeDir = home();
    expect(recordMigrationWitnessBinding.constructor.name).toBe("Function");
    const result = recordMigrationWitnessBinding({
      homeDir,
      generationId: GENERATION_ID,
      binding: witnessBinding(),
    });
    expect(result).toBeUndefined();
    expect(result instanceof Promise).toBe(false);
  });
});

describe("recordMigrationSelectionBinding: durable write and idempotency", () => {
  it("durably writes a fresh selection binding", () => {
    const homeDir = home();
    const binding = selectionBinding();
    recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding });
    const path = migrationSelectionBindingPath(homeDir, GENERATION_ID, "activation");
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(stored.generationId).toBe(GENERATION_ID);
    expect(stored.binding).toEqual(binding);
  });

  it("reuses an existing entry when the candidate is byte-identical (idempotent retry)", () => {
    const homeDir = home();
    const binding = selectionBinding();
    recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding });
    // Re-derive an independent, structurally-identical object -- the
    // realistic shape of a caller retrying after a crash.
    expect(() =>
      recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding: selectionBinding() }),
    ).not.toThrow();
  });

  it("refuses a different selection binding under the same generation and kind", () => {
    const homeDir = home();
    recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding: selectionBinding() });
    expect(() =>
      recordMigrationSelectionBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: selectionBinding({ publicationId: "pub-2" }),
      }),
    ).toThrow(MigrationBindingConflictError);
  });

  it("stores activation and rollback selections for the same generation as two independent files", () => {
    const homeDir = home();
    recordMigrationSelectionBinding({
      homeDir,
      generationId: GENERATION_ID,
      binding: selectionBinding({ kind: "activation" }),
    });
    recordMigrationSelectionBinding({
      homeDir,
      generationId: GENERATION_ID,
      binding: selectionBinding({ kind: "rollback", witnessChecksumSha256: HASH_B }),
    });
    const activationPath = migrationSelectionBindingPath(homeDir, GENERATION_ID, "activation");
    const rollbackPath = migrationSelectionBindingPath(homeDir, GENERATION_ID, "rollback");
    expect(readFileSync(activationPath, "utf8")).not.toBe(readFileSync(rollbackPath, "utf8"));
  });

  it("is unresolvable (throws), not absent, when an existing binding's permission is genuinely denied", () => {
    const homeDir = home();
    const binding = selectionBinding();
    recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding });
    const path = migrationSelectionBindingPath(homeDir, GENERATION_ID, "activation");
    chmodSync(path, 0o000);
    try {
      expect(() =>
        recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding }),
      ).toThrow(MigrationBindingUnresolvableError);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("fails closed when the private LCM root does not exist yet", () => {
    const homeDir = homeWithoutLcmRoot();
    expect(() =>
      recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding: selectionBinding() }),
    ).toThrow(MigrationBindingUnsafeStorageError);
  });

  it("fails closed when a regular file occupies the store directory path", () => {
    const homeDir = home();
    const store = migrationGenerationBindingStoreDirectory(homeDir);
    writeFileSync(store, "not a directory", { mode: 0o600 });
    expect(() =>
      recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding: selectionBinding() }),
    ).toThrow(MigrationBindingUnsafeStorageError);
  });

  it("fails closed when the store directory path is a symlink (an authentication failure distinct from" +
    " the per-generation directory's own mkdir-blocked failure above: a symlinked store still lets a" +
    " fresh per-generation mkdir succeed through it, so this path independently exercises openPrivateDirectory's" +
    " O_NOFOLLOW authentication rather than mkdir's own EEXIST/ENOTDIR failure)", () => {
    const homeDir = home();
    const realTarget = mkdtempSync(join(tmpdir(), "lcm-generation-binding-symlink-target-"));
    const store = migrationGenerationBindingStoreDirectory(homeDir);
    symlinkSync(realTarget, store);
    try {
      expect(() =>
        recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding: selectionBinding() }),
      ).toThrow(MigrationBindingUnsafeStorageError);
    } finally {
      rmSync(realTarget, { recursive: true, force: true });
    }
  });

  it("fails closed when a regular file occupies the per-generation directory path", () => {
    const homeDir = home();
    const store = migrationGenerationBindingStoreDirectory(homeDir);
    mkdirSync(store, { recursive: true, mode: 0o700 });
    const generationDirectory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    writeFileSync(generationDirectory, "not a directory", { mode: 0o600 });
    expect(() =>
      recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding: selectionBinding() }),
    ).toThrow(MigrationBindingUnsafeStorageError);
  });

  it("still writes and later re-reads successfully when process.getuid is unavailable", () => {
    const homeDir = home();
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      expect(() =>
        recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding: selectionBinding() }),
      ).not.toThrow();
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
    const path = migrationSelectionBindingPath(homeDir, GENERATION_ID, "activation");
    expect(readFileSync(path, "utf8").length).toBeGreaterThan(0);
  });

  describe("with an injected durable-write collision (a true concurrent race cannot be reproduced deterministically" +
    " inside a single synchronous test process; both branches below are disclosed dependency injection rather" +
    " than a genuine two-process race, following this campaign's established convention for reach that cannot be" +
    " reached through a real fixture)", () => {
    it("reconciles as reused when a concurrent writer's identical publish lands between the presence check and the write", () => {
      const homeDir = home();
      const binding = selectionBinding();
      let calls = 0;
      expect(() =>
        recordMigrationSelectionBinding(
          { homeDir, generationId: GENERATION_ID, binding },
          {
            writeDurable: (targetPath, content) => {
              calls += 1;
              writeFileSync(targetPath, content, { mode: 0o600 });
              throw new Error("private file was created concurrently");
            },
          },
        ),
      ).not.toThrow();
      expect(calls).toBe(1);
    });

    it("also reconciles as reused for the pre-check collision message", () => {
      const homeDir = home();
      const binding = selectionBinding();
      expect(() =>
        recordMigrationSelectionBinding(
          { homeDir, generationId: GENERATION_ID, binding },
          {
            writeDurable: (targetPath, content) => {
              writeFileSync(targetPath, content, { mode: 0o600 });
              throw new Error("private file already exists");
            },
          },
        ),
      ).not.toThrow();
    });

    it("re-throws the original collision when the collision inexplicably vanishes on retry", () => {
      const homeDir = home();
      expect(() =>
        recordMigrationSelectionBinding(
          { homeDir, generationId: GENERATION_ID, binding: selectionBinding() },
          { writeDurable: () => { throw new Error("private file already exists"); } },
        ),
      ).toThrow("private file already exists");
    });
  });

  it("propagates an unrecognized durable-write failure unchanged", () => {
    const homeDir = home();
    const boom = new Error("disk is full");
    expect(() =>
      recordMigrationSelectionBinding(
        { homeDir, generationId: GENERATION_ID, binding: selectionBinding() },
        { writeDurable: () => { throw boom; } },
      ),
    ).toThrow(boom);
  });

  it("propagates a non-Error durable-write throw unchanged", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationSelectionBinding(
        { homeDir, generationId: GENERATION_ID, binding: selectionBinding() },
        { writeDurable: () => { throw "not an Error instance"; } },
      ),
    ).toThrow();
  });

  it("propagates an unrecognized presence-check failure unchanged rather than attributing it", () => {
    const homeDir = home();
    const boom = new Error("unexpected failure with no fs error code");
    expect(() =>
      recordMigrationSelectionBinding(
        { homeDir, generationId: GENERATION_ID, binding: selectionBinding() },
        { readWithStat: () => { throw boom; } },
      ),
    ).toThrow(boom);
  });
});

describe("recordMigrationSelectionBinding: post-link crash-twin recovery (P1-1)", () => {
  it("accepts an identical retry after the exact post-link crash state, completes the interrupted unlink, and" +
    " leaves the durable content correct", () => {
    const homeDir = home();
    const binding = selectionBinding();
    const cleanBytes = captureCleanSelectionBytes(binding);
    const { finalPath, scratchPath } = buildCrashTwin(homeDir, GENERATION_ID, "selection-activation.binding", cleanBytes);
    expect(statSync(finalPath).nlink).toBe(2);

    expect(() =>
      recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding }),
    ).not.toThrow();

    expect(statSync(finalPath).nlink).toBe(1);
    expect(existsSync(scratchPath)).toBe(false);
    expect(readFileSync(finalPath, "utf8")).toBe(cleanBytes);
  });

  it("refuses a conflicting rewrite when the authenticated twin's content differs from the candidate", () => {
    const homeDir = home();
    const binding = selectionBinding();
    const cleanBytes = captureCleanSelectionBytes(binding);
    buildCrashTwin(homeDir, GENERATION_ID, "selection-activation.binding", cleanBytes);

    expect(() =>
      recordMigrationSelectionBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: selectionBinding({ publicationId: "pub-2" }),
      }),
    ).toThrow(MigrationBindingConflictError);
  });

  it("is unresolvable, never raw and never a conflict, when nlink=2 has no matching writer-scratch twin", () => {
    const homeDir = home();
    const directory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const finalPath = join(directory, "selection-activation.binding");
    const unrelatedPath = join(directory, "unrelated-hardlink-name");
    writeFileSync(unrelatedPath, "not a writer scratch file\n", { mode: 0o600 });
    linkSync(unrelatedPath, finalPath);

    expect(() =>
      recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding: selectionBinding() }),
    ).toThrow(MigrationBindingUnresolvableError);
  });

  it("is unresolvable when dependency-injected reads report more than one authenticated twin (a real filesystem" +
    " can never produce two links to the final inode while its own nlink is exactly 2, so this defensive branch is" +
    " reached only through disclosed dependency injection, following this file's established convention)", () => {
    const homeDir = home();
    const directory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const finalPath = join(directory, "selection-activation.binding");
    const scratchAName = "." + "selection-activation.binding" + "." + randomBytes(12).toString("hex") + ".tmp";
    const scratchBName = "." + "selection-activation.binding" + "." + randomBytes(12).toString("hex") + ".tmp";
    const scratchAPath = join(directory, scratchAName);
    const scratchBPath = join(directory, scratchBName);
    writeFileSync(finalPath, "on-disk content is irrelevant; the injected reader below is authoritative\n", { mode: 0o600 });
    writeFileSync(scratchAPath, "irrelevant\n", { mode: 0o600 });
    writeFileSync(scratchBPath, "irrelevant\n", { mode: 0o600 });

    const fakeIdentity: BoundedFileResult = {
      content: "shared-fake-content",
      mtimeMs: 1000,
      dev: 1,
      ino: 1,
      mode: 0o600,
      uid: 0,
      gid: 0,
      nlink: "2",
      parentDev: "1",
      parentIno: "1",
      exactDev: "1",
      exactIno: "1",
    };

    expect(() =>
      recordMigrationSelectionBinding(
        { homeDir, generationId: GENERATION_ID, binding: selectionBinding() },
        {
          readWithStat: (path: string, options: BoundedFileOptions): BoundedFileResult => {
            if (path === finalPath && options.requireSingleLink === true) {
              throw new Error("file has multiple hard links");
            }
            if (path === finalPath || path === scratchAPath || path === scratchBPath) {
              return { ...fakeIdentity };
            }
            throw new Error("unexpected path in fake reader: " + path);
          },
        },
      ),
    ).toThrow(MigrationBindingUnresolvableError);
  });
});

describe("recordMigrationSelectionBinding: code-less integrity failures are unresolvable (Reviewer B)", () => {
  it("is unresolvable when an existing stored file exceeds the bounded read size limit", () => {
    const homeDir = home();
    const directory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "selection-activation.binding"), "x".repeat(4097), { mode: 0o600 });
    expect(() =>
      recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding: selectionBinding() }),
    ).toThrow(MigrationBindingUnresolvableError);
  });

  it("is unresolvable when an existing stored file's mode is untrusted", () => {
    const homeDir = home();
    const directory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "selection-activation.binding"), "irrelevant\n", { mode: 0o644 });
    expect(() =>
      recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding: selectionBinding() }),
    ).toThrow(MigrationBindingUnresolvableError);
  });

  it("is unresolvable, not raw, when the bounded reader reports a torn-read identity change", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationSelectionBinding(
        { homeDir, generationId: GENERATION_ID, binding: selectionBinding() },
        {
          readWithStat: () => {
            throw new BoundedFileIdentityChangedError({ mode: 0o700, uid: 0, gid: 0, dev: "1", ino: "1" });
          },
        },
      ),
    ).toThrow(MigrationBindingUnresolvableError);
  });
});

describe("recordMigrationSelectionBinding: validation", () => {
  it("rejects a top-level input that is not a record", () => {
    expect(() =>
      recordMigrationSelectionBinding(null as unknown as Parameters<typeof recordMigrationSelectionBinding>[0]),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a top-level input with an extra key", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationSelectionBinding(
        { homeDir, generationId: GENERATION_ID, binding: selectionBinding(), extra: true } as unknown as Parameters<
          typeof recordMigrationSelectionBinding
        >[0],
      ),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a non-string, empty homeDir", () => {
    expect(() =>
      recordMigrationSelectionBinding({ homeDir: "", generationId: GENERATION_ID, binding: selectionBinding() }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a generationId that does not match the conservative token pattern", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationSelectionBinding({ homeDir, generationId: "not a valid id", binding: selectionBinding() }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a binding that is not a record", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationSelectionBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: null as unknown as MigrationSelectionBinding,
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a binding with an extra key", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationSelectionBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: { ...selectionBinding(), extra: true } as unknown as MigrationSelectionBinding,
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a binding with a missing key", () => {
    const homeDir = home();
    const { publicationId: _publicationId, ...withoutPublicationId } = selectionBinding();
    expect(() =>
      recordMigrationSelectionBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: withoutPublicationId as unknown as MigrationSelectionBinding,
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects an invalid kind", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationSelectionBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: selectionBinding({ kind: "unwind" as unknown as MigrationSelectionBinding["kind"] }),
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects an epochId that does not match the token pattern", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationSelectionBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: selectionBinding({ epochId: "" }),
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects an attemptId that does not match the token pattern", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationSelectionBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: selectionBinding({ attemptId: "bad id with spaces" }),
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a publicationId that does not match the token pattern", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationSelectionBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: selectionBinding({ publicationId: "not a valid id" }),
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a non-integer manifestRevision", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationSelectionBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: selectionBinding({ manifestRevision: 1.5 }),
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a negative manifestRevision", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationSelectionBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: selectionBinding({ manifestRevision: -1 }),
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a non-number manifestRevision", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationSelectionBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: selectionBinding({ manifestRevision: "1" as unknown as number }),
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a malformed witnessChecksumSha256", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationSelectionBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: selectionBinding({ witnessChecksumSha256: "not-a-hash" }),
      }),
    ).toThrow(MigrationBindingValidationError);
  });
});

describe("recordMigrationWitnessBinding: durable write, per-witness keying and first-write-wins reconciliation", () => {
  it("durably writes a fresh witness binding", () => {
    const homeDir = home();
    const binding = witnessBinding();
    recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding });
    const path = migrationWitnessBindingPath(homeDir, GENERATION_ID, binding.witnessChecksumSha256);
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(stored.generationId).toBe(GENERATION_ID);
    expect(stored.binding).toEqual(binding);
  });

  it("reuses an identical rewrite under the same witnessChecksumSha256 without rewriting the file", () => {
    const homeDir = home();
    const binding = witnessBinding();
    recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding });
    const path = migrationWitnessBindingPath(homeDir, GENERATION_ID, binding.witnessChecksumSha256);
    const before = readFileSync(path, "utf8");
    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding: witnessBinding() }),
    ).not.toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("accepts a rewrite whose manifestRevision differs (first-write-wins) and never rewrites the stored file", () => {
    const homeDir = home();
    const binding = witnessBinding({ manifestRevision: 1 });
    recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding });
    const path = migrationWitnessBindingPath(homeDir, GENERATION_ID, binding.witnessChecksumSha256);
    const before = readFileSync(path, "utf8");
    expect(() =>
      recordMigrationWitnessBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: witnessBinding({ manifestRevision: 7 }),
      }),
    ).not.toThrow();
    const after = readFileSync(path, "utf8");
    expect(after).toBe(before);
    const stored = JSON.parse(after) as { binding: MigrationWitnessBinding };
    expect(stored.binding.manifestRevision).toBe(1);
  });

  it("stores two witnesses for the same generation and kind, sharing a takeover-and-retry lineage, as two" +
    " independent files -- proving the store is keyed per witness rather than per kind", () => {
    const homeDir = home();
    const firstAttempt = witnessBinding({ attemptId: "attempt-1", witnessChecksumSha256: HASH_A });
    const secondAttempt = witnessBinding({ attemptId: "attempt-2", witnessChecksumSha256: HASH_B });
    recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding: firstAttempt });
    recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding: secondAttempt });
    const firstPath = migrationWitnessBindingPath(homeDir, GENERATION_ID, HASH_A);
    const secondPath = migrationWitnessBindingPath(homeDir, GENERATION_ID, HASH_B);
    const storedFirst = JSON.parse(readFileSync(firstPath, "utf8")) as { binding: MigrationWitnessBinding };
    const storedSecond = JSON.parse(readFileSync(secondPath, "utf8")) as { binding: MigrationWitnessBinding };
    expect(storedFirst.binding.attemptId).toBe("attempt-1");
    expect(storedSecond.binding.attemptId).toBe("attempt-2");
  });

  it("refuses when kind differs under the same witnessChecksumSha256 (a checksum collision or corruption)", () => {
    const homeDir = home();
    recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding: witnessBinding({ kind: "activation" }) });
    expect(() =>
      recordMigrationWitnessBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: witnessBinding({ kind: "rollback" }),
      }),
    ).toThrow(MigrationBindingConflictError);
  });

  it("refuses when epochId differs under the same witnessChecksumSha256", () => {
    const homeDir = home();
    recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding: witnessBinding({ epochId: "epoch-1" }) });
    expect(() =>
      recordMigrationWitnessBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: witnessBinding({ epochId: "epoch-2" }),
      }),
    ).toThrow(MigrationBindingConflictError);
  });

  it("refuses when attemptId differs under the same witnessChecksumSha256", () => {
    const homeDir = home();
    recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding: witnessBinding({ attemptId: "attempt-1" }) });
    expect(() =>
      recordMigrationWitnessBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: witnessBinding({ attemptId: "attempt-9" }),
      }),
    ).toThrow(MigrationBindingConflictError);
  });

  it("refuses when the stored file's generationId cross-check fails", () => {
    const homeDir = home();
    const binding = witnessBinding();
    const store = migrationGenerationBindingStoreDirectory(homeDir);
    const generationDirectory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    mkdirSync(generationDirectory, { recursive: true, mode: 0o700 });
    const path = migrationWitnessBindingPath(homeDir, GENERATION_ID, binding.witnessChecksumSha256);
    writeFileSync(
      path,
      `${JSON.stringify({ version: 1, generationId: "a-different-generation", binding })}\n`,
      { mode: 0o600 },
    );
    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding }),
    ).toThrow(MigrationBindingConflictError);
    void store;
  });

  it("refuses when the stored file is not valid JSON", () => {
    const homeDir = home();
    const binding = witnessBinding();
    const generationDirectory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    mkdirSync(generationDirectory, { recursive: true, mode: 0o700 });
    const path = migrationWitnessBindingPath(homeDir, GENERATION_ID, binding.witnessChecksumSha256);
    writeFileSync(path, "not json at all", { mode: 0o600 });
    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding }),
    ).toThrow(MigrationBindingConflictError);
  });

  it("refuses when the stored file is valid JSON but not an object", () => {
    const homeDir = home();
    const binding = witnessBinding();
    const generationDirectory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    mkdirSync(generationDirectory, { recursive: true, mode: 0o700 });
    const path = migrationWitnessBindingPath(homeDir, GENERATION_ID, binding.witnessChecksumSha256);
    writeFileSync(path, "42\n", { mode: 0o600 });
    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding }),
    ).toThrow(MigrationBindingConflictError);
  });

  it("refuses when the stored file's generationId field is not a string", () => {
    const homeDir = home();
    const binding = witnessBinding();
    const generationDirectory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    mkdirSync(generationDirectory, { recursive: true, mode: 0o700 });
    const path = migrationWitnessBindingPath(homeDir, GENERATION_ID, binding.witnessChecksumSha256);
    writeFileSync(path, `${JSON.stringify({ version: 1, generationId: 12345, binding })}\n`, { mode: 0o600 });
    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding }),
    ).toThrow(MigrationBindingConflictError);
  });

  it("refuses when the stored file's binding field is not a record", () => {
    const homeDir = home();
    const binding = witnessBinding();
    const generationDirectory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    mkdirSync(generationDirectory, { recursive: true, mode: 0o700 });
    const path = migrationWitnessBindingPath(homeDir, GENERATION_ID, binding.witnessChecksumSha256);
    writeFileSync(
      path,
      `${JSON.stringify({ version: 1, generationId: GENERATION_ID, binding: "not-a-record" })}\n`,
      { mode: 0o600 },
    );
    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding }),
    ).toThrow(MigrationBindingConflictError);
  });

  it("is unresolvable (throws), not absent, when an existing witness's permission is genuinely denied", () => {
    const homeDir = home();
    const binding = witnessBinding();
    recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding });
    const path = migrationWitnessBindingPath(homeDir, GENERATION_ID, binding.witnessChecksumSha256);
    chmodSync(path, 0o000);
    try {
      expect(() =>
        recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding }),
      ).toThrow(MigrationBindingUnresolvableError);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("fails closed when the private LCM root does not exist yet", () => {
    const homeDir = homeWithoutLcmRoot();
    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding: witnessBinding() }),
    ).toThrow(MigrationBindingUnsafeStorageError);
  });

  describe("with an injected durable-write collision", () => {
    it("reconciles as reused when a concurrent writer's identical publish lands between the presence check and the write", () => {
      const homeDir = home();
      const binding = witnessBinding();
      expect(() =>
        recordMigrationWitnessBinding(
          { homeDir, generationId: GENERATION_ID, binding },
          {
            writeDurable: (targetPath, content) => {
              writeFileSync(targetPath, content, { mode: 0o600 });
              throw new Error("private file was created concurrently");
            },
          },
        ),
      ).not.toThrow();
    });

    it("re-throws the original collision when the collision inexplicably vanishes on retry", () => {
      const homeDir = home();
      expect(() =>
        recordMigrationWitnessBinding(
          { homeDir, generationId: GENERATION_ID, binding: witnessBinding() },
          { writeDurable: () => { throw new Error("private file already exists"); } },
        ),
      ).toThrow("private file already exists");
    });
  });

  it("propagates an unrecognized durable-write failure unchanged", () => {
    const homeDir = home();
    const boom = new Error("disk is full");
    expect(() =>
      recordMigrationWitnessBinding(
        { homeDir, generationId: GENERATION_ID, binding: witnessBinding() },
        { writeDurable: () => { throw boom; } },
      ),
    ).toThrow(boom);
  });
});

describe("recordMigrationWitnessBinding: post-link crash-twin recovery (P1-1)", () => {
  it("accepts an identical retry after the exact post-link crash state and completes the interrupted unlink", () => {
    const homeDir = home();
    const binding = witnessBinding();
    const cleanBytes = captureCleanWitnessBytes(binding);
    const fileName = "witness-" + binding.witnessChecksumSha256 + ".binding";
    const { finalPath, scratchPath } = buildCrashTwin(homeDir, GENERATION_ID, fileName, cleanBytes);
    expect(statSync(finalPath).nlink).toBe(2);

    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding }),
    ).not.toThrow();

    expect(statSync(finalPath).nlink).toBe(1);
    expect(existsSync(scratchPath)).toBe(false);
    expect(readFileSync(finalPath, "utf8")).toBe(cleanBytes);
  });

  it("accepts a manifestRevision-differing retry after the crash twin (the section-18 ordinary recovery path)" +
    " and leaves the first-written revision on disk, never rewriting it", () => {
    const homeDir = home();
    const binding = witnessBinding({ manifestRevision: 1 });
    const cleanBytes = captureCleanWitnessBytes(binding);
    const fileName = "witness-" + binding.witnessChecksumSha256 + ".binding";
    const { finalPath, scratchPath } = buildCrashTwin(homeDir, GENERATION_ID, fileName, cleanBytes);

    expect(() =>
      recordMigrationWitnessBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: witnessBinding({ manifestRevision: 7 }),
      }),
    ).not.toThrow();

    expect(statSync(finalPath).nlink).toBe(1);
    expect(existsSync(scratchPath)).toBe(false);
    const stored = JSON.parse(readFileSync(finalPath, "utf8")) as { binding: MigrationWitnessBinding };
    expect(stored.binding.manifestRevision).toBe(1);
  });

  it("refuses a conflicting rewrite when the authenticated twin's digest-covered fields differ from the candidate", () => {
    const homeDir = home();
    const binding = witnessBinding({ epochId: "epoch-1" });
    const cleanBytes = captureCleanWitnessBytes(binding);
    const fileName = "witness-" + binding.witnessChecksumSha256 + ".binding";
    buildCrashTwin(homeDir, GENERATION_ID, fileName, cleanBytes);

    expect(() =>
      recordMigrationWitnessBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: witnessBinding({ epochId: "epoch-2" }),
      }),
    ).toThrow(MigrationBindingConflictError);
  });

  it("is unresolvable, never raw and never a conflict, when nlink=2 has no matching writer-scratch twin", () => {
    const homeDir = home();
    const binding = witnessBinding();
    const directory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const finalPath = join(directory, "witness-" + binding.witnessChecksumSha256 + ".binding");
    const unrelatedPath = join(directory, "unrelated-hardlink-name");
    writeFileSync(unrelatedPath, "not a writer scratch file\n", { mode: 0o600 });
    linkSync(unrelatedPath, finalPath);

    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding }),
    ).toThrow(MigrationBindingUnresolvableError);
  });
});

describe("recordMigrationWitnessBinding: strict stored-record parsing (P1-2)", () => {
  const candidate = witnessBinding({ manifestRevision: 5 });

  function writeRawStoredWitness(homeDir: string, storedObj: unknown): string {
    const directory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "witness-" + candidate.witnessChecksumSha256 + ".binding");
    writeFileSync(path, JSON.stringify(storedObj) + "\n", { mode: 0o600 });
    return path;
  }

  it("refuses (never silently reuses) a stored binding missing manifestRevision and witnessChecksumSha256", () => {
    const homeDir = home();
    writeRawStoredWitness(homeDir, {
      version: 1,
      generationId: GENERATION_ID,
      binding: { kind: candidate.kind, epochId: candidate.epochId, attemptId: candidate.attemptId },
    });
    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding: candidate }),
    ).toThrow(MigrationBindingConflictError);
  });

  it("refuses (never silently reuses) a stored binding whose embedded witnessChecksumSha256 disagrees with its" +
    " own storage key", () => {
    const homeDir = home();
    writeRawStoredWitness(homeDir, {
      version: 1,
      generationId: GENERATION_ID,
      binding: {
        kind: candidate.kind,
        epochId: candidate.epochId,
        attemptId: candidate.attemptId,
        manifestRevision: 1,
        witnessChecksumSha256: HASH_B,
      },
    });
    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding: candidate }),
    ).toThrow(MigrationBindingConflictError);
  });

  it("refuses (never silently reuses) a stored envelope at an unrecognised wire version", () => {
    const homeDir = home();
    writeRawStoredWitness(homeDir, {
      version: 99,
      generationId: GENERATION_ID,
      binding: {
        kind: candidate.kind,
        epochId: candidate.epochId,
        attemptId: candidate.attemptId,
        manifestRevision: 1,
        witnessChecksumSha256: candidate.witnessChecksumSha256,
      },
    });
    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding: candidate }),
    ).toThrow(MigrationBindingConflictError);
  });

  it("refuses (never silently reuses) a stored binding carrying an extra unknown field", () => {
    const homeDir = home();
    writeRawStoredWitness(homeDir, {
      version: 1,
      generationId: GENERATION_ID,
      binding: {
        kind: candidate.kind,
        epochId: candidate.epochId,
        attemptId: candidate.attemptId,
        manifestRevision: 1,
        witnessChecksumSha256: candidate.witnessChecksumSha256,
        extra: true,
      },
    });
    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding: candidate }),
    ).toThrow(MigrationBindingConflictError);
  });

  it("still refuses the control case: a stored binding missing attemptId (a digest-covered field)", () => {
    const homeDir = home();
    writeRawStoredWitness(homeDir, {
      version: 1,
      generationId: GENERATION_ID,
      binding: { kind: candidate.kind, epochId: candidate.epochId },
    });
    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding: candidate }),
    ).toThrow(MigrationBindingConflictError);
  });

  it("refuses a stored envelope with extra top-level keys", () => {
    const homeDir = home();
    writeRawStoredWitness(homeDir, {
      version: 1,
      generationId: GENERATION_ID,
      binding: {
        kind: candidate.kind,
        epochId: candidate.epochId,
        attemptId: candidate.attemptId,
        manifestRevision: 1,
        witnessChecksumSha256: candidate.witnessChecksumSha256,
      },
      extraTopLevel: true,
    });
    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding: candidate }),
    ).toThrow(MigrationBindingConflictError);
  });

  it("refuses a stored envelope whose generationId is not a string", () => {
    const homeDir = home();
    writeRawStoredWitness(homeDir, {
      version: 1,
      generationId: 12345,
      binding: {
        kind: candidate.kind,
        epochId: candidate.epochId,
        attemptId: candidate.attemptId,
        manifestRevision: 1,
        witnessChecksumSha256: candidate.witnessChecksumSha256,
      },
    });
    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding: candidate }),
    ).toThrow(MigrationBindingConflictError);
  });
});

describe("recordMigrationWitnessBinding: code-less integrity failures are unresolvable (Reviewer B)", () => {
  it("is unresolvable when an existing stored witness exceeds the bounded read size limit", () => {
    const homeDir = home();
    const binding = witnessBinding();
    const directory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, "witness-" + binding.witnessChecksumSha256 + ".binding"),
      "x".repeat(4097),
      { mode: 0o600 },
    );
    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding }),
    ).toThrow(MigrationBindingUnresolvableError);
  });

  it("is unresolvable when an existing stored witness's mode is untrusted", () => {
    const homeDir = home();
    const binding = witnessBinding();
    const directory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, "witness-" + binding.witnessChecksumSha256 + ".binding"),
      "irrelevant\n",
      { mode: 0o644 },
    );
    expect(() =>
      recordMigrationWitnessBinding({ homeDir, generationId: GENERATION_ID, binding }),
    ).toThrow(MigrationBindingUnresolvableError);
  });
});

describe("recordMigrationWitnessBinding: validation", () => {
  it("rejects a top-level input that is not a record", () => {
    expect(() =>
      recordMigrationWitnessBinding(undefined as unknown as Parameters<typeof recordMigrationWitnessBinding>[0]),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a binding that carries a publicationId (a selection-only field)", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationWitnessBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: { ...witnessBinding(), publicationId: "pub-1" } as unknown as MigrationWitnessBinding,
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a binding with a missing key", () => {
    const homeDir = home();
    const { attemptId: _attemptId, ...withoutAttemptId } = witnessBinding();
    expect(() =>
      recordMigrationWitnessBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: withoutAttemptId as unknown as MigrationWitnessBinding,
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects an invalid kind", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationWitnessBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: witnessBinding({ kind: "unwind" as unknown as MigrationWitnessBinding["kind"] }),
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects an epochId that does not match the token pattern", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationWitnessBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: witnessBinding({ epochId: "" }),
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects an attemptId that does not match the token pattern (shape only, never stability)", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationWitnessBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: witnessBinding({ attemptId: "bad id with spaces" }),
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a non-integer manifestRevision", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationWitnessBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: witnessBinding({ manifestRevision: 1.5 }),
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a negative manifestRevision", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationWitnessBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: witnessBinding({ manifestRevision: -1 }),
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a malformed witnessChecksumSha256", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationWitnessBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: witnessBinding({ witnessChecksumSha256: "not-a-hash" }),
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a generationId that does not match the conservative token pattern", () => {
    const homeDir = home();
    expect(() =>
      recordMigrationWitnessBinding({
        homeDir,
        generationId: "not a valid id",
        binding: witnessBinding(),
      }),
    ).toThrow(MigrationBindingValidationError);
  });

  it("rejects a non-string, empty homeDir", () => {
    expect(() =>
      recordMigrationWitnessBinding({ homeDir: "", generationId: GENERATION_ID, binding: witnessBinding() }),
    ).toThrow(MigrationBindingValidationError);
  });
});

describe("error classes", () => {
  it("each carries its own stable name and extends Error", () => {
    expect(new MigrationBindingValidationError("x").name).toBe("MigrationBindingValidationError");
    expect(new MigrationBindingConflictError("x").name).toBe("MigrationBindingConflictError");
    expect(new MigrationBindingUnresolvableError("x").name).toBe("MigrationBindingUnresolvableError");
    expect(new MigrationBindingUnsafeStorageError("x").name).toBe("MigrationBindingUnsafeStorageError");
    expect(new MigrationBindingValidationError("x")).toBeInstanceOf(Error);
    expect(new MigrationBindingConflictError("x")).toBeInstanceOf(Error);
    expect(new MigrationBindingUnresolvableError("x")).toBeInstanceOf(Error);
    expect(new MigrationBindingUnsafeStorageError("x")).toBeInstanceOf(Error);
  });

  it("are four distinct classes an instanceof check can branch on", () => {
    expect(MigrationBindingValidationError).not.toBe(MigrationBindingConflictError as unknown);
    expect(MigrationBindingConflictError).not.toBe(MigrationBindingUnresolvableError as unknown);
    expect(MigrationBindingUnresolvableError).not.toBe(MigrationBindingUnsafeStorageError as unknown);
  });
});

describe("ensureGenerationBindingDirectories: creation-path durability (P1-3)", () => {
  function withTrackedFsyncs(callback: () => void): string[] {
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpenSync = nodeFs.openSync as (path: string, flags: unknown, mode?: unknown) => number;
    const originalFsyncSync = nodeFs.fsyncSync as (fd: number) => void;
    const pathByFd = new Map<number, string>();
    const fsyncedPaths: string[] = [];
    withPatchedFs("openSync", ((path: string, flags: unknown, mode?: unknown) => {
      const fd = mode === undefined ? originalOpenSync(path, flags) : originalOpenSync(path, flags, mode);
      pathByFd.set(fd, path);
      return fd;
    }) as never, () => withPatchedFs("fsyncSync", ((fd: number) => {
      const path = pathByFd.get(fd);
      if (path !== undefined) fsyncedPaths.push(path);
      originalFsyncSync(fd);
    }) as never, callback));
    return fsyncedPaths;
  }

  it("fsyncs the fresh store directory and its parent LCM root, and the fresh per-generation directory and its" +
    " parent store, on first creation -- so a selection binding written once inside a fenced window durably" +
    " survives power loss immediately after this module returns success", () => {
    const homeDir = home();
    const root = join(homeDir, ".lcm");
    const store = migrationGenerationBindingStoreDirectory(homeDir);
    const generationDirectory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);

    const fsyncedPaths = withTrackedFsyncs(() => {
      recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding: selectionBinding() });
    });

    expect(fsyncedPaths.filter((path) => path === root).length).toBeGreaterThanOrEqual(1);
    expect(fsyncedPaths.filter((path) => path === store).length).toBeGreaterThanOrEqual(1);
    // The per-generation directory is fsynced at least twice on a fresh
    // creation: once by this module's own creation-path durability fsync,
    // and once more by atomicWritePrivateFileDurable's own pre-existing
    // parent fsync when it durably publishes the binding file itself.
    expect(fsyncedPaths.filter((path) => path === generationDirectory).length).toBeGreaterThanOrEqual(2);
  });

  it("does not re-fsync the store directory or its parent root when both already exist, and fsyncs the" +
    " per-generation directory only once -- via atomicWritePrivateFileDurable's own file-publish parent fsync," +
    " never a second time from this module's own creation-path logic -- when it already existed too", () => {
    const homeDir = home();
    recordMigrationSelectionBinding({
      homeDir,
      generationId: GENERATION_ID,
      binding: selectionBinding({ kind: "activation" }),
    });
    const root = join(homeDir, ".lcm");
    const store = migrationGenerationBindingStoreDirectory(homeDir);
    const generationDirectory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);

    const fsyncedPaths = withTrackedFsyncs(() => {
      recordMigrationSelectionBinding({
        homeDir,
        generationId: GENERATION_ID,
        binding: selectionBinding({ kind: "rollback", witnessChecksumSha256: HASH_B }),
      });
    });

    expect(fsyncedPaths.filter((path) => path === root).length).toBe(0);
    expect(fsyncedPaths.filter((path) => path === store).length).toBe(0);
    expect(fsyncedPaths.filter((path) => path === generationDirectory).length).toBe(1);
  });
});

describe("completeInterruptedScratchUnlink / reconcileWriterScratchTwin: internal branch coverage", () => {
  it("completeInterruptedScratchUnlink: leaves nothing to do when the twin is already gone (ENOENT) by the time" +
    " cleanup runs -- another retry may have completed the unlink first", () => {
    const homeDir = home();
    const binding = selectionBinding();
    const cleanBytes = captureCleanSelectionBytes(binding);
    const { finalPath, scratchPath } = buildCrashTwin(homeDir, GENERATION_ID, "selection-activation.binding", cleanBytes);
    expect(() =>
      recordMigrationSelectionBinding(
        { homeDir, generationId: GENERATION_ID, binding },
        {
          readWithStat: (path: string, options: BoundedFileOptions) => {
            const real = readBoundedRegularFileWithStat;
            if (path === scratchPath) {
              // Authenticate normally, then simulate a concurrent retry
              // completing the unlink first, before this call's own
              // completeInterruptedScratchUnlink gets to lstat it.
              const result = real(path, options);
              rmSync(scratchPath, { force: true });
              return result;
            }
            return real(path, options);
          },
        },
      ),
    ).not.toThrow();
    expect(readFileSync(finalPath, "utf8")).toBe(cleanBytes);
  });

  it("completeInterruptedScratchUnlink: propagates a genuine, non-ENOENT lstat failure unchanged rather than" +
    " swallowing it", () => {
    const homeDir = home();
    const binding = selectionBinding();
    const cleanBytes = captureCleanSelectionBytes(binding);
    const { scratchPath } = buildCrashTwin(homeDir, GENERATION_ID, "selection-activation.binding", cleanBytes);
    const boom = Object.assign(new Error("permission denied for testing"), { code: "EACCES" });
    const realLstatSync = (createRequire(import.meta.url)("node:fs") as { lstatSync: (p: string, o?: unknown) => unknown }).lstatSync;
    expect(() =>
      withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
        if (path === scratchPath) throw boom;
        return realLstatSync(path, options);
      }) as never, () =>
        recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding }),
      ),
    ).toThrow(boom);
  });

  it("completeInterruptedScratchUnlink: leaves a same-named, different-identity file alone rather than removing" +
    " it, when a real lstat right before removal disagrees with the earlier authenticated read", () => {
    const homeDir = home();
    const binding = selectionBinding();
    const cleanBytes = captureCleanSelectionBytes(binding);
    const { finalPath, scratchPath } = buildCrashTwin(homeDir, GENERATION_ID, "selection-activation.binding", cleanBytes);
    const decoyPath = scratchPath + ".decoy-swap";
    writeFileSync(decoyPath, "unrelated\n", { mode: 0o600 });
    const realLstatSync = (createRequire(import.meta.url)("node:fs") as { lstatSync: (p: string, o?: unknown) => unknown }).lstatSync;
    expect(() =>
      withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
        if (path === scratchPath) return realLstatSync(decoyPath, options);
        return realLstatSync(path, options);
      }) as never, () =>
        recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding }),
      ),
    ).not.toThrow();
    expect(existsSync(scratchPath)).toBe(true);
    expect(existsSync(decoyPath)).toBe(true);
    expect(readFileSync(finalPath, "utf8")).toBe(cleanBytes);
  });

  it("completeInterruptedScratchUnlink: swallows an ENOENT raised by the unlink call itself, not only by the" +
    " earlier lstat -- the doc comment's stated invariant (\"the twin already being gone is not an error\")" +
    " previously held only at the lstat, leaving a real gap in the narrower window between this function's own" +
    " lstat and its unlink, where a concurrent retry can complete the removal first", () => {
    const homeDir = home();
    const binding = selectionBinding();
    const cleanBytes = captureCleanSelectionBytes(binding);
    const { finalPath, scratchPath } = buildCrashTwin(homeDir, GENERATION_ID, "selection-activation.binding", cleanBytes);
    const realUnlinkSync = (createRequire(import.meta.url)("node:fs") as { unlinkSync: (p: string) => void }).unlinkSync;
    expect(() =>
      withPatchedFs("unlinkSync", ((path: string) => {
        if (path === scratchPath) {
          // A concurrent retry completes the removal first, in the window
          // between this function's own lstat (already run, above, and
          // authenticated the twin) and this unlink call. The subsequent
          // real unlinkSync call below then raises a genuine ENOENT rather
          // than a hand-built one.
          rmSync(scratchPath, { force: true });
        }
        return realUnlinkSync(path);
      }) as never, () =>
        recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding }),
      ),
    ).not.toThrow();
    expect(existsSync(scratchPath)).toBe(false);
    expect(readFileSync(finalPath, "utf8")).toBe(cleanBytes);
  });

  it("completeInterruptedScratchUnlink: propagates a genuine, non-ENOENT unlink failure unchanged rather than" +
    " swallowing it -- only ENOENT is the documented recovered-first-by-another-retry case; any other unlink" +
    " failure is a real problem the caller must see", () => {
    const homeDir = home();
    const binding = selectionBinding();
    const cleanBytes = captureCleanSelectionBytes(binding);
    const { scratchPath } = buildCrashTwin(homeDir, GENERATION_ID, "selection-activation.binding", cleanBytes);
    const boom = Object.assign(new Error("permission denied for testing"), { code: "EACCES" });
    const realUnlinkSync = (createRequire(import.meta.url)("node:fs") as { unlinkSync: (p: string) => void }).unlinkSync;
    expect(() =>
      withPatchedFs("unlinkSync", ((path: string) => {
        if (path === scratchPath) throw boom;
        return realUnlinkSync(path);
      }) as never, () =>
        recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding }),
      ),
    ).toThrow(boom);
  });

  it("reconcileWriterScratchTwin: is unresolvable when the final path's own re-read (without" +
    " requireSingleLink) reports absent (ENOENT) rather than present -- a genuine two-read race, reached only" +
    " through disclosed dependency injection; this pins only the first disjunct of the guard" +
    " (finalOutcome.kind !== \"present\"), see the sibling nlink !== \"2\" test below for the second", () => {
    const homeDir = home();
    const binding = selectionBinding();
    const cleanBytes = captureCleanSelectionBytes(binding);
    const { finalPath } = buildCrashTwin(homeDir, GENERATION_ID, "selection-activation.binding", cleanBytes);
    expect(() =>
      recordMigrationSelectionBinding(
        { homeDir, generationId: GENERATION_ID, binding },
        {
          readWithStat: (path: string, options: BoundedFileOptions) => {
            if (path === finalPath && options.requireSingleLink === true) {
              throw new Error("file has multiple hard links");
            }
            if (path === finalPath) {
              // The re-read (without requireSingleLink) that reconciles the
              // twin reports the state has already moved on -- a genuine
              // two-read race, only reachable through disclosed dependency
              // injection.
              const error = new Error("ENOENT") as NodeJS.ErrnoException;
              error.code = "ENOENT";
              throw error;
            }
            return readBoundedRegularFileWithStat(path, options);
          },
        },
      ),
    ).toThrow(MigrationBindingUnresolvableError);
  });

  it("reconcileWriterScratchTwin: is unresolvable when the final path's own re-read (without" +
    " requireSingleLink) reports present but with nlink no longer exactly \"2\" -- a genuine third-link race" +
    " between the requireSingleLink read that triggered recovery and this re-read, immediately before the" +
    " destructive unlink runs, reached only through disclosed dependency injection; this pins the second" +
    " disjunct of the guard (finalOutcome.value.nlink !== \"2\") that the sibling ENOENT test above does not" +
    " reach", () => {
    const homeDir = home();
    const binding = selectionBinding();
    const cleanBytes = captureCleanSelectionBytes(binding);
    const { finalPath } = buildCrashTwin(homeDir, GENERATION_ID, "selection-activation.binding", cleanBytes);
    expect(() =>
      recordMigrationSelectionBinding(
        { homeDir, generationId: GENERATION_ID, binding },
        {
          readWithStat: (path: string, options: BoundedFileOptions) => {
            if (path === finalPath && options.requireSingleLink === true) {
              throw new Error("file has multiple hard links");
            }
            if (path === finalPath) {
              // A third link appears between the requireSingleLink read
              // that triggered recovery and this re-read: present, but
              // nlink is no longer exactly "2". Rebuilt field-by-field
              // (never via object-spread) because several BoundedFileResult
              // fields, including nlink itself, are non-enumerable.
              const real = readBoundedRegularFileWithStat(path, options);
              return {
                content: real.content,
                mtimeMs: real.mtimeMs,
                dev: real.dev,
                ino: real.ino,
                mode: real.mode,
                uid: real.uid,
                gid: real.gid,
                nlink: "3",
                parentDev: real.parentDev,
                parentIno: real.parentIno,
                exactDev: real.exactDev,
                exactIno: real.exactIno,
              };
            }
            return readBoundedRegularFileWithStat(path, options);
          },
        },
      ),
    ).toThrow(MigrationBindingUnresolvableError);
  });

  it("reconcileWriterScratchTwin: is unresolvable when readdirSync itself fails while scanning for a" +
    " scratch twin", () => {
    const homeDir = home();
    const binding = selectionBinding();
    const cleanBytes = captureCleanSelectionBytes(binding);
    const { finalPath } = buildCrashTwin(homeDir, GENERATION_ID, "selection-activation.binding", cleanBytes);
    const directory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    const realReaddirSync = (createRequire(import.meta.url)("node:fs") as { readdirSync: (p: string) => string[] }).readdirSync;
    expect(() =>
      withPatchedFs("readdirSync", ((path: string) => {
        if (path === directory) throw new Error("synthetic readdir failure");
        return realReaddirSync(path);
      }) as never, () =>
        recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding }),
      ),
    ).toThrow(MigrationBindingUnresolvableError);
    expect(statSync(finalPath).nlink).toBe(2);
  });

  it("reconcileWriterScratchTwin: is unresolvable when a name-matching candidate itself fails an integrity" +
    " check while being read", () => {
    const homeDir = home();
    const binding = selectionBinding();
    const cleanBytes = captureCleanSelectionBytes(binding);
    buildCrashTwin(homeDir, GENERATION_ID, "selection-activation.binding", cleanBytes);
    const directory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    // A second, unrelated dotfile whose NAME matches the writer scratch
    // pattern but whose own content makes it fail the bounded read's size
    // limit -- an integrity failure encountered mid-scan, not at the final
    // path itself.
    const oversizedName = "." + "selection-activation.binding" + "." + randomBytes(12).toString("hex") + ".tmp";
    writeFileSync(join(directory, oversizedName), "x".repeat(4097), { mode: 0o600 });
    expect(() =>
      recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding }),
    ).toThrow(MigrationBindingUnresolvableError);
  });

  it("reconcileWriterScratchTwin: continues past a name-matching candidate that vanishes (ENOENT) between" +
    " being listed and being read, reached only through disclosed dependency injection", () => {
    const homeDir = home();
    const binding = selectionBinding();
    const cleanBytes = captureCleanSelectionBytes(binding);
    const { finalPath, scratchPath } = buildCrashTwin(homeDir, GENERATION_ID, "selection-activation.binding", cleanBytes);
    expect(() =>
      recordMigrationSelectionBinding(
        { homeDir, generationId: GENERATION_ID, binding },
        {
          readWithStat: (path: string, options: BoundedFileOptions) => {
            if (path === finalPath && options.requireSingleLink === true) {
              throw new Error("file has multiple hard links");
            }
            if (path === scratchPath) {
              const error = new Error("ENOENT") as NodeJS.ErrnoException;
              error.code = "ENOENT";
              throw error;
            }
            return readBoundedRegularFileWithStat(path, options);
          },
        },
      ),
    ).toThrow(MigrationBindingUnresolvableError);
  });

  it("reconcileWriterScratchTwin: a scratch-pattern-named decoy with its own separate inode is passed over" +
    " (content-and-metadata identity, never name alone, is what authenticates a twin) while nlink=2 is real" +
    " authority is an unrelated hardlink, and the write is refused as unresolvable with no genuine twin found", () => {
    const homeDir = home();
    const binding = selectionBinding();
    const directory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const finalPath = join(directory, "selection-activation.binding");
    // nlink=2 comes from an UNRELATED name (never matches the scratch
    // pattern), so the twin search finds no candidate from it.
    const unrelatedPath = join(directory, "unrelated-hardlink-name");
    writeFileSync(unrelatedPath, "not a writer scratch file\n", { mode: 0o600 });
    linkSync(unrelatedPath, finalPath);
    expect(statSync(finalPath).nlink).toBe(2);
    // A second, genuinely separate file (its own inode, nlink=1) whose NAME
    // fits the writer scratch pattern but whose content and identity do not
    // match final at all -- exercised so the pattern match at the loop's
    // entry is real, and exactWriterLinkPair's own content/identity check is
    // what correctly passes over it, not the name filter.
    const decoyName = "." + "selection-activation.binding" + "." + randomBytes(12).toString("hex") + ".tmp";
    writeFileSync(join(directory, decoyName), "not the same content at all\n", { mode: 0o600 });
    expect(() =>
      recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding }),
    ).toThrow(MigrationBindingUnresolvableError);
  });

  it("reconcileWriterScratchTwin: refuses to treat a name-matching candidate as a genuine scratch twin when" +
    " ANY error escapes reading it -- here a symlink raising ELOOP at open(2) (O_NOFOLLOW) -- fail-closed by" +
    " construction rather than by enumerating recognised codes, so an unrecognised failure from an untrusted" +
    " scan candidate becomes MigrationBindingUnresolvableError instead of escaping raw and wedging the retry" +
    " permanently", () => {
    const homeDir = home();
    const binding = selectionBinding();
    const directory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const finalPath = join(directory, "selection-activation.binding");
    // nlink=2 comes from an UNRELATED name (never matches the scratch
    // pattern), exactly as the decoy test above, so the twin search's only
    // name-matching candidate is the symlink below.
    const unrelatedPath = join(directory, "unrelated-hardlink-name-eloop");
    writeFileSync(unrelatedPath, "not a writer scratch file\n", { mode: 0o600 });
    linkSync(unrelatedPath, finalPath);
    expect(statSync(finalPath).nlink).toBe(2);
    // A name-matching scan candidate that is a live symlink rather than a
    // regular file. readBoundedRegularFileWithStat opens with O_NOFOLLOW,
    // so this raises a genuine ELOOP at open(2) -- a real .code the
    // classifier still does not recognise (it is not ENOENT/ENOTDIR,
    // EACCES/EPERM, or "file has multiple hard links"), which is exactly
    // why enumerating codes could never close this gap.
    const symlinkName = "." + "selection-activation.binding" + "." + randomBytes(12).toString("hex") + ".tmp";
    symlinkSync(unrelatedPath, join(directory, symlinkName));
    expect(() =>
      recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding }),
    ).toThrow(MigrationBindingUnresolvableError);
  });

  it("reconcileWriterScratchTwin: refuses a full-metadata clone (a separate inode carrying its own nlink=2," +
    " byte-identical content, and identical mode, uid, gid and mtime) as a genuine twin -- the only geometry" +
    " where exactWriterLinkPair's dev/ino fields are the sole discriminator, since every other compared field" +
    " is forced equal, so this is the one fixture that actually proves those fields matter rather than being" +
    " redundant with content or nlink", () => {
    const homeDir = home();
    const binding = selectionBinding();
    const cleanBytes = captureCleanSelectionBytes(binding);
    const directory = migrationGenerationBindingDirectory(homeDir, GENERATION_ID);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const finalPath = join(directory, "selection-activation.binding");
    // final gets nlink=2 via an UNRELATED sibling link (never matches the
    // scratch pattern), so no genuine twin exists for the scan to find --
    // only the clone below is a name-matching candidate.
    const finalContentPath = join(directory, "final-content-source-clone-geometry");
    writeFileSync(finalContentPath, cleanBytes, { mode: 0o600 });
    linkSync(finalContentPath, finalPath);

    // The clone: a SEPARATE inode (its own independent write), given its
    // own nlink=2 via its own second link, byte-identical content, and
    // identical mode -- and, set explicitly via utimesSync rather than
    // left to chance, identical mtime. uid/gid match automatically: the
    // same test process wrote both files.
    const clonePath = join(
      directory,
      "." + "selection-activation.binding" + "." + randomBytes(12).toString("hex") + ".tmp",
    );
    writeFileSync(clonePath, cleanBytes, { mode: 0o600 });
    const cloneSiblingLinkPath = join(directory, "clone-sibling-link");
    linkSync(clonePath, cloneSiblingLinkPath);
    // Round-tripping an EXISTING file's stat through utimesSync loses
    // sub-millisecond precision (a Date carries only whole milliseconds),
    // which would make the two mtimes merely close rather than the exact
    // equality exactWriterLinkPair requires. Setting BOTH files to the
    // identical explicit integer-second value sidesteps that: there is no
    // pre-existing fractional component to round away on either side.
    const fixedMtimeSeconds = 1_700_000_000;
    utimesSync(finalPath, fixedMtimeSeconds, fixedMtimeSeconds);
    utimesSync(clonePath, fixedMtimeSeconds, fixedMtimeSeconds);
    const finalStat = statSync(finalPath);
    expect(finalStat.nlink).toBe(2);
    const cloneStat = statSync(clonePath);
    expect(cloneStat.nlink).toBe(2);
    expect(cloneStat.ino).not.toBe(finalStat.ino);
    expect(cloneStat.mtimeMs).toBe(finalStat.mtimeMs);
    expect(cloneStat.mode).toBe(finalStat.mode);

    // Every field exactWriterLinkPair compares is now equal between final
    // and clone except dev/ino identity, so a refusal here can only be
    // caused by the inode-fields comparison -- not by content, nlink,
    // parent identity, mode, uid, gid or mtime, each of which is already
    // forced equal above.
    expect(() =>
      recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding }),
    ).toThrow(MigrationBindingUnresolvableError);
  });
});

describe("pathExists (via ensureSyncedPrivateChild): internal branch coverage", () => {
  it("wraps a genuine, non-ENOENT lstat failure from the existence check as unsafe storage (the same" +
    " catch-and-wrap discipline this module already applies to every other directory-authentication failure)," +
    " while the underlying cause is preserved rather than swallowed", () => {
    const homeDir = home();
    const store = migrationGenerationBindingStoreDirectory(homeDir);
    const boom = Object.assign(new Error("permission denied for testing"), { code: "EACCES" });
    const realLstatSync = (createRequire(import.meta.url)("node:fs") as { lstatSync: (p: string, o?: unknown) => unknown }).lstatSync;
    let caught: unknown;
    withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
      if (path === store) throw boom;
      return realLstatSync(path, options);
    }) as never, () => {
      try {
        recordMigrationSelectionBinding({ homeDir, generationId: GENERATION_ID, binding: selectionBinding() });
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBeInstanceOf(MigrationBindingUnsafeStorageError);
    expect((caught as MigrationBindingUnsafeStorageError & { cause?: unknown }).cause).toBe(boom);
  });
});
