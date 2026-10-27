import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackendPublicationCoordinator,
  BackendPublicationJournalError,
  backendCutoverSetJournalCapacity,
  backendCutoverSetManifestSha256,
  backendCutoverSetSelectionSha256,
  backendCutoverSetSelectionWorstCase,
  backendMaintenanceQueueEvidenceSentinel,
  backendPublicationCanonicalSha256,
  backendPublicationJournalPath,
  parseBackendCutoverSetSelection,
  readBackendMaintenanceJournal,
  rebindBackendMaintenanceCutoff,
  resolveBackendMaintenanceGenerationBinding,
  withBackendPublicationAppendBarrierAsync,
  type BackendCutoverSetManifest,
  type BackendCutoverSetSelection,
  type BackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { cutoverSetMaintenanceEntry } from "../../src/migration/cutover-set.js";
import { SET_ID, SET_MACHINE_ID, setManifest, sourceHash } from "../fixtures/cutover-set.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const NOW = new Date("2026-10-20T00:00:00.000Z");
const LIMIT = 1024 * 1024;
const SINGLE_GENERATION_CHECKSUM = "36a07c5ae945769d6ef4694e5f9edc19d59f508179dd2bf2cd41950db8150f7f";
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-cutover-set-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

function coordinator(homeDir: string): BackendPublicationCoordinator {
  const unexpected = async (): Promise<never> => { throw new Error("v2 driver must not run for maintenance"); };
  const driver: BackendPublicationDriver = {
    observeLocalState: unexpected, publishProjectMap: unexpected, publishConfig: unexpected,
    restoreConfig: unexpected, restoreProjectMap: unexpected,
  };
  return new BackendPublicationCoordinator({ homeDir, driver });
}

async function enterSet(homeDir: string, count = 3) {
  const entry = cutoverSetMaintenanceEntry(setManifest(count));
  const held = await coordinator(homeDir).enterMaintenance({ ...entry, now: NOW });
  return { entry, held };
}

type Payload = Record<string, any>;

function journalFile(homeDir: string): Payload {
  return JSON.parse(readFileSync(backendPublicationJournalPath(homeDir), "utf8"));
}

/** Rewrite the journal in place with a recomputed checksum (the file keeps its private mode). */
function rewrite(homeDir: string, edit: (payload: Payload) => void): void {
  const { checksumSha256: _checksum, ...payload } = journalFile(homeDir);
  edit(payload);
  writeFileSync(
    backendPublicationJournalPath(homeDir),
    JSON.stringify({ ...payload, checksumSha256: backendPublicationCanonicalSha256(payload) }),
  );
}

function rebind(
  homeDir: string,
  held: BackendMaintenanceJournal,
  generationId: string,
  expectedChecksumSha256: string,
  overrides: Partial<Parameters<typeof rebindBackendMaintenanceCutoff>[0]> = {},
) {
  const member = held.cutoverSet!.manifest.members.find((candidate) => candidate.generationId === generationId);
  return withBackendPublicationAppendBarrierAsync(homeDir, async (token) => rebindBackendMaintenanceCutoff({
    homeDir,
    expectedChecksumSha256,
    generationId,
    sourceSelectionSha256: member?.sourceSelectionSha256 ?? HASH_A,
    queueEvidenceSha256: HASH_B,
    roster: [{ machineId: SET_MACHINE_ID, queueCutoff: "0000000000000000007", evidenceSha256: HASH_B }],
    ...overrides,
  }, token));
}

function manyMembers(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    physicalProjectId: (index + 1).toString(16).padStart(64, "0"),
    generationId: "member-generation-" + String(index + 1),
    sourceSelectionSha256: sourceHash(index + 1),
  }));
}

describe("single-generation journals", () => {
  it("never gain a cutoverSet key and keep their checksum", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const homeDir = home();
    const held = await coordinator(homeDir).enterMaintenance({
      publicationId: "migration-generation-1",
      generationId: "generation-1",
      sourceSelectionSha256: HASH_A,
      queueEvidenceSha256: HASH_B,
      roster: [{ machineId: SET_MACHINE_ID, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A }],
      now: NOW,
    });
    expect("cutoverSet" in held).toBe(false);
    expect("cutoverSet" in journalFile(homeDir)).toBe(false);
    expect(held.checksumSha256).toBe(SINGLE_GENERATION_CHECKSUM);
    expect(resolveBackendMaintenanceGenerationBinding(held, "generation-1")).toEqual({
      generationId: "generation-1",
      sourceSelectionSha256: HASH_A,
      queueEvidenceSha256: HASH_B,
      roster: held.roster,
      checksumSha256: held.checksumSha256,
    });
    expect(resolveBackendMaintenanceGenerationBinding(held, "other-generation")).toBeNull();
    expect(resolveBackendMaintenanceGenerationBinding(null, "generation-1")).toBeNull();
  });
});

describe("cutover-set journal", () => {
  it("enters held with the set-derived top level and sentinel member bindings", async () => {
    const homeDir = home();
    const { entry, held } = await enterSet(homeDir);
    const manifest = entry.cutoverSet.manifest;
    expect(held).toMatchObject({
      phase: "maintenance-held",
      publicationId: SET_ID,
      generationId: SET_ID,
      sourceSelectionSha256: backendCutoverSetManifestSha256(manifest),
      queueEvidenceSha256: entry.queueEvidenceSha256,
      roster: [{
        machineId: SET_MACHINE_ID,
        queueCutoff: null,
        evidenceSha256: backendMaintenanceQueueEvidenceSentinel({
          generationId: SET_ID, sourceSelectionSha256: backendCutoverSetManifestSha256(manifest),
        }),
      }],
    });
    expect(readBackendMaintenanceJournal(homeDir)).toEqual(held);
    expect(coordinator(homeDir).inspectMaintenance()).toEqual(held);
    for (const member of manifest.members) {
      const view = resolveBackendMaintenanceGenerationBinding(held, member.generationId)!;
      expect(view.sourceSelectionSha256).toBe(member.sourceSelectionSha256);
      expect(view.roster[0]).toMatchObject({ queueCutoff: null });
      expect(view.queueEvidenceSha256).toBe(view.roster[0]!.evidenceSha256);
    }
    expect(resolveBackendMaintenanceGenerationBinding(held, SET_ID)).toBeNull();
    expect(resolveBackendMaintenanceGenerationBinding(held, "not-a-member")).toBeNull();
  });

  it("reports the capacity of the largest journal the set can reach", async () => {
    const { entry } = await enterSet(home());
    const capacity = backendCutoverSetJournalCapacity(entry.cutoverSet);
    expect(capacity.limitBytes).toBe(LIMIT);
    expect(capacity.worstCaseBytes).toBeGreaterThan(JSON.stringify(entry.cutoverSet).length);
  });

  describe("parser invariants fail closed", () => {
    const cases: readonly (readonly [string, RegExp, (payload: Payload) => void])[] = [
      ["a null set", /cutover set is malformed/, (p) => { p.cutoverSet = null; }],
      ["an unknown set key", /cutover set is malformed/, (p) => { p.cutoverSet.extra = 1; }],
      ["an unknown manifest key", /manifest is malformed/, (p) => { p.cutoverSet.manifest.extra = 1; }],
      ["a manifest version other than 1", /manifest is malformed/, (p) => { p.cutoverSet.manifest.version = 2; }],
      ["a malformed set id", /manifest is malformed/, (p) => { p.cutoverSet.manifest.setId = "not valid!"; }],
      ["a non-string set id", /manifest is malformed/, (p) => { p.cutoverSet.manifest.setId = 7; }],
      ["a non-canonical machine id", /manifest is malformed/, (p) => { p.cutoverSet.manifest.machineId = "machine"; }],
      ["a non-string machine id", /manifest is malformed/, (p) => { p.cutoverSet.manifest.machineId = 7; }],
      ["a single member", /manifest is malformed/, (p) => { p.cutoverSet.manifest.members.length = 1; }],
      ["members that are not an array", /manifest is malformed/, (p) => { p.cutoverSet.manifest.members = {}; }],
      ["a non-object member", /member\[1\] is malformed/, (p) => { p.cutoverSet.manifest.members[1] = 7; }],
      ["an unknown member key", /member\[1\] is malformed/, (p) => { p.cutoverSet.manifest.members[1].extra = 1; }],
      ["a malformed project id", /member\[1\] is malformed/, (p) => { p.cutoverSet.manifest.members[1].physicalProjectId = "ABC"; }],
      ["a non-string project id", /member\[1\] is malformed/, (p) => { p.cutoverSet.manifest.members[1].physicalProjectId = 7; }],
      ["a malformed member generation id", /member\[1\] is malformed/, (p) => { p.cutoverSet.manifest.members[1].generationId = "bad id"; }],
      ["a non-string member generation id", /member\[1\] is malformed/, (p) => { p.cutoverSet.manifest.members[1].generationId = 7; }],
      ["a malformed member source hash", /member\[1\] is malformed/, (p) => { p.cutoverSet.manifest.members[1].sourceSelectionSha256 = "x"; }],
      ["a single-element array as member source hash", /member\[1\] is malformed/, (p) => {
        p.cutoverSet.manifest.members[1].sourceSelectionSha256 = [p.cutoverSet.manifest.members[1].sourceSelectionSha256];
      }],
      ["unsorted members", /not uniquely sorted by project/, (p) => { p.cutoverSet.manifest.members.reverse(); }],
      ["duplicate members", /not uniquely sorted by project/, (p) => {
        p.cutoverSet.manifest.members[1].physicalProjectId = p.cutoverSet.manifest.members[0].physicalProjectId;
      }],
      ["shared member generation ids", /generation ids are not unique/, (p) => {
        p.cutoverSet.manifest.members[1].generationId = p.cutoverSet.manifest.members[0].generationId;
      }],
      ["a member generation id equal to the set id", /generation ids are not unique/, (p) => {
        p.cutoverSet.manifest.members[0].generationId = p.cutoverSet.manifest.setId;
      }],
      ["bindings that are not an array", /bindings do not align/, (p) => { p.cutoverSet.bindings = {}; }],
      ["a missing binding", /bindings do not align/, (p) => { p.cutoverSet.bindings.pop(); }],
      ["an unknown binding key", /binding\[0\] is malformed/, (p) => { p.cutoverSet.bindings[0].extra = 1; }],
      ["a non-object binding", /binding\[0\] is malformed/, (p) => { p.cutoverSet.bindings[0] = 7; }],
      ["misaligned binding order", /binding\[0\] is malformed/, (p) => { p.cutoverSet.bindings.reverse(); }],
      ["malformed binding evidence", /binding\[0\] is malformed/, (p) => { p.cutoverSet.bindings[0].queueEvidenceSha256 = "x"; }],
      ["a single-element array as binding evidence", /binding\[0\] is malformed/, (p) => {
        p.cutoverSet.bindings[0].queueEvidenceSha256 = [p.cutoverSet.bindings[0].queueEvidenceSha256];
      }],
      ["an empty binding roster", /roster is empty or malformed/, (p) => { p.cutoverSet.bindings[0].roster = []; }],
      ["two binding roster rows", /binding\[0\] roster is inconsistent/, (p) => {
        p.cutoverSet.bindings[0].roster.push({ ...p.cutoverSet.bindings[0].roster[0], machineId: "ffffffff-1234-7abc-8def-1234567890ab" });
      }],
      ["a binding roster for another machine", /binding\[0\] roster is inconsistent/, (p) => {
        p.cutoverSet.bindings[0].roster[0].machineId = "00000000-1234-7abc-8def-1234567890ab";
      }],
      ["binding evidence that differs from its roster", /binding\[0\] roster is inconsistent/, (p) => {
        p.cutoverSet.bindings[0].queueEvidenceSha256 = HASH_A;
      }],
      ["a generation id other than the set id", /inconsistent with its set/, (p) => { p.generationId = "other"; }],
      ["a publication id other than the set id", /inconsistent with its set/, (p) => { p.publicationId = "other"; }],
      ["a source selection that is not the manifest digest", /inconsistent with its set/, (p) => { p.sourceSelectionSha256 = HASH_A; }],
      ["top-level evidence independent of the bindings", /inconsistent with its set/, (p) => { p.queueEvidenceSha256 = HASH_A; }],
      ["a bound top-level roster", /inconsistent with its set/, (p) => { p.roster[0].queueCutoff = "0000000000000000001"; }],
      ["a prepared selection", /inconsistent with its set/, (p) => { p.phase = "selection-prepared"; }],
      ["a completed selection", /inconsistent with its set/, (p) => { p.phase = "selection-completed"; }],
    ];

    it.each(cases)("rejects %s", async (_name, message, edit) => {
      const homeDir = home();
      await enterSet(homeDir);
      rewrite(homeDir, edit);
      let error: unknown;
      try { readBackendMaintenanceJournal(homeDir); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(BackendPublicationJournalError);
      expect(error).toMatchObject({ reason: "malformed-journal" });
      expect((error as Error).message).toMatch(message);
    });

    it("rejects a set journal whose checksum was not recomputed", async () => {
      const homeDir = home();
      await enterSet(homeDir);
      const payload = journalFile(homeDir);
      payload.cutoverSet.bindings[0].roster[0].queueCutoff = "0000000000000000001";
      writeFileSync(backendPublicationJournalPath(homeDir), JSON.stringify(payload));
      expect(() => readBackendMaintenanceJournal(homeDir)).toThrow(/checksum/);
    });
  });

  describe("entry", () => {
    const enter = (homeDir: string, edit: (input: any) => void) => {
      const input: any = JSON.parse(JSON.stringify({ ...cutoverSetMaintenanceEntry(setManifest(3)) }));
      edit(input);
      return coordinator(homeDir).enterMaintenance({ ...input, now: NOW });
    };

    it.each([
      ["a malformed set", (i: any) => { i.cutoverSet = { manifest: 1 }; }, "malformed-journal"],
      ["a publication id other than the set id", (i: any) => { i.publicationId = "other"; }, "invalid-input"],
      ["a generation id other than the set id", (i: any) => { i.generationId = "other"; }, "invalid-input"],
      ["a source selection that is not the manifest digest", (i: any) => { i.sourceSelectionSha256 = HASH_A; }, "invalid-input"],
      ["independent top-level evidence", (i: any) => { i.queueEvidenceSha256 = HASH_A; }, "invalid-input"],
      ["a top-level roster that is not the set sentinel", (i: any) => { i.roster[0].evidenceSha256 = HASH_A; }, "invalid-input"],
      ["an already bound member cutoff", (i: any) => {
        i.cutoverSet.bindings[0].roster[0].queueCutoff = "0000000000000000001";
      }, "invalid-input"],
      ["a member binding that is not its sentinel", (i: any) => {
        i.cutoverSet.bindings[0].queueEvidenceSha256 = HASH_A;
        i.cutoverSet.bindings[0].roster[0].evidenceSha256 = HASH_A;
        i.queueEvidenceSha256 = backendPublicationCanonicalSha256({
          version: 1,
          kind: "cutover-set-queue-evidence",
          bindings: i.cutoverSet.bindings.map((b: any) => ({ generationId: b.generationId, queueEvidenceSha256: b.queueEvidenceSha256 })),
        });
      }, "invalid-input"],
    ])("refuses %s before writing", async (_name, edit, reason) => {
      const homeDir = home();
      await expect(enter(homeDir, edit)).rejects.toMatchObject({ reason });
      expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
    });

    it("refuses a set whose worst-case journal exceeds the readable size", async () => {
      const homeDir = home();
      const entry = cutoverSetMaintenanceEntry({ ...setManifest(2), members: manyMembers(3000) });
      await expect(coordinator(homeDir).enterMaintenance({ ...entry, now: NOW }))
        .rejects.toMatchObject({ reason: "invalid-input", message: expect.stringContaining("cutover-set-too-large") });
      expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
    });
  });

  describe("entering recovery", () => {
    async function entering(homeDir: string) {
      const { entry } = await enterSet(homeDir);
      rewrite(homeDir, (payload) => { payload.phase = "maintenance-entering"; });
      return entry;
    }

    it("completes only an identical resubmission", async () => {
      const homeDir = home();
      const entry = await entering(homeDir);
      const held = await coordinator(homeDir).enterMaintenance({ ...entry, now: NOW });
      expect(held.phase).toBe("maintenance-held");
      expect(held.cutoverSet).toEqual(entry.cutoverSet);
    });

    it("refuses a resubmission without the set, and replaces no live hold", async () => {
      const homeDir = home();
      const entry = await entering(homeDir);
      const before = readFileSync(backendPublicationJournalPath(homeDir), "utf8");
      await expect(coordinator(homeDir).enterMaintenance({
        publicationId: entry.publicationId,
        generationId: entry.generationId,
        sourceSelectionSha256: entry.sourceSelectionSha256,
        queueEvidenceSha256: entry.queueEvidenceSha256,
        roster: entry.roster,
        now: NOW,
      })).rejects.toMatchObject({ reason: "unexpected-state" });
      expect(readFileSync(backendPublicationJournalPath(homeDir), "utf8")).toBe(before);
    });

    it("refuses a set resubmitted for a single-generation entering journal", async () => {
      const homeDir = home();
      const entry = cutoverSetMaintenanceEntry(setManifest(3));
      await coordinator(homeDir).enterMaintenance({
        publicationId: entry.publicationId,
        generationId: entry.generationId,
        sourceSelectionSha256: entry.sourceSelectionSha256,
        queueEvidenceSha256: entry.queueEvidenceSha256,
        roster: entry.roster,
        now: NOW,
      });
      rewrite(homeDir, (payload) => { payload.phase = "maintenance-entering"; });
      await expect(coordinator(homeDir).enterMaintenance({ ...entry, now: NOW }))
        .rejects.toMatchObject({ reason: "unexpected-state" });
    });

    it("refuses a different manifest or bindings", async () => {
      const homeDir = home();
      await entering(homeDir);
      const other = cutoverSetMaintenanceEntry(setManifest(4));
      await expect(coordinator(homeDir).enterMaintenance({ ...other, now: NOW }))
        .rejects.toMatchObject({ reason: "unexpected-state" });
    });
  });

  describe("member rebind", () => {
    it("rewrites only that member, keeping the other members' binding checksums", async () => {
      const homeDir = home();
      const { held } = await enterSet(homeDir);
      const [a, b, c] = held.cutoverSet!.manifest.members.map((member) => member.generationId) as [string, string, string];
      const viewA = resolveBackendMaintenanceGenerationBinding(held, a)!;
      const viewB = resolveBackendMaintenanceGenerationBinding(held, b)!;
      const viewC = resolveBackendMaintenanceGenerationBinding(held, c)!;
      const afterA = await rebind(homeDir, held, a, viewA.checksumSha256);
      expect(afterA.checksumSha256).not.toBe(held.checksumSha256);
      expect(afterA.roster).toEqual(held.roster);
      expect(afterA.queueEvidenceSha256).not.toBe(held.queueEvidenceSha256);
      const boundA = resolveBackendMaintenanceGenerationBinding(afterA, a)!;
      expect(boundA.roster[0]).toEqual({ machineId: SET_MACHINE_ID, queueCutoff: "0000000000000000007", evidenceSha256: HASH_B });
      expect(boundA.checksumSha256).not.toBe(viewA.checksumSha256);
      expect(resolveBackendMaintenanceGenerationBinding(afterA, b)!.checksumSha256).toBe(viewB.checksumSha256);
      const afterB = await rebind(homeDir, afterA, b, viewB.checksumSha256, {
        queueEvidenceSha256: HASH_A,
        roster: [{ machineId: SET_MACHINE_ID, queueCutoff: "0000000000000000009", evidenceSha256: HASH_A }],
      });
      expect(resolveBackendMaintenanceGenerationBinding(afterB, a)!.checksumSha256).toBe(boundA.checksumSha256);
      expect(resolveBackendMaintenanceGenerationBinding(afterB, c)!.checksumSha256).toBe(viewC.checksumSha256);
      expect(afterB.queueEvidenceSha256).not.toBe(afterA.queueEvidenceSha256);
      expect(readBackendMaintenanceJournal(homeDir)).toEqual(afterB);
      expect(afterB.cutoverSet!.bindings.map((binding) => binding.roster[0]!.queueCutoff))
        .toEqual(["0000000000000000007", "0000000000000000009", null]);
    });

    it("treats an unchanged rebind as a no-op", async () => {
      const homeDir = home();
      const { held } = await enterSet(homeDir);
      const a = held.cutoverSet!.manifest.members[0]!.generationId;
      const first = await rebind(homeDir, held, a, resolveBackendMaintenanceGenerationBinding(held, a)!.checksumSha256);
      const second = await rebind(homeDir, first, a, resolveBackendMaintenanceGenerationBinding(first, a)!.checksumSha256);
      expect(second).toEqual(first);
    });

    it("refuses the journal checksum, a non-member, stale or foreign inputs", async () => {
      const homeDir = home();
      const { held } = await enterSet(homeDir);
      const a = held.cutoverSet!.manifest.members[0]!.generationId;
      const viewA = resolveBackendMaintenanceGenerationBinding(held, a)!;
      const refuse = (generationId: string, checksum: string, overrides = {}) =>
        expect(rebind(homeDir, held, generationId, checksum, overrides)).rejects.toMatchObject({ reason: "unexpected-state" });
      await refuse(a, held.checksumSha256);
      await refuse(a, HASH_A);
      await refuse(SET_ID, viewA.checksumSha256);
      await refuse("not-a-member", viewA.checksumSha256);
      await refuse(a, viewA.checksumSha256, { sourceSelectionSha256: HASH_A });
      await refuse(a, viewA.checksumSha256, { queueEvidenceSha256: "bad" });
      await refuse(a, viewA.checksumSha256, {
        roster: [{ machineId: "00000000-1234-7abc-8def-1234567890ab", queueCutoff: null, evidenceSha256: HASH_B }],
      });
      expect(readBackendMaintenanceJournal(homeDir)).toEqual(held);
    });

    it("refuses binding evidence that disagrees with its roster before writing", async () => {
      const homeDir = home();
      const { held } = await enterSet(homeDir);
      const a = held.cutoverSet!.manifest.members[0]!.generationId;
      await expect(rebind(homeDir, held, a, resolveBackendMaintenanceGenerationBinding(held, a)!.checksumSha256, {
        roster: [{ machineId: SET_MACHINE_ID, queueCutoff: "0000000000000000007", evidenceSha256: HASH_A }],
      })).rejects.toMatchObject({ reason: "malformed-journal" });
      expect(readBackendMaintenanceJournal(homeDir)).toEqual(held);
    });

    it("refuses a rebind after the hold is aborted", async () => {
      const homeDir = home();
      const { held } = await enterSet(homeDir);
      const a = held.cutoverSet!.manifest.members[0]!.generationId;
      const viewA = resolveBackendMaintenanceGenerationBinding(held, a)!;
      const aborted = await coordinator(homeDir).abortMaintenance({
        expectedChecksumSha256: held.checksumSha256,
        sourceSelectionSha256: held.sourceSelectionSha256,
        abortEvidenceSha256: HASH_B,
      });
      expect(resolveBackendMaintenanceGenerationBinding(aborted, a)!.checksumSha256).not.toBe(viewA.checksumSha256);
      await expect(rebind(homeDir, aborted, a, viewA.checksumSha256)).rejects.toMatchObject({ reason: "unexpected-state" });
    });

    it("never persists a journal the bounded reader cannot read", async () => {
      const homeDir = home();
      await enterSet(homeDir, 2);
      const entryFor = (size: number) =>
        cutoverSetMaintenanceEntry({ ...setManifest(2), members: manyMembers(size) });
      const entrySize = (size: number) => Buffer.byteLength(JSON.stringify({
        ...journalFile(homeDir),
        cutoverSet: entryFor(size).cutoverSet,
        sourceSelectionSha256: entryFor(size).sourceSelectionSha256,
        queueEvidenceSha256: entryFor(size).queueEvidenceSha256,
      })) + 1;
      // The largest set whose entry journal is readable although its worst case is not.
      let low = 2;
      let high = 3000;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (entrySize(mid) <= LIMIT) low = mid; else high = mid - 1;
      }
      const entry = entryFor(low);
      expect(backendCutoverSetJournalCapacity(entry.cutoverSet).worstCaseBytes).toBeGreaterThan(LIMIT);
      rewrite(homeDir, (payload) => {
        payload.cutoverSet = entry.cutoverSet;
        payload.sourceSelectionSha256 = entry.sourceSelectionSha256;
        payload.queueEvidenceSha256 = entry.queueEvidenceSha256;
        payload.roster = entry.roster;
      });
      let failure: unknown;
      let bound = 0;
      for (const member of entry.cutoverSet.manifest.members) {
        const current = readBackendMaintenanceJournal(homeDir)!;
        try {
          await rebind(homeDir, current, member.generationId,
            resolveBackendMaintenanceGenerationBinding(current, member.generationId)!.checksumSha256, {
              roster: [{ machineId: SET_MACHINE_ID, queueCutoff: "9223372036854775807", evidenceSha256: HASH_B }],
            });
          bound += 1;
        } catch (error) {
          failure = error;
          break;
        }
      }
      expect(failure).toMatchObject({ reason: "invalid-input", message: expect.stringContaining("cutover-set-too-large") });
      expect(bound).toBeLessThan(low);
      const survivor = readBackendMaintenanceJournal(homeDir)!;
      expect(survivor.cutoverSet!.bindings.filter((binding) => binding.roster[0]!.queueCutoff !== null)).toHaveLength(bound);
    }, 180_000);
  });

  describe("selection and abort", () => {
    it("refuses prepare and complete until a later child supports set selection", async () => {
      const homeDir = home();
      const { held } = await enterSet(homeDir);
      const member = held.cutoverSet!.manifest.members[0]!.generationId;
      await expect(coordinator(homeDir).prepareMaintenanceSelection({
        expectedChecksumSha256: held.checksumSha256,
        generationId: member,
        targetBackend: "postgresql",
        terminalEvidenceSha256: HASH_B,
      })).rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("not supported yet") });
      await expect(coordinator(homeDir).completeMaintenanceSelection({
        expectedChecksumSha256: held.checksumSha256,
        generationId: member,
        terminalEvidenceSha256: HASH_B,
      })).rejects.toMatchObject({ reason: "unexpected-state" });
      expect(readBackendMaintenanceJournal(homeDir)).toEqual(held);
    });

    it("aborts a set hold and keeps the set in the terminal journal", async () => {
      const homeDir = home();
      const { held } = await enterSet(homeDir);
      const aborted = await coordinator(homeDir).abortMaintenance({
        expectedChecksumSha256: held.checksumSha256,
        sourceSelectionSha256: held.sourceSelectionSha256,
        abortEvidenceSha256: HASH_B,
      });
      expect(aborted).toMatchObject({ phase: "maintenance-aborted", sourceBackend: "sqlite", abortEvidenceSha256: HASH_B });
      expect(aborted.cutoverSet).toEqual(held.cutoverSet);
      expect(readBackendMaintenanceJournal(homeDir)).toEqual(aborted);
      // A later single-generation hold archives the terminal set journal.
      const next = await coordinator(homeDir).enterMaintenance({
        publicationId: "migration-generation-2",
        generationId: "generation-2",
        sourceSelectionSha256: HASH_A,
        queueEvidenceSha256: HASH_B,
        roster: [{ machineId: SET_MACHINE_ID, queueCutoff: null, evidenceSha256: HASH_B }],
        now: NOW,
      });
      expect("cutoverSet" in next).toBe(false);
    });
  });
});


// ---------------------------------------------------------------------------
// #1549: the complete set selection tuple and the selection transitions.
// ---------------------------------------------------------------------------

const REMOTE_A = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9001";
const REMOTE_B = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9002";
const REMOTE_C = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9003";
const HEX = (value: string) => value.repeat(64);

type SelectionBody = Omit<BackendCutoverSetSelection, "checksumSha256">;

/** A complete tuple for the manifest, with a reproduced checksum (unless overridden after sealing). */
function selectionFor(manifest: BackendCutoverSetManifest, edit: (body: Record<string, any>) => void = () => undefined): BackendCutoverSetSelection {
  const body: Record<string, any> = {
    version: 1,
    kind: "cutover-set-selection",
    checkpointSha256: HEX("c"),
    setId: manifest.setId,
    manifestSha256: backendCutoverSetManifestSha256(manifest),
    publicationId: manifest.setId,
    identityDigest: HEX("d"),
    sourceBackend: "sqlite",
    targetBackend: "postgresql",
    members: manifest.members.map((member, index) => ({
      physicalProjectId: member.physicalProjectId,
      generationId: member.generationId,
      remoteProjectId: [REMOTE_A, REMOTE_B, REMOTE_C][index]!,
      copyBindingSha256: HEX(String(index + 1)),
      epochId: HEX("e"),
      attemptId: HEX("a"),
      epochManifestRevision: 8,
      epochManifestChecksumSha256: HEX("b"),
      witnessChecksumSha256: HEX(String(index + 4)),
    })),
  };
  edit(body);
  return { ...(body as SelectionBody), checksumSha256: backendCutoverSetSelectionSha256(body as SelectionBody) };
}

/** Bind every member off its sentinel so the hold looks like a prepared set. */
async function boundSet(homeDir: string, count = 3): Promise<BackendMaintenanceJournal> {
  const { held } = await enterSet(homeDir, count);
  let current = held;
  for (const member of held.cutoverSet!.manifest.members) {
    const view = resolveBackendMaintenanceGenerationBinding(current, member.generationId)!;
    current = await rebind(homeDir, current, member.generationId, view.checksumSha256);
  }
  return current;
}

function prepareInput(journal: BackendMaintenanceJournal, selection: BackendCutoverSetSelection, overrides: Record<string, unknown> = {}) {
  return {
    expectedChecksumSha256: journal.checksumSha256,
    generationId: journal.generationId,
    targetBackend: "postgresql" as const,
    terminalEvidenceSha256: selection.checksumSha256,
    cutoverSetSelection: selection,
    ...overrides,
  } as Parameters<BackendPublicationCoordinator["prepareMaintenanceSelection"]>[0];
}

describe("cutover-set selection tuple (#1549)", () => {
  it("prepares one selection-prepared journal carrying every member, then completes the same tuple", async () => {
    const homeDir = home();
    const held = await boundSet(homeDir);
    const manifest = held.cutoverSet!.manifest;
    const selection = selectionFor(manifest);
    const prepared = await coordinator(homeDir).prepareMaintenanceSelection(prepareInput(held, selection));
    expect(prepared).toMatchObject({
      phase: "selection-prepared", targetBackend: "postgresql", selectedGenerationId: SET_ID,
      terminalEvidenceSha256: selection.checksumSha256, abortEvidenceSha256: null,
    });
    expect(prepared.cutoverSet!.selection).toEqual(selection);
    expect(prepared.cutoverSet!.bindings).toEqual(held.cutoverSet!.bindings);
    expect(readBackendMaintenanceJournal(homeDir)).toEqual(prepared);
    // The held member digests are no longer the live member digests, and the live digest is not selection input.
    for (const member of manifest.members) {
      expect(resolveBackendMaintenanceGenerationBinding(prepared, member.generationId)!.checksumSha256)
        .not.toBe(resolveBackendMaintenanceGenerationBinding(held, member.generationId)!.checksumSha256);
    }
    const completed = await coordinator(homeDir).completeMaintenanceSelection({
      expectedChecksumSha256: prepared.checksumSha256, generationId: SET_ID, terminalEvidenceSha256: selection.checksumSha256,
    });
    expect(completed).toMatchObject({ phase: "selection-completed", terminalEvidenceSha256: selection.checksumSha256 });
    expect(completed.cutoverSet).toEqual(prepared.cutoverSet);
    expect(readBackendMaintenanceJournal(homeDir)).toEqual(completed);
    // A later hold archives the terminal set journal exactly as an aborted one.
    const next = await coordinator(homeDir).enterMaintenance({
      publicationId: "migration-generation-2", generationId: "generation-2", sourceSelectionSha256: HASH_A,
      queueEvidenceSha256: HASH_B, roster: [{ machineId: SET_MACHINE_ID, queueCutoff: null, evidenceSha256: HASH_B }], now: NOW,
    });
    expect("cutoverSet" in next).toBe(false);
  });

  it("never accepts a held member binding digest, a bare witness or a rehashed tuple as the selection", async () => {
    const homeDir = home();
    const held = await boundSet(homeDir);
    const manifest = held.cutoverSet!.manifest;
    const selection = selectionFor(manifest);
    const heldDigest = resolveBackendMaintenanceGenerationBinding(held, manifest.members[0]!.generationId)!.checksumSha256;
    // The held digest offered as the terminal evidence of a valid tuple contradicts the tuple.
    await expect(coordinator(homeDir).prepareMaintenanceSelection(prepareInput(held, selection, { terminalEvidenceSha256: heldDigest })))
      .rejects.toMatchObject({ reason: "invalid-input", message: expect.stringContaining("contradicts") });
    // The held digest, or any member witness, offered as the tuple checksum does not reproduce the tuple.
    for (const forged of [heldDigest, selection.members[0]!.witnessChecksumSha256]) {
      const tuple = { ...selection, checksumSha256: forged };
      await expect(coordinator(homeDir).prepareMaintenanceSelection(prepareInput(held, tuple)))
        .rejects.toMatchObject({ reason: "invalid-input", message: expect.stringContaining("checksum does not match") });
    }
    // A tuple-less prepare on a set hold keeps refusing; a tuple on a single-generation hold is contradictory input.
    await expect(coordinator(homeDir).prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256, generationId: SET_ID, targetBackend: "postgresql", terminalEvidenceSha256: selection.checksumSha256,
    })).rejects.toMatchObject({ reason: "unexpected-state" });
    expect(readBackendMaintenanceJournal(homeDir)).toEqual(held);
    const single = home();
    const singleHeld = await coordinator(single).enterMaintenance({
      publicationId: "migration-generation-1", generationId: "generation-1", sourceSelectionSha256: HASH_A, queueEvidenceSha256: HASH_B,
      roster: [{ machineId: SET_MACHINE_ID, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A }], now: NOW,
    });
    await expect(coordinator(single).prepareMaintenanceSelection({
      expectedChecksumSha256: singleHeld.checksumSha256, generationId: "generation-1", targetBackend: "postgresql",
      terminalEvidenceSha256: selection.checksumSha256, cutoverSetSelection: selection,
    })).rejects.toMatchObject({ reason: "invalid-input", message: expect.stringContaining("single-generation") });
    expect(readBackendMaintenanceJournal(single)).toEqual(singleHeld);
  });

  it("refuses every contradictory prepare input and preserves the CAS and phase classification", async () => {
    const homeDir = home();
    const held = await boundSet(homeDir);
    const manifest = held.cutoverSet!.manifest;
    const selection = selectionFor(manifest);
    const run = (overrides: Record<string, unknown>) => coordinator(homeDir).prepareMaintenanceSelection(prepareInput(held, selection, overrides));
    await expect(run({ generationId: manifest.members[0]!.generationId })).rejects.toMatchObject({ reason: "invalid-input", message: expect.stringContaining("contradicts") });
    await expect(run({ targetBackend: "sqlite" })).rejects.toMatchObject({ reason: "invalid-input", message: expect.stringContaining("contradicts") });
    await expect(run({ terminalEvidenceSha256: HASH_B })).rejects.toMatchObject({ reason: "invalid-input", message: expect.stringContaining("contradicts") });
    await expect(run({ cutoverSetSelection: { ...selection, extra: 1 } })).rejects.toMatchObject({ reason: "invalid-input", message: expect.stringContaining("malformed") });
    await expect(run({ terminalEvidenceSha256: "nope" })).rejects.toMatchObject({ reason: "invalid-input", message: expect.stringContaining("selection input is malformed") });
    await expect(run({ expectedChecksumSha256: HASH_A })).rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("held state") });
    expect(readBackendMaintenanceJournal(homeDir)).toEqual(held);
    const prepared = await coordinator(homeDir).prepareMaintenanceSelection(prepareInput(held, selection));
    await expect(coordinator(homeDir).prepareMaintenanceSelection(prepareInput(prepared, selection)))
      .rejects.toMatchObject({ reason: "unexpected-state" });
    await expect(coordinator(homeDir).completeMaintenanceSelection({
      expectedChecksumSha256: prepared.checksumSha256, generationId: SET_ID, terminalEvidenceSha256: HASH_B,
    })).rejects.toMatchObject({ reason: "unexpected-state" });
    await expect(coordinator(homeDir).abortMaintenance({
      expectedChecksumSha256: prepared.checksumSha256, sourceSelectionSha256: prepared.sourceSelectionSha256, abortEvidenceSha256: HASH_B,
    })).rejects.toMatchObject({ reason: "unexpected-state" });
    expect(readBackendMaintenanceJournal(homeDir)).toEqual(prepared);
  });

  describe("parser", () => {
    const manifest = setManifest(3);
    const cases: readonly (readonly [string, RegExp, (body: Record<string, any>) => void])[] = [
      ["an extra key", /selection is malformed/, (b) => { b.extra = 1; }],
      ["a missing key", /selection is malformed/, (b) => { delete b.identityDigest; }],
      ["another set id", /selection is malformed/, (b) => { b.setId = "cutover-set-2"; }],
      ["another manifest digest", /selection is malformed/, (b) => { b.manifestSha256 = HASH_A; }],
      ["a publication id that is not the set id", /selection is malformed/, (b) => { b.publicationId = "other"; }],
      ["a postgresql source", /selection is malformed/, (b) => { b.sourceBackend = "postgresql"; }],
      ["a sqlite target", /selection is malformed/, (b) => { b.targetBackend = "sqlite"; }],
      ["a missing member", /selection is malformed/, (b) => { b.members.pop(); }],
      ["an extra member", /selection is malformed/, (b) => { b.members.push({ ...b.members[0] }); }],
      ["a duplicate member", /member\[1\] is malformed/, (b) => { b.members[1] = { ...b.members[0] }; }],
      ["reordered members", /member\[0\] is malformed/, (b) => { b.members.reverse(); }],
      ["a wrong generation", /member\[2\] is malformed/, (b) => { b.members[2].generationId = "member-generation-9"; }],
      ["a wrong project", /member\[0\] is malformed/, (b) => { b.members[0].physicalProjectId = HASH_A; }],
      ["a malformed remote id", /member\[0\] is malformed/, (b) => { b.members[0].remoteProjectId = "not-a-uuid"; }],
      ["a repeated remote id", /remote projects are not unique/, (b) => { b.members[1].remoteProjectId = b.members[0].remoteProjectId; }],
      ["a negative revision", /member\[0\] is malformed/, (b) => { b.members[0].epochManifestRevision = -1; }],
      ["a fractional revision", /member\[0\] is malformed/, (b) => { b.members[0].epochManifestRevision = 1.5; }],
      ["a member key missing", /member\[1\] is malformed/, (b) => { delete b.members[1].attemptId; }],
      ["a short witness checksum", /member\[1\] is malformed/, (b) => { b.members[1].witnessChecksumSha256 = "abc"; }],
    ];
    for (const [label, pattern, edit] of cases) {
      it("refuses " + label, () => {
        expect(() => parseBackendCutoverSetSelection(selectionFor(manifest, edit), manifest))
          .toThrow(expect.objectContaining({ reason: "malformed-journal", message: expect.stringMatching(pattern) }));
      });
    }
    it("refuses a tampered field whose checksum was not recomputed, and accepts the reproduced tuple", () => {
      const selection = selectionFor(manifest);
      expect(() => parseBackendCutoverSetSelection({ ...selection, members: selection.members.map((m, i) => i === 0 ? { ...m, attemptId: HASH_B } : m) }, manifest))
        .toThrow(expect.objectContaining({ message: expect.stringMatching(/checksum does not match/) }));
      expect(parseBackendCutoverSetSelection(selection, manifest)).toEqual(selection);
      expect(parseBackendCutoverSetSelection(JSON.parse(JSON.stringify(selection)), manifest)).toEqual(selection);
    });
  });

  describe("journal invariants", () => {
    it("refuses a selection at a held phase, a selection phase without one, and top-level disagreement", async () => {
      const homeDir = home();
      const held = await boundSet(homeDir);
      const selection = selectionFor(held.cutoverSet!.manifest);
      const expectMalformed = (edit: (p: Payload) => void) => {
        rewrite(homeDir, edit);
        expect(() => readBackendMaintenanceJournal(homeDir)).toThrow(expect.objectContaining({ reason: "malformed-journal" }));
      };
      const snapshot = journalFile(homeDir);
      const restore = () => { writeFileSync(backendPublicationJournalPath(homeDir), JSON.stringify(snapshot)); };
      expectMalformed((p) => { p.cutoverSet.selection = selection; });
      restore();
      const selected = (p: Payload) => {
        p.phase = "selection-completed"; p.targetBackend = "postgresql"; p.selectedGenerationId = SET_ID;
        p.terminalEvidenceSha256 = selection.checksumSha256; p.cutoverSet.selection = selection;
      };
      expectMalformed((p) => { selected(p); delete p.cutoverSet.selection; });
      restore();
      expectMalformed((p) => { selected(p); p.terminalEvidenceSha256 = HASH_B; });
      restore();
      expectMalformed((p) => { selected(p); p.targetBackend = "sqlite"; });
      restore();
      expectMalformed((p) => { selected(p); p.sourceBackend = "postgresql"; });
      restore();
      expectMalformed((p) => { p.phase = "maintenance-aborted"; p.abortEvidenceSha256 = HASH_B; p.cutoverSet.selection = selection; });
      restore();
      rewrite(homeDir, selected);
      expect(readBackendMaintenanceJournal(homeDir)).toMatchObject({ phase: "selection-completed", cutoverSet: { selection } });
    });
  });

  describe("capacity", () => {
    /** The worst case with a real manifest digest, distinct remote ids and a reproduced checksum: same width, parseable. */
    function widestSelection(manifest: BackendCutoverSetManifest): BackendCutoverSetSelection {
      const worst = backendCutoverSetSelectionWorstCase(manifest);
      const body = {
        ...worst,
        manifestSha256: backendCutoverSetManifestSha256(manifest),
        members: worst.members.map((member, index) => ({ ...member, remoteProjectId: "ffffffff-ffff-7fff-bfff-" + index.toString(16).padStart(12, "0") })),
      };
      return { ...body, checksumSha256: backendCutoverSetSelectionSha256(body) };
    }

    function abortWorstBytes(manifest: BackendCutoverSetManifest): number {
      const hex = "f".repeat(64);
      return Buffer.byteLength(JSON.stringify({
        version: 3, publicationId: manifest.setId, sourceBackend: "postgresql", targetBackend: null, phase: "maintenance-aborted",
        createdAt: "+275760-09-13T00:00:00.000Z", updatedAt: "+275760-09-13T00:00:00.000Z", generationId: manifest.setId,
        sourceSelectionSha256: hex, queueEvidenceSha256: hex,
        roster: [{ machineId: manifest.machineId, queueCutoff: null, evidenceSha256: hex }],
        selectedGenerationId: null, terminalEvidenceSha256: null, abortEvidenceSha256: hex,
        cutoverSet: { manifest, bindings: manifest.members.map((m) => ({ generationId: m.generationId, queueEvidenceSha256: hex,
          roster: [{ machineId: manifest.machineId, queueCutoff: "9223372036854775807", evidenceSha256: hex }] })) },
        checksumSha256: hex,
      })) + 1;
    }

    it("reserves the larger of the abort and the complete-selection shapes", () => {
      const manifest = setManifest(3);
      const entry = cutoverSetMaintenanceEntry(manifest);
      const capacity = backendCutoverSetJournalCapacity(entry.cutoverSet);
      const selectionBytes = Buffer.byteLength(JSON.stringify(backendCutoverSetSelectionWorstCase(manifest)));
      expect(capacity.worstCaseBytes).toBeGreaterThan(abortWorstBytes(manifest));
      expect(capacity.worstCaseBytes).toBeGreaterThan(selectionBytes);
      expect(backendCutoverSetSelectionWorstCase(manifest).members).toHaveLength(3);
      // The widest parseable tuple has exactly the worst case's byte length.
      expect(Buffer.byteLength(JSON.stringify(widestSelection(manifest)))).toBe(selectionBytes);
      expect(parseBackendCutoverSetSelection(widestSelection(manifest), manifest)).toEqual(widestSelection(manifest));
    });

    it("admits the largest membership whose complete selection is readable and refuses one more", async () => {
      const entryFor = (size: number) => cutoverSetMaintenanceEntry({ ...setManifest(2), members: manyMembers(size) });
      let low = 2;
      let high = 3000;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (backendCutoverSetJournalCapacity(entryFor(mid).cutoverSet).worstCaseBytes <= LIMIT) low = mid; else high = mid - 1;
      }
      const homeDir = home();
      const held = await coordinator(homeDir).enterMaintenance({ ...entryFor(low), now: NOW });
      await expect(coordinator(home()).enterMaintenance({ ...entryFor(low + 1), now: NOW }))
        .rejects.toMatchObject({ reason: "invalid-input", message: expect.stringContaining("cutover-set-too-large") });
      // Bind every member at the maximum cutoff and select with full-width hashes: both writes stay readable.
      rewrite(homeDir, (payload) => {
        payload.cutoverSet.bindings = payload.cutoverSet.bindings.map((binding: Payload) => ({
          ...binding, queueEvidenceSha256: "f".repeat(64),
          roster: [{ machineId: SET_MACHINE_ID, queueCutoff: "9223372036854775807", evidenceSha256: "f".repeat(64) }],
        }));
        payload.queueEvidenceSha256 = backendPublicationCanonicalSha256({
          version: 1, kind: "cutover-set-queue-evidence",
          bindings: payload.cutoverSet.bindings.map((b: Payload) => ({ generationId: b.generationId, queueEvidenceSha256: b.queueEvidenceSha256 })),
        });
      });
      const bound = readBackendMaintenanceJournal(homeDir)!;
      expect(bound.cutoverSet!.manifest).toEqual(held.cutoverSet!.manifest);
      const selection = widestSelection(bound.cutoverSet!.manifest);
      const prepared = await coordinator(homeDir).prepareMaintenanceSelection(prepareInput(bound, selection));
      expect(readBackendMaintenanceJournal(homeDir)).toEqual(prepared);
      const completed = await coordinator(homeDir).completeMaintenanceSelection({
        expectedChecksumSha256: prepared.checksumSha256, generationId: SET_ID, terminalEvidenceSha256: selection.checksumSha256,
      });
      expect(readBackendMaintenanceJournal(homeDir)).toMatchObject({ phase: "selection-completed", cutoverSet: { selection } });
      expect(completed.cutoverSet!.selection!.members).toHaveLength(low);
    }, 120_000);

    it("refuses to select a legacy held set that cannot fit its selection, which stays abortable", async () => {
      const entryFor = (size: number) => cutoverSetMaintenanceEntry({ ...setManifest(2), members: manyMembers(size) });
      // The largest membership whose abort shape fits although its complete selection does not.
      let low = 2;
      let high = 3000;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (abortWorstBytes(entryFor(mid).cutoverSet.manifest) <= LIMIT) low = mid; else high = mid - 1;
      }
      const entry = entryFor(low);
      expect(backendCutoverSetJournalCapacity(entry.cutoverSet).worstCaseBytes).toBeGreaterThan(LIMIT);
      const homeDir = home();
      await enterSet(homeDir, 2);
      rewrite(homeDir, (payload) => {
        payload.cutoverSet = entry.cutoverSet;
        payload.sourceSelectionSha256 = entry.sourceSelectionSha256;
        payload.queueEvidenceSha256 = entry.queueEvidenceSha256;
        payload.roster = entry.roster;
      });
      const legacy = readBackendMaintenanceJournal(homeDir)!;
      const selection = widestSelection(legacy.cutoverSet!.manifest);
      await expect(coordinator(homeDir).prepareMaintenanceSelection(prepareInput(legacy, selection)))
        .rejects.toMatchObject({ reason: "invalid-input", message: expect.stringContaining("cutover-set-too-large") });
      expect(readBackendMaintenanceJournal(homeDir)).toEqual(legacy);
      const aborted = await coordinator(homeDir).abortMaintenance({
        expectedChecksumSha256: legacy.checksumSha256, sourceSelectionSha256: legacy.sourceSelectionSha256, abortEvidenceSha256: HASH_B,
      });
      expect(readBackendMaintenanceJournal(homeDir)).toEqual(aborted);
      expect(aborted.phase).toBe("maintenance-aborted");
    }, 120_000);
  });
});

