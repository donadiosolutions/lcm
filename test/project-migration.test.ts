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
import type {
  PostgreSqlMigrationRuntime,
  PostgreSqlMigrationIdentity,
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
    if (options.operation === "migrationVerifyRelationalIntegrity") return [{ violations: "0" }];
    if (options.operation.startsWith("migrationSidecar:")) return [];
    if (options.operation.startsWith("migrationReadBatch:")) {
      const table = options.operation.split(":")[1]!;
      const limit = Number(config.values?.at(-2));
      const offset = Number(config.values?.at(-1));
      const columns = /^SELECT (.+?) FROM /su.exec(config.text)?.[1]?.split(", ").map((column) => column.trim()) ?? [];
      return this.tableRows(table).slice(offset, offset + limit).map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
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
        return callback(scope);
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
  });

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
});
