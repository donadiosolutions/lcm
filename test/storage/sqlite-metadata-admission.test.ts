import { existsSync, linkSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectPathsForIdentity } from "../../src/daemon/project.js";
import { hashProjectPath } from "../../src/project-map.js";
import { SqliteStorageBackendFactory } from "../../src/storage/sqlite/factory.js";
import { createTemporaryDirectory } from "../fixtures/runtime.js";

const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function privateNonGitProject(): {
  identity: { id: string; canonical: string };
  paths: ReturnType<typeof projectPathsForIdentity>;
} {
  const home = createTemporaryDirectory("lcm-sqlite-metadata-home-");
  const cwd = join(home, "private-non-git-project");
  const canonical = resolve(cwd);
  const identity = { id: hashProjectPath(canonical), canonical };
  process.env.HOME = home;
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  const paths = projectPathsForIdentity(identity);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  return { identity, paths };
}

describe("default SQLite project metadata admission", () => {
  it("rejects hard-linked metadata before database initialization", async () => {
    const { identity, paths } = privateNonGitProject();
    const targetPath = join(process.env.HOME!, "linked-project-metadata.json");
    const original = JSON.stringify({ cwd: identity.canonical, extra: true });
    writeFileSync(targetPath, original);
    linkSync(targetPath, paths.metaPath);
    const factory = new SqliteStorageBackendFactory();
    try {
      await expect(factory.openProject(identity)).rejects.toMatchObject({
        code: "STORAGE_INITIALIZATION_FAILED",
        backend: "sqlite",
        projectId: identity.id,
        domain: "factory",
        operation: "openProject",
      });
      expect(existsSync(paths.dbPath)).toBe(false);
      expect(readFileSync(paths.metaPath, "utf8")).toBe(original);
      expect(readFileSync(targetPath, "utf8")).toBe(original);
      expect(statSync(paths.metaPath).ino).toBe(statSync(targetPath).ino);
    } finally {
      await factory.close();
    }
  });

  it("opens valid single-link metadata without rewriting it", async () => {
    const { identity, paths } = privateNonGitProject();
    const original = JSON.stringify({ cwd: identity.canonical, extra: true });
    writeFileSync(paths.metaPath, original, { mode: 0o600 });
    const factory = new SqliteStorageBackendFactory();
    let storage: Awaited<ReturnType<typeof factory.openProject>> | undefined;
    try {
      storage = await factory.openProject(identity);
      expect(existsSync(paths.dbPath)).toBe(true);
      expect(readFileSync(paths.metaPath, "utf8")).toBe(original);
    } finally {
      await storage?.close();
      await factory.close();
    }
  });
});
