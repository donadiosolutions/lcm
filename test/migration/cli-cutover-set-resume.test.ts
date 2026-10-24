import { beforeEach, describe, expect, it } from "vitest";
import {
  performSetAbort, performSetReport, performSetResume, type MigrationSetOperations, type MigrationSetOutcome,
} from "../../src/migration/cli-cutover-set.js";
import { renderMigrationSetEnvelope } from "../../src/migration/cli-render.js";
import { migrationCommandContract, type MigrationCommandName } from "../../src/migration/exit-classes.js";
import { deriveCutoverSetRollbackSetId } from "../../src/migration/cutover-set-rollback-store.js";
import {
  GENERATIONS, PROJECTS, SET_ID, craftedHome, holdJournal, publicationJournal, resolvedActivation, resolvedRollback, setOperations,
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
const ACTIVATING: Parts = { journal: holdJournal({ phase: "selection-prepared" }), activation: resolvedActivation(false) };
const ACTIVATED: Parts = { journal: publicationJournal(), activation: resolvedActivation() };
const ROLLING_BACK: Parts = { journal: publicationJournal(REVERSE_ID), activation: resolvedActivation(), rollback: resolvedRollback(false) };
const ROLLED_BACK: Parts = { journal: publicationJournal(REVERSE_ID), activation: resolvedActivation(), rollback: resolvedRollback() };
const ABORTED: Parts = { journal: holdJournal({ phase: "maintenance-aborted" }) };

const select = { generation: SET_ID, confirmGenerationId: SET_ID };
const SATISFIED = { restart: { answer: "satisfied", presence: "absent" } as const, evidence: { selectedBackend: "postgresql" } };

describe("resume --set drives only the service the durable state admits", () => {
  let home!: ReturnType<typeof craftedHome>;
  beforeEach(() => { home = craftedHome(["verified", "verified"]); });
  const counters = { prepare: 0, activate: 0, rollback: 0, abort: [] as unknown[] };
  beforeEach(() => { counters.prepare = 0; counters.activate = 0; counters.rollback = 0; counters.abort = []; });
  const stubs = (): Partial<MigrationSetOperations> => ({
    prepare: (async () => { counters.prepare += 1; return { status: "refuse", reason: "journal-unresolvable", setId: SET_ID, identityMutation: [] }; }) as never,
    activate: (async () => { counters.activate += 1; return { status: "refused", setId: SET_ID, step: "S1", reason: "quiescence-unsatisfied", detail: "", failures: [], members: [], effectBegun: false }; }) as never,
    rollback: (async () => { counters.rollback += 1; return { status: "refused", originalSetId: SET_ID, setId: REVERSE_ID, step: "records", reason: "activation-not-live", detail: "", members: [], effectBegun: false }; }) as never,
    abortCommand: (async (input: unknown) => { counters.abort.push(input); return { status: "ok", generationId: SET_ID, journalPhase: "maintenance-aborted", manifestPhase: null, applied: true }; }) as never,
  });
  const run = (parts: Parts, extra: Partial<MigrationSetOperations> = {}, input: object = {}) =>
    performSetResume({ homeDir: home.homeDir, ...select, ...input, _operationsForTesting: setOperations(home, parts, { ...stubs(), ...extra }) });
  const calls = () => [counters.prepare, counters.activate, counters.rollback, counters.abort.length];

  it("names the blocked preparation without running anything", async () => {
    const partial = envelope("resume", await run({ journal: holdJournal(), snapshot: "partial" }));
    expect(partial).toMatchObject({ exitCode: 2, next: "abort --set", applied: false, refusal: { reason: "set-refused-precondition" }, evidence: { serviceReason: "member-snapshot-partial" } });
    const tampered = envelope("resume", await run({ journal: holdJournal(), snapshot: "tampered" }));
    expect(tampered).toMatchObject({ exitCode: 5, next: null, evidence: { serviceReason: "member-snapshot-tampered" } });
    expect(calls()).toEqual([0, 0, 0, 0]);
  });

  it.each([
    ["a prepared set", PREPARED, "activate --set"],
    ["a settled activation", ACTIVATED, null],
    ["a settled rollback", ROLLED_BACK, null],
    ["a settled abort", ABORTED, "plan --set"],
  ] as const)("reports %s as settled and runs nothing", async (_name, parts, next) => {
    const stateHome = parts === ACTIVATED ? craftedHome(["active", "active"]) : parts === ROLLED_BACK ? craftedHome(["rolled-back", "rolled-back"]) : parts === ABORTED ? craftedHome(["absent", "absent"]) : home;
    home = stateHome;
    const result = envelope("resume", await run(parts));
    expect(result).toMatchObject({ exitCode: 0, applied: false, next: next ?? "report --set" });
    expect(calls()).toEqual([0, 0, 0, 0]);
  });

  it("names the route a dry run would take, without running it", async () => {
    for (const parts of [{ journal: holdJournal(), eligible: false }, ACTIVATING, ROLLING_BACK, ABORTED] as Parts[]) {
      const result = envelope("resume", await run(parts, {}, { dryRun: true }));
      expect(result).toMatchObject({ exitCode: 0, applied: false });
      expect(result.next).toMatch(/^resume --set \(the \w+ route would run; drop --dry-run\)$/u);
    }
    expect(calls()).toEqual([0, 0, 0, 0]);
  });

  it("dispatches activation, rollback and the whole-set abort exactly once", async () => {
    expect(envelope("resume", await run(ACTIVATING))).toMatchObject({ exitCode: 2, refusal: { reason: "set-refused-precondition" } });
    expect(calls()).toEqual([0, 1, 0, 0]);
    expect(envelope("resume", await run(ROLLING_BACK))).toMatchObject({ exitCode: 2, refusal: { reason: "set-refused-precondition" } });
    expect(calls()).toEqual([0, 1, 1, 0]);
    const aborted = envelope("resume", await run(ABORTED));
    expect(aborted).toMatchObject({ exitCode: 0, applied: true });
    expect(counters.abort).toEqual([{ homeDir: home.homeDir, generation: SET_ID, confirmGenerationId: SET_ID }]);
    expect(calls()).toEqual([0, 1, 1, 1]);
  });

  it("prepares the unfinished members with the default batch limits and reads the result back", async () => {
    const parts: Parts = { journal: holdJournal(), eligible: false };
    const seen: unknown[] = [];
    const result = envelope("resume", await run(parts, {
      prepare: (async (input: unknown) => {
        seen.push(input);
        Object.assign(parts, { eligible: true });
        return { status: "prepared", setId: SET_ID, identityMutation: [], members: GENERATIONS.map((generationId, index) => ({ physicalProjectId: PROJECTS[index]!, generationId, state: "verified" })) };
      }) as never,
    }, { maxRecords: 3 }));
    expect(seen).toEqual([expect.objectContaining({ confirmSetId: SET_ID, maxRecords: 3, maxBytes: 16 * 1024 * 1024 })]);
    expect(result).toMatchObject({ exitCode: 0, applied: false, next: "activate --set" });
    const defaults: unknown[] = [];
    await run({ journal: holdJournal(), eligible: false }, { prepare: (async (input: unknown) => { defaults.push(input); return { status: "refuse", reason: "x", setId: null, identityMutation: [] }; }) as never });
    expect(defaults).toEqual([expect.objectContaining({ maxRecords: 500, maxBytes: 16 * 1024 * 1024 })]);
  });

  it("refuses a missing target before preparing", async () => {
    const result = envelope("resume", await run({ journal: holdJournal(), eligible: false }, { resolveTargetConfig: () => ({ status: "refuse", reason: "migration-target-missing" }) }));
    expect(result).toMatchObject({ exitCode: 2, refusal: { reason: "migration-target-missing" } });
    expect(calls()).toEqual([0, 0, 0, 0]);
  });
});

describe("report --set", () => {
  let home!: ReturnType<typeof craftedHome>;
  beforeEach(() => { home = craftedHome(["verified", "verified"]); });
  const run = (parts: Parts, extra: Partial<MigrationSetOperations> = {}, input: object = { generation: SET_ID }) =>
    performSetReport({ homeDir: home.homeDir, ...input, _operationsForTesting: setOperations(home, parts, extra) });

  it("requires the original set id and never reads without it", async () => {
    expect(envelope("report", await run({}, {}, {}))).toMatchObject({ exitCode: 2, refusal: { reason: "set-generation-required" } });
    expect(envelope("report", await run({}, {}, { generation: "no good" }))).toMatchObject({ exitCode: 1, refusal: { reason: "set-generation-invalid" } });
  });

  it("describes a prepared set with the reverse id printed separately", async () => {
    const result = envelope("report", await run(PREPARED));
    expect(result).toMatchObject({ exitCode: 0, applied: false, generation: SET_ID, manifestPhase: "verified", next: "activate --set" });
    expect(result.evidence).toMatchObject({
      setState: "prepared", rollbackSetId: REVERSE_ID, journalKind: "hold", activationRecords: "absent", activationSelection: false,
      rollbackRecords: "absent", rollbackSelection: false, "member.1.state": "verified",
    });
  });

  it.each([
    ["a preparing set", { journal: holdJournal(), snapshot: "partial" }, "resume --set"],
    ["an activation in flight", ACTIVATING, "resume --set"],
    ["a rollback in flight", ROLLING_BACK, "resume --set"],
    ["an abort to finish", ABORTED, "resume --set"],
  ] as const)("reads %s as a legitimate state with its owner named", async (_name, parts, next) => {
    expect(envelope("report", await run(parts))).toMatchObject({ exitCode: 0, next });
  });

  it("reports present records with their selection", async () => {
    const result = envelope("report", await run(ROLLING_BACK));
    expect(result.evidence).toMatchObject({ activationRecords: "present", activationSelection: true, rollbackRecords: "present", rollbackSelection: false });
  });

  it.each([
    ["an unknown set", {}, 2, "generation-unknown"],
    ["the reverse id", { journal: holdJournal({ sourceBackend: "postgresql" }) }, 2, "set-original-generation-required"],
    ["unreadable state", { journal: { kind: "unresolvable", evidence: "journal-x" } }, 5, "report-evidence-unresolvable"],
    ["contradictory state", { journal: holdJournal({ phase: "selection-prepared" }) }, 5, "route-contradiction"],
    ["a stranger's slot", { journal: holdJournal({ setId: "other" }) }, 5, "route-foreign-publication"],
    ["a single-generation hold", { journal: holdJournal({ cutoverSet: false, generationId: "single" }) }, 2, "set-refused-precondition"],
  ] as const)("refuses %s while still printing what it read", async (_name, parts, exitCode, reason) => {
    const result = envelope("report", await run(parts as Parts));
    expect(result).toMatchObject({ exitCode, applied: false, refusal: { reason } });
    expect(result.evidence).toMatchObject({ scope: "cutover-set", setId: SET_ID });
  });

  it("marks unreadable record stores as unresolvable evidence", async () => {
    const result = envelope("report", await run({ activation: { state: "unresolvable", reason: "r" }, rollback: { state: "unresolvable", reason: "r" } }));
    expect(result.evidence).toMatchObject({ activationRecords: "unresolvable", rollbackRecords: "unresolvable" });
  });

  it("applies the restart cell to a settled activation or rollback, selecting the matching backend", async () => {
    const selected: string[] = [];
    const observe = (outcome: object) => (async (input: { selected: string }) => { selected.push(input.selected); return outcome; }) as never;
    const activeHome = craftedHome(["active", "active"]);
    home = activeHome;
    expect(envelope("report", await run(ACTIVATED, { observeRestart: observe(SATISFIED) }))).toMatchObject({ exitCode: 0, next: null, restart: { answer: "satisfied" } });
    const stale = { reason: "cutover-restart-required", restart: { answer: "unsatisfied", presence: "running" }, evidence: { selectedBackend: "postgresql" } };
    expect(envelope("report", await run(ACTIVATED, { observeRestart: observe(stale) }))).toMatchObject({ exitCode: 8, refusal: { reason: "report-restart-required" } });
    const contradiction = { reason: "cutover-restart-contradiction", restart: null, evidence: {} };
    expect(envelope("report", await run(ACTIVATED, { observeRestart: observe(contradiction) }))).toMatchObject({ exitCode: 5, refusal: { reason: "report-restart-contradiction" } });
    const unresolvable = { reason: "cutover-restart-unresolvable", restart: null, evidence: {} };
    expect(envelope("report", await run(ACTIVATED, { observeRestart: observe(unresolvable) }))).toMatchObject({ exitCode: 5, refusal: { reason: "report-restart-unresolvable" } });
    home = craftedHome(["rolled-back", "rolled-back"]);
    expect(envelope("report", await run(ROLLED_BACK, { observeRestart: observe(SATISFIED) }))).toMatchObject({ exitCode: 0, manifestPhase: "rolled-back" });
    expect(selected).toEqual(["postgresql", "postgresql", "postgresql", "postgresql", "sqlite"]);
  });
});

describe("abort --set", () => {
  let home!: ReturnType<typeof craftedHome>;
  beforeEach(() => { home = craftedHome(["verified", "absent"]); });
  const legacy = (outcome: object, seen: unknown[] = []) => ({
    abortCommand: (async (input: unknown) => { seen.push(input); return outcome; }) as never,
  });
  const run = (parts: Parts, outcome: object, input: object = {}, seen: unknown[] = []) =>
    performSetAbort({ homeDir: home.homeDir, ...input, _operationsForTesting: setOperations(home, parts, legacy(outcome, seen)) });

  it("refuses to abort a single-generation hold through the set command", async () => {
    const result = envelope("abort", await run({ journal: holdJournal({ cutoverSet: false, generationId: "single" }) }, {}));
    expect(result).toMatchObject({ exitCode: 2, generation: "single", next: "abort", evidence: { serviceReason: "cutover-set-single-generation-held" } });
  });

  it("converges the legacy whole-set abort and reads every member back", async () => {
    const seen: unknown[] = [];
    const ok = { status: "ok", generationId: SET_ID, journalPhase: "maintenance-aborted", manifestPhase: "verified", applied: true };
    const result = envelope("abort", await run(ABORTED, ok, { generation: SET_ID, confirmGenerationId: SET_ID, dryRun: true }, seen));
    expect(seen).toEqual([{ homeDir: home.homeDir, generation: SET_ID, confirmGenerationId: SET_ID, dryRun: true }]);
    expect(result).toMatchObject({ exitCode: 0, applied: true, generation: SET_ID, next: "plan --set", manifestPhase: null });
    expect(result.evidence).toMatchObject({ scope: "cutover-set", setId: SET_ID, memberCount: 2, journalPhase: "maintenance-aborted", "member.0.state": "verified", "member.1.state": "absent" });
    const settled = envelope("abort", await run(ABORTED, { ...ok, applied: false }, { confirmGenerationId: SET_ID }, seen));
    expect(settled).toMatchObject({ applied: false, next: null });
    expect(seen[1]).toEqual({ homeDir: home.homeDir, confirmGenerationId: SET_ID });
  });

  it("reports a member whose manifest cannot be read as unresolvable, and a common phase", async () => {
    const bad = holdJournal({ phase: "maintenance-aborted" });
    (bad as { journal: { cutoverSet: { manifest: { members: { generationId: string }[] } } } }).journal.cutoverSet.manifest.members[1]!.generationId = "bad id";
    const result = envelope("abort", await run({ journal: bad }, { status: "ok", generationId: SET_ID, journalPhase: "maintenance-aborted", manifestPhase: null, applied: true }));
    expect(result.evidence).toMatchObject({ "member.1.state": "unresolvable" });
    const same = craftedHome(["rolled-back", "rolled-back"]);
    home = same;
    const common = envelope("abort", await run(ABORTED, { status: "ok", generationId: SET_ID, journalPhase: "maintenance-aborted", manifestPhase: null, applied: true }));
    expect(common.manifestPhase).toBe("rolled-back");
  });

  it("keeps the legacy refusals, naming the set resume and carrying a write", async () => {
    const needsResume = envelope("abort", await run(ABORTED, { status: "refuse", reason: "abort-manifest-needs-resume", next: "resume", applied: true, generationId: SET_ID, evidence: "member-1:copy" }));
    expect(needsResume).toMatchObject({ exitCode: 6, applied: true, next: "resume --set", generation: SET_ID, evidence: { detail: "member-1:copy" } });
    const nothing = envelope("abort", await run({}, { status: "refuse", reason: "abort-nothing-to-abort" }));
    expect(nothing).toMatchObject({ exitCode: 2, applied: false, next: null, generation: null });
    expect(nothing.evidence).toEqual({ scope: "cutover-set", memberCount: 0 });
    const other = envelope("abort", await run(ABORTED, { status: "refuse", reason: "abort-confirmation-missing", next: "plan" }));
    expect(other).toMatchObject({ exitCode: 3, next: "plan" });
  });

  it("closes an unclassified throw conservatively", async () => {
    const result = envelope("abort", await performSetAbort({
      homeDir: home.homeDir,
      _operationsForTesting: setOperations(home, ABORTED, { abortCommand: (async () => { throw new TypeError("x"); }) as never }),
    }));
    expect(result).toMatchObject({ exitCode: 5, applied: true, refusal: { reason: "unexpected-failure" } });
  });
});

