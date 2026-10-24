import { beforeEach, describe, expect, it } from "vitest";
import {
  performSetAbort, performSetActivate, performSetReport, performSetResume, performSetRollback, performSetVerify,
  type MigrationSetOperations, type MigrationSetOutcome,
} from "../../src/migration/cli-cutover-set.js";
import { renderMigrationSetEnvelope } from "../../src/migration/cli-render.js";
import { migrationCommandContract, type MigrationCommandName } from "../../src/migration/exit-classes.js";
import { deriveCutoverSetRollbackSetId } from "../../src/migration/cutover-set-rollback-store.js";
import {
  ABSENT_JOURNAL, GENERATIONS, PROJECTS, SET_ID, craftedHome, holdJournal, publicationJournal, resolvedActivation,
  resolvedRollback, setOperations,
} from "../fixtures/cli-cutover-set.js";

const REVERSE_ID = deriveCutoverSetRollbackSetId(SET_ID);
type Parts = Parameters<typeof setOperations>[1];

/** Renders the outcome and holds it to the command's frozen exit contract. */
function envelope(command: MigrationCommandName, outcome: MigrationSetOutcome) {
  const rendered = renderMigrationSetEnvelope(command, outcome);
  expect(migrationCommandContract(command).canEmit).toContain(rendered.exitCode);
  return rendered;
}

const PREPARED: Parts = { journal: holdJournal() };
const PREPARING: Parts = { journal: holdJournal(), eligible: false };
const ACTIVATING: Parts = { journal: holdJournal({ phase: "selection-prepared" }), activation: resolvedActivation(false) };
const ACTIVATED: Parts = { journal: publicationJournal(), activation: resolvedActivation() };
const ROLLING_BACK: Parts = { journal: publicationJournal(REVERSE_ID), activation: resolvedActivation(), rollback: resolvedRollback(false) };
const ROLLING_BACK_OWNED: Parts = { journal: holdJournal({ setId: REVERSE_ID, sourceBackend: "postgresql" }), activation: resolvedActivation(), rollback: resolvedRollback(false) };
const ROLLING_BACK_SELECTED: Parts = { journal: publicationJournal(REVERSE_ID), activation: resolvedActivation(), rollback: resolvedRollback(true) };
const ROLLED_BACK: Parts = { journal: publicationJournal(REVERSE_ID), activation: resolvedActivation(), rollback: resolvedRollback() };

const SATISFIED = { restart: { answer: "satisfied", presence: "absent" } as const, evidence: { selectedBackend: "postgresql" } };
const STALE = { reason: "cutover-restart-required", restart: { answer: "unsatisfied", presence: "running" } as const, evidence: { selectedBackend: "postgresql" } };
const CONTRADICTION = { reason: "cutover-restart-contradiction", restart: { answer: "satisfied", presence: "running" } as const, evidence: { selectedBackend: "sqlite" } };
const UNRESOLVABLE = { reason: "cutover-restart-unresolvable", restart: null, evidence: { selectedBackend: "sqlite" } };

const members = (manifest: string) => GENERATIONS.map((generationId, index) => ({
  physicalProjectId: PROJECTS[index]!, generationId, manifest, evidence: null, reason: null, detail: null, successorFencingToken: null,
}));
const rollbackMembers = (manifest: string) => GENERATIONS.map((generationId, index) => ({
  physicalProjectId: PROJECTS[index]!, generationId, remoteProjectId: "remote-" + String(index), manifest, mode: "post-write" as const,
  installedGenerationId: "installed-" + String(index), reason: null, detail: null,
}));

const select = { generation: SET_ID, confirmGenerationId: SET_ID };

describe("the shared selector, confirmation and route admission", () => {
  let home!: ReturnType<typeof craftedHome>;
  beforeEach(() => { home = craftedHome(["verified", "verified"]); });
  const commands = {
    verify: (extra: object, ops: object) => performSetVerify({ homeDir: home.homeDir, ...extra, _operationsForTesting: ops }),
    resume: (extra: object, ops: object) => performSetResume({ homeDir: home.homeDir, ...extra, _operationsForTesting: ops }),
    activate: (extra: object, ops: object) => performSetActivate({ homeDir: home.homeDir, confirmBackend: "postgresql", ...extra, _operationsForTesting: ops }),
    rollback: (extra: object, ops: object) => performSetRollback({ homeDir: home.homeDir, confirmBackend: "sqlite", ...extra, _operationsForTesting: ops }),
  } as const;
  const names = Object.keys(commands) as (keyof typeof commands)[];

  it.each(names)("%s --set requires an explicit, valid set id and the aggregate confirmation", async (name) => {
    const ops = setOperations(home, PREPARED) as object;
    expect(envelope(name, await commands[name]({}, ops))).toMatchObject({ exitCode: 2, refusal: { reason: "set-generation-required" }, applied: false });
    expect(envelope(name, await commands[name]({ generation: "no good" }, ops))).toMatchObject({ exitCode: 1, refusal: { reason: "set-generation-invalid" } });
    expect(envelope(name, await commands[name]({ generation: SET_ID }, ops))).toMatchObject({ exitCode: 3, generation: SET_ID, refusal: { reason: "set-confirmation-missing" } });
    expect(envelope(name, await commands[name]({ ...select, confirmGenerationId: GENERATIONS[0] }, ops))).toMatchObject({ exitCode: 3, refusal: { reason: "set-confirmation-moved" } });
  });

  it.each([["activate", "sqlite"], ["rollback", "postgresql"]] as const)("%s --set fences the backend it switches to", async (name, other) => {
    const ops = setOperations(home, ACTIVATED) as object;
    const missing = await (name === "activate" ? performSetActivate : performSetRollback)({ homeDir: home.homeDir, ...select, _operationsForTesting: ops });
    expect(envelope(name, missing)).toMatchObject({ exitCode: 3, refusal: { reason: "backend-confirmation-missing" } });
    const moved = await (name === "activate" ? performSetActivate : performSetRollback)({ homeDir: home.homeDir, ...select, confirmBackend: other, _operationsForTesting: ops });
    expect(envelope(name, moved)).toMatchObject({ exitCode: 3, refusal: { reason: "backend-confirmation-moved" } });
  });

  const refusals: ReadonlyArray<readonly [string, Parts, number, string]> = [
    ["an unknown set", {}, 2, "generation-unknown"],
    ["the reverse id", { journal: holdJournal({ sourceBackend: "postgresql" }) }, 2, "set-original-generation-required"],
    ["unreadable state", { journal: { kind: "unresolvable", evidence: "journal-x" } }, 5, "set-refused-evidence"],
    ["contradictory state", { journal: holdJournal({ phase: "selection-prepared" }) }, 5, "set-refused-evidence"],
    ["another set's hold", { journal: holdJournal({ setId: "other" }) }, 2, "set-refused-precondition"],
    ["a single-generation hold", { journal: holdJournal({ cutoverSet: false, generationId: "single" }) }, 2, "set-refused-precondition"],
  ];
  it.each(refusals)("refuses activate over %s", async (_name, parts, exitCode, reason) => {
    const result = envelope("activate", await commands.activate(select, setOperations(home, parts)));
    expect(result).toMatchObject({ exitCode, refusal: { reason }, applied: false });
  });

  it("names the owner when the route is not the command's", async () => {
    const result = envelope("activate", await commands.activate(select, setOperations(home, PREPARING)));
    expect(result).toMatchObject({ exitCode: 2, next: "resume --set", evidence: { serviceReason: "route-prepare", setState: "prepare" } });
    const single = envelope("activate", await commands.activate(select, setOperations(home, { journal: holdJournal({ cutoverSet: false, generationId: "single" }) })));
    expect(single).toMatchObject({ next: "resume", evidence: { serviceReason: "cutover-set-single-generation-held" } });
  });
});

describe("verify --set", () => {
  let verified!: ReturnType<typeof craftedHome>;
  beforeEach(() => { verified = craftedHome(["verified", "verified"]); });
  const run = (parts: Parts, extra: object = {}) => performSetVerify({ homeDir: verified.homeDir, ...select, ...extra, _operationsForTesting: setOperations(verified, parts) });

  it("confirms a prepared set from persisted evidence without writing", async () => {
    expect(envelope("verify", await run(PREPARED))).toMatchObject({
      exitCode: 0, applied: false, manifestPhase: "verified", next: "activate --set", generation: SET_ID,
      evidence: { setState: "prepared", memberCount: 2 },
    });
  });

  it("points an incomplete preparation at resume", async () => {
    expect(envelope("verify", await run(PREPARING))).toMatchObject({ exitCode: 2, next: "resume --set", refusal: { reason: "set-refused-precondition" } });
  });

  it("returns a non-predictive preview for --dry-run, never exit 0", async () => {
    const result = envelope("verify", await run(PREPARED, { dryRun: true }));
    expect(result).toMatchObject({ exitCode: 5, applied: false, refusal: { reason: "set-preview-not-predictive" } });
    expect(result.evidence).toMatchObject({ predictive: false, notEvaluated: "recomputation", setState: "prepared" });
  });
});

describe("activate --set", () => {
  let prepared!: ReturnType<typeof craftedHome>;
  beforeEach(() => { prepared = craftedHome(["verified", "verified"]); });
  let active!: ReturnType<typeof craftedHome>;
  beforeEach(() => { active = craftedHome(["active", "active"]); });
  const failures = [{ physicalProjectId: PROJECTS[1]!, generationId: GENERATIONS[1]!, reason: "cutover-set-member-evidence-stale" }];
  const run = (parts: Parts, result: unknown, extra: Partial<MigrationSetOperations> = {}, extraInput: object = {}, home = prepared) =>
    performSetActivate({
      homeDir: home.homeDir, ...select, confirmBackend: "postgresql", ...extraInput,
      _operationsForTesting: setOperations(home, parts, { activate: async () => result, combineRestart: async () => SATISFIED, ...extra } as Partial<MigrationSetOperations>),
    });

  it("previews without evaluating anything, and refuses a missing target before the service", async () => {
    let calls = 0;
    const activate = async () => { calls += 1; return {}; };
    const preview = envelope("activate", await run(PREPARED, {}, { activate: activate as never }, { dryRun: true }));
    expect(preview).toMatchObject({ exitCode: 5, applied: false, refusal: { reason: "set-preview-not-predictive" } });
    expect(preview.evidence).toMatchObject({ predictive: false, notEvaluated: "quiescence,coverage,lease,target-health,census,restart" });
    const noTarget = envelope("activate", await run(PREPARED, {}, { resolveTargetConfig: () => ({ status: "refuse", reason: "migration-target-missing" }), activate: activate as never }));
    expect(noTarget).toMatchObject({ exitCode: 2, refusal: { reason: "migration-target-missing" } });
    const withDetail = envelope("activate", await run(PREPARED, {}, { resolveTargetConfig: () => ({ status: "refuse", reason: "migration-target-unresolvable", evidence: "Error" }) }));
    expect(withDetail.evidence).toEqual({ detail: "Error" });
    expect(calls).toBe(0);
  });

  it("maps a refusal into its bucket and keeps every failing member", async () => {
    const refused = (reason: string, extra: object = {}) => ({ status: "refused", setId: SET_ID, step: "S2", reason, detail: "x", failures, members: members("verified"), effectBegun: false, ...extra });
    const stale = envelope("activate", await run(PREPARED, refused("cutover-set-member-evidence-stale")));
    expect(stale).toMatchObject({ exitCode: 2, applied: false, evidence: { serviceStep: "S2", serviceReason: "cutover-set-member-evidence-stale", "failure.0.projectId": PROJECTS[1], "failure.0.reason": "cutover-set-member-evidence-stale" } });
    expect(envelope("activate", await run(PREPARED, refused("lease-conflict")))).toMatchObject({ exitCode: 4 });
    expect(envelope("activate", await run(PREPARED, refused("state-unresolvable")))).toMatchObject({ exitCode: 5 });
    expect(envelope("activate", await run(PREPARED, refused("cutover-set-confirmation-mismatch")))).toMatchObject({ exitCode: 3, refusal: { reason: "set-confirmation-moved" } });
  });

  const interrupted = (cause: string, effectBegun: boolean) => ({ status: "interrupted", setId: SET_ID, publicationId: SET_ID, step: "S11", cause, detail: "d", effectBegun, applied: "unknown", members: members("verified") });
  it("maps an interruption by whether anything began and whether the durable state still admits the service", async () => {
    const notBegun = envelope("activate", await run(PREPARED, interrupted("lease-lost", false)));
    expect(notBegun).toMatchObject({ exitCode: 4, applied: false, evidence: { effectBegun: false, serviceCause: "lease-lost" } });
    expect(envelope("activate", await run(PREPARED, interrupted("state-unresolvable", false)))).toMatchObject({ exitCode: 5 });
    const admitted = envelope("activate", await run(ACTIVATING, interrupted("lease-lost", true)));
    expect(admitted).toMatchObject({ exitCode: 6, applied: true, next: "resume --set", evidence: { selectionApplied: "unknown", effectBegun: true } });
    const moving = { ...ACTIVATING };
    const gone = envelope("activate", await run(moving, interrupted("lease-lost", true), {
      activate: (async () => { Object.assign(moving, ROLLING_BACK); return interrupted("lease-lost", true); }) as never,
    }));
    expect(gone).toMatchObject({ exitCode: 4, next: null });
    expect(envelope("activate", await run(ACTIVATING, interrupted("binding-conflict", true)))).toMatchObject({ exitCode: 5, applied: true });
  });

  it("maps a failed publication and an unhealthy target", async () => {
    const failed = (status: string) => ({ status: "publication-failed", setId: SET_ID, publicationId: SET_ID, publication: { status }, members: members("verified") });
    expect(envelope("activate", await run(ACTIVATING, failed("fence-unsatisfied")))).toMatchObject({ exitCode: 4, applied: true, evidence: { servicePublicationStatus: "fence-unsatisfied" } });
    expect(envelope("activate", await run(ACTIVATING, failed("aborted")))).toMatchObject({ exitCode: 5 });
    const unhealthy = (health: object) => ({ status: "post-publication-unhealthy", setId: SET_ID, publicationId: SET_ID, health, restart: { status: "satisfied" }, members: members("active") });
    expect(envelope("activate", await run(ACTIVATING, unhealthy({ status: "unhealthy", reason: "schema-drift", detail: "d", sqlState: null }), { combineRestart: async () => STALE as never })))
      .toMatchObject({ exitCode: 5, applied: true, next: "resume --set", evidence: { selectionApplied: "yes", healthStatus: "unhealthy", healthReason: "schema-drift" } });
    expect(envelope("activate", await run(ACTIVATING, unhealthy({ status: "healthy", readiness: {} })))).toMatchObject({ exitCode: 5 });
  });

  const activated = (resumedFrom: string) => ({ status: "activated", setId: SET_ID, publicationId: "pub-1", members: members("active"), restart: { status: "satisfied" }, resumedFrom });
  it("reads every member back before success and applies the restart matrix", async () => {
    const fresh = envelope("activate", await run(ACTIVATED, activated("fresh"), {}, {}, active));
    expect(fresh).toMatchObject({
      exitCode: 0, applied: true, manifestPhase: "active", next: "swap-grants-then-start-daemon", restart: { answer: "satisfied", presence: "absent" },
      evidence: { setState: "settled-activated", publicationId: "pub-1", resumedFrom: "fresh", grantSwap: "required-before-daemon-start", "member.0.state": "active" },
    });
    expect(envelope("activate", await run(ACTIVATED, activated("settled-active"), {}, {}, active))).toMatchObject({ exitCode: 0, applied: false });
    const stale = envelope("activate", await run(ACTIVATED, activated("fresh"), { combineRestart: async () => STALE as never }, {}, active));
    expect(stale).toMatchObject({ exitCode: 8, next: "swap-grants-then-start-daemon", applied: true });
    const contradiction = envelope("activate", await run(ACTIVATED, activated("settled-active"), { combineRestart: async () => CONTRADICTION as never }, {}, active));
    expect(contradiction).toMatchObject({ exitCode: 5, next: "report --set", applied: false });
    const mismatch = envelope("activate", await run(ACTIVATING, activated("fresh"), {}, {}, prepared));
    expect(mismatch).toMatchObject({ exitCode: 5, applied: true, evidence: { serviceReason: "readback-mismatch" } });
  });

  it("fails closed on an unknown status, reason, cause or publication status", async () => {
    for (const result of [
      { status: "unheard-of", members: [] },
      { status: "refused", setId: SET_ID, step: "S1", reason: "brand-new", detail: "", failures: [], members: [], effectBegun: false },
      interrupted("brand-new", true),
      { status: "publication-failed", setId: SET_ID, publicationId: SET_ID, publication: { status: "brand-new" }, members: [] },
    ]) {
      expect(envelope("activate", await run(ACTIVATING, result))).toMatchObject({ exitCode: 5, applied: true, refusal: { reason: "unexpected-failure" } });
    }
  });
});

describe("rollback --set", () => {
  let active!: ReturnType<typeof craftedHome>;
  beforeEach(() => { active = craftedHome(["active", "active"]); });
  let rolled!: ReturnType<typeof craftedHome>;
  beforeEach(() => { rolled = craftedHome(["rolled-back", "rolled-back"]); });
  const run = (parts: Parts, result: unknown, extra: Partial<MigrationSetOperations> = {}, extraInput: object = {}, home = active) =>
    performSetRollback({
      homeDir: home.homeDir, ...select, confirmBackend: "sqlite", ...extraInput,
      _operationsForTesting: setOperations(home, parts, { rollback: async () => result, observeRestart: async () => SATISFIED, ...extra } as Partial<MigrationSetOperations>),
    });
  const base = { originalSetId: SET_ID, setId: REVERSE_ID, members: rollbackMembers("active") };

  it("previews without evaluating anything", async () => {
    const preview = envelope("rollback", await run(ACTIVATED, {}, {}, { dryRun: true }));
    expect(preview).toMatchObject({ exitCode: 5, applied: false, refusal: { reason: "set-preview-not-predictive" } });
    expect(preview.evidence).toMatchObject({ predictive: false });
  });

  it("maps a refusal", async () => {
    const refused = (reason: string) => ({ ...base, status: "refused", step: "records", reason, detail: "d", effectBegun: false });
    expect(envelope("rollback", await run(ACTIVATED, refused("activation-not-completed")))).toMatchObject({ exitCode: 2, applied: false, evidence: { serviceStep: "records", rollbackSetId: REVERSE_ID } });
    expect(envelope("rollback", await run(ACTIVATED, refused("maintenance-held-by-other")))).toMatchObject({ exitCode: 4 });
    expect(envelope("rollback", await run(ACTIVATED, refused("target-identity-drift")))).toMatchObject({ exitCode: 5 });
  });

  it("maps a blocked member, resumable only while the rollback route admits the service", async () => {
    const blocked = (reason: string) => ({ ...base, status: "blocked", step: "build", member: GENERATIONS[0], reason, detail: "d" });
    expect(envelope("rollback", await run(ACTIVATED, blocked("lease-lost")))).toMatchObject({ exitCode: 4, applied: true, evidence: { blockedProjectId: GENERATIONS[0] } });
    expect(envelope("rollback", await run(ACTIVATED, blocked("not-eligible")))).toMatchObject({ exitCode: 2 });
    expect(envelope("rollback", await run(ACTIVATED, blocked("install-mismatch")))).toMatchObject({ exitCode: 5 });
    expect(envelope("rollback", await run(ROLLING_BACK_OWNED, blocked("build-failed")))).toMatchObject({ exitCode: 6, next: "resume --set" });
    expect(envelope("rollback", await run(ACTIVATED, blocked("install-failed")))).toMatchObject({ exitCode: 5, next: null });
  });

  it("maps an interruption", async () => {
    const interrupted = (cause: string) => ({ ...base, status: "interrupted", step: "publication", cause, detail: "d", effectBegun: true });
    expect(envelope("rollback", await run(ROLLING_BACK_SELECTED, interrupted("publication-aborted")))).toMatchObject({ exitCode: 6, applied: false, next: "resume --set" });
    expect(envelope("rollback", await run(ACTIVATED, interrupted("publication-aborted")))).toMatchObject({ exitCode: 5 });
    expect(envelope("rollback", await run(ACTIVATED, interrupted("hold-gone")))).toMatchObject({ exitCode: 7 });
    expect(envelope("rollback", await run(ACTIVATED, interrupted("lease-lost")))).toMatchObject({ exitCode: 4 });
    expect(envelope("rollback", await run(ACTIVATED, interrupted("readback-mismatch")))).toMatchObject({ exitCode: 5 });
  });

  const done = (resumedFrom: string) => ({ ...base, status: "rolled-back", publicationId: REVERSE_ID, members: rollbackMembers("rolled-back"), resumedFrom });
  it("reads every member back before success and applies the sqlite restart cell", async () => {
    const ok = envelope("rollback", await run(ROLLED_BACK, done("fresh"), {}, {}, rolled));
    expect(ok).toMatchObject({
      exitCode: 0, applied: true, manifestPhase: "rolled-back", next: "report --set",
      evidence: { rollbackSetId: REVERSE_ID, resumedFrom: "fresh", "member.0.installedGenerationId": "installed-0", "member.1.mode": "post-write" },
    });
    expect(envelope("rollback", await run(ROLLED_BACK, done("settled"), {}, {}, rolled))).toMatchObject({ exitCode: 0, applied: false });
    expect(envelope("rollback", await run(ROLLED_BACK, done("fresh"), { observeRestart: async () => STALE as never }, {}, rolled))).toMatchObject({ exitCode: 8, applied: true });
    expect(envelope("rollback", await run(ROLLED_BACK, done("settled"), { observeRestart: async () => UNRESOLVABLE as never }, {}, rolled))).toMatchObject({ exitCode: 5, applied: false });
    expect(envelope("rollback", await run(ROLLING_BACK, done("fresh"), {}, {}, active))).toMatchObject({ exitCode: 5, evidence: { serviceReason: "readback-mismatch" } });
  });

  it("fails closed on an unknown status or reason", async () => {
    for (const result of [{ status: "unheard-of" }, { ...base, status: "refused", step: "records", reason: "brand-new", detail: "", effectBegun: false },
      { ...base, status: "blocked", step: "build", member: "m", reason: "brand-new", detail: "" },
      { ...base, status: "interrupted", step: "hold", cause: "brand-new", detail: "", effectBegun: true }]) {
      expect(envelope("rollback", await run(ACTIVATED, result))).toMatchObject({ exitCode: 5, refusal: { reason: "unexpected-failure" } });
    }
  });
});

