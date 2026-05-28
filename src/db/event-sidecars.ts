import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventsDb } from "../hooks/events-db.js";
import { eventsDir } from "./events-path.js";
import { projectsDir } from "../runtime-paths.js";

export interface EventSidecarSummary {
  file: string;
  projectId: string;
  path: string;
  cwd?: string;
  metadataMissing: boolean;
  captured: number;
  unprocessed: number;
  errors: number;
  lastCapture: string | null;
  recentErrors?: Array<{ created_at: string; hook: string; error: string }>;
  scanError?: string;
}

export interface EventSidecarScanOptions {
  timeoutMs?: number;
  maxDbs?: number;
  includeRecentErrors?: boolean;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_DBS = 50;

function readCwdForProject(projectId: string): string | undefined {
  const metaPath = join(projectsDir(), projectId, "meta.json");
  if (!existsSync(metaPath)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf-8")) as { cwd?: unknown };
    return typeof parsed.cwd === "string" && parsed.cwd.length > 0 ? parsed.cwd : undefined;
  } catch {
    return undefined;
  }
}

function failedSidecarSummary(
  file: string,
  path: string,
  scanError: string,
  resolveMetadata = true,
): EventSidecarSummary {
  const projectId = file.slice(0, -".db".length);
  const cwd = resolveMetadata ? readCwdForProject(projectId) : undefined;
  return {
    file,
    projectId,
    path,
    cwd,
    metadataMissing: resolveMetadata && cwd === undefined,
    captured: 0,
    unprocessed: 0,
    errors: 0,
    lastCapture: null,
    scanError,
  };
}

export function collectEventSidecars(options: EventSidecarScanOptions = {}): EventSidecarSummary[] {
  const dir = eventsDir();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxDbs = options.maxDbs ?? DEFAULT_MAX_DBS;
  const deadline = Date.now() + timeoutMs;

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter(f => f.endsWith(".db"))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }

  const sidecars: EventSidecarSummary[] = [];
  let scanned = 0;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const path = join(dir, file);
    if (scanned >= maxDbs || Date.now() >= deadline) {
      const scanError = scanned >= maxDbs
        ? "sidecar scan skipped after maxDbs limit"
        : "sidecar scan skipped after timeout";
      for (const skippedFile of files.slice(index)) {
        sidecars.push(failedSidecarSummary(skippedFile, join(dir, skippedFile), scanError, false));
      }
      break;
    }
    scanned++;

    const projectId = file.slice(0, -".db".length);
    try {
      const db = new EventsDb(path);
      db.raw().exec("PRAGMA busy_timeout = 500");
      try {
        const stats = db.getHealthStats();
        const cwd = readCwdForProject(projectId);
        const recentErrors = options.includeRecentErrors
          ? db.raw().prepare(
            "SELECT created_at, hook, error FROM error_log WHERE hook NOT LIKE 'maintenance:%' ORDER BY id DESC LIMIT 5"
          ).all() as Array<{ created_at: string; hook: string; error: string }>
          : undefined;
        sidecars.push({
          file,
          projectId,
          path,
          cwd,
          metadataMissing: cwd === undefined,
          captured: stats.totalEvents,
          unprocessed: stats.unprocessed,
          errors: stats.errors,
          lastCapture: stats.lastCapture,
          recentErrors,
        });
      } finally {
        db.close();
      }
    } catch (error) {
      sidecars.push(failedSidecarSummary(
        file,
        path,
        error instanceof Error ? error.message : "failed to scan sidecar",
      ));
    }
  }

  return sidecars;
}
