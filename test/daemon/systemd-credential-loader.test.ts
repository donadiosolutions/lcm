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

type CredentialDirFixture = {
  directory: string;
  credentialsParent: string;
  runtimeRoot: string;
};

/** Create a systemd-shaped credential directory under a private runtime root. */
function makeCredentialDir(): CredentialDirFixture {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "lcm-loader-runtime-"));
  const credentialsParent = join(runtimeRoot, "credentials");
  const directory = join(credentialsParent, "lcm-loader-credentials");
  try {
    chmodSync(runtimeRoot, 0o700);
    mkdirSync(credentialsParent, { mode: 0o755 });
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    return { directory, credentialsParent, runtimeRoot };
  } catch (error) {
    rmSync(runtimeRoot, { recursive: true, force: true });
    throw error;
  }
}

function sealCredentialDir(directory: string, mode = 0o500): void {
  chmodSync(directory, mode);
}

function removeCredentialDir(fixture: CredentialDirFixture): void {
  chmodSync(fixture.directory, 0o700);
  rmSync(fixture.runtimeRoot, { recursive: true, force: true });
}

function credentialEnv(fixture: Pick<CredentialDirFixture, "directory" | "runtimeRoot">, ids: string): Record<string, string> {
  return {
    CREDENTIALS_DIRECTORY: fixture.directory,
    XDG_RUNTIME_DIR: fixture.runtimeRoot,
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
const LIVE_SYSTEMD_INTEGRATION_ENV = "LCM_SYSTEMD_CREDENTIAL_INTEGRATION";

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  return Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

/** Skip only when an explicit preflight proves this host cannot run the probe. */
function requireRunningUserManager(context: TestContext): boolean {
  if (process.env[LIVE_SYSTEMD_INTEGRATION_ENV] !== "1") {
    context.skip("live systemd credential probe is limited to the dedicated Linux systemd job");
    return false;
  }
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

function requireTrustedCredentialBaseDir(context: TestContext): string | undefined {
  if (typeof process.getuid !== "function") {
    context.skip("live systemd credential probe requires a POSIX UID");
    return undefined;
  }
  const baseDir = `/run/user/${process.getuid()}/credentials`;
  if (!existsSync(baseDir)) {
    context.skip(`running user manager did not expose ${baseDir}`);
    return undefined;
  }
  try {
    const probe = mkdtempSync(join(baseDir, "lcm-loader-live-probe-"));
    rmSync(probe, { recursive: true, force: true });
  } catch {
    context.skip(`live systemd credential probe cannot write ${baseDir}`);
    return undefined;
  }
  return baseDir;
}

describe("systemd credential loader hardening", () => {
  it.each([
    ["unknown id", "BAD,OPENAI_API_KEY"],
    ["duplicate id", "OPENAI_API_KEY,OPENAI_API_KEY"],
    ["path traversal id", "../OPENAI_API_KEY"],
    ["empty id", "OPENAI_API_KEY,"],
  ])("fails closed for malformed %s metadata", (_label, ids) => {
    const fixture = makeCredentialDir();
    try {
      writeFileSync(join(fixture.directory, "OPENAI_API_KEY"), "secret", { mode: 0o400 });
      sealCredentialDir(fixture.directory);
      expect(resolveDaemonConfigEnv(credentialEnv(fixture, ids))).toEqual(credentialEnv(fixture, ids));
    } finally {
      removeCredentialDir(fixture);
    }
  });

  it("rejects a systemd directory that retains launchd's writable mode", () => {
    const fixture = makeCredentialDir();
    try {
      writeFileSync(join(fixture.directory, "OPENAI_API_KEY"), "secret", { mode: 0o400 });
      sealCredentialDir(fixture.directory, 0o700);
      expect(resolveDaemonConfigEnv(credentialEnv(fixture, "OPENAI_API_KEY"))).toEqual(credentialEnv(fixture, "OPENAI_API_KEY"));
    } finally {
      removeCredentialDir(fixture);
    }
  });

  it("rejects a symlinked systemd credential directory", () => {
    const fixture = makeCredentialDir();
    const link = join(fixture.credentialsParent, `lcm-loader-directory-link-${randomUUID()}`);
    try {
      symlinkSync(fixture.directory, link, "dir");
      const environment = credentialEnv({ directory: link, runtimeRoot: fixture.runtimeRoot }, "OPENAI_API_KEY");
      expect(resolveDaemonConfigEnv(environment)).toEqual(environment);
    } finally {
      rmSync(link, { force: true });
      removeCredentialDir(fixture);
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
  ] as const)("rejects a credential leaf that is a %s", (_label, createLeaf) => {
    const fixture = makeCredentialDir();
    const directory = fixture.directory;
    const path = join(directory, "OPENAI_API_KEY");
    let cleanupOutside: (() => void) | undefined;
    try {
      cleanupOutside = createLeaf(path, directory) ?? undefined;
      sealCredentialDir(directory);
      expect(resolveDaemonConfigEnv(credentialEnv(fixture, "OPENAI_API_KEY"))).toEqual(credentialEnv(fixture, "OPENAI_API_KEY"));
    } finally {
      cleanupOutside?.();
      removeCredentialDir(fixture);
    }
  });

  it("rejects a credential larger than the systemd 1 MiB unit limit", () => {
    const fixture = makeCredentialDir();
    const directory = fixture.directory;
    try {
      writeFileSync(join(directory, "OPENAI_API_KEY"), Buffer.alloc(1024 * 1024 + 1, 0x78), { mode: 0o400 });
      sealCredentialDir(directory);
      expect(resolveDaemonConfigEnv(credentialEnv(fixture, "OPENAI_API_KEY"))).toEqual(credentialEnv(fixture, "OPENAI_API_KEY"));
    } finally {
      removeCredentialDir(fixture);
    }
  });

  it("rejects a credential owned by a different UID when the test process can create one", () => {
    const fixture = makeCredentialDir();
    const directory = fixture.directory;
    if (typeof process.getuid !== "function") {
      removeCredentialDir(fixture);
      return;
    }
    const path = join(directory, "OPENAI_API_KEY");
    try {
      writeFileSync(path, "owner", { mode: 0o400 });
      try {
        chownSync(path, process.getuid() + 1, -1);
      } catch {
        return;
      }
      sealCredentialDir(directory);
      expect(resolveDaemonConfigEnv(credentialEnv(fixture, "OPENAI_API_KEY"))).toEqual(credentialEnv(fixture, "OPENAI_API_KEY"));
    } finally {
      removeCredentialDir(fixture);
    }
  });

  it("observes the real user-systemd LoadCredential modes without exposing its value", (context: TestContext) => {
    if (!requireRunningUserManager(context)) return;
    const baseDir = requireTrustedCredentialBaseDir(context);
    if (baseDir === undefined) return;
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
