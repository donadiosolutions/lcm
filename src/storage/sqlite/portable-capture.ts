import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { PortableTransferError, normalizePortableTransferError } from "../portable-transfer.js";

export interface CapturedSqliteAuthority {
  /** Force the bounded full-file digest at final verification. */
  checkSync(forceHash?: boolean): void;
  check(signal?: AbortSignal, forceHash?: boolean): Promise<void>;
}

function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PortableTransferError("aborted", true);
}
function changed(): never {
  throw new PortableTransferError("source-changed");
}
function identity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.uid}:${stat.gid}:${stat.mode}`;
}
function version(stat: BigIntStats): string {
  return `${identity(stat)}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function hasEntry(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function inspect(path: string): { file: BigIntStats; parent: BigIntStats } {
  const file = lstatSync(path, { bigint: true });
  const parent = lstatSync(dirname(path), { bigint: true });
  if (!file.isFile() || !parent.isDirectory()
    || file.uid !== BigInt(process.getuid!()) || (file.mode & 0o077n) !== 0n
    || parent.uid !== file.uid || (parent.mode & 0o077n) !== 0n
    || realpathSync(path) !== path || hasEntry(`${path}-wal`) || hasEntry(`${path}-shm`)) changed();
  return { file, parent };
}

/**
 * Capture authentication is source-lifetime scoped. Every operation checks file
 * identity and nanosecond change timestamps; only admission, a metadata change,
 * and explicit final verification read the full file. Reads have bounded memory.
 * The caller revokes the source when any check fails.
 */
export function createCapturedSqliteAuthority(path: string, expectedSha256: string): CapturedSqliteAuthority {
  try {
    if (resolve(path) !== path || !/^[a-f0-9]{64}$/.test(expectedSha256)) changed();
    const initial = inspect(path);
    let authenticatedVersion: string | undefined;
    function inspectCurrent(): BigIntStats {
      const current = inspect(path);
      if (identity(current.file) !== identity(initial.file)
        || identity(current.parent) !== identity(initial.parent)) changed();
      return current.file;
    }
    function finish(before: BigIntStats, descriptor: BigIntStats, digest: string): void {
      if (version(before) !== version(descriptor) || version(before) !== version(inspectCurrent())
        || digest !== expectedSha256) changed();
      authenticatedVersion = version(before);
    }
    return {
      checkSync(forceHash = false): void {
        try {
          const before = inspectCurrent();
          if (!forceHash && authenticatedVersion === version(before)) return;
          const fd = openSync(path, "r");
          try {
            if (version(fstatSync(fd, { bigint: true })) !== version(before)) changed();
            const hash = createHash("sha256");
            const buffer = Buffer.alloc(64 * 1024);
            let count: number;
            while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
            finish(before, fstatSync(fd, { bigint: true }), hash.digest("hex"));
          } finally { closeSync(fd); }
        } catch (error) { throw normalizePortableTransferError(error, "source-changed"); }
      },
      async check(signal?: AbortSignal, forceHash = false): Promise<void> {
        try {
          abort(signal);
          const before = inspectCurrent();
          if (!forceHash && authenticatedVersion === version(before)) return;
          const file = await open(path, "r");
          try {
            abort(signal);
            if (version(await file.stat({ bigint: true })) !== version(before)) changed();
            const hash = createHash("sha256");
            const buffer = Buffer.alloc(64 * 1024);
            for (;;) {
              abort(signal);
              const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
              abort(signal);
              if (bytesRead === 0) break;
              hash.update(buffer.subarray(0, bytesRead));
            }
            const after = await file.stat({ bigint: true });
            abort(signal);
            finish(before, after, hash.digest("hex"));
          } finally { await file.close(); }
        } catch (error) { throw normalizePortableTransferError(error, "source-changed"); }
      },
    };
  } catch (error) { throw normalizePortableTransferError(error, "source-changed"); }
}

/** Existing-only immutable URI skips WAL recovery and never creates WAL/SHM. */
export function openCapturedSqliteDatabase(path: string): DatabaseSync {
  try {
    inspect(path);
    const uri = pathToFileURL(path);
    uri.search = "?immutable=1&mode=ro";
    return new DatabaseSync(uri.href, { readOnly: true });
  } catch (error) { throw normalizePortableTransferError(error, "source-changed"); }
}
