import { fork, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, it } from "vitest";
import { StorageOperationError } from "../../src/storage/errors.js";
import { setConfigValue } from "../../src/config-manager.js";
import { PostgreSqlIdentityRepository, type RegisteredMachine, type RemoteProject } from "../../src/storage/postgresql/identity-repository.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { createCertificate, encodeBookkeeping, loadMatrix, sourceDigest } from "../../scripts/surface-parity-artifact.mjs";
import { assertCompleteReport, assertSemanticEqual, compareBackendReports, semanticDigest } from "../surface-parity/assertions.mjs";
import { createGitFixture } from "../surface-parity/git-fixture.mjs";
import { FAULT_ASSERTION_OWNERS, type SurfaceRow } from "../surface-parity/inventory.js";
import { expectedSurfaceObservations } from "./fixtures/surface-parity-workflows.mjs";
import { assertHarnessReady, createPostgreSqlTestDatabase, harnessEnvironment, settings, type PostgreSqlTestDatabase } from "./harness.js";
import { applyAllRuntimeGrants, publishPostgreSqlSelection, restoreRuntimeGrants } from "./operational-fixture.js";

type Backend = "sqlite" | "postgresql";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = Record<string, unknown>;
interface RowResult { id: string; assertions: string[]; verdict: "passed" | "failed"; observation: Json }
type Bookkeeping = [string, string, string, number];
interface WorkerResult { type: "result"; seq: number; backend: Backend; scenario: string; rows: RowResult[]; fault?: Json; bookkeeping: Bookkeeping[] }
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
interface WorkerPaths { homeDir: string; projectPath: string; secondaryProjectPath: string }
type CorpusCounts = { projects: number; conversations: number; messages: number; summaries: number; promotedCount: number };

const SCENARIOS = ["identity", "admin", "events", "memory", "compaction", "native-import", "knowledge", "sensitive", "hooks", "promotion", "diagnostics"] as const;
const FAULT_SCENARIOS = ["fault-denial", "fault-pool", "fault-cancellation", "fault-unavailable"] as const;
type FaultScenario = typeof FAULT_SCENARIOS[number];
const SCENARIO_TIMEOUT = 120_000;
const REQUEST_TIMEOUT = 110_000;
const IPC_LIMIT = 262_144;
const STREAM_LIMIT = 65_536;
const scope = { domain: "factory", operation: "surfaceParityFixture" } as const;
const matrix: SurfaceRow[] = loadMatrix();
const faultAssertions = new Set(Object.values(FAULT_ASSERTION_OWNERS).flat().map(owner => `${owner.id}\0${owner.assertion}`));
const baselineMatrix = matrix.map(row => ({ ...row, assertions: row.assertions.filter(assertion => !faultAssertions.has(`${row.id}\0${assertion}`)) }));

function expectedFault(scenario: FaultScenario, backend: Backend): Json {
  const pg = backend === "postgresql";
  if (scenario === "fault-pool") return { variant: pg ? "postgresql-pool-exhaustion" : "sqlite-no-pool", noEffects: true, recovered: true };
  if (scenario === "fault-cancellation") return { variant: pg ? "postgresql-server-cancel" : "sqlite-abort-aware-open", transportAborted: true, invocationCancelled: true, settled: true, noEffects: true, recovered: true };
  if (scenario === "fault-denial") return { variant: pg ? "postgresql-select-denied" : "sqlite-no-runtime-grants", noEffects: true, recovered: true };
  return { variant: pg ? "postgresql-unavailable" : "sqlite-no-pg-endpoint", bounded: true, sanitized: true, noFallback: true };
}

function failure(id: string): Error { return new Error(`surface-parity-parent:${id}`); }
function requireThat(condition: unknown, id: string): asserts condition { if (!condition) throw failure(id); }
function object(value: unknown): value is ObjectValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value: unknown, keys: string[]): value is ObjectValue {
  return object(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  // Ownership precedes any request; failures arriving before its first await
  // must remain observable without producing unhandled-rejection noise.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function bounded<T>(promise: Promise<T>, milliseconds: number, id: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(failure(id)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
function digestError(error: unknown): { id: string; digest: string } {
  // Hash only. Neither a driver message nor an assertion object's actual value
  // becomes a parent test failure or a durable evidence field.
  return { id: "owned-administrator-failure", digest: createHash("sha256").update(error instanceof Error ? error.message : typeof error).digest("hex") };
}
function workerError(value: unknown): string {
  requireThat(exact(value, ["id", "digest"]) && typeof value.id === "string" && /^[a-zA-Z0-9_.:-]{1,80}$/u.test(value.id)
    && typeof value.digest === "string" && /^[a-f0-9]{64}$/u.test(value.digest), "failure-details");
  return `${value.id}:${value.digest}`;
}

/** Administrator authority is restricted to the newly allocated database. */
class OwnedAdministrator {
  readonly runtime: PostgreSqlRuntime;
  private lockRuntime: PostgreSqlRuntime;
  private lock?: { table: "messages" | "projects"; pid: number; release: Deferred<void>; finished: Promise<void> };
  private witnessed = new Set<number>();
  private denied = false;
  private baselineCorpus?: CorpusCounts;

  constructor(private database: PostgreSqlTestDatabase, private unavailable: () => Promise<Json>) {
    this.runtime = new PostgreSqlRuntime(settings(database.adminUrl));
    this.lockRuntime = new PostgreSqlRuntime(settings(database.adminUrl, { poolMax: 1 }));
  }

  async execute(action: unknown, payload: unknown, scenario: string): Promise<Json> {
    requireThat(typeof action === "string" && object(payload), "admin-request-schema");
    if (action === "snapshot") {
      requireThat(exact(payload, []), "snapshot-payload");
      const snapshot = await this.snapshot();
      if (scenario === "diagnostics") {
        requireThat(object(snapshot) && exact(snapshot.counts, ["projects", "conversations", "messages", "summaries", "promotedCount"])
          && Object.values(snapshot.counts).every(value => Number.isSafeInteger(value) && (value as number) >= 0), "native-corpus-counts");
        this.baselineCorpus = { ...snapshot.counts } as CorpusCounts;
      }
      return snapshot;
    }
    if (action === "unavailable.start") {
      requireThat(scenario === "fault-unavailable" && exact(payload, []), "unavailable-scenario");
      return this.unavailable();
    }
    if (action.startsWith("lock.")) requireThat(scenario === "fault-cancellation", "lock-scenario");
    if (action.startsWith("denial.")) requireThat(["memory", "diagnostics", "fault-denial"].includes(scenario), "denial-scenario");
    if (action === "lock.acquire") {
      requireThat(exact(payload, ["table"]) && (payload.table === "messages" || payload.table === "projects") && !this.lock, "lock-acquire-payload");
      const table = payload.table;
      const entered = deferred<number>();
      const release = deferred<void>();
      const rollback = new StorageOperationError("STORAGE_OPERATION_FAILED", "postgresql", undefined, "factory", "releaseSurfaceFixtureLock");
      const finished = this.lockRuntime.transaction(async transaction => {
        await transaction.query({ text: table === "messages" ? "LOCK TABLE lcm.messages IN ACCESS EXCLUSIVE MODE" : "LOCK TABLE lcm.projects IN ACCESS EXCLUSIVE MODE" }, scope);
        const result = await transaction.query<{ pid: number }>({ text: "SELECT pg_backend_pid() AS pid" }, scope);
        const pid = result.rows[0]?.pid;
        requireThat(Number.isSafeInteger(pid) && pid > 0, "lock-owner-pid");
        entered.resolve(pid);
        await release.promise;
        throw rollback;
      }, scope).then(() => { throw failure("lock-committed"); }, error => {
        if (error !== rollback) { entered.reject(error); throw error; }
      });
      void finished.catch(() => {});
      try {
        const pid = await bounded(entered.promise, 5_000, "lock-acquire-timeout");
        this.lock = { table, pid, release, finished };
        return { acquired: true };
      } catch (error) {
        release.resolve();
        await bounded(finished.catch(() => {}), 6_000, "lock-acquire-cleanup-timeout");
        throw error;
      }
    }
    if (action === "lock.wait") {
      requireThat(exact(payload, ["table"]) && this.lock && payload.table === this.lock.table, "lock-wait-payload");
      const end = performance.now() + 1_500;
      do {
        const result = await this.runtime.query<{ pid: number }>({
          text: `SELECT activity.pid FROM pg_catalog.pg_stat_activity AS activity
            JOIN pg_catalog.pg_locks AS waiting ON waiting.pid=activity.pid
            WHERE activity.datname=$1 AND activity.usename='lcm_test_runtime'
              AND activity.wait_event_type='Lock' AND NOT waiting.granted
              AND waiting.relation=pg_catalog.to_regclass($2)
              AND $3=ANY(pg_catalog.pg_blocking_pids(activity.pid))`,
          values: [this.database.name, `lcm.${this.lock.table}`, this.lock.pid],
        }, scope);
        if (result.rows.length === 1) {
          const pid = result.rows[0].pid;
          requireThat(Number.isSafeInteger(pid) && pid > 0, "blocked-query-pid");
          this.witnessed.add(pid);
          return { blocked: true, pid };
        }
        requireThat(result.rows.length === 0, "ambiguous-lock-witness");
        await delay(10);
      } while (performance.now() < end);
      throw failure("lock-witness-timeout");
    }
    if (action === "lock.settled") {
      requireThat(exact(payload, ["pid"]) && typeof payload.pid === "number" && this.witnessed.has(payload.pid), "settled-payload");
      const end = performance.now() + 1_500;
      do {
        const result = await this.runtime.query({
          text: `SELECT pid FROM pg_catalog.pg_stat_activity WHERE datname=$1
            AND usename='lcm_test_runtime' AND pid=$2
            AND (state='active' OR xact_start IS NOT NULL OR wait_event_type='Lock')`,
          values: [this.database.name, payload.pid],
        }, scope);
        if (result.rowCount === 0) return { settled: true };
        await delay(10);
      } while (performance.now() < end);
      throw failure("query-settlement-timeout");
    }
    if (action === "lock.release") {
      requireThat(exact(payload, []), "lock-release-payload");
      await this.releaseLock();
      return { released: true };
    }
    if (action === "denial.revoke") {
      requireThat(exact(payload, []) && !this.denied && !this.lock, "denial-revoke-payload");
      // Mark before the write so cleanup restores an uncertain write outcome.
      this.denied = true;
      await this.runtime.query({ text: "REVOKE SELECT ON lcm.messages FROM lcm_test_runtime" }, scope);
      return { revoked: true };
    }
    if (action === "denial.restore") {
      requireThat(exact(payload, []), "denial-restore-payload");
      await this.restore();
      return { restored: true };
    }
    throw failure("unknown-admin-action");
  }

  private async snapshot(): Promise<Json> {
    const catalog = await this.runtime.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>({
      text: `SELECT table_name,column_name,data_type,is_nullable,column_default
        FROM information_schema.columns WHERE table_schema='lcm'
        ORDER BY table_name COLLATE "C",ordinal_position`,
    }, scope);
    const constraints = await this.runtime.query({
      text: `SELECT relation.relname AS table_name,constraint_row.conname AS name,
        pg_catalog.pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_catalog.pg_constraint constraint_row
        JOIN pg_catalog.pg_class relation ON relation.oid=constraint_row.conrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname='lcm' ORDER BY relation.relname COLLATE "C",constraint_row.conname COLLATE "C"`,
    }, scope);
    const indexes = await this.runtime.query({
      text: "SELECT tablename,indexname,indexdef FROM pg_catalog.pg_indexes WHERE schemaname='lcm' ORDER BY tablename COLLATE \"C\",indexname COLLATE \"C\"",
    }, scope);
    const names = await this.runtime.query<{ name: string }>({
      text: "SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname='lcm' ORDER BY tablename COLLATE \"C\"",
    }, scope);
    const tables: Record<string, Json> = {};
    for (const { name } of names.rows) {
      requireThat(/^[a-z][a-z0-9_]{0,62}$/u.test(name), "snapshot-table-name");
      const rows = await this.runtime.query<{ row: Json }>({
        text: `SELECT to_jsonb(record) AS row FROM lcm."${name}" AS record ORDER BY to_jsonb(record)::text COLLATE "C"`,
      }, scope);
      tables[name] = { count: rows.rows.length, digest: semanticDigest(rows.rows.map(row => row.row)) };
    }
    const counts = await this.runtime.query<{ projects: number; conversations: number; messages: number; summaries: number; promotedCount: number }>({
      text: `SELECT (SELECT count(*)::integer FROM lcm.projects) AS projects,
        (SELECT count(*)::integer FROM lcm.conversations) AS conversations,
        (SELECT count(*)::integer FROM lcm.messages) AS messages,
        (SELECT count(*)::integer FROM lcm.summaries) AS summaries,
        (SELECT count(*)::integer FROM lcm.promoted_memories) AS "promotedCount"`,
    }, scope);
    const projects = await this.runtime.query<{ projectId: string; messageCount: number; summaryCount: number; promotedCount: number }>({
      text: `SELECT project.project_id AS "projectId",
        (SELECT count(*)::integer FROM lcm.messages item WHERE item.project_id=project.project_id) AS "messageCount",
        (SELECT count(*)::integer FROM lcm.summaries item WHERE item.project_id=project.project_id) AS "summaryCount",
        (SELECT count(*)::integer FROM lcm.promoted_memories item WHERE item.project_id=project.project_id) AS "promotedCount"
        FROM lcm.projects project ORDER BY project.project_id`,
    }, scope);
    const conversations = await this.runtime.query<{ projectId: string; conversationId: string; sessionId: string }>({
      text: "SELECT project_id AS \"projectId\",conversation_id::text AS \"conversationId\",session_id AS \"sessionId\" FROM lcm.conversations ORDER BY project_id,conversation_id",
    }, scope);
    return {
      schemaDigest: semanticDigest({ columns: catalog.rows, constraints: constraints.rows, indexes: indexes.rows }), tables,
      counts: counts.rows[0],
      projectCounts: Object.fromEntries(projects.rows.map(({ projectId, ...counts }) => [projectId, counts])),
      projectIds: projects.rows.map(row => row.projectId), conversations: conversations.rows,
      conversationIds: conversations.rows.map(row => row.conversationId),
    };
  }

  async releaseLock(): Promise<void> {
    const lock = this.lock;
    if (!lock) return;
    lock.release.resolve();
    await bounded(lock.finished, 6_000, "lock-release-timeout");
    const remaining = await this.runtime.query({
      text: `SELECT locks.pid FROM pg_catalog.pg_locks locks
        JOIN pg_catalog.pg_stat_activity activity ON activity.pid=locks.pid
        WHERE activity.datname=$1 AND activity.usename='lcm_harness_admin'
          AND locks.pid=$2 AND locks.relation=pg_catalog.to_regclass($3)
          AND locks.mode='AccessExclusiveLock' AND locks.granted`,
      values: [this.database.name, lock.pid, `lcm.${lock.table}`],
    }, scope);
    requireThat(remaining.rowCount === 0, "fixture-lock-retained");
    this.lock = undefined;
    this.witnessed.clear();
  }

  async restore(): Promise<void> {
    if (!this.denied) return;
    await restoreRuntimeGrants(this.runtime);
    this.denied = false;
  }

  diagnosticCorpus(): CorpusCounts {
    requireThat(this.baselineCorpus, "missing-native-diagnostic-corpus");
    return { ...this.baselineCorpus };
  }

  async cleanup(): Promise<void> {
    const results = await Promise.allSettled([this.releaseLock(), this.restore()]);
    const closed = await Promise.allSettled([this.lockRuntime.close(), this.runtime.close()]);
    requireThat([...results, ...closed].every(result => result.status === "fulfilled"), "administrator-cleanup");
  }
}

/** One home/backend for the entire worker lifetime; no ambient application env. */
function workerEnvironment(paths: WorkerPaths, backend: Backend, pg?: { database: PostgreSqlTestDatabase; primary: string; secondary: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "WINDIR"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const name of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]) {
    const path = name === "HOME" || name === "USERPROFILE" ? paths.homeDir : join(paths.homeDir, name.toLowerCase());
    mkdirSync(path, { recursive: true, mode: 0o700 });
    env[name] = path;
  }
  Object.assign(env, {
    GITHUB_ACTIONS: "true", NO_COLOR: "1", FORCE_COLOR: "0",
    LCM_SURFACE_BACKEND: backend, LCM_SURFACE_HOME: paths.homeDir,
    LCM_SURFACE_PROJECT_PATH: paths.projectPath, LCM_SURFACE_SECONDARY_PROJECT_PATH: paths.secondaryProjectPath,
  });
  if (backend === "postgresql") {
    requireThat(pg, "missing-postgresql-worker-authority");
    Object.assign(env, {
      LCM_POSTGRES_URL: pg.database.runtimeUrl,
      LCM_POSTGRES_CA_FILE: harnessEnvironment().LCM_TEST_POSTGRES_CA_FILE,
      LCM_POSTGRES_MIGRATION_ROLE: "lcm_test_migrator",
      LCM_SURFACE_ADMIN_URL: pg.database.adminUrl,
      LCM_SURFACE_MIGRATOR_URL: pg.database.migratorUrl,
      LCM_SURFACE_REMOTE_PROJECT_ID: pg.primary,
      LCM_SURFACE_SECONDARY_REMOTE_PROJECT_ID: pg.secondary,
    });
  }
  return env;
}

function initializeGitProjects(paths: WorkerPaths): void {
  for (const path of [paths.projectPath, paths.secondaryProjectPath]) {
    createGitFixture(path);
  }
}

async function unusedLoopbackPort(): Promise<number> {
  const reservation = createServer();
  try {
    await bounded(new Promise<void>((done, reject) => {
      reservation.once("error", () => reject(failure("fixture-port-listen")));
      reservation.listen(0, "127.0.0.1", done);
    }), 2_000, "fixture-port-timeout");
    const address = reservation.address();
    requireThat(address && typeof address !== "string" && address.port > 0, "fixture-port-address");
    return address.port;
  } finally {
    if (reservation.listening) await bounded(new Promise<void>((done, reject) => {
      reservation.close(error => error ? reject(failure("fixture-port-close")) : done());
    }), 2_000, "fixture-port-close-timeout");
  }
}

async function unavailableStartup(root: string, database: PostgreSqlTestDatabase, machine: RegisteredMachine, project: RemoteProject, projectPath: string): Promise<Json> {
  const homeDir = mkdtempSync(join(root, "unavailable-home-"));
  let child: ChildProcess | undefined;
  let rejectedConnections = 0;
  const listener = createServer(socket => { rejectedConnections++; socket.destroy(); });
  const closed = deferred<void>();
  listener.on("close", () => closed.resolve());
  listener.on("error", () => closed.reject(failure("unavailable-listener")));
  const exit = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const childExited = deferred<void>();
  let primaryError: unknown;
  try {
    mkdirSync(join(homeDir, ".lcm", "projects"), { recursive: true, mode: 0o700 });
    writeFileSync(join(homeDir, ".lcm", "machine.json"), JSON.stringify({ version: 1, identityKey: machine.identityKey, machineId: machine.machineId, displayName: machine.displayName }) + "\n", { mode: 0o600 });
    await publishPostgreSqlSelection(homeDir, machine, project, projectPath);
    await bounded(new Promise<void>((done, reject) => {
      listener.once("error", () => reject(failure("unavailable-listen")));
      listener.listen(0, "127.0.0.1", done);
    }), 2_000, "unavailable-listen-timeout");
    const address = listener.address();
    requireThat(address && typeof address !== "string", "unavailable-listener-address");
    const env = workerEnvironment({ homeDir, projectPath, secondaryProjectPath: projectPath }, "postgresql", { database, primary: project.projectId, secondary: project.projectId });
    const url = new URL(database.runtimeUrl);
    url.hostname = "127.0.0.1";
    url.port = String(address.port);
    url.password = "SURFACEPRIVATE_UNAVAILABLE_CREDENTIAL";
    env.LCM_POSTGRES_URL = url.toString();
    delete env.LCM_SURFACE_ADMIN_URL;
    delete env.LCM_SURFACE_MIGRATOR_URL;
    const daemonPort = await unusedLoopbackPort();
    for (const [path, value] of [["daemon.port", daemonPort], ["daemon.idleTimeoutMs", 0], ["storage.postgresql.connectionTimeoutMs", 100], ["storage.postgresql.statementTimeoutMs", 1000]] as const) {
      setConfigValue({ configPath: join(homeDir, ".lcm", "config.json"), path, value: String(value), json: true, env });
    }
    let stdout = "";
    let stderr = "";
    const start = performance.now();
    child = spawn(process.execPath, [join(process.cwd(), "dist/lcm.mjs"), "daemon", "start", "--foreground"], {
      cwd: projectPath, env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.once("error", () => exit.reject(failure("unavailable-child-error")));
    child.once("exit", () => childExited.resolve());
    child.once("close", (code, signal) => exit.resolve({ code, signal }));
    for (const [stream, target] of [[child.stdout, "stdout"], [child.stderr, "stderr"]] as const) {
      stream?.on("data", (chunk: Buffer) => {
        if (target === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > STREAM_LIMIT) {
          child?.kill("SIGKILL");
          exit.reject(failure("unavailable-output-limit"));
        }
      });
    }
    const finished = await bounded(exit.promise, 8_000, "unavailable-startup-timeout");
    requireThat(finished.signal === null && finished.code !== null, "unavailable-child-signal");
    const elapsedMs = performance.now() - start;
    let projectDatabaseCount = 0;
    function inspect(path: string): void {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const nested = join(path, entry.name);
        requireThat(!entry.isSymbolicLink(), "unavailable-fixture-symlink");
        if (entry.isDirectory()) inspect(nested);
        else if (/^db\.sqlite(?:-wal|-shm)?$/u.test(entry.name)) projectDatabaseCount++;
      }
    }
    inspect(homeDir);
    const config = JSON.parse(readFileSync(join(homeDir, ".lcm", "config.json"), "utf8"));
    const daemonHealthy = existsSync(join(homeDir, ".lcm", "daemon.pid")) || /daemon started on port/iu.test(stdout + stderr);
    for (const canary of [homeDir, url.toString(), url.password, decodeURIComponent(url.username), decodeURIComponent(url.pathname.slice(1))]) {
      requireThat(canary.length > 0 && !stdout.includes(canary) && !stderr.includes(canary), "unavailable-private-output");
    }
    // Preserve raw public output for the worker's sanitizer assertion; never
    // write it to stdout or hide a missing backend identity with normalization.
    return { code: finished.code, stdout, stderr, elapsedMs, rejectedConnections,
      backend: config.storage.backend, projectDatabaseCount, daemonHealthy };
  } catch (error) { primaryError = error; throw error; }
  finally {
    let cleanupFailed = false;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      try { await bounded(childExited.promise, 2_000, "unavailable-child-cleanup"); } catch { cleanupFailed = true; }
    }
    if (listener.listening) listener.close();
    try { await bounded(closed.promise, 2_000, "unavailable-listener-cleanup"); } catch { cleanupFailed = true; }
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    if (!primaryError) requireThat(!cleanupFailed, "unavailable-cleanup");
  }
}

class FixedBackendWorker {
  private child: ChildProcess;
  private ready = deferred<ObjectValue>();
  private stopped = deferred<ObjectValue>();
  private exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  private pending?: { seq: number; scenario: string; reply: Deferred<WorkerResult> };
  private sequence = 0;
  private adminSequence = 0;
  private adminOutstanding = 0;
  private adminQueue = Promise.resolve();
  private fatal?: Error;
  private readySeen = false;
  private stopping = false;
  private stopSeen = false;
  private startupFailed = false;
  private termination?: Promise<void>;

  constructor(readonly backend: Backend, env: NodeJS.ProcessEnv, private administrator: OwnedAdministrator) {
    this.child = fork(join(process.cwd(), "test/postgresql/fixtures/surface-parity-worker.mjs"), [], {
      cwd: process.cwd(), env, execArgv: [], detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    for (const stream of [this.child.stdout, this.child.stderr]) {
      let bytes = 0;
      stream?.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > STREAM_LIMIT) this.breakProtocol("worker-stream-limit");
        // Raw child diagnostics are deliberately not copied into harness logs.
      });
    }
    this.child.on("message", message => {
      try { this.receive(message); } catch { this.breakProtocol("worker-message-contract"); }
    });
    this.child.on("error", () => this.breakProtocol("worker-process-error"));
    this.child.on("exit", (code, signal) => {
      this.exited.resolve({ code, signal });
      if (!this.startupFailed && (!this.stopping || !this.stopSeen || code !== 0 || signal !== null)) this.breakProtocol("worker-premature-exit");
    });
  }

  private groupAlive(): boolean {
    const pid = this.child.pid;
    if (pid === undefined) return false;
    try { process.kill(-pid, 0); return true; }
    catch (error) {
      requireThat((error as NodeJS.ErrnoException).code === "ESRCH", "owned-process-group-probe");
      return false;
    }
  }

  private signalGroup(signal: "SIGTERM" | "SIGKILL"): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    // detached:true establishes this fixture's fresh POSIX session/group. All
    // CLI/MCP grandchildren inherit it, so a wedged worker cannot orphan them.
    try { process.kill(-pid, signal); }
    catch (error) { requireThat((error as NodeJS.ErrnoException).code === "ESRCH", "owned-process-group-kill"); }
  }

  private async awaitGroupExit(): Promise<void> {
    const end = performance.now() + 5_000;
    while (this.groupAlive() && performance.now() < end) await delay(10);
    requireThat(!this.groupAlive(), "owned-descendants-retained");
  }

  private terminateOwnedGroup(): Promise<void> {
    this.termination ??= (async () => {
      this.signalGroup("SIGTERM");
      const graceDeadline = performance.now() + 5_000;
      while (this.groupAlive() && performance.now() < graceDeadline) await delay(10);
      if (this.groupAlive()) this.signalGroup("SIGKILL");
      if (this.child.pid !== undefined) await bounded(this.exited.promise, 10_000, "worker-kill-timeout");
      await this.awaitGroupExit();
    })();
    void this.termination.catch(() => {});
    return this.termination;
  }

  private breakProtocol(id: string, terminate = true): void {
    this.fatal ??= failure(id);
    this.ready.reject(this.fatal);
    this.stopped.reject(this.fatal);
    this.pending?.reply.reject(this.fatal);
    if (terminate) void this.terminateOwnedGroup();
  }

  private send(message: ObjectValue): void {
    requireThat(this.child.connected && !this.fatal, "worker-disconnected");
    this.child.send(message, error => { if (error) this.breakProtocol("worker-send-failed"); });
  }

  private receive(message: unknown): void {
    requireThat(object(message) && Buffer.byteLength(JSON.stringify(message)) <= IPC_LIMIT, "ipc-message-limit");
    if (message.type === "failed" && message.scenario === "startup" && !this.readySeen) {
      requireThat(exact(message, ["type", "backend", "scenario", "error"]) && message.backend === this.backend && !this.pending && !this.stopping, "startup-failure-contract");
      this.startupFailed = true;
      this.breakProtocol(`worker-startup:${this.backend}:${workerError(message.error)}`, false);
      return;
    }
    if (message.type === "ready") {
      requireThat(exact(message, ["type", "backend", "routes", "tools"]) && message.backend === this.backend && !this.readySeen && !this.pending && !this.stopping, "ready-contract");
      this.readySeen = true;
      this.ready.resolve(message);
      return;
    }
    if (message.type === "admin") {
      requireThat(exact(message, ["type", "seq", "action", "payload"]) && this.backend === "postgresql" && this.pending && !this.stopping, "admin-contract");
      requireThat(Number.isSafeInteger(message.seq) && (message.seq as number) > this.adminSequence, "admin-sequence");
      this.adminSequence = message.seq as number;
      this.adminOutstanding++;
      const scenario = this.pending.scenario;
      this.adminQueue = this.adminQueue.then(async () => {
        try {
          const result = await this.administrator.execute(message.action, message.payload, scenario);
          requireThat(Buffer.byteLength(JSON.stringify(result)) <= IPC_LIMIT / 2, "admin-result-limit");
          this.send({ type: "admin-result", seq: message.seq, result });
        } catch (error) {
          this.send({ type: "admin-failed", seq: message.seq, error: digestError(error) });
        }
      }).catch(() => this.breakProtocol("admin-channel-failed")).finally(() => { this.adminOutstanding--; });
      return;
    }
    if (message.type === "stopped") {
      requireThat(exact(message, ["type", "backend", "cleanup"]) && message.backend === this.backend && this.stopping && !this.stopSeen && !this.pending, "stopped-contract");
      this.stopSeen = true;
      this.stopped.resolve(message);
      return;
    }
    requireThat(this.pending && message.seq === this.pending.seq && message.scenario === this.pending.scenario && message.backend === this.backend && this.adminOutstanding === 0, "response-identity");
    if (message.type === "failed") {
      requireThat(exact(message, ["type", "seq", "backend", "scenario", "error"]), "failure-contract");
      this.pending.reply.reject(failure(`worker:${this.backend}:${workerError(message.error)}`));
      return;
    }
    const fault = this.pending.scenario.startsWith("fault-");
    requireThat(message.type === "result" && exact(message, ["type", "seq", "backend", "scenario", "rows", "bookkeeping", ...(fault ? ["fault"] : [])]) && Array.isArray(message.rows) && Array.isArray(message.bookkeeping), "result-contract");
    encodeBookkeeping(message.bookkeeping, this.backend);
    const expectedPhase = this.pending.scenario === "compaction" ? "compact-preview" : this.pending.scenario === "diagnostics" ? "health-readiness" : this.pending.scenario;
    requireThat(message.bookkeeping.every(tuple => Array.isArray(tuple) && tuple[0] === expectedPhase), "bookkeeping-scenario-owner");
    this.pending.reply.resolve(message as unknown as WorkerResult);
  }

  async start(): Promise<void> {
    const ready = await bounded(this.ready.promise, REQUEST_TIMEOUT, "worker-ready-timeout");
    requireThat(Array.isArray(ready.routes) && Array.isArray(ready.tools), "worker-registry-schema");
    const routes = ready.routes as Array<{ key: string }>;
    const tools = ready.tools as Array<{ name: string; description: string; inputSchema: unknown }>;
    requireThat(new Set(routes.map(row => row.key)).size === routes.length && new Set(tools.map(row => row.name)).size === tools.length, "worker-registry-duplicates");
    assertSemanticEqual([...routes].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      matrix.filter(row => row.kind === "daemon").map(row => row.registration).sort((a, b) => String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0), "ready-route-inventory");
    assertSemanticEqual([...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      matrix.filter(row => row.kind === "mcp").map(row => ({ name: row.registration.name, description: row.registration.description, inputSchema: row.registration.inputSchema }))
        .sort((a, b) => String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0), "ready-tool-inventory");
  }

  async run(scenario: string): Promise<WorkerResult> {
    requireThat(this.readySeen && !this.pending && !this.stopping && !this.fatal, "worker-run-state");
    const reply = deferred<WorkerResult>();
    this.pending = { seq: ++this.sequence, scenario, reply };
    try {
      this.send({ type: "run", seq: this.sequence, scenario });
      return await bounded(reply.promise, REQUEST_TIMEOUT, "worker-scenario-timeout");
    } catch (error) {
      if (error instanceof Error && error.message === "surface-parity-parent:worker-scenario-timeout") this.breakProtocol("worker-scenario-timeout");
      throw error;
    } finally { this.pending = undefined; }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    let graceful = false;
    try {
      if (this.startupFailed) {
        // Startup reports its bounded failure before running owned cleanup.
        // Let that cleanup finish; the final group check remains independent.
        const exit = await bounded(this.exited.promise, 20_000, "startup-cleanup-timeout");
        requireThat(exit.code === 0 && exit.signal === null, "startup-cleanup-exit");
        await this.awaitGroupExit();
        graceful = true;
        return;
      }
      requireThat(!this.fatal && !this.pending, "worker-stop-state");
      await bounded(this.adminQueue, 10_000, "admin-drain-timeout");
      this.send({ type: "stop", seq: ++this.sequence });
      const stopped = await bounded(this.stopped.promise, 20_000, "worker-stop-timeout");
      assertSemanticEqual(stopped.cleanup, { verdict: "passed" }, "worker-cleanup");
      const exit = await bounded(this.exited.promise, 10_000, "worker-exit-timeout");
      requireThat(exit.code === 0 && exit.signal === null && !this.fatal, "worker-exit-failed");
      await this.awaitGroupExit();
      graceful = true;
    } finally {
      if (!graceful) {
        await this.terminateOwnedGroup();
      }
    }
  }
}

describe.sequential("complete configured backend surface parity", () => {
  let root: string | undefined;
  let database: PostgreSqlTestDatabase | undefined;
  let administrator: OwnedAdministrator | undefined;
  let faultAuthority: { machine: RegisteredMachine; project: RemoteProject; projectPath: string } | undefined;
  const workers = new Map<Backend, FixedBackendWorker>();
  const results = new Map<Backend, Map<string, RowResult>>([["sqlite", new Map()], ["postgresql", new Map()]]);
  const faults = new Map<Backend, Map<string, Json>>([["sqlite", new Map()], ["postgresql", new Map()]]);
  const bookkeeping = new Map<Backend, Bookkeeping[]>([["sqlite", []], ["postgresql", []]]);
  function collectBookkeeping(response: WorkerResult): void {
    const combined = [...bookkeeping.get(response.backend)!, ...response.bookkeeping];
    encodeBookkeeping(combined, response.backend);
    bookkeeping.set(response.backend, combined);
  }
  let runtime: { node: string; postgres: number; extensions: [string, string][]; corpus?: CorpusCounts } | undefined;
  let hadFailure = false;

  beforeAll(async () => {
    try {
      assertSemanticEqual([...new Set(matrix.filter(row => row.scenario !== "control" && row.scenario !== "transfer").map(row => row.scenario))].sort(), [...SCENARIOS].sort(), "data-scenario-denominator");
      assertSemanticEqual(Object.keys(FAULT_ASSERTION_OWNERS).sort(), [...FAULT_SCENARIOS].sort(), "fault-scenario-denominator");
      await assertHarnessReady();
      database = await createPostgreSqlTestDatabase("surface-parity");
      await applyAllRuntimeGrants(database);
      administrator = new OwnedAdministrator(database, async () => {
        requireThat(root && database && faultAuthority, "unavailable-authority");
        return unavailableStartup(root, database, faultAuthority.machine, faultAuthority.project, faultAuthority.projectPath);
      });
      root = mkdtempSync(join(tmpdir(), "lcm-surface-parity-"));
      const paths = (backend: Backend): WorkerPaths => {
        const homeDir = join(root!, backend, "home");
        const projectPath = join(root!, backend, "projects", "primary");
        const secondaryProjectPath = join(root!, backend, "projects", "secondary");
        for (const path of [homeDir, projectPath, secondaryProjectPath, join(homeDir, ".lcm", "projects")]) mkdirSync(path, { recursive: true, mode: 0o700 });
        return { homeDir, projectPath, secondaryProjectPath };
      };
      const sqlitePaths = paths("sqlite");
      const pgPaths = paths("postgresql");
      const repository = new PostgreSqlIdentityRepository(database.migrator);
      const machine = await repository.registerMachine(`machine:${createHash("sha256").update(pgPaths.homeDir).digest("hex")}`, "Surface parity fixture");
      const primary = await repository.createProject({ machineId: machine.machineId, displayName: "Surface parity primary", path: pgPaths.projectPath, normalizedPath: resolve(pgPaths.projectPath) });
      const secondary = await repository.createProject({ machineId: machine.machineId, displayName: "Surface parity secondary", path: pgPaths.secondaryProjectPath, normalizedPath: resolve(pgPaths.secondaryProjectPath) });
      faultAuthority = { machine, project: primary, projectPath: pgPaths.projectPath };
      writeFileSync(join(pgPaths.homeDir, ".lcm", "machine.json"), JSON.stringify({ version: 1, identityKey: machine.identityKey, machineId: machine.machineId, displayName: machine.displayName }) + "\n", { mode: 0o600 });
      await publishPostgreSqlSelection(pgPaths.homeDir, machine, primary, pgPaths.projectPath);
      // The secondary binding is subsequently admitted by the worker's public
      // project-link invocation, not by rewriting the publication result.
      const server = await administrator.runtime.query<{ version: number }>({ text: "SELECT current_setting('server_version_num')::integer AS version" }, scope);
      const extensions = await administrator.runtime.query<{ name: string; version: string }>({
        text: "SELECT extname AS name,extversion AS version FROM pg_catalog.pg_extension WHERE extname=ANY($1::text[]) ORDER BY extname COLLATE \"C\"",
        values: [["pg_stat_statements", "pg_trgm", "pgcrypto", "unaccent"]],
      }, scope);
      runtime = { node: process.versions.node, postgres: server.rows[0].version, extensions: extensions.rows.map(row => [row.name, row.version]) };
      const sqliteEnv = workerEnvironment(sqlitePaths, "sqlite");
      const pgEnv = workerEnvironment(pgPaths, "postgresql", { database, primary: primary.projectId, secondary: secondary.projectId });
      initializeGitProjects(sqlitePaths);
      initializeGitProjects(pgPaths);
      workers.set("sqlite", new FixedBackendWorker("sqlite", sqliteEnv, administrator));
      workers.set("postgresql", new FixedBackendWorker("postgresql", pgEnv, administrator));
      const ready = await Promise.allSettled([...workers.values()].map(worker => worker.start()));
      const rejected = ready.find(result => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
    } catch (error) {
      hadFailure = true;
      if (error instanceof Error && /^surface-parity-parent:[a-zA-Z0-9_.:-]{1,200}$/u.test(error.message)) throw error;
      throw failure(`setup:${digestError(error).digest}`);
    }
  }, SCENARIO_TIMEOUT);

  for (const scenario of SCENARIOS) {
    it(`${scenario} executes the same declared row assertions`, async () => {
      try {
        const pair = await Promise.allSettled([workers.get("sqlite")!.run(scenario), workers.get("postgresql")!.run(scenario)]);
        const rejected = pair.find(result => result.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
        const sqlite = (pair[0] as PromiseFulfilledResult<WorkerResult>).value;
        const postgres = (pair[1] as PromiseFulfilledResult<WorkerResult>).value;
        const expectedSqlite: Record<string, unknown> = expectedSurfaceObservations("sqlite");
        const expectedPostgres: Record<string, unknown> = expectedSurfaceObservations("postgresql");
        const expectations = Object.fromEntries(matrix.filter(row => row.scenario === scenario && row.expectation === "architecture-specific").map(row => [row.id, { sqlite: expectedSqlite[row.id], postgresql: expectedPostgres[row.id] }]));
        compareBackendReports(baselineMatrix, { backend: "sqlite", scenario, rows: sqlite.rows }, { backend: "postgresql", scenario, rows: postgres.rows }, { expectations });
        if (scenario === "diagnostics") {
          requireThat(runtime && administrator, "native-corpus-runtime");
          runtime = { ...runtime, corpus: administrator.diagnosticCorpus() };
        }
        for (const response of [sqlite, postgres]) {
          const target = results.get(response.backend)!;
          for (const row of response.rows) { requireThat(!target.has(row.id), "duplicate-scenario-receipt"); target.set(row.id, row); }
          collectBookkeeping(response);
        }
      } catch (error) { hadFailure = true; throw error; }
    }, SCENARIO_TIMEOUT);
  }

  // Fault variants append only their declared assertion IDs after checking the
  // actual counterpart. A successful baseline cannot claim unexecuted faults.
  for (const scenario of FAULT_SCENARIOS) {
    it(`${scenario} preserves failure, cancellation and recovery semantics`, async () => {
      try {
        const pair = await Promise.allSettled([workers.get("sqlite")!.run(scenario), workers.get("postgresql")!.run(scenario)]);
        const rejected = pair.find(result => result.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
        for (const response of pair) {
          requireThat(response.status === "fulfilled", "fault-result-missing");
          requireThat(response.value.rows.length === 0 && response.value.fault !== undefined, "fault-response-schema");
          const { backend, fault } = response.value;
          assertSemanticEqual(fault, expectedFault(scenario, backend), "fault-counterpart-result");
          const completed = faults.get(backend)!;
          requireThat(!completed.has(scenario), "duplicate-fault-result");
          completed.set(scenario, fault);
          for (const owner of FAULT_ASSERTION_OWNERS[scenario]) {
            const row = results.get(backend)!.get(owner.id);
            const declaration = matrix.find(entry => entry.id === owner.id);
            requireThat(row && declaration && declaration.assertions.includes(owner.assertion) && !row.assertions.includes(owner.assertion), "fault-assertion-owner");
            const executed = new Set([...row.assertions, owner.assertion]);
            row.assertions = declaration.assertions.filter(assertion => executed.has(assertion));
          }
          collectBookkeeping(response.value);
        }
      } catch (error) { hadFailure = true; throw error; }
    }, SCENARIO_TIMEOUT);
  }

  afterAll(async () => {
    const workerCleanup = await Promise.allSettled([...workers.values()].map(worker => worker.stop()));
    let cleanup = workerCleanup.every(result => result.status === "fulfilled");
    try { await administrator?.cleanup(); } catch { cleanup = false; }
    try { await database?.drop(); } catch { cleanup = false; }
    if (root) {
      try { rmSync(root, { recursive: true, force: true }); cleanup &&= !existsSync(root); }
      catch { cleanup = false; }
    }
    let certificateFailure = false;
    for (const backend of ["sqlite", "postgresql"] as const) {
      try {
        const rows = [...results.get(backend)!.values()];
        if (!hadFailure) {
          if (backend === "postgresql") requireThat(runtime?.corpus, "missing-runtime-corpus");
          assertSemanticEqual(rows.map(row => row.id).sort(), matrix.filter(row => row.scenario !== "control" && row.scenario !== "transfer").map(row => row.id).sort(), "data-row-denominator");
          assertSemanticEqual([...faults.get(backend)!.keys()].sort(), [...FAULT_SCENARIOS].sort(), "fault-denominator");
          for (const scenario of SCENARIOS) assertCompleteReport(matrix, { backend, scenario, rows: rows.filter(row => matrix.find(entry => entry.id === row.id)?.scenario === scenario) });
        }
        console.log(createCertificate(matrix, {
          producer: "data", backend, cleanup, bookkeeping: bookkeeping.get(backend),
          rows: rows.map(row => ({ id: row.id, assertions: row.assertions, verdict: hadFailure ? "failed" : row.verdict, digest: semanticDigest({
            baseline: row.observation,
            faults: Object.fromEntries(FAULT_SCENARIOS.filter(scenario => FAULT_ASSERTION_OWNERS[scenario].some(owner => owner.id === row.id) && faults.get(backend)!.has(scenario))
              .map(scenario => [scenario, faults.get(backend)!.get(scenario)])),
          }) })),
          runId: process.env.LCM_TEST_POSTGRES_RUN_ID, sourceDigest: sourceDigest(),
          ...(backend === "postgresql" && runtime?.corpus ? { runtime } : {}),
        }));
      } catch { certificateFailure = true; }
    }
    requireThat(cleanup, "owned-cleanup-failed");
    requireThat(!certificateFailure, "certificate-emission-failed");
  }, SCENARIO_TIMEOUT);
});
