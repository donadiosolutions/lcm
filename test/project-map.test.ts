import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  addProjectAlias,
  clearProjectMapCache,
  hashProjectPath,
  listProjectMapEntries,
  normalizeProjectPath,
  projectMapPath,
  removeProjectAlias,
  resolveProjectIdentity,
  showProjectMapEntry,
  validateProjectMap,
} from "../src/project-map.js";
import { eventsDbPath } from "../src/db/events-path.js";
import { projectDbPath, projectId, projectMetaPath } from "../src/daemon/project.js";

function resetLcmHome(): void {
  rmSync(join(homedir(), ".lcm"), { recursive: true, force: true });
  mkdirSync(join(homedir(), ".lcm"), { recursive: true });
  clearProjectMapCache();
}

function makeDir(name: string): string {
  const path = join(homedir(), name);
  mkdirSync(path, { recursive: true });
  return path;
}

describe("project map", () => {
  beforeEach(() => {
    resetLcmHome();
  });

  it("auto-creates a formatted canonical entry for a newly seen project path", () => {
    const canonical = makeDir("canonical");
    const identity = resolveProjectIdentity(canonical);
    const content = readFileSync(projectMapPath(), "utf-8");

    expect(identity.id).toMatch(/^[a-f0-9]{64}$/);
    expect(content).toBe(JSON.stringify({
      [identity.id]: { canonical: normalizeProjectPath(canonical), aliases: [] },
    }, null, 2) + "\n");
  });

  it("resolves canonical and alias paths to the same project paths", () => {
    const canonical = makeDir("canonical");
    const alias = makeDir("alias");
    const canonicalId = projectId(canonical);

    addProjectAlias(alias, { canonical });

    expect(projectId(alias)).toBe(canonicalId);
    expect(projectDbPath(alias)).toBe(projectDbPath(canonical));
    expect(projectMetaPath(alias)).toBe(projectMetaPath(canonical));
    expect(eventsDbPath(alias)).toBe(eventsDbPath(canonical));
  });

  it("warns for missing aliases and creates a backup before rewriting an existing map", () => {
    const canonical = makeDir("canonical");
    projectId(canonical);
    const missingAlias = join(homedir(), "missing-alias");

    const result = addProjectAlias(missingAlias, { canonical });

    expect(result.warning).toContain("does not exist");
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);
  });

  it("auto-populates missing entries from existing project metadata", () => {
    const canonical = makeDir("from-meta");
    const hash = hashProjectPath(normalizeProjectPath(canonical));
    mkdirSync(join(homedir(), ".lcm", "projects", hash), { recursive: true });
    writeFileSync(join(homedir(), ".lcm", "projects", hash, "meta.json"), JSON.stringify({ cwd: canonical }));

    const map = listProjectMapEntries();

    expect(map[hash]?.canonical).toBe(normalizeProjectPath(canonical));
  });

  it("reports invalid JSON without rewriting the map", () => {
    writeFileSync(projectMapPath(), "{not-json");

    const validation = validateProjectMap({ fix: true });

    expect(validation.ok).toBe(false);
    expect(validation.fixApplied).toBe(false);
    expect(readFileSync(projectMapPath(), "utf-8")).toBe("{not-json");
  });

  it("rejects relative canonical paths in manually edited maps", () => {
    const hash = hashProjectPath("/absolute-project");
    writeFileSync(projectMapPath(), JSON.stringify({
      [hash]: { canonical: "relative-project", aliases: [] },
    }));

    const validation = validateProjectMap({ fix: true });

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("canonical must be an absolute path");
  });

  it("rejects relative aliases in manually edited maps", () => {
    const canonical = makeDir("absolute-canonical");
    const hash = hashProjectPath(normalizeProjectPath(canonical));
    writeFileSync(projectMapPath(), JSON.stringify({
      [hash]: { canonical, aliases: ["relative-alias"] },
    }));

    const validation = validateProjectMap({ fix: true });

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("aliases must contain only absolute paths");
  });

  it("reformats valid compact JSON and creates a backup", () => {
    const canonical = makeDir("compact");
    const hash = hashProjectPath(normalizeProjectPath(canonical));
    writeFileSync(projectMapPath(), JSON.stringify({ [hash]: { canonical, aliases: [] } }));

    const validation = validateProjectMap({ fix: true });

    expect(validation.ok).toBe(true);
    expect(validation.fixApplied).toBe(true);
    expect(validation.backupPath).toBeDefined();
    expect(readFileSync(projectMapPath(), "utf-8")).toBe(JSON.stringify({
      [hash]: { canonical, aliases: [] },
    }, null, 2) + "\n");
  });

  it("repairs duplicate aliases within one hash", () => {
    const canonical = makeDir("dedupe");
    const alias = makeDir("dedupe-alias");
    const hash = hashProjectPath(normalizeProjectPath(canonical));
    writeFileSync(projectMapPath(), JSON.stringify({
      [hash]: { canonical, aliases: [alias, alias, canonical] },
    }));

    const validation = validateProjectMap({ fix: true });

    expect(validation.ok).toBe(true);
    expect(validation.fixApplied).toBe(true);
    expect(validation.map?.[hash].aliases).toEqual([alias]);
  });

  it("fails validation for cross-hash path ambiguity", () => {
    const first = makeDir("first");
    const second = makeDir("second");
    const shared = makeDir("shared");
    const firstHash = hashProjectPath(normalizeProjectPath(first));
    const secondHash = hashProjectPath(normalizeProjectPath(second));
    writeFileSync(projectMapPath(), JSON.stringify({
      [firstHash]: { canonical: first, aliases: [shared] },
      [secondHash]: { canonical: second, aliases: [shared] },
    }));

    const validation = validateProjectMap({ fix: true });

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("multiple hashes");
  });

  it("shows, adds, and removes aliases", () => {
    const canonical = makeDir("cli-canonical");
    const alias = makeDir("cli-alias");

    const added = addProjectAlias(alias, { canonical });
    const shown = showProjectMapEntry(added.hash);
    const removed = removeProjectAlias(alias);

    expect(shown.entry.aliases).toContain(normalizeProjectPath(alias));
    expect(removed.removed).toBe(true);
    expect(listProjectMapEntries()[added.hash].aliases).toEqual([]);
  });

  it("shows an unmapped path without creating or rewriting map.json", () => {
    const target = join(homedir(), "unmapped-show-target");

    const shown = showProjectMapEntry(target);

    expect(shown.transient).toBe(true);
    expect(shown.hash).toBe(hashProjectPath(normalizeProjectPath(target)));
    expect(shown.entry).toEqual({ canonical: normalizeProjectPath(target), aliases: [] });
    expect(existsSync(projectMapPath())).toBe(false);
  });

  it("does not create a map entry when removing from an unmapped canonical target", () => {
    const canonical = makeDir("remove-unmapped-canonical");
    const alias = join(homedir(), "remove-unmapped-alias");

    expect(() => removeProjectAlias(alias, { canonical })).toThrow(/unknown canonical project path/);
    expect(existsSync(projectMapPath())).toBe(false);
  });

  it("requires --canonical targets to be existing directories", () => {
    const canonicalFile = join(homedir(), "canonical-file");
    const alias = makeDir("file-target-alias");
    writeFileSync(canonicalFile, "not a directory");

    expect(() => addProjectAlias(alias, { canonical: canonicalFile })).toThrow(/existing directory/);
    expect(existsSync(projectMapPath())).toBe(false);
  });

  it("refuses ambiguous alias removal without an explicit target", () => {
    const first = makeDir("remove-first");
    const second = makeDir("remove-second");
    const shared = makeDir("remove-shared");
    const firstHash = hashProjectPath(normalizeProjectPath(first));
    const secondHash = hashProjectPath(normalizeProjectPath(second));
    writeFileSync(projectMapPath(), JSON.stringify({
      [firstHash]: { canonical: first, aliases: [shared] },
      [secondHash]: { canonical: second, aliases: [shared] },
    }, null, 2) + "\n");
    clearProjectMapCache();

    expect(() => removeProjectAlias(shared)).toThrow(/multiple hashes/);
    expect(readdirSync(join(homedir(), ".lcm")).includes("oldmaps")).toBe(false);
  });
});
