import { afterAll, describe, it, expect, vi } from "vitest";
import { chmodSync, existsSync as fsExistsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { EnsureCoreDeps } from "../src/bootstrap.js";
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS, DEFAULT_LLM_RETRY_POLICY, parseDaemonConfig } from "../src/daemon/config.js";
import { canonicalHookCommand, mergeClaudeSettings } from "../src/installer/settings.js";
import * as storageBackend from "../src/storage/backend.js";

const defaultDaemon = vi.hoisted(() => vi.fn().mockResolvedValue({ connected: true }));
const homeMock = vi.hoisted(() => ({ homeDir: "" }));
vi.mock("../src/daemon/lifecycle.js", () => ({ ensureDaemon: defaultDaemon }));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => homeMock.homeDir };
});
const publicationHome = mkdtempSync(join(tmpdir(), "lcm-bootstrap-test-"));
homeMock.homeDir = publicationHome;
const publicationRoot = join(publicationHome, ".lcm");
mkdirSync(publicationRoot, { mode: 0o700 });
mkdirSync(join(publicationHome, ".claude"), { mode: 0o700 });

afterAll(() => {
  rmSync(publicationHome, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<EnsureCoreDeps> = {}): EnsureCoreDeps {
  return {
    configPath: join(publicationRoot, "config.json"),
    settingsPath: "/tmp/test-settings.json",
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    binaryPath: "/opt/npm/bin/lcm",
    ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
    ...overrides,
  };
}

describe("ensureCore", () => {
  it("uses the default secure-root, durable writer, and daemon seams", async () => {
    const runtimeRoot = join(homedir(), ".lcm");
    const configPath = join(runtimeRoot, "config.json");
    const settingsPath = join(homedir(), ".claude", "settings.json");
    rmSync(configPath, { force: true });
    writeFileSync(settingsPath, "{}", { mode: 0o600 });
    chmodSync(runtimeRoot, 0o700);
    defaultDaemon.mockClear();

    try {
      const { ensureCore } = await import("../src/bootstrap.js");
      await expect(ensureCore()).resolves.toBe(true);
      expect(defaultDaemon).toHaveBeenCalledWith(expect.objectContaining({
        expectedStorageBackend: "sqlite",
        enforceUserManagerParent: true,
      }));
    } finally {
      rmSync(configPath, { force: true });
      rmSync(settingsPath, { force: true });
    }
  });

  it("creates config.json with defaults when missing", async () => {
    const deps = makeDeps();
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    expect(deps.writeFileSync).toHaveBeenCalledWith(
      deps.configPath,
      expect.stringContaining('"version"'),
    );
    const configWrite = vi.mocked(deps.writeFileSync).mock.calls.find(([path]) => path === deps.configPath);
    expect(configWrite).toBeDefined();
    const stored = JSON.parse(configWrite![1]) as { llm: Record<string, unknown> };
    expect(stored.llm.provider).toBe("auto");
    expect(stored.llm.requestTimeoutMs).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(stored.llm).not.toHaveProperty("retry");

    const effective = parseDaemonConfig(configWrite![1], {}, {});
    expect(effective.llm.requestTimeoutMs).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(effective.llm.retry).toEqual(DEFAULT_LLM_RETRY_POLICY);
  });

  it("keeps bounded config admission fail-closed when process ownership is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try {
      const { ensureCore } = await import("../src/bootstrap.js");
      await expect(ensureCore(makeDeps())).resolves.toBe(true);
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("uses the packaged runtime when no binary path is injected", async () => {
    const deps = makeDeps({ binaryPath: undefined });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    expect(deps.ensureDaemon).toHaveBeenCalledWith(expect.objectContaining({
      expectedEntrypoint: join(process.cwd(), "dist", "lcm.mjs"),
    }));
  });

  it("skips config.json creation when it already exists", async () => {
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({ version: 1 })),
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    const configWrites = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
      .filter((args) => args[0] === deps.configPath);
    expect(configWrites.length).toBe(0);
  });

  it("calls mergeClaudeSettings to clean stale hooks", async () => {
    const settingsWithDupes = JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }],
      },
    });
    const deps = makeDeps({
      existsSync: vi.fn().mockImplementation((p: string) => p.endsWith("settings.json")),
      readFileSync: vi.fn().mockReturnValue(settingsWithDupes),
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    const settingsWrites = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
      .filter((args) => args[0] === deps.settingsPath);
    expect(settingsWrites.length).toBe(1);
    const written = JSON.parse(settingsWrites[0][1]);
    expect(written.hooks?.PreCompact).toEqual([{
      matcher: "",
      hooks: [{
        type: "command",
        command: canonicalHookCommand("/opt/npm/bin/lcm", "compact --hook"),
      }],
    }]);
  });

  it("starts daemon if not running", async () => {
    const deps = makeDeps();
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    expect(deps.ensureDaemon).toHaveBeenCalledWith(
      expect.objectContaining({ expectedStorageBackend: "sqlite", enforceUserManagerParent: true }),
    );
  });

  it("rejects PostgreSQL before invoking the daemon lifecycle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-bootstrap-postgres-"));
    const root = join(dir, ".lcm");
    mkdirSync(root, { mode: 0o700 });
    const configPath = join(root, "config.json");
    const caFile = join(dir, "ca.pem");
    writeFileSync(configPath, JSON.stringify({ storage: { backend: "postgresql" } }));
    chmodSync(configPath, 0o600);
    writeFileSync(caFile, "test-ca");
    const previousUrl = process.env.LCM_POSTGRES_URL;
    const previousCa = process.env.LCM_POSTGRES_CA_FILE;
    const previousMigrationRole = process.env.LCM_POSTGRES_MIGRATION_ROLE;
    process.env.LCM_POSTGRES_URL = "postgresql://user:password@db.example/lcm";
    process.env.LCM_POSTGRES_CA_FILE = caFile;
    process.env.LCM_POSTGRES_MIGRATION_ROLE = "lcm_test_migrator";
    const deps = makeDeps({
      configPath,
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockImplementation((path: string) => path === configPath
        ? JSON.stringify({ storage: { backend: "postgresql" } })
        : "{}"),
    });

    try {
      const { ensureCoreEndpoint } = await import("../src/bootstrap.js");
      await expect(ensureCoreEndpoint(deps)).rejects.toThrow("publication evidence");
      expect(deps.ensureDaemon).not.toHaveBeenCalled();
    } finally {
      if (previousUrl === undefined) delete process.env.LCM_POSTGRES_URL;
      else process.env.LCM_POSTGRES_URL = previousUrl;
      if (previousCa === undefined) delete process.env.LCM_POSTGRES_CA_FILE;
      else process.env.LCM_POSTGRES_CA_FILE = previousCa;
      if (previousMigrationRole === undefined) delete process.env.LCM_POSTGRES_MIGRATION_ROLE;
      else process.env.LCM_POSTGRES_MIGRATION_ROLE = previousMigrationRole;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binds alternate canonical config admission to its own publication home", async () => {
    const alternateHome = mkdtempSync(join(tmpdir(), "lcm-bootstrap-alternate-home-"));
    const alternateRoot = join(alternateHome, ".lcm");
    const alternateConfigPath = join(alternateRoot, "config.json");
    mkdirSync(alternateRoot, { mode: 0o700 });
    writeFileSync(alternateConfigPath, JSON.stringify({ storage: { backend: "sqlite" } }), { mode: 0o600 });
    const select = vi.spyOn(storageBackend, "selectStorageBackend").mockImplementation((config) => {
      if (config.homeDir !== alternateHome) throw new Error("ambient publication home conflict");
      return { backend: "sqlite" };
    });
    const deps = makeDeps({
      configPath: alternateConfigPath,
      existsSync: fsExistsSync,
    });

    try {
      await expect((await import("../src/bootstrap.js")).ensureCoreEndpoint(deps))
        .resolves.toMatchObject({ connected: true });
      expect(select).toHaveBeenCalledWith({ backend: "sqlite", homeDir: alternateHome });
    } finally {
      select.mockRestore();
      rmSync(alternateHome, { recursive: true, force: true });
    }
  });

  it("rejects an oversized config before parsing it through an unbounded loader", async () => {
    const configPath = join(publicationRoot, "config.json");
    const oversized = `{"llm":{"model":"${"x".repeat(4 * 1024 * 1024)}"}}`;
    writeFileSync(configPath, oversized, { mode: 0o600 });
    const deps = makeDeps({
      configPath,
      existsSync: fsExistsSync,
    });

    try {
      const { ensureCoreEndpoint } = await import("../src/bootstrap.js");
      await expect(ensureCoreEndpoint(deps)).rejects.toThrow("size limit");
      expect(deps.ensureDaemon).not.toHaveBeenCalled();
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  it("rejects a non-canonical config path before daemon startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-bootstrap-noncanonical-"));
    const configPath = join(dir, "config.json");
    const deps = makeDeps({
      configPath,
      existsSync: fsExistsSync,
      writeFileSync: (path, data) => writeFileSync(path, data),
      mkdirSync: (path, options) => mkdirSync(path, options),
    });

    try {
      await expect(import("../src/bootstrap.js").then(({ ensureCoreEndpoint }) => ensureCoreEndpoint(deps)))
        .rejects.toThrow("canonical LCM configuration path");
      expect(deps.ensureDaemon).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("calls chmodSync(0o600) on config.json after creation", async () => {
    const chmodSync = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      chmodSync,
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    expect(chmodSync).toHaveBeenCalledWith(deps.configPath, 0o600);
  });

  it("continues when hardening a new config fails", async () => {
    const deps = makeDeps({
      chmodSync: vi.fn(() => { throw new Error("unsupported"); }),
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await expect(ensureCore(deps)).resolves.toBe(true);
  });

  it("does not rewrite unchanged settings and ignores malformed settings", async () => {
    const unchanged = makeDeps({
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockReturnValue(JSON.stringify(mergeClaudeSettings({}, "/opt/npm/bin/lcm"))),
    });
    const malformed = makeDeps({
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockReturnValue("{"),
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(unchanged);
    await expect(ensureCore(malformed)).resolves.toBe(true);
    expect(unchanged.writeFileSync).not.toHaveBeenCalled();
    expect(malformed.writeFileSync).not.toHaveBeenCalled();
  });
});

describe("ensureBootstrapped", () => {
  it("uses default flag inspection and durable bootstrap dependencies", async () => {
    const runtimeRoot = join(homedir(), ".lcm");
    const configPath = join(runtimeRoot, "config.json");
    const flagPath = join(runtimeRoot, "tmp", "bootstrapped-default-bootstrap.flag");
    rmSync(configPath, { force: true });
    rmSync(flagPath, { force: true });
    chmodSync(runtimeRoot, 0o700);

    try {
      const { ensureBootstrapped } = await import("../src/bootstrap.js");
      await expect(ensureBootstrapped("default-bootstrap")).resolves.toBe(true);
      expect(fsExistsSync(flagPath)).toBe(true);
    } finally {
      rmSync(configPath, { force: true });
      rmSync(flagPath, { force: true });
    }
  });

  it("skips ensureCore when flag file exists", async () => {
    const coreDeps = makeDeps();
    const { ensureBootstrapped } = await import("../src/bootstrap.js");
    await ensureBootstrapped("test-session", {
      ...coreDeps,
      flagExists: vi.fn().mockReturnValue(true),
      writeFlag: vi.fn(),
    });
    expect(coreDeps.ensureDaemon).not.toHaveBeenCalled();
  });

  it("runs ensureCore and writes flag when flag file missing", async () => {
    const writeFlag = vi.fn();
    const coreDeps = makeDeps();
    const { ensureBootstrapped } = await import("../src/bootstrap.js");
    await ensureBootstrapped("test-session", {
      ...coreDeps,
      flagExists: vi.fn().mockReturnValue(false),
      writeFlag,
    });
    expect(coreDeps.ensureDaemon).toHaveBeenCalledWith(
      expect.objectContaining({ enforceUserManagerParent: true }),
    );
    expect(writeFlag).toHaveBeenCalled();
  });

  it("continues when flag inspection and writing fail", async () => {
    const coreDeps = makeDeps();
    const { ensureBootstrapped } = await import("../src/bootstrap.js");
    await expect(ensureBootstrapped("unsafe/session:id", {
      ...coreDeps,
      flagExists: vi.fn(() => { throw new Error("unreadable"); }),
      writeFlag: vi.fn(() => { throw new Error("unwritable"); }),
    })).resolves.toBe(true);
    expect(coreDeps.ensureDaemon).toHaveBeenCalled();
  });

  it("does not write the bootstrap flag when daemon identity is unverified", async () => {
    const writeFlag = vi.fn();
    const coreDeps = makeDeps({ ensureDaemon: vi.fn().mockResolvedValue({ connected: false }) });
    const { ensureBootstrapped } = await import("../src/bootstrap.js");
    await expect(ensureBootstrapped("test-session", {
      ...coreDeps,
      flagExists: vi.fn().mockReturnValue(false),
      writeFlag,
    })).resolves.toBe(false);
    expect(writeFlag).not.toHaveBeenCalled();
  });
});
