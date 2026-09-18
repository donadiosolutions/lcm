import {
  chmodSync,
  mkdtempSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureExistingLcmSnapshot,
  closeLcmConnection,
  SQLITE_PREVIEW_SNAPSHOT_ERROR,
} from "../../src/db/connection.js";

// Mutating the real node:fs export object (rather than mocking the ESM named
// imports connection.ts uses) lets us inject filesystem faults at exact
// points inside the SQLite preview pipeline while every other caller in the
// process keeps using the real filesystem. syncBuiltinESMExports() is
// required after each mutation so the live ESM bindings observe the change.
const mutableFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;

function withBuiltinFsOverride<T>(
  name: string,
  replacement: unknown,
  operation: () => T,
): T {
  const original = mutableFs[name];
  mutableFs[name] = replacement;
  syncBuiltinESMExports();
  try {
    return operation();
  } finally {
    mutableFs[name] = original;
    syncBuiltinESMExports();
  }
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function causeOf(error: unknown): unknown {
  return error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
}

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("captureExistingLcmSnapshot chunked copy and digest boundaries", () => {
  it("captures and revalidates a database file larger than one preview copy chunk", () => {
    const dir = makeTempDir("lcm-conn-preview-large-");
    const dbPath = join(dir, "test.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("CREATE TABLE blob_probe (data BLOB)");
    // Larger than SQLITE_PREVIEW_COPY_CHUNK (1 MiB) so both the copy and the
    // post-copy digest loops take at least one full chunk plus a remainder.
    const bigBlob = Buffer.alloc(1_572_864, 0x41);
    db.prepare("INSERT INTO blob_probe (data) VALUES (?)").run(bigBlob);
    db.close();

    const snapshotRoot = makeTempDir("lcm-conn-preview-large-snap-");
    chmodSync(snapshotRoot, 0o700);
    const snapshot = captureExistingLcmSnapshot(dbPath, {
      _snapshotForTesting: { tempRoot: snapshotRoot },
    });
    expect(snapshot).not.toBeNull();
    if (snapshot === null) throw new Error("expected a snapshot for a large database");
    try {
      const row = snapshot.db.prepare("SELECT length(data) AS len FROM blob_probe").get() as {
        len: number;
      };
      expect(row.len).toBe(bigBlob.length);
    } finally {
      snapshot.close();
    }
  });
});

describe("captureExistingLcmSnapshot rollback-journal main-file safety checks", () => {
  it("refuses a journal sidecar next to a main file too small to hold a WAL header", () => {
    const dir = makeTempDir("lcm-conn-preview-tiny-journal-");
    const dbPath = join(dir, "test.sqlite");
    writeFileSync(dbPath, "");
    writeFileSync(`${dbPath}-journal`, "stale-journal");
    const snapshotRoot = makeTempDir("lcm-conn-preview-tiny-journal-snap-");
    chmodSync(snapshotRoot, 0o700);

    expect(() => captureExistingLcmSnapshot(dbPath, {
      _snapshotForTesting: { tempRoot: snapshotRoot },
    })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
  });

  it("treats a short WAL-header read on a rollback-journal database as an unsafe drift", () => {
    const dir = makeTempDir("lcm-conn-preview-short-header-");
    const dbPath = join(dir, "test.sqlite");
    writeFileSync(dbPath, Buffer.alloc(64, 0x00));
    writeFileSync(`${dbPath}-journal`, "stale-journal");
    const snapshotRoot = makeTempDir("lcm-conn-preview-short-header-snap-");
    chmodSync(snapshotRoot, 0o700);
    const attempts: number[] = [];

    expect(() => captureExistingLcmSnapshot(dbPath, {
      _snapshotForTesting: {
        tempRoot: snapshotRoot,
        beforeAttempt: ({ attempt }) => attempts.push(attempt),
        read: (fd, buffer, offset, length, position) => {
          if (length === 20 && position === 0) {
            return readSync(fd, buffer, offset, 5, position);
          }
          return readSync(fd, buffer, offset, length, position);
        },
      },
    })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
    expect(attempts).toEqual([1, 2, 3]);
  });
});

describe("captureExistingLcmSnapshot revalidation and admission failures", () => {
  it("treats a source database renamed away after copy as a retryable drift that exhausts to a preview error", () => {
    const dir = makeTempDir("lcm-conn-preview-vanish-");
    const dbPath = join(dir, "test.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("CREATE TABLE t (v INTEGER)");
    db.exec("INSERT INTO t VALUES (1)");
    db.close();
    const snapshotRoot = makeTempDir("lcm-conn-preview-vanish-snap-");
    chmodSync(snapshotRoot, 0o700);
    let renamed = false;

    // Rename (rather than remove) so the retained descriptor still reports
    // nlink 1 and passes validateSqlitePreviewSourceFile; only the original
    // pathname used by revalidateSqlitePreviewFile becomes unreachable,
    // isolating the lstat ENOENT drift branch from the unlink/nlink one.
    expect(() => captureExistingLcmSnapshot(dbPath, {
      _snapshotForTesting: {
        tempRoot: snapshotRoot,
        afterCopy: () => {
          if (!renamed) {
            renamed = true;
            renameSync(dbPath, `${dbPath}.moved`);
          }
        },
      },
    })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
    expect(renamed).toBe(true);
  });

  it("rethrows a non-ENOENT parent authentication failure instead of treating it as absence", () => {
    const dir = makeTempDir("lcm-conn-preview-loose-parent-");
    chmodSync(dir, 0o755);
    const dbPath = join(dir, "test.sqlite");
    writeFileSync(dbPath, "");

    expect(() => captureExistingLcmSnapshot(dbPath)).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
  });

  it("rethrows a non-drift failure discovered while recovering from a mid-open WAL disappearance", () => {
    const dir = makeTempDir("lcm-conn-preview-wal-corrupt-");
    const dbPath = join(dir, "test.sqlite");
    const writer = new DatabaseSync(dbPath);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    writer.exec("CREATE TABLE probe (value TEXT NOT NULL)");
    writer.exec("INSERT INTO probe (value) VALUES ('wal-only')");
    const snapshotRoot = makeTempDir("lcm-conn-preview-wal-corrupt-snap-");
    chmodSync(snapshotRoot, 0o700);

    const originalOpen = mutableFs.openSync as (...args: unknown[]) => number;
    const walLeaf = `${basename(dbPath)}-wal`;
    let injected = false;
    const replacement = (...args: unknown[]): number => {
      const path = String(args[0]);
      if (!injected && path.startsWith("/proc/self/fd/") && path.endsWith(`/${walLeaf}`)) {
        injected = true;
        // Flip on the sticky bit so the recovery path's revalidation of the
        // still-open main handle fails validateSqlitePreviewSourceFile with
        // something other than a retryable drift.
        chmodSync(dbPath, 0o1600);
        throw Object.assign(new Error("injected WAL open failure"), { code: "ENOENT" });
      }
      return Reflect.apply(originalOpen, mutableFs, args) as number;
    };

    try {
      withBuiltinFsOverride("openSync", replacement, () => {
        expect(() => captureExistingLcmSnapshot(dbPath, {
          _snapshotForTesting: { tempRoot: snapshotRoot },
        })).toThrow(SQLITE_PREVIEW_SNAPSHOT_ERROR);
      });
      expect(injected).toBe(true);
    } finally {
      writer.close();
    }
  });
});

describe("captureExistingLcmSnapshot cleanup-failure aggregation", () => {
  it("propagates a private preview directory close failure directly when no other cleanup error occurs", () => {
    const dir = makeTempDir("lcm-conn-preview-close-fail-");
    const dbPath = join(dir, "test.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("CREATE TABLE t (v INTEGER)");
    db.close();
    const snapshotRoot = makeTempDir("lcm-conn-preview-close-fail-snap-");
    chmodSync(snapshotRoot, 0o700);

    const originalOpen = mutableFs.openSync as (...args: unknown[]) => number;
    const originalClose = mutableFs.closeSync as (...args: unknown[]) => void;
    let previewFd: number | undefined;
    let injected = false;
    const openReplacement = (...args: unknown[]): number => {
      const fd = Reflect.apply(originalOpen, mutableFs, args) as number;
      const path = String(args[0]);
      if (previewFd === undefined && basename(path).startsWith("lcm-sqlite-preview-")) {
        previewFd = fd;
      }
      return fd;
    };
    const closeReplacement = (...args: unknown[]): void => {
      const fd = args[0] as number;
      if (!injected && fd === previewFd) {
        injected = true;
        throw new Error("injected private preview directory close failure");
      }
      Reflect.apply(originalClose, mutableFs, args);
    };

    withBuiltinFsOverride("openSync", openReplacement, () => {
      withBuiltinFsOverride("closeSync", closeReplacement, () => {
        const snapshot = captureExistingLcmSnapshot(dbPath, {
          _snapshotForTesting: { tempRoot: snapshotRoot },
        });
        expect(snapshot).not.toBeNull();
        if (snapshot === null) throw new Error("expected a snapshot");
        expect(previewFd).not.toBeUndefined();
        expect(() => snapshot.close()).toThrow("injected private preview directory close failure");
        expect(injected).toBe(true);
      });
    });
  });

  it("aggregates an unexpected-entry cleanup failure with a directory close failure and the original error", () => {
    const dir = makeTempDir("lcm-conn-preview-combined-cleanup-");
    const dbPath = join(dir, "test.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("CREATE TABLE t (v INTEGER)");
    db.close();
    const snapshotRoot = makeTempDir("lcm-conn-preview-combined-cleanup-snap-");
    chmodSync(snapshotRoot, 0o700);

    const originalOpen = mutableFs.openSync as (...args: unknown[]) => number;
    const originalClose = mutableFs.closeSync as (...args: unknown[]) => void;
    let previewFd: number | undefined;
    let closeInjected = false;
    const openReplacement = (...args: unknown[]): number => {
      const fd = Reflect.apply(originalOpen, mutableFs, args) as number;
      const path = String(args[0]);
      if (previewFd === undefined && basename(path).startsWith("lcm-sqlite-preview-")) {
        previewFd = fd;
      }
      return fd;
    };
    const closeReplacement = (...args: unknown[]): void => {
      const fd = args[0] as number;
      if (!closeInjected && fd === previewFd) {
        closeInjected = true;
        throw new Error("injected combined-failure directory close failure");
      }
      Reflect.apply(originalClose, mutableFs, args);
    };

    let caught: unknown;
    withBuiltinFsOverride("openSync", openReplacement, () => {
      withBuiltinFsOverride("closeSync", closeReplacement, () => {
        try {
          captureExistingLcmSnapshot(dbPath, {
            _snapshotForTesting: {
              tempRoot: snapshotRoot,
              afterCopy: (input) => {
                // Force a post-copy membership drift in the source directory
                // (the original error) while also leaving an unexpected
                // entry inside the private preview directory so its own
                // cleanup fails too, on top of the injected close failure.
                writeFileSync(`${dbPath}-journal`, "late-sidecar");
                symlinkSync(dbPath, join(dirname(input.snapshotPath), "sneaky-link"));
              },
            },
          });
        } catch (error) {
          caught = error;
        }
      });
    });

    expect(closeInjected).toBe(true);
    expect(messageOf(caught)).toBe(SQLITE_PREVIEW_SNAPSHOT_ERROR);
    expect(causeOf(caught)).toBeInstanceOf(AggregateError);
  });

  it("aggregates a parent-close failure with a distinct preview cleanup failure after a successful capture", () => {
    const dir = makeTempDir("lcm-conn-preview-success-double-cleanup-");
    const dbPath = join(dir, "test.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("CREATE TABLE t (v INTEGER)");
    db.close();
    const snapshotRoot = makeTempDir("lcm-conn-preview-success-double-cleanup-snap-");
    chmodSync(snapshotRoot, 0o700);

    const originalOpen = mutableFs.openSync as (...args: unknown[]) => number;
    const originalClose = mutableFs.closeSync as (...args: unknown[]) => void;
    let parentFd: number | undefined;
    let parentCloseInjected = false;
    const openReplacement = (...args: unknown[]): number => {
      const fd = Reflect.apply(originalOpen, mutableFs, args) as number;
      const path = String(args[0]);
      if (parentFd === undefined && path === dir) {
        parentFd = fd;
      }
      return fd;
    };
    const closeReplacement = (...args: unknown[]): void => {
      const fd = args[0] as number;
      if (!parentCloseInjected && fd === parentFd) {
        parentCloseInjected = true;
        throw new Error("injected parent directory close failure");
      }
      Reflect.apply(originalClose, mutableFs, args);
    };

    let caught: unknown;
    withBuiltinFsOverride("openSync", openReplacement, () => {
      withBuiltinFsOverride("closeSync", closeReplacement, () => {
        try {
          captureExistingLcmSnapshot(dbPath, {
            _snapshotForTesting: {
              tempRoot: snapshotRoot,
              afterCopy: (input) => {
                // An unexpected sibling inside the (already successfully
                // populated) private preview directory that only breaks the
                // preview directory's own cleanup, not the source capture.
                symlinkSync(dbPath, join(dirname(input.snapshotPath), "sneaky-link"));
              },
            },
          });
        } catch (error) {
          caught = error;
        }
      });
    });

    expect(parentCloseInjected).toBe(true);
    expect(messageOf(caught)).toBe(SQLITE_PREVIEW_SNAPSHOT_ERROR);
    const cause = causeOf(caught);
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toHaveLength(2);
  });

  it("wraps a preview database open failure together with its own cleanup failure", () => {
    const dir = makeTempDir("lcm-conn-preview-open-fail-");
    const dbPath = join(dir, "test.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("CREATE TABLE t (v INTEGER)");
    db.close();
    const snapshotRoot = makeTempDir("lcm-conn-preview-open-fail-snap-");
    chmodSync(snapshotRoot, 0o700);
    const openFailure = new Error("injected preview database open failure");

    let caught: unknown;
    try {
      captureExistingLcmSnapshot(dbPath, {
        _snapshotForTesting: {
          tempRoot: snapshotRoot,
          afterCopy: (input) => {
            symlinkSync(dbPath, join(dirname(input.snapshotPath), "sneaky-link"));
          },
          openDatabase: () => {
            throw openFailure;
          },
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(messageOf(caught)).toBe(SQLITE_PREVIEW_SNAPSHOT_ERROR);
    const cause = causeOf(caught);
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toContain(openFailure);
  });
});
