import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({ realpathSync: vi.fn(), readFileSync: vi.fn() }));
vi.mock("node:fs", async importOriginal => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  realpathSync: fsMocks.realpathSync,
  readFileSync: fsMocks.readFileSync,
}));

import { resolveDaemonConfigEnv } from "../../src/daemon/config.js";

const originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid");
const credentialDir = "/run/user/1000/credentials/current";

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });
  fsMocks.realpathSync.mockImplementation((path: string) => path);
  fsMocks.readFileSync.mockImplementation((path: string) => {
    if (path.endsWith("LCM_SUMMARY_API_KEY")) return "summary-key\n";
    throw new Error(`missing credential: ${path}`);
  });
});

afterEach(() => {
  if (originalGetuid) Object.defineProperty(process, "getuid", originalGetuid);
  else Reflect.deleteProperty(process, "getuid");
  vi.restoreAllMocks();
});

describe("portable systemd credential configuration", () => {
  it("loads trusted credentials while skipping missing and escaped files", () => {
    fsMocks.realpathSync.mockImplementation((path: string) => {
      if (path.endsWith("ANTHROPIC_API_KEY")) throw new Error("missing");
      if (path.endsWith("OPENAI_API_KEY")) return "/run/user/1000/credentials/sibling/OPENAI_API_KEY";
      return path;
    });

    const resolved = resolveDaemonConfigEnv({
      CREDENTIALS_DIRECTORY: credentialDir,
      LCM_SYSTEMD_CRED_IDS: "BAD, ANTHROPIC_API_KEY, LCM_SUMMARY_API_KEY, OPENAI_API_KEY",
    });

    expect(resolved.LCM_SUMMARY_API_KEY).toBe("summary-key");
    expect(resolved.ANTHROPIC_API_KEY).toBeUndefined();
    expect(resolved.OPENAI_API_KEY).toBeUndefined();
  });

  it("handles missing IDs and credential read failures", () => {
    expect(resolveDaemonConfigEnv({ CREDENTIALS_DIRECTORY: credentialDir })).toEqual({
      CREDENTIALS_DIRECTORY: credentialDir,
    });

    fsMocks.readFileSync.mockImplementation(() => { throw new Error("read failed"); });
    expect(resolveDaemonConfigEnv({
      CREDENTIALS_DIRECTORY: credentialDir,
      LCM_SYSTEMD_CRED_IDS: "LCM_SUMMARY_API_KEY",
    })).toEqual({
      CREDENTIALS_DIRECTORY: credentialDir,
      LCM_SYSTEMD_CRED_IDS: "LCM_SUMMARY_API_KEY",
    });
  });

  it("rejects an allowed credential whose canonical file leaves every trusted prefix", () => {
    fsMocks.realpathSync.mockImplementation((path: string) =>
      path.endsWith("OPENAI_API_KEY") ? "/portable/secrets/OPENAI_API_KEY" : path,
    );

    expect(resolveDaemonConfigEnv({
      CREDENTIALS_DIRECTORY: credentialDir,
      LCM_SYSTEMD_CRED_IDS: "OPENAI_API_KEY",
    })).toEqual({
      CREDENTIALS_DIRECTORY: credentialDir,
      LCM_SYSTEMD_CRED_IDS: "OPENAI_API_KEY",
    });
    expect(fsMocks.readFileSync).not.toHaveBeenCalled();
  });

  it("rejects relative, missing, and existing untrusted directories", () => {
    expect(resolveDaemonConfigEnv({ CREDENTIALS_DIRECTORY: "relative" })).toEqual({ CREDENTIALS_DIRECTORY: "relative" });

    fsMocks.realpathSync.mockImplementationOnce(() => { throw new Error("missing"); });
    expect(resolveDaemonConfigEnv({ CREDENTIALS_DIRECTORY: "/missing" })).toEqual({ CREDENTIALS_DIRECTORY: "/missing" });

    expect(resolveDaemonConfigEnv({ CREDENTIALS_DIRECTORY: "/portable/tmp" })).toEqual({ CREDENTIALS_DIRECTORY: "/portable/tmp" });
  });

  it("supports the system credential prefix when process.getuid is unavailable", () => {
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    const systemDir = "/run/credentials/lcm.service";
    expect(resolveDaemonConfigEnv({ CREDENTIALS_DIRECTORY: systemDir })).toEqual({ CREDENTIALS_DIRECTORY: systemDir });
  });
});
