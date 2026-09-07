import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, openSync, renameSync, statSync } from "node:fs";
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
  type BackendPublicationLockToken,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { SQLiteLocalHookOutboxFactory } from "../../src/storage/local-hook-outbox.js";
import {
  assertMigrationReplayAdmission,
  prepareSqliteMigrationEnrollment,
  authenticateSqliteMigrationSource,
  authenticateSqliteMigrationSourceBytes,
  captureAuthenticatedSqliteMigrationSource,
  classifyImmutableSqliteSnapshot,
  inspectImmutableSqliteSnapshot,
  dryRunAuthenticatedSqliteMigrationSource,
  type SqliteMigrationEnrollmentInput,
} from "../../src/migration/maintenance.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import { writeFileSync } from "node:fs";
import { SqliteStorageBackendFactory } from "../../src/storage/sqlite/factory.js";
import * as identityApi from "../../src/machine-identity.js";
import * as publicationApi from "../../src/storage/backend-publication.js";
import * as identityService from "../../src/identity-service.js";
import { type IdentityRepository } from "../../src/identity-service.js";
import { clearProjectMapCache, projectMapPath } from "../../src/project-map.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import * as connectionApi from "../../src/db/connection.js";
import { appendLocalHookEvents } from "../../src/hooks/local-enqueue.js";
import { getMigrationReceiptEpoch } from "../../src/migration/receipts.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const MACHINE_ID = "018f0b5d-1234-4abc-8def-1234567890ab";
const roots: string[] = [];

afterEach(() => {
  closeLcmConnection();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearProjectMapCache();
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

const REGISTERED_MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";

function enrollmentFixture() {
  const homeDir = home();
  const cwd = join(homeDir, "project");
  mkdirSync(cwd, { mode: 0o700 });
  const local = localProjectIdentity(cwd, homeDir);
  const projectDir = join(homeDir, ".lcm", "projects", local.id);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(homeDir, ".lcm", "events"), { mode: 0o700 });
  const metadata = join(projectDir, "meta.json");
  writeFileSync(metadata, `${JSON.stringify({ cwd })}\n`, { mode: 0o600 });
  const request: SqliteMigrationEnrollmentInput = {
    cwd, homeDir, targetConfig: { backend: "postgresql", postgresql: {
      url: "postgresql://unused.invalid/lcm", caFile: "/unused", migrationRole: "unused",
      poolMax: 1, connectionTimeoutMs: 100, idleTimeoutMs: 100, statementTimeoutMs: 100,
    } },
  };
  const registered = () => {
    const pending = identityApi.readMachineIdentity(homeDir)!;
    return { machineId: REGISTERED_MACHINE, identityKey: pending.identityKey, displayName: pending.displayName };
  };
  const repository = {
    registerMachine: vi.fn(async () => registered()),
    recoverMachine: vi.fn(async () => registered()),
  };
  const close = vi.fn(async () => undefined);
  const openIdentitySession = vi.fn(async () => ({ repository: repository as unknown as IdentityRepository, close }));
  return { homeDir, cwd, local, projectDir, metadata, request, registered, repository, close, openIdentitySession };
}

async function populatedFixture(legacy = false) {
  const fixture = enrollmentFixture();
  const factory = new SQLiteLocalHookOutboxFactory();
  const outbox = await factory.open(join(fixture.homeDir, ".lcm", "events", `${fixture.local.id}.db`));
  if (legacy) await outbox.insertEvent("legacy", { type: "decision", category: "decision", data: "unknown legacy effect", priority: 1 }, "SessionStart");
  await prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession });
  if (!legacy) await outbox.insertEvent("pending", { type: "decision", category: "decision", data: "proven receipt-era pending", priority: 1 }, "SessionStart");
  await factory.close();
  return fixture;
}

async function heldSource(fixture: ReturnType<typeof enrollmentFixture>) {
  return withBackendPublicationAppendBarrierAsync(fixture.homeDir, async (token) => {
    const authority = authenticateSqliteMigrationSource(fixture.cwd, fixture.homeDir, token);
    const expectedSourceBytes = await authenticateSqliteMigrationSourceBytes(authority, { homeDir: fixture.homeDir, lockToken: token });
    const held = await coordinator(fixture.homeDir).enterMaintenance({
      ...input(), sourceSelectionSha256: authority.sourceSelectionSha256,
      queueEvidenceSha256: expectedSourceBytes.checksumSha256,
      roster: [{ machineId: REGISTERED_MACHINE, queueCutoff: "0000000000000000000", evidenceSha256: expectedSourceBytes.checksumSha256 }],
    }, token);
    return { authority, options: { homeDir: fixture.homeDir, generationId: held.generationId,
      maintenanceChecksumSha256: held.checksumSha256, expectedSourceBytes } };
  });
}

describe("backend publication maintenance journal v3", () => {
  it.each([false, true])("keeps the first public hook after empty enrollment durable across restart=%s", async (restart) => {
    const fixture = enrollmentFixture();
    vi.stubEnv("HOME", fixture.homeDir);
    expect(existsSync(join(fixture.homeDir, ".lcm", "config.json"))).toBe(false);
    const outboxPath = join(fixture.homeDir, ".lcm", "events", `${fixture.local.id}.db`);
    expect(existsSync(outboxPath)).toBe(false);
    await prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession });
    const source = await heldSource(fixture);
    await expect(appendLocalHookEvents({
      cwd: fixture.cwd, sessionId: "first-hook", sourceHook: "PostToolUse",
      events: [{ type: "decision", category: "decision", data: "first held event", priority: 1 }],
    })).resolves.toEqual({ inserted: 1, pendingCount: 1 });
    closeLcmConnection();
    const authority = restart ? await withBackendPublicationAppendBarrierAsync(fixture.homeDir, (token) =>
      authenticateSqliteMigrationSource(fixture.cwd, fixture.homeDir, token)) : source.authority;
    const snapshot = await captureAuthenticatedSqliteMigrationSource(authority, source.options);
    const page = JSON.parse(readFileSync(join(fixture.homeDir, ".lcm", "migration-evidence", "generation-1", snapshot.pages[0].name), "utf8"));
    expect(snapshot.receiptReference.queueCutoff).toBe("0000000000000000000");
    expect(page.records).toMatchObject([{ disposition: "retained" }]);
    expect(page.records).toHaveLength(1);
  });
  it.each(["populated", "empty"] as const)(
    "refuses %s enrolled capture when its canonical outbox was deleted",
    async (kind) => {
      const fixture = enrollmentFixture();
      vi.stubEnv("HOME", fixture.homeDir);
      await prepareSqliteMigrationEnrollment(
        fixture.request,
        { openIdentitySession: fixture.openIdentitySession },
      );
      if (kind === "populated") {
        await appendLocalHookEvents({
          cwd: fixture.cwd,
          sessionId: "deleted-outbox",
          sourceHook: "PostToolUse",
          events: [{
            type: "decision",
            category: "decision",
            data: "must not seal after source deletion",
            priority: 1,
          }],
        });
      }
      closeLcmConnection();
      const outboxPath = join(fixture.homeDir, ".lcm", "events", `${fixture.local.id}.db`);
      rmSync(outboxPath, { force: true });
      rmSync(`${outboxPath}-wal`, { force: true });
      rmSync(`${outboxPath}-shm`, { force: true });

      const source = await heldSource(fixture);
      expect(source.authority.passiveEventsDbPath).toBeNull();
      await expect(captureAuthenticatedSqliteMigrationSource(source.authority, source.options))
        .rejects.toThrow("enrolled canonical outbox is missing");
      expect(existsSync(join(
        fixture.homeDir,
        ".lcm",
        "migration-evidence",
        source.options.generationId,
        "witness.json",
      ))).toBe(false);
      expect(existsSync(outboxPath)).toBe(false);
    },
  );

  it("captures a present empty enrolled outbox", async () => {
    const fixture = enrollmentFixture();
    await prepareSqliteMigrationEnrollment(
      fixture.request,
      { openIdentitySession: fixture.openIdentitySession },
    );
    const source = await heldSource(fixture);
    expect(source.authority.passiveEventsDbPath).not.toBeNull();

    const snapshot = await captureAuthenticatedSqliteMigrationSource(source.authority, source.options);
    expect(snapshot.pages).toEqual([]);
    expect(snapshot.receiptReference.queueCutoff).toBeNull();
  });
  it.each(["openProject", "openExistingProject"] as const)("prepares first-hook durability in ordinary registered %s", async (operation) => {
    const fixture = enrollmentFixture();
    vi.stubEnv("HOME", fixture.homeDir);
    const factory = new SqliteStorageBackendFactory({ resolveProject: () => ({
      id: fixture.local.id, dbPath: join(fixture.projectDir, "db.sqlite"),
    }) });
    const projectIdentity = { id: fixture.local.id, canonical: fixture.cwd };
    if (operation === "openExistingProject") await (await factory.openProject(projectIdentity)).close();
    const pending = identityApi.ensurePendingMachineIdentity("already registered", fixture.homeDir);
    identityApi.finalizeMachineIdentity(pending.identity, REGISTERED_MACHINE, "already registered", fixture.homeDir);
    try { await (await factory[operation](projectIdentity))!.close(); }
    finally { await factory.close(); }
    const source = await heldSource(fixture);
    await expect(appendLocalHookEvents({ cwd: fixture.cwd, sessionId: "first", sourceHook: "PostToolUse",
      events: [{ type: "decision", category: "decision", data: "ordinary startup first hook", priority: 1 }],
    })).resolves.toEqual({ inserted: 1, pendingCount: 1 });
    const snapshot = await captureAuthenticatedSqliteMigrationSource(source.authority, source.options);
    expect(snapshot.receiptReference.firstMachineSequence).toBe("0000000000000000000");
    expect(snapshot.receiptReference.queueCutoff).toBe("0000000000000000000");
    expect(snapshot.pages[0].records).toBe(1);
  });
  it.each(["missing", "legacy"] as const)("rechecks queued %s outbox creation or migration after entering hold", async (kind) => {
    const fixture = enrollmentFixture();
    const path = join(fixture.homeDir, ".lcm", "events", `${fixture.local.id}.db`);
    if (kind === "legacy") {
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(1)");
      db.close();
    }
    const before = existsSync(path) ? readFileSync(path) : null;
    const factory = new SQLiteLocalHookOutboxFactory();
    let enterBarrier!: (token: BackendPublicationLockToken) => void;
    let releaseBarrier!: () => void;
    const entered = new Promise<BackendPublicationLockToken>(resolve => { enterBarrier = resolve; });
    const release = new Promise<void>(resolve => { releaseBarrier = resolve; });
    const holder = withBackendPublicationAppendBarrierAsync(fixture.homeDir, async (token) => {
      enterBarrier(token);
      await release;
    });
    const token = await entered;
    const queued = factory.open(path);
    try {
      // The open is invoked before the journal exists but must decide whether
      // creation or migration is permitted only after acquiring admission.
      await coordinator(fixture.homeDir).enterMaintenance(input(), token);
    } finally {
      releaseBarrier();
      await holder;
    }
    try { await expect(queued).rejects.toThrow(); }
    finally { await factory.close(); }
    expect(existsSync(path) ? readFileSync(path) : null).toEqual(before);
  });
  it.each(["open", "openExisting"] as const)("refuses %s during maintenance entry before connection initialization", async operation => {
    const fixture = await populatedFixture();
    const source = await heldSource(fixture);
    const journalPath = publicationApi.backendPublicationJournalPath(fixture.homeDir);
    const { checksumSha256: _checksum, ...body } = JSON.parse(readFileSync(journalPath, "utf8"));
    body.phase = "maintenance-entering";
    writeFileSync(journalPath, JSON.stringify({ ...body, checksumSha256: publicationApi.backendPublicationCanonicalSha256(body) }));
    const path = source.authority.passiveEventsDbPath!;
    const before = readFileSync(path);
    const opening = vi.spyOn(connectionApi, "getExistingLcmConnection");
    const factory = new SQLiteLocalHookOutboxFactory();
    try {
      await expect(factory[operation](path)).rejects.toThrow("not ready for local append");
      expect(opening).not.toHaveBeenCalled();
      expect(readFileSync(path)).toEqual(before);
    } finally { await factory.close(); }
  });
  it.each(["open", "openExisting"] as const)("defers actual %s connection initialization throughout capture", async (operation) => {
    const fixture = await populatedFixture();
    closeLcmConnection();
    const source = await heldSource(fixture);
    const outboxPath = source.authority.passiveEventsDbPath!;
    const paths = [source.authority.projectDbPath, outboxPath, source.authority.machineSequenceDbPath]
      .flatMap((path) => [path, `${path}-wal`, `${path}-shm`]);
    const evidence = () => paths.map((path) => existsSync(path)
      ? { path, bytes: readFileSync(path), mode: statSync(path).mode } : { path, absent: true });
    let reached!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let once = false;
    const capture = captureAuthenticatedSqliteMigrationSource(source.authority, { ...source.options, _operationsForTesting: {
      observe: async (boundary) => {
        if (!once && boundary === "before-private-inspection") { once = true; reached(); await gate; }
      },
    } });
    await paused;
    const before = evidence();
    const opening = vi.spyOn(connectionApi, "getExistingLcmConnection");
    const factory = new SQLiteLocalHookOutboxFactory();
    const open = factory[operation](outboxPath);
    try {
      await Promise.resolve();
      expect(opening).not.toHaveBeenCalled();
      expect(evidence()).toEqual(before);
    } finally {
      release();
      await Promise.allSettled([capture, open]);
      await factory.close();
    }
    const snapshot = await capture;
    expect(opening).toHaveBeenCalledWith(outboxPath, { tightenDatabaseParent: true,
      expectedFileIdentity: { device: expect.any(Number), inode: expect.any(Number) } });
    expect(snapshot.receiptReference.queueCutoff).toBe("0000000000000000000");
  });
  it.each([false, true])("captures legal held appends with fresh cutoff after restart=%s", async (restart) => {
    const fixture = await populatedFixture();
    const source = await heldSource(fixture);
    const factory = new SQLiteLocalHookOutboxFactory();
    const outbox = await factory.open(join(fixture.homeDir, ".lcm", "events", `${fixture.local.id}.db`));
    await outbox.insertEvent("later", { type: "decision", category: "decision", data: "held append", priority: 1 }, "SessionStart");
    await factory.close();
    const authority = restart ? await withBackendPublicationAppendBarrierAsync(fixture.homeDir, async (token) =>
      authenticateSqliteMigrationSource(fixture.cwd, fixture.homeDir, token)) : source.authority;
    const snapshot = await captureAuthenticatedSqliteMigrationSource(authority, source.options);
    expect(snapshot.receiptReference.queueCutoff).toBe("0000000000000000001");
    expect(snapshot.artifact.maintenanceChecksumSha256).toBe(publicationApi.readBackendMaintenanceJournal(fixture.homeDir)!.checksumSha256);
    const page = JSON.parse(readFileSync(join(fixture.homeDir, ".lcm", "migration-evidence", "generation-1", snapshot.pages[0].name), "utf8"));
    expect(page.records).toHaveLength(2);
    expect(page.records.every((row: { disposition: string }) => row.disposition === "retained")).toBe(true);
  });
  it("serializes a concurrent public append behind the complete cutoff-copy interval", async () => {
    const fixture = await populatedFixture();
    const source = await heldSource(fixture);
    const factory = new SQLiteLocalHookOutboxFactory();
    const outbox = await factory.open(source.authority.passiveEventsDbPath!);
    let reached!: () => void; let release!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let once = false;
    const capture = captureAuthenticatedSqliteMigrationSource(source.authority, { ...source.options, _operationsForTesting: {
      observe: async (boundary) => {
        if (!once && boundary === "before-private-inspection") { once = true; reached(); await gate; }
      },
    } });
    await paused;
    let appended = false;
    const append = outbox.insertEvent("concurrent", { type: "decision", category: "decision", data: "after seal", priority: 1 }, "SessionStart")
      .then(() => { appended = true; });
    await Promise.resolve();
    expect(appended).toBe(false);
    release();
    const snapshot = await capture;
    await append;
    expect(snapshot.receiptReference.queueCutoff).toBe("0000000000000000000");
    expect(snapshot.pages[0].records).toBe(1);
    expect((await outbox.getHealthStats()).unprocessed).toBe(2);
    await factory.close();
  });
  it("recovers a refreshed held binding after failure before generation intent", async () => {
    const fixture = await populatedFixture(); const source = await heldSource(fixture);
    const factory = new SQLiteLocalHookOutboxFactory(); const outbox = await factory.open(source.authority.passiveEventsDbPath!);
    await outbox.insertEvent("later", { type: "decision", category: "decision", data: "before failed capture", priority: 1 }, "SessionStart");
    await factory.close();
    await expect(captureAuthenticatedSqliteMigrationSource(source.authority, { ...source.options, _operationsForTesting: {
      open: (path, flags, mode) => {
        if (path.endsWith("generation-1.intent.json")) throw new Error("injected before intent");
        return mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
      },
    } })).rejects.toThrow();
    const durable = publicationApi.readBackendMaintenanceJournal(fixture.homeDir)!;
    expect(durable.checksumSha256).not.toBe(source.options.maintenanceChecksumSha256);
    expect(await classifyImmutableSqliteSnapshot("generation-1", fixture.homeDir)).toEqual({ state: "absent" });
    await expect(captureAuthenticatedSqliteMigrationSource(source.authority, source.options)).rejects.toThrow("authority changed");
    const lateFactory = new SQLiteLocalHookOutboxFactory(); const lateOutbox = await lateFactory.open(source.authority.passiveEventsDbPath!);
    await lateOutbox.insertEvent("after-crash", { type: "decision", category: "decision", data: "another legal append", priority: 1 }, "SessionStart");
    await lateFactory.close();
    const restart = await withBackendPublicationAppendBarrierAsync(fixture.homeDir, async (token) => {
      const authority = authenticateSqliteMigrationSource(fixture.cwd, fixture.homeDir, token);
      const expectedSourceBytes = await authenticateSqliteMigrationSourceBytes(authority, { homeDir: fixture.homeDir, lockToken: token });
      return { authority, expectedSourceBytes };
    });
    const snapshot = await captureAuthenticatedSqliteMigrationSource(restart.authority, { ...source.options,
      expectedSourceBytes: restart.expectedSourceBytes, maintenanceChecksumSha256: durable.checksumSha256 });
    expect(snapshot.receiptReference.queueCutoff).toBe("0000000000000000002");
  });
  it.each(["partial", "replaced", "tampered", "complete"])("never rebinds %s generation after legal append", async (kind) => {
    const fixture = await populatedFixture(); const source = await heldSource(fixture);
    const generation = join(fixture.homeDir, ".lcm", "migration-snapshots", "generations", "generation-1");
    let complete: Awaited<ReturnType<typeof captureAuthenticatedSqliteMigrationSource>> | undefined;
    if (kind === "partial") {
      await expect(captureAuthenticatedSqliteMigrationSource(source.authority, { ...source.options, _operationsForTesting: {
        observe: (boundary) => { if (boundary === "before-witness") throw new Error("crash before seal"); },
      } })).rejects.toThrow();
    } else {
      complete = await captureAuthenticatedSqliteMigrationSource(source.authority, source.options);
      if (kind === "replaced") { renameSync(generation, `${generation}.saved`); mkdirSync(generation, { mode: 0o700 }); }
      if (kind === "tampered") writeFileSync(join(generation, "witness.committed"), "tampered");
    }
    const before = readFileSync(publicationApi.backendPublicationJournalPath(fixture.homeDir));
    const factory = new SQLiteLocalHookOutboxFactory(); const outbox = await factory.open(source.authority.passiveEventsDbPath!);
    await outbox.insertEvent("later", { type: "decision", category: "decision", data: "after attempt", priority: 1 }, "SessionStart");
    await factory.close();
    const retry = captureAuthenticatedSqliteMigrationSource(source.authority, source.options);
    if (kind === "complete") await expect(retry).resolves.toEqual(complete);
    else await expect(retry).rejects.toMatchObject({ reason: `snapshot-${kind}` });
    expect(readFileSync(publicationApi.backendPublicationJournalPath(fixture.homeDir))).toEqual(before);
  });
  it("refuses a generation that appears during private cutoff sampling", async () => {
    const fixture = await populatedFixture(); const source = await heldSource(fixture);
    const before = readFileSync(publicationApi.backendPublicationJournalPath(fixture.homeDir));
    let appeared = false;
    await expect(captureAuthenticatedSqliteMigrationSource(source.authority, { ...source.options, _operationsForTesting: {
      observe: (boundary, _path, role) => {
        if (!appeared && boundary === "after-private-inspection" && role === "machine-sequence") {
          appeared = true;
          mkdirSync(join(fixture.homeDir, ".lcm", "migration-snapshots", "generations", "generation-1"), { mode: 0o700 });
        }
      },
    } })).rejects.toThrow("generation appeared");
    expect(readFileSync(publicationApi.backendPublicationJournalPath(fixture.homeDir))).toEqual(before);
  });
  it.each(["source", "roster", "generation"])("refuses changed capture %s authority without rebinding", async (kind) => {
    const fixture = await populatedFixture(); const source = await heldSource(fixture);
    const path = publicationApi.backendPublicationJournalPath(fixture.homeDir);
    const { checksumSha256: _checksum, ...journal } = JSON.parse(readFileSync(path, "utf8"));
    if (kind === "source") journal.sourceSelectionSha256 = HASH_A;
    if (kind === "roster") journal.roster[0].machineId = MACHINE_ID;
    const checksum = publicationApi.backendPublicationCanonicalSha256(journal);
    writeFileSync(path, JSON.stringify({ ...journal, checksumSha256: checksum }));
    const before = readFileSync(path);
    await expect(captureAuthenticatedSqliteMigrationSource(source.authority, { ...source.options,
      generationId: kind === "generation" ? "different" : source.options.generationId, maintenanceChecksumSha256: checksum,
    })).rejects.toThrow();
    expect(readFileSync(path)).toEqual(before);
  });
  it("captures and inspects a populated source through authenticated public preparation", async () => {
    const fixture = await populatedFixture();
    const dryRun = await dryRunAuthenticatedSqliteMigrationSource(fixture.cwd, fixture.homeDir);
    expect(dryRun).toBeDefined();
    const source = await heldSource(fixture);
    const snapshot = await captureAuthenticatedSqliteMigrationSource(source.authority, source.options);
    expect(snapshot.receiptReference.machineId).toBe(REGISTERED_MACHINE);
    expect(snapshot.pages).toHaveLength(1);
    const page = JSON.parse(readFileSync(join(fixture.homeDir, ".lcm", "migration-evidence", "generation-1", snapshot.pages[0].name), "utf8"));
    expect(page.records).toMatchObject([{ disposition: "retained" }]);
    expect(await inspectImmutableSqliteSnapshot("generation-1", fixture.homeDir)).toEqual(snapshot.artifact);
    expect(await classifyImmutableSqliteSnapshot("generation-1", fixture.homeDir)).toMatchObject({ state: "complete" });
  });

  it("refuses copied authority objects even when every field matches", async () => {
    const fixture = await populatedFixture();
    const source = await heldSource(fixture);
    const copy = { ...source.authority };
    await expect(captureAuthenticatedSqliteMigrationSource(copy, source.options)).rejects.toThrow("not authenticated");
    await withBackendPublicationAppendBarrierAsync(fixture.homeDir, async (lockToken) => {
      await expect(authenticateSqliteMigrationSourceBytes(copy, { homeDir: fixture.homeDir, lockToken })).rejects.toThrow("not authenticated");
    });
  });

  it("refuses authentication and enrollment when PostgreSQL is already configured", async () => {
    const fixture = enrollmentFixture();
    const caFile = join(fixture.homeDir, ".lcm", "ca.crt");
    writeFileSync(caFile, "test authority", { mode: 0o600 });
    writeFileSync(join(fixture.homeDir, ".lcm", "config.json"), JSON.stringify({ storage: { backend: "postgresql" } }), { mode: 0o600 });
    vi.stubEnv("LCM_POSTGRES_URL", "postgresql://user:password@db.example.invalid/lcm");
    vi.stubEnv("LCM_POSTGRES_CA_FILE", caFile);
    vi.stubEnv("LCM_POSTGRES_MIGRATION_ROLE", "lcm_test_migrator");
    expect(() => authenticateSqliteMigrationSource(fixture.cwd, fixture.homeDir)).toThrow("SQLite to remain selected");
    await expect(prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession })).rejects.toThrow("SQLite to remain selected");
    expect(fixture.openIdentitySession).not.toHaveBeenCalled();
    expect(identityApi.readMachineIdentity(fixture.homeDir)).toBeNull();
  });

  it("refuses configuration changes at physical seal without publishing queue evidence", async () => {
    const fixture = await populatedFixture();
    const source = await heldSource(fixture);
    await expect(captureAuthenticatedSqliteMigrationSource(source.authority, {
      ...source.options, _operationsForTesting: { observe: (boundary) => {
        if (boundary === "after-commit-marker") writeFileSync(join(fixture.homeDir, ".lcm", "config.json"), '{"storage":{"backend":"sqlite"}}\n', { mode: 0o600 });
      } },
    })).rejects.toThrow("authority changed");
    expect(existsSync(join(fixture.homeDir, ".lcm", "migration-evidence", "generation-1", "index.json"))).toBe(false);
  });

  it("refuses configuration drift during remote enrollment before identity finalization", async () => {
    const fixture = enrollmentFixture();
    fixture.repository.recoverMachine.mockImplementation(async () => {
      writeFileSync(join(fixture.homeDir, ".lcm", "config.json"), '{"storage":{"backend":"sqlite"}}\n', { mode: 0o600 });
      return fixture.registered();
    });
    await expect(prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession })).rejects.toThrow("selection changed during");
    expect(identityApi.readMachineIdentity(fixture.homeDir)?.machineId).toBeNull();
    expect(existsSync(join(fixture.projectDir, "db.sqlite"))).toBe(false);
  });

  it.each(["before-capture", "before-seal"])("refuses authority drift %s", async (when) => {
    const fixture = await populatedFixture();
    const source = await heldSource(fixture);
    const mutate = () => writeFileSync(fixture.metadata, `${JSON.stringify({ cwd: fixture.cwd, changed: true })}\n`);
    if (when === "before-capture") mutate();
    await expect(captureAuthenticatedSqliteMigrationSource(source.authority, {
      ...source.options, _operationsForTesting: { observe: (boundary) => {
        if (when === "before-seal" && boundary === "after-commit-marker") mutate();
      } },
    })).rejects.toThrow("authority changed");
    expect(existsSync(join(fixture.homeDir, ".lcm", "migration-evidence", "generation-1", "index.json"))).toBe(false);
  });

  it.each(["generation", "checksum", "terminal"])("refuses mismatched %s maintenance authority", async (change) => {
    const fixture = await populatedFixture();
    const source = await heldSource(fixture);
    if (change === "terminal") await coordinator(fixture.homeDir).abortMaintenance({
      expectedChecksumSha256: source.options.maintenanceChecksumSha256,
      sourceSelectionSha256: source.authority.sourceSelectionSha256, abortEvidenceSha256: HASH_B,
    });
    await expect(captureAuthenticatedSqliteMigrationSource(source.authority, {
      ...source.options,
      ...(change === "generation" ? { generationId: "other-generation" } : {}),
      ...(change === "checksum" ? { maintenanceChecksumSha256: HASH_A } : {}),
    })).rejects.toThrow("authority changed");
  });

  it("refuses unknown null-machine legacy input without deleting its evidence", async () => {
    const fixture = await populatedFixture(true);
    const source = await heldSource(fixture);
    await expect(captureAuthenticatedSqliteMigrationSource(source.authority, source.options)).rejects.toThrow();
    const db = new DatabaseSync(source.authority.passiveEventsDbPath!, { readOnly: true });
    expect(db.prepare("SELECT machine_id, processed_at, data FROM events").all()).toEqual([
      { machine_id: null, processed_at: null, data: "unknown legacy effect" },
    ]);
    db.close();
  });

  it("authenticates mapped project identities, aliases and absent outboxes", async () => {
    const fixture = enrollmentFixture();
    await prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession });
    // Historical inspection still represents an absent sidecar; preparation
    // now creates one for projects that will accept held hooks.
    closeLcmConnection();
    rmSync(join(fixture.homeDir, ".lcm", "events", `${fixture.local.id}.db`));
    writeFileSync(projectMapPath(fixture.homeDir), JSON.stringify({ [fixture.local.id]: {
      canonical: fixture.cwd, aliases: [fixture.cwd, join(fixture.homeDir, "alias")], remoteProjectId: REGISTERED_MACHINE,
    } }), { mode: 0o600 });
    const authority = authenticateSqliteMigrationSource(fixture.cwd, fixture.homeDir);
    expect(authority.projectIdentity).toEqual({ scope: "shared", projectId: REGISTERED_MACHINE });
    expect(authority.aliases).toEqual([join(fixture.homeDir, "alias")]);
    expect(authority.passiveEventsDbPath).toBeNull();
  });

  it("refuses replay with missing, wrong, held or tampered terminal evidence", async () => {
    const homeDir = home();
    const replay = { homeDir, generationId: "generation-1", evidenceSha256: HASH_B };
    expect(() => assertMigrationReplayAdmission(replay)).toThrow("terminal maintenance generation");
    const held = await coordinator(homeDir).enterMaintenance(input());
    expect(() => assertMigrationReplayAdmission({ ...replay, generationId: "wrong" })).toThrow("terminal maintenance generation");
    expect(() => assertMigrationReplayAdmission(replay)).toThrow("no authoritative terminal");
    await coordinator(homeDir).abortMaintenance({ expectedChecksumSha256: held.checksumSha256,
      sourceSelectionSha256: HASH_A, abortEvidenceSha256: HASH_B });
    expect(() => assertMigrationReplayAdmission({ ...replay, evidenceSha256: HASH_A })).toThrow("no authoritative terminal");
    expect(assertMigrationReplayAdmission(replay)).toEqual({ backend: "sqlite", disposition: "source-abort" });
  });

  it.each(["machine", "identity-key"])("preserves pending identity when remote readback changes %s", async (change) => {
    const fixture = enrollmentFixture();
    fixture.repository.recoverMachine.mockImplementation(async () => ({ ...fixture.registered(),
      ...(change === "machine" ? { machineId: "118f0b5d-1234-7abc-8def-1234567890ab" } : { identityKey: `machine:${"e".repeat(64)}` }),
    }));
    await expect(prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession })).rejects.toThrow("readback");
    expect(identityApi.readMachineIdentity(fixture.homeDir)?.machineId).toBeNull();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(existsSync(join(fixture.projectDir, "db.sqlite"))).toBe(false);
  });

  it("preserves remote registration failure over session close failure", async () => {
    const fixture = enrollmentFixture();
    fixture.repository.registerMachine.mockRejectedValueOnce(new Error("registration unavailable"));
    fixture.close.mockRejectedValueOnce(new Error("close failed"));
    await expect(prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession })).rejects.toThrow("registration unavailable");
    expect(identityApi.readMachineIdentity(fixture.homeDir)?.machineId).toBeNull();
  });

  it("rejects source selection drift before finalizing remote registration", async () => {
    const fixture = enrollmentFixture();
    fixture.repository.recoverMachine.mockImplementation(async () => {
      writeFileSync(fixture.metadata, `${JSON.stringify({ cwd: fixture.cwd, changed: true })}\n`);
      return fixture.registered();
    });
    await expect(prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession })).rejects.toThrow("selection changed during");
    expect(identityApi.readMachineIdentity(fixture.homeDir)?.machineId).toBeNull();
  });

  it("uses the native session entry point and supports platforms without getuid", async () => {
    const fixture = enrollmentFixture();
    vi.spyOn(identityService, "openPostgreSqlIdentitySession").mockImplementation(fixture.openIdentitySession);
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try {
      const result = await prepareSqliteMigrationEnrollment({ ...fixture.request, displayName: "explicit name" });
      expect(result.identity.machineId).toBe(REGISTERED_MACHINE);
      // Metadata without a cwd is not an authoritative project-map participant.
      writeFileSync(fixture.metadata, "{}\n");
      const authority = authenticateSqliteMigrationSource(fixture.cwd, fixture.homeDir);
      expect(authority.canonicalPath).toBe(fixture.cwd);
      expect(authority.aliases).toEqual([]);
    } finally {
      if (descriptor) Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("rechecks source selection after waiting for finalization admission", async () => {
    const fixture = enrollmentFixture();
    const original = publicationApi.withBackendPublicationAppendBarrierAsync;
    vi.spyOn(publicationApi, "withBackendPublicationAppendBarrierAsync").mockImplementationOnce(async (...args) => {
      writeFileSync(fixture.metadata, `${JSON.stringify({ cwd: fixture.cwd, changed: true })}\n`);
      return original(...args);
    });
    await expect(prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession })).rejects.toThrow("before finalization");
    expect(identityApi.readMachineIdentity(fixture.homeDir)?.machineId).toBeNull();
  });

  it.each(["selection", "identity"])("refuses %s drift between epoch adoption and identity publication", async (change) => {
    const fixture = enrollmentFixture();
    const originalOpen = SqliteStorageBackendFactory.prototype.openProject;
    vi.spyOn(SqliteStorageBackendFactory.prototype, "openProject").mockImplementationOnce(async function (...args) {
      const project = await originalOpen.apply(this, args);
      if (change === "selection") writeFileSync(fixture.metadata, `${JSON.stringify({ cwd: fixture.cwd, changed: true })}\n`);
      else writeFileSync(join(fixture.homeDir, ".lcm", "machine.json"), JSON.stringify({
        ...identityApi.readMachineIdentity(fixture.homeDir),
        machineId: "118f0b5d-1234-7abc-8def-1234567890ab",
      }));
      return project;
    });
    await expect(prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession })).rejects.toThrow(
      change === "selection" ? "before identity publication" : "before receipt adoption",
    );
    expect(existsSync(join(fixture.projectDir, "db.sqlite"))).toBe(true);
  });

  it("recovers an uncertain local finalization from authoritative readback without changing provenance", async () => {
    const fixture = enrollmentFixture();
    const originalFinalize = identityApi.finalizeMachineIdentity;
    vi.spyOn(identityApi, "finalizeMachineIdentity").mockImplementationOnce((...args) => {
      originalFinalize(...args);
      throw new identityApi.MachineIdentityRegistrationChangedError();
    });
    fixture.close.mockRejectedValue(new Error("close unavailable"));
    const result = await prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession });
    expect(result.identity).toMatchObject({ machineId: REGISTERED_MACHINE, identityKey: fixture.registered().identityKey });
    expect(fixture.repository.recoverMachine).toHaveBeenCalledTimes(2);
    expect(fixture.close).toHaveBeenCalledTimes(2);
    const db = new DatabaseSync(join(fixture.projectDir, "db.sqlite"), { readOnly: true });
    expect(db.prepare("SELECT machine_id FROM migration_receipt_v1_epochs").get()).toEqual({ machine_id: REGISTERED_MACHINE });
    db.close();
  });

  it("recovers a pending same-key identity after an uncertain finalization", async () => {
    const fixture = enrollmentFixture();
    vi.spyOn(identityApi, "finalizeMachineIdentity").mockImplementationOnce(() => { throw new identityApi.MachineIdentityRegistrationChangedError(); });
    const result = await prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession });
    expect(result.identity.machineId).toBe(REGISTERED_MACHINE);
  });

  it.each(["remote-machine", "remote-key", "local-machine", "local-key", "missing-local", "selection"])("preserves conflicting %s evidence during uncertain-finalization recovery", async (change) => {
    const fixture = enrollmentFixture();
    vi.spyOn(identityApi, "finalizeMachineIdentity").mockImplementationOnce(() => { throw new identityApi.MachineIdentityRegistrationChangedError(); });
    fixture.repository.recoverMachine.mockImplementationOnce(async () => fixture.registered())
      .mockImplementationOnce(async () => {
        const registered = fixture.registered();
        if (change === "remote-machine") return { ...registered, machineId: "118f0b5d-1234-7abc-8def-1234567890ab" };
        if (change === "remote-key") return { ...registered, identityKey: `machine:${"e".repeat(64)}` };
        if (change === "selection") writeFileSync(fixture.metadata, `${JSON.stringify({ cwd: fixture.cwd, changed: true })}\n`);
        if (change === "missing-local") rmSync(join(fixture.homeDir, ".lcm", "machine.json"));
        if (change === "local-machine" || change === "local-key") writeFileSync(join(fixture.homeDir, ".lcm", "machine.json"), JSON.stringify({
          version: 1, ...registered,
          ...(change === "local-machine" ? { machineId: "118f0b5d-1234-7abc-8def-1234567890ab" } : { identityKey: `machine:${"e".repeat(64)}` }),
        }));
        return registered;
      });
    await expect(prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession })).rejects.toThrow(change === "selection" ? "before recovery" : "identity changed");
    const db = new DatabaseSync(join(fixture.projectDir, "db.sqlite"), { readOnly: true });
    expect(getMigrationReceiptEpoch(db, fixture.local.id, REGISTERED_MACHINE))
      .toMatchObject({ machineId: REGISTERED_MACHINE, firstMachineSequence: "0000000000000000000" });
    db.close();
    expect(fixture.close).toHaveBeenCalledTimes(2);
  });

  it("keeps identity pending when SQLite preparation fails before epoch adoption", async () => {
    const fixture = enrollmentFixture();
    vi.stubEnv("HOME", fixture.homeDir);
    const dbPath = join(fixture.projectDir, "db.sqlite");
    const blocker = new DatabaseSync(dbPath);
    blocker.exec("BEGIN EXCLUSIVE");
    try {
      await expect(prepareSqliteMigrationEnrollment(
        fixture.request,
        { openIdentitySession: fixture.openIdentitySession },
      )).rejects.toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED" });
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    expect(identityApi.readMachineIdentity(fixture.homeDir)?.machineId).toBeNull();

    await appendLocalHookEvents({
      cwd: fixture.cwd,
      sessionId: "pending-after-failure",
      sourceHook: "SessionStart",
      events: [{ type: "decision", category: "decision", data: "unregistered", priority: 1 }],
    });
    const outbox = new DatabaseSync(join(fixture.homeDir, ".lcm", "events", `${fixture.local.id}.db`), { readOnly: true });
    expect(outbox.prepare("SELECT machine_id, machine_sequence FROM events").all()).toEqual([{
      machine_id: null,
      machine_sequence: "0000000000000000000",
    }]);
    outbox.close();

    await expect(prepareSqliteMigrationEnrollment(
      fixture.request,
      { openIdentitySession: fixture.openIdentitySession },
    )).resolves.toMatchObject({ identity: { machineId: REGISTERED_MACHINE } });
    const project = new DatabaseSync(dbPath, { readOnly: true });
    expect(getMigrationReceiptEpoch(project, fixture.local.id, REGISTERED_MACHINE))
      .toMatchObject({ firstMachineSequence: "0000000000000000001" });
    project.close();
    const source = await heldSource(fixture);
    await expect(captureAuthenticatedSqliteMigrationSource(source.authority, source.options))
      .rejects.toThrow("unknown identity");
  });

  it("preserves the committed epoch when identity publication fails and retries", async () => {
    const fixture = enrollmentFixture();
    vi.stubEnv("HOME", fixture.homeDir);
    vi.spyOn(identityApi, "finalizeMachineIdentity").mockImplementationOnce(() => {
      throw new Error("injected identity publication failure");
    });
    await expect(prepareSqliteMigrationEnrollment(
      fixture.request,
      { openIdentitySession: fixture.openIdentitySession },
    )).rejects.toThrow("identity publication failure");
    expect(identityApi.readMachineIdentity(fixture.homeDir)?.machineId).toBeNull();
    const dbPath = join(fixture.projectDir, "db.sqlite");
    let db = new DatabaseSync(dbPath, { readOnly: true });
    expect(getMigrationReceiptEpoch(db, fixture.local.id, REGISTERED_MACHINE))
      .toMatchObject({ firstMachineSequence: "0000000000000000000" });
    db.close();

    await appendLocalHookEvents({
      cwd: fixture.cwd,
      sessionId: "pending-after-epoch",
      sourceHook: "SessionStart",
      events: [{ type: "decision", category: "decision", data: "still unregistered", priority: 1 }],
    });
    await expect(prepareSqliteMigrationEnrollment(
      fixture.request,
      { openIdentitySession: fixture.openIdentitySession },
    )).resolves.toMatchObject({ identity: { machineId: REGISTERED_MACHINE } });
    db = new DatabaseSync(dbPath, { readOnly: true });
    expect(getMigrationReceiptEpoch(db, fixture.local.id, REGISTERED_MACHINE))
      .toMatchObject({ firstMachineSequence: "0000000000000000000" });
    db.close();
  });

  it("refuses a different remote machine after an epoch commits for a pending identity", async () => {
    const fixture = enrollmentFixture();
    vi.spyOn(identityApi, "finalizeMachineIdentity").mockImplementationOnce(() => {
      throw new Error("injected identity publication failure");
    });
    await expect(prepareSqliteMigrationEnrollment(
      fixture.request,
      { openIdentitySession: fixture.openIdentitySession },
    )).rejects.toThrow("identity publication failure");
    expect(identityApi.readMachineIdentity(fixture.homeDir)?.machineId).toBeNull();

    const conflictingMachine = "118f0b5d-1234-7abc-8def-1234567890ab";
    const pending = identityApi.readMachineIdentity(fixture.homeDir)!;
    const conflicting = {
      machineId: conflictingMachine,
      identityKey: pending.identityKey,
      displayName: pending.displayName,
    };
    fixture.repository.registerMachine.mockResolvedValue(conflicting);
    fixture.repository.recoverMachine.mockResolvedValue(conflicting);
    await expect(prepareSqliteMigrationEnrollment(
      fixture.request,
      { openIdentitySession: fixture.openIdentitySession },
    )).rejects.toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED" });

    const db = new DatabaseSync(join(fixture.projectDir, "db.sqlite"), { readOnly: true });
    expect(getMigrationReceiptEpoch(db, fixture.local.id, REGISTERED_MACHINE))
      .toMatchObject({ machineId: REGISTERED_MACHINE });
    expect(getMigrationReceiptEpoch(db, fixture.local.id, conflictingMachine)).toBeNull();
    db.close();
    expect(identityApi.readMachineIdentity(fixture.homeDir)?.machineId).toBeNull();
  });

  it("keeps finalized enrollment idempotent and refuses a different remote identity", async () => {
    const fixture = enrollmentFixture();
    const first = await prepareSqliteMigrationEnrollment(
      fixture.request,
      { openIdentitySession: fixture.openIdentitySession },
    );
    const dbPath = join(fixture.projectDir, "db.sqlite");
    let db = new DatabaseSync(dbPath, { readOnly: true });
    const epoch = getMigrationReceiptEpoch(db, fixture.local.id, REGISTERED_MACHINE);
    db.close();
    await expect(prepareSqliteMigrationEnrollment(
      fixture.request,
      { openIdentitySession: fixture.openIdentitySession },
    )).resolves.toMatchObject({ identity: first.identity });
    db = new DatabaseSync(dbPath, { readOnly: true });
    expect(getMigrationReceiptEpoch(db, fixture.local.id, REGISTERED_MACHINE)).toEqual(epoch);
    db.close();

    const conflictingMachine = "118f0b5d-1234-7abc-8def-1234567890ab";
    const conflicting = {
      machineId: conflictingMachine,
      identityKey: first.identity.identityKey,
      displayName: first.identity.displayName,
    };
    fixture.repository.registerMachine.mockResolvedValue(conflicting);
    fixture.repository.recoverMachine.mockResolvedValue(conflicting);
    await expect(prepareSqliteMigrationEnrollment(
      fixture.request,
      { openIdentitySession: fixture.openIdentitySession },
    )).rejects.toThrow("machine identity changed before receipt adoption");
    expect(identityApi.readMachineIdentity(fixture.homeDir)).toEqual(first.identity);
  });

  it("does not report enrollment completion when finalization never runs", async () => {
    const fixture = enrollmentFixture();
    vi.spyOn(publicationApi, "withBackendPublicationAppendBarrierAsync").mockResolvedValueOnce(undefined);
    await expect(prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession })).rejects.toThrow("did not complete");
    expect(identityApi.readMachineIdentity(fixture.homeDir)?.machineId).toBeNull();
  });
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
      recoverMachine: async () => {
        const { readMachineIdentity } = await import("../../src/machine-identity.js");
        const pending = readMachineIdentity(homeDir)!;
        return { machineId: "018f0b5d-1234-7abc-8def-1234567890ab", identityKey: pending.identityKey, displayName: pending.displayName };
      },
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
