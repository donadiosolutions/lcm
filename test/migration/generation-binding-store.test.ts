import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
  it("returns undefined synchronously, never a thenable, and is not an async function", () => {
    const homeDir = home();
    expect(recordMigrationSelectionBinding.constructor.name).toBe("Function");
    const result = recordMigrationSelectionBinding({
      homeDir,
      generationId: GENERATION_ID,
      binding: selectionBinding(),
    });
    expect(result).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object(result), "then")).toBe(false);
  });
});

describe("recordMigrationWitnessBinding: synchronous return", () => {
  it("returns undefined synchronously, never a thenable, and is not an async function", () => {
    const homeDir = home();
    expect(recordMigrationWitnessBinding.constructor.name).toBe("Function");
    const result = recordMigrationWitnessBinding({
      homeDir,
      generationId: GENERATION_ID,
      binding: witnessBinding(),
    });
    expect(result).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object(result), "then")).toBe(false);
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
