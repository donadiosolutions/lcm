import type { EventRow, PatternReinforcementStats } from "../../hooks/events-db.js";
import { eventsDbPath, existingEventsDbPath } from "../../db/events-path.js";
import { deduplicateAndInsert } from "../../promotion/dedup.js";
import { sendJson, type RouteExecutionContext, type RouteHandler } from "../server.js";
import { isMissingCwdError, validateCwd } from "../validate-cwd.js";
import { projectIdentity, projectPathsForIdentity } from "../project.js";
import type { DaemonConfig } from "../config.js";
import { safeLogError } from "../../hooks/hook-errors.js";
import { collectEventSidecars } from "../../db/event-sidecars.js";
import { ScrubEngine } from "../../scrub.js";
import {
  SQLiteLocalHookOutboxFactory,
  type LocalHookOutboxRepository,
} from "../../storage/local-hook-outbox.js";
import {
  createStorageBackendFactory,
  type ProjectStorage,
  type StorageIdentityContext,
  type StorageBackendFactory,
} from "../../storage/index.js";
import {
  BackendPublicationJournalError,
  type BackendPublicationLockToken,
} from "../../storage/backend-publication.js";
import {
  closeRouteStorage,
  storageRouteFailureResponse,
  withProjectStorage,
} from "./storage-lifecycle.js";
import { StorageOperationError } from "../../storage/errors.js";

const AUTO_TAGS: Record<string, string> = {
  decision: "type:preference",
  error: "type:gotcha",      // overridden to "type:solution" for error→fix pairs
  plan: "type:decision",
  role: "type:user-context",
  git: "type:workflow",
  env: "type:environment",
  file: "type:pattern",
};

const CORRELATION_WINDOW = 20;
const MAX_GLOBAL_PROMOTION_BATCHES = 10_000;
const MISSING_CWD_CONFIRMATION_OBSERVATIONS = 3;
const MISSING_CWD_CONFIRMATION_INTERVAL_MS = 5 * 60 * 1000;
const MIN_REINFORCED_PATTERN_OCCURRENCES = 3;
const MIN_REINFORCED_PATTERN_SESSIONS = 2;
const AUTO_PROMOTABLE_PATTERN_CATEGORIES = new Set(["file", "mcp", "skill", "subagent"]);
const EMPTY_REINFORCEMENT: PatternReinforcementStats = { totalCount: 0, distinctSessions: 0 };
const sidecarPromotionLocks = new Map<string, Promise<void>>();

type PromotionExecutionContext = Pick<
  RouteExecutionContext,
  "publicationLockToken" | "withPublicationAdmission" | "signal"
>;

export type PromoteTerminalOutcome = {
  kind: "parked";
  reason: "unavailable-cwd";
};

export type PromoteDeferredOutcome = {
  kind: "awaiting-confirmation";
  reason: "unavailable-cwd";
  observations: number;
  retryAfterMs: number;
};

export interface PromoteResult {
  promoted: number;
  skipped: number;
  correlated: number;
  errors: number;
  deferred?: PromoteDeferredOutcome;
  terminal?: PromoteTerminalOutcome;
  message?: string;
}

export interface PromoteAllProjectResult extends PromoteResult {
  projectId: string;
  cwd?: string;
  unprocessedBefore: number;
  batches: number;
  metadataMissing?: boolean;
  incomplete?: boolean;
}

export interface PromoteAllResult extends PromoteResult {
  scanned: number;
  sidecarsWithUnprocessed: number;
  processedProjects: number;
  orphanedProjects: number;
  failedProjects: number;
  projects: PromoteAllProjectResult[];
}

function isReinforcedPattern(stats: PatternReinforcementStats): boolean {
  return stats.totalCount >= MIN_REINFORCED_PATTERN_OCCURRENCES &&
    stats.distinctSessions >= MIN_REINFORCED_PATTERN_SESSIONS;
}

function correlateErrors(events: EventRow[]): void {
  // Group by session
  const bySession = new Map<string, EventRow[]>();
  for (const e of events) {
    const list = bySession.get(e.session_id) ?? [];
    list.push(e);
    bySession.set(e.session_id, list);
  }

  for (const sessionEvents of bySession.values()) {
    // Sort by seq
    sessionEvents.sort((a, b) => a.seq - b.seq);

    // Find error→success pairs
    for (let i = 0; i < sessionEvents.length; i++) {
      const event = sessionEvents[i];
      if (event.category !== "error") continue;

      // Look for closest preceding error pattern match in the next CORRELATION_WINDOW events
      const errorPrefix = event.data.split(/\s+/).slice(0, 3).join(" ").toLowerCase();

      for (let j = i + 1; j < sessionEvents.length && (sessionEvents[j].seq - event.seq) <= CORRELATION_WINDOW; j++) {
        const candidate = sessionEvents[j];
        if (candidate.category === "error") continue; // skip other errors
        const candidatePrefix = candidate.data.split(/\s+/).slice(0, 3).join(" ").toLowerCase();

        // Match on command prefix overlap — guard against empty match token (data without colon)
        const matchToken = errorPrefix.split(":")[1]?.trim().split(" ")[0] ?? "";
        if (matchToken && candidatePrefix.includes(matchToken)) {
          // Correlation found — this is an error→fix pair
          // Set the tag to 'type:solution' (overriding 'type:gotcha' from AUTO_TAGS)
          (candidate as EventRow & { auto_tag?: string }).auto_tag = "type:solution";
          (candidate as EventRow & { _correlatedErrorId?: number })._correlatedErrorId = event.event_id;
          break; // only correlate with closest match
        }
      }
    }
  }
}

async function withSidecarPromotionLock<T>(sidecarPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = sidecarPromotionLocks.get(sidecarPath) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  // Stored lock promises only resolve; promotion failures are not stored in the map.
  const chained = previous.then(() => next);
  sidecarPromotionLocks.set(sidecarPath, chained);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (sidecarPromotionLocks.get(sidecarPath) === chained) {
      sidecarPromotionLocks.delete(sidecarPath);
    }
  }
}

function pendingMissingCwdResult(
  observations: number,
  retryAfterMs: number,
): PromoteResult {
  return {
    promoted: 0,
    skipped: 0,
    correlated: 0,
    errors: 0,
    deferred: {
      kind: "awaiting-confirmation",
      reason: "unavailable-cwd",
      observations,
      retryAfterMs,
    },
    message: `cwd is unavailable; awaiting confirmation (${observations}/${MISSING_CWD_CONFIRMATION_OBSERVATIONS})`,
  };
}

async function withLockedCwdPromotion<T>(
  cwd: string,
  sidecarPathOverride: string | undefined,
  onReady: (resolvedCwd: string, sidecarPath: string) => Promise<T>,
  onUnavailable: (result: PromoteResult) => T,
  publicationLockToken?: BackendPublicationLockToken,
): Promise<T> {
  let sidecarPath = sidecarPathOverride;
  if (sidecarPath === undefined) {
    try {
      const resolvedCwd = validateCwd(cwd);
      sidecarPath = existingEventsDbPathForPromotion(resolvedCwd, publicationLockToken)
        ?? eventsDbPath(resolvedCwd);
    } catch (error) {
      if (!isMissingCwdError(error)) throw error;
      // Preserve the same absolute lexical normalization used for an existing
      // cwd without requiring the missing path to become stat-able. Sidecar
      // identity must never depend on unresolved `..` or trailing separators.
      const resolvedCwd = validateCwd(cwd, { allowMissing: true });
      sidecarPath = existingEventsDbPathForPromotion(resolvedCwd, publicationLockToken);
      if (sidecarPath === undefined) return onUnavailable(noSidecarParkingResult());
    }
  }

  return withSidecarPromotionLock(sidecarPath, async () => {
    try {
      // The lock may have been contended long enough for a mount or renamed
      // cwd to recover. This is the decisive check for both state mutation and
      // terminal parking.
      const resolvedCwd = validateCwd(cwd);
      return await onReady(resolvedCwd, sidecarPath);
    } catch (error) {
      if (!isMissingCwdError(error)) throw error;
      return onUnavailable(await parkUnavailableCwdEventsUnlocked(sidecarPath));
    }
  });
}

function promotionExecutionContext(
  publicationLockToken: BackendPublicationLockToken | undefined,
  context: PromotionExecutionContext | undefined,
): PromotionExecutionContext | undefined {
  if (context !== undefined) return context;
  return publicationLockToken === undefined ? undefined : { publicationLockToken };
}

function existingEventsDbPathForPromotion(
  cwd: string,
  publicationLockToken?: BackendPublicationLockToken,
): string | undefined {
  return publicationLockToken === undefined
    ? existingEventsDbPath(cwd)
    : existingEventsDbPath(cwd, { publicationLockToken });
}

/**
 * Durably suspend local promotion while a recorded cwd remains unavailable.
 * The sidecar retains every event and delivery checkpoint so a future cwd
 * recovery can resume normal local promotion without data loss.
 */
export async function parkUnavailableCwdEvents(
  cwd: string,
  sidecarPathOverride?: string,
): Promise<PromoteResult> {
  // The cwd is revalidated under the lock, while an explicit sidecar path
  // remains the exact durable record to clear or observe. This permits a
  // recovered alias to resume its already-discovered sidecar without deriving
  // or creating a different path.
  return withLockedCwdPromotion(
    cwd,
    sidecarPathOverride,
    (_resolvedCwd, sidecarPath) => clearRecoveredMissingCwdState(sidecarPath),
    (result) => result,
  );
}

async function clearRecoveredMissingCwdState(
  sidecarPath: string,
): Promise<PromoteResult> {
  const outboxFactory = new SQLiteLocalHookOutboxFactory();
  try {
    const edb = await outboxFactory.openExisting(sidecarPath);
    await edb?.clearMissingCwd();
    return {
      promoted: 0,
      skipped: 0,
      correlated: 0,
      errors: 0,
      message: "cwd recovered; cleared durable parking state",
    };
  } finally {
    await closeRouteStorage(outboxFactory);
  }
}

async function parkUnavailableCwdEventsUnlocked(
  sidecarPath: string,
): Promise<PromoteResult> {
  const outboxFactory = new SQLiteLocalHookOutboxFactory();
  try {
    const edb = await outboxFactory.openExisting(sidecarPath);
    if (!edb) return noSidecarParkingResult();
    const state = await edb.observeMissingCwd(
      Date.now(),
      MISSING_CWD_CONFIRMATION_INTERVAL_MS,
      MISSING_CWD_CONFIRMATION_OBSERVATIONS,
    );
    if (!state.parked) {
      return pendingMissingCwdResult(state.observations, state.retryAfterMs);
    }
    return parkedCwdResult();
  } finally {
    await closeRouteStorage(outboxFactory);
  }
}

function parkedCwdResult(): PromoteResult {
  return {
    promoted: 0,
    skipped: 0,
    correlated: 0,
    errors: 0,
    terminal: { kind: "parked", reason: "unavailable-cwd" },
    message: "parked local promotion for unavailable cwd; preserved unprocessed events",
  };
}

function noSidecarParkingResult(): PromoteResult {
  return {
    promoted: 0,
    skipped: 0,
    correlated: 0,
    errors: 0,
    terminal: { kind: "parked", reason: "unavailable-cwd" },
    message: "no sidecar events to park for unavailable cwd",
  };
}

export function createPromoteEventsHandler(
  config: DaemonConfig,
  storageFactory?: StorageBackendFactory,
): RouteHandler {
  return async (_req, res, body, context) => {
    const input = JSON.parse(body || "{}");
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      sendJson(res, 400, { error: "invalid request body" });
      return;
    }

    if (!input.cwd) {
      sendJson(res, 400, { error: "cwd is required" });
      return;
    }

    let cwd: string;
    try {
      // Preserve direct-route validation for malformed inputs while allowing
      // a missing recorded cwd to reach durable unavailable-CWD preparation.
      cwd = validateCwd(input.cwd, { allowMissing: true });
    } catch (err) {
      // Log the detailed error server-side and return a generic message to the client
      await safeLogError("promote-events", err, {});
      sendJson(res, 400, { error: "cwd is invalid" });
      return;
    }

    let ownedFactory: StorageBackendFactory | undefined;
    const activeFactory = storageFactory
      ?? (ownedFactory = await createStorageBackendFactory(
        config.storage,
        undefined,
        undefined,
        context?.publicationLockToken,
      ));
    try {
      const result = input.drain === true
      ? await drainEventsForCwd(
            config,
            cwd,
            undefined,
            activeFactory,
            context?.publicationLockToken,
            context,
          )
        : await promoteEventsForCwd(
            config,
            cwd,
            undefined,
            activeFactory,
            context?.publicationLockToken,
            context,
          );
      sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof BackendPublicationJournalError) {
        sendJson(res, 503, {
          status: "blocked",
          error: "backend publication admission blocked",
        });
        return;
      }
      // Log detailed failure but avoid exposing internal error/stack info to the client
      await safeLogError("promote-events", error, { cwd });
      const storageFailure = storageRouteFailureResponse(
        config.storage.backend,
        error,
        "promote-events",
        activeFactory,
      );
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 500, { error: "failed to promote events" });
      return;
    } finally {
      await closeRouteStorage(ownedFactory);
    }
  };
}

export function createPromoteAllEventsHandler(
  config: DaemonConfig,
  storageFactory?: StorageBackendFactory,
): RouteHandler {
  return async (_req, res, _body, context) => {
    let ownedFactory: StorageBackendFactory | undefined;
    const activeFactory = storageFactory
      ?? (ownedFactory = await createStorageBackendFactory(
        config.storage,
        undefined,
        undefined,
        context?.publicationLockToken,
      ));
    try {
      const result: PromoteAllResult = {
        promoted: 0,
        skipped: 0,
        correlated: 0,
        errors: 0,
        scanned: 0,
        sidecarsWithUnprocessed: 0,
        processedProjects: 0,
        orphanedProjects: 0,
        failedProjects: 0,
        projects: [],
      };

      const sidecars = await collectEventSidecars({ timeoutMs: 30_000, maxDbs: Number.MAX_SAFE_INTEGER });
      result.scanned = sidecars.length;
      result.sidecarsWithUnprocessed = sidecars.filter(sidecar => sidecar.unprocessed > 0).length;

      for (const sidecar of sidecars) {
        if (sidecar.scanError) {
          result.errors++;
          result.failedProjects++;
          result.projects.push({
            projectId: sidecar.projectId,
            cwd: sidecar.cwd,
            unprocessedBefore: sidecar.unprocessed,
            metadataMissing: sidecar.metadataMissing,
            promoted: 0,
            skipped: 0,
            correlated: 0,
            errors: 1,
            batches: 0,
            message: "failed to scan sidecar",
          });
          continue;
        }
        if (sidecar.scanSkipped) {
          result.failedProjects++;
          result.projects.push({
            projectId: sidecar.projectId,
            cwd: sidecar.cwd,
            unprocessedBefore: 0,
            metadataMissing: sidecar.metadataMissing,
            promoted: 0,
            skipped: 0,
            correlated: 0,
            errors: 0,
            batches: 0,
            incomplete: true,
            message: `sidecar scan skipped: ${sidecar.scanSkipped}`,
          });
          continue;
        }

        if (sidecar.unprocessed === 0) continue;

        if (!sidecar.cwd) {
          result.orphanedProjects++;
          result.projects.push({
            projectId: sidecar.projectId,
            unprocessedBefore: sidecar.unprocessed,
            metadataMissing: true,
            promoted: 0,
            skipped: 0,
            correlated: 0,
            errors: 0,
            batches: 0,
            message: "missing project metadata",
          });
          continue;
        }

        try {
          const projectResult = await drainEventsForCwd(
            config,
            sidecar.cwd,
            sidecar.path,
            activeFactory,
            context?.publicationLockToken,
            context,
          );
          result.promoted += projectResult.promoted;
          result.skipped += projectResult.skipped;
          result.correlated += projectResult.correlated;
          result.errors += projectResult.errors;
          result.processedProjects++;
          if (projectResult.incomplete) result.failedProjects++;
          result.projects.push({
            ...projectResult,
            projectId: sidecar.projectId,
            cwd: sidecar.cwd,
            unprocessedBefore: sidecar.unprocessed,
          });
        } catch (error) {
          if (error instanceof BackendPublicationJournalError) throw error;
          if (storageRouteFailureResponse(config.storage.backend, error, "promote-events-all", activeFactory)) {
            throw error;
          }
          result.errors++;
          result.failedProjects++;
          await safeLogError("promote-events", error, { cwd: sidecar.cwd });
          result.projects.push({
            projectId: sidecar.projectId,
            cwd: sidecar.cwd,
            unprocessedBefore: sidecar.unprocessed,
            promoted: 0,
            skipped: 0,
            correlated: 0,
            errors: 1,
            batches: 0,
            message: "failed to promote events",
          });
        }
      }

      sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof BackendPublicationJournalError) {
        sendJson(res, 503, {
          status: "blocked",
          error: "backend publication admission blocked",
        });
        return;
      }
      await safeLogError("promote-events", error, {});
      const storageFailure = storageRouteFailureResponse(
        config.storage.backend,
        error,
        "promote-events-all",
        activeFactory,
      );
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 500, { error: "failed to promote events" });
    } finally {
      await closeRouteStorage(ownedFactory);
    }
  };
}

export async function drainEventsForCwd(
  config: DaemonConfig,
  cwd: string,
  sidecarPathOverride?: string,
  storageFactory?: StorageBackendFactory,
  publicationLockToken?: BackendPublicationLockToken,
  context?: PromotionExecutionContext,
): Promise<PromoteResult & { batches: number; incomplete?: boolean }> {
  return withLockedCwdPromotion(
    cwd,
    sidecarPathOverride,
    (resolvedCwd, sidecarPath) =>
      drainEventsForCwdUnlocked(
        config,
        resolvedCwd,
        sidecarPath,
        storageFactory,
        publicationLockToken,
        context,
      ),
    (parkingResult) => {
      const result: PromoteResult & { batches: number; incomplete?: boolean } = {
        ...parkingResult,
        batches: 0,
      };
      if (!result.terminal) result.incomplete = true;
      return result;
    },
    context?.publicationLockToken ?? publicationLockToken,
  );
}

async function drainEventsForCwdUnlocked(
  config: DaemonConfig,
  cwd: string,
  sidecarPath: string,
  storageFactory?: StorageBackendFactory,
  publicationLockToken?: BackendPublicationLockToken,
  context?: PromotionExecutionContext,
): Promise<PromoteResult & { batches: number; incomplete?: boolean }> {
  const result: PromoteResult & { batches: number; incomplete?: boolean } = {
    promoted: 0,
    skipped: 0,
    correlated: 0,
    errors: 0,
    batches: 0,
  };

  const outboxFactory = new SQLiteLocalHookOutboxFactory();
  let ownedFactory: StorageBackendFactory | undefined;
  try {
    const edb = await outboxFactory.open(sidecarPath);
    await edb.clearMissingCwd();
    const executionContext = promotionExecutionContext(publicationLockToken, context);
    const effectiveToken = executionContext?.publicationLockToken;
    const factory = storageFactory ?? (ownedFactory = await createStorageBackendFactory(
      config.storage,
      undefined,
      undefined,
      effectiveToken,
    ));
    for (let batch = 0; batch < MAX_GLOBAL_PROMOTION_BATCHES; batch++) {
      const prepared = await preparePromotionBatch(config, edb);
      const expectedIdentity = prepared.events.length === 0
        ? undefined
        : projectIdentity(cwd, config.storage, effectiveToken);
      const batchResult = await runSelectedPromotionBatch(
        config,
        cwd,
        edb,
        factory,
        executionContext,
        prepared,
        expectedIdentity,
      );
      if (batchResult.message === "no unprocessed events") {
        result.message = result.batches === 0
          ? "no unprocessed events"
          : "drained all unprocessed events";
        return result;
      }

      result.promoted += batchResult.promoted;
      result.skipped += batchResult.skipped;
      result.correlated += batchResult.correlated;
      result.errors += batchResult.errors;
      result.batches++;

      const processed = batchResult.promoted + batchResult.skipped;
      if (processed === 0) {
        result.incomplete = true;
        result.message = "stopped because remaining events failed to promote";
        return result;
      }
    }
  } finally {
    await closeRouteStorage(outboxFactory, ownedFactory);
  }

  result.incomplete = true;
  result.message = "stopped after maximum promotion batches";
  return result;
}

export async function promoteEventsForCwd(
  config: DaemonConfig,
  cwd: string,
  sidecarPathOverride?: string,
  storageFactory?: StorageBackendFactory,
  publicationLockToken?: BackendPublicationLockToken,
  context?: PromotionExecutionContext,
): Promise<PromoteResult> {
  return withLockedCwdPromotion(
    cwd,
    sidecarPathOverride,
    (resolvedCwd, sidecarPath) =>
      promoteEventsForCwdUnlocked(
        config,
        resolvedCwd,
        sidecarPath,
        storageFactory,
        publicationLockToken,
        context,
      ),
    (result) => result,
    context?.publicationLockToken ?? publicationLockToken,
  );
}

async function promoteEventsForCwdUnlocked(
  config: DaemonConfig,
  cwd: string,
  sidecarPath: string,
  storageFactory?: StorageBackendFactory,
  publicationLockToken?: BackendPublicationLockToken,
  context?: PromotionExecutionContext,
): Promise<PromoteResult> {
  const outboxFactory = new SQLiteLocalHookOutboxFactory();
  let ownedFactory: StorageBackendFactory | undefined;
  try {
    const edb = await outboxFactory.open(sidecarPath);
    await edb.clearMissingCwd();
    const prepared = await preparePromotionBatch(config, edb);
    const executionContext = promotionExecutionContext(publicationLockToken, context);
    const effectiveToken = executionContext?.publicationLockToken;
    const factory = storageFactory ?? (ownedFactory = await createStorageBackendFactory(
      config.storage,
      undefined,
      undefined,
      effectiveToken,
    ));
    const expectedIdentity = prepared.events.length === 0
      ? undefined
      : projectIdentity(cwd, config.storage, effectiveToken);
    return await runSelectedPromotionBatch(
      config,
      cwd,
      edb,
      factory,
      executionContext,
      prepared,
      expectedIdentity,
    );
  } finally {
    await closeRouteStorage(outboxFactory, ownedFactory);
  }
}

type PreparedPromotionBatch = Readonly<{
  events: EventRow[];
  reinforcementCache: Map<string, PatternReinforcementStats>;
  reinforcementErrors: Map<EventRow["event_id"], unknown>;
}>;

async function preparePromotionBatch(
  config: DaemonConfig,
  edb: LocalHookOutboxRepository,
): Promise<PreparedPromotionBatch> {
  const events = await edb.getUnprocessed();
  if (events.length === 0) {
    return {
      events,
      reinforcementCache: new Map(),
      reinforcementErrors: new Map(),
    };
  }

  correlateErrors(events);
  const thresholds = config.compaction.promotionThresholds;
  const reinforcementCache = new Map<string, PatternReinforcementStats>();
  const reinforcementErrors = new Map<EventRow["event_id"], unknown>();
  for (const event of events) {
    if (event.priority !== 3 || !AUTO_PROMOTABLE_PATTERN_CATEGORIES.has(event.category)) continue;
    const key = `${event.type}\u0000${event.category}\u0000${event.data}`;
    if (reinforcementCache.has(key)) continue;
    try {
      reinforcementCache.set(key, await edb.getPatternReinforcement(
        event.type,
        event.category,
        event.data,
        thresholds.insightsMaxAgeDays ?? 90,
      ));
    } catch (error) {
      // Keep the local sidecar read outside selected storage admission while
      // preserving the prior per-event best-effort behavior.
      reinforcementErrors.set(event.event_id, error);
    }
  }
  return { events, reinforcementCache, reinforcementErrors };
}

function cancelledPromotionResult(): PromoteResult {
  return {
    promoted: 0,
    skipped: 0,
    correlated: 0,
    errors: 0,
    message: "promotion cancelled",
  };
}

async function runSelectedPromotionBatch(
  config: DaemonConfig,
  cwd: string,
  edb: LocalHookOutboxRepository,
  factory: StorageBackendFactory,
  context: PromotionExecutionContext | undefined,
  prepared: PreparedPromotionBatch,
  expectedIdentity?: StorageIdentityContext & { readonly localProjectId: string },
): Promise<PromoteResult> {
  const activeScrubber = prepared.events.length === 0
    ? undefined
    : await ScrubEngine.forProject(
      config.security.sensitivePatterns,
      projectPathsForIdentity({
        id: expectedIdentity!.localProjectId,
        canonical: expectedIdentity!.canonical,
        ...(expectedIdentity!.remoteProjectId === undefined
          ? {}
          : { remoteProjectId: expectedIdentity!.remoteProjectId }),
      }).dir,
    );
  const storageRequest = {
    config,
    cwd,
    factory,
    context,
    mode: "create" as const,
    ...(expectedIdentity === undefined ? {} : { expectedIdentity }),
  };
  let result: PromoteResult | null;
  try {
    result = await withProjectStorage(
      storageRequest,
      async project => {
        if (prepared.events.length === 0) {
          return {
            promoted: 0,
            skipped: 0,
            correlated: 0,
            errors: 0,
            message: "no unprocessed events",
          };
        }
        return promoteEventsBatch(
          config,
          cwd,
          edb,
          project,
          activeScrubber!,
          new Map(),
          prepared.events,
          prepared.reinforcementCache,
          prepared.reinforcementErrors,
        );
      },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return cancelledPromotionResult();
    }
    throw error;
  }
  return result ?? cancelledPromotionResult();
}

async function promoteEventsBatch(
  config: DaemonConfig,
  cwd: string,
  edb: LocalHookOutboxRepository,
  project: ProjectStorage,
  scrubber: ScrubEngine,
  scrubCache: Map<string, string>,
  events: EventRow[],
  reinforcementCache: Map<string, PatternReinforcementStats>,
  reinforcementErrors: Map<EventRow["event_id"], unknown>,
): Promise<PromoteResult> {
  const result: PromoteResult = { promoted: 0, skipped: 0, correlated: 0, errors: 0 };

      const thresholds = config.compaction.promotionThresholds;
      const eventConf = thresholds.eventConfidence ?? {
        decision: 0.5, plan: 0.7, errorFix: 0.4, batch: 0.3, pattern: 0.2,
      };
      const getPatternReinforcement = (event: EventRow): PatternReinforcementStats => {
        if (event.priority !== 3 || !AUTO_PROMOTABLE_PATTERN_CATEGORIES.has(event.category)) {
          return EMPTY_REINFORCEMENT;
        }

        if (reinforcementErrors.has(event.event_id)) {
          throw reinforcementErrors.get(event.event_id);
        }
        const key = `${event.type}\u0000${event.category}\u0000${event.data}`;
        return reinforcementCache.get(key)!;
      };

      const processedIds: number[] = [];

      for (const event of events) {
        try {
          let scrubbedData = scrubCache.get(event.data);
          if (scrubbedData === undefined) {
            scrubbedData = scrubber.scrub(event.data);
            scrubCache.set(event.data, scrubbedData);
          }
          const autoTag = (event as EventRow & { auto_tag?: string }).auto_tag;
          const tag = autoTag ?? AUTO_TAGS[event.category] ?? `category:${event.category}`;
          const reinforcement = getPatternReinforcement(event);
          const reinforced = isReinforcedPattern(reinforcement);
          let confidence: number;
          let newEntryConfidence: number | undefined;

          // Determine confidence by tier
          if (event.priority === 1) {
            // Tier 1: immediate
            if (event.category === "plan") {
              confidence = eventConf.plan ?? 0.7;
            } else if ((event as EventRow & { _correlatedErrorId?: number })._correlatedErrorId) {
              confidence = eventConf.errorFix ?? 0.4;
              result.correlated++;
            } else {
              confidence = eventConf.decision ?? 0.5;
            }
          } else if (event.priority === 2) {
            // Tier 2: batch
            confidence = eventConf.batch ?? 0.3;
            // Check if this is a correlated fix event
            if ((event as EventRow & { _correlatedErrorId?: number })._correlatedErrorId) {
              confidence = eventConf.errorFix ?? 0.4;
              result.correlated++;
            }
          } else {
            // Tier 3: pattern-only — require either an existing promoted match or
            // enough repeated passive evidence to bootstrap a new memory.
            confidence = eventConf.pattern ?? 0.2;
            if (!reinforced) {
              const existing = await project.lexicalSearch.searchPromoted(
                scrubbedData,
                1,
                undefined,
                project.projectId,
              );
              if (existing.length === 0) {
                processedIds.push(event.event_id);
                result.skipped++;
                continue;
              }
            } else {
              newEntryConfidence = Math.min(
                thresholds.maxConfidence ?? 1.0,
                confidence + (thresholds.reinforcementBoost ?? 0.3),
              );
            }
          }

          // Set correlation chain
          const correlatedErrorId = (event as EventRow & { _correlatedErrorId?: number })._correlatedErrorId;
          if (correlatedErrorId) {
            await edb.setPrevEventId(event.event_id, correlatedErrorId);
          }

          // Promote via existing dedup pipeline
          await deduplicateAndInsert({
            transaction: (callback) => project.transaction(callback),
            content: scrubbedData,
            tags: [
              tag,
              "source:passive-capture",
              `hook:${event.source_hook}`,
              ...(reinforced ? ["signal:reinforced"] : []),
            ],
            sourceProjectId: project.projectId,
            sessionId: event.session_id,
            depth: 0,
            confidence,
            newEntryConfidence,
            thresholds: {
              dedupBm25Threshold: thresholds.dedupBm25Threshold ?? 15,
              dedupCandidateLimit: thresholds.dedupCandidateLimit ?? 100,
            },
          });

          processedIds.push(event.event_id);
          result.promoted++;
        } catch (error) {
          if (config.storage.backend === "postgresql" && error instanceof StorageOperationError) {
            throw error;
          }
          result.errors++;
          await safeLogError("promote-events", error, { cwd, sessionId: event.session_id });
          // Do not add to processedIds — transient errors (DB busy, dedup failure) should
          // allow the event to be retried on next promotion pass rather than being silently dropped.
        }
      }

      await edb.markProcessed(processedIds);

  return result;
}
