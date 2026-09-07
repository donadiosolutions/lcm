import { renderBackendDiagnostics } from "../storage/diagnostic-renderer.js";
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import type { CheckResult, DoctorDeps } from "./types.js";
import { collectStats, StatsUnavailableError } from "../stats.js";
import { backendDiagnosticFailure, type BackendDiagnosticSnapshot } from "../storage/diagnostics.js";
import {
  hasCanonicalClaudeMcpEntry,
  hasManagedClaudeSettings,
  mergeClaudeSettings,
  REQUIRED_HOOKS,
  resolveClaudeTransport,
} from "../../installer/install.js";
import { renderGuidance } from "../connectors/template-service.js";
import { NATIVE_PATTERNS, ScrubEngine, readGitleaksSyncDate } from "../scrub.js";
import { GITLEAKS_PATTERNS } from "../generated-patterns.js";
import { collectEventStats, collectDetailedEventStats } from "../db/events-stats.js";
import { validateRegex } from "../store/regex-safety.js";
import {
  configPath,
  daemonTokenPath,
  lcmHomeDir,
  projectsDir,
} from "../runtime-paths.js";
import {
  hashProjectPath,
  normalizeProjectIdentityPath,
  normalizeProjectPath,
  projectMapPath,
  type ProjectMap,
} from "../project-map.js";
import { packageExecutable, packageRootFor } from "../runtime-root.js";
import { readBoundedRegularFile, OWNER_ONLY_FILE_MODES } from "../security-files.js";
import { normalizeUuidV7 } from "../machine-identity.js";
import { managedDaemonPath } from "../daemon/managed-path.js";
import { daemonEntrypointMatches } from "../daemon/lifecycle-scope.js";
import { mapDaemonRefusalToRemediation } from "../daemon/remediation.js";
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
import {
  assertBackendPublicationConfigReadAccess,
  BackendPublicationJournalError,
  withBackendPublicationReadRoot,
} from "../storage/backend-publication.js";


const COLORS = {
  green: "\x1b[0;32m",
  yellow: "\x1b[1;33m",
  red: "\x1b[0;31m",
  cyan: "\x1b[0;36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  nc: "\x1b[0m",
};

async function collectBackendSnapshot(homeDir: string): Promise<BackendDiagnosticSnapshot> {
  try {
    return (await collectStats({ homeDir })).backendDiagnostics;
  } catch (error) {
    return error instanceof StatsUnavailableError ? error.diagnostics : backendDiagnosticFailure(error);
  }
}

function defaultDeps(): DoctorDeps {
  return {
    collectBackendSnapshot,
    existsSync,
    readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
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
  globalUserPatternCount?: number;
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

async function readRecognizedDaemonHealth(
  fetchFn: typeof globalThis.fetch,
  port: number,
  token: string | null,
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
          headers: { Authorization: `Bearer ${token}` },
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

type ExpectedDaemonIdentity = Readonly<{
  pid: number;
  version: string;
  storageBackend: "sqlite" | "postgresql";
  entrypoint: string;
  runtimeDigest: string;
}>;

function daemonHealthMatchesIdentity(
  health: DoctorDaemonHealth | null,
  identity: ExpectedDaemonIdentity,
  platform: NodeJS.Platform,
): boolean {
  return health !== null
    && health.pid === identity.pid
    && health.version === identity.version
    && (health.storageBackend ?? "sqlite") === identity.storageBackend
    && daemonEntrypointMatches(health.entrypoint, identity.entrypoint, platform)
    && health.runtimeDigest === identity.runtimeDigest;
}

/**
 * Build the identity doctor will require from token-authenticated health
 * before trusting storage readiness. The PID comes from authenticated health;
 * every remaining field is the identity this installation expects. Peer
 * metadata cannot supply a missing local version or runtime digest.
 */
function expectedDaemonIdentity(
  initialHealthPid: number | undefined,
  config: DoctorConfig,
  expectedVersion: string | undefined,
  expectedEntrypoint: string,
  expectedRuntimeDigest: string | undefined,
): ExpectedDaemonIdentity | undefined {
  if (
    initialHealthPid === undefined
    || expectedVersion === undefined
    || expectedVersion.trim() === ""
    || expectedRuntimeDigest === undefined
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
    globalUserPatternCount: config.security.sensitivePatterns.length,
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

/** Read a bounded private map without consumer locks, repair, or metadata backfill. */
function readDoctorProjectMap(homeDir: string): ProjectMap | null {
  return withBackendPublicationReadRoot(homeDir, assertRoot => {
    assertRoot();
    let content: string;
    try {
      content = readBoundedRegularFile(projectMapPath(homeDir), {
        allowedRoot: lcmHomeDir(homeDir), maxBytes: 4 * 1024 * 1024, allowedModes: OWNER_ONLY_FILE_MODES,
      });
    } catch (error) {
      assertRoot();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    assertRoot();
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid project map");
    const map: ProjectMap = {};
    const owners = new Map<string, string>();
    for (const [hash, value] of Object.entries(parsed)) {
      if (!/^[a-f0-9]{64}$/u.test(hash) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid project map");
      const entry = value as Record<string, unknown>;
      if (typeof entry.canonical !== "string" || !isAbsolute(entry.canonical)
        || !Array.isArray(entry.aliases) || !entry.aliases.every(alias => typeof alias === "string" && isAbsolute(alias))
        || (entry.remoteProjectId !== undefined && (typeof entry.remoteProjectId !== "string" || normalizeUuidV7(entry.remoteProjectId) === null))) throw new Error("Invalid project map");
      for (const path of [entry.canonical, ...entry.aliases] as string[]) {
        const normalized = normalizeProjectPath(path);
        if (owners.has(normalized) && owners.get(normalized) !== hash) throw new Error("Ambiguous project map");
        owners.set(normalized, hash);
      }
      map[hash] = { canonical: entry.canonical, aliases: entry.aliases as string[] };
    }
    return map;
  });
}

function checkProjectMap(results: CheckResult[], deps: DoctorDeps): void {
  try {
    const map = readDoctorProjectMap(deps.homedir);
    const count = Object.keys(map ?? {}).length;
    results.push({ name: "project-map", category: "Project Map", status: "pass",
      message: map === null ? "map.json not created yet" : `${count} mapped project${count === 1 ? "" : "s"}; static validation only` });
  } catch {
    results.push({ name: "project-map", category: "Project Map", status: "fail",
      message: "Project map is invalid, ambiguous, or unreadable. Run: lcm project list" });
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
    const matches = Object.entries(readDoctorProjectMap(homeDir) ?? {})
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


function packagedRuntimePath(): string {
  return packageExecutable(import.meta.url, 3);
}

async function checkPassiveLearning(
  results: CheckResult[],
  options: Required<DoctorRunOptions>,
  daemonHealthy: boolean,
  daemonStorageReadiness: DaemonStorageReadiness,
  repairBlocked: boolean,
  publicationBlocked: boolean,
  homeDir: string,
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
  const statsOptions = { homeDir, timeoutMs: 2000, maxDbs: options.eventsMaxDbs, pruneOrphanSidecars: false };
  const stats = options.verbose
    ? await collectDetailedEventStats(statsOptions)
    : await collectEventStats(statsOptions);

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
  } else if (stats.unprocessed > 0 && !daemonHealthy) {
    results.push({ name: "events-capture", category: "Passive Learning", status: "warn",
      message: `${stats.captured} events (${stats.unprocessed} unprocessed) — daemon runtime identity is unverified; restore authenticated daemon health before expecting queue drain. Run: lcm daemon restart` });
  } else if (stats.unprocessed >= PASSIVE_BACKLOG_WARN_THRESHOLD) {
    const sidecarCount = stats.sidecarsWithUnprocessed ?? 0;
    const orphanCount = stats.orphanedSidecarsWithUnprocessed ?? 0;
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

  // Verbose diagnostics deliberately omit filenames, paths and raw event errors.
  if (options.verbose && "projects" in stats) {
    const detailed = stats as import("../db/events-stats.js").DetailedEventStats;
    for (const [index, project] of detailed.projects.entries()) {
      const status = project.scanError ? "warn" : project.scanSkipped ? "skip" : "pass";
      const message = project.scanError ? "Sidecar scan failed"
        : project.scanSkipped ? "Sidecar scan skipped by scan budget"
        : `${project.captured} events (${project.unprocessed} unprocessed)`;
      results.push({ name: `events-project-${index + 1}`, category: "Passive Learning", status, message });
    }
  }
}

export async function runDoctor(overrides?: Partial<DoctorDeps>, doctorOptions: boolean | DoctorRunOptions = false): Promise<CheckResult[]> {
  const deps: DoctorDeps = { ...defaultDeps(), ...overrides };
  const options = normalizeDoctorOptions(doctorOptions);
  const results: CheckResult[] = [];
  try {
    const backendDiagnostics = await deps.collectBackendSnapshot(deps.homedir);
    results.push({
      name: "backend-health", category: "Storage",
      status: backendDiagnostics.classification === "healthy" ? "pass"
        : backendDiagnostics.classification === "degraded" ? "warn" : "fail",
      message: renderBackendDiagnostics(backendDiagnostics),
      backendDiagnostics,
    });
    const config = loadConfig(deps);
    const publicationBlocked = checkBackendPublicationAdmission(results, config);
    const repairBlocked = publicationBlocked || config.validationError !== undefined;
    const repairSkipMessage = publicationBlocked
      ? "Skipped because backend publication admission is blocked"
      : "Skipped because configuration validation failed; automatic repair is disabled";

    // ── Stack info ──
    results.push({
      name: "stack",
      category: "Stack",
      status: "pass",
      message: `Storage: ${config.storageBackend}; ` + (config.validationError
        ? "Summarizer: unavailable (configuration validation failed)"
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
      pkgVersion = typeof pkg.version === "string" && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/u.test(pkg.version) && pkg.version.length <= 64 ? pkg.version : undefined;
      results.push({ name: "version", category: "Stack", status: pkgVersion ? "pass" : "warn", message: pkgVersion ? `v${pkgVersion}` : "Could not read version" });
    } catch {
      results.push({ name: "version", category: "Stack", status: "warn", message: "Could not read version" });
    }

    // ── 2. config.json ──
    const resolvedConfigPath = configPath(deps.homedir);
    if (deps.existsSync(resolvedConfigPath)) {
      results.push(config.validationError
        ? { name: "config", category: "Stack", status: "fail", message: "Configuration validation failed. Correct config.json, then run: lcm doctor" }
        : { name: "config", category: "Stack", status: "pass", message: "Configuration is valid" });
    } else {
      results.push({ name: "config", category: "Stack", status: "fail", message: `Missing — run: lcm install` });
    }

    const runtimePath = packagedRuntimePath();
    const expectedRuntimeDigest = deps._expectedRuntimeDigestForTesting ?? RUNTIME_DIGEST;
    let daemonHealthy = false;
    let daemonStorageReadiness: DaemonStorageReadiness = "unverified";
    let daemonPid: number | undefined;

    if (repairBlocked) {
      results.push({ name: "project-map", category: "Project Map", status: "skip", message: repairSkipMessage });
    } else {
      checkProjectMap(results, deps);
    }
    results.push({ name: "worktree-reconciliation", category: "Project Map", status: "skip",
      message: "Not probed by observation-only diagnostics. Run: lcm project reconcile-worktrees" });

    // Existing-daemon observations never invoke lifecycle operations or clear notices.
    if (repairBlocked) {
      results.push({ name: "daemon", category: "Daemon", status: "skip", message: repairSkipMessage });
    } else {
      try {
        const health = await readDoctorAuthenticatedHealth(deps, config.port);
        const identity = expectedDaemonIdentity(
          health?.pid, config, pkgVersion, runtimePath, expectedRuntimeDigest,
        );
        if (health !== null && identity !== undefined && Number.isSafeInteger(identity.pid) && identity.pid > 0
          && daemonHealthMatchesIdentity(health, identity, deps.platform)) {
          daemonHealthy = true;
          daemonPid = health.pid;
          daemonStorageReadiness = storageReadinessFromHealth(health);
          results.push({ name: "daemon", category: "Daemon", status: daemonStorageReadiness === "ready" ? "pass" : "warn",
            message: daemonStorageReadiness === "ready" ? "Authenticated daemon version and runtime identity verified"
              : "Authenticated daemon identity verified; storage is unavailable" });
        } else {
          results.push({ name: "daemon", category: "Daemon", status: "fail",
            message: "Daemon health or installed runtime identity could not be authenticated. Run: lcm daemon restart" });
        }
      } catch {
        results.push({ name: "daemon", category: "Daemon", status: "fail",
          message: `Daemon health is unavailable or timed out. ${mapDaemonRefusalToRemediation("ambiguous").message}` });
      }
    }

    // ── Settings ──
    if (repairBlocked) {
      for (const name of ["hooks", "mcp-lcm", "lcm-md"] as const) {
        results.push({ name, category: "Settings", status: "skip", message: repairSkipMessage });
      }
    } else {
    const settingsPath = join(deps.homedir, ".claude", "settings.json");
    const claudeTransport = deps._claudeTransport ?? resolveClaudeTransport(configPath(deps.homedir));
    let settings: Record<string, unknown> | undefined;
    let settingsInvalid = false;
    try {
      if (deps.existsSync(settingsPath)) {
        const parsed: unknown = JSON.parse(deps.readFileSync(settingsPath, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) settingsInvalid = true;
        else settings = parsed as Record<string, unknown>;
      }
    } catch { settingsInvalid = true; }
    if (settingsInvalid) {
      for (const name of ["hooks", "mcp-lcm", "lcm-md"]) results.push({ name, category: "Settings", status: "fail",
        message: "Claude settings could not be read or parsed. Fix the JSON, then run: lcm install" });
    } else if (!settings || !hasManagedClaudeSettings(settings)) {
      for (const name of ["hooks", "mcp-lcm", "lcm-md"]) results.push({ name, category: "Settings", status: "pass",
        message: "Claude Code integration is not installed" });
    } else {
      const desired = mergeClaudeSettings(settings, runtimePath, process.execPath, claudeTransport);
      const hooksCurrent = JSON.stringify(settings.hooks) === JSON.stringify(desired.hooks);
      results.push({ name: "hooks", category: "Settings", status: hooksCurrent ? "pass" : "warn",
        message: hooksCurrent ? REQUIRED_HOOKS.map(h => `${h.event} ✓`).join("  ")
          : "Native Claude Code hooks are missing or stale. Run: lcm install" });
      const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
      const canonicalMcp = hasCanonicalClaudeMcpEntry(mcpServers?.lcm, runtimePath);
      const mcpCurrent = claudeTransport === "cli" ? !canonicalMcp : canonicalMcp;
      results.push({ name: "mcp-lcm", category: "Settings", status: mcpCurrent ? "pass" : "warn",
        message: mcpCurrent ? (claudeTransport === "cli" ? "Claude CLI transport does not use MCP" : "mcpServers.lcm uses the npm-installed runtime")
          : "Claude MCP registration is missing or stale. Run: lcm install" });
      const skillPath = join(deps.homedir, ".claude", "skills", "lcm-memory", "SKILL.md");
      try {
        const rendered = deps.renderClaudeSkill?.(claudeTransport) ?? renderGuidance("skill", claudeTransport);
        const current = deps.existsSync(skillPath) && deps.readFileSync(skillPath, "utf8") === rendered;
        results.push({ name: "lcm-md", category: "Settings", status: current ? "pass" : "warn",
          message: current ? "canonical Claude lcm-memory skill is installed" : "Canonical Claude lcm-memory skill is missing or stale. Run: lcm install" });
      } catch {
        results.push({ name: "lcm-md", category: "Settings", status: "fail", message: "Claude lcm-memory skill could not be read. Run: lcm install" });
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

    results.push({ name: "mcp-handshake-lcm", category: "MCP Servers", status: "skip",
      message: "MCP protocol not probed: doctor observes static registration only. Run: lcm connectors doctor claude" });

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

    const globalUserPatternCount = config.globalUserPatternCount ?? 0;

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
      deps.homedir,
    );
  } catch {
    results.push({ name: "doctor-observation", category: "Diagnostics", status: "fail",
      message: "Diagnostic observation failed. Review local permissions and configuration, then run: lcm doctor" });
  }

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
    console.log(`    ${icon} ${COLORS.dim}${r.name}${COLORS.nc}  ${r.message}`);
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
        lines.push(`| ${r.name} | ${icon} ${r.message} |`);
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
