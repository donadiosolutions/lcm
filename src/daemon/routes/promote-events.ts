import { EventsDb, type EventRow, type PatternReinforcementStats } from "../../hooks/events-db.js";
import { eventsDbPath } from "../../db/events-path.js";
import { PromotedStore } from "../../db/promoted.js";
import { deduplicateAndInsert } from "../../promotion/dedup.js";
import { sendJson, type RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import { projectId, projectDbPath } from "../project.js";
import { dirname } from "node:path";
import { getLcmConnection, closeLcmConnection } from "../../db/connection.js";
import { runLcmMigrations } from "../../db/migration.js";
import type { DaemonConfig } from "../config.js";
import { safeLogError } from "../../hooks/hook-errors.js";
import { collectEventSidecars } from "../../db/event-sidecars.js";
import { ScrubEngine } from "../../scrub.js";

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
const MIN_REINFORCED_PATTERN_OCCURRENCES = 3;
const MIN_REINFORCED_PATTERN_SESSIONS = 2;
const AUTO_PROMOTABLE_PATTERN_CATEGORIES = new Set(["file", "mcp", "skill", "subagent"]);
const EMPTY_REINFORCEMENT: PatternReinforcementStats = { totalCount: 0, distinctSessions: 0 };
const sidecarPromotionLocks = new Map<string, Promise<void>>();

export interface PromoteResult {
  promoted: number;
  skipped: number;
  correlated: number;
  errors: number;
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

export function createPromoteEventsHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");

    if (!input.cwd) {
      sendJson(res, 400, { error: "cwd is required" });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      // Log the detailed error server-side and return a generic message to the client
      safeLogError("promote-events", err, {});
      sendJson(res, 400, { error: "cwd is invalid" });
      return;
    }

    try {
      const result = input.drain === true
        ? await drainEventsForCwd(config, cwd)
        : await promoteEventsForCwd(config, cwd);
      sendJson(res, 200, result);
    } catch (error) {
      // Log detailed failure but avoid exposing internal error/stack info to the client
      safeLogError("promote-events", error, { cwd });
      sendJson(res, 500, { error: "failed to promote events" });
      return;
    }
  };
}

export function createPromoteAllEventsHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res) => {
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

      const sidecars = collectEventSidecars({ timeoutMs: 30_000, maxDbs: Number.MAX_SAFE_INTEGER });
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
          const projectResult = await drainEventsForCwd(config, sidecar.cwd, sidecar.path);
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
          result.errors++;
          result.failedProjects++;
          safeLogError("promote-events", error, { cwd: sidecar.cwd });
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
      safeLogError("promote-events", error, {});
      sendJson(res, 500, { error: "failed to promote events" });
    }
  };
}

export async function drainEventsForCwd(
  config: DaemonConfig,
  cwd: string,
  sidecarPathOverride?: string,
): Promise<PromoteResult & { batches: number; incomplete?: boolean }> {
  cwd = validateCwd(cwd);
  const sidecarPath = sidecarPathOverride ?? eventsDbPath(cwd);
  return withSidecarPromotionLock(sidecarPath, () => drainEventsForCwdUnlocked(config, cwd, sidecarPath));
}

async function drainEventsForCwdUnlocked(
  config: DaemonConfig,
  cwd: string,
  sidecarPath: string,
): Promise<PromoteResult & { batches: number; incomplete?: boolean }> {
  const result: PromoteResult & { batches: number; incomplete?: boolean } = {
    promoted: 0,
    skipped: 0,
    correlated: 0,
    errors: 0,
    batches: 0,
  };

  const edb = new EventsDb(sidecarPath);
  const dbPath = projectDbPath(cwd);
  let dbOpened = false;
  try {
    const db = getLcmConnection(dbPath);
    dbOpened = true;
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const scrubber = await ScrubEngine.forProject(
      config.security.sensitivePatterns,
      dirname(dbPath),
    );
    const scrubCache = new Map<string, string>();

    for (let batch = 0; batch < MAX_GLOBAL_PROMOTION_BATCHES; batch++) {
      const batchResult = await promoteEventsBatch(config, cwd, edb, store, scrubber, scrubCache);
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
    try {
      if (dbOpened) closeLcmConnection(dbPath);
    } finally {
      edb.close();
    }
  }

  result.incomplete = true;
  result.message = "stopped after maximum promotion batches";
  return result;
}

export async function promoteEventsForCwd(
  config: DaemonConfig,
  cwd: string,
  sidecarPathOverride?: string,
): Promise<PromoteResult> {
  cwd = validateCwd(cwd);
  const sidecarPath = sidecarPathOverride ?? eventsDbPath(cwd);
  return withSidecarPromotionLock(sidecarPath, () => promoteEventsForCwdUnlocked(config, cwd, sidecarPath));
}

async function promoteEventsForCwdUnlocked(
  config: DaemonConfig,
  cwd: string,
  sidecarPath: string,
): Promise<PromoteResult> {
  const edb = new EventsDb(sidecarPath);
  const dbPath = projectDbPath(cwd);
  let dbOpened = false;
  try {
    const db = getLcmConnection(dbPath);
    dbOpened = true;
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const scrubber = await ScrubEngine.forProject(
      config.security.sensitivePatterns,
      dirname(dbPath),
    );
    return await promoteEventsBatch(config, cwd, edb, store, scrubber, new Map());
  } finally {
    try {
      if (dbOpened) closeLcmConnection(dbPath);
    } finally {
      edb.close();
    }
  }
}

async function promoteEventsBatch(
  config: DaemonConfig,
  cwd: string,
  edb: EventsDb,
  store: PromotedStore,
  scrubber: ScrubEngine,
  scrubCache: Map<string, string>,
): Promise<PromoteResult> {
  const result: PromoteResult = { promoted: 0, skipped: 0, correlated: 0, errors: 0 };

  const events = edb.getUnprocessed();
  if (events.length === 0) {
    return { ...result, message: "no unprocessed events" };
  }

  // Correlate error→fix pairs
  correlateErrors(events);

  const pid = projectId(cwd);
      const thresholds = config.compaction.promotionThresholds;
      const eventConf = thresholds.eventConfidence ?? {
        decision: 0.5, plan: 0.7, errorFix: 0.4, batch: 0.3, pattern: 0.2,
      };
      const reinforcementCache = new Map<string, PatternReinforcementStats>();
      const getPatternReinforcement = (event: EventRow): PatternReinforcementStats => {
        if (event.priority !== 3 || !AUTO_PROMOTABLE_PATTERN_CATEGORIES.has(event.category)) {
          return EMPTY_REINFORCEMENT;
        }

        const key = `${event.type}\u0000${event.category}\u0000${event.data}`;
        const cached = reinforcementCache.get(key);
        if (cached) return cached;

        const stats = edb.getPatternReinforcement(
          event.type,
          event.category,
          event.data,
          thresholds.insightsMaxAgeDays ?? 90,
        );
        reinforcementCache.set(key, stats);
        return stats;
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
              const existing = store.search(scrubbedData, 1, undefined, pid);
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
            edb.setPrevEventId(event.event_id, correlatedErrorId);
          }

          // Promote via existing dedup pipeline
          await deduplicateAndInsert({
            store,
            content: scrubbedData,
            tags: [
              tag,
              "source:passive-capture",
              `hook:${event.source_hook}`,
              ...(reinforced ? ["signal:reinforced"] : []),
            ],
            projectId: pid,
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
          result.errors++;
          safeLogError("promote-events", error, { cwd, sessionId: event.session_id });
          // Do not add to processedIds — transient errors (DB busy, dedup failure) should
          // allow the event to be retried on next promotion pass rather than being silently dropped.
        }
      }

      edb.markProcessed(processedIds);

  return result;
}
