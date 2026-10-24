import { beforeEach, describe, expect, it } from "vitest";
import { BackendPublicationJournalError } from "../../src/storage/backend-publication.js";
import {
  performSetApply, performSetDryRun, performSetPlan, type MigrationSetOperations, type MigrationSetOutcome,
} from "../../src/migration/cli-cutover-set.js";
import { renderMigrationSetEnvelope } from "../../src/migration/cli-render.js";
import type { MigrationCommandName } from "../../src/migration/exit-classes.js";
import { MIGRATION_REFUSAL_REASONS } from "../../src/migration/refusal-mapping.js";
import { GENERATIONS, PROJECTS, SET_ID, craftedHome, holdJournal, setOperations } from "../fixtures/cli-cutover-set.js";

type Parts = Parameters<typeof setOperations>[1];

function envelope(command: MigrationCommandName, outcome: MigrationSetOutcome) {
  return renderMigrationSetEnvelope(command, outcome);
}

const PREPARED: Parts = { journal: holdJournal() };
const PREPARING: Parts = { journal: holdJournal(), eligible: false };

describe("the closed set refusal buckets", () => {
  it("exist in the shared refusal table with the exit classes the service classes need", () => {
    const byReason = new Map(MIGRATION_REFUSAL_REASONS.map((entry) => [entry.reason, entry.exitClass]));
    expect([...byReason].filter(([reason]) => reason.startsWith("set-"))).toEqual([
      ["set-refused-precondition", "refused-precondition"], ["set-refused-contention", "refused-contention"],
      ["set-refused-evidence", "refused-evidence"], ["set-incomplete", "incomplete-recoverable"],
      ["set-operator-required", "failed-operator-required"], ["set-preview-not-predictive", "refused-evidence"],
      ["set-generation-required", "refused-precondition"], ["set-generation-invalid", "usage"],
      ["set-original-generation-required", "refused-precondition"], ["set-confirmation-missing", "refused-confirmation"],
      ["set-confirmation-moved", "refused-confirmation"],
    ]);
    for (const entry of MIGRATION_REFUSAL_REASONS.filter((candidate) => candidate.reason.startsWith("set-"))) {
      expect(entry.remedy).not.toMatch(/\$\{/u);
      expect(entry.remedy.length).toBeGreaterThan(40);
    }
  });
});

describe("plan --set and the unexpected-failure boundary", () => {
  let base!: ReturnType<typeof craftedHome>;
  beforeEach(() => { base = craftedHome(["absent", "absent"]); });
  const ops = (extra: Partial<MigrationSetOperations> = {}) => setOperations(base, {}, extra);

  it("plans from the candidate and carries the daemon presence", async () => {
    const result = envelope("plan", await performSetPlan({
      homeDir: base.homeDir,
      _operationsForTesting: ops({
        classifyPresence: async () => ({ status: "present", storageBackend: "sqlite", pid: 1, daemonInstanceId: "d" }),
        resolveCandidate: async () => ({
          status: "candidate", disposition: "fresh", setId: SET_ID,
          members: GENERATIONS.map((generationId, index) => ({ physicalProjectId: PROJECTS[index]!, generationId })),
        }),
      }),
    }));
    expect(result).toMatchObject({ exitCode: 0, generation: SET_ID, next: "apply --set", applied: false });
    expect(result.evidence).toMatchObject({ daemonPresent: true, daemonStorageBackend: "sqlite", "member.1.generationId": GENERATIONS[1] });
  });

  it("refuses before the candidate on each failed preflight step", async () => {
    const homeDir = base.homeDir;
    const target = envelope("plan", await performSetPlan({ homeDir, _operationsForTesting: ops({ resolveTargetConfig: () => ({ status: "refuse", reason: "migration-target-missing" }) }) }));
    expect(target).toMatchObject({ exitCode: 2, refusal: { reason: "migration-target-missing" } });
    const withDetail = envelope("plan", await performSetPlan({ homeDir, _operationsForTesting: ops({ resolveTargetConfig: () => ({ status: "refuse", reason: "migration-target-unresolvable", evidence: "SyntaxError" }) }) }));
    expect(withDetail.evidence).toEqual({ detail: "SyntaxError" });
    const presence = envelope("plan", await performSetPlan({ homeDir, _operationsForTesting: ops({ classifyPresence: async () => ({ status: "unresolvable", evidence: "pid" }) }) }));
    expect(presence).toMatchObject({ exitCode: 5, refusal: { reason: "daemon-presence-unresolvable" } });
    const reach = envelope("plan", await performSetPlan({ homeDir, _operationsForTesting: ops({ verifyReachability: async () => ({ status: "refuse", reason: "migration-target-verification-failed" }) }) }));
    expect(reach).toMatchObject({ exitCode: 2, refusal: { reason: "migration-target-verification-failed" } });
    const reachDetail = envelope("plan", await performSetPlan({ homeDir, _operationsForTesting: ops({ verifyReachability: async () => ({ status: "refuse", reason: "migration-target-verification-unresolvable", evidence: "ECONNREFUSED" }) }) }));
    expect(reachDetail.evidence).toEqual({ detail: "ECONNREFUSED" });
  });

  it.each([
    ["cutover-set-single-project", 2, "set-refused-precondition", "cutover-set-single-project"],
    ["publication-occupies-slot", 4, "set-refused-contention", "publication-occupies-slot"],
    ["journal-unresolvable", 5, "set-refused-evidence", "journal-unresolvable"],
    ["capture-failed", 7, "set-operator-required", "capture-failed"],
    ["hold-entry-precondition", 2, "set-refused-precondition", "hold-entry-precondition"],
    ["confirmation-missing", 5, "set-refused-evidence", "unrecognized"],
    ["something-brand-new", 5, "set-refused-evidence", "unrecognized"],
  ])("classifies the candidate refusal %s into its shared bucket", async (reason, exitCode, bucket, serviceReason) => {
    const result = envelope("plan", await performSetPlan({
      homeDir: base.homeDir,
      _operationsForTesting: ops({ resolveCandidate: async () => ({ status: "refuse", reason, projects: [PROJECTS[1]!, PROJECTS[0]!] }) }),
    }));
    expect(result).toMatchObject({ exitCode, applied: false, refusal: { reason: bucket } });
    expect(result.evidence).toMatchObject({
      scope: "cutover-set", serviceCommand: "plan", serviceReason, "failure.0.projectId": PROJECTS[0], "failure.1.projectId": PROJECTS[1],
    });
  });

  it("turns an unclassified throw into one closed refusal, conservatively applied for a mutating command", async () => {
    const boom = ops({ resolveCandidate: async () => { throw new TypeError("secret /home/x"); } });
    const plan = envelope("plan", await performSetPlan({ homeDir: base.homeDir, _operationsForTesting: boom }));
    expect(plan).toMatchObject({ exitCode: 5, applied: false, refusal: { reason: "unexpected-failure" }, evidence: { detail: "TypeError" } });
    const apply = envelope("apply", await performSetApply({ homeDir: base.homeDir, confirmGenerationId: SET_ID, _operationsForTesting: boom }));
    expect(apply).toMatchObject({ exitCode: 5, applied: true, evidence: { scope: "cutover-set", writeObservation: "unresolvable", detail: "TypeError" } });
    expect(JSON.stringify(apply)).not.toContain("/home/x");
  });
});

describe("dry-run --set: the source check only", () => {
  let base!: ReturnType<typeof craftedHome>;
  beforeEach(() => { base = craftedHome(["absent", "absent"]); });
  const hashes = [PROJECTS[0]!, PROJECTS[1]!];
  const dryRun = { sourceSelectionSha256: "a".repeat(64), sourceByteWitnessSha256: "b".repeat(64), checksumSha256: "c".repeat(64), roles: [{}, {}], inspectedAt: "2026-01-01T00:00:00.000Z" };
  const ops = (extra: Record<string, unknown> = {}) => ({
    enumerate: () => ({ status: "resolved", projectHashes: hashes }),
    readMapSnapshot: () => Object.fromEntries(hashes.map((hash) => [hash, { canonical: "/x/" + hash.slice(0, 4), aliases: [] }])),
    dryRunSource: async () => dryRun,
    ...extra,
  } as unknown as Partial<MigrationSetOperations>);

  it("checks every member's source, with the enumeration suppressing any backfill, and calls no service", async () => {
    const seen: unknown[] = [];
    const result = envelope("dry-run", await performSetDryRun({
      homeDir: base.homeDir,
      _operationsForTesting: ops({ enumerate: (input: unknown) => { seen.push(input); return { status: "resolved", projectHashes: [...hashes].reverse() }; } }),
    }));
    expect(seen).toEqual([{ homeDir: base.homeDir, suppressMetadataBackfill: true }]);
    expect(result).toMatchObject({ exitCode: 0, applied: false, generation: null, next: "plan --set" });
    expect(result.evidence).toMatchObject({
      scope: "cutover-set", memberCount: 2, "member.0.projectId": hashes[0], "member.0.roleCount": 2, "member.1.state": "source-checked",
      "member.1.sourceByteWitnessSha256": "b".repeat(64),
    });
  });

  it("refuses a single-project home, an uncovered member, an unresolvable enumeration and a failing source", async () => {
    const homeDir = base.homeDir;
    const single = envelope("dry-run", await performSetDryRun({ homeDir, _operationsForTesting: ops({ enumerate: () => ({ status: "resolved", projectHashes: [hashes[0]!] }) }) }));
    expect(single).toMatchObject({ exitCode: 2, evidence: { serviceReason: "cutover-set-single-project" } });
    const uncovered = envelope("dry-run", await performSetDryRun({ homeDir, _operationsForTesting: ops({ readMapSnapshot: () => ({ [hashes[0]!]: { canonical: "/x", aliases: [] } }) }) }));
    expect(uncovered).toMatchObject({ exitCode: 2, evidence: { serviceReason: "cutover-set-uncovered-member", "failure.0.projectId": hashes[1] } });
    const unresolvable = envelope("dry-run", await performSetDryRun({ homeDir, _operationsForTesting: ops({ enumerate: () => ({ status: "unresolvable", reason: "x", detail: "/secret" }) }) }));
    expect(unresolvable).toMatchObject({ exitCode: 5, evidence: { serviceReason: "cutover-set-enumeration-unresolvable" } });
    expect(JSON.stringify(unresolvable)).not.toContain("/secret");
    const failing = envelope("dry-run", await performSetDryRun({ homeDir, _operationsForTesting: ops({ dryRunSource: async () => { throw new RangeError("boom"); } }) }));
    expect(failing).toMatchObject({ exitCode: 5, refusal: { reason: "dry-run-failed" }, evidence: { detail: "RangeError", "failure.0.projectId": hashes[0] } });
  });

  it("classifies a refusal from the existing consumer admission without bypassing it", async () => {
    const held = new BackendPublicationJournalError("unresolved-publication", "held");
    const contention = envelope("dry-run", await performSetDryRun({ homeDir: base.homeDir, _operationsForTesting: ops({ enumerate: () => { throw held; } }) }));
    expect(contention).toMatchObject({ exitCode: 4, refusal: { reason: "set-refused-contention" } });
    const other = envelope("dry-run", await performSetDryRun({ homeDir: base.homeDir, _operationsForTesting: ops({ enumerate: () => { throw new BackendPublicationJournalError("unsafe-storage", "x"); } }) }));
    expect(other).toMatchObject({ exitCode: 5, refusal: { reason: "set-refused-evidence" } });
    const plain = envelope("dry-run", await performSetDryRun({ homeDir: base.homeDir, _operationsForTesting: ops({ enumerate: () => { throw new Error("x"); } }) }));
    expect(plain).toMatchObject({ exitCode: 5, refusal: { reason: "set-refused-evidence" } });
  });
});

describe("apply --set", () => {
  let home!: ReturnType<typeof craftedHome>;
  beforeEach(() => { home = craftedHome(["absent", "absent"]); });
  const candidate = {
    status: "candidate", disposition: "continue-held", setId: SET_ID,
    members: GENERATIONS.map((generationId, index) => ({ physicalProjectId: PROJECTS[index]!, generationId })),
  } as const;
  const ops = (parts: Parts, extra: Record<string, unknown> = {}) =>
    setOperations(home, parts, { resolveCandidate: async () => candidate, ...extra } as Partial<MigrationSetOperations>);
  const prepared = (members: readonly ("verified" | "blocked" | "pending")[], extra: object = {}) => ({
    setId: SET_ID, identityMutation: [],
    members: members.map((state, index) => ({ physicalProjectId: PROJECTS[index]!, generationId: GENERATIONS[index]!, state })),
    ...extra,
  });

  it("refuses a missing or moved confirmation, and stops at the preview without calling the service", async () => {
    let calls = 0;
    const prepare = async () => { calls += 1; return prepared(["verified", "verified"]); };
    const missing = envelope("apply", await performSetApply({ homeDir: home.homeDir, _operationsForTesting: ops({}, { prepare }) }));
    expect(missing).toMatchObject({ exitCode: 3, generation: SET_ID, refusal: { reason: "set-confirmation-missing" } });
    const moved = envelope("apply", await performSetApply({ homeDir: home.homeDir, confirmGenerationId: "other", _operationsForTesting: ops({}, { prepare }) }));
    expect(moved).toMatchObject({ exitCode: 3, refusal: { reason: "set-confirmation-moved" } });
    const preview = envelope("apply", await performSetApply({ homeDir: home.homeDir, confirmGenerationId: SET_ID, dryRun: true, _operationsForTesting: ops({}, { prepare }) }));
    expect(preview).toMatchObject({ exitCode: 0, applied: false, next: "apply --set (drop --dry-run to prepare for real)" });
    expect(calls).toBe(0);
  });

  it("refuses before the confirmation on a preflight or candidate refusal", async () => {
    const refused = envelope("apply", await performSetApply({ homeDir: home.homeDir, confirmGenerationId: SET_ID, _operationsForTesting: ops({}, { classifyPresence: async () => ({ status: "unresolvable", evidence: "x" }) }) }));
    expect(refused.refusal?.reason).toBe("daemon-presence-unresolvable");
    const candidateRefusal = envelope("apply", await performSetApply({ homeDir: home.homeDir, confirmGenerationId: SET_ID, _operationsForTesting: ops({}, { resolveCandidate: async () => ({ status: "refuse", reason: "publication-occupies-slot" }) }) }));
    expect(candidateRefusal).toMatchObject({ exitCode: 4, applied: false });
  });

  it("passes the batch limits to the service and prepares once", async () => {
    const seen: unknown[] = [];
    const done = craftedHome(["verified", "verified"]);
    const result = envelope("apply", await performSetApply({
      homeDir: done.homeDir, confirmGenerationId: SET_ID, maxRecords: 7, maxBytes: 9,
      _operationsForTesting: ops(PREPARED, { prepare: async (input: unknown) => { seen.push(input); return prepared(["verified", "verified"]); } }),
    }));
    expect(seen).toEqual([expect.objectContaining({ confirmSetId: SET_ID, maxRecords: 7, maxBytes: 9 })]);
    expect(result).toMatchObject({ exitCode: 0, manifestPhase: "verified", next: "activate --set" });
  });

  it("reads the postcondition back instead of trusting a prepared result", async () => {
    const result = envelope("apply", await performSetApply({
      homeDir: home.homeDir, confirmGenerationId: SET_ID, _operationsForTesting: ops(PREPARING, { prepare: async () => prepared(["verified", "verified"]) }),
    }));
    expect(result).toMatchObject({ exitCode: 5, applied: true, refusal: { reason: "set-refused-evidence" }, evidence: { serviceReason: "readback-mismatch", setState: "prepare" } });
  });

  it("maps preparation refusals, counting identity mints as writes", async () => {
    const refuse = (reason: string, extra: object = {}) => async () => ({
      status: "refuse", reason, setId: null, identityMutation: [{ physicalProjectId: PROJECTS[0], effects: [{ stage: "local", outcome: "persisted" }] }], ...extra,
    });
    const minted = envelope("apply", await performSetApply({ homeDir: home.homeDir, confirmGenerationId: SET_ID, _operationsForTesting: ops({}, { prepare: refuse("hold-entry-contention", { projects: [PROJECTS[1]] }) }) }));
    expect(minted).toMatchObject({ exitCode: 4, applied: true, evidence: { serviceReason: "hold-entry-contention", "failure.0.projectId": PROJECTS[1] } });
    const reused = async () => ({ status: "refuse", reason: "cutover-set-authority-drifted", setId: SET_ID, identityMutation: [{ physicalProjectId: PROJECTS[0], effects: [{ stage: "local", outcome: "reused" }] }] });
    const unchanged = envelope("apply", await performSetApply({ homeDir: home.homeDir, confirmGenerationId: SET_ID, _operationsForTesting: ops({}, { prepare: reused }) }));
    expect(unchanged).toMatchObject({ exitCode: 5, applied: false });
    const moved = envelope("apply", await performSetApply({ homeDir: home.homeDir, confirmGenerationId: SET_ID, _operationsForTesting: ops({}, { prepare: refuse("confirmation-generation-moved") }) }));
    expect(moved).toMatchObject({ exitCode: 3, refusal: { reason: "set-confirmation-moved" } });
  });

  it("cannot exclude a write when the state around the service cannot be read", async () => {
    const result = envelope("apply", await performSetApply({
      homeDir: home.homeDir, confirmGenerationId: SET_ID,
      _operationsForTesting: ops({ journal: { kind: "unresolvable", evidence: "journal-x" } }, {
        prepare: async () => ({ status: "refuse", reason: "cutover-set-rollback-held", setId: SET_ID, identityMutation: [] }),
      }),
    }));
    expect(result).toMatchObject({ exitCode: 2, applied: true, evidence: { writeObservation: "unresolvable", serviceReason: "cutover-set-rollback-held" } });
  });

  const blocked = (reason: string) => async () => {
    const result = prepared(["verified", "blocked"], { status: "blocked", reason, blockedProject: PROJECTS[1] });
    return { ...result, members: result.members.map((member) => member.state === "blocked" ? { ...member, reason } : member) };
  };
  it.each([
    ["member-snapshot-partial", PREPARING, 2, "abort --set"],
    ["capture-contention", PREPARING, 4, "resume --set"],
    ["member-verification-failed", PREPARING, 5, null],
    ["copy-failed", PREPARING, 7, null],
    ["cancelled", { journal: holdJournal(), snapshot: "complete", eligible: false }, 6, "resume --set"],
    ["cancelled", { journal: holdJournal(), snapshot: "tampered", eligible: false }, 5, null],
  ])("maps the blocked reason %s (state %#)", async (reason, parts, exitCode, next) => {
    const result = envelope("apply", await performSetApply({ homeDir: home.homeDir, confirmGenerationId: SET_ID, _operationsForTesting: ops(parts, { prepare: blocked(reason) }) }));
    expect(result).toMatchObject({ exitCode, next });
    expect(result.evidence).toMatchObject({ "member.1.state": "blocked", "member.1.reason": reason, blockedProjectId: PROJECTS[1] });
  });
});

