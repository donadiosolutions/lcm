import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackendPublicationCoordinator,
  backendCutoverSetJournalCapacity,
  backendCutoverSetManifestSha256,
  backendCutoverSetRollbackJournalCapacity,
  backendCutoverSetRollbackSelectionSha256,
  backendCutoverSetRollbackSelectionWorstCase,
  backendCutoverSetSelectionSha256,
  backendCutoverSetSelectionWorstCase,
  backendPublicationCanonicalSha256,
  parseBackendCutoverSet,
  parseBackendCutoverSetAnySelection,
  parseBackendCutoverSetRollbackSelection,
  parseBackendCutoverSetSelection,
  readBackendMaintenanceJournal,
  type BackendCutoverSetManifest,
  type BackendCutoverSetRollbackSelection,
  type BackendCutoverSetRollbackSelectionMember,
  type BackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { cutoverSetMaintenanceEntry } from "../../src/migration/cutover-set.js";
import { SET_ID, SET_MACHINE_ID, setManifest, sourceHash } from "../fixtures/cutover-set.js";

/**
 * The thin reverse selection tuple of a set rollback (#1550, plan-v2 C2):
 * strict parsing, domain-separated digest, the journal rule for a
 * postgresql-origin hold, and the capacity proof that every membership the
 * activation budget admits also fits the rollback hold's terminal journal.
 */

const HEX = "f".repeat(64);
const NOW = new Date("2026-10-21T00:00:00.000Z");
const LIMIT = 1024 * 1024;
const ROLLBACK_SET_ID = "1".repeat(64);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-cutover-set-rollback-storage-"));
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

function rollbackManifest(count = 2): BackendCutoverSetManifest {
  return { ...setManifest(count), setId: ROLLBACK_SET_ID };
}

function member(manifest: BackendCutoverSetManifest, index: number): BackendCutoverSetRollbackSelectionMember {
  const expected = manifest.members[index]!;
  return {
    physicalProjectId: expected.physicalProjectId, generationId: expected.generationId,
    remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f900" + String(index + 1),
    mode: index % 2 === 0 ? "pre-write" : "post-write",
    epochId: sourceHash(100 + index), attemptId: sourceHash(200 + index),
    witnessChecksumSha256: sourceHash(300 + index), installEvidenceSha256: sourceHash(400 + index),
  };
}

function tuple(manifest: BackendCutoverSetManifest, overrides: Record<string, unknown> = {}): BackendCutoverSetRollbackSelection {
  const body = {
    version: 1 as const, kind: "cutover-set-rollback-selection" as const,
    setId: manifest.setId, manifestSha256: backendCutoverSetManifestSha256(manifest), publicationId: manifest.setId,
    originalSetId: SET_ID, originalSelectionSha256: sourceHash(1), checkpointSha256: sourceHash(2), identityDigest: sourceHash(3),
    sourceBackend: "postgresql" as const, targetBackend: "sqlite" as const,
    members: manifest.members.map((_, index) => member(manifest, index)),
    ...overrides,
  };
  return { ...body, checksumSha256: backendCutoverSetRollbackSelectionSha256(body) } as BackendCutoverSetRollbackSelection;
}

async function enterRollbackHold(homeDir: string, count = 2): Promise<BackendMaintenanceJournal> {
  const entry = cutoverSetMaintenanceEntry(rollbackManifest(count));
  return coordinator(homeDir).enterMaintenance({ ...entry, sourceBackend: "postgresql", now: NOW });
}

function manyMembers(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    physicalProjectId: (index + 1).toString(16).padStart(64, "0"),
    generationId: "member-generation-" + String(index + 1),
    sourceSelectionSha256: sourceHash(index + 1),
  }));
}

describe("parseBackendCutoverSetRollbackSelection", () => {
  it("round-trips a complete tuple and dispatches by kind", () => {
    const manifest = rollbackManifest(3);
    const selection = tuple(manifest);
    expect(parseBackendCutoverSetRollbackSelection(selection, manifest)).toEqual(selection);
    expect(parseBackendCutoverSetAnySelection(selection, manifest)).toEqual(selection);
    expect(parseBackendCutoverSetAnySelection(JSON.parse(JSON.stringify(selection)), manifest)).toEqual(selection);
    // The activation parser never admits a rollback tuple, and the rollback parser never admits an activation tuple.
    expect(() => parseBackendCutoverSetSelection(selection, manifest)).toThrow(/selection is malformed/u);
    const activation = backendCutoverSetSelectionWorstCase(manifest);
    expect(() => parseBackendCutoverSetRollbackSelection(activation, manifest)).toThrow(/rollback selection is malformed/u);
    // The dispatcher routes an activation-kind tuple to the activation parser (which refuses the worst case's placeholder digests).
    expect(() => parseBackendCutoverSetAnySelection(activation, manifest)).toThrow(/^backend cutover-set selection is malformed$/u);
    expect(() => parseBackendCutoverSetAnySelection("not a tuple", manifest)).toThrow(/selection is malformed/u);
  });

  it("domain-separates its digest from the activation tuple's", () => {
    const manifest = rollbackManifest(2);
    const selection = tuple(manifest);
    const { checksumSha256: _checksum, ...body } = selection;
    expect(backendCutoverSetSelectionSha256(body as never)).not.toBe(selection.checksumSha256);
    expect(backendPublicationCanonicalSha256(body)).not.toBe(selection.checksumSha256);
    expect(() => parseBackendCutoverSetRollbackSelection({ ...selection, checksumSha256: backendPublicationCanonicalSha256(body) }, manifest))
      .toThrow(/rollback selection checksum does not match/u);
  });

  it("refuses every malformed top-level field", () => {
    const manifest = rollbackManifest(2);
    const good = tuple(manifest);
    const variants: Record<string, unknown>[] = [
      { version: 2 }, { kind: "cutover-set-selection" }, { checkpointSha256: "nope" }, { identityDigest: "x" },
      { originalSelectionSha256: 7 }, { originalSetId: "bad id!" }, { originalSetId: manifest.setId }, { originalSetId: 5 },
      { setId: SET_ID }, { manifestSha256: HEX }, { publicationId: SET_ID }, { sourceBackend: "sqlite" }, { targetBackend: "postgresql" },
      { members: "none" }, { members: good.members.slice(0, 1) }, { members: [...good.members, good.members[0]] }, { extra: true },
    ];
    for (const variant of variants) {
      const { checksumSha256: _checksum, ...body } = { ...good, ...variant };
      const forged = { ...body, checksumSha256: backendCutoverSetRollbackSelectionSha256(body as never) };
      expect(() => parseBackendCutoverSetRollbackSelection(forged, manifest), JSON.stringify(variant)).toThrow(/rollback selection is malformed/u);
    }
    const { checksumSha256: _c, ...withoutChecksum } = good;
    expect(() => parseBackendCutoverSetRollbackSelection(withoutChecksum, manifest)).toThrow(/rollback selection is malformed/u);
    expect(() => parseBackendCutoverSetRollbackSelection({ ...good, checksumSha256: "0".repeat(64) }, manifest))
      .toThrow(/rollback selection checksum does not match/u);
  });

  it("refuses every malformed, reordered, duplicated or foreign member row", () => {
    const manifest = rollbackManifest(3);
    const good = tuple(manifest);
    const rows = good.members;
    const forgedWith = (members: unknown[]) => {
      const body = { ...good, members } as Record<string, unknown>;
      delete body.checksumSha256;
      return { ...body, checksumSha256: backendCutoverSetRollbackSelectionSha256(body as never) };
    };
    const rowVariants: Record<string, unknown>[] = [
      { physicalProjectId: rows[1]!.physicalProjectId }, { generationId: rows[1]!.generationId }, { remoteProjectId: "not-a-uuid" },
      { remoteProjectId: 3 }, { mode: "unknown" }, { mode: null }, { epochId: "short" }, { attemptId: 9 }, { witnessChecksumSha256: "" },
      { installEvidenceSha256: HEX.slice(1) }, { extra: 1 },
    ];
    for (const variant of rowVariants) {
      expect(() => parseBackendCutoverSetRollbackSelection(forgedWith([{ ...rows[0], ...variant }, rows[1], rows[2]]), manifest), JSON.stringify(variant))
        .toThrow(/rollback selection member\[0\] is malformed/u);
    }
    const { installEvidenceSha256: _dropped, ...missingKey } = rows[0]!;
    expect(() => parseBackendCutoverSetRollbackSelection(forgedWith([missingKey, rows[1], rows[2]]), manifest)).toThrow(/member\[0\] is malformed/u);
    expect(() => parseBackendCutoverSetRollbackSelection(forgedWith(["row", rows[1], rows[2]]), manifest)).toThrow(/member\[0\] is malformed/u);
    expect(() => parseBackendCutoverSetRollbackSelection(forgedWith([rows[1], rows[0], rows[2]]), manifest)).toThrow(/member\[0\] is malformed/u);
    expect(() => parseBackendCutoverSetRollbackSelection(forgedWith([rows[0], { ...rows[1], remoteProjectId: rows[0]!.remoteProjectId }, rows[2]]), manifest))
      .toThrow(/remote projects are not unique/u);
    // The activation worst case's member row substituted for a rollback row fails the row shape.
    const activationRow = backendCutoverSetSelectionWorstCase(manifest).members[0];
    expect(() => parseBackendCutoverSetRollbackSelection(forgedWith([activationRow, rows[1], rows[2]]), manifest)).toThrow(/member\[0\] is malformed/u);
  });

  it("parses a set carrying a rollback selection through parseBackendCutoverSet", () => {
    const manifest = rollbackManifest(2);
    const entry = cutoverSetMaintenanceEntry(manifest);
    const selection = tuple(manifest);
    const parsed = parseBackendCutoverSet({ manifest, bindings: entry.cutoverSet.bindings, selection });
    expect(parsed.selection).toEqual(selection);
    expect(parseBackendCutoverSet({ manifest, bindings: entry.cutoverSet.bindings }).selection).toBeUndefined();
  });
});

describe("the rollback hold's selection phases", () => {
  it("prepares and completes a postgresql-origin set hold with the rollback tuple, readable through the journal reader", async () => {
    const homeDir = home();
    const held = await enterRollbackHold(homeDir, 2);
    expect(held).toMatchObject({ phase: "maintenance-held", sourceBackend: "postgresql", generationId: ROLLBACK_SET_ID });
    const selection = tuple(held.cutoverSet!.manifest);
    const prepared = await coordinator(homeDir).prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256, generationId: ROLLBACK_SET_ID, targetBackend: "sqlite",
      terminalEvidenceSha256: selection.checksumSha256, cutoverSetSelection: selection,
    });
    expect(prepared).toMatchObject({
      phase: "selection-prepared", sourceBackend: "postgresql", targetBackend: "sqlite", selectedGenerationId: ROLLBACK_SET_ID,
      terminalEvidenceSha256: selection.checksumSha256,
    });
    expect(prepared.cutoverSet!.selection).toEqual(selection);
    expect(readBackendMaintenanceJournal(homeDir)).toEqual(prepared);
    const completed = await coordinator(homeDir).completeMaintenanceSelection({
      expectedChecksumSha256: prepared.checksumSha256, generationId: ROLLBACK_SET_ID, terminalEvidenceSha256: selection.checksumSha256,
    });
    expect(completed.phase).toBe("selection-completed");
    expect(readBackendMaintenanceJournal(homeDir)!.cutoverSet!.selection).toEqual(selection);
  });

  it("refuses a rollback tuple on a sqlite-origin hold, an activation tuple on a postgresql-origin hold and a contradicting target", async () => {
    const homeDir = home();
    const held = await enterRollbackHold(homeDir, 2);
    const selection = tuple(held.cutoverSet!.manifest);
    await expect(coordinator(homeDir).prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256, generationId: ROLLBACK_SET_ID, targetBackend: "postgresql",
      terminalEvidenceSha256: selection.checksumSha256, cutoverSetSelection: selection,
    })).rejects.toMatchObject({ reason: "invalid-input", message: expect.stringContaining("contradicts") });
    const worst = backendCutoverSetSelectionWorstCase(held.cutoverSet!.manifest);
    const activation = {
      ...worst, manifestSha256: backendCutoverSetManifestSha256(held.cutoverSet!.manifest),
      members: worst.members.map((row, index) => ({ ...row, remoteProjectId: "ffffffff-ffff-7fff-bfff-" + index.toString(16).padStart(12, "0") })),
    };
    const activationTuple = { ...activation, checksumSha256: backendCutoverSetSelectionSha256(activation) };
    await expect(coordinator(homeDir).prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256, generationId: ROLLBACK_SET_ID, targetBackend: "postgresql",
      terminalEvidenceSha256: activationTuple.checksumSha256, cutoverSetSelection: activationTuple,
    })).rejects.toMatchObject({ reason: "invalid-input", message: expect.stringContaining("contradicts") });
    expect(readBackendMaintenanceJournal(homeDir)).toEqual(held);

    const forward = home();
    const sqliteHeld = await coordinator(forward).enterMaintenance({ ...cutoverSetMaintenanceEntry(rollbackManifest(2)), now: NOW });
    await expect(coordinator(forward).prepareMaintenanceSelection({
      expectedChecksumSha256: sqliteHeld.checksumSha256, generationId: ROLLBACK_SET_ID, targetBackend: "sqlite",
      terminalEvidenceSha256: selection.checksumSha256, cutoverSetSelection: selection,
    })).rejects.toMatchObject({ reason: "invalid-input", message: expect.stringContaining("contradicts") });
    await expect(coordinator(forward).prepareMaintenanceSelection({
      expectedChecksumSha256: sqliteHeld.checksumSha256, generationId: ROLLBACK_SET_ID, targetBackend: "sqlite",
      terminalEvidenceSha256: selection.checksumSha256, cutoverSetSelection: { ...selection, checksumSha256: HEX },
    })).rejects.toMatchObject({ reason: "invalid-input", message: expect.stringContaining("malformed") });
  });
});

describe("capacity", () => {
  it("reserves the larger of the abort and the rollback-selection shapes for a rollback hold", () => {
    const manifest = rollbackManifest(3);
    const entry = cutoverSetMaintenanceEntry(manifest);
    const capacity = backendCutoverSetRollbackJournalCapacity(entry.cutoverSet, SET_ID);
    expect(capacity.limitBytes).toBe(LIMIT);
    const worst = backendCutoverSetRollbackSelectionWorstCase(manifest, SET_ID);
    expect(worst.members).toHaveLength(3);
    expect(capacity.worstCaseBytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(worst)));
    // The widest parseable tuple has exactly the worst case's width.
    const body = { ...worst, manifestSha256: backendCutoverSetManifestSha256(manifest),
      members: worst.members.map((row, index) => ({ ...row, remoteProjectId: "ffffffff-ffff-7fff-bfff-" + index.toString(16).padStart(12, "0") })) };
    const widest = { ...body, checksumSha256: backendCutoverSetRollbackSelectionSha256(body) };
    expect(Buffer.byteLength(JSON.stringify(widest))).toBe(Buffer.byteLength(JSON.stringify(worst)));
    expect(parseBackendCutoverSetRollbackSelection(widest, manifest)).toEqual(widest);
  });

  it("fits every membership the activation budget admits, up to and including the largest one", async () => {
    // The original set id at its widest; the rollback hold id is a 64-hex digest.
    const originalSetId = "s".repeat(128);
    const activationEntry = (size: number) => cutoverSetMaintenanceEntry({ ...setManifest(2, originalSetId), members: manyMembers(size) });
    const rollbackEntry = (size: number) => cutoverSetMaintenanceEntry({ ...setManifest(2, ROLLBACK_SET_ID), members: manyMembers(size) });
    let low = 2;
    let high = 3000;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (backendCutoverSetJournalCapacity(activationEntry(mid).cutoverSet).worstCaseBytes <= LIMIT) low = mid; else high = mid - 1;
    }
    for (const size of [2, 3, Math.floor(low / 2), low]) {
      const activation = backendCutoverSetJournalCapacity(activationEntry(size).cutoverSet).worstCaseBytes;
      const rollback = backendCutoverSetRollbackJournalCapacity(rollbackEntry(size).cutoverSet, originalSetId).worstCaseBytes;
      expect(activation, String(size)).toBeLessThanOrEqual(LIMIT);
      expect(rollback, String(size)).toBeLessThanOrEqual(activation);
    }
    // The largest admitted membership is actually held, selected with the widest rollback tuple and read back.
    const homeDir = home();
    const held = await coordinator(homeDir).enterMaintenance({ ...rollbackEntry(low), sourceBackend: "postgresql", now: NOW });
    const worst = backendCutoverSetRollbackSelectionWorstCase(held.cutoverSet!.manifest, originalSetId);
    const body = { ...worst, manifestSha256: backendCutoverSetManifestSha256(held.cutoverSet!.manifest),
      members: worst.members.map((row, index) => ({ ...row, remoteProjectId: "ffffffff-ffff-7fff-bfff-" + index.toString(16).padStart(12, "0") })) };
    const widest = { ...body, checksumSha256: backendCutoverSetRollbackSelectionSha256(body) };
    const prepared = await coordinator(homeDir).prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256, generationId: ROLLBACK_SET_ID, targetBackend: "sqlite",
      terminalEvidenceSha256: widest.checksumSha256, cutoverSetSelection: widest,
    });
    const completed = await coordinator(homeDir).completeMaintenanceSelection({
      expectedChecksumSha256: prepared.checksumSha256, generationId: ROLLBACK_SET_ID, terminalEvidenceSha256: widest.checksumSha256,
    });
    expect(readBackendMaintenanceJournal(homeDir)).toMatchObject({ phase: "selection-completed", cutoverSet: { selection: widest } });
    expect(completed.cutoverSet!.selection!.members).toHaveLength(low);
    expect(SET_MACHINE_ID).toBe(held.cutoverSet!.manifest.machineId);
  }, 120_000);
});

