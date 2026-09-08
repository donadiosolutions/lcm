import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertPrivateDirectory, copyRegularFilePrivateExclusive, openPrivateDirectory, openPrivateDirectoryIfExists } from "../security-files.js";

type FileWitness = Readonly<{ device: number; inode: number; metadata: string; sha256: string }>;

function witness(path: string): FileWitness | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    const metadata = (stat: typeof before): string =>
      `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (!before.isFile() || before.nlink !== 1n || before.size > 8n * 1024n * 1024n * 1024n
      || ((before.mode & 0o777n) !== 0o600n && (before.mode & 0o777n) !== 0o400n)
      || (process.getuid !== undefined && before.uid !== BigInt(process.getuid()))) {
      throw new Error("outbox schema source is not a private regular file");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) !== 0) hash.update(buffer.subarray(0, count));
    if (metadata(before) !== metadata(fstatSync(fd, { bigint: true }))
      || metadata(before) !== metadata(lstatSync(path, { bigint: true }))) {
      throw new Error("outbox schema source changed");
    }
    return { device: Number(before.dev), inode: Number(before.ino), metadata: metadata(before), sha256: hash.digest("hex") };
  } finally { closeSync(fd); }
}

/** Validate WAL-aware schema using private copies before any writable source open. */
export function readCurrentLocalHookOutboxIdentity(
  dbPath: string,
  schemaVersion: number,
): Readonly<{ device: number; inode: number }> | null {
  const parent = openPrivateDirectoryIfExists(dirname(dbPath));
  if (parent === undefined) return null;
  try {
    const paths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`];
    const before = paths.map(witness);
    if (before[0] === null) return null;
    if (before[3] !== null) throw new Error("outbox schema preflight refuses a rollback journal");
    const scratch = mkdtempSync(join(tmpdir(), "lcm-outbox-schema-"));
    const scratchHandle = openPrivateDirectory(scratch);
    try {
      const copy = join(scratch, "outbox.sqlite");
      for (const [index, destination] of [copy, `${copy}-wal`].entries()) {
        const source = before[index];
        if (source === null) continue;
        if (!copyRegularFilePrivateExclusive(paths[index]!, destination, { allowedRoot: dirname(dbPath) })
          || witness(destination)!.sha256 !== source!.sha256) throw new Error("outbox schema copy changed");
      }
      const database = new DatabaseSync(copy);
      try {
        const rows = database.prepare("SELECT version FROM schema_version LIMIT 2").all();
        if (rows.length !== 1 || rows[0]!.version !== schemaVersion) {
          throw new Error("events database schema is not current during migration maintenance");
        }
      } finally { database.close(); }
      assertPrivateDirectory(parent, dirname(dbPath), parent.witness);
      if (JSON.stringify(paths.map(witness)) !== JSON.stringify(before)) throw new Error("outbox schema source changed");
      return { device: before[0]!.device, inode: before[0]!.inode };
    } finally {
      try {
        assertPrivateDirectory(scratchHandle, scratch, scratchHandle.witness);
        rmSync(scratch, { recursive: true, force: true });
      } finally { scratchHandle.close(); }
    }
  } finally { parent.close(); }
}
