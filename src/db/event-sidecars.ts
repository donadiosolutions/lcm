import { lstatSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_PROJECT_METADATA_BYTES } from "../daemon/project.js";
import { readDiagnosticSqlite, withDiagnosticSqliteSession } from "./diagnostic-sqlite.js";
import { sanitizeHookErrorDiagnostic } from "../hooks/hook-error-diagnostic.js";
import { eventsDir } from "./events-path.js";
import { projectsDir } from "../runtime-paths.js";
import {
  assertPrivateDirectory,
  assertPrivateDirectoryEntry,
  openPrivateDirectoryIfExists,
  readBoundedRegularFile,
  PrivateDirectoryTopologyError,
  type PrivateDirectoryHandle,
  type PrivateDirectoryWitness,
} from "../security-files.js";
import { SQLiteLocalHookOutboxFactory, type LocalHookOutboxHealth, type LocalHookErrorRecord } from "../storage/local-hook-outbox.js";
import { isWorktreeReconciliationFence } from "../worktree-reconciliation-fence.js";

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
  deliveryPending: number;
  deliveryClaimed: number;
  deliveryRetry: number;
  deliveryReplicated: number;
  deliveryAcknowledged: number;
  deliveryAwaitingRemotePrune: number;
  deliveryQuarantined: number;
  oldestDeliveryAt: string | null;
  recentErrors?: Array<{ created_at: string; hook: string; error: string }>;
  scanError?: string;
  scanSkipped?: string;
  /** Number of sidecar files represented by a bounded skipped summary. */
  scanSkippedCount?: number;
  pruned?: boolean;
  pruneReason?: string;
}

export interface EventSidecarScanOptions {
  homeDir?: string;
  /** A local project identity hash, never a filesystem path or backend UUID. */
  projectId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxDbs?: number;
  startIndex?: number;
  includeRecentErrors?: boolean;
  pruneOrphanSidecars?: boolean;
  pruneOrphanSidecarsOlderThanDays?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_DBS = 50;
const DEFAULT_PRUNE_ORPHAN_SIDECAR_AGE_DAYS = 30;
const PROJECT_HASH_SIDECAR_RE = /^([a-f0-9]{64})\.db$/u;

type StablePrivateDirectoryWitness = Readonly<Omit<PrivateDirectoryWitness, "nlink">>;

class EventSidecarParentChangedError extends Error {}

class EventSidecarScanStoppedError extends Error {}

function sidecarDirectoryFailure(error: unknown): Error {
  let source = error;
  while (source instanceof EventSidecarParentChangedError || source instanceof PrivateDirectoryTopologyError) {
    source = source.cause;
  }
  const code = (source as NodeJS.ErrnoException | null)?.code;
  return Object.assign(new Error("event sidecar directory unavailable"), {
    code: code === "EACCES" || code === "EPERM" ? code : undefined,
  });
}

async function awaitSidecarScan<T>(operation: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    // Attach a rejection handler even if the deadline already elapsed.
    const stopped = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new EventSidecarScanStoppedError("sidecar scan cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => reject(new EventSidecarScanStoppedError("sidecar scan skipped after timeout")), Math.max(0, deadline - Date.now()));
      if (signal?.aborted) onAbort();
      else if (Date.now() >= deadline) reject(new EventSidecarScanStoppedError("sidecar scan skipped after timeout"));
    });
    return await Promise.race([stopped, operation]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort!);
  }
}

/** Diagnostic reads never enter the pooled EventsDb migration/creation path. */
function readOnlySidecarFactory(
  path: string,
  expected: NonNullable<ReturnType<typeof lstatSync>>,
  options: EventSidecarScanOptions,
  deadline: number,
  parent: PrivateDirectoryHandle,
  parentPath: string,
) {
  return {
    async open(_path: string, _options: { busyTimeoutMs: number }) {
      const statements: { sql: string; mode: "get" | "all" }[] = [{
        mode: "get",
        sql: `
          SELECT COUNT(*) AS totalEvents, MAX(created_at) AS lastCapture,
            COUNT(*) FILTER (WHERE processed_at IS NULL) AS unprocessed,
            COUNT(*) FILTER (WHERE delivery_state = 'pending') AS deliveryPending,
            COUNT(*) FILTER (WHERE delivery_state = 'claimed') AS deliveryClaimed,
            COUNT(*) FILTER (WHERE delivery_state = 'retry') AS deliveryRetry,
            COUNT(*) FILTER (WHERE delivery_state = 'replicated') AS deliveryReplicated,
            COUNT(*) FILTER (WHERE delivery_state = 'acknowledged') AS deliveryAcknowledged,
            COUNT(*) FILTER (WHERE delivery_state = 'acknowledged' AND remote_inbox_id IS NOT NULL AND remote_pruned_at IS NULL) AS deliveryAwaitingRemotePrune,
            COUNT(*) FILTER (WHERE delivery_state = 'quarantined') AS deliveryQuarantined,
            MIN(created_at) FILTER (WHERE delivery_state <> 'acknowledged') AS oldestDeliveryAt
          FROM events
        `,
      }, {
        mode: "get",
        sql: `
          SELECT COUNT(*) AS errors, MAX(created_at) AS lastError FROM error_log
          WHERE hook NOT LIKE 'maintenance:%' AND created_at >= datetime('now', '-30 days')
        `,
      }];
      if (options.includeRecentErrors) statements.push({
        mode: "all",
        sql: `
          SELECT created_at, hook, error FROM error_log WHERE hook NOT LIKE 'maintenance:%'
          ORDER BY id DESC LIMIT 5
        `,
      });
      const rows = await readDiagnosticSqlite({
        path, statements, signal: options.signal,
        timeoutMs: Math.max(1, deadline - Date.now()),
        expected: { device: BigInt(expected.dev), inode: BigInt(expected.ino) },
        parents: [{ path: parentPath, fd: parent.fd, device: BigInt(parent.witness.dev), inode: BigInt(parent.witness.ino) }],
      });
      return {
        async getHealthStats(): Promise<LocalHookOutboxHealth> {
          const totals = rows[0] as Omit<LocalHookOutboxHealth, "errors" | "lastError">;
          const errors = rows[1] as { errors: number; lastError: string | null };
          return { ...totals, ...errors };
        },
        async getRecentErrors(_options: { limit: number }): Promise<LocalHookErrorRecord[]> {
          return (rows[2] as LocalHookErrorRecord[])
            .map(row => ({ ...row, error: sanitizeHookErrorDiagnostic(row.error) }));
        },
      };
    },
    async close() { /* The isolated reader owns and closes its connection. */ },
  };
}

function stablePrivateDirectoryWitness(
  witness: PrivateDirectoryWitness,
): StablePrivateDirectoryWitness {
  return {
    mode: witness.mode,
    uid: witness.uid,
    gid: witness.gid,
    dev: witness.dev,
    ino: witness.ino,
  };
}

function assertEventSidecarParent(
  handle: PrivateDirectoryHandle,
  path: string,
  expected: StablePrivateDirectoryWitness,
): void {
  try {
    assertPrivateDirectoryEntry(handle, path, expected.uid);
    const actual = stablePrivateDirectoryWitness(
      assertPrivateDirectory(handle, path, undefined, expected.uid),
    );
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("event sidecar parent witness changed");
    }
  } catch (error) {
    throw new EventSidecarParentChangedError(
      "event sidecar parent changed during scan",
      { cause: error },
    );
  }
}

async function awaitWithEventSidecarParent<T>(
  operation: () => Promise<T>,
  handle: PrivateDirectoryHandle,
  path: string,
  expected: StablePrivateDirectoryWitness,
): Promise<T> {
  assertEventSidecarParent(handle, path, expected);
  try {
    return await operation();
  } finally {
    assertEventSidecarParent(handle, path, expected);
  }
}

function readCwdForProject(projectId: string, homeDir?: string): string | undefined {
  const metaPath = join(projectsDir(homeDir), projectId, "meta.json");
  try {
    const parsed = JSON.parse(readBoundedRegularFile(metaPath, {
      allowedRoot: dirname(metaPath),
      maxBytes: MAX_PROJECT_METADATA_BYTES,
      expectedUid: process.getuid?.(),
      requireSingleLink: true,
    })) as { cwd?: unknown };
    return typeof parsed.cwd === "string" && parsed.cwd.length > 0 ? parsed.cwd : undefined;
  } catch {
    return undefined;
  }
}

function failedSidecarSummary(
  file: string,
  path: string,
  scanError: string,
  homeDir?: string,
): EventSidecarSummary {
  const projectId = file.slice(0, -".db".length);
  const cwd = readCwdForProject(projectId, homeDir);
  return {
    file,
    projectId,
    path,
    cwd,
    metadataMissing: cwd === undefined,
    captured: 0,
    unprocessed: 0,
    errors: 0,
    lastCapture: null,
    deliveryPending: 0,
    deliveryClaimed: 0,
    deliveryRetry: 0,
    deliveryReplicated: 0,
    deliveryAcknowledged: 0,
    deliveryAwaitingRemotePrune: 0,
    deliveryQuarantined: 0,
    oldestDeliveryAt: null,
    scanError,
  };
}

function skippedSidecarSummary(
  file: string,
  path: string,
  scanSkipped: string,
  scanSkippedCount: number,
): EventSidecarSummary {
  const projectId = file.slice(0, -".db".length);
  return {
    file,
    projectId,
    path,
    metadataMissing: false,
    captured: 0,
    unprocessed: 0,
    errors: 0,
    lastCapture: null,
    deliveryPending: 0,
    deliveryClaimed: 0,
    deliveryRetry: 0,
    deliveryReplicated: 0,
    deliveryAcknowledged: 0,
    deliveryAwaitingRemotePrune: 0,
    deliveryQuarantined: 0,
    oldestDeliveryAt: null,
    scanSkipped,
    scanSkippedCount,
  };
}

function parseSqliteDate(value: string): number | undefined {
  const parsed = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function orphanPruneReason(summary: EventSidecarSummary, olderThanDays: number): string | undefined {
  if (
    !summary.metadataMissing
    || summary.unprocessed > 0
    || summary.errors > 0
    || summary.deliveryPending > 0
    || summary.deliveryClaimed > 0
    || summary.deliveryRetry > 0
    || summary.deliveryReplicated > 0
    || summary.deliveryAwaitingRemotePrune > 0
    || summary.deliveryQuarantined > 0
    || summary.scanError
    || summary.scanSkipped
  ) {
    return undefined;
  }
  if (summary.captured === 0) return "empty orphan sidecar";

  // A non-empty sidecar is backed by a NOT NULL created_at column, so the
  // aggregate MAX is non-null after the captured === 0 case above.
  const lastCaptureMs = parseSqliteDate(summary.lastCapture!);
  if (lastCaptureMs === undefined) return undefined;
  const ageMs = olderThanDays * 24 * 60 * 60 * 1000;
  if (Date.now() - lastCaptureMs >= ageMs) {
    return `stale orphan sidecar (${olderThanDays}d retention)`;
  }
  return undefined;
}

function pruneSidecarFiles(
  path: string,
  parent: PrivateDirectoryHandle,
  parentPath: string,
  parentWitness: StablePrivateDirectoryWitness,
): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    assertEventSidecarParent(parent, parentPath, parentWitness);
    try {
      rmSync(`${path}${suffix}`, { force: true });
    } finally {
      assertEventSidecarParent(parent, parentPath, parentWitness);
    }
  }
}

export async function collectEventSidecars(options: EventSidecarScanOptions = {}): Promise<EventSidecarSummary[]> {
  if (options.pruneOrphanSidecars !== false) return scanEventSidecars(options);
  const signal = options.signal ?? new AbortController().signal;
  return withDiagnosticSqliteSession(signal, () => scanEventSidecars({...options, signal}));
}

async function scanEventSidecars(options: EventSidecarScanOptions): Promise<EventSidecarSummary[]> {
  if (options.projectId !== undefined && !/^[a-f0-9]{64}$/u.test(options.projectId)) {
    throw new Error("invalid sidecar project ID");
  }
  const dir = eventsDir(options.homeDir);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxDbs = options.maxDbs ?? (options.pruneOrphanSidecars === false ? Number.MAX_SAFE_INTEGER : DEFAULT_MAX_DBS);
  const pruneOrphans = options.pruneOrphanSidecars ?? true;
  const pruneOlderThanDays = options.pruneOrphanSidecarsOlderThanDays ?? DEFAULT_PRUNE_ORPHAN_SIDECAR_AGE_DAYS;
  const deadline = Date.now() + timeoutMs;

  let parent: PrivateDirectoryHandle;
  try {
    const opened = openPrivateDirectoryIfExists(dir);
    if (!opened) return [];
    parent = opened;
  } catch (error) {
    if (!pruneOrphans) throw sidecarDirectoryFailure(error);
    return [];
  }
  const parentWitness = stablePrivateDirectoryWitness(parent.witness);
  try {
    let files: string[];
    try {
      assertEventSidecarParent(parent, dir, parentWitness);
      try {
        files = readdirSync(dir, { withFileTypes: true })
          .filter(entry => entry.name.endsWith(".db")
            && (options.projectId === undefined || entry.name === `${options.projectId}.db`))
          .filter((entry) => {
            const match = PROJECT_HASH_SIDECAR_RE.exec(entry.name);
            if (!match || entry.isFile() || entry.isSymbolicLink()) return true;
            return !isWorktreeReconciliationFence(
              join(dir, entry.name),
              match[1]!,
              "events",
              { _deadlineReached: () => options.signal?.aborted === true || Date.now() >= deadline },
            );
          })
          .map(entry => entry.name)
          .sort((a, b) => a.localeCompare(b));
      } finally {
        assertEventSidecarParent(parent, dir, parentWitness);
      }
    } catch (error) {
      if (!pruneOrphans) throw sidecarDirectoryFailure(error);
      return [];
    }
    if (files.length > 0 && options.startIndex !== undefined) {
      const start = Math.max(0, Math.trunc(options.startIndex)) % files.length;
      files = [...files.slice(start), ...files.slice(0, start)];
    }

    const sidecars: EventSidecarSummary[] = [];
    let scanned = 0;
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const path = join(dir, file);
      if (options.signal?.aborted || scanned >= maxDbs || Date.now() >= deadline) {
        const skippedCount = files.length - index;
        const reason = options.signal?.aborted
          ? "sidecar scan cancelled"
          : scanned >= maxDbs
          ? "sidecar scan skipped after maxDbs limit"
          : "sidecar scan skipped after timeout";
        const skippedFile = files[index];
        sidecars.push(skippedSidecarSummary(
          skippedFile,
          join(dir, skippedFile),
          `${skippedCount} ${skippedCount === 1 ? "sidecar" : "sidecars"} ${reason}`,
          skippedCount,
        ));
        break;
      }
      scanned++;

      const projectId = file.slice(0, -".db".length);
      try {
        assertEventSidecarParent(parent, dir, parentWitness);
        let stat: ReturnType<typeof lstatSync>;
        try {
          stat = lstatSync(path);
        } finally {
          assertEventSidecarParent(parent, dir, parentWitness);
        }
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error("sidecar path is not a regular file");
        }
        const outboxFactory = pruneOrphans
          ? new SQLiteLocalHookOutboxFactory()
          : readOnlySidecarFactory(path, stat, options, deadline, parent, dir);
        let opened = false;
        let summary: EventSidecarSummary;
        try {
          assertEventSidecarParent(parent, dir, parentWitness);
          let db: Awaited<ReturnType<typeof outboxFactory.open>>;
          try {
            const opening = outboxFactory.open(path, { busyTimeoutMs: Math.min(500, Math.max(0, deadline - Date.now())) });
            try {
              db = await awaitSidecarScan<Awaited<ReturnType<typeof outboxFactory.open>>>(
                opening, deadline, options.signal,
              );
            } catch (error) {
              // An injected or future asynchronous opener may finish after the
              // budget. Its factory still owns that late resource.
              void opening.then(() => outboxFactory.close()).catch(() => {});
              throw error;
            }
            opened = true;
          } finally {
            assertEventSidecarParent(parent, dir, parentWitness);
          }
          const stats = await awaitWithEventSidecarParent(
            () => awaitSidecarScan(db.getHealthStats(), deadline, options.signal),
            parent,
            dir,
            parentWitness,
          );
          const cwd = readCwdForProject(projectId, options.homeDir);
          const recentErrors = options.includeRecentErrors
            ? (await awaitWithEventSidecarParent(
              () => awaitSidecarScan(db.getRecentErrors({ limit: 5 }), deadline, options.signal),
              parent,
              dir,
              parentWitness,
            )).map(({ created_at, hook, error }) => ({
              created_at,
              hook,
              error,
            }))
            : undefined;
          summary = {
            file,
            projectId,
            path,
            cwd,
            metadataMissing: cwd === undefined,
            captured: stats.totalEvents,
            unprocessed: stats.unprocessed,
            errors: stats.errors,
            lastCapture: stats.lastCapture,
            deliveryPending: stats.deliveryPending,
            deliveryClaimed: stats.deliveryClaimed,
            deliveryRetry: stats.deliveryRetry,
            deliveryReplicated: stats.deliveryReplicated,
            deliveryAcknowledged: stats.deliveryAcknowledged,
            deliveryAwaitingRemotePrune: stats.deliveryAwaitingRemotePrune,
            deliveryQuarantined: stats.deliveryQuarantined,
            oldestDeliveryAt: stats.oldestDeliveryAt,
            recentErrors,
          };
        } finally {
          if (opened) {
            let beforeCloseError: unknown;
            let closeError: unknown;
            let closeFailed = false;
            let afterCloseError: unknown;
            try {
              assertEventSidecarParent(parent, dir, parentWitness);
            } catch (error) {
              beforeCloseError = error;
            }
            try {
              await awaitSidecarScan(outboxFactory.close(), deadline, options.signal);
            } catch (error) {
              closeFailed = true;
              closeError = error;
            }
            try {
              assertEventSidecarParent(parent, dir, parentWitness);
            } catch (error) {
              afterCloseError = error;
            }
            if (beforeCloseError !== undefined) throw beforeCloseError;
            if (afterCloseError !== undefined) throw afterCloseError;
            if (closeFailed) throw closeError;
          }
        }
        const pruneReason = pruneOrphans ? orphanPruneReason(summary, pruneOlderThanDays) : undefined;
        if (pruneReason) {
          pruneSidecarFiles(path, parent, dir, parentWitness);
          assertEventSidecarParent(parent, dir, parentWitness);
          sidecars.push({ ...summary, pruned: true, pruneReason });
        } else {
          sidecars.push(summary);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (error instanceof EventSidecarScanStoppedError || code === "DIAGNOSTIC_SQLITE_TIMEOUT" || code === "DIAGNOSTIC_SQLITE_ABORTED") {
          const reason = error instanceof EventSidecarScanStoppedError ? error.message
            : code === "DIAGNOSTIC_SQLITE_ABORTED" ? "sidecar scan cancelled" : "sidecar scan skipped after timeout";
          sidecars.push(skippedSidecarSummary(file, path, reason, files.length - index));
          break;
        }
        sidecars.push(failedSidecarSummary(
          file,
          path,
          error instanceof Error ? error.message : "failed to scan sidecar",
          options.homeDir,
        ));
        if (error instanceof EventSidecarParentChangedError || code === "DIAGNOSTIC_SQLITE_IDENTITY") break;
      }
    }

    return sidecars;
  } finally {
    parent.close();
  }
}
