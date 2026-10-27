import { afterEach, describe, expect, it } from "vitest";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MigrationActivationReportError,
  createMigrationActivationReport,
  migrationActivationReportDirectory,
  migrationActivationReportPath,
  migrationActivationReportReference,
  migrationActivationReportStoreDirectory,
  parseMigrationActivationReport,
  persistMigrationActivationReport,
  probeMigrationActivationReportPresence,
  readMigrationActivationReport,
  type CreateMigrationActivationReportInput,
  type MigrationActivationReport,
} from "../../src/migration/activation-report.js";
import {
  completeMigrationEffect,
  createMigrationManifest,
  migrationManifestCanonicalSha256,
  parseMigrationManifest,
  type MigrationManifest,
  type MigrationStorageWitness,
} from "../../src/migration/protocol.js";
import { PrivateFileCollisionError, readBoundedRegularFileWithStat } from "../../src/security-files.js";
import { canonicalJson, canonicalSha256, sha256 } from "../../src/storage/portable-record.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const STARTED_AT = "2026-10-16T12:00:04.000Z";
const GENERATION = "generation-1";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { chmodSync(root, 0o700); } catch { /* best-effort */ }
    try { chmodSync(join(root, ".lcm"), 0o700); } catch { /* best-effort */ }
    try { chmodSync(join(root, ".lcm", "migration-activation-reports"), 0o700); } catch { /* best-effort */ }
    try { chmodSync(migrationActivationReportDirectory(root, GENERATION), 0o700); } catch { /* best-effort */ }
    rmSync(root, { recursive: true, force: true });
  }
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-activation-report-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

function homeWithoutLcmRoot(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-activation-report-noroot-"));
  roots.push(value);
  return value;
}

function baseInput(overrides: Partial<CreateMigrationActivationReportInput> = {}): CreateMigrationActivationReportInput {
  return {
    generationId: GENERATION,
    epochId: HASH_A,
    attemptId: HASH_B,
    witnessChecksumSha256: HASH_C,
    publicationId: "pub-1",
    identityDigest: HASH_D,
    manifestRevisionAtComplete: 7,
    postPublicationProjectMapWitnessSha256: HASH_A,
    createdAt: STARTED_AT,
    ...overrides,
  };
}

/** Wire bytes built independently of the module, pinning the on-disk form. */
function wireBytes(report: MigrationActivationReport): string {
  return canonicalJson({
    version: report.version, reportId: report.reportId, body: report.body, reportSha256: report.reportSha256,
  }) + "\n";
}

function placeRaw(homeDir: string, generationId: string, reportSha256: string, content: string): string {
  mkdirSync(migrationActivationReportDirectory(homeDir, generationId), { recursive: true, mode: 0o700 });
  chmodSync(migrationActivationReportStoreDirectory(homeDir), 0o700);
  const path = migrationActivationReportPath(homeDir, generationId, reportSha256);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

describe("createMigrationActivationReport", () => {
  it("derives reportSha256 as the canonical sha256 of the body and reportId from it", () => {
    const report = createMigrationActivationReport(baseInput());
    expect(report.version).toBe(1);
    expect(report.body).toEqual({ version: 1, kind: "activation", ...baseInput() });
    expect(report.reportSha256).toBe(canonicalSha256(report.body));
    expect(report.reportId).toBe("publish-activation-" + report.reportSha256);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.body)).toBe(true);
  });

  it("is deterministic for identical input and changes identity for any field difference", () => {
    const first = createMigrationActivationReport(baseInput());
    expect(createMigrationActivationReport(baseInput())).toEqual(first);
    for (const overrides of [
      { epochId: HASH_B },
      { manifestRevisionAtComplete: 8 },
      { createdAt: "2026-10-16T12:00:05.000Z" },
    ] as const) {
      expect(createMigrationActivationReport(baseInput(overrides)).reportSha256).not.toBe(first.reportSha256);
    }
  });

  it("is a pure function of durable state: the body carries no restart verdict (plan-v7 A7 / S-1)", () => {
    const report = createMigrationActivationReport(baseInput());
    expect(Object.keys(report.body).sort()).toEqual([
      "attemptId", "createdAt", "epochId", "generationId", "identityDigest", "kind", "manifestRevisionAtComplete",
      "postPublicationProjectMapWitnessSha256", "publicationId", "version", "witnessChecksumSha256",
    ]);
    expect(() => createMigrationActivationReport({
      ...baseInput(), restart: { status: "satisfied", reason: "no-pid-file" },
    } as unknown as CreateMigrationActivationReportInput)).toThrow(
      expect.objectContaining({ name: "MigrationActivationReportError", reason: "invalid-input" }),
    );
  });

  it.each([
    ["non-record input", null],
    ["extra field", { ...baseInput(), extra: true }],
    ["caller-supplied version", { ...baseInput(), version: 1 }],
    ["invalid generationId", baseInput({ generationId: "-bad" })],
    ["invalid epochId", baseInput({ epochId: "" })],
    ["invalid attemptId", baseInput({ attemptId: "a b" })],
    ["invalid witnessChecksumSha256", baseInput({ witnessChecksumSha256: "A".repeat(64) })],
    ["invalid publicationId", baseInput({ publicationId: "bad/id" })],
    ["invalid identityDigest", baseInput({ identityDigest: "abc" })],
    ["negative manifestRevisionAtComplete", baseInput({ manifestRevisionAtComplete: -1 })],
    ["fractional manifestRevisionAtComplete", baseInput({ manifestRevisionAtComplete: 1.5 })],
    ["invalid postPublicationProjectMapWitnessSha256", baseInput({ postPublicationProjectMapWitnessSha256: "" })],
    ["non-ISO createdAt", baseInput({ createdAt: "2026-10-16" })],
    ["non-canonical ISO createdAt", baseInput({ createdAt: "2026-10-16T12:00:04Z" })],
  ])("rejects %s as invalid-input", (_name, input) => {
    expect(() => createMigrationActivationReport(input as unknown as CreateMigrationActivationReportInput)).toThrow(
      expect.objectContaining({ name: "MigrationActivationReportError", reason: "invalid-input" }),
    );
  });
});

describe("parseMigrationActivationReport", () => {
  it("round-trips a created report through JSON", () => {
    const report = createMigrationActivationReport(baseInput());
    expect(parseMigrationActivationReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });

  it.each([
    ["non-record", null],
    ["extra key", (r: MigrationActivationReport) => ({ ...r, extra: 1 })],
    ["unsupported version", (r: MigrationActivationReport) => ({ ...r, version: 2 })],
    ["non-record body", (r: MigrationActivationReport) => ({ ...r, body: "activation" })],
    ["body with an extra key", (r: MigrationActivationReport) => ({ ...r, body: { ...r.body, extra: 1 } })],
    ["invalid body", (r: MigrationActivationReport) => ({ ...r, body: { ...r.body, epochId: "" } })],
    ["body of another kind", (r: MigrationActivationReport) => ({ ...r, body: { ...r.body, kind: "rollback" } })],
    ["checksum not matching body", (r: MigrationActivationReport) => ({ ...r, body: { ...r.body, manifestRevisionAtComplete: 8 } })],
    ["reportId not derived from checksum", (r: MigrationActivationReport) => ({ ...r, reportId: "verify-generation-" + r.reportSha256 })],
  ])("rejects %s as malformed-record", (_name, mutate) => {
    const report = createMigrationActivationReport(baseInput());
    const value = typeof mutate === "function" ? mutate(report) : mutate;
    expect(() => parseMigrationActivationReport(value)).toThrow(
      expect.objectContaining({ name: "MigrationActivationReportError", reason: "malformed-record" }),
    );
  });
});

function witness(backend: MigrationStorageWitness["backend"], capturedAt: string): MigrationStorageWitness {
  return { version: 1, backend, identitySha256: HASH_A, schemaSha256: HASH_B, contentSha256: HASH_C, capturedAt };
}

/** A manifest at "activating" with a pending publish-activation effect
 * whose startedAt is the report's createdAt, built exactly as
 * protocol.test.ts builds its own pending-effect fixtures. */
function activatingManifest(): MigrationManifest {
  const genesis = createMigrationManifest({
    generationId: GENERATION,
    source: witness("sqlite", "2026-10-16T12:00:00.000Z"),
    destination: witness("postgresql", "2026-10-16T12:00:01.000Z"),
    parentGenerationId: null,
    preservedSourceGenerationId: "source-generation-1",
    createdAt: "2026-10-16T12:00:00.000Z",
  });
  const { checksumSha256: _checksum, ...payload } = {
    ...genesis,
    revision: 6,
    previousManifestSha256: HASH_A,
    phase: "activating",
    reports: [{ kind: "verification", reportId: "verify-generation-" + HASH_B, reportSha256: HASH_B, createdAt: "2026-10-16T12:00:02.000Z" }],
    activationEligible: true,
    rollbackLineage: { parentGenerationId: null, preservedSourceGenerationId: "source-generation-1", mode: null, returnPhase: null },
    pendingEffect: {
      effectId: "publish-activation-1",
      kind: "publish-activation",
      fromPhase: "activating",
      targetPhase: "active",
      inputSha256: HASH_A,
      recovery: "authoritative-readback-required",
      startedAt: STARTED_AT,
    },
    updatedAt: "2026-10-16T12:00:03.000Z",
  } as unknown as MigrationManifest & Record<string, unknown>;
  return parseMigrationManifest({ ...payload, checksumSha256: migrationManifestCanonicalSha256(payload) });
}

describe("migrationActivationReportReference", () => {
  it("is accepted verbatim by the real completeMigrationEffect for a pending publish-activation effect, reaching active", () => {
    const report = createMigrationActivationReport(baseInput());
    const reference = migrationActivationReportReference(report);
    expect(reference).toEqual({
      kind: "activation", reportId: report.reportId, reportSha256: report.reportSha256, createdAt: STARTED_AT,
    });
    const active = completeMigrationEffect(activatingManifest(), {
      effectId: "publish-activation-1",
      completedAt: "2026-10-16T12:00:09.000Z",
      report: reference,
    });
    expect(active.phase).toBe("active");
    expect(active.pendingEffect).toBeNull();
    expect(active.reports).toContainEqual(reference);
  });

  it("re-parses the report rather than trusting it (a tampered report is refused)", () => {
    const report = createMigrationActivationReport(baseInput());
    expect(() => migrationActivationReportReference({ ...report, reportSha256: HASH_D })).toThrow(MigrationActivationReportError);
  });
});

describe("persistMigrationActivationReport", () => {
  it("publishes under <home>/.lcm/migration-activation-reports/<sha256(generationId)>/<reportSha256>.json with private modes", () => {
    const homeDir = home();
    const report = createMigrationActivationReport(baseInput());
    const result = persistMigrationActivationReport({ homeDir, generationId: GENERATION, report });
    expect(result.outcome).toBe("published");
    expect(result.report).toEqual(report);
    expect(result.path).toBe(join(homeDir, ".lcm", "migration-activation-reports", sha256(GENERATION), report.reportSha256 + ".json"));
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(statSync(migrationActivationReportStoreDirectory(homeDir)).mode & 0o777).toBe(0o700);
    expect(statSync(migrationActivationReportDirectory(homeDir, GENERATION)).mode & 0o777).toBe(0o700);
    expect(readFileSync(result.path, "utf8")).toBe(wireBytes(report));
  });

  it("reuses an existing byte-identical report (idempotent S16 retry) and never rewrites it", () => {
    const homeDir = home();
    const report = createMigrationActivationReport(baseInput());
    const first = persistMigrationActivationReport({ homeDir, generationId: GENERATION, report });
    const before = statSync(first.path, { bigint: true });
    const retry = persistMigrationActivationReport({ homeDir, generationId: GENERATION, report });
    expect(retry.outcome).toBe("reused");
    expect(retry.path).toBe(first.path);
    const after = statSync(first.path, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });

  it("stores two different reports for one generation side by side (content-addressed, never keyed by generation)", () => {
    const homeDir = home();
    const a = persistMigrationActivationReport({ homeDir, generationId: GENERATION, report: createMigrationActivationReport(baseInput()) });
    const b = persistMigrationActivationReport({
      homeDir, generationId: GENERATION, report: createMigrationActivationReport(baseInput({ manifestRevisionAtComplete: 8 })),
    });
    expect(a.outcome).toBe("published");
    expect(b.outcome).toBe("published");
    expect(a.path).not.toBe(b.path);
    expect(existsSync(a.path) && existsSync(b.path)).toBe(true);
  });

  it("refuses with identity-conflict when different bytes already occupy the identity path, leaving them untouched", () => {
    const homeDir = home();
    const report = createMigrationActivationReport(baseInput());
    const path = placeRaw(homeDir, GENERATION, report.reportSha256, "{\"forged\":true}\n");
    expect(() => persistMigrationActivationReport({ homeDir, generationId: GENERATION, report })).toThrow(
      expect.objectContaining({ name: "MigrationActivationReportError", reason: "identity-conflict" }),
    );
    expect(readFileSync(path, "utf8")).toBe("{\"forged\":true}\n");
  });

  it("refuses a report whose body names another generation than the path it would be filed under", () => {
    const homeDir = home();
    const report = createMigrationActivationReport(baseInput({ generationId: "generation-2" }));
    expect(() => persistMigrationActivationReport({ homeDir, generationId: GENERATION, report })).toThrow(
      expect.objectContaining({ name: "MigrationActivationReportError", reason: "invalid-input" }),
    );
    expect(existsSync(migrationActivationReportStoreDirectory(homeDir))).toBe(false);
  });

  it.each([
    ["non-record input", null],
    ["missing homeDir", { generationId: GENERATION }],
    ["empty homeDir", { homeDir: "", generationId: GENERATION }],
    ["invalid generationId", { homeDir: "/tmp", generationId: "-bad" }],
  ])("rejects %s as invalid-input before any I/O", (_name, input) => {
    const report = createMigrationActivationReport(baseInput());
    expect(() => persistMigrationActivationReport(
      (input === null ? null : { ...input, report }) as unknown as Parameters<typeof persistMigrationActivationReport>[0],
    )).toThrow(expect.objectContaining({ name: "MigrationActivationReportError", reason: "invalid-input" }));
  });

  it("re-parses the report strictly (malformed-record) before touching storage", () => {
    const homeDir = home();
    const report = createMigrationActivationReport(baseInput());
    expect(() => persistMigrationActivationReport({ homeDir, generationId: GENERATION, report: { ...report, reportId: "x" } })).toThrow(
      expect.objectContaining({ name: "MigrationActivationReportError", reason: "malformed-record" }),
    );
    expect(existsSync(migrationActivationReportStoreDirectory(homeDir))).toBe(false);
  });

  it("fails closed (unsafe-storage) when the private LCM root does not exist", () => {
    const report = createMigrationActivationReport(baseInput());
    expect(() => persistMigrationActivationReport({ homeDir: homeWithoutLcmRoot(), generationId: GENERATION, report })).toThrow(
      expect.objectContaining({ name: "MigrationActivationReportError", reason: "unsafe-storage" }),
    );
  });

  it("fails closed (unsafe-storage) when a regular file occupies the store directory path", () => {
    const homeDir = home();
    writeFileSync(migrationActivationReportStoreDirectory(homeDir), "not a directory", { mode: 0o600 });
    const report = createMigrationActivationReport(baseInput());
    expect(() => persistMigrationActivationReport({ homeDir, generationId: GENERATION, report })).toThrow(
      expect.objectContaining({ name: "MigrationActivationReportError", reason: "unsafe-storage" }),
    );
  });

  it("fails closed (unsafe-storage) when a regular file occupies the per-generation directory path", () => {
    const homeDir = home();
    mkdirSync(migrationActivationReportStoreDirectory(homeDir), { mode: 0o700 });
    writeFileSync(migrationActivationReportDirectory(homeDir, GENERATION), "not a directory", { mode: 0o600 });
    const report = createMigrationActivationReport(baseInput());
    expect(() => persistMigrationActivationReport({ homeDir, generationId: GENERATION, report })).toThrow(
      expect.objectContaining({ name: "MigrationActivationReportError", reason: "unsafe-storage" }),
    );
  });

  it("propagates an unrecognized directory-presence failure raw rather than treating it as absent", () => {
    const homeDir = home();
    const report = createMigrationActivationReport(baseInput());
    const generationDirectory = migrationActivationReportDirectory(homeDir, GENERATION);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const original = nodeFs.lstatSync as typeof import("node:fs").lstatSync;
    nodeFs.lstatSync = ((path: Parameters<typeof original>[0], ...rest: unknown[]) => {
      if (path === generationDirectory) {
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      }
      return (original as unknown as (...args: unknown[]) => unknown)(path, ...rest);
    }) as unknown;
    syncBuiltinESMExports();
    try {
      expect(() => persistMigrationActivationReport({ homeDir, generationId: GENERATION, report })).toThrow(
        expect.objectContaining({ name: "MigrationActivationReportError", reason: "unsafe-storage", cause: expect.objectContaining({ code: "EIO" }) }),
      );
    } finally {
      nodeFs.lstatSync = original;
      syncBuiltinESMExports();
    }
  });

  it("is unresolvable (throws), not a fresh write, when the existing report's permission is genuinely denied", () => {
    const homeDir = home();
    const report = createMigrationActivationReport(baseInput());
    const first = persistMigrationActivationReport({ homeDir, generationId: GENERATION, report });
    chmodSync(first.path, 0o000);
    try {
      expect(() => persistMigrationActivationReport({ homeDir, generationId: GENERATION, report })).toThrow(
        expect.objectContaining({ name: "MigrationActivationReportError", reason: "unresolvable" }),
      );
    } finally {
      chmodSync(first.path, 0o600);
    }
  });

  it("tolerates an extra hard link to the immutable content (the writer's failed scratch cleanup) and still reuses", () => {
    const homeDir = home();
    const report = createMigrationActivationReport(baseInput());
    const first = persistMigrationActivationReport({ homeDir, generationId: GENERATION, report });
    linkSync(first.path, first.path + ".leftover");
    expect(statSync(first.path).nlink).toBe(2);
    expect(persistMigrationActivationReport({ homeDir, generationId: GENERATION, report }).outcome).toBe("reused");
    expect(readMigrationActivationReport({ homeDir, generationId: GENERATION, reportSha256: report.reportSha256 })).toMatchObject({
      state: "resolved", report,
    });
  });

  describe("with an injected durable-write collision (a true concurrent race cannot be reproduced deterministically)", () => {
    it("reconciles as reused when a concurrent writer published identical bytes between the presence check and the write", () => {
      const homeDir = home();
      const report = createMigrationActivationReport(baseInput());
      const path = migrationActivationReportPath(homeDir, GENERATION, report.reportSha256);
      const writeDurable = (): void => {
        writeFileSync(path, wireBytes(report), { mode: 0o600 });
        throw new PrivateFileCollisionError("destination already exists");
      };
      const result = persistMigrationActivationReport({ homeDir, generationId: GENERATION, report }, {
        writeDurable: writeDurable as unknown as NonNullable<Parameters<typeof persistMigrationActivationReport>[1]>["writeDurable"],
      });
      expect(result.outcome).toBe("reused");
    });

    it("re-throws the original collision when it inexplicably vanishes on retry", () => {
      const homeDir = home();
      const report = createMigrationActivationReport(baseInput());
      const writeDurable = (): void => { throw new PrivateFileCollisionError("destination already exists"); };
      expect(() => persistMigrationActivationReport({ homeDir, generationId: GENERATION, report }, {
        writeDurable: writeDurable as unknown as NonNullable<Parameters<typeof persistMigrationActivationReport>[1]>["writeDurable"],
      })).toThrow(PrivateFileCollisionError);
    });

    it("propagates an unrecognized durable-write failure unchanged", () => {
      const homeDir = home();
      const report = createMigrationActivationReport(baseInput());
      const writeDurable = (): void => { throw new Error("disk on fire"); };
      expect(() => persistMigrationActivationReport({ homeDir, generationId: GENERATION, report }, {
        writeDurable: writeDurable as unknown as NonNullable<Parameters<typeof persistMigrationActivationReport>[1]>["writeDurable"],
      })).toThrow("disk on fire");
    });
  });
});

describe("readMigrationActivationReport: three-valued", () => {
  function persisted(homeDir: string, overrides: Partial<CreateMigrationActivationReportInput> = {}) {
    const report = createMigrationActivationReport(baseInput(overrides));
    const result = persistMigrationActivationReport({ homeDir, generationId: report.body.generationId, report });
    return { report, path: result.path };
  }

  it("resolves a persisted report exactly", () => {
    const homeDir = home();
    const { report, path } = persisted(homeDir);
    expect(readMigrationActivationReport({ homeDir, generationId: GENERATION, reportSha256: report.reportSha256 })).toEqual({
      state: "resolved", report, path,
    });
  });

  it.each([
    ["the private LCM root", (homeDir: string) => { rmSync(join(homeDir, ".lcm"), { recursive: true }); }],
    ["the store directory", () => { /* never created */ }],
    ["the per-generation directory", (homeDir: string) => { persisted(homeDir, { generationId: "generation-2" }); }],
    ["the report file", (homeDir: string) => { persisted(homeDir, { manifestRevisionAtComplete: 99 }); }],
  ])("is authoritatively absent when %s does not exist", (_name, arrange) => {
    const homeDir = home();
    arrange(homeDir);
    const result = readMigrationActivationReport({ homeDir, generationId: GENERATION, reportSha256: HASH_A });
    expect(result).toMatchObject({ state: "authoritatively-absent" });
    expect((result as { detail: string }).detail).toContain("does not exist");
  });

  it("is unresolvable (root-unauthenticated), never absent, when the root exists with an untrusted mode", () => {
    const homeDir = home();
    const { report } = persisted(homeDir);
    chmodSync(join(homeDir, ".lcm"), 0o755);
    expect(readMigrationActivationReport({ homeDir, generationId: GENERATION, reportSha256: report.reportSha256 })).toMatchObject({
      state: "unresolvable", reason: "root-unauthenticated",
    });
  });

  it.each([
    ["store", (homeDir: string) => migrationActivationReportStoreDirectory(homeDir)],
    ["per-generation", (homeDir: string) => migrationActivationReportDirectory(homeDir, GENERATION)],
  ])("is unresolvable (directory-unauthenticated), never absent, when the %s directory has an untrusted mode", (_name, pick) => {
    const homeDir = home();
    const { report } = persisted(homeDir);
    chmodSync(pick(homeDir), 0o755);
    expect(readMigrationActivationReport({ homeDir, generationId: GENERATION, reportSha256: report.reportSha256 })).toMatchObject({
      state: "unresolvable", reason: "directory-unauthenticated",
    });
  });

  it("is unresolvable (read-unresolvable), never absent, when the report's permission is genuinely denied", () => {
    const homeDir = home();
    const { report, path } = persisted(homeDir);
    chmodSync(path, 0o000);
    try {
      expect(readMigrationActivationReport({ homeDir, generationId: GENERATION, reportSha256: report.reportSha256 })).toMatchObject({
        state: "unresolvable", reason: "read-unresolvable",
      });
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it.each([
    ["not JSON", () => "{nope\n"],
    ["a non-report JSON value", () => "[]\n"],
    ["a report whose checksum does not match its body", (r: MigrationActivationReport) =>
      wireBytes({ ...r, body: { ...r.body, manifestRevisionAtComplete: 8 } })],
    ["non-canonical bytes of a valid report (pretty-printed)", (r: MigrationActivationReport) => JSON.stringify(r, null, 2) + "\n"],
    ["a valid report missing its trailing newline", (r: MigrationActivationReport) => wireBytes(r).slice(0, -1)],
  ])("is unresolvable (malformed-record), never resolved, for stored bytes that are %s", (_name, bytes) => {
    const homeDir = home();
    const report = createMigrationActivationReport(baseInput());
    placeRaw(homeDir, GENERATION, report.reportSha256, bytes(report));
    expect(readMigrationActivationReport({ homeDir, generationId: GENERATION, reportSha256: report.reportSha256 })).toMatchObject({
      state: "unresolvable", reason: "malformed-record",
    });
  });

  it("is unresolvable (identity-mismatch) when a valid report sits under a filename that is not its own checksum", () => {
    const homeDir = home();
    const report = createMigrationActivationReport(baseInput());
    placeRaw(homeDir, GENERATION, HASH_D, wireBytes(report));
    const result = readMigrationActivationReport({ homeDir, generationId: GENERATION, reportSha256: HASH_D });
    expect(result).toMatchObject({ state: "unresolvable", reason: "identity-mismatch" });
    expect((result as { detail: string }).detail).toContain("filename");
  });

  it("is unresolvable (identity-mismatch) when a valid report under this generation's directory names another generation", () => {
    const homeDir = home();
    const report = createMigrationActivationReport(baseInput({ generationId: "generation-2" }));
    placeRaw(homeDir, GENERATION, report.reportSha256, wireBytes(report));
    const result = readMigrationActivationReport({ homeDir, generationId: GENERATION, reportSha256: report.reportSha256 });
    expect(result).toMatchObject({ state: "unresolvable", reason: "identity-mismatch" });
    expect((result as { detail: string }).detail).toContain("generation-2");
  });

  it("is unresolvable (directory-changed) when a directory stops authenticating during the read", () => {
    const homeDir = home();
    const { report } = persisted(homeDir);
    const directory = migrationActivationReportDirectory(homeDir, GENERATION);
    const readWithStat: typeof readBoundedRegularFileWithStat = (path, options) => {
      const value = readBoundedRegularFileWithStat(path, options);
      chmodSync(directory, 0o755);
      return value;
    };
    expect(readMigrationActivationReport(
      { homeDir, generationId: GENERATION, reportSha256: report.reportSha256 }, { readWithStat },
    )).toMatchObject({ state: "unresolvable", reason: "directory-changed" });
  });

  it("propagates an unrecognized read failure raw rather than attributing it", () => {
    const homeDir = home();
    const { report } = persisted(homeDir);
    const readWithStat: typeof readBoundedRegularFileWithStat = () => { throw new Error("disk on fire"); };
    expect(() => readMigrationActivationReport(
      { homeDir, generationId: GENERATION, reportSha256: report.reportSha256 }, { readWithStat },
    )).toThrow("disk on fire");
  });

  it.each([
    ["non-record input", null],
    ["invalid homeDir", { homeDir: 7, generationId: GENERATION, reportSha256: HASH_A }],
    ["invalid generationId", { homeDir: "/tmp", generationId: "-bad", reportSha256: HASH_A }],
    ["invalid reportSha256", { homeDir: "/tmp", generationId: GENERATION, reportSha256: "abc" }],
  ])("rejects %s as invalid-input before any I/O", (_name, input) => {
    expect(() => readMigrationActivationReport(input as unknown as Parameters<typeof readMigrationActivationReport>[0])).toThrow(
      expect.objectContaining({ name: "MigrationActivationReportError", reason: "invalid-input" }),
    );
  });
});


describe("currentUid fallback", () => {
  it("still persists and reads back successfully when process.getuid is unavailable", () => {
    const homeDir = home();
    const report = createMigrationActivationReport(baseInput());
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      const result = persistMigrationActivationReport({ homeDir, generationId: GENERATION, report });
      expect(result.outcome).toBe("published");
      expect(readMigrationActivationReport({ homeDir, generationId: GENERATION, reportSha256: report.reportSha256 })).toMatchObject({
        state: "resolved",
      });
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });
});

describe("probeMigrationActivationReportPresence: three-valued (#1549 F1)", () => {
  function persisted(homeDir: string, overrides: Partial<CreateMigrationActivationReportInput> = {}) {
    const report = createMigrationActivationReport(baseInput(overrides));
    persistMigrationActivationReport({ homeDir, generationId: report.body.generationId, report });
    return report;
  }

  it("is present once the per-generation directory exists, whatever report it holds", () => {
    const homeDir = home();
    persisted(homeDir);
    expect(probeMigrationActivationReportPresence({ homeDir, generationId: GENERATION })).toMatchObject({ state: "present", detail: expect.stringContaining(migrationActivationReportDirectory(homeDir, GENERATION)) });
    // An empty per-generation directory is still present: absence of every report is never inferred from a listing.
    rmSync(migrationActivationReportPath(homeDir, GENERATION, persisted(homeDir, { manifestRevisionAtComplete: 2 }).reportSha256));
    expect(probeMigrationActivationReportPresence({ homeDir, generationId: GENERATION })).toMatchObject({ state: "present" });
  });

  it.each([
    ["the private LCM root", (homeDir: string) => { rmSync(join(homeDir, ".lcm"), { recursive: true }); }],
    ["the store directory", () => { /* never created */ }],
    ["the per-generation directory", (homeDir: string) => { persisted(homeDir, { generationId: "generation-2" }); }],
  ])("is authoritatively absent when %s does not exist", (_name, arrange) => {
    const homeDir = home();
    arrange(homeDir);
    expect(probeMigrationActivationReportPresence({ homeDir, generationId: GENERATION })).toMatchObject({ state: "authoritatively-absent", detail: expect.stringContaining("does not exist") });
  });

  it("is unresolvable (root-unauthenticated), never absent, when the root exists with an untrusted mode", () => {
    const homeDir = home();
    persisted(homeDir);
    chmodSync(join(homeDir, ".lcm"), 0o755);
    expect(probeMigrationActivationReportPresence({ homeDir, generationId: GENERATION })).toMatchObject({ state: "unresolvable", reason: "root-unauthenticated" });
  });

  it.each([
    ["store", (homeDir: string) => migrationActivationReportStoreDirectory(homeDir)],
    ["per-generation", (homeDir: string) => migrationActivationReportDirectory(homeDir, GENERATION)],
  ])("is unresolvable (directory-unauthenticated), never absent, when the %s directory has an untrusted mode", (_name, pick) => {
    const homeDir = home();
    persisted(homeDir);
    chmodSync(pick(homeDir), 0o755);
    expect(probeMigrationActivationReportPresence({ homeDir, generationId: GENERATION })).toMatchObject({ state: "unresolvable", reason: "directory-unauthenticated" });
  });

  it("validates its input before any I/O and falls back when process.getuid is unavailable", () => {
    expect(() => probeMigrationActivationReportPresence(null as never)).toThrow(MigrationActivationReportError);
    expect(() => probeMigrationActivationReportPresence({ homeDir: home(), generationId: "../x" })).toThrow(MigrationActivationReportError);
    const homeDir = home();
    persisted(homeDir);
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      expect(probeMigrationActivationReportPresence({ homeDir, generationId: GENERATION })).toMatchObject({ state: "present" });
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("is unresolvable (directory-changed), never absent, when an authenticated ancestor is replaced before the next level is looked up (#1660)", () => {
    const homeDir = home();
    persisted(homeDir);
    const store = migrationActivationReportStoreDirectory(homeDir);
    const generationDirectory = migrationActivationReportDirectory(homeDir, GENERATION);
    mkdirSync(store + ".empty", { mode: 0o700 });
    const swapStore = () => { renameSync(store, store + ".swapped"); renameSync(store + ".empty", store); renameSync(store + ".swapped", store + ".empty"); };
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const realFs = nodeFs as unknown as typeof import("node:fs");
    const originalOpen = realFs.openSync;
    const originalStat = realFs.statSync;
    const canonicalLeaf = realFs.realpathSync(generationDirectory);
    // Before the leaf is looked up: the store directory authenticated one level up is swapped for an empty sibling.
    nodeFs.openSync = ((path: Parameters<typeof originalOpen>[0], ...rest: unknown[]) => {
      if (path === generationDirectory) swapStore();
      return (originalOpen as unknown as (...args: unknown[]) => number)(path, ...rest);
    }) as unknown;
    syncBuiltinESMExports();
    try {
      expect(probeMigrationActivationReportPresence({ homeDir, generationId: GENERATION }))
        .toMatchObject({ state: "unresolvable", reason: "directory-changed" });
    } finally {
      nodeFs.openSync = originalOpen;
      syncBuiltinESMExports();
    }
    swapStore();
    // After the leaf authenticated (its pathname stat is the last step): the same swap is caught by the re-assertion, never "present".
    nodeFs.statSync = ((path: Parameters<typeof originalStat>[0], ...rest: unknown[]) => {
      const value = (originalStat as unknown as (...args: unknown[]) => unknown)(path, ...rest);
      if (path === canonicalLeaf) swapStore();
      return value;
    }) as unknown;
    syncBuiltinESMExports();
    try {
      expect(probeMigrationActivationReportPresence({ homeDir, generationId: GENERATION }))
        .toMatchObject({ state: "unresolvable", reason: "directory-changed" });
    } finally {
      nodeFs.statSync = originalStat;
      syncBuiltinESMExports();
    }
  });
});
