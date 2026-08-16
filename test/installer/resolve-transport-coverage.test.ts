import { describe, expect, it, vi } from "vitest";

const registryMock = vi.hoisted(() => ({
  resolveAgentTransport: vi.fn(),
}));

vi.mock("../../src/connectors/registry.js", () => registryMock);

import { resolveClaudeTransport } from "../../installer/install.js";

describe("Claude transport resolver error boundary", () => {
  it("maps an absent config to MCP while preserving other errors", () => {
    registryMock.resolveAgentTransport.mockImplementationOnce(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(resolveClaudeTransport("/tmp/missing/.lcm/config.json")).toBe("mcp");

    registryMock.resolveAgentTransport.mockImplementationOnce(() => {
      throw new Error("malformed config");
    });
    expect(() => resolveClaudeTransport("/tmp/malformed/.lcm/config.json")).toThrow("malformed config");
  });
});
