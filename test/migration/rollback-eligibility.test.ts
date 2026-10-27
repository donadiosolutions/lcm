/**
 * Tests for src/migration/rollback-eligibility.ts.
 *
 * Per the epic's standing rule (plan-v2 section 0 for item #626): every
 * check here names the two independent observations it compares, and each
 * side is deliberately corrupted at least once elsewhere in this file so
 * the corresponding assertion is proven breakable, not merely passing.
 * Records are minted by activation-witness.ts's own create* functions.
 */

import { describe, expect, it } from "vitest";
import {
  classifyRollbackEligibilityMode,
  evaluateRollbackEligibility,
  resolveActivationAuthority,
  type ActivationAuthority,
  type MigrationActivationEvidenceResolution,
  type MigrationSelectionBinding,
  type MigrationWitnessResolution,
  type OperabilityFactResolution,
  type RollbackEligibilityObservation,
} from "../../src/migration/rollback-eligibility.js";
import { PORTABLE_RECORD_SCHEMA_SHA256 } from "../../src/storage/portable-record.js";
import {
  driftCanonicalDelta,
  driftCensusVector,
  fixtureActivationScenario,
  fixtureAttempt,
  fixtureBindingsAbsent,
  fixtureBindingsUnresolvable,
  fixtureCanonicalDelta,
  fixtureCensusVector,
  fixtureDestinationIdentity,
  fixtureEpoch,
  fixtureEvidenceAbsent,
  fixtureEvidenceUnresolvable,
  fixtureOperabilityAbsent,
  fixtureOperabilityPresent,
  fixtureOperabilityUnresolvable,
  fixtureRollbackWitness,
} from "../fixtures/migration-activation-records.js";

type Inputs = Readonly<{
  resolution: MigrationWitnessResolution;
  evidence: MigrationActivationEvidenceResolution;
  operabilityFact: OperabilityFactResolution;
}>;

/** The baseline every truth-table row below corrupts in exactly one input. */
function published(): Inputs & { scenario: ReturnType<typeof fixtureActivationScenario> } {
  const scenario = fixtureActivationScenario();
  return {
    scenario,
    resolution: scenario.bindings,
    evidence: scenario.evidence,
    operabilityFact: fixtureOperabilityAbsent,
  };
}

const authority = (inputs: Inputs): ActivationAuthority => resolveActivationAuthority(inputs);
const refusal = (inputs: Inputs): string => {
  const result = authority(inputs);
  if (result.status !== "refused") throw new Error("expected refused, got " + result.status);
  return result.reason;
};

describe("resolveActivationAuthority: the unactivated truth table (plan-v3.1 A1)", () => {
  it("baseline: an activation selection with its witness, attempt and epoch stored is authoritative", () => {
    const { scenario, ...inputs } = published();
    expect(authority(inputs)).toEqual({ status: "authoritative", selection: scenario.selection });
  });

  it("is authoritative whatever the operability fact says once a selection is bound", () => {
    // Breakable by consulting the operability fact before looking for a selection.
    const { scenario, ...inputs } = published();
    expect(authority({ ...inputs, operabilityFact: fixtureOperabilityPresent() }))
      .toEqual({ status: "authoritative", selection: scenario.selection });
  });

  // Rows 1-3: any reader unresolvable refuses, regardless of the other two,
  // each corrupting exactly one input of the baseline.
  it("refuses when the operability fact alone is unresolvable, naming the reader", () => {
    const { scenario: _scenario, ...inputs } = published();
    expect(refusal({ ...inputs, operabilityFact: fixtureOperabilityUnresolvable("lock contention") }))
      .toBe("operability-fact:unresolvable: lock contention");
  });

  it("refuses when the binding store alone is unresolvable, naming the reader", () => {
    const { scenario: _scenario, ...inputs } = published();
    expect(refusal({ ...inputs, resolution: fixtureBindingsUnresolvable("corrupt witness binding") }))
      .toBe("witness-resolution:unresolvable: corrupt witness binding");
  });

  it("refuses when the evidence store alone is unresolvable, naming the reader", () => {
    const { scenario: _scenario, ...inputs } = published();
    expect(refusal({ ...inputs, evidence: fixtureEvidenceUnresolvable("corrupt epoch record") }))
      .toBe("activation-evidence:unresolvable: corrupt epoch record");
  });

  it("refuses an unresolvable evidence store even when nothing was ever bound", () => {
    expect(refusal({
      resolution: fixtureBindingsAbsent,
      evidence: fixtureEvidenceUnresolvable("unreadable directory"),
      operabilityFact: fixtureOperabilityAbsent,
    })).toContain("activation-evidence:unresolvable");
  });

  it("does not collapse absence and unresolvability for the evidence store", () => {
    const base = { resolution: fixtureBindingsAbsent, operabilityFact: fixtureOperabilityAbsent };
    expect(authority({ ...base, evidence: fixtureEvidenceAbsent })).toEqual({ status: "unactivated" });
    expect(authority({ ...base, evidence: fixtureEvidenceUnresolvable("x") }).status).toBe("refused");
  });

  // Row 4: a binding without its evidence.
  it("refuses an activation selection whose evidence store is authoritatively absent", () => {
    const { scenario: _scenario, ...inputs } = published();
    expect(refusal({ ...inputs, evidence: fixtureEvidenceAbsent }))
      .toContain("a binding exists without its evidence record");
  });

  it("refuses a witness binding alone when the evidence store is authoritatively absent", () => {
    const { scenario } = published();
    expect(refusal({
      resolution: scenario.unpublishedBindings,
      evidence: fixtureEvidenceAbsent,
      operabilityFact: fixtureOperabilityAbsent,
    })).toContain("a binding exists without its evidence record");
  });

  it("refuses an activation selection alone (no witness binding) when the evidence store is authoritatively absent", () => {
    const { scenario } = published();
    expect(refusal({
      resolution: { state: "resolved", witnesses: [], selections: [scenario.selection] },
      // Empty record lists, so a mutant that skipped this refusal would answer witness-missing instead of crashing.
      evidence: { ...fixtureEvidenceAbsent, epochs: [], attempts: [], witnesses: [] } as MigrationActivationEvidenceResolution,
      operabilityFact: fixtureOperabilityAbsent,
    })).toContain("a binding exists without its evidence record");
  });

  // Row 5: a selection whose records disagree or are missing.
  it("refuses when the selected witness is missing from the evidence store", () => {
    const { scenario, ...inputs } = published();
    expect(refusal({ ...inputs, evidence: { ...scenario.evidence, witnesses: [] } }))
      .toContain("activation-evidence:witness-missing");
  });

  it("refuses when the attempt the selected witness names is missing", () => {
    const { scenario, ...inputs } = published();
    expect(refusal({ ...inputs, evidence: { ...scenario.evidence, attempts: [] } }))
      .toContain("activation-evidence:attempt-missing");
  });

  it("refuses when the epoch the selected witness names is missing", () => {
    const { scenario, ...inputs } = published();
    expect(refusal({ ...inputs, evidence: { ...scenario.evidence, epochs: [] } }))
      .toContain("activation-evidence:epoch-missing");
  });

  it("refuses when the selection names a different epoch than its witness", () => {
    const { scenario, ...inputs } = published();
    const resolution: MigrationWitnessResolution = {
      state: "resolved", witnesses: [scenario.witnessBinding],
      selections: [{ ...scenario.selection, epochId: "1".repeat(64) }],
    };
    expect(refusal({ ...inputs, resolution })).toContain("activation-evidence:mismatch");
  });

  it("refuses when the selection names a different attempt than its witness", () => {
    const { scenario, ...inputs } = published();
    const resolution: MigrationWitnessResolution = {
      state: "resolved", witnesses: [scenario.witnessBinding],
      selections: [{ ...scenario.selection, attemptId: "2".repeat(64) }],
    };
    expect(refusal({ ...inputs, resolution })).toContain("activation-evidence:mismatch");
  });

  it("refuses when the selected witness is a rollback witness, not an activation witness", () => {
    const { scenario, ...inputs } = published();
    const rollback = fixtureRollbackWitness({
      epoch: scenario.epoch, attempt: scenario.attempt,
      postEpochDelta: driftCanonicalDelta(scenario.attempt.canonicalDeltaBaseline, 0),
      postEpochCensus: null, rollbackMode: "post-write",
    });
    const resolution: MigrationWitnessResolution = {
      state: "resolved", witnesses: [scenario.witnessBinding],
      selections: [{ ...scenario.selection, witnessChecksumSha256: rollback.checksumSha256 }],
    };
    const evidence = { ...scenario.evidence, witnesses: [scenario.witness, rollback] };
    expect(refusal({ ...inputs, resolution, evidence })).toContain("activation-evidence:mismatch");
  });

  it("refuses when the stored attempt belongs to a different epoch than the stored witness's epoch", () => {
    const { scenario, ...inputs } = published();
    const otherEpoch = fixtureEpoch({ generationId: "generation-1", seed: "other" });
    const crossed = { ...scenario.attempt, epochId: otherEpoch.epochId };
    expect(refusal({ ...inputs, evidence: { ...scenario.evidence, attempts: [crossed] } }))
      .toContain("activation-evidence:mismatch");
  });

  // Row 6: published but unbound.
  it("refuses as published-but-unbound, never unactivated, when the destination is operable and no selection exists", () => {
    const { scenario } = published();
    const inputs = {
      resolution: scenario.unpublishedBindings,
      evidence: scenario.evidence,
      operabilityFact: fixtureOperabilityPresent(),
    };
    expect(refusal(inputs)).toContain("published-but-unbound");
    // Paired control: flipping only the operability fact reaches unactivated.
    expect(authority({ ...inputs, operabilityFact: fixtureOperabilityAbsent })).toEqual({ status: "unactivated" });
  });

  it("refuses as published-but-unbound when nothing at all was bound but the destination is operable", () => {
    expect(refusal({
      resolution: fixtureBindingsAbsent, evidence: fixtureEvidenceAbsent, operabilityFact: fixtureOperabilityPresent(),
    })).toContain("published-but-unbound");
  });

  // Unactivated rows.
  it("is unactivated when all three observations agree that nothing was activated", () => {
    expect(authority({
      resolution: fixtureBindingsAbsent, evidence: fixtureEvidenceAbsent, operabilityFact: fixtureOperabilityAbsent,
    })).toEqual({ status: "unactivated" });
  });

  it("is unactivated for an authenticated binding store holding nothing", () => {
    expect(authority({
      resolution: { state: "resolved", witnesses: [], selections: [] },
      evidence: fixtureEvidenceAbsent,
      operabilityFact: fixtureOperabilityAbsent,
    })).toEqual({ status: "unactivated" });
  });

  it("is unactivated for the witnessed-but-unpublished state when the destination is not yet operable", () => {
    const { scenario } = published();
    expect(authority({
      resolution: scenario.unpublishedBindings,
      evidence: scenario.evidence,
      operabilityFact: fixtureOperabilityAbsent,
    })).toEqual({ status: "unactivated" });
  });

  it("is unactivated when an epoch alone is stored", () => {
    const { scenario } = published();
    expect(authority({
      resolution: fixtureBindingsAbsent,
      evidence: { ...scenario.evidence, attempts: [], witnesses: [] },
      operabilityFact: fixtureOperabilityAbsent,
    })).toEqual({ status: "unactivated" });
  });

  it("does not treat a rollback-kind selection as activation authority", () => {
    const { scenario } = published();
    const resolution: MigrationWitnessResolution = {
      state: "resolved", witnesses: [],
      selections: [{ ...scenario.selection, kind: "rollback" }],
    };
    expect(authority({ resolution, evidence: scenario.evidence, operabilityFact: fixtureOperabilityAbsent }))
      .toEqual({ status: "unactivated" });
  });

  it("takes the last activation selection when more than one is present", () => {
    const { scenario, ...inputs } = published();
    const older: MigrationSelectionBinding = {
      ...scenario.selection, epochId: "3".repeat(64), attemptId: "4".repeat(64), witnessChecksumSha256: "5".repeat(64),
    };
    const resolution: MigrationWitnessResolution = {
      state: "resolved", witnesses: [scenario.witnessBinding], selections: [older, scenario.selection],
    };
    expect(authority({ ...inputs, resolution })).toEqual({ status: "authoritative", selection: scenario.selection });
  });
});

function observation(overrides: Partial<RollbackEligibilityObservation> = {}): RollbackEligibilityObservation {
  const identity = fixtureDestinationIdentity("dest");
  return {
    observedPortableRecordSchemaSha256: PORTABLE_RECORD_SCHEMA_SHA256,
    destinationIdentity: identity,
    postEpochDelta: fixtureCanonicalDelta("delta"),
    postEpochCensus: null,
    ...overrides,
  };
}

describe("evaluateRollbackEligibility: authoritative branch", () => {
  const delta = fixtureCanonicalDelta("shared-delta");
  const census = fixtureCensusVector("shared-census");
  const scenario = fixtureActivationScenario({
    destinationIdentity: fixtureDestinationIdentity("dest"),
    censusVector: census,
    canonicalDeltaBaseline: delta,
  });
  const evaluate = (overrides: Partial<RollbackEligibilityObservation>, context = scenario.context) =>
    evaluateRollbackEligibility({ authoritativeContext: context, observation: observation(overrides) });

  it("refuses on identity mismatch before the classifier is consulted", () => {
    // The census equals the epoch's, so a classifier that ran would grant pre-write.
    const decision = evaluate({
      destinationIdentity: fixtureDestinationIdentity("other-dest"), postEpochDelta: delta, postEpochCensus: census,
    });
    expect(decision).toEqual({
      eligibility: "refused",
      reason: "destination identity does not match the authoritative epoch",
    });
  });

  it("refuses when only the sealed witness of the destination identity differs (the system identifier matches)", () => {
    const identity = { ...fixtureDestinationIdentity("dest"), sealedWitnessSha256: "9".repeat(64) };
    expect(evaluate({ destinationIdentity: identity, postEpochDelta: delta, postEpochCensus: census })).toEqual({
      eligibility: "refused",
      reason: "destination identity does not match the authoritative epoch",
    });
  });

  it("refuses when only the system identifier of the destination identity differs (the sealed witness matches)", () => {
    const identity = { ...fixtureDestinationIdentity("dest"), systemIdentifier: "another-cluster" };
    expect(evaluate({ destinationIdentity: identity, postEpochDelta: delta, postEpochCensus: census })).toEqual({
      eligibility: "refused",
      reason: "destination identity does not match the authoritative epoch",
    });
  });

  it("grants pre-write when identity matches and the delta is unchanged with a matching census", () => {
    expect(evaluate({ postEpochDelta: delta, postEpochCensus: census }))
      .toEqual({ eligibility: "pre-write", mode: "pre-write" });
  });

  it("grants post-write when the delta has drifted from the baseline", () => {
    expect(evaluate({ postEpochDelta: driftCanonicalDelta(delta, 0), postEpochCensus: null }))
      .toEqual({ eligibility: "post-write", mode: "post-write" });
  });

  it("grants post-write when the delta is unchanged but the census has drifted", () => {
    expect(evaluate({ postEpochDelta: delta, postEpochCensus: driftCensusVector(census, 0) }))
      .toEqual({ eligibility: "post-write", mode: "post-write" });
  });

  it("refuses rather than defaulting when the delta is unchanged and no census was supplied", () => {
    expect(evaluate({ postEpochDelta: delta, postEpochCensus: null })).toEqual({
      eligibility: "refused",
      reason: "canonical delta is unchanged and no census was supplied",
    });
  });

  it("refuses on a schema-incomparable census with a distinct reason, never falling through to post-write", () => {
    expect(evaluate({
      observedPortableRecordSchemaSha256: "0".repeat(64), postEpochDelta: delta, postEpochCensus: census,
    })).toEqual({
      eligibility: "refused",
      reason: "observed census schema is not comparable to the frozen portable record schema",
    });
  });

  it("refuses a stored pair whose ids do not cross-match, rather than classifying it", () => {
    const stranger = fixtureAttempt({ epoch: fixtureEpoch({ generationId: "generation-1", seed: "stranger" }) });
    expect(evaluate({ postEpochDelta: delta, postEpochCensus: census }, { ...scenario.context, attempt: stranger }))
      .toEqual({
        eligibility: "refused",
        reason: "the activation attempt does not belong to the authoritative epoch",
      });
  });
});

describe("classifyRollbackEligibilityMode (plan-v3.1 A3)", () => {
  const delta = fixtureCanonicalDelta("adapter-delta");
  const census = fixtureCensusVector("adapter-census");
  const { epoch, attempt } = fixtureActivationScenario({ censusVector: census, canonicalDeltaBaseline: delta });

  it("returns the classifier's answers unchanged once its preconditions hold", () => {
    expect(classifyRollbackEligibilityMode({ epoch, attempt, postEpochDelta: delta, postEpochCensus: census }))
      .toEqual({ mode: "pre-write" });
    expect(classifyRollbackEligibilityMode({ epoch, attempt, postEpochDelta: delta, postEpochCensus: driftCensusVector(census, 1) }))
      .toEqual({ mode: "post-write" });
    expect(classifyRollbackEligibilityMode({ epoch, attempt, postEpochDelta: driftCanonicalDelta(delta, 2), postEpochCensus: null }))
      .toEqual({ mode: "post-write" });
  });

  it("refuses an attempt that does not belong to the epoch", () => {
    const stranger = fixtureAttempt({ epoch: fixtureEpoch({ generationId: "generation-1", seed: "stranger" }) });
    expect(classifyRollbackEligibilityMode({ epoch, attempt: stranger, postEpochDelta: delta, postEpochCensus: census }))
      .toEqual({ mode: "refused", reason: "the activation attempt does not belong to the authoritative epoch" });
  });

  it("refuses an unchanged delta with no census, and does not refuse a changed delta with no census", () => {
    expect(classifyRollbackEligibilityMode({ epoch, attempt, postEpochDelta: delta, postEpochCensus: null }))
      .toEqual({ mode: "refused", reason: "canonical delta is unchanged and no census was supplied" });
    expect(classifyRollbackEligibilityMode({ epoch, attempt, postEpochDelta: driftCanonicalDelta(delta, 0), postEpochCensus: null }))
      .toEqual({ mode: "post-write" });
  });

  it("rethrows a classifier throw that is not one of the two preconditions", () => {
    // A census that cannot be canonicalised makes the classifier throw from inside its census
    // comparison, after both preconditions held. That is a defect to surface, never a refusal.
    const malformed = { ...census, domains: census.domains.map((entry, index) => (
      index === 0 ? { ...entry, recordCount: Number.NaN } : entry)) };
    expect(() => classifyRollbackEligibilityMode({ epoch, attempt, postEpochDelta: delta, postEpochCensus: malformed }))
      .toThrow(TypeError);
  });
});
