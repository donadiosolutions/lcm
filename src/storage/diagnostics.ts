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
import { PostgreSqlStorageOperationError } from "./postgresql/errors.js";
import { areRequiredPostgreSqlExtensionsReady } from "./postgresql/extensions.js";
import { PostgreSqlRuntime } from "./postgresql/runtime.js";
import { verifyPostgreSqlRuntimeSchema } from "./postgresql/runtime-readiness.js";

export const BACKEND_DIAGNOSTIC_DEADLINE_MS = 2000;
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
  return {
    backend, classification, publication: "unverified", tls: "unverified", schema: "unverified",
    extensions: "unverified", search: "unverified", pool: { origin: "diagnostic-probe", status: "unverified" },
    project: { scope: "aggregate", status: "unverified" }, identity: { status: "unverified" }, outbox: { status: "unverified" }, remediation: REMEDIATION[classification],
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
function safeOutbox(value: EventStats): BackendDiagnosticOutbox {
  const counts = [value.captured, value.unprocessed, value.errors, value.deliveryPending, value.deliveryClaimed, value.deliveryRetry, value.deliveryReplicated, value.deliveryAcknowledged, value.deliveryAwaitingRemotePrune, value.deliveryQuarantined];
  if ((value.scanErrors ?? 0) > 0 || (value.scanSkipped ?? 0) > 0 || !counts.every(finiteCount)) return { status: "unavailable" };
  return { status: "ready", captured: value.captured, unprocessed: value.unprocessed, errors: value.errors, deliveryPending: value.deliveryPending, deliveryClaimed: value.deliveryClaimed, deliveryRetry: value.deliveryRetry, deliveryReplicated: value.deliveryReplicated, deliveryAcknowledged: value.deliveryAcknowledged, deliveryAwaitingRemotePrune: value.deliveryAwaitingRemotePrune, deliveryQuarantined: value.deliveryQuarantined };
}
/** One optimistic read observation. It never owns publication authority or repairs state. */
export async function collectBackendDiagnostics(options: CollectBackendDiagnosticOptions = {}): Promise<BackendDiagnosticSnapshot> {
  const scope = options.cwd !== undefined || options.projectId !== undefined ? "selected" : "aggregate";
  const scoped = (snapshot: BackendDiagnosticSnapshot): BackendDiagnosticSnapshot => { snapshot.project.scope = scope; return snapshot; };
  const dependencies: BackendDiagnosticDependencies = { observePublication, createRuntime: settings => new PostgreSqlRuntime(settings), verifySchema: verifyPostgreSqlRuntimeSchema, readMetrics: readPostgreSqlDiagnosticMetrics, readOutbox: collectEventStats, ...options._dependencies };
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
  // Borrowed pool counters are local observations, independent of a new remote
  // probe succeeding or acquiring a connection. Capture them before any await.
  let borrowedPool: BackendDiagnosticPool | undefined;
  if (backend === "postgresql" && options.storageFactory !== undefined) {
    const factory = options.storageFactory as StorageBackendFactory & {
      getDiagnosticPool?: () => ReturnType<BackendDiagnosticRuntime["poolDiagnostics"]> | undefined;
    };
    try { borrowedPool = safePool(factory.getDiagnosticPool?.(), "daemon"); }
    catch { borrowedPool = { origin: "daemon", status: "unverified" }; }
  }
  const timeoutSnapshot = (): BackendDiagnosticSnapshot => {
    const snapshot = scoped(emptySnapshot(backend, "timeout"));
    if (borrowedPool !== undefined) {
      // A timed-out remote probe cannot authenticate publication for the local
      // facts. Recheck the bounded synchronous witness before returning them.
      try {
        if (dependencies.observePublication(options.homeDir).witness !== before.witness) {
          return scoped(backendDiagnosticFailure(new BackendPublicationJournalError("unexpected-state", "Diagnostic publication changed."), backend));
        }
      } catch (error) { return scoped(backendDiagnosticFailure(error, backend)); }
      snapshot.publication = "ready";
      snapshot.pool = borrowedPool;
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
    if (borrowedPool !== undefined) snapshot.pool = borrowedPool;
    if (before.machineId !== null && normalizeUuidV7(before.machineId) === before.machineId) snapshot.identity = { status: "ready", machineId: before.machineId };
    else if (backend === "sqlite" && before.machineId === null) snapshot.identity = { status: "not-applicable" };
    try {
      const selected = options.cwd === undefined ? undefined : resolveDiagnosticProject(before.mapContent ?? null, options.cwd, backend);
      const selectedProjectId = selected?.projectId ?? options.projectId;
      const localProjectId = selected?.localProjectId ?? (backend === "sqlite" ? options.projectId : undefined);
      if (selectedProjectId !== undefined && !(backend === "postgresql"
        ? normalizeUuidV7(selectedProjectId) === selectedProjectId : /^[a-f0-9]{64}$/u.test(selectedProjectId))) throw new Error("Project diagnostic identity is unavailable.");
      if (backend === "postgresql") {
        const config = before.config.storage.postgresql;
        runtime = await dependencies.createRuntime({url:config.url,caFile:config.caFile,poolMax:config.poolMax,connectionTimeoutMs:Math.min(config.connectionTimeoutMs,duration),idleTimeoutMs:config.idleTimeoutMs,statementTimeoutMs:Math.min(config.statementTimeoutMs,duration)});
        if (controller.signal.aborted) { close(); return timeoutSnapshot(); }
        const health = await runtime.health(controller.signal);
        if (controller.signal.aborted) return timeoutSnapshot();
        snapshot.tls = health.tls === true ? "ready" : "unavailable";
        snapshot.extensions = health.extensions === undefined ? "unverified" : areRequiredPostgreSqlExtensionsReady(health.extensions) ? "ready" : "unavailable";
        snapshot.search = health.searchConfiguration === undefined ? "unverified" : health.searchConfiguration.ready ? "ready" : "unavailable";
        snapshot.pool = borrowedPool ?? safePool(runtime.poolDiagnostics(), "diagnostic-probe");
        if (health.status !== "healthy" && health.status !== "degraded") throw health.error;
        const metrics = await dependencies.readMetrics(runtime, controller.signal, selectedProjectId);
        if (controller.signal.aborted) return timeoutSnapshot();
        await dependencies.verifySchema(runtime, {expectedOwner:config.migrationRole,signal:controller.signal});
        if (controller.signal.aborted) return timeoutSnapshot();
        snapshot.schema = "ready";
        snapshot.metrics = metrics;
        if (snapshot.tls === "ready" && snapshot.extensions === "ready" && snapshot.search === "ready" && snapshot.identity.status === "ready" && snapshot.pool.status === "ready") snapshot.classification = health.status === "degraded" || snapshot.pool.failed === true ? "degraded" : "healthy";
      } else {
        snapshot.tls = "not-applicable"; snapshot.extensions = "not-applicable"; snapshot.search = "not-applicable";
        const pool = getPoolStats();
        snapshot.pool = {origin:options.storageFactory === undefined ? "local" : "daemon",status:"ready",total:pool.totalConnections,idle:pool.idleConnections};
        if (options.collectSqlite !== undefined) {
          await options.collectSqlite({homeDir:options.homeDir,signal:controller.signal,projectId:selectedProjectId,staleAfterDays:before.config.restoration.staleAfterDays,staleSurfacingWithoutUseLimit:before.config.restoration.staleSurfacingWithoutUseLimit});
          snapshot.schema = "ready"; snapshot.classification = "healthy";
        }
      }
      if (controller.signal.aborted) return timeoutSnapshot();
      if (snapshot.schema === "ready") snapshot.project = selectedProjectId === undefined
        ? { scope: "aggregate", status: "ready" }
        : { scope: "selected", status: localProjectId === undefined ? "unverified" : "ready", projectId: selectedProjectId, ...(localProjectId === undefined ? {} : { localProjectId }) };
      // A remote UUID cannot be interpreted as a local outbox directory identity.
      if (!(backend === "postgresql" && selectedProjectId !== undefined && localProjectId === undefined)) snapshot.outbox = safeOutbox(await dependencies.readOutbox({homeDir:options.homeDir,signal:controller.signal,projectId:localProjectId,pruneOrphanSidecars:false,timeoutMs:Math.max(1,deadline-performance.now())}));
    } catch (error) {
      snapshot.classification = controller.signal.aborted ? "timeout" : classifyFailure(error);
      delete snapshot.metrics;
      snapshot.project = { scope, status: "unavailable" };
    }
    try {
      const after = dependencies.observePublication(options.homeDir);
      if (after.witness !== before.witness) return scoped(backendDiagnosticFailure(new BackendPublicationJournalError("unexpected-state", "Diagnostic publication changed."), backend));
    } catch (error) { return scoped(backendDiagnosticFailure(error, backend)); }
    if (controller.signal.aborted || performance.now() >= deadline) return timeoutSnapshot();
    if (snapshot.outbox.status !== "ready" && (snapshot.classification === "healthy" || snapshot.classification === "degraded")) snapshot.classification = "unavailable";
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
