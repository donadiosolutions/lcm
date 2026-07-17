import { beforeEach, describe, expect, it, vi } from "vitest";

const fsState = vi.hoisted(() => ({
  exists: true,
  content: "// Updated: 2026-07-17\n",
  failure: undefined as Error | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => fsState.exists),
    readFileSync: vi.fn(() => {
      if (fsState.failure) throw fsState.failure;
      return fsState.content;
    }),
  };
});

vi.mock("../src/generated-patterns.js", () => ({
  GITLEAKS_PATTERNS: [{ id: "invalid-fixture", regex: "[", flags: "" }],
}));

import { readGitleaksSyncDate, ScrubEngine } from "../src/scrub.js";

describe("scrub metadata and trusted-pattern failures", () => {
  beforeEach(() => {
    fsState.exists = true;
    fsState.content = "// Updated: 2026-07-17\n";
    fsState.failure = undefined;
  });

  it("reads a valid generated-pattern sync date", () => {
    expect(readGitleaksSyncDate()).toBe("2026-07-17");
  });

  it("returns null for missing metadata, absent files, and read failures", () => {
    fsState.content = "// generated without a date\n";
    expect(readGitleaksSyncDate()).toBeNull();
    fsState.exists = false;
    expect(readGitleaksSyncDate()).toBeNull();
    fsState.exists = true;
    fsState.failure = new Error("deterministic read failure");
    expect(readGitleaksSyncDate()).toBeNull();
  });

  it("records malformed trusted patterns without preventing construction", () => {
    expect(new ScrubEngine([], []).invalidPatterns).toContain("[");
  });
});
