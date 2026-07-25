import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageAsset, packageEntrypoint, packageExecutable, packageRootFor } from "../src/runtime-root.js";

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("runtime package layout", () => {
  it("ascends from the generated runtime bundle", () => {
    expect(packageRootFor("file:///opt/lcm/dist/lcm.mjs", 3)).toBe("/opt/lcm");
  });

  it("ascends from compiled and source modules", () => {
    expect(packageRootFor("file:///opt/lcm/dist/src/daemon/version.js", 3)).toBe("/opt/lcm");
    expect(packageRootFor("file:///opt/lcm/src/daemon/version.ts", 3)).toBe("/opt/lcm");
  });

  it("selects bundled and compiled executable entrypoints", () => {
    expect(packageEntrypoint("file:///opt/lcm/dist/lcm.mjs", "/opt/lcm", "/fallback/lcm.js"))
      .toBe("/opt/lcm/dist/lcm.mjs");
    expect(packageEntrypoint("file:///opt/lcm/dist/src/doctor/doctor.js", "/opt/lcm", "/opt/lcm/dist/bin/lcm.js"))
      .toBe("/opt/lcm/dist/bin/lcm.js");
    expect(packageExecutable("file:///opt/lcm/dist/lcm.mjs", 3)).toBe("/opt/lcm/dist/lcm.mjs");
    expect(packageExecutable("file:///opt/lcm/src/doctor/doctor.ts", 3)).toBe("/opt/lcm/dist/lcm.mjs");
  });

  it("selects assets from the caller layout instead of ambient build artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-layout-"));
    cleanup.push(root);
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "data"), "built");
    expect(packageAsset("file:///opt/lcm/src/loader.ts", root, "dist/data", "src/data"))
      .toBe(join(root, "src/data"));
    expect(packageAsset("file:///opt/lcm/dist/src/loader.js", root, "dist/data", "src/data"))
      .toBe(join(root, "dist/data"));
  });

  it("uses package-local availability for the generated runtime bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-layout-bundle-"));
    cleanup.push(root);
    expect(packageAsset(`file://${root}/dist/lcm.mjs`, root, "dist/data", "src/data"))
      .toBe(join(root, "src/data"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "data"), "built");
    expect(packageAsset(`file://${root}/dist/lcm.mjs`, root, "dist/data", "src/data"))
      .toBe(join(root, "dist/data"));
  });
});
