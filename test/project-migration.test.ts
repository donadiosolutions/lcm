import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configPath, lcmHomeDir, projectsDir } from "../src/runtime-paths.js";
import { clearProjectMapCache, hashProjectPath, projectMapPath, readProjectMapSnapshot } from "../src/project-map.js";
import { machineIdentityPath } from "../src/machine-identity.js";
import { loadPostgreSqlMigrations } from "../src/storage/postgresql/migrations.js";
import { PostgreSqlWorkCoordinator } from "../src/storage/postgresql/coordination.js";
import {
  PostgreSqlMigrationAdapter,
  type PostgreSqlMigrationRuntime,
  type PostgreSqlMigrationIdentity,
} from "../src/storage/postgresql/migration-adapter.js";
import type {
  PostgreSqlOperationContext,
  PostgreSqlQueryOptions,
  PostgreSqlTransactionScopeExecutor,
} from "../src/storage/postgresql/contracts.js";
import type { StorageBackendFactory } from "../src/storage/contracts.js";
import {
  PROJECT_MIGRATION_TEST_SEAMS,
  activateProjectMigration,
  applyProjectMigration,
  dryRunProjectMigration,
  listProjectMigrationReports,
  planProjectMigration,
  reportProjectMigration,
  resumeProjectMigration,
  rollbackProjectMigration,
  verifyProjectMigration,
  type MigrationCrashPoint,
  type ProjectMigrationDependencies,
  type ProjectMigrationOptions,
} from "../src/storage/project-migration.js";
import {
  migrationProjectPaths,
  readMigrationManifest,
  readPublicationJournal,
  writeMigrationManifest,
  writePublicationJournal,
} from "../src/storage/migration-manifest.js";
import { SqliteMigrationReader, SqliteMigrationWriter, type MigrationRow } from "../src/storage/sqlite/migration-adapter.js";

const remoteProjectId = "018f1234-5678-7abc-8def-0123456789ab";
const machineId = "018f1234-5678-7abc-8def-0123456789ac";
const now = "2026-08-01T12:00:00.000Z";
const roots: string[] = [];

function queryResult<R extends QueryResultRow>(rows: R[], command = "SELECT"): QueryResult<R> {
  return { rows, rowCount: rows.length, command, oid: 0, fields: [] };
}

type QueryInput = { readonly text: string; readonly values?: readonly unknown[] };

class MigrationRuntime {
  readonly physical = new Map<string, Map<string, QueryResultRow>>();
  readonly pending = new Map<string, string>();
  readonly close = vi.fn(async () => undefined);
  healthStatus: "healthy" | "unhealthy" = "healthy";
  transactionCalls = 0;
  failTransactionAt: number | null = null;
  uncertainTransactionsRemaining = 0;
  relationalViolations = "0";
  sampleMismatch = false;
  schema = loadPostgreSqlMigrations().map(({ id, sha256 }) => ({ migration_id: id, sha256 }));
  aliases: string[] = [];
  identityKey = "";

  private key(table: string, values: readonly unknown[] | undefined): string {
    return `${table}:${JSON.stringify(values ?? [])}`;
  }

  private tableRows(table: string): QueryResultRow[] {
    return [...(this.physical.get(table)?.values() ?? [])];
  }

  private project(config: QueryInput, options: PostgreSqlQueryOptions): QueryResultRow[] {
    if (options.operation === "migrationDestinationProject") return [{ identity_key: this.identityKey }];
    if (options.operation.startsWith("migrationDestinationCount:")) {
      const table = options.operation.split(":")[1]!;
      return [{ count: String(this.tableRows(table).length) }];
    }
    if (options.operation === "migrationVerifyAliases") return this.aliases.map((path) => ({ path }));
    if (options.operation === "migrationSchemaHistory") return this.schema;
    if (options.operation === "migrationResolveConversation") return [{ conversation_id: "1" }];
    if (options.operation === "migrationVerifyRelationalIntegrity") return [{ violations: this.relationalViolations }];
    if (options.operation.startsWith("migrationSidecar:")) return [];
    if (options.operation.startsWith("migrationReadBatch:")) {
      const table = options.operation.split(":")[1]!;
      const limit = Number(config.values?.at(-2));
      const offset = Number(config.values?.at(-1));
      const columns = /^SELECT (.+?) FROM /su.exec(config.text)?.[1]?.split(", ").map((column) => column.trim()) ?? [];
      return this.tableRows(table).slice(offset, offset + limit).map((row) => Object.fromEntries(columns.map((column) => [column, this.sampleMismatch && limit === 2 && column === "session_id" ? "mismatch" : row[column]])));
    }
    const table = options.operation.split(":")[1] ?? "";
    if (options.operation.startsWith("migrationReadExisting:")) {
      const key = this.key(table, config.values);
      this.pending.set(table, key);
      const row = this.physical.get(table)?.get(key);
      return row ? [row] : [];
    }
    if (options.operation.startsWith("migrationInsert:")) {
      const columns = /\(([^)]+)\) VALUES/u.exec(config.text)?.[1]?.split(", ") ?? [];
      const values = config.values ?? [];
      const row = Object.fromEntries(columns.map((column, index) => [column, column === "metadata" && typeof values[index] === "string" ? JSON.parse(values[index]) as unknown : values[index]]));
      const rows = this.physical.get(table) ?? new Map<string, QueryResultRow>();
      rows.set(this.pending.get(table)!, row);
      this.physical.set(table, rows);
      return [];
    }
    if (options.operation.startsWith("migrationReadInserted:") || options.operation.startsWith("migrationAuthoritativeReadback:")) {
      const row = this.physical.get(table)?.get(this.key(table, config.values));
      return row ? [row] : [];
    }
    return [];
  }

  asRuntime(): PostgreSqlMigrationRuntime & { health(): Promise<{ backend: "postgresql"; status: "healthy" | "unhealthy"; details: string }>; close(): Promise<void> } {
    const query = async <R extends QueryResultRow>(config: QueryConfig, options: PostgreSqlQueryOptions): Promise<QueryResult<R>> => queryResult(this.project(config as QueryInput, options) as R[]);
    const scope = {
      transactionScope: "active" as const,
      query,
      savepoint: async <T>(callback: (savepoint: PostgreSqlTransactionScopeExecutor) => Promise<T>): Promise<T> => callback(scope),
    } as unknown as PostgreSqlTransactionScopeExecutor;
    return {
      query,
      health: async () => ({ backend: "postgresql", status: this.healthStatus, details: this.healthStatus }),
      close: this.close,
      transaction: async <T>(callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>, _options: PostgreSqlOperationContext): Promise<T> => {
        this.transactionCalls += 1;
        if (this.failTransactionAt === this.transactionCalls) throw new Error("injected PostgreSQL transaction failure");
        const value = await callback(scope);
        if (this.uncertainTransactionsRemaining > 0) {
          this.uncertainTransactionsRemaining -= 1;
          throw new (await import("../src/storage/postgresql/errors.js")).PostgreSqlCommitOutcomeUnknownError(_options);
        }
        return value;
      },
    };
  }
}

interface Fixture {
  readonly home: string;
  readonly projectPath: string;
  readonly localProjectId: string;
  readonly databasePath: string;
  readonly caFile: string;
  readonly runtime: MigrationRuntime;
  readonly factory: StorageBackendFactory & { close: ReturnType<typeof vi.fn>; projectExists: ReturnType<typeof vi.fn> };
  readonly options: ProjectMigrationOptions;
}

function writePrivate(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function createSource(path: string, conversations: number): void {
  const writer = new SqliteMigrationWriter(path);
  const rows: MigrationRow[] = Array.from({ length: conversations }, (_unused, index) => ({
    conversation_id: index + 1,
    session_id: `session-${index + 1}`,
    title: index === 0 ? null : `title-${index + 1}`,
    bootstrapped_at: null,
    created_at: now,
    updated_at: now,
  }));
  writer.writeBatch("conversations", rows);
  writer.checkpointAndClose();
}

function fixture(conversations = 1): Fixture {
  const home = mkdtempSync(join(tmpdir(), "lcm-project-migration-"));
  roots.push(home);
  const lcHome = lcmHomeDir(home);
  mkdirSync(lcHome, { recursive: true, mode: 0o700 });
  const projectPath = join(home, "workspace", "project");
  mkdirSync(projectPath, { recursive: true, mode: 0o700 });
  const localProjectId = hashProjectPath(resolve(projectPath));
  const databasePath = join(projectsDir(home), localProjectId, "db.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  createSource(databasePath, conversations);
  writePrivate(projectMapPath(home), `${JSON.stringify({ [localProjectId]: { canonical: projectPath, aliases: [], remoteProjectId } }, null, 2)}\n`);
  writePrivate(machineIdentityPath(home), `${JSON.stringify({ version: 1, identityKey: `machine:${"d".repeat(64)}`, machineId, displayName: "migration-test" }, null, 2)}\n`);
  writePrivate(configPath(home), `${JSON.stringify({ storage: { backend: "sqlite" } }, null, 2)}\n`);
  const caFile = join(home, "postgres-ca.pem");
  writePrivate(caFile, "test-ca\n");
  clearProjectMapCache();
  const runtime = new MigrationRuntime();
  runtime.identityKey = localProjectId;
  runtime.aliases = [resolve(projectPath)];
  const factory = {
    capabilities: {} as never,
    health: vi.fn(async () => ({ backend: "postgresql" as const, status: "healthy" as const, details: "ready" })),
    projectExists: vi.fn(async () => true),
    openProject: vi.fn(async () => { throw new Error("not used by migration activation"); }),
    close: vi.fn(async () => undefined),
  } as unknown as Fixture["factory"];
  const dependencies: Partial<ProjectMigrationDependencies> = {
    now: () => new Date(now),
    createRuntime: () => runtime.asRuntime(),
    createFactory: () => factory,
    processAlive: () => false,
  };
  return {
    home,
    projectPath,
    localProjectId,
    databasePath,
    caFile,
    runtime,
    factory,
    options: {
      homeDir: home,
      env: { LCM_POSTGRES_URL: "postgresql://user:password@database.invalid/lcm", LCM_POSTGRES_CA_FILE: caFile },
      batchSize: 1,
      sampleSize: 2,
      _dependenciesForTesting: dependencies,
    },
  };
}

async function forwardToVerified(current: Fixture): Promise<string> {
  const planned = planProjectMigration(current.options);
  await dryRunProjectMigration(planned.generationId, current.options);
  await applyProjectMigration(planned.generationId, current.options);
  await verifyProjectMigration(planned.generationId, current.options);
  return planned.generationId;
}

async function forwardToActive(current: Fixture): Promise<string> {
  const generationId = await forwardToVerified(current);
  await activateProjectMigration(generationId, current.options);
  return generationId;
}

beforeEach(() => {
  vi.spyOn(PostgreSqlWorkCoordinator.prototype, "acquireLease").mockResolvedValue({ resourceType: "storage-migration", resourceKey: "generation", fencingToken: 7n } as never);
  vi.spyOn(PostgreSqlWorkCoordinator.prototype, "renewLease").mockResolvedValue({} as never);
  vi.spyOn(PostgreSqlWorkCoordinator.prototype, "releaseLease").mockResolvedValue(null);
  vi.spyOn(PostgreSqlWorkCoordinator.prototype, "assertLeaseFence").mockResolvedValue({} as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearProjectMapCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reversible project migration lifecycle", () => {
  it("runs plan, dry-run, apply, verify, global activation, and post-write rollback", async () => {
    const current = fixture();
    const sourceBytes = readFileSync(current.databasePath);
    const planned = planProjectMigration({ ...current.options, progress: vi.fn() });
    expect(planned).toMatchObject({ operation: "plan", status: "planned", ready: false, blockers: ["dry-run required before apply"] });
    await expect(applyProjectMigration(planned.generationId, current.options)).rejects.toThrow("apply requires a successful dry-run");
    await expect(dryRunProjectMigration(planned.generationId, current.options)).resolves.toMatchObject({ operation: "dry-run", status: "dry-run-verified" });
    await expect(applyProjectMigration(planned.generationId, current.options)).resolves.toMatchObject({ operation: "apply", status: "applied", blockers: ["verification required before activation"] });
    const privateArchive = migrationProjectPaths(planned.generationId, current.localProjectId, current.home).originalMainArchive;
    expect(readFileSync(privateArchive)).toEqual(sourceBytes);
    await expect(verifyProjectMigration(planned.generationId, current.options)).resolves.toMatchObject({ operation: "verify", status: "verified", ready: true });
    await expect(activateProjectMigration(planned.generationId, current.options)).resolves.toMatchObject({ operation: "activate", status: "active", ready: true });
    expect(JSON.parse(readFileSync(configPath(current.home), "utf8"))).toMatchObject({ storage: { backend: "postgresql" } });
    await expect(activateProjectMigration(planned.generationId, current.options)).resolves.toMatchObject({ status: "active", ready: true });
    expect(current.factory.close).toHaveBeenCalled();

    await expect(rollbackProjectMigration(planned.generationId, current.options)).resolves.toMatchObject({ operation: "rollback", status: "rolled-back", ready: true });
    await expect(rollbackProjectMigration(planned.generationId, current.options)).resolves.toMatchObject({ status: "rolled-back", ready: true });
    expect(JSON.parse(readFileSync(configPath(current.home), "utf8"))).toMatchObject({ storage: { backend: "sqlite" } });
    expect(readFileSync(`${current.databasePath}.preserved-${planned.generationId}`)).toEqual(sourceBytes);
    expect(readFileSync(privateArchive)).toEqual(sourceBytes);
    const reverse = new SqliteMigrationReader(current.databasePath);
    try { expect(reverse.readBatch("conversations", 0, 10)).toHaveLength(1); }
    finally { reverse.close(); }
    expect(readProjectMapSnapshot(current.home)[current.localProjectId]).toMatchObject({ canonical: current.projectPath, remoteProjectId });
    expect(reportProjectMigration(planned.generationId, current.options)).toMatchObject({ status: "rolled-back", ready: true });
    expect(listProjectMigrationReports(current.options)).toHaveLength(1);
  }, 15_000);

  it("resumes only an interrupted exact generation after a durable checkpoint", async () => {
    const current = fixture(2);
    const planned = planProjectMigration(current.options);
    await dryRunProjectMigration(planned.generationId, current.options);
    current.runtime.failTransactionAt = 2;
    await expect(applyProjectMigration(planned.generationId, current.options)).rejects.toThrow("injected PostgreSQL transaction failure");
    expect(readMigrationManifest(planned.generationId, current.home).projects[0]?.tables[0]?.copiedRows).toBe(1);
    current.runtime.failTransactionAt = null;
    await expect(resumeProjectMigration(planned.generationId, current.options)).resolves.toMatchObject({ operation: "resume", status: "applied" });
    await expect(resumeProjectMigration(planned.generationId, current.options)).rejects.toThrow("resume requires an interrupted compatible apply generation");
    await verifyProjectMigration(planned.generationId, current.options);
  });

  it("performs a pre-write rollback without changing source identity or bytes", async () => {
    const current = fixture();
    const bytes = readFileSync(current.databasePath);
    const planned = planProjectMigration(current.options);
    await expect(rollbackProjectMigration(planned.generationId, current.options)).resolves.toMatchObject({ status: "rolled-back", ready: true });
    await expect(rollbackProjectMigration(planned.generationId, current.options)).resolves.toMatchObject({ status: "rolled-back", ready: true });
    expect(readFileSync(current.databasePath)).toEqual(bytes);
    expect(readPublicationJournal(planned.generationId, current.home)).toMatchObject({ operation: "pre-write-rollback", phase: "completed" });
  });
});

describe("publication crash recovery", () => {
  it.each(["after-prepare", "after-commit-journal", "after-map", "after-config"] as const)("recovers activation from %s", async (point) => {
    const current = fixture();
    const generationId = await forwardToVerified(current);
    const crashing = { ...current.options, _dependenciesForTesting: { ...current.options._dependenciesForTesting, crash: (candidate: MigrationCrashPoint) => { if (candidate === point) throw new Error(`crash:${point}`); } } };
    await expect(activateProjectMigration(generationId, crashing)).rejects.toThrow(`crash:${point}`);
    await expect(activateProjectMigration(generationId, current.options)).resolves.toMatchObject({ status: "active" });
    expect(readPublicationJournal(generationId, current.home)?.phase).toBe("completed");
  });

  it.each(["after-prepare", "after-commit-journal"] as const)("recovers pre-write rollback from %s", async (point) => {
    const current = fixture();
    const generationId = planProjectMigration(current.options).generationId;
    const crashing = { ...current.options, _dependenciesForTesting: { ...current.options._dependenciesForTesting, crash: (candidate: MigrationCrashPoint) => { if (candidate === point) throw new Error(`crash:${point}`); } } };
    await expect(rollbackProjectMigration(generationId, crashing)).rejects.toThrow(`crash:${point}`);
    await expect(rollbackProjectMigration(generationId, current.options)).resolves.toMatchObject({ status: "rolled-back" });
  });

  it.each(["after-prepare", "after-commit-journal", "after-filesystem", "after-map", "after-config"] as const)("recovers post-write rollback from %s", async (point) => {
    const current = fixture();
    const generationId = await forwardToActive(current);
    const crashing = { ...current.options, _dependenciesForTesting: { ...current.options._dependenciesForTesting, crash: (candidate: MigrationCrashPoint) => { if (candidate === point) throw new Error(`crash:${point}`); } } };
    await expect(rollbackProjectMigration(generationId, crashing)).rejects.toThrow(`crash:${point}`);
    await expect(rollbackProjectMigration(generationId, current.options)).resolves.toMatchObject({ status: "rolled-back" });
    expect(readPublicationJournal(generationId, current.home)?.phase).toBe("completed");
  });
});

describe("migration safety helpers and blockers", () => {
  it("bounds options and sanitizes progress and failures", () => {
    const seam = PROJECT_MIGRATION_TEST_SEAMS;
    expect(seam.positiveOption(undefined, 5, "batchSize")).toBe(5);
    expect(seam.positiveOption(1, 5, "batchSize")).toBe(1);
    for (const value of [0, -1, 1.5, 100_001]) expect(() => seam.positiveOption(value, 5, "batchSize")).toThrow("batchSize must be between 1 and 100000");
    expect(seam.sanitizedId("abcdefghijklmnop")).toBe("abcdefghijkl");
    expect(seam.sanitizedFailure(new Error("postgresql://user:secret@host/db /private/home/project/file"))).not.toContain("secret");
    expect(seam.sanitizedFailure("not-an-error")).toBe("migration operation failed");
    expect(seam.sanitizedFailure(new Error("x".repeat(600)))).toHaveLength(512);
    const progress = vi.fn();
    seam.progress({ progress }, "abcdefghijklmnop", "copy");
    seam.progress({}, "abcdefghijklmnop", "copy");
    expect(progress).toHaveBeenCalledWith("project:abcdefghijkl copy");
    expect(seam.emptyDigest()).toMatch(/^[a-f0-9]{64}$/u);
    expect(seam.schemaContract().migrations).toHaveLength(5);
    expect(seam.actualHome({ homeDir: "." })).toBe(resolve("."));
    expect(seam.timestamp({ ...seam.dependencies({}), now: () => new Date(now) })).toBe(now);
    const defaults = seam.dependencies({});
    expect(defaults.now()).toBeInstanceOf(Date);
    expect(defaults.processAlive(process.pid)).toBe(true);
    expect(defaults.processAlive(2_147_483_647)).toBe(false);
  });

  it("detects local artifacts, orphan coverage, daemon state, and delivery blockers", () => {
    const current = fixture();
    const seam = PROJECT_MIGRATION_TEST_SEAMS;
    expect(seam.projectHasStoredData(current.home, current.localProjectId)).toBe(true);
    expect(seam.daemonStopped(current.home, { ...PROJECT_MIGRATION_TEST_SEAMS.dependencies(current.options), processAlive: () => false })).toBe(true);
    writePrivate(join(lcmHomeDir(current.home), "daemon.pid"), `${process.pid}\n`);
    expect(seam.daemonStopped(current.home, { ...PROJECT_MIGRATION_TEST_SEAMS.dependencies(current.options), processAlive: () => true })).toBe(false);
    writePrivate(join(lcmHomeDir(current.home), "daemon.pid"), "invalid\n");
    expect(seam.daemonStopped(current.home, PROJECT_MIGRATION_TEST_SEAMS.dependencies(current.options))).toBe(false);

    const missingEvent = join(lcmHomeDir(current.home), "events", `${current.localProjectId}.db`);
    expect(seam.readDeliveryGate(missingEvent, now)).toEqual({ blockingOutbox: 0, quarantined: 0, checkedAt: now });
    mkdirSync(dirname(missingEvent), { recursive: true, mode: 0o700 });
    const events = new DatabaseSync(missingEvent);
    events.exec("CREATE TABLE events (delivery_state TEXT NOT NULL); INSERT INTO events VALUES ('pending'), ('claimed'), ('retry'), ('replicated'), ('quarantined'), ('delivered')");
    events.close();
    expect(seam.readDeliveryGate(missingEvent, now)).toEqual({ blockingOutbox: 4, quarantined: 1, checkedAt: now });

    const orphan = "f".repeat(64);
    const orphanPath = join(projectsDir(current.home), orphan, "db.sqlite");
    mkdirSync(dirname(orphanPath), { recursive: true, mode: 0o700 });
    cpSync(current.databasePath, orphanPath);
    const coverage = seam.installationCoverage(current.home, readProjectMapSnapshot(current.home), now);
    expect(coverage.complete).toBe(false);
    expect(coverage.orphanArtifacts).toHaveLength(1);
    const junkDirectory = join(projectsDir(current.home), "not-a-project");
    mkdirSync(junkDirectory, { mode: 0o700 });
    mkdirSync(join(projectsDir(current.home), "e".repeat(64)), { mode: 0o700 });
    const eventsRoot = join(lcmHomeDir(current.home), "events");
    writePrivate(join(eventsRoot, "not-an-event.txt"), "ignored");
    mkdirSync(join(eventsRoot, "directory.db"), { mode: 0o700 });
    const orphanEvent = join(eventsRoot, `${"c".repeat(64)}.db`);
    writePrivate(orphanEvent, "orphan");
    const expanded = seam.installationCoverage(current.home, readProjectMapSnapshot(current.home), now);
    expect(expanded.orphanArtifacts).toContain(`events/${"c".repeat(64)}.db`);
  });

  it("validates project identity, source state, inventories, and manifest contracts", () => {
    const current = fixture();
    const seam = PROJECT_MIGRATION_TEST_SEAMS;
    expect(() => seam.projectIdentity(current.localProjectId, { canonical: current.projectPath, aliases: [] })).toThrow("has no compatible PostgreSQL binding");
    expect(() => seam.projectIdentity(current.localProjectId, { canonical: current.projectPath, aliases: [], remoteProjectId: "bad" })).toThrow("has no compatible PostgreSQL binding");
    expect(seam.projectIdentity(current.localProjectId, { canonical: current.projectPath, aliases: [current.projectPath], remoteProjectId: remoteProjectId.toUpperCase() })).toMatchObject({ aliases: [resolve(current.projectPath)], remoteProjectId });
    const planned = planProjectMigration(current.options);
    const manifest = readMigrationManifest(planned.generationId, current.home);
    expect(seam.result("report", { ...manifest, status: "verified" })).toMatchObject({ ready: true });
    expect(seam.result("report", { ...manifest, status: "active" })).toMatchObject({ ready: true });
    expect(seam.result("report", { ...manifest, status: "rolled-back" })).toMatchObject({ ready: true });
    expect(seam.result("report", manifest, ["blocked"])).toMatchObject({ ready: false });
    expect(seam.reportFor({ ...manifest, status: "verified", projects: manifest.projects.map((project) => ({ ...project, status: "active" })) })).toMatchObject({ ready: true, projects: [{ verified: true }] });
    expect(seam.reportFor({ ...manifest, status: "active", projects: manifest.projects.map((project) => ({ ...project, status: "rolled-back" })) })).toMatchObject({ ready: false, projects: [{ verified: true }] });
    expect(seam.inventoriesEqual(manifest.projects[0]!.tables, [])).toBe(false);
    expect(seam.inventoriesEqual([{ table: "x", copiedRows: 0, sourceRows: 1, sourceSha256: "a".repeat(64) }], [{ table: "x", rows: 1, sha256: "a".repeat(64) }])).toBe(true);
    expect(seam.inventoriesEqual([{ table: "x", copiedRows: 0, sourceRows: 1, sourceSha256: "a".repeat(64) }], [{ table: "y", rows: 1, sha256: "a".repeat(64) }])).toBe(false);
    expect(seam.sourceFingerprint({ ...manifest.projects[0]!, sourceFingerprint: null }, current.home).main).not.toBeNull();
    expect(seam.currentSourceMatches({ ...manifest.projects[0]!, sourceFingerprint: null }, current.home)).toBe(false);
    rmSync(current.databasePath);
    expect(seam.sourceFingerprint(manifest.projects[0]!, current.home)).toEqual({ main: null, wal: null });
    expect(seam.currentSourceMatches({ ...manifest.projects[0]!, sourceFingerprint: null }, current.home)).toBe(true);
    expect(seam.archiveOriginal({ ...manifest.projects[0]!, sourceFingerprint: null }, manifest.generationId, current.home, seam.dependencies(current.options))).toMatchObject({ sourceFingerprint: null });
    expect(() => seam.assertManifestContract({ ...manifest, schemaManifestSha256: "0".repeat(64) })).toThrow("migration schema or manifest checksum changed");
    expect(() => seam.assertManifestContract({ ...manifest, coverage: { ...manifest.coverage, complete: false, orphanArtifacts: ["orphan"] } })).toThrow("installation coverage contains orphan local storage artifacts");
  });

  it("fails planning for empty installations, orphan files, and missing bindings", () => {
    const empty = fixture();
    rmSync(empty.databasePath);
    clearProjectMapCache();
    expect(() => planProjectMigration(empty.options)).toThrow("no local project data is available to migrate");

    const orphaned = fixture();
    const orphan = join(projectsDir(orphaned.home), "f".repeat(64), "db.sqlite");
    mkdirSync(dirname(orphan), { recursive: true, mode: 0o700 });
    cpSync(orphaned.databasePath, orphan);
    clearProjectMapCache();
    expect(() => planProjectMigration(orphaned.options)).toThrow("orphan local storage artifacts block planning (1)");

    const unbound = fixture();
    writePrivate(projectMapPath(unbound.home), `${JSON.stringify({ [unbound.localProjectId]: { canonical: unbound.projectPath, aliases: [] } })}\n`);
    clearProjectMapCache();
    expect(() => planProjectMigration(unbound.options)).toThrow("has no compatible PostgreSQL binding");
  });

  it("uses an empty private snapshot for event-only projects", async () => {
    const current = fixture();
    rmSync(current.databasePath);
    const eventPath = join(lcmHomeDir(current.home), "events", `${current.localProjectId}.db`);
    mkdirSync(dirname(eventPath), { recursive: true, mode: 0o700 });
    const event = new DatabaseSync(eventPath);
    event.exec("CREATE TABLE events (delivery_state TEXT NOT NULL)");
    event.close();
    clearProjectMapCache();
    const planned = planProjectMigration(current.options);
    await dryRunProjectMigration(planned.generationId, current.options);
    const manifest = readMigrationManifest(planned.generationId, current.home);
    expect(manifest.projects[0]?.sourceFingerprint).toBeNull();
    expect(manifest.projects[0]?.snapshot?.logicalRows).toBe(0);
  });

  it("fails dry-run for stale generations, registry drift, aliases, occupied state, and delivery queues", async () => {
    const stale = fixture();
    const staleGeneration = planProjectMigration(stale.options).generationId;
    await dryRunProjectMigration(staleGeneration, stale.options);
    await expect(dryRunProjectMigration(staleGeneration, stale.options)).rejects.toThrow("dry-run requires a newly planned generation");

    const registry = fixture();
    registry.runtime.schema = [];
    const registryGeneration = planProjectMigration(registry.options).generationId;
    await expect(dryRunProjectMigration(registryGeneration, registry.options)).rejects.toThrow("registry or checksum");
    expect(readMigrationManifest(registryGeneration, registry.home).status).toBe("failed");

    const aliases = fixture();
    aliases.runtime.aliases = ["/wrong"];
    await expect(dryRunProjectMigration(planProjectMigration(aliases.options).generationId, aliases.options)).rejects.toThrow("remote aliases do not match");

    const occupied = fixture();
    occupied.runtime.physical.set("messages", new Map([["occupied", { message_id: 1 }]]));
    await expect(dryRunProjectMigration(planProjectMigration(occupied.options).generationId, occupied.options)).rejects.toThrow("destination is not empty");

    const delivery = fixture();
    const eventPath = join(lcmHomeDir(delivery.home), "events", `${delivery.localProjectId}.db`);
    mkdirSync(dirname(eventPath), { recursive: true, mode: 0o700 });
    const event = new DatabaseSync(eventPath);
    event.exec("CREATE TABLE events (delivery_state TEXT NOT NULL); INSERT INTO events VALUES ('pending')");
    event.close();
    clearProjectMapCache();
    await expect(dryRunProjectMigration(planProjectMigration(delivery.options).generationId, delivery.options)).rejects.toThrow("blocking local outbox state");
  }, 20_000);

  it("fails runtime opening safely and preserves the health failure", async () => {
    const current = fixture();
    current.runtime.healthStatus = "unhealthy";
    await expect(dryRunProjectMigration(planProjectMigration(current.options).generationId, current.options)).rejects.toThrow("runtime is not terminal healthy");
    expect(current.runtime.close).toHaveBeenCalled();
    const closeFailure = fixture();
    closeFailure.runtime.healthStatus = "unhealthy";
    closeFailure.runtime.close.mockRejectedValueOnce(new Error("close failed"));
    await expect(dryRunProjectMigration(planProjectMigration(closeFailure.options).generationId, closeFailure.options)).rejects.toThrow("runtime is not terminal healthy");
  });

  it("fails apply for live daemons, drift, unavailable leases, and early snapshots", async () => {
    const daemon = fixture();
    const daemonGeneration = planProjectMigration(daemon.options).generationId;
    await dryRunProjectMigration(daemonGeneration, daemon.options);
    writePrivate(join(lcmHomeDir(daemon.home), "daemon.pid"), `${process.pid}\n`);
    const liveOptions = { ...daemon.options, _dependenciesForTesting: { ...daemon.options._dependenciesForTesting, processAlive: () => true } };
    await expect(applyProjectMigration(daemonGeneration, liveOptions)).rejects.toThrow("daemon to be stopped");

    const drift = fixture();
    const driftGeneration = planProjectMigration(drift.options).generationId;
    await dryRunProjectMigration(driftGeneration, drift.options);
    const db = new DatabaseSync(drift.databasePath);
    db.exec("UPDATE conversations SET title = 'changed'");
    db.close();
    await expect(applyProjectMigration(driftGeneration, drift.options)).rejects.toThrow("source fingerprint changed after dry-run");

    const noLease = fixture();
    const noLeaseGeneration = planProjectMigration(noLease.options).generationId;
    await dryRunProjectMigration(noLeaseGeneration, noLease.options);
    vi.mocked(PostgreSqlWorkCoordinator.prototype.acquireLease).mockResolvedValueOnce(null);
    await expect(applyProjectMigration(noLeaseGeneration, noLease.options)).rejects.toThrow("migration lease is held by another writer");

    const early = fixture();
    const earlyGeneration = planProjectMigration(early.options).generationId;
    await dryRunProjectMigration(earlyGeneration, early.options);
    const earlyManifest = readMigrationManifest(earlyGeneration, early.home);
    writeMigrationManifest({ ...earlyManifest, projects: earlyManifest.projects.map((project) => ({ ...project, tables: project.tables.map((table) => table.table === "conversations" ? { ...table, sourceRows: table.sourceRows + 1 } : table) })) }, early.home);
    await expect(applyProjectMigration(earlyGeneration, early.options)).rejects.toThrow("source snapshot ended early in conversations");
  }, 20_000);

  it("records authoritative readback checkpoints and handles lease release failures", async () => {
    const uncertain = fixture();
    const uncertainGeneration = planProjectMigration(uncertain.options).generationId;
    await dryRunProjectMigration(uncertainGeneration, uncertain.options);
    uncertain.runtime.uncertainTransactionsRemaining = 1;
    await applyProjectMigration(uncertainGeneration, uncertain.options);
    expect(readMigrationManifest(uncertainGeneration, uncertain.home).projects[0]?.tables[0]?.remoteOutcome).toBe("readback-verified");

    const release = fixture();
    const releaseGeneration = planProjectMigration(release.options).generationId;
    await dryRunProjectMigration(releaseGeneration, release.options);
    vi.mocked(PostgreSqlWorkCoordinator.prototype.releaseLease).mockRejectedValueOnce(new Error("release failed"));
    await expect(applyProjectMigration(releaseGeneration, release.options)).rejects.toThrow("release failed");

    const suppressed = fixture();
    const suppressedGeneration = planProjectMigration(suppressed.options).generationId;
    await dryRunProjectMigration(suppressedGeneration, suppressed.options);
    suppressed.runtime.failTransactionAt = 1;
    vi.mocked(PostgreSqlWorkCoordinator.prototype.releaseLease).mockRejectedValueOnce(new Error("release failed"));
    await expect(applyProjectMigration(suppressedGeneration, suppressed.options)).rejects.toThrow("injected PostgreSQL transaction failure");
  }, 20_000);

  it("fails verification for invalid state, drift, ledger, inventory, relational, and sample mismatches", async () => {
    const invalid = fixture();
    await expect(verifyProjectMigration(planProjectMigration(invalid.options).generationId, invalid.options)).rejects.toThrow("verify requires a completed apply generation");

    const cases = ["source", "ledger", "inventory", "relational", "sample"] as const;
    for (const scenario of cases) {
      const current = fixture();
      const generationId = planProjectMigration(current.options).generationId;
      await dryRunProjectMigration(generationId, current.options);
      await applyProjectMigration(generationId, current.options);
      if (scenario === "source") {
        const db = new DatabaseSync(current.databasePath);
        db.exec("UPDATE conversations SET title = 'drift'");
        db.close();
      } else if (scenario === "ledger") current.runtime.schema = [];
      else if (scenario === "inventory") current.runtime.physical.get("conversations")!.clear();
      else if (scenario === "relational") current.runtime.relationalViolations = "1";
      else current.runtime.sampleMismatch = true;
      await expect(verifyProjectMigration(generationId, current.options), scenario).rejects.toThrow();
      expect(readMigrationManifest(generationId, current.home).status).toBe("failed");
    }
    const repeat = fixture();
    const repeatGeneration = await forwardToVerified(repeat);
    await expect(verifyProjectMigration(repeatGeneration, repeat.options)).resolves.toMatchObject({ status: "verified" });
  }, 30_000);

  it("reports activation blockers without mutating config or map", async () => {
    const current = fixture();
    const generationId = await forwardToVerified(current);
    current.factory.health = vi.fn(async () => ({ backend: "postgresql" as const, status: "unhealthy" as const, details: "blocked" }));
    current.factory.close = vi.fn(async () => { throw new Error("close failed"); });
    const beforeConfig = readFileSync(configPath(current.home));
    const beforeMap = readFileSync(projectMapPath(current.home));
    const blocked = await activateProjectMigration(generationId, current.options);
    expect(blocked.ready).toBe(false);
    expect(blocked.blockers).toContain("live PostgreSQL storage factory is not terminal healthy");
    expect(blocked.blockers).toContain("live PostgreSQL storage factory did not close cleanly");
    expect(readFileSync(configPath(current.home))).toEqual(beforeConfig);
    expect(readFileSync(projectMapPath(current.home))).toEqual(beforeMap);
  });

  it("aggregates installation, project, delivery, and factory activation blockers", async () => {
    const current = fixture();
    const generationId = await forwardToVerified(current);
    const manifest = readMigrationManifest(generationId, current.home);
    writePrivate(join(lcmHomeDir(current.home), "daemon.pid"), `${process.pid}\n`);
    const orphan = join(projectsDir(current.home), "f".repeat(64), "db.sqlite");
    mkdirSync(dirname(orphan), { recursive: true, mode: 0o700 });
    cpSync(current.databasePath, orphan);
    const eventPath = join(lcmHomeDir(current.home), "events", `${current.localProjectId}.db`);
    mkdirSync(dirname(eventPath), { recursive: true, mode: 0o700 });
    const event = new DatabaseSync(eventPath);
    event.exec("CREATE TABLE events (delivery_state TEXT); INSERT INTO events VALUES ('pending')");
    event.close();
    current.factory.projectExists.mockResolvedValue(false);
    current.factory.close.mockRejectedValueOnce(new Error("close failed"));
    const degraded = {
      ...manifest,
      status: "applied" as const,
      schemaManifestSha256: "0".repeat(64),
      coverage: { ...manifest.coverage, inventorySha256: "1".repeat(64) },
      projects: manifest.projects.map((project) => ({
        ...project,
        status: "applied" as const,
        sourceFingerprint: project.sourceFingerprint === null ? null : {
          ...project.sourceFingerprint,
          main: { ...project.sourceFingerprint.main, sha256: "2".repeat(64) },
        },
      })),
    };
    const blockers = await PROJECT_MIGRATION_TEST_SEAMS.activationBlockers(
      degraded,
      current.options,
      { ...PROJECT_MIGRATION_TEST_SEAMS.dependencies(current.options), processAlive: () => true },
    );
    expect(blockers).toEqual(expect.arrayContaining([
      "generation is not terminal verified",
      "LCM daemon is not stopped",
      "schema or manifest checksum changed",
      "installation coverage contains orphan local storage artifacts",
      "installation-wide project coverage changed after planning",
      `project:${current.localProjectId.slice(0, 12)} is not verified`,
      `project:${current.localProjectId.slice(0, 12)} source fingerprint changed`,
      `project:${current.localProjectId.slice(0, 12)} local delivery is not quiescent`,
      `project:${current.localProjectId.slice(0, 12)} is not usable through the live PostgreSQL factory`,
      "live PostgreSQL storage factory did not close cleanly",
    ]));

    const failingFactory = fixture();
    const failingGeneration = await forwardToVerified(failingFactory);
    const failingManifest = readMigrationManifest(failingGeneration, failingFactory.home);
    failingFactory.factory.health.mockRejectedValueOnce(new Error("health failed"));
    failingFactory.factory.close.mockRejectedValueOnce(new Error("close failed"));
    const factoryBlockers = await PROJECT_MIGRATION_TEST_SEAMS.activationBlockers(
      failingManifest,
      failingFactory.options,
      PROJECT_MIGRATION_TEST_SEAMS.dependencies(failingFactory.options),
    );
    expect(factoryBlockers).toContain("live PostgreSQL storage factory behavioral check failed");
    expect(factoryBlockers).not.toContain("live PostgreSQL storage factory did not close cleanly");
  }, 20_000);

  it("rejects every independently stale project-map identity field", () => {
    const current = fixture();
    const generationId = planProjectMigration(current.options).generationId;
    const project = readMigrationManifest(generationId, current.home).projects[0]!;
    const valid = readProjectMapSnapshot(current.home)[current.localProjectId]!;
    expect(PROJECT_MIGRATION_TEST_SEAMS.expectedMapEntry({ [current.localProjectId]: valid }, project)).toEqual(valid);
    expect(() => PROJECT_MIGRATION_TEST_SEAMS.expectedMapEntry({}, project)).toThrow("disappeared from the project map");
    expect(() => PROJECT_MIGRATION_TEST_SEAMS.expectedMapEntry({ [current.localProjectId]: { ...valid, canonical: dirname(current.projectPath) } }, project)).toThrow("project-map identity changed");
    expect(() => PROJECT_MIGRATION_TEST_SEAMS.expectedMapEntry({ [current.localProjectId]: { ...valid, remoteProjectId: machineId } }, project)).toThrow("project-map identity changed");
    expect(() => PROJECT_MIGRATION_TEST_SEAMS.expectedMapEntry({ [current.localProjectId]: { ...valid, aliases: [dirname(current.projectPath)] } }, project)).toThrow("project-map identity changed");
  });

  it("rejects stale and incompatible activation journals before publication", async () => {
    const current = fixture();
    const generationId = await forwardToVerified(current);
    const manifest = readMigrationManifest(generationId, current.home);
    const deps = PROJECT_MIGRATION_TEST_SEAMS.dependencies(current.options);
    const changedSource = {
      ...manifest,
      projects: manifest.projects.map((project) => ({ ...project, sourceFingerprint: project.sourceFingerprint === null ? null : { ...project.sourceFingerprint, main: { ...project.sourceFingerprint.main, sha256: "0".repeat(64) } } })),
    };
    expect(() => PROJECT_MIGRATION_TEST_SEAMS.publishActivation(changedSource, current.options, deps)).toThrow("changed during activation");

    const crashing = { ...deps, crash: (point: MigrationCrashPoint) => { if (point === "after-prepare") throw new Error("stop after prepare"); } };
    expect(() => PROJECT_MIGRATION_TEST_SEAMS.publishActivation(manifest, current.options, crashing)).toThrow("stop after prepare");
    const prepared = readPublicationJournal(generationId, current.home)!;
    writePublicationJournal(generationId, { ...prepared, operation: "pre-write-rollback" }, current.home);
    expect(() => PROJECT_MIGRATION_TEST_SEAMS.publishActivation(manifest, current.options, deps)).toThrow("operation does not match activation");
    writePublicationJournal(generationId, { ...prepared, operation: "activate", phase: "completed" }, current.home);
    expect(() => PROJECT_MIGRATION_TEST_SEAMS.publishActivation(manifest, current.options, deps)).not.toThrow();
    writePublicationJournal(generationId, { ...prepared, expectedConfigSha256: "0".repeat(64) }, current.home);
    expect(() => PROJECT_MIGRATION_TEST_SEAMS.publishActivation(manifest, current.options, deps)).toThrow("configuration changed during activation publication");

    writePrivate(configPath(current.home), `${JSON.stringify({ storage: { backend: "postgresql" } }, null, 2)}\n`);
    writePublicationJournal(generationId, {
      ...prepared,
      expectedConfigSha256: PROJECT_MIGRATION_TEST_SEAMS.configSha256(current.home),
      publishedConfigSha256: "1".repeat(64),
      phase: "recovery",
    }, current.home);
    expect(() => PROJECT_MIGRATION_TEST_SEAMS.publishActivation(manifest, current.options, deps)).toThrow("published PostgreSQL configuration changed");
  }, 15_000);

  it("rejects invalid and stale pre-write rollback publications", () => {
    const current = fixture();
    const generationId = planProjectMigration(current.options).generationId;
    const manifest = readMigrationManifest(generationId, current.home);
    const deps = PROJECT_MIGRATION_TEST_SEAMS.dependencies(current.options);
    const copied = { ...manifest, projects: manifest.projects.map((project) => ({ ...project, tables: project.tables.map((table, index) => index === 0 ? { ...table, copiedRows: 1 } : table) })) };
    expect(() => PROJECT_MIGRATION_TEST_SEAMS.preWriteRollback(copied, current.options, deps)).toThrow("unavailable after remote writes");
    writePrivate(configPath(current.home), `${JSON.stringify({ storage: { backend: "postgresql" } })}\n`);
    expect(() => PROJECT_MIGRATION_TEST_SEAMS.preWriteRollback(manifest, current.options, deps)).toThrow("expected the global SQLite backend");
    writePrivate(configPath(current.home), `${JSON.stringify({ storage: { backend: "sqlite" } })}\n`);

    const stop = { ...deps, crash: (point: MigrationCrashPoint) => { if (point === "after-prepare") throw new Error("stop after prepare"); } };
    expect(() => PROJECT_MIGRATION_TEST_SEAMS.preWriteRollback(manifest, current.options, stop)).toThrow("stop after prepare");
    const prepared = readPublicationJournal(generationId, current.home)!;
    writePublicationJournal(generationId, { ...prepared, operation: "activate" }, current.home);
    expect(() => PROJECT_MIGRATION_TEST_SEAMS.preWriteRollback(manifest, current.options, deps)).toThrow("operation does not match pre-write rollback");
    writePublicationJournal(generationId, { ...prepared, phase: "completed" }, current.home);
    expect(PROJECT_MIGRATION_TEST_SEAMS.preWriteRollback(manifest, current.options, deps).projects[0]?.status).toBe("rolled-back");
    expect(PROJECT_MIGRATION_TEST_SEAMS.preWriteRollback({ ...manifest, projects: manifest.projects.map((project) => ({ ...project, verifiedAt: now })) }, current.options, deps).projects[0]?.verifiedAt).toBe(now);

    writePublicationJournal(generationId, prepared, current.home);
    writePrivate(configPath(current.home), `${JSON.stringify({ storage: { backend: "sqlite" }, changed: true })}\n`);
    expect(() => PROJECT_MIGRATION_TEST_SEAMS.preWriteRollback(manifest, current.options, deps)).toThrow("configuration changed during pre-write rollback");
  });
});
