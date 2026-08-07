import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerResponse } from "node:http";
import { EventsDb } from "../../../src/hooks/events-db.js";
import { createPromoteEventsHandler } from "../../../src/daemon/routes/promote-events.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import {
  addProjectAlias,
  clearProjectMapCache,
  hashProjectPath,
  projectMapPath,
  resolveProjectIdentity,
} from "../../../src/project-map.js";
import { eventsDbPath, existingEventsDbPath, eventsDir } from "../../../src/db/events-path.js";
import { lcmHomeDir, projectsDir } from "../../../src/runtime-paths.js";

function mockResponse(): {
  readonly res: ServerResponse;
  readonly status: () => number;
  readonly body: () => Record<string, unknown>;
} {
  let statusCode = 0;
  let responseBody = "";
  const res = {
    writeHead: (status: number) => {
      statusCode = status;
    },
    end: (body?: string) => {
      responseBody = body ?? "";
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => statusCode,
    body: () => JSON.parse(responseBody) as Record<string, unknown>,
  };
}

describe("promote-events missing-cwd identity lookup", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "lcm-promote-missing-cwd-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    clearProjectMapCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearProjectMapCache();
    rmSync(homeDir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it("does not mutate map.json for an unrecorded missing cwd", async () => {
    const recorded = mkdtempSync(join(homeDir, "recorded-project-"));
    resolveProjectIdentity(recorded);
    const mapBefore = readFileSync(projectMapPath(), "utf8");
    const missing = join(homeDir, "workspace", "typo-project");
    mkdirSync(dirname(missing), { recursive: true });

    const response = mockResponse();
    const handler = createPromoteEventsHandler(loadDaemonConfig(join(homeDir, "config")));
    await handler({} as never, response.res, JSON.stringify({
      cwd: `${dirname(missing)}/unused/../${basename(missing)}/`,
    }));

    expect(response.status()).toBe(200);
    expect(response.body()).toMatchObject({
      terminal: { kind: "parked", reason: "unavailable-cwd" },
      message: "no sidecar events to park for unavailable cwd",
    });
    expect(readFileSync(projectMapPath(), "utf8")).toBe(mapBefore);
    expect(existsSync(join(lcmHomeDir(), "events"))).toBe(false);
  });

  it("finds a legacy-hash sidecar without creating map or metadata identity", async () => {
    const missing = join(homeDir, "legacy-hash-project");
    const sidecar = join(eventsDir(), `${hashProjectPath(missing)}.db`);
    const events = new EventsDb(sidecar);
    events.insertEvent(
      "legacy-hash-session",
      { type: "decision", category: "decision", data: "retain legacy event", priority: 1 },
      "PostToolUse",
    );
    events.close();

    expect(existsSync(projectMapPath())).toBe(false);
    expect(existsSync(projectsDir())).toBe(false);
    expect(existingEventsDbPath(missing)).toBe(sidecar);

    const response = mockResponse();
    const handler = createPromoteEventsHandler(loadDaemonConfig(join(homeDir, "config")));
    await handler({} as never, response.res, JSON.stringify({ cwd: missing }));

    expect(response.status()).toBe(200);
    expect(response.body()).toMatchObject({
      deferred: { observations: 1 },
      errors: 0,
    });
    expect(existsSync(projectMapPath())).toBe(false);
    expect(existsSync(projectsDir())).toBe(false);
  });

  it("finds an existing sidecar through an explicit alias after path.resolve normalization", async () => {
    const canonical = mkdtempSync(join(homeDir, "canonical-project-"));
    const alias = mkdtempSync(join(homeDir, "alias-project-"));
    resolveProjectIdentity(canonical);
    addProjectAlias(alias, { canonical });
    const sidecar = eventsDbPath(canonical);
    const events = new EventsDb(sidecar);
    events.insertEvent(
      "alias-session",
      { type: "decision", category: "decision", data: "retain alias event", priority: 1 },
      "PostToolUse",
    );
    events.close();
    const mapBefore = readFileSync(projectMapPath(), "utf8");
    rmSync(alias, { recursive: true, force: true });
    const lexicalAlias = `${dirname(alias)}/unused/../${basename(alias)}/`;
    const expectedSidecar = existingEventsDbPath(lexicalAlias);
    expect(expectedSidecar).toBe(sidecar);

    const response = mockResponse();
    const handler = createPromoteEventsHandler(loadDaemonConfig(join(homeDir, "config")));
    await handler({} as never, response.res, JSON.stringify({ cwd: lexicalAlias }));

    expect(response.status()).toBe(200);
    expect(response.body()).toMatchObject({ deferred: { observations: 1 }, errors: 0 });
    expect(readFileSync(projectMapPath(), "utf8")).toBe(mapBefore);
    const state = new EventsDb(sidecar);
    expect(state.getHealthStats().totalEvents).toBe(1);
    state.close();
  });

  it("discovers a missing cwd sidecar from existing project metadata without publishing the map", async () => {
    const missing = join(homeDir, "metadata-project");
    const projectId = hashProjectPath(missing);
    mkdirSync(join(projectsDir(), projectId), { recursive: true });
    writeFileSync(
      join(projectsDir(), projectId, "meta.json"),
      JSON.stringify({ cwd: missing }) + "\n",
    );
    const sidecar = join(eventsDir(), `${projectId}.db`);
    const events = new EventsDb(sidecar);
    events.insertEvent(
      "metadata-session",
      { type: "decision", category: "decision", data: "retain metadata event", priority: 1 },
      "PostToolUse",
    );
    events.close();

    const response = mockResponse();
    const handler = createPromoteEventsHandler(loadDaemonConfig(join(homeDir, "config")));
    await handler({} as never, response.res, JSON.stringify({ cwd: `${missing}/./` }));

    expect(response.status()).toBe(200);
    expect(response.body()).toMatchObject({ deferred: { observations: 1 }, errors: 0 });
    expect(existsSync(projectMapPath())).toBe(false);
    const state = new EventsDb(sidecar);
    expect(state.getHealthStats().totalEvents).toBe(1);
    state.close();
  });
});
