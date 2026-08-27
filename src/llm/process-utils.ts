import { readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { lcmHomeDir } from "../runtime-paths.js";

export const MAX_MODEL_DISPLAY_LENGTH = 80;

export function boundedModelForDisplay(model: string): string {
  const sanitized = model
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length <= MAX_MODEL_DISPLAY_LENGTH) return sanitized || "default";
  return `${sanitized.slice(0, MAX_MODEL_DISPLAY_LENGTH)}...[truncated]`;
}

export function createProcessCompatibilityError(options: {
  cliName: string;
  providerId: string;
  code: number | null;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}): Error {
  const model = boundedModelForDisplay(options.model ?? "default");
  const reasoningEffort = options.reasoningEffort ?? "default/omitted";
  const fastMode = options.fastMode === undefined ? "default/omitted" : String(options.fastMode);
  return new Error(
    `${options.cliName} CLI rejected the compaction request (exit ${options.code ?? "unknown"}; diagnostic output omitted): ` +
      `provider ${options.providerId}, model ${JSON.stringify(model)}, reasoning effort ${JSON.stringify(reasoningEffort)}, ` +
      `fast mode ${fastMode}. Upgrade the ${options.cliName} CLI or choose a supported model and control combination.`,
  );
}

type ProcessChild = {
  readonly pid?: number | null;
  kill: (signal?: NodeJS.Signals | number) => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

type ProcessGroupProbe = (pgid: number) => boolean;
type ProcessKill = (pid: number, signal?: NodeJS.Signals | number) => void;

export type OwnedProcessTeardownOptions = Readonly<{
  child: ProcessChild;
  /** Override the host platform for deterministic tests. */
  platform?: NodeJS.Platform;
  /** The child-owned process group, when it has been independently validated. */
  processGroupId?: number;
  /** The daemon's process group; a matching group is never signaled. */
  daemonProcessGroupId?: number;
  /** Injectable process signal seam. */
  killProcess?: ProcessKill;
  /** Injectable group-liveness probe. */
  isProcessGroupAlive?: ProcessGroupProbe;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}>;

export type OwnedProcessTeardown = Readonly<{
  pid?: number;
  processGroupId?: number;
  groupValidated: boolean;
  /** Wait for the child close and (when validated) group disappearance. */
  waitForSettlement: () => Promise<boolean>;
  /** Idempotently tear down one process. Cancellation waits for full settlement. */
  terminate: (reason?: "abort" | "timeout") => Promise<boolean>;
}>;

const POSIX_PROCESS_GROUP_PLATFORMS = new Set<NodeJS.Platform>([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
]);
const PROCESS_GROUP_POLL_MS = 20;
const PROCESS_GROUP_TERM_GRACE_MS = 2_000;

function positivePid(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function linuxProcessGroupId(pid: number): number | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    const pgid = Number(fields[2]);
    return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : undefined;
  } catch {
    return undefined;
  }
}

function defaultProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
}

function resolveOwnedProcessGroup(options: OwnedProcessTeardownOptions, pid: number | undefined): number | undefined {
  const platform = options.platform ?? process.platform;
  if (!POSIX_PROCESS_GROUP_PLATFORMS.has(platform) || pid === undefined) return undefined;
  const candidate = positivePid(options.processGroupId)
    ?? (platform === "linux" ? linuxProcessGroupId(pid) : undefined);
  if (candidate === undefined) return undefined;

  const daemonGroup = positivePid(options.daemonProcessGroupId)
    ?? (platform === "linux" ? linuxProcessGroupId(process.pid) : undefined);
  // Without a daemon-group witness on non-Linux hosts, direct-child cleanup is
  // the safest equivalent: never guess at a group that might be shared.
  if (daemonGroup === undefined || candidate === daemonGroup) return undefined;
  return candidate;
}

function safeChildSignal(child: ProcessChild, signal: NodeJS.Signals): void {
  // A ChildProcess handle is already bound by the spawn operation.  It remains
  // a safe direct-child target even when a test seam (or an older runtime)
  // does not expose a numeric pid.
  try {
    child.kill(signal);
  } catch {
    // A concurrently exiting child is already on the close path.
  }
}

/**
 * Create one idempotent teardown controller for a spawned provider process.
 * Group signaling is enabled only for a positive child/group identity that is
 * proven distinct from the daemon group; all other cases use the child handle.
 */
export function createOwnedProcessTeardown(options: OwnedProcessTeardownOptions): OwnedProcessTeardown {
  const pid = positivePid(options.child.pid);
  const groupId = resolveOwnedProcessGroup(options, pid);
  const killProcess = options.killProcess ?? ((target: number, signal?: NodeJS.Signals | number) => process.kill(target, signal));
  const isGroupAlive = options.isProcessGroupAlive ?? defaultProcessGroupAlive;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  let childClosed = false;
  let termination: Promise<boolean> | undefined;
  let closeListener: ((...args: unknown[]) => void) | undefined;
  // Observe close from creation so an abort cannot miss a child that exited
  // between the provider's terminal event and teardown initialization.
  options.child.once("close", () => { childClosed = true; });

  const signalTarget = (signal: NodeJS.Signals): void => {
    if (groupId === undefined) {
      safeChildSignal(options.child, signal);
      return;
    }
    try {
      // Negative PGIDs are the POSIX process-group form.  The validated
      // positive group identity above is the only value allowed to reach here.
      killProcess(-groupId, signal);
    } catch {
      // If a platform rejects group signaling, still terminate the owned child.
      safeChildSignal(options.child, signal);
    }
  };

  const groupDisappeared = (): boolean => {
    if (groupId === undefined) return true;
    try {
      return !isGroupAlive(groupId);
    } catch {
      // An unverifiable group remains evidence-bearing; do not claim it gone.
      return false;
    }
  };

  const waitForSettlement = (deadlineMs?: number): Promise<boolean> => new Promise(resolve => {
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      if (pollTimer !== undefined) clearTimer(pollTimer);
      if (deadlineTimer !== undefined) clearTimer(deadlineTimer);
      options.child.removeListener("close", closeListener!);
      closeListener = undefined;
      resolve(result);
    };
    closeListener = (): void => {
      childClosed = true;
      if (groupDisappeared()) finish(true);
    };
    options.child.once("close", closeListener);
    if (deadlineMs !== undefined) {
      deadlineTimer = setTimer(() => finish(false), deadlineMs);
    }
    const poll = (): void => {
      if (childClosed && groupDisappeared()) {
        finish(true);
        return;
      }
      pollTimer = setTimer(poll, PROCESS_GROUP_POLL_MS);
    };
    poll();
  });

  const waitForSettlementWithoutDeadline = (): Promise<boolean> => waitForSettlement();

  const terminate = (reason: "abort" | "timeout" = "abort"): Promise<boolean> => {
    if (termination !== undefined) return termination;
    termination = (async () => {
      signalTarget("SIGTERM");
      // Older process fakes may not expose a pid or close event. Preserve the
      // historical immediate timeout/error result for that unidentifiable
      // compatibility path; real children with validated PIDs take the full
      // TERM -> KILL settlement path below.
      if (reason === "timeout" && pid === undefined) return false;
      if (await waitForSettlement(PROCESS_GROUP_TERM_GRACE_MS)) return true;
      signalTarget("SIGKILL");
      return waitForSettlement();
    })();
    return termination;
  };

  return {
    pid,
    processGroupId: groupId,
    groupValidated: groupId !== undefined,
    waitForSettlement: waitForSettlementWithoutDeadline,
    terminate,
  };
}

export type ProviderProcessWitness = Readonly<{
  daemonInstanceId: string;
  providerId: string;
  pid: number;
  pgid: number | null;
  processStartTime: string | null;
}>;

type WitnessOperations = Readonly<{
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
  chmodSync: typeof chmodSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
}>;

export type ProviderProcessWitnessStore = Readonly<{
  path: string;
  add: (entry: ProviderProcessWitness) => void;
  remove: (entry: ProviderProcessWitness) => void;
}>;

const DEFAULT_WITNESS_FILE = "daemon-runtime.json";
const DEFAULT_WITNESS_OPERATIONS: WitnessOperations = {
  readFileSync,
  writeFileSync,
  chmodSync,
  renameSync,
  unlinkSync,
};

function readWitnesses(path: string, operations: WitnessOperations): ProviderProcessWitness[] {
  try {
    const parsed = JSON.parse(operations.readFileSync(path, "utf8")) as { providers?: unknown };
    if (!parsed || !Array.isArray(parsed.providers)) return [];
    return parsed.providers.filter((entry): entry is ProviderProcessWitness => {
      if (!entry || typeof entry !== "object") return false;
      const candidate = entry as Partial<ProviderProcessWitness>;
      return typeof candidate.daemonInstanceId === "string"
        && typeof candidate.providerId === "string"
        && positivePid(candidate.pid) !== undefined
        && (candidate.pgid === null || positivePid(candidate.pgid) !== undefined)
        && (candidate.processStartTime === null || typeof candidate.processStartTime === "string");
    });
  } catch {
    return [];
  }
}

function writeWitnesses(path: string, daemonInstanceId: string, providers: readonly ProviderProcessWitness[], operations: WitnessOperations): void {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${DEFAULT_WITNESS_FILE}.${process.pid}.${Date.now()}.tmp`);
  const content = `${JSON.stringify({ version: 1, daemonInstanceId, providers })}\n`;
  operations.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  operations.chmodSync(temporaryPath, 0o600);
  try {
    operations.renameSync(temporaryPath, path);
  } catch (error) {
    try {
      operations.unlinkSync(temporaryPath);
    } catch {
      // Preserve the original publication failure.
    }
    throw error;
  }
}

/** Maintain a secret-free owner-only witness for provider child identities. */
export function createProviderProcessWitnessStore(options: {
  daemonInstanceId: string;
  path?: string;
  operations?: Partial<WitnessOperations>;
}): ProviderProcessWitnessStore {
  const path = options.path ?? join(lcmHomeDir(), DEFAULT_WITNESS_FILE);
  const operations: WitnessOperations = { ...DEFAULT_WITNESS_OPERATIONS, ...options.operations };
  const update = (entry: ProviderProcessWitness, remove: boolean): void => {
    const current = readWitnesses(path, operations)
      .filter(candidate => candidate.daemonInstanceId === options.daemonInstanceId);
    const otherDaemonEntries = readWitnesses(path, operations)
      .filter(candidate => candidate.daemonInstanceId !== options.daemonInstanceId);
    const matches = (candidate: ProviderProcessWitness): boolean => candidate.providerId === entry.providerId
      && candidate.pid === entry.pid
      && candidate.pgid === entry.pgid
      && candidate.processStartTime === entry.processStartTime;
    const nextCurrent = remove
      ? current.filter(candidate => !matches(candidate))
      : [...current.filter(candidate => !matches(candidate)), entry];
    const next = [...otherDaemonEntries, ...nextCurrent];
    if (next.length === 0) {
      try {
        operations.unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
      }
      return;
    }
    writeWitnesses(path, options.daemonInstanceId, next, operations);
  };
  return {
    path,
    add: entry => update(entry, false),
    remove: entry => update(entry, true),
  };
}

/** Internal pure/lifecycle seams used by provider tests. */
export const __processUtilsTestUtils = {
  positivePid,
  linuxProcessGroupId,
  resolveOwnedProcessGroup,
  defaultProcessGroupAlive,
  readWitnesses,
  writeWitnesses,
};
