import { describe, expect, it, vi } from "vitest";

const daemonMock = vi.hoisted(() => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
}));
const doctorMock = vi.hoisted(() => ({
  runDoctor: vi.fn().mockResolvedValue([]),
  printResults: vi.fn(),
}));
const bootstrapMock = vi.hoisted(() => ({
  ensureCore: vi.fn(async (deps: { ensureDaemon: (opts: unknown) => Promise<unknown> }) => {
    await deps.ensureDaemon({ port: 0, pidFilePath: "/tmp/lcm-test.pid", spawnTimeoutMs: 1 });
    return true;
  }),
}));
const readlineMock = vi.hoisted(() => ({ createInterface: vi.fn() }));

vi.mock("../../src/bootstrap.js", () => ({ ensureCore: bootstrapMock.ensureCore }));
vi.mock("../../src/daemon/lifecycle.js", () => daemonMock);
vi.mock("../../src/doctor/doctor.js", () => doctorMock);
vi.mock("node:readline/promises", () => readlineMock);

import { install, readlinePrompt, type ServiceDeps } from "../../installer/install.js";

describe("installer default fallback coverage", () => {
  it("closes the readline interface after a successful prompt", async () => {
    const close = vi.fn();
    const question = vi.fn().mockResolvedValue("answer");
    readlineMock.createInterface.mockReturnValue({ question, close });

    await expect(readlinePrompt("Question: ")).resolves.toBe("answer");
    expect(readlineMock.createInterface).toHaveBeenCalledWith({
      input: process.stdin,
      output: process.stdout,
    });
    expect(question).toHaveBeenCalledWith("Question: ");
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses the default daemon and doctor fallbacks through dynamic imports", async () => {
    const files = new Map<string, string>();
    const deps: ServiceDeps = {
      spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: "[]" }),
      existsSync: vi.fn((path: string) => files.has(path)),
      readFileSync: vi.fn((path: string) => files.get(path) ?? "{}"),
      writeFileSync: vi.fn((path: string, data: string) => { files.set(path, data); }),
      mkdirSync: vi.fn(),
      rmSync: vi.fn(),
      promptUser: vi.fn(),
      binaryPath: "/opt/npm/bin/lcm",
      commandsSourceDir: "/nonexistent/lcm-commands",
    };

    await expect(install(deps)).resolves.toBeUndefined();
    expect(bootstrapMock.ensureCore).toHaveBeenCalled();
    expect(daemonMock.ensureDaemon).toHaveBeenCalledWith({
      port: 0,
      pidFilePath: "/tmp/lcm-test.pid",
      spawnTimeoutMs: 1,
    });
    expect(doctorMock.runDoctor).toHaveBeenCalledOnce();
    expect(doctorMock.printResults).toHaveBeenCalledWith([]);
  });
});
