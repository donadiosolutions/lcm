import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUPERVISOR_DAEMON_TEMP_CREATION_WARNING } from "../../src/daemon/supervisor.js";

const state = vi.hoisted(() => ({
  exit: vi.fn((code?: string | number | null): never => {
    throw new Error(`exit:${code ?? 0}`);
  }),
  ensureDaemon: vi.fn(),
  restartDaemon: vi.fn(),
  migrateLegacyHome: vi.fn(),
  loadConfig: vi.fn(() => ({
    daemon: { port: 3737 },
    storage: { backend: "sqlite" },
  })),
}));

const fakeStdin = vi.hoisted(() => ({
  isTTY: true,
  destroy: vi.fn(),
  on: vi.fn(),
}));

vi.mock("node:process", async importOriginal => ({
  ...(await importOriginal<typeof import("node:process")>()),
  exit: state.exit,
  stdin: fakeStdin,
}));

vi.mock("node:fs", async importOriginal => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: vi.fn((path: unknown) => {
    if (String(path).endsWith("package.json")) return JSON.stringify({ version: "1.4.2" });
    throw new Error(`unexpected file read: ${String(path)}`);
  }),
}));

vi.mock("../../src/runtime-paths.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/runtime-paths.js")>()),
  configPath: () => "/lcm/.lcm/config.json",
  daemonPidPath: () => "/lcm/daemon.pid",
  daemonTokenPath: () => "/lcm/daemon.token",
  lcmHomeDir: () => "/lcm",
  migrateLegacyHomeIfNeeded: state.migrateLegacyHome,
  projectsDir: () => "/lcm/projects",
}));

vi.mock("../../src/daemon/config.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/daemon/config.js")>()),
  loadDaemonConfig: state.loadConfig,
}));

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: state.ensureDaemon,
  restartDaemon: state.restartDaemon,
}));

vi.mock("../../src/storage/backend.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/storage/backend.js")>()),
  selectStorageBackendForConfig: vi.fn(),
}));

const { runCli } = await import("../../bin/lcm.js");

async function invoke(args: string[]): Promise<Error | undefined> {
  try {
    await runCli(["node", "lcm", ...args]);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.loadConfig.mockReturnValue({
    daemon: { port: 3737 },
    storage: { backend: "sqlite" },
  });
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("Bug 1018 managed daemon refusal warnings", () => {
  it.each([
    ["start", state.ensureDaemon],
    ["restart", state.restartDaemon],
  ] as const)("retains the canonical warning after failed daemon %s", async (action, lifecycle) => {
    lifecycle.mockResolvedValueOnce({
      connected: false,
      spawned: false,
      restarted: false,
      restartedForParent: false,
      refusalReason: "startup-failure",
      warning: SUPERVISOR_DAEMON_TEMP_CREATION_WARNING,
    });
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const successOutput = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await invoke(["daemon", action]);

    expect(result?.message).toBe("exit:1");
    expect(errorOutput).toHaveBeenCalledExactlyOnceWith(
      `  lcm daemon unavailable (startup-failure); run 'lcm daemon restart' or 'lcm doctor'. ${SUPERVISOR_DAEMON_TEMP_CREATION_WARNING}`,
    );
    expect(successOutput).not.toHaveBeenCalled();
  });

  it("uses the start fallback while retaining the canonical warning when the reason is missing", async () => {
    state.ensureDaemon.mockResolvedValueOnce({
      connected: false,
      spawned: false,
      restartedForParent: false,
      warning: SUPERVISOR_DAEMON_TEMP_CREATION_WARNING,
    });
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const successOutput = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await invoke(["daemon", "start"]);

    expect(result?.message).toBe("exit:1");
    expect(errorOutput).toHaveBeenCalledExactlyOnceWith(
      `  lcm daemon unavailable (not-running); run 'lcm daemon start'. ${SUPERVISOR_DAEMON_TEMP_CREATION_WARNING}`,
    );
    expect(successOutput).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["arbitrary", "untrusted diagnostic"],
    ["prefixed", `prefix: ${SUPERVISOR_DAEMON_TEMP_CREATION_WARNING}`],
    ["suffixed", `${SUPERVISOR_DAEMON_TEMP_CREATION_WARNING}; suffix`],
    ["control-bearing", `${SUPERVISOR_DAEMON_TEMP_CREATION_WARNING}\nforged output`],
    ["oversized", "x".repeat(64 * 1024)],
    ["number", 7],
    ["array", [SUPERVISOR_DAEMON_TEMP_CREATION_WARNING]],
  ] as const)("rejects a %s lifecycle warning", async (_label, warning) => {
    state.ensureDaemon.mockResolvedValueOnce({
      connected: false,
      spawned: false,
      restartedForParent: false,
      refusalReason: "startup-failure",
      warning,
    });
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await invoke(["daemon", "start"]);

    expect(result?.message).toBe("exit:1");
    expect(errorOutput).toHaveBeenCalledExactlyOnceWith(
      "  lcm daemon unavailable (startup-failure); run 'lcm daemon restart' or 'lcm doctor'.",
    );
  });

  it("does not coerce an object warning while deciding whether it is trusted", async () => {
    const toString = vi.fn(() => SUPERVISOR_DAEMON_TEMP_CREATION_WARNING);
    state.ensureDaemon.mockResolvedValueOnce({
      connected: false,
      spawned: false,
      restartedForParent: false,
      refusalReason: "startup-failure",
      warning: { toString },
    });
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await invoke(["daemon", "start"]);

    expect(result?.message).toBe("exit:1");
    expect(errorOutput).toHaveBeenCalledExactlyOnceWith(
      "  lcm daemon unavailable (startup-failure); run 'lcm daemon restart' or 'lcm doctor'.",
    );
    expect(toString).not.toHaveBeenCalled();
  });

  it.each([
    ["start", state.ensureDaemon],
    ["restart", state.restartDaemon],
  ] as const)("preserves generic output when daemon %s throws", async (action, lifecycle) => {
    lifecycle.mockRejectedValueOnce(new Error("private lifecycle failure"));
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const successOutput = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await invoke(["daemon", action]);

    expect(result?.message).toBe("exit:1");
    expect(errorOutput).toHaveBeenCalledExactlyOnceWith(
      "  lcm daemon unavailable (ambiguous); run 'lcm daemon restart' or 'lcm doctor'.",
    );
    expect(successOutput).not.toHaveBeenCalled();
  });

  it.each([
    [
      "canonical",
      SUPERVISOR_DAEMON_TEMP_CREATION_WARNING,
      `  lcm daemon unavailable (startup-failure); run 'lcm daemon restart' or 'lcm doctor'. ${SUPERVISOR_DAEMON_TEMP_CREATION_WARNING}`,
    ],
    [
      "untrusted",
      "private client diagnostic",
      "  lcm daemon unavailable (startup-failure); run 'lcm daemon restart' or 'lcm doctor'.",
    ],
  ] as const)("applies the same %s warning boundary to a search client refusal", async (_label, warning, expected) => {
    state.ensureDaemon.mockResolvedValueOnce({
      connected: false,
      spawned: false,
      refusalReason: "startup-failure",
      warning,
    });
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const successOutput = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await invoke(["search", "query"]);

    expect(result?.message).toBe("exit:1");
    expect(errorOutput).toHaveBeenCalledExactlyOnceWith(expected);
    expect(successOutput).not.toHaveBeenCalled();
  });
});
