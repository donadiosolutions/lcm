import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PORTABLE_RECORD_DOMAIN_ORDER, type PortableDomain } from "../../src/storage/portable-record.js";
import { migrationWitnessSha256 } from "../../src/migration/activation-witness.js";
import {
  createMigrationVerificationReport,
  MIGRATION_MISMATCH_CLASSES,
  MIGRATION_PUBLIC_PROBE_ORDER,
  MigrationVerificationReportError,
  type CreateMigrationVerificationReportInput,
} from "../../src/migration/verification-report.js";
import {
  MigrationVerificationReportStore,
  MigrationVerificationStoreError,
  migrationVerificationReportFilename,
  parseMigrationVerificationReportFilename,
} from "../../src/migration/verification-store.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function domainVector<T>(build: (domain: PortableDomain, index: number) => T): T[] {
  return PORTABLE_RECORD_DOMAIN_ORDER.map(build);
}

function baseInput(overrides: Partial<CreateMigrationVerificationReportInput> = {}): CreateMigrationVerificationReportInput {
  return {
    generationId: "generation-1",
    targetGenerationId: "generation-1-postgresql",
    bindingSha256: HASH_A,
    manifestRevision: 4,
    manifestChecksumSha256: HASH_B,
    sourceWitness: { version: 1, identitySha256: HASH_A, schemaSha256: HASH_B, contentSha256: HASH_C },
    destinationIdentity: { version: 1, sealedWitnessSha256: HASH_C, systemIdentifier: "712345" },
    destinationSchemaWitness: {
      version: 1, migrationsSha256: HASH_A, searchConfigurationSha256: HASH_B,
      collationSha256: HASH_C, sequenceStateSha256: HASH_D,
    },
    projectMapWitnessSha256: HASH_D,
    queueClassificationWitness: {
      version: 1, queueCutoff: "0000000000000000001", queueSetSha256: HASH_A,
      receiptSetSha256: HASH_B, epochChecksumSha256: HASH_C,
    },
    censusVector: {
      version: 1,
      domains: domainVector((domain, index) => ({ domain, recordCount: index, prefixSha256: migrationWitnessSha256(["c", domain]) })),
      contentSha256: HASH_A,
    },
    canonicalDelta: {
      version: 1,
      domains: domainVector((domain, index) => ({ domain, recordCount: index, terminalIdentitySha256: migrationWitnessSha256(["d", domain]) })),
    },
    classCoverage: MIGRATION_MISMATCH_CLASSES.map((mismatchClass) => ({ class: mismatchClass, ran: true })),
    sampleParameters: { version: 1, strideOrdinal: 97, sampleCount: 32, seedBasisSha256: HASH_D },
    publicProbeSha256: migrationWitnessSha256(["public-probe"]),
    publicProbeCoverage: MIGRATION_PUBLIC_PROBE_ORDER.map((probe) => ({ probe, ran: true })),
    mismatches: [],
    mismatchTotals: [],
    ...overrides,
  };
}

function expectStoreError(callback: () => unknown, reason: MigrationVerificationStoreError["reason"]): void {
  try {
    callback();
    throw new Error("expected MigrationVerificationStoreError");
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationVerificationStoreError);
    expect((error as MigrationVerificationStoreError).reason).toBe(reason);
  }
}

describe("MigrationVerificationReportStore", () => {
  let homeDir: string;
  let store: MigrationVerificationReportStore;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "lcm-verification-store-"));
    store = new MigrationVerificationReportStore({ homeDir });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true });
  });

  function reportPath(generationId: string, reportSha256: string): string {
    return join(homeDir, ".lcm", "migration-verification", "generations", generationId, "reports", `${reportSha256}.json`);
  }

  it("publishes a fresh report and reads it back unchanged", () => {
    const report = createMigrationVerificationReport(baseInput());
    const published = store.persist("generation-1", report);
    expect(published.outcome).toBe("published");
    expect(published.report).toEqual(report);
    expect(store.has("generation-1", report.reportSha256)).toBe(true);
    expect(store.read("generation-1", report.reportSha256)).toEqual(report);
  });

  it("reuses an identical report on a second persist without republishing", () => {
    const report = createMigrationVerificationReport(baseInput());
    store.persist("generation-1", report);
    const second = store.persist("generation-1", report);
    expect(second.outcome).toBe("reused");
    expect(second.report).toEqual(report);
  });

  it("round-4: rejects persisting a report whose body names a different generation than the call site", () => {
    // Before this fix, persist() validated the report's own internal
    // consistency but never checked it against the generationId
    // parameter used to build the file path -- a report for generation
    // A could be written under generation B's path, and a pending B
    // effect could later resume on evidence that was never actually
    // about B.
    const wrongGenerationReport = createMigrationVerificationReport(baseInput({ generationId: "generation-2" }));
    expectStoreError(() => store.persist("generation-1", wrongGenerationReport), "malformed-record");
  });

  it("round-4: rejects reading back a stored report whose body names a different generation than the path it was read from", () => {
    // Mirrors "rejects a stored report whose content identity does not
    // match its own filename" above: persist() writes canonical bytes
    // for a generation-2 report at generation-2's own identity path;
    // copying those exact bytes under generation-1's path (same
    // reportSha256, different generation directory) produces well-
    // formed, canonical, validating content naming the wrong generation.
    const otherGenerationReport = createMigrationVerificationReport(baseInput({ generationId: "generation-2" }));
    store.persist("generation-2", otherGenerationReport);
    const sourcePath = reportPath("generation-2", otherGenerationReport.reportSha256);
    const targetPath = reportPath("generation-1", otherGenerationReport.reportSha256);
    mkdirSync(join(targetPath, ".."), { recursive: true, mode: 0o700 });
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, 0o600);
    expectStoreError(() => store.read("generation-1", otherGenerationReport.reportSha256), "malformed-record");
  });

  it("round-4 P1-adjacent: defaults expectedUid to the current process uid rather than leaving the descriptor-owner check disabled", () => {
    // Before this fix, an omitted expectedUid stayed undefined and was
    // passed straight through to readBoundedRegularFileWithStat, whose
    // own check is skipped entirely when expectedUid is undefined --
    // manifest-store.ts defaults this to the current process uid for
    // exactly this reason, and this store had silently drifted from
    // that pattern. beforeEach's default `store` (no expectedUid
    // passed) already proves the happy path -- a real file this test
    // process itself wrote reads back fine under the new default -- so
    // this test proves the other half: that the default now actually
    // enforces ownership rather than merely not breaking anything. It
    // patches process.getuid so a fresh store's captured #expectedUid
    // disagrees with the file's real owner (this test process, which
    // wrote it through the unpatched default store above), which is the
    // only way to produce a genuine mismatch without real multi-user
    // file ownership.
    const report = createMigrationVerificationReport(baseInput());
    store.persist("generation-1", report);
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    const real = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (real === undefined) return; // no getuid on this platform: nothing to mismatch against.
    try {
      Object.defineProperty(process, "getuid", { value: () => real + 1, configurable: true });
      const mismatchedStore = new MigrationVerificationReportStore({ homeDir });
      expect(() => mismatchedStore.read("generation-1", report.reportSha256)).toThrow("file owner is not trusted");
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("leaves expectedUid undefined, rather than throwing, on a platform with no process.getuid", () => {
    // The other half of currentUid()'s own branch: a platform without
    // process.getuid (this store's fallback, matching manifest-store.ts's
    // identical function) must not fail construction, and the resulting
    // store must still work -- just without an ownership check to
    // default, which is the same behaviour this store always had before
    // this fix on such a platform.
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      const noGetuidStore = new MigrationVerificationReportStore({ homeDir });
      const report = createMigrationVerificationReport(baseInput());
      expect(() => noGetuidStore.persist("generation-1", report)).not.toThrow();
      expect(noGetuidStore.read("generation-1", report.reportSha256)).toEqual(report);
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("two distinct reports for the same generation coexist under their own identities", () => {
    const clean = createMigrationVerificationReport(baseInput());
    const dirty = createMigrationVerificationReport(baseInput({
      mismatches: [{ domain: "messages", class: "count", identitySha256: HASH_A }],
      mismatchTotals: [{ domain: "messages", class: "count", count: 1 }],
    }));
    expect(clean.reportSha256).not.toBe(dirty.reportSha256);
    store.persist("generation-1", clean);
    store.persist("generation-1", dirty);
    expect(store.read("generation-1", clean.reportSha256)).toEqual(clean);
    expect(store.read("generation-1", dirty.reportSha256)).toEqual(dirty);
  });

  it("refuses a report whose identity collides with different persisted content", () => {
    const report = createMigrationVerificationReport(baseInput());
    const path = reportPath("generation-1", report.reportSha256);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, "not the canonical bytes\n", { mode: 0o600 });
    expectStoreError(() => store.persist("generation-1", report), "identity-conflict");
  });

  it("rejects an invalid generation id", () => {
    const report = createMigrationVerificationReport(baseInput());
    expectStoreError(() => store.persist("", report), "invalid-input");
    expectStoreError(() => store.read("", report.reportSha256), "invalid-input");
    expectStoreError(() => store.has("", report.reportSha256), "invalid-input");
  });

  it("rejects an invalid report identity on read and has", () => {
    expectStoreError(() => store.read("generation-1", "nope"), "invalid-input");
    expectStoreError(() => store.has("generation-1", "nope"), "invalid-input");
  });

  it("rejects a report that fails validation", () => {
    // persist() re-validates through verification-report.ts rather than
    // duplicating its rules, so a structurally invalid report surfaces that
    // module's own error type unwrapped.
    expect(() => store.persist(
      "generation-1",
      { bogus: true } as unknown as ReturnType<typeof createMigrationVerificationReport>,
    )).toThrow(MigrationVerificationReportError);
  });

  it("reports absence for a report that was never persisted", () => {
    expect(store.has("generation-1", HASH_A)).toBe(false);
    expectStoreError(() => store.read("generation-1", HASH_A), "absent");
  });

  it("surfaces on-disk content without a trailing newline as malformed-record", () => {
    const path = reportPath("generation-1", HASH_A);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, "not json at all", { mode: 0o600 });
    expectStoreError(() => store.read("generation-1", HASH_A), "malformed-record");
  });

  it("surfaces on-disk content that is not valid JSON as malformed-record", () => {
    const path = reportPath("generation-1", HASH_A);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, "not json at all\n", { mode: 0o600 });
    expectStoreError(() => store.read("generation-1", HASH_A), "malformed-record");
  });

  it("surfaces well-formed but structurally invalid JSON as malformed-record", () => {
    const path = reportPath("generation-1", HASH_A);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, "{}\n", { mode: 0o600 });
    expectStoreError(() => store.read("generation-1", HASH_A), "malformed-record");
  });

  it("surfaces non-canonical but structurally valid JSON as malformed-record", () => {
    const report = createMigrationVerificationReport(baseInput());
    const path = reportPath("generation-1", report.reportSha256);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    // Valid JSON.parse()-able content for this report, but with a trailing
    // space before the newline so it is not the canonical serialization.
    writeFileSync(path, `${JSON.stringify(report)} \n`, { mode: 0o600 });
    expectStoreError(() => store.read("generation-1", report.reportSha256), "malformed-record");
  });

  it("rejects a stored report whose content identity does not match its own filename", () => {
    const report = createMigrationVerificationReport(baseInput());
    const otherReport = createMigrationVerificationReport(baseInput({ manifestRevision: 9 }));
    // persist() writes canonical bytes for otherReport at its own identity
    // path; copying those exact bytes under report's identity produces
    // well-formed, canonical, validating content for the wrong identity.
    store.persist("generation-1", otherReport);
    const sourcePath = reportPath("generation-1", otherReport.reportSha256);
    const targetPath = reportPath("generation-1", report.reportSha256);
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, 0o600);
    expectStoreError(() => store.read("generation-1", report.reportSha256), "malformed-record");
  });

  it("propagates an unexpected filesystem error from read() unwrapped", () => {
    const report = createMigrationVerificationReport(baseInput());
    const path = reportPath("generation-1", report.reportSha256);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, "content\n", { mode: 0o600 });
    // requireSingleLink is deliberately not used by this store (see the
    // durable-wedge test below), so an untrusted mode is the vehicle here
    // for a real, non-ENOENT filesystem error distinct from malformed
    // JSON or a content/filename mismatch.
    chmodSync(path, 0o644);
    expect(() => store.read("generation-1", report.reportSha256)).toThrow();
    expect(() => store.read("generation-1", report.reportSha256)).not.toThrow(MigrationVerificationStoreError);
  });

  it("propagates an unexpected filesystem error from has() as malformed-record", () => {
    const report = createMigrationVerificationReport(baseInput());
    const path = reportPath("generation-1", report.reportSha256);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, "content\n", { mode: 0o600 });
    // See the read() test above: an untrusted mode is the vehicle for a
    // real, non-ENOENT filesystem error.
    chmodSync(path, 0o644);
    expectStoreError(() => store.has("generation-1", report.reportSha256), "malformed-record");
  });

  it("tolerates a durable extra hard link left by a winner's failed temp-file cleanup (does not wedge reuse or read)", () => {
    // Models the exact synthesis-round durable wedge: the winner's publish
    // already succeeded (published=true), but atomicWritePrivateFileExclusive's
    // best-effort temp-file removal failed afterwards, leaving nlink=2 on
    // the final name forever -- no later caller ever retries that specific
    // removal. Content addressing, not link count, is this store's real
    // safety property, so this must not throw.
    const report = createMigrationVerificationReport(baseInput());
    const persisted = store.persist("generation-1", report);
    expect(persisted.outcome).toBe("published");
    const path = reportPath("generation-1", report.reportSha256);
    const strayTempPath = join(path, "..", ".stray-temp-link.tmp");
    linkSync(path, strayTempPath);
    expect(() => store.read("generation-1", report.reportSha256)).not.toThrow();
    expect(store.has("generation-1", report.reportSha256)).toBe(true);
    const reused = store.persist("generation-1", report);
    expect(reused.outcome).toBe("reused");
    expect(reused.report.reportSha256).toBe(report.reportSha256);
  });
});

describe("filename helpers", () => {
  it("defaults to the OS home directory when none is supplied", () => {
    const fallbackHome = mkdtempSync(join(tmpdir(), "lcm-verification-store-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = fallbackHome;
    try {
      const defaultStore = new MigrationVerificationReportStore();
      // A nonexistent generation directory is a safe read-only probe: it
      // never creates anything under the (mocked) real home directory.
      expect(defaultStore.has("generation-1", "a".repeat(64))).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(fallbackHome, { recursive: true });
    }
  });

  it("round-trips a report identity through its filename", () => {
    expect(migrationVerificationReportFilename(HASH_A)).toBe(`${HASH_A}.json`);
    expect(parseMigrationVerificationReportFilename(`${HASH_A}.json`)).toBe(HASH_A);
  });
  it("rejects an invalid identity when building a filename", () => {
    expect(() => migrationVerificationReportFilename("nope")).toThrow(MigrationVerificationStoreError);
  });
  it("rejects a malformed filename", () => {
    expect(() => parseMigrationVerificationReportFilename("nope.json")).toThrow(MigrationVerificationStoreError);
  });
});
