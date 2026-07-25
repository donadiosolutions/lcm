import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: string[] = [];
const repoRoot = resolve(import.meta.dirname, "../..");

afterEach(() => cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("sync-package-version", () => {
  it("syncs package-lock root versions from package.json without plugin metadata", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sync-package-version-"));
    cleanup.push(tempDir);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({
      name: "@donadiosolutions/lcm",
      version: "1.2.3",
    }));
    writeFileSync(join(tempDir, "package-lock.json"), JSON.stringify({
      name: "@donadiosolutions/lcm",
      version: "1.0.0",
      packages: {
        "": {
          name: "@donadiosolutions/lcm",
          version: "1.0.0",
        },
      },
    }, null, 2));

    execFileSync("node", [resolve(repoRoot, "scripts/sync-package-version.mjs")], { cwd: tempDir });

    const lock = JSON.parse(readFileSync(join(tempDir, "package-lock.json"), "utf8"));
    expect(lock.version).toBe("1.2.3");
    expect(lock.packages[""].version).toBe("1.2.3");
  });
});
