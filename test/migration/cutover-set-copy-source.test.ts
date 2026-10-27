import { expect, it, vi } from "vitest";
import * as publicationApi from "../../src/storage/backend-publication.js";
import {
  readBackendMaintenanceJournal,
  resolveBackendMaintenanceGenerationBinding,
  type BackendMaintenanceJournal,
} from "../../src/storage/backend-publication.js";
import { captureAuthenticatedSqliteMigrationSource } from "../../src/migration/maintenance.js";
import { bindMigrationCopySource, openMigrationCopySource } from "../../src/migration/copy-source.js";
import { canonicalSha256 } from "../../src/storage/portable-record.js";
import { enterSetHold, setHome, setMemberCaptureOptions, setMemberIdentity } from "../fixtures/cutover-set-home.js";
import { heldSource, populatedFixture, REGISTERED_MACHINE } from "../fixtures/migration-copy.js";

const PROBE = { destinationWitnessSha256: "a".repeat(64), identityFingerprintSha256: "b".repeat(64), systemIdentifier: "7123456789", nonIdentityDomainsEmpty: true, existingRun: null } as const;

async function capturedSet() {
  const { homeDir, projects } = await setHome();
  const { held } = await enterSetHold(homeDir);
  const members = held.cutoverSet!.manifest.members;
  const snapshots = [];
  for (const [index, member] of members.entries()) {
    const source = await setMemberCaptureOptions(homeDir, readBackendMaintenanceJournal(homeDir)!, projects[index]!, member.generationId);
    snapshots.push(await captureAuthenticatedSqliteMigrationSource(source.authority, source.options));
  }
  return { homeDir, projects, members, snapshots };
}

it("binds a single-generation copy to the journal checksum and roster exactly as before", async () => {
  const fixture = await populatedFixture();
  const held = await heldSource(fixture);
  const snapshot = await captureAuthenticatedSqliteMigrationSource(held.authority, held.options);
  const id = "018f0b5d-1234-7abc-8def-1234567890ac";
  const expectedIdentity = { id, remoteProjectId: id, localProjectId: fixture.local.id, machineId: REGISTERED_MACHINE, canonical: fixture.cwd, selectedPath: fixture.cwd };
  const source = await openMigrationCopySource({ generationId: snapshot.artifact.generationId, homeDir: fixture.homeDir, expectedIdentity, scratchParent: fixture.homeDir });
  try {
    const journal = readBackendMaintenanceJournal(fixture.homeDir)!;
    const bound = bindMigrationCopySource(source, { expectedOwner: "owner", expectedIdentity, destinationCapturedAt: "2026-09-07T03:04:05.000Z", targetProbe: PROBE });
    // The view of a single-generation journal is the journal itself.
    expect(resolveBackendMaintenanceGenerationBinding(journal, snapshot.artifact.generationId)!.checksumSha256).toBe(journal.checksumSha256);
    expect(bound.binding.maintenanceChecksumSha256).toBe(journal.checksumSha256);
    expect(bound.binding.maintenanceRoster).toEqual(journal.roster);
    expect(bound.bindingSha256).toBe(canonicalSha256(bound.binding));
    expect(bound.runId).toBe("migration-copy-" + bound.bindingSha256);
  } finally { await source.stream.close(); }
});

it("opens and binds a set member against its own binding view, and survives a sibling's capture", async () => {
  const { homeDir, projects, members } = await setHome().then(async ({ homeDir, projects }) => {
    const { held } = await enterSetHold(homeDir);
    return { homeDir, projects, members: held.cutoverSet!.manifest.members };
  });
  const [memberA, memberB] = members as [typeof members[number], typeof members[number]];
  const sourceA = await setMemberCaptureOptions(homeDir, readBackendMaintenanceJournal(homeDir)!, projects[0]!, memberA.generationId);
  const snapshotA = await captureAuthenticatedSqliteMigrationSource(sourceA.authority, sourceA.options);
  const copy = await openMigrationCopySource({
    generationId: memberA.generationId, homeDir, expectedIdentity: setMemberIdentity(projects[0]!, 1), scratchParent: homeDir,
  });
  try {
    const viewA = resolveBackendMaintenanceGenerationBinding(readBackendMaintenanceJournal(homeDir), memberA.generationId)!;
    const bound = bindMigrationCopySource(copy, { expectedOwner: "owner", expectedIdentity: setMemberIdentity(projects[0]!, 1), destinationCapturedAt: "2026-09-07T03:04:05.000Z", targetProbe: PROBE });
    expect(bound.binding.maintenanceChecksumSha256).toBe(viewA.checksumSha256);
    expect(bound.binding.maintenanceChecksumSha256).not.toBe(readBackendMaintenanceJournal(homeDir)!.checksumSha256);
    expect(bound.binding.maintenanceRoster).toEqual(viewA.roster);
    expect(bound.binding.generationId).toBe(memberA.generationId);
    expect(snapshotA.artifact.maintenanceChecksumSha256).toBe(viewA.checksumSha256);

    // Capturing the sibling rebinds the aggregate journal but not member A's view.
    const aggregateBefore = readBackendMaintenanceJournal(homeDir)!.checksumSha256;
    const sourceB = await setMemberCaptureOptions(homeDir, readBackendMaintenanceJournal(homeDir)!, projects[1]!, memberB.generationId);
    await captureAuthenticatedSqliteMigrationSource(sourceB.authority, sourceB.options);
    expect(readBackendMaintenanceJournal(homeDir)!.checksumSha256).not.toBe(aggregateBefore);
    await expect(copy.reauthenticate()).resolves.toBeUndefined();
    expect(bindMigrationCopySource(copy, { expectedOwner: "owner", expectedIdentity: setMemberIdentity(projects[0]!, 1), destinationCapturedAt: "2026-09-07T03:04:05.000Z", targetProbe: PROBE }).bindingSha256)
      .toBe(bound.bindingSha256);
  } finally { await copy.stream.close(); }
});

it("refuses a set member whose view moved, who left the set, or whose hold is no longer held", async () => {
  const { homeDir, projects, members } = await capturedSet();
  const memberA = members[0]!;
  const identity = setMemberIdentity(projects[0]!, 1);
  const copy = await openMigrationCopySource({ generationId: memberA.generationId, homeDir, expectedIdentity: identity, scratchParent: homeDir });
  try {
    const actual = readBackendMaintenanceJournal(homeDir)!;
    const manifest = actual.cutoverSet!.manifest;
    const bindings = actual.cutoverSet!.bindings;
    const withBinding = (change: Record<string, unknown>): BackendMaintenanceJournal => ({
      ...actual, cutoverSet: { manifest, bindings: bindings.map((binding) => binding.generationId === memberA.generationId ? { ...binding, ...change } : binding) },
    }) as BackendMaintenanceJournal;
    const bindingA = bindings.find((binding) => binding.generationId === memberA.generationId)!;
    const cases: Array<BackendMaintenanceJournal | null> = [
      null,
      { ...actual, phase: "selection-prepared" } as BackendMaintenanceJournal,
      // The requested generation is not a member any more.
      { ...actual, cutoverSet: { manifest: { ...manifest, members: [manifest.members[1]!] }, bindings: [bindings[1]!] } } as BackendMaintenanceJournal,
      withBinding({ queueEvidenceSha256: "c".repeat(64) }),
      withBinding({ roster: [] }),
      ...[{ machineId: "other" }, { queueCutoff: null }, { evidenceSha256: "d".repeat(64) }].map((change) =>
        withBinding({ roster: [{ ...bindingA.roster[0], ...change }] })),
      { ...actual, cutoverSet: { manifest: { ...manifest, members: [{ ...manifest.members[0]!, sourceSelectionSha256: "e".repeat(64) }, manifest.members[1]!] }, bindings } } as BackendMaintenanceJournal,
    ];
    for (const value of cases) {
      const spy = vi.spyOn(publicationApi, "readBackendMaintenanceJournal").mockReturnValue(value as never);
      try { await expect(copy.reauthenticate()).rejects.toThrow("authority"); } finally { spy.mockRestore(); }
    }
    // The trailing recheck compares the same member view after the asynchronous authentication gap.
    const spy = vi.spyOn(publicationApi, "readBackendMaintenanceJournal")
      .mockReturnValueOnce(actual).mockReturnValueOnce(withBinding({ queueEvidenceSha256: "c".repeat(64) }));
    try { await expect(copy.reauthenticate()).rejects.toThrow("authority"); } finally { spy.mockRestore(); }
    // Binding resolves the artifact's own member view as well.
    const bind = () => bindMigrationCopySource(copy, { expectedOwner: "owner", expectedIdentity: identity, destinationCapturedAt: "2026-09-07T03:04:05.000Z", targetProbe: PROBE });
    for (const value of [null, withBinding({ queueEvidenceSha256: "c".repeat(64) })]) {
      const bindSpy = vi.spyOn(publicationApi, "readBackendMaintenanceJournal").mockReturnValue(value as never);
      try { expect(bind).toThrow("authority"); } finally { bindSpy.mockRestore(); }
    }
    expect(readBackendMaintenanceJournal(homeDir)).toEqual(actual);
  } finally { await copy.stream.close(); }
});

it("refuses to open a copy source for a generation that is not a member of the held set", async () => {
  const { homeDir, projects } = await capturedSet();
  await expect(openMigrationCopySource({
    generationId: "stranger-generation", homeDir, expectedIdentity: setMemberIdentity(projects[0]!, 1), scratchParent: homeDir,
  })).rejects.toThrow();
});

