import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageAsset, packageEntrypoint, packageRootFor } from "../src/runtime-root.js";

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("runtime package layout", () => {
  it("uses the entrypoint directory for committed bundles", () => {
    expect(packageRootFor("file:///opt/lcm/lcm.mjs", 3)).toBe("/opt/lcm");
    expect(packageRootFor("file:///opt/lcm/mcp.mjs", 3)).toBe("/opt/lcm");
  });

  it("ascends from compiled and source modules", () => {
    expect(packageRootFor("file:///opt/lcm/dist/src/daemon/version.js", 3)).toBe("/opt/lcm");
    expect(packageRootFor("file:///opt/lcm/src/daemon/version.ts", 3)).toBe("/opt/lcm");
  });

  it("selects bundled and compiled executable entrypoints", () => {
    expect(packageEntrypoint("file:///opt/lcm/lcm.mjs", "/opt/lcm", "/fallback/lcm.js")).toBe("/opt/lcm/lcm.mjs");
    expect(packageEntrypoint("file:///opt/lcm/dist/src/doctor/doctor.js", "/opt/lcm", "/opt/lcm/dist/bin/lcm.js"))
      .toBe("/opt/lcm/dist/bin/lcm.js");
  });

  it("prefers built assets and falls back to source assets", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-layout-"));
    cleanup.push(root);
    expect(packageAsset(root, "dist/data", "src/data")).toBe(join(root, "src/data"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "data"), "built");
    expect(packageAsset(root, "dist/data", "src/data")).toBe(join(root, "dist/data"));
  });
});
