import { withDiagnosticSqliteSession } from "../db/diagnostic-sqlite.js";
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import {
  parseDaemonConfig, readDaemonConfigRawSnapshot, resolveDaemonConfigEnv,
  type DaemonConfig,
} from "../daemon/config.js";
import { getPoolStats } from "../db/connection.js";
import { collectEventStats, type EventStats } from "../db/events-stats.js";
import { machineIdentityPath, normalizeUuidV7, readMachineIdentity } from "../machine-identity.js";
import { configPath, lcmHomeDir } from "../runtime-paths.js";
import { projectMapPath } from "../project-map.js";
import {
  assertBackendPublicationConfigReadAccess, backendPublicationCanonicalSha256,
  backendPublicationJournalPath, BackendPublicationJournalError,
  captureBackendPublicationFileWitness, withBackendPublicationReadRoot,
} from "./backend-publication.js";
import { resolveDiagnosticProject } from "./diagnostic-project.js";
import type { StorageBackendFactory } from "./contracts.js";
import type { PostgreSqlConnectionSettings, PostgreSqlQueryExecutor, PostgreSqlRuntimeHealth } from "./postgresql/contracts.js";
import { readPostgreSqlDiagnosticMetrics, type PostgreSqlDiagnosticMetrics } from "./postgresql/diagnostics.js";
import { readPostgreSqlMigrationLedger, readPostgreSqlQueueHealth } from "./postgresql/runtime-health.js";
import { PostgreSqlDiagnosticPoolError, PostgreSqlStorageOperationError, type PostgreSqlDiagnosticPoolRejection } from "./postgresql/errors.js";
import { areRequiredPostgreSqlExtensionsReady } from "./postgresql/extensions.js";
import { PostgreSqlRuntime } from "./postgresql/runtime.js";
import { verifyPostgreSqlRuntimeSchema } from "./postgresql/runtime-readiness.js";
import {
  collectPostgreSqlQueryStatistics,
  createQueryStatisticsFamily,
  type QueryStatisticsFamily,
  type QueryStatisticsObservation,
} from "./postgresql/query-statistics.js";
import {
  PROBE_MIN_REMAINING_MS, extensionsTelemetry, failUnfinishedTelemetry, failedServerQueueReads, localPendingAgeRead,
  migrationTelemetry, poolTelemetry, queueTelemetry, serverQueueReads, telemetryDegraded, telemetryFailureStatus,
  telemetryFillers, type BackendDiagnosticTelemetry, type FieldRead, type TelemetryFailureStatus,
  type TelemetryFamilyName,
} from "./runtime-health.js";

export const BACKEND_DIAGNOSTIC_DEADLINE_MS = 2000;
export const STATEMENT_FAMILY_BUDGET_MS = 750;
const STATEMENT_FAMILY_RESERVE_MS = 100;
export type BackendDiagnosticClassification = "healthy" | "degraded" | "unavailable" | "permission-denied" | "timeout" | "stale-publication";
export type BackendDiagnosticReadiness = "ready" | "unavailable" | "unverified" | "not-applicable";
export interface BackendDiagnosticPool {
  origin: "daemon" | "diagnostic-probe" | "local";
  status: BackendDiagnosticReadiness;
  configuredMax?: number;
  total?: number;
  idle?: number;
  waiting?: number;
  failed?: boolean;
}
export interface BackendDiagnosticOutbox {
  status: BackendDiagnosticReadiness;
  captured?: number;
  unprocessed?: number;
  errors?: number;
  deliveryPending?: number;
  deliveryClaimed?: number;
  deliveryRetry?: number;
  deliveryReplicated?: number;
  deliveryAcknowledged?: number;
  deliveryAwaitingRemotePrune?: number;
  deliveryQuarantined?: number;
}
export interface BackendDiagnosticSnapshot {
  backend: "sqlite" | "postgresql" | "unavailable";
  classification: BackendDiagnosticClassification;
  publication: BackendDiagnosticReadiness;
  tls: BackendDiagnosticReadiness;
  schema: BackendDiagnosticReadiness;
  extensions: BackendDiagnosticReadiness;
  search: BackendDiagnosticReadiness;
  pool: BackendDiagnosticPool;
  project: { scope: "aggregate" | "selected"; status: BackendDiagnosticReadiness; projectId?: string; localProjectId?: string };
  identity: { status: BackendDiagnosticReadiness; machineId?: string };
  outbox: BackendDiagnosticOutbox;
  metrics?: PostgreSqlDiagnosticMetrics;
  /** Fixed telemetry families; see the PostgreSQL telemetry guide. */
  telemetry: BackendDiagnosticTelemetry & { statements: QueryStatisticsFamily };
  remediation: string;
}
export interface BackendDiagnosticRuntime extends PostgreSqlQueryExecutor {
  health(signal?: AbortSignal): Promise<PostgreSqlRuntimeHealth>;
  poolDiagnostics(): { configuredMax: number; total: number; idle: number; waiting: number; failed: boolean };
  close(): Promise<void>;
}
/** Trusted in-process observation; the witness and config are never serialized. */
export interface BackendDiagnosticObservation {
  config: DaemonConfig;
  witness: string;
  machineId: string | null;
  mapContent?: string | null;
}
export interface BackendDiagnosticDependencies {
  observePublication(homeDir?: string): BackendDiagnosticObservation;
  createRuntime(settings: PostgreSqlConnectionSettings): BackendDiagnosticRuntime | Promise<BackendDiagnosticRuntime>;
  verifySchema: typeof verifyPostgreSqlRuntimeSchema;
  readMetrics: typeof readPostgreSqlDiagnosticMetrics;
  readOutbox: typeof collectEventStats;
  readStatements: typeof collectPostgreSqlQueryStatistics;
  readMigrationHistory: typeof readPostgreSqlMigrationLedger;
  readQueue: typeof readPostgreSqlQueueHealth;
}
export interface CollectBackendDiagnosticOptions {
  homeDir?: string;
  signal?: AbortSignal;
  projectId?: string;
  cwd?: string;
  storageFactory?: StorageBackendFactory;
  /** Trusted adapter callback; no SQLite writer may be opened by this callback. */
  collectSqlite?: (options: {
    homeDir?: string; signal: AbortSignal; projectId?: string;
    staleAfterDays: number; staleSurfacingWithoutUseLimit: number;
  }) => Promise<void>;
  _dependencies?: Partial<BackendDiagnosticDependencies>;
  /** Fixtures may shorten, never extend, the owned deadline. */
  _deadlineMs?: number;
}
const REMEDIATION: Record<BackendDiagnosticClassification, string> = {
  healthy: "No action required.",
  degraded: "Run `lcm doctor` to recheck backend readiness.",
  unavailable: "Run `lcm doctor` and review the storage configuration.",
  "permission-denied": "Review local file permissions and PostgreSQL runtime grants, then run `lcm doctor`.",
  timeout: "Check backend connectivity, then run `lcm doctor` again.",
  "stale-publication": "Complete backend publication recovery, then run `lcm doctor`.",
};
function classifyFailure(error: unknown): BackendDiagnosticClassification {
  if (error instanceof BackendPublicationJournalError) {
    switch (error.reason) {
      case "unresolved-publication": case "publication-evidence-missing":
      case "backend-mismatch": case "checksum-mismatch": case "unexpected-state":
        return "stale-publication";
      case "invalid-input": case "unsafe-storage": case "malformed-journal": case "permit-mismatch":
        return "unavailable";
    }
  }
  if (error instanceof PostgreSqlStorageOperationError) {
    if (error.sqlState === "57014") return "timeout";
    if (["42501", "28000", "28P01"].includes(error.sqlState ?? "")) return "permission-denied";
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return "permission-denied";
    if (code === "DIAGNOSTIC_SQLITE_TIMEOUT" || code === "DIAGNOSTIC_SQLITE_ABORTED") return "timeout";
  }
  return "unavailable";
}
function emptySnapshot(backend: BackendDiagnosticSnapshot["backend"], classification: BackendDiagnosticClassification): BackendDiagnosticSnapshot {
  const statementStatus = backend === "sqlite" ? "not-applicable"
    : backend === "postgresql" && classification === "timeout" ? "timeout" : "unavailable";
  return {
    backend, classification, publication: "unverified", tls: "unverified", schema: "unverified",
    extensions: "unverified", search: "unverified", pool: { origin: "diagnostic-probe", status: "unverified" },
    project: { scope: "aggregate", status: "unverified" }, identity: { status: "unverified" }, outbox: { status: "unverified" },
    telemetry: {
      ...telemetryFillers(backend, telemetryFailureStatus(classification), Date.now()),
      statements: createQueryStatisticsFamily(statementStatus),
    },
    remediation: REMEDIATION[classification],
  };
}
/** Failure DTO for an outer publication boundary. Never serializes an error. */
export function backendDiagnosticFailure(error: unknown, backend: BackendDiagnosticSnapshot["backend"] = "unavailable"): BackendDiagnosticSnapshot {
  const snapshot = emptySnapshot(backend, classifyFailure(error));
  if (error instanceof BackendPublicationJournalError) snapshot.publication = "unavailable";
  return snapshot;
}
function observePublication(homeDir?: string): BackendDiagnosticObservation {
  return withBackendPublicationReadRoot(homeDir, assertReadRoot => {
    const guarded = <T>(read: () => T): T => { assertReadRoot(); const value = read(); assertReadRoot(); return value; };
    const path = configPath(homeDir);
    const first = guarded(() => readDaemonConfigRawSnapshot(path));
    const config = parseDaemonConfig(first.content, undefined, resolveDaemonConfigEnv(process.env));
    const admission = guarded(() => assertBackendPublicationConfigReadAccess(path, config.storage.backend, first.witness));
    const mapPath = projectMapPath(homeDir);
    const map = guarded(() => captureBackendPublicationFileWitness(mapPath, dirname(mapPath)));
    const root = guarded(() => {
      const stat = lstatSync(lcmHomeDir(homeDir), {bigint:true,throwIfNoEntry:false});
      if (stat === undefined) return null;
      return [String(stat.dev), String(stat.ino), String(stat.mode), String(stat.uid), String(stat.gid)];
    });
    const journalPath = backendPublicationJournalPath(homeDir);
    const journal = guarded(() => captureBackendPublicationFileWitness(journalPath, dirname(journalPath)).witness);
    const identityPath = machineIdentityPath(homeDir);
    const identityBefore = guarded(() => captureBackendPublicationFileWitness(identityPath, dirname(identityPath)).witness);
    const identity = guarded(() => readMachineIdentity(homeDir));
    const identityAfter = guarded(() => captureBackendPublicationFileWitness(identityPath, dirname(identityPath)).witness);
    const second = guarded(() => readDaemonConfigRawSnapshot(path));
    const secondAdmission = guarded(() => assertBackendPublicationConfigReadAccess(path, config.storage.backend, second.witness));
    if (backendPublicationCanonicalSha256([first.witness, admission, identityBefore]) !== backendPublicationCanonicalSha256([second.witness, secondAdmission, identityAfter])) {
      throw new BackendPublicationJournalError("unexpected-state", "Diagnostic observation changed.");
    }
    return { config, witness: backendPublicationCanonicalSha256([first.witness, admission, map.witness, journal, identityBefore, root]), machineId: identity?.machineId ?? null, mapContent: map.content };
  });
}
function finiteCount(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function safePool(value: ReturnType<BackendDiagnosticRuntime["poolDiagnostics"]> | undefined, origin: BackendDiagnosticPool["origin"]): BackendDiagnosticPool {
  if (value === undefined || ![value.configuredMax, value.total, value.idle, value.waiting].every(finiteCount) || typeof value.failed !== "boolean") return { origin, status: "unverified" };
  return { origin, status: "ready", configuredMax: value.configuredMax, total: value.total, idle: value.idle, waiting: value.waiting, failed: value.failed };
}
function safeSqlitePool(value: ReturnType<typeof getPoolStats>, origin: BackendDiagnosticPool["origin"]): BackendDiagnosticPool {
  if (![value.totalConnections, value.idleConnections].every(finiteCount)) return { origin, status: "unverified" };
  return { origin, status: "ready", total: value.totalConnections, idle: value.idleConnections };
}
/** The closed reason of a refused pool observation; any other failure carries no reason. */
function poolRejectionOf(error: unknown): PostgreSqlDiagnosticPoolRejection | undefined {
  return error instanceof PostgreSqlDiagnosticPoolError ? error.reason : undefined;
}
function safeOutbox(value: EventStats): BackendDiagnosticOutbox {
  const counts = [value.captured, value.unprocessed, value.errors, value.deliveryPending, value.deliveryClaimed, value.deliveryRetry, value.deliveryReplicated, value.deliveryAcknowledged, value.deliveryAwaitingRemotePrune, value.deliveryQuarantined];
  if ((value.scanErrors ?? 0) > 0 || (value.scanSkipped ?? 0) > 0 || !counts.every(finiteCount)) return { status: "unavailable" };
  return { status: "ready", captured: value.captured, unprocessed: value.unprocessed, errors: value.errors, deliveryPending: value.deliveryPending, deliveryClaimed: value.deliveryClaimed, deliveryRetry: value.deliveryRetry, deliveryReplicated: value.deliveryReplicated, deliveryAcknowledged: value.deliveryAcknowledged, deliveryAwaitingRemotePrune: value.deliveryAwaitingRemotePrune, deliveryQuarantined: value.deliveryQuarantined };
}
/** One optimistic read observation. It never owns publication authority or repairs state. */
export async function collectBackendDiagnostics(options: CollectBackendDiagnosticOptions = {}): Promise<BackendDiagnosticSnapshot> {
  const scope = options.cwd !== undefined || options.projectId !== undefined ? "selected" : "aggregate";
  const scoped = (snapshot: BackendDiagnosticSnapshot): BackendDiagnosticSnapshot => { snapshot.project.scope = scope; return snapshot; };
  const dependencies: BackendDiagnosticDependencies = {
    observePublication,
    createRuntime: settings => new PostgreSqlRuntime(settings),
    verifySchema: verifyPostgreSqlRuntimeSchema,
    readMetrics: readPostgreSqlDiagnosticMetrics,
    readOutbox: collectEventStats,
    readStatements: collectPostgreSqlQueryStatistics,
    readMigrationHistory: readPostgreSqlMigrationLedger,
    readQueue: readPostgreSqlQueueHealth,
    ...options._dependencies,
  };
  const duration = Number.isFinite(options._deadlineMs) && options._deadlineMs! > 0 ? Math.min(options._deadlineMs!, BACKEND_DIAGNOSTIC_DEADLINE_MS) : BACKEND_DIAGNOSTIC_DEADLINE_MS;
  const deadline = performance.now() + duration;
  const controller = new AbortController();
  let runtime: BackendDiagnosticRuntime | undefined;
  let closed = false;
  const close = (): void => {
    if (runtime === undefined || closed) return;
    closed = true;
    try { void runtime.close().catch(() => undefined); } catch { /* Keep the primary classified outcome. */ }
  };
  let before: BackendDiagnosticObservation;
  try { before = dependencies.observePublication(options.homeDir); } catch (error) { return scoped(backendDiagnosticFailure(error)); }
  const backend = before.config.storage.backend;
  if (options.storageFactory !== undefined && options.storageFactory.backend !== backend) {
    return scoped(backendDiagnosticFailure(new BackendPublicationJournalError("backend-mismatch", "Diagnostic backend changed."), options.storageFactory.backend));
  }
  // Pool counters are local observations, independent of project, outbox, or
  // remote probe work succeeding. Capture them before any await.
  let poolObservation: BackendDiagnosticPool | undefined;
  // Capture time of the pool counters, reused by the timeout DTO.
  let poolObservedAt = Date.now();
  // Why the boundary refused the counters, kept only so telemetry can tell an out-of-range value from an unverified pool.
  let poolRejection: PostgreSqlDiagnosticPoolRejection | undefined;
  if (backend === "postgresql" && options.storageFactory !== undefined) {
    const factory = options.storageFactory as StorageBackendFactory & {
      getDiagnosticPool?: () => ReturnType<BackendDiagnosticRuntime["poolDiagnostics"]> | undefined;
    };
    try { poolObservation = safePool(factory.getDiagnosticPool?.(), "daemon"); }
    catch (error) { poolObservation = { origin: "daemon", status: "unverified" }; poolRejection = poolRejectionOf(error); }
  } else if (backend === "sqlite") {
    const origin = options.storageFactory === undefined ? "local" : "daemon";
    try { poolObservation = safeSqlitePool(getPoolStats(), origin); }
    catch { poolObservation = { origin, status: "unverified" }; }
  }
  const timeoutSnapshot = (): BackendDiagnosticSnapshot => {
    const snapshot = scoped(emptySnapshot(backend, "timeout"));
    if (poolObservation !== undefined) {
      // Timed-out work cannot authenticate publication for these local facts.
      // Recheck the bounded synchronous witness before returning them.
      try {
        if (dependencies.observePublication(options.homeDir).witness !== before.witness) {
          return scoped(backendDiagnosticFailure(new BackendPublicationJournalError("unexpected-state", "Diagnostic publication changed."), backend));
        }
      } catch (error) { return scoped(backendDiagnosticFailure(error, backend)); }
      snapshot.publication = "ready";
      snapshot.pool = poolObservation;
      if (backend === "postgresql") snapshot.telemetry.pool = poolTelemetry(poolObservation, poolObservedAt, poolRejection);
    }
    return snapshot;
  };
  if (options.signal?.aborted || performance.now() >= deadline) return timeoutSnapshot();
  const abort = (): void => { controller.abort(); close(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout>;
  let onTimeout: () => void;
  const aborted = new Promise<BackendDiagnosticSnapshot>(resolve => {
    onTimeout = () => resolve(timeoutSnapshot());
    controller.signal.addEventListener("abort", onTimeout, {once:true});
    timer = setTimeout(abort, Math.max(0, deadline - performance.now()));
  });
  const work = withDiagnosticSqliteSession(controller.signal, async (): Promise<BackendDiagnosticSnapshot> => {
    const snapshot = scoped(emptySnapshot(backend, "unavailable"));
    snapshot.publication = "ready";
    if (poolObservation !== undefined) snapshot.pool = poolObservation;
    // Families whose observation finished; the catch rewrites only the others.
    const finished = new Set<TelemetryFamilyName>();
    let serverQueue: ReturnType<typeof serverQueueReads> | undefined;
    const probeBudget = (): boolean => deadline - performance.now() >= PROBE_MIN_REMAINING_MS;
    const failureOf = (error: unknown): TelemetryFailureStatus => telemetryFailureStatus(controller.signal.aborted ? "timeout" : classifyFailure(error));
    const failedFamilies = (status: TelemetryFailureStatus) => telemetryFillers("postgresql", status, Date.now());
    if (before.machineId !== null && normalizeUuidV7(before.machineId) === before.machineId) snapshot.identity = { status: "ready", machineId: before.machineId };
    else if (backend === "sqlite" && before.machineId === null) snapshot.identity = { status: "not-applicable" };
    let statementObservation: QueryStatisticsObservation | undefined;
    try {
      const selected = options.cwd === undefined ? undefined : resolveDiagnosticProject(before.mapContent ?? null, options.cwd, backend);
      const selectedProjectId = selected?.projectId ?? options.projectId;
      const localProjectId = selected?.localProjectId ?? (backend === "sqlite" ? options.projectId : undefined);
      if (selectedProjectId !== undefined && !(backend === "postgresql"
        ? normalizeUuidV7(selectedProjectId) === selectedProjectId : /^[a-f0-9]{64}$/u.test(selectedProjectId))) throw new Error("Project diagnostic identity is unavailable.");
      if (backend === "postgresql") {
        const config = before.config.storage.postgresql;
        runtime = await dependencies.createRuntime({url:config.url,caFile:config.caFile,poolMax:config.poolMax,connectionTimeoutMs:Math.min(config.connectionTimeoutMs,duration),idleTimeoutMs:config.idleTimeoutMs,statementTimeoutMs:Math.min(config.statementTimeoutMs,duration),snapshotIdleTimeoutMs:config.snapshotIdleTimeoutMs});
        if (controller.signal.aborted) { close(); return timeoutSnapshot(); }
        const health = await runtime.health(controller.signal);
        if (controller.signal.aborted) return timeoutSnapshot();
        // Derived before the health-status throw: an unavailable result can still carry extensions.
        // The family is finalized only when health() returned extension records; otherwise the catch mirrors the classified failure.
        snapshot.telemetry.extensions = extensionsTelemetry(health.extensions, Date.now());
        if (health.extensions !== undefined) finished.add("extensions");
        snapshot.tls = health.tls === true ? "ready" : "unavailable";
        snapshot.extensions = health.extensions === undefined ? "unverified" : areRequiredPostgreSqlExtensionsReady(health.extensions) ? "ready" : "unavailable";
        snapshot.search = health.searchConfiguration === undefined ? "unverified" : health.searchConfiguration.ready ? "ready" : "unavailable";
        if (poolObservation === undefined) {
          try { snapshot.pool = safePool(runtime.poolDiagnostics(), "diagnostic-probe"); }
          catch (error) {
            // Only an out-of-range counter is a pool-local fact; any other failure still fails the probe.
            poolRejection = poolRejectionOf(error);
            if (poolRejection !== "out-of-range") throw error;
            snapshot.pool = { origin: "diagnostic-probe", status: "unverified" };
          }
          poolObservedAt = Date.now();
        }
        snapshot.telemetry.pool = poolTelemetry(snapshot.pool, poolObservedAt, poolRejection);
        finished.add("pool");
        if (health.status !== "healthy" && health.status !== "degraded") throw health.error;
        if (!probeBudget()) snapshot.telemetry.migration = failedFamilies("timeout").migration;
        else {
          try { snapshot.telemetry.migration = migrationTelemetry(await dependencies.readMigrationHistory(runtime, controller.signal), Date.now()); }
          catch (error) { snapshot.telemetry.migration = failedFamilies(failureOf(error)).migration; }
        }
        finished.add("migration");
        const metrics = await dependencies.readMetrics(runtime, controller.signal, selectedProjectId);
        if (controller.signal.aborted) return timeoutSnapshot();
        await dependencies.verifySchema(runtime, {expectedOwner:config.migrationRole,signal:controller.signal});
        if (controller.signal.aborted) return timeoutSnapshot();
        snapshot.schema = "ready";
        snapshot.metrics = metrics;
        if (!probeBudget()) serverQueue = failedServerQueueReads("timeout");
        else {
          try { serverQueue = serverQueueReads(await dependencies.readQueue(runtime, controller.signal, selectedProjectId)); }
          catch (error) { serverQueue = failedServerQueueReads(failureOf(error)); }
        }
        if (snapshot.tls === "ready" && snapshot.extensions === "ready" && snapshot.search === "ready" && snapshot.identity.status === "ready" && snapshot.pool.status === "ready") snapshot.classification = health.status === "degraded" || snapshot.pool.failed === true ? "degraded" : "healthy";
      } else {
        snapshot.tls = "not-applicable"; snapshot.extensions = "not-applicable"; snapshot.search = "not-applicable";
        if (options.collectSqlite !== undefined) {
          await options.collectSqlite({homeDir:options.homeDir,signal:controller.signal,projectId:selectedProjectId,staleAfterDays:before.config.restoration.staleAfterDays,staleSurfacingWithoutUseLimit:before.config.restoration.staleSurfacingWithoutUseLimit});
          snapshot.schema = "ready";
          snapshot.classification = snapshot.pool.status === "ready" ? "healthy" : "unavailable";
        }
      }
      if (controller.signal.aborted) return timeoutSnapshot();
      if (snapshot.schema === "ready") snapshot.project = selectedProjectId === undefined
        ? { scope: "aggregate", status: "ready" }
        : { scope: "selected", status: localProjectId === undefined ? "unverified" : "ready", projectId: selectedProjectId, ...(localProjectId === undefined ? {} : { localProjectId }) };
      // A remote UUID cannot be interpreted as a local outbox directory identity.
      // Local pending age is unknown unless this scan reads it from a verified outbox.
      let localAge: FieldRead = { reason: "unavailable" };
      if (!(backend === "postgresql" && selectedProjectId !== undefined && localProjectId === undefined)) {
        const stats = await dependencies.readOutbox({homeDir:options.homeDir,signal:controller.signal,projectId:localProjectId,pruneOrphanSidecars:false,timeoutMs:Math.max(1,deadline-performance.now())});
        snapshot.outbox = safeOutbox(stats);
        if (snapshot.outbox.status === "ready") localAge = localPendingAgeRead(stats.oldestPendingAt, Date.now());
      }
      if (serverQueue !== undefined) {
        const localQuarantined = snapshot.outbox.status === "ready" ? snapshot.outbox.deliveryQuarantined : undefined;
        snapshot.telemetry.queue = queueTelemetry({ ...serverQueue, outboxOldestPendingAgeSeconds: localAge }, localQuarantined, Date.now());
      }
      // Statement statistics run last, after every runtime-health and outbox read,
      // while retaining the shared snapshot deadline and publication reserve.
      if (backend === "postgresql" && runtime !== undefined && snapshot.schema === "ready") {
        const remaining = deadline - performance.now() - STATEMENT_FAMILY_RESERVE_MS;
        if (remaining <= 0) {
          snapshot.telemetry.statements = createQueryStatisticsFamily("timeout");
        } else {
          const child = new AbortController();
          let familyDeadlineExpired = false;
          const abortChild = (): void => { child.abort(); };
          controller.signal.addEventListener("abort", abortChild, { once: true });
          const familyTimer = setTimeout(() => {
            familyDeadlineExpired = true;
            child.abort();
          }, Math.min(STATEMENT_FAMILY_BUDGET_MS, remaining));
          let resolveAbort!: () => void;
          const childAborted = new Promise<void>((resolve) => { resolveAbort = resolve; });
          child.signal.addEventListener("abort", resolveAbort, { once: true });
          try {
            const familyWork = dependencies.readStatements(runtime, {
              publicationWitness: before.witness,
              signal: child.signal,
            });
            const outcome = await Promise.race([
              familyWork.then((value) => ({ kind: "value" as const, value })),
              childAborted.then(() => ({ kind: "aborted" as const })),
            ]);
            if (outcome.kind === "value" && !child.signal.aborted) {
              statementObservation = outcome.value;
              snapshot.telemetry.statements = outcome.value.family;
            } else {
              snapshot.telemetry.statements = createQueryStatisticsFamily("timeout");
            }
          } catch {
            snapshot.telemetry.statements = createQueryStatisticsFamily(
              child.signal.aborted || controller.signal.aborted || familyDeadlineExpired
                ? "timeout" : "unavailable",
            );
          } finally {
            clearTimeout(familyTimer);
            controller.signal.removeEventListener("abort", abortChild);
            child.signal.removeEventListener("abort", resolveAbort);
          }
        }
      }
    } catch (error) {
      snapshot.classification = controller.signal.aborted ? "timeout" : classifyFailure(error);
      if (backend === "postgresql") {
        const status = failureOf(error);
        // A failed local scan keeps the server observations that already completed.
        if (serverQueue !== undefined) {
          snapshot.telemetry.queue = queueTelemetry({ ...serverQueue, outboxOldestPendingAgeSeconds: { reason: status } }, undefined, Date.now());
          finished.add("queue");
        }
        const statements = snapshot.classification === "timeout"
          && statementObservation === undefined
          ? createQueryStatisticsFamily("timeout")
          : snapshot.telemetry.statements;
        snapshot.telemetry = {
          ...failUnfinishedTelemetry(snapshot.telemetry, finished, status, Date.now()),
          statements,
        };
      }
      delete snapshot.metrics;
      snapshot.project = { scope, status: "unavailable" };
    }
    try {
      const after = dependencies.observePublication(options.homeDir);
      if (after.witness !== before.witness) return scoped(backendDiagnosticFailure(new BackendPublicationJournalError("unexpected-state", "Diagnostic publication changed."), backend));
    } catch (error) { return scoped(backendDiagnosticFailure(error, backend)); }
    if (controller.signal.aborted || performance.now() >= deadline) return timeoutSnapshot();
    if (snapshot.outbox.status !== "ready" && (snapshot.classification === "healthy" || snapshot.classification === "degraded")) snapshot.classification = "unavailable";
    if (snapshot.classification === "healthy" && telemetryDegraded(snapshot.telemetry)) snapshot.classification = "degraded";
    statementObservation?.commit();
    snapshot.remediation = REMEDIATION[snapshot.classification];
    return snapshot;
  });
  try { return await Promise.race([work, aborted]); }
  finally {
    clearTimeout(timer!);
    options.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onTimeout!);
    controller.abort(); close();
  }
}
