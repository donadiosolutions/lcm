import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkPnpmReleaseInputs } from "../../.github/scripts/check-pnpm-release-inputs.mjs";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lcm-pnpm-release-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  for (const name of ["package.json", "pnpm-lock.yaml", ".npmrc", "pnpm-workspace.yaml", "scripts/bootstrap-pnpm.mjs"]) {
    writeFileSync(join(root, name), readFileSync(new URL(`../../${name}`, import.meta.url)));
  }
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("tagged pnpm release prerequisites", () => {
  it("accepts the current tag and another exact integrity-pinned pnpm era", () => {
    const root = fixture();
    expect(() => checkPnpmReleaseInputs(root)).not.toThrow();
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: `pnpm@10.33.0+sha512.${"a".repeat(128)}` }));
    expect(() => checkPnpmReleaseInputs(root)).not.toThrow();
  });

  it.each(["pnpm-lock.yaml", ".npmrc", "pnpm-workspace.yaml", "scripts/bootstrap-pnpm.mjs"])("rejects a tag missing %s before build", (name) => {
    const root = fixture();
    rmSync(join(root, name));
    writeFileSync(join(root, "package-lock.json"), "{}");
    expect(() => checkPnpmReleaseInputs(root)).toThrow("npm-only historical tags cannot be rebuilt");
  });

  it.each(["pnpm@10.34.5", "npm@11.0.0", `pnpm@^10.34.5+sha512.${"a".repeat(128)}`, null])("rejects malformed manager %s", (packageManager) => {
    const root = fixture();
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager }));
    expect(() => checkPnpmReleaseInputs(root)).toThrow("exact pnpm version with SHA-512");
  });

  it("rejects symlinked or empty inputs and automatic manager replacement", () => {
    const root = fixture();
    rmSync(join(root, "pnpm-lock.yaml"));
    symlinkSync(join(root, "package.json"), join(root, "pnpm-lock.yaml"));
    expect(() => checkPnpmReleaseInputs(root)).toThrow("nonempty regular file");
    rmSync(join(root, "pnpm-lock.yaml"));
    writeFileSync(join(root, "pnpm-lock.yaml"), " ");
    expect(() => checkPnpmReleaseInputs(root)).toThrow("nonempty regular file");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    writeFileSync(join(root, ".npmrc"), readFileSync(join(root, ".npmrc"), "utf8").replace("manage-package-manager-versions=false", "manage-package-manager-versions=true"));
    expect(() => checkPnpmReleaseInputs(root)).toThrow("manage-package-manager-versions=false");
  });

  it("reports actionable CLI failure from a separate trusted checkout", () => {
    const root = fixture();
    rmSync(join(root, "pnpm-lock.yaml"));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../.github/scripts/check-pnpm-release-inputs.mjs", import.meta.url)), root], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Already-published npm versions can use verification-only recovery");
  });
});
