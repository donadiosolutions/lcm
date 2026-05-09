import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configPath,
  legacyLcmHomeDir,
  lcmHomeDir,
  migrateLegacyHomeIfNeeded,
} from "../src/runtime-paths.js";

describe("runtime paths", () => {
  it("uses ~/.lcm as the default LCM home", () => {
    expect(lcmHomeDir("/home/alice")).toBe("/home/alice/.lcm");
    expect(configPath("/home/alice")).toBe("/home/alice/.lcm/config.json");
  });

  it("keeps the legacy home path available for migration only", () => {
    expect(legacyLcmHomeDir("/home/alice")).toBe("/home/alice/.lossless-claude");
  });

  it("migrates an existing legacy home when the new home is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-paths-"));
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
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-paths-"));
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

  it("merges legacy contents when the new home already contains unrelated files", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-paths-"));
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
});
