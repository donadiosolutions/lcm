import { afterEach, describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configPath,
  daemonPidPath,
  daemonTokenPath,
  legacyLcmHomeDir,
  lcmHomeDir,
  lcmPath,
  migrateLegacyHomeIfNeeded,
  projectsDir,
  tmpDir,
} from "../src/runtime-paths.js";
import { legacyLcmHomeDirname } from "../src/legacy-names.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-runtime-paths-"));
  homes.push(home);
  return home;
}

describe("runtime paths", () => {
  it("uses ~/.lcm as the default LCM home", () => {
    expect(lcmHomeDir("/home/alice")).toBe("/home/alice/.lcm");
    expect(configPath("/home/alice")).toBe("/home/alice/.lcm/config.json");
  });

  it("keeps the legacy home path available for migration only", () => {
    expect(legacyLcmHomeDir("/home/alice")).toBe(join("/home/alice", legacyLcmHomeDirname()));
  });

  it("builds every runtime path, including default-home paths", () => {
    expect(lcmPath("nested", "value")).toBe(join(lcmHomeDir(), "nested", "value"));
    expect(configPath()).toBe(join(lcmHomeDir(), "config.json"));
    expect(daemonPidPath()).toBe(join(lcmHomeDir(), "daemon.pid"));
    expect(daemonTokenPath()).toBe(join(lcmHomeDir(), "daemon.token"));
    expect(projectsDir()).toBe(join(lcmHomeDir(), "projects"));
    expect(tmpDir()).toBe(join(lcmHomeDir(), "tmp"));
  });

  it("does not migrate when the legacy home is absent", () => {
    const home = makeHome();
    expect(migrateLegacyHomeIfNeeded(home)).toEqual({
      migrated: false,
      from: legacyLcmHomeDir(home),
      to: lcmHomeDir(home),
    });
  });

  it("migrates an existing legacy home when the new home is absent", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const next = lcmHomeDir(home);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), JSON.stringify({ version: 1 }));

    const result = migrateLegacyHomeIfNeeded(home);

    expect(result).toEqual({ migrated: true, from: legacy, to: next });
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(next, "config.json"), "utf-8")).toBe(JSON.stringify({ version: 1 }));
  });

  it("does not migrate when the new home already has lcm data", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const next = lcmHomeDir(home);
    mkdirSync(legacy, { recursive: true });
    mkdirSync(next, { recursive: true });
    writeFileSync(join(legacy, "config.json"), "legacy");
    writeFileSync(join(next, "config.json"), "new");

    const result = migrateLegacyHomeIfNeeded(home);

    expect(result).toEqual({ migrated: false, from: legacy, to: next });
    expect(readFileSync(join(next, "config.json"), "utf-8")).toBe("new");
    expect(readFileSync(join(legacy, "config.json"), "utf-8")).toBe("legacy");
  });

  it.each(["projects", "events"])("does not migrate when the new home has %s data", (name) => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const next = lcmHomeDir(home);
    mkdirSync(legacy, { recursive: true });
    mkdirSync(join(next, name), { recursive: true });

    expect(migrateLegacyHomeIfNeeded(home)).toEqual({ migrated: false, from: legacy, to: next });
  });

  it("merges legacy contents when the new home already contains unrelated files", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const next = lcmHomeDir(home);
    mkdirSync(legacy, { recursive: true });
    mkdirSync(next, { recursive: true });
    writeFileSync(join(legacy, "config.json"), "legacy");
    writeFileSync(join(next, "daemon.pid"), "new");

    const result = migrateLegacyHomeIfNeeded(home);

    expect(result).toEqual({ migrated: true, from: legacy, to: next });
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(next, "config.json"), "utf-8")).toBe("legacy");
    expect(readFileSync(join(next, "daemon.pid"), "utf-8")).toBe("new");
  });

  it("preserves duplicate targets while merging a legacy home", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const next = lcmHomeDir(home);
    mkdirSync(legacy, { recursive: true });
    mkdirSync(next, { recursive: true });
    writeFileSync(join(legacy, "shared.txt"), "legacy");
    writeFileSync(join(next, "shared.txt"), "current");

    expect(migrateLegacyHomeIfNeeded(home).migrated).toBe(true);
    expect(readFileSync(join(next, "shared.txt"), "utf-8")).toBe("current");
  });
});
