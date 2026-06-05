import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDaemon } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { addProjectAlias, clearProjectMapCache } from "../../../src/project-map.js";
import { projectDbPath, projectId } from "../../../src/daemon/project.js";
import { eventsDbPath } from "../../../src/db/events-path.js";

const tempDirs: string[] = [];

afterEach(() => {
  clearProjectMapCache();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("daemon routes with project path aliases", () => {
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
