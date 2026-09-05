import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => {
  const getBuiltinModule = (process as NodeJS.Process & {
    getBuiltinModule: (specifier: string) => unknown;
  }).getBuiltinModule;
  const fs = getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = getBuiltinModule("node:os") as typeof import("node:os");
  const path = getBuiltinModule("node:path") as typeof import("node:path");
  return {
    homeDir: fs.mkdtempSync(path.join(os.tmpdir(), "lcm-installer-defaults-")),
    ensureCore: vi.fn(),
    ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
    runDoctor: vi.fn().mockResolvedValue([]),
    printResults: vi.fn(),
    question: vi.fn().mockResolvedValue("1"),
    close: vi.fn(),
  };
});
vi.mock("../../src/bootstrap.js", () => ({
  ensureCore: mocks.ensureCore.mockImplementation(async (options: any) => {
    await options.ensureDaemon({ port: 3737, pidFilePath: "/tmp/pid", spawnTimeoutMs: 1 });
  }),
}));
vi.mock("../../src/daemon/lifecycle.js", () => ({ ensureDaemon: mocks.ensureDaemon }));
vi.mock("../../src/doctor/doctor.js", () => ({ runDoctor: mocks.runDoctor, printResults: mocks.printResults }));
vi.mock("../../src/daemon/orientation.js", () => ({ LCM_MD_CONTENT: "orientation" }));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => mocks.homeDir };
});
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import { install, type ServiceDeps } from "../../installer/install.js";

beforeAll(() => {
  expect(dirname(mocks.homeDir)).toBe(tmpdir());
});

afterAll(() => {
  rmSync(mocks.homeDir, { recursive: true, force: true });
});

describe("install default service boundaries", () => {
  it("uses default daemon and doctor integrations", async () => {
    const files = new Map<string, string>();
    const deps: ServiceDeps = {
      spawnSync: vi.fn().mockReturnValue({
        status: null,
        stdout: "",
        error: Object.assign(new Error("missing"), { code: "ENOENT" }),
      }),
      readFileSync: vi.fn((path: string) => files.get(path) ?? "{}"),
      writeFileSync: vi.fn((path: string, data: string) => {
        files.set(path, data);
      }),
      mkdirSync: vi.fn(),
      existsSync: vi.fn((path: string) => path.endsWith("config.json")),
      binaryPath: "/usr/local/bin/lcm",
      promptUser: vi.fn(),
    };
    await install(deps);
    expect(mocks.ensureDaemon).toHaveBeenCalled();
    expect(mocks.runDoctor).toHaveBeenCalled();
    expect(mocks.printResults).toHaveBeenCalledWith([]);
  });

  it("authenticates the default runtime home when no service dependencies are injected", async () => {
    const root = join(mocks.homeDir, ".lcm");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);

    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    mocks.question.mockResolvedValue("1");
    mocks.close.mockClear();
    try {
      await expect(install()).resolves.toBeUndefined();
      expect(mocks.ensureCore).toHaveBeenCalledWith(expect.objectContaining({
        ensureRuntimeHome: expect.any(Function),
      }));
      expect(mocks.close).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalIsTTY });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes the default readline interface when the public installer prompt fails", async () => {
    const root = join(mocks.homeDir, ".lcm");
    rmSync(root, { recursive: true, force: true });
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    mocks.question.mockRejectedValueOnce(new Error("failed"));
    mocks.close.mockClear();
    try {
      await expect(install()).rejects.toThrow("failed");
      expect(mocks.close).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalIsTTY });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
