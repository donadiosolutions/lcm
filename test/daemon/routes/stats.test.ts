import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import {
  backendPublicationConfigSha256,
  backendPublicationJournalPath,
  backendPublicationProjectMapSha256,
  prepareBackendPublication,
} from "../../../src/storage/backend-publication.js";

const temporaryHomes: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("GET /stats", () => {
  let daemon: DaemonInstance;
  let port: number;

  beforeAll(async () => {
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    port = daemon.address().port;
  });

  afterAll(async () => {
    await daemon.stop();
  });

  it("returns 200 with OverallStats shape including redactionCounts", { timeout: 60_000 }, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/stats`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("projects");
    expect(body).toHaveProperty("conversations");
    expect(body).toHaveProperty("messages");
    expect(body).toHaveProperty("summaries");
    expect(body).toHaveProperty("redactionCounts");
    expect(body.redactionCounts).toMatchObject({
      builtIn: expect.any(Number),
      global: expect.any(Number),
      project: expect.any(Number),
      total: expect.any(Number),
    });
  });

  it("redactionCounts.total equals sum of built-in, global, and project", { timeout: 60_000 }, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/stats`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      redactionCounts: { builtIn: number; global: number; project: number; total: number };
    };
    const rc = body.redactionCounts;
    expect(rc.total).toBe(rc.builtIn + rc.global + rc.project);
  });

  it("returns one sanitized failure without reading SQLite during unresolved publication", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-stats-route-publication-"));
    temporaryHomes.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const root = join(home, ".lcm");
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, "config.json"), "{}\n", { mode: 0o600 });
    prepareBackendPublication({
      publicationId: "stats-route-unresolved",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      expectedConfigSha256: backendPublicationConfigSha256(home),
      expectedProjectMapSha256: backendPublicationProjectMapSha256(home),
      intendedConfigSha256: "1".repeat(64),
      intendedProjectMapSha256: "2".repeat(64),
      projects: [{
        localProjectId: "a".repeat(64),
        remoteProjectId: "018f0000-0000-7000-8000-000000000001",
        evidenceSha256: "3".repeat(64),
      }],
      homeDir: home,
    });
    const journalPath = backendPublicationJournalPath(home);
    const before = readFileSync(journalPath, "utf8");

    const res = await fetch(`http://127.0.0.1:${port}/stats`);

    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("Stats collection failed");
    expect(body).not.toContain("stats-route-unresolved");
    expect(readFileSync(journalPath, "utf8")).toBe(before);
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(root, "projects"))).toBe(false);
  });
});
