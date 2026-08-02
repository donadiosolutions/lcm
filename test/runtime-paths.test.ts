import { afterEach, describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import {
  advanceBackendPublication,
  backendPublicationConfigSha256,
  backendPublicationJournalPath,
  backendPublicationProjectMapSha256,
  prepareBackendPublication,
} from "../src/storage/backend-publication.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-runtime-paths-"));
  homes.push(home);
  return home;
}

function publicationInput(homeDir: string, publicationId: string) {
  return {
    publicationId,
    sourceBackend: "sqlite" as const,
    targetBackend: "postgresql" as const,
    expectedConfigSha256: backendPublicationConfigSha256(homeDir),
    expectedProjectMapSha256: backendPublicationProjectMapSha256(homeDir),
    intendedConfigSha256: "1".repeat(64),
    intendedProjectMapSha256: "2".repeat(64),
    projects: [{
      localProjectId: "a".repeat(64),
      remoteProjectId: "018f0000-0000-7000-8000-000000000001",
      evidenceSha256: "3".repeat(64),
    }],
    homeDir,
  };
}

function installAbortedPublication(homeDir: string): void {
  const input = publicationInput(homeDir, "runtime-path-terminal");
  let journal = prepareBackendPublication(input);
  const advance = (
    phase: Parameters<typeof advanceBackendPublication>[0]["phase"],
    witnesses: Pick<
      Parameters<typeof advanceBackendPublication>[0],
      "publishedConfigSha256" | "publishedProjectMapSha256"
    > = {},
  ): void => {
    journal = advanceBackendPublication({
      publicationId: journal.publicationId,
      expectedChecksumSha256: journal.checksumSha256,
      phase,
      homeDir,
      ...witnesses,
    });
  };
  advance("abort-prepared");
  advance("config-restored", { publishedConfigSha256: input.expectedConfigSha256 });
  advance("map-restored", { publishedProjectMapSha256: input.expectedProjectMapSha256 });
  advance("abort-releasing");
  advance("aborted");
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
    expect(statSync(lcmHomeDir(home)).mode & 0o777).toBe(0o700);
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

  it("fails closed without moving legacy bytes while publication is unresolved", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), "legacy");
    prepareBackendPublication(publicationInput(home, "runtime-path-unresolved"));

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrowError(expect.objectContaining({
      reason: "unresolved-publication",
    }));
    expect(readFileSync(join(legacy, "config.json"), "utf8")).toBe("legacy");
    expect(existsSync(configPath(home))).toBe(false);
  });

  it("keeps the active home authoritative after terminal publication evidence", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), "legacy");
    installAbortedPublication(home);

    expect(migrateLegacyHomeIfNeeded(home)).toEqual({
      migrated: false,
      from: legacy,
      to: lcmHomeDir(home),
    });
    expect(readFileSync(join(legacy, "config.json"), "utf8")).toBe("legacy");
    expect(existsSync(configPath(home))).toBe(false);
  });

  it("fails closed when retained publication history loses its active journal", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "map.json"), "legacy-map");
    installAbortedPublication(home);
    prepareBackendPublication(publicationInput(home, "runtime-path-next"));
    rmSync(backendPublicationJournalPath(home));

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrowError(expect.objectContaining({
      reason: "publication-evidence-missing",
    }));
    expect(readFileSync(join(legacy, "map.json"), "utf8")).toBe("legacy-map");
  });
});
