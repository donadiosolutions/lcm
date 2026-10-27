/**
 * Tests for src/migration/rollback-generation.ts.
 *
 * The "source" in every test here is a plain SQLite database opened as a
 * portable source (openSqlitePortableSource + createPortableRecordStream),
 * never PostgreSQL: buildRollbackGeneration's contract is over the generic
 * PortableRecordStream interface, so this module does not need a live
 * PostgreSQL harness to test build/verify/quarantine correctness. The
 * PostgreSQL-specific piece (opening the fenced, leased source) belongs to
 * rollback.ts's orchestration and is exercised there.
 *
 * Per the epic's standing rule (plan-v2 section 0): every check names the
 * two independent observations it compares, and is proven breakable. The
 * "red-proof" test below is the most important one in this file: it proves
 * that corrupting ONLY the on-disk serialized manifest is caught by this
 * module's second verification pass, while runPortableTransfer's own
 * built-in verifyComplete call -- which DOES reopen the destination file
 * from disk and IS independent on the data axis -- stays unaffected,
 * because the manifest it compares against never itself crosses a
 * durability boundary: it is the same in-memory object derived from
 * source.describe() before a single record was read. This module's
 * second pass adds independence on exactly that manifest axis, binding
 * the comparand to a durable, disk-round-tripped artifact the built-in
 * check does not use -- not a second, redundant data-axis check, and the
 * module doc comment below states that distinction precisely.
 */

import { mkdirSync, mkdtempSync, chmodSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import * as fsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import { fixtureCanonicalDelta, fixtureCensusVector } from "../fixtures/migration-activation-records.js";
import {
  openSqlitePortableSource,
  sqlitePortableFileSha256,
} from "../../src/storage/sqlite/portable-source.js";
import {
  createPortableRecordStream,
  type PortableRecordStream,
} from "../../src/storage/portable-record-stream.js";
import * as portableRecordStreamModule from "../../src/storage/portable-record-stream.js";
import * as portableDestinationModule from "../../src/storage/sqlite/portable-destination.js";
import { canonicalSha256 } from "../../src/storage/portable-record.js";
import {
  buildRollbackGeneration,
  rollbackGenerationPath,
  rollbackGenerationsRoot,
  RollbackGenerationError,
} from "../../src/migration/rollback-generation.js";

// Pass-through by default (rollback-generation.ts's real serialization
// helpers from this module keep running normally for every test), except
// for createPortableRecordStream, which is overridden with
// mockImplementationOnce inside the one test below that needs
// independentReadback's fresh-reopen call specifically to return a fake,
// content-disagreeing stream.
vi.mock("../../src/storage/portable-record-stream.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/storage/portable-record-stream.js")>()),
}));
const streamSpy = vi.spyOn(portableRecordStreamModule, "createPortableRecordStream");

// Pass-through by default; overridden with mockImplementationOnce inside
// the one test below that needs openSqlitePortableDestination to fail
// before db.sqlite is ever created, so quarantine() runs against a
// databasePath that does not exist.
vi.mock("../../src/storage/sqlite/portable-destination.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/storage/sqlite/portable-destination.js")>()),
}));
const destinationSpy = vi.spyOn(portableDestinationModule, "openSqlitePortableDestination");

// Pass-through by default; overridden with mockImplementationOnce inside
// the one test below that needs mkdirSync to fail with a non-EEXIST error,
// distinct from the real "the directory already exists" collision case.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));
const realMkdirSync = fsModule.mkdirSync;
const mkdirSpy = vi.spyOn(fsModule, "mkdirSync");

const identity = { scope: "local" as const, projectId: "a".repeat(64) };
const facts = { machines: [{ identityKey: "local-machine", machineId: null }], aliases: [] };
const capturedAt = "2026-09-06T00:00:00.000000Z";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-rollback-generation-home-"));
  dirs.push(dir);
  return dir;
}

function sqliteFixture(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "lcm-rollback-generation-src-"));
  dirs.push(dir);
  const path = join(dir, "source.db");
  const db = new DatabaseSync(path);
  try { runLcmMigrations(db, { fts5Available: false }); } finally { db.close(); }
  chmodSync(path, 0o600);
  return { dir, path };
}

async function sqliteSourceStream(file: { dir: string; path: string }): Promise<PortableRecordStream> {
  return createPortableRecordStream(await openSqlitePortableSource({
    databasePath: file.path,
    scratchParent: file.dir,
    projectIdentity: identity,
    identityFacts: facts,
    expectedFileSha256: sqlitePortableFileSha256(file.path),
    expectedFactsSha256: canonicalSha256(facts),
    capturedAt,
    capturedSidecars: {
      events: { absent: true, evidenceSha256: "f".repeat(64) },
      instructions: { absent: true, evidenceSha256: "e".repeat(64) },
    },
  }));
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("buildRollbackGeneration", () => {
  it("builds and independently verifies a fresh generation", async () => {
    const homeDir = tempHome();
    const source = await sqliteSourceStream(sqliteFixture());
    const outcome = await buildRollbackGeneration({
      homeDir, generationId: "gen-verified", projectIdentity: identity, source,
    });
    expect(outcome.state).toBe("verified");
    if (outcome.state !== "verified") throw new Error("unreachable");
    expect(outcome.witness.state).toBe("verified");
    expect(outcome.witness.contentSha256).toBe(outcome.contentSha256);
    expect(outcome.witness.reason).toBeNull();
    const witnessPath = join(rollbackGenerationPath(homeDir, "gen-verified"), "witness.json");
    // Immutable evidence either way: witness.json is always 0400.
    expect(mode(witnessPath)).toBe(0o400);
    // Breakable independently: a verified generation's db file is NOT
    // tightened to 0400, because it is about to be installed by a single
    // rename and must stay writable once live -- the quarantine test below
    // proves the opposite outcome tightens it.
    expect(mode(outcome.databasePath)).toBe(0o600);
  });

  it("refuses an invalid generation id, never touching the filesystem", async () => {
    const homeDir = tempHome();
    const source = await sqliteSourceStream(sqliteFixture());
    await expect(buildRollbackGeneration({
      homeDir, generationId: "../escape", projectIdentity: identity, source,
    })).rejects.toMatchObject({ name: "RollbackGenerationError", reason: "invalid-input" });
  });

  it("refuses a generation id whose directory already exists -- never silently rebuilds or resumes", async () => {
    const homeDir = tempHome();
    mkdirSync(rollbackGenerationsRoot(homeDir), { recursive: true, mode: 0o700 });
    mkdirSync(rollbackGenerationPath(homeDir, "gen-dup"), { mode: 0o700 });
    const source = await sqliteSourceStream(sqliteFixture());
    await expect(buildRollbackGeneration({
      homeDir, generationId: "gen-dup", projectIdentity: identity, source,
    })).rejects.toMatchObject({ name: "RollbackGenerationError", reason: "generation-exists" });
  });

  it("records the export snapshot's evidence in the witness of both a verified and a quarantined build, and null when none is given", async () => {
    const exportEvidence = { canonicalDelta: fixtureCanonicalDelta("export"), censusVector: fixtureCensusVector("export") };
    const witnessOf = (homeDir: string, generationId: string) => JSON.parse(
      readFileSync(join(rollbackGenerationPath(homeDir, generationId), "witness.json"), "utf8"),
    ) as { exportEvidence: unknown };

    const homeDir = tempHome();
    const verified = await buildRollbackGeneration({
      homeDir, generationId: "gen-evidence-ok", projectIdentity: identity,
      source: await sqliteSourceStream(sqliteFixture()), exportEvidence,
    });
    expect(verified.state).toBe("verified");
    expect(witnessOf(homeDir, "gen-evidence-ok").exportEvidence).toEqual(exportEvidence);

    const real = await sqliteSourceStream(sqliteFixture());
    const failing: PortableRecordStream = {
      describe: () => real.describe(),
      readBatch: () => { throw new Error("simulated source failure"); },
      verify: (checkpoint) => real.verify(checkpoint),
      close: () => real.close(),
    };
    const quarantined = await buildRollbackGeneration({
      homeDir, generationId: "gen-evidence-bad", projectIdentity: identity, source: failing, exportEvidence,
    });
    expect(quarantined.state).toBe("quarantined");
    expect(witnessOf(homeDir, "gen-evidence-bad").exportEvidence).toEqual(exportEvidence);

    await buildRollbackGeneration({
      homeDir, generationId: "gen-evidence-none", projectIdentity: identity, source: await sqliteSourceStream(sqliteFixture()),
    });
    expect(witnessOf(homeDir, "gen-evidence-none").exportEvidence).toBeNull();
  });

  it("quarantines rather than deletes when the transfer itself fails, and tightens the partial database file to 0400", async () => {
    const homeDir = tempHome();
    const real = await sqliteSourceStream(sqliteFixture());
    const failingSource: PortableRecordStream = {
      describe: () => real.describe(),
      readBatch: () => { throw new Error("simulated source failure"); },
      verify: (checkpoint) => real.verify(checkpoint),
      close: () => real.close(),
    };
    const outcome = await buildRollbackGeneration({
      homeDir, generationId: "gen-transfer-fails", projectIdentity: identity, source: failingSource,
    });
    expect(outcome.state).toBe("quarantined");
    if (outcome.state !== "quarantined") throw new Error("unreachable");
    expect(outcome.reason.startsWith("transfer:")).toBe(true);
    expect(outcome.witness.state).toBe("quarantined");
    expect(outcome.witness.reason).toBe(outcome.reason);
    const witnessPath = join(rollbackGenerationPath(homeDir, "gen-transfer-fails"), "witness.json");
    expect(mode(witnessPath)).toBe(0o400);
    // Breakable independently of the verified-outcome test above: this is
    // the SAME databasePath field name compared to a DIFFERENT expected
    // mode, proving quarantine (not success) is what tightens the file.
    expect(mode(outcome.databasePath)).toBe(0o400);
  });

  it("RED-PROOF: corrupting only the independently-serialized manifest on disk is caught by the second pass, even though runPortableTransfer's own built-in verifyComplete (using its untouched in-memory manifest) has already succeeded by this point", async () => {
    const homeDir = tempHome();
    const source = await sqliteSourceStream(sqliteFixture());
    const generationId = "gen-manifest-corrupted";
    let corrupted = false;
    const outcome = await buildRollbackGeneration({
      homeDir, generationId, projectIdentity: identity, source,
      _afterTransferForTesting: () => {
        // runPortableTransfer has already returned successfully by this
        // point -- its own verifyComplete call, using the SAME in-memory
        // manifest object it derived from source.describe(), has already
        // agreed with itself. Corrupt only the DURABLE disk copy that the
        // second, independent pass reads back.
        const manifestPath = join(rollbackGenerationPath(homeDir, generationId), "manifest.bin");
        chmodSync(manifestPath, 0o600);
        writeFileSync(manifestPath, Buffer.from("not a valid manifest\n"));
        chmodSync(manifestPath, 0o400);
        corrupted = true;
      },
    });
    expect(corrupted).toBe(true);
    expect(outcome.state).toBe("quarantined");
    if (outcome.state !== "quarantined") throw new Error("unreachable");
    expect(outcome.reason).toBe("independent-verification:manifest-readback-failed");
  });

  it("positive control for the red-proof above: the hook running with no corruption still verifies -- proving the previous failure came from the corruption, not from the hook's mere presence", async () => {
    const homeDir = tempHome();
    const source = await sqliteSourceStream(sqliteFixture());
    let hookRan = false;
    const outcome = await buildRollbackGeneration({
      homeDir, generationId: "gen-hook-noop", projectIdentity: identity, source,
      _afterTransferForTesting: () => { hookRan = true; },
    });
    expect(hookRan).toBe(true);
    expect(outcome.state).toBe("verified");
  });

  it("refuses when the durably-written manifest parses but names a different transfer -- distinct from the malformed-bytes case above", async () => {
    const homeDir = tempHome();
    const source = await sqliteSourceStream(sqliteFixture());
    const generationId = "gen-manifest-sha-mismatch";
    // A second, unrelated SQLite source describes a structurally valid
    // manifest with a different manifestSha256. Swapping it in for the
    // real one proves the manifestSha256 comparison specifically, as
    // opposed to any parse failure.
    // A different capturedAt forces a genuinely different manifestSha256
    // (capturedAt participates in the source description) from an
    // otherwise byte-identical empty fixture database.
    const otherFile = sqliteFixture();
    const otherSource = await createPortableRecordStream(await openSqlitePortableSource({
      databasePath: otherFile.path,
      scratchParent: otherFile.dir,
      projectIdentity: identity,
      identityFacts: facts,
      expectedFileSha256: sqlitePortableFileSha256(otherFile.path),
      expectedFactsSha256: canonicalSha256(facts),
      capturedAt: "2026-09-07T00:00:00.000000Z",
      capturedSidecars: {
        events: { absent: true, evidenceSha256: "f".repeat(64) },
        instructions: { absent: true, evidenceSha256: "e".repeat(64) },
      },
    }));
    const otherManifest = otherSource.describe();
    await otherSource.close();
    expect(otherManifest.manifestSha256).not.toBe(source.describe().manifestSha256);
    const outcome = await buildRollbackGeneration({
      homeDir, generationId, projectIdentity: identity, source,
      _afterTransferForTesting: async () => {
        const { serializePortableManifest } = await import("../../src/storage/portable-record-stream.js");
        const manifestPath = join(rollbackGenerationPath(homeDir, generationId), "manifest.bin");
        chmodSync(manifestPath, 0o600);
        writeFileSync(manifestPath, serializePortableManifest(otherManifest));
        chmodSync(manifestPath, 0o400);
      },
    });
    expect(outcome.state).toBe("quarantined");
    if (outcome.state !== "quarantined") throw new Error("unreachable");
    expect(outcome.reason).toBe("independent-verification:manifest-sha-mismatch");
  });

  it("catches a real post-transfer archive mutation -- via the source reader's own ledger-consistency check, one layer earlier than manifestsAgree", async () => {
    // Documented honestly rather than forced to match a guess: a raw SQL
    // INSERT into the archive after the ledger is marked complete does
    // NOT reach manifestsAgree's content comparison at all.
    // openSqlitePortableSource's own internal ledger-vs-archive
    // consistency check fires first and refuses to open at all, which is
    // why this is "readback-failed", proven distinct below (with a
    // different underlying cause) from the chmod-0644 readback-failed
    // case above by asserting on the real error text.
    const homeDir = tempHome();
    const source = await sqliteSourceStream(sqliteFixture());
    const generationId = "gen-post-transfer-archive-mutation";
    const outcome = await buildRollbackGeneration({
      homeDir, generationId, projectIdentity: identity, source,
      _afterTransferForTesting: () => {
        const databasePath = join(rollbackGenerationPath(homeDir, generationId), "db.sqlite");
        chmodSync(databasePath, 0o600);
        const raw = new DatabaseSync(databasePath);
        try {
          raw.exec("PRAGMA journal_mode=DELETE");
          raw.prepare(`INSERT INTO portable_archive_session_instructions
            (_ordinal,_identity_sha256,machineIdentityKey,scopeHash,clientName,sessionId,worktreePath,cwdPath,content,contentHash,updatedAt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .run(999, "f".repeat(64), "local-machine", "9".repeat(64), "codex", "mutated-session",
              "/mutated/worktree", "/mutated/worktree/src", "mutated content", "8".repeat(64), "2026-09-08T00:00:00.000000Z");
        } finally { raw.close(); }
      },
    });
    expect(outcome.state).toBe("quarantined");
    if (outcome.state !== "quarantined") throw new Error("unreachable");
    expect(outcome.reason).toBe("independent-verification:readback-failed");
  });

  it("refuses when the independent reopen itself cannot succeed, distinct from a content disagreement", async () => {
    const homeDir = tempHome();
    const source = await sqliteSourceStream(sqliteFixture());
    const generationId = "gen-readback-fails";
    const outcome = await buildRollbackGeneration({
      homeDir, generationId, projectIdentity: identity, source,
      _afterTransferForTesting: () => {
        // A group/other-readable database file fails the source opener's
        // own private-file authentication before any content is even
        // read, which is a different failure shape from a clean read that
        // disagrees on content.
        const databasePath = join(rollbackGenerationPath(homeDir, generationId), "db.sqlite");
        chmodSync(databasePath, 0o644);
      },
    });
    expect(outcome.state).toBe("quarantined");
    if (outcome.state !== "quarantined") throw new Error("unreachable");
    expect(outcome.reason).toBe("independent-verification:readback-failed");
  });

  it("refuses on a genuine content disagreement between the readback manifest and a fresh reopen -- proven via a controlled fake reopen, documented honestly", async () => {
    // Why a mock, stated rather than hidden: a real post-transfer archive
    // mutation is caught one layer earlier, by openSqlitePortableSource's
    // own ledger-consistency check (proven above), before manifestsAgree
    // ever runs. That is a genuinely stronger guard, and it means this
    // specific branch -- a CLEAN independent reopen that nonetheless
    // disagrees on content -- has no known real-world trigger through this
    // reader chain. It is still required by plan-v2 section 4 ("compares
    // contentSha256 and all 22 domain digests") as defense in depth, so it
    // is proven wired correctly with a controlled fake rather than either
    // left uncovered or given a misleading "real" reproduction it does not
    // have.
    //
    // Why the branch is kept despite the earlier guard, not deleted as
    // dead code: first, the guard that fires earlier lives in a DIFFERENT
    // module (openSqlitePortableSource), so its behaviour is not this
    // module's to depend on -- if that module ever relaxes or reorders
    // its ledger-consistency check, this comparison is what still catches
    // a genuine content divergence. Second, plan-v2 section 4 requires an
    // independent second verification on the manifest axis specifically
    // BECAUSE runPortableTransfer's own built-in check, while genuinely
    // independent for the destination's bytes (it reopens the file from
    // disk), compares those bytes against a manifest that never itself
    // crosses a durability boundary -- the same in-memory object
    // runPortableTransfer derived at the very start. A verification that
    // only fires when some other module happens to decline to open is
    // not independent on the content axis either. This is defence in
    // depth, not redundancy, and the fake is what proves the depth is
    // real rather than assumed.
    const homeDir = tempHome();
    const source = await sqliteSourceStream(sqliteFixture());
    const generationId = "gen-content-mismatch-mocked";
    const outcome = await buildRollbackGeneration({
      homeDir, generationId, projectIdentity: identity, source,
      _afterTransferForTesting: () => {
        // Fake only createPortableRecordStream's next call, which is
        // exactly the call independentReadback makes to wrap the fresh
        // reopen. A minimal but structurally valid PortableRecordStream
        // whose describe() disagrees with the real readBackManifest on
        // contentSha256 is sufficient to exercise manifestsAgree's false
        // branch without needing a real divergent database.
        streamSpy.mockImplementationOnce(async () => ({
          describe: () => ({
            version: 1 as const,
            schemaSha256: "0".repeat(64),
            source: { capturedAt, sourceIdentitySha256: "0".repeat(64), sourceWitnessSha256: "0".repeat(64), coverage: {} },
            domains: [],
            contentSha256: "1".repeat(64),
            limits: { maxBatchRecords: 1, maxBatchBytes: 1, maxRecordBytes: 1 },
            manifestSha256: "2".repeat(64),
          }),
          readBatch: () => { throw new Error("not used by independentReadback"); },
          verify: () => { throw new Error("not used by independentReadback"); },
          close: async () => undefined,
        }));
      },
    });
    expect(outcome.state).toBe("quarantined");
    if (outcome.state !== "quarantined") throw new Error("unreachable");
    expect(outcome.reason).toBe("independent-verification:content-mismatch");
  });

  it("distinguishes a domains-length disagreement from a contentSha256 disagreement -- the same manifestsAgree comparator, a different one of its two guard clauses", async () => {
    const homeDir = tempHome();
    const source = await sqliteSourceStream(sqliteFixture());
    const generationId = "gen-content-mismatch-domains-length";
    const realContentSha256 = source.describe().contentSha256;
    const outcome = await buildRollbackGeneration({
      homeDir, generationId, projectIdentity: identity, source,
      _afterTransferForTesting: () => {
        streamSpy.mockImplementationOnce(async () => ({
          describe: () => ({
            version: 1 as const,
            schemaSha256: "0".repeat(64),
            source: { capturedAt, sourceIdentitySha256: "0".repeat(64), sourceWitnessSha256: "0".repeat(64), coverage: {} },
            domains: [],
            // Matches the real content digest exactly, so only the
            // domains-length guard (not the contentSha256 guard already
            // proven above) can be what makes this disagree.
            contentSha256: realContentSha256,
            limits: { maxBatchRecords: 1, maxBatchBytes: 1, maxRecordBytes: 1 },
            manifestSha256: "2".repeat(64),
          }),
          readBatch: () => { throw new Error("not used by independentReadback"); },
          verify: () => { throw new Error("not used by independentReadback"); },
          close: async () => undefined,
        }));
      },
    });
    expect(outcome.state).toBe("quarantined");
    if (outcome.state !== "quarantined") throw new Error("unreachable");
    expect(outcome.reason).toBe("independent-verification:content-mismatch");
  });

  it("quarantines without a databasePath to chmod when the destination never got created -- best-effort tightening never blocks the quarantine itself", async () => {
    const homeDir = tempHome();
    const source = await sqliteSourceStream(sqliteFixture());
    destinationSpy.mockImplementationOnce(() => {
      throw new Error("simulated: destination could not even be opened");
    });
    const outcome = await buildRollbackGeneration({
      homeDir, generationId: "gen-destination-open-fails", projectIdentity: identity, source,
    });
    expect(outcome.state).toBe("quarantined");
    if (outcome.state !== "quarantined") throw new Error("unreachable");
    expect(outcome.reason.startsWith("transfer:")).toBe(true);
    // The database file was never created, and quarantine() still
    // completed (witness.json exists), proving the best-effort chmod does
    // not block quarantine when there is nothing to chmod.
    expect(() => statSync(outcome.databasePath)).toThrow();
    const witnessPath = join(rollbackGenerationPath(homeDir, "gen-destination-open-fails"), "witness.json");
    expect(mode(witnessPath)).toBe(0o400);
  });
});

describe("rollbackGenerationPath", () => {
  it("rejects a generation id outside the allowed pattern before joining any path", () => {
    expect(() => rollbackGenerationPath("/tmp/home", "bad/id"))
      .toThrow(RollbackGenerationError);
  });
});

describe("buildRollbackGeneration directory precondition", () => {
  it("refuses with unsafe-storage when the generation directory cannot be created for a reason other than EEXIST", async () => {
    const homeDir = tempHome();
    const source = await sqliteSourceStream(sqliteFixture());
    // ensurePrivateDirectory's own internal mkdirSync call (for the
    // idempotent root directory) consumes the FIRST mockImplementationOnce
    // if we only queue one -- let it run for real, and fail only the
    // SECOND call, which is this function's own exclusive generationDir
    // creation.
    mkdirSpy.mockImplementationOnce((path, options) => realMkdirSync(path, options));
    mkdirSpy.mockImplementationOnce(() => {
      throw Object.assign(new Error("simulated ENOSPC"), { code: "ENOSPC" });
    });
    await expect(buildRollbackGeneration({
      homeDir, generationId: "gen-mkdir-fails", projectIdentity: identity, source,
    })).rejects.toMatchObject({ name: "RollbackGenerationError", reason: "unsafe-storage" });
    mkdirSpy.mockRestore();
  });
});
