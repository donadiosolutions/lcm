import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortManifestGenerationIds,
  abortSetMemberGenerationIds,
  classifyMigrationAbortGate,
  completePendingMigrationAbort,
  performMigrationAbort,
} from "../../src/migration/abort.js";
import { cutoverSetMaintenanceEntry } from "../../src/migration/cutover-set.js";
import { performMigrationAbortCommand } from "../../src/migration/cli-abort.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import {
  beginMigrationEffect,
  completeMigrationEffect,
  createMigrationManifest,
  MigrationProtocolError,
  type MigrationManifest,
} from "../../src/migration/protocol.js";
import {
  BackendPublicationCoordinator,
  backendPublicationCanonicalSha256,
  readBackendMaintenanceJournal,
  type BackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { SET_ID, setManifest } from "../fixtures/cutover-set.js";

const roots: string[] = [];
const CREATED_AT = "2026-08-12T12:00:00.000Z";
const MEMBERS = ["member-generation-1", "member-generation-2", "member-generation-3"] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-set-abort-"));
  roots.push(home);
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  return home;
}

function coordinatorFor(home: string): BackendPublicationCoordinator {
  const unexpected = async (): Promise<never> => { throw new Error("v2 driver must not run for maintenance"); };
  const driver: BackendPublicationDriver = {
    observeLocalState: unexpected, publishProjectMap: unexpected, publishConfig: unexpected,
    restoreConfig: unexpected, restoreProjectMap: unexpected,
  };
  return new BackendPublicationCoordinator({ homeDir: home, driver });
}

function heldSet(home: string): Promise<BackendMaintenanceJournal> {
  return coordinatorFor(home).enterMaintenance(cutoverSetMaintenanceEntry(setManifest(3)));
}

function manifest(generationId: string): MigrationManifest {
  return createMigrationManifest({
    generationId,
    source: { version: 1, backend: "sqlite", identitySha256: "1".repeat(64), schemaSha256: "2".repeat(64), contentSha256: "3".repeat(64), capturedAt: CREATED_AT },
    destination: { version: 1, backend: "postgresql", identitySha256: "4".repeat(64), schemaSha256: "5".repeat(64), contentSha256: "6".repeat(64), capturedAt: CREATED_AT },
    parentGenerationId: null,
    preservedSourceGenerationId: generationId,
    createdAt: CREATED_AT,
  });
}

function create(store: MigrationManifestStore, generationId: string): MigrationManifest {
  const planned = manifest(generationId);
  store.create(planned);
  return planned;
}

/** A planned manifest whose verify-dry-run effect is begun but not completed (resume's territory). */
function createPendingDryRun(store: MigrationManifestStore, generationId: string): void {
  const planned = create(store, generationId);
  store.update(generationId, planned.checksumSha256, () => beginMigrationEffect(planned, {
    effectId: "e".repeat(64), kind: "verify-dry-run", inputSha256: "f".repeat(64), startedAt: CREATED_AT,
  }));
}

describe("set member generation lists", () => {
  it("names the members of a set journal in manifest order and nothing for a single generation", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    expect(abortSetMemberGenerationIds(held)).toEqual([...MEMBERS]);
    expect(abortManifestGenerationIds(held)).toEqual([...MEMBERS]);
    const single = { ...held, cutoverSet: undefined } as unknown as BackendMaintenanceJournal;
    expect(abortSetMemberGenerationIds(single)).toBeUndefined();
    expect(abortManifestGenerationIds(single)).toEqual([held.generationId]);
  });
});

describe("classifyMigrationAbortGate over a terminal set", () => {
  it("checks every member manifest and never the absent set-id manifest", async () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    const generationIds = [...MEMBERS];
    const gate = () => classifyMigrationAbortGate({ journalTerminal: true, generationId: SET_ID, generationIds, manifestStore: store });
    expect(gate()).toEqual({ status: "ready" });
    create(store, MEMBERS[1]);
    expect(gate()).toEqual({ status: "incomplete-pair", evidence: "member-generation-2:manifest-ready" });
    // The same journal without the member list only consults the set id: the single-generation view.
    expect(classifyMigrationAbortGate({ journalTerminal: true, generationId: SET_ID, manifestStore: store })).toEqual({ status: "ready" });
    expect(classifyMigrationAbortGate({ journalTerminal: false, generationId: SET_ID, generationIds, manifestStore: store })).toEqual({ status: "ready" });
  });

  it("reports an unreadable member as unresolvable evidence naming the member", () => {
    const store = {
      probeManifestPresence: (id: string) => id === MEMBERS[0] ? { status: "absent" as const } : { status: "unresolvable" as const, reason: "internal-error" as const },
    } as unknown as MigrationManifestStore;
    expect(classifyMigrationAbortGate({ journalTerminal: true, generationId: SET_ID, generationIds: [...MEMBERS], manifestStore: store }))
      .toEqual({ status: "unresolvable", evidence: "member-generation-2:manifest-internal-error" });
  });
});

describe("performMigrationAbort over a set hold", () => {
  it("settles every member manifest under the aborted journal, with member-specific effects", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    create(store, MEMBERS[0]);
    create(store, MEMBERS[2]);
    // Member 2 never reached genesis: absent is a legitimate state.
    const result = await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
    });
    expect(result).toEqual({ status: "completed", mutated: true });
    const aborted = readBackendMaintenanceJournal(home)!;
    expect(aborted.phase).toBe("maintenance-aborted");
    const first = store.read(MEMBERS[0]);
    const third = store.read(MEMBERS[2]);
    expect([first.phase, third.phase]).toEqual(["aborted", "aborted"]);
    expect(store.probeManifestPresence(MEMBERS[1])).toEqual({ status: "absent" });
    expect(store.probeManifestPresence(SET_ID)).toEqual({ status: "absent" });
    const reportOf = (value: MigrationManifest) => value.reports.find((report) => report.kind === "abort")!;
    expect(reportOf(first).reportId).not.toBe(reportOf(third).reportId);
    // A repeat finds everything settled and writes nothing.
    expect(await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: aborted, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
    })).toEqual({ status: "completed", mutated: false });
  });

  it("classifies every member before the first write and refuses with that member's evidence", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    create(store, MEMBERS[0]);
    createPendingDryRun(store, MEMBERS[1]);
    const before = store.read(MEMBERS[0]).checksumSha256;
    const result = await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
    });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-resume", mutated: false, member: "member-generation-2" });
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-held");
    expect(store.read(MEMBERS[0]).checksumSha256).toBe(before);
  });

  it("refuses an unreadable member manifest before any write", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    const store = {
      probeManifestPresence: (id: string) => id === MEMBERS[0] ? { status: "absent" as const } : { status: "present" as const },
      read: () => { throw new MigrationProtocolError("checksum-mismatch", "damaged"); },
    } as unknown as MigrationManifestStore;
    expect(await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
    })).toEqual({ status: "refuse", evidence: "manifest-checksum-mismatch", mutated: false, member: "member-generation-2" });
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-held");
  });

  it("reports a dry run without writing anything", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    create(store, MEMBERS[0]);
    expect(await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store, dryRun: true,
    })).toEqual({ status: "dry-run" });
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-held");
    expect(store.read(MEMBERS[0]).phase).toBe("planned");
  });

  it("converges an interrupted set abort: ready, pending-abort and settled members in one invocation", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    create(store, MEMBERS[0]);
    create(store, MEMBERS[1]);
    // The first invocation dies while completing member 1: journal aborted, member 1 holds its begun abort effect.
    const interrupted = await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
      _operationsForTesting: { completeEffect: () => { throw new MigrationProtocolError("invalid-input", "injected"); } },
    });
    expect(interrupted).toEqual({ status: "refuse", evidence: "manifest-invalid-input", mutated: true, member: "member-generation-1" });
    const aborted = readBackendMaintenanceJournal(home)!;
    expect(aborted.phase).toBe("maintenance-aborted");
    expect(store.read(MEMBERS[0]).pendingEffect?.kind).toBe("abort");
    expect(store.read(MEMBERS[1]).phase).toBe("planned");

    const converged = await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: aborted, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
    });
    expect(converged).toEqual({ status: "completed", mutated: true });
    expect(readBackendMaintenanceJournal(home)!.checksumSha256).toBe(aborted.checksumSha256);
    expect([store.read(MEMBERS[0]), store.read(MEMBERS[1])].map((value) => [value.phase, value.pendingEffect])).toEqual([["aborted", null], ["aborted", null]]);
  });

  it("completes a carried member abort exactly as the single-generation completion does", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    create(store, MEMBERS[0]);
    await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
      _operationsForTesting: { completeEffect: () => { throw new MigrationProtocolError("invalid-input", "injected"); } },
    });
    const aborted = readBackendMaintenanceJournal(home)!;
    const carried = store.read(MEMBERS[0]).pendingEffect!;
    expect(carried.inputSha256).toBe(aborted.checksumSha256);
    await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: aborted, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
    });
    const completed = store.read(MEMBERS[0]);
    expect(completed.reports.find((report) => report.kind === "abort")!.createdAt).toBe(carried.startedAt);
  });

  it("reports a failed completion of a carried member abort without claiming a write", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    create(store, MEMBERS[0]);
    const failing = { completeEffect: () => { throw new MigrationProtocolError("invalid-input", "injected"); } };
    const base = { homeDir: home, coordinator: coordinatorFor(home), abortEvidenceSha256: "c".repeat(64), manifestStore: store, _operationsForTesting: failing };
    await performMigrationAbort({ ...base, journal: held });
    expect(await performMigrationAbort({ ...base, journal: readBackendMaintenanceJournal(home)! }))
      .toEqual({ status: "refuse", evidence: "manifest-invalid-input", mutated: false, member: "member-generation-1" });
  });

  it("refuses every write when a carried abort names another effect or another journal checksum", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    create(store, MEMBERS[0]);
    const planned = create(store, MEMBERS[1]);
    await coordinatorFor(home).abortMaintenance({
      expectedChecksumSha256: held.checksumSha256, sourceSelectionSha256: held.sourceSelectionSha256, abortEvidenceSha256: "c".repeat(64),
    });
    const aborted = readBackendMaintenanceJournal(home)!;
    const input = { homeDir: home, coordinator: coordinatorFor(home), journal: aborted, abortEvidenceSha256: "c".repeat(64), manifestStore: store };
    store.update(MEMBERS[1], planned.checksumSha256, () => beginMigrationEffect(planned, {
      effectId: "9".repeat(64), kind: "abort", inputSha256: aborted.checksumSha256, startedAt: CREATED_AT,
    }));
    expect(await performMigrationAbort(input)).toEqual({ status: "refuse", evidence: "carried-effect-mismatch", mutated: false, member: "member-generation-2" });
    expect(store.read(MEMBERS[0]).phase).toBe("planned");
    // A journal that records no abort evidence cannot complete a carried effect either.
    expect(await performMigrationAbort({ ...input, journal: { ...aborted, abortEvidenceSha256: null } }))
      .toEqual({ status: "refuse", evidence: "carried-effect-mismatch", mutated: false, member: "member-generation-2" });
  });

  it("refuses a carried abort whose input digest is not the aborted journal checksum", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    await coordinatorFor(home).abortMaintenance({
      expectedChecksumSha256: held.checksumSha256, sourceSelectionSha256: held.sourceSelectionSha256, abortEvidenceSha256: "c".repeat(64),
    });
    const aborted = readBackendMaintenanceJournal(home)!;
    const planned = create(store, MEMBERS[0]);
    // The effect id is the real member id (via a first failed attempt), but the input digest is foreign.
    await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: aborted, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
      _operationsForTesting: { completeEffect: () => { throw new MigrationProtocolError("invalid-input", "injected"); } },
    });
    const pending = store.read(MEMBERS[0]);
    expect(pending.pendingEffect?.kind).toBe("abort");
    expect(await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: { ...aborted, checksumSha256: "d".repeat(64) },
      abortEvidenceSha256: "c".repeat(64), manifestStore: store,
    })).toEqual({ status: "refuse", evidence: "carried-effect-mismatch", mutated: false, member: "member-generation-1" });
    expect(planned.generationId).toBe(MEMBERS[0]);
  });

  it("keeps the single-generation refusal for a pending abort effect on a terminal journal", async () => {
    const home = makeHome();
    const held = await coordinatorFor(home).enterMaintenance({
      publicationId: "maintenance-publication", generationId: "generation-1", sourceSelectionSha256: "a".repeat(64),
      queueEvidenceSha256: "b".repeat(64), roster: [{ machineId: "018f0b5d-1234-4abc-8def-1234567890ab", queueCutoff: null, evidenceSha256: "a".repeat(64) }],
    });
    const store = new MigrationManifestStore({ homeDir: home });
    create(store, "generation-1");
    await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
      _operationsForTesting: { completeEffect: () => { throw new MigrationProtocolError("invalid-input", "injected"); } },
    });
    const aborted = readBackendMaintenanceJournal(home)!;
    expect(await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: aborted, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
    })).toEqual({ status: "refuse", evidence: "manifest-resume", mutated: false });
  });

  it("reports the write that preceded a member begin failure", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    create(store, MEMBERS[0]);
    expect(await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
      _operationsForTesting: { beginEffect: () => { throw new MigrationProtocolError("invalid-input", "injected"); } },
    })).toEqual({ status: "refuse", evidence: "manifest-invalid-input", mutated: true, member: "member-generation-1" });
  });
});

describe("completePendingMigrationAbort stays single-generation", () => {
  it("refuses a journal that is not aborted", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    expect(completePendingMigrationAbort({ homeDir: home, journal: held }))
      .toEqual({ status: "refuse", evidence: "carried-effect-mismatch", mutated: false });
  });
});

describe("migration abort command over a set", () => {
  it("settles every member manifest and reads them all back before reporting success", async () => {
    const home = makeHome();
    await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    create(store, MEMBERS[0]);
    create(store, MEMBERS[1]);
    expect(await performMigrationAbortCommand({ homeDir: home, confirmGenerationId: SET_ID }))
      .toEqual({ status: "ok", generationId: SET_ID, journalPhase: "maintenance-aborted", manifestPhase: "aborted", applied: true });
    expect([store.read(MEMBERS[0]).phase, store.read(MEMBERS[1]).phase]).toEqual(["aborted", "aborted"]);
    // Row 5: repeating is a confirmation that writes nothing.
    expect(await performMigrationAbortCommand({ homeDir: home, confirmGenerationId: SET_ID }))
      .toEqual({ status: "ok", generationId: SET_ID, journalPhase: "maintenance-aborted", manifestPhase: "aborted", applied: false });
  });

  it("converges members left unsettled by an earlier abort instead of reading back a mismatch", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    create(store, MEMBERS[0]);
    create(store, MEMBERS[2]);
    // The earlier abort terminalized the journal and died before touching a manifest.
    await coordinatorFor(home).abortMaintenance({
      expectedChecksumSha256: held.checksumSha256, sourceSelectionSha256: held.sourceSelectionSha256, abortEvidenceSha256: "c".repeat(64),
    });
    expect(await performMigrationAbortCommand({ homeDir: home, confirmGenerationId: SET_ID }))
      .toEqual({ status: "ok", generationId: SET_ID, journalPhase: "maintenance-aborted", manifestPhase: "aborted", applied: true });
    expect([store.read(MEMBERS[0]).phase, store.read(MEMBERS[2]).phase]).toEqual(["aborted", "aborted"]);
  });

  it("keeps the whole-journal confirmation and reports a member refusal with its evidence", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    createPendingDryRun(store, MEMBERS[1]);
    expect(await performMigrationAbortCommand({ homeDir: home, confirmGenerationId: MEMBERS[1] }))
      .toMatchObject({ status: "refuse", reason: "abort-confirmation-moved", generationId: SET_ID });
    expect(await performMigrationAbortCommand({ homeDir: home, confirmGenerationId: SET_ID }))
      .toEqual({ status: "refuse", reason: "abort-manifest-needs-resume", evidence: "member-generation-2:manifest-resume", next: "resume" });
    expect(readBackendMaintenanceJournal(home)).toEqual(held);
  });

  it("dry-runs a set abort without writing", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    create(new MigrationManifestStore({ homeDir: home }), MEMBERS[0]);
    expect(await performMigrationAbortCommand({ homeDir: home, confirmGenerationId: SET_ID, dryRun: true }))
      .toEqual({ status: "ok", generationId: SET_ID, journalPhase: "maintenance-held", manifestPhase: null, applied: false });
    expect(readBackendMaintenanceJournal(home)).toEqual(held);
  });

  it("refuses a readback when a member is not settled after the operation claims completion", async () => {
    const home = makeHome();
    await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    create(store, MEMBERS[0]);
    expect(await performMigrationAbortCommand({
      homeDir: home, confirmGenerationId: SET_ID,
      _operationsForTesting: { performAbort: async (input) => {
        await coordinatorFor(home).abortMaintenance({
          expectedChecksumSha256: input.journal.checksumSha256, sourceSelectionSha256: input.journal.sourceSelectionSha256, abortEvidenceSha256: input.abortEvidenceSha256,
        });
        return { status: "completed", mutated: true };
      } },
    })).toEqual({ status: "refuse", reason: "abort-readback-mismatch", applied: true });
  });

  it.each([
    ["established", { probeManifestPresence: () => ({ status: "unresolvable" as const, reason: "internal-error" as const }) }, "manifest-internal-error"],
    ["read", {
      probeManifestPresence: () => ({ status: "present" as const }),
      read: () => { throw new MigrationProtocolError("checksum-mismatch", "damaged"); },
    }, "manifest-checksum-mismatch"],
  ])("refuses a readback when a member manifest cannot be %s", async (_name, readback, evidence) => {
    const home = makeHome();
    await heldSet(home);
    expect(await performMigrationAbortCommand({
      homeDir: home, confirmGenerationId: SET_ID, manifestStore: readback as unknown as MigrationManifestStore,
      _resolution: { manifestStore: new MigrationManifestStore({ homeDir: home }) },
      _operationsForTesting: { performAbort: async (input) => {
        await coordinatorFor(home).abortMaintenance({
          expectedChecksumSha256: input.journal.checksumSha256, sourceSelectionSha256: input.journal.sourceSelectionSha256, abortEvidenceSha256: input.abortEvidenceSha256,
        });
        return { status: "completed", mutated: true };
      } },
    })).toEqual({ status: "refuse", reason: "abort-unresolvable", evidence, applied: true });
  });
});

describe("member attribution of set abort refusals (F2)", () => {
  const failFor = (generationId: string) => ({
    completeEffect: ((begun: MigrationManifest, completion: Parameters<typeof completeMigrationEffect>[1]) => {
      if (begun.generationId === generationId) throw new MigrationProtocolError("invalid-input", "injected");
      return completeMigrationEffect(begun, completion);
    }) as typeof completeMigrationEffect,
  });

  it("names the failing member after an earlier member was already settled", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    create(store, MEMBERS[0]);
    create(store, MEMBERS[1]);
    const result = await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
      _operationsForTesting: failFor(MEMBERS[1]),
    });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-invalid-input", mutated: true, member: MEMBERS[1] });
    // Member 1 was settled before the failure; member 2 holds its begun, uncompleted abort effect.
    expect(store.read(MEMBERS[0]).phase).toBe("aborted");
    expect(store.read(MEMBERS[1]).pendingEffect?.kind).toBe("abort");
  });

  it("keeps journal-wide failures unattributed", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    const stale = { ...held, checksumSha256: "f".repeat(64) };
    expect(await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: stale, abortEvidenceSha256: "c".repeat(64),
    })).toEqual({ status: "refuse", evidence: "journal-unexpected-state", mutated: false });
  });

  it("reports the member and keeps the reason and next step through the command", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    create(store, MEMBERS[0]);
    createPendingDryRun(store, MEMBERS[2]);
    expect(await performMigrationAbortCommand({ homeDir: home, confirmGenerationId: SET_ID }))
      .toEqual({ status: "refuse", reason: "abort-manifest-needs-resume", evidence: "member-generation-3:manifest-resume", next: "resume" });
    expect(readBackendMaintenanceJournal(home)).toEqual(held);
    expect(store.read(MEMBERS[0]).phase).toBe("planned");
  });

  it("keeps the carried-effect reason through the command and writes nothing", async () => {
    const home = makeHome();
    const held = await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    const planned = create(store, MEMBERS[1]);
    await coordinatorFor(home).abortMaintenance({
      expectedChecksumSha256: held.checksumSha256, sourceSelectionSha256: held.sourceSelectionSha256, abortEvidenceSha256: "c".repeat(64),
    });
    store.update(MEMBERS[1], planned.checksumSha256, () => beginMigrationEffect(planned, {
      effectId: "9".repeat(64), kind: "abort", inputSha256: "8".repeat(64), startedAt: CREATED_AT,
    }));
    const before = store.read(MEMBERS[1]);
    expect(await performMigrationAbortCommand({ homeDir: home, confirmGenerationId: SET_ID }))
      .toEqual({ status: "refuse", reason: "abort-carried-effect-mismatch", evidence: "member-generation-2:carried-effect-mismatch" });
    expect(store.read(MEMBERS[1])).toEqual(before);
  });

  it("reports the failing member and the earlier write through the command", async () => {
    const home = makeHome();
    await heldSet(home);
    const store = new MigrationManifestStore({ homeDir: home });
    create(store, MEMBERS[0]);
    create(store, MEMBERS[1]);
    expect(await performMigrationAbortCommand({
      homeDir: home, confirmGenerationId: SET_ID,
      _operationsForTesting: { performAbort: (input) => performMigrationAbort({ ...input, _operationsForTesting: failFor(MEMBERS[1]) }) },
    })).toEqual({ status: "refuse", reason: "abort-unresolvable", evidence: "member-generation-2:manifest-invalid-input", applied: true });
  });
});

describe("set member abort evidence across retries (PR #1658 thread)", () => {
  // The journal stamps its own clock, so two homes only agree byte-for-byte under a pinned Date.
  const NOW = new Date("2026-08-12T12:30:00.000Z");
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const pair = async (): Promise<{ home: string; store: MigrationManifestStore }> => {
    const home = makeHome();
    await coordinatorFor(home).enterMaintenance(cutoverSetMaintenanceEntry(setManifest(2)));
    const store = new MigrationManifestStore({ homeDir: home });
    create(store, MEMBERS[0]);
    create(store, MEMBERS[1]);
    return { home, store };
  };
  const abortCommand = (home: string, operations?: Parameters<typeof performMigrationAbort>[0]["_operationsForTesting"]) =>
    performMigrationAbortCommand({
      homeDir: home, confirmGenerationId: SET_ID, now: NOW,
      ...(operations === undefined ? {} : {
        _operationsForTesting: { performAbort: (input) => performMigrationAbort({ ...input, _operationsForTesting: operations }) },
      }),
    });
  const failingFor = <T extends (manifest: MigrationManifest, ...rest: never[]) => MigrationManifest>(generationId: string, real: T): T =>
    ((manifest: MigrationManifest, ...rest: never[]) => {
      if (manifest.generationId === generationId) throw new MigrationProtocolError("invalid-input", "injected");
      return real(manifest, ...rest);
    }) as T;
  const uninterrupted = async (): Promise<MigrationManifest> => {
    const { home, store } = await pair();
    expect(await abortCommand(home)).toMatchObject({ status: "ok", applied: true });
    return store.read(MEMBERS[1]);
  };

  it("seals a member begun only by the retry to the journal's persisted evidence", async () => {
    const expected = await uninterrupted();
    const { home, store } = await pair();
    // The first abort terminalizes the journal, settles member 1 and dies before member 2's begin.
    expect(await abortCommand(home, { beginEffect: failingFor(MEMBERS[1], beginMigrationEffect) }))
      .toEqual({ status: "refuse", reason: "abort-unresolvable", evidence: "member-generation-2:manifest-invalid-input", applied: true });
    const aborted = readBackendMaintenanceJournal(home)!;
    expect([aborted.phase, store.read(MEMBERS[0]).phase, store.read(MEMBERS[1]).phase]).toEqual(["maintenance-aborted", "aborted", "planned"]);
    // The retry's caller digests the aborted journal, which is not the evidence the journal persisted.
    const retryEvidence = backendPublicationCanonicalSha256({
      version: 1, kind: "migration-abort-cli-request", generationId: SET_ID, checksumSha256: aborted.checksumSha256,
    });
    expect(retryEvidence).not.toBe(aborted.abortEvidenceSha256);

    expect(await abortCommand(home)).toMatchObject({ status: "ok", applied: true });
    const settled = store.read(MEMBERS[1]);
    expect(settled).toEqual(expected);
    expect(settled.reports.find((report) => report.kind === "abort")!.reportSha256).toBe(backendPublicationCanonicalSha256({
      version: 1, kind: "migration-abort-report", generationId: MEMBERS[1],
      abortEvidenceSha256: aborted.abortEvidenceSha256, completedAt: NOW.toISOString(),
    }));
  });

  it("completes a member begun by the retry and carried into a third invocation identically", async () => {
    const expected = await uninterrupted();
    const { home, store } = await pair();
    expect(await abortCommand(home, { beginEffect: failingFor(MEMBERS[1], beginMigrationEffect) })).toMatchObject({ status: "refuse", applied: true });
    // The retry begins member 2's effect and dies before completing it.
    expect(await abortCommand(home, { completeEffect: failingFor(MEMBERS[1], completeMigrationEffect) }))
      .toEqual({ status: "refuse", reason: "abort-unresolvable", evidence: "member-generation-2:manifest-invalid-input", applied: true });
    const carried = store.read(MEMBERS[1]).pendingEffect!;
    expect([carried.kind, carried.inputSha256]).toEqual(["abort", readBackendMaintenanceJournal(home)!.checksumSha256]);

    expect(await abortCommand(home)).toMatchObject({ status: "ok", applied: true });
    expect(store.read(MEMBERS[1])).toEqual(expected);
  });
});
