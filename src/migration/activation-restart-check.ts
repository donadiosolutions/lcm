import { dirname } from "node:path";
import { STORAGE_BACKENDS, type StorageBackend } from "../daemon/config.js";
import { readBoundedRegularFile } from "../security-files.js";

/**
 * A live daemon freezes its selected storage backend at startup and refuses
 * local outbox requests once the on-disk selection diverges (see
 * `assertDaemonRequestStorageAdmission` in `src/daemon/server.ts`, which
 * throws "daemon request backend differs from the authenticated startup
 * backend"). After a migration cutover completes, callers need to know
 * whether a leftover daemon process will hit that refusal before they can
 * report the cutover as safely activated.
 *
 * The answer here is deliberately three-valued rather than boolean:
 *
 * - `satisfied`: authoritative absence. Either no pid file names a daemon,
 *   a named pid is not a running process, or a running daemon's own startup
 *   backend already matches the selection. There is nothing to restart.
 * - `unsatisfied`: a running daemon's startup backend is stale against the
 *   completed selection. It will refuse local outbox requests until it is
 *   restarted.
 * - `unresolvable`: a pid file names a process that is running, but its
 *   `/health` endpoint could not be observed (network failure, timeout, or
 *   an unrecognized response body). This is distinct from both definite
 *   answers: the verifier could not look, so it must not be reported as
 *   either "no live daemon" or "stale daemon".
 *
 * Collapsing `unresolvable` into either neighbour would either block a
 * correct cutover forever (folded into `unsatisfied`) or let a genuinely
 * stale daemon pass silently (folded into `satisfied`). Callers that need
 * to attribute an absence must use `reason` and `detail`; this module does
 * not discard that attribution.
 */

export type ActivationRestartCheckStatus = "satisfied" | "unsatisfied" | "unresolvable";

export type ActivationRestartCheckReason =
  | "no-pid-file"
  | "stale-pid-file"
  | "backend-matches"
  | "backend-stale"
  | "health-unreachable";

/** Attributed three-valued verification result. Never collapse to boolean. */
export type ActivationRestartCheckResult = Readonly<{
  status: ActivationRestartCheckStatus;
  reason: ActivationRestartCheckReason;
  /** Human-readable attribution for the status; always populated. */
  detail: string;
  /** The pid named by the pid file, when one exists, regardless of liveness. */
  pid: number | null;
  /** The live daemon's own reported startup backend, when it could be observed. */
  observedBackend: StorageBackend | null;
  /** The backend the caller resolved as the completed migration selection. */
  selectedBackend: StorageBackend;
}>;

export type ActivationRestartCheckInput = Readonly<{
  /** The backend the caller has already resolved as the completed selection. */
  selectedBackend: StorageBackend;
  /** Path to the daemon's pid file (e.g. `daemonPidPath()`). */
  pidFilePath: string;
  /** The daemon's configured port, used to probe `/health`. */
  port: number;
  /** Deadline for the `/health` probe. Defaults to 2000ms. */
  healthTimeoutMs?: number;
}>;

export type ActivationRestartCheckDependencies = Readonly<{
  /** Override pid-file reading. Must return `null` for any unusable pid. */
  readPidFile?: (pidFilePath: string) => number | null;
  /** Override process-liveness detection. */
  isProcessAlive?: (pid: number) => boolean;
  /** Override the fetch implementation used to probe `/health`. */
  fetchFn?: typeof globalThis.fetch;
}>;

/** Bytes are generous for a decimal pid with surrounding whitespace. */
const MAX_PID_FILE_BYTES = 32;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Read a pid file through the repository's bounded, no-follow file reader
 * (the same defense used for the daemon's own publication-config reads).
 * Returns `null` for a missing file or content that does not name a
 * positive integer pid; any other read failure propagates.
 */
function defaultReadPidFile(pidFilePath: string): number | null {
  let content: string;
  try {
    content = readBoundedRegularFile(pidFilePath, {
      allowedRoot: dirname(pidFilePath),
      maxBytes: MAX_PID_FILE_BYTES,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const pid = Number.parseInt(content.trim(), 10);
  return isPositiveInteger(pid) ? pid : null;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type HealthProbe =
  | Readonly<{ kind: "observed"; backend: StorageBackend }>
  | Readonly<{ kind: "unreachable"; detail: string }>;

/**
 * Probe `/health` unauthenticated. The daemon reports its own startup
 * `storageBackend` on every `/health` response, healthy or not (see
 * `src/daemon/server.ts`), so an HTTP-level failure status is not treated
 * as "unreachable" here as long as the body names a recognized backend.
 * Only a network failure, a timeout, or a body that does not name a
 * recognized backend counts as "the daemon did not answer".
 */
async function probeDaemonHealth(
  port: number,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<HealthProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    const body: unknown = await response.json();
    const backend = body !== null && typeof body === "object"
      ? (body as { storageBackend?: unknown }).storageBackend
      : undefined;
    if (typeof backend === "string" && (STORAGE_BACKENDS as readonly string[]).includes(backend)) {
      return { kind: "observed", backend: backend as StorageBackend };
    }
    return {
      kind: "unreachable",
      detail: "the /health response did not report a recognized storage backend",
    };
  } catch (error) {
    return {
      kind: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildResult(
  status: ActivationRestartCheckStatus,
  reason: ActivationRestartCheckReason,
  detail: string,
  pid: number | null,
  observedBackend: StorageBackend | null,
  selectedBackend: StorageBackend,
): ActivationRestartCheckResult {
  return Object.freeze({ status, reason, detail, pid, observedBackend, selectedBackend });
}

/**
 * Answer, with an attributed three-valued result, whether a live LCM daemon
 * (if any) is admitted against the caller's already-resolved selected
 * storage backend. See the module doc comment above for the full contract.
 * This function only observes; it never spawns, restarts, or signals a
 * daemon.
 */
export async function checkActivationRestartAdmission(
  input: ActivationRestartCheckInput,
  dependencies: ActivationRestartCheckDependencies = {},
): Promise<ActivationRestartCheckResult> {
  const readPidFile = dependencies.readPidFile ?? defaultReadPidFile;
  const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
  const fetchFn = dependencies.fetchFn ?? globalThis.fetch;
  const timeoutMs = input.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const { selectedBackend, pidFilePath, port } = input;

  const pid = readPidFile(pidFilePath);
  if (pid === null) {
    return buildResult(
      "satisfied",
      "no-pid-file",
      `no usable pid file at ${pidFilePath}; there is no live daemon to admit against the "${selectedBackend}" selection`,
      null,
      null,
      selectedBackend,
    );
  }

  if (!isProcessAlive(pid)) {
    return buildResult(
      "satisfied",
      "stale-pid-file",
      `pid file at ${pidFilePath} names pid ${pid}, but that process is not running; there is no live daemon to admit`,
      pid,
      null,
      selectedBackend,
    );
  }

  const probe = await probeDaemonHealth(port, fetchFn, timeoutMs);
  if (probe.kind === "unreachable") {
    return buildResult(
      "unresolvable",
      "health-unreachable",
      `pid ${pid} is running but /health on port ${port} could not be observed: ${probe.detail}`,
      pid,
      null,
      selectedBackend,
    );
  }

  if (probe.backend === selectedBackend) {
    return buildResult(
      "satisfied",
      "backend-matches",
      `pid ${pid} is running with startup backend "${probe.backend}", which matches the selected backend`,
      pid,
      probe.backend,
      selectedBackend,
    );
  }

  return buildResult(
    "unsatisfied",
    "backend-stale",
    `pid ${pid} is running with startup backend "${probe.backend}", which differs from the selected backend "${selectedBackend}"; it will refuse local outbox requests until it restarts`,
    pid,
    probe.backend,
    selectedBackend,
  );
}
