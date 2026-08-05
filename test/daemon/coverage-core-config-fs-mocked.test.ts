import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({ realpathSync: vi.fn(), readFileSync: vi.fn(), lstatSync: vi.fn() }));
const securityMocks = vi.hoisted(() => ({ readBoundedRegularFile: vi.fn() }));
vi.mock("node:fs", async importOriginal => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  realpathSync: fsMocks.realpathSync,
  readFileSync: fsMocks.readFileSync,
  lstatSync: fsMocks.lstatSync,
}));
vi.mock("../../src/security-files.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/security-files.js")>()),
  readBoundedRegularFile: securityMocks.readBoundedRegularFile,
}));

import { resolveDaemonConfigEnv } from "../../src/daemon/config.js";

const originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid");
const credentialDir = "/run/user/1000/credentials/current";

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });
  fsMocks.realpathSync.mockImplementation((path: string) => path);
  fsMocks.lstatSync.mockImplementation((path: string) => {
    if (path === credentialDir) {
      return {
        dev: 1,
        ino: 1,
        uid: 1000,
        mode: 0o40500,
        isSymbolicLink: () => false,
        isDirectory: () => true,
      };
    }
    return {
      dev: 2,
      ino: 2,
      uid: 1000,
      mode: 0o100400,
      isSymbolicLink: () => false,
      isDirectory: () => false,
    };
  });
  securityMocks.readBoundedRegularFile.mockImplementation((path: string) => {
    if (path.endsWith("LCM_SUMMARY_API_KEY")) return "summary-key\n";
    if (path.endsWith("LCM_POSTGRES_URL")) return "postgresql://credential\n";
    throw new Error(`missing credential: ${path}`);
  });
  fsMocks.readFileSync.mockImplementation((path: string) => {
    if (path.endsWith("LCM_SUMMARY_API_KEY")) return "summary-key\n";
    if (path.endsWith("LCM_POSTGRES_URL")) return "postgresql://credential\n";
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
      LCM_SYSTEMD_CRED_IDS: "ANTHROPIC_API_KEY, LCM_POSTGRES_URL, LCM_SUMMARY_API_KEY, OPENAI_API_KEY",
    });

    expect(resolved.LCM_SUMMARY_API_KEY).toBe("summary-key");
    expect(resolved.LCM_POSTGRES_URL).toBe("postgresql://credential");
    expect(resolved.ANTHROPIC_API_KEY).toBeUndefined();
    expect(resolved.OPENAI_API_KEY).toBeUndefined();
  });

  it("handles missing IDs and credential read failures", () => {
    expect(resolveDaemonConfigEnv({ CREDENTIALS_DIRECTORY: credentialDir })).toEqual({
      CREDENTIALS_DIRECTORY: credentialDir,
    });

    securityMocks.readBoundedRegularFile.mockImplementation(() => { throw new Error("read failed"); });
    expect(resolveDaemonConfigEnv({
      CREDENTIALS_DIRECTORY: credentialDir,
      LCM_SYSTEMD_CRED_IDS: "LCM_SUMMARY_API_KEY",
    })).toEqual({
      CREDENTIALS_DIRECTORY: credentialDir,
      LCM_SYSTEMD_CRED_IDS: "LCM_SUMMARY_API_KEY",
    });
  });

  it("fails closed for empty and non-string credential ID metadata", () => {
    expect(resolveDaemonConfigEnv({
      CREDENTIALS_DIRECTORY: credentialDir,
      LCM_SYSTEMD_CRED_IDS: "   ",
    })).toEqual({
      CREDENTIALS_DIRECTORY: credentialDir,
      LCM_SYSTEMD_CRED_IDS: "   ",
    });
    expect(resolveDaemonConfigEnv({
      CREDENTIALS_DIRECTORY: credentialDir,
      LCM_SYSTEMD_CRED_IDS: 42 as never,
    })).toEqual({
      CREDENTIALS_DIRECTORY: credentialDir,
      LCM_SYSTEMD_CRED_IDS: 42,
    });
  });

  it("fails closed when the trusted directory changes before or after a read", () => {
    fsMocks.lstatSync.mockImplementationOnce(() => ({
      dev: 1,
      ino: 1,
      uid: 1000,
      mode: 0o40500,
      isSymbolicLink: () => false,
      isDirectory: () => true,
    })).mockImplementationOnce(() => { throw new Error("directory race"); });
    expect(resolveDaemonConfigEnv({
      CREDENTIALS_DIRECTORY: credentialDir,
      LCM_SYSTEMD_CRED_IDS: "LCM_SUMMARY_API_KEY",
    })).toEqual({
      CREDENTIALS_DIRECTORY: credentialDir,
      LCM_SYSTEMD_CRED_IDS: "LCM_SUMMARY_API_KEY",
    });

    fsMocks.lstatSync.mockReset();
    fsMocks.lstatSync.mockImplementationOnce(() => ({
      dev: 1,
      ino: 1,
      uid: 1000,
      mode: 0o40500,
      isSymbolicLink: () => false,
      isDirectory: () => true,
    })).mockImplementationOnce(() => ({
      dev: 1,
      ino: 1,
      uid: 1000,
      mode: 0o40500,
      isSymbolicLink: () => false,
      isDirectory: () => true,
    })).mockImplementationOnce(() => { throw new Error("directory race"); });
    securityMocks.readBoundedRegularFile.mockReturnValue("summary-key\n");
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
    expect(securityMocks.readBoundedRegularFile).not.toHaveBeenCalled();
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
