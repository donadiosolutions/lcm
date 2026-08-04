import { execFileSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, type TestContext } from "vitest";
import { resolveDaemonConfigEnv } from "../../src/daemon/config.js";

function trustedCredentialBaseDir(): string | undefined {
  if (typeof process.getuid !== "function") return undefined;
  const baseDir = `/run/user/${process.getuid()}/credentials`;
  try {
    if (!existsSync(baseDir)) return undefined;
    const probe = mkdtempSync(join(baseDir, "lcm-loader-probe-"));
    rmSync(probe, { recursive: true, force: true });
    return baseDir;
  } catch {
    return undefined;
  }
}

function makeCredentialDir(context: TestContext): string | undefined {
  const baseDir = trustedCredentialBaseDir();
  if (baseDir === undefined) {
    context.skip();
    return undefined;
  }
  return mkdtempSync(join(baseDir, "lcm-loader-credentials-"));
}

function sealCredentialDir(directory: string, mode = 0o500): void {
  chmodSync(directory, mode);
}

function removeCredentialDir(directory: string): void {
  chmodSync(directory, 0o700);
  rmSync(directory, { recursive: true, force: true });
}

function credentialEnv(directory: string, ids: string): Record<string, string> {
  return {
    CREDENTIALS_DIRECTORY: directory,
    LCM_SYSTEMD_CRED_IDS: ids,
  };
}

const NONRUNNING_USER_MANAGER_STATES = new Set([
  "initializing",
  "offline",
  "starting",
  "stopped",
  "stopping",
  "unknown",
]);

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  return Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

/** Skip only when an explicit preflight proves this host cannot run the probe. */
function requireRunningUserManager(context: TestContext): boolean {
  if (process.platform !== "linux") {
    context.skip("live systemd credential probe requires Linux");
    return false;
  }
  if (typeof process.getuid !== "function") {
    context.skip("live systemd credential probe requires a POSIX UID");
    return false;
  }

  let output: string;
  try {
    output = execFileSync("systemctl", ["--user", "is-system-running"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      context.skip("systemd user manager is unsupported: systemctl is unavailable");
      return false;
    }
    const details = `${outputText((error as { stdout?: unknown }).stdout)}\n${outputText((error as { stderr?: unknown }).stderr)}`;
    const state = details.trim().split(/\s+/u)[0] ?? "";
    if (NONRUNNING_USER_MANAGER_STATES.has(state)
      || /Failed to connect to bus:\s+(?:No medium found|No such file or directory)/iu.test(details)) {
      context.skip(`systemd user manager is not running (${state || "unavailable"})`);
      return false;
    }
    throw error;
  }

  const state = output.trim().split(/\s+/u)[0] ?? "";
  if (state === "running" || state === "degraded") return true;
  if (NONRUNNING_USER_MANAGER_STATES.has(state)) {
    context.skip(`systemd user manager is not running (${state})`);
    return false;
  }
  throw new Error(`unexpected systemd user manager preflight state: ${state || "empty"}`);
}

function requireTrustedCredentialBaseDir(): string {
  if (typeof process.getuid !== "function") {
    throw new Error("live systemd credential probe requires a POSIX UID");
  }
  const baseDir = `/run/user/${process.getuid()}/credentials`;
  if (!existsSync(baseDir)) {
    throw new Error(`running user manager did not expose ${baseDir}`);
  }
  const probe = mkdtempSync(join(baseDir, "lcm-loader-live-probe-"));
  rmSync(probe, { recursive: true, force: true });
  return baseDir;
}

describe("systemd credential loader hardening", () => {
  it("prefers an authenticated staged credential over residual ambient environment", (context: TestContext) => {
    const directory = makeCredentialDir(context);
    if (directory === undefined) return;
    try {
      writeFileSync(join(directory, "OPENAI_API_KEY"), "staged-value\n", { mode: 0o400 });
      sealCredentialDir(directory);
      expect(resolveDaemonConfigEnv({
        ...credentialEnv(directory, "OPENAI_API_KEY"),
        OPENAI_API_KEY: "ambient-value",
      }).OPENAI_API_KEY).toBe("staged-value");
    } finally {
      removeCredentialDir(directory);
    }
  });

  it("accepts staged credentials beneath a validated XDG runtime root and rejects a mismatched root", () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "lcm-loader-runtime-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "lcm-loader-outside-runtime-"));
    const credentialsParent = join(runtimeRoot, "credentials");
    const directory = join(credentialsParent, "custom-unit.service");
    const outsideDirectory = join(outsideRoot, "custom-unit.service");
    try {
      chmodSync(runtimeRoot, 0o700);
      mkdirSync(credentialsParent, { mode: 0o755 });
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(join(directory, "OPENAI_API_KEY"), "custom-staged\n", { mode: 0o400 });
      chmodSync(directory, 0o500);
      mkdirSync(outsideDirectory, { mode: 0o700 });
      writeFileSync(join(outsideDirectory, "OPENAI_API_KEY"), "outside-staged\n", { mode: 0o400 });
      chmodSync(outsideDirectory, 0o500);

      expect(resolveDaemonConfigEnv({
        ...credentialEnv(directory, "OPENAI_API_KEY"),
        XDG_RUNTIME_DIR: runtimeRoot,
        OPENAI_API_KEY: "ambient-value",
      }).OPENAI_API_KEY).toBe("custom-staged");
      expect(resolveDaemonConfigEnv({
        ...credentialEnv(outsideDirectory, "OPENAI_API_KEY"),
        XDG_RUNTIME_DIR: runtimeRoot,
        OPENAI_API_KEY: "ambient-value",
      }).OPENAI_API_KEY).toBe("ambient-value");
      expect(resolveDaemonConfigEnv({
        ...credentialEnv(outsideDirectory, "OPENAI_API_KEY"),
        XDG_RUNTIME_DIR: join(runtimeRoot, "missing"),
        OPENAI_API_KEY: "ambient-value",
      }).OPENAI_API_KEY).toBe("ambient-value");
      chmodSync(runtimeRoot, 0o755);
      expect(resolveDaemonConfigEnv({
        ...credentialEnv(directory, "OPENAI_API_KEY"),
        XDG_RUNTIME_DIR: runtimeRoot,
        OPENAI_API_KEY: "ambient-value",
      }).OPENAI_API_KEY).toBe("ambient-value");
      chmodSync(runtimeRoot, 0o700);
    } finally {
      if (existsSync(directory)) chmodSync(directory, 0o700);
      if (existsSync(outsideDirectory)) chmodSync(outsideDirectory, 0o700);
      rmSync(runtimeRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["unknown id", "BAD,OPENAI_API_KEY"],
    ["duplicate id", "OPENAI_API_KEY,OPENAI_API_KEY"],
    ["path traversal id", "../OPENAI_API_KEY"],
    ["empty id", "OPENAI_API_KEY,"],
  ])("fails closed for malformed %s metadata", (_label, ids, context: TestContext) => {
    const directory = makeCredentialDir(context);
    if (directory === undefined) return;
    try {
      writeFileSync(join(directory, "OPENAI_API_KEY"), "secret", { mode: 0o400 });
      sealCredentialDir(directory);
      expect(resolveDaemonConfigEnv(credentialEnv(directory, ids))).toEqual(credentialEnv(directory, ids));
    } finally {
      removeCredentialDir(directory);
    }
  });

  it("does not let malformed systemd markers replace detached direct environment", (context: TestContext) => {
    const directory = makeCredentialDir(context);
    if (directory === undefined) return;
    try {
      writeFileSync(join(directory, "OPENAI_API_KEY"), "staged-value", { mode: 0o400 });
      sealCredentialDir(directory);
      expect(resolveDaemonConfigEnv({
        ...credentialEnv(directory, "BAD"),
        OPENAI_API_KEY: "ambient-value",
      }).OPENAI_API_KEY).toBe("ambient-value");
    } finally {
      removeCredentialDir(directory);
    }
  });

  it("rejects a systemd directory that retains launchd's writable mode", (context: TestContext) => {
    const directory = makeCredentialDir(context);
    if (directory === undefined) return;
    try {
      writeFileSync(join(directory, "OPENAI_API_KEY"), "secret", { mode: 0o400 });
      sealCredentialDir(directory, 0o700);
      expect(resolveDaemonConfigEnv(credentialEnv(directory, "OPENAI_API_KEY"))).toEqual(credentialEnv(directory, "OPENAI_API_KEY"));
    } finally {
      removeCredentialDir(directory);
    }
  });

  it("rejects a symlinked systemd credential directory", (context: TestContext) => {
    const directory = makeCredentialDir(context);
    const baseDir = trustedCredentialBaseDir();
    if (directory === undefined || baseDir === undefined) return;
    const link = join(baseDir, `lcm-loader-directory-link-${randomUUID()}`);
    try {
      symlinkSync(directory, link, "dir");
      expect(resolveDaemonConfigEnv(credentialEnv(link, "OPENAI_API_KEY"))).toEqual(credentialEnv(link, "OPENAI_API_KEY"));
    } finally {
      rmSync(link, { force: true });
      removeCredentialDir(directory);
    }
  });

  it.each([
    ["symlink", (path: string, directory: string) => {
      const outside = mkdtempSync(join(tmpdir(), "lcm-loader-outside-"));
      writeFileSync(join(outside, "secret"), "outside", { mode: 0o400 });
      symlinkSync(join(outside, "secret"), path);
      return () => rmSync(outside, { recursive: true, force: true });
    }],
    ["FIFO", (path: string) => {
      execFileSync("mkfifo", [path]);
      return undefined;
    }],
    ["directory", (path: string) => {
      mkdirSync(path, { mode: 0o500 });
      return undefined;
    }],
    ["hard link", (path: string, directory: string) => {
      const source = join(directory, "source");
      writeFileSync(source, "linked", { mode: 0o400 });
      linkSync(source, path);
      return undefined;
    }],
    ["unexpected mode", (path: string) => {
      writeFileSync(path, "mode", { mode: 0o600 });
      return undefined;
    }],
  ] as const)("rejects a credential leaf that is a %s", (_label, createLeaf, context: TestContext) => {
    const directory = makeCredentialDir(context);
    if (directory === undefined) return;
    const path = join(directory, "OPENAI_API_KEY");
    let cleanupOutside: (() => void) | undefined;
    try {
      cleanupOutside = createLeaf(path, directory) ?? undefined;
      sealCredentialDir(directory);
      expect(resolveDaemonConfigEnv(credentialEnv(directory, "OPENAI_API_KEY"))).toEqual(credentialEnv(directory, "OPENAI_API_KEY"));
    } finally {
      cleanupOutside?.();
      removeCredentialDir(directory);
    }
  });

  it("rejects a credential larger than the systemd 1 MiB unit limit", (context: TestContext) => {
    const directory = makeCredentialDir(context);
    if (directory === undefined) return;
    try {
      writeFileSync(join(directory, "OPENAI_API_KEY"), Buffer.alloc(1024 * 1024 + 1, 0x78), { mode: 0o400 });
      sealCredentialDir(directory);
      expect(resolveDaemonConfigEnv(credentialEnv(directory, "OPENAI_API_KEY"))).toEqual(credentialEnv(directory, "OPENAI_API_KEY"));
    } finally {
      removeCredentialDir(directory);
    }
  });

  it("rejects a credential owned by a different UID when the test process can create one", (context: TestContext) => {
    const directory = makeCredentialDir(context);
    if (directory === undefined || typeof process.getuid !== "function") return;
    const path = join(directory, "OPENAI_API_KEY");
    try {
      writeFileSync(path, "owner", { mode: 0o400 });
      try {
        chownSync(path, process.getuid() + 1, -1);
      } catch {
        return;
      }
      sealCredentialDir(directory);
      expect(resolveDaemonConfigEnv(credentialEnv(directory, "OPENAI_API_KEY"))).toEqual(credentialEnv(directory, "OPENAI_API_KEY"));
    } finally {
      removeCredentialDir(directory);
    }
  });

  it("observes the real user-systemd LoadCredential modes without exposing its value", (context: TestContext) => {
    if (!requireRunningUserManager(context)) return;
    const baseDir = requireTrustedCredentialBaseDir();
    const source = join(baseDir, `lcm-loader-source-${randomUUID()}`);
    const unit = `lcm-loader-probe-${randomUUID().replaceAll("-", "")}`;
    try {
      writeFileSync(source, "probe-value\n", { mode: 0o400 });
      const output = execFileSync("systemd-run", [
        "--user",
        "--wait",
        "--collect",
        "--pipe",
        `--unit=${unit}`,
        "-p",
        `LoadCredential=LCM_PROBE:${source}`,
        "/bin/sh",
        "-c",
        "stat -c '%u %a %F %h %s' \"$CREDENTIALS_DIRECTORY/LCM_PROBE\"; stat -c '%u %a %F %h' \"$CREDENTIALS_DIRECTORY\"",
      ], { encoding: "utf8", timeout: 15_000 });
      const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
      expect(lines).toContain(`${process.getuid()} 400 regular file 1 12`);
      expect(lines).toContain(`${process.getuid()} 500 directory 2`);
    } finally {
      rmSync(source, { force: true });
    }
  });
});
