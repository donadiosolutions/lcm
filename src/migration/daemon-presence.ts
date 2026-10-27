import { readFileSync } from "node:fs";
import { DaemonClient, type DaemonObservation } from "../daemon/client.js";
import { readDaemonConfigSnapshot } from "../daemon/config.js";
import { readAuthToken } from "../daemon/auth.js";
import { configPath, daemonPidPath, daemonTokenPath } from "../runtime-paths.js";

/**
 * Section 7's presence classifier. `apply` must positively establish
 * daemon presence before taking the hold and refuse exit 5 when it cannot
 * — never conclude "nothing answered, therefore nothing is stale".
 *
 * **Not `createDaemonReadClientOrExit`.** That function (bin/lcm.ts) folds
 * an unreachable daemon, a version mismatch, an entrypoint mismatch, an
 * unstable config witness, **and a storage-backend mismatch** into one
 * generic "identity could not be verified" throw. The backend-mismatch
 * case is exactly #1384's condition — a live daemon holding a stale
 * startup backend — so reusing that function here would make the single
 * most important "present" case indistinguishable from "no daemon exists
 * at all". It is not a defective function: it correctly answers "can I
 * trust this daemon enough to read from it" for its own caller. This
 * module answers a different question — "is a daemon there, and what
 * backend does it claim" — and needs its own classifier for that reason.
 *
 * Two independent observations, each breakable on its own, exactly as the
 * rest of this item is built:
 *
 * - The daemon's own answer (`DaemonClient.observe()`), which returns a
 *   strictly-parsed `DaemonObservation` with a **required, never-defaulted**
 *   `storageBackend` field on success, or `null` for every failure mode
 *   (no daemon, unreachable, malformed response) — deliberately not
 *   `DaemonClient.health()`, whose `storageBackend` defaults to
 *   `"sqlite"` on an old daemon (`client.ts:137-138`, #1394) and would
 *   silently fabricate the one fact this classifier exists to observe
 *   honestly.
 * - The process-liveness side: the daemon pid file
 *   (`daemonPidPath`) plus a liveness check on whatever pid it names.
 *   `observe()` returning `null` never decides anything by itself; only
 *   this second, independent observation can turn that null into either
 *   "authoritatively absent" (no pid file, or a pid file naming a
 *   definitively dead process) or "unresolvable" (a pid file names a live
 *   process, but it did not answer — never treated as absence).
 */

export type MigrationDaemonPresence =
  | Readonly<{ status: "present"; storageBackend: string; pid: number; daemonInstanceId: string }>
  | Readonly<{ status: "authoritatively-absent" }>
  | Readonly<{ status: "unresolvable"; evidence: string }>;

type MigrationDaemonPidFileRead =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "present"; pid: number }>
  | Readonly<{ status: "unresolvable"; evidence: string }>;

type MigrationDaemonProcessLiveness = "alive" | "dead" | "unresolvable";

export type MigrationDaemonPresenceOperations = Readonly<{
  observe: (homeDir: string) => Promise<DaemonObservation | null>;
  readPidFile: (homeDir: string) => MigrationDaemonPidFileRead;
  classifyLiveness: (pid: number) => MigrationDaemonProcessLiveness;
}>;

function defaultReadPidFile(homeDir: string): MigrationDaemonPidFileRead {
  let content: string;
  try {
    content = readFileSync(daemonPidPath(homeDir), "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "absent" };
    return { status: "unresolvable", evidence: `pidfile-${String(code)}` };
  }
  // The whole trimmed content must be one canonical positive integer:
  // Number.parseInt would accept a numeric prefix ("123junk"), and then
  // probe a pid the file never named. A dead stranger would read as
  // absence and a live one as the wrong liveness evidence.
  const trimmed = content.trim();
  const pid = /^[1-9][0-9]*$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(pid)) {
    return { status: "unresolvable", evidence: "pidfile-malformed" };
  }
  return { status: "present", pid };
}

/**
 * Mirrors `src/daemon/lifecycle.ts`'s own `isProcessAlive` classification
 * (a bare `process.kill(pid, 0)` probe), but three-valued rather than
 * two-valued: `ESRCH` is a positive "definitely dead" observation,
 * `EPERM` means the process exists (just not signalable by us) so it is
 * still `alive`, and any other unexpected errno is `unresolvable` rather
 * than silently folded into "dead" the way a bare boolean would.
 */
function defaultClassifyLiveness(pid: number): MigrationDaemonProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unresolvable";
  }
}

async function defaultObserve(homeDir: string): Promise<DaemonObservation | null> {
  const snapshot = readDaemonConfigSnapshot(configPath(homeDir));
  const tokenPath = daemonTokenPath(homeDir);
  const token = readAuthToken(tokenPath);
  if (token === null || token.length === 0) return null;
  const port = snapshot.config.daemon.port;
  const client = new DaemonClient(`http://127.0.0.1:${port}`, tokenPath);
  return client.observe({ timeoutMs: 2000 });
}

export async function classifyMigrationDaemonPresence(input: Readonly<{
  homeDir: string;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/`.
   */
  _operationsForTesting?: Partial<MigrationDaemonPresenceOperations>;
}>): Promise<MigrationDaemonPresence> {
  const observe = input._operationsForTesting?.observe ?? defaultObserve;
  const readPidFile = input._operationsForTesting?.readPidFile ?? defaultReadPidFile;
  const classifyLiveness = input._operationsForTesting?.classifyLiveness ?? defaultClassifyLiveness;

  let observation: DaemonObservation | null;
  try {
    observation = await observe(input.homeDir);
  } catch (error) {
    // A genuine setup failure (malformed config, unreadable snapshot) is
    // not the same fact as "no daemon answered" — it is a failure to even
    // ask the question, and must not fall through to the pid-file side as
    // if it were an ordinary non-answer.
    return { status: "unresolvable", evidence: error instanceof Error ? `observe-${error.name}` : "observe-unknown-error" };
  }

  if (observation !== null) {
    // A genuine, attributable answer is decisive on its own — including,
    // and especially, when the observed backend disagrees with whatever
    // the live config says. That disagreement is #1384's condition and is
    // the finding this classifier exists to surface, never an error to
    // paper over.
    return {
      status: "present",
      storageBackend: observation.storageBackend,
      pid: observation.pid,
      daemonInstanceId: observation.daemonInstanceId,
    };
  }

  const pidFile = readPidFile(input.homeDir);
  if (pidFile.status === "unresolvable") {
    return { status: "unresolvable", evidence: pidFile.evidence };
  }
  if (pidFile.status === "absent") {
    // Two independent observations now agree: the daemon's own channel did
    // not answer, and no pid is even recorded to check liveness for.
    return { status: "authoritatively-absent" };
  }

  const liveness = classifyLiveness(pidFile.pid);
  if (liveness === "dead") {
    // A stale pid file naming a definitively dead process, plus no answer
    // from the daemon's own channel: both observations agree on absence.
    return { status: "authoritatively-absent" };
  }
  if (liveness === "alive") {
    // A live process is tracked but did not answer authentication or
    // identity checks. Never absence: it could be starting up, hung, or
    // simply not the daemon we expect. No attributable identity exists
    // either, so this is not "present" — it is genuinely unresolvable.
    return { status: "unresolvable", evidence: "pidfile-live-no-answer" };
  }
  return { status: "unresolvable", evidence: "pidfile-liveness-unresolvable" };
}
