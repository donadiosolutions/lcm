import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalSha256, createPostgreSqlPortableDestination, openSqlitePortableDestination, runPortableTransfer } from "../../src/storage/portable.js";
import { PostgreSqlPromotedMemoryRepository } from "../../src/storage/postgresql/memory-repositories.js";
import { seedPortableSqlite, SQLITE_PORTABLE_FIXTURE } from "../storage/sqlite-portable-fixture.js";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase } from "./harness.js";
import { seedPortablePostgreSql } from "./portable-fixture.js";
import {
  transferGrants, identityFacts, capture, expectEquivalent, assertNativeSqliteCorpus,
  assertRuntimeMemory, assertSqliteReadback, nativeCaptureHashes,
  assertNativeSqliteScope, assertPostgreSqlNativeCounts, withOwnedHandles,
  pgSource, pgDestination, sqliteSource,
} from "./portable-corpus.js";

import { assertInterruptedPortableTransfer } from "./portable-resume.js";
import { emitCanonicalEvidence } from "./portable-evidence.js";

beforeAll(assertHarnessReady);
const context = { domain: "factory", operation: "portableCrossBackendFixture" } as const;

describe("PostgreSQL 18 and SQLite complete canonical transfer", { timeout: 120_000 }, () => {
  it("moves independently seeded PostgreSQL through SQLite archive into a fresh PostgreSQL database with all 22 hashes intact", async () => {
    const manifest = await withPostgreSqlTestDatabase("portable-origin", async origin => {
      const fixture = await seedPortablePostgreSql(origin.migrator);
      await transferGrants(origin);
      return withPostgreSqlTestDatabase("portable-return", async target => {
        const registered = await seedPortablePostgreSql(target.migrator, { identityOnly: true });
        expect(registered.expectedIdentity).toEqual(fixture.expectedIdentity);
        await transferGrants(target);
        return withOwnedHandles(async (root, own) => {
          const source = own(await pgSource(origin, fixture.expectedIdentity));
          const expected = source.describe();
          const corpus = await capture(source);
          const path = join(root, "pg-import.sqlite");
          const options = { databasePath: path,
            projectIdentity: { scope: "shared" as const, projectId: fixture.expectedIdentity.id },
            generationIdentitySha256: canonicalSha256(randomUUID()), scratchParent: root };
          const destination = own(await openSqlitePortableDestination({ ...options, mode: "create" }));
          expect((await assertInterruptedPortableTransfer({ source, destination,
            reopenDestination: () => openSqlitePortableDestination({ ...options, mode: "resume" }),
            openWrongDestination: () => openSqlitePortableDestination({ ...options, mode: "resume", generationIdentitySha256: canonicalSha256("wrong-cross-generation") }),
            openDifferentSource: () => pgSource(origin, fixture.expectedIdentity),
            async readNativeProgress() {
              const db = new DatabaseSync(path, { readOnly: true });
              try {
                return { receipts: Number(db.prepare("SELECT count(*) AS n FROM transfer_batches").get()!.n),
                  transferredMachines: Number(db.prepare("SELECT count(*) AS n FROM transfer_identities WHERE domain='machines'").get()!.n),
                  nativeMachines: Number(db.prepare("SELECT count(*) AS n FROM portable_archive_machines").get()!.n) };
              } finally { db.close(); }
            },
          })).contentSha256).toBe(expected.contentSha256);
          await assertSqliteReadback(path, fixture.expectedIdentity, corpus);
          const intermediate = own(await sqliteSource(path, fixture.expectedIdentity, root));
          expectEquivalent(intermediate.describe(), expected);
          const remote = own(await pgDestination(target, registered.expectedIdentity, root));
          expect((await runPortableTransfer({ source: intermediate, destination: remote, maxRecords: 2 })).contentSha256).toBe(expected.contentSha256);
          const readback = own(await pgSource(target, registered.expectedIdentity));
          expectEquivalent(readback.describe(), expected);
          await assertRuntimeMemory(new PostgreSqlPromotedMemoryRepository(target.runtime, registered.expectedIdentity.id), corpus, registered.expectedIdentity.id);
          expect((await target.migrator.query({ text: "SELECT count(*)::int AS n FROM lcm.native_transcripts WHERE project_id=$1", values: [registered.expectedIdentity.id] }, context)).rows[0].n)
            .toBe(corpus.get("native-transcripts")!.length);
          await assertPostgreSqlNativeCounts(target, registered.expectedIdentity.id, corpus);
          expect(await capture(readback)).toEqual(corpus);
          return expected;
        });
      });
    });
    emitCanonicalEvidence("postgresql->sqlite", manifest);
  });

  it("moves independent native SQLite rows into PostgreSQL and back into a fresh SQLite archive", async () => {
    const manifest = await withPostgreSqlTestDatabase("portable-from-sqlite", async target => {
      const fixture = await seedPortablePostgreSql(target.migrator, { identityOnly: true });
      await transferGrants(target);
      return withOwnedHandles(async (root, own) => {
        const path = join(root, "independent.sqlite");
        const nativeCapture = seedPortableSqlite(path, { projectIdentity: { scope: "shared", projectId: fixture.expectedIdentity.id }, identityFacts: await identityFacts(target, fixture.expectedIdentity) });
        expect(nativeCapture.sourceLocalProjectId).toBe(SQLITE_PORTABLE_FIXTURE.sourceLocalProjectId);
        expect(nativeCapture.sourceLocalProjectId).not.toBe(fixture.expectedIdentity.id);
        const captureHashes = nativeCaptureHashes(path, nativeCapture);
        assertNativeSqliteScope(path, nativeCapture);
        const source = own(await sqliteSource(path, fixture.expectedIdentity, root, nativeCapture));
        const expected = source.describe();
        const corpus = await capture(source);
        assertNativeSqliteCorpus(corpus, nativeCapture);
        const options = { settings: settings(target.runtimeUrl), expectedOwner: "lcm_test_migrator", expectedIdentity: fixture.expectedIdentity,
          generationId: randomUUID(), runId: randomUUID(), scratchParent: root };
        const remote = own(await createPostgreSqlPortableDestination(options));
        expect((await assertInterruptedPortableTransfer({ source, destination: remote,
          reopenDestination: () => createPostgreSqlPortableDestination(options),
          openWrongDestination: () => createPostgreSqlPortableDestination({ ...options, generationId: "wrong-cross-generation" }),
          async readNativeProgress() {
            const result = await target.migrator.query<{ receipts: number; transferredMachines: number; nativeMachines: number }>({
              text: `SELECT (SELECT count(*)::int FROM lcm.transfer_batches WHERE run_id=$1) AS receipts,
                (SELECT count(*)::int FROM lcm.transfer_identities WHERE run_id=$1 AND domain='machines') AS "transferredMachines",
                (SELECT count(*)::int FROM lcm.machines) AS "nativeMachines"`, values: [options.runId],
            }, context);
            return result.rows[0];
          },
        })).contentSha256).toBe(expected.contentSha256);
        await assertRuntimeMemory(new PostgreSqlPromotedMemoryRepository(target.runtime, fixture.expectedIdentity.id), corpus, fixture.expectedIdentity.id);
        await assertPostgreSqlNativeCounts(target, fixture.expectedIdentity.id, corpus);
        const intermediate = own(await pgSource(target, fixture.expectedIdentity));
        expectEquivalent(intermediate.describe(), expected);
        const finalPath = join(root, "returned.sqlite");
        const finalTarget = own(await openSqlitePortableDestination({ databasePath: finalPath, mode: "create", projectIdentity: { scope: "shared", projectId: fixture.expectedIdentity.id },
          generationIdentitySha256: canonicalSha256(randomUUID()), scratchParent: root }));
        expect((await runPortableTransfer({ source: intermediate, destination: finalTarget, maxRecords: 2 })).contentSha256).toBe(expected.contentSha256);
        await assertSqliteReadback(finalPath, fixture.expectedIdentity, corpus);
        const readback = own(await sqliteSource(finalPath, fixture.expectedIdentity, root));
        expectEquivalent(readback.describe(), expected);
        expect(await capture(readback)).toEqual(corpus);
        assertNativeSqliteScope(path, nativeCapture);
        expect(nativeCaptureHashes(path, nativeCapture)).toEqual(captureHashes);
        return expected;
      });
    });
    emitCanonicalEvidence("sqlite->postgresql", manifest);
  });
});
