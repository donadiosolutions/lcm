import { describe, expect, it } from "vitest";
import {
  closedToken, journalSections, nextForRoute, observeSet, observedRows, selectSet, setRowsEvidence, setSections,
  setWriteFingerprint, type SetRoute,
} from "../../src/migration/cli-cutover-set-state.js";
import { deriveCutoverSetRollbackSetId } from "../../src/migration/cutover-set-rollback-store.js";
import type { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import type { FixtureStage } from "./existing-fixtures.js";
import { createFixtureManifest } from "./existing-fixtures.js";
import {
  ABSENT_JOURNAL, ABSENT_RECORDS, GENERATIONS, SET_ID, craftedHome, holdJournal, observation, publicationJournal,
  resolvedActivation, resolvedRollback,
} from "../fixtures/cli-cutover-set.js";

const REVERSE_ID = deriveCutoverSetRollbackSetId(SET_ID);
type Stage = FixtureStage | "absent";

async function route(
  stages: readonly Stage[],
  parts: Parameters<typeof observation>[0],
  store?: Partial<MigrationManifestStore>,
) {
  const home = craftedHome(stages);
  return observeSet({
    homeDir: home.homeDir, setId: SET_ID,
    manifestStore: (store ?? home.store) as MigrationManifestStore,
    _operationsForTesting: observation(parts),
  });
}

describe("the shared set route", () => {
  const cases: ReadonlyArray<readonly [string, readonly Stage[], Parameters<typeof observation>[0], SetRoute]> = [
    ["nothing names the set", ["absent", "absent"], {}, "unknown"],
    ["the journal cannot be read", ["absent", "absent"], { journal: { kind: "unresolvable", evidence: "journal-x" } }, "unresolvable"],
    ["the activation records cannot be read", ["absent", "absent"], { activation: { state: "unresolvable", reason: "r" } }, "unresolvable"],
    ["the rollback records cannot be read", ["absent", "absent"], { rollback: { state: "unresolvable", reason: "r" } }, "unresolvable"],
    ["a committed rollback with every member rolled back", ["rolled-back", "rolled-back"], { rollback: resolvedRollback() }, "settled-rolled-back"],
    ["a committed rollback with active members", ["active", "active"], { rollback: resolvedRollback(false), journal: publicationJournal(REVERSE_ID) }, "rollback"],
    ["activation records beside a rollback hold", ["active", "active"], { activation: resolvedActivation(), journal: holdJournal({ setId: REVERSE_ID, sourceBackend: "postgresql" }) }, "contradiction"],
    ["activation records beside a rollback publication", ["active", "active"], { activation: resolvedActivation(), journal: publicationJournal(REVERSE_ID) }, "contradiction"],
    ["a completed activation with every member active", ["active", "active"], { activation: resolvedActivation(), journal: publicationJournal() }, "settled-activated"],
    ["an activation with members still verified", ["verified", "active"], { activation: resolvedActivation(false), journal: holdJournal({ phase: "selection-prepared" }) }, "activate"],
    ["a rollback hold named as the set", ["verified", "verified"], { journal: holdJournal({ sourceBackend: "postgresql" }) }, "reverse-id"],
    ["a publication named as the set without activation records", ["absent", "absent"], { journal: publicationJournal() }, "reverse-id"],
    ["a forward hold still entering", ["absent", "absent"], { journal: holdJournal({ phase: "maintenance-entering" }), snapshot: "absent" }, "prepare"],
    ["a held set with every member verified", ["verified", "verified"], { journal: holdJournal() }, "prepared"],
    ["a held set with an ineligible member", ["verified", "verified"], { journal: holdJournal(), eligible: false }, "prepare"],
    ["a held set with a member still copied", ["verified", "copied"], { journal: holdJournal() }, "prepare"],
    ["an aborted hold whose members never reached a manifest", ["absent", "absent"], { journal: holdJournal({ phase: "maintenance-aborted" }) }, "settled-aborted"],
    ["an aborted hold whose members rolled back", ["rolled-back", "rolled-back"], { journal: holdJournal({ phase: "maintenance-aborted" }) }, "settled-aborted"],
    ["an aborted hold with an unsettled member", ["verified", "absent"], { journal: holdJournal({ phase: "maintenance-aborted" }) }, "abort"],
    ["a selection phase without activation records", ["verified", "verified"], { journal: holdJournal({ phase: "selection-prepared" }) }, "contradiction"],
    ["a single-generation hold", ["absent", "absent"], { journal: holdJournal({ cutoverSet: false, generationId: "single" }) }, "single-generation-held"],
    ["a rollback hold without rollback records", ["absent", "absent"], { journal: holdJournal({ setId: REVERSE_ID, sourceBackend: "postgresql" }) }, "contradiction"],
    ["a rollback publication without rollback records", ["absent", "absent"], { journal: publicationJournal(REVERSE_ID) }, "contradiction"],
    ["another set's hold", ["absent", "absent"], { journal: holdJournal({ setId: "other" }) }, "foreign"],
    ["a stranger's publication", ["absent", "absent"], { journal: publicationJournal("other") }, "foreign"],
  ];
  it.each(cases)("routes %s", async (_name, stages, parts, expected) => {
    expect((await route(stages, parts)).route).toBe(expected);
  });

  it("treats an unreadable member manifest as unresolvable outside a forward hold, and as a block inside one", async () => {
    const broken = { probeManifestPresence: () => ({ status: "unresolvable", reason: "x" }), read: () => { throw new Error("no"); } };
    expect((await route([], { activation: resolvedActivation() }, broken)).route).toBe("unresolvable");
    const held = await route([], { journal: holdJournal(), snapshot: "complete" }, broken);
    expect(held.route).toBe("prepare");
    expect(held.prepareBlock).toEqual({ reason: "manifest-unresolvable", bucket: "evidence" });
  });

  it("treats a manifest that throws on read as unresolvable and an eligibility check that throws as ineligible", async () => {
    const store = { probeManifestPresence: () => ({ status: "present" }), read: () => { throw new Error("no"); } };
    expect((await route([], { activation: resolvedActivation() }, store)).members[0]!.manifest).toBe("unresolvable");
    const home = craftedHome(["verified", "verified"]);
    const observed = await observeSet({
      homeDir: home.homeDir, setId: SET_ID, manifestStore: home.store,
      _operationsForTesting: { ...observation({ journal: holdJournal() }), readVerified: () => { throw new Error("no"); } },
    });
    expect(observed.members.map((member) => member.eligible)).toEqual([false, false]);
  });

  it("reports a record reader that throws as unresolvable evidence, never as absence", async () => {
    const home = craftedHome(["absent", "absent"]);
    const throwing = { ...observation(), readActivation: () => { throw new Error("no"); }, readRollback: () => { throw new Error("no"); } };
    const observed = await observeSet({ homeDir: home.homeDir, setId: SET_ID, manifestStore: home.store, _operationsForTesting: throwing });
    expect(observed).toMatchObject({ route: "unresolvable", activation: { state: "unresolvable" }, rollback: { state: "unresolvable" } });
  });

  it("reads the real record stores and journal when nothing is injected", async () => {
    const home = craftedHome(["absent", "absent"]);
    const observed = await observeSet({ homeDir: home.homeDir, setId: SET_ID });
    expect(observed).toMatchObject({ route: "unknown", members: [], setId: SET_ID, rollbackSetId: REVERSE_ID });
  });
});

describe("what blocks a preparation from continuing", () => {
  const cases: ReadonlyArray<readonly [string, readonly Stage[], string, { reason: string; bucket: string } | null]> = [
    ["a partial snapshot", ["absent", "absent"], "partial", { reason: "member-snapshot-partial", bucket: "precondition" }],
    ["a replaced snapshot", ["absent", "absent"], "replaced", { reason: "member-snapshot-partial", bucket: "precondition" }],
    ["a tampered snapshot", ["absent", "absent"], "tampered", { reason: "member-snapshot-tampered", bucket: "evidence" }],
    ["an unclassifiable snapshot", ["absent", "absent"], "unresolvable", { reason: "member-snapshot-unresolvable", bucket: "evidence" }],
    ["a manifest beside an absent snapshot", ["planned", "absent"], "absent", { reason: "member-snapshot-absent", bucket: "evidence" }],
    ["an absent snapshot without a manifest", ["absent", "absent"], "absent", null],
    ["complete snapshots", ["verified", "copied"], "complete", null],
  ];
  it.each(cases)("names %s", async (_name, stages, snapshot, expected) => {
    const observed = await route(stages, { journal: holdJournal(), snapshot });
    expect(observed.prepareBlock).toEqual(expected);
  });

  it("prefers evidence over a precondition when both are present", async () => {
    const home = craftedHome(["absent", "absent"]);
    let calls = 0;
    const observed = await observeSet({
      homeDir: home.homeDir, setId: SET_ID, manifestStore: home.store,
      _operationsForTesting: {
        ...observation({ journal: holdJournal() }),
        classifySnapshot: async () => ({ state: calls++ === 0 ? "partial" : "tampered" }) as never,
      },
    });
    expect(observed.prepareBlock).toEqual({ reason: "member-snapshot-tampered", bucket: "evidence" });
  });

  it("observes snapshots only while a forward hold is preparing", async () => {
    const home = craftedHome(["absent", "absent"]);
    const throwing = await observeSet({
      homeDir: home.homeDir, setId: SET_ID, manifestStore: home.store,
      _operationsForTesting: { ...observation({ journal: holdJournal() }), classifySnapshot: async () => { throw new Error("no"); } },
    });
    expect(throwing.prepareBlock).toEqual({ reason: "member-snapshot-unresolvable", bucket: "evidence" });
    expect((await route(["absent", "absent"], { journal: holdJournal({ phase: "maintenance-aborted" }) })).members[0]!.snapshot).toBeNull();
    expect((await route(["absent", "absent"], {})).prepareBlock).toBeNull();
  });
});

describe("selectors, tokens and evidence rows", () => {
  it("requires an explicit, well-formed set id", () => {
    expect(selectSet(undefined)).toEqual({ status: "refuse", reason: "set-generation-required" });
    expect(selectSet("not valid!")).toEqual({ status: "refuse", reason: "set-generation-invalid" });
    expect(selectSet(SET_ID)).toEqual({ status: "selected", setId: SET_ID });
  });

  it("emits a service token only when it is a short closed identifier", () => {
    expect(closedToken("member-snapshot-partial")).toBe("member-snapshot-partial");
    expect(closedToken("has space")).toBe("unrecognized");
    expect(closedToken("/etc/passwd")).toBe("unrecognized");
    expect(closedToken(null)).toBe("unrecognized");
    expect(closedToken(undefined)).toBe("unrecognized");
  });

  it("flattens rows into numbered scalar keys and omits absent fields", () => {
    expect(setRowsEvidence([
      { projectId: "p", generationId: "g", state: "verified", pending: "x", snapshot: "complete", reason: "bad reason", mode: "pre-write", installedGenerationId: "i" },
      { state: "absent", projectId: null, generationId: null, pending: null, snapshot: null, reason: null, mode: null, installedGenerationId: null },
    ])).toEqual({
      "member.0.projectId": "p", "member.0.generationId": "g", "member.0.state": "verified", "member.0.pending": "x",
      "member.0.snapshot": "complete", "member.0.reason": "unrecognized", "member.0.mode": "pre-write", "member.0.installedGenerationId": "i",
      "member.1.state": "absent",
    });
  });

  it("describes the journal and the observation as scalar evidence", async () => {
    expect(journalSections(holdJournal())).toEqual({ journalKind: "hold", journalPhase: "maintenance-held", journalGeneration: SET_ID });
    expect(journalSections(publicationJournal())).toEqual({ journalKind: "publication", journalPhase: "released", journalGeneration: SET_ID });
    expect(journalSections(ABSENT_JOURNAL)).toEqual({ journalKind: "absent" });
    const observed = await route(["verified", "verified"], { journal: holdJournal() });
    expect(setSections(observed, { extra: true })).toEqual({
      scope: "cutover-set", setId: SET_ID, rollbackSetId: REVERSE_ID, memberCount: 2, setState: "prepared", extra: true,
    });
    expect(observedRows(observed).map((row) => row.state)).toEqual(["verified", "verified"]);
  });

  it("names the command that owns each route", () => {
    expect(nextForRoute("prepare")).toBe("resume --set");
    expect(nextForRoute("activate")).toBe("resume --set");
    expect(nextForRoute("rollback")).toBe("resume --set");
    expect(nextForRoute("abort")).toBe("resume --set");
    expect(nextForRoute("prepared")).toBe("activate --set");
    expect(nextForRoute("settled-aborted")).toBe("plan --set");
    expect(nextForRoute("unknown")).toBe("plan --set");
    expect(nextForRoute("settled-activated")).toBeNull();
  });
});

describe("the write fingerprint", () => {
  const ids = [...GENERATIONS];

  it("moves when a member manifest, the journal slot or a record store moves, and not otherwise", async () => {
    const home = craftedHome(["verified", "verified"]);
    const base = { homeDir: home.homeDir, setId: SET_ID, generationIds: ids, manifestStore: home.store };
    const stable = observation({ journal: holdJournal(), activation: resolvedActivation(false), rollback: resolvedRollback(false) });
    const first = await setWriteFingerprint(base, stable);
    expect(await setWriteFingerprint(base, stable)).toBe(first);
    expect(await setWriteFingerprint(base, observation({ journal: publicationJournal(), activation: resolvedActivation(false), rollback: resolvedRollback(false) }))).not.toBe(first);
    expect(await setWriteFingerprint(base, observation({ journal: ABSENT_JOURNAL, activation: resolvedActivation(true), rollback: resolvedRollback(false) }))).not.toBe(first);
    expect(await setWriteFingerprint(base, observation({ journal: holdJournal(), activation: resolvedActivation(false), rollback: resolvedRollback(true) }))).not.toBe(first);
    expect(await setWriteFingerprint(base, observation({ journal: holdJournal(), activation: ABSENT_RECORDS, rollback: ABSENT_RECORDS }))).not.toBe(first);
    createFixtureManifest(home.store, "planned", { generationId: "late-member" });
    expect(await setWriteFingerprint({ ...base, generationIds: [...ids, "late-member"] }, stable)).not.toBe(first);
    expect(await setWriteFingerprint({ ...base, generationIds: [...ids, "never-created"] }, stable)).not.toBe(first);
  });

  it("moves with the member records of an uncommitted rollback checkpoint", async () => {
    const home = craftedHome(["verified", "verified"]);
    const base = { homeDir: home.homeDir, setId: SET_ID, generationIds: ids, manifestStore: home.store };
    const fingerprint = (rollback: object) => setWriteFingerprint(base, observation({ journal: holdJournal(), rollback: rollback as never }));
    const incomplete = (memberRecords: number) => ({ state: "authoritatively-absent", cause: "checkpoint-incomplete", memberRecords });
    const empty = await fingerprint({ state: "authoritatively-absent", cause: "empty" });
    const one = await fingerprint(incomplete(1));
    expect(one).not.toBe(empty);
    expect(await fingerprint(incomplete(2))).not.toBe(one);
    expect(await fingerprint(incomplete(1))).toBe(one);
  });

  it("is unresolvable whenever the state cannot be read", async () => {
    const home = craftedHome(["verified", "verified"]);
    const base = { homeDir: home.homeDir, setId: SET_ID, generationIds: ids };
    expect(await setWriteFingerprint({ ...base, manifestStore: home.store }, observation({ journal: { kind: "unresolvable", evidence: "x" } }))).toBe("unresolvable");
    const brokenHeads = await setWriteFingerprint({ ...base, generationIds: ["bad id with spaces"] }, observation());
    expect(brokenHeads).toBe("unresolvable");
  });
});
