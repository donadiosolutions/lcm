import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { lcmHomeDir } from "../runtime-paths.js";
import {
  processStartTime,
  withPrivateMutationLock,
} from "../private-mutation-lock.js";
import { readBoundedRegularFileWithStat } from "../security-files.js";

export const MAX_MODEL_DISPLAY_LENGTH = 80;

/** Normalize host process-birth probes to the witness file's null sentinel. */
export function normalizeProcessBirthTime(value: string | null | undefined): string | null {
  return value ?? null;
}

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
type ProcessBirthProbe = (pid: number) => string | null;
type ProcessGroupIdProbe = (pid: number) => number | undefined;

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
  /** Injectable process-birth identity probe. */
  processBirthTime?: ProcessBirthProbe;
  /** Injectable current process-group identity probe. */
  processGroupIdProbe?: ProcessGroupIdProbe;
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
  terminate: (reason?: "abort" | "timeout" | "close") => Promise<boolean>;
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
const PROCESS_GROUP_KILL_GRACE_MS = 2_000;

function positivePid(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function linuxProcessGroupId(pid: number): number | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return positivePid(Number(fields[2]));
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
  const platform = options.platform ?? process.platform;
  const birthProbe = options.processBirthTime ?? processStartTime;
  let expectedBirth: string | undefined;
  if (pid !== undefined) {
    try {
      expectedBirth = birthProbe(pid) ?? undefined;
    } catch {
      expectedBirth = undefined;
    }
  }
  const candidateGroupId = resolveOwnedProcessGroup(options, pid);
  const groupId = candidateGroupId !== undefined && expectedBirth !== undefined ? candidateGroupId : undefined;
  const killProcess = options.killProcess ?? ((target: number, signal?: NodeJS.Signals | number) => process.kill(target, signal));
  const isGroupAlive = options.isProcessGroupAlive ?? defaultProcessGroupAlive;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const currentGroupProbe = options.processGroupIdProbe
    ?? (platform === "linux" && options.processGroupId === undefined ? linuxProcessGroupId : undefined);
  let childClosed = false;
  let termination: Promise<boolean> | undefined;
  let groupInvalidated = false;
  let groupDisappearedLatched = groupId === undefined;
  let settlementPromise: Promise<boolean> | undefined;
  let resolveSettlement: ((result: boolean) => void) | undefined;
  let settlementPollTimer: ReturnType<typeof setTimeout> | undefined;
  let settlementDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  // Observe close from creation so an abort cannot miss a child that exited
  // between the provider's terminal event and teardown initialization.
  const observeChildClose = (): void => {
    childClosed = true;
    groupDisappeared();
    if (settlementPromise !== undefined) checkSettlement();
  };
  options.child.once("close", observeChildClose);

  function groupDisappeared(): boolean {
    if (groupDisappearedLatched) return true;
    try {
      if (!isGroupAlive(groupId!)) {
        groupDisappearedLatched = true;
        return true;
      }
    } catch {
      // An unverifiable group remains evidence-bearing; do not claim it gone.
    }
    return false;
  }

  function groupIdentityStillOwned(): boolean {
    if (groupId === undefined || groupInvalidated || groupDisappearedLatched) return false;
    const processId = pid as number;
    const capturedBirth = expectedBirth as string;
    let observedBirth: string | null;
    try {
      observedBirth = birthProbe(processId);
    } catch {
      groupInvalidated = true;
      return false;
    }
    if (observedBirth === null || observedBirth !== capturedBirth) {
      groupInvalidated = true;
      return false;
    }
    if (currentGroupProbe !== undefined) {
      let observedGroup: number | undefined;
      try {
        observedGroup = currentGroupProbe(processId);
      } catch {
        groupInvalidated = true;
        return false;
      }
      if (observedGroup !== groupId) {
        groupInvalidated = true;
        return false;
      }
    } else if (childClosed) {
      // Once the child handle has closed, the captured PGID alone is no
      // longer enough to authenticate a negative-group signal. Without a
      // current PGID probe, fail closed rather than risking PID/PGID reuse.
      groupInvalidated = true;
      return false;
    }
    return true;
  }

  const signalTarget = (signal: NodeJS.Signals): void => {
    const disappearanceObserved = signal === "SIGKILL" || childClosed ? groupDisappeared() : false;
    if (groupId === undefined || disappearanceObserved || !groupIdentityStillOwned()) {
      if (!childClosed) safeChildSignal(options.child, signal);
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

  function finishSettlement(result: boolean): void {
    const resolve = resolveSettlement;
    if (resolve === undefined) return;
    resolveSettlement = undefined;
    if (settlementPollTimer !== undefined) {
      clearTimer(settlementPollTimer);
      settlementPollTimer = undefined;
    }
    if (settlementDeadlineTimer !== undefined) {
      clearTimer(settlementDeadlineTimer);
      settlementDeadlineTimer = undefined;
    }
    settlementPromise = undefined;
    resolve(result);
  }

  function checkSettlement(): void {
    const groupGone = groupDisappeared();
    if (childClosed && groupGone) finishSettlement(true);
  }

  function waitForSettlement(deadlineMs?: number): Promise<boolean> {
    if (childClosed && groupDisappeared()) return Promise.resolve(true);
    if (settlementPromise === undefined) {
      settlementPromise = new Promise<boolean>(resolve => { resolveSettlement = resolve; });
      const poll = (): void => {
        if (settlementPromise === undefined) return;
        settlementPollTimer = undefined;
        checkSettlement();
        if (settlementPromise !== undefined) {
          settlementPollTimer = setTimer(poll, PROCESS_GROUP_POLL_MS);
        }
      };
      settlementPollTimer = setTimer(poll, PROCESS_GROUP_POLL_MS);
    }
    if (deadlineMs !== undefined && settlementDeadlineTimer === undefined) {
      settlementDeadlineTimer = setTimer(() => finishSettlement(false), deadlineMs);
    }
    return settlementPromise;
  }

  const terminate = (reason: "abort" | "timeout" | "close" = "abort"): Promise<boolean> => {
    if (termination !== undefined) return termination;
    termination = (async () => {
      if (!childClosed || groupId !== undefined) signalTarget("SIGTERM");
      // Older process fakes may not expose a pid or close event. Preserve the
      // historical immediate timeout/error result for that unidentifiable
      // compatibility path; real children with validated PIDs take the full
      // TERM -> KILL settlement path below.
      if (reason === "timeout" && pid === undefined) return false;
      if (await waitForSettlement(PROCESS_GROUP_TERM_GRACE_MS)) return true;
      signalTarget("SIGKILL");
      return waitForSettlement(PROCESS_GROUP_KILL_GRACE_MS);
    })();
    return termination;
  };

  return {
    pid,
    processGroupId: groupId,
    groupValidated: groupId !== undefined,
    waitForSettlement: () => waitForSettlement(),
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

export type ProviderProcessWitnessSnapshot = Readonly<{
  available: boolean;
  providers: readonly ProviderProcessWitness[];
}>;

const DEFAULT_WITNESS_FILE = "daemon-runtime.json";
type WitnessUpdate = () => void;
type WitnessPathLock = {
  active: boolean;
  pending: WitnessUpdate[];
};
const witnessPathLocks = new Map<string, WitnessPathLock>();
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

const WITNESS_VERSION = 1;
const WITNESS_MAX_BYTES = 64 * 1024;
const WITNESS_TOP_LEVEL_KEYS = ["daemonInstanceId", "providers", "version"] as const;
const WITNESS_ENTRY_KEYS = ["daemonInstanceId", "pgid", "pid", "processStartTime", "providerId"] as const;

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function parseWitnessDocument(value: unknown): {
  daemonInstanceId: string;
  providers: ProviderProcessWitness[];
} | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!hasExactKeys(value, WITNESS_TOP_LEVEL_KEYS)) return undefined;
  const document = value as {
    daemonInstanceId?: unknown;
    providers?: unknown;
    version?: unknown;
  };
  if (
    document.version !== WITNESS_VERSION
    || typeof document.daemonInstanceId !== "string"
    || document.daemonInstanceId.length === 0
    || !Array.isArray(document.providers)
  ) return undefined;
  const providers: ProviderProcessWitness[] = [];
  const identities = new Set<string>();
  for (const raw of document.providers) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !hasExactKeys(raw, WITNESS_ENTRY_KEYS)) {
      return undefined;
    }
    const entry = raw as Partial<ProviderProcessWitness>;
    const pid = positivePid(entry.pid);
    const pgid = entry.pgid === null ? null : positivePid(entry.pgid);
    if (
      typeof entry.daemonInstanceId !== "string"
      || entry.daemonInstanceId.length === 0
      || typeof entry.providerId !== "string"
      || entry.providerId.length === 0
      || pid === undefined
      || pgid === undefined
      || (entry.processStartTime !== null && typeof entry.processStartTime !== "string")
      || (typeof entry.processStartTime === "string" && entry.processStartTime.length === 0)
    ) return undefined;
    const normalized: ProviderProcessWitness = {
      daemonInstanceId: entry.daemonInstanceId,
      providerId: entry.providerId,
      pid,
      pgid,
      processStartTime: entry.processStartTime,
    };
    const identity = JSON.stringify(normalized);
    if (identities.has(identity)) return undefined;
    identities.add(identity);
    providers.push(normalized);
  }
  return { daemonInstanceId: document.daemonInstanceId, providers };
}

/** Read the secret-free provider witness without mutating its backing file. */
export function readProviderProcessWitnesses(options: {
  path?: string;
  daemonInstanceId?: string;
} = {}): ProviderProcessWitnessSnapshot {
  const path = options.path ?? join(lcmHomeDir(), DEFAULT_WITNESS_FILE);
  try {
    const snapshot = readBoundedRegularFileWithStat(path, {
      allowedRoot: dirname(path),
      maxBytes: WITNESS_MAX_BYTES,
      expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
      allowedModes: [0o600],
      requireSingleLink: true,
    });
    const document = parseWitnessDocument(JSON.parse(snapshot.content) as unknown);
    if (document === undefined) return { available: false, providers: [] };
    return {
      available: true,
      providers: options.daemonInstanceId === undefined
        ? document.providers
        : document.providers.filter(entry => entry.daemonInstanceId === options.daemonInstanceId),
    };
  } catch {
    // Missing, replaced, symlinked, wrong-owner, wrong-mode, and malformed
    // evidence are all unavailable for a drain proof.
    return { available: false, providers: [] };
  }
}

function writeWitnesses(path: string, daemonInstanceId: string, providers: readonly ProviderProcessWitness[], operations: WitnessOperations): void {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${DEFAULT_WITNESS_FILE}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  const content = `${JSON.stringify({ version: 1, daemonInstanceId, providers })}\n`;
  let published = false;
  try {
    operations.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    operations.chmodSync(temporaryPath, 0o600);
    operations.renameSync(temporaryPath, path);
    published = true;
  } finally {
    if (!published) {
      try {
        operations.unlinkSync(temporaryPath);
      } catch {
        // Preserve the original publication failure.
      }
    }
  }
}

function withWitnessMutationLock<T>(path: string, operation: () => T): T {
  // The repository lock validates owner PID/start identity, rejects unsafe
  // lock files, and reclaims only stale owners. A live lock is contention,
  // never permission to perform an unlocked read-modify-write.
  return withPrivateMutationLock(`${path}.lock`, "provider witness", operation);
}

function withWitnessPathLock(path: string, operation: WitnessUpdate): void {
  let lock = witnessPathLocks.get(path);
  if (lock === undefined) {
    lock = { active: false, pending: [] };
    witnessPathLocks.set(path, lock);
  }
  if (lock.active) {
    lock.pending.push(operation);
    return;
  }
  lock.active = true;
  let observedError: unknown;
  let hasError = false;
  try {
    operation();
  } catch (error) {
    observedError = error;
    hasError = true;
  }
  while (lock.pending.length > 0) {
    const queued = lock.pending.shift()!;
    try {
      queued();
    } catch (error) {
      if (!hasError) {
        observedError = error;
        hasError = true;
      }
    }
  }
  lock.active = false;
  witnessPathLocks.delete(path);
  if (hasError) throw observedError;
}

/** Maintain a secret-free owner-only witness for provider child identities. */
export function createProviderProcessWitnessStore(options: {
  daemonInstanceId: string;
  path?: string;
  operations?: Partial<WitnessOperations>;
}): ProviderProcessWitnessStore {
  const path = options.path ?? join(lcmHomeDir(), DEFAULT_WITNESS_FILE);
  const operations: WitnessOperations = { ...DEFAULT_WITNESS_OPERATIONS, ...options.operations };
  const update = (entry: ProviderProcessWitness, remove: boolean): void => withWitnessPathLock(path, () =>
    withWitnessMutationLock(path, () => {
      const entries = readWitnesses(path, operations);
      const current = entries.filter(candidate => candidate.daemonInstanceId === options.daemonInstanceId);
      const otherDaemonEntries = entries.filter(candidate => candidate.daemonInstanceId !== options.daemonInstanceId);
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
    }),
  );
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
