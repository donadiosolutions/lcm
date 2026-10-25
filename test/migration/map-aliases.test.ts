import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashProjectPath, normalizeProjectPath, projectMapPath } from "../../src/project-map.js";
import { withBackendPublicationConsumerLock } from "../../src/storage/backend-publication.js";
import { authorizedMapAliasPaths, readAuthorizedMapAliasPaths } from "../../src/migration/map-aliases.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const homeDir = mkdtempSync(join(tmpdir(), "lcm-map-aliases-"));
  roots.push(homeDir);
  mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
  const cwd = join(homeDir, "project");
  mkdirSync(cwd, { mode: 0o700 });
  const canonical = normalizeProjectPath(cwd);
  return { homeDir, canonical, id: hashProjectPath(canonical) };
}

describe("authorizedMapAliasPaths", () => {
  it("resolves, de-duplicates, drops the canonical path and sorts", () => {
    expect(authorizedMapAliasPaths("/p/canonical", ["/p/b/../b", "/p/a", "/p/b", "/p/canonical/", "/p/canonical"]))
      .toEqual(["/p/a", "/p/b"]);
  });

  it("is empty without aliases", () => {
    expect(authorizedMapAliasPaths("/p/canonical", [])).toEqual([]);
  });
});

describe("readAuthorizedMapAliasPaths", () => {
  it("reads the persisted entry's aliases, with and without the caller's admission", () => {
    const { homeDir, canonical, id } = fixture();
    writeFileSync(projectMapPath(homeDir), JSON.stringify({
      [id]: { canonical, aliases: [join(homeDir, "moved"), canonical] },
    }), { mode: 0o600 });
    const expected = [join(homeDir, "moved")];
    expect(readAuthorizedMapAliasPaths({ homeDir, localProjectId: id, canonicalPath: canonical })).toEqual(expected);
    expect(withBackendPublicationConsumerLock(homeDir, (publicationLockToken) => readAuthorizedMapAliasPaths({
      homeDir, localProjectId: id, canonicalPath: canonical, publicationLockToken,
    }))).toEqual(expected);
  });

  it("is empty for a project the map does not carry", () => {
    const { homeDir, canonical } = fixture();
    expect(readAuthorizedMapAliasPaths({ homeDir, localProjectId: "f".repeat(64), canonicalPath: canonical })).toEqual([]);
  });
});
