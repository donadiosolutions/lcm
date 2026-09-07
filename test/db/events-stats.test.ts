// test/db/events-stats.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

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
import {
  serializeWorktreeReconciliationFence,
} from "../../src/worktree-reconciliation-fence.js";

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

  it("returns zeros when no sidecar DBs exist", async () => {
    const stats = await collectEventStats();
    expect(stats.captured).toBe(0);
    expect(stats.unprocessed).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.lastCapture).toBeNull();
    expect(stats.deliveryPending).toBe(0);
    expect(stats.deliveryQuarantined).toBe(0);
    expect(stats.oldestDeliveryAt).toBeNull();
  });

  it("aggregates across multiple sidecar DBs", async () => {
    const db1 = new EventsDb(join(tempDir, "project1.db"));
    db1.insertEvent("s1", { type: "decision", category: "decision", data: "d1", priority: 1 }, "PostToolUse");
    db1.insertEvent("s1", { type: "file", category: "pattern", data: "f1", priority: 3 }, "PostToolUse");
    db1.logHookError("PostToolUse", new Error("err1"));
    db1.close();

    const db2 = new EventsDb(join(tempDir, "project2.db"));
    db2.insertEvent("s2", { type: "git", category: "workflow", data: "g1", priority: 2 }, "PostToolUse");
    db2.close();

    const stats = await collectEventStats();
    expect(stats.captured).toBe(3);
    expect(stats.unprocessed).toBe(3);
    expect(stats.errors).toBe(1);
    expect(stats.deliveryPending).toBe(3);
    expect(stats.oldestDeliveryAt).not.toBeNull();
  });

  it("skips non-.db files in events directory", async () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tempDir, "not-a-db.txt"), "hello");

    const stats = await collectEventStats();
    expect(stats.captured).toBe(0);
  });

  it("handles corrupt DB gracefully", async () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tempDir, "corrupt.db"), "not a sqlite database");

    const stats = await collectEventStats();
    expect(stats.captured).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.scanErrors).toBe(1);
  });

  it("respects timeout budget", async () => {
    const db = new EventsDb(join(tempDir, "timeout.db"));
    db.close();
    const stats = await collectEventStats(0);
    expect(stats.captured).toBe(0);
    expect(stats.scanSkipped).toBe(1);
  });

  it("returns no sidecars when the events directory cannot be read", async () => {
    mockEventsDir = join(tempDir, "missing-events-dir");
    expect(await collectEventSidecars()).toEqual([]);
  });

  it("loads valid project metadata and ignores invalid or empty metadata", async () => {
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

    const sidecars = await collectEventSidecars({ pruneOrphanSidecars: false });
    expect(sidecars.find((entry) => entry.projectId === "valid-meta")?.cwd).toBe("/workspace/project");
    for (const projectId of ["invalid-meta", "empty-meta", "typed-meta"]) {
      expect(sidecars.find((entry) => entry.projectId === projectId)?.cwd).toBeUndefined();
    }
  });

  it("preserves fresh and malformed-date processed orphan sidecars", async () => {
    for (const [file, createdAt] of [
      ["fresh.db", "datetime('now')"],
      ["invalid-date.db", "'invalid'"],
    ] as const) {
      const path = join(tempDir, file);
      const db = new EventsDb(path);
      db.insertEvent("s", { type: "decision", category: "decision", data: file, priority: 1 }, "PostToolUse");
      const events = db.getUnprocessed();
      db.markProcessed(events.map((event) => event.event_id));
      const [claim] = db.claimDeliveries({
        machineId: "0195d250-0000-7000-8000-000000000091",
        claimOwner: `terminal-${file}`,
        limit: 1,
        staleClaimMs: 1_000,
      });
      expect(db.markReplicated(claim.event_uuid, `terminal-${file}`, 41n)).toBe(true);
      expect(db.markAcknowledged(claim.event_uuid, 41n)).toBe(true);
      expect(db.markRemotePruned(claim.event_uuid)).toBe(true);
      db.close();
      const raw = new DatabaseSync(path);
      raw.exec("PRAGMA journal_mode = WAL");
      raw.exec("PRAGMA foreign_keys = ON");
      raw.exec(`UPDATE events SET created_at = ${createdAt}`);
      raw.close();
    }

    const sidecars = await collectEventSidecars({ pruneOrphanSidecars: true });
    expect(sidecars.find((entry) => entry.file === "fresh.db")?.pruned).toBeUndefined();
    expect(sidecars.find((entry) => entry.file === "invalid-date.db")?.pruned).toBeUndefined();
  });

  it("normalizes non-Error sidecar scan failures", async () => {
    writeFileSync(join(tempDir, "string-error.db"), "trigger");
    expect((await collectEventSidecars({ pruneOrphanSidecars: true }))[0].scanError)
      .toBe("failed to scan sidecar");
  });

  it("surfaces sidecars skipped by scan limits", async () => {
    const db1 = new EventsDb(join(tempDir, "project1.db"));
    db1.insertEvent("s1", { type: "decision", category: "decision", data: "d1", priority: 1 }, "PostToolUse");
    db1.close();

    const db2 = new EventsDb(join(tempDir, "project2.db"));
    db2.insertEvent("s2", { type: "decision", category: "decision", data: "d2", priority: 1 }, "PostToolUse");
    db2.close();

    const sidecars = await collectEventSidecars({ maxDbs: 1 });
    expect(sidecars).toHaveLength(2);
    expect(sidecars.some((sidecar) => sidecar.scanSkipped === undefined)).toBe(true);
    expect(sidecars.some((sidecar) => (sidecar.scanSkipped ?? "").includes("maxDbs"))).toBe(true);

    const stats = await collectEventStats({ maxDbs: 1 });
    expect(stats.scanSkipped).toBe(1);
    expect(stats.scanErrors).toBe(0);
  });

  it("can start scans from a rotated sidecar index", async () => {
    for (const file of ["a.db", "b.db", "c.db"]) {
      const db = new EventsDb(join(tempDir, file));
      db.insertEvent("s1", { type: "decision", category: "decision", data: file, priority: 1 }, "PostToolUse");
      db.close();
    }

    const sidecars = await collectEventSidecars({ maxDbs: 1, startIndex: 1, pruneOrphanSidecars: false });

    expect(sidecars[0].file).toBe("b.db");
    expect(sidecars[0].scanSkipped).toBeUndefined();
    expect(sidecars).toHaveLength(2);
    expect(sidecars[1].scanSkipped).toContain("2 sidecars");
  });

  it("omits exact reconciliation fences before ordering and scan budgets", async () => {
    const hash = "0".repeat(64);
    const fencePath = join(tempDir, `${hash}.db`);
    mkdirSync(fencePath);
    writeFileSync(
      join(fencePath, "fence.json"),
      serializeWorktreeReconciliationFence(hash, "events"),
    );
    for (const file of ["a.db", "b.db"]) {
      const db = new EventsDb(join(tempDir, file));
      db.insertEvent(
        "s1",
        { type: "decision", category: "decision", data: file, priority: 1 },
        "PostToolUse",
      );
      db.close();
    }

    const sidecars = await collectEventSidecars({
      maxDbs: 1,
      startIndex: 1,
      pruneOrphanSidecars: false,
    });
    expect(sidecars[0].file).toBe("b.db");
    expect(sidecars[1].scanSkipped).toContain("1 sidecar");
    expect(sidecars.some((sidecar) => sidecar.projectId === hash)).toBe(false);
    expect(existsSync(join(fencePath, "fence.json"))).toBe(true);
  });

  it("does not count, open, or prune a lone exact reconciliation fence", async () => {
    const hash = "a".repeat(64);
    const fencePath = join(tempDir, `${hash}.db`);
    mkdirSync(fencePath);
    writeFileSync(
      join(fencePath, "fence.json"),
      serializeWorktreeReconciliationFence(hash, "events"),
    );

    expect(await collectEventSidecars({ maxDbs: 0 })).toEqual([]);
    expect(existsSync(join(fencePath, "fence.json"))).toBe(true);
  });

  it("surfaces every malformed or ambiguous fence candidate as a scan failure", async () => {
    const candidates = [
      ["1", "{"],
      [
        "2",
        `${JSON.stringify({ version: 1, hash: "3".repeat(64), kind: "events" })}\n`,
      ],
      [
        "3",
        `${JSON.stringify({ version: 1, hash: "3".repeat(64), kind: "project" })}\n`,
      ],
      [
        "4",
        `${JSON.stringify({ version: 2, hash: "4".repeat(64), kind: "events" })}\n`,
      ],
      ["5", "x".repeat(1025)],
    ] as const;
    for (const [digit, marker] of candidates) {
      const path = join(tempDir, `${digit.repeat(64)}.db`);
      mkdirSync(path);
      writeFileSync(join(path, "fence.json"), marker);
    }

    const extraHash = "6".repeat(64);
    const extraPath = join(tempDir, `${extraHash}.db`);
    mkdirSync(extraPath);
    writeFileSync(
      join(extraPath, "fence.json"),
      serializeWorktreeReconciliationFence(extraHash, "events"),
    );
    writeFileSync(join(extraPath, "unexpected"), "entry");

    mkdirSync(join(tempDir, `${"7".repeat(64)}.db`));
    const symlinkTarget = join(tempDir, "valid-fence-target");
    mkdirSync(symlinkTarget);
    writeFileSync(
      join(symlinkTarget, "fence.json"),
      serializeWorktreeReconciliationFence("8".repeat(64), "events"),
    );
    symlinkSync(symlinkTarget, join(tempDir, `${"8".repeat(64)}.db`), "dir");
    const nonHashPath = join(tempDir, "not-a-project-hash.db");
    mkdirSync(nonHashPath);
    writeFileSync(
      join(nonHashPath, "fence.json"),
      serializeWorktreeReconciliationFence("9".repeat(64), "events"),
    );

    const sidecars = await collectEventSidecars({ pruneOrphanSidecars: true });
    expect(sidecars).toHaveLength(9);
    expect(sidecars.every((sidecar) =>
      sidecar.scanError === "sidecar path is not a regular file"
    )).toBe(true);
    expect(sidecars.every((sidecar) => sidecar.pruned === undefined)).toBe(true);
  });

  it("bounds truncation reporting to one summary regardless of skipped file count", async () => {
    for (let i = 0; i < 100; i++) writeFileSync(join(tempDir, `placeholder-${i}.db`), "");
    const sidecars = await collectEventSidecars({ maxDbs: 0, pruneOrphanSidecars: false });
    expect(sidecars).toHaveLength(1);
    expect(sidecars[0].scanSkipped).toContain("100 sidecars");
  });

  it("prunes empty orphan sidecars by default", async () => {
    const sidecarPath = join(tempDir, `orphan-empty-${Date.now()}.db`);
    const db = new EventsDb(sidecarPath);
    db.close();

    const sidecars = await collectEventSidecars();
    const pruned = sidecars.find((sidecar) => sidecar.path === sidecarPath);

    expect(pruned?.pruned).toBe(true);
    expect(pruned?.pruneReason).toContain("empty orphan");
    expect(existsSync(sidecarPath)).toBe(false);
  });

  it("preserves stale processed sidecars until remote delivery and queued sidecars", async () => {
    const stalePath = join(tempDir, `orphan-stale-${Date.now()}.db`);
    const staleDb = new EventsDb(stalePath);
    staleDb.insertEvent("s1", { type: "decision", category: "decision", data: "old", priority: 1 }, "PostToolUse");
    const staleEvents = staleDb.getUnprocessed();
    staleDb.markProcessed(staleEvents.map((event) => event.event_id));
    staleDb.close();
    const raw = new DatabaseSync(stalePath);
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec("UPDATE events SET created_at = datetime('now', '-31 days')");
    raw.close();

    const queuedPath = join(tempDir, `orphan-queued-${Date.now()}.db`);
    const queuedDb = new EventsDb(queuedPath);
    queuedDb.insertEvent("s1", { type: "decision", category: "decision", data: "queued", priority: 1 }, "PostToolUse");
    queuedDb.close();

    const sidecars = await collectEventSidecars({ pruneOrphanSidecars: true });
    const retained = sidecars.find((sidecar) => sidecar.path === stalePath);
    const queued = sidecars.find((sidecar) => sidecar.path === queuedPath);

    expect(retained?.pruned).toBeUndefined();
    expect(retained?.deliveryPending).toBe(1);
    expect(existsSync(stalePath)).toBe(true);
    expect(queued?.pruned).toBeUndefined();
    expect(queued?.unprocessed).toBe(1);
    expect(existsSync(queuedPath)).toBe(true);
  });

  it("retains an acknowledged orphan until exact remote pruning is checkpointed", async () => {
    const sidecarPath = join(tempDir, `orphan-awaiting-prune-${Date.now()}.db`);
    const db = new EventsDb(sidecarPath);
    db.insertEvent(
      "s1",
      { type: "decision", category: "decision", data: "applied", priority: 1 },
      "PostToolUse",
    );
    const [event] = db.getUnprocessed();
    db.markProcessed([event.event_id]);
    const [claim] = db.claimDeliveries({
      machineId: "0195d250-0000-7000-8000-000000000091",
      claimOwner: "retention-test",
      limit: 1,
      staleClaimMs: 1_000,
    });
    expect(db.markReplicated(claim.event_uuid, "retention-test", 41n)).toBe(true);
    expect(db.markAcknowledged(claim.event_uuid, 41n)).toBe(true);
    db.close();
    const raw = new DatabaseSync(sidecarPath);
    raw.exec("UPDATE events SET created_at = datetime('now', '-31 days')");
    raw.close();

    const retained = (await collectEventSidecars({ pruneOrphanSidecars: true }))
      .find((sidecar) => sidecar.path === sidecarPath);
    expect(retained?.deliveryAwaitingRemotePrune).toBe(1);
    expect(retained?.pruned).toBeUndefined();
    expect(existsSync(sidecarPath)).toBe(true);

    const checkpoint = new EventsDb(sidecarPath);
    expect(checkpoint.markRemotePruned(event.event_uuid)).toBe(true);
    checkpoint.close();
    const pruned = (await collectEventSidecars({ pruneOrphanSidecars: true }))
      .find((sidecar) => sidecar.path === sidecarPath);
    expect(pruned?.pruned).toBe(true);
    expect(existsSync(sidecarPath)).toBe(false);
  });

  it("preserves orphan sidecars with recent hook errors", async () => {
    const sidecarPath = join(tempDir, `orphan-errors-${Date.now()}.db`);
    const db = new EventsDb(sidecarPath);
    db.logHookError("PostToolUse", new Error("recent failure"));
    db.close();

    const sidecars = await collectEventSidecars({ pruneOrphanSidecars: true });
    const preserved = sidecars.find((sidecar) => sidecar.path === sidecarPath);

    expect(preserved?.pruned).toBeUndefined();
    expect(preserved?.errors).toBe(1);
    expect(existsSync(sidecarPath)).toBe(true);
  });

  it("includes scan failures in detailed project stats", async () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tempDir, "corrupt.db"), "not a sqlite database");

    const stats = await collectDetailedEventStats();
    expect(stats.errors).toBe(0);
    expect(stats.scanErrors).toBe(1);
    expect(stats.projects).toHaveLength(1);
    expect(stats.projects[0].scanError).toBeTruthy();
    expect(stats.projects[0].path).toContain("corrupt.db");
  });

  it("includes recent errors from healthy sidecars in detailed stats", async () => {
    const db = new EventsDb(join(tempDir, "detailed.db"));
    db.insertEvent("s", { type: "decision", category: "decision", data: "d", priority: 1 }, "PostToolUse");
    db.logHookError("PostToolUse", new Error("detailed failure"));
    db.close();

    const stats = await collectDetailedEventStats({ pruneOrphanSidecars: false });
    expect(stats.recentErrors.some((entry) => entry.error.includes("detailed failure"))).toBe(true);
  });
});
