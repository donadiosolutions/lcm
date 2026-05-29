// test/db/events-stats.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let mockEventsDir: string;
vi.mock("../../src/db/events-path.js", () => ({
  eventsDir: () => mockEventsDir,
}));

import { collectDetailedEventStats, collectEventStats } from "../../src/db/events-stats.js";
import { collectEventSidecars } from "../../src/db/event-sidecars.js";
import { EventsDb } from "../../src/hooks/events-db.js";

describe("collectEventStats", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "events-stats-test-"));
    mockEventsDir = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns zeros when no sidecar DBs exist", () => {
    const stats = collectEventStats();
    expect(stats.captured).toBe(0);
    expect(stats.unprocessed).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.lastCapture).toBeNull();
  });

  it("aggregates across multiple sidecar DBs", () => {
    const db1 = new EventsDb(join(tempDir, "project1.db"));
    db1.insertEvent("s1", { type: "decision", category: "decision", data: "d1", priority: 1 }, "PostToolUse");
    db1.insertEvent("s1", { type: "file", category: "pattern", data: "f1", priority: 3 }, "PostToolUse");
    db1.logHookError("PostToolUse", new Error("err1"));
    db1.close();

    const db2 = new EventsDb(join(tempDir, "project2.db"));
    db2.insertEvent("s2", { type: "git", category: "workflow", data: "g1", priority: 2 }, "PostToolUse");
    db2.close();

    const stats = collectEventStats();
    expect(stats.captured).toBe(3);
    expect(stats.unprocessed).toBe(3);
    expect(stats.errors).toBe(1);
  });

  it("skips non-.db files in events directory", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tempDir, "not-a-db.txt"), "hello");

    const stats = collectEventStats();
    expect(stats.captured).toBe(0);
  });

  it("handles corrupt DB gracefully", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tempDir, "corrupt.db"), "not a sqlite database");

    const stats = collectEventStats();
    expect(stats.captured).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.scanErrors).toBe(1);
  });

  it("respects timeout budget", () => {
    const stats = collectEventStats(0);
    expect(stats.captured).toBe(0);
  });

  it("surfaces sidecars skipped by scan limits", () => {
    const db1 = new EventsDb(join(tempDir, "project1.db"));
    db1.insertEvent("s1", { type: "decision", category: "decision", data: "d1", priority: 1 }, "PostToolUse");
    db1.close();

    const db2 = new EventsDb(join(tempDir, "project2.db"));
    db2.insertEvent("s2", { type: "decision", category: "decision", data: "d2", priority: 1 }, "PostToolUse");
    db2.close();

    const sidecars = collectEventSidecars({ maxDbs: 1 });
    expect(sidecars).toHaveLength(2);
    expect(sidecars.some((sidecar) => sidecar.scanSkipped === undefined)).toBe(true);
    expect(sidecars.some((sidecar) => (sidecar.scanSkipped ?? "").includes("maxDbs"))).toBe(true);

    const stats = collectEventStats({ maxDbs: 1 });
    expect(stats.scanSkipped).toBe(1);
    expect(stats.scanErrors).toBe(0);
  });

  it("prunes empty orphan sidecars during scans", () => {
    const sidecarPath = join(tempDir, `orphan-empty-${Date.now()}.db`);
    const db = new EventsDb(sidecarPath);
    db.close();

    const sidecars = collectEventSidecars();
    const pruned = sidecars.find((sidecar) => sidecar.path === sidecarPath);

    expect(pruned?.pruned).toBe(true);
    expect(pruned?.pruneReason).toContain("empty orphan");
    expect(existsSync(sidecarPath)).toBe(false);
  });

  it("prunes stale processed orphan sidecars but preserves queued orphan sidecars", () => {
    const stalePath = join(tempDir, `orphan-stale-${Date.now()}.db`);
    const staleDb = new EventsDb(stalePath);
    staleDb.insertEvent("s1", { type: "decision", category: "decision", data: "old", priority: 1 }, "PostToolUse");
    const staleEvents = staleDb.getUnprocessed();
    staleDb.markProcessed(staleEvents.map((event) => event.event_id));
    staleDb.raw().exec("UPDATE events SET created_at = datetime('now', '-31 days')");
    staleDb.close();

    const queuedPath = join(tempDir, `orphan-queued-${Date.now()}.db`);
    const queuedDb = new EventsDb(queuedPath);
    queuedDb.insertEvent("s1", { type: "decision", category: "decision", data: "queued", priority: 1 }, "PostToolUse");
    queuedDb.close();

    const sidecars = collectEventSidecars();
    const pruned = sidecars.find((sidecar) => sidecar.path === stalePath);
    const queued = sidecars.find((sidecar) => sidecar.path === queuedPath);

    expect(pruned?.pruned).toBe(true);
    expect(pruned?.pruneReason).toContain("stale orphan");
    expect(existsSync(stalePath)).toBe(false);
    expect(queued?.pruned).toBeUndefined();
    expect(queued?.unprocessed).toBe(1);
    expect(existsSync(queuedPath)).toBe(true);
  });

  it("preserves orphan sidecars with recent hook errors", () => {
    const sidecarPath = join(tempDir, `orphan-errors-${Date.now()}.db`);
    const db = new EventsDb(sidecarPath);
    db.logHookError("PostToolUse", new Error("recent failure"));
    db.close();

    const sidecars = collectEventSidecars();
    const preserved = sidecars.find((sidecar) => sidecar.path === sidecarPath);

    expect(preserved?.pruned).toBeUndefined();
    expect(preserved?.errors).toBe(1);
    expect(existsSync(sidecarPath)).toBe(true);
  });

  it("includes scan failures in detailed project stats", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tempDir, "corrupt.db"), "not a sqlite database");

    const stats = collectDetailedEventStats();
    expect(stats.errors).toBe(0);
    expect(stats.scanErrors).toBe(1);
    expect(stats.projects).toHaveLength(1);
    expect(stats.projects[0].scanError).toBeTruthy();
    expect(stats.projects[0].path).toContain("corrupt.db");
  });
});
