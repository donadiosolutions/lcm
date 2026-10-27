import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  allocateLocalHookEventSequence,
  allocateLocalHookEventSequences,
  deriveLegacyLocalHookEventUuid,
  formatLocalHookMachineSequence,
  LocalHookEventSequenceAllocator,
  parseLocalHookMachineSequence,
} from "../../src/storage/local-hook-event-sequence.js";
import { isLcmConnectionOpen } from "../../src/db/connection.js";

const MAX_POSTGRESQL_BIGINT = 9_223_372_036_854_775_807n;

describe("local hook event sequence", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function sequencePath(): string {
    const directory = mkdtempSync(join(tmpdir(), "lcm-event-sequence-"));
    directories.push(directory);
    return join(directory, ".machine-sequence.sqlite");
  }

  it("allocates durable, gap-safe installation-global batches", () => {
    const path = sequencePath();
    expect(allocateLocalHookEventSequences(0, path)).toEqual([]);
    expect(allocateLocalHookEventSequence(path)).toBe(0n);
    expect(allocateLocalHookEventSequences(3, path)).toEqual([1n, 2n, 3n]);
    expect(allocateLocalHookEventSequence(path)).toBe(4n);

    const raw = new DatabaseSync(path);
    expect(raw.prepare(
      "SELECT next_sequence FROM local_hook_sequence WHERE singleton = 1",
    ).get()).toEqual({ next_sequence: "5" });
    raw.close();
  });

  it("reuses one initialized allocator while committing every exact allocation", () => {
    const path = sequencePath();
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec");
    const allocator = new LocalHookEventSequenceAllocator(path);
    try {
      expect(allocator.allocateSequences(0)).toEqual([]);
      expect(Array.from(
        { length: 5 },
        () => allocator.allocateSequence(),
      )).toEqual([0n, 1n, 2n, 3n, 4n]);
      expect(isLcmConnectionOpen(path)).toBe(true);

      const sql = execSpy.mock.calls.map(([statement]) => statement);
      expect(sql.filter((statement) =>
        statement.includes("CREATE TABLE IF NOT EXISTS local_hook_sequence")
      )).toHaveLength(1);
      expect(sql.filter((statement) => statement === "BEGIN IMMEDIATE"))
        .toHaveLength(5);
      expect(sql.filter((statement) => statement === "COMMIT")).toHaveLength(5);
    } finally {
      allocator.close();
      allocator.close();
      execSpy.mockRestore();
    }

    expect(isLcmConnectionOpen(path)).toBe(false);
    expect(() => allocator.allocateSequence()).toThrow("allocator is closed");
  });

  it("reads the next cutoff sequence without allocating it", () => {
    const allocatorPath = sequencePath();
    const allocator = new LocalHookEventSequenceAllocator(allocatorPath);
    try {
      expect(allocator.peekNextSequence()).toBe(0n);
      expect(allocator.allocateSequence()).toBe(0n);
      expect(allocator.peekNextSequence()).toBe(1n);
    } finally {
      allocator.close();
    }
    expect(() => allocator.peekNextSequence()).toThrow("allocator is closed");
    expect(isLcmConnectionOpen(allocatorPath)).toBe(false);
    expect(allocateLocalHookEventSequence(allocatorPath)).toBe(1n);
  });

  describe("reconcileCheckpoint", () => {
    it("advances the checkpoint to stay ahead of an already-used historical sequence, without minting or returning anything", () => {
      const path = sequencePath();
      const allocator = new LocalHookEventSequenceAllocator(path);
      try {
        allocator.reconcileCheckpoint(9n);
        // Breakable independently: the checkpoint must be STRICTLY ahead
        // of the reconciled value (9n was already used), so the next
        // live allocation is 10n, not 9n.
        expect(allocator.peekNextSequence()).toBe(10n);
        expect(allocator.allocateSequence()).toBe(10n);
      } finally {
        allocator.close();
      }
    });

    it("is a no-op when the stored checkpoint already exceeds the supplied value -- proven by an unchanged checkpoint after both a lower and an equal call", () => {
      const path = sequencePath();
      const allocator = new LocalHookEventSequenceAllocator(path);
      try {
        allocator.reconcileCheckpoint(9n);
        expect(allocator.peekNextSequence()).toBe(10n);
        allocator.reconcileCheckpoint(3n);
        expect(allocator.peekNextSequence()).toBe(10n);
        allocator.reconcileCheckpoint(9n);
        expect(allocator.peekNextSequence()).toBe(10n);
      } finally {
        allocator.close();
      }
    });

    it("never regresses the checkpoint below a value live allocation has already advanced past", () => {
      const path = sequencePath();
      const allocator = new LocalHookEventSequenceAllocator(path);
      try {
        allocator.allocateSequences(5);
        expect(allocator.peekNextSequence()).toBe(5n);
        allocator.reconcileCheckpoint(0n);
        expect(allocator.peekNextSequence()).toBe(5n);
      } finally {
        allocator.close();
      }
    });

    it("refuses on a closed allocator, the same as every other method", () => {
      const path = sequencePath();
      const allocator = new LocalHookEventSequenceAllocator(path);
      allocator.close();
      expect(() => allocator.reconcileCheckpoint(0n)).toThrow("allocator is closed");
    });

    it("refuses a value outside the PostgreSQL bigint range", () => {
      const path = sequencePath();
      const allocator = new LocalHookEventSequenceAllocator(path);
      try {
        expect(() => allocator.reconcileCheckpoint(-1n)).toThrow("outside the PostgreSQL bigint range");
        expect(() => allocator.reconcileCheckpoint(MAX_POSTGRESQL_BIGINT + 1n)).toThrow("outside the PostgreSQL bigint range");
      } finally {
        allocator.close();
      }
    });

    it("reconciles the maximum representable sequence without overflowing", () => {
      const path = sequencePath();
      const allocator = new LocalHookEventSequenceAllocator(path);
      try {
        allocator.reconcileCheckpoint(MAX_POSTGRESQL_BIGINT);
        expect(allocator.peekNextSequence()).toBe(MAX_POSTGRESQL_BIGINT + 1n);
      } finally {
        allocator.close();
      }
    });

    it("rolls back and preserves the prior checkpoint when the commit itself fails", () => {
      const path = sequencePath();
      const allocator = new LocalHookEventSequenceAllocator(path);
      try {
        allocator.allocateSequence();
        expect(allocator.peekNextSequence()).toBe(1n);
        const realExec = DatabaseSync.prototype.exec;
        const execSpy = vi.spyOn(DatabaseSync.prototype, "exec");
        execSpy.mockImplementation(function (this: DatabaseSync, sql: string) {
          if (sql === "COMMIT") throw new Error("simulated commit failure");
          return realExec.call(this, sql);
        });
        try {
          expect(() => allocator.reconcileCheckpoint(50n)).toThrow();
        } finally {
          execSpy.mockRestore();
        }
        // The checkpoint is exactly what it was before the failed
        // reconcile -- proving the ROLLBACK preserved it rather than
        // partially applying the write.
        expect(allocator.peekNextSequence()).toBe(1n);
      } finally {
        allocator.close();
      }
    });

    it("still surfaces the original commit failure when the rollback itself also fails, rather than losing it to a swallowed error", () => {
      const path = sequencePath();
      const allocator = new LocalHookEventSequenceAllocator(path);
      try {
        allocator.allocateSequence();
        const realExec = DatabaseSync.prototype.exec;
        const execSpy = vi.spyOn(DatabaseSync.prototype, "exec");
        execSpy.mockImplementation(function (this: DatabaseSync, sql: string) {
          if (sql === "COMMIT") throw new Error("simulated commit failure");
          if (sql === "ROLLBACK") throw new Error("simulated rollback failure too");
          return realExec.call(this, sql);
        });
        try {
          expect(() => allocator.reconcileCheckpoint(50n)).toThrow("simulated commit failure");
        } finally {
          execSpy.mockRestore();
        }
        // Not asserting the checkpoint value here: when BOTH commit and
        // rollback fail, the underlying SQLite transaction is left
        // genuinely open (neither committed nor rolled back), which is
        // an inherent double-fault state rather than something this
        // method can restore to a clean "preserved" value. What matters,
        // and what the assertion above proves, is that the ORIGINAL
        // commit failure is what a caller sees, not the secondary
        // rollback failure masking it.
      } finally {
        allocator.close();
      }
    });
  });

  it("releases its connection when checkpoint initialization fails", () => {
    const path = sequencePath();
    const originalExec = DatabaseSync.prototype.exec;
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(
      function (this: DatabaseSync, sql: string) {
        if (sql.includes("CREATE TABLE IF NOT EXISTS local_hook_sequence")) {
          throw new Error("injected checkpoint initialization failure");
        }
        return originalExec.call(this, sql);
      },
    );
    try {
      expect(() => new LocalHookEventSequenceAllocator(path))
        .toThrow("injected checkpoint initialization failure");
      expect(isLcmConnectionOpen(path)).toBe(false);
    } finally {
      execSpy.mockRestore();
    }
  });

  it("creates and tightens the private parent directory for a standalone allocator", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-event-sequence-parent-"));
    directories.push(directory);
    const parent = join(directory, "nested", "events");
    mkdirSync(parent, { recursive: true, mode: 0o755 });
    chmodSync(parent, 0o755);
    const path = join(parent, "sequence.sqlite");

    expect(allocateLocalHookEventSequence(path)).toBe(0n);
    expect(statSync(parent).mode & 0o777).toBe(0o700);
    const raw = new DatabaseSync(path);
    expect(raw.prepare(
      "SELECT next_sequence FROM local_hook_sequence WHERE singleton = 1",
    ).get()).toEqual({ next_sequence: "1" });
    raw.close();
  });

  it("rejects a symlink checkpoint parent before changing its target", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-event-sequence-symlink-"));
    directories.push(directory);
    const target = join(directory, "target");
    const linkedParent = join(directory, "linked-parent");
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync(target, linkedParent);
    const path = join(linkedParent, "sequence.sqlite");

    expect(() => new LocalHookEventSequenceAllocator(path)).toThrow();
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(isLcmConnectionOpen(path)).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    "rejects an invalid allocation count (%s)",
    (count) => {
      expect(() => allocateLocalHookEventSequences(count, sequencePath()))
        .toThrow("non-negative safe integer");
    },
  );

  it("bounds allocation batches before opening the checkpoint", () => {
    expect(() => allocateLocalHookEventSequences(1_000_001, sequencePath()))
      .toThrow("must not exceed 1000000");
  });

  it("preserves the final bigint and then fails closed when exhausted", () => {
    const path = sequencePath();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE local_hook_sequence (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        next_sequence TEXT NOT NULL
      );
    `);
    raw.prepare(
      "INSERT INTO local_hook_sequence(singleton, next_sequence) VALUES(1, ?)",
    ).run(MAX_POSTGRESQL_BIGINT.toString());
    raw.close();

    const allocator = new LocalHookEventSequenceAllocator(path);
    try {
      expect(allocator.allocateSequence()).toBe(MAX_POSTGRESQL_BIGINT);
      expect(() => allocator.allocateSequence())
        .toThrow("machine sequence is exhausted");
      expect(() => allocator.allocateSequence())
        .toThrow("machine sequence is exhausted");
    } finally {
      allocator.close();
    }
    const reopened = new DatabaseSync(path);
    expect(reopened.prepare(
      "SELECT next_sequence FROM local_hook_sequence WHERE singleton = 1",
    ).get()).toEqual({
      next_sequence: (MAX_POSTGRESQL_BIGINT + 1n).toString(),
    });
    reopened.close();
  });

  it("fails closed for a malformed durable checkpoint without changing it", () => {
    const path = sequencePath();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE local_hook_sequence (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        next_sequence TEXT NOT NULL
      );
      INSERT INTO local_hook_sequence(singleton, next_sequence)
      VALUES(1, 'not-a-number');
    `);
    raw.close();

    const allocator = new LocalHookEventSequenceAllocator(path);
    expect(() => allocator.allocateSequence())
      .toThrow("invalid local hook sequence checkpoint");
    allocator.close();
    const reopened = new DatabaseSync(path);
    expect(reopened.prepare(
      "SELECT next_sequence FROM local_hook_sequence WHERE singleton = 1",
    ).get()).toEqual({ next_sequence: "not-a-number" });
    reopened.close();
  });

  it("formats text-sortable bigint sequences and validates boundaries", () => {
    expect(formatLocalHookMachineSequence(0n)).toBe("0000000000000000000");
    const maximum = formatLocalHookMachineSequence(MAX_POSTGRESQL_BIGINT);
    expect(maximum).toBe("9223372036854775807");
    expect(parseLocalHookMachineSequence(maximum)).toBe(MAX_POSTGRESQL_BIGINT);
    expect(() => formatLocalHookMachineSequence(-1n)).toThrow("outside");
    expect(() => formatLocalHookMachineSequence(MAX_POSTGRESQL_BIGINT + 1n))
      .toThrow("outside");
    for (const invalid of ["1", "000000000000000000x", "9999999999999999999"]) {
      expect(() => parseLocalHookMachineSequence(invalid)).toThrow();
    }
  });

  it("derives a stable compatibility UUID from immutable legacy content", () => {
    const legacy = {
      event_id: 7,
      session_id: "session",
      seq: 2,
      type: "choice",
      category: "decision",
      data: "SQLite",
      priority: 1,
      source_hook: "PostToolUse",
      created_at: "2026-07-29 12:00:00",
    };
    const first = deriveLegacyLocalHookEventUuid(legacy);
    expect(deriveLegacyLocalHookEventUuid({ ...legacy })).toBe(first);
    expect(deriveLegacyLocalHookEventUuid({ ...legacy, data: "PostgreSQL" }))
      .not.toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});
