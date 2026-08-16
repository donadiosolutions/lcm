import { describe, it, expect } from "vitest";
import {
  AGENTS,
  findAgent,
  getAgentsByCategory,
  resolveAgentTransport,
} from "../../src/connectors/registry.js";
import { CONNECTOR_TRANSPORTS, requiresRestart } from "../../src/connectors/types.js";

describe("connector registry", () => {
  it("has exactly 22 agents", () => {
    expect(AGENTS).toHaveLength(22);
  });

  it("all agents have required fields", () => {
    for (const agent of AGENTS) {
      expect(agent.id).toBeTruthy();
      expect(agent.name).toBeTruthy();
      expect(agent.category).toBeTruthy();
      expect(CONNECTOR_TRANSPORTS).toContain(agent.defaultTransport);
      expect(agent.capabilities.cli.guidance.length).toBeGreaterThan(0);
      if (agent.capabilities.mcp) {
        expect(agent.capabilities.mcp.mcpAdapter).toBe(true);
        expect(agent.capabilities.mcp.guidance.length).toBeGreaterThan(0);
      }
    }
  });

  it("all agent ids are unique", () => {
    const ids = AGENTS.map(a => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("config paths expose only declared bundle capabilities", () => {
    for (const agent of AGENTS) {
      if (agent.configPaths.hook) {
        expect(agent.capabilities.cli.nativeHook || agent.capabilities.mcp?.nativeHook).toBe(true);
      }
      if (agent.configPaths.mcp) {
        expect(agent.capabilities.mcp?.mcpAdapter).toBe(true);
      }
      if (agent.configPaths.skill) {
        expect(agent.capabilities.cli.guidance.includes("skill")).toBe(true);
      }
    }
  });

  it("getAgentsByCategory filters correctly", () => {
    const cli = getAgentsByCategory("cli");
    expect(cli.length).toBe(7);
    expect(cli.every(a => a.category === "cli")).toBe(true);
  });

  it("findAgent works by id and name", () => {
    expect(findAgent("claude-code")?.name).toBe("Claude Code");
    expect(findAgent("Claude Code")?.id).toBe("claude-code");
    expect(findAgent("nonexistent")).toBeUndefined();
  });

  it("rejects transport resolution for an unknown agent", () => {
    expect(() => resolveAgentTransport("nonexistent")).toThrow("Unknown agent: nonexistent");
  });

  it("records transport defaults and the Codex bundle preference", () => {
    expect(findAgent("codex")?.defaultTransport).toBe("cli");
    expect(findAgent("codex")?.capabilities.cli).toMatchObject({
      guidance: ["skill"],
      nativeHook: true,
    });
    expect(findAgent("claude-code")?.defaultTransport).toBe("mcp");
    expect(findAgent("qwen-code")?.defaultTransport).toBe("mcp");
    expect(findAgent("zed")?.defaultTransport).toBe("mcp");
  });

  it("requiresRestart is true for both public transports", () => {
    expect(requiresRestart("cli")).toBe(true);
    expect(requiresRestart("mcp")).toBe(true);
  });
});
