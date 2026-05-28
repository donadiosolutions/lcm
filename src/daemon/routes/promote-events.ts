import { EventsDb, type EventRow, type PatternReinforcementStats } from "../../hooks/events-db.js";
import { eventsDbPath } from "../../db/events-path.js";
import { PromotedStore } from "../../db/promoted.js";
import { deduplicateAndInsert } from "../../promotion/dedup.js";
import { sendJson, type RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import { projectId, projectDbPath } from "../project.js";
import { getLcmConnection, closeLcmConnection } from "../../db/connection.js";
import { runLcmMigrations } from "../../db/migration.js";
import type { DaemonConfig } from "../config.js";
import { safeLogError } from "../../hooks/hook-errors.js";
import { collectEventSidecars } from "../../db/event-sidecars.js";

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
const MIN_REINFORCED_PATTERN_OCCURRENCES = 3;
const MIN_REINFORCED_PATTERN_SESSIONS = 2;
const AUTO_PROMOTABLE_PATTERN_CATEGORIES = new Set(["file", "mcp", "skill", "subagent"]);
const EMPTY_REINFORCEMENT: PatternReinforcementStats = { totalCount: 0, distinctSessions: 0 };

interface PromoteResult {
  promoted: number;
  skipped: number;
  correlated: number;
  errors: number;
  message?: string;
}

interface PromoteAllProjectResult extends PromoteResult {
  projectId: string;
  cwd?: string;
  unprocessedBefore: number;
  metadataMissing?: boolean;
}

interface PromoteAllResult extends PromoteResult {
  scanned: number;
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
      const result = await promoteEventsForCwd(config, cwd);
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
    const result: PromoteAllResult = {
      promoted: 0,
      skipped: 0,
      correlated: 0,
      errors: 0,
      scanned: 0,
      processedProjects: 0,
      orphanedProjects: 0,
      failedProjects: 0,
      projects: [],
    };

    const sidecars = collectEventSidecars({ timeoutMs: 30_000, maxDbs: Number.MAX_SAFE_INTEGER })
      .filter(sidecar => sidecar.unprocessed > 0);
    result.scanned = sidecars.length;

    for (const sidecar of sidecars) {
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
          message: "missing project metadata",
        });
        continue;
      }

      try {
        const projectResult = await promoteEventsForCwd(config, sidecar.cwd);
        result.promoted += projectResult.promoted;
        result.skipped += projectResult.skipped;
        result.correlated += projectResult.correlated;
        result.errors += projectResult.errors;
        result.processedProjects++;
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
          message: "failed to promote events",
        });
      }
    }

    sendJson(res, 200, result);
  };
}

export async function promoteEventsForCwd(config: DaemonConfig, cwd: string): Promise<PromoteResult> {
  cwd = validateCwd(cwd);
  const result: PromoteResult = { promoted: 0, skipped: 0, correlated: 0, errors: 0 };
  const sidecarPath = eventsDbPath(cwd);
  const edb = new EventsDb(sidecarPath);

  try {
    const events = edb.getUnprocessed();
    if (events.length === 0) {
      return { ...result, message: "no unprocessed events" };
    }

    // Correlate error→fix pairs
    correlateErrors(events);

    // Open main project DB for promotion
    const pid = projectId(cwd);
    const dbPath = projectDbPath(cwd);
    const db = getLcmConnection(dbPath);
    try {
      runLcmMigrations(db);
      const store = new PromotedStore(db);

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
              const existing = store.search(event.data, 1, undefined, pid);
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
            content: event.data,
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
    } finally {
      closeLcmConnection(dbPath);
    }
  } finally {
    edb.close();
  }

  return result;
}
