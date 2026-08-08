import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  eventSequenceDbPath,
  eventsDbPath,
  eventsDir,
  existingEventsDbPath,
} from "../../src/db/events-path.js";
import { hashProjectPath, normalizeProjectIdentityPath, normalizeProjectPath, projectMapPath } from "../../src/project-map.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tmpdir } from "node:os";

describe("backend-independent local project identity", () => {
  let previousHome: string | undefined;
  let home: string;
  let project: string;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "lcm-events-path-home-"));
    project = mkdtempSync(join(tmpdir(), "lcm-events-path-project-"));
    process.env.HOME = home;
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("keeps the sidecar ID stable while an existing map switches keys", () => {
    const canonical = normalizeProjectIdentityPath(project);
    const stableId = hashProjectPath(canonical);
    const legacyId = "a".repeat(64);
    const mapPath = projectMapPath();
    const publish = (id: string): void => {
      const temporaryPath = `${mapPath}.${id}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify({
        [id]: { canonical, aliases: [] },
      }), { mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, mapPath);
    };

    publish(legacyId);
    const expected = eventsDbPath(project);
    expect(expected).toBe(join(home, ".lcm", "events", `${stableId}.db`));
    for (let index = 0; index < 8; index += 1) {
      publish(index % 2 === 0 ? stableId : legacyId);
      expect(eventsDbPath(project)).toBe(expected);
    }
  });

  it("keeps the existing-only probe read-only while recovering an orphaned sidecar", () => {
    const unavailable = join(project, "gone");
    expect(existingEventsDbPath(unavailable)).toBeUndefined();
    expect(existsSync(projectMapPath())).toBe(false);

    const sidecarDir = join(home, ".lcm", "events");
    mkdirSync(sidecarDir, { recursive: true, mode: 0o700 });
    const sidecar = join(sidecarDir, `${hashProjectPath(normalizeProjectPath(unavailable))}.db`);
    writeFileSync(sidecar, "");
    expect(existingEventsDbPath(unavailable)).toBe(sidecar);
    expect(existsSync(projectMapPath())).toBe(false);
  });
});

describe("eventsDbPath", () => {
  it("returns a path under ~/.lcm/events/", () => {
    const result = eventsDbPath("/some/project");
    expect(result).toMatch(/\.lcm\/events\/.+\.db$/);
  });

  it("produces consistent paths for the same cwd", () => {
    const a = eventsDbPath("/some/project");
    const b = eventsDbPath("/some/project");
    expect(a).toBe(b);
  });

  it("produces different paths for different cwds", () => {
    const a = eventsDbPath("/project/a");
    const b = eventsDbPath("/project/b");
    expect(a).not.toBe(b);
  });
});

describe("eventsDir", () => {
  it("returns ~/.lcm/events", () => {
    expect(eventsDir()).toBe(join(homedir(), ".lcm", "events"));
  });

  it("accepts an explicit home directory", () => {
    expect(eventsDir("/srv/lcm-user")).toBe("/srv/lcm-user/.lcm/events");
  });
});

describe("eventSequenceDbPath", () => {
  it("keeps the machine-global allocator beside the project sidecars", () => {
    expect(eventSequenceDbPath("/srv/lcm-user"))
      .toBe("/srv/lcm-user/.lcm/events/.machine-sequence.sqlite");
  });
});
