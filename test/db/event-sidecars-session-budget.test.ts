import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadDiagnosticSqliteOptions } from "../../src/db/diagnostic-sqlite.js";

const diagnostic = vi.hoisted(() => ({
  read: vi.fn(),
  original: null as null | ((options: ReadDiagnosticSqliteOptions) => Promise<unknown[]>),
}));
vi.mock("../../src/db/diagnostic-sqlite.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/db/diagnostic-sqlite.js")>();
  diagnostic.original = actual.readDiagnosticSqlite;
  return { ...actual, readDiagnosticSqlite: diagnostic.read };
});

import { collectEventSidecars } from "../../src/db/event-sidecars.js";
import { EventsDb } from "../../src/hooks/events-db.js";

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  diagnostic.read.mockReset();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it("continues a read-only scan past two seconds and stops at its overall budget", async () => {
  const home = mkdtempSync(join(tmpdir(), "lcm-sidecar-session-budget-"));
  homes.push(home);
  const eventsDir = join(home, ".lcm", "events");
  mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
  const ids = ["a", "b", "c"].map(letter => letter.repeat(64));
  for (const id of ids) {
    const db = new EventsDb(join(eventsDir, `${id}.db`));
    db.insertEvent("session", {
      type: "decision", category: "decision", data: `event for ${id}`, priority: 1,
    }, "PostToolUse");
    db.close();
  }

  const realNow = Date.now.bind(Date);
  let budgetOffsetMs = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + budgetOffsetMs);
  let reads = 0;
  diagnostic.read.mockImplementation(async (options: ReadDiagnosticSqliteOptions) => {
    reads++;
    if (reads === 2) await new Promise(resolve => setTimeout(resolve, 2100));
    return diagnostic.original!(options);
  });

  const summaries = await collectEventSidecars({
    homeDir: home, pruneOrphanSidecars: false, timeoutMs: 30_000, maxDbs: 3,
    _afterSidecarForTesting: summary => {
      if (summary.projectId === ids[1]) budgetOffsetMs = 30_000;
    },
  });
  expect(diagnostic.read).toHaveBeenCalledTimes(2);
  expect(summaries.map(summary => summary.projectId)).toEqual(ids);
  expect(summaries.slice(0, 2).map(summary => summary.unprocessed)).toEqual([1, 1]);
  expect(summaries[1]?.scanSkipped).toBeUndefined();
  expect(summaries[2]?.scanSkipped).toContain("timeout");
});
