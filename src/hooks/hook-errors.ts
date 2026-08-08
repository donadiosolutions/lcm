// src/hooks/hook-errors.ts
import { eventsDbPath } from "../db/events-path.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { lcmHomeDir, lcmPath } from "../runtime-paths.js";
import { ensureProjectDir } from "../daemon/project.js";
import { validateCwd } from "../daemon/validate-cwd.js";
import { SQLiteLocalHookOutboxFactory } from "../storage/local-hook-outbox.js";
import {
  assertPrivateDirectory,
  openPrivateDirectory,
  type PrivateDirectoryHandle,
  type PrivateDirectoryWitness,
} from "../security-files.js";
import { sanitizeHookErrorDiagnostic } from "./hook-error-diagnostic.js";

function assertStableRoot(
  handle: PrivateDirectoryHandle,
  path: string,
  expected: PrivateDirectoryWitness,
): void {
  const actual = assertPrivateDirectory(handle, path);
  // Error logging may create child directories; nlink is therefore expected
  // to change, while root identity and ownership/security evidence are not.
  if (
    actual.mode !== expected.mode
    || actual.uid !== expected.uid
    || actual.gid !== expected.gid
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
  ) {
    throw new Error("private directory witness changed");
  }
}

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
export async function safeLogError(
  hook: string,
  error: unknown,
  opts: { cwd?: string; sessionId?: string },
): Promise<void> {
  // Error reporting must not become another hook-side root bootstrap path.
  // If bootstrap/install has not established ~/.lcm, there is nowhere safe
  // to persist a diagnostic and the fail-safe outcome is to return silently.
  const rootPath = lcmHomeDir();
  let rootHandle: ReturnType<typeof openPrivateDirectory>;
  try {
    rootHandle = openPrivateDirectory(rootPath);
  } catch {
    return;
  }
  const rootWitness = rootHandle.witness;

  try {
    try {
      assertStableRoot(rootHandle, rootPath, rootWitness);
    } catch {
      return;
    }

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
        assertStableRoot(rootHandle, rootPath, rootWitness);
        ensureProjectDir(validatedCwd);
        assertStableRoot(rootHandle, rootPath, rootWitness);
        const outboxFactory = new SQLiteLocalHookOutboxFactory();
        const db = await outboxFactory.open(eventsDbPath(validatedCwd));
        try {
          await db.logHookError(hook, error, opts.sessionId);
        } finally {
          await outboxFactory.close();
        }
        assertStableRoot(rootHandle, rootPath, rootWitness);
        return;
      } catch {
        try {
          assertStableRoot(rootHandle, rootPath, rootWitness);
        } catch {
          return;
        }
        dbCircuitOpen = true; // skip DB on subsequent calls this process
      }
    }

    // Layer 2: Flat file (include cwd for diagnosing DB-skip cases)
    try {
      assertStableRoot(rootHandle, rootPath, rootWitness);
      const logPath = getLogPath();
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, JSON.stringify({
        ts: new Date().toISOString(),
        hook,
        error: sanitizeHookErrorDiagnostic(error),
        session_id: opts.sessionId,
        cwd: opts.cwd,
      }) + "\n");
      assertStableRoot(rootHandle, rootPath, rootWitness);
      return;
    } catch {
      try {
        assertStableRoot(rootHandle, rootPath, rootWitness);
      } catch {
        return;
      }
      /* file failed — fall through */
    }

    // Layer 3: Swallow silently — hooks must never crash
  } finally {
    rootHandle.close();
  }
}
