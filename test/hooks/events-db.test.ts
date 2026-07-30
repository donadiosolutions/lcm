// test/hooks/events-db.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  EventsDb,
  MAX_HOOK_ERROR_DIAGNOSTIC_LENGTH,
  _resetMigratedPathsForTesting,
  type EventRow,
  type HealthStats,
} from "../../src/hooks/events-db.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  closeLcmConnection,
  getLcmConnection,
  isLcmConnectionOpen,
} from "../../src/db/connection.js";

const machineIdentityState = vi.hoisted(() => ({ fail: false }));

vi.mock("../../src/machine-identity.js", () => ({
  readMachineIdentity: () => {
    if (machineIdentityState.fail) throw new Error("injected machine identity failure");
    return null;
  },
}));

function withSqlite<T>(path: string, operation: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    return operation(db);
  } finally {
    db.close();
  }
}

function getPooledBusyTimeout(path: string): number {
  const db = getLcmConnection(path);
  try {
    return (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
  } finally {
    closeLcmConnection(path);
  }
}

describe("EventsDb", () => {
  const fallbackMachineId = "0195d250-0000-7000-8000-000000000091";
  let dir: string;
  let dbPath: string;

  function machineIdFor(db: EventsDb): string {
    return db.getUnprocessed()[0]?.machine_id ?? fallbackMachineId;
  }

  beforeEach(() => {
    machineIdentityState.fail = false;
    _resetMigratedPathsForTesting();
    dir = mkdtempSync(join(tmpdir(), "events-db-test-"));
    dbPath = join(dir, "test.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates schema on first open", () => {
    const db = new EventsDb(dbPath);
    // Should not throw
    db.close();
  });

  it("keeps event capture offline-safe when machine identity is unreadable", () => {
    const db = new EventsDb(dbPath);
    machineIdentityState.fail = true;
    expect(db.insertEvent(
      "offline",
      { type: "choice", category: "decision", data: "local", priority: 1 },
      "PostToolUse",
    )).toBeTypeOf("number");
    expect(db.getUnprocessed()[0].machine_id).toBeNull();
    db.close();
  });

  it("does not initialize a sequence allocator after closing before the first insert", () => {
    const sequencePath = join(dir, ".machine-sequence.sqlite");
    const db = new EventsDb(dbPath);
    db.close();

    expect(existsSync(sequencePath)).toBe(false);
    expect(isLcmConnectionOpen(sequencePath)).toBe(false);
    expect(() => db.insertEvent("after-close", {
      type: "choice",
      category: "decision",
      data: "must not reserve",
      priority: 1,
    }, "PostToolUse")).toThrow("events database is closed");
    expect(existsSync(sequencePath)).toBe(false);
    expect(isLcmConnectionOpen(sequencePath)).toBe(false);

    db.close();
  });

  it("reuses one durable sequence allocator across 501 event inserts", () => {
    const sequencePath = join(dir, ".machine-sequence.sqlite");
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec");
    const db = new EventsDb(dbPath);
    expect(existsSync(sequencePath)).toBe(false);
    expect(isLcmConnectionOpen(sequencePath)).toBe(false);

    try {
      for (let index = 0; index < 501; index++) {
        db.insertEvent("backlog", {
          type: "choice",
          category: "decision",
          data: `event ${index}`,
          priority: 1,
        }, "PostToolUse");
      }

      expect(isLcmConnectionOpen(sequencePath)).toBe(true);
      const rows = db.getUnprocessed(501);
      expect(rows).toHaveLength(501);
      expect(rows.map(({ machine_sequence: sequence }) => BigInt(sequence)))
        .toEqual(Array.from({ length: 501 }, (_, index) => BigInt(index)));

      const sql = execSpy.mock.calls.map(([statement]) => statement);
      expect(sql.filter((statement) =>
        statement.includes("CREATE TABLE IF NOT EXISTS local_hook_sequence")
      )).toHaveLength(1);
      expect(sql.filter((statement) => statement === "BEGIN IMMEDIATE"))
        .toHaveLength(501);
      expect(sql.filter((statement) => statement === "COMMIT")).toHaveLength(502);
    } finally {
      db.close();
      db.close();
      execSpy.mockRestore();
    }

    expect(isLcmConnectionOpen(sequencePath)).toBe(false);
    expect(() => db.insertEvent("after-close", {
      type: "choice",
      category: "decision",
      data: "must not reserve",
      priority: 1,
    }, "PostToolUse")).toThrow("events database is closed");
    const checkpoint = new DatabaseSync(sequencePath, { readOnly: true });
    expect(checkpoint.prepare(
      "SELECT next_sequence FROM local_hook_sequence WHERE singleton = 1",
    ).get()).toEqual({ next_sequence: "501" });
    checkpoint.close();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "ignores a non-finite busy timeout (%s)",
    (busyTimeoutMs) => {
      const execSpy = vi.spyOn(DatabaseSync.prototype, "exec");
      let db: EventsDb | undefined;
      try {
        db = new EventsDb(dbPath, { busyTimeoutMs });
        const busyTimeoutPragmas = execSpy.mock.calls
          .map(([sql]) => sql)
          .filter((sql) => sql.startsWith("PRAGMA busy_timeout"));
        expect(busyTimeoutPragmas).toEqual(["PRAGMA busy_timeout = 5000"]);
      } finally {
        db?.close();
        execSpy.mockRestore();
      }
    },
  );

  it.each([
    [-12.9, 0],
    [12.9, 12],
  ])("clamps and truncates a finite busy timeout (%s)", (busyTimeoutMs, expectedTimeout) => {
    const keeper = new EventsDb(dbPath);
    const pooled = getLcmConnection(dbPath);
    pooled.exec("PRAGMA busy_timeout = 0");
    closeLcmConnection(dbPath);
    let db: EventsDb | undefined;
    try {
      db = new EventsDb(dbPath, { busyTimeoutMs });
      expect(getPooledBusyTimeout(dbPath)).toBe(expectedTimeout);
    } finally {
      db?.close();
      expect(getPooledBusyTimeout(dbPath)).toBe(0);
      keeper.close();
    }
  });

  it("restores the exact pooled baseline after the final override closes", () => {
    const keeper = new EventsDb(dbPath);
    const pooled = getLcmConnection(dbPath);
    pooled.exec("PRAGMA busy_timeout = 900");
    closeLcmConnection(dbPath);

    const scoped = new EventsDb(dbPath, { busyTimeoutMs: 1_200 });
    expect(getPooledBusyTimeout(dbPath)).toBe(1_200);
    scoped.close();
    scoped.close();
    expect(getPooledBusyTimeout(dbPath)).toBe(900);
    keeper.close();
  });

  it("does not let a shorter override weaken the pooled baseline", () => {
    const keeper = new EventsDb(dbPath);
    const scoped = new EventsDb(dbPath, { busyTimeoutMs: 250 });

    expect(getPooledBusyTimeout(dbPath)).toBe(5_000);
    scoped.close();
    expect(getPooledBusyTimeout(dbPath)).toBe(5_000);
    keeper.close();
  });

  it("keeps the strongest active override across out-of-order closes", () => {
    const keeper = new EventsDb(dbPath);
    const first = new EventsDb(dbPath, { busyTimeoutMs: 7_500 });
    const second = new EventsDb(dbPath, { busyTimeoutMs: 6_250 });
    expect(getPooledBusyTimeout(dbPath)).toBe(7_500);

    first.close();
    expect(getPooledBusyTimeout(dbPath)).toBe(6_250);
    second.close();
    expect(getPooledBusyTimeout(dbPath)).toBe(5_000);
    keeper.close();
  });

  it("restores the previous active override when the newest owner closes first", () => {
    const keeper = new EventsDb(dbPath);
    const first = new EventsDb(dbPath, { busyTimeoutMs: 6_250 });
    const second = new EventsDb(dbPath, { busyTimeoutMs: 7_500 });

    second.close();
    expect(getPooledBusyTimeout(dbPath)).toBe(6_250);
    first.close();
    expect(getPooledBusyTimeout(dbPath)).toBe(5_000);
    keeper.close();
  });

  it.each([new Error("timeout rejected"), "plain timeout rejection"])(
    "releases the pooled connection when applying an override fails",
    (failure) => {
      const originalExec = DatabaseSync.prototype.exec;
      const execSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
        this: DatabaseSync,
        sql: string,
      ) {
        if (sql === "PRAGMA busy_timeout = 6250") throw failure;
        return originalExec.call(this, sql);
      });
      try {
        expect(() => new EventsDb(dbPath, { busyTimeoutMs: 6_250 })).toThrow(
          failure instanceof Error ? failure.message : failure,
        );
        expect(isLcmConnectionOpen(dbPath)).toBe(false);
      } finally {
        execSpy.mockRestore();
      }
    },
  );

  it("preserves an active override when a newer override cannot be applied", () => {
    const keeper = new EventsDb(dbPath);
    const active = new EventsDb(dbPath, { busyTimeoutMs: 6_250 });
    const originalExec = DatabaseSync.prototype.exec;
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "PRAGMA busy_timeout = 7500") throw new Error("new override rejected");
      return originalExec.call(this, sql);
    });
    try {
      expect(() => new EventsDb(dbPath, { busyTimeoutMs: 7_500 })).toThrow("new override rejected");
      expect(getPooledBusyTimeout(dbPath)).toBe(6_250);
    } finally {
      execSpy.mockRestore();
      active.close();
      expect(getPooledBusyTimeout(dbPath)).toBe(5_000);
      keeper.close();
    }
  });

  it("completes close cleanup when busy-timeout restoration fails", () => {
    const scoped = new EventsDb(dbPath, { busyTimeoutMs: 500 });
    const originalExec = DatabaseSync.prototype.exec;
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "PRAGMA busy_timeout = 5000") throw new Error("unhealthy handle");
      return originalExec.call(this, sql);
    });
    try {
      expect(() => scoped.close()).not.toThrow();
      expect(() => scoped.close()).not.toThrow();
      expect(isLcmConnectionOpen(dbPath)).toBe(false);
    } finally {
      execSpy.mockRestore();
    }

    rmSync(dbPath, { force: true });
    const reopened = new EventsDb(dbPath);
    reopened.insertEvent(
      "clean-session",
      { type: "choice", category: "decision", data: "reopened", priority: 1 },
      "PostToolUse",
    );
    expect(reopened.getUnprocessed()).toHaveLength(1);
    reopened.close();
  });

  it("inserts and retrieves events", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("session-1", {
      type: "decision",
      category: "decision",
      data: "use SQLite",
      priority: 1,
    }, "PostToolUse");

    const events = db.getUnprocessed();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_version: 1,
      session_id: "session-1",
      type: "decision",
      category: "decision",
      data: "use SQLite",
      priority: 1,
      source_hook: "PostToolUse",
      processed_at: null,
      delivery_state: "pending",
      delivery_attempts: 0,
      remote_inbox_id: null,
    });
    expect(events[0].event_uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(events[0].machine_sequence).toMatch(/^\d{19}$/u);
    db.close();
  });

  it("increments seq per session", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    db.insertEvent("s1", { type: "b", category: "file", data: "y", priority: 3 }, "PostToolUse");
    db.insertEvent("s2", { type: "c", category: "file", data: "z", priority: 3 }, "PostToolUse");

    const events = db.getUnprocessed();
    const s1Events = events.filter(e => e.session_id === "s1");
    const s2Events = events.filter(e => e.session_id === "s2");
    expect(s1Events[0].seq).toBe(1);
    expect(s1Events[1].seq).toBe(2);
    expect(s2Events[0].seq).toBe(1);
    db.close();
  });

  it("marks events as processed", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    const events = db.getUnprocessed();
    expect(events).toHaveLength(1);

    db.markProcessed([events[0].event_id]);
    expect(db.getUnprocessed()).toHaveLength(0);
    const stored = withSqlite(dbPath, (raw) => raw.prepare(
      "SELECT delivery_state, acknowledged_at FROM events WHERE event_id = ?",
    ).get(events[0].event_id)) as {
      delivery_state: string;
      acknowledged_at: string | null;
    };
    expect(stored).toEqual({
      delivery_state: "pending",
      acknowledged_at: null,
    });
    expect(db.claimDeliveries({
      machineId: events[0].machine_id ?? fallbackMachineId,
      claimOwner: "replicator",
      limit: 1,
      staleClaimMs: 1_000,
    })).toHaveLength(1);
    db.close();
  });

  it("claims a ready prefix in machine order and does not skip delayed retries", () => {
    const db = new EventsDb(dbPath);
    for (const data of ["first", "second", "third"]) {
      db.insertEvent(
        "s1",
        { type: "choice", category: "decision", data, priority: 1 },
        "PostToolUse",
      );
    }
    const machineId = machineIdFor(db);
    const firstClaim = db.claimDeliveries({
      machineId,
      claimOwner: "owner-a",
      limit: 1,
      staleClaimMs: 1_000,
    });
    expect(firstClaim.map((event) => event.data)).toEqual(["first"]);
    expect(db.markDeliveryRetry(
      firstClaim[0].event_uuid,
      "owner-a",
      "network unavailable",
      "2099-01-01T00:00:00.000Z",
    )).toBe(true);

    expect(db.claimDeliveries({
      machineId,
      claimOwner: "owner-b",
      limit: 3,
      staleClaimMs: 1_000,
    })).toEqual([]);

    withSqlite(dbPath, (raw) => raw.prepare(
      "UPDATE events SET delivery_next_attempt_at = datetime('now', '-1 second') WHERE event_uuid = ?",
    ).run(firstClaim[0].event_uuid));
    const resumed = db.claimDeliveries({
      machineId,
      claimOwner: "owner-b",
      limit: 3,
      staleClaimMs: 1_000,
    });
    expect(resumed.map((event) => event.data)).toEqual(["first", "second", "third"]);
    expect(resumed.map((event) => event.delivery_attempts)).toEqual([2, 1, 1]);
    expect(resumed.map((event) => event.machine_sequence))
      .toEqual([...resumed.map((event) => event.machine_sequence)].sort());
    db.close();
  });

  it("recovers stale delivery claims without allowing a fresh owner takeover", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent(
      "s1",
      { type: "choice", category: "decision", data: "stale", priority: 1 },
      "PostToolUse",
    );
    const machineId = machineIdFor(db);
    const [claimed] = db.claimDeliveries({
      machineId,
      claimOwner: "owner-a",
      limit: 1,
      staleClaimMs: 60_000,
    });
    expect(db.claimDeliveries({
      machineId,
      claimOwner: "owner-b",
      limit: 1,
      staleClaimMs: 60_000,
    })).toEqual([]);

    withSqlite(dbPath, (raw) => raw.prepare(
      "UPDATE events SET delivery_claimed_at = datetime('now', '-2 minutes') WHERE event_uuid = ?",
    ).run(claimed.event_uuid));
    const [recovered] = db.claimDeliveries({
      machineId,
      claimOwner: "owner-b",
      limit: 1,
      staleClaimMs: 60_000,
    });
    expect(recovered).toMatchObject({
      event_uuid: claimed.event_uuid,
      delivery_owner: "owner-b",
      delivery_attempts: 2,
    });
    db.close();
  });

  it("tracks retry, quarantine, exact replay, acknowledgement, and prune checkpoints", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent(
      "s1",
      { type: "choice", category: "decision", data: "poison", priority: 1 },
      "PostToolUse",
    );
    const machineId = machineIdFor(db);
    const [firstClaim] = db.claimDeliveries({
      machineId,
      claimOwner: "owner-a",
      limit: 1,
      staleClaimMs: 1_000,
    });
    expect(db.markReplicated(firstClaim.event_uuid, "owner-b", 41n)).toBe(false);
    expect(db.markDeliveryRetry(
      firstClaim.event_uuid,
      "owner-a",
      "password=hunter2",
      "2020-01-01T00:00:00.000Z",
    )).toBe(true);
    expect(db.getDeliveryDiagnostics()).toMatchObject({
      retry: 1,
      pending: 0,
      quarantined: 0,
    });

    const [retryClaim] = db.claimDeliveries({
      machineId,
      claimOwner: "owner-b",
      limit: 1,
      staleClaimMs: 1_000,
    });
    expect(retryClaim.delivery_last_error).toBeNull();
    expect(db.markReplicated(retryClaim.event_uuid, "owner-b", 41n)).toBe(true);
    expect(db.listAwaitingRemote()).toHaveLength(1);
    expect(db.markQuarantined(
      retryClaim.event_uuid,
      42n,
      "wrong remote",
    )).toBe(false);
    expect(db.markQuarantined(
      retryClaim.event_uuid,
      41n,
      "password=hunter2",
    )).toBe(true);
    expect(db.markQuarantined(
      retryClaim.event_uuid,
      41n,
      "password=hunter2",
    )).toBe(false);
    expect(db.listAwaitingRemote()).toEqual([]);
    expect(db.listAwaitingRemote(undefined, true)[0].quarantine_reason)
      .not.toContain("hunter2");
    expect(db.replayQuarantined("0195d250-0000-7000-8000-000000000099"))
      .toBe(false);
    expect(db.replayQuarantined(retryClaim.event_uuid)).toBe(true);
    expect(db.listAwaitingRemote()[0].delivery_state).toBe("replicated");

    expect(db.markAcknowledged(retryClaim.event_uuid, 42n)).toBe(false);
    expect(db.markAcknowledged(retryClaim.event_uuid, 41n)).toBe(true);
    expect(db.markAcknowledged(retryClaim.event_uuid, 41n)).toBe(false);
    expect(db.markQuarantined(retryClaim.event_uuid, 41n, "late poison"))
      .toBe(false);
    expect(db.listAcknowledgedForRemotePrune()).toHaveLength(1);
    expect(db.getHealthStats().deliveryAwaitingRemotePrune).toBe(1);
    expect(db.markRemotePruned(retryClaim.event_uuid)).toBe(true);
    expect(db.markRemotePruned(retryClaim.event_uuid)).toBe(false);
    expect(db.listAcknowledgedForRemotePrune()).toEqual([]);
    expect(db.getHealthStats().deliveryAwaitingRemotePrune).toBe(0);
    db.close();
  });

  it("rejects remote inbox IDs outside the exact PostgreSQL bigint range", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent(
      "s1",
      { type: "choice", category: "decision", data: "range", priority: 1 },
      "PostToolUse",
    );
    const [event] = db.getUnprocessed();
    for (const invalid of [0n, 9_223_372_036_854_775_808n]) {
      expect(() => db.markReplicated(event.event_uuid, "owner", invalid))
        .toThrow("outside the PostgreSQL bigint range");
      expect(() => db.markAcknowledged(event.event_uuid, invalid))
        .toThrow("outside the PostgreSQL bigint range");
      expect(() => db.markQuarantined(event.event_uuid, invalid, "poison"))
        .toThrow("outside the PostgreSQL bigint range");
    }
    expect(db.getDeliveryDiagnostics().pending).toBe(1);
    db.close();
  });

  it("rejects invalid delivery owners, batch limits, and retry intervals", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent(
      "s1",
      { type: "choice", category: "decision", data: "validation", priority: 1 },
      "PostToolUse",
    );
    const event = db.getUnprocessed()[0];
    expect(() => db.claimDeliveries({
      machineId: fallbackMachineId,
      claimOwner: " ",
      limit: 1,
      staleClaimMs: 1_000,
    })).toThrow("claim owner must not be blank");
    expect(() => db.claimDeliveries({
      machineId: fallbackMachineId,
      claimOwner: "owner",
      limit: 501,
      staleClaimMs: 1_000,
    })).toThrow("delivery limit must be an integer between 1 and 500");
    expect(() => db.claimDeliveries({
      machineId: fallbackMachineId,
      claimOwner: "owner",
      limit: 1,
      staleClaimMs: -1,
    })).toThrow("stale claim milliseconds must be a non-negative safe integer");
    expect(() => db.markDeliveryRetry(
      event.event_uuid,
      " ",
      "retry",
      "2026-07-29T12:00:00.000Z",
    )).toThrow("claim owner must not be blank");
    expect(() => db.markRemotePruned("not-an-event-uuid"))
      .toThrow("invalid local hook event UUID");
    db.close();
  });

  it("quarantines and exactly replays an unsupported pre-delivery envelope", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent(
      "s1",
      { type: "choice", category: "decision", data: "future", priority: 1 },
      "PostToolUse",
    );
    withSqlite(dbPath, (raw) => raw.exec(
      "UPDATE events SET event_version = 2",
    ));
    const [claim] = db.claimDeliveries({
      machineId: machineIdFor(db),
      claimOwner: "compatibility-worker",
      limit: 1,
      staleClaimMs: 1_000,
    });
    expect(db.markDeliveryQuarantined(
      claim.event_uuid,
      "wrong-worker",
      "unsupported version",
    )).toBe(false);
    expect(db.markDeliveryQuarantined(
      claim.event_uuid,
      "compatibility-worker",
      "unsupported version",
    )).toBe(true);
    expect(db.listQuarantined()[0]).toMatchObject({
      event_version: 2,
      delivery_state: "quarantined",
      remote_inbox_id: null,
      quarantine_reason: "unsupported version",
    });
    expect(db.listAwaitingRemote()).toEqual([]);
    expect(db.replayQuarantined(claim.event_uuid)).toBe(true);
    expect(db.getDeliveryDiagnostics()).toMatchObject({
      pending: 1,
      quarantined: 0,
    });
    db.close();
  });

  it("fails closed when a sidecar contains an event owned by another machine", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent(
      "s1",
      { type: "choice", category: "decision", data: "foreign", priority: 1 },
      "PostToolUse",
    );
    withSqlite(dbPath, (raw) => raw.prepare(
      "UPDATE events SET machine_id = ?",
    ).run("0195d250-0000-7000-8000-000000000099"));
    expect(() => db.claimDeliveries({
      machineId: "0195d250-0000-7000-8000-000000000098",
      claimOwner: "owner",
      limit: 1,
      staleClaimMs: 1_000,
    })).toThrow("belongs to a different machine");
    expect(db.getDeliveryDiagnostics().pending).toBe(1);
    db.close();
  });

  it("ignores an empty processed-id list and links predecessor events", () => {
    const db = new EventsDb(dbPath);
    const first = db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    const second = db.insertEvent("s1", { type: "b", category: "file", data: "y", priority: 3 }, "PostToolUse");
    db.markProcessed([]);
    db.setPrevEventId(second, first);
    db.setPrevEventId(second, first);
    expect(db.getUnprocessed().find((event) => event.event_id === second))
      .toMatchObject({ prev_event_id: first, delivery_generation: 1 });
    db.close();
  });

  it("freezes predecessor metadata before the first delivery attempt", () => {
    const db = new EventsDb(dbPath);
    const first = db.insertEvent(
      "s1",
      { type: "error", category: "error", data: "failed", priority: 1 },
      "PostToolUse",
    );
    const second = db.insertEvent(
      "s1",
      { type: "choice", category: "solution", data: "fixed", priority: 1 },
      "PostToolUse",
    );
    const machineId = machineIdFor(db);
    const claimed = db.claimDeliveries({
      machineId,
      claimOwner: "replicator",
      limit: 2,
      staleClaimMs: 1_000,
    });
    expect(claimed).toHaveLength(2);

    db.setPrevEventId(second, first);

    expect(db.getUnprocessed().find((event) => event.event_id === second))
      .toMatchObject({
        prev_event_id: null,
        delivery_state: "claimed",
        delivery_generation: 2,
      });
    db.close();
  });

  it("reports pattern reinforcement with the default age window", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("s1", { type: "choice", category: "decision", data: "SQLite", priority: 1 }, "PostToolUse");
    db.insertEvent("s2", { type: "choice", category: "decision", data: "SQLite", priority: 1 }, "PostToolUse");
    expect(db.getPatternReinforcement("choice", "decision", "SQLite")).toEqual({
      totalCount: 2,
      distinctSessions: 2,
    });
    db.close();
  });

  it("prunes old processed events only after remote acknowledgement and pruning", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    const events = db.getUnprocessed();
    db.markProcessed([events[0].event_id]);

    // Manually backdate the processed_at to 10 days ago
    withSqlite(dbPath, (raw) => raw.exec(
      `UPDATE events SET processed_at = datetime('now', '-10 days') WHERE event_id = ${events[0].event_id}`
    ));

    expect(db.pruneProcessed(7)).toBe(0);
    const [claimed] = db.claimDeliveries({
      machineId: events[0].machine_id ?? fallbackMachineId,
      claimOwner: "test-owner",
      limit: 1,
      staleClaimMs: 1_000,
    });
    expect(claimed.event_uuid).toBe(events[0].event_uuid);
    expect(db.markReplicated(claimed.event_uuid, "test-owner", 10n)).toBe(true);
    expect(db.markAcknowledged(claimed.event_uuid, 10n)).toBe(true);
    expect(db.pruneProcessed(7)).toBe(0);
    expect(db.markRemotePruned(claimed.event_uuid)).toBe(true);
    expect(db.pruneProcessed(7)).toBe(1);
    db.close();
  });

  it("handles concurrent opens (WAL mode)", () => {
    const sequencePath = join(dir, ".machine-sequence.sqlite");
    const db1 = new EventsDb(dbPath);
    const db2 = new EventsDb(dbPath);
    try {
      db1.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
      db2.insertEvent("s2", { type: "b", category: "file", data: "y", priority: 3 }, "PostToolUse");

      const events = db1.getUnprocessed();
      expect(events.map(({ machine_sequence: sequence }) => BigInt(sequence)))
        .toEqual([0n, 1n]);
      expect(isLcmConnectionOpen(sequencePath)).toBe(true);
      db1.close();
      expect(isLcmConnectionOpen(sequencePath)).toBe(true);
    } finally {
      db1.close();
      db2.close();
    }
    expect(isLcmConnectionOpen(sequencePath)).toBe(false);
  });

  describe("Schema migrations — error_log + pattern lookup index", () => {
    it("atomically rolls back initial schema DDL when version insertion fails", () => {
      const originalPrepare = DatabaseSync.prototype.prepare;
      const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
        this: DatabaseSync,
        sql: string,
      ) {
        if (sql === "INSERT INTO schema_version (version) VALUES (?)") {
          throw new Error("injected schema-version failure");
        }
        return originalPrepare.call(this, sql);
      });

      try {
        expect(() => new EventsDb(dbPath, { busyTimeoutMs: 250 }))
          .toThrow("injected schema-version failure");
      } finally {
        prepareSpy.mockRestore();
      }

      const rawDb = new DatabaseSync(dbPath);
      const applicationObjects = rawDb.prepare(`
        SELECT name FROM sqlite_master
        WHERE name IN ('schema_version', 'events', 'error_log', 'idx_events_unprocessed')
      `).all();
      expect(applicationObjects).toEqual([]);
      rawDb.close();

      const recovered = new EventsDb(dbPath);
      expect(withSqlite(dbPath, (raw) => (raw.prepare("SELECT version FROM schema_version").get() as { version: number }).version))
        .toBe(4);
      recovered.close();
    });

    it("repairs an empty schema-version table", () => {
      const { DatabaseSync } = require("node:sqlite");
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        CREATE TABLE events (
          event_id INTEGER PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT,
          category TEXT, data TEXT, priority INTEGER, source_hook TEXT,
          prev_event_id INTEGER, processed_at TEXT, created_at TEXT
        );
      `);
      rawDb.close();
      const db = new EventsDb(dbPath);
      expect(withSqlite(dbPath, (raw) => (raw.prepare("SELECT version FROM schema_version").get() as { version: number }).version)).toBe(4);
      db.close();
    });

    it("migrates a v2 database to the versioned delivery envelope", () => {
      const { DatabaseSync } = require("node:sqlite");
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (2);
        CREATE TABLE events (
          event_id INTEGER PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT,
          category TEXT, data TEXT, priority INTEGER, source_hook TEXT,
          prev_event_id INTEGER, processed_at TEXT, created_at TEXT
        );
        INSERT INTO events(
          event_id, session_id, seq, type, category, data, priority,
          source_hook, prev_event_id, processed_at, created_at
        ) VALUES(
          7, 'legacy-session', 3, 'choice', 'decision', 'SQLite', 1,
          'PostToolUse', NULL, NULL, NULL
        ),(
          8, 'processed-legacy-session', 1, 'observation', 'fact', 'PostgreSQL', 2,
          'Stop', 7, '2026-07-29 12:00:00', '2026-07-29 11:59:00'
        );
      `);
      rawDb.close();
      const db = new EventsDb(dbPath);
      expect(withSqlite(dbPath, (raw) => raw.prepare("SELECT name FROM sqlite_master WHERE name='idx_events_pattern_lookup'").get())).toBeDefined();
      expect(withSqlite(dbPath, (raw) => raw.prepare(
        "SELECT name FROM pragma_table_info('events') WHERE name='event_uuid'",
      ).get())).toBeDefined();
      const migrated = db.getUnprocessed()[0];
      expect(migrated).toMatchObject({
        event_id: 7,
        event_version: 1,
        session_id: "legacy-session",
        seq: 3,
        data: "SQLite",
        created_at: "1970-01-01 00:00:00",
        delivery_state: "pending",
      });
      expect(migrated.event_uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      const processedLegacy = withSqlite(dbPath, (raw) => raw.prepare(`
        SELECT processed_at, delivery_state, acknowledged_at, remote_inbox_id
        FROM events
        WHERE event_id = 8
      `).get()) as {
        processed_at: string;
        delivery_state: string;
        acknowledged_at: string | null;
        remote_inbox_id: string | null;
      };
      expect(processedLegacy).toEqual({
        processed_at: "2026-07-29 12:00:00",
        delivery_state: "pending",
        acknowledged_at: null,
        remote_inbox_id: null,
      });
      expect(() => withSqlite(dbPath, (raw) => raw.prepare(`
        UPDATE events
        SET delivery_state = 'acknowledged',
            acknowledged_at = '2026-07-29 12:00:01'
        WHERE event_id = 8
      `).run())).toThrow();
      db.close();
    });

    it("takes the legacy snapshot only after acquiring the migration lock", () => {
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (2);
        CREATE TABLE events (
          event_id INTEGER PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT,
          category TEXT, data TEXT, priority INTEGER, source_hook TEXT,
          prev_event_id INTEGER, processed_at TEXT, created_at TEXT
        );
        INSERT INTO events(
          event_id, session_id, seq, type, category, data, priority,
          source_hook, prev_event_id, processed_at, created_at
        ) VALUES(
          7, 'first-session', 1, 'observation', 'fact', 'first', 2,
          'PostToolUse', NULL, NULL, '2026-07-29 11:59:00'
        );
      `);
      rawDb.close();

      const competingWriter = new DatabaseSync(dbPath);
      const originalExec = DatabaseSync.prototype.exec;
      let competingRowCommitted = false;
      const execSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
        this: DatabaseSync,
        sql: string,
      ) {
        if (!competingRowCommitted && sql === "BEGIN EXCLUSIVE") {
          competingWriter.prepare(`
            INSERT INTO events(
              event_id, session_id, seq, type, category, data, priority,
              source_hook, prev_event_id, processed_at, created_at
            ) VALUES(
              8, 'competing-session', 1, 'observation', 'fact', 'second', 2,
              'PostToolUse', NULL, NULL, '2026-07-29 12:00:00'
            )
          `).run();
          competingRowCommitted = true;
        }
        return originalExec.call(this, sql);
      });

      let db: EventsDb | undefined;
      try {
        db = new EventsDb(dbPath);
        expect(competingRowCommitted).toBe(true);
        expect(db.getUnprocessed()
          .map(({ event_id: eventId }) => eventId)
          .sort((left, right) => left - right))
          .toEqual([7, 8]);
      } finally {
        db?.close();
        execSpy.mockRestore();
        competingWriter.close();
      }
    });

    it("leaves an already-current schema version unchanged", () => {
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (4);
      `);
      rawDb.close();

      const db = new EventsDb(dbPath);
      expect(withSqlite(dbPath, (raw) => (raw.prepare("SELECT version FROM schema_version").get() as { version: number }).version))
        .toBe(4);
      db.close();
      const execSpy = vi.spyOn(DatabaseSync.prototype, "exec");
      let reopened: EventsDb | undefined;
      try {
        reopened = new EventsDb(dbPath);
        expect(reopened.getUnprocessed()).toEqual([]);
        expect(execSpy).not.toHaveBeenCalledWith("BEGIN EXCLUSIVE");
      } finally {
        reopened?.close();
        execSpy.mockRestore();
      }
    });

    it.each([
      [0, "invalid events schema version"],
      [5, "unsupported events schema version"],
    ])("rejects incompatible schema version %s", (version, message) => {
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (${version});
      `);
      rawDb.close();

      expect(() => new EventsDb(dbPath)).toThrow(message);
    });

    it("releases the pooled connection when migration fails", () => {
      const { DatabaseSync } = require("node:sqlite");
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (1);
        CREATE TABLE events (
          event_id INTEGER PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT,
          category TEXT, data TEXT, priority INTEGER, source_hook TEXT,
          prev_event_id INTEGER, processed_at TEXT, created_at TEXT
        );
        CREATE VIEW error_log AS SELECT 1 AS id;
      `);
      rawDb.close();
      expect(() => new EventsDb(dbPath)).toThrow();
    });
    it("migrates v1 DB to the latest schema on open", () => {
      // Create a v1 DB manually (no error_log table or pattern lookup index)
      const { DatabaseSync } = require("node:sqlite");
      const { mkdirSync } = require("node:fs");
      const { dirname } = require("node:path");
      mkdirSync(dirname(dbPath), { recursive: true });
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS events (
          event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id    TEXT NOT NULL,
          seq           INTEGER NOT NULL DEFAULT 0,
          type          TEXT NOT NULL,
          category      TEXT NOT NULL,
          data          TEXT NOT NULL,
          priority      INTEGER DEFAULT 3,
          source_hook   TEXT NOT NULL,
          prev_event_id INTEGER,
          processed_at  TEXT,
          created_at    TEXT DEFAULT (datetime('now'))
        );
      `);
      rawDb.prepare("INSERT INTO schema_version (version) VALUES (1)").run();
      rawDb.close();

      // Now open with EventsDb — should migrate to the latest schema.
      const db = new EventsDb(dbPath);
      const tableRow = withSqlite(dbPath, (raw) => raw.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='error_log'",
      ).get());
      const indexRow = withSqlite(dbPath, (raw) => raw.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_pattern_lookup'",
      ).get());
      expect(tableRow).toBeDefined();
      expect(indexRow).toBeDefined();
      const versionRow = withSqlite(dbPath, (raw) => raw.prepare("SELECT version FROM schema_version").get()) as { version: number };
      expect(versionRow.version).toBe(4);
      db.close();
    });

    it("logHookError inserts into error_log", () => {
      const db = new EventsDb(dbPath);
      db.logHookError("PostToolUse", new Error("something went wrong"), "session-abc");
      const row = db.getRecentErrors({ includeMaintenance: true })[0];
      expect(row).toBeDefined();
      expect(row.hook).toBe("PostToolUse");
      expect(row.error).toBe("something went wrong");
      expect(row.session_id).toBe("session-abc");
      db.close();
    });

    it("logHookError handles non-Error values", () => {
      const db = new EventsDb(dbPath);
      db.logHookError("PreToolUse", "raw string error");
      const row = db.getRecentErrors({ includeMaintenance: true })[0];
      expect(row.error).toBe("raw string error");
      expect(row.session_id).toBeNull();
      db.close();
    });

    it("sanitizes and bounds hook errors both when writing and reading legacy rows", () => {
      const db = new EventsDb(dbPath);
      const secrets = [
        "bearer-header-secret",
        "sk-0123456789abcdefghijklmnop",
        "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
        "npm_0123456789abcdefghijklmnopqrstuvwxyz",
        "header-api-key-secret",
      ];
      const unsafe = `failed at /Users/alice/private.txt password=hunter2 Authorization: Bearer ${secrets[0]} ${secrets.slice(1, 4).join(" ")} X-Api-Key: ${secrets[4]} \u001b[31m${"x".repeat(
        MAX_HOOK_ERROR_DIAGNOSTIC_LENGTH + 100,
      )}`;
      db.logHookError("PostToolUse", new Error(unsafe));

      const persisted = withSqlite(dbPath, (raw) => raw.prepare(
        "SELECT error FROM error_log WHERE hook = 'PostToolUse'",
      ).get()) as { error: string };
      expect(persisted.error).not.toContain("/Users/alice");
      expect(persisted.error).not.toContain("hunter2");
      for (const secret of secrets) expect(persisted.error).not.toContain(secret);
      expect(persisted.error).not.toContain("\u001b");
      expect(persisted.error.length).toBe(MAX_HOOK_ERROR_DIAGNOSTIC_LENGTH);

      withSqlite(dbPath, (raw) => raw.prepare(
        "INSERT INTO error_log (hook, error, session_id) VALUES (?, ?, NULL)",
      ).run("legacy", unsafe));
      const legacy = db.getRecentErrors({ includeMaintenance: true, limit: 1 })[0];
      expect(legacy.hook).toBe("legacy");
      expect(legacy.error).not.toContain("/Users/alice");
      expect(legacy.error).not.toContain("hunter2");
      for (const secret of secrets) expect(legacy.error).not.toContain(secret);
      expect(legacy.error).not.toContain("\u001b");
      expect(legacy.error.length).toBe(MAX_HOOK_ERROR_DIAGNOSTIC_LENGTH);
      db.close();
    });

    it("normalizes recent-error limits to a bounded non-negative integer", () => {
      const db = new EventsDb(dbPath);
      for (let i = 0; i < 105; i++) db.logHookError("PostToolUse", `failure ${i}`);

      expect(db.getRecentErrors({ limit: -1 })).toEqual([]);
      expect(db.getRecentErrors({ limit: 2.9 })).toHaveLength(2);
      expect(db.getRecentErrors({ limit: Number.NaN })).toHaveLength(5);
      expect(db.getRecentErrors({ limit: Number.POSITIVE_INFINITY })).toHaveLength(5);
      expect(db.getRecentErrors({ limit: 1_000 })).toHaveLength(100);
      db.close();
    });

    it("getHealthStats returns correct counts", () => {
      const db = new EventsDb(dbPath);
      db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
      db.insertEvent("s1", { type: "b", category: "file", data: "y", priority: 3 }, "PostToolUse");
      const events = db.getUnprocessed();
      db.markProcessed([events[0].event_id]);
      db.logHookError("PostToolUse", new Error("oops"), "s1");

      const stats: HealthStats = db.getHealthStats();
      expect(stats.totalEvents).toBe(2);
      expect(stats.unprocessed).toBe(1);
      expect(stats.errors).toBe(1);
      expect(stats.lastCapture).not.toBeNull();
      expect(stats.lastError).not.toBeNull();
      expect(stats.deliveryPending).toBe(2);
      expect(stats.deliveryAcknowledged).toBe(0);
      expect(stats.deliveryAwaitingRemotePrune).toBe(0);
      expect(stats.oldestDeliveryAt).not.toBeNull();
      db.close();
    });

    it("getHealthStats returns zeros on empty DB", () => {
      const db = new EventsDb(dbPath);
      const stats: HealthStats = db.getHealthStats();
      expect(stats.totalEvents).toBe(0);
      expect(stats.unprocessed).toBe(0);
      expect(stats.errors).toBe(0);
      expect(stats.lastCapture).toBeNull();
      expect(stats.lastError).toBeNull();
      expect(stats.deliveryPending).toBe(0);
      expect(stats.deliveryAwaitingRemotePrune).toBe(0);
      expect(stats.deliveryQuarantined).toBe(0);
      expect(stats.oldestDeliveryAt).toBeNull();
      db.close();
    });

    it("pruneUnprocessed retains rows beyond the cap for outage recovery", () => {
      const db = new EventsDb(dbPath);
      // Insert 15 unprocessed events
      for (let i = 0; i < 15; i++) {
        db.insertEvent("s1", { type: "a", category: "file", data: `d${i}`, priority: 3 }, "PostToolUse");
      }
      const before = db.getUnprocessed();
      expect(before).toHaveLength(15);

      // Report the guard breach without discarding the durable outbox.
      const result = db.pruneUnprocessed(10, 9999);
      expect(result.pruned).toBe(0);

      const after = db.getUnprocessed();
      expect(after.map((event) => event.event_id))
        .toEqual(before.map((event) => event.event_id));
      expect(db.getDeliveryDiagnostics().pending).toBe(15);
      db.close();
    });

    it("pruneUnprocessed stays silent when no retention guard is breached", () => {
      const db = new EventsDb(dbPath);
      expect(db.pruneUnprocessed(10, 30)).toEqual({ pruned: 0 });
      expect(db.getRecentErrors({ includeMaintenance: true })).toEqual([]);
      db.close();
    });

    it("excludes processed rows from the unprocessed retention guard", () => {
      const db = new EventsDb(dbPath);
      db.insertEvent("s1", { type: "a", category: "file", data: "processed", priority: 3 }, "PostToolUse");
      const [event] = db.getUnprocessed();
      db.markProcessed([event.event_id]);
      withSqlite(dbPath, (raw) => raw.exec("UPDATE events SET created_at = datetime('now', '-31 days')"));

      expect(db.pruneUnprocessed(0, 30)).toEqual({ pruned: 0 });
      expect(db.getRecentErrors({ includeMaintenance: true })).toEqual([]);
      db.close();
    });

    it("retains old unprocessed rows and reports each observed guard breach", () => {
      const db = new EventsDb(dbPath);
      db.insertEvent("s1", { type: "a", category: "file", data: "old", priority: 3 }, "PostToolUse");
      withSqlite(dbPath, (raw) => raw.exec("UPDATE events SET created_at = datetime('now', '-31 days')"));
      expect(db.pruneUnprocessed(10, 30)).toEqual({ pruned: 0 });
      expect(db.pruneUnprocessed(10, 30)).toEqual({ pruned: 0 });
      expect(db.getUnprocessed()).toHaveLength(1);
      expect(db.getRecentErrors({ includeMaintenance: true, limit: 10 })
        .filter((entry) => entry.hook === "maintenance:pruneUnprocessed"))
        .toHaveLength(2);
      db.close();
    });

    it("never executes event deletion while reporting an unprocessed retention breach", () => {
      const db = new EventsDb(dbPath);
      db.insertEvent("s1", { type: "a", category: "file", data: "old", priority: 3 }, "PostToolUse");
      withSqlite(dbPath, (raw) => raw.exec(`
        UPDATE events SET created_at = datetime('now', '-31 days');
        CREATE TRIGGER reject_event_delete BEFORE DELETE ON events BEGIN
          SELECT RAISE(ABORT, 'delete rejected');
        END;
      `));
      expect(db.pruneUnprocessed(10, 30)).toEqual({ pruned: 0 });
      expect(db.getUnprocessed()).toHaveLength(1);
      db.close();
    });

    it("pruneUnprocessed logs the retained count", () => {
      const db = new EventsDb(dbPath);
      for (let i = 0; i < 5; i++) {
        db.insertEvent("s1", { type: "a", category: "file", data: `d${i}`, priority: 3 }, "PostToolUse");
      }
      db.pruneUnprocessed(3, 9999);

      const logRow = db.getRecentErrors({ includeMaintenance: true }).find(
        (entry) => entry.hook === "maintenance:pruneUnprocessed",
      );
      expect(logRow).toBeDefined();
      expect(logRow!.error).toContain("retained 2");
      db.close();
    });

    it("pruneUnprocessed leaves delivery checkpoints unchanged", () => {
      const db = new EventsDb(dbPath);
      for (let i = 0; i < 3; i++) {
        db.insertEvent("s1", { type: "a", category: "file", data: `d${i}`, priority: 3 }, "PostToolUse");
      }
      const result = db.pruneUnprocessed(2, 9999);
      expect(result).toEqual({ pruned: 0 });
      expect(db.getUnprocessed()).toHaveLength(3);
      expect(db.getUnprocessed().every((event) =>
        event.delivery_state === "pending"
        && event.delivery_generation === 0
      )).toBe(true);
      db.close();
    });

    it("pruneErrorLog removes old entries", () => {
      const db = new EventsDb(dbPath);
      db.logHookError("PostToolUse", new Error("old error"), "s1");
      // Backdate the entry
      withSqlite(dbPath, (raw) => raw.exec("UPDATE error_log SET created_at = datetime('now', '-31 days')"));
      // Add a recent entry
      db.logHookError("PostToolUse", new Error("recent error"), "s1");

      const pruned = db.pruneErrorLog(30);
      expect(pruned).toBe(1);

      expect(db.getRecentErrors({ includeMaintenance: true, limit: 10 })).toHaveLength(1);
      db.close();
    });
  });
});
