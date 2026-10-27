import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackendPublicationCoordinator,
  type BackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import {
  beginMigrationEffect,
  completeMigrationEffect,
  createMigrationManifest,
  type MigrationEffectKind,
  type MigrationManifest,
  type MigrationPhase,
} from "../../src/migration/protocol.js";
import { migrationWitnessSha256 } from "../../src/migration/activation-witness.js";
import {
  createMigrationVerificationReport,
  MIGRATION_MISMATCH_CLASSES,
  MIGRATION_PUBLIC_PROBE_ORDER,
  type CreateMigrationVerificationReportInput,
  type MigrationVerificationReport,
} from "../../src/migration/verification-report.js";
import { PORTABLE_RECORD_DOMAIN_ORDER } from "../../src/storage/portable-record.js";
import { migrationVerificationEffectId } from "../../src/migration/verify-generation.js";
import { MigrationVerificationReportStore } from "../../src/migration/verification-store.js";

/**
 * Real-file fixtures shared by the existing-generation command tests: a real
 * home, a real maintenance journal written by the real coordinator, a real
 * manifest advanced through the protocol's own begin and complete operations,
 * and a real persisted verification report. Only the snapshot classification
 * is injected by callers, because a real captured snapshot needs a SQLite
 * source the command tests do not exercise.
 */

export const FIXTURE_AT = "2026-08-12T12:00:00.000Z";
export const FIXTURE_MACHINE_ID = "018f0b5d-1234-4abc-8def-1234567890ab";
export const FIXTURE_GENERATION = "generation-1";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

export function makeFixtureHome(roots: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-existing-fixture-"));
  roots.push(home);
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  return home;
}

export function removeFixtureHomes(roots: string[]): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function maintenanceCoordinator(home: string): BackendPublicationCoordinator {
  const unexpected = async (): Promise<never> => { throw new Error("v2 driver must not run for maintenance"); };
  const driver: BackendPublicationDriver = {
    observeLocalState: unexpected,
    publishProjectMap: unexpected,
    publishConfig: unexpected,
    restoreConfig: unexpected,
    restoreProjectMap: unexpected,
  };
  return new BackendPublicationCoordinator({ homeDir: home, driver });
}

export async function heldFixtureJournal(home: string, generationId = FIXTURE_GENERATION): Promise<BackendMaintenanceJournal> {
  return maintenanceCoordinator(home).enterMaintenance({
    publicationId: "maintenance-publication",
    generationId,
    sourceSelectionSha256: HASH_A,
    queueEvidenceSha256: HASH_B,
    roster: [{ machineId: FIXTURE_MACHINE_ID, queueCutoff: null, evidenceSha256: HASH_A }],
  });
}

export async function abortedFixtureJournal(home: string, generationId = FIXTURE_GENERATION): Promise<BackendMaintenanceJournal> {
  const held = await heldFixtureJournal(home, generationId);
  return maintenanceCoordinator(home).abortMaintenance({
    expectedChecksumSha256: held.checksumSha256,
    sourceSelectionSha256: held.sourceSelectionSha256,
    abortEvidenceSha256: HASH_C,
  });
}

/** A verification report whose destination identity matches `destinationIdentitySha256` (the manifest's sealed one). */
export function fixtureVerificationReport(
  generationId = FIXTURE_GENERATION,
  overrides: Partial<CreateMigrationVerificationReportInput> = {},
): MigrationVerificationReport {
  return createMigrationVerificationReport({
    generationId,
    targetGenerationId: `${generationId}-postgresql`,
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
      domains: PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => ({ domain, recordCount: index, prefixSha256: migrationWitnessSha256(["c", domain]) })),
      contentSha256: HASH_A,
    },
    canonicalDelta: {
      version: 1,
      domains: PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => ({ domain, recordCount: index, terminalIdentitySha256: migrationWitnessSha256(["d", domain]) })),
    },
    classCoverage: MIGRATION_MISMATCH_CLASSES.map((mismatchClass) => ({ class: mismatchClass, ran: true })),
    sampleParameters: { version: 1, strideOrdinal: 97, sampleCount: 32, seedBasisSha256: HASH_D },
    publicProbeSha256: migrationWitnessSha256(["public-probe"]),
    publicProbeCoverage: MIGRATION_PUBLIC_PROBE_ORDER.map((probe) => ({ probe, ran: true })),
    mismatches: [],
    mismatchTotals: [],
    ...overrides,
  });
}

export type FixtureStage = "planned" | "dry-run-verified" | "copying" | "copied" | "verified" | "active" | "rolled-back";

export type FixtureManifestOptions = Readonly<{
  generationId?: string;
  /** The destination witness the manifest seals; the report fixture's identity is `c` x 64. */
  destinationIdentitySha256?: string;
  destinationSystemIdentifier?: string | null;
  /** Begin, and leave pending, this effect at the final stage. */
  pending?: MigrationEffectKind;
  /** Overrides the pending effect's id (to forge one that does not name its report). */
  pendingEffectId?: string;
  /** The report a verify-generation effect completes with or names. */
  report?: MigrationVerificationReport;
}>;

/**
 * Creates a manifest and advances it to `stage` through the protocol's own
 * operations, then optionally begins one more effect and leaves it pending.
 */
export function createFixtureManifest(
  store: MigrationManifestStore,
  stage: FixtureStage,
  options: FixtureManifestOptions = {},
): MigrationManifest {
  const generationId = options.generationId ?? FIXTURE_GENERATION;
  const systemIdentifier = options.destinationSystemIdentifier === undefined ? "712345" : options.destinationSystemIdentifier;
  let manifest = store.create(createMigrationManifest({
    generationId,
    source: { version: 1, backend: "sqlite", identitySha256: "1".repeat(64), schemaSha256: "2".repeat(64), contentSha256: "3".repeat(64), capturedAt: FIXTURE_AT },
    destination: {
      version: 1, backend: "postgresql", identitySha256: options.destinationIdentitySha256 ?? HASH_C,
      schemaSha256: "5".repeat(64), contentSha256: "6".repeat(64), capturedAt: FIXTURE_AT,
      ...(systemIdentifier === null ? {} : { systemIdentifier }),
    },
    parentGenerationId: null,
    preservedSourceGenerationId: generationId,
    createdAt: FIXTURE_AT,
  }));
  const begin = (kind: MigrationEffectKind, effectId: string, inputSha256 = HASH_A): void => {
    manifest = store.update(generationId, manifest.checksumSha256, (current) =>
      beginMigrationEffect(current, { kind, effectId, inputSha256, startedAt: FIXTURE_AT }));
  };
  const complete = (effectId: string, evidence: Omit<Parameters<typeof completeMigrationEffect>[1], "effectId" | "completedAt"> = {}): void => {
    manifest = store.update(generationId, manifest.checksumSha256, (current) =>
      completeMigrationEffect(current, { effectId, completedAt: FIXTURE_AT, ...evidence }));
  };
  const order: readonly FixtureStage[] = ["planned", "dry-run-verified", "copying", "copied", "verified", "active", "rolled-back"];
  const reached = (target: FixtureStage): boolean => order.indexOf(stage) >= order.indexOf(target);
  if (reached("dry-run-verified")) {
    begin("verify-dry-run", "dry-run-effect");
    complete("dry-run-effect", { report: { kind: "dry-run", reportId: "dry-run-effect", reportSha256: HASH_A, createdAt: FIXTURE_AT } });
  }
  if (reached("copying")) {
    begin("copy-batch", "copy-effect");
    complete("copy-effect", { checkpoint: { domain: "conversation", ordinal: 1, recordCount: 1, sourceCheckpointSha256: HASH_A, destinationCommitSha256: HASH_B } });
  }
  if (reached("copied")) {
    begin("complete-copy", "complete-copy-effect");
    complete("complete-copy-effect");
  }
  if (reached("verified")) {
    const report = options.report ?? fixtureVerificationReport(generationId);
    const effectId = migrationVerificationEffectId(report.reportSha256);
    begin("verify-generation", effectId, report.reportSha256);
    complete(effectId, {
      activationEligible: true,
      report: { kind: "verification", reportId: report.reportId, reportSha256: report.reportSha256, createdAt: FIXTURE_AT },
    });
  }
  if (reached("active")) {
    begin("prepare-activation", "prepare-activation-effect");
    complete("prepare-activation-effect");
    begin("publish-activation", "publish-activation-effect");
    complete("publish-activation-effect", { report: { kind: "activation", reportId: "activation-report", reportSha256: HASH_B, createdAt: FIXTURE_AT } });
  }
  if (reached("rolled-back")) {
    begin("prepare-rollback", "prepare-rollback-effect");
    complete("prepare-rollback-effect");
    begin("publish-rollback", "publish-rollback-effect");
    complete("publish-rollback-effect", {
      rollbackMode: "pre-write",
      report: { kind: "rollback", reportId: "rollback-report", reportSha256: HASH_C, createdAt: FIXTURE_AT },
    });
  }
  if (options.pending !== undefined) {
    const report = options.report;
    const effectId = options.pendingEffectId ?? (options.pending === "verify-generation" && report !== undefined
      ? migrationVerificationEffectId(report.reportSha256)
      : `${options.pending}-effect`);
    begin(options.pending, effectId, report?.reportSha256 ?? HASH_A);
  }
  return manifest;
}

export function persistFixtureReport(home: string, report: MigrationVerificationReport): void {
  new MigrationVerificationReportStore({ homeDir: home }).persist(report.body.generationId, report);
}

/** Every file under the home as base64, so a test can prove nothing moved. */
export function snapshotHome(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(home, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      out[path] = readFileSync(path, "base64");
    }
  }
  return out;
}

