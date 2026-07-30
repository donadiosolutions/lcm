import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  allocateLocalHookEventSequence,
  allocateLocalHookEventSequences,
  deriveLegacyLocalHookEventUuid,
  formatLocalHookMachineSequence,
  parseLocalHookMachineSequence,
} from "../../src/storage/local-hook-event-sequence.js";

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

    expect(allocateLocalHookEventSequence(path)).toBe(MAX_POSTGRESQL_BIGINT);
    expect(() => allocateLocalHookEventSequence(path))
      .toThrow("machine sequence is exhausted");
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

    expect(() => allocateLocalHookEventSequence(path))
      .toThrow("invalid local hook sequence checkpoint");
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
