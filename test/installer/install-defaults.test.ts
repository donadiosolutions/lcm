import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureCore: vi.fn(),
  ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
  runDoctor: vi.fn().mockResolvedValue([]),
  printResults: vi.fn(),
}));

vi.mock("../../src/bootstrap.js", () => ({
  ensureCore: mocks.ensureCore.mockImplementation(async (options: any) => {
    await options.ensureDaemon({ port: 3737, pidFilePath: "/tmp/pid", spawnTimeoutMs: 1 });
  }),
}));
vi.mock("../../src/daemon/lifecycle.js", () => ({ ensureDaemon: mocks.ensureDaemon }));
vi.mock("../../src/doctor/doctor.js", () => ({ runDoctor: mocks.runDoctor, printResults: mocks.printResults }));
vi.mock("../../src/daemon/orientation.js", () => ({ LCM_MD_CONTENT: "orientation" }));

import { install, type ServiceDeps } from "../../installer/install.js";

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
});
