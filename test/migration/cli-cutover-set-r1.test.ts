import { beforeEach, describe, expect, it } from "vitest";
import {
  performSetActivate, performSetApply, performSetPlan, performSetReport, performSetResume, performSetRollback,
  type MigrationSetOperations, type MigrationSetOutcome,
} from "../../src/migration/cli-cutover-set.js";
import { observeSet } from "../../src/migration/cli-cutover-set-state.js";
import { renderMigrationSetEnvelope } from "../../src/migration/cli-render.js";
import { migrationCommandContract, type MigrationCommandName } from "../../src/migration/exit-classes.js";
import { deriveCutoverSetRollbackSetId } from "../../src/migration/cutover-set-rollback-store.js";
import {
  ABSENT_JOURNAL, GENERATIONS, PROJECTS, SET_ID, craftedHome, holdJournal, observation, publicationJournal,
  resolvedActivation, resolvedRollback, setOperations,
} from "../fixtures/cli-cutover-set.js";

const REVERSE_ID = deriveCutoverSetRollbackSetId(SET_ID);
type Parts = Parameters<typeof setOperations>[1];

function envelope(command: MigrationCommandName, outcome: MigrationSetOutcome) {
  const rendered = renderMigrationSetEnvelope(command, outcome);
  expect(migrationCommandContract(command).canEmit).toContain(rendered.exitCode);
  return rendered;
}

const select = { generation: SET_ID, confirmGenerationId: SET_ID };
const reverseHold = (phase = "maintenance-held") => holdJournal({ setId: REVERSE_ID, sourceBackend: "postgresql", phase });
const members = (manifest: string) => GENERATIONS.map((generationId, index) => ({
  physicalProjectId: PROJECTS[index]!, generationId, manifest, evidence: null, reason: null, detail: null, successorFencingToken: null,
}));
const rollbackMembers = (manifest: string) => GENERATIONS.map((generationId, index) => ({
  physicalProjectId: PROJECTS[index]!, generationId, remoteProjectId: "r" + String(index), manifest, mode: "post-write" as const,
  installedGenerationId: "i" + String(index), reason: null, detail: null,
}));

describe("F1: plan and dry-run stay inside their frozen exit contract", () => {
  let home!: ReturnType<typeof craftedHome>;
  beforeEach(() => { home = craftedHome(["absent", "absent"]); });

  it.each(["capture-failed", "generation-invalid-input", "entering-recovery-unclassified", "cancelled"])(
    "folds the mutation-class candidate refusal %s into evidence and keeps its attribution",
    async (reason) => {
      const result = envelope("plan", await performSetPlan({
        homeDir: home.homeDir,
        _operationsForTesting: setOperations(home, {}, { resolveCandidate: async () => ({ status: "refuse", reason }) }),
      }));
      expect(result).toMatchObject({ exitCode: 5, refusal: { reason: "set-refused-evidence" } });
      expect(result.evidence).toMatchObject({ serviceCommand: "plan", serviceReason: reason });
    },
  );
});

describe("F2: report fails when the evidence it reads is unreadable", () => {
  const run = (stages: Parameters<typeof craftedHome>[0], parts: Parts, ops: Partial<MigrationSetOperations> = {}) => {
    const home = craftedHome(stages);
    return performSetReport({ homeDir: home.homeDir, generation: SET_ID, _operationsForTesting: setOperations(home, parts, ops) });
  };

  it("keeps reporting a legitimately preparing set", async () => {
    expect(envelope("report", await run(["absent", "absent"], { journal: holdJournal({ phase: "maintenance-entering" }), snapshot: "absent" })))
      .toMatchObject({ exitCode: 0, next: "resume --set" });
    expect(envelope("report", await run(["copied", "copied"], { journal: holdJournal(), snapshot: "partial", eligible: false })))
      .toMatchObject({ exitCode: 0, next: "resume --set" });
  });

  it("refuses with the rows it read when a member manifest cannot be read", async () => {
    const bad = holdJournal();
    (bad as { journal: { cutoverSet: { manifest: { members: { generationId: string }[] } } } }).journal.cutoverSet.manifest.members[1]!.generationId = "bad id";
    const result = envelope("report", await run(["copied", "copied"], { journal: bad }));
    expect(result).toMatchObject({ exitCode: 5, refusal: { reason: "report-evidence-unresolvable" }, applied: false });
    expect(result.evidence).toMatchObject({ "member.0.state": "copied", "member.1.state": "unresolvable", "member.1.reason": "manifest-unresolvable" });
  });

  it("refuses when a member snapshot cannot be classified", async () => {
    const result = envelope("report", await run(["copied", "copied"], { journal: holdJournal() }, {
      observation: { ...observation({ journal: holdJournal() }), classifySnapshot: async () => { throw new Error("no"); } },
    }));
    expect(result).toMatchObject({ exitCode: 5, refusal: { reason: "report-evidence-unresolvable" } });
    expect(result.evidence).toMatchObject({ "member.0.snapshot": "unresolvable", "member.0.reason": "snapshot-unresolvable" });
  });

  it("refuses when a verified member's referenced report cannot be read", async () => {
    const result = envelope("report", await run(["verified", "verified"], { journal: holdJournal(), eligible: false }));
    expect(result).toMatchObject({ exitCode: 5, refusal: { reason: "report-evidence-unresolvable" } });
    expect(result.evidence).toMatchObject({ "member.0.state": "verified", "member.0.reason": "verification-evidence" });
  });
});

describe("F3: exit 6 needs a durable state that admits the same service", () => {
  let active!: ReturnType<typeof craftedHome>;
  let prepared!: ReturnType<typeof craftedHome>;
  beforeEach(() => { active = craftedHome(["active", "active"]); prepared = craftedHome(["verified", "verified"]); });

  const blocked = { originalSetId: SET_ID, setId: REVERSE_ID, status: "blocked", step: "build", member: GENERATIONS[0], reason: "build-failed", detail: "d", members: rollbackMembers("active") };
  const rollbackAfter = async (after: Parts) => {
    const state: Parts = { journal: reverseHold(), activation: resolvedActivation(), rollback: resolvedRollback(false) };
    return performSetRollback({
      homeDir: active.homeDir, ...select, confirmBackend: "sqlite",
      _operationsForTesting: setOperations(active, state, { rollback: (async () => { Object.assign(state, after); return blocked; }) as never }),
    });
  };
  const owned: Parts = { journal: reverseHold(), activation: resolvedActivation(), rollback: resolvedRollback(false) };

  it("keeps exit 6 for a blocked rollback whose own hold is still live, or whose publication carries the selection", async () => {
    expect(envelope("rollback", await rollbackAfter(owned))).toMatchObject({ exitCode: 6, next: "resume --set" });
    expect(envelope("rollback", await rollbackAfter(owned))).toMatchObject({ refusal: { reason: "set-incomplete" } });
    const published = { journal: publicationJournal(REVERSE_ID), activation: resolvedActivation(), rollback: resolvedRollback(true) };
    expect(envelope("rollback", await rollbackAfter(published))).toMatchObject({ exitCode: 6 });
    for (const phase of ["maintenance-entering", "selection-prepared", "selection-completed"]) {
      expect(envelope("rollback", await rollbackAfter({ ...owned, journal: reverseHold(phase), rollback: resolvedRollback(phase !== "maintenance-entering") })))
        .toMatchObject({ exitCode: 6 });
    }
  });

  it.each([
    ["an empty slot", { journal: ABSENT_JOURNAL }],
    ["another hold", { journal: holdJournal({ setId: "other" }) }],
    ["an aborted own hold", { journal: reverseHold("maintenance-aborted") }],
    ["a reverse publication without the frozen selection", { journal: publicationJournal(REVERSE_ID) }],
    ["a selection-prepared hold without the frozen selection", { journal: reverseHold("selection-prepared") }],
    ["a selection-completed hold without the frozen selection", { journal: reverseHold("selection-completed") }],
  ])("does not claim exit 6 for a blocked rollback once %s replaced the hold", async (_name, slot) => {
    const result = envelope("rollback", await rollbackAfter({ ...owned, ...slot }));
    expect(result).toMatchObject({ exitCode: 5, next: null, refusal: { reason: "set-refused-evidence" } });
  });

  const interrupted = { status: "interrupted", setId: SET_ID, publicationId: SET_ID, step: "S11", cause: "lease-lost", detail: "d", effectBegun: true, applied: "no", members: members("verified") };
  const activateAfter = async (start: Parts, after: Parts, home = prepared) => {
    const state: Parts = { ...start };
    return performSetActivate({
      homeDir: home.homeDir, ...select, confirmBackend: "postgresql",
      _operationsForTesting: setOperations(home, state, { activate: (async () => { Object.assign(state, after); return interrupted; }) as never }),
    });
  };
  const activating: Parts = { journal: holdJournal({ phase: "selection-prepared" }), activation: resolvedActivation(false) };

  it("keeps exit 6 for an interrupted activation that still owns a live hold or a selected publication", async () => {
    const selected = { journal: holdJournal({ phase: "selection-prepared" }), activation: resolvedActivation(true) };
    expect(envelope("activate", await activateAfter(activating, selected))).toMatchObject({ exitCode: 6 });
    const completed = { journal: holdJournal({ phase: "selection-completed" }), activation: resolvedActivation(true) };
    expect(envelope("activate", await activateAfter(activating, completed))).toMatchObject({ exitCode: 6 });
    expect(envelope("activate", await activateAfter({ journal: holdJournal() }, { journal: holdJournal() }))).toMatchObject({ exitCode: 6 });
    const published = { journal: publicationJournal(), activation: resolvedActivation(true) };
    expect(envelope("activate", await activateAfter(activating, published))).toMatchObject({ exitCode: 6 });
  });

  it.each([
    ["a checkpoint-only record with the hold gone", { journal: ABSENT_JOURNAL, activation: resolvedActivation(false) }],
    ["another hold", { journal: holdJournal({ setId: "other" }), activation: resolvedActivation(false) }],
    ["an aborted own hold", { journal: holdJournal({ phase: "maintenance-aborted" }), activation: resolvedActivation(false) }],
    ["a publication without the frozen selection", { journal: publicationJournal(), activation: resolvedActivation(false) }],
    ["a selection-prepared hold without the frozen selection", { journal: holdJournal({ phase: "selection-prepared" }), activation: resolvedActivation(false) }],
    ["a selection-completed hold without the frozen selection", { journal: holdJournal({ phase: "selection-completed" }), activation: resolvedActivation(false) }],
  ])("does not claim exit 6 for an interrupted activation with %s", async (_name, after) => {
    const result = envelope("activate", await activateAfter(activating, after));
    expect(result).toMatchObject({ exitCode: 4, next: null });
  });
});

describe("F4: applied reports the effects of this invocation", () => {
  let active!: ReturnType<typeof craftedHome>;
  beforeEach(() => { active = craftedHome(["active", "active"]); });
  const owned: Parts = { journal: reverseHold(), activation: resolvedActivation(), rollback: resolvedRollback(false) };
  const run = (result: object, after: Parts | null) => {
    const state: Parts = { ...owned };
    return performSetRollback({
      homeDir: active.homeDir, ...select, confirmBackend: "sqlite",
      _operationsForTesting: setOperations(active, state, { rollback: (async () => { if (after !== null) Object.assign(state, after); return result; }) as never }),
    });
  };
  const base = { originalSetId: SET_ID, setId: REVERSE_ID, members: rollbackMembers("active") };
  const blocked = (step: string, reason = "not-eligible") => ({ ...base, status: "blocked", step, member: GENERATIONS[0], reason, detail: "d" });
  const interrupted = (step: string, effectBegun: boolean) => ({ ...base, status: "interrupted", step, cause: "hold-gone", detail: "d", effectBegun });

  it("is false for a blocked or interrupted re-entry that left every durable observation unchanged", async () => {
    expect(envelope("rollback", await run(blocked("classify"), null))).toMatchObject({ exitCode: 2, applied: false });
    expect(envelope("rollback", await run(interrupted("hold", false), null))).toMatchObject({ exitCode: 7, applied: false });
    expect(envelope("rollback", await run(interrupted("hold", true), null))).toMatchObject({ exitCode: 7, applied: false });
  });

  it("is true when the fingerprint moved", async () => {
    const moved = { ...owned, journal: reverseHold("maintenance-aborted") };
    const result = envelope("rollback", await run(blocked("classify"), moved));
    expect(result).toMatchObject({ applied: true });
    expect(result.evidence).not.toHaveProperty("writeObservation");
  });

  it("is true with the unresolvable marker when the observation after the call cannot be read", async () => {
    const result = envelope("rollback", await run(blocked("classify"), { journal: { kind: "unresolvable", evidence: "x" } }));
    expect(result).toMatchObject({ applied: true, evidence: { writeObservation: "unresolvable" } });
  });

  it.each(["artifact", "build", "install"])("cannot exclude a write at step %s even when every record is unchanged", async (step) => {
    const result = envelope("rollback", await run(blocked(step), null));
    expect(result).toMatchObject({ applied: true, evidence: { writeObservation: "unresolvable" } });
  });

  it("cannot exclude a write when a re-entry is interrupted at completion with every record unchanged", async () => {
    const result = envelope("rollback", await run(interrupted("completion", true), null));
    expect(result).toMatchObject({ exitCode: 7, applied: true, evidence: { writeObservation: "unresolvable" } });
  });

  it("is true for a settled success only when something changed, and keeps a changed readback true", async () => {
    const done = { ...base, status: "rolled-back", publicationId: REVERSE_ID, members: rollbackMembers("rolled-back"), resumedFrom: "settled" };
    const rolled = craftedHome(["rolled-back", "rolled-back"]);
    const settledState: Parts = { journal: publicationJournal(REVERSE_ID), activation: resolvedActivation(), rollback: resolvedRollback() };
    const ops = setOperations(rolled, settledState, { rollback: (async () => done) as never, observeRestart: (async () => ({ restart: { answer: "satisfied", presence: "absent" }, evidence: {} })) as never });
    const result = envelope("rollback", await performSetRollback({ homeDir: rolled.homeDir, ...select, confirmBackend: "sqlite", _operationsForTesting: ops }));
    expect(result).toMatchObject({ exitCode: 0, applied: false });
    const moving: Parts = { ...settledState, journal: publicationJournal("someone-else") };
    const changed = setOperations(rolled, moving, { rollback: (async () => { Object.assign(moving, settledState); return done; }) as never, observeRestart: (async () => ({ restart: { answer: "satisfied", presence: "absent" }, evidence: {} })) as never });
    expect(envelope("rollback", await performSetRollback({ homeDir: rolled.homeDir, ...select, confirmBackend: "sqlite", _operationsForTesting: changed })))
      .toMatchObject({ exitCode: 0, applied: true });
  });
});

describe("a checkpoint refusal reports the member records it wrote (#1667)", () => {
  let active!: ReturnType<typeof craftedHome>;
  beforeEach(() => { active = craftedHome(["active", "active"]); });
  const EMPTY = { state: "authoritatively-absent", cause: "empty" } as never;
  const incomplete = (memberRecords: number) => ({ state: "authoritatively-absent", cause: "checkpoint-incomplete", memberRecords }) as never;
  const settled = (rollback: unknown): Parts => ({ journal: publicationJournal(), activation: resolvedActivation(), rollback: rollback as never });
  const refused = (step: string, reason: string) => ({ originalSetId: SET_ID, setId: REVERSE_ID, status: "refused", step, reason, detail: "d", members: rollbackMembers("active"), effectBegun: false });
  const run = (start: Parts, result: object, after: Parts) => {
    const state: Parts = { ...start };
    return performSetRollback({
      homeDir: active.homeDir, ...select, confirmBackend: "sqlite",
      _operationsForTesting: setOperations(active, state, { rollback: (async () => { Object.assign(state, after); return result; }) as never }),
    });
  };
  const checkpoint = refused("checkpoint", "activation-unresolvable");

  it("is applied when the refused call left member records of an uncommitted checkpoint", async () => {
    const result = envelope("rollback", await run(settled(EMPTY), checkpoint, settled(incomplete(1))));
    expect(result).toMatchObject({ exitCode: 5, applied: true, evidence: { serviceStep: "checkpoint" } });
    expect(result.evidence).not.toHaveProperty("writeObservation");
    expect(envelope("rollback", await run(settled(incomplete(1)), checkpoint, settled(incomplete(2))))).toMatchObject({ applied: true });
  });

  it("is not applied when the refused call left the stored records as they were", async () => {
    expect(envelope("rollback", await run(settled(EMPTY), checkpoint, settled(EMPTY)))).toMatchObject({ exitCode: 5, applied: false });
    expect(envelope("rollback", await run(settled(incomplete(1)), checkpoint, settled(incomplete(1))))).toMatchObject({ applied: false });
  });

  it("is applied with the unresolvable marker when the records after the refusal cannot be read", async () => {
    const result = envelope("rollback", await run(settled(EMPTY), checkpoint, settled({ state: "unresolvable", reason: "r" })));
    expect(result).toMatchObject({ applied: true, evidence: { writeObservation: "unresolvable" } });
  });

  it("keeps the unobserved fast path for a refusal at any other step", async () => {
    const result = envelope("rollback", await run(settled(EMPTY), refused("records", "activation-not-completed"), settled(incomplete(1))));
    expect(result).toMatchObject({ exitCode: 2, applied: false });
  });

  it("is applied, without the unresolvable marker, when the refusal states it published the reverse artifact (#1746)", async () => {
    const published = { ...checkpoint, artifactPublished: true };
    const result = envelope("rollback", await run(settled(EMPTY), published, settled(EMPTY)));
    expect(result).toMatchObject({ exitCode: 5, applied: true, evidence: { serviceStep: "checkpoint" } });
    expect(result.evidence).not.toHaveProperty("writeObservation");
  });

  it("keeps the unresolvable marker for a refusal that states an artifact write when the records cannot be read (#1746)", async () => {
    const published = { ...checkpoint, artifactPublished: true };
    const result = envelope("rollback", await run(settled(EMPTY), published, settled({ state: "unresolvable", reason: "r" })));
    expect(result).toMatchObject({ exitCode: 5, applied: true, evidence: { writeObservation: "unresolvable" } });
  });
});

describe("F5: an explicit bucket never whitelists an unknown reason", () => {
  let home!: ReturnType<typeof craftedHome>;
  beforeEach(() => { home = craftedHome(["absent", "absent"]); });

  it("reports a canary preparation reason as unrecognized, in the refusal and in the member row", async () => {
    const candidate = { status: "candidate", disposition: "continue-held", setId: SET_ID, members: GENERATIONS.map((generationId, index) => ({ physicalProjectId: PROJECTS[index]!, generationId })) } as const;
    const result = envelope("apply", await performSetApply({
      homeDir: home.homeDir, confirmGenerationId: SET_ID,
      _operationsForTesting: setOperations(home, { journal: holdJournal(), eligible: false }, {
        resolveCandidate: async () => candidate,
        prepare: (async () => ({
          status: "blocked", setId: SET_ID, reason: "canary-zzz", blockedProject: PROJECTS[1], identityMutation: [],
          members: [{ physicalProjectId: PROJECTS[0], generationId: GENERATIONS[0], state: "verified" }, { physicalProjectId: PROJECTS[1], generationId: GENERATIONS[1], state: "blocked", reason: "canary-zzz" }],
        })) as never,
      }),
    }));
    expect(result).toMatchObject({ exitCode: 5, evidence: { serviceReason: "unrecognized", "member.1.reason": "unrecognized" } });
    expect(JSON.stringify(result)).not.toContain("canary-zzz");
  });

  it("reports a canary activation member reason as unrecognized and keeps a known one", async () => {
    const prepared = craftedHome(["verified", "verified"]);
    const refused = (reason: string) => ({
      status: "refused", setId: SET_ID, step: "S2", reason: "cutover-set-member-evidence-stale", detail: "d", failures: [], effectBegun: false,
      members: members("verified").map((member, index) => index === 1 ? { ...member, reason } : member),
    });
    const run = (reason: string) => performSetActivate({
      homeDir: prepared.homeDir, ...select, confirmBackend: "postgresql",
      _operationsForTesting: setOperations(prepared, { journal: holdJournal() }, { activate: (async () => refused(reason)) as never }),
    });
    const canary = envelope("activate", await run("canary-yyy"));
    expect(canary.evidence["member.1.reason"]).toBe("unrecognized");
    expect(JSON.stringify(canary)).not.toContain("canary-yyy");
    expect(envelope("activate", await run("cutover-set-member-evidence-stale")).evidence["member.1.reason"]).toBe("cutover-set-member-evidence-stale");
  });
});

describe("F6: a terminal settlement needs its frozen selection", () => {
  const route = async (stages: Parameters<typeof craftedHome>[0], parts: Parts) => {
    const home = craftedHome(stages);
    return (await observeSet({ homeDir: home.homeDir, setId: SET_ID, _operationsForTesting: observation(parts) })).route;
  };

  it("treats all-active or all-rolled-back members without a selection as a contradiction, and with one as settled", async () => {
    expect(await route(["active", "active"], { journal: publicationJournal(), activation: resolvedActivation(false) })).toBe("contradiction");
    expect(await route(["active", "active"], { journal: publicationJournal(), activation: resolvedActivation(true) })).toBe("settled-activated");
    expect(await route(["rolled-back", "rolled-back"], { journal: publicationJournal(REVERSE_ID), activation: resolvedActivation(), rollback: resolvedRollback(false) })).toBe("contradiction");
    expect(await route(["rolled-back", "rolled-back"], { journal: publicationJournal(REVERSE_ID), activation: resolvedActivation(), rollback: resolvedRollback(true) })).toBe("settled-rolled-back");
  });

  it("does not let resume report a selection-less terminal shape as a successful no-op", async () => {
    const rolled = craftedHome(["rolled-back", "rolled-back"]);
    const result = envelope("resume", await performSetResume({
      homeDir: rolled.homeDir, ...select,
      _operationsForTesting: setOperations(rolled, { journal: publicationJournal(REVERSE_ID), activation: resolvedActivation(), rollback: resolvedRollback(false) }),
    }));
    expect(result).toMatchObject({ exitCode: 5, refusal: { reason: "set-refused-evidence" }, evidence: { serviceReason: "route-contradiction" } });
  });

  it("refuses a rollback success whose selection is missing on readback", async () => {
    const rolled = craftedHome(["rolled-back", "rolled-back"]);
    const moving: Parts = { journal: publicationJournal(REVERSE_ID), activation: resolvedActivation(), rollback: resolvedRollback(true) };
    const result = envelope("rollback", await performSetRollback({
      homeDir: rolled.homeDir, ...select, confirmBackend: "sqlite",
      _operationsForTesting: setOperations(rolled, moving, {
        rollback: (async () => {
          Object.assign(moving, { rollback: resolvedRollback(false) });
          return { originalSetId: SET_ID, setId: REVERSE_ID, status: "rolled-back", publicationId: REVERSE_ID, members: rollbackMembers("rolled-back"), resumedFrom: "settled" };
        }) as never,
      }),
    }));
    expect(result).toMatchObject({ exitCode: 5, evidence: { serviceReason: "readback-mismatch" } });
  });
});
