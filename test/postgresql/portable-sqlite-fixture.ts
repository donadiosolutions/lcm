import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { canonicalSha256, createPortableRecordStream, openSqlitePortableSource, openSqlitePortableDestination,
  runPortableTransfer, sqlitePortableFileSha256, type PortableManifest } from "../../src/storage/portable.js";
import { seedPortableSqlite, SQLITE_PORTABLE_FIXTURE } from "../storage/sqlite-portable-fixture.js";
import { assertInterruptedPortableTransfer } from "./portable-resume.js";
import { PORTABLE_POSTGRESQL_FIXTURE } from "./portable-fixture.js";
import {
  assertNativeSqliteCorpus, assertNativeSqliteScope, assertSqliteReadback,
  capture, expectEquivalent, nativeCaptureHashes, sqliteSource, withOwnedHandles,
} from "./portable-corpus.js";

/** The PG leg and the focused SQLite probe execute this exact same corpus. */
export async function assertSqliteCanonicalTransfer(): Promise<PortableManifest> {
  const fixture = PORTABLE_POSTGRESQL_FIXTURE;
  const identity = fixture.expectedIdentity;
  return withOwnedHandles(async (root, own) => {
    const path = join(root, "native-source.sqlite");
    const nativeCapture = seedPortableSqlite(path, {
      projectIdentity: { scope: "shared", projectId: identity.id },
      identityFacts: {
        machines: [
          { identityKey: fixture.machineIdentityKey, machineId: fixture.machineId },
          { identityKey: fixture.secondaryMachineIdentityKey, machineId: fixture.secondaryMachineId },
        ],
        aliases: [
          { machineIdentityKey: fixture.machineIdentityKey, path: fixture.path, normalizedPath: fixture.path },
          { machineIdentityKey: fixture.machineIdentityKey, path: "/portable-worktree", normalizedPath: "/portable-worktree" },
          { machineIdentityKey: fixture.secondaryMachineIdentityKey, path: "/secondary/portable-project", normalizedPath: "/secondary/portable-project" },
        ],
      },
    });
    expect(nativeCapture.sourceLocalProjectId).toBe(SQLITE_PORTABLE_FIXTURE.sourceLocalProjectId);
    expect(nativeCapture.sourceLocalProjectId).not.toBe(identity.id);
    const captureHashes = nativeCaptureHashes(path, nativeCapture);
    assertNativeSqliteScope(path, nativeCapture);
    const source = own(await sqliteSource(path, identity, root, nativeCapture));
    const expected = source.describe();
    const corpus = await capture(source);
    assertNativeSqliteCorpus(corpus, nativeCapture);
    // Canonical archives have explicit owned paths outside project DB storage.
    const targetPath = join(root, "canonical-destination.sqlite");
    const destination = own(await openSqlitePortableDestination({
      databasePath: targetPath, mode: "create",
      projectIdentity: { scope: "shared", projectId: identity.id },
      generationIdentitySha256: canonicalSha256(randomUUID()), scratchParent: root,
    }));
    expect((await runPortableTransfer({ source, destination, maxRecords: 2 })).contentSha256).toBe(expected.contentSha256);
    await assertSqliteReadback(targetPath, identity, corpus);
    const readback = own(await sqliteSource(targetPath, identity, root));
    expectEquivalent(readback.describe(), expected);
    expect(await capture(readback)).toEqual(corpus);
    // A second owned archive exercises an interrupted public transfer with the
    // exact same independently seeded corpus, not a weaker checkpoint fixture.
    const resumePath = join(root, "canonical-resume.sqlite");
    const resumeOptions = {
      databasePath: resumePath, mode: "resume" as const,
      projectIdentity: { scope: "shared" as const, projectId: identity.id },
      generationIdentitySha256: canonicalSha256(randomUUID()), scratchParent: root,
    };
    const interruptedSource = own(await sqliteSource(path, identity, root, nativeCapture));
    expect(interruptedSource.describe()).toEqual(expected);
    const interruptedDestination = own(await openSqlitePortableDestination({ ...resumeOptions, mode: "create" }));
    const resumedResult = await assertInterruptedPortableTransfer({ source: interruptedSource, destination: interruptedDestination,
      reopenDestination: () => openSqlitePortableDestination(resumeOptions),
      openWrongDestination: () => openSqlitePortableDestination({ ...resumeOptions, generationIdentitySha256: canonicalSha256("wrong-destination-generation") }),
      async readNativeProgress() {
        const db = new DatabaseSync(resumePath, { readOnly: true });
        try {
          return {
            receipts: Number(db.prepare("SELECT count(*) AS n FROM transfer_batches").get()!.n),
            transferredMachines: Number(db.prepare("SELECT count(*) AS n FROM transfer_identities WHERE domain='machines'").get()!.n),
            nativeMachines: Number(db.prepare("SELECT count(*) AS n FROM portable_archive_machines").get()!.n),
          };
        } finally { db.close(); }
      },
      openDifferentSource: async () => createPortableRecordStream(await openSqlitePortableSource({
        ...nativeCapture, databasePath: path, projectIdentity: resumeOptions.projectIdentity,
        expectedFileSha256: sqlitePortableFileSha256(path), capturedAt: "2026-09-06T17:00:00.000000Z", scratchParent: root,
      })),
    });
    expect(resumedResult.contentSha256).toBe(expected.contentSha256);
    expect(resumedResult.recordCount).toBe(expected.domains.reduce((count, domain) => count + domain.recordCount, 0));
    const completedDigest = sqlitePortableFileSha256(resumePath);
    await expect(openSqlitePortableDestination({ ...resumeOptions,
      projectIdentity: { scope: "shared", projectId: "01990000-0000-7000-8000-000000000099" },
    }).then(own)).rejects.toMatchObject({ code: "destination-conflict" });
    expect(sqlitePortableFileSha256(resumePath)).toBe(completedDigest);
    // These exact per-domain counts and complete records detect duplicate rows
    // after both replay and refusal, independently of the transfer's own digest.
    await assertSqliteReadback(resumePath, identity, corpus);
    const finalReadback = own(await sqliteSource(resumePath, identity, root));
    expectEquivalent(finalReadback.describe(), expected);
    expect(await capture(finalReadback)).toEqual(corpus);
    assertNativeSqliteScope(path, nativeCapture);
    expect(nativeCaptureHashes(path, nativeCapture)).toEqual(captureHashes);
    return expected;
  });
}
