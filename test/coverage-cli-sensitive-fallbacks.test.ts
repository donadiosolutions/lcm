import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    daemonPort: 3737,
    storage: { backend: "sqlite" as const },
    security: { sensitivePatterns: [] as string[] },
  })),
  loadProjectPatterns: vi.fn(async () => [] as string[]),
  readSyncDate: vi.fn(() => "2026-07-18" as string | null),
  scrub: vi.fn((value: string) => value),
}));

vi.mock("../src/config-projection.js", () => ({ loadStoredConfigProjection: mocks.loadConfig }));
vi.mock("../src/daemon/project.js", () => ({ projectDir: (cwd: string): string => cwd }));
vi.mock("../src/generated-patterns.js", () => ({ GITLEAKS_PATTERNS: [] }));
vi.mock("../src/runtime-paths.js", () => ({
  configPath: (): string => "/isolated/config.json",
  projectsDir: (): string => "/isolated/projects",
}));
vi.mock("../src/scrub.js", () => ({
  NATIVE_PATTERNS: [],
  readGitleaksSyncDate: mocks.readSyncDate,
  ScrubEngine: {
    loadProjectPatterns: mocks.loadProjectPatterns,
    forProject: vi.fn(async () => ({ scrub: mocks.scrub })),
  },
}));

import { handleSensitive } from "../src/sensitive.js";

describe("sensitive configuration fallbacks", () => {
  it.each([
    ["available", "2026-07-18", "(synced 2026-07-18)"],
    ["unavailable", null, "patterns\n"],
  ] as const)("lists an empty normalized security section when metadata is %s", async (_state, syncDate, expected) => {
    mocks.readSyncDate.mockReturnValueOnce(syncDate);
    const result = await handleSensitive(["list"], "/isolated/project", "/isolated/config.json");
    expect(result.stdout).toContain(expected);
    if (syncDate === null) expect(result.stdout).not.toContain("(synced ");
    expect(result.stdout).toContain("Global patterns (config.json):\n  (none)");
  });

  it("tests text with an absent normalized security section", async () => {
    const result = await handleSensitive(["test", "ordinary"], "/isolated/project", "/isolated/config.json");
    expect(result).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("No patterns matched") });
  });
});
