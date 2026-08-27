import { randomUUID } from "node:crypto";
import {
  createAbortError,
  throwIfAborted,
} from "./cancellation.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_TOMBSTONE_TTL_MS = 60_000;
const DEFAULT_MAX_TOMBSTONES = 1_024;

export type InvocationCommand = "compact";
export type InvocationLiveState = "active" | "cancelling";
export type InvocationTerminalState = "finished" | "cancelled";
export type InvocationState = InvocationLiveState | InvocationTerminalState;

export type InvocationTarget = Readonly<{
  invocationId: string;
  command: InvocationCommand;
  daemonInstanceId: string;
}>;

export type InvocationInput = InvocationTarget & Partial<Readonly<{
  invocation_id: string;
  daemon_instance_id: string;
  invocationId: string;
  daemonInstanceId: string;
}>>;

export type InvocationSnapshot = Readonly<{
  invocationId: string;
  command: InvocationCommand;
  daemonInstanceId: string;
  state: InvocationState;
  activeCount: number;
  workCount: number;
  commitCount: number;
  leaseExpiresAt: number | null;
}>;

export type InvocationAdmission = Readonly<{
  signal: AbortSignal;
  release: () => void;
}>;

export type InvocationCoordinatorOptions = Readonly<{
  daemonInstanceId?: string;
  instanceId?: string;
  now?: () => number;
  _now?: () => number;
  setTimeout?: typeof setTimeout;
  _setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  _clearTimeout?: typeof clearTimeout;
  leaseMs?: number;
  tombstoneTtlMs?: number;
  maxTombstones?: number;
}>;

export type InvocationCoordinator = Readonly<{
  readonly daemonInstanceId: string;
  readonly instanceId: string;
  readonly signal: AbortSignal;
  start: (input: InvocationInput) => InvocationSnapshot;
  heartbeat: (input: InvocationInput) => InvocationSnapshot;
  admitWork: (input: InvocationInput) => InvocationAdmission;
  acquireCommit: (input: InvocationInput) => InvocationAdmission;
  admitCommit: (input: InvocationInput) => InvocationAdmission;
  cancel: (input: InvocationInput) => Promise<InvocationSnapshot>;
  finish: (input: InvocationInput) => Promise<InvocationSnapshot>;
  snapshot: (invocationId: string) => InvocationSnapshot;
  tombstoneCount: () => number;
  shutdown: () => Promise<void>;
  close: () => Promise<void>;
}>;

type CoordinatorErrorCode =
  | "invalid-input"
  | "wrong-instance"
  | "unknown-invocation"
  | "duplicate"
  | "cancelled"
  | "shutdown";

export class InvocationCoordinatorError extends Error {
  public readonly statusCode: number;
  public readonly code: CoordinatorErrorCode;

  public constructor(code: CoordinatorErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = "InvocationCoordinatorError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

type InvocationRecord = {
  invocationId: string;
  command: InvocationCommand;
  daemonInstanceId: string;
  state: InvocationLiveState;
  controller: AbortController;
  workCount: number;
  commitCount: number;
  leaseExpiresAt: number;
  leaseTimer: ReturnType<typeof setTimeout> | undefined;
  drainState: InvocationTerminalState | undefined;
  zeroWaiters: Array<(snapshot: InvocationSnapshot) => void>;
};

type Tombstone = {
  snapshot: InvocationSnapshot;
  expiresAt: number;
};

function canonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function optionNumber(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected < 0) throw new RangeError(`${name} must be non-negative`);
  return selected;
}

function targetFields(input: InvocationInput): Readonly<{
  invocationId: unknown;
  command: unknown;
  daemonInstanceId: unknown;
}> {
  const value = input as unknown as Record<string, unknown>;
  return {
    invocationId: value.invocationId ?? value.invocation_id,
    command: value.command,
    daemonInstanceId: value.daemonInstanceId ?? value.daemon_instance_id,
  };
}

export function isCanonicalInvocationId(value: unknown): value is string {
  return canonicalUuid(value);
}

function normalizeTarget(
  input: InvocationInput,
  daemonInstanceId: string,
): InvocationTarget {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new InvocationCoordinatorError("invalid-input", "invalid invocation control input", 400);
  }
  const fields = targetFields(input);
  if (!canonicalUuid(fields.invocationId) || !canonicalUuid(fields.daemonInstanceId)) {
    throw new InvocationCoordinatorError("invalid-input", "invocation identifiers must be canonical UUIDs", 400);
  }
  if (fields.command !== "compact") {
    throw new InvocationCoordinatorError("invalid-input", "unsupported invocation command", 400);
  }
  if (fields.daemonInstanceId !== daemonInstanceId) {
    throw new InvocationCoordinatorError("wrong-instance", "invocation belongs to another daemon instance", 409);
  }
  return {
    invocationId: fields.invocationId,
    command: "compact",
    daemonInstanceId: fields.daemonInstanceId,
  };
}

function activeCount(record: InvocationRecord): number {
  return record.workCount + record.commitCount;
}

function snapshotForRecord(record: InvocationRecord): InvocationSnapshot {
  return Object.freeze({
    invocationId: record.invocationId,
    command: record.command,
    daemonInstanceId: record.daemonInstanceId,
    state: record.state,
    activeCount: activeCount(record),
    workCount: record.workCount,
    commitCount: record.commitCount,
    leaseExpiresAt: record.leaseExpiresAt,
  });
}

function snapshotForTombstone(tombstone: Tombstone): InvocationSnapshot {
  return Object.freeze({ ...tombstone.snapshot });
}

export function createInvocationCoordinator(
  options: InvocationCoordinatorOptions = {},
): InvocationCoordinator {
  const configuredInstance = options.daemonInstanceId ?? options.instanceId;
  const daemonInstanceId = configuredInstance ?? randomUUID();
  if (!canonicalUuid(daemonInstanceId)) {
    throw new RangeError("daemon instance ID must be a canonical UUID");
  }
  const now = options.now ?? options._now ?? Date.now;
  const setTimer = options.setTimeout ?? options._setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? options._clearTimeout ?? clearTimeout;
  const leaseMs = optionNumber(options.leaseMs, DEFAULT_LEASE_MS, "lease");
  const tombstoneTtlMs = optionNumber(options.tombstoneTtlMs, DEFAULT_TOMBSTONE_TTL_MS, "tombstone TTL");
  const maxTombstones = optionNumber(options.maxTombstones, DEFAULT_MAX_TOMBSTONES, "tombstone limit");
  if (!Number.isInteger(maxTombstones)) throw new RangeError("tombstone limit must be an integer");

  const records = new Map<string, InvocationRecord>();
  const tombstones = new Map<string, Tombstone>();
  const shutdownController = new AbortController();
  const globalZeroWaiters: Array<() => void> = [];
  let reaperTimer: ReturnType<typeof setTimeout> | undefined;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  const clearLeaseTimer = (record: InvocationRecord): void => {
    if (record.leaseTimer === undefined) return;
    clearTimer(record.leaseTimer);
    record.leaseTimer = undefined;
  };

  const globalZero = (): boolean => [...records.values()].every(record => activeCount(record) === 0);
  const resolveGlobalZero = (): void => {
    if (!globalZero()) return;
    const waiters = globalZeroWaiters.splice(0);
    for (const waiter of waiters) waiter();
  };

  const scheduleReaper = (): void => {
    if (reaperTimer !== undefined || tombstones.size === 0) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const tombstone of tombstones.values()) earliest = Math.min(earliest, tombstone.expiresAt);
    const delay = Math.max(0, earliest - now());
    reaperTimer = setTimer(() => {
      reaperTimer = undefined;
      const current = now();
      for (const [id, tombstone] of tombstones) {
        if (tombstone.expiresAt <= current) tombstones.delete(id);
      }
      scheduleReaper();
    }, delay);
    const maybeUnref = reaperTimer as unknown as { unref?: () => void };
    maybeUnref.unref?.();
  };

  const terminalize = (record: InvocationRecord, state: InvocationTerminalState): InvocationSnapshot => {
    clearLeaseTimer(record);
    record.state = "cancelling";
    const terminal = Object.freeze({
      invocationId: record.invocationId,
      command: record.command,
      daemonInstanceId: record.daemonInstanceId,
      state,
      activeCount: activeCount(record),
      workCount: record.workCount,
      commitCount: record.commitCount,
      leaseExpiresAt: null,
    });
    records.delete(record.invocationId);
    tombstones.set(record.invocationId, { snapshot: terminal, expiresAt: now() + tombstoneTtlMs });
    while (tombstones.size > maxTombstones) {
      const oldest = tombstones.keys().next().value as string;
      tombstones.delete(oldest);
    }
    scheduleReaper();
    const waiters = record.zeroWaiters.splice(0);
    for (const waiter of waiters) waiter(terminal);
    resolveGlobalZero();
    return terminal;
  };

  const maybeDrainRecord = (record: InvocationRecord): InvocationSnapshot => {
    const snapshot = snapshotForRecord(record);
    if (activeCount(record) !== 0) {
      resolveGlobalZero();
      return snapshot;
    }
    if (record.drainState === undefined) {
      const waiters = record.zeroWaiters.splice(0);
      for (const waiter of waiters) waiter(snapshot);
      resolveGlobalZero();
      return snapshot;
    }
    return terminalize(record, record.drainState);
  };

  const transitionToCancel = (
    record: InvocationRecord,
    drainState: InvocationTerminalState | undefined,
  ): InvocationSnapshot => {
    clearLeaseTimer(record);
    record.state = "cancelling";
    record.drainState = drainState;
    if (!record.controller.signal.aborted) record.controller.abort(createAbortError());
    return maybeDrainRecord(record);
  };

  const scheduleLease = (record: InvocationRecord): void => {
    clearLeaseTimer(record);
    const delay = Math.max(0, record.leaseExpiresAt - now());
    record.leaseTimer = setTimer(() => {
      record.leaseTimer = undefined;
      if (records.get(record.invocationId) !== record || record.state !== "active") return;
      if (now() < record.leaseExpiresAt) {
        scheduleLease(record);
        return;
      }
      transitionToCancel(record, "cancelled");
    }, delay);
    const maybeUnref = record.leaseTimer as unknown as { unref?: () => void };
    maybeUnref.unref?.();
  };

  const lookup = (target: InvocationTarget): InvocationRecord | Tombstone => {
    const record = records.get(target.invocationId);
    if (record !== undefined) return record;
    const tombstone = tombstones.get(target.invocationId);
    if (tombstone !== undefined) return tombstone;
    throw new InvocationCoordinatorError("unknown-invocation", "unknown invocation", 404);
  };

  const waitForZero = (record: InvocationRecord): Promise<InvocationSnapshot> => {
    return new Promise(resolve => record.zeroWaiters.push(resolve));
  };

  const releaseCount = (record: InvocationRecord, kind: "work" | "commit"): void => {
    if (kind === "work") record.workCount -= 1;
    else record.commitCount -= 1;
    maybeDrainRecord(record);
  };

  const admit = (input: InvocationInput, kind: "work" | "commit"): InvocationAdmission => {
    const target = normalizeTarget(input, daemonInstanceId);
    throwIfAborted(shutdownController.signal);
    const found = lookup(target);
    if (!("controller" in found)) {
      throw new InvocationCoordinatorError("cancelled", "invocation is already terminal", 409);
    }
    if (found.state !== "active") {
      throw new InvocationCoordinatorError("cancelled", "invocation is cancelling", 409);
    }
    if (kind === "work") found.workCount += 1;
    else found.commitCount += 1;
    let released = false;
    return {
      signal: found.controller.signal,
      release: () => {
        if (released) return;
        released = true;
        releaseCount(found, kind);
      },
    };
  };

  const start = (input: InvocationInput): InvocationSnapshot => {
    const target = normalizeTarget(input, daemonInstanceId);
    if (shuttingDown) throw new InvocationCoordinatorError("shutdown", "daemon shutdown is in progress", 503);
    if (records.has(target.invocationId) || tombstones.has(target.invocationId)) {
      throw new InvocationCoordinatorError("duplicate", "invocation is already active or replayed", 409);
    }
    const record: InvocationRecord = {
      invocationId: target.invocationId,
      command: target.command,
      daemonInstanceId: target.daemonInstanceId,
      state: "active",
      controller: new AbortController(),
      workCount: 0,
      commitCount: 0,
      leaseExpiresAt: now() + leaseMs,
      leaseTimer: undefined,
      drainState: undefined,
      zeroWaiters: [],
    };
    records.set(record.invocationId, record);
    scheduleLease(record);
    return snapshotForRecord(record);
  };

  const heartbeat = (input: InvocationInput): InvocationSnapshot => {
    const target = normalizeTarget(input, daemonInstanceId);
    const found = lookup(target);
    if (!("controller" in found)) {
      throw new InvocationCoordinatorError("cancelled", "invocation is terminal", 409);
    }
    if (found.state !== "active") {
      throw new InvocationCoordinatorError("cancelled", "invocation is cancelling", 409);
    }
    found.leaseExpiresAt = now() + leaseMs;
    scheduleLease(found);
    return snapshotForRecord(found);
  };

  const cancel = async (input: InvocationInput): Promise<InvocationSnapshot> => {
    const target = normalizeTarget(input, daemonInstanceId);
    const found = lookup(target);
    if (!("controller" in found)) return snapshotForTombstone(found);
    if (found.state === "active") transitionToCancel(found, undefined);
    if (activeCount(found) === 0) return snapshotForRecord(found);
    return await waitForZero(found);
  };

  const finish = async (input: InvocationInput): Promise<InvocationSnapshot> => {
    const target = normalizeTarget(input, daemonInstanceId);
    const found = lookup(target);
    if (!("controller" in found)) return snapshotForTombstone(found);
    const transitioned = transitionToCancel(found, "finished");
    if (records.get(found.invocationId) !== found) return transitioned;
    return await waitForZero(found);
  };

  const snapshot = (invocationId: string): InvocationSnapshot => {
    if (!canonicalUuid(invocationId)) {
      throw new InvocationCoordinatorError("invalid-input", "invocation identifier must be a canonical UUID", 400);
    }
    const record = records.get(invocationId);
    if (record !== undefined) return snapshotForRecord(record);
    const tombstone = tombstones.get(invocationId);
    if (tombstone !== undefined) return snapshotForTombstone(tombstone);
    throw new InvocationCoordinatorError("unknown-invocation", "unknown invocation", 404);
  };

  const shutdown = async (): Promise<void> => {
    if (shutdownPromise !== undefined) return await shutdownPromise;
    shuttingDown = true;
    shutdownController.abort(createAbortError());
    for (const record of [...records.values()]) transitionToCancel(record, "cancelled");
    if (globalZero()) {
      if (reaperTimer !== undefined) clearTimer(reaperTimer);
      reaperTimer = undefined;
      shutdownPromise = Promise.resolve();
      return await shutdownPromise;
    }
    shutdownPromise = new Promise<void>(resolve => {
      globalZeroWaiters.push(() => {
        if (reaperTimer !== undefined) clearTimer(reaperTimer);
        reaperTimer = undefined;
        resolve();
      });
    });
    resolveGlobalZero();
    return await shutdownPromise;
  };

  const coordinator: InvocationCoordinator = {
    daemonInstanceId,
    instanceId: daemonInstanceId,
    signal: shutdownController.signal,
    start,
    heartbeat,
    admitWork: input => admit(input, "work"),
    acquireCommit: input => admit(input, "commit"),
    admitCommit: input => admit(input, "commit"),
    cancel,
    finish,
    snapshot,
    tombstoneCount: () => tombstones.size,
    shutdown,
    close: shutdown,
  };
  return coordinator;
}
