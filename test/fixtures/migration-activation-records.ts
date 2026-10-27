/**
 * Test builders for the activation records rollback consumes. Every record is
 * minted by activation-witness.ts's own create* functions, so identities and
 * checksums are the production derivations; nothing here re-implements them.
 */

import { createHash } from "node:crypto";
import { PORTABLE_RECORD_DOMAIN_ORDER } from "../../src/storage/portable-record.js";
import {
  createMigrationActivationAttempt,
  createMigrationActivationEpoch,
  createMigrationActivationWitness,
  createMigrationQuiescenceFence,
  type MigrationActivationAttempt,
  type MigrationActivationEpoch,
  type MigrationActivationWitness,
  type MigrationCanonicalDelta,
  type MigrationCensusVector,
  type MigrationDestinationIdentity,
  type MigrationSchemaWitness,
} from "../../src/migration/activation-witness.js";
import type {
  MigrationActivationEvidenceResolution,
  RollbackAuthoritativeContext,
} from "../../src/migration/activation-evidence-store.js";
import type {
  MigrationSelectionBinding,
  MigrationWitnessBinding,
  MigrationWitnessResolution,
} from "../../src/migration/generation-binding-store.js";
import type { OperabilityFactResolution } from "../../src/migration/rollback-eligibility.js";

export function fixtureSha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A canonical delta with one deterministic value per domain, easy to mutate. */
export function fixtureCanonicalDelta(seed: string): MigrationCanonicalDelta {
  return {
    version: 1,
    domains: PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => ({
      domain,
      recordCount: 10,
      terminalIdentitySha256: fixtureSha(seed + ":" + domain + ":terminal"),
    })),
  };
}

/** A census vector with one deterministic value per domain, easy to mutate. */
export function fixtureCensusVector(seed: string): MigrationCensusVector {
  return {
    version: 1,
    domains: PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => ({
      domain,
      recordCount: 10,
      prefixSha256: fixtureSha(seed + ":" + domain + ":prefix"),
    })),
    contentSha256: fixtureSha(seed + ":content"),
  };
}

/** Mutates exactly one domain's record count in an otherwise identical delta. */
export function driftCanonicalDelta(delta: MigrationCanonicalDelta, domainIndex: number): MigrationCanonicalDelta {
  return {
    ...delta,
    domains: delta.domains.map((entry, index) => (
      index === domainIndex ? { ...entry, recordCount: entry.recordCount + 1 } : entry
    )),
  };
}

/** Mutates exactly one domain's content digest in an otherwise identical census. */
export function driftCensusVector(census: MigrationCensusVector, domainIndex: number): MigrationCensusVector {
  return {
    ...census,
    domains: census.domains.map((entry, index) => (
      index === domainIndex ? { ...entry, prefixSha256: fixtureSha(entry.prefixSha256 + ":drift") } : entry
    )),
    contentSha256: fixtureSha(census.contentSha256 + ":drift"),
  };
}

export function fixtureDestinationIdentity(seed: string): MigrationDestinationIdentity {
  return {
    version: 1,
    sealedWitnessSha256: fixtureSha(seed + ":sealed-witness"),
    systemIdentifier: "7" + String(seed.length),
  };
}

export function fixtureSchemaWitness(seed: string): MigrationSchemaWitness {
  return {
    version: 1,
    migrationsSha256: fixtureSha(seed + ":migrations"),
    searchConfigurationSha256: fixtureSha(seed + ":search-config"),
    collationSha256: fixtureSha(seed + ":collation"),
    sequenceStateSha256: fixtureSha(seed + ":sequence-state"),
  };
}

export type FixtureEpochInput = Readonly<{
  generationId: string;
  seed?: string;
  manifestRevision?: number;
  destinationIdentity?: MigrationDestinationIdentity;
  censusVector?: MigrationCensusVector;
  schemaWitness?: MigrationSchemaWitness;
}>;

export function fixtureEpoch(input: FixtureEpochInput): MigrationActivationEpoch {
  const seed = input.seed ?? "epoch";
  return createMigrationActivationEpoch({
    generationId: input.generationId,
    manifestRevision: input.manifestRevision ?? 1,
    manifestChecksumSha256: fixtureSha(seed + ":manifest"),
    verificationReportId: "report-" + seed,
    verificationReportSha256: fixtureSha(seed + ":report"),
    projectMapWitnessSha256: fixtureSha(seed + ":project-map"),
    queueClassificationWitnessSha256: fixtureSha(seed + ":queue"),
    destinationIdentity: input.destinationIdentity ?? fixtureDestinationIdentity(seed),
    censusVector: input.censusVector ?? fixtureCensusVector(seed + ":census"),
    schemaWitness: input.schemaWitness ?? fixtureSchemaWitness(seed),
  });
}

export type FixtureAttemptInput = Readonly<{
  epoch: MigrationActivationEpoch;
  seed?: string;
  canonicalDeltaBaseline?: MigrationCanonicalDelta;
  activationRecomputedCensus?: MigrationCensusVector;
}>;

export function fixtureAttempt(input: FixtureAttemptInput): MigrationActivationAttempt {
  const seed = input.seed ?? "attempt";
  return createMigrationActivationAttempt({
    epochId: input.epoch.epochId,
    selectionAuthority: {
      version: 1,
      resourceType: "postgresql-destination",
      resourceKey: "destination-" + seed,
      fencingToken: "1",
      ownerProcessId: "process-" + seed,
    },
    canonicalDeltaBaseline: input.canonicalDeltaBaseline ?? fixtureCanonicalDelta(seed + ":baseline"),
    activationRecomputedCensus: input.activationRecomputedCensus ?? input.epoch.censusVector,
    intraActivationWatermark: null,
    quiescenceFence: createMigrationQuiescenceFence({ kind: "test-quiescence", payload: { seed } }),
  });
}

export function fixtureActivationWitness(
  epoch: MigrationActivationEpoch,
  attempt: MigrationActivationAttempt,
): MigrationActivationWitness {
  return createMigrationActivationWitness({
    kind: "activation", epoch, attempt, postEpochDelta: null, postEpochCensus: null, rollbackMode: null,
  });
}

export function fixtureRollbackWitness(input: Readonly<{
  epoch: MigrationActivationEpoch;
  attempt: MigrationActivationAttempt;
  postEpochDelta: MigrationCanonicalDelta;
  postEpochCensus: MigrationCensusVector | null;
  rollbackMode: "pre-write" | "post-write";
}>): MigrationActivationWitness {
  return createMigrationActivationWitness({ kind: "rollback", ...input });
}


// ---------------------------------------------------------------------------
// Resolution-level builders: the three-valued reads rollback-eligibility.ts
// consumes (binding store, activation evidence store, operability fact).
// ---------------------------------------------------------------------------

export const fixtureBindingsAbsent: MigrationWitnessResolution = { state: "authoritatively-absent" };
export const fixtureEvidenceAbsent: MigrationActivationEvidenceResolution = { state: "authoritatively-absent" };

export function fixtureBindingsUnresolvable(reason: string): MigrationWitnessResolution {
  return { state: "unresolvable", reason };
}

export function fixtureEvidenceUnresolvable(reason: string): MigrationActivationEvidenceResolution {
  return { state: "unresolvable", reason };
}

export function fixtureOperabilityPresent(valueSha256 = "e".repeat(64)): OperabilityFactResolution {
  return { state: "present", valueSha256 };
}

export const fixtureOperabilityAbsent: OperabilityFactResolution = { state: "authoritatively-absent" };

export function fixtureOperabilityUnresolvable(reason: string): OperabilityFactResolution {
  return { state: "unresolvable", reason };
}

export type FixtureActivationScenarioInput = Readonly<{
  generationId?: string;
  seed?: string;
  manifestRevision?: number;
  publicationId?: string;
  destinationIdentity?: MigrationDestinationIdentity;
  censusVector?: MigrationCensusVector;
  canonicalDeltaBaseline?: MigrationCanonicalDelta;
}>;

/**
 * One consistent activation: epoch, attempt, activation witness, the two
 * bindings an activation driver records for it, and the resolutions the
 * binding store and the evidence store would return for exactly that state.
 */
export function fixtureActivationScenario(input: FixtureActivationScenarioInput = {}) {
  const seed = input.seed ?? "scenario";
  const epoch = fixtureEpoch({
    generationId: input.generationId ?? "generation-1",
    seed,
    manifestRevision: input.manifestRevision ?? 1,
    destinationIdentity: input.destinationIdentity,
    censusVector: input.censusVector,
  });
  const attempt = fixtureAttempt({ epoch, seed, canonicalDeltaBaseline: input.canonicalDeltaBaseline });
  const witness = fixtureActivationWitness(epoch, attempt);
  const witnessBinding: MigrationWitnessBinding = {
    kind: "activation",
    epochId: epoch.epochId,
    attemptId: attempt.attemptId,
    manifestRevision: input.manifestRevision ?? 1,
    witnessChecksumSha256: witness.checksumSha256,
  };
  const selection: MigrationSelectionBinding = { ...witnessBinding, publicationId: input.publicationId ?? "publication-1" };
  const evidence: Extract<MigrationActivationEvidenceResolution, { state: "resolved" }> = {
    state: "resolved", epochs: [epoch], attempts: [attempt], witnesses: [witness],
  };
  return {
    epoch,
    attempt,
    witness,
    witnessBinding,
    selection,
    evidence,
    /** The binding store after the selection binding was recorded. */
    bindings: { state: "resolved", witnesses: [witnessBinding], selections: [selection] } as MigrationWitnessResolution,
    /** The binding store after the witness binding but before any selection: witnessed but unpublished. */
    unpublishedBindings: { state: "resolved", witnesses: [witnessBinding], selections: [] } as MigrationWitnessResolution,
    context: { epoch, attempt, witness } as RollbackAuthoritativeContext,
  };
}
