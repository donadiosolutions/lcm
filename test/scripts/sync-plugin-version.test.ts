import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("sync-plugin-version", () => {
  it("syncs plugin metadata and package-lock root versions from package.json", () => {
    const repoRoot = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), "sync-plugin-version-"));
    try {
      mkdirSync(join(tempDir, ".claude-plugin"), { recursive: true });
      writeFileSync(join(tempDir, "package.json"), JSON.stringify({
        name: "@donadiosolutions/lcm",
        version: "1.2.3",
      }, null, 2));
      writeFileSync(join(tempDir, "package-lock.json"), JSON.stringify({
        name: "@donadiosolutions/lcm",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "@donadiosolutions/lcm",
            version: "1.0.0",
          },
          "node_modules/example": {
            version: "1.0.0",
          },
        },
      }, null, 2));
      writeFileSync(join(tempDir, ".claude-plugin", "plugin.json"), JSON.stringify({
        name: "lcm",
        version: "1.0.0",
      }, null, 2));
      writeFileSync(join(tempDir, ".claude-plugin", "marketplace.json"), JSON.stringify({
        plugins: [{ name: "lcm", version: "1.0.0" }],
      }, null, 2));

      execFileSync("node", [resolve(repoRoot, "scripts/sync-plugin-version.mjs")], { cwd: tempDir });

      const packageLock = JSON.parse(readFileSync(join(tempDir, "package-lock.json"), "utf-8"));
      const plugin = JSON.parse(readFileSync(join(tempDir, ".claude-plugin", "plugin.json"), "utf-8"));
      const marketplace = JSON.parse(readFileSync(join(tempDir, ".claude-plugin", "marketplace.json"), "utf-8"));

      expect(packageLock.version).toBe("1.2.3");
      expect(packageLock.packages[""].version).toBe("1.2.3");
      expect(packageLock.packages["node_modules/example"].version).toBe("1.0.0");
      expect(plugin.version).toBe("1.2.3");
      expect(marketplace.plugins[0].version).toBe("1.2.3");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
