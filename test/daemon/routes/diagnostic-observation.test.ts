import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPoolStatsHandler } from "../../../src/daemon/routes/pool-stats.js";
import { createStatusHandler } from "../../../src/daemon/routes/status.js";
import { getLcmConnection, closeLcmConnection } from "../../../src/db/connection.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

const roots: string[] = [];
function home() {
  const root = mkdtempSync(join(tmpdir(), "lcm-diagnostic-route-"));
  roots.push(root);
  mkdirSync(join(root, ".lcm"), { mode: 0o700 });
  writeFileSync(join(root, ".lcm", "config.json"), "{}", { mode: 0o600 });
  return root;
}
function response() {
  const value = { statusCode: 0, writeHead: vi.fn(), setHeader: vi.fn(), end: vi.fn() };
  return { value, json: () => JSON.parse(String(value.end.mock.calls[0]?.[0])) };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("diagnostic route observation", () => {
  it("never serializes connection paths from an active SQLite pool", async () => {
    const root = home();
    vi.stubEnv("HOME", root);
    const path = join(root, "secret-pool-canary.sqlite");
    const db = getLcmConnection(path);
    const res = response();
    try {
      await createPoolStatsHandler()({} as never, res.value as never, "");
      expect(JSON.stringify(res.json())).not.toContain("secret-pool-canary");
      expect(res.json()).toHaveProperty("backendDiagnostics");
    } finally { closeLcmConnection(path, db); }
  });

  it("status does not register an unknown project or change authority files", async () => {
    const root = home();
    vi.stubEnv("HOME", root);
    const configFile = join(root, ".lcm", "config.json");
    const before = readFileSync(configFile);
    const res = response();
    await createStatusHandler(loadDaemonConfig(configFile), Date.now())(
      {} as never, res.value as never, JSON.stringify({ cwd: root }),
    );
    expect(readFileSync(configFile)).toEqual(before);
    expect(existsSync(join(root, ".lcm", "projects", "map.json"))).toBe(false);
    expect(existsSync(join(root, ".lcm.backend-publication.consumer.lock"))).toBe(false);
    expect(res.json()).toHaveProperty("backendDiagnostics");
  });
});
