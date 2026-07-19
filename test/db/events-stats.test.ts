// test/db/events-stats.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let mockEventsDir: string;
let mockProjectsDir: string;
vi.mock("../../src/db/events-path.js", () => ({
  eventsDir: () => mockEventsDir,
}));
vi.mock("../../src/runtime-paths.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/runtime-paths.js")>(),
  projectsDir: () => mockProjectsDir,
}));
vi.mock("../../src/hooks/events-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/events-db.js")>();
  return {
    ...actual,
    EventsDb: class extends actual.EventsDb {
      constructor(path: string) {
        if (path.endsWith("string-error.db")) throw "non-error failure";
        super(path);
      }
    },
  };
});

import { collectDetailedEventStats, collectEventStats } from "../../src/db/events-stats.js";
import { collectEventSidecars } from "../../src/db/event-sidecars.js";
import { EventsDb } from "../../src/hooks/events-db.js";

describe("collectEventStats", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "events-stats-test-"));
    mockEventsDir = tempDir;
    mockProjectsDir = join(tempDir, "projects");
    mkdirSync(mockProjectsDir, { recursive: true });
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
    const db = new EventsDb(join(tempDir, "timeout.db"));
    db.close();
    const stats = collectEventStats(0);
    expect(stats.captured).toBe(0);
    expect(stats.scanSkipped).toBe(1);
  });

  it("returns no sidecars when the events directory cannot be read", () => {
    mockEventsDir = join(tempDir, "missing-events-dir");
    expect(collectEventSidecars()).toEqual([]);
  });

  it("loads valid project metadata and ignores invalid or empty metadata", () => {
    for (const [projectId, metadata] of [
      ["valid-meta", JSON.stringify({ cwd: "/workspace/project" })],
      ["invalid-meta", "not-json"],
      ["empty-meta", JSON.stringify({ cwd: "" })],
      ["typed-meta", JSON.stringify({ cwd: 42 })],
    ] as const) {
      const db = new EventsDb(join(tempDir, `${projectId}.db`));
      db.insertEvent("s", { type: "decision", category: "decision", data: projectId, priority: 1 }, "PostToolUse");
      db.close();
      const projectDir = join(mockProjectsDir, projectId);
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "meta.json"), metadata);
    }

    const sidecars = collectEventSidecars({ pruneOrphanSidecars: false });
    expect(sidecars.find((entry) => entry.projectId === "valid-meta")?.cwd).toBe("/workspace/project");
    for (const projectId of ["invalid-meta", "empty-meta", "typed-meta"]) {
      expect(sidecars.find((entry) => entry.projectId === projectId)?.cwd).toBeUndefined();
    }
  });

  it("preserves fresh and malformed-date processed orphan sidecars", () => {
    for (const [file, createdAt] of [
      ["fresh.db", "datetime('now')"],
      ["invalid-date.db", "'invalid'"],
      ["null-date.db", "NULL"],
    ] as const) {
      const path = join(tempDir, file);
      const db = new EventsDb(path);
      db.insertEvent("s", { type: "decision", category: "decision", data: file, priority: 1 }, "PostToolUse");
      const events = db.getUnprocessed();
      db.markProcessed(events.map((event) => event.event_id));
      db.raw().exec(`UPDATE events SET created_at = ${createdAt}`);
      db.close();
    }

    const sidecars = collectEventSidecars({ pruneOrphanSidecars: true });
    expect(sidecars.find((entry) => entry.file === "fresh.db")?.pruned).toBeUndefined();
    expect(sidecars.find((entry) => entry.file === "invalid-date.db")?.pruned).toBeUndefined();
    expect(sidecars.find((entry) => entry.file === "null-date.db")?.pruned).toBeUndefined();
  });

  it("normalizes non-Error sidecar scan failures", () => {
    writeFileSync(join(tempDir, "string-error.db"), "trigger");
    expect(collectEventSidecars({ pruneOrphanSidecars: false })[0].scanError)
      .toBe("failed to scan sidecar");
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

  it("can start scans from a rotated sidecar index", () => {
    for (const file of ["a.db", "b.db", "c.db"]) {
      const db = new EventsDb(join(tempDir, file));
      db.insertEvent("s1", { type: "decision", category: "decision", data: file, priority: 1 }, "PostToolUse");
      db.close();
    }

    const sidecars = collectEventSidecars({ maxDbs: 1, startIndex: 1, pruneOrphanSidecars: false });

    expect(sidecars[0].file).toBe("b.db");
    expect(sidecars[0].scanSkipped).toBeUndefined();
    expect(sidecars).toHaveLength(2);
    expect(sidecars[1].scanSkipped).toContain("2 sidecars");
  });

  it("bounds truncation reporting to one summary regardless of skipped file count", () => {
    for (let i = 0; i < 100; i++) writeFileSync(join(tempDir, `placeholder-${i}.db`), "");
    const sidecars = collectEventSidecars({ maxDbs: 0, pruneOrphanSidecars: false });
    expect(sidecars).toHaveLength(1);
    expect(sidecars[0].scanSkipped).toContain("100 sidecars");
  });

  it("prunes empty orphan sidecars by default", () => {
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

    const sidecars = collectEventSidecars({ pruneOrphanSidecars: true });
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

    const sidecars = collectEventSidecars({ pruneOrphanSidecars: true });
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

  it("includes recent errors from healthy sidecars in detailed stats", () => {
    const db = new EventsDb(join(tempDir, "detailed.db"));
    db.insertEvent("s", { type: "decision", category: "decision", data: "d", priority: 1 }, "PostToolUse");
    db.logHookError("PostToolUse", new Error("detailed failure"));
    db.close();

    const stats = collectDetailedEventStats({ pruneOrphanSidecars: false });
    expect(stats.recentErrors.some((entry) => entry.error.includes("detailed failure"))).toBe(true);
  });
});
