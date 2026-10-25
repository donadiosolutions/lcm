import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSidecarSummary } from "../../src/db/event-sidecars.js";
import { localPendingAgeRead } from "../../src/storage/runtime-health.js";

const sidecarMock = vi.hoisted(() => vi.fn<() => Promise<EventSidecarSummary[]>>());

vi.mock("../../src/db/event-sidecars.js", () => ({
  collectEventSidecars: sidecarMock,
}));

import { collectDetailedEventStats, collectEventStats } from "../../src/db/events-stats.js";

function sidecar(overrides: Partial<EventSidecarSummary>): EventSidecarSummary {
  return {
    file: "project.db",
    projectId: "project",
    path: "/events/project.db",
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
    ...overrides,
  };
}

describe("event stats aggregation boundaries", () => {
  beforeEach(() => sidecarMock.mockReset());

  it("aggregates pruned, skipped, failed, orphaned, and healthy sidecars", async () => {
    sidecarMock.mockResolvedValue([
      sidecar({ file: "pruned.db", pruned: true }),
      sidecar({ file: "skipped.db", scanSkipped: "budget", scanSkippedCount: 7 }),
      sidecar({ file: "legacy-skipped.db", scanSkipped: "legacy" }),
      sidecar({ file: "count-without-prose.db", scanSkippedCount: 9 }),
      sidecar({ file: "failed.db", captured: 2, unprocessed: 1, metadataMissing: true, scanError: "bad", lastCapture: "2025-01-01" }),
      sidecar({ file: "healthy.db", captured: 3, unprocessed: 1, errors: 4, lastCapture: "2026-01-01" }),
      sidecar({ file: "older.db", captured: 1, lastCapture: "2024-01-01" }),
    ]);

    expect(await collectEventStats(123)).toEqual({
      captured: 6,
      unprocessed: 2,
      errors: 4,
      scanErrors: 1,
      scanSkipped: 8,
      prunedSidecars: 1,
      lastCapture: "2026-01-01",
      sidecars: 7,
      sidecarsWithUnprocessed: 2,
      orphanedSidecarsWithUnprocessed: 1,
      deliveryPending: 0,
      deliveryClaimed: 0,
      deliveryRetry: 0,
      deliveryReplicated: 0,
      deliveryAcknowledged: 0,
      deliveryAwaitingRemotePrune: 0,
      deliveryQuarantined: 0,
      oldestDeliveryAt: null,
    });
    expect(sidecarMock).toHaveBeenCalledWith({ timeoutMs: 123 });
  });

  it("builds detailed projects and globally sorts and limits recent errors", async () => {
    const errors = Array.from({ length: 7 }, (_, index) => ({
      created_at: `2026-01-0${index + 1}`,
      hook: `hook-${index}`,
      error: `error-${index}`,
    }));
    sidecarMock.mockResolvedValue([
      sidecar({ file: "pruned.db", pruned: true, pruneReason: "empty" }),
      sidecar({ file: "skipped.db", scanSkipped: "timeout", scanSkippedCount: 7 }),
      sidecar({ file: "legacy-skipped.db", scanSkipped: "legacy" }),
      sidecar({ file: "count-without-prose.db", scanSkippedCount: 9 }),
      sidecar({ file: "failed.db", metadataMissing: true, unprocessed: 1, scanError: "bad", recentErrors: errors.slice(0, 4), lastCapture: "2025-01-01" }),
      sidecar({ file: "healthy.db", captured: 3, unprocessed: 1, errors: 2, recentErrors: errors.slice(4), lastCapture: "2026-01-01", cwd: "/project" }),
      sidecar({ file: "empty-errors.db", recentErrors: undefined }),
    ]);

    const result = await collectDetailedEventStats({ maxDbs: 9 });
    expect(result).toMatchObject({
      captured: 3,
      unprocessed: 2,
      errors: 2,
      scanErrors: 1,
      scanSkipped: 8,
      prunedSidecars: 1,
      lastCapture: "2026-01-01",
      sidecars: 7,
      sidecarsWithUnprocessed: 2,
      orphanedSidecarsWithUnprocessed: 1,
    });
    expect(result.projects).toHaveLength(7);
    expect(result.recentErrors).toHaveLength(5);
    expect(result.recentErrors.map((entry) => entry.created_at)).toEqual([
      "2026-01-07", "2026-01-06", "2026-01-05", "2026-01-04", "2026-01-03",
    ]);
    expect(sidecarMock).toHaveBeenCalledWith({ maxDbs: 9, includeRecentErrors: true });
  });

  it("defaults delivery fields from legacy summaries and retains the oldest backlog", async () => {
    const legacy = sidecar({ file: "legacy.db" });
    for (const field of [
      "deliveryPending",
      "deliveryClaimed",
      "deliveryRetry",
      "deliveryReplicated",
      "deliveryAcknowledged",
      "deliveryAwaitingRemotePrune",
      "deliveryQuarantined",
      "oldestDeliveryAt",
    ] as const) {
      Reflect.deleteProperty(legacy, field);
    }
    const summaries = [
      sidecar({ file: "oldest.db", oldestDeliveryAt: "2026-01-01" }),
      sidecar({ file: "newer.db", oldestDeliveryAt: "2026-02-01" }),
      legacy,
    ];
    sidecarMock.mockResolvedValue(summaries);

    await expect(collectEventStats()).resolves.toMatchObject({
      deliveryPending: 0,
      deliveryClaimed: 0,
      deliveryRetry: 0,
      deliveryReplicated: 0,
      deliveryAcknowledged: 0,
      deliveryAwaitingRemotePrune: 0,
      deliveryQuarantined: 0,
      oldestDeliveryAt: "2026-01-01",
    });

    sidecarMock.mockResolvedValue(summaries);
    const detailed = await collectDetailedEventStats();
    expect(detailed.oldestDeliveryAt).toBe("2026-01-01");
    expect(detailed.projects.find(({ file }) => file === "legacy.db")).toMatchObject({
      deliveryPending: 0,
      deliveryClaimed: 0,
      deliveryRetry: 0,
      deliveryReplicated: 0,
      deliveryAcknowledged: 0,
      deliveryAwaitingRemotePrune: 0,
      deliveryQuarantined: 0,
      oldestDeliveryAt: null,
    });
  });
});


describe("internal oldest pending capture time", () => {
  beforeEach(() => sidecarMock.mockReset());
  const readers = [
    ["collectEventStats", (): Promise<{ oldestPendingAt?: string | null }> => collectEventStats(1)],
    ["collectDetailedEventStats", (): Promise<{ oldestPendingAt?: string | null }> => collectDetailedEventStats(1)],
  ] as const;

  it.each(readers)("%s reports a proven empty source as null", async (_name, read) => {
    sidecarMock.mockResolvedValue([]);
    expect((await read()).oldestPendingAt).toBeNull();
    sidecarMock.mockResolvedValue([sidecar({ oldestPendingAt: null }), sidecar({ file: "b.db", oldestPendingAt: null })]);
    expect((await read()).oldestPendingAt).toBeNull();
  });
  it.each(readers)("%s selects the minimum across complete sidecars and ignores pruned ones", async (_name, read) => {
    sidecarMock.mockResolvedValue([
      sidecar({ oldestPendingAt: "2026-02-03 10:00:00" }),
      sidecar({ file: "none.db", oldestPendingAt: null }),
      sidecar({ file: "older.db", oldestPendingAt: "2026-01-01 00:00:00" }),
      sidecar({ file: "newer.db", oldestPendingAt: "2026-03-01 00:00:00" }),
      sidecar({ file: "pruned.db", pruned: true }),
    ]);
    expect((await read()).oldestPendingAt).toBe("2026-01-01 00:00:00");
  });
  it.each(readers)("%s makes the aggregate unknown when any source did not report it", async (_name, read) => {
    for (const unread of [
      sidecar({ file: "legacy.db" }),
      sidecar({ file: "failed.db", scanError: "bad" }),
      sidecar({ file: "skipped.db", scanSkipped: "budget", scanSkippedCount: 2 }),
    ]) {
      for (const order of [[unread, sidecar({ oldestPendingAt: "2026-01-01 00:00:00" })], [sidecar({ oldestPendingAt: "2026-01-01 00:00:00" }), unread]]) {
        sidecarMock.mockResolvedValue(order);
        expect((await read()).oldestPendingAt).toBeUndefined();
      }
    }
  });
  it("never adds the value to a detailed project record", async () => {
    sidecarMock.mockResolvedValue([sidecar({ oldestPendingAt: "2026-01-01 00:00:00" })]);
    expect(Object.keys((await collectDetailedEventStats(1)).projects[0]!)).not.toContain("oldestPendingAt");
  });
  const valid = "2026-02-03 10:00:00";
  const orders = <T>(first: T, second: T): T[][] => [[first, second], [second, first]];
  it.each(readers)("%s keeps an invalid timestamp from being masked by a valid sibling", async (_name, read) => {
    for (const invalid of ["not-a-timestamp", "2026-02-30 10:00:00", "2026-00-01 00:00:00"]) {
      for (const order of orders(valid, invalid)) {
        sidecarMock.mockResolvedValue(order.map((oldestPendingAt, index) => sidecar({ file: index + ".db", oldestPendingAt })));
        expect((await read()).oldestPendingAt).toBe(invalid);
      }
    }
  });
  it.each(readers)("%s keeps an invalid timestamp across null, a later invalid one, and a valid one", async (_name, read) => {
    for (const order of orders<string | null>(null, "not-a-timestamp")) {
      sidecarMock.mockResolvedValue(order.map((oldestPendingAt, index) => sidecar({ file: index + ".db", oldestPendingAt })));
      expect((await read()).oldestPendingAt).toBe("not-a-timestamp");
    }
    sidecarMock.mockResolvedValue([
      sidecar({ oldestPendingAt: "not-a-timestamp" }),
      sidecar({ file: "b.db", oldestPendingAt: "2026-02-30 10:00:00" }),
    ]);
    expect((await read()).oldestPendingAt).toBe("not-a-timestamp");
    sidecarMock.mockResolvedValue([
      sidecar({ oldestPendingAt: "not-a-timestamp" }),
      sidecar({ file: "b.db", oldestPendingAt: valid }),
      sidecar({ file: "c.db", oldestPendingAt: "2025-01-01 00:00:00" }),
    ]);
    expect((await read()).oldestPendingAt).toBe("not-a-timestamp");
  });
  it.each(readers)("%s keeps the aggregate unknown when an unread source meets an invalid timestamp", async (_name, read) => {
    const unread = sidecar({ file: "legacy.db" });
    for (const order of orders(unread, sidecar({ file: "bad.db", oldestPendingAt: "not-a-timestamp" }))) {
      sidecarMock.mockResolvedValue(order);
      expect((await read()).oldestPendingAt).toBeUndefined();
    }
  });
  it.each(readers)("%s leaves a calendar-valid future sibling to the read-time age check", async (_name, read) => {
    const future = "2099-01-01 00:00:00";
    for (const order of orders(valid, future)) {
      sidecarMock.mockResolvedValue(order.map((oldestPendingAt, index) => sidecar({ file: index + ".db", oldestPendingAt })));
      const folded = (await read()).oldestPendingAt;
      expect(folded).toBe(valid);
      expect(localPendingAgeRead(folded, Date.UTC(2026, 1, 3, 11, 0, 0))).toEqual({ value: 3600 });
    }
  });
  it.each(readers)("%s reports an invalid fold as out of range at read time", async (_name, read) => {
    sidecarMock.mockResolvedValue([sidecar({ oldestPendingAt: valid }), sidecar({ file: "b.db", oldestPendingAt: "2026-02-30 10:00:00" })]);
    expect(localPendingAgeRead((await read()).oldestPendingAt, Date.UTC(2026, 1, 3, 11, 0, 0))).toEqual({ reason: "out-of-range" });
  });
});
