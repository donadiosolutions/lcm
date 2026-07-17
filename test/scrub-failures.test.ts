import { beforeEach, describe, expect, it, vi } from "vitest";

interface FsState {
  exists: boolean;
  content: string;
  failure: Error | undefined;
}

interface GeneratedPatternsMock {
  GITLEAKS_PATTERNS: Array<{ id: string; regex: string; flags: string }>;
}

const fsState = vi.hoisted((): FsState => ({
  exists: true,
  content: "// Updated: 2026-07-17\n",
  failure: undefined as Error | undefined,
}));

vi.mock("node:fs", async (): Promise<typeof import("node:fs")> => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((): boolean => fsState.exists),
    readFileSync: vi.fn((): string => {
      if (fsState.failure) throw fsState.failure;
      return fsState.content;
    }),
  };
});

vi.mock("../src/generated-patterns.js", (): GeneratedPatternsMock => ({
  GITLEAKS_PATTERNS: [{ id: "invalid-fixture", regex: "[", flags: "" }],
}));

import { readGitleaksSyncDate, ScrubEngine } from "../src/scrub.js";

describe("scrub metadata and trusted-pattern failures", (): void => {
  beforeEach((): void => {
    fsState.exists = true;
    fsState.content = "// Updated: 2026-07-17\n";
    fsState.failure = undefined;
  });

  it("reads a valid generated-pattern sync date", (): void => {
    expect(readGitleaksSyncDate()).toBe("2026-07-17");
  });

  it("returns null for missing metadata, absent files, and read failures", (): void => {
    fsState.content = "// generated without a date\n";
    expect(readGitleaksSyncDate()).toBeNull();
    fsState.exists = false;
    expect(readGitleaksSyncDate()).toBeNull();
    fsState.exists = true;
    fsState.failure = new Error("deterministic read failure");
    expect(readGitleaksSyncDate()).toBeNull();
  });

  it("records malformed trusted patterns without preventing construction", (): void => {
    expect(new ScrubEngine([], []).invalidPatterns).toContain("[");
  });
});
