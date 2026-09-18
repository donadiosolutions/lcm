import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PORTABLE_RECORD_DOMAIN_ORDER, type PortableDomain } from "../../src/storage/portable-record.js";
import { migrationWitnessSha256 } from "../../src/migration/activation-witness.js";
import {
  createMigrationVerificationReport,
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
    sampleParameters: { version: 1, strideOrdinal: 97, sampleCount: 32, seedBasisSha256: HASH_D },
    publicProbeSha256: migrationWitnessSha256(["public-probe"]),
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
    const otherPath = reportPath("generation-1", HASH_B);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, "content\n", { mode: 0o600 });
    // A second hard link trips requireSingleLink, a real error distinct from ENOENT.
    linkSync(path, otherPath);
    chmodSync(path, 0o600);
    expect(() => store.read("generation-1", report.reportSha256)).toThrow();
    expect(() => store.read("generation-1", report.reportSha256)).not.toThrow(MigrationVerificationStoreError);
  });

  it("propagates an unexpected filesystem error from has() as malformed-record", () => {
    const report = createMigrationVerificationReport(baseInput());
    const path = reportPath("generation-1", report.reportSha256);
    const otherPath = reportPath("generation-1", HASH_B);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, "content\n", { mode: 0o600 });
    // A second hard link trips requireSingleLink, a real error distinct from ENOENT.
    linkSync(path, otherPath);
    chmodSync(path, 0o600);
    expectStoreError(() => store.has("generation-1", report.reportSha256), "malformed-record");
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
