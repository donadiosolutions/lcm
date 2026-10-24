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
import { appendLocalHookEvents } from "../../../src/hooks/local-enqueue.js";
import { createBackendPublicationCoordinator } from "../../../src/storage/backend-publication-driver.js";
import { createPostgreSqlBackendPublicationRemoteGuard } from "../../../src/storage/postgresql/publication-remote-guard.js";
import { resolveMigrationDestination } from "../../../src/migration/cli-destination.js";
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
import { PostgreSqlConversationRepository } from "../../../src/storage/postgresql/conversation-repository.js";
import { PostgreSqlRuntime } from "../../../src/storage/postgresql/runtime.js";
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

export interface RehearsalRole {
  readonly name: string;
  readonly url: string;
  profile: GrantProfile;
}

async function applyProfile(db: PostgreSqlTestDatabase, role: string, profile: GrantProfile): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    const run = (text: string, operation: string) => administrator.query({ text }, { domain: "factory", operation });
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

/** A dedicated login role holding the transfer profile, as an operator provisions the canonical transfer role. */
export async function provisionRole(db: PostgreSqlTestDatabase): Promise<RehearsalRole> {
  const name = "lcm_rh_" + randomBytes(6).toString("hex");
  const password = randomBytes(18).toString("hex");
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    await administrator.query({ text: "CREATE ROLE " + name + " LOGIN PASSWORD '" + password + "'" }, { domain: "factory", operation: "rehearsalCreateRole" });
    await administrator.query({ text: "REVOKE USAGE ON SCHEMA lcm FROM lcm_test_runtime" }, { domain: "factory", operation: "rehearsalRevokeBaseline" });
  } finally {
    await administrator.close();
  }
  const url = new URL(db.runtimeUrl);
  url.username = name;
  url.password = password;
  const role: RehearsalRole = { name, url: url.toString(), profile: "transfer" };
  await applyProfile(db, name, "transfer");
  return role;
}

/** The operator's grant swap (and its reverse): drop the role's grants and install the other profile. */
export async function swapGrants(db: PostgreSqlTestDatabase, role: RehearsalRole, profile: GrantProfile): Promise<void> {
  await applyProfile(db, role.name, profile);
  role.profile = profile;
}

export async function dropRole(db: PostgreSqlTestDatabase, role: RehearsalRole): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    await administrator.query({ text: "DROP OWNED BY " + role.name }, { domain: "factory", operation: "rehearsalDropOwned" });
    await administrator.query({ text: "DROP ROLE " + role.name }, { domain: "factory", operation: "rehearsalDropRole" });
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

export function childEnvironment(root: string, home: string, role: RehearsalRole): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TZ: "UTC",
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_STATE_HOME: join(root, "xdg-state"), XDG_RUNTIME_DIR: join(root, "xdg-run"), TMPDIR: join(root, "tmp"),
    LCM_POSTGRES_URL: role.url, LCM_POSTGRES_CA_FILE: harnessEnvironment().LCM_TEST_POSTGRES_CA_FILE,
    LCM_POSTGRES_MIGRATION_ROLE: MIGRATION_ROLE,
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

export function createHome(label: string, role: RehearsalRole, daemonPort: number, projectName = "project"): RehearsalHome {
  const root = mkdtempSync(join(tmpdir(), "lcm-rh-" + label.toLowerCase().replace(/[^a-z0-9]+/gu, "") + "-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".lcm"), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(home), JSON.stringify({
    storage: { backend: "sqlite", postgresql: { migrationRole: MIGRATION_ROLE } },
    daemon: { port: daemonPort },
  }) + "\n", { mode: 0o600 });
  const env = childEnvironment(root, home, role);
  return addProject({ root, home, cwd: "", localProjectId: "", projectDir: "", env }, projectName);
}

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
} = {}): Promise<CliResult> {
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
    signalGroup("SIGKILL");
  }
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

/** Independent per-domain digests from the native SQLite tables (fixture-known identities and content). */
export function sqliteDomainDigests(databasePath: string): DomainDigests {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = (sql: string): (readonly unknown[])[] =>
      (db.prepare(sql).all() as Record<string, unknown>[]).map((record) => Object.values(record));
    const memories = (db.prepare("SELECT id,content,depth,confidence,archived_at IS NOT NULL AS archived FROM promoted").all() as Record<string, unknown>[])
      .map((r) => [r.id, r.content, String(r.depth), numeric(r.confidence), String(Number(r.archived) === 1)]);
    return {
      conversations: digestRows(rows("SELECT session_id,title FROM conversations")),
      messages: digestRows(rows("SELECT c.session_id,CAST(m.seq AS TEXT),m.role,m.content,CAST(m.token_count AS TEXT) FROM messages m JOIN conversations c ON c.conversation_id=m.conversation_id")),
      parts: digestRows(rows("SELECT p.part_id,p.part_type,p.text_content FROM message_parts p")),
      summaries: digestRows(rows("SELECT summary_id,kind,CAST(depth AS TEXT),content,CAST(token_count AS TEXT) FROM summaries")),
      memories: digestRows(memories),
      instructions: digestRows(rows("SELECT scope_hash,client_name,session_id,content FROM session_instruction_cache")),
    };
  } finally {
    db.close();
  }
}

/** The same domains from PostgreSQL for the project bound to the given normalized path. */
export async function postgresDomainDigests(db: PostgreSqlTestDatabase, normalizedPath: string): Promise<DomainDigests> {
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    const found = await administrator.query<{ project_id: string }>({
      text: "SELECT project_id FROM lcm.project_aliases WHERE normalized_path = $1 LIMIT 1", values: [normalizedPath],
    }, { domain: "factory", operation: "rehearsalFindProject" });
    const projectId = found.rows[0]?.project_id;
    if (projectId === undefined) throw new Error("rehearsal destination project is absent");
    const rows = async (text: string): Promise<(readonly unknown[])[]> => {
      const result = await administrator.query({ text, values: [projectId] }, { domain: "factory", operation: "rehearsalDigest" });
      return result.rows.map((record: Record<string, unknown>) => Object.values(record));
    };
    const memories = (await rows("SELECT memory_id,content,depth,confidence::text,(archived_at IS NOT NULL)::text FROM lcm.promoted_memories WHERE project_id=$1"))
      .map((r) => [r[0], r[1], String(r[2]), numeric(r[3]), String(r[4] === "true")]);
    return {
      conversations: digestRows(await rows("SELECT session_id,title FROM lcm.conversations WHERE project_id=$1")),
      messages: digestRows(await rows("SELECT c.session_id,m.seq::text,m.role,m.content,m.token_count::text FROM lcm.messages m JOIN lcm.conversations c ON c.project_id=m.project_id AND c.conversation_id=m.conversation_id WHERE m.project_id=$1")),
      parts: digestRows(await rows("SELECT part_id::text,part_type,text_content FROM lcm.message_parts WHERE project_id=$1")),
      summaries: digestRows(await rows("SELECT summary_id,kind,depth::text,content,token_count::text FROM lcm.summaries WHERE project_id=$1")),
      memories: digestRows(memories),
      instructions: digestRows(await rows("SELECT scope_hash,client_name,session_id,content FROM lcm.session_instructions WHERE project_id=$1")),
    };
  } finally {
    await administrator.close();
  }
}

// ─── Oracles ───────────────────────────────────────────────────────────────

export interface AuthorityObservation {
  readonly configBackend: string;
  readonly boundProjects: number;
  readonly maintenancePhase: string | null;
  readonly publicationPhase: string | null;
  readonly publicationTarget: string | null;
  readonly admitted: readonly string[];
}

function admits(home: string, backend: "sqlite" | "postgresql"): boolean {
  try {
    assertBackendPublicationConsumerAccess({ backend, homeDir: home });
    return true;
  } catch {
    return false;
  }
}

/** I1: durable authority from the authenticated journals, the config and the project map, plus independent consumer admission. */
export function readAuthority(h: RehearsalHome): AuthenticatedAuthority {
  const config = JSON.parse(readFileSync(configPath(h.home), "utf8")) as { storage?: { backend?: string } };
  let map: Record<string, { remoteProjectId?: string }> = {};
  try { map = JSON.parse(readFileSync(projectMapPath(h.home), "utf8")) as typeof map; } catch { /* absent map */ }
  let maintenancePhase: string | null = null;
  try { maintenancePhase = readBackendMaintenanceJournal(h.home)?.phase ?? null; } catch { maintenancePhase = "unreadable"; }
  let publicationPhase: string | null = null;
  let publicationTarget: string | null = null;
  try {
    const journal = readBackendPublicationJournal(h.home);
    publicationPhase = journal?.phase ?? null;
    publicationTarget = journal?.targetBackend ?? null;
  } catch { publicationPhase = "unreadable"; }
  const admitted = (["sqlite", "postgresql"] as const).filter((backend) => admits(h.home, backend));
  return {
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
  private started = Date.now();

  constructor(
    readonly spec: ScenarioSpec,
    readonly manifest: Manifest,
    readonly db: PostgreSqlTestDatabase,
    readonly role: RehearsalRole,
    public h: RehearsalHome,
  ) {
    this.secrets = [role.url, new URL(role.url).password];
  }

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
    const result = await runCli(home, args, { secrets: this.secrets, env: extra.env, deadlineMs: extra.deadlineMs ?? spec.deadlineMs });
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
    const result = await runCli(home, args, { raw: true, secrets: this.secrets });
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
    const expected = this.spec.authority.find((entry) => entry.checkpoint === checkpoint);
    if (expected === undefined) throw new Error("scenario " + this.spec.id + " has no authority checkpoint " + checkpoint);
    const observed = readAuthority(home);
    const failures: string[] = [];
    if (observed.admitted.length > 1) failures.push("mixed admission " + observed.admitted.join(","));
    if (!sameJson([...observed.admitted].sort(), [...expected.admitted].sort())) failures.push("admitted " + observed.admitted.join(",") + " != " + expected.admitted.join(","));
    if (expected.configBackend !== undefined && observed.configBackend !== expected.configBackend) failures.push("config " + observed.configBackend);
    if (expected.boundProjects !== undefined && observed.boundProjects !== expected.boundProjects) failures.push("bound " + String(observed.boundProjects));
    this.authorities.push({
      checkpoint, lastCommittedBackend: expected.lastCommittedBackend,
      consumerAdmission: observed.admitted.length === 0 ? "fenced" : "admitted",
      witnesses: [observed.configBackend, observed.maintenancePhase ?? "none", observed.publicationPhase ?? "none"],
    });
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

  /** I6 for this scenario: the private home is removed and proven absent; the owned role is dropped. */
  async cleanup(): Promise<void> {
    const homes = [this.h, ...this.extraHomes];
    const absent = homes.map((home) => removeHome(home));
    try { await dropRole(this.db, this.role); } catch { /* the database drop removes the role grants; the role is dropped below */ }
    this.invariants.I6 = { status: absent.every(Boolean) ? "pass" : "fail", evidenceRefs: ["homes-absent:" + String(absent.length)] };
  }

  /** The most recent error the daemon recorded for the route (closed text from its sidecar error log). */
  private lastPromoteRefusal(): string {
    const events = new DatabaseSync(join(this.h.home, ".lcm", "events", this.h.localProjectId + ".db"), { readOnly: true });
    try {
      const row = events.prepare("SELECT error FROM error_log WHERE hook = 'promote-events' ORDER BY id DESC LIMIT 1").get() as { error?: string } | undefined;
      return row?.error ?? "";
    } finally {
      events.close();
    }
  }

  /** One bounded awaited drain request to the running daemon: the same POST that 'lcm events promote' issues. */
  async promote(daemon: RunningDaemon, id: string): Promise<Record<string, unknown>> {
    // The daemon's own background sweep can hold the publication mutation lock; the route answers 500 "retry after the
    // active operation completes". One awaited retry is allowed for exactly that refusal; any other failure is fatal.
    const request = (): Promise<Record<string, unknown>> => daemon.client.post<Record<string, unknown>>("/promote-events", { cwd: this.h.cwd, drain: true }, { timeoutMs: 60_000 });
    let retried = false;
    let result: Record<string, unknown>;
    try {
      result = await request();
    } catch (error) {
      if (!(error instanceof Error) || !/failed to promote events/u.test(error.message)) throw error;
      const reason = this.lastPromoteRefusal();
      if (!/already in progress/u.test(reason)) throw new Error("promote failed: " + reason);
      retried = true;
      result = await request();
    }
    this.steps.push({ id, surface: "http", command: ["POST", "/promote-events", "drain", retried ? "retried-once-after-lock-contention" : "single-request"], exitCode: null, outcome: null, reason: null, envelopeSha256: sha256(JSON.stringify(result)), checkpointRef: null });
    return result;
  }

  /** Run the foreground daemon for the callback with the case's disclosure secrets. */
  daemon<T>(callback: (daemon: RunningDaemon) => Promise<T>, options: { readonly env?: NodeJS.ProcessEnv } = {}): Promise<T> {
    return withDaemon(this.h, this.daemonPort, callback, { ...options, secrets: this.secrets });
  }

  extraHomes: RehearsalHome[] = [];
  daemonPort = 0;
  readonly ledger: LedgerEntry[] = [];

  record(verdict: Verdict, failure?: string): Record<string, unknown> {
    const invariants: Record<string, InvariantRecord> = {};
    for (const key of ["I1", "I2", "I3", "I4", "I5", "I6"] as const) {
      const declared = this.spec.invariants[key];
      invariants[key] = this.invariants[key] ?? (declared.startsWith("na:")
        ? { status: "not-applicable", evidenceRefs: [], reason: declared.slice(3) }
        : { status: "fail", evidenceRefs: [], reason: "not asserted" });
    }
    return {
      id: this.spec.id, fixture: this.spec.fixture, parameters: {}, supportingTests: this.spec.supportingTests,
      steps: this.steps, injections: this.injections, authority: this.authorities, invariants,
      acknowledgedInputDigest: sha256(JSON.stringify(this.canonicalDomainDigests)),
      canonicalDomainDigests: this.canonicalDomainDigests.map((entry) => ({ label: entry.label, domains: entry.domains })),
      knownLimits: this.spec.knownLimits, artifacts: this.artifacts, elapsedMs: Date.now() - this.started,
      verdict, ...(failure === undefined ? {} : { failure: failure.slice(0, 600) }),
    };
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
  options: { readonly env?: NodeJS.ProcessEnv; readonly deadlineMs?: number; readonly secrets?: readonly string[] } = {},
): Promise<T> {
  const child = spawn(process.execPath, [CLI_ENTRYPOINT, "daemon", "start", "--foreground"], {
    cwd: h.cwd, env: options.env ?? h.env, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
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
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  let exited = false;
  void closed.then(() => { exited = true; });
  const deadline = setTimeout(() => signalGroup("SIGKILL"), options.deadlineMs ?? 90_000);
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
    if (started === null) throw new Error("rehearsal daemon did not become healthy: " + sha256(output).slice(0, 12));
    return await callback({ port, pid: child.pid!, health: started.health, client: started.client });
  } finally {
    clearTimeout(deadline);
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
export async function adminSql(db: PostgreSqlTestDatabase, text: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    return (await administrator.query({ text, values }, { domain: "factory", operation: "rehearsalAdminSql" })).rows as Record<string, unknown>[];
  } finally {
    await administrator.close();
  }
}

export async function destinationProjectId(db: PostgreSqlTestDatabase, cwd: string): Promise<string> {
  const rows = await adminSql(db, "SELECT project_id FROM lcm.project_aliases WHERE normalized_path = $1 LIMIT 1", [cwd]);
  const id = rows[0]?.project_id;
  if (typeof id !== "string") throw new Error("rehearsal destination project is absent");
  return id;
}

/** A canonical write through the project-guarded repository under the ordinary runtime role (after the grant swap). */
export async function guardedWrite(c: RehearsalCase, sessionId: string): Promise<void> {
  const runtime = new PostgreSqlRuntime(settings(c.role.url));
  try {
    const repository = new PostgreSqlConversationRepository(runtime, await destinationProjectId(c.db, c.h.cwd));
    await repository.createConversation({ sessionId });
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

export interface LedgerEntry { readonly eventUuid: string; readonly machineSequence: string; readonly envelopeSha256: string }
export interface EventRow {
  readonly event_uuid: string; readonly event_version: number; readonly machine_sequence: string; readonly session_id: string;
  readonly seq: number; readonly type: string; readonly category: string; readonly data: string; readonly priority: number;
  readonly source_hook: string; readonly created_at: string; readonly processed_at: string | null; readonly delivery_state: string;
  readonly remote_inbox_id: string | null;
}

export function envelopeHash(row: EventRow): string {
  return sha256(JSON.stringify([row.event_uuid, row.event_version, row.machine_sequence, row.session_id, row.seq, row.type,
    row.category, row.data, row.priority, row.source_hook, row.created_at]));
}

export function readEventRows(h: RehearsalHome): EventRow[] {
  const path = join(h.home, ".lcm", "events", h.localProjectId + ".db");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT event_uuid,event_version,machine_sequence,session_id,seq,type,category,data,priority,source_hook,created_at,processed_at,delivery_state,remote_inbox_id FROM events ORDER BY machine_sequence").all() as unknown as EventRow[];
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
  const added = readEventRows(c.h).filter((row) => !before.has(row.event_uuid))
    .map((row) => ({ eventUuid: row.event_uuid, machineSequence: row.machine_sequence, envelopeSha256: envelopeHash(row) }));
  if (added.length !== data.length) throw new Error("acknowledged events were not retained by the durable enqueue");
  c.ledger.push(...added);
  return added;
}

function readEventRowsSafe(h: RehearsalHome): EventRow[] {
  try { return readEventRows(h); } catch { return []; }
}

/** Every acknowledged input must still be retained locally with an identical envelope. */
export function assertLedgerRetained(c: RehearsalCase, label: string): void {
  const rows = new Map(readEventRows(c.h).map((row) => [row.event_uuid, row]));
  const missing = c.ledger.filter((entry) => {
    const row = rows.get(entry.eventUuid);
    return row === undefined || envelopeHash(row) !== entry.envelopeSha256 || row.machine_sequence !== entry.machineSequence;
  });
  c.invariants.I3 ??= { status: "pass", evidenceRefs: [] };
  c.invariants.I3.evidenceRefs.push(label + ":" + String(c.ledger.length));
  if (missing.length > 0) {
    c.invariants.I3.status = "fail";
    throw new Error("I3 acknowledged input lost or changed at " + label + ": " + String(missing.length));
  }
}

// ─── Genuine process kill at a named existing seam ─────────────────────────

const WORKER_PATH = join(process.cwd(), "test/postgresql/fixtures/cutover-rehearsal-worker.mjs");

/** Fork the rehearsal worker, wait for its readiness message at the named seam, SIGKILL exactly that process group, await close. */
export async function killWorkerAtSeam(c: RehearsalCase, boundary: string): Promise<{ readonly signal: string | null; readonly generationId: string }> {
  const child = fork(WORKER_PATH, [], {
    cwd: c.h.cwd, env: { ...c.h.env, LCM_REHEARSAL_WORKER_BOUNDARY: boundary }, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: true,
  });
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
  try {
    const reached = await ready;
    signalGroup("SIGKILL");
    const outcome = await closed;
    c.injections.push({ surface: "module-seam", boundary, kind: "process-kill", hitCount: 1, signal: outcome.signal });
    return { signal: outcome.signal, generationId: reached.generationId };
  } finally {
    clearTimeout(deadline);
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
export async function expireCopyLease(db: PostgreSqlTestDatabase): Promise<number> {
  const rows = await adminSql(db, "UPDATE lcm.fenced_leases SET acquired_at = acquired_at - interval '2 hours', renewed_at = renewed_at - interval '2 hours', expires_at = expires_at - interval '2 hours' WHERE resource_type = 'migration-copy' AND released_at IS NULL RETURNING 1 AS n");
  return rows.length;
}

// ─── In-process module-seam interruption of the production activation ─────

export class InjectedInterruption extends Error {
  constructor(readonly point: string) { super("rehearsal-interruption:" + point); this.name = "InjectedInterruption"; }
}

/** Operator environment for in-process production entries: private HOME plus the destination variables. */
export async function withOperatorEnv<T>(c: RehearsalCase, home: RehearsalHome, callback: () => Promise<T>): Promise<T> {
  const caFile = harnessEnvironment().LCM_TEST_POSTGRES_CA_FILE;
  vi.stubEnv("LCM_POSTGRES_URL", c.role.url);
  vi.stubEnv("LCM_POSTGRES_CA_FILE", caFile);
  vi.stubEnv("LCM_POSTGRES_MIGRATION_ROLE", MIGRATION_ROLE);
  try {
    return await withHome(home.home, callback);
  } finally {
    vi.unstubAllEnvs();
  }
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
  const outcome = await withOperatorEnv(c, home, async () => {
    const destination = await resolveMigrationDestination({ cwd: home.cwd, homeDir: home.home });
    if (destination.status === "refuse") throw new Error("rehearsal destination did not resolve: " + destination.reason);
    try {
      const result = await runMigrationActivation({
        homeDir: home.home, generationId: c.gen, transferSettings: destination.settings, ordinarySettings: destination.settings,
        expectedIdentity: destination.expectedIdentity, expectedOwner: destination.expectedOwner,
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
  const runtime = new PostgreSqlRuntime(settings(c.role.url));
  const projectId = await destinationProjectId(c.db, c.h.cwd);
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
  await adminSql(c.db, "UPDATE lcm.fenced_leases SET acquired_at = acquired_at - interval '2 hours', renewed_at = renewed_at - interval '2 hours', expires_at = expires_at - interval '2 hours' WHERE resource_type = $1", [resourceType]);
  const second = await competingLease(c, resourceType, resourceKey);
  const runtime = new PostgreSqlRuntime(settings(c.role.url));
  try {
    const projectId = await destinationProjectId(c.db, c.h.cwd);
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
  const projectId = await destinationProjectId(c.db, c.h.cwd);
  const machineId = readMachineIdentity(c.h.home)!.machineId!;
  const rows = await adminSql(c.db, "INSERT INTO lcm.fenced_leases (project_id, resource_type, resource_key, owner_machine_id, owner_process_id, operation, expires_at) VALUES ($1, 'backend-publication', 'selection', $2, $3, $4, statement_timestamp() + interval '10 minutes') RETURNING fencing_token::text AS token", [projectId, machineId, OWNER, FOREIGN_PUBLICATION_OPERATION]);
  return {
    fencingToken: String(rows[0]!.token),
    release: async () => { await adminSql(c.db, "DELETE FROM lcm.fenced_leases WHERE project_id = $1 AND resource_type = 'backend-publication' AND owner_process_id = $2", [projectId, OWNER]); },
  };
}

// ─── Uncertain commit (F3) ─────────────────────────────────────────────────

/**
 * Run the production apply sequence in-process with one server-committed response loss on the receipt-owning
 * connection: the real COMMIT is awaited first, then ECONNRESET is raised, exactly as migration-copy.integration.ts does.
 */
export async function applyWithResponseLoss(c: RehearsalCase): Promise<{ readonly lost: boolean; readonly status: string }> {
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
        expectedIdentity: identity.expectedIdentity, ownerProcessId: "cutover-rehearsal-response-loss", maxRecords: 1, maxBytes: 150994944,
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

export interface InboxRow { readonly event_id: string; readonly status: string; readonly machine_sequence: string }

/** PostgreSQL inbox disposition per event: the remote half of the I3 join. */
export async function inboxRows(db: PostgreSqlTestDatabase): Promise<InboxRow[]> {
  return await adminSql(db, "SELECT event_id::text AS event_id, status, machine_sequence::text AS machine_sequence FROM lcm.passive_event_inbox ORDER BY machine_sequence") as unknown as InboxRow[];
}

/**
 * I3 join after a bounded drain: every acknowledged input is still retained locally with an identical envelope, no
 * PostgreSQL inbox row is foreign to the ledger, and no event has more than one remote disposition. Remote delivery is
 * asynchronous with backoff, so the observed dispositions are recorded as evidence, not required to be terminal.
 */
export async function assertEventsJoined(c: RehearsalCase, label: string): Promise<void> {
  assertLedgerRetained(c, label);
  const rows = await inboxRows(c.db);
  const known = new Set(c.ledger.map((entry) => entry.eventUuid));
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.event_id, (counts.get(row.event_id) ?? 0) + 1);
  const foreign = rows.filter((row) => !known.has(row.event_id)).length;
  const duplicated = [...counts.values()].filter((count) => count > 1).length;
  const byStatus: Record<string, number> = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  c.invariants.I3 ??= { status: "pass", evidenceRefs: [] };
  c.invariants.I3.evidenceRefs.push(label + ":inbox=" + JSON.stringify(byStatus));
  if (foreign > 0 || duplicated > 0) {
    c.invariants.I3.status = "fail";
    throw new Error("I3 remote join failed at " + label + ": foreign=" + String(foreign) + " duplicated=" + String(duplicated));
  }
}

// ─── In-process module-seam interruption of the production rollback ───────

/** Settings and project resolved while the harness environment is unambiguous, for writes made inside an operator-environment window. */
export async function prepareGuardedWriter(c: RehearsalCase): Promise<(sessionId: string) => Promise<void>> {
  const connection = settings(c.role.url);
  const projectId = await destinationProjectId(c.db, c.h.cwd);
  return async (sessionId: string): Promise<void> => {
    const runtime = new PostgreSqlRuntime(connection);
    try {
      await new PostgreSqlConversationRepository(runtime, projectId).createConversation({ sessionId });
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
      const result = await runMigrationRollbackFromHome({ homeDir: home.home, generationId: c.gen }, dependencies);
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
      const result = await activateCutoverSet({ homeDir: c.h.home, confirmSetId: c.gen, targetConfig }, dependencies);
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
      const result = await rollbackCutoverSet({ homeDir: c.h.home, confirmSetId: c.gen }, dependencies);
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
      homeDir: c.h.home, confirmSetId: candidate.setId, targetConfig, maxRecords: 1, maxBytes: 16 * 1024 * 1024,
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
