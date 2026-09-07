import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackendPublicationCoordinator,
  BackendPublicationJournalError,
  assertBackendPublicationConsumerAccess,
  withBackendPublicationAppendBarrier,
  withBackendPublicationAppendBarrierAsync,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { SQLiteLocalHookOutboxFactory } from "../../src/storage/local-hook-outbox.js";
import {
  assertMigrationReplayAdmission,
  prepareSqliteMigrationEnrollment,
} from "../../src/migration/maintenance.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import { writeFileSync } from "node:fs";
import { SqliteStorageBackendFactory } from "../../src/storage/sqlite/factory.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const MACHINE_ID = "018f0b5d-1234-4abc-8def-1234567890ab";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-maintenance-v3-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

function coordinator(homeDir: string): BackendPublicationCoordinator {
  const unexpected = async (): Promise<never> => {
    throw new Error("v2 driver must not run for maintenance");
  };
  const driver: BackendPublicationDriver = {
    observeLocalState: unexpected,
    publishProjectMap: unexpected,
    publishConfig: unexpected,
    restoreConfig: unexpected,
    restoreProjectMap: unexpected,
  };
  return new BackendPublicationCoordinator({ homeDir, driver });
}

function input() {
  return {
    publicationId: "migration-generation-1",
    generationId: "generation-1",
    sourceSelectionSha256: HASH_A,
    queueEvidenceSha256: HASH_B,
    roster: [{
      machineId: MACHINE_ID,
      queueCutoff: "0000000000000000012",
      evidenceSha256: HASH_A,
    }],
    now: new Date("2026-09-07T03:04:05.000Z"),
  } as const;
}

describe("backend publication maintenance journal v3", () => {
  it("durably holds maintenance across coordinator restart", async () => {
    const homeDir = home();
    const entered = await coordinator(homeDir).enterMaintenance(input());

    expect(entered).toMatchObject({
      version: 3,
      phase: "maintenance-held",
      targetBackend: null,
      generationId: "generation-1",
      roster: input().roster,
    });
    expect(coordinator(homeDir).inspectMaintenance()).toEqual(entered);
  });

  it("does not let generic resume activate a held maintenance journal", async () => {
    const homeDir = home();
    await coordinator(homeDir).enterMaintenance(input());

    await expect(coordinator(homeDir).resume()).rejects.toMatchObject({
      reason: "unresolved-publication",
    });
    expect(coordinator(homeDir).inspectMaintenance().phase).toBe("maintenance-held");
  });

  it("requires checksum compare-and-swap and exact selected generation", async () => {
    const homeDir = home();
    const entered = await coordinator(homeDir).enterMaintenance(input());

    await expect(coordinator(homeDir).prepareMaintenanceSelection({
      expectedChecksumSha256: HASH_A,
      generationId: "generation-1",
      targetBackend: "postgresql",
      terminalEvidenceSha256: HASH_B,
    })).rejects.toMatchObject({ reason: "unexpected-state" });

    await expect(coordinator(homeDir).prepareMaintenanceSelection({
      expectedChecksumSha256: entered.checksumSha256,
      generationId: "wrong-generation",
      targetBackend: "postgresql",
      terminalEvidenceSha256: HASH_B,
    })).rejects.toMatchObject({ reason: "unexpected-state" });

    const prepared = await coordinator(homeDir).prepareMaintenanceSelection({
      expectedChecksumSha256: entered.checksumSha256,
      generationId: "generation-1",
      targetBackend: "postgresql",
      terminalEvidenceSha256: HASH_B,
    });
    expect(prepared).toMatchObject({
      phase: "selection-prepared",
      selectedGenerationId: "generation-1",
      targetBackend: "postgresql",
      terminalEvidenceSha256: HASH_B,
    });
    expect(() => assertBackendPublicationConsumerAccess({ homeDir, backend: "postgresql" }))
      .toThrowError(BackendPublicationJournalError);
    const completed = await coordinator(homeDir).completeMaintenanceSelection({
      expectedChecksumSha256: prepared.checksumSha256,
      generationId: "generation-1",
      terminalEvidenceSha256: HASH_B,
    });
    expect(completed.phase).toBe("selection-completed");
    expect(assertMigrationReplayAdmission({
      homeDir,
      generationId: "generation-1",
      evidenceSha256: HASH_B,
    })).toEqual({ backend: "postgresql", disposition: "selected" });
    expect(() => assertBackendPublicationConsumerAccess({ homeDir, backend: "postgresql" })).not.toThrow();
  });

  it("aborts only from held maintenance with preserved source evidence", async () => {
    const homeDir = home();
    const entered = await coordinator(homeDir).enterMaintenance(input());
    const aborted = await coordinator(homeDir).abortMaintenance({
      expectedChecksumSha256: entered.checksumSha256,
      sourceSelectionSha256: HASH_A,
      abortEvidenceSha256: HASH_B,
    });

    expect(aborted).toMatchObject({
      phase: "maintenance-aborted",
      selectedGenerationId: null,
      abortEvidenceSha256: HASH_B,
    });
    expect(() => coordinator(homeDir).inspectMaintenance()).not.toThrow();
    expect(() => assertBackendPublicationConsumerAccess({ homeDir, backend: "sqlite" })).not.toThrow();
  });

  it("admits only local append while maintenance is held", async () => {
    const homeDir = home();
    const entered = await coordinator(homeDir).enterMaintenance(input());

    expect(() => assertBackendPublicationConsumerAccess({ homeDir, backend: "sqlite" }))
      .toThrowError(BackendPublicationJournalError);
    expect(withBackendPublicationAppendBarrier(homeDir, () => "appended")).toBe("appended");

    await coordinator(homeDir).prepareMaintenanceSelection({
      expectedChecksumSha256: entered.checksumSha256,
      generationId: entered.generationId,
      targetBackend: "postgresql",
      terminalEvidenceSha256: HASH_B,
    });
    expect(withBackendPublicationAppendBarrier(homeDir, () => "retained")).toBe("retained");
  });

  it("enters held maintenance reentrantly before releasing the cutoff barrier", async () => {
    const homeDir = home();
    const entered = await withBackendPublicationAppendBarrierAsync(
      homeDir,
      async (token) => coordinator(homeDir).enterMaintenance(input(), token),
    );
    expect(entered.phase).toBe("maintenance-held");
    expect(coordinator(homeDir).inspectMaintenance()).toEqual(entered);
  });

  it("fences destructive operations on a retained outbox while append remains available", async () => {
    const homeDir = home();
    const eventsDir = join(homeDir, ".lcm", "events");
    mkdirSync(eventsDir, { mode: 0o700 });
    const dbPath = join(eventsDir, `${"1".repeat(64)}.db`);
    const factory = new SQLiteLocalHookOutboxFactory();
    const outbox = await factory.open(dbPath);
    const oldId = await outbox.insertEvent("session", {
      type: "decision",
      category: "decision",
      data: "retained",
      priority: 1,
    }, "SessionStart");
    await outbox.markProcessed([oldId]);
    const fixture = new DatabaseSync(dbPath);
    fixture.prepare(`
      UPDATE events
      SET delivery_state = 'acknowledged', remote_inbox_id = '1',
          acknowledged_at = datetime('now'), remote_pruned_at = datetime('now'),
          processed_at = datetime('now', '-40 days')
      WHERE event_id = ?
    `).run(oldId);
    fixture.close();

    await coordinator(homeDir).enterMaintenance(input());
    await expect(outbox.pruneProcessed(30)).rejects.toMatchObject({
      reason: "unresolved-publication",
    });
    await expect(outbox.markProcessed([oldId])).rejects.toMatchObject({
      reason: "unresolved-publication",
    });
    expect(await outbox.insertEvent("session", {
      type: "file",
      category: "file",
      data: "post-cutoff",
      priority: 3,
    }, "PostToolUse")).toBeGreaterThan(oldId);

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    expect((verify.prepare("SELECT count(*) AS count FROM events").get() as { count: number }).count).toBe(2);
    verify.close();
    await factory.close();
  });

  it("does not migrate or create an outbox after maintenance is held", async () => {
    const homeDir = home();
    const eventsDir = join(homeDir, ".lcm", "events");
    mkdirSync(eventsDir, { mode: 0o700 });
    const stalePath = join(eventsDir, `${"2".repeat(64)}.db`);
    const stale = new DatabaseSync(stalePath);
    stale.exec("CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(4)");
    stale.close();
    await coordinator(homeDir).enterMaintenance(input());

    const factory = new SQLiteLocalHookOutboxFactory();
    await expect(factory.open(stalePath)).rejects.toThrow();
    await expect(factory.open(join(eventsDir, `${"3".repeat(64)}.db`))).rejects.toThrow();
    const verify = new DatabaseSync(stalePath, { readOnly: true });
    expect(verify.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 4 });
    verify.close();
    await factory.close();
  });

  it("refuses malformed, duplicate, and noncanonical roster input", async () => {
    const homeDir = home();
    await expect(coordinator(homeDir).enterMaintenance({
      ...input(),
      roster: [input().roster[0], input().roster[0]],
    })).rejects.toBeInstanceOf(BackendPublicationJournalError);
    expect(coordinator(homeDir).inspectMaintenance()).toBeNull();
  });

  it("registers a migration machine remotely before adopting its local receipt epoch", async () => {
    const homeDir = home();
    const cwd = join(homeDir, "project");
    mkdirSync(cwd, { mode: 0o700 });
    const identity = localProjectIdentity(cwd, homeDir);
    const projectDir = join(homeDir, ".lcm", "projects", identity.id);
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    const eventsDir = join(homeDir, ".lcm", "events");
    mkdirSync(eventsDir, { mode: 0o700 });
    writeFileSync(join(projectDir, "meta.json"), `${JSON.stringify({ cwd })}\n`, { mode: 0o600 });
    const outboxFactory = new SQLiteLocalHookOutboxFactory();
    const outboxPath = join(eventsDir, `${identity.id}.db`);
    const outbox = await outboxFactory.open(outboxPath);
    const repository = {
      registerMachine: async (identityKey: string, displayName: string) => ({
        machineId: "018f0b5d-1234-7abc-8def-1234567890ab",
        identityKey,
        displayName,
      }),
      recoverMachine: async () => { throw new Error("unexpected recovery"); },
    };
    const originalOpen = SqliteStorageBackendFactory.prototype.openProject;
    let releaseAdoption!: () => void;
    let adoptionEntered!: () => void;
    const adoptionGate = new Promise<void>((resolve) => { releaseAdoption = resolve; });
    const adoptionEnteredPromise = new Promise<void>((resolve) => { adoptionEntered = resolve; });
    const openSpy = vi.spyOn(SqliteStorageBackendFactory.prototype, "openProject")
      .mockImplementationOnce(async function (this: SqliteStorageBackendFactory, ...args) {
        adoptionEntered();
        await adoptionGate;
        return originalOpen.apply(this, args);
      });
    const enrollment = prepareSqliteMigrationEnrollment({
      cwd,
      homeDir,
      targetConfig: {
        backend: "postgresql",
        postgresql: {
          url: "postgresql://example.invalid/lcm",
          poolMax: 1,
          connectionTimeoutMs: 100,
          idleTimeoutMs: 100,
          statementTimeoutMs: 100,
        },
      },
    }, {
      openIdentitySession: async () => ({ repository: repository as never, close: async () => undefined }),
    });
    await adoptionEnteredPromise;
    let appendSettled = false;
    const append = outbox.insertEvent("queued", {
      type: "decision",
      category: "decision",
      data: "queued during enrollment",
      priority: 1,
    }, "SessionStart").finally(() => { appendSettled = true; });
    await Promise.resolve();
    expect(appendSettled).toBe(false);
    releaseAdoption();
    const result = await enrollment;
    await append;
    openSpy.mockRestore();

    expect(result.identity.machineId).toBe("018f0b5d-1234-7abc-8def-1234567890ab");
    const projectDb = new DatabaseSync(join(projectDir, "db.sqlite"), { readOnly: true });
    expect(projectDb.prepare(
      "SELECT first_machine_sequence FROM migration_receipt_v1_epochs",
    ).get()).toEqual({ first_machine_sequence: "0000000000000000000" });
    projectDb.close();
    const eventsDb = new DatabaseSync(outboxPath, { readOnly: true });
    expect(eventsDb.prepare("SELECT machine_id, machine_sequence FROM events").get()).toEqual({
      machine_id: "018f0b5d-1234-7abc-8def-1234567890ab",
      machine_sequence: "0000000000000000000",
    });
    eventsDb.close();
    await outboxFactory.close();
  });
});
