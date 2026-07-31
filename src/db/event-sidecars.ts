import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { eventsDir } from "./events-path.js";
import { projectsDir } from "../runtime-paths.js";
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

function pruneSidecarFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

export async function collectEventSidecars(options: EventSidecarScanOptions = {}): Promise<EventSidecarSummary[]> {
  const dir = eventsDir();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxDbs = options.maxDbs ?? DEFAULT_MAX_DBS;
  const pruneOrphans = options.pruneOrphanSidecars ?? true;
  const pruneOlderThanDays = options.pruneOrphanSidecarsOlderThanDays ?? DEFAULT_PRUNE_ORPHAN_SIDECAR_AGE_DAYS;
  const deadline = Date.now() + timeoutMs;

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter(f => f.endsWith(".db"))
      .filter((file) => {
        const match = PROJECT_HASH_SIDECAR_RE.exec(file);
        return !match
          || !isWorktreeReconciliationFence(join(dir, file), match[1]!, "events");
      })
      .sort((a, b) => a.localeCompare(b));
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
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("sidecar path is not a regular file");
      }
      const outboxFactory = new SQLiteLocalHookOutboxFactory();
      const db = await outboxFactory.open(path, { busyTimeoutMs: 500 });
      let summary: EventSidecarSummary;
      try {
        const stats = await db.getHealthStats();
        const cwd = readCwdForProject(projectId);
        const recentErrors = options.includeRecentErrors
          ? (await db.getRecentErrors({ limit: 5 })).map(({ created_at, hook, error }) => ({
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
        await outboxFactory.close();
      }
      const pruneReason = pruneOrphans ? orphanPruneReason(summary, pruneOlderThanDays) : undefined;
      if (pruneReason) {
        pruneSidecarFiles(path);
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
    }
  }

  return sidecars;
}
