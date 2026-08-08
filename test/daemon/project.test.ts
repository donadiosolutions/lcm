import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureProjectDirForIdentity,
  localProjectIdentity,
  projectId,
  projectDbPath,
  projectMetaPath,
} from "../../src/daemon/project.js";
import * as securityFiles from "../../src/security-files.js";

describe("secure project-root handoff", () => {
  let previousHome: string | undefined;
  let home: string;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "lcm-project-root-home-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("does not create ~/.lcm when the operator has not bootstrapped it", () => {
    expect(() => ensureProjectDirForIdentity({ id: "a".repeat(64), canonical: "/project" })).toThrow();
    expect(existsSync(join(home, ".lcm"))).toBe(false);
  });

  it("falls back to the normalized path for malformed compatibility entries", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    writeFileSync(join(home, ".lcm", "map.json"), JSON.stringify({
      "not-a-hash": { canonical: "/ignored", aliases: [] },
      ["a".repeat(64)]: null,
      ["b".repeat(64)]: { canonical: 42, aliases: [] },
      ["c".repeat(64)]: { canonical: "\u0000", aliases: [] },
    }));
    expect(localProjectIdentity("/project", home).canonical).toBe("/project");
    expect(localProjectIdentity("/project", home).id).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed when the retained root witness changes during metadata publication", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const originalAssert = securityFiles.assertPrivateDirectory;
    let calls = 0;
    const assert = vi.spyOn(securityFiles, "assertPrivateDirectory").mockImplementation((handle, path, expected) => {
      const actual = originalAssert(handle, path, expected);
      calls += 1;
      return calls === 2 ? { ...actual, ino: `${actual.ino}-changed` } : actual;
    });
    try {
      expect(() => ensureProjectDirForIdentity({ id: "b".repeat(64), canonical: "/project" }))
        .toThrow("private directory witness changed");
    } finally {
      assert.mockRestore();
    }
  });
});

describe("projectId", () => {
  it("returns sha256 hex of absolute path", () => expect(projectId("/foo")).toMatch(/^[a-f0-9]{64}$/));
  it("is deterministic", () => expect(projectId("/foo")).toBe(projectId("/foo")));
  it("differs for different paths", () => expect(projectId("/foo")).not.toBe(projectId("/bar")));
});

describe("projectDbPath", () => {
  it("returns path under .lcm/projects/<id>/db.sqlite", () => {
    const p = projectDbPath("/foo/bar");
    expect(p).toContain(".lcm");
    expect(p).toContain("projects");
    expect(p).toContain("db.sqlite");
  });
});

describe("projectMetaPath", () => {
  it("returns path ending in meta.json", () => {
    expect(projectMetaPath("/foo")).toContain("meta.json");
  });
});
