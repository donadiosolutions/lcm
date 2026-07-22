import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// Mutable ref updated in beforeEach — lets the vi.mock factory redirect projectDir
// into the per-test temp dir so no writes touch the real ~/.lcm/.
const _projectBase = vi.hoisted(() => ({ current: "" }));

interface SensitiveConfig {
  security: {
    sensitivePatterns: string[];
  };
}

vi.mock("../src/daemon/project.js", async () => {
  const { createHash: hash } = await import("node:crypto");
  const { join: j } = await import("node:path");
  return {
    projectDir: (cwd: string) => j(_projectBase.current, "projects", hash("sha256").update(cwd).digest("hex")),
    projectId: (cwd: string) => hash("sha256").update(cwd).digest("hex"),
    projectDbPath: (cwd: string) => j(_projectBase.current, "projects", hash("sha256").update(cwd).digest("hex"), "db.sqlite"),
    projectMetaPath: (cwd: string) => j(_projectBase.current, "projects", hash("sha256").update(cwd).digest("hex"), "meta.json"),
    ensureProjectDir: () => {},
  };
});

vi.mock("../src/runtime-paths.js", async (): Promise<typeof import("../src/runtime-paths.js")> => {
  const actual = await vi.importActual<typeof import("../src/runtime-paths.js")>("../src/runtime-paths.js");
  const { join: j } = await import("node:path");
  return {
    ...actual,
    configPath: (): string => j(_projectBase.current, "config.json"),
    projectsDir: (): string => j(_projectBase.current, "all-projects"),
  };
});

import { handleSensitive } from "../src/sensitive.js";
import { NATIVE_PATTERNS } from "../src/scrub.js";
import { GITLEAKS_PATTERNS } from "../src/generated-patterns.js";
import { StorageBackendUnavailableError } from "../src/storage/backend.js";
import { ConfigValidationError } from "../src/daemon/config.js";

describe("lcm sensitive", () => {
  let tempBase: string;
  let cwd: string;
  let configPath: string;
  let pDir: string;

  beforeEach(() => {
    tempBase = join(tmpdir(), `lcm-sensitive-${Math.random().toString(36).slice(2)}`);
    _projectBase.current = tempBase;
    cwd = join(tempBase, "project");
    mkdirSync(cwd, { recursive: true });
    configPath = join(tempBase, "config.json");

    const hash = createHash("sha256").update(cwd).digest("hex");
    pDir = join(tempBase, "projects", hash);
    mkdirSync(pDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempBase, { recursive: true, force: true });
  });

  // --- list ---

  it("list: shows gitleaks pattern count and native patterns with correct labels", async () => {
    const r = await handleSensitive(["list"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    // Gitleaks section: shows count summary
    expect(r.stdout).toContain(`[gitleaks]  ${GITLEAKS_PATTERNS.length} patterns`);
    // Native section: each native pattern shown with [native] label
    for (const p of NATIVE_PATTERNS) {
      expect(r.stdout).toContain(`[native]    ${p}`);
    }
  });

  it("list: shows project patterns with [user] label when file exists", async () => {
    writeFileSync(join(pDir, "sensitive-patterns.txt"), "MY_SECRET_TOKEN_.*\n");
    const r = await handleSensitive(["list"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[user]      MY_SECRET_TOKEN_.*");
  });

  it("list: shows (none) when no project patterns", async () => {
    const r = await handleSensitive(["list"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("(none)");
  });

  it("list: shows global user patterns from config.json", async () => {
    writeFileSync(configPath, JSON.stringify({ security: { sensitivePatterns: ["CORP_TOKEN_.*"] } }, null, 2));
    const r = await handleSensitive(["list"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[user]      CORP_TOKEN_.*");
  });

  it("list: loads persisted global patterns for PostgreSQL without runtime secrets", async () => {
    writeFileSync(configPath, JSON.stringify({
      storage: { backend: "postgresql" },
      security: { sensitivePatterns: ["POSTGRES_SECRET_.*"] },
    }));

    const r = await handleSensitive(["list"], cwd, configPath);

    expect(r).toMatchObject({ exitCode: 0 });
    expect(r.stdout).toContain("[user]      POSTGRES_SECRET_.*");
  });

  it("list: preserves the empty-pattern fallback for invalid persisted configuration", async () => {
    writeFileSync(configPath, JSON.stringify({ storage: { backend: "invalid" } }));

    const r = await handleSensitive(["list"], cwd, configPath);

    expect(r).toMatchObject({ exitCode: 0 });
    expect(r.stdout).toContain("Global patterns (config.json):\n  (none)");
  });

  // --- add ---

  it("add: appends pattern to project file", async () => {
    const r = await handleSensitive(["add", "MY_API_KEY_.*"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Added project pattern: MY_API_KEY_.*");
    const content = readFileSync(join(pDir, "sensitive-patterns.txt"), "utf-8");
    expect(content).toContain("MY_API_KEY_.*");
  });

  it("add: is idempotent — does not duplicate pattern", async () => {
    writeFileSync(join(pDir, "sensitive-patterns.txt"), "MY_API_KEY_.*\n");
    const r = await handleSensitive(["add", "MY_API_KEY_.*"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("already present");
    const content = readFileSync(join(pDir, "sensitive-patterns.txt"), "utf-8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines.filter(l => l === "MY_API_KEY_.*")).toHaveLength(1);
  });

  it("add --global: appends to config.json sensitivePatterns", async () => {
    writeFileSync(configPath, JSON.stringify({ security: { sensitivePatterns: [] } }, null, 2));
    const r = await handleSensitive(["add", "--global", "CORP_SECRET_.*"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Added global pattern: CORP_SECRET_.*");
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(cfg.security.sensitivePatterns).toContain("CORP_SECRET_.*");
  });

  it("add --global: is idempotent — does not duplicate", async () => {
    writeFileSync(configPath, JSON.stringify({ security: { sensitivePatterns: ["CORP_SECRET_.*"] } }, null, 2));
    const r = await handleSensitive(["add", "--global", "CORP_SECRET_.*"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("already present");
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(cfg.security.sensitivePatterns.filter((p: string) => p === "CORP_SECRET_.*")).toHaveLength(1);
  });

  it.each([
    ["invalid JSON", "{"],
    ["not a JSON object", "[]"],
  ])("add --global: refuses a config with %s", async (message: string, content: string): Promise<void> => {
    writeFileSync(configPath, content);
    const r = await handleSensitive(["add", "--global", "CORP_SECRET_.*"], cwd, configPath);
    expect(r).toMatchObject({ exitCode: 1 });
    expect(r.stdout).toContain(message);
    expect(readFileSync(configPath, "utf-8")).toBe(content);
  });

  it("add --global: creates missing security structures and config directories", async (): Promise<void> => {
    configPath = join(tempBase, "nested", "config.json");
    const r = await handleSensitive(["add", "--global", "CORP_SECRET_.*"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toMatchObject({
      security: { sensitivePatterns: ["CORP_SECRET_.*"] },
    });

    writeFileSync(configPath, JSON.stringify({ security: { sensitivePatterns: "invalid" } }));
    await expect(handleSensitive(["add", "--global", "SECOND_.*"], cwd, configPath))
      .resolves.toMatchObject({ exitCode: 0 });
    const repairedConfig = JSON.parse(readFileSync(configPath, "utf-8")) as SensitiveConfig;
    expect(repairedConfig.security.sensitivePatterns).toEqual(["SECOND_.*"]);
  });

  it("add: appends and normalizes a missing trailing newline in a project pattern file", async (): Promise<void> => {
    writeFileSync(join(pDir, "sensitive-patterns.txt"), "PAT_A");
    await expect(handleSensitive(["add", "PAT_B"], cwd, configPath)).resolves.toMatchObject({ exitCode: 0 });
    expect(readFileSync(join(pDir, "sensitive-patterns.txt"), "utf-8")).toBe("PAT_A\nPAT_B\n");
  });

  it("add: preserves an existing project pattern file with a trailing newline", async (): Promise<void> => {
    writeFileSync(join(pDir, "sensitive-patterns.txt"), "PAT_A\n");
    await expect(handleSensitive(["add", "PAT_B"], cwd, configPath)).resolves.toMatchObject({ exitCode: 0 });
    expect(readFileSync(join(pDir, "sensitive-patterns.txt"), "utf-8")).toBe("PAT_A\nPAT_B\n");
  });

  it("add --global: rethrows non-missing filesystem failures", async (): Promise<void> => {
    await expect(handleSensitive(["add", "--global", "PATTERN"], cwd, tempBase)).rejects.toThrow();
  });

  it.each([["add"], ["remove"], ["test"]])("%s: reports missing input", async (command: string): Promise<void> => {
    const r = await handleSensitive([command], cwd, configPath);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Usage:");
  });

  // --- remove ---

  it("remove: removes exact match from project file", async () => {
    writeFileSync(join(pDir, "sensitive-patterns.txt"), "PAT_A\nPAT_B\n");
    const r = await handleSensitive(["remove", "PAT_A"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Removed project pattern: PAT_A");
    const content = readFileSync(join(pDir, "sensitive-patterns.txt"), "utf-8");
    expect(content).not.toContain("PAT_A");
    expect(content).toContain("PAT_B");
  });

  it("remove: prints error when pattern not found", async () => {
    writeFileSync(join(pDir, "sensitive-patterns.txt"), "PAT_B\n");
    const r = await handleSensitive(["remove", "PAT_A"], cwd, configPath);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Pattern not found");
  });

  // --- test ---

  it("test: shows [REDACTED] for matching input", async () => {
    const r = await handleSensitive(["test", "sk-abcdefghijklmnopqrstuv"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[REDACTED]");
  });

  it("test: shows original for non-matching input", async () => {
    const r = await handleSensitive(["test", "hello world"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("No patterns matched");
    expect(r.stdout).toContain("hello world");
  });

  it("test: skips invalid global and project patterns", async (): Promise<void> => {
    writeFileSync(configPath, JSON.stringify({ security: { sensitivePatterns: ["[invalid"] } }));
    writeFileSync(join(pDir, "sensitive-patterns.txt"), "[also-invalid\n");
    await expect(handleSensitive(["test", "ordinary"], cwd, configPath)).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("No patterns matched"),
    });
  });

  it("test: reports matching gitleaks and user patterns", async (): Promise<void> => {
    const githubToken = `ghp_${"A".repeat(36)}`;
    writeFileSync(configPath, JSON.stringify({ security: { sensitivePatterns: ["CORP_[A-Z]+"] } }));
    writeFileSync(join(pDir, "sensitive-patterns.txt"), "PROJECT_[A-Z]+\n");
    const r = await handleSensitive(["test", `token=${githubToken} CORP_ALPHA PROJECT_BETA`], cwd, configPath);
    expect(r.stdout).toContain("[gitleaks:");
    expect(r.stdout).toContain("[global]");
    expect(r.stdout).toContain("[project]");
  });

  it("test: scrubs with persisted global patterns for PostgreSQL without runtime secrets", async () => {
    writeFileSync(configPath, JSON.stringify({
      storage: { backend: "postgresql" },
      security: { sensitivePatterns: ["POSTGRES_SECRET_[A-Z]+"] },
    }));

    const r = await handleSensitive(["test", "value=POSTGRES_SECRET_ALPHA"], cwd, configPath);

    expect(r).toMatchObject({ exitCode: 0 });
    expect(r.stdout).toContain("[global]  POSTGRES_SECRET_[A-Z]+");
    expect(r.stdout).toContain("Redacted: value=[REDACTED]");
  });

  // --- purge ---

  it("purge: requires --yes — exits 1 without it", async () => {
    const r = await handleSensitive(["purge"], cwd, configPath);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("--yes");
  });

  it("purge --yes: deletes project dir", async () => {
    writeFileSync(join(pDir, "sensitive-patterns.txt"), "FOO\n");
    expect(existsSync(pDir)).toBe(true);
    const r = await handleSensitive(["purge", "--yes"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(existsSync(pDir)).toBe(false);
  });

  it("purge --yes: succeeds when project data is already absent", async (): Promise<void> => {
    rmSync(pDir, { recursive: true, force: true });
    await expect(handleSensitive(["purge", "--yes"], cwd, configPath)).resolves.toEqual({
      exitCode: 0,
      stdout: "No project data to purge.\n",
    });
  });

  it("purge --all --yes handles both existing and absent project roots", async (): Promise<void> => {
    const allProjects = join(tempBase, "all-projects");
    mkdirSync(allProjects, { recursive: true });
    writeFileSync(join(allProjects, "data"), "value");
    const removed = await handleSensitive(["purge", "--all", "--yes"], cwd, configPath);
    expect(removed).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("Purged all") });
    expect(existsSync(allProjects)).toBe(false);
    await expect(handleSensitive(["purge", "--all", "--yes"], cwd, configPath)).resolves.toEqual({
      exitCode: 0,
      stdout: "No project data to purge.\n",
    });
  });

  it.each([
    ["current project", [] as string[]],
    ["all projects", ["--all"]],
  ])("purge --yes: rejects PostgreSQL before deleting %s data", async (_label, extraArgs) => {
    writeFileSync(configPath, JSON.stringify({ storage: { backend: "postgresql" } }));
    const allProjects = join(tempBase, "all-projects");
    if (extraArgs.includes("--all")) {
      mkdirSync(allProjects, { recursive: true });
      writeFileSync(join(allProjects, "data"), "value");
    } else {
      writeFileSync(join(pDir, "data"), "value");
    }

    await expect(handleSensitive(["purge", ...extraArgs, "--yes"], cwd, configPath))
      .rejects.toBeInstanceOf(StorageBackendUnavailableError);
    expect(existsSync(extraArgs.includes("--all") ? allProjects : pDir)).toBe(true);
  });

  it.each([
    ["malformed JSON", "{"],
    ["an unknown backend", JSON.stringify({ storage: { backend: "unknown" } })],
    ["a forbidden PostgreSQL URL", JSON.stringify({
      storage: {
        backend: "postgresql",
        postgresql: { url: "postgresql://user:secret@localhost/lcm" },
      },
    })],
  ])("purge --yes: preserves all targets when config contains %s", async (_label, content) => {
    writeFileSync(configPath, content);
    writeFileSync(join(pDir, "data"), "current");
    const allProjects = join(tempBase, "all-projects");
    mkdirSync(allProjects, { recursive: true });
    writeFileSync(join(allProjects, "data"), "all");

    for (const extraArgs of [[], ["--all"]]) {
      await expect(handleSensitive(["purge", ...extraArgs, "--yes"], cwd, configPath))
        .rejects.toBeInstanceOf(ConfigValidationError);
      expect(existsSync(pDir)).toBe(true);
      expect(existsSync(allProjects)).toBe(true);
      expect(readFileSync(join(pDir, "data"), "utf8")).toBe("current");
      expect(readFileSync(join(allProjects, "data"), "utf8")).toBe("all");
    }
  });

  it("uses the isolated default config path when none is supplied", async (): Promise<void> => {
    writeFileSync(configPath, JSON.stringify({ security: { sensitivePatterns: ["DEFAULT_PATH_UNIQUE_.*"] } }));
    const result = await handleSensitive(["list"], cwd);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("[user]      DEFAULT_PATH_UNIQUE_.*");
  });

  it("reports usage for unknown subcommands", async (): Promise<void> => {
    await expect(handleSensitive(["unknown"], cwd, configPath)).resolves.toMatchObject({ exitCode: 1 });
  });
});
