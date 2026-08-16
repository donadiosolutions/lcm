import { describe, it, expect } from "vitest";
import { buildOrientationPrompt, LCM_MD_CONTENT } from "../../src/daemon/orientation.js";
import { renderGuidance } from "../../src/connectors/template-service.js";

describe("buildOrientationPrompt", () => {
  it("returns empty string — guidance now lives in ~/.claude/lcm.md", () => {
    expect(buildOrientationPrompt()).toBe("");
  });
});

describe("LCM_MD_CONTENT", () => {
  it("is the canonical MCP rules rendering", () => {
    expect(LCM_MD_CONTENT).toBe(renderGuidance("rules", "mcp"));
    expect(LCM_MD_CONTENT).toContain("lcm_grep");
    expect(LCM_MD_CONTENT).toContain("lcm_expand");
    expect(LCM_MD_CONTENT).not.toContain("lcm grep");
  });
});
