import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  failure: "raw filesystem failure" as unknown,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: () => { throw state.failure; },
  };
});

import { validateCwd } from "../../src/daemon/validate-cwd.js";

describe("validateCwd filesystem failure handling", () => {
  it("sanitizes a non-Error stat failure", () => {
    expect(() => validateCwd("/tmp")).toThrow("filesystem error");
  });
});
