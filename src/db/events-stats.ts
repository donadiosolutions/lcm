// src/db/events-stats.ts
import { collectEventSidecars, type EventSidecarScanOptions } from "./event-sidecars.js";

export interface EventStats {
  captured: number;
  unprocessed: number;
  errors: number;
  scanErrors?: number;
  scanSkipped?: number;
  prunedSidecars?: number;
  lastCapture: string | null;
  sidecars?: number;
  sidecarsWithUnprocessed?: number;
  orphanedSidecarsWithUnprocessed?: number;
}

export interface DetailedEventStats extends EventStats {
  projects: Array<{
    file: string;
    projectId: string;
    cwd?: string;
    metadataMissing: boolean;
    captured: number;
    unprocessed: number;
    lastCapture: string | null;
    path: string;
    scanError?: string;
    scanSkipped?: string;
    pruned?: boolean;
    pruneReason?: string;
  }>;
  recentErrors: Array<{ created_at: string; hook: string; error: string }>;
}

export type EventStatsOptions = number | EventSidecarScanOptions;

function normalizeStatsOptions(options: EventStatsOptions = {}): EventSidecarScanOptions {
  if (typeof options === "number") return { timeoutMs: options };
  return options;
}

/**
 * Scan all sidecar DBs and aggregate event stats.
 * Used by both lcm doctor and lcm stats.
 * @param options Total scan options, or timeout in milliseconds for backward compatibility.
 */
export async function collectEventStats(options: EventStatsOptions = {}): Promise<EventStats> {
  const scanOptions = normalizeStatsOptions(options);
  const result: EventStats = {
    captured: 0,
    unprocessed: 0,
    errors: 0,
    scanErrors: 0,
    scanSkipped: 0,
    prunedSidecars: 0,
    lastCapture: null,
    sidecars: 0,
    sidecarsWithUnprocessed: 0,
    orphanedSidecarsWithUnprocessed: 0,
  };

  for (const sidecar of await collectEventSidecars(scanOptions)) {
    result.sidecars = result.sidecars! + 1;
    if (sidecar.pruned) {
      result.prunedSidecars = result.prunedSidecars! + 1;
      continue;
    }
    if (sidecar.scanSkipped) {
      result.scanSkipped = result.scanSkipped! + 1;
      continue;
    }
    result.captured += sidecar.captured;
    result.unprocessed += sidecar.unprocessed;
    if (sidecar.scanError) {
      result.scanErrors = result.scanErrors! + 1;
    } else {
      result.errors += sidecar.errors;
    }
    if (sidecar.unprocessed > 0) {
      result.sidecarsWithUnprocessed = result.sidecarsWithUnprocessed! + 1;
      if (sidecar.metadataMissing) {
        result.orphanedSidecarsWithUnprocessed = result.orphanedSidecarsWithUnprocessed! + 1;
      }
    }
    if (sidecar.lastCapture && (!result.lastCapture || sidecar.lastCapture > result.lastCapture)) {
      result.lastCapture = sidecar.lastCapture;
    }
  }

  return result;
}

/**
 * Detailed scan for verbose doctor output — returns per-project breakdown + recent errors.
 */
export async function collectDetailedEventStats(options: EventStatsOptions = {}): Promise<DetailedEventStats> {
  const scanOptions = normalizeStatsOptions(options);
  const result: DetailedEventStats = {
    captured: 0, unprocessed: 0, errors: 0, scanErrors: 0, scanSkipped: 0, prunedSidecars: 0, lastCapture: null,
    sidecars: 0, sidecarsWithUnprocessed: 0, orphanedSidecarsWithUnprocessed: 0,
    projects: [], recentErrors: [],
  };

  for (const sidecar of await collectEventSidecars({ ...scanOptions, includeRecentErrors: true })) {
    result.sidecars = result.sidecars! + 1;
    if (sidecar.pruned) {
      result.prunedSidecars = result.prunedSidecars! + 1;
    } else if (sidecar.scanSkipped) {
      result.scanSkipped = result.scanSkipped! + 1;
    } else {
      result.captured += sidecar.captured;
      result.unprocessed += sidecar.unprocessed;
      if (sidecar.scanError) {
        result.scanErrors = result.scanErrors! + 1;
      } else {
        result.errors += sidecar.errors;
      }
      if (sidecar.unprocessed > 0) {
        result.sidecarsWithUnprocessed = result.sidecarsWithUnprocessed! + 1;
        if (sidecar.metadataMissing) {
          result.orphanedSidecarsWithUnprocessed = result.orphanedSidecarsWithUnprocessed! + 1;
        }
      }
      if (sidecar.lastCapture && (!result.lastCapture || sidecar.lastCapture > result.lastCapture)) {
        result.lastCapture = sidecar.lastCapture;
      }
    }
    result.projects.push({
      file: sidecar.file,
      projectId: sidecar.projectId,
      cwd: sidecar.cwd,
      metadataMissing: sidecar.metadataMissing,
      captured: sidecar.captured,
      unprocessed: sidecar.unprocessed,
      lastCapture: sidecar.lastCapture,
      path: sidecar.path,
      scanError: sidecar.scanError,
      scanSkipped: sidecar.scanSkipped,
      pruned: sidecar.pruned,
      pruneReason: sidecar.pruneReason,
    });
    result.recentErrors.push(...(sidecar.recentErrors ?? []));
  }

  // Sort and limit recent errors across all DBs
  result.recentErrors.sort((a, b) => b.created_at.localeCompare(a.created_at));
  result.recentErrors = result.recentErrors.slice(0, 5);

  return result;
}
