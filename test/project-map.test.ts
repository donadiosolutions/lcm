import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProjectAlias,
  clearProjectMapCache,
  hashProjectPath,
  listProjectMapEntries,
  normalizeProjectPath,
  projectMapPath,
  reloadProjectMapCache,
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
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-project-map-home-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    resetLcmHome();
  });

  afterEach(() => {
    clearProjectMapCache();
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
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

  it("shows metadata-backed map entries by hash and path", () => {
    const canonical = makeDir("show-from-meta");
    const hash = hashProjectPath(normalizeProjectPath(canonical));
    mkdirSync(join(homedir(), ".lcm", "projects", hash), { recursive: true });
    writeFileSync(join(homedir(), ".lcm", "projects", hash, "meta.json"), JSON.stringify({ cwd: canonical }));

    const byHash = showProjectMapEntry(hash);
    const byPath = showProjectMapEntry(canonical);

    expect(byHash.transient).toBeUndefined();
    expect(byHash.entry.canonical).toBe(normalizeProjectPath(canonical));
    expect(byPath.hash).toBe(hash);
    expect(byPath.entry.canonical).toBe(normalizeProjectPath(canonical));
  });

  it("skips metadata backfill entries that would create path ambiguity", () => {
    const shared = makeDir("shared-meta");
    const firstHash = hashProjectPath(`${normalizeProjectPath(shared)}-first`);
    const secondHash = hashProjectPath(`${normalizeProjectPath(shared)}-second`);
    mkdirSync(join(homedir(), ".lcm", "projects", firstHash), { recursive: true });
    mkdirSync(join(homedir(), ".lcm", "projects", secondHash), { recursive: true });
    writeFileSync(join(homedir(), ".lcm", "projects", firstHash, "meta.json"), JSON.stringify({ cwd: shared }));
    writeFileSync(join(homedir(), ".lcm", "projects", secondHash, "meta.json"), JSON.stringify({ cwd: shared }));

    const map = listProjectMapEntries();
    const validation = validateProjectMap({ fix: true });

    expect(Object.keys(map)).toHaveLength(1);
    expect(validation.ok).toBe(true);
  });

  it("reports invalid JSON without rewriting the map", () => {
    writeFileSync(projectMapPath(), "{not-json");

    const validation = validateProjectMap({ fix: true });

    expect(validation.ok).toBe(false);
    expect(validation.fixApplied).toBe(false);
    expect(readFileSync(projectMapPath(), "utf-8")).toBe("{not-json");
  });

  it("does not overwrite invalid map edits from a stale cache", () => {
    const canonical = makeDir("cached-canonical");
    resolveProjectIdentity(canonical);
    writeFileSync(projectMapPath(), "{not-json");

    const unseen = makeDir("unseen-while-invalid");

    expect(() => resolveProjectIdentity(unseen)).toThrow(/refusing to overwrite invalid map\.json/);
    expect(readFileSync(projectMapPath(), "utf-8")).toBe("{not-json");
  });

  it("keeps cached aliases when map.json temporarily disappears", () => {
    const canonical = makeDir("cached-missing-canonical");
    const alias = makeDir("cached-missing-alias");
    const unseen = makeDir("cached-missing-unseen");
    const canonicalId = projectId(canonical);
    addProjectAlias(alias, { canonical });
    rmSync(projectMapPath());

    const unseenId = projectId(unseen);
    const map = listProjectMapEntries();

    expect(map[canonicalId].aliases).toContain(normalizeProjectPath(alias));
    expect(map[unseenId].canonical).toBe(normalizeProjectPath(unseen));
    expect(readFileSync(projectMapPath(), "utf-8")).toBe(JSON.stringify(map, null, 2) + "\n");
  });

  it("keeps cached aliases when a map reload sees a transient missing file", () => {
    const canonical = makeDir("reload-missing-canonical");
    const alias = makeDir("reload-missing-alias");
    const unseen = makeDir("reload-missing-unseen");
    const canonicalId = projectId(canonical);
    addProjectAlias(alias, { canonical });
    rmSync(projectMapPath());

    expect(reloadProjectMapCache({ reformat: true })).toBe(true);
    expect(existsSync(projectMapPath())).toBe(false);

    const unseenId = projectId(unseen);
    const map = listProjectMapEntries();

    expect(map[canonicalId].aliases).toContain(normalizeProjectPath(alias));
    expect(map[unseenId].canonical).toBe(normalizeProjectPath(unseen));
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

  it.each([
    ["array root", []],
    ["bad hash", { not_a_hash: { canonical: "/tmp/project", aliases: [] } }],
    ["non-object entry", { ["a".repeat(64)]: null }],
    ["empty canonical", { ["a".repeat(64)]: { canonical: "", aliases: [] } }],
    ["bad aliases", { ["a".repeat(64)]: { canonical: "/tmp/project", aliases: [""] } }],
  ])("rejects invalid map schema: %s", (_label: string, map: unknown) => {
    writeFileSync(projectMapPath(), JSON.stringify(map));

    const validation = validateProjectMap({ fix: true });

    expect(validation.ok).toBe(false);
    expect(validation.fixApplied).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
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

  it("shows the current mapped project when no target is provided", () => {
    const originalCwd = process.cwd();
    const canonical = makeDir("show-current-canonical");
    const hash = projectId(canonical);
    process.chdir(canonical);

    try {
      const shown = showProjectMapEntry();

      expect(shown).toMatchObject({
        hash,
        entry: { canonical: normalizeProjectPath(canonical), aliases: [] },
      });
      expect(shown.transient).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("shows the current unmapped project without writing map.json", () => {
    const originalCwd = process.cwd();
    const target = makeDir("show-current-unmapped");
    process.chdir(target);

    try {
      const shown = showProjectMapEntry();

      expect(shown.transient).toBe(true);
      expect(shown.hash).toBe(hashProjectPath(normalizeProjectPath(target)));
      expect(shown.entry).toEqual({ canonical: normalizeProjectPath(target), aliases: [] });
      expect(existsSync(projectMapPath())).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("adds an alias to the current project by default", () => {
    const originalCwd = process.cwd();
    const canonical = makeDir("default-add-canonical");
    const alias = makeDir("default-add-alias");
    const hash = projectId(canonical);
    process.chdir(canonical);

    try {
      const added = addProjectAlias(alias);

      expect(added.hash).toBe(hash);
      expect(added.entry.aliases).toContain(normalizeProjectPath(alias));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects ambiguous project identity resolution", () => {
    const first = makeDir("identity-first");
    const second = makeDir("identity-second");
    const shared = makeDir("identity-shared");
    const firstHash = hashProjectPath(normalizeProjectPath(first));
    const secondHash = hashProjectPath(normalizeProjectPath(second));
    writeFileSync(projectMapPath(), JSON.stringify({
      [firstHash]: { canonical: first, aliases: [shared] },
      [secondHash]: { canonical: second, aliases: [shared] },
    }, null, 2) + "\n");
    clearProjectMapCache();

    expect(() => resolveProjectIdentity(shared)).toThrow(/multiple hashes/);
  });

  it("rejects alias add and remove targets with both canonical and hash", () => {
    const canonical = makeDir("mutual-canonical");
    const alias = makeDir("mutual-alias");
    const hash = projectId(canonical);

    expect(() => addProjectAlias(alias, { canonical, hash })).toThrow(/mutually exclusive/);
    expect(() => removeProjectAlias(alias, { canonical, hash })).toThrow(/mutually exclusive/);
  });

  it("rejects duplicate aliases on the target project", () => {
    const canonical = makeDir("duplicate-canonical");
    const alias = makeDir("duplicate-alias");

    addProjectAlias(alias, { canonical });

    expect(() => addProjectAlias(alias, { canonical })).toThrow(/already mapped/);
  });

  it("rejects aliases already owned by another non-adoptable hash", () => {
    const first = makeDir("nonadopt-first");
    const second = makeDir("nonadopt-second");
    const alias = makeDir("nonadopt-alias");
    const firstHash = hashProjectPath(normalizeProjectPath(first));
    const secondHash = hashProjectPath(normalizeProjectPath(second));
    writeFileSync(projectMapPath(), JSON.stringify({
      [firstHash]: { canonical: first, aliases: [alias] },
      [secondHash]: { canonical: second, aliases: [] },
    }, null, 2) + "\n");
    clearProjectMapCache();

    expect(() => addProjectAlias(alias, { hash: secondHash })).toThrow(/already mapped to another hash/);
  });

  it("rejects aliases equal to the target canonical path", () => {
    const canonical = makeDir("same-canonical");
    const hash = projectId(canonical);

    expect(() => addProjectAlias(canonical, { hash })).toThrow(/matches canonical path/);
  });

  it("rejects ambiguous canonical targets when removing aliases", () => {
    const canonical = makeDir("ambiguous-canonical");
    const firstHash = hashProjectPath(`${normalizeProjectPath(canonical)}-first`);
    const secondHash = hashProjectPath(`${normalizeProjectPath(canonical)}-second`);
    writeFileSync(projectMapPath(), JSON.stringify({
      [firstHash]: { canonical, aliases: [] },
      [secondHash]: { canonical, aliases: [] },
    }, null, 2) + "\n");
    clearProjectMapCache();

    expect(() => removeProjectAlias(makeDir("ambiguous-remove-alias"), { canonical })).toThrow(/multiple hashes/);
  });

  it("converts an already-seen canonical-only path into an alias", () => {
    const canonical = makeDir("adopt-canonical");
    const alias = makeDir("adopt-alias");
    const canonicalId = projectId(canonical);
    const staleAliasId = projectId(alias);

    const added = addProjectAlias(alias, { canonical });
    const map = listProjectMapEntries();

    expect(added.hash).toBe(canonicalId);
    expect(map[canonicalId].aliases).toContain(normalizeProjectPath(alias));
    expect(map[staleAliasId]).toBeUndefined();
    expect(projectId(alias)).toBe(canonicalId);
  });

  it("refuses to adopt an already-seen alias project that has stored data", () => {
    const canonical = makeDir("data-canonical");
    const alias = makeDir("data-alias");
    projectId(canonical);
    const staleAliasId = projectId(alias);
    mkdirSync(join(homedir(), ".lcm", "projects", staleAliasId), { recursive: true });
    writeFileSync(join(homedir(), ".lcm", "projects", staleAliasId, "db.sqlite"), "");

    expect(() => addProjectAlias(alias, { canonical })).toThrow(/stored data/);
    expect(listProjectMapEntries()[staleAliasId]).toBeDefined();
  });

  it("refuses to adopt an already-seen alias project that has an event sidecar", () => {
    const canonical = makeDir("events-canonical");
    const alias = makeDir("events-alias");
    projectId(canonical);
    const staleAliasId = projectId(alias);
    mkdirSync(join(homedir(), ".lcm", "events"), { recursive: true });
    writeFileSync(join(homedir(), ".lcm", "events", `${staleAliasId}.db`), "");

    expect(() => addProjectAlias(alias, { canonical })).toThrow(/stored data/);
    expect(listProjectMapEntries()[staleAliasId]).toBeDefined();
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

  it("rejects missing canonical and unknown hash remove targets", () => {
    const missingCanonical = join(homedir(), "missing-remove-canonical");
    const hash = "a".repeat(64);

    expect(() => removeProjectAlias(makeDir("missing-remove-alias"), { canonical: missingCanonical })).toThrow(/canonical path does not exist/);
    expect(() => removeProjectAlias(makeDir("unknown-hash-remove-alias"), { hash })).toThrow(/unknown project hash/);
  });

  it("requires --canonical targets to be existing directories", () => {
    const canonicalFile = join(homedir(), "canonical-file");
    const alias = makeDir("file-target-alias");
    writeFileSync(canonicalFile, "not a directory");

    expect(() => addProjectAlias(alias, { canonical: canonicalFile })).toThrow(/existing directory/);
    expect(existsSync(projectMapPath())).toBe(false);
  });

  it("reports invalid map reloads without replacing the cache", () => {
    const canonical = makeDir("reload-invalid-canonical");
    const alias = makeDir("reload-invalid-alias");
    const hash = projectId(canonical);
    addProjectAlias(alias, { canonical });
    writeFileSync(projectMapPath(), "{not-json");

    expect(reloadProjectMapCache({ reformat: true })).toBe(false);
    expect(projectId(alias)).toBe(hash);
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
