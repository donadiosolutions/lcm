// src/db/events-stats.ts
import { collectEventSidecars } from "./event-sidecars.js";

export interface EventStats {
  captured: number;
  unprocessed: number;
  errors: number;
  scanErrors?: number;
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
  }>;
  recentErrors: Array<{ created_at: string; hook: string; error: string }>;
}

/**
 * Scan all sidecar DBs and aggregate event stats.
 * Used by both lcm doctor and lcm stats.
 * @param timeoutMs Total time budget for the scan (default 2000ms)
 */
export function collectEventStats(timeoutMs = 2000): EventStats {
  const result: EventStats = {
    captured: 0,
    unprocessed: 0,
    errors: 0,
    scanErrors: 0,
    lastCapture: null,
    sidecars: 0,
    sidecarsWithUnprocessed: 0,
    orphanedSidecarsWithUnprocessed: 0,
  };

  for (const sidecar of collectEventSidecars({ timeoutMs })) {
    result.sidecars = (result.sidecars ?? 0) + 1;
    result.captured += sidecar.captured;
    result.unprocessed += sidecar.unprocessed;
    if (sidecar.scanError) {
      result.scanErrors = (result.scanErrors ?? 0) + 1;
    } else {
      result.errors += sidecar.errors;
    }
    if (sidecar.unprocessed > 0) {
      result.sidecarsWithUnprocessed = (result.sidecarsWithUnprocessed ?? 0) + 1;
      if (sidecar.metadataMissing) {
        result.orphanedSidecarsWithUnprocessed = (result.orphanedSidecarsWithUnprocessed ?? 0) + 1;
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
export function collectDetailedEventStats(timeoutMs = 2000): DetailedEventStats {
  const result: DetailedEventStats = {
    captured: 0, unprocessed: 0, errors: 0, scanErrors: 0, lastCapture: null,
    sidecars: 0, sidecarsWithUnprocessed: 0, orphanedSidecarsWithUnprocessed: 0,
    projects: [], recentErrors: [],
  };

  for (const sidecar of collectEventSidecars({ timeoutMs, includeRecentErrors: true })) {
    result.sidecars = (result.sidecars ?? 0) + 1;
    result.captured += sidecar.captured;
    result.unprocessed += sidecar.unprocessed;
    if (sidecar.scanError) {
      result.scanErrors = (result.scanErrors ?? 0) + 1;
    } else {
      result.errors += sidecar.errors;
    }
    if (sidecar.unprocessed > 0) {
      result.sidecarsWithUnprocessed = (result.sidecarsWithUnprocessed ?? 0) + 1;
      if (sidecar.metadataMissing) {
        result.orphanedSidecarsWithUnprocessed = (result.orphanedSidecarsWithUnprocessed ?? 0) + 1;
      }
    }
    if (sidecar.lastCapture && (!result.lastCapture || sidecar.lastCapture > result.lastCapture)) {
      result.lastCapture = sidecar.lastCapture;
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
    });
    result.recentErrors.push(...(sidecar.recentErrors ?? []));
  }

  // Sort and limit recent errors across all DBs
  result.recentErrors.sort((a, b) => b.created_at.localeCompare(a.created_at));
  result.recentErrors = result.recentErrors.slice(0, 5);

  return result;
}
