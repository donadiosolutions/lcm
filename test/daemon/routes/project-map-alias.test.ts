import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDaemon } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { addProjectAlias, clearProjectMapCache } from "../../../src/project-map.js";
import { projectDbPath, projectId } from "../../../src/daemon/project.js";
import { eventsDbPath } from "../../../src/db/events-path.js";
import { EventsDb } from "../../../src/hooks/events-db.js";
import { promoteEventsForCwd } from "../../../src/daemon/routes/promote-events.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let tempHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "lcm-route-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  clearProjectMapCache();
});

afterEach(() => {
  vi.useRealTimers();
  clearProjectMapCache();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
});

function makeProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("daemon routes with project path aliases", () => {
  it("uses one exact sidecar for lexically equivalent missing cwd paths", async () => {
    const parent = makeProject("lcm-missing-lexical-parent-");
    const missing = join(parent, "missing-project");
    const lexical = `${parent}/unused/../missing-project/`;
    const exactSidecar = eventsDbPath(missing);
    const events = new EventsDb(exactSidecar);
    events.insertEvent(
      "missing-lexical-session",
      { type: "decision", category: "decision", data: "preserve exact sidecar", priority: 1 },
      "PostToolUse",
    );
    events.close();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const config = loadDaemonConfig("/nonexistent");

    await expect(promoteEventsForCwd(config, lexical)).resolves.toMatchObject({
      deferred: { observations: 1 },
    });
    vi.advanceTimersByTime(5 * 60 * 1000);
    await expect(promoteEventsForCwd(config, `${parent}/./missing-project/`))
      .resolves.toMatchObject({ deferred: { observations: 2 } });
    vi.advanceTimersByTime(5 * 60 * 1000);
    await expect(promoteEventsForCwd(config, missing)).resolves.toMatchObject({
      terminal: { kind: "parked", reason: "unavailable-cwd" },
    });

    expect(eventsDbPath(lexical)).toBe(exactSidecar);
    const preserved = new DatabaseSync(exactSidecar, { readOnly: true });
    expect(preserved.prepare(`
      SELECT data, processed_at FROM events
    `).get()).toEqual({ data: "preserve exact sidecar", processed_at: null });
    expect(preserved.prepare(`
      SELECT observations, parked_at FROM missing_cwd_state WHERE id = 1
    `).get()).toEqual({ observations: 3, parked_at: expect.any(String) });
    preserved.close();
  });

  it("preserves a lexical symlink alias at the daemon validation boundary", async () => {
    const canonical = makeProject("lcm-symlink-canonical-");
    const aliasParent = makeProject("lcm-symlink-parent-");
    const alias = join(aliasParent, "project-alias");
    symlinkSync(canonical, alias, "dir");
    addProjectAlias(alias, { canonical });

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const storeRes = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: alias, text: "Stored through a lexical symlink alias" }),
      });
      expect(storeRes.status).toBe(200);
      expect(projectDbPath(alias)).toBe(projectDbPath(canonical));
    } finally {
      await daemon.stop();
    }
  });

  it("routes store/search/ingest/promote/passive sidecar paths through the canonical hash", async () => {
    const canonical = makeProject("lcm-canonical-");
    const alias = makeProject("lcm-alias-");
    const canonicalId = projectId(canonical);
    addProjectAlias(alias, { canonical });

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const storeRes = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: alias, text: "The canonical project uses aliases", tags: ["decision"] }),
      });
      expect(storeRes.status).toBe(200);

      const searchRes = await fetch(`http://127.0.0.1:${port}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: canonical, query: "aliases" }),
      });
      const searchData = await searchRes.json() as { promoted: unknown[] };
      expect(searchRes.status).toBe(200);
      expect(searchData.promoted.length).toBeGreaterThanOrEqual(1);

      const ingestRes = await fetch(`http://127.0.0.1:${port}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: alias,
          session_id: "alias-session",
          messages: [
            { role: "user", content: "We chose the alias route", tokenCount: 5 },
            { role: "assistant", content: "Recorded under canonical identity", tokenCount: 5 },
          ],
        }),
      });
      expect(ingestRes.status).toBe(200);

      const db = new DatabaseSync(projectDbPath(canonical));
      try {
        const row = db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number };
        expect(row.count).toBe(2);
      } finally {
        db.close();
      }

      const promoteRes = await fetch(`http://127.0.0.1:${port}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: alias }),
      });
      expect(promoteRes.status).toBe(200);

      expect(projectId(alias)).toBe(canonicalId);
      expect(projectDbPath(alias)).toBe(projectDbPath(canonical));
      expect(eventsDbPath(alias)).toBe(eventsDbPath(canonical));
    } finally {
      await daemon.stop();
    }
  });
});
