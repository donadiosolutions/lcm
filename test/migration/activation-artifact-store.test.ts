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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActivationArtifactIdentityMismatchError,
  ActivationArtifactPresenceUnresolvableError,
  ActivationArtifactUnsafeStorageError,
  ActivationArtifactValidationError,
  activationArtifactDirectory,
  activationArtifactPath,
  captureActivationRecoveryFile,
  computeActivationArtifactIdentityDigest,
  publishActivationArtifact,
  readActivationArtifact,
  type ActivationArtifactRecoveryMaterial,
} from "../../src/migration/activation-artifact-store.js";
import type { BackendPublicationRecoveryFile } from "../../src/storage/backend-publication.js";
import {
  PrivateFileCollisionCleanupError,
  PrivateFileCollisionError,
  readBoundedRegularFileWithStat,
  type BoundedFileOptions,
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
      chmodSync(join(root, ".lcm", "migration-activation-material"), 0o700);
    } catch { /* best-effort */ }
    try { chmodSync(join(root, "sources"), 0o700); } catch { /* best-effort */ }
    rmSync(root, { recursive: true, force: true });
  }
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-activation-artifact-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

/** A home directory whose private .lcm root deliberately does not exist yet,
 * to exercise the fail-closed directory-bootstrap path. */
function homeWithoutLcmRoot(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-activation-artifact-noroot-"));
  roots.push(value);
  return value;
}

function sourcesDir(homeDir: string): string {
  const dir = join(homeDir, "sources");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function writeSourceFile(homeDir: string, name: string, content: string): string {
  const dir = sourcesDir(homeDir);
  const path = join(dir, name);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** Build a real, genuine candidate material: every file is captured (via
 * captureActivationRecoveryFile, itself under test below) from real files on
 * disk with real identity metadata, never a hand-built witness object. */
function buildMaterial(
  homeDir: string,
  publicationId: string,
  overrides: Partial<{
    sourceConfig: string;
    sourceMap: string;
    targetConfig: string;
    targetMap: string;
    projects: ActivationArtifactRecoveryMaterial["projects"];
  }> = {},
): ActivationArtifactRecoveryMaterial {
  const dir = sourcesDir(homeDir);
  const sourceConfigPath = writeSourceFile(homeDir, "source-config.json", overrides.sourceConfig ?? '{"backend":"sqlite"}');
  const sourceMapPath = writeSourceFile(homeDir, "source-map.json", overrides.sourceMap ?? '{"map":{}}');
  const targetConfigPath = writeSourceFile(homeDir, "target-config.json", overrides.targetConfig ?? '{"backend":"postgresql"}');
  const targetMapPath = writeSourceFile(homeDir, "target-map.json", overrides.targetMap ?? '{"map":{}}');
  return {
    version: 1,
    publicationId,
    source: {
      config: captureActivationRecoveryFile(sourceConfigPath, dir),
      projectMap: captureActivationRecoveryFile(sourceMapPath, dir),
    },
    target: {
      config: captureActivationRecoveryFile(targetConfigPath, dir),
      projectMap: captureActivationRecoveryFile(targetMapPath, dir),
    },
    projects: overrides.projects ?? [
      { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: HASH_A },
    ],
  };
}

describe("computeActivationArtifactIdentityDigest", () => {
  it("is deterministic for identical source, target and projects", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const first = computeActivationArtifactIdentityDigest(material);
    const second = computeActivationArtifactIdentityDigest(material);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("excludes publicationId: two materials differing only in publicationId share a digest", () => {
    const homeDir = home();
    const materialA = buildMaterial(homeDir, "pub-1");
    const materialB = { ...materialA, publicationId: "pub-2" };
    expect(computeActivationArtifactIdentityDigest(materialA)).toBe(
      computeActivationArtifactIdentityDigest(materialB),
    );
  });

  it("is independent of the projects array's input order", () => {
    const homeDir = home();
    const projectsAsc = [
      { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: HASH_A },
      { localProjectId: "local-b", remoteProjectId: "remote-b", evidenceSha256: HASH_B },
    ];
    const projectsDesc = [...projectsAsc].reverse();
    const materialAsc = buildMaterial(homeDir, "pub-1", { projects: projectsAsc });
    const materialDesc = { ...materialAsc, projects: projectsDesc };
    expect(computeActivationArtifactIdentityDigest(materialAsc)).toBe(
      computeActivationArtifactIdentityDigest(materialDesc),
    );
  });

  it("differs when the source content differs", () => {
    const homeDir = home();
    const materialA = buildMaterial(homeDir, "pub-1", { sourceConfig: '{"backend":"sqlite","n":1}' });
    const materialB = buildMaterial(homeDir, "pub-1", { sourceConfig: '{"backend":"sqlite","n":2}' });
    expect(computeActivationArtifactIdentityDigest(materialA)).not.toBe(
      computeActivationArtifactIdentityDigest(materialB),
    );
  });

  it("rejects a malformed candidate rather than hashing garbage", () => {
    expect(() =>
      computeActivationArtifactIdentityDigest({
        source: { config: { presence: "absent" }, projectMap: { presence: "absent" } },
        target: { config: { presence: "absent" }, projectMap: { presence: "absent" } },
        projects: "not-an-array" as unknown as ActivationArtifactRecoveryMaterial["projects"],
      }),
    ).toThrow(ActivationArtifactValidationError);
  });
});

describe("captureActivationRecoveryFile", () => {
  it("reports a genuinely absent path as presence: absent", () => {
    const homeDir = home();
    const dir = sourcesDir(homeDir);
    const result = captureActivationRecoveryFile(join(dir, "does-not-exist.json"), dir);
    expect(result).toEqual({ presence: "absent" });
  });

  it("captures a present file's content and real file-identity metadata", () => {
    const homeDir = home();
    const path = writeSourceFile(homeDir, "present.json", '{"k":"v"}');
    const dir = sourcesDir(homeDir);
    const result = captureActivationRecoveryFile(path, dir) as Extract<
      BackendPublicationRecoveryFile,
      { presence: "present" }
    >;
    expect(result.presence).toBe("present");
    expect(Buffer.from(result.content).toString("utf8")).toBe('{"k":"v"}');
    expect(result.mode).toBe(0o600);
    expect(result.nlink).toBe("1");
    expect(/^\d+$/u.test(result.dev)).toBe(true);
    expect(/^\d+$/u.test(result.ino)).toBe(true);
    expect(/^\d+$/u.test(result.parentDev)).toBe(true);
    expect(/^\d+$/u.test(result.parentIno)).toBe(true);
  });

  it("is unresolvable (throws), not absent, when the real file exists but permission is genuinely denied", () => {
    const homeDir = home();
    const path = writeSourceFile(homeDir, "locked.json", '{"k":"v"}');
    const dir = sourcesDir(homeDir);
    chmodSync(path, 0o000);
    try {
      expect(() => captureActivationRecoveryFile(path, dir)).toThrow(
        ActivationArtifactPresenceUnresolvableError,
      );
    } finally {
      chmodSync(path, 0o600);
    }
  });
});

describe("publishActivationArtifact", () => {
  it("durably writes a fresh record and returns outcome \"written\"", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const result = publishActivationArtifact({ homeDir, material });
    expect(result.outcome).toBe("written");
    expect(result.identityDigest).toBe(computeActivationArtifactIdentityDigest(material));
    expect(result.path).toBe(activationArtifactPath(homeDir, result.identityDigest));
  });

  it("reuses an existing entry when the candidate is byte-identical (idempotent retry)", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const first = publishActivationArtifact({ homeDir, material });
    expect(first.outcome).toBe("written");
    // A second, independently rebuilt candidate for the exact same real
    // files and the exact same publicationId -- the realistic shape of a
    // caller retrying after a crash before anything was sealed.
    const second = publishActivationArtifact({ homeDir, material: buildMaterial(homeDir, "pub-1") });
    expect(second.outcome).toBe("reused");
    expect(second.identityDigest).toBe(first.identityDigest);
  });

  it("never refreshes the publicationId: a retry with a fresh id for the same identity refuses", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const first = publishActivationArtifact({ homeDir, material });
    expect(first.outcome).toBe("written");
    // Same source/target/projects (same identity digest) but a freshly
    // minted publicationId, exactly the "recovery re-drives with a refreshed
    // id" mistake the module doc comment explains must never happen.
    const refreshed = { ...material, publicationId: "pub-2" };
    expect(() => publishActivationArtifact({ homeDir, material: refreshed })).toThrow(
      ActivationArtifactIdentityMismatchError,
    );
  });

  it("refuses when a different record has been corrupted/replaced directly at the identity path", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const directory = activationArtifactDirectory(homeDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = activationArtifactPath(homeDir, digest);
    // Real bytes that do not correspond to this candidate's serialization,
    // written directly (bypassing publishActivationArtifact entirely) to
    // simulate a name collision or on-disk corruption under the same key.
    writeFileSync(path, '{"not":"the expected record"}\n', { mode: 0o600 });
    expect(() => publishActivationArtifact({ homeDir, material })).toThrow(
      ActivationArtifactIdentityMismatchError,
    );
  });

  it("converges on retry despite orphaned temp-file debris from a prior interrupted attempt", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const directory = activationArtifactDirectory(homeDir);
    // Real debris: atomicWritePrivateFileDurable's temp files are named
    // ".<basename>.<random-hex>.tmp" and are only ever linked into place
    // after a complete, fsynced write. A process that crashed after opening
    // and partially writing (or even fully writing) that temp file, but
    // before the link() call, leaves exactly this: an orphaned, arbitrarily
    // named temp file that was *never* linked to the final identity-digest
    // path. Because this module always creates a *fresh* random temp name
    // per attempt (never reuses one), this debris cannot collide with -- or
    // block -- a subsequent legitimate attempt. This is precisely what a
    // bare O_EXCL-on-the-final-path design would *not* have: that design
    // writes directly to the final, deterministic name, so a crash mid-write
    // leaves a truncated body sitting at the exact name retry needs, which a
    // byte-identity read-back check would then refuse permanently.
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, `.${digest}.material.deadbeefcafefeed.tmp`),
      "truncated-partial-body-from-a-crashed-attempt",
      { mode: 0o600 },
    );
    const result = publishActivationArtifact({ homeDir, material });
    expect(result.outcome).toBe("written");
    const readBack = readActivationArtifact({ homeDir, identityDigest: digest });
    expect(readBack).not.toBeNull();
  });

  it("is unresolvable (throws), not absent, when an existing artifact's permission is genuinely denied", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const first = publishActivationArtifact({ homeDir, material });
    chmodSync(first.path, 0o000);
    try {
      expect(() => publishActivationArtifact({ homeDir, material: buildMaterial(homeDir, "pub-1") })).toThrow(
        ActivationArtifactPresenceUnresolvableError,
      );
      // Demonstrate the attribution actually matters: a deliberately broken
      // reconciliation that folds "unresolvable" into "absent" (i.e. treats
      // a permission-denied read as "nothing here, safe to write") would
      // wrongly attempt to overwrite -- and since requireAbsent demands a
      // genuinely absent destination, that broken behavior would itself
      // throw a *different* error (a durable-write collision) instead of
      // this module's own attributed ActivationArtifactPresenceUnresolvableError,
      // proving the distinction is load-bearing rather than cosmetic.
      let sawUnresolvable = false;
      try {
        publishActivationArtifact({ homeDir, material: buildMaterial(homeDir, "pub-1") });
      } catch (error) {
        sawUnresolvable = error instanceof ActivationArtifactPresenceUnresolvableError;
      }
      expect(sawUnresolvable).toBe(true);
    } finally {
      chmodSync(first.path, 0o600);
    }
  });

  it("fails closed when the private LCM root does not exist yet", () => {
    const homeDir = homeWithoutLcmRoot();
    const material = buildMaterial(homeDir, "pub-1");
    expect(() => publishActivationArtifact({ homeDir, material })).toThrow(
      ActivationArtifactUnsafeStorageError,
    );
  });

  it("rejects a candidate with an invalid publicationId", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "not a valid id");
    expect(() => publishActivationArtifact({ homeDir, material })).toThrow(
      ActivationArtifactValidationError,
    );
  });

  it("rejects a candidate whose recovery file is not owner-only mode", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const tampered = {
      ...material,
      source: {
        ...material.source,
        config: { ...(material.source.config as Extract<BackendPublicationRecoveryFile, { presence: "present" }>), mode: 0o644 },
      },
    };
    expect(() => publishActivationArtifact({ homeDir, material: tampered })).toThrow(
      ActivationArtifactValidationError,
    );
  });

  it("rejects duplicate localProjectId entries in the projects array", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1", {
      projects: [
        { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: HASH_A },
        { localProjectId: "local-a", remoteProjectId: "remote-b", evidenceSha256: HASH_B },
      ],
    });
    expect(() => publishActivationArtifact({ homeDir, material })).toThrow(
      ActivationArtifactValidationError,
    );
  });

  it("rejects duplicate remoteProjectId entries in the projects array", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1", {
      projects: [
        { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: HASH_A },
        { localProjectId: "local-b", remoteProjectId: "remote-a", evidenceSha256: HASH_B },
      ],
    });
    expect(() => publishActivationArtifact({ homeDir, material })).toThrow(
      ActivationArtifactValidationError,
    );
  });

  it("rejects a malformed evidenceSha256", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1", {
      projects: [{ localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: "not-a-hash" }],
    });
    expect(() => publishActivationArtifact({ homeDir, material })).toThrow(
      ActivationArtifactValidationError,
    );
  });

  it("normalizes (sorts) the projects array before persisting, independent of input order", () => {
    const homeDir = home();
    const projects = [
      { localProjectId: "local-b", remoteProjectId: "remote-b", evidenceSha256: HASH_B },
      { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: HASH_A },
    ];
    const material = buildMaterial(homeDir, "pub-1", { projects });
    const result = publishActivationArtifact({ homeDir, material });
    expect(result.material.projects.map((p) => p.localProjectId)).toEqual(["local-a", "local-b"]);
  });

  describe("with an injected durable-write collision (a true concurrent race cannot be reproduced", () => {
    it("deterministically inside a single synchronous test process; both branches below are disclosed" +
      " dependency injection rather than a genuine two-process race, following this campaign's" +
      " established convention for reach that cannot be reached through a real fixture)", () => {
      const homeDir = home();
      const material = buildMaterial(homeDir, "pub-1");
      const digest = computeActivationArtifactIdentityDigest(material);
      const path = activationArtifactPath(homeDir, digest);
      let calls = 0;
      const result = publishActivationArtifact(
        { homeDir, material },
        {
          writeDurable: (targetPath, content) => {
            calls += 1;
            // Simulate a concurrent writer's publish landing between this
            // call's own presence check and its own durable-write attempt:
            // the content a genuine concurrent winner would have produced
            // (byte-identical to this candidate) is already on disk by the
            // time this call's own link attempt is rejected.
            writeFileSync(targetPath, content, { mode: 0o600 });
            throw new PrivateFileCollisionError("private file was created concurrently");
          },
        },
      );
      expect(calls).toBe(1);
      expect(result.outcome).toBe("reused");
      const onDisk = readActivationArtifact({ homeDir, identityDigest: digest });
      expect(onDisk?.publicationId).toBe("pub-1");
      void path;
    });

    it("re-throws the original collision when the collision inexplicably vanishes on retry", () => {
      const homeDir = home();
      const material = buildMaterial(homeDir, "pub-1");
      expect(() =>
        publishActivationArtifact(
          { homeDir, material },
          {
            writeDurable: () => {
              throw new PrivateFileCollisionError("private file already exists");
            },
          },
        ),
      ).toThrow("private file already exists");
    });
  });

  it("propagates an unrecognized durable-write failure unchanged", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const boom = new Error("disk is full");
    expect(() =>
      publishActivationArtifact(
        { homeDir, material },
        { writeDurable: () => { throw boom; } },
      ),
    ).toThrow(boom);
  });

  it("propagates an unrecognized presence-check failure unchanged rather than attributing it", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const boom = new Error("unexpected failure with no fs error code");
    expect(() =>
      publishActivationArtifact(
        { homeDir, material },
        { readWithStat: () => { throw boom; } },
      ),
    ).toThrow(boom);
  });
});

describe("readActivationArtifact", () => {
  it("returns null for a genuinely absent artifact", () => {
    const homeDir = home();
    expect(readActivationArtifact({ homeDir, identityDigest: HASH_A })).toBeNull();
  });

  it("rejects a malformed identity digest before any I/O", () => {
    const homeDir = home();
    expect(() => readActivationArtifact({ homeDir, identityDigest: "not-a-digest" })).toThrow(
      ActivationArtifactValidationError,
    );
  });

  it("round-trips a published record exactly", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const published = publishActivationArtifact({ homeDir, material });
    const readBack = readActivationArtifact({ homeDir, identityDigest: published.identityDigest });
    expect(readBack).not.toBeNull();
    expect(readBack?.publicationId).toBe("pub-1");
    expect(readBack?.projects).toEqual(material.projects);
    const sourceConfig = readBack?.source.config as Extract<BackendPublicationRecoveryFile, { presence: "present" }>;
    expect(Buffer.from(sourceConfig.content).toString("utf8")).toBe('{"backend":"sqlite"}');
  });

  it("is unresolvable (throws), not absent, when a real stored artifact's permission is genuinely denied", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const published = publishActivationArtifact({ homeDir, material });
    chmodSync(published.path, 0o000);
    try {
      expect(() => readActivationArtifact({ homeDir, identityDigest: published.identityDigest })).toThrow(
        ActivationArtifactPresenceUnresolvableError,
      );
    } finally {
      chmodSync(published.path, 0o600);
    }
  });

  it("rejects a stored record that is not valid JSON", () => {
    const homeDir = home();
    const directory = activationArtifactDirectory(homeDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const digest = HASH_B;
    writeFileSync(activationArtifactPath(homeDir, digest), "not json at all", { mode: 0o600 });
    expect(() => readActivationArtifact({ homeDir, identityDigest: digest })).toThrow(
      ActivationArtifactValidationError,
    );
  });

  it("rejects a stored record with a malformed envelope (extra/missing keys)", () => {
    const homeDir = home();
    const directory = activationArtifactDirectory(homeDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const digest = HASH_A;
    writeFileSync(
      activationArtifactPath(homeDir, digest),
      `${JSON.stringify({ version: 1, publicationId: "pub-1", source: {}, target: {}, projects: [], extra: true })}\n`,
      { mode: 0o600 },
    );
    expect(() => readActivationArtifact({ homeDir, identityDigest: digest })).toThrow(
      ActivationArtifactValidationError,
    );
  });

  it("rejects a stored record whose project entry is malformed", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const published = publishActivationArtifact({ homeDir, material });
    const raw = JSON.parse(
      Buffer.from(
        (published.material.source.config as Extract<BackendPublicationRecoveryFile, { presence: "present" }>).content,
      ).toString("utf8") === '{"backend":"sqlite"}'
        ? `{"placeholder":true}`
        : `{"placeholder":true}`,
    );
    void raw;
    // Rebuild a minimally valid envelope by hand, then corrupt just the
    // projects entry, to isolate this exact validation branch.
    const config = published.material.source.config as Extract<BackendPublicationRecoveryFile, { presence: "present" }>;
    const fileJson = {
      presence: "present",
      contentBase64: Buffer.from(config.content).toString("base64"),
      mode: config.mode,
      uid: config.uid,
      gid: config.gid,
      nlink: config.nlink,
      dev: config.dev,
      ino: config.ino,
      parentDev: config.parentDev,
      parentIno: config.parentIno,
    };
    const digest = HASH_A === published.identityDigest ? HASH_B : HASH_A;
    const directory = activationArtifactDirectory(homeDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      activationArtifactPath(homeDir, digest),
      `${JSON.stringify({
        version: 1,
        publicationId: "pub-1",
        source: { config: fileJson, projectMap: { presence: "absent" } },
        target: { config: { presence: "absent" }, projectMap: { presence: "absent" } },
        projects: [{ localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: "not-a-hash" }],
      })}\n`,
      { mode: 0o600 },
    );
    expect(() => readActivationArtifact({ homeDir, identityDigest: digest })).toThrow(
      ActivationArtifactValidationError,
    );
  });
});


describe("activationArtifactDirectory / activationArtifactPath default homeDir", () => {
  it("falls back to the process home directory when homeDir is omitted", async () => {
    const { homedir } = await import("node:os");
    const { join: pathJoin } = await import("node:path");
    expect(activationArtifactDirectory()).toBe(pathJoin(homedir(), ".lcm", "migration-activation-material"));
    expect(activationArtifactPath(undefined, HASH_A)).toBe(
      pathJoin(homedir(), ".lcm", "migration-activation-material", `${HASH_A}.material`),
    );
  });
});

describe("currentUid fallback", () => {
  it("still publishes and reads back successfully when process.getuid is unavailable", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      const result = publishActivationArtifact({ homeDir, material });
      expect(result.outcome).toBe("written");
      expect(readActivationArtifact({ homeDir, identityDigest: result.identityDigest })).not.toBeNull();
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });
});

describe("ensureActivationArtifactDirectory failure via an occupied path", () => {
  it("fails closed when a regular file already occupies the activation-artifact directory path", () => {
    const homeDir = home();
    const directory = activationArtifactDirectory(homeDir);
    // A real, genuine collision: something that is not a directory sits at
    // the exact path this module needs to create/open as a private
    // directory. ensurePrivateDirectory's own mkdirSync(recursive) throws
    // for this real filesystem state (ENOTDIR/EEXIST depending on
    // platform), which this module wraps as ActivationArtifactUnsafeStorageError.
    writeFileSync(directory, "not a directory", { mode: 0o600 });
    const material = buildMaterial(homeDir, "pub-1");
    expect(() => publishActivationArtifact({ homeDir, material })).toThrow(
      ActivationArtifactUnsafeStorageError,
    );
  });
});

describe("material version validation", () => {
  it("rejects an explicit, unsupported version", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const tampered = { ...material, version: 2 } as unknown as ActivationArtifactRecoveryMaterial;
    expect(() => publishActivationArtifact({ homeDir, material: tampered })).toThrow(
      ActivationArtifactValidationError,
    );
    expect(() => computeActivationArtifactIdentityDigest(tampered)).toThrow(ActivationArtifactValidationError);
  });
});

describe("absent files round-trip", () => {
  it("publishes and reads back a material with an absent target config (a fresh target with no prior file)", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const withAbsentTarget: ActivationArtifactRecoveryMaterial = {
      ...material,
      target: { ...material.target, config: { presence: "absent" } },
    };
    const published = publishActivationArtifact({ homeDir, material: withAbsentTarget });
    const readBack = readActivationArtifact({ homeDir, identityDigest: published.identityDigest });
    expect(readBack?.target.config).toEqual({ presence: "absent" });
  });
});

describe("assertRecoveryFileShape malformed-candidate branches", () => {
  it("rejects a source file that is not a record at all", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const tampered = {
      ...material,
      source: { ...material.source, config: null },
    } as unknown as ActivationArtifactRecoveryMaterial;
    expect(() => publishActivationArtifact({ homeDir, material: tampered })).toThrow(
      ActivationArtifactValidationError,
    );
  });

  it("rejects a source file whose presence is neither absent nor present", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const tampered = {
      ...material,
      source: { ...material.source, config: { presence: "pending" } },
    } as unknown as ActivationArtifactRecoveryMaterial;
    expect(() => publishActivationArtifact({ homeDir, material: tampered })).toThrow(
      ActivationArtifactValidationError,
    );
  });

  it("rejects an absent source file that carries unexpected extra fields", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const tampered = {
      ...material,
      source: { ...material.source, config: { presence: "absent", extra: true } },
    } as unknown as ActivationArtifactRecoveryMaterial;
    expect(() => publishActivationArtifact({ homeDir, material: tampered })).toThrow(
      ActivationArtifactValidationError,
    );
  });
});

describe("recoveryFileFromWireJson malformed-stored-record branches", () => {
  function writeRawMaterial(homeDir: string, digest: string, sourceConfig: unknown): void {
    const directory = activationArtifactDirectory(homeDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      activationArtifactPath(homeDir, digest),
      `${JSON.stringify({
        version: 1,
        publicationId: "pub-1",
        source: { config: sourceConfig, projectMap: { presence: "absent" } },
        target: { config: { presence: "absent" }, projectMap: { presence: "absent" } },
        projects: [],
      })}\n`,
      { mode: 0o600 },
    );
  }

  it("rejects a stored file field that is not a record", () => {
    const homeDir = home();
    writeRawMaterial(homeDir, HASH_A, null);
    expect(() => readActivationArtifact({ homeDir, identityDigest: HASH_A })).toThrow(
      ActivationArtifactValidationError,
    );
  });

  it("rejects a stored absent file field with unexpected extra keys", () => {
    const homeDir = home();
    writeRawMaterial(homeDir, HASH_A, { presence: "absent", extra: true });
    expect(() => readActivationArtifact({ homeDir, identityDigest: HASH_A })).toThrow(
      ActivationArtifactValidationError,
    );
  });

  it("rejects a stored present file field missing a required identity field", () => {
    const homeDir = home();
    writeRawMaterial(homeDir, HASH_A, {
      presence: "present",
      contentBase64: Buffer.from("hi").toString("base64"),
      mode: 0o600,
      uid: 0,
      gid: 0,
      nlink: "1",
      dev: "1",
      ino: "1",
      parentDev: "1",
      // parentIno intentionally omitted
    });
    expect(() => readActivationArtifact({ homeDir, identityDigest: HASH_A })).toThrow(
      ActivationArtifactValidationError,
    );
  });

  it("rejects a stored present file field whose presence flag was tampered to something else", () => {
    const homeDir = home();
    writeRawMaterial(homeDir, HASH_A, {
      presence: "present",
      contentBase64: Buffer.from("hi").toString("base64"),
      mode: 0o600,
      uid: 0,
      gid: 0,
      nlink: "1",
      dev: "1",
      ino: "1",
      parentDev: "1",
      parentIno: "1",
    });
    // Corrupt on-disk bytes directly: flip the presence value after the
    // otherwise-valid-shaped object was serialized, to exercise the
    // `value.presence !== "present"` guard specifically (distinct from the
    // exactKeys guard exercised by the other malformed-record tests here).
    const directory = activationArtifactDirectory(homeDir);
    const raw = JSON.parse(
      Buffer.from(
        readFileSync(activationArtifactPath(homeDir, HASH_A)),
      ).toString("utf8"),
    ) as Record<string, unknown>;
    (raw.source as Record<string, unknown>).config = {
      ...((raw.source as Record<string, unknown>).config as Record<string, unknown>),
      presence: "pending",
    };
    writeFileSync(activationArtifactPath(homeDir, HASH_A), `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    void directory;
    expect(() => readActivationArtifact({ homeDir, identityDigest: HASH_A })).toThrow(
      ActivationArtifactValidationError,
    );
  });
});

/** Mirror of generation-binding-store.test.ts's withPatchedFs: patch one
 * node:fs export for the duration of callback, then restore it, so calls
 * made through this module's own named ESM imports are reached too. */
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

/** Publish once, then hand back the exact on-disk wire bytes and remove the
 * published file, so the caller can rebuild the precise post-link crash
 * state from genuine bytes rather than hand-built approximations. */
function capturePublishedArtifactBytes(
  homeDir: string,
  material: ActivationArtifactRecoveryMaterial,
): string {
  const first = publishActivationArtifact({ homeDir, material });
  expect(first.outcome).toBe("written");
  const bytes = readFileSync(first.path, "utf8");
  rmSync(first.path);
  return bytes;
}

/** Rebuild the exact crash state atomicWritePrivateFileDurable's
 * requireAbsent path leaves when linkSync(final) succeeds but the matching
 * unlinkSync(scratch) never runs: the final name and its scratch twin are
 * two links to one inode, both nlink=2. */
function buildArtifactCrashTwin(
  homeDir: string,
  identityDigest: string,
  content: string,
): Readonly<{ finalPath: string; scratchPath: string }> {
  const directory = activationArtifactDirectory(homeDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const finalPath = activationArtifactPath(homeDir, identityDigest);
  const scratchPath = join(
    directory,
    "." + identityDigest + ".material." + randomBytes(12).toString("hex") + ".tmp",
  );
  writeFileSync(scratchPath, content, { mode: 0o600 });
  linkSync(scratchPath, finalPath);
  return { finalPath, scratchPath };
}

describe("publishActivationArtifact: post-link crash-twin recovery (#1436)", () => {
  it("converges on retry after the exact post-link crash state, completing the interrupted unlink" +
    " instead of escaping the raw multi-link read error", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const cleanBytes = capturePublishedArtifactBytes(homeDir, material);
    const { finalPath, scratchPath } = buildArtifactCrashTwin(homeDir, digest, cleanBytes);
    expect(statSync(finalPath).nlink).toBe(2);
    const result = publishActivationArtifact({ homeDir, material: buildMaterial(homeDir, "pub-1") });
    expect(result.outcome).toBe("reused");
    expect(statSync(finalPath).nlink).toBe(1);
    expect(existsSync(scratchPath)).toBe(false);
    expect(readFileSync(finalPath, "utf8")).toBe(cleanBytes);
  });

  it("refuses a conflicting rewrite when the authenticated twin's content differs from the candidate", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const cleanBytes = capturePublishedArtifactBytes(homeDir, material);
    buildArtifactCrashTwin(homeDir, digest, cleanBytes);
    const conflicting = { ...buildMaterial(homeDir, "pub-1"), publicationId: "pub-2" };
    expect(() => publishActivationArtifact({ homeDir, material: conflicting })).toThrow(
      ActivationArtifactIdentityMismatchError,
    );
  });

  it("is unresolvable, never raw and never a conflict, when nlink=2 has no matching writer-scratch twin", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const directory = activationArtifactDirectory(homeDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const unrelatedPath = join(directory, "unrelated-hardlink-name");
    const finalPath = activationArtifactPath(homeDir, digest);
    writeFileSync(unrelatedPath, "not a writer scratch file", { mode: 0o600 });
    linkSync(unrelatedPath, finalPath);
    expect(statSync(finalPath).nlink).toBe(2);
    expect(() => publishActivationArtifact({ homeDir, material: buildMaterial(homeDir, "pub-1") })).toThrow(
      ActivationArtifactPresenceUnresolvableError,
    );
  });

  it("readActivationArtifact reports the same stuck-twin state as unresolvable, not a raw error", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const cleanBytes = capturePublishedArtifactBytes(homeDir, material);
    buildArtifactCrashTwin(homeDir, digest, cleanBytes);
    expect(() => readActivationArtifact({ homeDir, identityDigest: digest })).toThrow(
      ActivationArtifactPresenceUnresolvableError,
    );
  });
});

describe("publishActivationArtifact: typed durable-write collision recognition (#1434)", () => {
  it("reconciles as reused when the write primitive raises a typed collision with unrelated message text", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const result = publishActivationArtifact(
      { homeDir, material },
      {
        writeDurable: (targetPath, content) => {
          writeFileSync(targetPath, content, { mode: 0o600 });
          throw new PrivateFileCollisionError("driver-specific wording that must never be matched");
        },
      },
    );
    expect(result.outcome).toBe("reused");
  });

  it("reconciles as reused for a typed collision cleanup whose primary failure is a collision", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const result = publishActivationArtifact(
      { homeDir, material },
      {
        writeDurable: (targetPath, content) => {
          writeFileSync(targetPath, content, { mode: 0o600 });
          throw new PrivateFileCollisionCleanupError("wrapped typed collision", {
            cause: new PrivateFileCollisionError("driver-specific primary wording"),
          });
        },
      },
    );
    expect(result.outcome).toBe("reused");
  });

  it("propagates a same-message bare Error rather than treating its text as a collision", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const boom = new Error("private file was created concurrently");
    expect(() =>
      publishActivationArtifact(
        { homeDir, material },
        {
          writeDurable: (targetPath, content) => {
            // A genuine concurrent winner's bytes are on disk, exactly as
            // in the benign case above -- only the error's type differs.
            writeFileSync(targetPath, content, { mode: 0o600 });
            throw boom;
          },
        },
      ),
    ).toThrow(boom);
  });
});

describe("ensureActivationArtifactDirectory: creation-path durability (#1437)", () => {
  it("fsyncs the freshly created store directory and its parent LCM root on first creation", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const root = join(homeDir, ".lcm");
    const store = activationArtifactDirectory(homeDir);
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
    }) as never, () => {
      publishActivationArtifact({ homeDir, material });
    }));
    expect(fsyncedPaths.filter((path) => path === root).length).toBeGreaterThanOrEqual(1);
    expect(fsyncedPaths.filter((path) => path === store).length).toBeGreaterThanOrEqual(2);
  });
});

describe("reconcileArtifactScratchTwin: internal branch coverage", () => {
  it("is unresolvable when the final re-read reports absent (ENOENT) rather than present", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const cleanBytes = capturePublishedArtifactBytes(homeDir, material);
    const { finalPath } = buildArtifactCrashTwin(homeDir, digest, cleanBytes);
    expect(() =>
      publishActivationArtifact(
        { homeDir, material },
        {
          readWithStat: (path: string, options: BoundedFileOptions) => {
            if (path === finalPath && options.requireSingleLink !== true) {
              const error = new Error("ENOENT") as NodeJS.ErrnoException;
              error.code = "ENOENT";
              throw error;
            }
            return readBoundedRegularFileWithStat(path, options);
          },
        },
      ),
    ).toThrow(ActivationArtifactPresenceUnresolvableError);
  });

  it("is unresolvable when the final re-read is unresolvable (EACCES) rather than present", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const cleanBytes = capturePublishedArtifactBytes(homeDir, material);
    const { finalPath } = buildArtifactCrashTwin(homeDir, digest, cleanBytes);
    const boom = Object.assign(new Error("permission denied for testing"), { code: "EACCES" });
    expect(() =>
      publishActivationArtifact(
        { homeDir, material },
        {
          readWithStat: (path: string, options: BoundedFileOptions) => {
            if (path === finalPath && options.requireSingleLink !== true) throw boom;
            return readBoundedRegularFileWithStat(path, options);
          },
        },
      ),
    ).toThrow(ActivationArtifactPresenceUnresolvableError);
  });

  it("is unresolvable when the final re-read is present but nlink is no longer exactly 2", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const directory = activationArtifactDirectory(homeDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const finalPath = activationArtifactPath(homeDir, digest);
    writeFileSync(finalPath, "unrelated multi-link content", { mode: 0o600 });
    linkSync(finalPath, join(directory, "foreign-second-link"));
    linkSync(finalPath, join(directory, "foreign-third-link"));
    expect(statSync(finalPath).nlink).toBe(3);
    expect(() => publishActivationArtifact({ homeDir, material })).toThrow(
      ActivationArtifactPresenceUnresolvableError,
    );
  });

  it("is unresolvable when readdirSync itself fails while scanning for a scratch twin", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const cleanBytes = capturePublishedArtifactBytes(homeDir, material);
    const { finalPath } = buildArtifactCrashTwin(homeDir, digest, cleanBytes);
    const directory = activationArtifactDirectory(homeDir);
    const realReaddirSync = (createRequire(import.meta.url)("node:fs") as { readdirSync: (p: string) => string[] }).readdirSync;
    expect(() =>
      withPatchedFs("readdirSync", ((path: string) => {
        if (path === directory) throw new Error("synthetic readdir failure");
        return realReaddirSync(path);
      }) as never, () => publishActivationArtifact({ homeDir, material })),
    ).toThrow(ActivationArtifactPresenceUnresolvableError);
    expect(statSync(finalPath).nlink).toBe(2);
  });

  it("is unresolvable when a name-matching candidate fails an integrity check while being read", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const directory = activationArtifactDirectory(homeDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const unrelatedPath = join(directory, "unrelated-hardlink-name");
    const finalPath = activationArtifactPath(homeDir, digest);
    writeFileSync(unrelatedPath, "not a writer scratch file", { mode: 0o600 });
    linkSync(unrelatedPath, finalPath);
    const looseName = "." + digest + ".material." + randomBytes(12).toString("hex") + ".tmp";
    writeFileSync(join(directory, looseName), "wrong mode", { mode: 0o644 });
    expect(() => publishActivationArtifact({ homeDir, material })).toThrow(
      ActivationArtifactPresenceUnresolvableError,
    );
  });

  it("is unresolvable when a name-matching candidate read is itself unresolvable", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const cleanBytes = capturePublishedArtifactBytes(homeDir, material);
    const { scratchPath } = buildArtifactCrashTwin(homeDir, digest, cleanBytes);
    const boom = Object.assign(new Error("permission denied for testing"), { code: "EACCES" });
    expect(() =>
      publishActivationArtifact(
        { homeDir, material },
        {
          readWithStat: (path: string, options: BoundedFileOptions) => {
            if (path === scratchPath && options.requireSingleLink !== true) throw boom;
            return readBoundedRegularFileWithStat(path, options);
          },
        },
      ),
    ).toThrow(ActivationArtifactPresenceUnresolvableError);
  });

  it("passes over a name-matching decoy with a separate inode and refuses with no genuine twin found", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const directory = activationArtifactDirectory(homeDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const unrelatedPath = join(directory, "unrelated-hardlink-name");
    const finalPath = activationArtifactPath(homeDir, digest);
    writeFileSync(unrelatedPath, "not a writer scratch file", { mode: 0o600 });
    linkSync(unrelatedPath, finalPath);
    const decoyName = "." + digest + ".material." + randomBytes(12).toString("hex") + ".tmp";
    const decoyPath = join(directory, decoyName);
    writeFileSync(decoyPath, "not the same content at all", { mode: 0o600 });
    expect(() => publishActivationArtifact({ homeDir, material })).toThrow(
      ActivationArtifactPresenceUnresolvableError,
    );
    expect(existsSync(decoyPath)).toBe(true);
  });

  it("passes over scratch-pattern-shaped non-candidates: a wrong suffix, an empty middle, a non-hex middle", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const directory = activationArtifactDirectory(homeDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const unrelatedPath = join(directory, "unrelated-hardlink-name");
    const finalPath = activationArtifactPath(homeDir, digest);
    writeFileSync(unrelatedPath, "not a writer scratch file", { mode: 0o600 });
    linkSync(unrelatedPath, finalPath);
    writeFileSync(join(directory, "." + digest + ".material.abc"), "wrong suffix", { mode: 0o600 });
    writeFileSync(join(directory, "." + digest + ".material..tmp"), "empty middle", { mode: 0o600 });
    writeFileSync(join(directory, "." + digest + ".material.ZZZ.tmp"), "non-hex middle", { mode: 0o600 });
    expect(() => publishActivationArtifact({ homeDir, material })).toThrow(
      ActivationArtifactPresenceUnresolvableError,
    );
  });

  it("is unresolvable when dependency-injected reads report more than one authenticated twin", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const directory = activationArtifactDirectory(homeDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const finalPath = activationArtifactPath(homeDir, digest);
    const scratchAName = "." + digest + ".material." + randomBytes(12).toString("hex") + ".tmp";
    const scratchBName = "." + digest + ".material." + randomBytes(12).toString("hex") + ".tmp";
    const scratchAPath = join(directory, scratchAName);
    const scratchBPath = join(directory, scratchBName);
    writeFileSync(finalPath, "on-disk content is irrelevant", { mode: 0o600 });
    writeFileSync(scratchAPath, "irrelevant", { mode: 0o600 });
    writeFileSync(scratchBPath, "irrelevant", { mode: 0o600 });
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
      publishActivationArtifact(
        { homeDir, material },
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
    ).toThrow(ActivationArtifactPresenceUnresolvableError);
  });

  it("completes the unlink when the twin is already gone by cleanup time and reuses", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const cleanBytes = capturePublishedArtifactBytes(homeDir, material);
    const { finalPath, scratchPath } = buildArtifactCrashTwin(homeDir, digest, cleanBytes);
    const result = publishActivationArtifact(
      { homeDir, material },
      {
        readWithStat: (path: string, options: BoundedFileOptions) => {
          const real = readBoundedRegularFileWithStat(path, options);
          if (path === scratchPath && options.requireSingleLink !== true) rmSync(scratchPath, { force: true });
          return real;
        },
      },
    );
    expect(result.outcome).toBe("reused");
    expect(existsSync(scratchPath)).toBe(false);
    expect(statSync(finalPath).nlink).toBe(1);
  });

  it("propagates a genuine, non-ENOENT twin lstat failure unchanged", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const cleanBytes = capturePublishedArtifactBytes(homeDir, material);
    const { scratchPath } = buildArtifactCrashTwin(homeDir, digest, cleanBytes);
    const boom = Object.assign(new Error("permission denied for testing"), { code: "EACCES" });
    const realLstatSync = (createRequire(import.meta.url)("node:fs") as { lstatSync: (p: string, o?: unknown) => unknown }).lstatSync;
    expect(() =>
      withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
        if (path === scratchPath) throw boom;
        return realLstatSync(path, options);
      }) as never, () => publishActivationArtifact({ homeDir, material })),
    ).toThrow(boom);
  });

  it("leaves a same-named, different-identity file alone and refuses as unresolvable", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const cleanBytes = capturePublishedArtifactBytes(homeDir, material);
    const { finalPath, scratchPath } = buildArtifactCrashTwin(homeDir, digest, cleanBytes);
    const decoyPath = scratchPath + ".decoy-swap";
    writeFileSync(decoyPath, "unrelated", { mode: 0o600 });
    const realLstatSync = (createRequire(import.meta.url)("node:fs") as { lstatSync: (p: string, o?: unknown) => unknown }).lstatSync;
    expect(() =>
      withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
        if (path === scratchPath) return realLstatSync(decoyPath, options);
        return realLstatSync(path, options);
      }) as never, () => publishActivationArtifact({ homeDir, material })),
    ).toThrow(ActivationArtifactPresenceUnresolvableError);
    expect(existsSync(scratchPath)).toBe(true);
    expect(existsSync(decoyPath)).toBe(true);
    expect(readFileSync(finalPath, "utf8")).toBe(cleanBytes);
    expect(statSync(finalPath).nlink).toBe(2);
  });

  it("swallows an ENOENT raised by the unlink call itself", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const cleanBytes = capturePublishedArtifactBytes(homeDir, material);
    const { finalPath, scratchPath } = buildArtifactCrashTwin(homeDir, digest, cleanBytes);
    const realUnlinkSync = (createRequire(import.meta.url)("node:fs") as { unlinkSync: (p: string) => void }).unlinkSync;
    const result = withPatchedFs("unlinkSync", ((path: string) => {
      if (path === scratchPath) rmSync(scratchPath, { force: true });
      return realUnlinkSync(path);
    }) as never, () => publishActivationArtifact({ homeDir, material }));
    expect(result.outcome).toBe("reused");
    expect(existsSync(scratchPath)).toBe(false);
    expect(statSync(finalPath).nlink).toBe(1);
  });

  it("propagates a genuine, non-ENOENT unlink failure unchanged", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const cleanBytes = capturePublishedArtifactBytes(homeDir, material);
    const { scratchPath } = buildArtifactCrashTwin(homeDir, digest, cleanBytes);
    const boom = Object.assign(new Error("permission denied for testing"), { code: "EACCES" });
    const realUnlinkSync = (createRequire(import.meta.url)("node:fs") as { unlinkSync: (p: string) => void }).unlinkSync;
    expect(() =>
      withPatchedFs("unlinkSync", ((path: string) => {
        if (path === scratchPath) throw boom;
        return realUnlinkSync(path);
      }) as never, () => publishActivationArtifact({ homeDir, material })),
    ).toThrow(boom);
  });

  it("treats a published file that vanishes before the post-unlink assertion as absent and writes fresh", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const cleanBytes = capturePublishedArtifactBytes(homeDir, material);
    const { finalPath, scratchPath } = buildArtifactCrashTwin(homeDir, digest, cleanBytes);
    const result = publishActivationArtifact(
      { homeDir, material },
      {
        readWithStat: (path: string, options: BoundedFileOptions) => {
          const real = readBoundedRegularFileWithStat(path, options);
          if (path === scratchPath && options.requireSingleLink !== true) {
            rmSync(finalPath, { force: true });
            rmSync(scratchPath, { force: true });
          }
          return real;
        },
      },
    );
    expect(result.outcome).toBe("written");
    expect(readFileSync(finalPath, "utf8")).toBe(cleanBytes);
    expect(statSync(finalPath).nlink).toBe(1);
  });

  it("propagates a genuine, non-ENOENT published-link-count lookup failure unchanged", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const cleanBytes = capturePublishedArtifactBytes(homeDir, material);
    const { finalPath } = buildArtifactCrashTwin(homeDir, digest, cleanBytes);
    const boom = Object.assign(new Error("permission denied for testing"), { code: "EACCES" });
    const realLstatSync = (createRequire(import.meta.url)("node:fs") as { lstatSync: (p: string, o?: unknown) => unknown }).lstatSync;
    expect(() =>
      withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
        if (path === finalPath) throw boom;
        return realLstatSync(path, options);
      }) as never, () => publishActivationArtifact({ homeDir, material })),
    ).toThrow(boom);
  });
});

describe("readActivationArtifact: failure attribution", () => {
  it("propagates an unrecognized read failure unchanged rather than attributing it", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const boom = new Error("unexpected failure with no fs error code");
    expect(() =>
      readActivationArtifact(
        { homeDir, identityDigest: computeActivationArtifactIdentityDigest(material) },
        { readWithStat: () => { throw boom; } },
      ),
    ).toThrow(boom);
  });
});

describe("ensureActivationArtifactDirectory: failure branches", () => {
  it("wraps a creation-path fsync failure as unsafe storage", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const boom = new Error("synthetic fsync failure");
    const realFsyncSync = (createRequire(import.meta.url)("node:fs") as { fsyncSync: (fd: number) => void }).fsyncSync;
    expect(() =>
      withPatchedFs("fsyncSync", ((fd: number) => {
        void realFsyncSync;
        throw boom;
      }) as never, () => publishActivationArtifact({ homeDir, material })),
    ).toThrow(ActivationArtifactUnsafeStorageError);
  });

  it("wraps a genuine, non-ENOENT existence-check lstat failure as unsafe storage with its cause", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const store = activationArtifactDirectory(homeDir);
    const boom = Object.assign(new Error("permission denied for testing"), { code: "EACCES" });
    const realLstatSync = (createRequire(import.meta.url)("node:fs") as { lstatSync: (p: string, o?: unknown) => unknown }).lstatSync;
    let caught: unknown;
    withPatchedFs("lstatSync", ((path: string, options?: unknown) => {
      if (path === store) throw boom;
      return realLstatSync(path, options);
    }) as never, () => {
      try {
        publishActivationArtifact({ homeDir, material });
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBeInstanceOf(ActivationArtifactUnsafeStorageError);
    expect((caught as ActivationArtifactUnsafeStorageError & { cause?: unknown }).cause).toBe(boom);
  });

  it("does not re-fsync the store directory or its parent root when both already exist", () => {
    const homeDir = home();
    publishActivationArtifact({ homeDir, material: buildMaterial(homeDir, "pub-1") });
    const root = join(homeDir, ".lcm");
    const store = activationArtifactDirectory(homeDir);
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
    }) as never, () => {
      // A different identity (different source bytes, hence a different
      // digest and a different file) in the same, already-existing store
      // directory: publicationId alone must never change the identity.
      publishActivationArtifact({
        homeDir,
        material: buildMaterial(homeDir, "pub-2", { sourceConfig: '{"backend":"sqlite-v2"}' }),
      });
    }));
    expect(fsyncedPaths.filter((path) => path === root).length).toBe(0);
    expect(fsyncedPaths.filter((path) => path === store).length).toBe(1);
  });
});

describe("reconcileArtifactScratchTwin: vanishing scan candidate", () => {
  it("continues past a name-matching candidate that vanishes (ENOENT) between being listed and being read", () => {
    const homeDir = home();
    const material = buildMaterial(homeDir, "pub-1");
    const digest = computeActivationArtifactIdentityDigest(material);
    const cleanBytes = capturePublishedArtifactBytes(homeDir, material);
    const { scratchPath } = buildArtifactCrashTwin(homeDir, digest, cleanBytes);
    expect(() =>
      publishActivationArtifact(
        { homeDir, material },
        {
          readWithStat: (path: string, options: BoundedFileOptions) => {
            if (path === scratchPath) {
              const error = new Error("ENOENT") as NodeJS.ErrnoException;
              error.code = "ENOENT";
              throw error;
            }
            return readBoundedRegularFileWithStat(path, options);
          },
        },
      ),
    ).toThrow(ActivationArtifactPresenceUnresolvableError);
  });
});
