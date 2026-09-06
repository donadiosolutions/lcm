import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { eventsDir } from "./events-path.js";
import { projectsDir } from "../runtime-paths.js";
import {
  assertPrivateDirectory,
  assertPrivateDirectoryEntry,
  openPrivateDirectory,
  type PrivateDirectoryHandle,
  type PrivateDirectoryWitness,
} from "../security-files.js";
import { SQLiteLocalHookOutboxFactory } from "../storage/local-hook-outbox.js";
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
  pruned?: boolean;
  pruneReason?: string;
}

export interface EventSidecarScanOptions {
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
): EventSidecarSummary {
  const projectId = file.slice(0, -".db".length);
  const cwd = readCwdForProject(projectId);
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

function skippedSidecarSummary(file: string, path: string, scanSkipped: string): EventSidecarSummary {
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
  const dir = eventsDir();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxDbs = options.maxDbs ?? DEFAULT_MAX_DBS;
  const pruneOrphans = options.pruneOrphanSidecars ?? true;
  const pruneOlderThanDays = options.pruneOrphanSidecarsOlderThanDays ?? DEFAULT_PRUNE_ORPHAN_SIDECAR_AGE_DAYS;
  const deadline = Date.now() + timeoutMs;

  let parent: PrivateDirectoryHandle;
  try {
    parent = openPrivateDirectory(dir);
  } catch {
    return [];
  }
  const parentWitness = stablePrivateDirectoryWitness(parent.witness);
  try {
    let files: string[];
    try {
      assertEventSidecarParent(parent, dir, parentWitness);
      try {
        files = readdirSync(dir, { withFileTypes: true })
          .filter(entry => entry.name.endsWith(".db"))
          .filter((entry) => {
            const match = PROJECT_HASH_SIDECAR_RE.exec(entry.name);
            if (!match || entry.isFile() || entry.isSymbolicLink()) return true;
            return !isWorktreeReconciliationFence(
              join(dir, entry.name),
              match[1]!,
              "events",
              { _deadlineReached: () => Date.now() >= deadline },
            );
          })
          .map(entry => entry.name)
          .sort((a, b) => a.localeCompare(b));
      } finally {
        assertEventSidecarParent(parent, dir, parentWitness);
      }
    } catch {
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
      if (scanned >= maxDbs || Date.now() >= deadline) {
        const skippedCount = files.length - index;
        const reason = scanned >= maxDbs
          ? "sidecar scan skipped after maxDbs limit"
          : "sidecar scan skipped after timeout";
        const skippedFile = files[index];
        sidecars.push(skippedSidecarSummary(
          skippedFile,
          join(dir, skippedFile),
          `${skippedCount} ${skippedCount === 1 ? "sidecar" : "sidecars"} ${reason}`,
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
        const outboxFactory = new SQLiteLocalHookOutboxFactory();
        let opened = false;
        let summary: EventSidecarSummary;
        try {
          assertEventSidecarParent(parent, dir, parentWitness);
          let db: Awaited<ReturnType<typeof outboxFactory.open>>;
          try {
            db = await outboxFactory.open(path, { busyTimeoutMs: 500 });
            opened = true;
          } finally {
            assertEventSidecarParent(parent, dir, parentWitness);
          }
          const stats = await awaitWithEventSidecarParent(
            () => db.getHealthStats(),
            parent,
            dir,
            parentWitness,
          );
          const cwd = readCwdForProject(projectId);
          const recentErrors = options.includeRecentErrors
            ? (await awaitWithEventSidecarParent(
              () => db.getRecentErrors({ limit: 5 }),
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
              await outboxFactory.close();
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
        sidecars.push(failedSidecarSummary(
          file,
          path,
          error instanceof Error ? error.message : "failed to scan sidecar",
        ));
        if (error instanceof EventSidecarParentChangedError) break;
      }
    }

    return sidecars;
  } finally {
    parent.close();
  }
}
