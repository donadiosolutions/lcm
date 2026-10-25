import { fork, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { vi } from "vitest";
import { harnessEnvironment, settings, type PostgreSqlTestDatabase } from "../harness.js";
import { appendLocalHookEvents, LocalHookDurabilityTimeoutError } from "../../../src/hooks/local-enqueue.js";
import { createBackendPublicationCoordinator } from "../../../src/storage/backend-publication-driver.js";
import { createPostgreSqlBackendPublicationRemoteGuard } from "../../../src/storage/postgresql/publication-remote-guard.js";
import { resolveMigrationDestination } from "../../../src/migration/cli-destination.js";
import { resolveMigrationActivationRuntimeSettings } from "../../../src/migration/cli-activate.js";
import { runMigrationActivation, type MigrationActivationDependencies } from "../../../src/migration/activate-generation.js";
import { readMachineIdentity } from "../../../src/machine-identity.js";
import { PostgreSqlCoordinationRepository } from "../../../src/storage/postgresql/memory-repositories.js";
import { PostgreSqlLeaseFenceError, PostgreSqlWorkCoordinator } from "../../../src/storage/postgresql/coordination.js";
import { Client } from "pg";
import { resolveMigrationExpectedIdentity, resolveMigrationPreflight } from "../../../src/migration/cli-preflight.js";
import { performMigrationApplyThroughCapture } from "../../../src/migration/apply.js";
import { performMigrationApplyGenesisAndCopy } from "../../../src/migration/apply-genesis-copy.js";
import { getMigrationReceiptEpoch, recordMigrationReceipt, type MigrationReceiptEnvelope } from "../../../src/migration/receipts.js";
import { DEFAULT_ROLLBACK_ENTRY_DEPENDENCIES, runMigrationRollbackFromHome, type RollbackEntryDependencies } from "../../../src/migration/rollback-inputs.js";
import { runMigrationRollback } from "../../../src/migration/rollback.js";
import { syncPrivateDirectory } from "../../../src/security-files.js";
import { DaemonClient, type DaemonHealth } from "../../../src/daemon/client.js";
import { PROMOTE_EVENTS_BUSY_BODY } from "../../../src/daemon/routes/promote-events.js";
import { PostgreSqlConversationRepository } from "../../../src/storage/postgresql/conversation-repository.js";
import { PostgreSqlRuntime } from "../../../src/storage/postgresql/runtime.js";
import { PassiveEventReplicationWorker, sameEnvelope } from "../../../src/daemon/passive-event-replication.js";
import { applyReplicatedPassiveEvent } from "../../../src/daemon/passive-event-replication-pass.js";
import { SQLiteLocalHookOutboxFactory, type LocalHookEventRow } from "../../../src/storage/local-hook-outbox.js";
import { PostgreSqlPassiveEventRepository, type PostgreSqlPassiveEventRecord } from "../../../src/storage/postgresql/passive-event-repository.js";
import { closeLcmConnection } from "../../../src/db/connection.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { localProjectIdentity } from "../../../src/daemon/project.js";
import { clearProjectMapCache, projectMapPath } from "../../../src/project-map.js";
import { assertBackendPublicationConsumerAccess, readBackendMaintenanceJournal, readBackendPublicationJournal } from "../../../src/storage/backend-publication.js";
import { configPath, projectsDir } from "../../../src/runtime-paths.js";
import { captureAuthenticatedSqliteMigrationSource, prepareSqliteMigrationEnrollment } from "../../../src/migration/maintenance.js";
import { prepareCutoverSet, resolveCutoverSetCandidate } from "../../../src/migration/cutover-set-prepare.js";
import { activateCutoverSet, createCutoverSetActivateDependencies, type CutoverSetActivateDependencies } from "../../../src/migration/cutover-set-activate.js";
import { createCutoverSetRollbackDependencies, rollbackCutoverSet, type CutoverSetRollbackDependencies } from "../../../src/migration/cutover-set-rollback.js";

export const MIGRATION_ROLE = "lcm_test_migrator";
export const CLI_ENTRYPOINT = join(process.cwd(), "dist/lcm.mjs");
const OUTPUT_CAP = 64 * 1024;

/** Owned child processes (pid:start ticks) spawned by this run; the post-exit receipt proves each is gone. */
export const OWNED_CHILDREN: string[] = [];
function processStart(pid: number): string {
  try {
    const stat = readFileSync("/proc/" + String(pid) + "/stat", "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "unknown";
  } catch {
    return "exited";
  }
}
function registerChild(pid: number | undefined): void {
  if (pid !== undefined && OWNED_CHILDREN.length < 4096) OWNED_CHILDREN.push(String(pid) + ":" + processStart(pid));
}

export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

/** Run a callback with HOME/USERPROFILE pointing at a private home (in-process setup helpers only). */
export async function withHome<T>(home: string, callback: () => Promise<T>): Promise<T> {
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  try {
    return await callback();
  } finally {
    closeLcmConnection();
    vi.unstubAllEnvs();
  }
}

const RUNTIME_SCRIPTS = [
  "postgresql-runtime-readiness-grants.sql",
  "postgresql-runtime-identity-grants.sql",
  "postgresql-runtime-conversation-grants.sql",
  "postgresql-runtime-summary-context-grants.sql",
  "postgresql-runtime-memory-grants.sql",
  "postgresql-runtime-search-grants.sql",
  "postgresql-runtime-coordination-grants.sql",
  "postgresql-runtime-transcript-grants.sql",
] as const;
const TRANSFER_SCRIPTS = [...RUNTIME_SCRIPTS, "postgresql-transfer-grants.sql"] as const;

export type GrantProfile = "transfer" | "runtime" | "none";

/**
 * One of a row's login roles. A single-generation row owns two: the transfer role that copy and verification use
 * (`LCM_POSTGRES_URL`) and the distinct daemon runtime role that activation proves (`LCM_POSTGRES_RUNTIME_URL`),
 * in the documented grant-first order. A set row owns the same pair: it grants the runtime profile before
 * activation proves that role, then revokes the transfer role after activation succeeds.
 */
export interface RehearsalRole {
  readonly name: string;
  readonly url: string;
  profile: GrantProfile;
}

async function applyProfile(db: PostgreSqlTestDatabase, role: string, profile: GrantProfile, signal?: AbortSignal): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    const run = (text: string, operation: string) => administrator.query({ text }, { domain: "factory", operation, ...(signal === undefined ? {} : { signal }) });
    await run("DROP OWNED BY " + role, "rehearsalRevokeRole");
    if (profile === "none") return;
    await run('GRANT CONNECT ON DATABASE "' + db.name + '" TO ' + role, "rehearsalGrantConnect");
    for (const script of profile === "transfer" ? TRANSFER_SCRIPTS : RUNTIME_SCRIPTS) {
      const sql = readFileSync(join(process.cwd(), "src/storage/postgresql/reference", script), "utf8")
        .split("\n").filter((line) => !line.startsWith("\\")).join("\n")
        .replaceAll(':"lcm_runtime_role"', '"' + role + '"')
        .replaceAll(':"lcm_transfer_role"', '"' + role + '"');
      await run(sql, "rehearsalGrant");
    }
  } finally {
    await administrator.close();
  }
}

/**
 * Create the row's dedicated login role. The caller owns the returned role from this point on, so a later provisioning
 * failure still drops it (the role is cluster-wide and outside the harness's labelled-resource audit).
 */
export async function createRole(db: PostgreSqlTestDatabase, signal?: AbortSignal): Promise<RehearsalRole> {
  const name = "lcm_rh_" + randomBytes(6).toString("hex");
  const password = randomBytes(18).toString("hex");
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  const context = (operation: string) => ({ domain: "factory" as const, operation, ...(signal === undefined ? {} : { signal }) });
  try {
    await administrator.query({ text: "CREATE ROLE " + name + " LOGIN PASSWORD '" + password + "'" }, context("rehearsalCreateRole"));
  } finally {
    await administrator.close();
  }
  const url = new URL(db.runtimeUrl);
  url.username = name;
  url.password = password;
  return { name, url: url.toString(), profile: "none" };
}

/** Both login roles of a row; a failure creating the second still drops the first (the caller owns both afterwards). */
export async function createRoles(db: PostgreSqlTestDatabase, signal?: AbortSignal): Promise<{ readonly transfer: RehearsalRole; readonly runtime: RehearsalRole }> {
  const transfer = await createRole(db, signal);
  try {
    return { transfer, runtime: await createRole(db, signal) };
  } catch (error) {
    // The creation failure is the one reported; a drop failure here would only hide it.
    try { await dropRole(db, transfer, signal); } catch { /* reported through the thrown creation failure */ }
    throw error;
  }
}

/** Give the created role the transfer profile, as an operator provisions the canonical transfer role. */
export async function provisionRole(db: PostgreSqlTestDatabase, role: RehearsalRole, signal?: AbortSignal): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    await administrator.query({ text: "REVOKE USAGE ON SCHEMA lcm FROM lcm_test_runtime" }, { domain: "factory", operation: "rehearsalRevokeBaseline", ...(signal === undefined ? {} : { signal }) });
  } finally {
    await administrator.close();
  }
  await applyProfile(db, role.name, "transfer", signal);
  role.profile = "transfer";
}

/** Replace one test role's grants with the requested profile. */
export async function swapGrants(db: PostgreSqlTestDatabase, role: RehearsalRole, profile: GrantProfile, signal?: AbortSignal): Promise<void> {
  await applyProfile(db, role.name, profile, signal);
  role.profile = profile;
}

export async function dropRole(db: PostgreSqlTestDatabase, role: RehearsalRole, signal?: AbortSignal): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    await administrator.query({ text: "DROP OWNED BY " + role.name }, { domain: "factory", operation: "rehearsalDropOwned", ...(signal === undefined ? {} : { signal }) });
    await administrator.query({ text: "DROP ROLE " + role.name }, { domain: "factory", operation: "rehearsalDropRole", ...(signal === undefined ? {} : { signal }) });
  } finally {
    await administrator.close();
  }
}

export interface RehearsalHome {
  readonly root: string;
  readonly home: string;
  readonly cwd: string;
  readonly localProjectId: string;
  readonly projectDir: string;
  readonly env: NodeJS.ProcessEnv;
}

/** The operator's shell: `LCM_POSTGRES_URL` names the transfer role; the activate-only runtime URL is present when the row has a runtime role. */
export function childEnvironment(root: string, home: string, role: RehearsalRole, runtime: RehearsalRole | null = null): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TZ: "UTC",
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_STATE_HOME: join(root, "xdg-state"), XDG_RUNTIME_DIR: join(root, "xdg-run"), TMPDIR: join(root, "tmp"),
    LCM_POSTGRES_URL: role.url, LCM_POSTGRES_CA_FILE: harnessEnvironment().LCM_TEST_POSTGRES_CA_FILE,
    LCM_POSTGRES_MIGRATION_ROLE: MIGRATION_ROLE,
    ...(runtime === null ? {} : { LCM_POSTGRES_RUNTIME_URL: runtime.url }),
  };
  for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR"]) {
    mkdirSync(environment[name]!, { recursive: true, mode: 0o700 });
  }
  return environment;
}

/** Create a private home with one project directory (no SQLite rows yet). */
/** A loopback port nothing listens on, so the restart check never observes a host daemon. */
export async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("missing loopback address");
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export function createHome(label: string, role: RehearsalRole, daemonPort: number, projectName = "project", runtime: RehearsalRole | null = null): RehearsalHome {
  const root = mkdtempSync(join(tmpdir(), "lcm-rh-" + label.toLowerCase().replace(/[^a-z0-9]+/gu, "") + "-"));
  const home = join(root, "home");
  try {
    mkdirSync(join(home, ".lcm"), { recursive: true, mode: 0o700 });
    writeFileSync(configPath(home), JSON.stringify({
      storage: { backend: "sqlite", postgresql: { migrationRole: MIGRATION_ROLE } },
      daemon: { port: daemonPort },
    }) + "\n", { mode: 0o600 });
    const env = childEnvironment(root, home, role, runtime);
    return addProject({ root, home, cwd: "", localProjectId: "", projectDir: "", env }, projectName);
  } catch (error) {
    rmSync(root, { recursive: true });
    throw error;
  }
}

/** The home of a row whose setup failed before any home was created; cleanup skips it. */
export const NO_HOME: RehearsalHome = { root: "", home: "", cwd: "", localProjectId: "", projectDir: "", env: {} };

export function addProject(base: RehearsalHome, projectName: string): RehearsalHome {
  const cwd = join(base.root, projectName);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const local = localProjectIdentity(cwd, base.home);
  const projectDir = join(projectsDir(base.home), local.id);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd }) + "\n", { mode: 0o600 });
  mkdirSync(join(base.home, ".lcm", "events"), { recursive: true, mode: 0o700 });
  clearProjectMapCache();
  return { ...base, cwd, localProjectId: local.id, projectDir };
}

/** Enrol the machine and project for receipt-era migration (the module API; no CLI exists for it). */
export async function enrollProject(h: RehearsalHome, role: RehearsalRole): Promise<void> {
  await prepareSqliteMigrationEnrollment({
    cwd: h.cwd, homeDir: h.home,
    targetConfig: { backend: "postgresql", postgresql: { ...settings(role.url), snapshotIdleTimeoutMs: settings(role.url).snapshotIdleTimeoutMs ?? 300_000, migrationRole: MIGRATION_ROLE } },
  });
}

export interface CliResult {
  readonly exitCode: number;
  readonly envelope: Record<string, unknown>;
  readonly envelopeSha256: string;
  readonly stderrSha256: string;
  readonly elapsedMs: number;
}

/** Run one real 'lcm migration' child, owning its process group to terminal close. */
export async function runCli(h: RehearsalHome, args: readonly string[], options: {
  readonly deadlineMs?: number; readonly secrets?: readonly string[]; readonly env?: NodeJS.ProcessEnv; readonly raw?: boolean;
  readonly signal?: AbortSignal;
} = {}): Promise<CliResult> {
  options.signal?.throwIfAborted();
  const started = Date.now();
  const child = spawn(process.execPath, [CLI_ENTRYPOINT, ...(options.raw === true ? args : ["migration", ...args, "--json"])], {
    cwd: h.cwd, env: options.env ?? h.env, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  registerChild(child.pid);
  const cancel = (): void => signalGroup("SIGKILL");
  options.signal?.addEventListener("abort", cancel, { once: true });
  let stdout = "";
  let stderr = "";
  let overflow = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdout.length + chunk.length > OUTPUT_CAP) { overflow = true; signalGroup("SIGKILL"); } else stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length + chunk.length > OUTPUT_CAP) { overflow = true; signalGroup("SIGKILL"); } else stderr += chunk.toString();
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; signalGroup("SIGKILL"); }, options.deadlineMs ?? 110_000);
  let outcome: { code: number | null; signal: NodeJS.Signals | null };
  try {
    outcome = await closed;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", cancel);
    signalGroup("SIGKILL");
  }
  options.signal?.throwIfAborted();
  if (child.pid !== undefined) {
    try { process.kill(-child.pid, 0); throw new Error("CLI process group survived"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  if (timedOut) throw new Error("CLI child exceeded its deadline: " + String(args[0]));
  if (overflow) throw new Error("CLI child exceeded the output cap: " + String(args[0]));
  for (const secret of [...(options.secrets ?? []), h.root]) {
    if (secret !== "" && (stdout.includes(secret) || stderr.includes(secret))) throw new Error("CLI output disclosed a private value: " + String(args[0]));
  }
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error("CLI stdout was not one JSON document: " + String(args[0]) + " exit=" + String(outcome.code) + " stderr=" + stderr.slice(-300));
  }
  return {
    exitCode: outcome.code ?? -1, envelope, envelopeSha256: sha256(stdout), stderrSha256: sha256(stderr), elapsedMs: Date.now() - started,
  };
}

export interface SeedOptions {
  readonly conversations?: number;
  readonly messagesPerConversation?: number;
  readonly withParts?: boolean;
  readonly rich?: boolean;
  readonly tiedTimestamps?: boolean;
}

const SEED_TIMESTAMP = "2026-09-06 12:00:00.123456";

/**
 * Independent native SQL seed of the project's SQLite database (no portable mapper, no migration
 * writer). The project must already be enrolled so the database exists with its receipt epoch.
 */
export function seedNative(h: RehearsalHome, options: SeedOptions = {}): { readonly records: number } {
  const conversations = options.conversations ?? 2;
  const perConversation = options.messagesPerConversation ?? 3;
  const db = new DatabaseSync(join(h.projectDir, "db.sqlite"));
  let records = 0;
  try {
    db.exec("PRAGMA busy_timeout=5000");
    runLcmMigrations(db, { fts5Available: false });
    db.exec("BEGIN");
    const insertConversation = db.prepare("INSERT INTO conversations(conversation_id,session_id,title,created_at,updated_at) VALUES(?,?,?,?,?)");
    const insertMessage = db.prepare("INSERT INTO messages(message_id,conversation_id,seq,role,content,token_count,created_at) VALUES(?,?,?,?,?,?,?)");
    const insertPart = db.prepare("INSERT INTO message_parts(part_id,message_id,session_id,part_type,ordinal,text_content) VALUES(?,?,?,'text',0,?)");
    let messageId = 0;
    for (let c = 1; c <= conversations; c += 1) {
      const session = "rehearsal-session-" + String(c).padStart(4, "0");
      const stamp = options.tiedTimestamps === true ? SEED_TIMESTAMP : "2026-09-06 12:" + String(Math.floor(c / 60) % 60).padStart(2, "0") + ":" + String(c % 60).padStart(2, "0") + ".000001";
      insertConversation.run(c, session, "Rehearsal " + String(c), stamp, stamp);
      records += 1;
      for (let m = 0; m < perConversation; m += 1) {
        messageId += 1;
        const tokens = c === 1 && m === 0 ? 9007199254740993n : BigInt(m + 1);
        insertMessage.run(messageId, c, m, m % 2 === 0 ? "user" : "assistant", "rehearsal message " + String(c) + "/" + String(m), tokens, stamp);
        records += 1;
        if (options.withParts === true) {
          insertPart.run("00000000-0000-4000-8000-" + String(messageId).padStart(12, "0"), messageId, session, "part " + String(messageId));
          records += 1;
        }
      }
    }
    if (options.rich !== false) {
      db.prepare("INSERT INTO summaries(summary_id,conversation_id,kind,depth,content,token_count,created_at) VALUES('rehearsal-leaf',1,'leaf',0,'Rehearsal leaf',3,?)").run(SEED_TIMESTAMP);
      db.prepare("INSERT INTO summaries(summary_id,conversation_id,kind,depth,content,token_count,created_at) VALUES('rehearsal-parent',1,'condensed',1,'Rehearsal parent',4,?)").run(SEED_TIMESTAMP);
      db.exec("INSERT INTO summary_messages VALUES('rehearsal-leaf',1,0); INSERT INTO summary_parents VALUES('rehearsal-parent','rehearsal-leaf',0)");
      db.prepare("INSERT INTO context_items VALUES(1,0,'message',1,NULL,?),(1,1,'summary',NULL,'rehearsal-parent',?)").run(SEED_TIMESTAMP, SEED_TIMESTAMP);
      db.prepare(
        "INSERT INTO promoted(id,content,tags,metadata,project_id,session_id,depth,confidence,created_at) VALUES(?,?,'[\"own\"]','{}',?,?,0,0.75,?),(?,?,'[]','{}',?,?,1,1,?)",
      ).run(
        "33333333-3333-4333-8333-000000000001", "Rehearsal memory one", h.localProjectId, "rehearsal-session-0001", SEED_TIMESTAMP,
        "33333333-3333-4333-8333-000000000002", "Rehearsal memory two", h.localProjectId, "rehearsal-session-0001", SEED_TIMESTAMP,
      );
      db.prepare("INSERT INTO session_instruction_cache VALUES(?,?,?,?,?,?,?,?,?)").run(
        h.localProjectId, "d".repeat(64), "codex", "rehearsal-session-0001", h.cwd, h.cwd, "rehearsal instructions", "c".repeat(64), SEED_TIMESTAMP);
      records += 8;
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return { records };
}

export type DomainDigests = Readonly<Record<string, { readonly count: number; readonly sha256: string }>>;

function digestRows(rows: readonly (readonly unknown[])[]): { count: number; sha256: string } {
  const lines = rows.map((row) => JSON.stringify(row, (_key, value) => typeof value === "bigint" ? value.toString() : value)).sort();
  return { count: lines.length, sha256: sha256(lines.join("\n")) };
}

const numeric = (value: unknown): string => Number(value).toFixed(6);

/** One canonical UTC rendering with microseconds for the SQLite text and PostgreSQL timestamptz representations. */
function normalizeTimestamp(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const text = String(value);
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|\+00(?::?00)?)?$/u.exec(text);
  if (match === null) return "unparsed:" + text;
  return match[1] + "T" + match[2] + "." + (match[3] ?? "").padEnd(6, "0").slice(0, 6) + "Z";
}

const PG_TS = "to_char(%C AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')";
const pgTs = (column: string, alias = "stamp"): string => PG_TS.replace("%C", column) + " AS " + alias;

/** Independent per-domain digests from the native SQLite tables (fixture-known identities, content, timestamps and links). */
export function sqliteDomainDigests(databasePath: string): DomainDigests {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = (sql: string): (readonly unknown[])[] =>
      (db.prepare(sql).all() as Record<string, unknown>[]).map((record) => Object.values(record));
    const stamped = (list: (readonly unknown[])[], ...columns: number[]): (readonly unknown[])[] =>
      list.map((row) => row.map((value, index) => columns.includes(index) ? normalizeTimestamp(value) : value));
    const memories = (db.prepare("SELECT id,content,depth,confidence,archived_at IS NOT NULL AS archived,created_at FROM promoted").all() as Record<string, unknown>[])
      .map((r) => [r.id, r.content, String(r.depth), numeric(r.confidence), String(Number(r.archived) === 1), normalizeTimestamp(r.created_at)]);
    return {
      conversations: digestRows(stamped(rows("SELECT session_id,title,created_at,updated_at FROM conversations"), 2, 3)),
      messages: digestRows(stamped(rows("SELECT c.session_id,CAST(m.seq AS TEXT),m.role,m.content,CAST(m.token_count AS TEXT),m.created_at FROM messages m JOIN conversations c ON c.conversation_id=m.conversation_id"), 5)),
      parts: digestRows(rows("SELECT c.session_id,CAST(m.seq AS TEXT),CAST(p.ordinal AS TEXT),p.part_id,p.part_type,p.text_content FROM message_parts p JOIN messages m ON m.message_id=p.message_id JOIN conversations c ON c.conversation_id=m.conversation_id")),
      summaries: digestRows(stamped(rows("SELECT s.summary_id,c.session_id,s.kind,CAST(s.depth AS TEXT),s.content,CAST(s.token_count AS TEXT),s.created_at FROM summaries s JOIN conversations c ON c.conversation_id=s.conversation_id"), 6)),
      summaryEdges: digestRows([
        ...rows("SELECT 'message',sm.summary_id,c.session_id || '/' || CAST(m.seq AS TEXT),CAST(sm.ordinal AS TEXT) FROM summary_messages sm JOIN messages m ON m.message_id=sm.message_id JOIN conversations c ON c.conversation_id=m.conversation_id"),
        ...rows("SELECT 'parent',summary_id,parent_summary_id,CAST(ordinal AS TEXT) FROM summary_parents"),
      ]),
      contextItems: digestRows(stamped(rows("SELECT c.session_id,CAST(i.ordinal AS TEXT),i.item_type,COALESCE((SELECT c2.session_id || '/' || CAST(m.seq AS TEXT) FROM messages m JOIN conversations c2 ON c2.conversation_id=m.conversation_id WHERE m.message_id=i.message_id),''),COALESCE(i.summary_id,''),i.created_at FROM context_items i JOIN conversations c ON c.conversation_id=i.conversation_id"), 5)),
      memories: digestRows(memories),
      instructions: digestRows(rows("SELECT scope_hash,client_name,session_id,content FROM session_instruction_cache")),
    };
  } finally {
    db.close();
  }
}

/** The same domains from PostgreSQL for the project bound to the given normalized path. */
export async function postgresDomainDigests(db: PostgreSqlTestDatabase, normalizedPath: string, signal?: AbortSignal): Promise<DomainDigests> {
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    const context = (operation: string) => ({ domain: "factory" as const, operation, ...(signal === undefined ? {} : { signal }) });
    const found = await administrator.query<{ project_id: string }>({
      text: "SELECT project_id FROM lcm.project_aliases WHERE normalized_path = $1 LIMIT 1", values: [normalizedPath],
    }, context("rehearsalFindProject"));
    const projectId = found.rows[0]?.project_id;
    if (projectId === undefined) throw new Error("rehearsal destination project is absent");
    const rows = async (text: string): Promise<(readonly unknown[])[]> => {
      signal?.throwIfAborted();
      const result = await administrator.query({ text, values: [projectId] }, context("rehearsalDigest"));
      return result.rows.map((record: Record<string, unknown>) => Object.values(record));
    };
    const memories = (await rows("SELECT memory_id,content,depth,confidence::text,(archived_at IS NOT NULL)::text," + pgTs("created_at") + " FROM lcm.promoted_memories WHERE project_id=$1"))
      .map((r) => [r[0], r[1], String(r[2]), numeric(r[3]), String(r[4] === "true"), r[5]]);
    const messageAt = "(SELECT c2.session_id || '/' || m2.seq::text FROM lcm.messages m2 JOIN lcm.conversations c2 ON c2.project_id=m2.project_id AND c2.conversation_id=m2.conversation_id WHERE m2.project_id=%P AND m2.message_id=%M)";
    return {
      conversations: digestRows(await rows("SELECT session_id,title," + pgTs("created_at", "created") + "," + pgTs("updated_at", "updated") + " FROM lcm.conversations WHERE project_id=$1")),
      messages: digestRows(await rows("SELECT c.session_id,m.seq::text,m.role,m.content,m.token_count::text," + pgTs("m.created_at") + " FROM lcm.messages m JOIN lcm.conversations c ON c.project_id=m.project_id AND c.conversation_id=m.conversation_id WHERE m.project_id=$1")),
      parts: digestRows(await rows("SELECT c.session_id,m.seq::text,p.ordinal::text,p.part_id::text,p.part_type,p.text_content FROM lcm.message_parts p JOIN lcm.messages m ON m.project_id=p.project_id AND m.conversation_id=p.conversation_id AND m.message_id=p.message_id JOIN lcm.conversations c ON c.project_id=m.project_id AND c.conversation_id=m.conversation_id WHERE p.project_id=$1")),
      summaries: digestRows(await rows("SELECT s.summary_id,c.session_id,s.kind,s.depth::text,s.content,s.token_count::text," + pgTs("s.created_at") + " FROM lcm.summaries s JOIN lcm.conversations c ON c.project_id=s.project_id AND c.conversation_id=s.conversation_id WHERE s.project_id=$1")),
      summaryEdges: digestRows([
        ...await rows("SELECT 'message' AS kind,s.summary_id AS owner,c.session_id || '/' || m.seq::text AS target,sm.ordinal::text AS position FROM lcm.summary_messages sm JOIN lcm.summaries s ON s.project_id=sm.project_id AND s.summary_key=sm.summary_key JOIN lcm.messages m ON m.project_id=sm.project_id AND m.conversation_id=sm.conversation_id AND m.message_id=sm.message_id JOIN lcm.conversations c ON c.project_id=m.project_id AND c.conversation_id=m.conversation_id WHERE sm.project_id=$1"),
        ...await rows("SELECT 'parent' AS kind,s.summary_id AS owner,p.summary_id AS target,sp.ordinal::text AS position FROM lcm.summary_parents sp JOIN lcm.summaries s ON s.project_id=sp.project_id AND s.summary_key=sp.summary_key JOIN lcm.summaries p ON p.project_id=sp.project_id AND p.summary_key=sp.parent_summary_key WHERE sp.project_id=$1"),
      ]),
      contextItems: digestRows(await rows("SELECT c.session_id AS session,i.ordinal::text AS position,i.item_type AS item,COALESCE(" + messageAt.replace("%P", "i.project_id").replace("%M", "i.message_id") + ",'') AS message,COALESCE(s.summary_id,'') AS summary," + pgTs("i.created_at") + " FROM lcm.context_items i JOIN lcm.conversations c ON c.project_id=i.project_id AND c.conversation_id=i.conversation_id LEFT JOIN lcm.summaries s ON s.project_id=i.project_id AND s.summary_key=i.summary_key WHERE i.project_id=$1")),
      memories: digestRows(memories),
      instructions: digestRows(await rows("SELECT scope_hash,client_name,session_id,content FROM lcm.session_instructions WHERE project_id=$1")),
    };
  } finally {
    await administrator.close();
  }
}

// ─── Oracles ───────────────────────────────────────────────────────────────

export interface AuthorityObservation {
  /** The backend the authenticated journals (or, with none, the config) name as last committed. */
  readonly committedBackend: string;
  /** sha256 over the authenticated journal kind and checksum, or null when no journal is present. */
  readonly journalIdentitySha256: string | null;
  readonly configBackend: string;
  readonly boundProjects: number;
  readonly maintenancePhase: string | null;
  readonly publicationPhase: string | null;
  readonly publicationTarget: string | null;
  readonly admitted: readonly string[];
}

function admits(home: string, backend: "sqlite" | "postgresql"): boolean {
  // A live daemon's background sweep can hold the publication mutation lock for a moment; that contention is not an admission
  // verdict, so it is awaited for a bounded time (10 s) and any other refusal is the answer.
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      assertBackendPublicationConsumerAccess({ backend, homeDir: home });
      return true;
    } catch (error) {
      const contended = error instanceof Error && /mutation is already in progress/u.test(error.message);
      if (!contended || Date.now() > deadline) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/** I1: durable authority from the authenticated journals, the config and the project map, plus independent consumer admission. */
export function readAuthority(h: RehearsalHome): AuthenticatedAuthority {
  const config = JSON.parse(readFileSync(configPath(h.home), "utf8")) as { storage?: { backend?: string } };
  let map: Record<string, { remoteProjectId?: string }> = {};
  try { map = JSON.parse(readFileSync(projectMapPath(h.home), "utf8")) as typeof map; } catch { /* absent map */ }
  let maintenance: ReturnType<typeof readBackendMaintenanceJournal> = null;
  let maintenancePhase: string | null = null;
  try { maintenance = readBackendMaintenanceJournal(h.home); maintenancePhase = maintenance?.phase ?? null; } catch { maintenancePhase = "unreadable"; }
  let publication: ReturnType<typeof readBackendPublicationJournal> = null;
  let publicationPhase: string | null = null;
  let publicationTarget: string | null = null;
  try {
    publication = readBackendPublicationJournal(h.home);
    publicationPhase = publication?.phase ?? null;
    publicationTarget = publication?.targetBackend ?? null;
  } catch { publicationPhase = "unreadable"; }
  // The journal slot holds either a maintenance hold or a publication; each reader is authenticated and refuses the other kind.
  // A hold's committed backend is the one selected when it was entered, except a completed selection; a publication commits at completed.
  let committedBackend = config.storage?.backend ?? "sqlite";
  let journalIdentitySha256: string | null = null;
  if (maintenance !== null) {
    committedBackend = maintenance.phase === "selection-completed" ? (maintenance.targetBackend ?? maintenance.sourceBackend) : maintenance.sourceBackend;
    journalIdentitySha256 = sha256("maintenance\0" + maintenance.checksumSha256);
  } else if (publication !== null) {
    committedBackend = publication.phase === "completed" ? publication.targetBackend : publication.sourceBackend;
    journalIdentitySha256 = sha256("publication\0" + publication.checksumSha256);
  } else if (maintenancePhase === "unreadable" && publicationPhase === "unreadable") {
    committedBackend = "unreadable";
  }
  const admitted = (["sqlite", "postgresql"] as const).filter((backend) => admits(h.home, backend));
  return {
    committedBackend, journalIdentitySha256,
    configBackend: config.storage?.backend ?? "sqlite",
    boundProjects: Object.values(map).filter((entry) => entry.remoteProjectId !== undefined).length,
    maintenancePhase, publicationPhase, publicationTarget, admitted,
  };
}
export type AuthenticatedAuthority = AuthorityObservation;

export interface ArtifactWitness { readonly path: string; readonly sha256: string; readonly bytes: number }

function walk(root: string, directory: string, out: ArtifactWitness[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(root, full, out);
    else if (entry.isFile()) {
      const bytes = readFileSync(full);
      out.push({ path: relative(root, full), sha256: sha256(bytes), bytes: bytes.length });
    }
  }
}

/** I2: raw descriptor-free hashes of every sealed snapshot / evidence file of a generation (never opened as databases). */
export function sealedArtifacts(h: RehearsalHome, generation: string): readonly ArtifactWitness[] {
  const out: ArtifactWitness[] = [];
  for (const area of ["migration-snapshots/generations", "migration-evidence"]) {
    const directory = join(h.home, ".lcm", area, generation);
    if (existsSync(directory)) walk(join(h.home, ".lcm"), directory, out);
  }
  return out;
}

export function artifactSetSha256(artifacts: readonly ArtifactWitness[]): string {
  return sha256(artifacts.map((a) => a.path + "\0" + a.sha256 + "\0" + String(a.bytes)).join("\n"));
}

/** I6: tear a home down and prove it absent. */
export function removeHome(h: RehearsalHome): boolean {
  if (h.root === "") return true; // setup failed before the home existed
  closeLcmConnection();
  rmSync(h.root, { recursive: true });
  return !existsSync(h.root);
}

// ─── Manifest, case runner and evidence ────────────────────────────────────

export type Verdict = "pass" | "pass-with-documented-limits" | "fail" | "incomplete";
export interface StepSpec {
  readonly id: string;
  readonly use?: string;
  readonly surface?: "cli" | "module-seam";
  readonly args?: readonly string[];
  readonly exit?: number;
  readonly outcome?: string;
  readonly reason?: string | null;
  readonly next?: string | null;
  readonly manifestPhase?: string | null;
  readonly applied?: boolean;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly restartAnswer?: string | null;
  readonly deadlineMs?: number;
  readonly note?: string;
}
export interface AuthoritySpec {
  readonly checkpoint: string;
  readonly lastCommittedBackend: "sqlite" | "postgresql";
  readonly configBackend?: string;
  readonly admitted: readonly string[];
  readonly boundProjects?: number;
  readonly note?: string;
}
export interface KnownLimit {
  readonly issue: string;
  readonly expectedRefusal: string;
  readonly preservedAuthority: string;
  readonly safetyEvidence: string;
  readonly unavailable: string;
}
export interface ScenarioSpec {
  readonly id: string;
  readonly title: string;
  readonly fixture: string;
  readonly profiles: readonly ("default" | "full")[];
  readonly timeoutMs: number;
  readonly requirement: string;
  readonly supportingTests: readonly string[];
  readonly steps: readonly StepSpec[];
  readonly injections: readonly { readonly surface: string; readonly boundary: string; readonly kind: string; readonly note?: string }[];
  readonly authority: readonly AuthoritySpec[];
  readonly invariants: Readonly<Record<"I1" | "I2" | "I3" | "I4" | "I5" | "I6", string>>;
  readonly knownLimits: readonly KnownLimit[];
  readonly notes?: string;
  /** A row whose success depends on an unmerged fix is listed but not generated until the gate is removed. */
  readonly gate?: { readonly status: "pending"; readonly pendingOn: readonly string[] };
}
export interface Manifest {
  readonly schemaVersion: 1;
  readonly workload: {
    readonly workers: 1;
    readonly profiles: Readonly<Record<string, unknown>>;
    readonly bounds: {
      readonly largeFixture: {
        readonly conversations: number; readonly messagesPerConversation: number; readonly otherRecords: number;
        readonly plannedRecords: number; readonly maxPortableRecords: number;
      };
      readonly aliasFixture: { readonly aliasPathsPerProject: number };
      readonly maxHookEventsPerRow: number;
    } & Readonly<Record<string, unknown>>;
    readonly thresholds: Readonly<Record<string, unknown>>;
  };
  readonly templates: readonly StepSpec[];
  readonly scenarios: readonly ScenarioSpec[];
}

export const MANIFEST_PATH = join(process.cwd(), "test/postgresql/cutover-rehearsal/scenarios.json");
export function loadManifest(): { readonly manifest: Manifest; readonly sha256: string } {
  const bytes = readFileSync(MANIFEST_PATH);
  return { manifest: JSON.parse(bytes.toString("utf8")) as Manifest, sha256: sha256(bytes) };
}

export function activeProfile(): "default" | "full" {
  return process.env.LCM_TEST_POSTGRES_CUTOVER_REHEARSAL === "true" ? "full" : "default";
}

export interface RecordedStep {
  readonly id: string;
  readonly surface: string;
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly outcome: string | null;
  readonly reason: string | null;
  readonly envelopeSha256: string | null;
  readonly checkpointRef: string | null;
}
export interface InvariantRecord { status: "pass" | "fail" | "not-applicable"; evidenceRefs: string[]; reason?: string }

const CLOSED_OUTCOMES: Readonly<Record<number, string>> = Object.freeze({
  0: "ok", 1: "usage", 2: "refused-precondition", 3: "refused-confirmation", 4: "refused-contention",
  5: "refused-evidence", 6: "incomplete-recoverable", 7: "failed-operator-required", 8: "restart-required",
});

function sameJson(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

/** One scenario's executable context: manifest-pinned steps, authority checkpoints, oracles and evidence. */
export class RehearsalCase {
  readonly vars: Record<string, string> = {};
  readonly steps: RecordedStep[] = [];
  readonly authorities: Record<string, unknown>[] = [];
  readonly injections: Record<string, unknown>[] = [];
  readonly invariants: Record<string, InvariantRecord> = {};
  readonly artifacts: ArtifactWitness[] = [];
  readonly canonicalDomainDigests: { label: string; domains: DomainDigests }[] = [];
  readonly secrets: string[];
  private seals: { generation: string; artifacts: readonly ArtifactWitness[] }[] = [];
  second: RehearsalHome | null = null;
  /** The scenario's execution budget: aborted before Vitest's own timeout so cleanup can still finish. */
  signal: AbortSignal = new AbortController().signal;
  /** Cleanup problems recorded instead of suppressed. */
  readonly cleanupProblems: string[] = [];
  /** Throws when the scenario budget is spent. */
  checkpoint(): void { this.signal.throwIfAborted(); }
  /** One administrative statement in the isolated database, bound to the scenario budget. */
  sql(text: string, values: unknown[] = []): Promise<Record<string, unknown>[]> { return adminSql(this.db, text, values, this.signal); }
  private started = Date.now();

  constructor(
    readonly spec: ScenarioSpec,
    readonly manifest: Manifest,
    readonly db: PostgreSqlTestDatabase,
    /** The transfer role used through verification and revoked after activation. */
    readonly role: RehearsalRole,
    /** The distinct daemon runtime role granted before and proved by activation. */
    readonly runtime: RehearsalRole,
    public h: RehearsalHome,
  ) {
    this.secrets = [role.url, new URL(role.url).password, runtime.url, new URL(runtime.url).password];
    this.operator = role;
  }

  /** The role the operator's `LCM_POSTGRES_URL` names now: the transfer role until a single-generation activation hands over to the runtime role. */
  operator: RehearsalRole;

  get gen(): string { return this.vars.gen!; }

  private resolve(id: string): StepSpec {
    const own = this.spec.steps.find((step) => step.id === id);
    if (own === undefined) throw new Error("scenario " + this.spec.id + " has no manifest step " + id);
    if (own.use === undefined) return own;
    const base = this.manifest.templates.find((template) => template.id === own.use);
    if (base === undefined) throw new Error("manifest has no template " + own.use);
    return { ...base, ...own, id };
  }

  private expand(args: readonly string[]): string[] {
    return args.map((arg) => arg.replace(/\{([a-zA-Z0-9]+)\}/gu, (_m, name: string) => {
      const value = this.vars[name];
      if (value === undefined) throw new Error("unbound step variable " + name);
      return value;
    }));
  }

  /** Run one manifest-pinned real CLI step against the given home and assert its pinned outcome exactly. */
  async step(id: string, home: RehearsalHome = this.h, extra: { readonly env?: NodeJS.ProcessEnv; readonly deadlineMs?: number } = {}): Promise<CliResult> {
    const spec = this.resolve(id);
    if (spec.args === undefined || spec.exit === undefined) throw new Error("incomplete manifest step " + id);
    const args = this.expand(spec.args);
    const result = await runCli(home, args, { secrets: this.secrets, env: extra.env, deadlineMs: extra.deadlineMs ?? spec.deadlineMs, signal: this.signal });
    const envelope = result.envelope;
    const refusal = envelope.refusal as { reason?: string } | null;
    const observed = {
      exit: result.exitCode, outcome: envelope.outcome as string, reason: refusal?.reason ?? null,
    };
    const failures: string[] = [];
    if (result.exitCode !== spec.exit) failures.push("exit " + String(result.exitCode) + " != " + String(spec.exit));
    if (envelope.exitCode !== result.exitCode) failures.push("envelope exitCode " + String(envelope.exitCode));
    if (envelope.outcome !== CLOSED_OUTCOMES[spec.exit]) failures.push("outcome " + String(envelope.outcome));
    if (spec.outcome !== undefined && envelope.outcome !== spec.outcome) failures.push("pinned outcome " + String(envelope.outcome));
    if ((spec.reason ?? null) !== observed.reason) failures.push("reason " + String(observed.reason) + " != " + String(spec.reason ?? null));
    if (spec.next !== undefined && envelope.next !== spec.next) failures.push("next " + String(envelope.next) + " != " + String(spec.next));
    if (spec.manifestPhase !== undefined && envelope.manifestPhase !== spec.manifestPhase) failures.push("manifestPhase " + String(envelope.manifestPhase));
    if (spec.applied !== undefined && envelope.applied !== spec.applied) failures.push("applied " + String(envelope.applied));
    if (spec.restartAnswer !== undefined) {
      const answer = (envelope.restart as { answer?: string } | null)?.answer ?? null;
      if (answer !== spec.restartAnswer) failures.push("restart " + String(answer));
    }
    for (const [key, value] of Object.entries(spec.evidence ?? {})) {
      const actual = (envelope.evidence as Record<string, unknown>)[key];
      if (!sameJson(actual, value)) failures.push("evidence." + key + "=" + JSON.stringify(actual));
    }
    this.steps.push({
      id, surface: "cli", command: spec.args, exitCode: result.exitCode, outcome: envelope.outcome as string,
      reason: observed.reason, envelopeSha256: result.envelopeSha256, checkpointRef: null,
    });
    if (failures.length > 0) {
      throw new Error("manifest step " + this.spec.id + "/" + id + " deviated: " + failures.join("; ")
        + " | envelope=" + JSON.stringify(envelope).slice(0, 1200));
    }
    return result;
  }

  /** A non-migration operator command that prints one JSON document (for example 'events promote --json'). */
  async rawCli(id: string, args: readonly string[], expectedExit: number, home: RehearsalHome = this.h): Promise<Record<string, unknown>> {
    const result = await runCli(home, args, { raw: true, secrets: this.secrets, signal: this.signal });
    this.steps.push({ id, surface: "cli", command: args, exitCode: result.exitCode, outcome: null, reason: null, envelopeSha256: result.envelopeSha256, checkpointRef: null });
    if (result.exitCode !== expectedExit) {
      throw new Error("command " + id + " exited " + String(result.exitCode) + " != " + String(expectedExit) + " | " + JSON.stringify(result.envelope).slice(0, 600));
    }
    return result.envelope;
  }

  /** Record a setup / injected step that is not an operator command. */
  note(id: string, surface: string, command: readonly string[]): void {
    this.steps.push({ id, surface, command, exitCode: null, outcome: null, reason: null, envelopeSha256: null, checkpointRef: null });
  }

  /** I1: the pinned authority checkpoint, with independent consumer admission. */
  authority(checkpoint: string, home: RehearsalHome = this.h): AuthenticatedAuthority {
    this.checkpoint();
    const expected = this.spec.authority.find((entry) => entry.checkpoint === checkpoint);
    if (expected === undefined) throw new Error("scenario " + this.spec.id + " has no authority checkpoint " + checkpoint);
    const observed = readAuthority(home);
    const failures: string[] = [];
    if (observed.admitted.length > 1) failures.push("mixed admission " + observed.admitted.join(","));
    if (!sameJson([...observed.admitted].sort(), [...expected.admitted].sort())) failures.push("admitted " + observed.admitted.join(",") + " != " + expected.admitted.join(","));
    if (observed.committedBackend !== expected.lastCommittedBackend) failures.push("committed backend " + observed.committedBackend + " != " + expected.lastCommittedBackend);
    if (expected.configBackend !== undefined && observed.configBackend !== expected.configBackend) failures.push("config " + observed.configBackend);
    if (expected.boundProjects !== undefined && observed.boundProjects !== expected.boundProjects) failures.push("bound " + String(observed.boundProjects));
    this.authorities.push({
      checkpoint, lastCommittedBackend: observed.committedBackend, journalIdentitySha256: observed.journalIdentitySha256,
      consumerAdmission: observed.admitted.length === 0 ? "fenced" : "admitted",
      witnesses: [observed.configBackend, observed.maintenancePhase ?? "none", observed.publicationPhase ?? "none"],
    });
    this.invariants.I1 ??= { status: "pass", evidenceRefs: [] };
    if (failures.length > 0) this.invariants.I1.status = "fail";
    else this.invariants.I1.evidenceRefs.push(checkpoint + ":" + observed.committedBackend);
    if (failures.length > 0) throw new Error("authority " + this.spec.id + "/" + checkpoint + ": " + failures.join("; ") + " observed=" + JSON.stringify(observed));
    return observed;
  }

  /** I2: capture the sealed baseline of one or more generations, then prove every sealed file is still byte-identical. */
  sealBaseline(...generations: string[]): void {
    const wanted = generations.length === 0 ? [this.gen] : generations;
    this.seals = wanted.map((generation) => ({ generation, artifacts: sealedArtifacts(this.h, generation) }));
    if (this.seals.some((seal) => seal.artifacts.length === 0)) throw new Error("no sealed artifacts for " + wanted.join(","));
    this.artifacts.splice(0, this.artifacts.length, ...this.seals.flatMap((seal) => seal.artifacts).slice(0, 64));
  }

  /** With replacedAside, the snapshot generation directory was swapped for an empty one: its original bytes must be intact beside it. */
  sealCheck(label: string, home: RehearsalHome = this.h, injected: readonly string[] = [], replacedAside = false): void {
    if (this.seals.length === 0) throw new Error("seal baseline not captured");
    const changed: string[] = [];
    for (const seal of this.seals) {
      const now = new Map(sealedArtifacts(home, seal.generation).map((a) => [a.path, a.sha256]));
      if (replacedAside) {
        const aside: ArtifactWitness[] = [];
        walk(join(home.home, ".lcm"), join(home.home, ".lcm", "migration-snapshots", "generations", seal.generation + ".original"), aside);
        for (const a of aside) now.set(a.path.replace(seal.generation + ".original/", seal.generation + "/"), a.sha256);
      }
      changed.push(...seal.artifacts.filter((a) => now.get(a.path) !== a.sha256 && !injected.some((name) => a.path.endsWith("/" + name))).map((a) => a.path));
    }
    this.invariants.I2 ??= { status: "pass", evidenceRefs: [] };
    this.invariants.I2.evidenceRefs.push(label + ":" + artifactSetSha256(this.seals.flatMap((seal) => seal.artifacts)).slice(0, 16));
    if (changed.length > 0) {
      this.invariants.I2.status = "fail";
      throw new Error("I2 sealed artifacts changed at " + label + ": " + String(changed.length));
    }
  }

  /** I4: canonical per-domain digests must be identical between two independent native reads. */
  compareDomains(label: string, expected: DomainDigests, actual: DomainDigests): void {
    this.checkpoint();
    this.canonicalDomainDigests.push({ label, domains: actual });
    this.invariants.I4 ??= { status: "pass", evidenceRefs: [] };
    this.invariants.I4.evidenceRefs.push(label);
    const mismatched = Object.keys(expected).filter((domain) => !sameJson(expected[domain], actual[domain]));
    if (mismatched.length > 0) {
      this.invariants.I4.status = "fail";
      throw new Error("I4 canonical data differs at " + label + ": " + mismatched.join(","));
    }
  }

  mark(invariant: "I1" | "I2" | "I3" | "I4" | "I5" | "I6", ref: string): void {
    this.invariants[invariant] ??= { status: "pass", evidenceRefs: [] };
    this.invariants[invariant]!.evidenceRefs.push(ref);
  }

  /**
   * I6 for this scenario: private homes are removed and proven absent, and the owned role is dropped and proven absent.
   * Every failure is recorded (never suppressed) and never prevents the remaining steps.
   */
  async cleanup(signal?: AbortSignal): Promise<void> {
    // Cleanup runs on its own bounded budget: the execution budget may already be spent.
    if (signal !== undefined) this.signal = signal;
    const homes = [this.h, ...this.extraHomes];
    const roots = homes.map((home) => home.root);
    const absent: boolean[] = [];
    for (const home of homes) {
      try { absent.push(removeHome(home)); } catch (error) { absent.push(false); this.cleanupProblems.push("home removal failed: " + (error instanceof Error ? error.name : "error")); }
    }
    let rolesAbsent = 0;
    for (const role of [this.role, this.runtime]) {
      try { await dropRole(this.db, role, this.signal); } catch (error) { this.cleanupProblems.push("role drop failed: " + (error instanceof Error ? error.name : "error")); }
      try {
        if ((await this.sql("SELECT 1 AS present FROM pg_catalog.pg_roles WHERE rolname = $1", [role.name])).length === 0) rolesAbsent += 1;
      } catch (error) { this.cleanupProblems.push("role absence query failed: " + (error instanceof Error ? error.name : "error")); }
    }
    if (rolesAbsent !== 2) this.cleanupProblems.push("an owned role is still present");
    if (!absent.every(Boolean)) this.cleanupProblems.push("a private home is still present");
    this.homeRoots.push(...roots.filter((root) => root !== ""));
    this.invariants.I6 = {
      status: this.cleanupProblems.length === 0 ? "pass" : "fail",
      evidenceRefs: ["homes-absent:" + String(absent.length), "owned-roles-absent:" + String(rolesAbsent) + "/2"],
      ...(this.cleanupProblems.length === 0 ? {} : { reason: this.cleanupProblems.join("; ").slice(0, 280) }),
    };
  }
  readonly homeRoots: string[] = [];

  /** One bounded awaited drain request to the running daemon: the same POST that 'lcm events promote' issues. */
  async promote(daemon: RunningDaemon, id: string): Promise<Record<string, unknown>> {
    // The daemon's own background sweep can hold the publication lock; the route answers 503 with
    // PROMOTE_EVENTS_BUSY_BODY. One awaited retry is allowed for exactly that answer; any other failure is fatal.
    const request = (): Promise<Record<string, unknown>> => daemon.client.post<Record<string, unknown>>("/promote-events", { cwd: this.h.cwd, drain: true }, { timeoutMs: 60_000 });
    let retried = false;
    let result: Record<string, unknown>;
    try {
      result = await request();
    } catch (error) {
      if (!(error instanceof Error) || (error as Error & { statusCode?: number }).statusCode !== 503 || error.message !== PROMOTE_EVENTS_BUSY_BODY.error) throw error;
      retried = true;
      result = await request();
    }
    this.steps.push({ id, surface: "http", command: ["POST", "/promote-events", "drain", retried ? "retried-once-after-lock-contention" : "single-request"], exitCode: null, outcome: null, reason: null, envelopeSha256: sha256(JSON.stringify(result)), checkpointRef: null });
    return result;
  }

  /** Run the foreground daemon for the callback with the case's disclosure secrets. */
  daemon<T>(callback: (daemon: RunningDaemon) => Promise<T>, options: { readonly env?: NodeJS.ProcessEnv } = {}): Promise<T> {
    return withDaemon(this.h, this.daemonPort, callback, { ...options, secrets: this.secrets, signal: this.signal });
  }

  extraHomes: RehearsalHome[] = [];
  daemonPort = 0;
  readonly ledger: LedgerEntry[] = [];
  readonly mutations: MutationEntry[] = [];

  /**
   * Finalize I1-I6 once and choose the verdict from them. A required invariant must have been asserted and passed; a
   * not-applicable one carries the manifest's reason. Any problem (or a thrown failure) makes the verdict fail, so a
   * required invariant that was never asserted can no longer ride along with a passing row.
   */
  record(failure?: string): { readonly record: Record<string, unknown>; readonly problems: string[] } {
    const invariants: Record<string, InvariantRecord> = {};
    const problems: string[] = [];
    for (const key of ["I1", "I2", "I3", "I4", "I5", "I6"] as const) {
      const declared = this.spec.invariants[key];
      const asserted = this.invariants[key];
      if (declared.startsWith("na:")) {
        // The manifest's declaration decides: a not-applicable invariant stays not-applicable (a later mark() cannot turn it into
        // a pass) unless the row actually failed it, and a row that asserts an invariant it declared not applicable is inconsistent.
        invariants[key] = asserted?.status === "fail" ? asserted : { status: "not-applicable", evidenceRefs: [], reason: declared.slice(3) };
        if (asserted?.status === "pass") problems.push(key + ":asserted although the manifest declares it not applicable");
      } else if (asserted === undefined) {
        invariants[key] = { status: "fail", evidenceRefs: [], reason: "not asserted" };
      } else {
        invariants[key] = asserted;
      }
      if (invariants[key]!.status === "fail") problems.push(key + ":" + (invariants[key]!.reason ?? "failed"));
    }
    const verdict: Verdict = failure !== undefined || problems.length > 0 ? "fail" : this.spec.knownLimits.length > 0 ? "pass-with-documented-limits" : "pass";
    return {
      problems,
      record: {
        id: this.spec.id, fixture: this.spec.fixture, parameters: {}, supportingTests: this.spec.supportingTests,
        steps: this.steps, injections: this.injections, authority: this.authorities, invariants,
        // The disclosure scan runs on every command step; it is evidence, not an I5 assertion.
        disclosureScan: { cliSteps: this.steps.filter((step) => step.surface === "cli" && step.exitCode !== null).length },
        acknowledgedInputDigest: this.acknowledgedInputDigest(),
        canonicalDomainDigests: this.canonicalDomainDigests.map((entry) => ({ label: entry.label, domains: entry.domains })),
        knownLimits: this.spec.knownLimits, artifacts: this.artifacts, elapsedMs: Date.now() - this.started,
        verdict, ...(failure === undefined ? {} : { failure: failure.slice(0, 600) }),
      },
    };
  }

  /** The deterministic digest of the acknowledged-input ledger (scoped events and explicit mutations), sorted. */
  acknowledgedInputDigest(): string {
    const events = this.ledger.map((entry) => ["event", entry.projectId, entry.machineId, entry.eventUuid, entry.machineSequence, entry.envelopeSha256].join("\0"));
    const mutations = this.mutations.map((entry) => ["mutation", entry.domain, entry.identitySha256, entry.beforeSha256, entry.afterSha256].join("\0"));
    return sha256([...events, ...mutations].sort().join("\n"));
  }
}

export function evidenceDirectory(): string | null {
  const directory = process.env.LCM_MIGRATION_REHEARSAL_EVIDENCE_DIR;
  return directory === undefined || directory === "" ? null : directory;
}

export function writeEvidence(file: string, value: unknown): void {
  const directory = evidenceDirectory();
  if (directory === null) return;
  mkdirSync(join(directory, "scenarios"), { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, file), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

// ─── Foreground daemon (private, owned process group) ─────────────────────

/** The daemon process exited by itself before it reported ready (a start refusal, not a timeout). */
export class DaemonExitedBeforeReady extends Error {
  constructor(readonly exitCode: number | null) { super("daemon exited before ready"); this.name = "DaemonExitedBeforeReady"; }
}

export interface RunningDaemon {
  readonly port: number;
  readonly pid: number;
  readonly health: DaemonHealth;
  readonly client: DaemonClient;
}

async function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (listening: boolean): void => { socket.destroy(); resolve(listening); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

/** Run the installed CLI daemon in the foreground for the callback, then prove its process group and port are gone. */
export async function withDaemon<T>(
  h: RehearsalHome, port: number, callback: (daemon: RunningDaemon) => Promise<T>,
  options: { readonly env?: NodeJS.ProcessEnv; readonly deadlineMs?: number; readonly secrets?: readonly string[]; readonly signal?: AbortSignal } = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  const child = spawn(process.execPath, [CLI_ENTRYPOINT, "daemon", "start", "--foreground"], {
    cwd: h.cwd, env: options.env ?? h.env, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  registerChild(child.pid);
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  // A fenced daemon logs on every sweep: keep a bounded prefix for the readiness and disclosure checks and discard the rest.
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk: Buffer) => {
      if (output.length < OUTPUT_CAP) output += chunk.toString().slice(0, OUTPUT_CAP - output.length);
    });
  }
  let exitCode: number | null = null;
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => { exitCode = code; resolve(); });
  });
  let exited = false;
  void closed.then(() => { exited = true; });
  const deadline = setTimeout(() => signalGroup("SIGKILL"), options.deadlineMs ?? 90_000);
  const cancel = (): void => signalGroup("SIGKILL");
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const tokenPath = join(h.home, ".lcm", "daemon.token");
    let started: { client: DaemonClient; health: DaemonHealth } | null = null;
    for (let attempt = 0; attempt < 300 && !exited && started === null; attempt += 1) {
      if (output.includes("lcm daemon started on port " + String(port)) && existsSync(tokenPath)) {
        const client = new DaemonClient("http://127.0.0.1:" + String(port), tokenPath);
        const health = await client.health({ signal: AbortSignal.timeout(1000) });
        if (health?.status === "ok") started = { client, health };
      }
      if (started === null) await delay(100);
    }
    if (started === null) {
      if (exited) throw new DaemonExitedBeforeReady(exitCode);
      throw new Error("rehearsal daemon did not become healthy: " + sha256(output).slice(0, 12));
    }
    return await callback({ port, pid: child.pid!, health: started.health, client: started.client });
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", cancel);
    signalGroup("SIGTERM");
    const backstop = setTimeout(() => signalGroup("SIGKILL"), 5000);
    try { await closed; } finally { clearTimeout(backstop); signalGroup("SIGKILL"); }
    for (const target of [child.pid!, -child.pid!]) {
      try { process.kill(target, 0); throw new Error("daemon process group survived"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    for (const secret of [...new Set(["rehearsal message", ...(options.secrets ?? [])])]) {
      if (output.includes(secret)) throw new Error("daemon output disclosed a private value");
    }
    if (await portListening(port)) throw new Error("daemon port still listening");
  }
}

// ─── Case helpers: guarded write, administrative mutation, snapshot damage ──

/** Run one administrative statement in the case's isolated database (the injected, unguarded mutation). */
export async function adminSql(db: PostgreSqlTestDatabase, text: string, values: unknown[] = [], signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    return (await administrator.query({ text, values }, { domain: "factory", operation: "rehearsalAdminSql", ...(signal === undefined ? {} : { signal }) })).rows as Record<string, unknown>[];
  } finally {
    await administrator.close();
  }
}

export async function destinationProjectId(db: PostgreSqlTestDatabase, cwd: string, signal?: AbortSignal): Promise<string> {
  const rows = await adminSql(db, "SELECT project_id FROM lcm.project_aliases WHERE normalized_path = $1 LIMIT 1", [cwd], signal);
  const id = rows[0]?.project_id;
  if (typeof id !== "string") throw new Error("rehearsal destination project is absent");
  return id;
}

/** A canonical write through the project-guarded repository under the role the operator now holds (the runtime role after the handover). */
export async function guardedWrite(c: RehearsalCase, sessionId: string): Promise<void> {
  const runtime = new PostgreSqlRuntime(settings(c.operator.url));
  try {
    const projectId = await destinationProjectId(c.db, c.h.cwd, c.signal);
    const repository = new PostgreSqlConversationRepository(runtime, projectId);
    recordConversationWrite(c, projectId, await repository.createConversation({ sessionId }));
  } finally {
    await runtime.close();
  }
}

/** Damage a sealed snapshot file in place (same inode) or replace it by an identical copy (new inode). */
export function damageSnapshot(h: RehearsalHome, generation: string, file: string, how: "tamper" | "replace"): void {
  const path = join(h.home, ".lcm", "migration-snapshots", "generations", generation, file);
  const bytes = readFileSync(path);
  if (how === "tamper") {
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 0xff;
    const mode = statSync(path).mode & 0o777;
    chmodSync(path, 0o600);
    writeFileSync(path, changed);
    chmodSync(path, mode);
  } else {
    const generations = join(h.home, ".lcm", "migration-snapshots", "generations");
    renameSync(join(generations, generation), join(generations, generation + ".original"));
    mkdirSync(join(generations, generation), { mode: 0o700 });
  }
}

// ─── Acknowledged-input ledger (I3) ────────────────────────────────────────

export interface LedgerEntry {
  readonly projectId: string; readonly machineId: string; readonly eventUuid: string;
  readonly machineSequence: string; readonly envelopeSha256: string; readonly data: string;
}
/** A non-event acknowledged input: an explicit guarded mutation or a native instruction, with before/after content digests. */
export interface MutationEntry {
  readonly domain: "conversation" | "instruction"; readonly identitySha256: string; readonly locator: string;
  readonly beforeSha256: string; readonly afterSha256: string;
}
/** The local sidecar row exactly as the production outbox reads it (SELECT *), so production comparisons accept it. */
export type EventRow = LocalHookEventRow;

/** One canonical instant for the SQLite text form ("YYYY-MM-DD HH:MM:SS", UTC) and the ISO form; null when unparsable. */
export function instantOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const iso = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value) ? value : value.replace(" ", "T") + "Z";
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** The canonical envelope digest: identity, version, sequence, session facts, content and the creation instant. */
export function canonicalEnvelopeSha256(fields: {
  readonly eventUuid: string; readonly eventVersion: number; readonly machineSequence: string | bigint; readonly sessionId: unknown;
  readonly sessionSequence: unknown; readonly type: unknown; readonly category: unknown; readonly data: unknown; readonly priority: unknown;
  readonly sourceHook: unknown; readonly createdAt: unknown;
}): string {
  return sha256(JSON.stringify([fields.eventUuid.toLowerCase(), fields.eventVersion, BigInt(fields.machineSequence).toString(), fields.sessionId, fields.sessionSequence,
    fields.type, fields.category, fields.data, fields.priority, fields.sourceHook, instantOf(fields.createdAt)]));
}

export function envelopeHash(row: EventRow): string {
  return canonicalEnvelopeSha256({
    eventUuid: row.event_uuid, eventVersion: row.event_version, machineSequence: row.machine_sequence, sessionId: row.session_id, sessionSequence: row.seq,
    type: row.type, category: row.category, data: row.data, priority: row.priority, sourceHook: row.source_hook, createdAt: row.created_at,
  });
}

export function readEventRows(h: RehearsalHome): EventRow[] {
  const path = join(h.home, ".lcm", "events", h.localProjectId + ".db");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT * FROM events ORDER BY machine_sequence").all() as unknown as EventRow[];
  } finally {
    db.close();
  }
}

/** Append hook events through the real durable enqueue and record the acknowledged inputs before any interruption. */
export async function acknowledgeEvents(c: RehearsalCase, label: string, data: readonly string[]): Promise<LedgerEntry[]> {
  if (c.ledger.length + data.length > c.manifest.workload.bounds.maxHookEventsPerRow) throw new Error("the row exceeds the declared hook event bound");
  const before = new Set(readEventRowsSafe(c.h).map((row) => row.event_uuid));
  await withHome(c.h.home, () => appendLocalHookEvents({
    cwd: c.h.cwd, sessionId: "rehearsal-" + label, sourceHook: "SessionStart",
    events: data.map((entry) => ({ type: "decision", category: "decision", data: entry, priority: 1 })),
  }));
  const added = readEventRows(c.h).filter((row) => !before.has(row.event_uuid)).map((row) => ledgerEntryOf(c.h, row));
  if (added.length !== data.length) throw new Error("acknowledged events were not retained by the durable enqueue");
  c.ledger.push(...added);
  return added;
}

/** The scoped ledger identity of one retained event: project, machine, UUID, sequence and canonical envelope. */
/** Legacy events acknowledged before the machine was enrolled carry no machine identity; their sequence facts are still ledgered. */
const PRE_EPOCH_MACHINE = "pre-epoch";

export function ledgerEntryOf(h: RehearsalHome, row: EventRow): LedgerEntry {
  return {
    projectId: h.localProjectId, machineId: readMachineIdentity(h.home)?.machineId ?? PRE_EPOCH_MACHINE, eventUuid: row.event_uuid,
    machineSequence: row.machine_sequence, envelopeSha256: envelopeHash(row), data: row.data,
  };
}

/**
 * Acknowledge events while the maintenance hold is up. The enqueue stays open during a hold, so the expected result is
 * "accepted": the input is ledgered and its machine sequence is proved above the hold's sealed queue cutoff. The one
 * closed, identifiable refusal (the append barrier timing out) is reported as "refused" and acknowledges nothing; every
 * other failure propagates.
 */
export async function acknowledgeHeldGap(c: RehearsalCase, label: string, data: readonly string[]): Promise<"accepted" | "refused"> {
  let added: LedgerEntry[];
  try {
    added = await acknowledgeEvents(c, label, data);
  } catch (error) {
    if (error instanceof LocalHookDurabilityTimeoutError && error.retryRequired) return "refused";
    throw error;
  }
  const machineId = readMachineIdentity(c.h.home)!.machineId!;
  const cutoff = readBackendMaintenanceJournal(c.h.home)?.roster.find((entry) => entry.machineId === machineId)?.queueCutoff;
  if (cutoff === undefined || cutoff === null) throw new Error("the hold carries no sealed queue cutoff for this machine");
  for (const entry of added) {
    if (BigInt(entry.machineSequence) <= BigInt(cutoff)) {
      c.invariants.I3 ??= { status: "pass", evidenceRefs: [] };
      c.invariants.I3.status = "fail";
      throw new Error("a held-gap input was sequenced inside the sealed cutoff: " + entry.machineSequence + " <= " + cutoff);
    }
  }
  c.mark("I3", "held-gap-above-cutoff:" + cutoff);
  return "accepted";
}

function readEventRowsSafe(h: RehearsalHome): EventRow[] {
  try { return readEventRows(h); } catch { return []; }
}

/** Every acknowledged input of the focused project must still be retained with an identical scoped envelope and content. */
export function assertLedgerRetained(c: RehearsalCase, label: string): void {
  const rows = new Map(readEventRows(c.h).map((row) => [row.event_uuid, row]));
  const scoped = c.ledger.filter((entry) => entry.projectId === c.h.localProjectId);
  const machineId = readMachineIdentity(c.h.home)!.machineId!;
  const missing = scoped.filter((entry) => {
    const row = rows.get(entry.eventUuid);
    return row === undefined || (entry.machineId !== PRE_EPOCH_MACHINE && entry.machineId !== machineId) || envelopeHash(row) !== entry.envelopeSha256 || row.machine_sequence !== entry.machineSequence;
  });
  const changedInstructions = c.mutations.filter((entry) => entry.domain === "instruction" && !instructionRetained(c, entry));
  // A row with no acknowledged input has nothing to retain: it asserts nothing (and keeps its not-applicable declaration).
  if (scoped.length === 0 && c.mutations.length === 0) return;
  c.invariants.I3 ??= { status: "pass", evidenceRefs: [] };
  c.invariants.I3.evidenceRefs.push(label + ":" + String(scoped.length) + "+" + String(c.mutations.length));
  if (missing.length > 0 || changedInstructions.length > 0) {
    c.invariants.I3.status = "fail";
    throw new Error("I3 acknowledged input lost or changed at " + label + ": " + String(missing.length) + " events, " + String(changedInstructions.length) + " instructions");
  }
}

const instructionContent = (row: { scope_hash: string; client_name: string; session_id: string; content: string }): string => sha256(JSON.stringify([row.scope_hash, row.client_name, row.session_id, row.content]));

/** Record the natively seeded instruction rows as acknowledged inputs (identity plus content digest). */
export function recordInstructionLedger(c: RehearsalCase): void {
  const db = new DatabaseSync(join(c.h.projectDir, "db.sqlite"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT scope_hash,client_name,session_id,content FROM session_instruction_cache").all() as { scope_hash: string; client_name: string; session_id: string; content: string }[];
    for (const row of rows) {
      const content = instructionContent(row);
      c.mutations.push({ domain: "instruction", identitySha256: sha256(["instruction", c.h.localProjectId, row.scope_hash, row.client_name, row.session_id].join("\0")), locator: row.scope_hash + "\0" + row.client_name + "\0" + row.session_id, beforeSha256: content, afterSha256: content });
    }
  } finally {
    db.close();
  }
}

function instructionRetained(c: RehearsalCase, entry: MutationEntry): boolean {
  const [scope, client, session] = entry.locator.split("\0") as [string, string, string];
  const db = new DatabaseSync(join(c.h.projectDir, "db.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT scope_hash,client_name,session_id,content FROM session_instruction_cache WHERE scope_hash=? AND client_name=? AND session_id=?").get(scope, client, session) as { scope_hash: string; client_name: string; session_id: string; content: string } | undefined;
    return row !== undefined && instructionContent(row) === entry.afterSha256;
  } finally {
    db.close();
  }
}

/** Record one explicit guarded canonical write (absent before, the returned canonical row after). */
export function recordConversationWrite(c: RehearsalCase, projectId: string, record: { readonly sessionId: string; readonly title: string | null }): void {
  c.mutations.push({
    domain: "conversation", identitySha256: sha256(["conversation", projectId, record.sessionId].join("\0")), locator: record.sessionId,
    beforeSha256: sha256("absent"), afterSha256: sha256(JSON.stringify([record.sessionId, record.title])),
  });
}

/** After a rollback: every guarded write is present in the restored SQLite project with its recorded content. */
export function assertWritesRestored(c: RehearsalCase, databasePath: string, label: string): void {
  if (!c.mutations.some((candidate) => candidate.domain === "conversation")) return;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    for (const entry of c.mutations.filter((candidate) => candidate.domain === "conversation")) {
      const row = db.prepare("SELECT session_id,title FROM conversations WHERE session_id = ?").get(entry.locator) as { session_id: string; title: string | null } | undefined;
      if (row === undefined || sha256(JSON.stringify([row.session_id, row.title])) !== entry.afterSha256) {
        c.invariants.I3 ??= { status: "pass", evidenceRefs: [] };
        c.invariants.I3.status = "fail";
        throw new Error("I3 guarded write not restored at " + label);
      }
    }
  } finally {
    db.close();
  }
  c.mark("I3", "guarded-writes-restored:" + label);
}

// ─── Genuine process kill at a named existing seam ─────────────────────────

const WORKER_PATH = join(process.cwd(), "test/postgresql/fixtures/cutover-rehearsal-worker.mjs");

/** Fork the rehearsal worker, wait for its readiness message at the named seam, SIGKILL exactly that process group, await close. */
export async function killWorkerAtSeam(c: RehearsalCase, boundary: string): Promise<{ readonly signal: string | null; readonly generationId: string }> {
  c.checkpoint();
  const child = fork(WORKER_PATH, [], {
    cwd: c.h.cwd, env: { ...c.h.env, LCM_REHEARSAL_WORKER_BOUNDARY: boundary }, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: true,
  });
  registerChild(child.pid);
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  let output = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => { output += chunk.length; if (output > OUTPUT_CAP) signalGroup("SIGKILL"); });
  }
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise<{ generationId: string }>((resolve, reject) => {
    child.on("message", (message: { type?: string; reason?: string; generationId?: string }) => {
      if (message.type === "ready") resolve({ generationId: message.generationId! });
      else if (message.type === "failed") reject(new Error("rehearsal worker failed: " + String(message.reason)));
    });
    child.once("close", () => reject(new Error("rehearsal worker exited before reaching the seam")));
  });
  const deadline = setTimeout(() => signalGroup("SIGKILL"), 30_000);
  const cancel = (): void => signalGroup("SIGKILL");
  c.signal.addEventListener("abort", cancel, { once: true });
  try {
    const reached = await ready;
    signalGroup("SIGKILL");
    const outcome = await closed;
    c.injections.push({ surface: "module-seam", boundary, kind: "process-kill", hitCount: 1, signal: outcome.signal });
    return { signal: outcome.signal, generationId: reached.generationId };
  } finally {
    clearTimeout(deadline);
    c.signal.removeEventListener("abort", cancel);
    signalGroup("SIGKILL");
    await closed;
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, 0); throw new Error("worker process group survived"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
}

/** Deterministically expire the dead worker's copy lease (isolated owned row; no wall-clock wait). */
export async function expireCopyLease(db: PostgreSqlTestDatabase, signal?: AbortSignal): Promise<number> {
  const rows = await adminSql(db, "UPDATE lcm.fenced_leases SET acquired_at = acquired_at - interval '2 hours', renewed_at = renewed_at - interval '2 hours', expires_at = expires_at - interval '2 hours' WHERE resource_type = 'migration-copy' AND released_at IS NULL RETURNING 1 AS n", [], signal);
  return rows.length;
}

// ─── In-process module-seam interruption of the production activation ─────

export class InjectedInterruption extends Error {
  constructor(readonly point: string) { super("rehearsal-interruption:" + point); this.name = "InjectedInterruption"; }
}

/**
 * Operator environment for in-process production entries: private HOME plus the destination variables, `LCM_POSTGRES_URL`
 * naming the role the operator holds now and the activate-only runtime URL beside it.
 */
export async function withOperatorEnv<T>(c: RehearsalCase, home: RehearsalHome, callback: () => Promise<T>): Promise<T> {
  const caFile = harnessEnvironment().LCM_TEST_POSTGRES_CA_FILE;
  vi.stubEnv("LCM_POSTGRES_URL", c.operator.url);
  vi.stubEnv("LCM_POSTGRES_RUNTIME_URL", c.runtime.url);
  vi.stubEnv("LCM_POSTGRES_CA_FILE", caFile);
  vi.stubEnv("LCM_POSTGRES_MIGRATION_ROLE", MIGRATION_ROLE);
  try {
    return await withHome(home.home, callback);
  } finally {
    vi.unstubAllEnvs();
  }
}

/** The documented grant-first step: the runtime role receives the runtime profile after verification, immediately before `activate`. */
export async function grantRuntimeRole(c: RehearsalCase): Promise<void> {
  await swapGrants(c.db, c.runtime, "runtime", c.signal);
}

/**
 * The operator's one privilege step after a successful single-generation activation: revoke the transfer grants, then hand
 * `LCM_POSTGRES_URL` to the proven runtime role for the daemon, guarded writes and a later rollback.
 */
export async function revokeTransferGrants(c: RehearsalCase): Promise<void> {
  await swapGrants(c.db, c.role, "none", c.signal);
  c.operator = c.runtime;
  c.h.env.LCM_POSTGRES_URL = c.runtime.url;
}

export type ActivationInterruption =
  | { readonly kind: "crash-point"; readonly point: string }
  | { readonly kind: "publication-phase"; readonly phase: string };

/**
 * Run the production activation once with a single deterministic interruption at an existing named boundary.
 * The interruption is a thrown error (an unwinding, not an OS crash) and is recorded as injected-interruption.
 */
export async function interruptActivation(c: RehearsalCase, interruption: ActivationInterruption, home: RehearsalHome = c.h): Promise<string> {
  let fired = false;
  const deps: Partial<MigrationActivationDependencies> = interruption.kind === "crash-point"
    ? { crashPoint: (point: string) => { if (!fired && point === interruption.point) { fired = true; throw new InjectedInterruption(point); } } }
    : {
      createCoordinator: ({ homeDir, guard, machineId }) => createBackendPublicationCoordinator({
        homeDir,
        observer: (event) => {
          if (fired || event !== "after-journal-write") return;
          if (readBackendPublicationJournal(homeDir)?.phase === interruption.phase) { fired = true; throw new InjectedInterruption(interruption.phase); }
        },
        remoteGuard: { mode: "delegated", provider: createPostgreSqlBackendPublicationRemoteGuard({ guard, machineId, ttlMs: 15 * 60 * 1000 }) },
      }),
    };
  const label = interruption.kind === "crash-point" ? interruption.point : interruption.phase;
  c.checkpoint();
  const outcome = await withOperatorEnv(c, home, async () => {
    const destination = await resolveMigrationDestination({ cwd: home.cwd, homeDir: home.home });
    if (destination.status === "refuse") throw new Error("rehearsal destination did not resolve: " + destination.reason);
    const runtime = resolveMigrationActivationRuntimeSettings({ transferSettings: destination.settings, expectedOwner: destination.expectedOwner });
    if (runtime.status === "refuse") throw new Error("rehearsal runtime target did not resolve: " + runtime.reason);
    try {
      const result = await runMigrationActivation({
        homeDir: home.home, generationId: c.gen, transferSettings: destination.settings, ordinarySettings: runtime.settings,
        expectedIdentity: destination.expectedIdentity, expectedOwner: destination.expectedOwner, signal: c.signal,
      }, deps);
      return "returned:" + result.status;
    } catch (error) {
      if (error instanceof InjectedInterruption) return "interrupted";
      throw error;
    }
  });
  if (!fired) throw new Error("interruption " + label + " was never reached");
  c.injections.push({ surface: "module-seam", boundary: label, kind: "injected-interruption", hitCount: 1, outcome });
  c.note("interrupt-activation", "module-seam", [label]);
  return outcome;
}

// ─── Competing fence holder (F8) ───────────────────────────────────────────

const OWNER = "rehearsal-competing-owner";
const OPERATION = "rehearsal-contention";
/** A decodable foreign publication row: the guard only accepts backend-publication:<target>:<sha256> operations. */
const FOREIGN_PUBLICATION_OPERATION = "backend-publication:postgresql:" + "ab".repeat(32);

export interface CompetingLease { readonly fencingToken: string; release(): Promise<void> }

/** Another actor takes a fenced lease on the destination project under its own process id. */
export async function competingLease(c: RehearsalCase, resourceType: string, resourceKey: string, ttlMs = 600_000): Promise<CompetingLease> {
  const runtime = new PostgreSqlRuntime(settings(c.operator.url));
  const projectId = await destinationProjectId(c.db, c.h.cwd, c.signal);
  const machineId = readMachineIdentity(c.h.home)!.machineId!;
  const repository = new PostgreSqlCoordinationRepository(runtime, projectId, machineId);
  const lease = await repository.acquireLease({ resourceType, resourceKey, processId: OWNER, operation: OPERATION, ttlMs });
  if (lease === null) { await runtime.close(); throw new Error("competing lease could not be acquired"); }
  return {
    fencingToken: lease.fencingToken.toString(),
    async release(): Promise<void> {
      try { await repository.releaseLease({ resourceType, resourceKey, processId: OWNER, operation: OPERATION, fencingToken: lease.fencingToken }); } finally { await runtime.close(); }
    },
  };
}

/** Takeover proof: a token superseded by a fresh owner after expiry must be refused by the fence, the new token must pass. */
export async function staleTokenRefused(c: RehearsalCase): Promise<{ readonly stale: string; readonly current: string }> {
  const resourceType = "rehearsal-fence";
  const resourceKey = "f8-takeover";
  const first = await competingLease(c, resourceType, resourceKey, 1_000);
  await c.sql("UPDATE lcm.fenced_leases SET acquired_at = acquired_at - interval '2 hours', renewed_at = renewed_at - interval '2 hours', expires_at = expires_at - interval '2 hours' WHERE resource_type = $1", [resourceType]);
  const second = await competingLease(c, resourceType, resourceKey);
  const runtime = new PostgreSqlRuntime(settings(c.operator.url));
  try {
    const projectId = await destinationProjectId(c.db, c.h.cwd, c.signal);
    const machineId = readMachineIdentity(c.h.home)!.machineId!;
    const assertFence = (token: string) => runtime.transaction(async (executor) => {
      await new PostgreSqlWorkCoordinator(executor, projectId, machineId).assertLeaseFence({ resourceType, resourceKey, processId: OWNER, operation: OPERATION, fencingToken: BigInt(token) });
    }, { domain: "coordination", operation: "rehearsalAssertFence", projectId, transactionMode: "read-committed-read-write" });
    await assertFence(second.fencingToken);
    let refused = false;
    try { await assertFence(first.fencingToken); } catch (error) { refused = error instanceof PostgreSqlLeaseFenceError; }
    if (!refused) throw new Error("the stale fencing token was not refused after takeover");
  } finally {
    await runtime.close();
    await second.release();
    try { await first.release(); } catch { /* the superseded token cannot release; the row now belongs to the new owner */ }
  }
  return { stale: first.fencingToken, current: second.fencingToken };
}

/** Another actor holds the reserved publication fence: an unexpired row owned by a foreign process id (isolated owned database). */
export async function competingPublicationFence(c: RehearsalCase): Promise<CompetingLease> {
  const projectId = await destinationProjectId(c.db, c.h.cwd, c.signal);
  const machineId = readMachineIdentity(c.h.home)!.machineId!;
  const rows = await c.sql("INSERT INTO lcm.fenced_leases (project_id, resource_type, resource_key, owner_machine_id, owner_process_id, operation, expires_at) VALUES ($1, 'backend-publication', 'selection', $2, $3, $4, statement_timestamp() + interval '10 minutes') RETURNING fencing_token::text AS token", [projectId, machineId, OWNER, FOREIGN_PUBLICATION_OPERATION]);
  return {
    fencingToken: String(rows[0]!.token),
    release: async () => { await c.sql("DELETE FROM lcm.fenced_leases WHERE project_id = $1 AND resource_type = 'backend-publication' AND owner_process_id = $2", [projectId, OWNER]); },
  };
}

// ─── Uncertain commit (F3) ─────────────────────────────────────────────────

/**
 * Run the production apply sequence in-process with one server-committed response loss on the receipt-owning
 * connection: the real COMMIT is awaited first, then ECONNRESET is raised, exactly as migration-copy.integration.ts does.
 */
export async function applyWithResponseLoss(c: RehearsalCase): Promise<{ readonly lost: boolean; readonly status: string }> {
  c.checkpoint();
  return withOperatorEnv(c, c.h, async () => {
    const cwd = c.h.cwd;
    const homeDir = c.h.home;
    const preflight = await resolveMigrationPreflight({ cwd, homeDir });
    if (preflight.status !== "ready") throw new Error("rehearsal preflight: " + preflight.status);
    const identity = await resolveMigrationExpectedIdentity({ preflight, cwd, homeDir });
    if (identity.status !== "resolved") throw new Error("rehearsal identity: " + identity.status);
    const captured = await performMigrationApplyThroughCapture({ cwd, homeDir, base: preflight.base, confirmGenerationId: preflight.candidate.generationId });
    if (captured.status !== "captured") throw new Error("rehearsal capture: " + captured.status);
    const original = Client.prototype.query;
    let lost = false;
    const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
      const promise = Reflect.apply(original, this, args) as Promise<unknown>;
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text;
      if (!lost && text === "COMMIT" && (this as Client & { copyReceipt?: boolean }).copyReceipt === true) {
        lost = true;
        return promise.then(() => { throw Object.assign(new Error("post-server-commit-response-loss"), { code: "ECONNRESET" }); }) as never;
      }
      if (text?.startsWith("INSERT INTO lcm.transfer_batches")) (this as Client & { copyReceipt?: boolean }).copyReceipt = true;
      return promise as never;
    });
    try {
      const outcome = await performMigrationApplyGenesisAndCopy({
        homeDir, generationId: captured.generationId, maintenanceChecksumSha256: captured.maintenanceChecksumSha256,
        settings: preflight.targetConfig.postgresql, expectedOwner: preflight.targetConfig.postgresql.migrationRole,
        expectedIdentity: identity.expectedIdentity, ownerProcessId: "cutover-rehearsal-response-loss", maxRecords: 1, maxBytes: 150994944, signal: c.signal,
      });
      c.injections.push({ surface: "module-seam", boundary: "post-server-commit-response-loss", kind: "uncertain-commit", hitCount: lost ? 1 : 0 });
      c.note("apply-with-response-loss", "module-seam", ["performMigrationApplyGenesisAndCopy", "ECONNRESET after COMMIT"]);
      return { lost, status: outcome.status };
    } finally {
      spy.mockRestore();
    }
  });
}

// ─── Represented receipt-era events and PostgreSQL inbox readback ─────────

/** Make already-acknowledged events "represented": exact-envelope receipts (applied / no-effect) plus processed_at. */
export function recordRepresented(c: RehearsalCase, data: readonly string[]): void {
  const machine = readMachineIdentity(c.h.home)!;
  const events = new DatabaseSync(join(c.h.home, ".lcm", "events", c.h.localProjectId + ".db"));
  const project = new DatabaseSync(join(c.h.projectDir, "db.sqlite"));
  try {
    const epoch = getMigrationReceiptEpoch(project, c.h.localProjectId, machine.machineId!);
    if (epoch === null || epoch === undefined) throw new Error("no receipt epoch: the project is not enrolled");
    const envelopes = events.prepare(
      "SELECT event_uuid AS eventUuid, event_version AS eventVersion, machine_id AS machineId, machine_sequence AS machineSequence, "
        + "session_id AS sessionId, seq AS sessionSequence, type, category, data, priority, source_hook AS sourceHook, created_at AS createdAt "
        + "FROM events ORDER BY machine_sequence",
    ).all() as unknown as (MigrationReceiptEnvelope & { data: string })[];
    const memory = project.prepare("SELECT id FROM promoted ORDER BY id LIMIT 1").get() as { id: string };
    project.exec("BEGIN IMMEDIATE");
    for (const [index, name] of data.entries()) {
      const envelope = envelopes.find((candidate) => candidate.data === name);
      if (envelope === undefined) throw new Error("represented event not found: " + name);
      recordMigrationReceipt(project, {
        projectId: c.h.localProjectId, epochId: epoch.epochId, envelope,
        effectWitness: index === 0
          ? { version: 1, outcome: "applied", promotedMemoryId: memory.id }
          : { version: 1, outcome: "no-effect", reason: "unreinforced-pattern" },
        committedAt: "2026-09-14T03:00:00.000000Z",
      });
    }
    project.exec("COMMIT");
    for (const name of data) events.prepare("UPDATE events SET processed_at = '2026-09-14T03:00:00.000Z' WHERE data = ?").run(name);
  } finally {
    events.close();
    project.close();
  }
}

export interface InboxRow {
  readonly inbox_id: string; readonly project_id: string; readonly machine_id: string; readonly event_id: string; readonly event_version: number;
  readonly machine_sequence: string; readonly event_type: string; readonly status: string; readonly payload: Record<string, unknown>;
}

/** PostgreSQL inbox disposition per event: the remote half of the I3 join. */
export async function inboxRows(db: PostgreSqlTestDatabase, signal?: AbortSignal): Promise<InboxRow[]> {
  return await adminSql(db, "SELECT inbox_id::text AS inbox_id, project_id::text AS project_id, machine_id::text AS machine_id, event_id::text AS event_id, event_version, machine_sequence::text AS machine_sequence, event_type, status, payload FROM lcm.passive_event_inbox ORDER BY machine_sequence", [], signal) as unknown as InboxRow[];
}

/**
 * The remote copy must be the acknowledged input by the production replication comparison itself (sameEnvelope: identity,
 * version, sequence, type, and the payload with createdAt as one instant in either form, previousEventId ignored only when one
 * side lacks it, every other key equal and no extra key), and its canonical fields must reproduce the ledger digest.
 */
function remoteEnvelopeProblems(name: string, receipt: PostgreSqlPassiveEventRecord, entry: LedgerEntry, local: EventRow | undefined): string[] {
  const problems: string[] = [];
  if (local === undefined) return [name + ": the local row is gone"];
  if (!sameEnvelope(local, receipt)) problems.push(name + ": the remote copy is not the acknowledged event by the production comparison");
  const fields: Record<string, unknown> = receipt.payload;
  const present = (key: string, kind: "string" | "number"): boolean => {
    if (typeof fields[key] === kind) return true;
    problems.push(name + ": payload field " + key + " is missing or malformed");
    return false;
  };
  const complete = [present("sessionId", "string"), present("category", "string"), present("data", "string"), present("sourceHook", "string"),
    present("createdAt", "string"), present("sessionSequence", "number"), present("priority", "number")].every(Boolean);
  if (!complete) return problems;
  const remoteDigest = canonicalEnvelopeSha256({
    eventUuid: receipt.eventId, eventVersion: receipt.eventVersion, machineSequence: receipt.machineSequence, sessionId: fields.sessionId, sessionSequence: fields.sessionSequence,
    type: receipt.eventType, category: fields.category, data: fields.data, priority: fields.priority, sourceHook: fields.sourceHook, createdAt: fields.createdAt,
  });
  if (remoteDigest !== entry.envelopeSha256) problems.push(name + ": the remote envelope differs from the acknowledged envelope");
  if (instantOf(fields.createdAt) === null) problems.push(name + ": createdAt is not an instant");
  return problems;
}

/** A replication counter the daemon reports: a finite number of at least one; anything else is not progress. */
const countsProgress = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 1;

/**
 * The restarted PostgreSQL daemon itself delivers: the named input was acknowledged and left undelivered before the daemon
 * started, so only its start-up sweep can move it (the daemon replicates only there and every five minutes). Wait, bounded by
 * the daemon window and the scenario budget, until the status route reports replication enabled and a pass that acknowledged
 * at least one event, then require that input's local row acknowledged against a remote inbox id, and pruned when the pass
 * pruned. The daemon's counters are the only pass evidence; an enabled pass that acknowledged nothing is not delivery.
 */
export async function assertDaemonReplicates(c: RehearsalCase, daemon: RunningDaemon, name: string): Promise<void> {
  const entry = c.ledger.find((candidate) => candidate.projectId === c.h.localProjectId && candidate.data === name);
  if (entry === undefined) throw new Error("the daemon-owned input is not in the ledger: " + name);
  const failure = (message: string): Error => {
    c.invariants.I3 ??= { status: "pass", evidenceRefs: [] };
    c.invariants.I3.status = "fail";
    return new Error(message);
  };
  const deadline = Date.now() + 45_000;
  let replication: Record<string, unknown>;
  for (;;) {
    c.checkpoint();
    const status = await daemon.client.post<{ passiveEvents?: { replication?: Record<string, unknown> } }>("/status", { cwd: c.h.cwd }, { timeoutMs: 30_000 });
    const reported = status.passiveEvents?.replication;
    if (reported?.enabled !== true) throw failure("the daemon does not report replication enabled: " + JSON.stringify(reported));
    replication = reported;
    if (countsProgress(replication.acknowledged)) break;
    if (Date.now() >= deadline) throw failure("the daemon's start-up sweep acknowledged no event within the bound: " + JSON.stringify(replication));
    await delay(250);
  }
  if (!countsProgress(replication.passes) || !countsProgress(replication.projects)) throw failure("the daemon acknowledged an event without counting a pass over a project: " + JSON.stringify(replication));
  const row = readEventRows(c.h).find((candidate) => candidate.event_uuid === entry.eventUuid);
  if (row === undefined || row.delivery_state !== "acknowledged" || row.remote_inbox_id === null) throw failure("the daemon-owned input is not acknowledged locally against a remote inbox row: " + name);
  const pruned = countsProgress(replication.pruned);
  if (pruned && row.remote_pruned_at === null) throw failure("the daemon pruned, but the daemon-owned input does not record its prune: " + name);
  c.mark("I3", "daemon-replication:passes=" + String(replication.passes) + ",projects=" + String(replication.projects) + ",acknowledged=" + String(replication.acknowledged)
    + ",pruned=" + String(replication.pruned) + ";input=" + name + ":acknowledged,inbox=" + row.remote_inbox_id + (pruned ? ",pruned" : ""));
}

/**
 * I3 join after a bounded drain. Every acknowledged input of the focused project is still retained locally with an
 * identical scoped envelope; the PostgreSQL inbox holds no row that is foreign to the ledger and at most one per
 * (machine, event); and each event named in "eligible" (the inputs that existed when the drain was requested) has exactly
 * one terminal "applied" disposition for the right project, machine, sequence and canonical envelope, with the local row
 * pointing at that inbox row. Inputs appended after the drain are only required to be retained.
 */
export async function assertEventsJoined(c: RehearsalCase, label: string, eligible: readonly string[] = [], receipts?: readonly PostgreSqlPassiveEventRecord[]): Promise<void> {
  assertLedgerRetained(c, label);
  const rows = await inboxRows(c.db, c.signal);
  const projectId = await destinationProjectId(c.db, c.h.cwd, c.signal);
  const scoped = c.ledger.filter((entry) => entry.projectId === c.h.localProjectId);
  const keyOf = (machineId: string, eventId: string): string => machineId + ":" + eventId;
  const known = new Map(scoped.map((entry) => [keyOf(entry.machineId, entry.eventUuid), entry]));
  const ofProject = rows.filter((row) => row.project_id === projectId);
  const counts = new Map<string, number>();
  for (const row of ofProject) counts.set(keyOf(row.machine_id, row.event_id), (counts.get(keyOf(row.machine_id, row.event_id)) ?? 0) + 1);
  const foreign = ofProject.filter((row) => !known.has(keyOf(row.machine_id, row.event_id))).length;
  const duplicated = [...counts.values()].filter((count) => count > 1).length;
  const byStatus: Record<string, number> = {};
  for (const row of ofProject) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  c.invariants.I3 ??= { status: "pass", evidenceRefs: [] };
  c.invariants.I3.evidenceRefs.push(label + ":inbox=" + JSON.stringify(byStatus));
  const problems: string[] = [];
  if (foreign > 0 || duplicated > 0) problems.push("foreign=" + String(foreign) + " duplicated=" + String(duplicated));
  const local = new Map(readEventRows(c.h).map((row) => [row.event_uuid, row]));
  if (eligible.length > 0 && receipts === undefined) throw new Error("a delivery join needs the receipts captured before the prune (replicateWithWitness)");
  const witnesses = receipts ?? [];
  for (const name of eligible) {
    const entry = scoped.find((candidate) => candidate.data === name);
    if (entry === undefined) { problems.push("eligible input not in the ledger: " + name); continue; }
    const key = keyOf(entry.machineId, entry.eventUuid);
    const localRow = local.get(entry.eventUuid);
    // The terminal receipt: the applied inbox row as replication applied it and as the production repository reads it, captured
    // before the prune (replicateWithWitness). The production replication applies no further canonical effect
    // (applyReplicatedPassiveEvent is deliberately empty), so this applied row is the one canonical receipt and must occur once.
    const witnessed = witnesses.filter((record) => record.projectId === projectId && keyOf(record.machineId, record.eventId) === key);
    if (witnessed.length !== 1) { problems.push(name + ": " + String(witnessed.length) + " terminal receipts"); continue; }
    const receipt = witnessed[0]!;
    const receiptInboxId = receipt.inboxId.toString();
    if (receipt.status !== "applied") problems.push(name + ": receipt status " + receipt.status);
    problems.push(...remoteEnvelopeProblems(name, receipt, entry, localRow));
    const current = ofProject.filter((row) => keyOf(row.machine_id, row.event_id) === key);
    if (current.length > 1 || (current[0] !== undefined && (current[0].inbox_id !== receiptInboxId || current[0].status !== "applied"))) problems.push(name + ": the live inbox row differs from the receipt");
    if (current.length === 0 && (localRow === undefined || localRow.remote_pruned_at === null)) problems.push(name + ": no live inbox row and the prune is not recorded locally");
    if (localRow === undefined || localRow.delivery_state !== "acknowledged" || localRow.remote_inbox_id === null || String(localRow.remote_inbox_id) !== receiptInboxId) {
      problems.push(name + ": local row is not acknowledged against receipt " + receiptInboxId);
    }
  }
  if (problems.length > 0) {
    c.invariants.I3.status = "fail";
    throw new Error("I3 remote join failed at " + label + ": " + problems.join("; "));
  }
  if (eligible.length > 0) c.mark("I3", label + ":drained=" + String(eligible.length));
}

// ─── In-process module-seam interruption of the production rollback ───────

/** Settings and project resolved while the harness environment is unambiguous, for writes made inside an operator-environment window. */
export async function prepareGuardedWriter(c: RehearsalCase): Promise<(sessionId: string) => Promise<void>> {
  const connection = settings(c.operator.url);
  const projectId = await destinationProjectId(c.db, c.h.cwd, c.signal);
  return async (sessionId: string): Promise<void> => {
    const runtime = new PostgreSqlRuntime(connection);
    try {
      recordConversationWrite(c, projectId, await new PostgreSqlConversationRepository(runtime, projectId).createConversation({ sessionId }));
    } finally {
      await runtime.close();
    }
  };
}

export type RollbackInterruption =
  | { readonly kind: "before-complete-selection" }
  | { readonly kind: "after-install-sync" }
  | { readonly kind: "publication-phase"; readonly phase: string }
  | { readonly kind: "around-fence"; readonly beforeOpen: () => Promise<void>; readonly afterOpen: () => Promise<void> };

/** Run the production rollback entry once with one deterministic interruption (or fence-adjacent actions); returns how it ended. */
export async function interruptRollback(c: RehearsalCase, interruption: RollbackInterruption, home: RehearsalHome = c.h): Promise<string> {
  let fired = false;
  const dependencies: RollbackEntryDependencies = {
    ...DEFAULT_ROLLBACK_ENTRY_DEPENDENCIES,
    createCoordinator: (input) => {
      if (interruption.kind === "publication-phase") {
        return createBackendPublicationCoordinator({
          ...input,
          observer: (event) => {
            if (fired || event !== "after-journal-write") return;
            if (readBackendPublicationJournal(input.homeDir)?.phase === interruption.phase) { fired = true; throw new InjectedInterruption(interruption.phase); }
          },
        });
      }
      const coordinator = createBackendPublicationCoordinator(input);
      if (interruption.kind === "before-complete-selection") {
        coordinator.completeMaintenanceSelection = async () => { fired = true; throw new InjectedInterruption("before-complete-selection"); };
      }
      return coordinator;
    },
    run: (input, runDependencies) => runMigrationRollback(input, {
      ...runDependencies,
      ...(interruption.kind === "after-install-sync"
        ? { syncDirectory: (path: string) => { syncPrivateDirectory(path); if (!fired) { fired = true; throw new InjectedInterruption("after-install-sync"); } } }
        : {}),
      ...(interruption.kind === "around-fence"
        ? {
          openFencedSession: async (sessionInput: Parameters<typeof runDependencies.openFencedSession>[0]) => {
            await interruption.beforeOpen();
            const session = await runDependencies.openFencedSession(sessionInput);
            fired = true;
            await interruption.afterOpen();
            return session;
          },
        }
        : {}),
    }),
  };
  const label = interruption.kind === "publication-phase" ? interruption.phase : interruption.kind;
  const outcome = await withOperatorEnv(c, home, async () => {
    try {
      const result = await runMigrationRollbackFromHome({ homeDir: home.home, generationId: c.gen, signal: c.signal }, dependencies);
      return "returned:" + result.manifest.phase;
    } catch (error) {
      return "threw:" + (error instanceof Error ? error.name : "unknown");
    }
  });
  if (!fired) throw new Error("rollback interruption " + label + " was never reached");
  c.injections.push({ surface: "module-seam", boundary: label, kind: "injected-interruption", hitCount: 1, outcome });
  c.note("interrupt-rollback", "module-seam", [label]);
  return outcome;
}

// ─── Cutover sets (S rows, H2) ─────────────────────────────────────────────

/** The resolved target every in-process set entry copies to; resolved while the harness environment is unambiguous. */
export function targetConfigFor(role: RehearsalRole): Parameters<typeof prepareCutoverSet>[0]["targetConfig"] {
  const connection = settings(role.url);
  return { backend: "postgresql", postgresql: { ...connection, snapshotIdleTimeoutMs: connection.snapshotIdleTimeoutMs ?? 300_000, migrationRole: MIGRATION_ROLE } } as unknown as Parameters<typeof prepareCutoverSet>[0]["targetConfig"];
}

/** Member generation ids of a --set envelope, in manifest order. */
export function memberGenerations(envelope: Record<string, unknown>): string[] {
  const evidence = envelope.evidence as Record<string, unknown>;
  return Object.keys(evidence).map((key) => /^member\.(\d+)\.generationId$/u.exec(key)).filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1])).map((match) => String(evidence[match[0]]));
}

/** Run a callback with the case focused on another project of the same home. */
export async function withProject<T>(c: RehearsalCase, home: RehearsalHome, callback: () => Promise<T>): Promise<T> {
  const original = c.h;
  c.h = home;
  try { return await callback(); } finally { c.h = original; }
}

/** Every project of the home is bound to its remote project or none is (the all-or-none selection property). */
export function assertAllOrNoneBound(c: RehearsalCase, expectedProjects: number): number {
  const bound = readAuthority(c.h).boundProjects;
  if (bound !== 0 && bound !== expectedProjects) throw new Error("mixed project selection: " + String(bound) + " of " + String(expectedProjects));
  return bound;
}

export type SetActivationInterruption =
  | { readonly kind: "crash-point"; readonly point: string }
  | { readonly kind: "publication-phase"; readonly phase: string };

/** Run the production set activation once with one deterministic interruption at an existing named boundary. */
export async function interruptSetActivation(c: RehearsalCase, interruption: SetActivationInterruption, targetConfig: ReturnType<typeof targetConfigFor>): Promise<string> {
  let fired = false;
  const label = interruption.kind === "crash-point" ? interruption.point : interruption.phase;
  const ordinarySettings = { ...settings(c.role.url), url: c.runtime.url };
  const outcome = await withOperatorEnv(c, c.h, async () => {
    const base = createCutoverSetActivateDependencies({ homeDir: c.h.home });
    const dependencies: CutoverSetActivateDependencies = interruption.kind === "crash-point"
      ? { ...base, crashPoint: (point: string) => { if (!fired && point === interruption.point) { fired = true; throw new InjectedInterruption(point); } } }
      : {
        ...base,
        createCoordinator: ({ homeDir, guard, machineId }) => createBackendPublicationCoordinator({
          homeDir,
          observer: (event) => {
            if (fired || event !== "after-journal-write") return;
            if (readBackendPublicationJournal(homeDir)?.phase === interruption.phase) { fired = true; throw new InjectedInterruption(interruption.phase); }
          },
          remoteGuard: { mode: "delegated", provider: createPostgreSqlBackendPublicationRemoteGuard({ guard, machineId, ttlMs: 15 * 60 * 1000 }) },
        }),
      };
    try {
      const result = await activateCutoverSet({
        homeDir: c.h.home,
        confirmSetId: c.gen,
        targetConfig,
        ordinarySettings,
        signal: c.signal,
      }, dependencies);
      return "returned:" + result.status;
    } catch (error) {
      if (error instanceof InjectedInterruption) return "interrupted";
      throw error;
    }
  });
  if (!fired) throw new Error("set activation interruption " + label + " was never reached");
  c.injections.push({ surface: "module-seam", boundary: "set-activation:" + label, kind: "injected-interruption", hitCount: 1, outcome });
  c.note("interrupt-set-activation", "module-seam", [label]);
  return outcome;
}

export type SetRollbackInterruption =
  | { readonly kind: "crash-point"; readonly point: string }
  | { readonly kind: "publication-phase"; readonly phase: string }
  | { readonly kind: "install-failure" };

/** Run the production set rollback once with one deterministic interruption or one failed install after the export was read back. */
export async function interruptSetRollback(c: RehearsalCase, interruption: SetRollbackInterruption): Promise<string> {
  let fired = false;
  const label = interruption.kind === "crash-point" ? interruption.point : interruption.kind === "publication-phase" ? interruption.phase : "install-failure";
  const outcome = await withOperatorEnv(c, c.h, async () => {
    const base = createCutoverSetRollbackDependencies({ homeDir: c.h.home });
    let dependencies: CutoverSetRollbackDependencies = base;
    if (interruption.kind === "crash-point") {
      dependencies = { ...base, crashPoint: (point: string) => { if (!fired && point === interruption.point) { fired = true; throw new InjectedInterruption(point); } } };
    } else if (interruption.kind === "publication-phase") {
      dependencies = {
        ...base,
        createCoordinator: ({ homeDir, guard, machineId }) => createBackendPublicationCoordinator({
          homeDir,
          observer: (event) => {
            if (fired || event !== "after-journal-write") return;
            if (readBackendPublicationJournal(homeDir)?.phase === interruption.phase) { fired = true; throw new InjectedInterruption(interruption.phase); }
          },
          remoteGuard: { mode: "delegated", provider: createPostgreSqlBackendPublicationRemoteGuard({ guard, machineId, ttlMs: 15 * 60 * 1000 }) },
        }),
      };
    } else {
      dependencies = { ...base, installGeneration: (...args: Parameters<typeof base.installGeneration>) => { if (!fired) { fired = true; throw new Error("rehearsal install failure"); } return base.installGeneration(...args); } };
    }
    try {
      const result = await rollbackCutoverSet({ homeDir: c.h.home, confirmSetId: c.gen, signal: c.signal }, dependencies);
      return "returned:" + result.status;
    } catch (error) {
      if (error instanceof InjectedInterruption) return "interrupted";
      throw error;
    }
  });
  if (!fired) throw new Error("set rollback interruption " + label + " was never reached");
  c.injections.push({ surface: "module-seam", boundary: "set-rollback:" + label, kind: interruption.kind === "install-failure" ? "member-install-failure" : "injected-interruption", hitCount: 1, outcome });
  c.note("interrupt-set-rollback", "module-seam", [label]);
  return outcome;
}

/** Stop a set preparation while the second member copies, after its first checkpoint (the existing per-copy seam). */
export async function interruptSetPrepare(c: RehearsalCase, targetConfig: ReturnType<typeof targetConfigFor>): Promise<string> {
  let sources = 0;
  let fired = false;
  const outcome = await withOperatorEnv(c, c.h, async () => {
    const candidate = await resolveCutoverSetCandidate({ homeDir: c.h.home, targetConfig });
    if (candidate.status !== "candidate" || candidate.setId !== c.gen) throw new Error("rehearsal set candidate did not resolve to the planned set");
    const result = await prepareCutoverSet({
      homeDir: c.h.home, confirmSetId: candidate.setId, targetConfig, maxRecords: 1, maxBytes: 16 * 1024 * 1024, signal: c.signal,
      copyTesting: { observe: async (boundary) => {
        if (boundary === "before-source") sources += 1;
        if (sources === 2 && boundary === "after-checkpoint") { fired = true; throw new InjectedInterruption("second-member-after-checkpoint"); }
      } },
    });
    return result.status + (result.status === "blocked" ? ":" + String((result as { reason?: string }).reason) : "");
  });
  if (!fired) throw new Error("the second member's copy was never interrupted");
  c.injections.push({ surface: "module-seam", boundary: "second member copy after its first checkpoint", kind: "injected-interruption", hitCount: 1, outcome });
  c.note("interrupt-set-prepare", "module-seam", ["second-member-after-checkpoint"]);
  return outcome;
}

/**
 * Fail the real capture after its registration is durable (the existing source-copy observer seam), leaving a held
 * journal with a partial snapshot. The third project copy is the artifact capture itself.
 */
export async function capturePartialSnapshot(c: RehearsalCase): Promise<string> {
  c.checkpoint();
  const outcome = await withOperatorEnv(c, c.h, async () => {
    const cwd = c.h.cwd;
    const homeDir = c.h.home;
    const preflight = await resolveMigrationPreflight({ cwd, homeDir });
    if (preflight.status !== "ready") throw new Error("rehearsal preflight: " + preflight.status);
    const identity = await resolveMigrationExpectedIdentity({ preflight, cwd, homeDir });
    if (identity.status !== "resolved") throw new Error("rehearsal identity: " + identity.status);
    let copies = 0;
    const result = await performMigrationApplyThroughCapture({
      cwd, homeDir, base: preflight.base, confirmGenerationId: preflight.candidate.generationId,
      _operationsForTesting: {
        captureSource: (authority, options) => captureAuthenticatedSqliteMigrationSource(authority, {
          ...options,
          _operationsForTesting: {
            observe: (boundary: string, _path: string, role: string | null) => {
              if (boundary === "after-source-copy" && role === "project") {
                copies += 1;
                if (copies === 3) throw new Error("injected capture failure");
              }
            },
          },
        }),
      },
    });
    return result.status === "refuse" ? result.reason : result.status;
  });
  if (outcome !== "capture-failed") throw new Error("the capture was not interrupted: " + outcome);
  c.injections.push({ surface: "module-seam", boundary: "source copy of the artifact capture", kind: "injected-capture-failure", hitCount: 1, outcome });
  c.note("interrupt-capture", "module-seam", ["after-source-copy:project:3"]);
  return outcome;
}

/** Structural proof that the row's owned role has lost every privilege on the selected schema (no exception text involved). */
export async function roleHasNoPrivileges(db: PostgreSqlTestDatabase, role: RehearsalRole, signal?: AbortSignal): Promise<boolean> {
  const rows = await adminSql(db, "SELECT has_schema_privilege($1, 'lcm', 'USAGE') AS usage, has_table_privilege($1, 'lcm.projects', 'SELECT') AS selectable", [role.name], signal);
  return rows[0]?.usage === false && rows[0]?.selectable === false;
}

/** One bounded native allocation in the restored SQLite database: the next identifier must not collide with a restored one. */
export function assertNativeAllocationSafe(c: RehearsalCase, databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    const before = (db.prepare("SELECT MAX(conversation_id) AS maximum FROM conversations").get() as { maximum: number | bigint | null }).maximum;
    const stamp = "2026-10-24 00:00:00.000001";
    const inserted = db.prepare("INSERT INTO conversations(session_id,title,created_at,updated_at) VALUES('rehearsal-native-allocation',NULL,?,?)").run(stamp, stamp);
    if (before !== null && BigInt(inserted.lastInsertRowid) <= BigInt(before)) throw new Error("the native allocation collided with a restored identifier");
    c.mark("I4", "native-allocation-after-recovery:" + String(inserted.lastInsertRowid));
  } finally {
    db.close();
  }
}

/**
 * Run the production replication worker once so it uploads the named acknowledged inputs, with the apply step deferred: the
 * production daemon's apply is a no-op that settles a row at once, so a worker whose apply defers is the only way to leave
 * an uploaded row resident in the inbox (pending, retry or claimed). Returns the resident rows; fails when nothing uploaded.
 */
export async function uploadResidentEvents(c: RehearsalCase, names: readonly string[]): Promise<InboxRow[]> {
  const entries = names.map((name) => {
    const entry = c.ledger.find((candidate) => candidate.projectId === c.h.localProjectId && candidate.data === name);
    if (entry === undefined) throw new Error("cannot replicate an input that is not in the ledger: " + name);
    return entry;
  });
  const projectId = await destinationProjectId(c.db, c.h.cwd, c.signal);
  const runtime = new PostgreSqlRuntime(settings(c.operator.url));
  const factory = new SQLiteLocalHookOutboxFactory();
  try {
    await withHome(c.h.home, async () => {
      const local = await factory.openExisting(join(c.h.home, ".lcm", "events", c.h.localProjectId + ".db"));
      if (local === null) throw new Error("the sidecar events database is missing");
      const worker = new PassiveEventReplicationWorker({
        local,
        remote: new PostgreSqlPassiveEventRepository(runtime, projectId, entries[0]!.machineId),
        applyEvent: async () => { throw new Error("apply deferred by the rehearsal"); },
      }, { processId: "rehearsal-replication", retryBaseMs: 60_000, retryMaxMs: 60_000, quarantineAfterAttempts: 50 });
      const pass = await worker.runOnce(c.signal);
      c.injections.push({ surface: "module-seam", boundary: "production replication worker with the apply step deferred", kind: "deferred-apply", hitCount: 1 });
      if (pass.uploaded < names.length) throw new Error("replication uploaded " + String(pass.uploaded) + " of " + String(names.length) + " inputs");
    });
  } finally {
    await factory.close();
    await runtime.close();
  }
  const resident = (await inboxRows(c.db, c.signal)).filter((row) => row.project_id === projectId && entries.some((entry) => entry.eventUuid === row.event_id) && ["pending", "retry", "claimed"].includes(row.status));
  if (resident.length === 0) throw new Error("no uploaded input is resident in the inbox");
  c.mark("I3", "uploaded-resident:" + resident.map((row) => row.status).join(","));
  return resident;
}

/**
 * Deliver the named acknowledged inputs through the production replication worker (the production no-op apply, the production
 * repositories) and capture the durable terminal witness: the proxy around the remote repository reads the applied inbox rows
 * immediately before the worker's one prune call deletes them, through the production repository's own read, so the receipts
 * are the rows as replication applied them and as production parses them. One pass, no retry: every input must be
 * acknowledged against its inbox row and pruned by it.
 */
export async function replicateWithWitness(c: RehearsalCase, names: readonly string[]): Promise<PostgreSqlPassiveEventRecord[]> {
  const entries = names.map((name) => {
    const entry = c.ledger.find((candidate) => candidate.projectId === c.h.localProjectId && candidate.data === name);
    if (entry === undefined) throw new Error("cannot replicate an input that is not in the ledger: " + name);
    return entry;
  });
  const projectId = await destinationProjectId(c.db, c.h.cwd, c.signal);
  const runtime = new PostgreSqlRuntime(settings(c.operator.url));
  const factory = new SQLiteLocalHookOutboxFactory();
  const receipts: PostgreSqlPassiveEventRecord[] = [];
  try {
    await withHome(c.h.home, async () => {
      const local = await factory.openExisting(join(c.h.home, ".lcm", "events", c.h.localProjectId + ".db"));
      if (local === null) throw new Error("the sidecar events database is missing");
      const bound = new PostgreSqlPassiveEventRepository(runtime, projectId, entries[0]!.machineId);
      const remote = new Proxy(bound, {
        get: (target, property) => {
          if (property === "pruneApplied") {
            return async (keys: readonly { eventId: string; machineId: string }[], signal?: AbortSignal) => {
              receipts.push(...(await target.readEvents(keys.map((key) => ({ eventId: key.eventId, machineId: key.machineId })), c.signal)).filter((record) => record.status === "applied"));
              return await target.pruneApplied(keys as never, signal);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const worker = new PassiveEventReplicationWorker({ local, remote, applyEvent: applyReplicatedPassiveEvent }, { processId: "rehearsal-replication" });
      const pass = await worker.runOnce(c.signal);
      c.injections.push({ surface: "module-seam", boundary: "production replication worker; remote prune observed to capture the applied receipts", kind: "receipt-witness", hitCount: 1 });
      await local.close();
      if (pass.uploaded < names.length || pass.pruned < names.length) throw new Error("replication did not deliver every input in one pass: " + JSON.stringify(pass));
    });
  } finally {
    await factory.close();
    await runtime.close();
  }
  const rows = readEventRows(c.h);
  for (const name of names) {
    const row = rows.find((candidate) => candidate.data === name);
    if (row === undefined || row.delivery_state !== "acknowledged" || row.remote_inbox_id === null || row.remote_pruned_at === null) {
      c.invariants.I3 ??= { status: "pass", evidenceRefs: [] };
      c.invariants.I3.status = "fail";
      throw new Error("the input was not delivered and pruned by the replication pass: " + name);
    }
  }
  c.mark("I3", "replicated-pass:inputs=" + String(names.length) + ",receipts=" + String(receipts.length));
  return receipts;
}
