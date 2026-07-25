import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import pkg from "../package.json";

describe("package.json", () => {
  it("has correct name", () => expect(pkg.name).toBe("@donadiosolutions/lcm"));
  it("uses the generated npm runtime as its executable", () => {
    expect(pkg.bin).toHaveProperty("lcm", "dist/lcm.mjs");
  });
  it("has anthropic sdk as optional peer dep", () => expect(pkg.peerDependencies).toHaveProperty("@anthropic-ai/sdk"));
  it("has mcp sdk", () => expect(pkg.dependencies).toHaveProperty("@modelcontextprotocol/sdk"));
  it("does not have pi-ai", () => expect(pkg.dependencies).not.toHaveProperty("@mariozechner/pi-ai"));
  it("does not have pi-agent-core", () => expect(pkg.dependencies).not.toHaveProperty("@mariozechner/pi-agent-core"));

  it("does not use prepack (breaks npm install from git without node_modules)", () => {
    expect(pkg.scripts).not.toHaveProperty("prepack");
  });

  it("uses prepublishOnly for build (only runs during npm publish)", () => {
    expect(pkg.scripts).toHaveProperty("prepublishOnly", "npm run build");
  });

  it("uses exact, reproducible runtime bundle tooling", () => {
    expect(pkg.devDependencies.esbuild).toBe("0.28.1");
    expect(pkg.scripts).toHaveProperty("build:runtime", "node scripts/build-runtime.mjs");
    expect(pkg.scripts).not.toHaveProperty("check:plugin-bundles");
  });

  it("ships acknowledgments and npm-owned assets without Marketplace files", () => {
    expect(pkg.files).toContain("dist/");
    expect(pkg.files).toContain("ACKNOWLEDGMENTS.md");
    expect(pkg.files).not.toContain("lcm.mjs");
    expect(pkg.files).not.toContain("mcp.mjs");
    expect(pkg.files).not.toContain(".claude-plugin/");
  });

  it("generates only the dist runtime bundle", () => {
    const source = readFileSync(new URL("../scripts/build-runtime.mjs", import.meta.url), "utf8");
    expect(source).toContain('join(root, "dist", "lcm.mjs")');
    expect(source).not.toContain('join(root, "lcm.mjs")');
    expect(source).not.toContain("mcp.mjs");
  });

  it("pins every direct dependency and development dependency exactly", () => {
    for (const dependencies of [pkg.dependencies, pkg.devDependencies]) {
      for (const version of Object.values(dependencies)) {
        expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
      }
    }
  });
});
