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
 * - `satisfied`: authoritative absence. Either no pid file names a daemon
 *   AND nothing answers the daemon port, a named pid is not a running
 *   process AND nothing answers the daemon port, or a running daemon's own
 *   startup backend already matches the selection. There is nothing to
 *   restart.
 * - `unsatisfied`: a running daemon's startup backend is stale against the
 *   completed selection. It will refuse local outbox requests until it is
 *   restarted.
 * - `unresolvable`: a pid file names a process that is running, but its
 *   `/health` endpoint could not be observed (network failure, timeout, or
 *   an unrecognized response body); or the pid file itself exists but could
 *   not be read (`pid-file-unreadable`) or does not parse as a canonical
 *   pid (`pid-file-malformed`). This is distinct from both definite
 *   answers: the verifier could not look, so it must not be reported as
 *   either "no live daemon" or "stale daemon".
 *
 * The pid-file read is itself attributed three ways (plan-v7 A12, raised as
 * #627 PA-7 against the earlier version of this module, which folded every
 * unusable pid file into `no-pid-file`): only ENOENT is authoritative
 * absence. A file that exists with garbage in it, or one the bounded
 * no-follow reader refuses, says nothing about whether a daemon is running
 * -- the daemon may be alive under a pid this verifier failed to obtain --
 * so both are `unresolvable`, never `satisfied`.
 *
 * Absence of a pid file is likewise not absence of a daemon (plan-v7.1 R1).
 * A daemon can be live before its pid file is written, or after the file
 * was removed, so on ENOENT (and on a pid file naming a dead process) the
 * verifier makes its own independent observation: it probes the configured
 * daemon port. A refused connection is the positive absence that licenses
 * `satisfied`. A daemon that answers is evaluated on its reported backend:
 * a stale backend is `unsatisfied` / `backend-stale` exactly as on the
 * pid-file path; a matching backend is `unresolvable` /
 * `live-daemon-without-pid-file` and never `satisfied`, because a daemon
 * no pid file accounts for cannot be attributed, and a live daemon on a pid
 * other than the one a stale file names is the same situation. A timeout or
 * any other answer is `unresolvable` / `health-unreachable`.
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
  /** The pid file exists but its content is not a canonical safe-integer
   * pid; the daemon's pid could not be obtained, so nothing was checked. */
  | "pid-file-malformed"
  /** The pid file could not be read for a reason other than ENOENT
   * (permission denied, a symlink refused by the no-follow reader, I/O
   * error); the daemon's pid could not be obtained. */
  | "pid-file-unreadable"
  /** No pid file (or a pid file naming a dead process), yet a daemon whose
   * backend matches the selection answered the daemon port: it cannot be
   * attributed, so the cutover is not proven safe. */
  | "live-daemon-without-pid-file"
  | "stale-pid-file"
  | "backend-matches"
  | "backend-stale"
  | "health-unreachable"
  /** /health answered, but its body.pid is missing, not a number, or not the
   * pid named by the pid file, so the answer cannot be attributed to that
   * daemon. */
  | "health-pid-mismatch";

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

/** One attributed read of the pid file. `absent` is ENOENT only; a file
 * that exists but cannot be parsed is `malformed`, and any other read
 * failure is `unreadable`. Never collapse the last two into `absent`. */
export type ActivationPidFileRead = Readonly<
  | { kind: "present"; pid: number }
  | { kind: "absent" }
  | { kind: "malformed"; detail: string }
  | { kind: "unreadable"; detail: string }
>;

export type ActivationRestartCheckDependencies = Readonly<{
  /** Override pid-file reading with an already-attributed outcome. */
  readPidFile?: (pidFilePath: string) => ActivationPidFileRead;
  /** Override process-liveness detection. */
  isProcessAlive?: (pid: number) => boolean;
  /** Override the signal-sending primitive used by the default liveness
   * probe. Defaults to process.kill. Only ESRCH means the process is gone. */
  killProcess?: (pid: number, signal: number) => void;
  /** Override the fetch implementation used to probe `/health`. */
  fetchFn?: typeof globalThis.fetch;
}>;

/** Bytes are generous for a decimal pid with surrounding whitespace. */
const MAX_PID_FILE_BYTES = 32;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;

const CANONICAL_PID = /^[1-9][0-9]*$/u;

/**
 * Read a pid file through the repository's bounded, no-follow file reader
 * (the same defense used for the daemon's own publication-config reads)
 * and attribute the outcome: `absent` only for ENOENT; `unreadable` for
 * any other read failure (the error's code or message is carried as
 * detail; the reader's own messages name the refused path, never file
 * content); `malformed` for content that is not, after trimming
 * surrounding whitespace, exactly a canonical positive decimal pid (no
 * sign, leading zero, fraction, exponent or trailing text) within the
 * safe-integer range; `present` otherwise.
 */
function defaultReadPidFile(pidFilePath: string): ActivationPidFileRead {
  let content: string;
  try {
    content = readBoundedRegularFile(pidFilePath, {
      allowedRoot: dirname(pidFilePath),
      maxBytes: MAX_PID_FILE_BYTES,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return {
      kind: "unreadable",
      detail: "reading " + pidFilePath + " failed: " + (typeof code === "string" ? code : (error as Error).message),
    };
  }
  const text = content.trim();
  if (!CANONICAL_PID.test(text)) {
    return { kind: "malformed", detail: "the content of " + pidFilePath + " is not a canonical pid" };
  }
  const pid = Number(text);
  if (!Number.isSafeInteger(pid)) {
    return { kind: "malformed", detail: "the content of " + pidFilePath + " is not a canonical pid (out of range)" };
  }
  return { kind: "present", pid };
}

function defaultIsProcessAlive(
  pid: number,
  killProcess: (pid: number, signal: number) => void,
): boolean {
  try {
    killProcess(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves the process is gone. EPERM (a live process owned by
    // another user) and every other failure leave the process alive so the
    // /health step decides.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

type HealthProbe =
  | Readonly<{ kind: "observed"; backend: StorageBackend }>
  /** The connection was positively refused: nothing listens on the port. */
  | Readonly<{ kind: "refused"; detail: string }>
  | Readonly<{ kind: "unreachable"; detail: string }>
  | Readonly<{ kind: "pid-mismatch"; detail: string }>;

function isConnectionRefused(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  return (cause as NodeJS.ErrnoException | undefined)?.code === "ECONNREFUSED";
}

/**
 * Probe `/health` unauthenticated. The daemon reports its own startup
 * `storageBackend` on every `/health` response, healthy or not (see
 * `src/daemon/server.ts`), so an HTTP-level failure status is not treated
 * as "unreachable" here as long as the body names a recognized backend.
 * Only a network failure, a timeout, or a body that does not name a
 * recognized backend counts as "the daemon did not answer".
 *
 * The body must also report the pid named by the pid file: `/health` sends
 * `pid: process.pid` on every response, so a missing, non-numeric or
 * different pid means the listener on this port is not the daemon the pid
 * file names, and its backend is not accepted. When no pid file names a
 * daemon (expectedPid null), any reported pid is accepted as an observation
 * and the caller attributes it.
 *
 * A refused connection is reported separately from every other failure:
 * it is the one outcome that positively proves nothing is listening.
 */
async function probeDaemonHealth(
  port: number,
  expectedPid: number | null,
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
      const reportedPid = (body as { pid?: unknown }).pid;
      if (expectedPid !== null && reportedPid !== expectedPid) {
        return {
          kind: "pid-mismatch",
          detail: "the /health response reported pid " + String(reportedPid) + " instead of " + String(expectedPid),
        };
      }
      return { kind: "observed", backend: backend as StorageBackend };
    }
    return {
      kind: "unreachable",
      detail: "the /health response did not report a recognized storage backend",
    };
  } catch (error) {
    if (isConnectionRefused(error)) {
      return { kind: "refused", detail: "connection to port " + port + " was refused" };
    }
    return {
      kind: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The independent observation plan-v7.1 R1 requires before an absent (or
 * dead-process) pid file may be called satisfied: probe the daemon port
 * with no expected pid and attribute what answers. absentReason is the
 * satisfied reason to use when the port positively refuses.
 */
async function attributeWithoutPid(
  absentReason: "no-pid-file" | "stale-pid-file",
  absentDetail: string,
  pid: number | null,
  port: number,
  selectedBackend: StorageBackend,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<ActivationRestartCheckResult> {
  const probe = await probeDaemonHealth(port, null, fetchFn, timeoutMs);
  if (probe.kind === "refused") {
    return buildResult("satisfied", absentReason, absentDetail + "; " + probe.detail, pid, null, selectedBackend);
  }
  if (probe.kind === "observed") {
    if (probe.backend !== selectedBackend) {
      return buildResult(
        "unsatisfied",
        "backend-stale",
        `a daemon not accounted for by a pid file answered /health on port ${port} with startup backend "${probe.backend}", which differs from the selected backend "${selectedBackend}"; it will refuse local outbox requests until it restarts`,
        pid,
        probe.backend,
        selectedBackend,
      );
    }
    return buildResult(
      "unresolvable",
      "live-daemon-without-pid-file",
      `a daemon not accounted for by a pid file answered /health on port ${port} with startup backend "${probe.backend}"; it cannot be attributed, so the cutover is not proven safe`,
      pid,
      probe.backend,
      selectedBackend,
    );
  }
  return buildResult(
    "unresolvable",
    "health-unreachable",
    `${absentDetail}, but /health on port ${port} neither refused nor answered: ${probe.detail}`,
    pid,
    null,
    selectedBackend,
  );
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
  const killProcess = dependencies.killProcess ?? ((pid: number, signal: number) => process.kill(pid, signal));
  const isProcessAlive = dependencies.isProcessAlive ?? ((pid: number) => defaultIsProcessAlive(pid, killProcess));
  const fetchFn = dependencies.fetchFn ?? globalThis.fetch;
  const timeoutMs = input.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const { selectedBackend, pidFilePath, port } = input;

  const read = readPidFile(pidFilePath);
  if (read.kind === "absent") {
    return attributeWithoutPid(
      "no-pid-file",
      `no pid file at ${pidFilePath}`,
      null,
      port,
      selectedBackend,
      fetchFn,
      timeoutMs,
    );
  }
  if (read.kind === "malformed") {
    return buildResult(
      "unresolvable",
      "pid-file-malformed",
      `the pid file at ${pidFilePath} exists but could not be parsed, so no daemon pid was obtained: ${read.detail}`,
      null,
      null,
      selectedBackend,
    );
  }
  if (read.kind === "unreadable") {
    return buildResult(
      "unresolvable",
      "pid-file-unreadable",
      `the pid file at ${pidFilePath} could not be read, so no daemon pid was obtained: ${read.detail}`,
      null,
      null,
      selectedBackend,
    );
  }
  const pid = read.pid;

  if (!isProcessAlive(pid)) {
    return attributeWithoutPid(
      "stale-pid-file",
      `pid file at ${pidFilePath} names pid ${pid}, but that process is not running`,
      pid,
      port,
      selectedBackend,
      fetchFn,
      timeoutMs,
    );
  }

  const probe = await probeDaemonHealth(port, pid, fetchFn, timeoutMs);
  if (probe.kind === "pid-mismatch") {
    return buildResult(
      "unresolvable",
      "health-pid-mismatch",
      `pid ${pid} is running but /health on port ${port} cannot be attributed to it: ${probe.detail}`,
      pid,
      null,
      selectedBackend,
    );
  }
  if (probe.kind === "unreachable" || probe.kind === "refused") {
    // On the pid-file path a refused connection is not absence: the named
    // process is alive, so it was looked for and not found at the port.
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
