import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import pkg from "../package.json";

describe("package.json", () => {
  it("has correct name", () => expect(pkg.name).toBe("@donadiosolutions/lcm"));
  it("has bin entry", () => expect(pkg.bin).toHaveProperty("lcm"));
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

  it("ships mcp.mjs as a fallback MCP entrypoint", () => {
    expect(pkg.files).toContain("mcp.mjs");
  });

  it("uses exact, reproducible plugin bundle tooling", () => {
    expect(pkg.devDependencies.esbuild).toBe("0.28.1");
    expect(pkg.scripts).toHaveProperty("check:plugin-bundles");
  });

  it("excludes destructive dogfood and E2E helpers from the package allowlist", () => {
    expect(pkg.files).toContain("!.claude-plugin/commands/lcm-dogfood.md");
    expect(pkg.files).toContain("!.claude-plugin/skills/lcm-dogfood/");
    expect(pkg.files).toContain("!.claude-plugin/skills/lcm-e2e/");
  });

  it("fails closed when no plugin cache bundle can be resolved", () => {
    const skill = readFileSync(new URL("../.claude-plugin/skills/lcm-context/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain('[ -n "$LCM_DIR" ] && [ -f "${LCM_DIR}lcm.mjs" ]');
    expect(skill).not.toMatch(/node "\$\(ls -d/);
  });

  it("keeps dogfood diagnostics single-line even though the helper is not shipped", () => {
    const helper = readFileSync(new URL("../.claude-plugin/skills/lcm-dogfood/scripts/prompt-search-test.js", import.meta.url), "utf8");
    expect(helper.match(/replace\(\/\[\\r\\n\]\/g, " "\)/g)).toHaveLength(2);
    expect(helper).toContain('req.on("error", () => console.log("Request failed"))');
  });

  it("ships inert plugin bundles without runtime package installation", () => {
    for (const entrypoint of ["lcm.mjs", "mcp.mjs"]) {
      const source = readFileSync(new URL(`../${entrypoint}`, import.meta.url), "utf8");
      expect(source).not.toContain("npm install --silent");
      expect(source).not.toContain("npm run build --silent");
      expect(source).not.toContain("execSync(");
    }
  });
});
