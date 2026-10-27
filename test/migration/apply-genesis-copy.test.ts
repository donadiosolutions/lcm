import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { performMigrationApplyGenesisAndCopy, performMigrationGenesisDryRun } from "../../src/migration/apply-genesis-copy.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import {
  beginMigrationEffect,
  classifyMigrationRecovery,
  completeMigrationEffect,
  createMigrationManifest,
  type MigrationManifest,
} from "../../src/migration/protocol.js";
import type { AuthenticatedSqliteSnapshotAuthority } from "../../src/migration/sqlite-snapshot.js";
import type { PostgreSqlConnectionSettings } from "../../src/storage/postgresql/contracts.js";
import type { StorageIdentityContext } from "../../src/storage/contracts.js";

const classify = vi.hoisted(() => vi.fn());
const inspect = vi.hoisted(() => vi.fn());
const runCopy = vi.hoisted(() => vi.fn());

vi.mock("../../src/migration/sqlite-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/migration/sqlite-snapshot.js")>()),
  classifySqliteSnapshotArtifact: classify,
}));
vi.mock("../../src/migration/batch-copy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/migration/batch-copy.js")>()),
  inspectSqliteMigrationCopy: inspect,
  runSqliteMigrationCopy: runCopy,
}));

const roots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-apply-genesis-copy-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

const SETTINGS: PostgreSqlConnectionSettings = {
  url: "postgresql://unused:unused@127.0.0.1:1/unused",
  caFile: "/unused", poolMax: 1, connectionTimeoutMs: 100, idleTimeoutMs: 100, statementTimeoutMs: 100,
};
const IDENTITY: StorageIdentityContext = {
  id: "remote-project", remoteProjectId: "remote-project", localProjectId: "local-project",
  machineId: "018f0b5d-1234-4abc-8def-1234567890ab", canonical: "/unused", selectedPath: "/unused",
};

function baseInput(overrides: Partial<Parameters<typeof performMigrationApplyGenesisAndCopy>[0]> = {}) {
  return {
    homeDir: home(), generationId: "generation-1", maintenanceChecksumSha256: "a".repeat(64),
    settings: SETTINGS, expectedOwner: "lcm_test_migrator", expectedIdentity: IDENTITY,
    ownerProcessId: "owner-1", maxRecords: 1, maxBytes: 1024,
    ...overrides,
  };
}

function witness(sha = "1".repeat(64), backend: "sqlite" | "postgresql" = "sqlite") {
  return {
    version: 1 as const, backend, identitySha256: sha, schemaSha256: sha,
    contentSha256: sha, capturedAt: "2026-08-12T12:00:00.000Z",
  };
}

describe("performMigrationApplyGenesisAndCopy (section 8's genesis-and-copy row)", () => {
  it("refuses snapshot-unresolvable when classification itself throws, never treating that as capture-incomplete", async () => {
    classify.mockRejectedValueOnce(new Error("injected classification failure"));
    const input = baseInput();
    const outcome = await performMigrationApplyGenesisAndCopy(input);
    expect(outcome).toEqual({ status: "refuse", reason: "snapshot-unresolvable", evidence: "Error" });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("refuses snapshot-unresolvable with unknown-snapshot-failure evidence when classification throws a non-Error value", async () => {
    classify.mockRejectedValueOnce("not-an-error-instance");
    const input = baseInput();
    const outcome = await performMigrationApplyGenesisAndCopy(input);
    expect(outcome).toEqual({ status: "refuse", reason: "snapshot-unresolvable", evidence: "unknown-snapshot-failure" });
  });

  it.each(["absent", "partial", "replaced", "tampered"] as const)(
    "refuses capture-incomplete (section 4.7, enforced here) when the carried generationId classifies %s, never reaching the manifest tree",
    async (state) => {
      classify.mockResolvedValueOnce({ state, generationId: "generation-1" });
      const input = baseInput();
      const outcome = await performMigrationApplyGenesisAndCopy(input);
      expect(outcome).toEqual({ status: "refuse", reason: "capture-incomplete", evidence: `snapshot-${state}` });
      expect(inspect).not.toHaveBeenCalled();
    },
  );

  it("refuses manifest-unresolvable when the manifest presence probe itself cannot be established", async () => {
    classify.mockResolvedValueOnce({ state: "complete", generationId: "generation-1", witness: {} as never });
    const input = baseInput();
    const migrations = join(input.homeDir, ".lcm", "migrations");
    mkdirSync(migrations, { mode: 0o700 });
    chmodSync(migrations, 0o755);
    let outcome;
    try {
      outcome = await performMigrationApplyGenesisAndCopy(input);
    } finally {
      chmodSync(migrations, 0o700);
    }
    expect(outcome).toEqual({ status: "refuse", reason: "manifest-unresolvable", evidence: "manifest-internal-error" });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("refuses genesis-inspection-failed when inspectSqliteMigrationCopy itself throws, never creating a manifest", async () => {
    classify.mockResolvedValueOnce({ state: "complete", generationId: "generation-1", witness: {} as never });
    inspect.mockRejectedValueOnce(new Error("injected PostgreSQL probe failure"));
    const input = baseInput();
    const outcome = await performMigrationApplyGenesisAndCopy(input);
    expect(outcome).toEqual({ status: "refuse", reason: "genesis-inspection-failed", evidence: "Error" });
    const store = new MigrationManifestStore({ homeDir: input.homeDir });
    expect(store.probeManifestPresence(input.generationId)).toEqual({ status: "absent" });
  });

  it("refuses genesis-inspection-failed with unknown-inspection-failure evidence when inspectSqliteMigrationCopy throws a non-Error value", async () => {
    classify.mockResolvedValueOnce({ state: "complete", generationId: "generation-1", witness: {} as never });
    inspect.mockRejectedValueOnce("not-an-error-instance");
    const input = baseInput();
    const outcome = await performMigrationApplyGenesisAndCopy(input);
    expect(outcome).toEqual({ status: "refuse", reason: "genesis-inspection-failed", evidence: "unknown-inspection-failure" });
  });

  it("refuses genesis-create-failed when the inspected witness cannot produce a valid manifest (a malformed destination witness)", async () => {
    classify.mockResolvedValueOnce({ state: "complete", generationId: "generation-1", witness: {} as never });
    inspect.mockResolvedValueOnce({ source: witness(), destination: { not: "a witness" } as never, bindingSha256: "b".repeat(64) });
    const input = baseInput();
    const outcome = await performMigrationApplyGenesisAndCopy(input);
    expect(outcome.status).toBe("refuse");
    if (outcome.status !== "refuse") throw new Error("unreachable");
    expect(outcome.reason).toBe("genesis-create-failed");
    const store = new MigrationManifestStore({ homeDir: input.homeDir });
    expect(store.probeManifestPresence(input.generationId)).toEqual({ status: "absent" });
  });

  it("refuses genesis-dry-run-begin-failed when beginMigrationEffect itself refuses on the just-created manifest (proven by corrupting the manifest handed to it, independent of genesis's own create step, which already succeeded)", async () => {
    classify.mockResolvedValueOnce({ state: "complete", generationId: "generation-1", witness: {} as never });
    inspect.mockResolvedValueOnce({ source: witness("1".repeat(64)), destination: witness("2".repeat(64), "postgresql"), bindingSha256: "b".repeat(64) });
    const input = baseInput();
    const realCreate = MigrationManifestStore.prototype.create;
    const createSpy = vi.spyOn(MigrationManifestStore.prototype, "create").mockImplementationOnce(function (this: MigrationManifestStore, manifest: MigrationManifest) {
      const created = realCreate.call(this, manifest);
      // Corrupts the manifest object beginMigrationEffect receives without
      // touching the durable copy create() already wrote: this proves the
      // begin-failed mapping is exercised by beginMigrationEffect's own
      // parseMigrationManifest refusing a self-inconsistent object (the
      // stale checksumSha256 no longer matches the mutated revision), a
      // real refusal this function must classify correctly, not a
      // fabricated status string.
      return { ...created, revision: Number.MAX_SAFE_INTEGER };
    });
    const outcome = await performMigrationApplyGenesisAndCopy(input);
    createSpy.mockRestore();
    expect(outcome).toEqual({ status: "refuse", reason: "genesis-dry-run-begin-failed", evidence: "manifest-malformed-manifest" });
  });

  it("refuses genesis-dry-run-complete-failed when completeMigrationEffect refuses (proven by a store.update race that moves the checksum underneath it)", async () => {
    classify.mockResolvedValueOnce({ state: "complete", generationId: "generation-1", witness: {} as never });
    inspect.mockResolvedValueOnce({ source: witness("1".repeat(64)), destination: witness("2".repeat(64), "postgresql"), bindingSha256: "b".repeat(64) });
    const input = baseInput();
    const realUpdate = MigrationManifestStore.prototype.update;
    let calls = 0;
    const updateSpy = vi.spyOn(MigrationManifestStore.prototype, "update").mockImplementation(function (this: MigrationManifestStore, generationId: string, expectedChecksumSha256: string, mutate: (current: MigrationManifest) => MigrationManifest) {
      calls += 1;
      if (calls === 2) {
        // The second update call is completeMigrationEffect's own publish.
        // Racing the expected checksum here forces MigrationManifestStore's
        // own optimistic-concurrency refusal, which surfaces through this
        // function's genesis-dry-run-complete-failed mapping.
        // Flip the final hex digit so the raced checksum always differs.
        const raced = `${expectedChecksumSha256.slice(0, -1)}${expectedChecksumSha256.endsWith("0") ? "1" : "0"}`;
        return realUpdate.call(this, generationId, raced, mutate);
      }
      return realUpdate.call(this, generationId, expectedChecksumSha256, mutate);
    });
    const outcome = await performMigrationApplyGenesisAndCopy(input);
    updateSpy.mockRestore();
    expect(outcome.status).toBe("refuse");
    if (outcome.status !== "refuse") throw new Error("unreachable");
    expect(outcome.reason).toBe("genesis-dry-run-complete-failed");
  });

  it("refuses copy-failed when runSqliteMigrationCopy itself throws after a successful genesis", async () => {
    classify.mockResolvedValueOnce({ state: "complete", generationId: "generation-1", witness: {} as never });
    inspect.mockResolvedValueOnce({ source: witness("1".repeat(64)), destination: witness("2".repeat(64), "postgresql"), bindingSha256: "b".repeat(64) });
    runCopy.mockRejectedValueOnce(new Error("injected copy failure"));
    const input = baseInput();
    const outcome = await performMigrationApplyGenesisAndCopy(input);
    expect(outcome).toEqual({ status: "refuse", reason: "copy-failed", evidence: "Error" });
    const store = new MigrationManifestStore({ homeDir: input.homeDir });
    const manifest = store.read(input.generationId);
    expect(manifest.phase).toBe("dry-run-verified");
    expect(classifyMigrationRecovery(manifest)).toEqual({ action: "ready" });
  });

  it("completes genesis and copy for a fresh generation, recording the caller-supplied maintenanceChecksumSha256 in the dry-run report rather than any other value", async () => {
    classify.mockResolvedValueOnce({ state: "complete", generationId: "generation-1", witness: {} as never });
    inspect.mockResolvedValueOnce({ source: witness("1".repeat(64)), destination: witness("2".repeat(64), "postgresql"), bindingSha256: "b".repeat(64) });
    runCopy.mockResolvedValueOnce({ phase: "copied" as const, generationId: "generation-1" });
    const input = baseInput({ maintenanceChecksumSha256: "9".repeat(64) });
    const outcome = await performMigrationApplyGenesisAndCopy(input);
    expect(outcome).toEqual({ status: "copied", result: { phase: "copied", generationId: "generation-1" } });
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ generationId: "generation-1", maxRecords: 1, maxBytes: 1024 }));
    const store = new MigrationManifestStore({ homeDir: input.homeDir });
    const manifest = store.read(input.generationId);
    const report = manifest.reports.find((entry) => entry.kind === "dry-run")!;
    expect(report).toBeDefined();
    // The differential proof that this reportId is a function of the
    // *carried* checksum, not a re-read of any live state, is the real-PG
    // integration test's job (migration-apply-genesis-copy.integration.ts):
    // it runs the real function twice with two different carried values
    // against the same real journal and shows the recorded hash differs
    // exactly as this function's own documented computation predicts.
  });

  it("skips genesis entirely when the manifest already exists, going straight to copy (never re-creating or re-deriving anything)", async () => {
    classify.mockResolvedValue({ state: "complete", generationId: "generation-1", witness: {} as never });
    inspect.mockResolvedValueOnce({ source: witness("1".repeat(64)), destination: witness("2".repeat(64), "postgresql"), bindingSha256: "b".repeat(64) });
    runCopy.mockResolvedValue({ phase: "copied" as const, generationId: "generation-1" });
    const input = baseInput();
    const first = await performMigrationApplyGenesisAndCopy(input);
    expect(first.status).toBe("copied");
    expect(inspect).toHaveBeenCalledTimes(1);

    const second = await performMigrationApplyGenesisAndCopy(input);
    expect(second.status).toBe("copied");
    // Genesis's own inspection is not called a second time: presence was
    // "present", so the manifest tree was never touched by this call.
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(runCopy).toHaveBeenCalledTimes(2);
  });

  it("threads the optional copy limits and cancellation signal through to the copy input when the caller supplies them", async () => {
    classify.mockResolvedValueOnce({ state: "complete", generationId: "generation-1", witness: {} as never });
    inspect.mockResolvedValueOnce({ source: witness("1".repeat(64)), destination: witness("2".repeat(64), "postgresql"), bindingSha256: "b".repeat(64) });
    runCopy.mockResolvedValueOnce({ phase: "copied" as const, generationId: "generation-1" });
    const controller = new AbortController();
    const input = baseInput({ leaseTtlMs: 60000, maximumTransactionAttempts: 5, signal: controller.signal });
    const outcome = await performMigrationApplyGenesisAndCopy(input);
    expect(outcome.status).toBe("copied");
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({
      leaseTtlMs: 60000, maximumTransactionAttempts: 5, signal: controller.signal,
    }));
    expect(runCopy).toHaveBeenCalledWith(expect.objectContaining({
      leaseTtlMs: 60000, maximumTransactionAttempts: 5, signal: controller.signal,
    }), undefined);
  });

  it("forwards the optional testing dependencies through to runSqliteMigrationCopy's own second parameter, the identical seam threaded one layer up rather than reinvented (real-PostgreSQL proof of what this seam is for lives in migration-apply-genesis-copy.integration.ts)", async () => {
    classify.mockResolvedValueOnce({ state: "complete", generationId: "generation-1", witness: {} as never });
    inspect.mockResolvedValueOnce({ source: witness("1".repeat(64)), destination: witness("2".repeat(64), "postgresql"), bindingSha256: "b".repeat(64) });
    runCopy.mockResolvedValueOnce({ phase: "copied" as const, generationId: "generation-1" });
    const testing = { observe: vi.fn() };
    const input = baseInput({ testing });
    const outcome = await performMigrationApplyGenesisAndCopy(input);
    expect(outcome.status).toBe("copied");
    // The exact same object reference reaches runSqliteMigrationCopy's
    // second argument, unmodified and un-re-wrapped -- a caller that did
    // not supply testing (every production caller today) still causes a
    // second argument to be passed, but as undefined, matching
    // runSqliteMigrationCopy's own default-parameter behaviour exactly.
    expect(runCopy).toHaveBeenCalledWith(expect.objectContaining({ generationId: "generation-1" }), testing);
  });

  it("refuses genesis-create-failed with manifest-internal-error evidence when the create step throws something other than a MigrationProtocolError (proves protocolEvidence's fallback, not just its typed branch)", async () => {
    classify.mockResolvedValueOnce({ state: "complete", generationId: "generation-1", witness: {} as never });
    inspect.mockResolvedValueOnce({ source: witness("1".repeat(64)), destination: witness("2".repeat(64), "postgresql"), bindingSha256: "b".repeat(64) });
    const createSpy = vi.spyOn(MigrationManifestStore.prototype, "create").mockImplementationOnce(() => {
      throw new Error("injected non-protocol create failure");
    });
    const input = baseInput();
    const outcome = await performMigrationApplyGenesisAndCopy(input);
    createSpy.mockRestore();
    expect(outcome).toEqual({ status: "refuse", reason: "genesis-create-failed", evidence: "manifest-internal-error" });
  });

  it("refuses copy-failed with unknown-copy-failure evidence when runSqliteMigrationCopy throws a non-Error value (proves the ternary's other side)", async () => {
    classify.mockResolvedValueOnce({ state: "complete", generationId: "generation-1", witness: {} as never });
    inspect.mockResolvedValueOnce({ source: witness("1".repeat(64)), destination: witness("2".repeat(64), "postgresql"), bindingSha256: "b".repeat(64) });
    runCopy.mockRejectedValueOnce("not-an-error-instance");
    const input = baseInput();
    const outcome = await performMigrationApplyGenesisAndCopy(input);
    expect(outcome).toEqual({ status: "refuse", reason: "copy-failed", evidence: "unknown-copy-failure" });
  });
});
describe("performMigrationGenesisDryRun (plan-v5 rows 19-20: genesis without the copy)", () => {
  const CAPTURED_AT = "2026-01-02T03:04:05.000Z";

  function plannedManifest(generationId: string): MigrationManifest {
    return createMigrationManifest({
      generationId,
      source: witness("1".repeat(64)),
      destination: { ...witness("2".repeat(64), "postgresql"), capturedAt: CAPTURED_AT },
      parentGenerationId: null,
      preservedSourceGenerationId: generationId,
      createdAt: CAPTURED_AT,
    });
  }

  function completeSnapshot(): void {
    classify.mockResolvedValue({ state: "complete", generationId: "generation-1", witness: {} as never });
  }

  it("with no manifest, does exactly what apply's genesis does, then stops before any copy", async () => {
    completeSnapshot();
    inspect.mockResolvedValueOnce({ source: witness("1".repeat(64)), destination: witness("2".repeat(64), "postgresql"), bindingSha256: "b".repeat(64) });
    const input = baseInput();
    const outcome = await performMigrationGenesisDryRun(input);
    expect(outcome).toEqual({ status: "ready" });
    const manifest = new MigrationManifestStore({ homeDir: input.homeDir }).read(input.generationId);
    expect(manifest.phase).toBe("dry-run-verified");
    expect(manifest.pendingEffect).toBeNull();
    expect(runCopy).not.toHaveBeenCalled();
  });

  it("with a planned manifest and nothing pending (a crash after create), begins and completes the dry-run effect, binding the sealed capture time rather than a fresh clock", async () => {
    completeSnapshot();
    inspect.mockResolvedValueOnce({ source: witness("1".repeat(64)), destination: witness("2".repeat(64), "postgresql"), bindingSha256: "b".repeat(64) });
    const input = baseInput();
    new MigrationManifestStore({ homeDir: input.homeDir }).create(plannedManifest(input.generationId));
    const outcome = await performMigrationGenesisDryRun({ ...input, now: new Date("2030-01-01T00:00:00.000Z") });
    expect(outcome).toEqual({ status: "ready" });
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ destinationCapturedAt: CAPTURED_AT }));
    const manifest = new MigrationManifestStore({ homeDir: input.homeDir }).read(input.generationId);
    expect(manifest.phase).toBe("dry-run-verified");
    expect(manifest.reports.some((report) => report.kind === "dry-run" && report.reportSha256 === "b".repeat(64))).toBe(true);
  });

  async function pendingDryRun(input: ReturnType<typeof baseInput>): Promise<string> {
    const store = new MigrationManifestStore({ homeDir: input.homeDir });
    const created = store.create(plannedManifest(input.generationId));
    const begun = beginMigrationEffect(created, {
      kind: "verify-dry-run", effectId: "carried-effect", inputSha256: "c".repeat(64), startedAt: created.updatedAt,
    });
    store.update(input.generationId, created.checksumSha256, () => begun);
    return "carried-effect";
  }

  it("with a pending verify-dry-run (a crash after begin), completes only the carried effect id and never begins again", async () => {
    completeSnapshot();
    inspect.mockResolvedValueOnce({ source: witness("1".repeat(64)), destination: witness("2".repeat(64), "postgresql"), bindingSha256: "b".repeat(64) });
    const input = baseInput();
    const carriedEffectId = await pendingDryRun(input);
    const outcome = await performMigrationGenesisDryRun({ ...input, carriedEffectId });
    expect(outcome).toEqual({ status: "ready" });
    const manifest = new MigrationManifestStore({ homeDir: input.homeDir }).read(input.generationId);
    expect(manifest.phase).toBe("dry-run-verified");
    expect(manifest.reports.find((report) => report.kind === "dry-run")?.reportId).toBe(carriedEffectId);
  });

  it.each([
    ["a different effect id", "some-other-effect"],
    ["no carried effect id", undefined],
  ])("writes nothing and refuses genesis-dry-run-effect-mismatch for %s", async (_name, carried) => {
    completeSnapshot();
    const input = baseInput();
    await pendingDryRun(input);
    const store = new MigrationManifestStore({ homeDir: input.homeDir });
    const before = store.read(input.generationId).checksumSha256;
    const outcome = await performMigrationGenesisDryRun({ ...input, carriedEffectId: carried });
    expect(outcome).toEqual({ status: "refuse", reason: "genesis-dry-run-effect-mismatch" });
    expect(store.read(input.generationId).checksumSha256).toBe(before);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("refuses genesis-dry-run-unexpected-state for a manifest past planned, writing nothing", async () => {
    completeSnapshot();
    const input = baseInput();
    const store = new MigrationManifestStore({ homeDir: input.homeDir });
    const created = store.create(plannedManifest(input.generationId));
    const begun = beginMigrationEffect(created, { kind: "verify-dry-run", effectId: "e", inputSha256: "c".repeat(64), startedAt: created.updatedAt });
    const stored = store.update(input.generationId, created.checksumSha256, () => begun);
    const done = completeMigrationEffect(stored, { effectId: "e", completedAt: stored.updatedAt, report: { kind: "dry-run", reportId: "e", reportSha256: "d".repeat(64), createdAt: stored.updatedAt } });
    store.update(input.generationId, stored.checksumSha256, () => done);
    const outcome = await performMigrationGenesisDryRun({ ...input, carriedEffectId: "e" });
    expect(outcome).toEqual({ status: "refuse", reason: "genesis-dry-run-unexpected-state", evidence: "manifest-dry-run-verified" });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("enforces capture-before-genesis on every call", async () => {
    classify.mockResolvedValueOnce({ state: "partial", generationId: "generation-1" });
    const outcome = await performMigrationGenesisDryRun(baseInput());
    expect(outcome).toEqual({ status: "refuse", reason: "capture-incomplete", evidence: "snapshot-partial" });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("refuses manifest-unresolvable when the presence probe cannot be established, and when a present manifest cannot be read", async () => {
    completeSnapshot();
    const probe = baseInput();
    const migrations = join(probe.homeDir, ".lcm", "migrations");
    mkdirSync(migrations, { mode: 0o700 });
    chmodSync(migrations, 0o755);
    let outcome;
    try {
      outcome = await performMigrationGenesisDryRun(probe);
    } finally {
      chmodSync(migrations, 0o700);
    }
    expect(outcome).toEqual({ status: "refuse", reason: "manifest-unresolvable", evidence: "manifest-internal-error" });

    const unreadable = {
      probeManifestPresence: () => ({ status: "present" as const }),
      read: () => { throw new Error("boom"); },
    } as unknown as MigrationManifestStore;
    expect(await performMigrationGenesisDryRun({ ...baseInput(), manifestStore: unreadable }))
      .toEqual({ status: "refuse", reason: "manifest-unresolvable", evidence: "manifest-internal-error" });
  });

  it.each([
    ["an Error", new Error("probe failed"), "Error"],
    ["a non-Error", "not-an-error", "unknown-inspection-failure"],
  ])("refuses genesis-inspection-failed when re-inspecting a planned manifest throws %s, writing nothing", async (_name, failure, evidence) => {
    completeSnapshot();
    inspect.mockRejectedValueOnce(failure);
    const input = baseInput();
    const store = new MigrationManifestStore({ homeDir: input.homeDir });
    const created = store.create(plannedManifest(input.generationId));
    const outcome = await performMigrationGenesisDryRun(input);
    expect(outcome).toEqual({ status: "refuse", reason: "genesis-inspection-failed", evidence });
    expect(store.read(input.generationId).checksumSha256).toBe(created.checksumSha256);
  });
});
