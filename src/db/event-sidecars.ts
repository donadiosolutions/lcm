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
}

export interface EventSidecarScanOptions {
  timeoutMs?: number;
  maxDbs?: number;
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

export function collectEventSidecars(options: EventSidecarScanOptions = {}): EventSidecarSummary[] {
  const dir = eventsDir();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxDbs = options.maxDbs ?? DEFAULT_MAX_DBS;
  const deadline = Date.now() + timeoutMs;

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".db"));
  } catch {
    return [];
  }

  const sidecars: EventSidecarSummary[] = [];
  let scanned = 0;
  for (const file of files) {
    if (scanned >= maxDbs || Date.now() >= deadline) break;
    scanned++;

    const projectId = file.slice(0, -".db".length);
    const path = join(dir, file);
    try {
      const db = new EventsDb(path);
      db.raw().exec("PRAGMA busy_timeout = 500");
      try {
        const stats = db.getHealthStats();
        const cwd = readCwdForProject(projectId);
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
        });
      } finally {
        db.close();
      }
    } catch {
      // Corrupt or locked sidecars should not break global diagnostics.
    }
  }

  return sidecars;
}
