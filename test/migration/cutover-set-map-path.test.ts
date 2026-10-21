import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { projectMapPath, readProjectMapCanonicalPath } from "../../src/project-map.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-map-path-"));
  roots.push(value);
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  return value;
}

it("reads one persisted canonical path without a lock or a write", () => {
  const homeDir = home();
  const hash = "a".repeat(64);
  expect(readProjectMapCanonicalPath({ homeDir, hash })).toBeNull();
  writeFileSync(projectMapPath(homeDir), JSON.stringify({ [hash]: { canonical: "/project/a", aliases: [] } }) + "\n", { mode: 0o600 });
  expect(readProjectMapCanonicalPath({ homeDir, hash })).toBe("/project/a");
  expect(readProjectMapCanonicalPath({ homeDir, hash: "b".repeat(64) })).toBeNull();
});

it("refuses an invalid map instead of reading around it", () => {
  const homeDir = home();
  writeFileSync(projectMapPath(homeDir), "{not json", { mode: 0o600 });
  expect(() => readProjectMapCanonicalPath({ homeDir, hash: "a".repeat(64) })).toThrow();
});

