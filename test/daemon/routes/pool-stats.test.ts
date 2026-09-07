import { mkdirSync } from "node:fs";
import { projectsDir } from "../../../src/runtime-paths.js";
import { afterEach, describe, it, expect } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

describe("GET /stats/pool", () => {
  let daemon: DaemonInstance | undefined;

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
  });

  it("returns safe public pool counts without per-connection paths", async () => {
    mkdirSync(projectsDir(), { recursive: true, mode: 0o700 });
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/stats/pool`);
    expect(res.status).toBe(200);
    const data = await res.json() as { backendDiagnostics: { pool: { total: number; idle: number } } };
    expect(data.backendDiagnostics).toMatchObject({ backend: "sqlite", classification: "healthy", pool: { origin: "daemon", status: "ready" } });
    expect(data.backendDiagnostics.pool.total).toBeGreaterThanOrEqual(0);
    expect(data.backendDiagnostics.pool.idle).toBeGreaterThanOrEqual(0);
    expect(data).not.toHaveProperty("connections");
    expect(JSON.stringify(data)).not.toContain('"path"');
  });
});
