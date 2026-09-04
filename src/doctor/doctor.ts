import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, lstatSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import type { CheckResult, DoctorDeps } from "./types.js";
import {
  hasCanonicalClaudeMcpEntry,
  hasManagedClaudeSettings,
  mergeClaudeMcpEntry,
  mergeClaudeSettings,
  REQUIRED_HOOKS,
  ensureLcmMd,
  installClaudeSkill,
  removeClaudeLegacyAssets,
  resolveClaudeTransport,
} from "../../installer/install.js";
import { renderGuidance } from "../connectors/template-service.js";
import { NATIVE_PATTERNS, ScrubEngine, readGitleaksSyncDate } from "../scrub.js";
import { GITLEAKS_PATTERNS } from "../generated-patterns.js";
import { collectEventStats, collectDetailedEventStats } from "../db/events-stats.js";
import { validateRegex } from "../store/regex-safety.js";
import {
  configPath,
  daemonPidPath,
  daemonTokenPath,
  lcmHomeDir,
  projectsDir,
} from "../runtime-paths.js";
import {
  hashProjectPath,
  normalizeProjectIdentityPath,
  normalizeProjectPath,
  projectMapPath,
  readProjectMapSnapshot,
  validateProjectMap,
  type ProjectMapValidation,
} from "../project-map.js";
import { packageExecutable, packageRootFor } from "../runtime-root.js";
import { sanitizeTerminalText } from "../terminal-sanitize.js";
import { managedDaemonPath } from "../daemon/managed-path.js";
import { daemonEntrypointMatches } from "../daemon/lifecycle-scope.js";
import { RUNTIME_DIGEST } from "../daemon/version.js";
import {
  ConfigValidationError,
  DEFAULT_DAEMON_PORT,
  daemonConfigSnapshotWitnessEqual,
  parseDaemonConfig,
  readDaemonConfigRawSnapshot,
  resolveDaemonConfigEnv,
  type DaemonConfig,
  type DaemonConfigRawSnapshot,
  type LlmRetryPolicy,
  type ResolvedStorageConfig,
} from "../daemon/config.js";
import {
  isStagedPostgreSqlHealth,
  type StagedPostgreSqlHealthResponse,
} from "../daemon/staged-postgresql.js";
import { listWorktreeReconciliationJournals } from "../worktree-reconciliation.js";
import {
  clearDaemonNotice,
  sanitizeDaemonRefusalReason,
} from "../hooks/daemon-notice.js";
import {
  isDaemonRefusalReason,
  mapDaemonRefusalToRemediation,
  type DaemonRefusalReason,
} from "../daemon/remediation.js";
import {
  assertBackendPublicationConfigReadAccess,
  BackendPublicationJournalError,
  withBackendPublicationReadRoot,
} from "../storage/backend-publication.js";
import {
  PrivateMutationLockContentionError,
  processStartTime,
  readPrivateMutationLockOwner,
} from "../private-mutation-lock.js";

const COLORS = {
  green: "\x1b[0;32m",
  yellow: "\x1b[1;33m",
  red: "\x1b[0;31m",
  cyan: "\x1b[0;36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  nc: "\x1b[0m",
};

function defaultDeps(): DoctorDeps {
  return {
    existsSync,
    readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
    writeFileSync,
    mkdirSync: (p, o) => mkdirSync(p, o),
    lstatSync,
    readdirSync,
    spawnSync: (cmd, args, opts) => {
      const r = spawnSync(cmd, args, { encoding: "utf-8", ...opts });
      return { status: r.status, stdout: r.stdout as string, stderr: r.stderr as string };
    },
    fetch: globalThis.fetch,
    homedir: homedir(),
    platform: platform(),
  };
}

interface DoctorConfig {
  port: number;
  storageBackend: "sqlite" | "postgresql" | "unavailable";
  storage?: ResolvedStorageConfig;
  summarizer: string;
  apiMode?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  requestTimeoutMs?: number;
  retry?: LlmRetryPolicy;
  validationError?: ConfigValidationError;
  publicationError?: BackendPublicationJournalError;
}

const PASSIVE_BACKLOG_WARN_THRESHOLD = 200;
const DAEMON_HEALTH_DEADLINE_MS = 2000;

function publicationAdmissionMessage(
  reason: BackendPublicationJournalError["reason"],
): string {
  switch (reason) {
    case "publication-evidence-missing":
      return "Backend publication admission is blocked: completed publication evidence is missing. Complete or recover the backend publication, then rerun lcm doctor.";
    case "unresolved-publication":
      return "Backend publication admission is blocked: a backend publication is unresolved. Complete or abort the pending publication, then rerun lcm doctor.";
    case "unsafe-storage":
    case "malformed-journal":
    case "checksum-mismatch":
    case "unexpected-state":
    case "permit-mismatch":
    case "backend-mismatch":
    case "invalid-input":
      return "Backend publication admission is blocked: authenticated publication state is invalid or unsafe. Stop automatic repair and inspect the installation before retrying.";
  }
}

function checkBackendPublicationAdmission(
  results: CheckResult[],
  config: DoctorConfig,
): boolean {
  if (config.publicationError !== undefined) {
    const error = config.publicationError;
    results.push({
      name: "backend-publication",
      category: "Storage",
      status: "fail",
      message: publicationAdmissionMessage(error.reason),
    });
    return true;
  }
  return false;
}

type DaemonStorageReadiness = "ready" | "unavailable" | "unverified";

type DoctorDaemonHealth = StagedPostgreSqlHealthResponse & {
  readonly status?: string;
  /** Authenticated health only: the daemon's resolved runtime entrypoint. */
  readonly entrypoint?: string;
  /** Authenticated health only: the packaged runtime digest. */
  readonly runtimeDigest?: string;
};

type LifecycleResultWithRefusal = Readonly<{
  refusalReason?: unknown;
  warning?: unknown;
}>;

/**
 * Resolve one canonical state root for remediation marker operations.  The
 * marker is only a hint, so a missing root remains a safe, lexical fallback;
 * no lifecycle decision depends on this helper succeeding.
 */
function daemonRemediationScope(homeDir: string): Readonly<{ scope: string; stateRoot: string }> {
  const root = lcmHomeDir(homeDir);
  try {
    const canonical = realpathSync(root);
    return { scope: canonical, stateRoot: canonical };
  } catch {
    const lexical = resolve(root);
    return { scope: lexical, stateRoot: lexical };
  }
}

function refusalReasonFrom(
  value: unknown,
  fallback: DaemonRefusalReason = "ambiguous",
): DaemonRefusalReason {
  const candidate = (value as LifecycleResultWithRefusal | null | undefined)?.refusalReason;
  return isDaemonRefusalReason(candidate) ? candidate : fallback;
}

function remediationGuidance(reason: DaemonRefusalReason): string {
  return mapDaemonRefusalToRemediation(sanitizeDaemonRefusalReason(reason)).message;
}

async function readRecognizedDaemonHealth(
  fetchFn: typeof globalThis.fetch,
  port: number,
  token?: string | null,
  timeoutMs = DAEMON_HEALTH_DEADLINE_MS,
): Promise<DoctorDaemonHealth | null> {
  if (token === null) return null;
  const controller = new AbortController();
  let timeout!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Daemon health check timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const res = await fetchFn(`http://127.0.0.1:${port}/health`, {
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
          signal: controller.signal,
        });
        const health = await res.json() as DoctorDaemonHealth;
        return (res.ok && health.status === "ok")
          || isStagedPostgreSqlHealth(res.status, health)
          ? health
          : null;
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function readDoctorDaemonToken(deps: DoctorDeps): string | null {
  try {
    return deps.readFileSync(daemonTokenPath(deps.homedir), "utf-8").trim() || null;
  } catch {
    return null;
  }
}

async function readDoctorAuthenticatedHealth(
  deps: DoctorDeps,
  port: number,
): Promise<DoctorDaemonHealth | null> {
  return readRecognizedDaemonHealth(
    deps.fetch,
    port,
    readDoctorDaemonToken(deps),
  );
}

const PUBLICATION_CONVERGENCE_MS = 2_000;
const PUBLICATION_CONVERGENCE_POLL_MS = 50;

/**
 * The exact managed daemon that doctor is willing to wait for. Every field is
 * taken from token-authenticated health so that only the daemon holding the
 * daemon token can be treated as the convergence owner.
 */
type ConvergenceDaemonIdentity = Readonly<{
  pid: number;
  version: string | undefined;
  storageBackend: "sqlite" | "postgresql";
  entrypoint: string | undefined;
  runtimeDigest: string | undefined;
}>;

/**
 * Doctor stages that must remain eligible for convergence share one wall-clock
 * budget so the total time spent waiting on the daemon's publication work is
 * bounded across the entire doctor run, not per stage.
 */
type PublicationConvergence = Readonly<{
  identity: ConvergenceDaemonIdentity | undefined;
  deadline: number;
  now: () => number;
  sleep: (delayMs: number) => Promise<void>;
}>;

function daemonHealthMatchesIdentity(
  health: DoctorDaemonHealth | null,
  identity: ConvergenceDaemonIdentity,
  expectedRuntimeDigest: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  return health !== null
    && health.pid === identity.pid
    && health.version === identity.version
    && (health.storageBackend ?? "sqlite") === identity.storageBackend
    && daemonEntrypointMatches(health.entrypoint, identity.entrypoint, platform)
    && (expectedRuntimeDigest === undefined || health.runtimeDigest === expectedRuntimeDigest);
}

/**
 * Build the identity doctor will require from token-authenticated health
 * before any retry. The PID comes from the initial recognized health probe;
 * every remaining field is the identity this installation expects, so a
 * daemon must prove all of them through authenticated health at retry time.
 */
function expectedConvergenceIdentity(
  initialHealthPid: number | undefined,
  config: DoctorConfig,
  expectedVersion: string | undefined,
  expectedEntrypoint: string,
  expectedRuntimeDigest: string | undefined,
): ConvergenceDaemonIdentity | undefined {
  if (
    initialHealthPid === undefined
    || (config.storageBackend !== "sqlite" && config.storageBackend !== "postgresql")
  ) return undefined;
  return {
    pid: initialHealthPid,
    version: expectedVersion,
    storageBackend: config.storageBackend,
    entrypoint: expectedEntrypoint,
    runtimeDigest: expectedRuntimeDigest,
  };
}

function createPublicationConvergence(
  deps: DoctorDeps,
  identity: ConvergenceDaemonIdentity | undefined,
): PublicationConvergence {
  const now = deps._publicationConvergenceNow ?? Date.now;
  const sleep = deps._publicationConvergenceSleep
    ?? ((delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs)));
  return {
    identity,
    deadline: now() + PUBLICATION_CONVERGENCE_MS,
    now,
    sleep,
  };
}

/**
 * Decide whether one lock-contention failure may be retried. Only the exact
 * authenticated daemon identity captured at the start of doctor qualifies: the
 * lock owner PID and process birth must match, the owner must still be live,
 * and a fresh token-authenticated health exchange must confirm the same
 * daemon. Foreign, ambiguous, malformed, stale, or unresolved owners and any
 * identity drift are refused so the original typed error propagates unchanged.
 */
async function convergenceRetryDelay(
  deps: DoctorDeps,
  port: number,
  convergence: PublicationConvergence,
  error: unknown,
): Promise<number | undefined> {
  if (!(error instanceof PrivateMutationLockContentionError) || convergence.identity === undefined) {
    return undefined;
  }
  if (convergence.now() >= convergence.deadline) return undefined;
  let owner;
  try {
    owner = (deps._readPrivateMutationLockOwnerForTesting ?? readPrivateMutationLockOwner)(
      join(deps.homedir, ".lcm.backend-publication.lock"),
      "backend publication",
    );
  } catch {
    return undefined;
  }
  if (
    owner === null
    || owner.pid !== convergence.identity.pid
    || owner.processStartTime === null
  ) return undefined;
  const remainingBirthBudgetMs = convergence.deadline - convergence.now();
  if (remainingBirthBudgetMs <= 0) return undefined;
  const observedProcessStartTime = (
    deps._processStartTimeForTesting ?? processStartTime
  )(owner.pid, undefined, { timeoutMs: remainingBirthBudgetMs });
  if (observedProcessStartTime !== owner.processStartTime) return undefined;
  const token = readDoctorDaemonToken(deps);
  const remainingHealthBudgetMs = convergence.deadline - convergence.now();
  if (remainingHealthBudgetMs <= 0) return undefined;
  let health: DoctorDaemonHealth | null;
  try {
    health = await readRecognizedDaemonHealth(
      deps.fetch,
      port,
      token,
      Math.min(DAEMON_HEALTH_DEADLINE_MS, remainingHealthBudgetMs),
    );
  } catch {
    return undefined;
  }
  if (
    !daemonHealthMatchesIdentity(
      health,
      convergence.identity,
      convergence.identity.runtimeDigest,
      deps.platform,
    )
    || convergence.now() >= convergence.deadline
  ) return undefined;
  return Math.min(
    PUBLICATION_CONVERGENCE_POLL_MS,
    Math.max(1, convergence.deadline - convergence.now()),
  );
}

/**
 * Retry one lock-taking doctor stage within the shared budget. Synchronous
 * stages (project map, worktree journals) and asynchronous stages (daemon
 * lifecycle) share this helper; the identity check is asynchronous because it
 * performs an authenticated health exchange, so every stage is awaited here.
 */
async function withPublicationConvergence<T>(
  run: () => T | Promise<T>,
  deps: DoctorDeps,
  port: number,
  convergence: PublicationConvergence,
): Promise<T> {
  let firstContention: PrivateMutationLockContentionError | undefined;
  while (true) {
    if (firstContention !== undefined && convergence.now() >= convergence.deadline) {
      throw firstContention;
    }
    try {
      return await run();
    } catch (error) {
      const delay = await convergenceRetryDelay(deps, port, convergence, error);
      if (delay === undefined) throw error;
      firstContention ??= error as PrivateMutationLockContentionError;
      deps._betweenConvergenceAttemptsForTesting?.();
      await convergence.sleep(delay);
    }
  }
}

function storageReadinessFromHealth(
  health: DoctorDaemonHealth,
): DaemonStorageReadiness {
  return health.status === "ok" ? "ready" : "unavailable";
}

export interface DoctorRunOptions {
  verbose?: boolean;
  eventsMaxDbs?: number;
}

function normalizeDoctorOptions(options: boolean | DoctorRunOptions = false): Required<DoctorRunOptions> {
  if (typeof options === "boolean") {
    return { verbose: options, eventsMaxDbs: 50 };
  }
  const requestedMaxDbs = options.eventsMaxDbs;
  const eventsMaxDbs = typeof requestedMaxDbs === "number"
    && Number.isInteger(requestedMaxDbs)
    && Number.isFinite(requestedMaxDbs)
    && requestedMaxDbs > 0
    ? requestedMaxDbs
    : 50;
  return {
    verbose: options.verbose ?? false,
    eventsMaxDbs,
  };
}

function recoverConfiguredPort(content: string): number {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_DAEMON_PORT;
    const daemon = (parsed as Record<string, unknown>).daemon;
    if (daemon === null || typeof daemon !== "object" || Array.isArray(daemon)) return DEFAULT_DAEMON_PORT;
    const port = (daemon as Record<string, unknown>).port;
    return typeof port === "number"
      && Number.isInteger(port)
      && port >= 1
      && port <= 65535
      ? port
      : DEFAULT_DAEMON_PORT;
  } catch {
    return DEFAULT_DAEMON_PORT;
  }
}

/**
 * Every locked publication consumer opens the LCM root with O_NOFOLLOW, so a
 * symlinked or non-directory root is never admitted. Mirror that rule for the
 * lock-free doctor read so an unsafe root blocks admission before any repair.
 * The inspection is a real filesystem lstat: injected file readers are byte
 * sources only and cannot vouch for the root's shape.
 */
function assertLcmRootShape(homeDir: string, inspect: typeof lstatSync): void {
  const root = join(homeDir, ".lcm");
  let stat;
  try {
    stat = inspect(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new BackendPublicationJournalError(
      "unsafe-storage",
      `LCM root cannot be inspected: ${(error as Error).message}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new BackendPublicationJournalError("unsafe-storage", "LCM root is not a directory");
  }
}

function backendCandidate(content: string): "sqlite" | "postgresql" {
  try {
    const parsed = JSON.parse(content) as { storage?: { backend?: unknown } };
    return parsed.storage?.backend === "postgresql" ? "postgresql" : "sqlite";
  } catch {
    return "sqlite";
  }
}

function doctorConfigFromDaemonConfig(config: DaemonConfig): DoctorConfig {
  return {
    port: config.daemon.port,
    storageBackend: config.storage.backend,
    storage: config.storage,
    summarizer: config.llm.provider,
    apiMode: config.llm.apiMode,
    reasoningEffort: config.llm.reasoningEffort,
    fastMode: config.llm.fastMode,
    requestTimeoutMs: config.llm.provider === "openai" ? config.llm.requestTimeoutMs : undefined,
    retry: config.llm.provider === "openai" ? config.llm.retry : undefined,
    publicationError: undefined,
  };
}

/**
 * Read a valid daemon configuration without taking the publication mutation
 * lock. Doctor only needs a stable, authenticated snapshot for its admission
 * decision; repairs and other writes retain their own exclusive locks. Two
 * descriptor-bound snapshots and two journal admissions must agree, otherwise
 * the read is refused as unexpected state rather than trusted.
 */
function loadConfig(deps: DoctorDeps): DoctorConfig {
  const resolvedConfigPath = configPath(deps.homedir);
  const readSnapshot = deps._readDaemonConfigRawSnapshot ?? readDaemonConfigRawSnapshot;
  const assertReadAccess = deps._assertPublicationReadAccess ?? assertBackendPublicationConfigReadAccess;
  return withBackendPublicationReadRoot(deps.homedir, (assertReadRoot) => {
    const readVerifiedSnapshot = (): DaemonConfigRawSnapshot => {
      assertReadRoot();
      const snapshot = readSnapshot(resolvedConfigPath);
      assertReadRoot();
      return snapshot;
    };
    const assertVerifiedReadAccess = (
      backend: "sqlite" | "postgresql",
      snapshot: DaemonConfigRawSnapshot,
    ): Readonly<{ journalChecksumSha256: string | null }> => {
      assertReadRoot();
      const admission = assertReadAccess(resolvedConfigPath, backend, snapshot.witness);
      assertReadRoot();
      return admission;
    };
    const runInterleavingSeam = (): void => {
      assertReadRoot();
      deps._betweenConfigSnapshotsForTesting?.();
      assertReadRoot();
    };
    let first: DaemonConfigRawSnapshot | undefined;
    let parsed: DaemonConfig | undefined;
    try {
      assertLcmRootShape(deps.homedir, deps._lstatLcmRootForTesting ?? lstatSync);
      first = readVerifiedSnapshot();
      parsed = parseDaemonConfig(first.content, undefined, resolveDaemonConfigEnv(process.env));
      const firstAdmission = assertVerifiedReadAccess(parsed.storage.backend, first);
      runInterleavingSeam();
      const second = readVerifiedSnapshot();
      if (!daemonConfigSnapshotWitnessEqual(first.witness, second.witness)) {
        throw new BackendPublicationJournalError(
          "unexpected-state",
          "doctor config changed during lock-free read admission",
        );
      }
      const secondAdmission = assertVerifiedReadAccess(parsed.storage.backend, second);
      if (firstAdmission.journalChecksumSha256 !== secondAdmission.journalChecksumSha256) {
        throw new BackendPublicationJournalError(
          "unexpected-state",
          "doctor backend publication changed during lock-free read admission",
        );
      }
      if (first.witness.presence === "absent") {
        // No configuration yet: the daemon would run on defaults, but doctor
        // reports the summarizer as disabled until `lcm install` writes one.
        return {
          port: DEFAULT_DAEMON_PORT,
          storageBackend: "sqlite",
          storage: { backend: "sqlite" },
          summarizer: "disabled",
          publicationError: undefined,
        };
      }
      return doctorConfigFromDaemonConfig(parsed);
    } catch (error) {
      if (error instanceof BackendPublicationJournalError) {
        return {
          port: parsed?.daemon.port ?? DEFAULT_DAEMON_PORT,
          storageBackend: "unavailable",
          summarizer: "disabled",
          publicationError: error,
        };
      }
      const validationError = error instanceof ConfigValidationError
        ? error
        : new ConfigValidationError(
          "$",
          error instanceof Error ? error.message : String(error),
        );
      if (first !== undefined) {
        // The bytes were observed safely; only validation failed. Doctor still
        // authenticates publication evidence against the candidate backend so a
        // blocked publication is reported even when the config is invalid, and
        // still diagnoses the daemon on a recoverable port.
        let publicationError: BackendPublicationJournalError | undefined;
        try {
          const candidateBackend = backendCandidate(first.content);
          const firstAdmission = assertVerifiedReadAccess(candidateBackend, first);
          runInterleavingSeam();
          const second = readVerifiedSnapshot();
          if (!daemonConfigSnapshotWitnessEqual(first.witness, second.witness)) {
            throw new BackendPublicationJournalError(
              "unexpected-state",
              "doctor config changed during lock-free read admission",
            );
          }
          const secondAdmission = assertVerifiedReadAccess(candidateBackend, second);
          if (firstAdmission.journalChecksumSha256 !== secondAdmission.journalChecksumSha256) {
            throw new BackendPublicationJournalError(
              "unexpected-state",
              "doctor backend publication changed during lock-free read admission",
            );
          }
        } catch (admissionError) {
          if (!(admissionError instanceof BackendPublicationJournalError)) throw admissionError;
          publicationError = admissionError;
        }
        return {
          port: recoverConfiguredPort(first.content),
          storageBackend: "unavailable",
          summarizer: "disabled",
          validationError,
          publicationError,
        };
      }
      return {
        port: DEFAULT_DAEMON_PORT,
        storageBackend: "unavailable",
        summarizer: "disabled",
        validationError,
        publicationError: new BackendPublicationJournalError(
          "unsafe-storage",
          "backend publication admission is blocked because config bytes could not be observed safely",
        ),
      };
    }
  });
}

async function checkProjectMap(
  results: CheckResult[],
  deps: DoctorDeps,
  port: number,
  convergence: PublicationConvergence,
): Promise<void> {
  let validation: ProjectMapValidation;
  try {
    validation = await withPublicationConvergence(
      () => validateProjectMap({ homeDir: deps.homedir, fix: true }),
      deps,
      port,
      convergence,
    );
  } catch (err) {
    results.push({
      name: "project-map",
      category: "Project Map",
      status: "fail",
      message: `${projectMapPath(deps.homedir)}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  if (!validation.ok) {
    results.push({
      name: "project-map",
      category: "Project Map",
      status: "fail",
      message: `${validation.path}: ${validation.errors.join("; ")}`,
    });
    return;
  }

  if (validation.fixApplied) {
    const detail = validation.warnings.length > 0
      ? validation.warnings.join("; ")
      : "formatted map.json";
    const backup = validation.backupPath ? `; backup: ${validation.backupPath}` : "";
    results.push({
      name: "project-map",
      category: "Project Map",
      status: "warn",
      message: `${detail}${backup}`,
      fixApplied: true,
    });
    return;
  }

  const count = validation.map ? Object.keys(validation.map).length : 0;
  const mapExists = existsSync(validation.path);
  results.push({
    name: "project-map",
    category: "Project Map",
    status: "pass",
    message: !mapExists
      ? "map.json not created yet"
      : `${count} mapped project${count === 1 ? "" : "s"}`,
  });
}

async function checkWorktreeReconciliations(
  results: CheckResult[],
  deps: DoctorDeps,
  port: number,
  convergence: PublicationConvergence,
): Promise<void> {
  try {
    const journals = await withPublicationConvergence(
      () => listWorktreeReconciliationJournals(deps.homedir),
      deps,
      port,
      convergence,
    );
    const blocked = journals.filter((journal) => journal.phase === "blocked");
    const partial = journals.filter((journal) =>
      journal.phase !== "blocked" && journal.phase !== "completed");
    const completed = journals.filter((journal) => journal.phase === "completed");
    if (blocked.length > 0) {
      results.push({
        name: "worktree-reconciliation",
        category: "Project Map",
        status: "fail",
        message: `${blocked.length} blocked; run lcm project reconcile-worktrees to retry`,
      });
    } else if (partial.length > 0) {
      results.push({
        name: "worktree-reconciliation",
        category: "Project Map",
        status: "warn",
        message: `${partial.length} partial; run lcm project reconcile-worktrees to resume`,
      });
    } else {
      results.push({
        name: "worktree-reconciliation",
        category: "Project Map",
        status: "pass",
        message: completed.length > 0
          ? `${completed.length} completed reconciliation${completed.length === 1 ? "" : "s"}`
          : "no pending worktree reconciliations",
      });
    }
  } catch (error) {
    results.push({
      name: "worktree-reconciliation",
      category: "Project Map",
      status: "fail",
      message: String(error),
    });
  }
}

function diagnosticProjectPatternsPath(cwd: string, homeDir: string): string {
  const normalized = normalizeProjectPath(cwd);
  let canonical = normalized;
  try {
    canonical = normalizeProjectIdentityPath(cwd);
  } catch {
    // Other doctor checks report malformed Git metadata. Pattern diagnostics
    // must remain read-only and must not prevent accumulated results rendering.
  }
  let hash = hashProjectPath(canonical);
  try {
    const matches = Object.entries(readProjectMapSnapshot(homeDir))
      .filter(([, entry]) => (
        normalizeProjectPath(entry.canonical) === canonical
        || [entry.canonical, ...entry.aliases]
          .some((path) => normalizeProjectPath(path) === normalized)
      ));
    if (matches.length === 1) hash = matches[0]![0];
  } catch {
    // The project-map check already reports malformed or unreadable state.
  }
  return join(projectsDir(homeDir), hash, "sensitive-patterns.txt");
}

function daemonProcessPath(deps: DoctorDeps, pid: number | undefined): string | undefined {
  if (deps.platform !== "linux" || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  try {
    const environment = deps.readFileSync(`/proc/${pid}/environ`, "latin1");
    const pathEntry = environment.split("\0").find((entry) => entry.startsWith("PATH="));
    return pathEntry === undefined ? undefined : pathEntry.slice("PATH=".length);
  } catch {
    return undefined;
  }
}

const MANAGED_DAEMON_PLATFORMS = new Set(["linux", "darwin"]);

function usesManagedDaemonPath(platform: string): boolean {
  return MANAGED_DAEMON_PLATFORMS.has(platform);
}

function processBinaryMessage(platform: string, command: string, found: boolean): string {
  const status = found ? "found" : "not found";
  const scope = usesManagedDaemonPath(platform) ? " on managed daemon PATH" : "";
  return `${command} CLI ${status}${scope}`;
}

function checkBinary(deps: DoctorDeps, command: string, daemonPath: string): boolean {
  const managed = usesManagedDaemonPath(deps.platform);
  const opts = managed
    ? { env: { PATH: daemonPath } }
    : {};
  return deps.spawnSync(managed ? "/bin/sh" : "sh", ["-c", `command -v ${command}`], opts).status === 0;
}

function addClaudeProcessChecks(results: CheckResult[], deps: DoctorDeps, daemonPath: string): void {
  if (checkBinary(deps, "claude", daemonPath)) {
    results.push({ name: "claude-process", category: "Summarizer", status: "pass", message: processBinaryMessage(deps.platform, "claude", true) });
  } else {
    results.push({ name: "claude-process", category: "Summarizer", status: "fail", message: `${processBinaryMessage(deps.platform, "claude", false)}\n     Fix: npm install -g @anthropic-ai/claude-code alongside lcm` });
  }
}

function addCodexProcessChecks(results: CheckResult[], deps: DoctorDeps, daemonPath: string): void {
  if (checkBinary(deps, "codex", daemonPath)) {
    results.push({ name: "codex-process", category: "Summarizer", status: "pass", message: processBinaryMessage(deps.platform, "codex", true) });
  } else {
    results.push({ name: "codex-process", category: "Summarizer", status: "fail", message: `${processBinaryMessage(deps.platform, "codex", false)}\n     Fix: npm install -g @openai/codex alongside lcm` });
  }
}


function testMcpHandshake(): Promise<CheckResult> {
  return new Promise((resolve) => {
    const initMsg = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "doctor", version: "0.1" } } });
    const listMsg = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    // Resolve the binary relative to this file so it works outside Claude Code's PATH
    const binPath = packagedRuntimePath();
    const child = spawn(process.execPath, [binPath, "mcp"], { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    let finished = false;
    let stopRequested = false;
    let termination: Promise<void> | undefined;
    let recordChildClose!: () => void;
    const childClosed = new Promise<void>((resolveChildClose) => {
      recordChildClose = resolveChildClose;
    });
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const resultFromOutput = (): CheckResult => {
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const parsed = JSON.parse(line) as { id?: unknown; result?: { tools?: unknown } };
          if (parsed.id !== 2 || !Array.isArray(parsed.result?.tools)) continue;
          const count = parsed.result.tools.length;
          return { name: "mcp-handshake-lcm", category: "MCP Servers", status: count === 7 ? "pass" : "warn", message: `lcm: ${count}/7 tools` };
        } catch {}
      }
      return { name: "mcp-handshake-lcm", category: "MCP Servers", status: "warn", message: "lcm: 0/7 tools" };
    };

    const finish = (result: CheckResult): void => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      resolve(result);
    };

    const childIsLive = (): boolean => child.exitCode === null && child.signalCode === null;
    const signalChild = (signal: NodeJS.Signals): boolean => {
      if (!childIsLive()) return true;
      try { return child.kill(signal); } catch { return false; }
    };
    const waitForClose = async (timeoutMs: number): Promise<void> => {
      let resolveTimeout!: () => void;
      const timeout = new Promise<void>((resolve) => {
        resolveTimeout = resolve;
      });
      const timer = setTimeout(resolveTimeout, timeoutMs);
      await Promise.race([
        childClosed,
        timeout,
      ]);
      clearTimeout(timer);
    };
    const abandonChild = (): void => {
      try { child.stdin.destroy(); } catch {}
      try { child.stdout.destroy(); } catch {}
      try { child.unref(); } catch {}
    };
    const stopChild = (): Promise<void> => {
      stopRequested = true;
      if (!childIsLive()) return Promise.resolve();
      termination ??= (async () => {
        const termSent = signalChild("SIGTERM");
        if (termSent && childIsLive()) await waitForClose(250);
        if (childIsLive()) {
          signalChild("SIGKILL");
          await waitForClose(250);
        }
        if (childIsLive()) abandonChild();
      })();
      return termination;
    };
    const stopChildForPipeFailure = (): void => {
      if (finished) return;
      void stopChild();
    };
    const stdinIsWritable = (): boolean => !finished
      && !stopRequested
      && childIsLive()
      && child.stdin.writable
      && !child.stdin.destroyed
      && !child.stdin.writableEnded;

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stdout.on("error", stopChildForPipeFailure);
    child.on("close", () => {
      recordChildClose();
      finish(resultFromOutput());
    });
    child.on("error", () => {
      if (stopRequested) return;
      finish({ name: "mcp-handshake-lcm", category: "MCP Servers", status: "warn", message: "Could not spawn MCP process" });
    });
    child.stdin.on("error", stopChildForPipeFailure);
    child.stdin.on("close", () => {
      if (!child.stdin.writableEnded) stopChildForPipeFailure();
    });

    timers.add(setTimeout(() => {
      void (async () => {
        try {
          await stopChild();
        } finally {
          finish(resultFromOutput());
        }
      })();
    }, 6000));

    // Send initialize, wait 300ms, then send tools/list, then close stdin after 500ms
    if (!stdinIsWritable()) {
      stopChildForPipeFailure();
      return;
    }
    timers.add(setTimeout(() => {
      if (!stdinIsWritable()) {
        stopChildForPipeFailure();
        return;
      }
      timers.add(setTimeout(() => {
        if (!stdinIsWritable()) {
          stopChildForPipeFailure();
          return;
        }
        try {
          child.stdin.end();
        } catch {
          stopChildForPipeFailure();
        }
      }, 500));
      try {
        child.stdin.write(listMsg + "\n");
      } catch {
        stopChildForPipeFailure();
      }
    }, 300));
    try {
      child.stdin.write(initMsg + "\n");
    } catch {
      stopChildForPipeFailure();
    }
  });
}

function packagedRuntimePath(): string {
  return packageExecutable(import.meta.url, 3);
}

function formatTimeAgo(date: Date): string {
  const ms = Math.max(0, Date.now() - date.getTime());
  if (ms === 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function checkPassiveLearning(
  results: CheckResult[],
  options: Required<DoctorRunOptions>,
  daemonHealthy: boolean,
  daemonStorageReadiness: DaemonStorageReadiness,
  repairBlocked: boolean,
  publicationBlocked: boolean,
): Promise<void> {
  if (repairBlocked) {
    results.push({
      name: "events-capture",
      category: "Passive Learning",
      status: "skip",
      message: publicationBlocked
        ? "Skipped because backend publication admission is blocked"
        : "Skipped because configuration validation failed; automatic passive-learning repair is disabled",
    });
    return;
  }
  const statsOptions = { timeoutMs: 2000, maxDbs: options.eventsMaxDbs, pruneOrphanSidecars: true };
  const stats = options.verbose
    ? await collectDetailedEventStats(statsOptions)
    : await collectEventStats(statsOptions);

  if ((stats.prunedSidecars ?? 0) > 0) {
    results.push({
      name: "events-sidecar-prune",
      category: "Passive Learning",
      status: "pass",
      message: `pruned ${stats.prunedSidecars} empty/stale orphan sidecar${stats.prunedSidecars === 1 ? "" : "s"}`,
      fixApplied: true,
    });
  }

  // Capture check
  if (stats.captured === 0) {
    results.push({ name: "events-capture", category: "Passive Learning", status: "warn", message: "No events captured — passive learning may not be active\n     Fix: run 'lcm install' to re-register hooks, then use a Bash or Edit tool to trigger the first event capture; re-run /lcm-doctor to verify" });
  } else if (
    stats.unprocessed > 0
    && daemonHealthy
    && daemonStorageReadiness === "unavailable"
  ) {
    results.push({
      name: "events-capture",
      category: "Passive Learning",
      status: "warn",
      message: `${stats.captured} events (${stats.unprocessed} unprocessed) — daemon is up but storage is unavailable; the queue cannot drain until storage is healthy`,
    });
  } else if (
    stats.unprocessed > 0
    && daemonHealthy
    && daemonStorageReadiness === "unverified"
  ) {
    results.push({
      name: "events-capture",
      category: "Passive Learning",
      status: "warn",
      message: `${stats.captured} events (${stats.unprocessed} unprocessed) — daemon is up but storage readiness could not be authenticated; restore access to the daemon token and authenticated diagnostics before the queue can be promised to drain`,
    });
  } else if (stats.unprocessed >= PASSIVE_BACKLOG_WARN_THRESHOLD) {
    const sidecarCount = stats.sidecarsWithUnprocessed ?? 0;
    const orphanCount = stats.orphanedSidecarsWithUnprocessed ?? 0;
    if (daemonHealthy) {
      const scope = sidecarCount > 0
        ? ` across ${sidecarCount} project sidecar${sidecarCount === 1 ? "" : "s"}`
        : "";
      const orphanNote = orphanCount > 0
        ? `; ${orphanCount} sidecar${orphanCount === 1 ? "" : "s"} missing metadata`
        : "";
      if (orphanCount > 0 && orphanCount === sidecarCount) {
        results.push({ name: "events-capture", category: "Passive Learning", status: "warn", message: `${stats.captured} events (${stats.unprocessed} unprocessed${scope}${orphanNote}) — project metadata is missing; lcm events promote --all can only report orphaned sidecars — remove stale orphan sidecars or trigger new activity after lcm install` });
      } else if (orphanCount > 0) {
        results.push({ name: "events-capture", category: "Passive Learning", status: "warn", message: `${stats.captured} events (${stats.unprocessed} unprocessed${scope}${orphanNote}) — daemon is up — run: lcm events promote --all for metadata-backed sidecars; orphaned sidecars need metadata repair or pruning` });
      } else {
        results.push({ name: "events-capture", category: "Passive Learning", status: "warn", message: `${stats.captured} events (${stats.unprocessed} unprocessed${scope}${orphanNote}) — daemon is up — run: lcm events promote --all` });
      }
    } else {
      results.push({
        name: "events-capture", category: "Passive Learning", status: "warn",
        message: `${stats.captured} events (${stats.unprocessed} unprocessed) — daemon may be offline — ${remediationGuidance("not-running")}`,
      });
    }
  } else {
    const pending = stats.unprocessed > 0
      ? `; ${stats.unprocessed} queued for automatic daemon processing`
      : "; queue empty";
    results.push({ name: "events-capture", category: "Passive Learning", status: "pass", message: `${stats.captured} events captured${pending}` });
  }

  // Error check
  if (stats.errors >= 50) {
    results.push({ name: "events-errors", category: "Passive Learning", status: "fail", message: `${stats.errors} hook errors (30d) — check ~/.lcm/logs/events.log` });
  } else if (stats.errors > 0) {
    results.push({ name: "events-errors", category: "Passive Learning", status: "warn", message: `${stats.errors} hook errors (30d) — check ~/.lcm/logs/events.log` });
  } else {
    results.push({ name: "events-errors", category: "Passive Learning", status: "pass", message: "0 hook errors" });
  }

  if ((stats.scanErrors ?? 0) > 0) {
    results.push({ name: "events-sidecar-scan", category: "Passive Learning", status: "warn", message: `${stats.scanErrors} sidecar${stats.scanErrors === 1 ? "" : "s"} failed to scan — run lcm doctor --verbose to identify the affected .db file${stats.scanErrors === 1 ? "" : "s"}` });
  }
  if ((stats.scanSkipped ?? 0) > 0) {
    results.push({
      name: "events-sidecar-scan-skipped",
      category: "Passive Learning",
      status: "skip",
      message: `${stats.scanSkipped} sidecar${stats.scanSkipped === 1 ? "" : "s"} skipped by scan budget — run lcm doctor --events-max-dbs all to remove the count limit; timeout skips may still require retrying`,
    });
  }

  // Staleness check
  if (stats.lastCapture) {
    const isoLastCapture = `${stats.lastCapture.replace(" ", "T")}Z`;
    const lastCaptureDate = new Date(isoLastCapture);
    const lastCaptureTime = lastCaptureDate.getTime();
    if (Number.isNaN(lastCaptureTime)) return;
    const daysSince = (Date.now() - lastCaptureTime) / (1000 * 60 * 60 * 24);
    if (daysSince >= 7) {
      results.push({ name: "events-staleness", category: "Passive Learning", status: "warn", message: `last capture ${Math.floor(daysSince)}d ago — hooks may not be firing if project is active` });
    } else {
      const ago = daysSince < 1 ? `${Math.floor(daysSince * 24)}h ago` : `${Math.floor(daysSince)}d ago`;
      results.push({ name: "events-staleness", category: "Passive Learning", status: "pass", message: `last capture ${ago}` });
    }
  }

  // Verbose: per-project breakdown
  if (options.verbose && "projects" in stats) {
    const detailed = stats as import("../db/events-stats.js").DetailedEventStats;
    for (const p of detailed.projects) {
      const safeFile = sanitizeTerminalText(p.file);
      const safePath = sanitizeTerminalText(p.path);
      if (p.pruned) {
        results.push({ name: `events-project-${safeFile}`, category: "Passive Learning", status: "pass", message: `${safeFile.slice(0, 8)}… pruned: ${sanitizeTerminalText(p.pruneReason ?? "orphan sidecar")} — ${safePath}` });
        continue;
      }
      if (p.scanError) {
        results.push({ name: `events-project-${safeFile}`, category: "Passive Learning", status: "warn", message: `${safeFile.slice(0, 8)}… scan failed: ${sanitizeTerminalText(p.scanError)} — ${safePath}` });
        continue;
      }
      if (p.scanSkipped) {
        results.push({ name: `events-project-${safeFile}`, category: "Passive Learning", status: "skip", message: `${safeFile.slice(0, 8)}… scan skipped: ${sanitizeTerminalText(p.scanSkipped)} — ${safePath}` });
        continue;
      }
      const ago = p.lastCapture ? formatTimeAgo(new Date(`${p.lastCapture.replace(" ", "T")}Z`)) : "never";
      const projectLabel = p.cwd ?? (p.metadataMissing ? "metadata missing" : p.projectId);
      results.push({ name: `events-project-${safeFile}`, category: "Passive Learning", status: "pass", message: `${safeFile.slice(0, 8)}… ${p.captured} events (${p.unprocessed} unprocessed) last: ${ago} — ${sanitizeTerminalText(projectLabel)}` });
    }
    if (detailed.recentErrors.length > 0) {
      const errorLines = detailed.recentErrors.map(e =>
        `  ${sanitizeTerminalText(e.created_at)} ${sanitizeTerminalText(e.hook)}: ${sanitizeTerminalText(e.error)}`
      ).join("\n");
      results.push({ name: "events-recent-errors", category: "Passive Learning", status: "warn", message: `Recent errors:\n${errorLines}` });
    }
  }
}

export async function runDoctor(overrides?: Partial<DoctorDeps>, doctorOptions: boolean | DoctorRunOptions = false): Promise<CheckResult[]> {
  const deps: DoctorDeps = { ...defaultDeps(), ...overrides };
  const options = normalizeDoctorOptions(doctorOptions);
  const results: CheckResult[] = [];
  const config = loadConfig(deps);
  const publicationBlocked = checkBackendPublicationAdmission(results, config);
  const repairBlocked = publicationBlocked || config.validationError !== undefined;
  const repairSkipMessage = publicationBlocked
    ? "Skipped because backend publication admission is blocked"
    : "Skipped because configuration validation failed; automatic repair is disabled";
  const remediationScope = daemonRemediationScope(deps.homedir);

  // ── Stack info ──
  results.push({
    name: "stack",
    category: "Stack",
    status: "pass",
    message: `Storage: ${config.storageBackend}; ` + (config.validationError
      ? `Summarizer: unavailable (${config.validationError.name}: ${config.validationError.message})`
      : config.summarizer === "auto"
      ? `Summarizer: auto (Claude->claude-process, Codex->codex-process); reasoning effort: ${config.reasoningEffort ?? "default"}; fast mode: ${config.fastMode ? "on" : "off"}`
      : `Summarizer: ${config.summarizer}${config.apiMode ? `; API mode: ${config.apiMode}` : ""}${config.reasoningEffort && config.summarizer !== "claude-process" && config.summarizer !== "codex-process" ? `; reasoning effort: ${config.reasoningEffort}` : ""}` +
        `${config.summarizer === "claude-process" || config.summarizer === "codex-process" ? `; reasoning effort: ${config.reasoningEffort ?? "default"}; fast mode: ${config.fastMode ? "on" : "off"}` : ""}` +
        `${config.requestTimeoutMs !== undefined ? `; timeout: ${config.requestTimeoutMs}ms` : ""}` +
        `${config.retry ? `; retry: ${config.retry.maxAttempts} attempts, ${config.retry.initialDelayMs}-${config.retry.maxDelayMs}ms x${config.retry.multiplier}` : ""}`),
  });

  // ── 1. Binary version ──
  // dist/src/doctor/doctor.js → ../../.. → project root
  const pkgPath = join(packageRootFor(import.meta.url, 3), "package.json");
  let pkgVersion: string | undefined;
  try {
    const pkg = JSON.parse(deps.readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    pkgVersion = typeof pkg.version === "string" ? pkg.version : undefined;
    results.push({ name: "version", category: "Stack", status: pkgVersion ? "pass" : "warn", message: pkgVersion ? `v${pkgVersion}` : "Could not read version" });
  } catch {
    results.push({ name: "version", category: "Stack", status: "warn", message: "Could not read version" });
  }

  // ── 2. config.json ──
  const resolvedConfigPath = configPath(deps.homedir);
  if (deps.existsSync(resolvedConfigPath)) {
    results.push(config.validationError
      ? { name: "config", category: "Stack", status: "fail", message: `${resolvedConfigPath}: ${config.validationError.name}: ${config.validationError.message}` }
      : { name: "config", category: "Stack", status: "pass", message: resolvedConfigPath });
  } else {
    results.push({ name: "config", category: "Stack", status: "fail", message: `Missing — run: lcm install` });
  }

  // ── Convergence identity ──
  // Observe the daemon before any lock-taking stage so that project-map,
  // worktree, and lifecycle admission can all wait for the same daemon's
  // short publication work under one shared deadline. Retries additionally
  // require token-authenticated health to match this identity every time.
  const runtimePath = packagedRuntimePath();
  const expectedRuntimeDigest = deps._expectedRuntimeDigestForTesting ?? RUNTIME_DIGEST;
  let daemonHealthy = false;
  let daemonVersion: string | undefined;
  let initialHealthPid: number | undefined;
  if (!publicationBlocked) {
    try {
      const h = await readRecognizedDaemonHealth(deps.fetch, config.port);
      if (h) {
        daemonHealthy = true;
        daemonVersion = h.version;
        initialHealthPid = h.pid;
      }
    } catch {}
  }
  const convergence = createPublicationConvergence(
    deps,
    repairBlocked
      ? undefined
      : expectedConvergenceIdentity(initialHealthPid, config, pkgVersion, runtimePath, expectedRuntimeDigest),
  );

  // ── Project path aliases ──
  if (repairBlocked) {
    results.push({ name: "project-map", category: "Project Map", status: "skip", message: repairSkipMessage });
    results.push({ name: "worktree-reconciliation", category: "Project Map", status: "skip", message: repairSkipMessage });
  } else {
    await checkProjectMap(results, deps, config.port, convergence);
    await checkWorktreeReconciliations(results, deps, config.port, convergence);
  }

  // ── Daemon ──
  let daemonStorageReadiness: DaemonStorageReadiness = "unverified";
  let daemonPid: number | undefined;
  const daemonSpawnArgs = [runtimePath, "daemon", "start", "--foreground"];
  const clearRemediationMarker = (): void => {
    clearDaemonNotice(remediationScope);
  };

  if (publicationBlocked) {
    results.push({
      name: "daemon",
      category: "Daemon",
      status: "skip",
      message: "Automatic daemon start, restart, and repair skipped because backend publication admission is blocked",
      fixApplied: false,
    });
  } else if (config.validationError || config.storageBackend === "unavailable") {
    results.push(daemonHealthy
      ? {
          name: "daemon", category: "Daemon", status: "warn",
          message: `localhost:${config.port} (up) — automatic validation and repair skipped because config is invalid`,
          fixApplied: false,
        }
      : {
          name: "daemon", category: "Daemon", status: "fail",
          message: `localhost:${config.port} not responding — automatic start skipped because config is invalid\n     Fix: correct config.json; ${remediationGuidance("stale-config")}`,
          fixApplied: false,
        });
  } else if (daemonHealthy) {
    const pidFilePath = daemonPidPath(deps.homedir);
    const versionMismatch = Boolean(pkgVersion && daemonVersion !== pkgVersion);
    const daemonVersionLabel = daemonVersion ? `v${daemonVersion}` : "unknown version";
    try {
      const { ensureDaemon, restartDaemon } = await import("../daemon/lifecycle.js");
      const lifecycleOptions = {
        port: config.port,
        pidFilePath,
        spawnTimeoutMs: 10000,
        expectedVersion: pkgVersion,
        expectedStorageBackend: config.storageBackend,
        spawnCommand: process.execPath,
        spawnArgs: daemonSpawnArgs,
        expectedEntrypoint: runtimePath,
        enforceUserManagerParent: true,
      };
      const invokeLifecycle = (restart: boolean): Promise<Awaited<ReturnType<typeof ensureDaemon>>> =>
        withPublicationConvergence(
          () => restart ? restartDaemon(lifecycleOptions) : ensureDaemon(lifecycleOptions),
          deps,
          config.port,
          convergence,
        );
      let lifecycleResult = versionMismatch
        ? await invokeLifecycle(true)
        : await invokeLifecycle(false);
      const repairedStaleConfiguration = !versionMismatch
        && !lifecycleResult.connected
        && lifecycleResult.refusalReason === "stale-config";
      if (repairedStaleConfiguration) {
        lifecycleResult = await invokeLifecycle(true);
      }
      if (lifecycleResult.connected) daemonPid = lifecycleResult.pid ?? initialHealthPid;

      let postRestartVersion: string | undefined;
      let postRestartOk = false;
      let postRestartStorageReadiness: DaemonStorageReadiness = "unverified";
      if (lifecycleResult.connected) {
        try {
          const h = await readDoctorAuthenticatedHealth(deps, config.port);
          if (h) {
            postRestartOk = true;
            postRestartStorageReadiness = storageReadinessFromHealth(h);
            daemonStorageReadiness = postRestartStorageReadiness;
            postRestartVersion = h.version;
          }
        } catch { /* non-fatal */ }
      }

      if (versionMismatch) {
        const fixApplied = lifecycleResult.connected && postRestartOk && postRestartVersion === pkgVersion;
        if (fixApplied) {
          clearRemediationMarker();
          const warning = lifecycleResult.warning ? `\n     Warning: ${lifecycleResult.warning}` : "";
          results.push({
            name: "daemon", category: "Daemon", status: "warn",
            message: `localhost:${config.port} — restarted (${daemonVersionLabel} → v${pkgVersion})${warning}`,
            fixApplied: true,
          });
          daemonHealthy = true;
          daemonStorageReadiness = postRestartStorageReadiness;
        } else if (lifecycleResult.connected) {
          const runningVersionLabel = postRestartVersion ? `v${postRestartVersion}` : daemonVersionLabel;
          results.push({
            name: "daemon", category: "Daemon", status: "warn",
            message: `localhost:${config.port} — version mismatch (${runningVersionLabel} running, v${pkgVersion} installed); restart did not fix mismatch\n     Fix: ${remediationGuidance(refusalReasonFrom(lifecycleResult, "not-running"))}`,
            fixApplied: false,
          });
          daemonHealthy = false;
          daemonStorageReadiness = "unverified";
        } else {
          results.push({
            name: "daemon", category: "Daemon", status: "fail",
            message: `localhost:${config.port} — version mismatch (${daemonVersionLabel} running, v${pkgVersion} installed); restart failed\n     Fix: ${remediationGuidance(refusalReasonFrom(lifecycleResult, "not-running"))}`,
            fixApplied: false,
          });
          daemonHealthy = false;
          daemonStorageReadiness = "unverified";
        }
      } else if (repairedStaleConfiguration && lifecycleResult.connected && postRestartOk) {
        clearRemediationMarker();
        const warning = lifecycleResult.warning ? `\n     Warning: ${lifecycleResult.warning}` : "";
        results.push({
          name: "daemon", category: "Daemon", status: "warn",
          message: `localhost:${config.port} — stale configuration repaired; daemon restarted${warning}`,
          fixApplied: true,
        });
        daemonHealthy = true;
        daemonStorageReadiness = postRestartStorageReadiness;
      } else if (repairedStaleConfiguration && lifecycleResult.connected) {
        results.push({
          name: "daemon", category: "Daemon", status: "fail",
          message: `localhost:${config.port} — stale configuration repair restarted the daemon, but authenticated health could not be verified after restart\n     Fix: ${remediationGuidance("stale-config")}`,
          fixApplied: false,
        });
        daemonHealthy = false;
        daemonStorageReadiness = "unverified";
      } else if (!lifecycleResult.connected) {
        results.push({
          name: "daemon", category: "Daemon", status: "fail",
          message: repairedStaleConfiguration
            ? `localhost:${config.port} — stale configuration repair/restart failed\n     Fix: ${remediationGuidance(refusalReasonFrom(lifecycleResult, "stale-config"))}`
            : `localhost:${config.port} — running daemon could not be validated or restarted\n     Fix: ${remediationGuidance(refusalReasonFrom(lifecycleResult, "not-running"))}`,
          fixApplied: false,
        });
        daemonHealthy = false;
        daemonStorageReadiness = "unverified";
      } else if (lifecycleResult.restartedForParent) {
        clearRemediationMarker();
        const warning = lifecycleResult.warning ? `\n     Warning: ${lifecycleResult.warning}` : "";
        results.push({
          name: "daemon", category: "Daemon", status: "warn",
          message: `localhost:${config.port} — restarted under user systemd${warning}`,
          fixApplied: true,
        });
        daemonHealthy = true;
        daemonStorageReadiness = postRestartStorageReadiness;
      } else if (lifecycleResult.warning) {
        clearRemediationMarker();
        results.push({
          name: "daemon", category: "Daemon", status: "warn",
          message: `localhost:${config.port} (up)\n     Warning: ${lifecycleResult.warning}`,
          fixApplied: false,
        });
        daemonHealthy = true;
      } else {
        clearRemediationMarker();
        results.push({
          name: "daemon",
          category: "Daemon",
          status: "pass",
          message: `localhost:${config.port} (up)`,
        });
        daemonHealthy = true;
      }
    } catch (error) {
      daemonHealthy = false;
      daemonStorageReadiness = "unverified";
      if (error instanceof PrivateMutationLockContentionError) {
        results.push({
          name: "daemon",
          category: "Daemon",
          status: "fail",
          message: `localhost:${config.port} — backend publication admission failed: ${sanitizeTerminalText(error.message)}`,
          fixApplied: false,
        });
      } else if (versionMismatch) {
        results.push({ name: "daemon", category: "Daemon", status: "warn",
          message: `localhost:${config.port} — version mismatch (${daemonVersionLabel} running, v${pkgVersion} installed)\n     Fix: ${remediationGuidance("not-running")}` });
      } else {
        results.push({ name: "daemon", category: "Daemon", status: "warn",
          message: `localhost:${config.port} — daemon validation failed\n     Fix: ${remediationGuidance("not-running")}` });
      }
    }
  } else {
    // Auto-fix: try ensureDaemon
    try {
      const { ensureDaemon } = await import("../daemon/lifecycle.js");
      const expectedStorageBackend = config.storageBackend;
      const ensureResult = await withPublicationConvergence(() => ensureDaemon({
        port: config.port,
        pidFilePath: daemonPidPath(deps.homedir),
        spawnTimeoutMs: 10000,
        expectedVersion: pkgVersion,
        expectedStorageBackend,
        spawnCommand: process.execPath,
        spawnArgs: daemonSpawnArgs,
        expectedEntrypoint: runtimePath,
        enforceUserManagerParent: true,
      }), deps, config.port, convergence);
      if (ensureResult.connected) {
        clearRemediationMarker();
        daemonPid = ensureResult.pid;
        const warning = ensureResult.warning ? `\n     Warning: ${ensureResult.warning}` : "";
        results.push({ name: "daemon", category: "Daemon", status: "warn", message: `localhost:${config.port} — started${warning}`, fixApplied: true });
        daemonHealthy = true;
        try {
          const h = await readDoctorAuthenticatedHealth(deps, config.port);
          if (h) daemonStorageReadiness = storageReadinessFromHealth(h);
        } catch { /* non-fatal */ }
      } else {
        results.push({
          name: "daemon", category: "Daemon", status: "fail",
          message: `localhost:${config.port} not responding\n     Fix: ${remediationGuidance(refusalReasonFrom(ensureResult, "not-running"))}`,
        });
      }
    } catch {
      results.push({
        name: "daemon", category: "Daemon", status: "fail",
        message: `localhost:${config.port} not responding\n     Fix: ${remediationGuidance("not-running")}`,
      });
    }
  }

  // ── Settings ──
  if (repairBlocked) {
    for (const name of ["hooks", "mcp-lcm", "lcm-md"] as const) {
      results.push({ name, category: "Settings", status: "skip", message: repairSkipMessage });
    }
  } else {
  const settingsPath = join(deps.homedir, ".claude", "settings.json");
  const claudeTransport = deps._claudeTransport
    ?? resolveClaudeTransport(configPath(deps.homedir));
  const claudeSettingsExists = deps.existsSync(settingsPath);
  let settingsData: unknown = {};
  let settingsError: string | undefined;
  let claudeSettingsManaged = false;
  if (claudeSettingsExists) {
    try {
      settingsData = JSON.parse(deps.readFileSync(settingsPath, "utf-8"));
      claudeSettingsManaged = hasManagedClaudeSettings(settingsData);
    } catch (error) {
      settingsError = error instanceof Error ? error.message : String(error);
    }
  }

  let currentSettings: Record<string, unknown> | undefined;
  let lcmBinary: string | undefined;
  let claudeSettingsCleaned = false;
  if (!claudeSettingsExists || (!settingsError && !claudeSettingsManaged)) {
    results.push({
      name: "hooks",
      category: "Settings",
      status: "pass",
      message: "Claude Code integration is not installed",
    });
  } else if (settingsError) {
    results.push({
      name: "hooks",
      category: "Settings",
      status: "fail",
      message: `Could not parse ${settingsPath}: ${settingsError}\n     Fix the JSON, then run: lcm install`,
    });
  } else {
    try {
      lcmBinary = runtimePath;
      const merged = mergeClaudeSettings(settingsData, lcmBinary, process.execPath, claudeTransport) as Record<string, unknown>;
      const beforeHooks = (settingsData as Record<string, unknown>)?.hooks;
      if (JSON.stringify(beforeHooks) === JSON.stringify(merged.hooks)) {
        if (JSON.stringify(settingsData) !== JSON.stringify(merged)) {
          deps.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
          claudeSettingsCleaned = true;
        }
        currentSettings = merged;
        results.push({
          name: "hooks",
          category: "Settings",
          status: "pass",
          message: REQUIRED_HOOKS.map(h => `${h.event} \u2713`).join("  "),
        });
      } else {
        deps.mkdirSync(dirname(settingsPath), { recursive: true });
        deps.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
        currentSettings = merged;
        results.push({
          name: "hooks",
          category: "Settings",
          status: "warn",
          message: "Native Claude Code hooks were missing or stale — repaired automatically",
          fixApplied: true,
        });
      }
    } catch (error) {
      results.push({
        name: "hooks",
        category: "Settings",
        status: "fail",
        message: `Could not manage native Claude Code hooks: ${error instanceof Error ? error.message : error}\n     Fix: lcm install`,
      });
    }
  }

  const mcpServers = currentSettings?.mcpServers as Record<string, unknown> | undefined;
  if (!claudeSettingsExists || (!settingsError && !claudeSettingsManaged)) {
    results.push({ name: "mcp-lcm", category: "Settings", status: "pass", message: "Claude Code integration is not installed" });
  } else if (settingsError) {
    results.push({
      name: "mcp-lcm",
      category: "Settings",
      status: "fail",
      message: `Could not parse ${settingsPath}: ${settingsError}\n     Fix the JSON, then run: lcm install`,
    });
  } else if (claudeTransport === "cli") {
    if (lcmBinary && hasCanonicalClaudeMcpEntry(mcpServers?.lcm, lcmBinary)) {
      try {
        const merged = structuredClone(currentSettings) as Record<string, unknown>;
        const servers = merged.mcpServers as Record<string, unknown>;
        delete servers.lcm;
        if (Object.keys(servers).length === 0) delete merged.mcpServers;
        deps.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
        results.push({ name: "mcp-lcm", category: "Settings", status: "warn", message: "Removed the owned Claude MCP entry for CLI transport", fixApplied: true });
      } catch {
        results.push({ name: "mcp-lcm", category: "Settings", status: "fail", message: "Owned Claude MCP entry could not be removed — run: lcm install" });
      }
    } else {
      results.push({ name: "mcp-lcm", category: "Settings", status: "pass", message: "Claude CLI transport does not use MCP" });
    }
  } else if (lcmBinary && hasCanonicalClaudeMcpEntry(mcpServers?.lcm, lcmBinary)) {
    results.push(claudeSettingsCleaned
      ? { name: "mcp-lcm", category: "Settings", status: "warn", message: "Removed the legacy lossless-claude MCP registration", fixApplied: true }
      : { name: "mcp-lcm", category: "Settings", status: "pass", message: "mcpServers.lcm uses the npm-installed runtime" });
  } else if (currentSettings && lcmBinary) {
    try {
      const merged = mergeClaudeSettings(currentSettings, lcmBinary!, process.execPath, claudeTransport);
      if (merged.mcpServers === null || typeof merged.mcpServers !== "object" || Array.isArray(merged.mcpServers)) {
        merged.mcpServers = {};
      }
      merged.mcpServers.lcm = mergeClaudeMcpEntry(merged.mcpServers.lcm, lcmBinary);
      deps.mkdirSync(dirname(settingsPath), { recursive: true });
      deps.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
      results.push({ name: "mcp-lcm", category: "Settings", status: "warn", message: "mcpServers.lcm was missing or stale — repaired automatically", fixApplied: true });
    } catch {
      results.push({ name: "mcp-lcm", category: "Settings", status: "fail", message: "mcpServers.lcm could not be repaired — run: lcm install" });
    }
  } else {
    results.push({ name: "mcp-lcm", category: "Settings", status: "fail", message: "mcpServers.lcm could not be validated — run: lcm install" });
  }

  // ── canonical lcm-memory skill ──
  const skillPath = join(deps.homedir, ".claude", "skills", "lcm-memory", "SKILL.md");
  const renderedSkill = deps.renderClaudeSkill?.(claudeTransport)
    ?? renderGuidance("skill", claudeTransport);
  if (!claudeSettingsExists || (!settingsError && !claudeSettingsManaged)) {
    results.push({ name: "lcm-md", category: "Settings", status: "pass", message: "Claude Code integration is not installed" });
  } else if (settingsError) {
    results.push({ name: "lcm-md", category: "Settings", status: "fail", message: "lcm-memory skill could not be validated because Claude settings are malformed" });
  } else {
    try {
      const skillExists = deps.existsSync(skillPath);
      const skillCurrent = skillExists && (() => {
        try { return deps.readFileSync(skillPath, "utf-8") === renderedSkill; } catch { return false; }
      })();
      if (skillCurrent) {
        results.push({ name: "lcm-md", category: "Settings", status: "pass", message: "canonical Claude lcm-memory skill is installed" });
      } else {
        installClaudeSkill({
          existsSync: deps.existsSync,
          readFileSync: deps.readFileSync,
          writeFileSync: deps.writeFileSync,
          mkdirSync: deps.mkdirSync,
          renderClaudeSkill: deps.renderClaudeSkill,
        }, claudeTransport, deps.homedir);
        results.push({ name: "lcm-md", category: "Settings", status: "warn", message: "canonical Claude lcm-memory skill repaired", fixApplied: true });
      }
      const { LCM_MD_CONTENT } = await import("../daemon/orientation.js");
      removeClaudeLegacyAssets({
        existsSync: deps.existsSync,
        readFileSync: deps.readFileSync,
        writeFileSync: deps.writeFileSync,
        mkdirSync: deps.mkdirSync,
        lstatSync: deps.lstatSync,
        readdirSync: deps.readdirSync,
      }, deps.homedir, LCM_MD_CONTENT);
    } catch (err) {
      results.push({ name: "lcm-md", category: "Settings", status: "fail", message: `lcm-memory skill repair failed: ${err instanceof Error ? err.message : String(err)} — run: lcm install` });
    }
  }
  }

  // ── Summarizer (conditional) ──
  const effectiveDaemonPath = deps.managedDaemonPath
    ?? daemonProcessPath(deps, daemonPid)
    ?? managedDaemonPath(process.execPath, [process.argv[1]], deps.cwd);
  if (config.summarizer === "auto") {
    addClaudeProcessChecks(results, deps, effectiveDaemonPath);
    addCodexProcessChecks(results, deps, effectiveDaemonPath);
  } else if (config.summarizer === "claude-process") {
    addClaudeProcessChecks(results, deps, effectiveDaemonPath);
  } else if (config.summarizer === "codex-process") {
    addCodexProcessChecks(results, deps, effectiveDaemonPath);
  } else if (config.summarizer === "anthropic") {
    if (process.env.ANTHROPIC_API_KEY) {
      results.push({ name: "anthropic-key", category: "Summarizer", status: "pass", message: "ANTHROPIC_API_KEY set" });
    } else {
      results.push({ name: "anthropic-key", category: "Summarizer", status: "warn", message: "ANTHROPIC_API_KEY not set in environment" });
    }
  }

  // ── MCP handshake ──
  if (daemonHealthy) {
    try {
      const handshake = deps._testMcpHandshake ?? testMcpHandshake;
      const mcpResult = await handshake();
      results.push(mcpResult);
    } catch {
      results.push({ name: "mcp-handshake-lcm", category: "MCP Servers", status: "warn", message: "Could not test MCP handshake" });
    }
  }

  // ── Security ──

  // Gitleaks health check: verify generated-patterns.js exists and exports non-empty array
  const syncDate = readGitleaksSyncDate();
  const gitleaksCount = GITLEAKS_PATTERNS.length;
  if (gitleaksCount === 0) {
    results.push({
      name: "secret-detection",
      category: "Security",
      status: "fail",
      message: "No gitleaks patterns were loaded (GITLEAKS_PATTERNS is empty) — run pnpm run update:patterns from an LCM source checkout",
    });
  } else {
    const syncNote = syncDate ? ` (synced ${syncDate})` : "";
    results.push({
      name: "secret-detection",
      category: "Security",
      status: "pass",
      message: `Secret detection\n     Built-in patterns:  ${gitleaksCount} (gitleaks${syncNote}) + ${NATIVE_PATTERNS.length} (native)\n     Manage patterns:    lcm sensitive add/remove`,
    });
  }

  const cwd = deps.cwd ?? process.cwd();
  const patternsFile = diagnosticProjectPatternsPath(cwd, deps.homedir);
  const projectPatterns = await ScrubEngine.loadProjectPatterns(patternsFile);

  // Load global user patterns count for informational display
  let globalUserPatternCount = 0;
  try {
    const { loadDaemonConfig } = await import("../daemon/config.js");
    const globalConfigPath = configPath(deps.homedir);
    const config = loadDaemonConfig(globalConfigPath);
    globalUserPatternCount = config.security?.sensitivePatterns?.length ?? 0;
  } catch {
    // config may not exist
  }

  // User patterns: informational only (no warning for zero patterns)
  if (projectPatterns.length > 0) {
    const invalidPatterns: string[] = [];
    for (const pat of projectPatterns) {
      try { validateRegex(pat); } catch { invalidPatterns.push(pat); }
    }
    if (invalidPatterns.length > 0) {
      results.push({
        name: "user-patterns",
        category: "Security",
        status: "warn",
        message: `User patterns:  ${globalUserPatternCount} global, ${projectPatterns.length} project (${invalidPatterns.length} invalid regex — will be skipped)`,
      });
    } else {
      results.push({
        name: "user-patterns",
        category: "Security",
        status: "pass",
        message: `User patterns:  ${globalUserPatternCount} global, ${projectPatterns.length} project`,
      });
    }
  } else {
    results.push({
      name: "user-patterns",
      category: "Security",
      status: "pass",
      message: `User patterns:  ${globalUserPatternCount} global, 0 project`,
    });
  }

  // ── Passive Learning ──
  // The hooks check above always reports pass or warn, so passive-learning
  // diagnostics are always applicable by the time this point is reached.
  await checkPassiveLearning(
    results,
    options,
    daemonHealthy,
    daemonStorageReadiness,
    repairBlocked,
    publicationBlocked,
  );

  return results;
}

export function printResults(results: CheckResult[]): void {
  console.log(`\n${COLORS.bold}🧠 lcm${COLORS.nc}`);

  let currentCategory = "";

  for (const r of results) {
    if (r.category !== currentCategory) {
      currentCategory = r.category;
      const label = ` ${currentCategory} `;
      const dashes = "─".repeat(42 - 3 - label.length);
      console.log(`\n${COLORS.cyan}──${label}${dashes}${COLORS.nc}`);
    }
    if (r.name === "stack") {
      console.log(`    ${COLORS.dim}${r.message}${COLORS.nc}`);
      continue;
    }

    const icon =
      r.status === "pass" ? `${COLORS.green}✅${COLORS.nc}` :
      r.status === "warn" ? `${COLORS.yellow}⚠️ ${COLORS.nc}` :
      r.status === "skip" ? `${COLORS.dim}⏭️ ${COLORS.nc}` :
                            `${COLORS.red}❌${COLORS.nc}`;
    const suffix = r.fixApplied ? ` ${COLORS.dim}(auto-fixed)${COLORS.nc}` : "";
    console.log(`    ${icon} ${COLORS.dim}${r.name}${COLORS.nc}  ${r.message}${suffix}`);
  }

  const pass = results.filter(r => r.status === "pass" && r.name !== "stack").length;
  const fail = results.filter(r => r.status === "fail").length;
  const warn = results.filter(r => r.status === "warn").length;
  const skip = results.filter(r => r.status === "skip").length;

  console.log(`\n  ${pass} passed · ${fail} failed · ${warn} warnings · ${skip} skipped\n`);
}

export function formatResultsPlain(results: CheckResult[]): string {
  const lines: string[] = [];

  // Group results by category
  const categories: Map<string, CheckResult[]> = new Map();
  for (const r of results) {
    if (!categories.has(r.category)) categories.set(r.category, []);
    categories.get(r.category)!.push(r);
  }

  for (const [category, items] of categories) {
    lines.push(`## ${category}`);

    // Stack entries (name === "stack") go as plain text before the table
    for (const r of items) {
      if (r.name === "stack") {
        lines.push(r.message);
      }
    }

    const tableItems = items.filter(r => r.name !== "stack");
    if (tableItems.length > 0) {
      lines.push("");
      lines.push("| Check | Status |");
      lines.push("|---|---|");
      for (const r of tableItems) {
        const icon = r.status === "pass" ? "✅" : r.status === "warn" ? "⚠️" : r.status === "skip" ? "⏭️" : "❌";
        const suffix = r.fixApplied ? " (auto-fixed)" : "";
        lines.push(`| ${r.name} | ${icon} ${r.message}${suffix} |`);
      }
    }

    lines.push("");
  }

  const pass = results.filter(r => r.status === "pass" && r.name !== "stack").length;
  const fail = results.filter(r => r.status === "fail").length;
  const warn = results.filter(r => r.status === "warn").length;
  const skip = results.filter(r => r.status === "skip").length;
  lines.push(`${pass} passed · ${fail} failed · ${warn} warnings · ${skip} skipped`);
  return lines.join("\n");
}
