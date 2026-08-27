import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { currentUid, lcmHomeDir } from "../runtime-paths.js";
import {
  processStartTime,
  withPrivateMutationLock,
} from "../private-mutation-lock.js";
import { readBoundedRegularFileWithStat } from "../security-files.js";
import { isCanonicalInvocationId } from "../daemon/invocation-coordinator.js";

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
  /**
   * Proves that this child was spawned detached and therefore owns a fresh
   * process group whose PGID is the child's PID.  This is intentionally
   * opt-in: ordinary callers must still provide an independently observed
   * group identity and daemon-group witness before group signaling.
   */
  detachedProcessGroup?: boolean;
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
  const candidate = options.detachedProcessGroup
    ? options.processGroupId === undefined ? pid : positivePid(options.processGroupId)
    : positivePid(options.processGroupId)
      ?? (platform === "linux" ? linuxProcessGroupId(pid) : undefined);
  if (candidate === undefined) return undefined;

  // A detached spawn creates a new session/process group with the child PID
  // as its PGID.  Requiring that exact relationship prevents an arbitrary
  // caller-supplied group from turning this proof into a shared-group kill.
  if (options.detachedProcessGroup && candidate !== pid) return undefined;

  const daemonGroup = positivePid(options.daemonProcessGroupId)
    ?? (platform === "linux" ? linuxProcessGroupId(process.pid) : undefined);
  // Detached spawn is a structural ownership proof even when a non-Linux host
  // cannot expose the daemon's current PGID.  Ordinary callers still require
  // that witness, preserving the shared-group safeguard.
  if (candidate === daemonGroup || (!options.detachedProcessGroup && daemonGroup === undefined)) return undefined;
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
  let groupProbeFailed = false;
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
      groupProbeFailed = false;
    } catch {
      // An unverifiable group remains evidence-bearing; do not claim it gone.
      groupProbeFailed = true;
    }
    return false;
  }

  function groupIdentityStillOwned(): boolean {
    if (groupId === undefined || groupInvalidated || groupDisappearedLatched) return false;
    // A detached leader may have exited while descendants keep the PGID
    // alive.  Its PID birth/PGID probes necessarily fail after close; the
    // explicit detached-spawn proof plus the immediately preceding group-live
    // probe is the ownership evidence for this post-leader phase.
    if (options.detachedProcessGroup && childClosed) return true;
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
    } else if (childClosed && !options.detachedProcessGroup) {
      // Once the child handle has closed, the captured PGID alone is no
      // longer enough to authenticate a negative-group signal. Without a
      // current PGID probe, fail closed rather than risking PID/PGID reuse.
      groupInvalidated = true;
      return false;
    }
    return true;
  }

  const signalTarget = (signal: NodeJS.Signals): void => {
    // Detached groups must be observed alive immediately before every
    // negative-PGID signal.  This prevents a leader-close race from turning a
    // reused/disappeared PGID into a kill target; disappearance is latched by
    // groupDisappeared() and all later signals fall back to the child handle.
    const disappearanceObserved = options.detachedProcessGroup
      ? groupDisappeared()
      : signal === "SIGKILL" || childClosed ? groupDisappeared() : false;
    if (groupId === undefined || disappearanceObserved || groupProbeFailed || !groupIdentityStillOwned()) {
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
  invocationId?: string;
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
  getUid: typeof currentUid;
}>;

export type ProviderProcessWitnessStore = Readonly<{
  path: string;
  initialize?: () => void;
  add: (entry: ProviderProcessWitness) => void;
  remove: (entry: ProviderProcessWitness) => void;
}>;

export type ProviderProcessWitnessSnapshot = Readonly<{
  available: boolean;
  providers: readonly ProviderProcessWitness[];
}>;

export type ProviderProcessWitnessReconcileOptions = Readonly<{
  /** Generation whose provider identities may be reconciled and reclaimed. */
  daemonInstanceId: string;
  path?: string;
  /** Injectable PID liveness probe used by deterministic tests. */
  killProcess?: ProcessKill;
  /** Injectable process-birth identity probe used by deterministic tests. */
  processBirthTime?: ProcessBirthProbe;
  /** @internal deterministic filesystem/ownership seams. */
  operations?: Partial<WitnessOperations>;
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
  getUid: currentUid,
};

const LEGACY_WITNESS_VERSION = 1;
const WITNESS_VERSION = 2;
const WITNESS_MAX_BYTES = 64 * 1024;
const LEGACY_WITNESS_TOP_LEVEL_KEYS = ["daemonInstanceId", "providers", "version"] as const;
const WITNESS_TOP_LEVEL_KEYS = ["daemonInstances", "providers", "version"] as const;
const LEGACY_WITNESS_ENTRY_KEYS = ["daemonInstanceId", "pgid", "pid", "processStartTime", "providerId"] as const;
const WITNESS_ENTRY_KEYS = ["daemonInstanceId", "invocationId", "pgid", "pid", "processStartTime", "providerId"] as const;

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function parseWitnessDocument(value: unknown): {
  version: 1 | 2;
  daemonInstances: string[];
  providers: ProviderProcessWitness[];
} | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  let version: 1 | 2;
  let daemonInstances: string[];
  let rawProviders: unknown;
  if (candidate.version === LEGACY_WITNESS_VERSION) {
    version = LEGACY_WITNESS_VERSION;
    if (!hasExactKeys(value, LEGACY_WITNESS_TOP_LEVEL_KEYS)) return undefined;
    if (typeof candidate.daemonInstanceId !== "string" || candidate.daemonInstanceId.length === 0) return undefined;
    daemonInstances = [candidate.daemonInstanceId];
    rawProviders = candidate.providers;
  } else {
    version = WITNESS_VERSION;
    if (!hasExactKeys(value, WITNESS_TOP_LEVEL_KEYS)) return undefined;
    if (!Array.isArray(candidate.daemonInstances) || candidate.daemonInstances.length === 0) return undefined;
    daemonInstances = [];
    const daemonIdentitySet = new Set<string>();
    for (const rawIdentity of candidate.daemonInstances) {
      if (typeof rawIdentity !== "string" || rawIdentity.length === 0 || daemonIdentitySet.has(rawIdentity)) return undefined;
      daemonIdentitySet.add(rawIdentity);
      daemonInstances.push(rawIdentity);
    }
    rawProviders = candidate.providers;
  }
  if (!Array.isArray(rawProviders)) return undefined;
  const daemonIdentitySet = new Set(daemonInstances);
  const providers: ProviderProcessWitness[] = [];
  const identities = new Set<string>();
  for (const raw of rawProviders) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || (!hasExactKeys(raw, LEGACY_WITNESS_ENTRY_KEYS) && !hasExactKeys(raw, WITNESS_ENTRY_KEYS))) {
      return undefined;
    }
    const entry = raw as Partial<ProviderProcessWitness>;
    const pid = positivePid(entry.pid);
    const pgid = entry.pgid === null ? null : positivePid(entry.pgid);
    if (
      typeof entry.daemonInstanceId !== "string"
      || entry.daemonInstanceId.length === 0
      || !daemonIdentitySet.has(entry.daemonInstanceId)
      || typeof entry.providerId !== "string"
      || entry.providerId.length === 0
      || pid === undefined
      || pgid === undefined
      || (entry.processStartTime !== null && typeof entry.processStartTime !== "string")
      || (typeof entry.processStartTime === "string" && entry.processStartTime.length === 0)
      || (entry.invocationId !== undefined && !isCanonicalInvocationId(entry.invocationId))
    ) return undefined;
    const normalized: ProviderProcessWitness = {
      daemonInstanceId: entry.daemonInstanceId,
      ...(typeof entry.invocationId === "string" ? { invocationId: entry.invocationId } : {}),
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
  return { version, daemonInstances, providers };
}

type WitnessDocument = Readonly<{
  version: 1 | 2;
  daemonInstances: string[];
  providers: ProviderProcessWitness[];
}>;

/**
 * Keep the historical test seam for callers that only need the provider
 * entries. Mutating callers use readWitnessDocument so malformed evidence is
 * never silently reduced to an empty list.
 */
function readWitnesses(path: string, operations: WitnessOperations): ProviderProcessWitness[] {
  try {
    const parsed = JSON.parse(operations.readFileSync(path, "utf8")) as unknown;
    return parseWitnessDocument(parsed)?.providers ?? [];
  } catch {
    return [];
  }
}

function readWitnessDocument(
  path: string,
  operations: Pick<WitnessOperations, "getUid"> = DEFAULT_WITNESS_OPERATIONS,
): WitnessDocument | undefined {
  try {
    const snapshot = readBoundedRegularFileWithStat(path, {
      allowedRoot: dirname(path),
      maxBytes: WITNESS_MAX_BYTES,
      expectedUid: operations.getUid(),
      allowedModes: [0o600],
      requireSingleLink: true,
    });
    const document = parseWitnessDocument(JSON.parse(snapshot.content) as unknown);
    if (document === undefined) throw new Error("provider witness document is malformed");
    return document;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Read the secret-free provider witness without mutating its backing file. */
export function readProviderProcessWitnesses(options: {
  path?: string;
  daemonInstanceId?: string;
  invocationId?: string;
  /** @internal deterministic platform identity seam. */
  _getUid?: () => number | undefined;
} = {}): ProviderProcessWitnessSnapshot {
  if (options.invocationId !== undefined && !isCanonicalInvocationId(options.invocationId)) {
    return { available: false, providers: [] };
  }
  const path = options.path ?? join(lcmHomeDir(), DEFAULT_WITNESS_FILE);
  const getUid = options._getUid ?? currentUid;
  try {
    const snapshot = readBoundedRegularFileWithStat(path, {
      allowedRoot: dirname(path),
      maxBytes: WITNESS_MAX_BYTES,
      expectedUid: getUid(),
      allowedModes: [0o600],
      requireSingleLink: true,
    });
    const document = parseWitnessDocument(JSON.parse(snapshot.content) as unknown);
    if (document === undefined) return { available: false, providers: [] };
    const daemonProviders = options.daemonInstanceId === undefined
      ? document.providers
      : document.daemonInstances.includes(options.daemonInstanceId)
        ? document.providers.filter(entry => entry.daemonInstanceId === options.daemonInstanceId)
        : [];
    return {
      available: true,
      providers: options.invocationId === undefined
        ? daemonProviders
        : daemonProviders.filter(entry => entry.invocationId === options.invocationId),
    };
  } catch {
    // Missing, replaced, symlinked, wrong-owner, wrong-mode, and malformed
    // evidence are all unavailable for a drain proof.
    return { available: false, providers: [] };
  }
}

function writeWitnesses(
  path: string,
  daemonInstances: readonly string[],
  providers: readonly ProviderProcessWitness[],
  operations: WitnessOperations,
): void {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${DEFAULT_WITNESS_FILE}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  const content = `${JSON.stringify({ version: WITNESS_VERSION, daemonInstances, providers })}\n`;
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

function compactDaemonInstances(
  daemonInstances: readonly string[],
  currentDaemonInstanceId: string,
  providers: readonly ProviderProcessWitness[],
): string[] {
  const retained = new Set<string>([currentDaemonInstanceId]);
  for (const entry of providers) retained.add(entry.daemonInstanceId);
  return daemonInstances.filter(id => retained.has(id)).concat(
    [...retained].filter(id => !daemonInstances.includes(id)),
  );
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
  const initialize = (): void => withWitnessPathLock(path, () =>
    withWitnessMutationLock(path, () => {
      const existing = readWitnessDocument(path, operations);
      if (existing === undefined) {
        writeWitnesses(path, [options.daemonInstanceId], [], operations);
        return;
      }
      const daemonInstances = compactDaemonInstances(
        existing.daemonInstances,
        options.daemonInstanceId,
        existing.providers,
      );
      // A legacy document is rewritten to the v2 multi-generation format even
      // when this daemon was already the sole recorded generation.
      const needsMigration = existing.version !== WITNESS_VERSION
        || daemonInstances.length !== existing.daemonInstances.length
        || daemonInstances.some((id, index) => id !== existing.daemonInstances[index]);
      if (needsMigration) writeWitnesses(path, daemonInstances, existing.providers, operations);
    }),
  );
  initialize();
  const update = (entry: ProviderProcessWitness, remove: boolean): void => withWitnessPathLock(path, () =>
    withWitnessMutationLock(path, () => {
      const existing = readWitnessDocument(path, operations);
      if (existing === undefined) {
        if (remove) {
          writeWitnesses(path, [options.daemonInstanceId], [], operations);
          return;
        }
        writeWitnesses(path, [options.daemonInstanceId], [entry], operations);
        return;
      }
      const entries = existing.providers;
      const current = entries.filter(candidate => candidate.daemonInstanceId === options.daemonInstanceId);
      const otherDaemonEntries = entries.filter(candidate => candidate.daemonInstanceId !== options.daemonInstanceId);
      const matches = (candidate: ProviderProcessWitness): boolean => candidate.providerId === entry.providerId
        && candidate.invocationId === entry.invocationId
        && candidate.pid === entry.pid
        && candidate.pgid === entry.pgid
        && candidate.processStartTime === entry.processStartTime;
      const nextCurrent = remove
        ? current.filter(candidate => !matches(candidate))
        : [...current.filter(candidate => !matches(candidate)), entry];
      const next = [...otherDaemonEntries, ...nextCurrent];
      const daemonInstances = compactDaemonInstances(
        existing.daemonInstances,
        options.daemonInstanceId,
        next,
      );
      writeWitnesses(path, daemonInstances, next, operations);
    }),
  );
  return {
    path,
    initialize,
    add: entry => update(entry, false),
    remove: entry => update(entry, true),
  };
}

/**
 * Reconcile provider identities for a daemon generation that has been
 * replaced.  This is intentionally the only mutating read path: ordinary
 * invocation-scoped reads remain observational and never prune evidence.
 * A provider is reclaimed only when its PID is proven absent (ESRCH), or its
 * live PID has a different non-null birth identity.  Any other result is
 * ambiguous and is retained so replacement proof fails closed.
 */
export function reconcileProviderProcessWitnesses(
  options: ProviderProcessWitnessReconcileOptions,
): ProviderProcessWitnessSnapshot {
  if (typeof options.daemonInstanceId !== "string" || options.daemonInstanceId.length === 0) {
    return { available: false, providers: [] };
  }
  const path = options.path ?? join(lcmHomeDir(), DEFAULT_WITNESS_FILE);
  const operations: WitnessOperations = { ...DEFAULT_WITNESS_OPERATIONS, ...options.operations };
  const killProcess = options.killProcess ?? process.kill.bind(process);
  const processBirth = options.processBirthTime ?? processStartTime;
  if (typeof killProcess !== "function" || typeof processBirth !== "function") {
    return { available: false, providers: [] };
  }
  let result: ProviderProcessWitnessSnapshot = { available: false, providers: [] };
  try {
    withWitnessPathLock(path, () => withWitnessMutationLock(path, () => {
      const existing = readWitnessDocument(path, operations);
      if (existing === undefined) return;
      const targetEntries = existing.providers.filter(entry => entry.daemonInstanceId === options.daemonInstanceId);
      const dead = new Set<ProviderProcessWitness>();
      for (const entry of targetEntries) {
        try {
          killProcess(entry.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException | undefined)?.code === "ESRCH") dead.add(entry);
          continue;
        }
        if (entry.processStartTime === null) continue;
        let observedBirth: string | null;
        try {
          observedBirth = normalizeProcessBirthTime(processBirth(entry.pid));
        } catch {
          continue;
        }
        if (observedBirth !== null && observedBirth !== entry.processStartTime) dead.add(entry);
      }
      const providers = dead.size === 0
        ? existing.providers
        : existing.providers.filter(entry => !dead.has(entry));
      // This function is used for an old-generation replacement proof. Keep
      // every non-target generation and any target generation that still owns
      // rows; remove an empty target generation after successful publication.
      const targetRetained = providers.some(entry => entry.daemonInstanceId === options.daemonInstanceId);
      const daemonInstances = existing.daemonInstances.filter(id => id !== options.daemonInstanceId || targetRetained);
      if (daemonInstances.length === 0) daemonInstances.push(options.daemonInstanceId);
      const changed = providers.length !== existing.providers.length
        || daemonInstances.length !== existing.daemonInstances.length;
      if (changed) writeWitnesses(path, daemonInstances, providers, operations);
      result = {
        available: true,
        providers: providers.filter(entry => entry.daemonInstanceId === options.daemonInstanceId),
      };
    }));
  } catch {
    return { available: false, providers: [] };
  }
  return result;
}

/** Internal pure/lifecycle seams used by provider tests. */
export const __processUtilsTestUtils = {
  positivePid,
  linuxProcessGroupId,
  resolveOwnedProcessGroup,
  defaultProcessGroupAlive,
  readWitnesses,
  writeWitnesses,
  compactDaemonInstances,
};
