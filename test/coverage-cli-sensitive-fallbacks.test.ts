import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    daemonPort: 3737,
    storage: { backend: "sqlite" as const },
    security: { sensitivePatterns: [] as string[] },
  })),
  privateContention: false,
  loadProjectPatterns: vi.fn(async () => [] as string[]),
  readSyncDate: vi.fn(() => "2026-07-18" as string | null),
  scrub: vi.fn((value: string) => value),
}));

const securityReadRace = vi.hoisted(() => ({
  path: "",
  callCount: 0,
  enabled: false,
  code: "ENOENT",
}));

vi.mock("../src/security-files.js", async () => {
  const actual = await vi.importActual<typeof import("../src/security-files.js")>("../src/security-files.js");
  return {
    ...actual,
    readBoundedRegularFile: (path: string, options: Parameters<typeof actual.readBoundedRegularFile>[1]) => {
      if (securityReadRace.enabled && path === securityReadRace.path) {
        securityReadRace.callCount += 1;
        if (securityReadRace.callCount === 1) return "PAT_A\n";
        const error = Object.assign(new Error("pattern file race"), { code: securityReadRace.code });
        throw error;
      }
      return actual.readBoundedRegularFile(path, options);
    },
  };
});

vi.mock("../src/config-projection.js", async () => {
  const { PrivateMutationLockContentionError } = await vi.importActual<typeof import("../src/private-mutation-lock.js")>("../src/private-mutation-lock.js");
  return {
    loadStoredConfigProjection: () => {
    if (mocks.privateContention) {
      throw new PrivateMutationLockContentionError("publication busy");
    }
    return mocks.loadConfig();
  },
  };
});
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
import { BackendPublicationJournalError } from "../src/storage/backend-publication.js";
import { PrivateMutationLockContentionError } from "../src/private-mutation-lock.js";

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

  it("does not convert unresolved publication evidence into an empty pattern fallback", async () => {
    mocks.loadConfig.mockImplementationOnce(() => {
      throw new BackendPublicationJournalError(
        "unresolved-publication",
        "publication evidence is unresolved",
      );
    });
    await expect(handleSensitive(["list"], "/isolated/project", "/isolated/config.json"))
      .rejects.toThrow("publication evidence is unresolved");
  });

  it("does not swallow private publication contention", async () => {
    mocks.privateContention = true;
    try {
      await expect(handleSensitive(["list"], "/isolated/project", "/isolated/config.json"))
        .rejects.toBeInstanceOf(PrivateMutationLockContentionError);
    } finally {
      mocks.privateContention = false;
    }
  });

  it("treats a project pattern file disappearing after preflight as already removed", async () => {
    const project = mkdtempSync(join(tmpdir(), "lcm-sensitive-fallback-race-"));
    securityReadRace.path = join(project, "sensitive-patterns.txt");
    securityReadRace.callCount = 0;
    securityReadRace.enabled = true;
    try {
      await expect(handleSensitive(["remove", "PAT_A"], project, "/isolated/config.json"))
        .resolves.toMatchObject({ exitCode: 0 });
      expect(securityReadRace.callCount).toBe(2);
    } finally {
      securityReadRace.enabled = false;
      rmSync(project, { recursive: true, force: true });
    }

    const errorProject = mkdtempSync(join(tmpdir(), "lcm-sensitive-fallback-error-"));
    securityReadRace.path = join(errorProject, "sensitive-patterns.txt");
    securityReadRace.callCount = 0;
    securityReadRace.code = "EACCES";
    securityReadRace.enabled = true;
    try {
      await expect(handleSensitive(["remove", "PAT_A"], errorProject, "/isolated/config.json"))
        .rejects.toThrow("pattern file race");
      securityReadRace.callCount = 0;
      await expect(handleSensitive(["add", "PAT_B"], errorProject, "/isolated/config.json"))
        .rejects.toThrow("pattern file race");
    } finally {
      securityReadRace.enabled = false;
      securityReadRace.code = "ENOENT";
      rmSync(errorProject, { recursive: true, force: true });
    }
  });
});
