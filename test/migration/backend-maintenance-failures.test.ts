import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeAbortedTerminalPublicationJournal } from "../fixtures/terminal-publication-journal.js";
import { BackendPublicationCoordinator, assertBackendPublicationConsumerAccess, assertBackendPublicationProjectMapAccess, backendPublicationCanonicalSha256 as hash,
  backendPublicationJournalPath, backendPublicationHistoryDirectory, readBackendMaintenanceJournal, withBackendPublicationAppendBarrier,
  withBackendPublicationAppendBarrierAsync, type BackendPublicationDriver, type BackendMaintenanceJournal,
  type EnterBackendMaintenanceInput, type PrepareBackendMaintenanceSelectionInput } from "../../src/storage/backend-publication.js";

const interception = vi.hoisted(() => ({ read: undefined as ((path: string, observed: Record<string, unknown>) => Record<string, unknown>) | undefined }));
vi.mock("../../src/security-files.js", async (original) => {
  const actual = await original<typeof import("../../src/security-files.js")>();
  return { ...actual, readBoundedRegularFileWithStat: (...args: Parameters<typeof actual.readBoundedRegularFileWithStat>) => {
    const observed = actual.readBoundedRegularFileWithStat(...args);
    return interception.read === undefined ? observed : interception.read(args[0], observed as unknown as Record<string, unknown>);
  } };
});
const roots: string[] = [];
const HASH = "a".repeat(64); const OTHER = "b".repeat(64);
const MACHINE = "018f0b5d-1234-4abc-8def-1234567890ab";
const SECOND = "118f0b5d-1234-4abc-8def-1234567890ab";
afterEach(() => { interception.read = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "lcm-maintenance-errors-")); roots.push(home); mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  const unexpected = vi.fn(async (): Promise<never> => { throw new Error("v2 driver must not run"); });
  const driver: BackendPublicationDriver = { observeLocalState: unexpected, publishProjectMap: unexpected, publishConfig: unexpected,
    restoreConfig: unexpected, restoreProjectMap: unexpected };
  const coordinator = new BackendPublicationCoordinator({ homeDir: home, driver });
  return { home, coordinator, unexpected };
}
const input = (): EnterBackendMaintenanceInput => ({ publicationId: "publication", generationId: "generation", sourceSelectionSha256: HASH,
  queueEvidenceSha256: OTHER, roster: [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: HASH }] });
async function held() { const value = fixture(); return { ...value, journal: await value.coordinator.enterMaintenance(input()) }; }
function rewrite(home: string, update: Record<string, unknown>, checksum = true): void {
  const path = backendPublicationJournalPath(home); const value = { ...JSON.parse(readFileSync(path, "utf8")), ...update };
  const { checksumSha256: _old, ...body } = value; if (checksum) value.checksumSha256 = hash(body);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}
const selection = (journal: BackendMaintenanceJournal): PrepareBackendMaintenanceSelectionInput => ({ expectedChecksumSha256: journal.checksumSha256,
  generationId: journal.generationId, targetBackend: "postgresql", terminalEvidenceSha256: OTHER });

describe("backend maintenance v3 failure boundaries", () => {
  it.each([[], null, [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: HASH, extra: true }],
    [{ machineId: "invalid", queueCutoff: null, evidenceSha256: HASH }], [{ machineId: MACHINE, queueCutoff: "1", evidenceSha256: HASH }],
    [{ machineId: MACHINE, queueCutoff: "9223372036854775808", evidenceSha256: HASH }],
    [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: "bad" }],
    [MACHINE, MACHINE].map((machineId) => ({ machineId, queueCutoff: null, evidenceSha256: HASH })),
    [SECOND, MACHINE].map((machineId) => ({ machineId, queueCutoff: null, evidenceSha256: HASH })),
  ].map((roster) => ({ roster })))("refuses malformed or unsorted roster $roster", async ({ roster }) => {
    const value = fixture();
    await expect(value.coordinator.enterMaintenance({ ...input(), roster } as EnterBackendMaintenanceInput)).rejects.toMatchObject({ reason: "malformed-journal" });
    expect(value.coordinator.inspectMaintenance()).toBeNull();
  });
  it("accepts sorted multi-machine roster with a padded maximum cutoff", async () => {
    const value = fixture(); const roster = [MACHINE, SECOND].map((machineId) => ({ machineId, queueCutoff: "9223372036854775807", evidenceSha256: HASH }));
    expect((await value.coordinator.enterMaintenance({ ...input(), roster })).roster).toEqual(roster);
  });
  it.each([{ publicationId: "!" }, { generationId: "!" }, { sourceSelectionSha256: "bad" }, { queueEvidenceSha256: "bad" }, { now: new Date(NaN) }])("refuses malformed entering input %j", async (change) => {
    const value = fixture(); await expect(value.coordinator.enterMaintenance({ ...input(), ...change })).rejects.toMatchObject({ reason: "invalid-input" });
  });
  it.each(["{", "null", "[]"])("refuses malformed stored JSON %s", async (content) => {
    const value = await held(); writeFileSync(backendPublicationJournalPath(value.home), content);
    expect(() => readBackendMaintenanceJournal(value.home)).toThrow("journal");
  });
  it.each([{ extra: true }, { checksumSha256: "bad" }, { checksumSha256: OTHER }])("refuses unknown shape or stale checksum %j", async (change) => {
    const value = await held(); rewrite(value.home, change, false);
    expect(() => value.coordinator.inspectMaintenance()).toThrow("journal");
  });
  it.each([{ publicationId: "!" }, { sourceBackend: "postgresql" }, { targetBackend: "bad" }, { phase: "unknown" },
    { createdAt: "bad" }, { updatedAt: "bad" }, { generationId: "!" }, { sourceSelectionSha256: "bad" }, { queueEvidenceSha256: "bad" },
    { selectedGenerationId: "!" }, { terminalEvidenceSha256: "bad" }, { abortEvidenceSha256: "bad" }])("refuses rechecksummed malformed journal fields %j", async (change) => {
    const value = await held(); rewrite(value.home, change);
    expect(() => value.coordinator.inspectMaintenance()).toThrow("fields are malformed");
  });
  it.each([
    [{ targetBackend: "sqlite" }, "held backend maintenance"],
    [{ phase: "selection-prepared" }, "selection is incomplete"],
    [{ phase: "selection-completed", targetBackend: "postgresql", selectedGenerationId: "other", terminalEvidenceSha256: HASH }, "selection is incomplete"],
    [{ phase: "maintenance-aborted" }, "abort is incomplete"],
  ] as const)("refuses inconsistent phase evidence %j", async (change, message) => {
    const value = await held(); rewrite(value.home, change);
    expect(() => value.coordinator.inspectMaintenance()).toThrow(message);
  });
  it("refuses unsafe journal mode", async () => {
    const value = await held(); chmodSync(backendPublicationJournalPath(value.home), 0o644);
    expect(() => value.coordinator.inspectMaintenance()).toThrow("cannot be read");
  });
  it("authenticates the retained journal parent identity", async () => {
    const value = await held(); interception.read = (path, observed) => path === backendPublicationJournalPath(value.home)
      ? { ...observed, parentDev: Number(observed.parentDev) + 1 } : observed;
    expect(() => value.coordinator.inspectMaintenance()).toThrow("parent does not match");
  });
  it.each(["prepare", "complete", "abort"])("refuses %s without maintenance evidence", async (operation) => {
    const value = fixture();
    const attempt = operation === "prepare" ? value.coordinator.prepareMaintenanceSelection({ expectedChecksumSha256: HASH, generationId: "generation", targetBackend: "sqlite", terminalEvidenceSha256: OTHER })
      : operation === "complete" ? value.coordinator.completeMaintenanceSelection({ expectedChecksumSha256: HASH, generationId: "generation", terminalEvidenceSha256: OTHER })
        : value.coordinator.abortMaintenance({ expectedChecksumSha256: HASH, sourceSelectionSha256: HASH, abortEvidenceSha256: OTHER });
    await expect(attempt).rejects.toMatchObject({ reason: "publication-evidence-missing" });
  });
  it.each([{ expectedChecksumSha256: "bad" }, { terminalEvidenceSha256: "bad" }, { generationId: "!" }, { targetBackend: "bad" }])("rejects invalid selection input %j", async (change) => {
    const value = await held(); await expect(value.coordinator.prepareMaintenanceSelection({ ...selection(value.journal), ...change } as PrepareBackendMaintenanceSelectionInput)).rejects.toMatchObject({ reason: "invalid-input" });
  });
  it.each([{ expectedChecksumSha256: "bad" }, { terminalEvidenceSha256: "bad" }, { generationId: "!" }])("rejects invalid completion input %j", async (change) => {
    const value = await held(); await expect(value.coordinator.completeMaintenanceSelection({ ...selection(value.journal), ...change })).rejects.toMatchObject({ reason: "invalid-input" });
  });
  it.each(["phase", "checksum", "generation", "terminal"])("rejects completion with mismatched %s", async (kind) => {
    const value = await held(); const journal = kind === "phase" ? value.journal : await value.coordinator.prepareMaintenanceSelection(selection(value.journal));
    const change = kind === "checksum" ? { expectedChecksumSha256: HASH } : kind === "generation" ? { generationId: "other" } : kind === "terminal" ? { terminalEvidenceSha256: HASH } : {};
    await expect(value.coordinator.completeMaintenanceSelection({ ...selection(journal), ...change })).rejects.toMatchObject({ reason: "unexpected-state" });
  });
  it.each([{ expectedChecksumSha256: "bad" }, { sourceSelectionSha256: "bad" }, { abortEvidenceSha256: "bad" }])("rejects invalid abort input %j", async (change) => {
    const value = await held(); await expect(value.coordinator.abortMaintenance({ expectedChecksumSha256: value.journal.checksumSha256, sourceSelectionSha256: HASH, abortEvidenceSha256: OTHER, ...change })).rejects.toMatchObject({ reason: "invalid-input" });
  });
  it.each(["phase", "checksum", "source"])("rejects abort with mismatched %s", async (kind) => {
    const value = await held(); if (kind === "phase") await value.coordinator.prepareMaintenanceSelection(selection(value.journal));
    await expect(value.coordinator.abortMaintenance({ expectedChecksumSha256: kind === "checksum" ? HASH : value.journal.checksumSha256,
      sourceSelectionSha256: kind === "source" ? OTHER : HASH, abortEvidenceSha256: OTHER })).rejects.toMatchObject({ reason: "unexpected-state" });
  });
  it.each(["sync", "async"])("supports exact reentrant %s append tokens", async (kind) => {
    const value = await held();
    if (kind === "sync") expect(withBackendPublicationAppendBarrier(value.home, (token) =>
      withBackendPublicationAppendBarrier(value.home, (nested) => nested === token, token))).toBe(true);
    else expect(await withBackendPublicationAppendBarrierAsync(value.home, (token) =>
      withBackendPublicationAppendBarrierAsync(value.home, async (nested) => nested === token, token))).toBe(true);
  });
  it.each(["sync", "async"])("refuses %s append in entering phase", async (kind) => {
    const value = await held(); rewrite(value.home, { phase: "maintenance-entering" });
    if (kind === "sync") expect(() => withBackendPublicationAppendBarrier(value.home, () => "forbidden")).toThrow("not ready for local append");
    else await expect(withBackendPublicationAppendBarrierAsync(value.home, async () => "forbidden")).rejects.toThrow("not ready for local append");
  });
  it("admits synchronous append before any maintenance exists", () => {
    const value = fixture(); expect(withBackendPublicationAppendBarrier(value.home, () => "allowed")).toBe("allowed");
  });
  it.each(["abort", "select"])("refuses wrong backend after terminal %s", async (kind) => {
    const value = await held();
    if (kind === "abort") await value.coordinator.abortMaintenance({ expectedChecksumSha256: value.journal.checksumSha256, sourceSelectionSha256: HASH, abortEvidenceSha256: OTHER });
    else { const prepared = await value.coordinator.prepareMaintenanceSelection(selection(value.journal)); await value.coordinator.completeMaintenanceSelection(selection(prepared)); }
    expect(() => assertBackendPublicationConsumerAccess({ homeDir: value.home, backend: kind === "abort" ? "postgresql" : "sqlite" })).toThrow("does not match terminal");
    expect(value.unexpected).not.toHaveBeenCalled();
  });
  it("preserves v2 evidence while refusing an unresolved publication", async () => {
    const value = fixture(); writeAbortedTerminalPublicationJournal(value.home); rewrite(value.home, { phase: "prepared" });
    const original = readFileSync(backendPublicationJournalPath(value.home));
    await expect(value.coordinator.enterMaintenance(input())).rejects.toMatchObject({ reason: "unresolved-publication" });
    expect(readFileSync(backendPublicationJournalPath(value.home))).toEqual(original);
    expect(value.coordinator.inspectMaintenance()).toBeNull();
  });
  it("archives terminal v2 evidence before entering v3 maintenance", async () => {
    const value = fixture(); const checksum = writeAbortedTerminalPublicationJournal(value.home);
    const original = readFileSync(backendPublicationJournalPath(value.home));
    expect(value.coordinator.inspectMaintenance()).toBeNull();
    await expect(value.coordinator.enterMaintenance(input())).resolves.toMatchObject({ phase: "maintenance-held" });
    expect(readFileSync(join(backendPublicationHistoryDirectory(value.home), `terminal-publication-a.${checksum}.json`))).toEqual(original);
  });
  it.each(["changed", "missing"])("refuses CAS %s after the initial selection read", async (kind) => {
    const value = await held(); let reads = 0;
    interception.read = (path, observed) => {
      if (path === backendPublicationJournalPath(value.home) && ++reads === 1) {
        if (kind === "changed") rewrite(value.home, { updatedAt: "2026-09-08T01:02:03.000Z" });
        else rmSync(path);
      }
      return observed;
    };
    await expect(value.coordinator.prepareMaintenanceSelection(selection(value.journal))).rejects.toThrow("changed before update");
    expect(reads).toBe(kind === "changed" ? 2 : 1);
    if (kind === "changed") expect(JSON.parse(readFileSync(backendPublicationJournalPath(value.home), "utf8")).phase).toBe("maintenance-held");
    else expect(() => readFileSync(backendPublicationJournalPath(value.home))).toThrow();
  });
  it("refuses a maintenance journal that appears between first read and creation", async () => {
    const template = await held(); const bytes = readFileSync(backendPublicationJournalPath(template.home));
    const value = fixture(); let appeared = false;
    const roster = new Proxy(input().roster, { get: (target, key, receiver) => {
      if (!appeared && key === "map") {
        appeared = true; writeFileSync(backendPublicationJournalPath(value.home), bytes, { mode: 0o600 });
      }
      return Reflect.get(target, key, receiver);
    } });
    await expect(value.coordinator.enterMaintenance({ ...input(), roster })).rejects.toThrow("journal already exists");
    expect(appeared).toBe(true); expect(readFileSync(backendPublicationJournalPath(value.home))).toEqual(bytes);
  });
  it("allows async local append before maintenance and preserves it after nested failure", async () => {
    const value = fixture();
    await expect(withBackendPublicationAppendBarrierAsync(value.home, async (token) =>
      withBackendPublicationAppendBarrierAsync(value.home, async () => { throw new Error("append refused"); }, token))).rejects.toThrow("append refused");
    expect(await withBackendPublicationAppendBarrierAsync(value.home, async () => "next")).toBe("next");
  });

  it("reads maintenance on platforms without process.getuid", async () => {
    const value = await held(); const descriptor = Object.getOwnPropertyDescriptor(process, "getuid")!;
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      expect(value.coordinator.inspectMaintenance()).toEqual(value.journal);
    } finally { Object.defineProperty(process, "getuid", descriptor); }
  });
  it("preserves ordinary project-map admission without an explicit lock token", () => {
    const value = fixture();
    expect(() => assertBackendPublicationProjectMapAccess({ homeDir: value.home, content: null, map: {}, present: false })).not.toThrow();
  });

  it("refuses v2 terminal authority drift after archiving its original bytes", async () => {
    const value = fixture(); const checksum = writeAbortedTerminalPublicationJournal(value.home);
    const original = readFileSync(backendPublicationJournalPath(value.home)); let reads = 0;
    interception.read = (path, observed) => {
      if (path === backendPublicationJournalPath(value.home) && ++reads === 2) rewrite(value.home, { phase: "prepared" });
      return observed;
    };
    await expect(value.coordinator.enterMaintenance(input())).rejects.toThrow("changed before update");
    expect(reads).toBe(3);
    expect(JSON.parse(readFileSync(backendPublicationJournalPath(value.home), "utf8")).phase).toBe("prepared");
    expect(readFileSync(join(backendPublicationHistoryDirectory(value.home), `terminal-publication-a.${checksum}.json`))).toEqual(original);
  });

});
