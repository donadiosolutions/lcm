import { randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CanonicalRowDigest,
  MIGRATION_ARTIFACT_MAX_BYTES,
  MIGRATION_MANIFEST_TEST_SEAMS,
  MIGRATION_MANIFEST_VERSION,
  MIGRATION_PROTOCOL_CONTRACT,
  atomicWriteMigrationArtifact,
  canonicalJson,
  createMigrationGeneration,
  ensureMigrationProjectDirectory,
  fingerprintMigrationFile,
  fingerprintMigrationFileSync,
  generationRelativePath,
  listMigrationManifests,
  manifestSha256,
  migrationGenerationPaths,
  migrationProjectPaths,
  migrationsRoot,
  readMigrationArtifact,
  readMigrationManifest,
  readPublicationJournal,
  sameMigrationFingerprint,
  sha256Canonical,
  sha256Text,
  validateMigrationManifest,
  validatePublicationJournal,
  writeMigrationCheckpoint,
  writeMigrationManifest,
  writeMigrationReport,
  writePublicationJournal,
  type MigrationFileFingerprint,
  type MigrationManifest,
  type MigrationPublicationJournal,
} from "../../src/storage/migration-manifest.js";

const roots: string[] = [];
const generationId = "018f1234-5678-7abc-8def-0123456789ab";
const projectId = "a".repeat(64);
const remoteProjectId = "018f1234-5678-7abc-8def-0123456789ac";
const digest = "b".repeat(64);

function temporaryHome(): string {
  const root = mkdtempSync(join(tmpdir(), "lcm-migration-manifest-"));
  roots.push(root);
  return root;
}

function fileFingerprint(path = "/private/source.sqlite"): MigrationFileFingerprint {
  return { path, device: 1, inode: 2, size: 3, mtimeMs: 4, sha256: digest };
}

function manifest(overrides: Partial<MigrationManifest> = {}): MigrationManifest {
  const createdAt = "2026-08-01T12:00:00.000Z";
  return {
    version: MIGRATION_MANIFEST_VERSION,
    generationId,
    direction: "sqlite-to-postgresql",
    status: "planned",
    createdAt,
    updatedAt: createdAt,
    batchSize: 2,
    sampleSize: 1,
    coverage: {
      inventorySha256: digest,
      projectMapSha256: digest,
      inventory: [],
      activeLocalProjectIds: [projectId],
      representedLocalProjectIds: [projectId],
      orphanArtifacts: [],
      complete: true,
      checkedAt: createdAt,
    },
    sourceBackend: "sqlite",
    destinationBackend: "postgresql",
    schemaManifestSha256: digest,
    protocol: MIGRATION_PROTOCOL_CONTRACT,
    projects: [{
      identity: {
        localProjectId: projectId,
        canonicalPath: "/workspace/project",
        aliases: ["/workspace/project"],
        remoteProjectId,
      },
      status: "planned",
      sourceFingerprint: null,
      snapshot: null,
      quiescence: null,
      tables: [{ table: "conversations", copiedRows: 0, sourceRows: 0, sourceSha256: digest }],
      delivery: null,
      operationalEvidence: {
        payloadMinimized: true,
        originalMainArchive: null,
        originalWalArchive: null,
        nativeTranscriptSidecar: null,
        passiveEventSidecar: null,
        checkpointSidecar: null,
      },
    }],
    ...overrides,
  };
}

function journal(): MigrationPublicationJournal {
  return {
    version: MIGRATION_MANIFEST_VERSION,
    generationId,
    operation: "activate",
    phase: "prepare",
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    expectedBackend: "sqlite",
    targetBackend: "postgresql",
    expectedConfigSha256: digest,
    projects: [{
      generationId,
      localProjectId: projectId,
      remoteProjectId,
      sourceFingerprintSha256: digest,
      manifestSha256: digest,
      expectedCanonicalPath: "/workspace/project",
      expectedAliasesSha256: digest,
      published: false,
    }],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("migration manifest canonicalization", () => {
  it("canonicalizes every supported scalar, container, and temporal value", () => {
    expect(canonicalJson({ z: -0, a: [1n, true, null, new Date("2026-08-01T12:00:00Z")] })).toBe(
      '{"a":[{"$integer":"1"},true,null,"2026-08-01T12:00:00.000Z"],"z":0}',
    );
    expect(sha256Canonical({ b: 2, a: 1 })).toBe(sha256Text('{"a":1,"b":2}'));
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Date(Number.NaN),
    undefined,
    () => undefined,
    Symbol("unsupported"),
  ])("rejects unsupported canonical root value %#", (value) => {
    expect(() => canonicalJson(value)).toThrow(/canonical JSON rejects/u);
  });

  it("rejects unsupported object members and cycles while allowing repeated siblings", () => {
    for (const value of [{ bad: undefined }, { bad: () => undefined }, { bad: Symbol("bad") }]) {
      expect(() => canonicalJson(value)).toThrow("canonical JSON rejects unsupported value at bad");
    }
    const array: unknown[] = [];
    array.push(array);
    expect(() => canonicalJson(array)).toThrow("canonical JSON rejects cycles");
    const object: Record<string, unknown> = {};
    object.self = object;
    expect(() => canonicalJson(object)).toThrow("canonical JSON rejects cycles");
    const shared = { safe: true };
    expect(canonicalJson([shared, shared])).toBe('[{"safe":true},{"safe":true}]');
  });

  it("frames row digests and refuses reuse after completion", () => {
    const rows = new CanonicalRowDigest();
    rows.update({ value: "é" });
    rows.update({ value: 2 });
    const completed = rows.digest();
    expect(completed.rows).toBe(2);
    expect(completed.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => rows.update({ value: 3 })).toThrow("canonical row digest is already complete");
    expect(() => rows.digest()).toThrow("canonical row digest is already complete");
  });
});

describe("private migration artifacts", () => {
  it("creates deterministic private generation and project paths", () => {
    const home = temporaryHome();
    const paths = createMigrationGeneration(home, generationId);
    const project = ensureMigrationProjectDirectory(generationId, projectId, home);
    expect(paths).toEqual(migrationGenerationPaths(generationId, home));
    expect(project).toEqual(migrationProjectPaths(generationId, projectId, home));
    expect(migrationsRoot(home)).toContain(".lcm/migrations");
    expect(lstatSync(paths.root).mode & 0o777).toBe(0o700);
    expect(lstatSync(paths.directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(project.directory).mode & 0o777).toBe(0o700);
    expect(generationRelativePath(generationId, project.sourceSnapshot, home)).toBe(`projects/${projectId}/source.sqlite`);
    expect(() => migrationGenerationPaths("bad", home)).toThrow("invalid migration generation id");
    expect(() => migrationProjectPaths(generationId, "bad", home)).toThrow("invalid local project identity");
    expect(() => generationRelativePath(generationId, join(home, "outside"), home)).toThrow("outside the migration generation");
  });

  it("atomically writes, replaces, bounds, fingerprints, and reads private files", async () => {
    const home = temporaryHome();
    const paths = createMigrationGeneration(home, generationId);
    const path = join(paths.directory, "artifact.txt");
    atomicWriteMigrationArtifact(path, "first", paths.directory);
    expect(readMigrationArtifact(path, paths.directory)).toBe("first");
    atomicWriteMigrationArtifact(path, "second", paths.directory);
    expect(readFileSync(path, "utf8")).toBe("second");
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    const synchronous = fingerprintMigrationFileSync(path, paths.directory);
    await expect(fingerprintMigrationFile(path, paths.directory)).resolves.toEqual(synchronous);
    expect(sameMigrationFingerprint(synchronous, { ...synchronous })).toBe(true);
    expect(sameMigrationFingerprint(synchronous, { ...synchronous, size: synchronous.size + 1 })).toBe(false);
    expect(sameMigrationFingerprint(null, null)).toBe(true);
    expect(sameMigrationFingerprint(null, synchronous)).toBe(false);
    expect(sameMigrationFingerprint(synchronous, null)).toBe(false);
    expect(() => readMigrationArtifact(path, paths.directory, 5)).toThrow("exceeds the configured size limit");
    expect(() => readMigrationArtifact(path, paths.directory, -1)).toThrow("maxBytes must be non-negative");
    expect(() => readMigrationArtifact(path, paths.directory, 1.5)).toThrow("maxBytes must be non-negative");
    expect(() => atomicWriteMigrationArtifact(join(home, "outside"), "bad", paths.directory)).toThrow("outside the permitted root");
    expect(() => readMigrationArtifact(join(home, "outside"), paths.directory)).toThrow("outside the generation root");
    expect(() => fingerprintMigrationFileSync(path, join(paths.directory, "nested"))).toThrow("outside the permitted root");
  });

  it("detects every source identity change reported by a streaming fingerprint", () => {
    const identity = { dev: 1, ino: 2, size: 3, mtimeMs: 4 };
    expect(() => MIGRATION_MANIFEST_TEST_SEAMS.assertFingerprintStable(identity, identity, identity)).not.toThrow();
    for (const changed of [
      { ...identity, dev: 9 },
      { ...identity, ino: 9 },
      { ...identity, size: 9 },
      { ...identity, mtimeMs: 9 },
    ]) expect(() => MIGRATION_MANIFEST_TEST_SEAMS.assertFingerprintStable(identity, changed, identity)).toThrow("changed while hashing");
    expect(() => MIGRATION_MANIFEST_TEST_SEAMS.assertFingerprintStable(identity, identity, { ...identity, dev: 9 })).toThrow("changed while hashing");
    expect(() => MIGRATION_MANIFEST_TEST_SEAMS.assertFingerprintStable(identity, identity, { ...identity, ino: 9 })).toThrow("changed while hashing");
  });

  it("fails closed for unsafe links, modes, roots, and oversized files", () => {
    const home = temporaryHome();
    const paths = createMigrationGeneration(home, generationId);
    const source = join(paths.directory, "source");
    atomicWriteMigrationArtifact(source, "safe", paths.directory);
    const hardLink = join(paths.directory, "hard-link");
    linkSync(source, hardLink);
    expect(() => readMigrationArtifact(source, paths.directory)).toThrow("private single-link file");
    expect(() => fingerprintMigrationFileSync(source, paths.directory)).toThrow("regular single-link file");
    rmSync(hardLink);
    chmodSync(source, 0o644);
    expect(() => readMigrationArtifact(source, paths.directory)).toThrow("private single-link file");
    chmodSync(source, 0o600);
    const symlink = join(paths.directory, "symbolic");
    symlinkSync(source, symlink);
    expect(() => readMigrationArtifact(symlink, paths.directory)).toThrow();
    expect(() => fingerprintMigrationFileSync(symlink, paths.directory)).toThrow();
    const unsafeReplacement = join(paths.directory, "replacement");
    mkdirSync(unsafeReplacement, { mode: 0o700 });
    expect(() => atomicWriteMigrationArtifact(unsafeReplacement, "bad", paths.directory)).toThrow("refusing to replace an unsafe migration artifact");
    const oversized = join(paths.directory, "oversized");
    writeFileSync(oversized, Buffer.alloc(MIGRATION_ARTIFACT_MAX_BYTES + 1));
    chmodSync(oversized, 0o600);
    expect(() => readMigrationArtifact(oversized, paths.directory)).toThrow("exceeds the configured size limit");
  });
});

describe("versioned migration artifacts", () => {
  it("round-trips manifests, checkpoints, reports, journals, and listings", () => {
    const home = temporaryHome();
    createMigrationGeneration(home, generationId);
    const value = manifest();
    writeMigrationManifest(value, home);
    expect(readMigrationManifest(generationId, home)).toEqual(value);
    expect(manifestSha256(value)).toBe(sha256Canonical(value));
    const checkpoint = writeMigrationCheckpoint(value, home);
    expect(checkpoint).toMatchObject({ generationId, manifestSha256: manifestSha256(value) });
    writeMigrationReport({
      version: MIGRATION_MANIFEST_VERSION,
      generationId,
      generatedAt: value.updatedAt,
      status: value.status,
      ready: false,
      blockers: ["dry-run required"],
      projects: [],
    }, home);
    expect(readFileSync(migrationGenerationPaths(generationId, home).report, "utf8")).toContain("dry-run required");
    expect(readPublicationJournal(generationId, home)).toBeNull();
    writePublicationJournal(generationId, journal(), home);
    expect(readPublicationJournal(generationId, home)).toEqual(journal());
    expect(listMigrationManifests(home)).toEqual([value]);
    expect(listMigrationManifests(temporaryHome())).toEqual([]);
  });

  it("validates identity, state, metadata, coverage, project, source, and snapshot fields", () => {
    const good = manifest();
    expect(validateMigrationManifest(good)).toBe(good);
    const invalid: Array<[unknown, string]> = [
      [null, "invalid migration manifest identity"],
      [{ ...good, version: 2 }, "invalid migration manifest identity"],
      [{ ...good, generationId: "bad" }, "invalid migration manifest identity"],
      [{ ...good, direction: "postgresql-to-sqlite" }, "invalid migration manifest state"],
      [{ ...good, sourceBackend: "postgresql" }, "invalid migration manifest state"],
      [{ ...good, destinationBackend: "sqlite" }, "invalid migration manifest state"],
      [{ ...good, status: "unknown" }, "invalid migration manifest state"],
      [{ ...good, createdAt: "bad" }, "invalid migration manifest metadata"],
      [{ ...good, updatedAt: "bad" }, "invalid migration manifest metadata"],
      [{ ...good, batchSize: 0 }, "invalid migration manifest metadata"],
      [{ ...good, sampleSize: 0 }, "invalid migration manifest metadata"],
      [{ ...good, schemaManifestSha256: "bad" }, "invalid migration manifest metadata"],
      [{ ...good, coverage: null }, "invalid migration manifest coverage or protocol"],
      [{ ...good, projects: [] }, "invalid migration manifest coverage or protocol"],
      [{ ...good, protocol: null }, "invalid migration manifest coverage or protocol"],
      [{ ...good, protocol: { ...good.protocol, deterministicSampling: "unknown" } }, "invalid migration manifest coverage or protocol"],
      [{ ...good, projects: [null] }, "invalid migration project state"],
      [{ ...good, projects: [{ ...good.projects[0], identity: null }] }, "invalid migration project state"],
      [{ ...good, projects: [{ ...good.projects[0], identity: { ...good.projects[0]!.identity, localProjectId: "bad" } }] }, "invalid migration project state"],
      [{ ...good, projects: [{ ...good.projects[0], tables: null }] }, "invalid migration project state"],
      [{ ...good, projects: [{ ...good.projects[0], operationalEvidence: null }] }, "invalid migration project state"],
      [{ ...good, projects: [{ ...good.projects[0], sourceFingerprint: {} }] }, "invalid migration source fingerprint"],
      [{ ...good, projects: [{ ...good.projects[0], sourceFingerprint: { main: fileFingerprint(), wal: {}, schemaSha256: digest } }] }, "invalid migration source fingerprint"],
      [{ ...good, projects: [{ ...good.projects[0], snapshot: {} }] }, "invalid migration snapshot"],
    ];
    for (const [value, reason] of invalid) expect(() => validateMigrationManifest(value), reason).toThrow(reason);
    const withFiles = manifest({
      projects: [{
        ...good.projects[0]!,
        sourceFingerprint: { main: fileFingerprint(), wal: fileFingerprint("/private/source.sqlite-wal"), schemaSha256: digest },
        snapshot: { relativePath: "source.sqlite", file: fileFingerprint("/private/snapshot.sqlite"), schemaSha256: digest, logicalRows: 0, logicalSha256: digest, createdAt: good.createdAt },
      }],
    });
    expect(validateMigrationManifest(withFiles)).toBe(withFiles);
  });

  it("validates publication phases, immutable evidence, and operation-specific paths", () => {
    const good = journal();
    expect(validatePublicationJournal(good, generationId)).toBe(good);
    const invalid: unknown[] = [
      null,
      { ...good, version: 2 },
      { ...good, operation: "unknown" },
      { ...good, phase: "unknown" },
      { ...good, createdAt: "bad" },
      { ...good, expectedBackend: "postgresql" },
      { ...good, expectedConfigSha256: "bad" },
      { ...good, publishedConfigSha256: "bad" },
      { ...good, projects: [] },
      { ...good, projects: [null] },
      { ...good, projects: [good.projects[0], good.projects[0]] },
      { ...good, projects: [{ ...good.projects[0], published: true }] },
      { ...good, priorPublicationJournalSha256: digest },
    ];
    for (const value of invalid) expect(() => validatePublicationJournal(value, generationId)).toThrow("invalid publication journal");
    const reverse: MigrationPublicationJournal = {
      ...good,
      operation: "post-write-rollback",
      expectedBackend: "postgresql",
      targetBackend: "sqlite",
      priorPublicationJournalSha256: digest,
      projects: good.projects.map((project) => ({
        ...project,
        stagedSqlitePath: "/private/reverse.sqlite",
        archivedMainPath: "/private/db.sqlite.preserved",
        archivedWalPath: "/private/db.sqlite-wal.preserved",
      })),
    };
    expect(validatePublicationJournal(reverse, generationId)).toBe(reverse);
    expect(() => validatePublicationJournal({ ...reverse, priorPublicationJournalSha256: undefined }, generationId)).toThrow("invalid post-write rollback journal evidence");
    expect(() => validatePublicationJournal({ ...reverse, projects: reverse.projects.map(({ stagedSqlitePath: _ignored, ...project }) => project) }, generationId)).toThrow("invalid post-write rollback journal evidence");
  });

  it("rejects malformed persisted JSON, journals, reports, roots, and generation mismatches", () => {
    const home = temporaryHome();
    const paths = createMigrationGeneration(home, generationId);
    atomicWriteMigrationArtifact(paths.manifest, "not-json", paths.directory);
    expect(() => readMigrationManifest(generationId, home)).toThrow("migration artifact is not valid JSON");
    atomicWriteMigrationArtifact(paths.journal, `${canonicalJson({ version: 9, generationId, projects: [] })}\n`, paths.directory);
    expect(() => readPublicationJournal(generationId, home)).toThrow("invalid publication journal");
    expect(() => writePublicationJournal(randomUUID(), journal(), home)).toThrow("journal generation does not match");
    expect(() => writeMigrationReport({ ...({} as never), version: 9, generationId }, home)).toThrow("invalid migration report");
    expect(() => writeMigrationReport({ ...({} as never), version: MIGRATION_MANIFEST_VERSION, generationId: "bad" }, home)).toThrow("invalid migration report");
    rmSync(paths.root, { recursive: true });
    writeFileSync(paths.root, "unsafe");
    expect(() => listMigrationManifests(home)).toThrow("migration root must be a private directory");
    rmSync(paths.root);
    mkdirSync(paths.root, { mode: 0o755 });
    expect(() => listMigrationManifests(home)).toThrow("migration root must be a private directory");
  });
});
