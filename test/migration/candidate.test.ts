import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMigrationApplyCandidate } from "../../src/migration/candidate.js";
import { performMigrationApplyThroughCapture } from "../../src/migration/apply.js";
import {
  prepareSqliteMigrationEnrollment,
  authenticateSqliteMigrationSource,
  type SqliteMigrationEnrollmentInput,
} from "../../src/migration/maintenance.js";
import { computeMigrationGenerationBase, MigrationIdentityError } from "../../src/migration/generation-identity.js";
import { migrationEntryRoster, migrationQueueEvidenceSentinel } from "../../src/migration/hold-entry.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { createMigrationManifest } from "../../src/migration/protocol.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import * as identityApi from "../../src/machine-identity.js";
import {
  BackendPublicationCoordinator,
  backendPublicationJournalPath,
  backendPublicationCanonicalSha256,
  readBackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { clearProjectMapCache } from "../../src/project-map.js";
import type { IdentityRepository } from "../../src/identity-service.js";

/**
 * Calls the real entry point with the confirmed generation id defaulting to
 * the first candidate ordinal, the id a fresh project's `plan` would print.
 * Tests that act on a later generation pass their own.
 */
function capture(
  input: Omit<Parameters<typeof performMigrationApplyThroughCapture>[0], "confirmGenerationId"> & { confirmGenerationId?: string },
): ReturnType<typeof performMigrationApplyThroughCapture> {
  return performMigrationApplyThroughCapture({ confirmGenerationId: `${input.base}-0`, ...input });
}

const roots: string[] = [];
const REGISTERED_MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";

afterEach(() => {
  closeLcmConnection();
  vi.restoreAllMocks();
  clearProjectMapCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-candidate-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

function enrollmentFixture() {
  const homeDir = home();
  const cwd = join(homeDir, "project");
  mkdirSync(cwd, { mode: 0o700 });
  const local = localProjectIdentity(cwd, homeDir);
  const projectDir = join(homeDir, ".lcm", "projects", local.id);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(homeDir, ".lcm", "events"), { mode: 0o700 });
  writeFileSync(join(projectDir, "meta.json"), `${JSON.stringify({ cwd })}\n`, { mode: 0o600 });
  const request: SqliteMigrationEnrollmentInput = {
    cwd,
    homeDir,
    targetConfig: {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://unused.invalid/lcm",
        caFile: "/unused",
        migrationRole: "unused",
        poolMax: 1,
        connectionTimeoutMs: 100,
        idleTimeoutMs: 100,
        statementTimeoutMs: 100,
      },
    },
  };
  const registered = () => {
    const pending = identityApi.readMachineIdentity(homeDir)!;
    return { machineId: REGISTERED_MACHINE, identityKey: pending.identityKey, displayName: pending.displayName };
  };
  const repository = {
    registerMachine: vi.fn(async () => registered()),
    recoverMachine: vi.fn(async () => registered()),
  };
  const close = vi.fn(async () => undefined);
  const openIdentitySession = vi.fn(async () => ({ repository: repository as unknown as IdentityRepository, close }));
  return { homeDir, cwd, local, projectDir, request, openIdentitySession };
}

function coordinatorFor(homeDir: string): BackendPublicationCoordinator {
  const unexpected: BackendPublicationDriver["observeLocalState"] = async () => {
    throw new Error("v2 driver must not run for maintenance");
  };
  const driver: BackendPublicationDriver = {
    observeLocalState: unexpected,
    publishProjectMap: async () => { throw new Error("v2 driver must not run for maintenance"); },
    publishConfig: async () => { throw new Error("v2 driver must not run for maintenance"); },
    restoreConfig: async () => { throw new Error("v2 driver must not run for maintenance"); },
    restoreProjectMap: async () => { throw new Error("v2 driver must not run for maintenance"); },
  };
  return new BackendPublicationCoordinator({ homeDir, driver });
}

async function enrolled() {
  const fixture = enrollmentFixture();
  await prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession });
  const base = computeMigrationGenerationBase({
    physicalProjectId: fixture.local.id,
    canonicalPath: fixture.local.canonical,
    target: { host: "db.example", port: 5432, database: "appdb" },
  });
  return { ...fixture, base };
}

describe("resolveMigrationApplyCandidate: agreement with the real apply pipeline", () => {
  it("computes the exact same fresh generation id that performMigrationApplyThroughCapture actually captures (equivalence: the two paths are tested to agree, not merely intended to)", async () => {
    const fixture = await enrolled();
    const preview = await resolveMigrationApplyCandidate({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base,
    });
    expect(preview).toEqual({ status: "candidate", disposition: "fresh", generationId: `${fixture.base}-0` });

    const coordinator = coordinatorFor(fixture.homeDir);
    const real = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(real.status).toBe("captured");
    if (real.status !== "captured") throw new Error("unreachable");
    expect(real.generationId).toBe((preview as { generationId: string }).generationId);
  });

  it("never mutates anything: the preview alone leaves no maintenance journal on disk", async () => {
    const fixture = await enrolled();
    await resolveMigrationApplyCandidate({ cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base });
    expect(readBackendMaintenanceJournal(fixture.homeDir)).toBeNull();
  });

  it("agrees with the real pipeline for a continue-held disposition too: a real held-and-captured journal previews as continue-held at the same generation id", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const first = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(first.status).toBe("captured");
    if (first.status !== "captured") throw new Error("unreachable");

    const preview = await resolveMigrationApplyCandidate({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base,
    });
    expect(preview).toEqual({ status: "candidate", disposition: "continue-held", generationId: first.generationId });
  });
});

describe("resolveMigrationApplyCandidate: refusal paths", () => {
  it("refuses publication-occupies-slot when injected observation reports a v2 publication journal", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationApplyCandidate({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base,
      _operationsForTesting: { observeJournal: () => ({ kind: "publication", publicationId: "publication-1", phase: "preparing" }) },
    });
    expect(result).toEqual({ status: "refuse", reason: "publication-occupies-slot" });
  });

  it("refuses journal-unresolvable, carrying the observation's evidence", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationApplyCandidate({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base,
      _operationsForTesting: { observeJournal: () => ({ kind: "unresolvable", evidence: "journal-checksum-mismatch" }) },
    });
    expect(result).toEqual({ status: "refuse", reason: "journal-unresolvable", evidence: "journal-checksum-mismatch" });
  });

  it("previews recover-entering for a real maintenance-entering journal (mirrors apply's own A-1 recovery treatment), never probing for a fresh candidate", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const generationId = `${fixture.base}-0`;
    const authority = authenticateSqliteMigrationSource(fixture.cwd, fixture.homeDir);
    const sentinel = migrationQueueEvidenceSentinel({ generationId, sourceSelectionSha256: authority.sourceSelectionSha256 });
    const roster = migrationEntryRoster({ machineId: authority.machineIdentity.machineId, sentinelEvidenceSha256: sentinel });
    await coordinator.enterMaintenance({
      publicationId: generationId, generationId,
      sourceSelectionSha256: authority.sourceSelectionSha256, queueEvidenceSha256: sentinel, roster,
    });
    const path = backendPublicationJournalPath(fixture.homeDir);
    const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const { checksumSha256: _checksum, ...payload } = current;
    writeFileSync(path, `${JSON.stringify({ ...payload, phase: "maintenance-entering", checksumSha256: backendPublicationCanonicalSha256({ ...payload, phase: "maintenance-entering" }) })}\n`, { mode: 0o600 });

    const preview = await resolveMigrationApplyCandidate({ cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base });
    expect(preview).toEqual({ status: "candidate", disposition: "recover-entering", generationId });
    // Never mutated: still exactly the entering journal this test wrote.
    expect(readBackendMaintenanceJournal(fixture.homeDir)!.phase).toBe("maintenance-entering");
  });

  it("refuses continuation-mismatched-hold when a real held journal's stable fields disagree with the live authenticated candidate", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const first = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(first.status).toBe("captured");
    const path = backendPublicationJournalPath(fixture.homeDir);
    const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const { checksumSha256: _checksum, ...payload } = current;
    const mutated = { ...payload, sourceSelectionSha256: "f".repeat(64) };
    writeFileSync(path, `${JSON.stringify({ ...mutated, checksumSha256: backendPublicationCanonicalSha256(mutated) })}\n`, { mode: 0o600 });

    const preview = await resolveMigrationApplyCandidate({ cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base });
    expect(preview).toEqual({ status: "refuse", reason: "continuation-mismatched-hold" });
  });

  it("refuses continuation-resume-required for a real selection-prepared journal", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationApplyCandidate({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base,
      _operationsForTesting: {
        observeJournal: () => ({
          kind: "maintenance",
          journal: {
            phase: "selection-prepared", publicationId: `${fixture.base}-0`, generationId: `${fixture.base}-0`,
            sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64), roster: [],
            checksumSha256: "c".repeat(64),
          },
        } as never),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "continuation-resume-required" });
  });

  it("previews a fresh next-ordinal candidate for a real terminal (maintenance-aborted) journal with no manifest yet (section 4.6's abort gate lets a genuinely absent manifest through)", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const first = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(first.status).toBe("captured");
    if (first.status !== "captured") throw new Error("unreachable");
    const held = readBackendMaintenanceJournal(fixture.homeDir)!;
    await coordinator.abortMaintenance({
      expectedChecksumSha256: held.checksumSha256,
      sourceSelectionSha256: held.sourceSelectionSha256,
      abortEvidenceSha256: "c".repeat(64),
    });
    expect(readBackendMaintenanceJournal(fixture.homeDir)!.phase).toBe("maintenance-aborted");

    const preview = await resolveMigrationApplyCandidate({ cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base });
    expect(preview).toEqual({ status: "candidate", disposition: "fresh", generationId: `${fixture.base}-1` });
  });

  it("refuses abort-or-resume-required when the abort gate finds a present-but-unsettled manifest for the terminal journal's generation (section 4.6)", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const first = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(first.status).toBe("captured");
    if (first.status !== "captured") throw new Error("unreachable");
    const held = readBackendMaintenanceJournal(fixture.homeDir)!;
    await coordinator.abortMaintenance({
      expectedChecksumSha256: held.checksumSha256,
      sourceSelectionSha256: held.sourceSelectionSha256,
      abortEvidenceSha256: "c".repeat(64),
    });
    const manifestStore = new MigrationManifestStore({ homeDir: fixture.homeDir });
    manifestStore.create(createMigrationManifest({
      generationId: first.generationId,
      source: { version: 1, backend: "sqlite", identitySha256: "a".repeat(64), schemaSha256: "a".repeat(64), contentSha256: "a".repeat(64), capturedAt: "2026-08-12T12:00:00.000Z" },
      destination: { version: 1, backend: "postgresql", identitySha256: "b".repeat(64), schemaSha256: "b".repeat(64), contentSha256: "b".repeat(64), capturedAt: "2026-08-12T12:00:01.000Z" },
      parentGenerationId: null,
      preservedSourceGenerationId: first.generationId,
      createdAt: "2026-08-12T12:00:01.000Z",
    }));

    const preview = await resolveMigrationApplyCandidate({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, manifestStore,
    });
    expect(preview.status).toBe("refuse");
    expect((preview as { reason: string }).reason).toBe("abort-or-resume-required");
  });

  it("catches a thrown MigrationIdentityError from resolveGenerationId and converts it into generation-<reason>, never letting it escape uncaught (mirrors apply.ts's own conversion, so plan and apply see one uniform vocabulary)", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationApplyCandidate({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base,
      _operationsForTesting: {
        resolveGenerationId: async () => {
          throw new MigrationIdentityError("probe-bound-exceeded", "test", "max-9999");
        },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "generation-probe-bound-exceeded", evidence: "max-9999" });
  });

  it("re-throws a non-MigrationIdentityError from resolveGenerationId rather than misclassifying it as a generation refusal (red: broadening the instanceof check would swallow this)", async () => {
    const fixture = await enrolled();
    const outcome = resolveMigrationApplyCandidate({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base,
      _operationsForTesting: {
        resolveGenerationId: async () => { throw new Error("an unrelated failure"); },
      },
    });
    await expect(outcome).rejects.toThrow("an unrelated failure");
  });

  it("refuses abort-gate-unresolvable when the manifest presence probe itself cannot be established for the terminal journal's generation", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const first = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(first.status).toBe("captured");
    if (first.status !== "captured") throw new Error("unreachable");
    const held = readBackendMaintenanceJournal(fixture.homeDir)!;
    await coordinator.abortMaintenance({
      expectedChecksumSha256: held.checksumSha256,
      sourceSelectionSha256: held.sourceSelectionSha256,
      abortEvidenceSha256: "c".repeat(64),
    });
    const unresolvableManifestStore = {
      probeManifestPresence: () => ({ status: "unresolvable" as const, reason: "internal-error" }),
    } as unknown as MigrationManifestStore;

    const preview = await resolveMigrationApplyCandidate({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, manifestStore: unresolvableManifestStore,
    });
    expect(preview.status).toBe("refuse");
    expect((preview as { reason: string }).reason).toBe("abort-gate-unresolvable");
  });

  it("refuses continuation-unclassified if resolveHoldContinuation ever returned recover-entering for a non-entering phase journal (a type-level guard, proven via the injection seam since a real journal cannot produce this)", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const first = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(first.status).toBe("captured");

    const preview = await resolveMigrationApplyCandidate({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base,
      _operationsForTesting: {
        resolveHoldContinuation: () => ({ action: "recover-entering", observedChecksumSha256: "a".repeat(64) }),
      },
    });
    expect(preview).toEqual({ status: "refuse", reason: "continuation-unclassified" });
  });

  it("converts a MigrationIdentityError with null evidence to undefined, matching the envelope's optional-evidence shape", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationApplyCandidate({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base,
      _operationsForTesting: {
        resolveGenerationId: async () => {
          throw new MigrationIdentityError("invalid-input", "test invalid input", null);
        },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "generation-invalid-input", evidence: undefined });
  });
});
