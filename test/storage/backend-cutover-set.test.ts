import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackendPublicationCoordinator,
  BackendPublicationJournalError,
  backendCutoverSetJournalCapacity,
  backendCutoverSetManifestSha256,
  backendMaintenanceQueueEvidenceSentinel,
  backendPublicationCanonicalSha256,
  backendPublicationJournalPath,
  readBackendMaintenanceJournal,
  rebindBackendMaintenanceCutoff,
  resolveBackendMaintenanceGenerationBinding,
  withBackendPublicationAppendBarrierAsync,
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
