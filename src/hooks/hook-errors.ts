// src/hooks/hook-errors.ts
import { EventsDb } from "./events-db.js";
import { eventsDbPath } from "../db/events-path.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { lcmPath } from "../runtime-paths.js";
import { ensureProjectDir } from "../daemon/project.js";
import { validateCwd } from "../daemon/validate-cwd.js";

function isUnderDir(candidate: string, base: string): boolean {
  const resolvedCandidate = resolve(candidate);
  const resolvedBase = resolve(base);
  const rel = relative(resolvedBase, resolvedCandidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

let testLogPath: string | undefined;

export function _setLogPathForTesting(path: string | undefined): void {
  testLogPath = path;
}

/** Returns the log path. */
export function getLogPath(): string {
  const defaultPath = lcmPath("logs", "events.log");
  if (!testLogPath) return defaultPath;

  const resolved = resolve(testLogPath);
  const allowedBases = [
    lcmPath("logs"),
    tmpdir(),
  ];
  if (!allowedBases.some((base) => isUnderDir(resolved, base))) {
    throw new Error("Test log path must be under the LCM logs directory or the system temp directory");
  }
  return resolved;
}

let dbCircuitOpen = false;

/** Reset circuit breaker — for testing only. */
export function _resetCircuitBreaker(): void {
  dbCircuitOpen = false;
}

/**
 * Three-layer error fence for hook processes.
 * Layer 1: Sidecar DB error_log table (queryable by doctor/stats)
 * Layer 2: Flat file ~/.lcm/logs/events.log
 * Layer 3: Swallow silently — hooks must never crash
 */
export function safeLogError(
  hook: string,
  error: unknown,
  opts: { cwd?: string; sessionId?: string },
): void {
  // Layer 1: Sidecar DB (skip if cwd missing or circuit open)
  let validatedCwd: string | undefined;
  if (opts.cwd) {
    try {
      validatedCwd = validateCwd(opts.cwd);
    } catch {
      // Invalid diagnostic context must not create persistent project state.
    }
  }
  if (validatedCwd && !dbCircuitOpen) {
    try {
      ensureProjectDir(validatedCwd);
      const db = new EventsDb(eventsDbPath(validatedCwd));
      try {
        db.logHookError(hook, error, opts.sessionId);
      } finally {
        db.close();
      }
      return;
    } catch {
      dbCircuitOpen = true; // skip DB on subsequent calls this process
    }
  }

  // Layer 2: Flat file (include cwd for diagnosing DB-skip cases)
  try {
    const logPath = getLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify({
      ts: new Date().toISOString(),
      hook,
      error: error instanceof Error ? error.message : String(error),
      session_id: opts.sessionId,
      cwd: opts.cwd,
    }) + "\n");
    return;
  } catch { /* file failed — fall through */ }

  // Layer 3: Swallow silently — hooks must never crash
}
