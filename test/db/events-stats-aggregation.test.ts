import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSidecarSummary } from "../../src/db/event-sidecars.js";

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
    ...overrides,
  };
}

describe("event stats aggregation boundaries", () => {
  beforeEach(() => sidecarMock.mockReset());

  it("aggregates pruned, skipped, failed, orphaned, and healthy sidecars", async () => {
    sidecarMock.mockResolvedValue([
      sidecar({ file: "pruned.db", pruned: true }),
      sidecar({ file: "skipped.db", scanSkipped: "budget" }),
      sidecar({ file: "failed.db", captured: 2, unprocessed: 1, metadataMissing: true, scanError: "bad", lastCapture: "2025-01-01" }),
      sidecar({ file: "healthy.db", captured: 3, unprocessed: 1, errors: 4, lastCapture: "2026-01-01" }),
      sidecar({ file: "older.db", captured: 1, lastCapture: "2024-01-01" }),
    ]);

    expect(await collectEventStats(123)).toEqual({
      captured: 6,
      unprocessed: 2,
      errors: 4,
      scanErrors: 1,
      scanSkipped: 1,
      prunedSidecars: 1,
      lastCapture: "2026-01-01",
      sidecars: 5,
      sidecarsWithUnprocessed: 2,
      orphanedSidecarsWithUnprocessed: 1,
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
      sidecar({ file: "skipped.db", scanSkipped: "timeout" }),
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
      scanSkipped: 1,
      prunedSidecars: 1,
      lastCapture: "2026-01-01",
      sidecars: 5,
      sidecarsWithUnprocessed: 2,
      orphanedSidecarsWithUnprocessed: 1,
    });
    expect(result.projects).toHaveLength(5);
    expect(result.recentErrors).toHaveLength(5);
    expect(result.recentErrors.map((entry) => entry.created_at)).toEqual([
      "2026-01-07", "2026-01-06", "2026-01-05", "2026-01-04", "2026-01-03",
    ]);
    expect(sidecarMock).toHaveBeenCalledWith({ maxDbs: 9, includeRecentErrors: true });
  });
});
