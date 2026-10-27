import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const PACK_TIMEOUT_MS = 30_000;

function packedPaths(scratch: string, files: string[]): string[] {
  writeFileSync(join(scratch, "package.json"), JSON.stringify({
    name: "@donadiosolutions/lcm-docs-selection-fixture",
    version: "0.0.0",
    files,
  }));
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: scratch,
    encoding: "utf8",
    timeout: PACK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, npm_config_cache: join(scratch, "npm-cache") },
  });
  if (packed.error || packed.status !== 0) {
    throw new Error(`npm pack fixture failed (status ${String(packed.status)}, signal ${String(packed.signal)})`);
  }
  try {
    const metadata = JSON.parse(packed.stdout) as Array<{ files?: Array<{ path?: unknown }> }>;
    if (metadata.length !== 1 || !Array.isArray(metadata[0]?.files)) {
      throw new Error("unexpected npm pack metadata");
    }
    return metadata[0].files.flatMap(({ path }) => typeof path === "string" ? [path] : []);
  } catch {
    throw new Error("npm pack fixture returned invalid metadata");
  }
}

describe("npm documentation selection", () => {
  it("selects tracked public docs without admitting ignored local docs", { timeout: 70_000 }, () => {
    const trackedDocs = execFileSync("git", ["ls-files", "--", "docs"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: PACK_TIMEOUT_MS,
    }).trim().split("\n");
    const declaredDocs = pkg.files.filter((path) => path.startsWith("docs/")).sort();
    expect(declaredDocs).toEqual(trackedDocs);

    const scratch = mkdtempSync(join(tmpdir(), "lcm-npm-docs-selection-"));
    try {
      copyFileSync(join(repositoryRoot, ".gitignore"), join(scratch, ".gitignore"));
      copyFileSync(join(repositoryRoot, ".npmignore"), join(scratch, ".npmignore"));
      mkdirSync(join(scratch, "docs", "superpowers"), { recursive: true });
      writeFileSync(join(scratch, "docs", "README.md"), "Public documentation fixture.\n");
      writeFileSync(join(scratch, "docs", "AGENTS.local.md"), "Harmless root canary.\n");
      writeFileSync(join(scratch, "docs", "superpowers", "canary.txt"), "Harmless nested canary.\n");

      const broadFiles = [...new Set(pkg.files.map((path) =>
        path.startsWith("docs/") ? "docs/" : path,
      ))];
      const baseline = packedPaths(scratch, broadFiles);
      expect(baseline).toContain("docs/superpowers/canary.txt");

      const candidate = packedPaths(scratch, pkg.files);
      expect(candidate.filter((path) => path.startsWith("docs/")).sort()).toEqual(["docs/README.md"]);
      expect(candidate).not.toContain("docs/AGENTS.local.md");
      expect(candidate).not.toContain("docs/superpowers/canary.txt");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
