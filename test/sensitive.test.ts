import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

function writeConfigFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
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
    configPath: (): string => j(_projectBase.current, ".lcm", "config.json"),
    projectsDir: (): string => j(_projectBase.current, "all-projects"),
  };
});

import { handleSensitive } from "../src/sensitive.js";
import { NATIVE_PATTERNS } from "../src/scrub.js";
import { GITLEAKS_PATTERNS } from "../src/generated-patterns.js";
import { BackendPublicationJournalError } from "../src/storage/backend-publication.js";
import {
  BackendPublicationCoordinator,
  backendPublicationMaterialWitness,
  type BackendPublicationDriver,
  type BackendPublicationRecoveryFile,
  type BackendPublicationRecoveryMaterial,
} from "../src/storage/backend-publication.js";
import { ConfigValidationError } from "../src/daemon/config.js";
import * as backendPublication from "../src/storage/backend-publication.js";
import * as storageBackend from "../src/storage/backend.js";

function recoveryFile(content: string): BackendPublicationRecoveryFile {
  return {
    presence: "present",
    content: Buffer.from(content),
    mode: 0o600,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
    nlink: "1",
    dev: "1",
    ino: "2",
    parentDev: "3",
    parentIno: "4",
  };
}

async function completePostgreSqlPublication(configPath: string, content: string): Promise<void> {
  chmodSync(configPath, 0o600);
  const config = recoveryFile(content);
  const absent = { presence: "absent" } as const;
  const material: BackendPublicationRecoveryMaterial = {
    source: { config, projectMap: absent },
    target: { config, projectMap: absent },
  };
  const state = backendPublicationMaterialWitness(material);
  const driver: BackendPublicationDriver = {
    observeLocalState: async () => state,
    publishProjectMap: async ({ expectedWitness }) => expectedWitness,
    publishConfig: async ({ expectedWitness }) => expectedWitness,
    restoreConfig: async ({ expectedWitness }) => expectedWitness,
    restoreProjectMap: async ({ expectedWitness }) => expectedWitness,
  };
  const homeDir = join(configPath, "..", "..");
  const coordinator = new BackendPublicationCoordinator({ homeDir, driver });
  await coordinator.prepare({
    publicationId: "sensitive-postgresql",
    sourceBackend: "sqlite",
    targetBackend: "postgresql",
    material,
    projects: [],
  });
  await coordinator.resume();
}

describe("lcm sensitive", () => {
  let tempBase: string;
  let cwd: string;
  let configPath: string;
  let pDir: string;

  beforeEach(() => {
    tempBase = join(tmpdir(), `lcm-sensitive-${Math.random().toString(36).slice(2)}`);
    _projectBase.current = tempBase;
    cwd = join(tempBase, "project");
    mkdirSync(tempBase, { mode: 0o700 });
    chmodSync(tempBase, 0o700);
    mkdirSync(cwd, { recursive: true });
    configPath = join(tempBase, ".lcm", "config.json");
    mkdirSync(join(tempBase, ".lcm"), { mode: 0o700 });

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

  it("list: fails closed when the project pattern path is not a regular file", async () => {
    mkdirSync(join(pDir, "sensitive-patterns.txt"));
    await expect(handleSensitive(["list"], cwd, configPath)).rejects.toThrow();
  });

  it("list: shows global user patterns from config.json", async () => {
    writeConfigFile(configPath, JSON.stringify({ security: { sensitivePatterns: ["CORP_TOKEN_.*"] } }, null, 2));
    const r = await handleSensitive(["list"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[user]      CORP_TOKEN_.*");
  });

  it("list: loads persisted global patterns for PostgreSQL without runtime secrets", async () => {
    const content = JSON.stringify({
      storage: { backend: "postgresql" },
      security: { sensitivePatterns: ["POSTGRES_SECRET_.*"] },
    });
    writeConfigFile(configPath, content);
    await completePostgreSqlPublication(configPath, content);

    const r = await handleSensitive(["list"], cwd, configPath);

    expect(r).toMatchObject({ exitCode: 0 });
    expect(r.stdout).toContain("[user]      POSTGRES_SECRET_.*");
  });

  it("list: preserves the empty-pattern fallback for invalid persisted configuration", async () => {
    writeConfigFile(configPath, JSON.stringify({ storage: { backend: "invalid" } }));

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
    writeConfigFile(configPath, JSON.stringify({ security: { sensitivePatterns: [] } }, null, 2));
    const r = await handleSensitive(["add", "--global", "CORP_SECRET_.*"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Added global pattern: CORP_SECRET_.*");
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(cfg.security.sensitivePatterns).toContain("CORP_SECRET_.*");
  });

  it("add --global: is idempotent — does not duplicate", async () => {
    writeConfigFile(configPath, JSON.stringify({ security: { sensitivePatterns: ["CORP_SECRET_.*"] } }, null, 2));
    const r = await handleSensitive(["add", "--global", "CORP_SECRET_.*"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("already present");
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(cfg.security.sensitivePatterns.filter((p: string) => p === "CORP_SECRET_.*")).toHaveLength(1);
  });

  it.each([null, [], { backend: "sqlite" }, { backend: "postgresql" }])(
    "add --global: treats storage shape %j as local-only",
    async (storage) => {
      const content = JSON.stringify({ storage, security: { sensitivePatterns: [] } });
      writeConfigFile(configPath, content);
      if ((storage as { backend?: unknown } | null)?.backend === "postgresql") {
        await completePostgreSqlPublication(configPath, content);
      }
      await expect(handleSensitive(["add", "--global", "LOCAL_SECRET_.*"], cwd, configPath))
        .resolves.toMatchObject({ exitCode: 0 });
    },
  );

  it.each([
    ["invalid JSON", "{"],
    ["not a JSON object", "[]"],
  ])("add --global: refuses a config with %s", async (message: string, content: string): Promise<void> => {
    writeConfigFile(configPath, content);
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

    writeConfigFile(configPath, JSON.stringify({ security: { sensitivePatterns: "invalid" } }));
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

  it("remove: treats a project pattern file disappearing after preflight as already removed", async () => {
    const patternsFile = join(pDir, "sensitive-patterns.txt");
    writeFileSync(patternsFile, "PAT_A\n");
    const securityFiles = await import("../src/security-files.js");
    const originalRead = securityFiles.readBoundedRegularFile;
    const readSpy = vi.spyOn(securityFiles, "readBoundedRegularFile");
    readSpy.mockImplementation((path, options) => {
      if (path === patternsFile && readSpy.mock.calls.filter(([candidate]) => candidate === patternsFile).length === 2) {
        throw Object.assign(new Error("file disappeared"), { code: "ENOENT" });
      }
      return originalRead(path, options);
    });
    await expect(handleSensitive(["remove", "PAT_A"], cwd, configPath)).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Removed project pattern"),
    });
    expect(readFileSync(patternsFile, "utf8")).toBe("\n");
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
    writeConfigFile(configPath, JSON.stringify({ security: { sensitivePatterns: ["[invalid"] } }));
    writeFileSync(join(pDir, "sensitive-patterns.txt"), "[also-invalid\n");
    await expect(handleSensitive(["test", "ordinary"], cwd, configPath)).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("No patterns matched"),
    });
  });

  it("test: reports matching gitleaks and user patterns", async (): Promise<void> => {
    const githubToken = `ghp_${"A".repeat(36)}`;
    writeConfigFile(configPath, JSON.stringify({ security: { sensitivePatterns: ["CORP_[A-Z]+"] } }));
    writeFileSync(join(pDir, "sensitive-patterns.txt"), "PROJECT_[A-Z]+\n");
    const r = await handleSensitive(["test", `token=${githubToken} CORP_ALPHA PROJECT_BETA`], cwd, configPath);
    expect(r.stdout).toContain("[gitleaks:");
    expect(r.stdout).toContain("[global]");
    expect(r.stdout).toContain("[project]");
  });

  it("test: scrubs with persisted global patterns for PostgreSQL without runtime secrets", async () => {
    const content = JSON.stringify({
      storage: { backend: "postgresql" },
      security: { sensitivePatterns: ["POSTGRES_SECRET_[A-Z]+"] },
    });
    writeConfigFile(configPath, content);
    await completePostgreSqlPublication(configPath, content);

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

  it("purge --yes: binds selection and the consumer lock to an alternate canonical home", async () => {
    writeConfigFile(configPath, JSON.stringify({ storage: { backend: "sqlite" } }));
    const select = vi.spyOn(storageBackend, "selectStorageBackend").mockImplementation((config) => {
      if (config.homeDir !== tempBase) throw new Error("ambient publication home conflict");
      return { backend: "sqlite" };
    });
    const consumerLock = vi.spyOn(backendPublication, "withBackendPublicationConsumerLockAsync");
    try {
      await expect(handleSensitive(["purge", "--yes"], cwd, configPath)).resolves.toMatchObject({
        exitCode: 0,
        stdout: expect.stringContaining("Purged project data"),
      });
      expect(select).toHaveBeenCalledWith({ backend: "sqlite", homeDir: tempBase });
      expect(consumerLock).toHaveBeenCalledWith(tempBase, expect.any(Function));
      expect(existsSync(pDir)).toBe(false);
    } finally {
      select.mockRestore();
      consumerLock.mockRestore();
    }
  });

  it("purge refuses admitted PostgreSQL before deleting local data", async () => {
    const content = JSON.stringify({ storage: { backend: "postgresql" } });
    writeConfigFile(configPath, content);
    await completePostgreSqlPublication(configPath, content);
    await expect(handleSensitive(["purge", "--yes"], cwd, configPath))
      .rejects.toMatchObject({name: "StorageBackendUnavailableError"});
    expect(existsSync(pDir)).toBe(true);
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
    writeConfigFile(configPath, JSON.stringify({ storage: { backend: "postgresql" } }));
    const allProjects = join(tempBase, "all-projects");
    if (extraArgs.includes("--all")) {
      mkdirSync(allProjects, { recursive: true });
      writeFileSync(join(allProjects, "data"), "value");
    } else {
      writeFileSync(join(pDir, "data"), "value");
    }

    await expect(handleSensitive(["purge", ...extraArgs, "--yes"], cwd, configPath))
      .rejects.toMatchObject({
        name: BackendPublicationJournalError.name,
        reason: "publication-evidence-missing",
      });
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
    writeConfigFile(configPath, content);
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
    writeConfigFile(configPath, JSON.stringify({ security: { sensitivePatterns: ["DEFAULT_PATH_UNIQUE_.*"] } }));
    const result = await handleSensitive(["list"], cwd);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("[user]      DEFAULT_PATH_UNIQUE_.*");
  });

  it("reports usage for unknown subcommands", async (): Promise<void> => {
    await expect(handleSensitive(["unknown"], cwd, configPath)).resolves.toMatchObject({ exitCode: 1 });
  });
});
