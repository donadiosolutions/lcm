import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockReturnValue("name: invalid\ndescription: missing template\nvariables: []\n"),
}));

import { loadTemplate } from "../../src/prompts/loader.js";

describe("loadTemplate malformed content", () => {
  it("rejects a template without a string template field", () => {
    expect(() => loadTemplate("invalid")).toThrow(
      "Invalid prompt template: invalid — missing 'template' field",
    );
  });
});
