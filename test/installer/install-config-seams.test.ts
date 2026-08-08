import { beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

const bootstrapMock = vi.hoisted(() => ({
  ensureCore: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../src/bootstrap.js", () => ({ ensureCore: bootstrapMock.ensureCore }));
vi.mock("../../src/runtime-paths.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/runtime-paths.js")>("../../src/runtime-paths.js");
  return {
    ...actual,
    bootstrapLcmHome: vi.fn(),
    lcmHomeDir: () => join(homedir(), ".lcm-coverage-alt"),
  };
});
import { install, type ServiceDeps } from "../../installer/install.js";

function makeDeps(
  config: string,
  bounded?: ServiceDeps["readBoundedRegularFile"],
  configPresent = true,
): ServiceDeps {
  const root = join(homedir(), ".lcm-coverage-alt");
  const configPath = join(root, "config.json");
  const files = new Map<string, string>();
  const deps: ServiceDeps = {
    spawnSync: vi.fn().mockReturnValue({
      status: null,
      stdout: "",
      error: Object.assign(new Error("claude is not installed"), { code: "ENOENT" }),
    }),
    readFileSync: vi.fn((path: string) => {
      if (path === configPath) return config;
      return files.get(path) ?? "{}";
    }),
    writeFileSync: vi.fn((path: string, data: string) => { files.set(path, data); }),
    mkdirSync: vi.fn(),
    existsSync: vi.fn((path: string) => (path === configPath && configPresent) || files.has(path)),
    ensureLcmHome: vi.fn(),
    promptUser: vi.fn(),
    binaryPath: "/opt/npm/bin/lcm",
    runDoctor: vi.fn().mockResolvedValue([]),
    commandsSourceDir: "/nonexistent/lcm-commands",
    skillSourceDir: "/nonexistent/lcm-skills",
  };
  if (bounded !== undefined) deps.readBoundedRegularFile = bounded;
  return deps;
}

describe("installer config reader compatibility seams", () => {
  beforeEach(() => bootstrapMock.ensureCore.mockClear());

  it("uses the bounded compatibility reader for an unbound config path", async () => {
    const bounded = vi.fn(() => "{}");
    const deps = makeDeps("{}", bounded as ServiceDeps["readBoundedRegularFile"]);

    await expect(install(deps)).resolves.toBeUndefined();
    expect(bounded).toHaveBeenCalledWith(
      expect.stringContaining(".lcm-coverage-alt/config.json"),
      expect.objectContaining({
        allowedModes: [0o600],
        requireSingleLink: true,
      }),
    );
    expect(bootstrapMock.ensureCore).toHaveBeenCalled();
  });

  it("supports bounded-reader platforms without a getuid syscall", async () => {
    const bounded = vi.fn(() => "{}");
    const deps = makeDeps("{}", bounded as ServiceDeps["readBoundedRegularFile"]);
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      await expect(install(deps)).resolves.toBeUndefined();
      expect(bounded).toHaveBeenCalled();
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: () => number }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("handles a missing config through the unbound preparation seam", async () => {
    const deps = makeDeps("{}", undefined, false);

    await expect(install(deps)).resolves.toBeUndefined();
    expect(deps.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".lcm-coverage-alt/config.json"),
      expect.stringContaining('"version"'),
    );
  });

  it("treats a config created by a concurrent installer as already complete", async () => {
    const deps = makeDeps("{}", undefined, false);
    const configPath = join(homedir(), ".lcm-coverage-alt", "config.json");
    let checks = 0;
    deps.existsSync = vi.fn((path: string) => path === configPath ? ++checks > 1 : false);

    await expect(install(deps)).resolves.toBeUndefined();
    expect(deps.writeFileSync).not.toHaveBeenCalledWith(configPath, expect.any(String));
  });

  it("preserves an installer race when the config appears after a failed write", async () => {
    const deps = makeDeps("{}", undefined, false);
    const configPath = join(homedir(), ".lcm-coverage-alt", "config.json");
    let writeAttempted = false;
    const writeFile = deps.writeFileSync;
    deps.existsSync = vi.fn((path: string) => path === configPath ? writeAttempted : false);
    deps.writeFileSync = vi.fn((path: string, data: string) => {
      if (path === configPath) {
        writeAttempted = true;
        throw new Error("concurrent config publication");
      }
      writeFile(path, data);
    });

    await expect(install(deps)).resolves.toBeUndefined();
    expect(writeAttempted).toBe(true);
  });

  it("uses the bounded string fallback and rejects oversized content before parsing", async () => {
    const deps = makeDeps(`{"padding":"${"x".repeat(4 * 1024 * 1024)}"}`);

    await expect(install(deps)).rejects.toThrow("configuration file exceeds the 4 MiB safety limit");
    expect(bootstrapMock.ensureCore).not.toHaveBeenCalled();
  });

  it("parses the PostgreSQL backend branch on an unbound config path", async () => {
    const deps = makeDeps('{"storage":{"backend":"postgresql"}}');

    await expect(install(deps)).resolves.toBeUndefined();
    expect(bootstrapMock.ensureCore).toHaveBeenCalled();
  });
});
