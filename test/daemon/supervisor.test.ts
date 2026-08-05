import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupManagedCredentialDirectory,
  createManagedCredentialDirectory,
  managedCredentialPath,
  validateManagedCredentialDirectory,
  writeManagedCredentialFiles,
} from "../../src/daemon/managed-credentials.js";
import { managedDaemonPathForStableLaunch } from "../../src/daemon/managed-path.js";
import {
  canonicalSupervisorScope,
  createSupervisor,
  createSupervisorSpec,
  isSupervisorPreflightUnavailableReason,
  MANAGED_LAUNCH_ENV_ALLOWLIST,
  managedLaunchEnvironment,
  managedLaunchEnvironmentDigest,
  type SupervisorKind,
  type SupervisorSpec,
} from "../../src/daemon/supervisor.js";

type SupervisorCommandResult = Readonly<{
  code?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}>;

const roots: string[] = [];
const VALID_RUNTIME_DIGEST = "a".repeat(64);
const OTHER_RUNTIME_DIGEST = "b".repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lcm-supervisor-test-"));
  roots.push(root);
  return root;
}

function makeSpec(kind: SupervisorKind, stateRoot = makeRoot(), overrides: Partial<SupervisorSpec> = {}): SupervisorSpec {
  return createSupervisorSpec({
    kind,
    stateRoot,
    port: 3737,
    nonce: "nonce-001",
    executable: "/usr/bin/node",
    args: ["/opt/lcm/dist/lcm.mjs", "daemon", "run-managed"],
    ...overrides,
  });
}

function systemdEnvironmentDigest(
  spec: SupervisorSpec,
  environmentOverride?: Readonly<Record<string, string>>,
): string {
  return managedLaunchEnvironmentDigest(
    spec,
    "systemd-user",
    typeof process.getuid === "function" ? process.getuid() : -1,
    environmentOverride ?? spec.launchEnvironment ?? managedLaunchEnvironment(process.env),
  );
}

function launchdEnvironmentDigest(
  spec: SupervisorSpec,
  environmentOverride?: Readonly<Record<string, string>>,
): string {
  return managedLaunchEnvironmentDigest(
    spec,
    "launchd-user",
    -1,
    environmentOverride ?? spec.launchEnvironment ?? managedLaunchEnvironment(process.env),
  );
}

function managerText(
  spec: SupervisorSpec,
  state = "active",
  pid = 1234,
  subState = state === "active" ? "running" : state,
  environmentOverride?: Readonly<Record<string, string>>,
): string {
  const environmentDigest = systemdEnvironmentDigest(spec, environmentOverride);
  const credentialMetadata = spec.credentialDirectory === undefined
    ? ""
    : ` LCM_CREDENTIAL_DIRECTORY=${spec.credentialDirectory}${(spec.credentialFiles ?? []).map(({ name, path }) => ` LCM_CREDENTIAL_${name}_FILE=${path}`).join("")}`;
  return [
    "LoadState=loaded",
    `ActiveState=${state}`,
    `SubState=${subState}`,
    `MainPID=${state === "active" ? pid : 0}`,
    `Environment=LCM_SUPERVISOR_MARKER=${spec.marker} LCM_SUPERVISOR_SCOPE=${spec.scopeDigest} LCM_SUPERVISOR_STATE_ROOT=${spec.stateRoot} LCM_SUPERVISOR_PORT=${spec.port} LCM_SUPERVISOR_NONCE=${spec.nonce} LCM_SUPERVISOR_EXECUTABLE=${spec.executable} LCM_SUPERVISOR_ARGS=${JSON.stringify(spec.args)} LCM_SUPERVISOR_CWD=${spec.cwd ?? ""}${spec.entrypoint === undefined ? "" : ` LCM_SUPERVISOR_ENTRYPOINT=${spec.entrypoint}`}${spec.runtimeDigest === undefined ? "" : ` LCM_SUPERVISOR_RUNTIME_DIGEST=${spec.runtimeDigest}`}${spec.storageBackend === undefined ? "" : ` LCM_SUPERVISOR_STORAGE_BACKEND=${spec.storageBackend}`}${spec.postgresCaFile === undefined ? "" : ` LCM_POSTGRES_CA_FILE=${spec.postgresCaFile}`}${spec.kind === "systemd-user" ? ` LCM_SUPERVISOR_ENV_DIGEST=${environmentDigest}` : ""}${credentialMetadata}`,
  ].join("\n");
}

/**
 * Real-shaped `launchctl print` output: identity and credential metadata are
 * flat top-level `KEY => VALUE` entries, not nested inside the environment
 * dictionary.  The supervisor's parser authenticates this projection.
 */
function launchdPrintText(
  value: SupervisorSpec,
  state = "running",
  pid = 543,
  environmentOverride?: Readonly<Record<string, string>>,
): string {
  const environmentDigest = launchdEnvironmentDigest(value, environmentOverride);
  const lines = [
    `state = ${state}`,
    `pid = ${state === "running" ? pid : 0}`,
    `LCM_SUPERVISOR_MARKER => ${value.marker}`,
    `LCM_SUPERVISOR_SCOPE => ${value.scopeDigest}`,
    `LCM_SUPERVISOR_STATE_ROOT => ${value.stateRoot}`,
    `LCM_SUPERVISOR_PORT => ${value.port}`,
    `LCM_SUPERVISOR_NONCE => ${value.nonce}`,
    `LCM_SUPERVISOR_EXECUTABLE => ${value.executable}`,
    `LCM_SUPERVISOR_ARGS => ${JSON.stringify(value.args)}`,
    `LCM_SUPERVISOR_CWD => ${value.cwd ?? ""}`,
    `LCM_SUPERVISOR_ENV_DIGEST => ${environmentDigest}`,
  ];
  if (value.entrypoint !== undefined) lines.push(`LCM_SUPERVISOR_ENTRYPOINT => ${value.entrypoint}`);
  if (value.runtimeDigest !== undefined) lines.push(`LCM_SUPERVISOR_RUNTIME_DIGEST => ${value.runtimeDigest}`);
  if (value.storageBackend !== undefined) lines.push(`LCM_SUPERVISOR_STORAGE_BACKEND => ${value.storageBackend}`);
  if (value.postgresCaFile !== undefined) lines.push(`LCM_POSTGRES_CA_FILE => ${value.postgresCaFile}`);
  if (value.credentialDirectory !== undefined) {
    lines.push(`LCM_CREDENTIAL_DIRECTORY => ${value.credentialDirectory}`);
    if ((value.credentialFiles ?? []).length > 0) {
      lines.push(`LCM_SYSTEMD_CRED_IDS => ${(value.credentialFiles ?? []).map(({ name }) => name).join(",")}`);
      for (const credential of value.credentialFiles ?? []) {
        lines.push(`LCM_CREDENTIAL_${credential.name}_FILE => ${credential.path}`);
      }
    }
  }
  return lines.join("\n");
}

function fakeRunner(results: Array<SupervisorCommandResult>): {
  readonly run: ReturnType<typeof vi.fn>;
  readonly calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }>;
} {
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = [];
  const run = vi.fn(async (command: string, args: readonly string[], options: { timeoutMs: number }) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    return results.shift() ?? { code: 0, stdout: "", stderr: "" };
  });
  return { run, calls };
}

describe("canonical supervisor identity", () => {
  it("projects only bounded non-secret launch values", () => {
    expect(MANAGED_LAUNCH_ENV_ALLOWLIST).toContain("HOME");
    const runtimeRoot = makeRoot();
    const linkRoot = makeRoot();
    const runtimeLink = join(linkRoot, "runtime");
    symlinkSync(runtimeRoot, runtimeLink, "dir");
    const environment = managedLaunchEnvironment({
      CODEX_HOME: runtimeRoot,
      CLAUDE_CONFIG_DIR: runtimeLink,
      HOME: "/home/test",
      PATH: "/usr/bin",
      XDG_RUNTIME_DIR: runtimeLink,
      DBUS_SESSION_BUS_ADDRESS: "http://unsafe",
      OPENAI_API_KEY: "ambient-secret",
      FIRECRAWL_API_KEY: "ambient-secret",
      DOCKERHUB_TOKEN: "ambient-secret",
      LCM_POSTGRES_URL: "postgresql://user:secret@example/db",
      BAD_NEWLINE: "bad\nvalue",
      BAD_NUL: "bad\u0000value",
      TOO_LARGE: "x".repeat(4097),
    });
    expect(environment).toEqual({ CODEX_HOME: runtimeRoot, HOME: "/home/test", PATH: "/usr/bin" });
    expect(managedLaunchEnvironment({
      CLAUDE_CONFIG_DIR: runtimeRoot,
      HOME: "/home/test",
      PATH: "/usr/bin",
      XDG_RUNTIME_DIR: runtimeRoot,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    })).toEqual({
      CLAUDE_CONFIG_DIR: runtimeRoot,
      HOME: "/home/test",
      PATH: "/usr/bin",
      XDG_RUNTIME_DIR: runtimeRoot,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
    const wrongMode = makeRoot();
    chmodSync(wrongMode, 0o755);
    expect(managedLaunchEnvironment({ CODEX_HOME: wrongMode })).toEqual({});
    const regularFile = join(makeRoot(), "config");
    writeFileSync(regularFile, "not-a-directory");
    expect(managedLaunchEnvironment({ CLAUDE_CONFIG_DIR: regularFile })).toEqual({});
    expect(managedLaunchEnvironment({ CODEX_HOME: join(makeRoot(), "missing") })).toEqual({});
    expect(managedLaunchEnvironment({ CODEX_HOME: "relative" })).toEqual({});
  });

  it("uses the private directory owner when process.getuid is unavailable", () => {
    const root = makeRoot();
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, enumerable: true, value: undefined, writable: true });
    try {
      expect(managedLaunchEnvironment({ CODEX_HOME: root })).toEqual({ CODEX_HOME: root });
    } finally {
      if (descriptor !== undefined) Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("allows detached compatibility only for read-only manager absence reasons", () => {
    const reasons = ["manager-unavailable", "manager-timeout", "manager-command-failed",
      "manager-not-found", "metadata-missing", "metadata-mismatch", "foreign-job",
      "pid-missing", "pid-invalid", "state-conflict", "credential-invalid",
      "cleanup-failed", "unsupported-platform"
    ] as const;
    expect(reasons.map(isSupervisorPreflightUnavailableReason)).toEqual([true, false, false,
      true, false, false, false, false, false, false, false, false, false
    ]);
  });

  it("uses only the canonical state root for full and shortened identities", () => {
    const root = makeRoot();
    const scope = canonicalSupervisorScope(root);
    expect(scope.stateRoot).toBe(root);
    expect(scope.scopeDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(scope.shortDigest).toBe(scope.scopeDigest.slice(0, 20));
    expect(scope.systemdUnit).toBe(`lcm-daemon-${scope.shortDigest}.service`);
    expect(scope.launchdLabel).toBe(`com.donadiosolutions.lcm.daemon.${scope.shortDigest}`);
    expect(canonicalSupervisorScope(root, () => `${root}/`)).toEqual(scope);
    expect(() => canonicalSupervisorScope("relative")).toThrow("absolute");
    expect(() => canonicalSupervisorScope(root, () => "relative")).toThrow("canonical");
    expect(() => canonicalSupervisorScope(join(root, "missing"))).toThrow("unavailable");
  });

  it("does not derive identity from a mutable port and validates specifications", () => {
    const root = makeRoot();
    const first = makeSpec("systemd-user", root, { port: 3737 });
    const second = makeSpec("systemd-user", root, { port: 4747 });
    expect(first.systemdUnit).toBe(second.systemdUnit);
    expect(first.scopeDigest).toBe(second.scopeDigest);
    expect(first.marker).toBe("lcm-supervisor-v1");
    expect(first.name).toBe(first.systemdUnit);
    expect(makeSpec("launchd-user", root).name).toBe(makeSpec("launchd-user", root).launchdLabel);
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: -1, executable: "/bin/node" })).toThrow("port");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, nonce: "bad nonce", executable: "/bin/node" })).toThrow("nonce");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, executable: "node" })).toThrow("absolute");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, executable: "/bin/node", cwd: "relative" })).toThrow("working");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, executable: "/bin/node", args: ["bad\narg"] })).toThrow("argument");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, executable: "/bin/node", stopTimeoutMs: 0 })).toThrow("timeout");
    expect(() => createSupervisorSpec({ kind: "bogus" as SupervisorKind, stateRoot: root, port: 1, executable: "/bin/node" })).toThrow("kind");
    expect(createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, command: "/bin/node", argv: ["daemon"], cwd: "/tmp", entrypoint: "entry", runtimeDigest: VALID_RUNTIME_DIGEST, storageBackend: "sqlite" })).toMatchObject({ executable: "/bin/node", args: ["daemon"], cwd: "/tmp", runtimeDigest: VALID_RUNTIME_DIGEST });
    expect(createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, executable: "/bin/node" }).runtimeDigest).toBeUndefined();
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, executable: "/bin/node", runtimeDigest: "a".repeat(63) })).toThrow("runtime digest");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, executable: "/bin/node", runtimeDigest: "a".repeat(65) })).toThrow("runtime digest");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, executable: "/bin/node", runtimeDigest: "A".repeat(64) })).toThrow("runtime digest");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, executable: "/bin/node", runtimeDigest: "g".repeat(64) })).toThrow("runtime digest");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, executable: "/bin/node", entrypoint: "" })).toThrow("metadata");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, executable: "/bin/node", runtimeDigest: "line\nfeed" })).toThrow("runtime digest");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, executable: "/bin/node", credentialFiles: [{ name: "bad\nname", path: "/tmp/credential" }] })).toThrow("credential");
  });

  it("generates bounded cryptographic launch nonces when none is supplied", () => {
    const root = makeRoot();
    const first = createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 3737, executable: "/bin/node" });
    const second = createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 3737, executable: "/bin/node" });
    expect(first.nonce).toMatch(/^[a-f0-9]{32}$/u);
    expect(second.nonce).toMatch(/^[a-f0-9]{32}$/u);
    expect(second.nonce).not.toBe(first.nonce);
    expect(first.systemdUnit).toBe(second.systemdUnit);
  });
});

describe("managed one-launch credentials", () => {
  it("creates, validates, writes, and idempotently cleans private credential files", () => {
    const root = makeRoot();
    const directory = createManagedCredentialDirectory(root, "launch-001");
    expect(validateManagedCredentialDirectory(directory, root)).toBe(directory);
    const files = writeManagedCredentialFiles(directory, {
      OPENAI_API_KEY: "secret-value",
      LCM_SUMMARY_API_KEY: "summary-value",
    });
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    expect(() => validateManagedCredentialDirectory(directory, root, uid + 1)).toThrow("owned");
    expect(files).toHaveLength(2);
    expect(readFileSync(managedCredentialPath(directory, "OPENAI_API_KEY"), "utf8")).toBe("secret-value");
    expect(() => managedCredentialPath(directory, "NOT_ALLOWED")).toThrow("unsupported");
    expect(validateManagedCredentialDirectory(directory, root)).toBe(directory);
    cleanupManagedCredentialDirectory(directory, root);
    cleanupManagedCredentialDirectory(directory, root);
    expect(readdirSync(join(root, "credentials"))).toHaveLength(0);
  });

  it("never deletes a concurrent pre-registration nonce directory at start time", async () => {
    const root = makeRoot();
    // Lifecycle-shaped directories from earlier or in-flight launches.  A
    // concurrent winner may have already created its nonce directory without
    // having registered the manager unit yet; deleting it here would surrender
    // live secret material, so start must preserve every pre-existing child.
    const stale = createManagedCredentialDirectory(root, "old-launch-abcdef0123456789");
    writeManagedCredentialFiles(stale, { OPENAI_API_KEY: "stale" });
    const concurrent = createManagedCredentialDirectory(root, "concurrent-0123456789abcdef");
    writeManagedCredentialFiles(concurrent, { OPENAI_API_KEY: "current" });
    const unrelated = createManagedCredentialDirectory(root, "manual-directory");
    writeManagedCredentialFiles(unrelated, { OPENAI_API_KEY: "manual" });

    const directory = createManagedCredentialDirectory(root, "launch-no-scavenge");
    const file = writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "secret" })[0]!;
    const spec = makeSpec("systemd-user", root, {
      nonce: "no-scavenge-nonce",
      credentialDirectory: directory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: file }],
    });
    const runner = fakeRunner([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: managerText(spec, "active", 446) },
      { code: 1, stderr: "Unit is not-found" },
    ]);
    const supervisor = createSupervisor("systemd-user", { run: runner.run, platform: "linux" });
    await expect(supervisor.start(spec)).resolves.toMatchObject({ managerPid: 446 });
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(concurrent)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(directory)).toBe(true);

    await expect(supervisor.stopAndAwaitAbsent(spec)).resolves.toBeUndefined();
    expect(existsSync(directory)).toBe(false);
    // Explicit cleanup proves absence for the exact nonce first; the other
    // pre-existing directories remain private evidence for their owners.
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(concurrent)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    cleanupManagedCredentialDirectory(stale, root);
    cleanupManagedCredentialDirectory(concurrent, root);
    cleanupManagedCredentialDirectory(unrelated, root);
  });

  it("rejects tampered modes, symlinks, hard links, names, and containment escapes", () => {
    const root = makeRoot();
    const directory = createManagedCredentialDirectory(root, "launch-002");
    writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "value" });
    const file = managedCredentialPath(directory, "OPENAI_API_KEY");
    chmodSync(file, 0o644);
    expect(() => validateManagedCredentialDirectory(directory, root)).toThrow("validation");
    chmodSync(file, 0o600);
    rmSync(file);
    symlinkSync(join(root, "outside"), file);
    expect(() => validateManagedCredentialDirectory(directory, root)).toThrow("unavailable");
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    rmSync(file);
    writeFileSync(join(directory, "unknown"), "x", { mode: 0o600 });
    expect(() => validateManagedCredentialDirectory(directory, root)).toThrow("unsupported");
    rmSync(join(directory, "unknown"));
    writeFileSync(file, "x".repeat(1024 * 1024 + 1), { mode: 0o600 });
    chmodSync(file, 0o600);
    expect(() => validateManagedCredentialDirectory(directory, root)).toThrow("validation");
    rmSync(file);
    expect(() => createManagedCredentialDirectory(root, "bad nonce")).toThrow("nonce");
    expect(() => validateManagedCredentialDirectory(join(root, "missing"), root)).toThrow("unavailable");
    expect(() => cleanupManagedCredentialDirectory(join(root, "missing"), root)).not.toThrow();
    expect(() => validateManagedCredentialDirectory(root, root)).toThrow("escapes");
    expect(() => cleanupManagedCredentialDirectory(root, root)).toThrow("escapes");
  });

  it("covers ownership, creation, write, and cleanup failure fences without exposing values", () => {
    const root = makeRoot();
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    expect(() => createManagedCredentialDirectory("relative", "n", uid)).toThrow("absolute");
    chmodSync(root, 0o755);
    expect(() => createManagedCredentialDirectory(root, "n", uid)).toThrow("private");
    chmodSync(root, 0o700);
    expect(() => createManagedCredentialDirectory(root, "n", uid + 1)).toThrow("uid");
    chmodSync(join(root, "credentials"), 0o755);
    const directory = createManagedCredentialDirectory(root, "n", uid);
    expect(statSync(join(root, "credentials")).mode & 0o777).toBe(0o700);
    expect(() => writeManagedCredentialFiles(directory, { OPENAI_API_KEY: 1 as unknown as string })).toThrow("value");
    expect(() => writeManagedCredentialFiles(directory, {
      ANTHROPIC_API_KEY: "a",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      OPENAI_API_KEY: "b",
      LCM_SUMMARY_API_KEY: "c",
      LCM_POSTGRES_URL: "d",
      EXTRA: "e",
    })).toThrow("large");
    expect(() => writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "x".repeat(1024 * 1024 + 1) })).toThrow("large");
    writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "value" });
    expect(() => writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "again" })).toThrow("created");

    cleanupManagedCredentialDirectory(directory);
    expect(() => validateManagedCredentialDirectory(directory)).toThrow("unavailable");
    expect(() => cleanupManagedCredentialDirectory("\0")).toThrow("absolute");
  });

  it("uses fail-closed ownership defaults when the host does not expose getuid", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, enumerable: true, value: undefined, writable: true });
    try {
      const root = makeRoot();
      const directory = createManagedCredentialDirectory(root, "no-uid");
      expect(validateManagedCredentialDirectory(directory, root)).toBe(directory);
    } finally {
      if (descriptor !== undefined) Object.defineProperty(process, "getuid", descriptor);
    }
  });
});

describe("systemd-user supervisor", () => {
  it("admits the same stable launch identity from distinct caller directories", async () => {
    const root = makeRoot();
    const spawnCommand = "/usr/bin/node";
    const spawnArgs = [
      "/home/alice/.local/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
      "daemon",
      "start",
      "--foreground",
    ];
    const callerDirectories = ["/home/alice", "/work/project"];
    const environments = callerDirectories.map(() => ({
      HOME: "/home/alice",
      PATH: managedDaemonPathForStableLaunch(spawnCommand, spawnArgs, root, "/home/alice"),
    }));
    const specs = environments.map((launchEnvironment, index) => createSupervisorSpec({
      kind: "systemd-user",
      stateRoot: root,
      port: 3737,
      nonce: `stable-${index}`,
      executable: spawnCommand,
      args: spawnArgs,
      launchEnvironment,
    }));
    expect(managedLaunchEnvironmentDigest(specs[0]!, "systemd-user", process.getuid?.() ?? -1, environments[0]!))
      .toBe(managedLaunchEnvironmentDigest(specs[1]!, "systemd-user", process.getuid?.() ?? -1, environments[1]!));
    for (const [index, spec] of specs.entries()) {
      const environment = environments[index]!;
      const runner = fakeRunner([{ code: 0, stdout: managerText(spec, "active", 4321, "running", environment) }]);
      await expect(createSupervisor("systemd-user", {
        run: runner.run,
        environment,
        platform: "linux",
      }).probe(spec)).resolves.toMatchObject({ kind: "registered-running-valid", managerPid: 4321 });
    }
  });

  it("rejects clean-environment drift before admitting a registered unit", async () => {
    const root = makeRoot();
    const original = makeSpec("systemd-user", root, { launchEnvironment: { PATH: "/usr/bin" } });
    const drifted = createSupervisorSpec({
      kind: "systemd-user",
      stateRoot: root,
      port: original.port,
      nonce: original.nonce,
      executable: original.executable,
      args: original.args,
      launchEnvironment: { PATH: "/opt/bin" },
    });
    const runner = fakeRunner([{ code: 0, stdout: managerText(original, "active", 4321) }]);
    const supervisor = createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
      environment: original.launchEnvironment,
    });
    await expect(supervisor.probe(drifted)).resolves.toMatchObject({
      kind: "registered-stale-config",
      reason: "metadata-mismatch",
    });
    expect(runner.calls).toHaveLength(1);
  });

  it("probes unavailable, absent, valid running, terminal, stale, collision, and ambiguous states", async () => {
    const spec = makeSpec("systemd-user");
    const responses: SupervisorCommandResult[] = [
      { code: 127, stderr: "systemctl not found" },
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: managerText(spec, "active", 111) },
      { code: 0, stdout: managerText(spec, "inactive") },
      { code: 0, stdout: managerText({ ...spec, port: 9 }, "inactive") },
      { code: 0, stdout: "LoadState=loaded\nActiveState=active\nMainPID=222\nEnvironment=LCM_SUPERVISOR_MARKER=other" },
      { code: 0, stdout: "LoadState=loaded\nActiveState=active\nEnvironment=LCM_SUPERVISOR_MARKER=lcm-supervisor-v1 LCM_SUPERVISOR_SCOPE=" + spec.scopeDigest },
      { code: 113, stderr: "transport failed" },
    ];
    const runner = fakeRunner(responses);
    const supervisor = createSupervisor("systemd-user", { run: runner.run, platform: "linux" });
    expect((await supervisor.probe(spec)).kind).toBe("unavailable");
    expect((await supervisor.probe(spec)).kind).toBe("absent");
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-running-valid", managerPid: 111 });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-not-running-valid", terminal: "inactive" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-stale-config" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-invalid-collision" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-stale-config" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "unavailable", reason: "manager-command-failed" });
    expect(runner.calls.every((call) => call.timeoutMs === 5_000)).toBe(true);
  });

  it("rejects contradictory active and terminal manager state fields", async () => {
    const spec = makeSpec("systemd-user");
    const systemd = fakeRunner([{
      code: 0,
      stdout: `${managerText(spec, "active", 111)}\nSubState=failed`,
    }]);
    await expect(createSupervisor("systemd-user", { run: systemd.run, platform: "linux" }).probe(spec)).resolves.toMatchObject({
      kind: "ambiguous",
      reason: "state-conflict",
    });
    const launchdSpec = makeSpec("launchd-user");
    const launchd = fakeRunner([{
      code: 0,
      stdout: [
        "state = running",
        "pid = 123",
        "substate = failed",
        `LCM_SUPERVISOR_MARKER => ${launchdSpec.marker}`,
        `LCM_SUPERVISOR_SCOPE => ${launchdSpec.scopeDigest}`,
        `LCM_SUPERVISOR_PORT => ${launchdSpec.port}`,
        `LCM_SUPERVISOR_NONCE => ${launchdSpec.nonce}`,
        `LCM_SUPERVISOR_EXECUTABLE => ${launchdSpec.executable}`,
        `LCM_SUPERVISOR_ARGS => ${JSON.stringify(launchdSpec.args)}`,
        "LCM_SUPERVISOR_CWD =>",
        `LCM_SUPERVISOR_ENV_DIGEST => ${launchdEnvironmentDigest(launchdSpec)}`,
      ].join("\n"),
    }]);
    await expect(createSupervisor("launchd-user", { run: launchd.run, platform: "darwin", uid: 501 }).probe(launchdSpec)).resolves.toMatchObject({
      kind: "ambiguous",
      reason: "state-conflict",
    });
  });

  it("adopts a concurrent valid winner, starts an absent unit, and emits bounded safe args", async () => {
    const spec = makeSpec("systemd-user");
    const runner = fakeRunner([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: managerText(spec, "active", 321) },
    ]);
    const supervisor = createSupervisor("systemd-user", { run: runner.run, platform: "linux" });
    expect(await supervisor.start(spec)).toMatchObject({ kind: "systemd-user", managerPid: 321, nonce: spec.nonce });
    const startCall = runner.calls[1];
    expect(startCall.command).toBe("systemd-run");
    expect(startCall.args).toContain("--user");
    expect(startCall.args).toContain("--no-block");
    expect(startCall.args).toContain("--quiet");
    expect(startCall.args).toContain(`--unit=${spec.systemdUnit}`);
    expect(startCall.args).not.toContain("--unit");
    expect(startCall.args.join(" ")).toContain("KillMode=control-group");
    expect(startCall.args.join(" ")).not.toContain("--collect");
    expect(startCall.args.join(" ")).not.toContain("Restart");

    const winner = fakeRunner([
      { code: 0, stdout: managerText(spec, "active", 987) },
    ]);
    const adopted = await createSupervisor("systemd-user", { run: winner.run, platform: "linux" }).start(spec);
    expect(adopted.managerPid).toBe(987);
    expect(winner.calls).toHaveLength(1);
  });

  it("rejects absent, tampered, or unknown credential metadata during manager admission", async () => {
    const root = makeRoot();
    const directory = createManagedCredentialDirectory(root, "credential-identity-001");
    const file = writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "secret" })[0]!;
    const credentialSpec = makeSpec("systemd-user", root, {
      credentialDirectory: directory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: file }],
    });
    const omitted = fakeRunner([{ code: 0, stdout: managerText({ ...credentialSpec, credentialDirectory: undefined, credentialFiles: undefined }, "active", 444) }]);
    await expect(createSupervisor("systemd-user", { run: omitted.run, platform: "linux" }).probe(credentialSpec)).resolves.toMatchObject({
      kind: "registered-stale-config",
      reason: "metadata-missing",
    });
    const differentFile = join(directory, "different");
    const different = fakeRunner([{ code: 0, stdout: managerText({ ...credentialSpec, credentialFiles: [{ name: "OPENAI_API_KEY", path: differentFile }] }, "active", 444) }]);
    await expect(createSupervisor("systemd-user", { run: different.run, platform: "linux" }).probe(credentialSpec)).resolves.toMatchObject({
      kind: "registered-stale-config",
      reason: "metadata-mismatch",
    });
    const unknown = fakeRunner([{
      code: 0,
      stdout: managerText({ ...credentialSpec, credentialFiles: undefined }, "active", 444)
        .replace(`LCM_CREDENTIAL_DIRECTORY=${directory}`, `LCM_CREDENTIAL_DIRECTORY=${directory} LCM_CREDENTIAL_UNKNOWN_FILE=${file}`),
    }]);
    await expect(createSupervisor("systemd-user", { run: unknown.run, platform: "linux" }).probe(credentialSpec)).resolves.toMatchObject({
      kind: "registered-stale-config",
      reason: "metadata-missing",
    });
    const exact = fakeRunner([{ code: 0, stdout: managerText(credentialSpec, "active", 444) }]);
    await expect(createSupervisor("systemd-user", { run: exact.run, platform: "linux" }).probe(credentialSpec)).resolves.toMatchObject({
      kind: "registered-running-valid",
      managerPid: 444,
      credentialDirectory: directory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: file }],
    });
  });

  it("polls exact owned systemd activation and refuses foreign or malformed transitions", async () => {
    const activating = (spec: SupervisorSpec): string => managerText(spec, "activating", 0, "start");
    const sleep = vi.fn(async () => undefined);
    const runningSpec = makeSpec("systemd-user");
    const running = fakeRunner([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: activating(runningSpec) },
      { code: 0, stdout: managerText(runningSpec, "active", 777) },
    ]);
    await expect(createSupervisor("systemd-user", { run: running.run, platform: "linux", sleep }).start(runningSpec)).resolves.toMatchObject({ managerPid: 777 });
    expect(sleep).toHaveBeenCalledOnce();

    const failedSpec = makeSpec("systemd-user");
    const failedSleep = vi.fn(async () => undefined);
    const failed = fakeRunner([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: activating(failedSpec) },
      { code: 0, stdout: managerText(failedSpec, "failed") },
    ]);
    await expect(createSupervisor("systemd-user", { run: failed.run, platform: "linux", sleep: failedSleep }).start(failedSpec)).rejects.toThrow("manager command");
    expect(failedSleep).toHaveBeenCalledOnce();

    const foreignSpec = makeSpec("systemd-user");
    const foreignSleep = vi.fn(async () => undefined);
    const foreign = fakeRunner([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: activating({ ...foreignSpec, port: foreignSpec.port + 1 }) },
    ]);
    await expect(createSupervisor("systemd-user", { run: foreign.run, platform: "linux", sleep: foreignSleep }).start(foreignSpec)).rejects.toThrow("manager command");
    expect(foreignSleep).not.toHaveBeenCalled();

    const malformedSpec = makeSpec("systemd-user");
    const malformed = fakeRunner([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: managerText(malformedSpec, "activating", 0, "verify") },
    ]);
    await expect(createSupervisor("systemd-user", { run: malformed.run, platform: "linux" }).start(malformedSpec)).rejects.toThrow("manager command");
  });

  it("carries allow-listed managed configuration through env -i without ambient secrets", async () => {
    const root = makeRoot();
    const environment = {
      HOME: "/home/managed",
      PATH: "/home/managed/bin:/usr/bin",
      LCM_SUMMARY_PROVIDER: "openai",
      LCM_SUMMARY_MODEL: "safe-model",
      LCM_POSTGRES_CA_FILE: "/home/managed/ca.pem",
      OPENAI_API_KEY: "ambient-secret",
    };
    const spec = makeSpec("systemd-user", root, {
      executable: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      launchEnvironment: environment,
    });
    const runner = fakeRunner([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: managerText(spec, "active", 322) },
    ]);
    await expect(createSupervisor("systemd-user", {
      run: runner.run,
      environment,
      platform: "linux",
    }).start(spec)).resolves.toMatchObject({ managerPid: 322 });
    const args = runner.calls[1].args;
    expect(args).toContain("HOME=/home/managed");
    expect(args).toContain("PATH=/home/managed/bin:/usr/bin");
    expect(args).toContain("LCM_SUMMARY_PROVIDER=openai");
    expect(args).toContain("LCM_SUMMARY_MODEL=safe-model");
    expect(args).toContain("LCM_POSTGRES_CA_FILE=/home/managed/ca.pem");
    expect(args.join(" ")).not.toContain("ambient-secret");
    const wrapperIndex = args.indexOf("/usr/bin/env");
    expect(wrapperIndex).toBeGreaterThanOrEqual(0);
    const childEnvironment = JSON.parse(execFileSync(args[wrapperIndex]!, args.slice(wrapperIndex + 1), { encoding: "utf8" })) as Record<string, string>;
    expect(childEnvironment).toMatchObject({
      HOME: "/home/managed",
      PATH: "/home/managed/bin:/usr/bin",
      LCM_SUMMARY_PROVIDER: "openai",
      LCM_SUMMARY_MODEL: "safe-model",
      LCM_POSTGRES_CA_FILE: "/home/managed/ca.pem",
    });
    expect(childEnvironment.OPENAI_API_KEY).toBeUndefined();
    expect(childEnvironment.DOCKERHUB_TOKEN).toBeUndefined();
    expect(childEnvironment.FIRECRAWL_API_KEY).toBeUndefined();
  });

  it("projects only validated systemd credential names into LoadCredential and the config allow-list", async () => {
    const root = makeRoot();
    const directory = createManagedCredentialDirectory(root, "systemd-cred-001");
    const files = writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "secret" });
    const spec = makeSpec("systemd-user", root, {
      credentialDirectory: directory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: files[0] }],
    });
    const runner = fakeRunner([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: managerText(spec, "active", 444) },
    ]);
    await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).start(spec)).resolves.toMatchObject({ managerPid: 444 });
    expect(runner.calls[1].args.join(" ")).toContain("--property=LoadCredential=OPENAI_API_KEY:");
    expect(runner.calls[1].args).toContain("--setenv=LCM_SYSTEMD_CRED_IDS=OPENAI_API_KEY");
    // The allow-listed LoadCredential source path is retained twice for exact
    // post-start admission: once as manager metadata mirrored into systemd's
    // Environment= line, and once as a child env -i assignment.  Neither the
    // manager metadata nor the child environment ever carries a value.
    expect(runner.calls[1].args).toContain(`--setenv=LCM_CREDENTIAL_OPENAI_API_KEY_FILE=${files[0]}`);
    expect(runner.calls[1].args).toContain(`LCM_CREDENTIAL_OPENAI_API_KEY_FILE=${files[0]}`);
    expect(runner.calls[1].args).toContain("/usr/bin/env");
    expect(runner.calls[1].args).toContain("-i");
    expect(runner.calls[1].args).toContain(`CREDENTIALS_DIRECTORY=/run/user/${process.getuid?.() ?? -1}/credentials/${spec.systemdUnit}`);
    expect(runner.calls[1].args).toContain("LCM_SYSTEMD_CRED_IDS=OPENAI_API_KEY");
    expect(runner.calls[1].args.join(" ")).not.toContain("secret");
    // Post-start verification used the mirrored source-path metadata to admit
    // the exact unit; a follow-up probe admits it too, so an ensure-shaped
    // second start adopts it instead of failing post-start admission.
    const probeRunner = fakeRunner([{ code: 0, stdout: managerText(spec, "active", 444) }]);
    await expect(createSupervisor("systemd-user", { run: probeRunner.run, platform: "linux" }).probe(spec)).resolves.toMatchObject({ kind: "registered-running-valid", managerPid: 444 });
    const adoptRunner = fakeRunner([{ code: 0, stdout: managerText(spec, "active", 444) }]);
    await expect(createSupervisor("systemd-user", { run: adoptRunner.run, platform: "linux" }).start(spec)).resolves.toMatchObject({ managerPid: 444 });
    expect(adoptRunner.calls).toHaveLength(1);
  });

  it("projects only the non-secret PostgreSQL CA path into both manager launch surfaces", async () => {
    const caFile = "/etc/lcm/ca.crt";
    for (const kind of ["systemd-user", "launchd-user"] as const) {
      const spec = makeSpec(kind, makeRoot(), { postgresCaFile: caFile });
      const runner = fakeRunner(kind === "systemd-user"
        ? [{ code: 1, stderr: "Unit is not-found" }, { code: 0, stdout: "started" }, { code: 0, stdout: managerText(spec, "active", 444) }]
        : [{ code: 113, stderr: "Could not find service" }, { code: 0, stdout: "bootstrap" }, { code: 0, stdout: launchdPrintText(spec, "running", 444) }]);
      await expect(createSupervisor(kind, { run: runner.run, platform: kind === "systemd-user" ? "linux" : "darwin", uid: 501 }).start(spec)).resolves.toMatchObject({ managerPid: 444 });
      if (kind === "systemd-user") {
        expect(runner.calls[1]!.args).toContain(`--setenv=LCM_POSTGRES_CA_FILE=${caFile}`);
        expect(runner.calls[1]!.args.join(" ")).not.toContain("LCM_POSTGRES_URL");
      } else {
        const plist = readFileSync(join(spec.stateRoot, `daemon.${spec.shortDigest}.${spec.nonce}.plist`), "utf8");
        expect(plist).toContain(`<key>LCM_POSTGRES_CA_FILE</key><string>${caFile}</string>`);
        expect(plist).not.toContain("LCM_POSTGRES_URL");
      }
    }
    const unset = makeSpec("systemd-user");
    const runner = fakeRunner([{ code: 1, stderr: "Unit is not-found" }, { code: 0, stdout: "started" }, { code: 0, stdout: managerText(unset, "active", 445) }]);
    await createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).start(unset);
    expect(runner.calls[1]!.args.join(" ")).not.toContain("LCM_POSTGRES_CA_FILE");
    const mismatch = makeSpec("systemd-user", makeRoot(), { postgresCaFile: caFile });
    await expect(createSupervisor("systemd-user", { run: fakeRunner([{ code: 0, stdout: `${managerText(mismatch).replace(` LCM_POSTGRES_CA_FILE=${caFile}`, "")}\nLCM_POSTGRES_CA_FILE=/other/ca.crt` }]).run, platform: "linux" }).probe(mismatch)).resolves.toMatchObject({ reason: "metadata-missing", postgresCaFile: "/other/ca.crt" });
    await expect(createSupervisor("systemd-user", { run: fakeRunner([{ code: 0, stdout: managerText(mismatch).replace(` LCM_POSTGRES_CA_FILE=${caFile}`, "") }]).run, platform: "linux" }).probe(mismatch)).resolves.toMatchObject({ reason: "metadata-missing" });
  });

  it("cleans only a losing launch credential directory after a different exact winner is running", async () => {
    const root = makeRoot();
    const loserDirectory = createManagedCredentialDirectory(root, "loser-abcdef0123456789");
    const loserFile = writeManagedCredentialFiles(loserDirectory, { OPENAI_API_KEY: "loser" })[0]!;
    const loser = makeSpec("systemd-user", root, {
      nonce: "loser-nonce",
      credentialDirectory: loserDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: loserFile }],
    });
    const winner = makeSpec("systemd-user", root, { nonce: "winner-nonce" });
    const runner = fakeRunner([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: managerText(winner, "active", 555) },
      { code: 0, stdout: managerText(winner, "active", 555) },
      { code: 0, stdout: managerText(winner, "active", 555) },
    ]);
    await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).start(loser)).rejects.toThrow("manager command");
    expect(existsSync(loserDirectory)).toBe(false);
  });

  it("keeps the clean-environment digest stable across per-launch credential markers", () => {
    const root = makeRoot();
    const directory = createManagedCredentialDirectory(root, "systemd-digest-001");
    const file = writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "secret" })[0]!;
    const plain = makeSpec("systemd-user", root, { launchEnvironment: { PATH: "/usr/bin" } });
    const credentialed = createSupervisorSpec({
      kind: "systemd-user",
      stateRoot: root,
      port: plain.port,
      nonce: plain.nonce,
      executable: plain.executable,
      args: plain.args,
      launchEnvironment: plain.launchEnvironment,
      credentialDirectory: directory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: file }],
    });
    expect(managedLaunchEnvironmentDigest(plain, "systemd-user", process.getuid?.() ?? -1, plain.launchEnvironment!))
      .toBe(managedLaunchEnvironmentDigest(credentialed, "systemd-user", process.getuid?.() ?? -1, credentialed.launchEnvironment!));
  });

  it("derives the canonical user runtime root when XDG_RUNTIME_DIR is absent", async () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    const runtimeRoot = uid < 0 ? "" : `/run/user/${uid}`;
    if (uid < 0 || !existsSync(runtimeRoot) || (lstatSync(runtimeRoot).mode & 0o777) !== 0o700) return;
    const root = makeRoot();
    const directory = createManagedCredentialDirectory(root, "systemd-runtime-fallback");
    const file = writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "secret" })[0]!;
    const spec = makeSpec("systemd-user", root, {
      credentialDirectory: directory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: file }],
    });
    const runner = fakeRunner([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: managerText(spec, "active", 445, "running", {}) },
    ]);
    await expect(createSupervisor("systemd-user", {
      run: runner.run,
      environment: {},
      platform: "linux",
      uid,
    }).start(spec)).resolves.toMatchObject({ managerPid: 445 });
    expect(runner.calls[1]!.args).toContain(`CREDENTIALS_DIRECTORY=${runtimeRoot}/credentials/${spec.systemdUnit}`);
    await expect(createSupervisor("systemd-user", {
      run: fakeRunner([]).run,
      environment: {},
      platform: "linux",
      uid: -1,
    }).start(spec)).rejects.toThrow("systemd runtime directory");
  });

  it("fails closed when the systemd runtime root for credentials is missing or untrusted", async () => {
    const root = makeRoot();
    let attemptIndex = 0;
    const attempt = async (runtimeRoot: string, uid?: number, removeBeforeStart = false): Promise<void> => {
      attemptIndex += 1;
      const directory = createManagedCredentialDirectory(root, `systemd-runtime-${attemptIndex}`);
      const files = writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "secret" });
      const base = {
        kind: "systemd-user" as const,
        stateRoot: root,
        port: 3737,
        nonce: "nonce-001",
        executable: "/usr/bin/node",
        args: ["/opt/lcm/dist/lcm.mjs", "daemon", "run-managed"],
        credentialDirectory: directory,
        credentialFiles: [{ name: "OPENAI_API_KEY", path: files[0] }],
      };
      const spec = createSupervisorSpec({ ...base, launchEnvironment: { XDG_RUNTIME_DIR: runtimeRoot } });
      if (removeBeforeStart) rmSync(runtimeRoot, { recursive: true, force: true });
      const runner = fakeRunner([
        { code: 1, stderr: "Unit is not-found" },
        { code: 1, stderr: "Unit is not-found" },
      ]);
      await expect(createSupervisor("systemd-user", {
        run: runner.run,
        platform: "linux",
        ...(uid === undefined ? {} : { uid }),
      }).start(spec)).rejects.toThrow(/manager command|systemd runtime directory/u);
    };
    await attempt(join(root, "missing"));
    const deleted = join(root, "deleted-runtime");
    mkdirSync(deleted, { mode: 0o700 });
    chmodSync(deleted, 0o700);
    await attempt(deleted, undefined, true);
    const untrusted = join(root, "runtime");
    mkdirSync(untrusted, { mode: 0o755 });
    chmodSync(untrusted, 0o755);
    await attempt(untrusted);
    await attempt(untrusted, -1);
  });

  it("refuses stale/collision starts and cleans exact terminal units through manager stop", async () => {
    const spec = makeSpec("systemd-user");
    const stale = fakeRunner([{ code: 0, stdout: managerText({ ...spec, port: 9 }, "inactive") }]);
    await expect(createSupervisor("systemd-user", { run: stale.run, platform: "linux" }).start(spec)).rejects.toThrow("manager command");
    const stop = fakeRunner([
      { code: 0, stdout: managerText(spec, "inactive") },
      { code: 0, stdout: "stopped" },
      { code: 0, stdout: "reset" },
      { code: 1, stderr: "Unit is not-found" },
    ]);
    await expect(createSupervisor("systemd-user", { run: stop.run, platform: "linux" }).stopAndAwaitAbsent(spec)).resolves.toBeUndefined();
    expect(stop.calls[1].args).toEqual(["--user", "stop", spec.systemdUnit]);
    expect(stop.calls[2].args).toEqual(["--user", "reset-failed", spec.systemdUnit]);
  });

  it("resets an authenticated failed unit only after stop before requiring absence", async () => {
    const spec = makeSpec("systemd-user");
    const runner = fakeRunner([
      { code: 0, stdout: managerText(spec, "failed") },
      { code: 0, stdout: "stopped" },
      { code: 0, stdout: "reset" },
      { code: 1, stderr: "Unit is not-found" },
    ]);
    await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).stopAndAwaitAbsent(spec)).resolves.toBeUndefined();
    expect(runner.calls[1].args).toEqual(["--user", "stop", spec.systemdUnit]);
    expect(runner.calls[2].args).toEqual(["--user", "reset-failed", spec.systemdUnit]);
    expect(runner.calls[2].timeoutMs).toBe(spec.stopTimeoutMs);
  });

  it("tolerates a clean-exit unit disappearing before reset-failed and proves absence", async () => {
    const spec = makeSpec("systemd-user");
    const runner = fakeRunner([
      { code: 0, stdout: managerText(spec, "inactive") },
      { code: 0, stdout: "stopped" },
      { code: 1, stderr: `Unit ${spec.systemdUnit} not-found` },
      { code: 1, stderr: `Unit ${spec.systemdUnit} not-found` },
    ]);
    await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).stopAndAwaitAbsent(spec)).resolves.toBeUndefined();
    expect(runner.calls[2].args).toEqual(["--user", "reset-failed", spec.systemdUnit]);
    expect(runner.calls[3].args).toEqual(["--user", "show", "--no-pager", "--property=LoadState,ActiveState,SubState,MainPID,Environment,ExecMainStartTimestamp,FragmentPath", spec.systemdUnit]);
  });

  it("refuses a reset-failed failure other than exact not-found", async () => {
    const spec = makeSpec("systemd-user");
    const runner = fakeRunner([
      { code: 0, stdout: managerText(spec, "failed") },
      { code: 0, stdout: "stopped" },
      { code: 1, stderr: "permission denied" },
    ]);
    await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).stopAndAwaitAbsent(spec)).rejects.toThrow("manager command");
    expect(runner.calls[2].args).toEqual(["--user", "reset-failed", spec.systemdUnit]);
    expect(runner.calls).toHaveLength(3);
  });

  it("resets and proves absence of a retained clean-exit unit before same-name recreation", async () => {
    const spec = makeSpec("systemd-user");
    const terminal = managerText(spec, "inactive");
    const runner = fakeRunner([
      { code: 0, stdout: terminal },
      { code: 0, stdout: terminal },
      { code: 0, stdout: "stopped" },
      { code: 0, stdout: "reset" },
      { code: 0, stdout: terminal },
      { code: 1, stderr: `Unit ${spec.systemdUnit} not-found` },
      { code: 1, stderr: `Unit ${spec.systemdUnit} not-found` },
      { code: 0, stdout: "started" },
      { code: 0, stdout: managerText(spec, "active", 909) },
    ]);
    await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).start(spec)).resolves.toMatchObject({
      kind: "systemd-user",
      managerPid: 909,
    });
    expect(runner.calls[2]?.args).toEqual(["--user", "stop", spec.systemdUnit]);
    expect(runner.calls[3]?.args).toEqual(["--user", "reset-failed", spec.systemdUnit]);
    expect(runner.calls.filter(({ command }) => command === "systemd-run")).toHaveLength(1);
    expect(runner.calls.some(({ args }) => args.includes("--collect"))).toBe(false);

    const terminalReplacement = fakeRunner([
      { code: 0, stdout: terminal },
      { code: 0, stdout: terminal },
      { code: 0, stdout: "stopped" },
      { code: 0, stdout: "reset" },
      { code: 1, stderr: `Unit ${spec.systemdUnit} not-found` },
      { code: 0, stdout: terminal },
    ]);
    await expect(createSupervisor("systemd-user", { run: terminalReplacement.run, platform: "linux" }).start(spec)).rejects.toThrow("manager command");
    expect(terminalReplacement.calls.filter(({ command }) => command === "systemd-run")).toHaveLength(0);
  });

  it("accepts a not-loaded stop race only after an exact prior probe and absent poll", async () => {
    const spec = makeSpec("systemd-user");
    const race = fakeRunner([
      { code: 0, stdout: managerText(spec, "active", 515) },
      { code: 1, stderr: `Unit ${spec.systemdUnit} not loaded` },
      { code: 1, stderr: `Unit ${spec.systemdUnit} not found` },
    ]);
    await expect(createSupervisor("systemd-user", {
      run: race.run,
      platform: "linux",
    }).stopAndAwaitAbsent(spec)).resolves.toBeUndefined();
    expect(race.calls[1].args).toEqual(["--user", "stop", spec.systemdUnit]);

    const genericFailure = fakeRunner([
      { code: 0, stdout: managerText(spec, "active", 515) },
      { code: 1, stderr: "permission denied" },
      { code: 1, stderr: `Unit ${spec.systemdUnit} not found` },
    ]);
    await expect(createSupervisor("systemd-user", {
      run: genericFailure.run,
      platform: "linux",
    }).stopAndAwaitAbsent(spec)).rejects.toThrow("manager command");
  });

  it("parses JSON/key-value variants and all terminal/metadata refusal boundaries", async () => {
    const spec = makeSpec("systemd-user");
    const identity = ` LCM_SUPERVISOR_EXECUTABLE=${spec.executable} LCM_SUPERVISOR_ARGS=${JSON.stringify(spec.args)} LCM_SUPERVISOR_CWD= LCM_SUPERVISOR_ENV_DIGEST=${systemdEnvironmentDigest(spec)}`;
    const outputs: SupervisorCommandResult[] = [
      { status: 0, stdout: JSON.stringify({
        loadState: "loaded",
        activeState: "active",
        mainPid: 444,
        environment: {
          LCM_SUPERVISOR_MARKER: spec.marker,
          LCM_SUPERVISOR_SCOPE: spec.scopeDigest,
          LCM_SUPERVISOR_PORT: spec.port,
          LCM_SUPERVISOR_NONCE: spec.nonce,
          LCM_SUPERVISOR_EXECUTABLE: spec.executable,
          LCM_SUPERVISOR_ARGS: JSON.stringify(spec.args),
          LCM_SUPERVISOR_CWD: "",
          LCM_SUPERVISOR_ENV_DIGEST: systemdEnvironmentDigest(spec),
        },
        list: [null, true, 3],
      }) },
      { exitCode: 0, stdout: `LoadState=loaded\nActiveState=failed\nMainPID=0\nEnvironment=LCM_SUPERVISOR_MARKER=${spec.marker} LCM_SUPERVISOR_SCOPE=${spec.scopeDigest} LCM_SUPERVISOR_PORT=${spec.port} LCM_SUPERVISOR_NONCE=${spec.nonce}${identity}` },
      { code: 0, stdout: `LoadState=loaded\nActiveState=last-exit\nMainPID=0\nEnvironment=LCM_SUPERVISOR_MARKER=${spec.marker} LCM_SUPERVISOR_SCOPE=${spec.scopeDigest} LCM_SUPERVISOR_PORT=${spec.port} LCM_SUPERVISOR_NONCE=${spec.nonce}${identity}` },
      { code: 0, stdout: `LoadState=loaded\nActiveState=active\nMainPID=not-a-pid\nEnvironment=LCM_SUPERVISOR_MARKER=${spec.marker} LCM_SUPERVISOR_SCOPE=${spec.scopeDigest} LCM_SUPERVISOR_PORT=${spec.port} LCM_SUPERVISOR_NONCE=${spec.nonce}${identity}` },
      { code: 0, stdout: `LoadState=loaded\nActiveState=inactive\nMainPID=999\nEnvironment=LCM_SUPERVISOR_MARKER=${spec.marker} LCM_SUPERVISOR_SCOPE=${spec.scopeDigest} LCM_SUPERVISOR_PORT=${spec.port} LCM_SUPERVISOR_NONCE=${spec.nonce}${identity}` },
      { code: 1, stderr: "Unit lcm.service could not be found" },
      { code: 0, stdout: `LoadState=not-found` },
      { code: 0, stdout: `LoadState=loaded\nActiveState=active\nMainPID=1\nEnvironment=LCM_SUPERVISOR_MARKER=${spec.marker} LCM_SUPERVISOR_SCOPE=${spec.scopeDigest}` },
    ];
    const runner = fakeRunner(outputs);
    const supervisor = createSupervisor("systemd-user", { run: runner.run, platform: "linux" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-running-valid", managerPid: 444 });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-not-running-valid", terminal: "failed" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-not-running-valid", terminal: "last-exit" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "ambiguous", reason: "pid-missing" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "ambiguous", reason: "state-conflict" });
    expect((await supervisor.probe(spec)).kind).toBe("absent");
    expect((await supervisor.probe(spec)).kind).toBe("absent");
    expect((await supervisor.probe(spec)).kind).toBe("registered-stale-config");
    expect(await supervisor.probe({ ...spec, kind: "launchd-user" })).toMatchObject({ kind: "ambiguous" });
  });

  it("parses systemd's outer-quoted Environment assignments without widening metadata", async () => {
    const spec = makeSpec("systemd-user", makeRoot(), {
      args: ["20"],
    });
    const output = [
      "LoadState=loaded",
      "ActiveState=active",
      "SubState=running",
      "MainPID=4242",
      `Environment=LCM_SUPERVISOR_MARKER=${spec.marker} LCM_SUPERVISOR_SCOPE=${spec.scopeDigest} LCM_SUPERVISOR_PORT=${spec.port} LCM_SUPERVISOR_NONCE=${spec.nonce} LCM_SUPERVISOR_EXECUTABLE=${spec.executable} LCM_SUPERVISOR_CWD= LCM_SUPERVISOR_ENV_DIGEST=${systemdEnvironmentDigest(spec)} \"LCM_SUPERVISOR_ARGS=[\\\"20\\\"]\"`,
    ].join("\n");
    const runner = fakeRunner([{ code: 0, stdout: output }]);
    await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).probe(spec)).resolves.toMatchObject({
      kind: "registered-running-valid",
      managerPid: 4242,
      args: JSON.stringify(spec.args),
    });
  });

  it("admits serialized argument metadata beyond the legacy 512-byte field cap", async () => {
    const spec = makeSpec("systemd-user", makeRoot(), {
      args: ["a".repeat(512), "daemon", "run-managed"],
    });
    const serializedArgs = JSON.stringify(spec.args);
    expect(serializedArgs.length).toBeGreaterThan(512);
    const runner = fakeRunner([{ code: 0, stdout: managerText(spec, "active", 4343) }]);
    await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).probe(spec)).resolves.toMatchObject({
      kind: "registered-running-valid",
      managerPid: 4343,
      args: serializedArgs,
    });
  });

  it("keeps raw argument byte/count limits exact for multibyte values", () => {
    const root = makeRoot();
    const exact = Array.from({ length: 128 }, () => "é".repeat(256));
    const over = [...exact.slice(0, -1), "é".repeat(257)];
    expect(exact.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0)).toBe(64 * 1024);
    expect(over.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0)).toBeGreaterThan(64 * 1024);
    expect(createSupervisorSpec({
      kind: "systemd-user",
      stateRoot: root,
      port: 3737,
      executable: "/usr/bin/node",
      args: exact,
    }).args).toHaveLength(128);
    expect(() => createSupervisorSpec({
      kind: "systemd-user",
      stateRoot: root,
      port: 3737,
      executable: "/usr/bin/node",
      args: over,
    })).toThrow("argument");
  });

  it("rejects malformed, duplicate, and oversized serialized assignments", async () => {
    const spec = makeSpec("systemd-user");
    const identity = `LCM_SUPERVISOR_SCOPE=${spec.scopeDigest} LCM_SUPERVISOR_PORT=${spec.port} LCM_SUPERVISOR_NONCE=${spec.nonce} LCM_SUPERVISOR_EXECUTABLE=${spec.executable} LCM_SUPERVISOR_ARGS=${JSON.stringify(spec.args)} LCM_SUPERVISOR_CWD=`;
    const duplicate = `LoadState=loaded\nActiveState=active\nMainPID=4344\nEnvironment=LCM_SUPERVISOR_MARKER=${spec.marker} LCM_SUPERVISOR_MARKER=${spec.marker} ${identity}`;
    const oversized = `LoadState=loaded\nActiveState=active\nMainPID=4345\nEnvironment=LCM_SUPERVISOR_MARKER=${spec.marker} ${identity} LCM_PADDING=${"x".repeat(70_000)}`;
    const runner = fakeRunner([
      { code: 0, stdout: duplicate },
      { code: 0, stdout: oversized },
    ]);
    const supervisor = createSupervisor("systemd-user", { run: runner.run, platform: "linux" });
    await expect(supervisor.probe(spec)).resolves.not.toMatchObject({ kind: "registered-running-valid" });
    await expect(supervisor.probe(spec)).resolves.not.toMatchObject({ kind: "registered-running-valid" });
  });

  it("bounds path-shaped supervisor metadata by UTF-8 bytes", () => {
    const root = makeRoot();
    const pathAtLimit = `/${"p".repeat(4095)}`;
    const pathOverLimit = `/${"p".repeat(4096)}`;
    const spec = createSupervisorSpec({
      kind: "systemd-user",
      stateRoot: root,
      realpath: () => pathAtLimit,
      port: 3737,
      executable: pathAtLimit,
      args: [],
      cwd: pathAtLimit,
      entrypoint: pathAtLimit,
      credentialDirectory: pathAtLimit,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: pathAtLimit }],
    });
    expect(spec.stateRoot).toBe(pathAtLimit);
    expect(spec.executable).toBe(pathAtLimit);
    expect(spec.cwd).toBe(pathAtLimit);
    expect(spec.entrypoint).toBe(pathAtLimit);
    expect(spec.credentialDirectory).toBe(pathAtLimit);
    expect(spec.credentialFiles?.[0]?.path).toBe(pathAtLimit);
    expect(() => createSupervisorSpec({
      kind: "systemd-user",
      stateRoot: root,
      realpath: () => pathOverLimit,
      port: 3737,
      executable: "/usr/bin/node",
    })).toThrow("state root");
    expect(() => createSupervisorSpec({
      kind: "systemd-user",
      stateRoot: root,
      port: 3737,
      executable: pathOverLimit,
    })).toThrow("executable");
    expect(() => createSupervisorSpec({
      kind: "systemd-user",
      stateRoot: root,
      port: 3737,
      executable: "/usr/bin/node",
      cwd: pathOverLimit,
    })).toThrow("working");
  });

  it("parses real launchd not-running and exit-code terminal output", async () => {
    const spec = makeSpec("launchd-user");
    const output = [
      "state = not running",
      "pid = 0",
      "last exit code = 36",
      `LCM_SUPERVISOR_MARKER => ${spec.marker}`,
      `LCM_SUPERVISOR_SCOPE => ${spec.scopeDigest}`,
      `LCM_SUPERVISOR_PORT => ${spec.port}`,
      `LCM_SUPERVISOR_NONCE => ${spec.nonce}`,
      `LCM_SUPERVISOR_EXECUTABLE => ${spec.executable}`,
      `LCM_SUPERVISOR_ARGS => ${JSON.stringify(spec.args)}`,
      "LCM_SUPERVISOR_CWD =>",
      `LCM_SUPERVISOR_ENV_DIGEST => ${launchdEnvironmentDigest(spec)}`,
    ].join("\n");
    const runner = fakeRunner([{ code: 0, stdout: output }]);
    await expect(createSupervisor("launchd-user", { run: runner.run, platform: "darwin", uid: 501 }).probe(spec)).resolves.toMatchObject({
      kind: "registered-not-running-valid",
      terminal: "inactive",
      nonce: spec.nonce,
    });

    const exitOnly = output.replace("state = not running\n", "");
    const exitRunner = fakeRunner([{ code: 0, stdout: exitOnly }]);
    await expect(createSupervisor("launchd-user", { run: exitRunner.run, platform: "darwin", uid: 501 }).probe(spec)).resolves.toMatchObject({
      kind: "registered-not-running-valid",
      terminal: "last-exit",
    });
  });

  it("handles quoted/oversized metadata, suffix keys, invalid numeric identities, and stale fields", async () => {
    const spec = makeSpec("systemd-user");
    const quoted = `LoadState=loaded\nActiveState=active\npid='123'\nfoo.LCM_SUPERVISOR_MARKER='${spec.marker}'\nfoo.LCM_SUPERVISOR_SCOPE='${spec.scopeDigest}'\nfoo.LCM_SUPERVISOR_PORT='${spec.port}'\nfoo.LCM_SUPERVISOR_NONCE='${spec.nonce}'\nLCM_SUPERVISOR_EXECUTABLE='${spec.executable}'\nLCM_SUPERVISOR_ARGS='${JSON.stringify(spec.args)}'\nLCM_SUPERVISOR_CWD=''\nLCM_SUPERVISOR_ENV_DIGEST='${systemdEnvironmentDigest(spec)}'`;
    const oversized = `LoadState=loaded\nActiveState=active\nMainPID=999999999999999999999\nLCM_SUPERVISOR_MARKER=${spec.marker}\nLCM_SUPERVISOR_SCOPE=${spec.scopeDigest}\nLCM_SUPERVISOR_PORT=999999999999999999999\nLCM_SUPERVISOR_NONCE=${spec.nonce}\nBig=${"x".repeat(70_000)}`;
    const staleScope = managerText({ ...spec, scopeDigest: "0".repeat(64) }, "inactive");
    const staleRoot = `${managerText(spec, "inactive")}\nLCM_SUPERVISOR_STATE_ROOT=/other/root`;
    const staleNonce = managerText({ ...spec, nonce: "other" }, "inactive");
    const stalePort = managerText({ ...spec, port: 9 }, "inactive");
    const unknownState = managerText(spec, "mystery", 0);
    const directKeys = `LoadState=loaded\nActiveState=active\npid=123\nmarker=${spec.marker}\nscopeDigest=${spec.scopeDigest}\nport=${spec.port}\nnonce=${spec.nonce}\nexecutable=${spec.executable}\nargs=${JSON.stringify(spec.args)}\ncwd=\nLCM_SUPERVISOR_ENV_DIGEST=${systemdEnvironmentDigest(spec)}`;
    const noMetadata = "LoadState=loaded\nActiveState=active\nMainPID=123";
    const activeError = { code: 1, stdout: managerText(spec, "active", 4), stderr: "unexpected" };
    const terminalError = { code: 1, stdout: managerText(spec, "inactive"), stderr: "unexpected" };
    const terminalNotFound = { code: 1, stdout: managerText(spec, "inactive"), stderr: "Unit could not be found" };
    const runner = fakeRunner([
      { code: 0, stdout: quoted },
      { code: 0, stdout: oversized },
      { code: 0, stdout: staleScope },
      { code: 0, stdout: staleRoot },
      { code: 0, stdout: staleNonce },
      { code: 0, stdout: stalePort },
      { code: 0, stdout: unknownState },
      { code: 0, stdout: directKeys },
      { code: 0, stdout: noMetadata },
      activeError,
      terminalError,
      terminalNotFound,
    ]);
    const supervisor = createSupervisor("systemd-user", { run: runner.run, platform: "linux" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-running-valid", managerPid: 123 });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-stale-config" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-stale-config" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-stale-config" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-stale-config" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-stale-config" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "ambiguous", reason: "metadata-malformed" });
    const directObserved = await supervisor.probe(spec);
    expect(directObserved).toMatchObject({ kind: "registered-running-valid", managerPid: 123 });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-invalid-collision" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "ambiguous", reason: "state-conflict" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "ambiguous", reason: "state-conflict" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "absent" });
  });

  it("parses systemd Environment values with quoting and escaped JSON", async () => {
    const spec = makeSpec("systemd-user");
    const escaped = (value: string): string => value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
    const environment = [
      `LCM_SUPERVISOR_MARKER="${escaped(spec.marker)}"`,
      `LCM_SUPERVISOR_SCOPE="${escaped(spec.scopeDigest)}"`,
      `LCM_SUPERVISOR_PORT="${spec.port}"`,
      `LCM_SUPERVISOR_NONCE="${escaped(spec.nonce)}"`,
      `LCM_SUPERVISOR_EXECUTABLE="${escaped(spec.executable)}"`,
      `LCM_SUPERVISOR_ARGS="${escaped(JSON.stringify(spec.args))}"`,
      "LCM_SUPERVISOR_CWD=\"\"",
      `LCM_SUPERVISOR_ENV_DIGEST="${systemdEnvironmentDigest(spec)}"`,
    ].join(" ");
    const runner = fakeRunner([{
      code: 0,
      stdout: `LoadState=loaded\nActiveState=active\nMainPID=515\nEnvironment=${environment}`,
    }]);
    await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).probe(spec)).resolves.toMatchObject({
      kind: "registered-running-valid",
      managerPid: 515,
      scopeDigest: spec.scopeDigest,
      nonce: spec.nonce,
    });
  });

  it("retains authenticated metadata from a bounded large systemd Environment line", async () => {
    const root = makeRoot();
    const credentialDirectory = createManagedCredentialDirectory(root, "large-env-001");
    const spec = makeSpec("systemd-user", root, { credentialDirectory });
    const padding = Array.from({ length: 24 }, (_, index) => `LCM_PADDING_${index}=${"x".repeat(32)}`).join(" ");
    const environment = [
      `LCM_SUPERVISOR_MARKER=${spec.marker}`,
      `LCM_SUPERVISOR_SCOPE=${spec.scopeDigest}`,
      `LCM_SUPERVISOR_PORT=${spec.port}`,
      `LCM_SUPERVISOR_NONCE=${spec.nonce}`,
      `LCM_SUPERVISOR_EXECUTABLE=${spec.executable}`,
      `LCM_SUPERVISOR_ARGS=${JSON.stringify(spec.args)}`,
      "LCM_SUPERVISOR_CWD=",
      `LCM_SUPERVISOR_ENV_DIGEST=${systemdEnvironmentDigest(spec)}`,
      `LCM_CREDENTIAL_DIRECTORY=${credentialDirectory}`,
      padding,
    ].join(" ");
    expect(environment.length).toBeGreaterThan(512);
    const runner = fakeRunner([{
      code: 0,
      stdout: `LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=616\nEnvironment=${environment}`,
    }]);
    await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).probe(spec)).resolves.toMatchObject({
      kind: "registered-running-valid",
      managerPid: 616,
      credentialDirectory,
    });
  });

  it("fails closed when any mandatory marker/scope/port/nonce field is absent", async () => {
    const spec = makeSpec("systemd-user");
    const complete = `LoadState=loaded\nActiveState=active\nMainPID=123\nEnvironment=LCM_SUPERVISOR_MARKER=${spec.marker} LCM_SUPERVISOR_SCOPE=${spec.scopeDigest} LCM_SUPERVISOR_PORT=${spec.port} LCM_SUPERVISOR_NONCE=${spec.nonce}`;
    const variants = [
      complete.replace(`LCM_SUPERVISOR_MARKER=${spec.marker} `, ""),
      complete.replace(`LCM_SUPERVISOR_SCOPE=${spec.scopeDigest} `, ""),
      complete.replace(`LCM_SUPERVISOR_PORT=${spec.port} `, ""),
      complete.replace(`LCM_SUPERVISOR_NONCE=${spec.nonce}`, ""),
    ];
    for (const output of variants) {
      const runner = fakeRunner([{ code: 0, stdout: output }]);
      const observed = await createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).probe(spec);
      expect(observed).toMatchObject({ kind: "registered-stale-config", reason: "metadata-missing" });
    }
  });

  it("binds admission to executable, argv, cwd, entrypoint, runtime, and storage identity", async () => {
    const spec = makeSpec("systemd-user", makeRoot(), { cwd: "/tmp", entrypoint: "entry", runtimeDigest: VALID_RUNTIME_DIGEST, storageBackend: "sqlite" });
    const variants = [
      managerText({ ...spec, executable: "/usr/bin/other" }, "active", 1),
      managerText({ ...spec, args: ["different"] }, "active", 1),
      managerText({ ...spec, cwd: "/var/tmp" }, "active", 1),
      managerText({ ...spec, entrypoint: "old" }, "active", 1),
      managerText({ ...spec, runtimeDigest: OTHER_RUNTIME_DIGEST }, "active", 1),
      managerText({ ...spec, storageBackend: "postgresql" }, "active", 1),
    ];
    for (const output of variants) {
      const runner = fakeRunner([{ code: 0, stdout: output }]);
      expect(await createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).probe(spec)).toMatchObject({ kind: "registered-stale-config", reason: "metadata-mismatch" });
    }
    const complete = managerText(spec, "active", 1);
    for (const field of [
      "LCM_SUPERVISOR_EXECUTABLE",
      "LCM_SUPERVISOR_ARGS",
      "LCM_SUPERVISOR_CWD",
      "LCM_SUPERVISOR_ENTRYPOINT",
      "LCM_SUPERVISOR_RUNTIME_DIGEST",
      "LCM_SUPERVISOR_STORAGE_BACKEND",
    ]) {
      const runner = fakeRunner([{ code: 0, stdout: complete.replace(new RegExp(` ${field}=[^ ]*`, "u"), "") }]);
      const observed = await createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).probe(spec);
      expect(observed).toMatchObject({ kind: "registered-stale-config", reason: "metadata-missing" });
    }
  });

  it("never stops stale configuration through the strict stop API, while explicit restart may replace it", async () => {
    const spec = makeSpec("systemd-user");
    const stale = managerText({ ...spec, port: 9 }, "inactive");
    const strictRunner = fakeRunner([{ code: 0, stdout: stale }]);
    await expect(createSupervisor("systemd-user", { run: strictRunner.run, platform: "linux" }).stopAndAwaitAbsent(spec)).rejects.toThrow("manager command");
    expect(strictRunner.calls).toHaveLength(1);
    const restartRunner = fakeRunner([
      { code: 0, stdout: stale },
      { code: 0, stdout: stale },
      { code: 0, stdout: "stopped" },
      { code: 1, stderr: "Unit is not-found" },
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: managerText(spec, "active", 818) },
    ]);
    await expect(createSupervisor("systemd-user", { run: restartRunner.run, platform: "linux" }).stopAndStart(spec)).resolves.toMatchObject({ managerPid: 818 });
  });

  it("requires an exact fresh systemd stale registration before replacement mutation", async () => {
    const root = makeRoot();
    const credentialDirectory = createManagedCredentialDirectory(root, "replacement");
    const credentialFile = writeManagedCredentialFiles(credentialDirectory, { OPENAI_API_KEY: "replacement-secret" })[0]!;
    const spec = makeSpec("systemd-user", root, {
      credentialDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: credentialFile }],
    });
    const prior = makeSpec("systemd-user", root, {
      port: spec.port + 1,
      nonce: "prior-stale",
      credentialDirectory: join(root, "credentials", "prior-stale"),
      credentialFiles: [{ name: "OPENAI_API_KEY", path: join(root, "credentials", "prior-stale", "OPENAI_API_KEY") }],
    });
    const stale = managerText(prior, "inactive");
    const stable = fakeRunner([
      { code: 0, stdout: stale },
      { code: 0, stdout: stale },
      { code: 0, stdout: "stopped" },
      { code: 1, stderr: `Unit ${spec.systemdUnit} not-found` },
      { code: 1, stderr: `Unit ${spec.systemdUnit} not-found` },
      { code: 0, stdout: "started" },
      { code: 0, stdout: managerText(spec, "active", 818) },
    ]);
    await expect(createSupervisor("systemd-user", { run: stable.run, platform: "linux" }).stopAndStart(spec)).resolves.toMatchObject({ managerPid: 818 });
    expect(stable.calls.some(({ command, args }) => command === "systemctl" && args[1] === "stop")).toBe(true);
    expect(existsSync(credentialDirectory)).toBe(true);

    const replacedCases: ReadonlyArray<readonly [string, SupervisorCommandResult]> = [
      ["absence", { code: 1, stderr: `Unit ${spec.systemdUnit} not-found` }],
      ["same nonce running-valid", { code: 0, stdout: managerText(spec, "active", 777) }],
      ["different nonce", { code: 0, stdout: managerText(makeSpec("systemd-user", root, { nonce: "concurrent-winner" }), "active", 777) }],
      ["collision", { code: 0, stdout: stale.replace(`LCM_SUPERVISOR_MARKER=${prior.marker}`, "LCM_SUPERVISOR_MARKER=foreign") }],
      ["ambiguity", { code: 0, stdout: managerText(spec, "active", 777, "stopped") }],
      ["unavailable", { code: 1, stderr: "permission denied" }],
      ["sparse observation", { code: 0, stdout: stale.replace("LCM_SUPERVISOR_CWD=", "LCM_SUPERVISOR_OTHER=") }],
      ["malformed environment digest", { code: 0, stdout: stale.replace(/LCM_SUPERVISOR_ENV_DIGEST=[0-9a-f]{64}/u, "LCM_SUPERVISOR_ENV_DIGEST=not-a-digest") }],
    ];
    for (const [label, fresh] of replacedCases) {
      const runner = fakeRunner([
        { code: 0, stdout: stale },
        fresh,
      ]);
      await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).stopAndStart(spec), label).rejects.toThrow("manager command");
      expect(runner.calls.some(({ command, args }) => command === "systemctl" && (args[1] === "stop" || args[1] === "reset-failed")), label).toBe(false);
      expect(runner.calls.some(({ command }) => command === "systemd-run"), label).toBe(false);
      expect(existsSync(credentialDirectory), label).toBe(true);
    }

    const configured = makeSpec("systemd-user", root, { entrypoint: "/opt/lcm/dist/lcm.mjs" });
    const incompletePrior = makeSpec("systemd-user", root, { port: configured.port + 1, nonce: "incomplete-prior" });
    const incompleteRunner = fakeRunner([
      { code: 0, stdout: managerText(incompletePrior, "inactive") },
      { code: 0, stdout: managerText(incompletePrior, "inactive") },
    ]);
    await expect(createSupervisor("systemd-user", { run: incompleteRunner.run, platform: "linux" }).stopAndStart(configured)).rejects.toThrow("manager command");
    expect(incompleteRunner.calls.some(({ command, args }) => command === "systemctl" && args[1] === "stop")).toBe(false);

    const missingMarker = managerText(incompletePrior, "inactive").replace(`LCM_SUPERVISOR_MARKER=${incompletePrior.marker} `, "");
    const missingMarkerRunner = fakeRunner([
      { code: 0, stdout: missingMarker },
      { code: 0, stdout: missingMarker },
    ]);
    await expect(createSupervisor("systemd-user", { run: missingMarkerRunner.run, platform: "linux" }).stopAndStart(configured)).rejects.toThrow("manager command");
    expect(missingMarkerRunner.calls.some(({ command, args }) => command === "systemctl" && args[1] === "stop")).toBe(false);

    const configuredWithCa = makeSpec("systemd-user", root, { postgresCaFile: join(root, "ca.pem") });
    const missingCaRunner = fakeRunner([
      { code: 0, stdout: managerText(incompletePrior, "inactive") },
      { code: 0, stdout: managerText(incompletePrior, "inactive") },
    ]);
    await expect(createSupervisor("systemd-user", { run: missingCaRunner.run, platform: "linux" }).stopAndStart(configuredWithCa)).rejects.toThrow("manager command");
    expect(missingCaRunner.calls.some(({ command, args }) => command === "systemctl" && args[1] === "stop")).toBe(false);
  });

  it("covers command preflight, bounded timeout, runner errors, and explicit restart decisions", async () => {
    const spec = makeSpec("systemd-user", makeRoot(), {
      cwd: "/tmp",
      entrypoint: "entry",
      runtimeDigest: VALID_RUNTIME_DIGEST,
      storageBackend: "sqlite",
    });
    expect(() => createSupervisor("bogus" as SupervisorKind, { run: vi.fn() })).toThrow("kind");
    expect(() => createSupervisor("systemd-user", { run: undefined as never })).toThrow("runner");
    const timeout = fakeRunner([{ timedOut: true }]);
    expect((await createSupervisor("systemd-user", { run: timeout.run, platform: "linux" }).probe(spec)).kind).toBe("unavailable");
    const runnerError = fakeRunner([{ code: 1, stderr: "permission denied" }]);
    expect(await createSupervisor("systemd-user", { run: runnerError.run, platform: "linux" }).probe(spec)).toMatchObject({ kind: "unavailable", reason: "manager-command-failed" });
    const commandError = fakeRunner([{ code: 1, stderr: "unexpected failure" }]);
    expect(await createSupervisor("systemd-user", { run: commandError.run, platform: "linux" }).probe(spec)).toMatchObject({ kind: "unavailable", reason: "manager-command-failed" });
    const timeoutOption = fakeRunner([{ code: 1, stderr: "not found" }]);
    expect((await createSupervisor("systemd-user", { run: timeoutOption.run, platform: "linux", commandTimeoutMs: 0 }).probe(spec)).kind).toBe("unavailable");

    const restart = fakeRunner([
      { code: 0, stdout: managerText(spec, "active", 1) },
      { code: 0, stdout: managerText(spec, "active", 1) },
      { code: 0, stdout: "stopped" },
      { code: 1, stderr: "Unit is not-found" },
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: managerText(spec, "active", 2) },
    ]);
    const result = await createSupervisor("systemd-user", { run: restart.run, platform: "linux", sleep: vi.fn() }).stopAndStart(spec);
    expect(result.managerPid).toBe(2);
  });

  it("covers mutation failures, bounded runner races, and manager refusal edges", async () => {
    const spec = makeSpec("systemd-user", makeRoot(), { cwd: "/tmp" });
    const terminal = fakeRunner([
      { code: 0, stdout: managerText(spec, "inactive") },
      { code: 0, stdout: managerText(spec, "inactive") },
      { code: 0, stdout: "stopped" },
      { code: 0, stdout: "reset" },
      { code: 1, stderr: "Unit is not-found" },
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: managerText(spec, "active", 99) },
    ]);
    await expect(createSupervisor("systemd-user", { run: terminal.run, platform: "linux" }).start(spec)).resolves.toMatchObject({ managerPid: 99 });
    const unavailableAfter = fakeRunner([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 127, stderr: "systemctl not found" },
    ]);
    await expect(createSupervisor("systemd-user", { run: unavailableAfter.run, platform: "linux" }).start(spec)).rejects.toThrow("manager command");
    const rejected = createSupervisor("systemd-user", {
      run: async () => { throw new Error("runner failed"); },
      platform: "linux",
    });
    expect((await rejected.probe(spec)).kind).toBe("unavailable");
    const hanging = createSupervisor("systemd-user", {
      run: async () => ({ timedOut: true }),
      platform: "linux",
      commandTimeoutMs: 1,
    });
    expect((await hanging.probe(spec)).kind).toBe("unavailable");
    const unsupported = createSupervisor("launchd-user", { run: vi.fn() });
    expect((await unsupported.probe(makeSpec("launchd-user"))).kind).toBe("unavailable");
    const absentLaunchd = fakeRunner([{ code: 113, stderr: "Could not find service" }]);
    const noExplicitUid = createSupervisor("launchd-user", { run: absentLaunchd.run, platform: "darwin" });
    expect((await noExplicitUid.probe(makeSpec("launchd-user"))).kind).toBe("absent");
    const unsafeSystemd = makeSpec("systemd-user", makeRoot(), { credentialFiles: [{ name: "EVIL", path: "/tmp/not-private" }] });
    const unsafeRunner = fakeRunner([{ code: 1, stderr: "Unit is not-found" }]);
    await expect(createSupervisor("systemd-user", { run: unsafeRunner.run, platform: "linux" }).start(unsafeSystemd)).rejects.toThrow("credential");

    const shortTimeout = makeSpec("systemd-user", makeRoot(), { stopTimeoutMs: 1 });
    const poll = fakeRunner([
      { code: 0, stdout: managerText(shortTimeout, "active", 51) },
      { code: 0, stdout: "stopped" },
      { code: 0, stdout: managerText(shortTimeout, "active", 51) },
    ]);
    const sleep = vi.fn(async () => undefined);
    await expect(createSupervisor("systemd-user", { run: poll.run, platform: "linux", sleep }).stopAndAwaitAbsent(shortTimeout)).rejects.toThrow("manager command");
    expect(poll.calls[1].timeoutMs).toBe(1);
    expect(sleep.mock.calls.length).toBeLessThanOrEqual(1);

    const defaultSleepPoll = fakeRunner([
      { code: 0, stdout: managerText(shortTimeout, "active", 52) },
      { code: 0, stdout: "stopped" },
      { code: 0, stdout: managerText(shortTimeout, "active", 52) },
    ]);
    await expect(createSupervisor("systemd-user", { run: defaultSleepPoll.run, platform: "linux" }).stopAndAwaitAbsent(shortTimeout)).rejects.toThrow("manager command");

    const terminalAfterStart = makeSpec("systemd-user", makeRoot());
    const terminalMutation = fakeRunner([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: managerText(terminalAfterStart, "inactive") },
      { code: 1, stderr: "Unit is not-found" },
    ]);
    await expect(createSupervisor("systemd-user", { run: terminalMutation.run, platform: "linux" }).start(terminalAfterStart)).rejects.toThrow("manager command");

    const terminalCredentialRoot = makeRoot();
    const terminalCredentialDirectory = createManagedCredentialDirectory(terminalCredentialRoot, "systemd-immediate-exit");
    const terminalCredentialPath = writeManagedCredentialFiles(
      terminalCredentialDirectory,
      { OPENAI_API_KEY: "secret" },
    )[0]!;
    const terminalCredentialSpec = makeSpec("systemd-user", terminalCredentialRoot, {
      credentialDirectory: terminalCredentialDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: terminalCredentialPath }],
    });
    const terminalCredentialRunner = fakeRunner([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: managerText(terminalCredentialSpec, "inactive") },
      { code: 1, stderr: "Unit is not-found" },
    ]);
    await expect(createSupervisor("systemd-user", {
      run: terminalCredentialRunner.run,
      platform: "linux",
    }).start(terminalCredentialSpec)).rejects.toThrow("manager command");
    expect(readdirSync(join(terminalCredentialRoot, "credentials"))).toHaveLength(0);

    const launchdCredentialRoot = makeRoot();
    const launchdCredentialDirectory = createManagedCredentialDirectory(launchdCredentialRoot, "launchd-immediate-exit");
    const launchdCredentialPath = writeManagedCredentialFiles(
      launchdCredentialDirectory,
      { OPENAI_API_KEY: "secret" },
    )[0]!;
    const launchdCredentialSpec = makeSpec("launchd-user", launchdCredentialRoot, {
      credentialDirectory: launchdCredentialDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: launchdCredentialPath }],
    });
    const launchdTerminalOutput = [
      "state = not running",
      "pid = 0",
      "last exit code = 36",
      `LCM_SUPERVISOR_MARKER => ${launchdCredentialSpec.marker}`,
      `LCM_SUPERVISOR_SCOPE => ${launchdCredentialSpec.scopeDigest}`,
      `LCM_SUPERVISOR_PORT => ${launchdCredentialSpec.port}`,
      `LCM_SUPERVISOR_NONCE => ${launchdCredentialSpec.nonce}`,
      `LCM_SUPERVISOR_EXECUTABLE => ${launchdCredentialSpec.executable}`,
      `LCM_SUPERVISOR_ARGS => ${JSON.stringify(launchdCredentialSpec.args)}`,
      "LCM_SUPERVISOR_CWD =>",
      `LCM_SUPERVISOR_ENV_DIGEST => ${launchdEnvironmentDigest(launchdCredentialSpec)}`,
    ].join("\n");
    const launchdCredentialRunner = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: launchdTerminalOutput },
      { code: 113, stderr: "Could not find service" },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: launchdCredentialRunner.run,
      platform: "darwin",
      uid: 501,
    }).start(launchdCredentialSpec)).rejects.toThrow("manager command");
    expect(readdirSync(join(launchdCredentialRoot, "credentials"))).toHaveLength(0);
    expect(readdirSync(launchdCredentialRoot).filter(name => name.endsWith(".plist"))).toHaveLength(0);
  });
});

describe("launchd-user supervisor", () => {
  it("classifies captured launchctl absence vocabulary without hiding permission or transport failures", async () => {
    const spec = makeSpec("launchd-user");
    const exactExitCode = fakeRunner([{ code: 36, stderr: "No such process" }]);
    await expect(createSupervisor("launchd-user", {
      run: exactExitCode.run,
      platform: "darwin",
      uid: 501,
    }).probe(spec)).resolves.toMatchObject({ kind: "absent", name: spec.launchdLabel });

    const noSuchProcess = fakeRunner([{ code: 3, stderr: "No such process" }]);
    await expect(createSupervisor("launchd-user", {
      run: noSuchProcess.run,
      platform: "darwin",
      uid: 501,
    }).probe(spec)).resolves.toMatchObject({ kind: "absent", name: spec.launchdLabel });

    const absentStop = fakeRunner([{ code: 3, stderr: "No such process" }]);
    await expect(createSupervisor("launchd-user", {
      run: absentStop.run,
      platform: "darwin",
      uid: 501,
    }).stopAndAwaitAbsent(spec)).resolves.toBeUndefined();

    const capturedNotFound = fakeRunner([{
      code: 113,
      stderr: `Could not find service "${spec.launchdLabel}" in domain gui/501`,
    }]);
    await expect(createSupervisor("launchd-user", {
      run: capturedNotFound.run,
      platform: "darwin",
      uid: 501,
    }).probe(spec)).resolves.toMatchObject({ kind: "absent", name: spec.launchdLabel });

    for (const stderr of [
      "Could not find socket in domain gui/501",
      "Permission denied",
      "transport failed",
    ]) {
      const failure = fakeRunner([{ code: 113, stderr }]);
      await expect(createSupervisor("launchd-user", {
        run: failure.run,
        platform: "darwin",
        uid: 501,
      }).probe(spec)).resolves.toMatchObject({ kind: "unavailable", reason: "manager-command-failed" });
    }

    const wrongExitCode = fakeRunner([{
      code: 1,
      stderr: `Could not find service "${spec.launchdLabel}" in domain gui/501`,
    }]);
    await expect(createSupervisor("launchd-user", {
      run: wrongExitCode.run,
      platform: "darwin",
      uid: 501,
    }).probe(spec)).resolves.toMatchObject({ kind: "unavailable", reason: "manager-command-failed" });
  });

  it("preserves staged credentials across a same-spec launchd stop/start", async () => {
    const root = makeRoot();
    const credentialDirectory = createManagedCredentialDirectory(root, "same-spec-restart");
    const credentialFile = writeManagedCredentialFiles(credentialDirectory, { OPENAI_API_KEY: "secret" })[0]!;
    const spec = makeSpec("launchd-user", root, {
      credentialDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: credentialFile }],
    });
    const absent = { code: 113, stderr: "Could not find service" };
    const runner = fakeRunner([
      { code: 0, stdout: launchdPrintText(spec, "running", 543) },
      { code: 0, stdout: launchdPrintText(spec, "running", 543) },
      { code: 0, stdout: "bootout" },
      absent,
      absent,
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: launchdPrintText(spec, "running", 544) },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
    }).stopAndStart(spec)).resolves.toMatchObject({ managerPid: 544 });
    expect(existsSync(credentialFile)).toBe(true);
    expect(runner.calls.some((call) => call.command === "launchctl" && call.args[0] === "bootout")).toBe(true);
    expect(runner.calls.some((call) => call.command === "launchctl" && call.args[0] === "bootstrap")).toBe(true);
  });

  it("handles a launchd stop/start race that proves the exact job absent", async () => {
    const root = makeRoot();
    const spec = makeSpec("launchd-user", root);
    const absent = { code: 113, stderr: "Could not find service" };
    const runner = fakeRunner([
      { code: 0, stdout: launchdPrintText(spec, "running", 543) },
      absent,
      absent,
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: launchdPrintText(spec, "running", 544) },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
    }).stopAndStart(spec)).resolves.toMatchObject({ managerPid: 544 });
    expect(runner.calls.some((call) => call.args[0] === "bootout")).toBe(false);
  });

  it("retries a launchd stale-terminal transition read-only before exact bootout", async () => {
    const root = makeRoot();
    const prior = makeSpec("launchd-user", root, { nonce: "prior-terminal" });
    const replacement = makeSpec("launchd-user", root, { nonce: "replacement-terminal" });
    const terminal = launchdPrintText(prior, "exited", 0);
    const sparseTransition = "state = exited\npid = 0";
    const runner = fakeRunner([
      { code: 0, stdout: terminal },
      { code: 0, stdout: sparseTransition },
      { code: 0, stdout: terminal },
      { code: 0, stdout: "bootout" },
      { code: 113, stderr: "Could not find service" },
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: launchdPrintText(replacement, "running", 544) },
    ]);
    const sleep = vi.fn(async () => undefined);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      sleep,
    }).stopAndStart(replacement)).resolves.toMatchObject({
      kind: "launchd-user",
      managerPid: 544,
      nonce: replacement.nonce,
    });
    expect(sleep).toHaveBeenCalledWith(50);
    expect(runner.calls.filter(({ args }) => args[0] === "bootout")).toHaveLength(1);
    expect(runner.calls.some(({ command }) => /^(?:kill|pkill|killall)$/u.test(command))).toBe(false);

    const transitionAbsent = fakeRunner([
      { code: 0, stdout: terminal },
      { code: 0, stdout: sparseTransition },
      { code: 113, stderr: "Could not find service" },
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: launchdPrintText(replacement, "running", 545) },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: transitionAbsent.run,
      platform: "darwin",
      uid: 501,
      sleep: vi.fn(async () => undefined),
    }).stopAndStart(replacement)).resolves.toMatchObject({ managerPid: 545 });
    expect(transitionAbsent.calls.some(({ args }) => args[0] === "bootout")).toBe(false);

    const foreignTerminal = launchdPrintText(makeSpec("launchd-user", makeRoot(), { nonce: "foreign-terminal" }), "exited", 0);
    const persistentCollision = fakeRunner([
      { code: 0, stdout: terminal },
      { code: 0, stdout: foreignTerminal },
      { code: 0, stdout: sparseTransition },
      { code: 0, stdout: sparseTransition },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: persistentCollision.run,
      platform: "darwin",
      uid: 501,
    }).stopAndStart(replacement)).rejects.toThrow("manager command");
    expect(persistentCollision.calls.some(({ args }) => args[0] === "bootout")).toBe(false);

    const expiredCollision = fakeRunner([
      { code: 0, stdout: terminal },
      { code: 0, stdout: sparseTransition },
    ]);
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(10_000);
    await expect(createSupervisor("launchd-user", {
      run: expiredCollision.run,
      platform: "darwin",
      uid: 501,
      now,
    }).stopAndStart(replacement)).rejects.toThrow("manager command");
    expect(expiredCollision.calls.some(({ args }) => args[0] === "bootout")).toBe(false);
  });

  it("refuses a stale launchd repetition whose fresh security metadata drifted from the authenticated prior registration", async () => {
    const root = makeRoot();
    const prior = makeSpec("launchd-user", root, {
      nonce: "prior-terminal",
      entrypoint: "/opt/lcm/dist/lcm.mjs",
      runtimeDigest: VALID_RUNTIME_DIGEST,
      storageBackend: "sqlite",
      cwd: root,
    });
    const replacement = makeSpec("launchd-user", root, {
      nonce: "replacement-terminal",
      entrypoint: "/opt/lcm/dist/lcm.mjs",
      runtimeDigest: VALID_RUNTIME_DIGEST,
      storageBackend: "sqlite",
      cwd: root,
    });
    const terminal = launchdPrintText(prior, "exited", 0);
    expect(prior.launchdLabel).toBe(replacement.launchdLabel);
    expect(prior.scopeDigest).toBe(replacement.scopeDigest);

    // A sparse/contradictory projection that resolves back to the exact prior
    // identity remains the legitimate authenticated transition and must still
    // authorize the exact bootout.
    const sparseTransition = "state = exited\npid = 0";
    const stable = fakeRunner([
      { code: 0, stdout: terminal },
      { code: 0, stdout: sparseTransition },
      { code: 0, stdout: terminal },
      { code: 0, stdout: "bootout" },
      { code: 113, stderr: "Could not find service" },
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: launchdPrintText(replacement, "running", 544) },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: stable.run,
      platform: "darwin",
      uid: 501,
      sleep: vi.fn(async () => undefined),
    }).stopAndStart(replacement)).resolves.toMatchObject({ managerPid: 544 });
    expect(stable.calls.filter(({ args }) => args[0] === "bootout")).toHaveLength(1);

    // Every security-relevant metadata surface that could drift between the
    // authenticated prior registration and a fresh observation must remain
    // fail-closed: the changed observation is not the authenticated prior
    // launch and may never authorize bootout, even under the same label mutex.
    const driftCases: ReadonlyArray<readonly [string, string]> = [
      ["executable", terminal.replace(/^LCM_SUPERVISOR_EXECUTABLE => .*$/mu, "LCM_SUPERVISOR_EXECUTABLE => /evil/node")],
      ["args", terminal.replace(/^LCM_SUPERVISOR_ARGS => .*$/mu, `LCM_SUPERVISOR_ARGS => ${JSON.stringify(["/evil/injected.js"])}`)],
      ["entrypoint", terminal.replace(/^LCM_SUPERVISOR_ENTRYPOINT => .*$/mu, "LCM_SUPERVISOR_ENTRYPOINT => /evil/entry.js")],
      ["runtimeDigest", terminal.replace(/^LCM_SUPERVISOR_RUNTIME_DIGEST => .*$/mu, `LCM_SUPERVISOR_RUNTIME_DIGEST => ${OTHER_RUNTIME_DIGEST}`)],
      ["storageBackend", terminal.replace(/^LCM_SUPERVISOR_STORAGE_BACKEND => .*$/mu, "LCM_SUPERVISOR_STORAGE_BACKEND => postgresql")],
      ["cwd", terminal.replace(/^LCM_SUPERVISOR_CWD => .*$/mu, "LCM_SUPERVISOR_CWD => /tmp/evil")],
      ["credentialDirectory", terminal.replace(/^LCM_SUPERVISOR_CWD => .*$/mu, `LCM_SUPERVISOR_CWD => ${root}\nLCM_CREDENTIAL_DIRECTORY => ${root}/credentials/attacker`)],
      ["credentialFile", terminal.replace(/^LCM_SUPERVISOR_CWD => .*$/mu, `LCM_SUPERVISOR_CWD => ${root}\nLCM_CREDENTIAL_OPENAI_API_KEY_FILE => ${root}/credentials/attacker/OPENAI_API_KEY`)],
      ["postgresCaFile", terminal.replace(/^LCM_SUPERVISOR_CWD => .*$/mu, `LCM_SUPERVISOR_CWD => ${root}\nLCM_POSTGRES_CA_FILE => ${root}/ca.pem`)],
      ["stateRoot", terminal.replace(/^LCM_SUPERVISOR_STATE_ROOT => .*$/mu, "LCM_SUPERVISOR_STATE_ROOT => /tmp/evil")],
    ];
    for (const [label, drifted] of driftCases) {
      const runner = fakeRunner([
        { code: 0, stdout: terminal },
        { code: 0, stdout: sparseTransition },
        { code: 0, stdout: drifted },
        { code: 0, stdout: drifted },
      ]);
      await expect(createSupervisor("launchd-user", {
        run: runner.run,
        platform: "darwin",
        uid: 501,
        sleep: vi.fn(async () => undefined),
      }).stopAndStart(replacement)).rejects.toThrow("manager command");
      expect(runner.calls.filter(({ args }) => args[0] === "bootout"), label).toHaveLength(0);
      expect(runner.calls.filter(({ args }) => args[0] === "bootstrap"), label).toHaveLength(0);
    }

    // A concurrent valid replacement that won the label mutex carries its own
    // fresh nonce; the transition must not confuse it with the prior terminal
    // and must refuse without mutation.
    const winner = makeSpec("launchd-user", root, {
      nonce: "winner-terminal",
      entrypoint: "/opt/lcm/dist/lcm.mjs",
      runtimeDigest: VALID_RUNTIME_DIGEST,
      storageBackend: "sqlite",
      cwd: root,
    });
    const concurrentWinner = fakeRunner([
      { code: 0, stdout: terminal },
      { code: 0, stdout: sparseTransition },
      { code: 0, stdout: launchdPrintText(winner, "running", 777) },
      { code: 0, stdout: launchdPrintText(winner, "running", 777) },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: concurrentWinner.run,
      platform: "darwin",
      uid: 501,
      sleep: vi.fn(async () => undefined),
    }).stopAndStart(replacement)).rejects.toThrow("manager command");
    expect(concurrentWinner.calls.some(({ args }) => args[0] === "bootout")).toBe(false);
  });

  it("retires a prior launchd plist with an older bounded assignment set", async () => {
    const root = makeRoot();
    const oldSpec = makeSpec("launchd-user", root, {
      launchEnvironment: { HOME: "/home/old", PATH: "/usr/bin" },
    });
    const replacementSpec = makeSpec("launchd-user", root, {
      launchEnvironment: { HOME: "/home/new", PATH: "/usr/bin", LCM_SUMMARY_PROVIDER: "openai" },
    });
    const oldRunner = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: launchdPrintText(oldSpec, "running", 543) },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: oldRunner.run,
      platform: "darwin",
      uid: 501,
    }).start(oldSpec)).resolves.toMatchObject({ managerPid: 543 });

    const replacementRunner = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: launchdPrintText(replacementSpec, "running", 544) },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: replacementRunner.run,
      platform: "darwin",
      uid: 501,
    }).start(replacementSpec)).resolves.toMatchObject({ managerPid: 544 });
    expect(readFileSync(join(root, `daemon.${replacementSpec.shortDigest}.${replacementSpec.nonce}.plist`), "utf8"))
      .toContain("<string>LCM_SUMMARY_PROVIDER=openai</string>");
  });

  it("checks current assignment values before allowing absence-only digest drift", async () => {
    const root = makeRoot();
    const oldEnvironment = { HOME: "/home/old", PATH: "/usr/bin" };
    const replacementEnvironment = { HOME: "/home/new", PATH: "/usr/bin" };
    const spec = makeSpec("launchd-user", root);
    const oldDigest = launchdEnvironmentDigest(spec, oldEnvironment);
    const replacementDigest = launchdEnvironmentDigest(spec, replacementEnvironment);
    const oldRunner = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: launchdPrintText(spec, "running", 543, oldEnvironment) },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: oldRunner.run,
      environment: oldEnvironment,
      platform: "darwin",
      uid: 501,
    }).start(spec)).resolves.toMatchObject({ managerPid: 543 });

    const plist = join(root, `daemon.${spec.shortDigest}.${spec.nonce}.plist`);
    const forgedDigestDocument = readFileSync(plist, "utf8").replaceAll(oldDigest, replacementDigest);
    writeFileSync(plist, forgedDigestDocument, { mode: 0o600 });
    const replacementRunner = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: launchdPrintText(spec, "running", 544, replacementEnvironment) },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: replacementRunner.run,
      environment: replacementEnvironment,
      platform: "darwin",
      uid: 501,
    }).start(spec)).resolves.toMatchObject({ managerPid: 544 });
    expect(readFileSync(plist, "utf8")).toContain(`<string>HOME=${replacementEnvironment.HOME}</string>`);
  });

  it("authenticates launchd environment drift from manager-observed digest variants", async () => {
    const spec = makeSpec("launchd-user");
    const environment = { HOME: "/home/managed", PATH: "/usr/bin", OPENAI_API_KEY: "manager-secret" };
    const filteredEnvironment = managedLaunchEnvironment(environment);
    const matching = launchdPrintText(spec, "running", 301, filteredEnvironment);
    const [state, pid, ...metadataLines] = matching.split("\n");
    const nested = `${state}\n${pid}\nenvironment = {\n${metadataLines.map((line) => ` ${line}`).join("\n")}\n}`;
    const missing = matching.replace(/\nLCM_SUPERVISOR_ENV_DIGEST => [^\n]+/u, "");
    const malformed = matching.replace(/LCM_SUPERVISOR_ENV_DIGEST => [^\n]+/u, "LCM_SUPERVISOR_ENV_DIGEST => not-a-digest");
    const drifted = matching.replace(
      /LCM_SUPERVISOR_ENV_DIGEST => [^\n]+/u,
      `LCM_SUPERVISOR_ENV_DIGEST => ${launchdEnvironmentDigest(spec, managedLaunchEnvironment({ HOME: "/home/other", PATH: "/usr/bin" }))}`,
    );
    expect(matching).not.toContain(environment.OPENAI_API_KEY);
    const runner = fakeRunner([
      { code: 0, stdout: matching },
      { code: 0, stdout: nested },
      { code: 0, stdout: missing },
      { code: 0, stdout: malformed },
      { code: 0, stdout: drifted },
    ]);
    const supervisor = createSupervisor("launchd-user", {
      run: runner.run,
      environment,
      platform: "darwin",
      uid: 501,
    });
    await expect(supervisor.probe(spec)).resolves.toMatchObject({ kind: "registered-running-valid", managerPid: 301 });
    await expect(supervisor.probe(spec)).resolves.toMatchObject({ kind: "registered-running-valid", managerPid: 301 });
    await expect(supervisor.probe(spec)).resolves.toMatchObject({ kind: "registered-stale-config", reason: "metadata-missing" });
    await expect(supervisor.probe(spec)).resolves.toMatchObject({ kind: "registered-stale-config", reason: "metadata-malformed" });
    await expect(supervisor.probe(spec)).resolves.toMatchObject({ kind: "registered-stale-config", reason: "metadata-mismatch" });
  });

  it("writes a private plist without KeepAlive and uses gui UID bootstrap/print/bootout", async () => {
    const root = makeRoot();
    const credentialDirectory = createManagedCredentialDirectory(root, "launch-003");
    const files = writeManagedCredentialFiles(credentialDirectory, { OPENAI_API_KEY: "secret" });
    const spec = makeSpec("launchd-user", root, {
      cwd: "/tmp",
      entrypoint: "entry",
      runtimeDigest: VALID_RUNTIME_DIGEST,
      storageBackend: "sqlite",
      credentialDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: files[0] }],
    });
    const running = launchdPrintText(spec, "running", 543);
    const runner = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: running },
    ]);
    const supervisor = createSupervisor("launchd-user", { run: runner.run, platform: "darwin", uid: 501 });
    expect(await supervisor.start(spec)).toMatchObject({ kind: "launchd-user", managerPid: 543 });
    const plist = join(root, `daemon.${spec.shortDigest}.${spec.nonce}.plist`);
    const document = readFileSync(plist, "utf8");
    expect(document).toContain(`<key>Label</key><string>${spec.launchdLabel}</string>`);
    expect(document).not.toContain("KeepAlive");
    expect(document).toContain("<string>/usr/bin/env</string>");
    expect(document).toContain("<string>-i</string>");
    expect(document).toContain(`<string>LCM_CREDENTIAL_DIRECTORY=${credentialDirectory}</string>`);
    expect(document).toContain(`<string>LCM_CREDENTIAL_OPENAI_API_KEY_FILE=${files[0]}</string>`);
    expect(document).not.toContain("secret");
    expect(lstatSync(plist).mode & 0o777).toBe(0o600);
    expect(runner.calls[1]).toMatchObject({ command: "launchctl", args: ["bootstrap", "gui/501", plist] });

    const stopRunner = fakeRunner([
      { code: 0, stdout: running },
      { code: 0, stdout: "bootout" },
      { code: 113, stderr: "Could not find service" },
    ]);
    await expect(createSupervisor("launchd-user", { run: stopRunner.run, platform: "darwin", uid: 501 }).stopAndAwaitAbsent(spec)).resolves.toBeUndefined();
    expect(stopRunner.calls[1].args).toEqual(["bootout", `gui/501/${spec.launchdLabel}`]);
  });

  it("refuses unsupported platforms and unsafe credential references", async () => {
    const spec = makeSpec("launchd-user");
    const unsupported = createSupervisor("launchd-user", { run: vi.fn(), platform: "linux", uid: 501 });
    await expect(unsupported.start(spec)).rejects.toThrow("unavailable");
    const unsafe = makeSpec("launchd-user", spec.stateRoot, { credentialDirectory: spec.stateRoot, credentialFiles: [{ name: "OPENAI_API_KEY", path: join(spec.stateRoot, "secret") }] });
    const supervisor = createSupervisor("launchd-user", { run: vi.fn(async () => ({ code: 113, stderr: "Could not find service" })), platform: "darwin", uid: 501 });
    await expect(supervisor.start(unsafe)).rejects.toThrow("credential");
  });

  it("replaces an absent launchd plist after authenticating its prior staged credential paths", async () => {
    const root = makeRoot();
    const firstDirectory = createManagedCredentialDirectory(root, "launch-004");
    const firstFiles = writeManagedCredentialFiles(firstDirectory, { OPENAI_API_KEY: "first-secret" });
    const first = makeSpec("launchd-user", root, {
      nonce: "nonce-replace",
      credentialDirectory: firstDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: firstFiles[0] }],
    });
    // Real `launchctl print` output: identity and credential metadata are
    // flat top-level entries, not nested under an environment dictionary.
    const runningFirst = launchdPrintText(first, "running", 543);
    const initial = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: runningFirst },
    ]);
    await expect(createSupervisor("launchd-user", { run: initial.run, platform: "darwin", uid: 501 }).start(first)).resolves.toMatchObject({ managerPid: 543 });

    const secondDirectory = createManagedCredentialDirectory(root, "launch-005");
    const secondFiles = writeManagedCredentialFiles(secondDirectory, {
      OPENAI_API_KEY: "second-secret",
      LCM_POSTGRES_URL: "postgresql://second",
    });
    const second = makeSpec("launchd-user", root, {
      nonce: first.nonce,
      credentialDirectory: secondDirectory,
      credentialFiles: secondFiles.map((path) => ({ name: path.slice(path.lastIndexOf("/") + 1), path })),
    });
    const firstPlist = join(root, `daemon.${first.shortDigest}.${first.nonce}.plist`);
    const firstDocument = readFileSync(firstPlist, "utf8");
    const credentialDirectoryAssignment = `<string>LCM_CREDENTIAL_DIRECTORY=${firstDirectory}</string>`;
    const credentialDirectoryEnvironment = `<key>LCM_CREDENTIAL_DIRECTORY</key><string>${firstDirectory}</string>`;
    const credentialFileAssignment = `<string>LCM_CREDENTIAL_OPENAI_API_KEY_FILE=${firstFiles[0]}</string>`;
    const credentialFileEnvironment = `<key>LCM_CREDENTIAL_OPENAI_API_KEY_FILE</key><string>${firstFiles[0]}</string>`;
    const credentialIdsAssignment = "LCM_SYSTEMD_CRED_IDS=OPENAI_API_KEY";
    const credentialIdsEnvironment = "<key>LCM_SYSTEMD_CRED_IDS</key><string>OPENAI_API_KEY</string>";
    const mismatchedDirectory = join(root, "credentials", "launch-mismatch");
    const addAssignment = (document: string, assignment: string): string =>
      document.replace("<string>/usr/bin/node</string>", `<string>${assignment}</string><string>/usr/bin/node</string>`);
    const credentialTampering = [
      (document: string) => document.replace("</dict><key>RunAtLoad", "<key>OPENAI_API_KEY</key><string>secret</string></dict><key>RunAtLoad"),
      (document: string) => document.replace("<string>LCM_SUPERVISOR_MARKER=", "<string>LCM_SUPERVISOR_RUNTIME_DIGEST=unexpected</string><string>LCM_SUPERVISOR_MARKER="),
      // Directory: each surface may be absent, but duplicated values must
      // agree before the old launch is authenticated.
      (document: string) => document.replace(credentialDirectoryAssignment, `<string>LCM_CREDENTIAL_DIRECTORY=${mismatchedDirectory}</string>`),
      // File path: exercise both one-surface fallbacks, a cross-surface
      // collision, and the bounded-path rejection after equal surfaces pass.
      (document: string) => document.replace(credentialFileAssignment, "<string>LCM_CREDENTIAL_OPENAI_API_KEY_FILE=/tmp/outside</string>"),
      (document: string) => document
        .replace(credentialFileAssignment, "<string>LCM_CREDENTIAL_OPENAI_API_KEY_FILE=/tmp/outside</string>")
        .replace(credentialFileEnvironment, "<key>LCM_CREDENTIAL_OPENAI_API_KEY_FILE</key><string>/tmp/outside</string>"),
      // IDs: exercise both fallbacks, cross-surface mismatch, and the
      // equal-but-unexpected ID-set guard.
      (document: string) => addAssignment(document, "LCM_SYSTEMD_CRED_IDS=BAD"),
      (document: string) => addAssignment(document, "LCM_SYSTEMD_CRED_IDS=BAD").replace(credentialIdsEnvironment, "<key>LCM_SYSTEMD_CRED_IDS</key><string>BAD</string>"),
      // A directory/file presence mismatch must fail before any path or ID
      // selection.  Both surfaces are removed so this is not merely a
      // cross-surface equality failure.
      (document: string) => document.replaceAll(credentialDirectoryAssignment, "").replace(credentialDirectoryEnvironment, ""),
      (document: string) => document.replaceAll(credentialFileAssignment, "").replace(credentialFileEnvironment, ""),
    ];
    for (const tamper of credentialTampering) {
      const tampered = tamper(firstDocument);
      expect(tampered).not.toBe(firstDocument);
      expect(tampered).not.toContain("first-secret");
      expect(tampered).not.toContain("second-secret");
      writeFileSync(firstPlist, tampered, { mode: 0o600 });
      chmodSync(firstPlist, 0o600);
      const collision = fakeRunner([{ code: 113, stderr: "Could not find service" }, { code: 113, stderr: "Could not find service" }]);
      let rejection: unknown;
      try {
        await createSupervisor("launchd-user", { run: collision.run, platform: "darwin", uid: 501 }).start(second);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe("supervisor manager command failed");
      expect((rejection as Error).message).not.toContain("first-secret");
      expect((rejection as Error).message).not.toContain("second-secret");
      expect(readFileSync(firstPlist, "utf8")).toBe(tampered);
      expect(readFileSync(firstPlist, "utf8")).not.toContain("first-secret");
      expect(readFileSync(firstPlist, "utf8")).not.toContain("second-secret");
      expect(collision.calls.some((call) => call.command === "launchctl" && call.args[0] === "bootstrap")).toBe(false);
      writeFileSync(firstPlist, firstDocument, { mode: 0o600 });
      chmodSync(firstPlist, 0o600);
    }
    const restoreFirstCredentials = (): void => {
      rmSync(firstDirectory, { recursive: true, force: true });
      createManagedCredentialDirectory(root, "launch-004");
      writeManagedCredentialFiles(firstDirectory, { OPENAI_API_KEY: "first-secret" });
    };
    const credentialFallbacks = [
      (document: string) => document.replace(credentialDirectoryAssignment, ""),
      (document: string) => document.replace(credentialDirectoryEnvironment, ""),
      (document: string) => document,
      (document: string) => document.replace(credentialFileAssignment, ""),
      (document: string) => document.replace(credentialFileEnvironment, ""),
      (document: string) => document,
      (document: string) => document,
      (document: string) => addAssignment(document.replace(credentialIdsEnvironment, ""), credentialIdsAssignment),
      (document: string) => addAssignment(document, credentialIdsAssignment),
    ];
    for (const fallback of credentialFallbacks) {
      restoreFirstCredentials();
      const fallbackDocument = fallback(firstDocument);
      writeFileSync(firstPlist, fallbackDocument, { mode: 0o600 });
      chmodSync(firstPlist, 0o600);
      const fallbackRunner = fakeRunner([
        { code: 113, stderr: "Could not find service" },
        { code: 0, stdout: "bootstrapped" },
        { code: 0, stdout: launchdPrintText(second, "running", 544) },
      ]);
      await expect(createSupervisor("launchd-user", { run: fallbackRunner.run, platform: "darwin", uid: 501 }).start(second)).resolves.toMatchObject({ managerPid: 544 });
      expect(fallbackRunner.calls.some((call) => call.command === "launchctl" && call.args[0] === "bootstrap")).toBe(true);
      expect(readFileSync(firstPlist, "utf8")).not.toContain("first-secret");
      expect(readFileSync(firstPlist, "utf8")).not.toContain("second-secret");
    }
    const emptyCredentialDirectory = createManagedCredentialDirectory(root, "empty-replacement");
    const noCredentials = makeSpec("launchd-user", root, {
      nonce: first.nonce,
      credentialDirectory: emptyCredentialDirectory,
      credentialFiles: [],
    });
    const noCredentialRepair = fakeRunner([{ code: 113, stderr: "Could not find service" }, { code: 0, stdout: "bootstrap" }, { code: 0, stdout: launchdPrintText(noCredentials, "running", 543) }]);
    await expect(createSupervisor("launchd-user", { run: noCredentialRepair.run, platform: "darwin", uid: 501 }).start(noCredentials)).resolves.toMatchObject({ managerPid: 543 });
    rmSync(secondDirectory, { recursive: true, force: true });
    createManagedCredentialDirectory(root, "launch-005");
    writeManagedCredentialFiles(secondDirectory, {
      OPENAI_API_KEY: "second-secret",
      LCM_POSTGRES_URL: "postgresql://second",
    });
    const replacement = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: launchdPrintText(second, "running", 543) },
    ]);
    await expect(createSupervisor("launchd-user", { run: replacement.run, platform: "darwin", uid: 501 }).start(second)).resolves.toMatchObject({ managerPid: 543 });
    expect(existsSync(firstDirectory)).toBe(false);
    const plist = join(root, `daemon.${second.shortDigest}.${second.nonce}.plist`);
    expect(readFileSync(plist, "utf8")).toContain(`<string>LCM_CREDENTIAL_DIRECTORY=${secondDirectory}</string>`);

    const thirdDirectory = createManagedCredentialDirectory(root, "launch-006");
    const thirdFiles = writeManagedCredentialFiles(thirdDirectory, { OPENAI_API_KEY: "third-secret" });
    const third = makeSpec("launchd-user", root, {
      nonce: first.nonce,
      credentialDirectory: thirdDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: thirdFiles[0]! }],
    });
    const shrink = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: launchdPrintText(third, "running", 543) },
    ]);
    await expect(createSupervisor("launchd-user", { run: shrink.run, platform: "darwin", uid: 501 }).start(third)).resolves.toMatchObject({ managerPid: 543 });
    expect(existsSync(secondDirectory)).toBe(false);
    const cleanup = fakeRunner([{ code: 113, stderr: "Could not find service" }]);
    await expect(createSupervisor("launchd-user", { run: cleanup.run, platform: "darwin", uid: 501 }).stopAndAwaitAbsent(third)).resolves.toBeUndefined();
    expect(existsSync(thirdDirectory)).toBe(false);

    const plain = makeSpec("launchd-user", root, { nonce: "plain-replace" });
    const plainRunning = launchdPrintText(plain, "running", 543);
    const plainStart = fakeRunner([{ code: 113, stderr: "Could not find service" }, { code: 0, stdout: "bootstrap" }, { code: 0, stdout: plainRunning }]);
    await expect(createSupervisor("launchd-user", { run: plainStart.run, platform: "darwin", uid: 501 }).start(plain)).resolves.toMatchObject({ managerPid: 543 });
    const plainDirectory = createManagedCredentialDirectory(root, "plain-replacement");
    const plainFile = writeManagedCredentialFiles(plainDirectory, { OPENAI_API_KEY: "plain-secret" })[0]!;
    const plainReplacement = makeSpec("launchd-user", root, {
      nonce: plain.nonce,
      credentialDirectory: plainDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: plainFile }],
    });
    const plainRepair = fakeRunner([{ code: 113, stderr: "Could not find service" }, { code: 0, stdout: "bootstrap" }, { code: 0, stdout: launchdPrintText(plainReplacement, "running", 543) }]);
    await expect(createSupervisor("launchd-user", { run: plainRepair.run, platform: "darwin", uid: 501 }).start(plainReplacement)).resolves.toMatchObject({ managerPid: 543 });
    expect(readFileSync(join(root, `daemon.${plain.shortDigest}.${plain.nonce}.plist`), "utf8")).toContain(`<string>LCM_CREDENTIAL_DIRECTORY=${plainDirectory}</string>`);
  });

  it("refuses tampered launchd plist structure and bounded-environment assignments", async () => {
    const root = makeRoot();
    const credentialDirectory = createManagedCredentialDirectory(root, "tamper-credentials");
    const credentialFile = writeManagedCredentialFiles(credentialDirectory, { OPENAI_API_KEY: "secret" })[0]!;
    const spec = makeSpec("launchd-user", root, {
      cwd: "/tmp",
      entrypoint: "entry",
      runtimeDigest: VALID_RUNTIME_DIGEST,
      storageBackend: "sqlite",
      postgresCaFile: "/etc/lcm/postgres-ca.crt",
      credentialDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: credentialFile }],
    });
    const running = launchdPrintText(spec, "running", 543);
    const initial = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: running },
    ]);
    await expect(createSupervisor("launchd-user", { run: initial.run, platform: "darwin", uid: 501 }).start(spec)).resolves.toMatchObject({ managerPid: 543 });
    const plist = join(root, `daemon.${spec.shortDigest}.${spec.nonce}.plist`);
    const original = readFileSync(plist, "utf8");
    expect(original).not.toContain("secret");
    for (const tamper of [
      (document: string) => document.replace("</dict></plist>\n", "<key>OPENAI_API_KEY</key><string>secret</string></dict></plist>\n"),
      (document: string) => document.replace(/<string>LCM_SUPERVISOR_MARKER=[^<]*<\/string>/u, "<string>malformed-assignment</string>"),
      (document: string) => document.replace(/<string>HOME=[^<]*<\/string>/u, `<string>HOME=${"x".repeat(4_097)}</string>`),
      (document: string) => document.replace(/<string>LCM_SUPERVISOR_ENV_DIGEST=[^<]*<\/string>/u, "<string>LCM_SUPERVISOR_ENV_DIGEST=not-a-digest</string>"),
      (document: string) => document.replace("<string>daemon</string>", "<string>tampered</string>"),
      (document: string) => document.replace("<string>/usr/bin/node</string>", "<string>/usr/bin/other</string>"),
      (document: string) => document.replace(/<key>Label<\/key><string>[^<]*<\/string>/u, "<key>Label</key><string>foreign.label</string>"),
      (document: string) => document.replace("<key>LCM_SUPERVISOR_ENTRYPOINT</key><string>entry</string>", "<key>LCM_SUPERVISOR_ENTRYPOINT</key><string>other</string>"),
      (document: string) => document.replace("<key>LCM_SUPERVISOR_RUNTIME_DIGEST</key><string>" + VALID_RUNTIME_DIGEST + "</string>", "<key>LCM_SUPERVISOR_RUNTIME_DIGEST</key><string>unexpected</string>"),
      (document: string) => document.replace("<key>LCM_SUPERVISOR_CWD</key><string>/tmp</string>", "<key>LCM_SUPERVISOR_CWD</key><true/>"),
      (document: string) => document.replace("<key>LCM_SUPERVISOR_CWD</key><string>/tmp</string>", "<key>LCM_SUPERVISOR_CWD</key><string>/tmp</string><key>LCM_SUPERVISOR_CWD</key><string>/tmp</string>"),
      (document: string) => document.replace("<key>WorkingDirectory</key><string>/tmp</string>", "<key>WorkingDirectory</key><string>/other</string>"),
      (document: string) => document.replace("</dict></plist>\n", "<key>WorkingDirectory</key><string>/tmp</string></dict></plist>\n"),
      (document: string) => document.replace("<string>/usr/bin/node</string>", "<true/>"),
      (document: string) => document.replace(/<key>ProgramArguments<\/key><array>.*?<\/array>/su, "<key>ProgramArguments</key><array></array>"),
      (document: string) => document.replace("<key>RunAtLoad</key><true/>", "<key>RunAtLoad</key><false/>"),
      (document: string) => document.replace("</dict></plist>\n", "<key>WorkingDirectory</key><true/></dict></plist>\n"),
      (document: string) => document.replace(/<string>HOME=[^<]*<\/string>/u, "<string>invalid-assignment</string>"),
      (document: string) => document.replace(/<string>HOME=[^<]*<\/string>/u, "<string>1BAD=foo</string>"),
      (document: string) => document.replace("<string>HOME=", "<string>UNKNOWN=foo</string><string>HOME="),
      (document: string) => document.replace(/<string>HOME=[^<]*<\/string>/u, (value) => `${value}<string>${value.slice(8)}</string>`),
    ]) {
      const tampered = tamper(original);
      writeFileSync(plist, tampered, { mode: 0o600 });
      chmodSync(plist, 0o600);
      const collision = fakeRunner([
        { code: 113, stderr: "Could not find service" },
        { code: 113, stderr: "Could not find service" },
      ]);
      await expect(createSupervisor("launchd-user", { run: collision.run, platform: "darwin", uid: 501 }).start(spec)).rejects.toThrow("manager command");
      expect(readFileSync(plist, "utf8")).toBe(tampered);
      writeFileSync(plist, original, { mode: 0o600 });
      chmodSync(plist, 0o600);
    }
  });

  it.each([
    ["without postgres CA", undefined],
    ["with postgres CA", "/etc/lcm/postgres-ca.crt"],
  ] as const)("cleans an absent launchd descriptor after bounded environment drift (%s) but never executes it while running", async (_case, postgresCaFile) => {
    const root = makeRoot();
    const firstEnvironment = { HOME: "/home/managed", PATH: "/usr/bin" };
    const replacementEnvironment = { HOME: "/home/other", PATH: "/usr/bin" };
    const credentialDirectory = createManagedCredentialDirectory(root, "drift-credentials");
    const credentialFile = writeManagedCredentialFiles(credentialDirectory, { OPENAI_API_KEY: "drift-secret" })[0]!;
    const spec = makeSpec("launchd-user", root, {
      ...(postgresCaFile === undefined ? {} : { postgresCaFile }),
      credentialDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: credentialFile }],
    });
    const firstRunning = launchdPrintText(spec, "running", 543, firstEnvironment);
    const replacementRunning = launchdPrintText(spec, "running", 543, replacementEnvironment);
    const initial = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: firstRunning },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: initial.run,
      environment: firstEnvironment,
      platform: "darwin",
      uid: 501,
    }).start(spec)).resolves.toMatchObject({ managerPid: 543 });
    const plist = join(root, `daemon.${spec.shortDigest}.${spec.nonce}.plist`);
    expect(readFileSync(plist, "utf8")).toContain(`<string>HOME=${firstEnvironment.HOME}</string>`);
    const drifted = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: replacementRunning },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: drifted.run,
      environment: replacementEnvironment,
      platform: "darwin",
      uid: 501,
    }).start(spec)).resolves.toMatchObject({ managerPid: 543 });
    expect(readFileSync(plist, "utf8")).toContain(`<string>HOME=${replacementEnvironment.HOME}</string>`);
    expect(drifted.calls.some((call) => call.command === "launchctl" && call.args[0] === "bootstrap")).toBe(true);

    const runningRoot = makeRoot();
    const runningSpec = makeSpec("launchd-user", runningRoot, {
      ...(postgresCaFile === undefined ? {} : { postgresCaFile }),
    });
    const runningOutput = `state = running\npid = 777\nenvironment = {\n LCM_SUPERVISOR_MARKER => ${runningSpec.marker}\n LCM_SUPERVISOR_SCOPE => ${runningSpec.scopeDigest}\n LCM_SUPERVISOR_PORT => ${runningSpec.port}\n LCM_SUPERVISOR_NONCE => ${runningSpec.nonce}\n LCM_SUPERVISOR_EXECUTABLE => ${runningSpec.executable}\n LCM_SUPERVISOR_ARGS => ${JSON.stringify(runningSpec.args)}\n LCM_SUPERVISOR_CWD => ${postgresCaFile === undefined ? "" : `\n LCM_POSTGRES_CA_FILE => ${postgresCaFile}`}\n LCM_SUPERVISOR_ENV_DIGEST => ${launchdEnvironmentDigest(runningSpec, firstEnvironment)}`;
    const runningInitial = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: runningOutput },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: runningInitial.run,
      environment: firstEnvironment,
      platform: "darwin",
      uid: 501,
    }).start(runningSpec)).resolves.toMatchObject({ managerPid: 777 });
    const runningPlist = join(runningRoot, `daemon.${runningSpec.shortDigest}.${runningSpec.nonce}.plist`);
    const runningDocument = readFileSync(runningPlist, "utf8");
    const runningWinner = fakeRunner([{ code: 0, stdout: runningOutput }]);
    await expect(createSupervisor("launchd-user", {
      run: runningWinner.run,
      environment: replacementEnvironment,
      platform: "darwin",
      uid: 501,
    }).start(runningSpec)).rejects.toThrow("manager command");
    expect(runningWinner.calls).toHaveLength(1);
    expect(readFileSync(runningPlist, "utf8")).toBe(runningDocument);
  });

  it("covers launchd terminal, collision, timeout, UID, and exact cleanup/refusal paths", async () => {
    const root = makeRoot();
    const spec = makeSpec("launchd-user", root);
    const running = `state = running\npid = 777\nLCM_SUPERVISOR_MARKER => ${spec.marker}\nLCM_SUPERVISOR_SCOPE => ${spec.scopeDigest}\nLCM_SUPERVISOR_PORT => ${spec.port}\nLCM_SUPERVISOR_NONCE => ${spec.nonce}\nLCM_SUPERVISOR_EXECUTABLE => ${spec.executable}\nLCM_SUPERVISOR_ARGS => ${JSON.stringify(spec.args)}\nLCM_SUPERVISOR_CWD => \nLCM_SUPERVISOR_ENV_DIGEST => ${launchdEnvironmentDigest(spec)}`;
    const terminal = `state = exited\npid = 0\nLCM_SUPERVISOR_MARKER => ${spec.marker}\nLCM_SUPERVISOR_SCOPE => ${spec.scopeDigest}\nLCM_SUPERVISOR_PORT => ${spec.port}\nLCM_SUPERVISOR_NONCE => ${spec.nonce}\nLCM_SUPERVISOR_EXECUTABLE => ${spec.executable}\nLCM_SUPERVISOR_ARGS => ${JSON.stringify(spec.args)}\nLCM_SUPERVISOR_CWD => \nLCM_SUPERVISOR_ENV_DIGEST => ${launchdEnvironmentDigest(spec)}`;
    const runner = fakeRunner([
      { code: 0, stdout: terminal },
      { code: 0, stdout: terminal },
      { code: 0, stdout: "bootout" },
      { code: 113, stderr: "Could not find service" },
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: running },
    ]);
    const supervisor = createSupervisor("launchd-user", { run: runner.run, platform: "darwin", uid: 501 });
    await expect(supervisor.start(spec)).resolves.toMatchObject({ managerPid: 777 });

    const second = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrapped" },
      { code: 113, stderr: "Could not find service" },
    ]);
    await expect(createSupervisor("launchd-user", { run: second.run, platform: "darwin", uid: 501 }).start(spec)).rejects.toThrow("manager command");

    const badPlist = join(root, `daemon.${spec.shortDigest}.${spec.nonce}.plist`);
    writeFileSync(badPlist, "foreign", { mode: 0o644 });
    const collision = fakeRunner([{ code: 113, stderr: "Could not find service" }, { code: 113, stderr: "Could not find service" }]);
    await expect(createSupervisor("launchd-user", { run: collision.run, platform: "darwin", uid: 501 }).start(spec)).rejects.toThrow("manager command");
    rmSync(badPlist, { force: true });

    writeFileSync(badPlist, "foreign", { mode: 0o600 });
    chmodSync(badPlist, 0o644);
    const modeCollision = fakeRunner([{ code: 113, stderr: "Could not find service" }]);
    await expect(createSupervisor("launchd-user", { run: modeCollision.run, platform: "darwin", uid: 501 }).start(spec)).rejects.toThrow("manager command");
    rmSync(badPlist, { force: true });

    const noUid = createSupervisor("launchd-user", { run: vi.fn(), platform: "darwin", uid: -1 });
    expect((await noUid.probe(spec)).kind).toBe("unavailable");
    const nanUid = createSupervisor("launchd-user", { run: vi.fn(async () => ({ code: 0, stdout: terminal })), platform: "darwin", uid: Number.NaN });
    await expect(nanUid.probe(spec)).rejects.toThrow("uid");

    const stopTimeout = fakeRunner([{ code: 0, stdout: running }, { timedOut: true }]);
    await expect(createSupervisor("launchd-user", { run: stopTimeout.run, platform: "darwin", uid: 501 }).stopAndAwaitAbsent(spec)).rejects.toThrow("manager command");
    const stopUnavailable = fakeRunner([{ code: 0, stdout: running }, { code: 0, stdout: "bootout" }, { code: 1, stderr: "launchctl not found" }]);
    await expect(createSupervisor("launchd-user", { run: stopUnavailable.run, platform: "darwin", uid: 501 }).stopAndAwaitAbsent(spec)).rejects.toThrow("unavailable");
    const stopCollision = fakeRunner([{ code: 0, stdout: running }, { code: 0, stdout: "bootout" }, { code: 0, stdout: "foreign state" }]);
    await expect(createSupervisor("launchd-user", { run: stopCollision.run, platform: "darwin", uid: 501 }).stopAndAwaitAbsent(spec)).rejects.toThrow("manager command");

    const refusal = fakeRunner([{ code: 0, stdout: "foreign state" }]);
    const refusalSupervisor = createSupervisor("launchd-user", { run: refusal.run, platform: "darwin", uid: 501 });
    await expect(refusalSupervisor.stopAndStart(spec)).rejects.toThrow("manager command");

    const absentStop = fakeRunner([{ code: 113, stderr: "Could not find service" }]);
    await expect(createSupervisor("launchd-user", { run: absentStop.run, platform: "darwin", uid: 501 }).stopAndAwaitAbsent(spec)).resolves.toBeUndefined();

    const unavailableRestart = fakeRunner([{ code: 127, stderr: "launchctl not found" }]);
    await expect(createSupervisor("launchd-user", { run: unavailableRestart.run, platform: "darwin", uid: 501 }).stopAndStart(spec)).rejects.toThrow("unavailable");

    const unsafeRestart = makeSpec("launchd-user", root, { credentialDirectory: root, credentialFiles: [{ name: "OPENAI_API_KEY", path: join(root, "not-private") }] });
    const unsafeRestartRunner = fakeRunner([]);
    await expect(createSupervisor("launchd-user", { run: unsafeRestartRunner.run, platform: "darwin", uid: 501 }).stopAndStart(unsafeRestart)).rejects.toThrow("credential");
    expect(unsafeRestartRunner.calls).toHaveLength(0);
  });

  it.each([
    ["changed", "/etc/lcm/old-ca.crt", "/etc/lcm/new-ca.crt"],
    ["old-present-new-absent", "/etc/lcm/old-ca.crt", undefined],
    ["old-absent-new-present", undefined, "/etc/lcm/new-ca.crt"],
  ] as const)("removes only the authenticated old launchd plist during stale-config repair (%s)", async (_case, oldCa, newCa) => {
    const root = makeRoot();
    const oldEnvironment = { HOME: "/home/managed", PATH: "/usr/bin" };
    const newEnvironment = { HOME: "/home/other", PATH: "/usr/bin" };
    const oldDirectory = createManagedCredentialDirectory(root, "stale-old-credentials");
    const oldFile = writeManagedCredentialFiles(oldDirectory, { OPENAI_API_KEY: "old-secret" })[0]!;
    const oldSpec = makeSpec("launchd-user", root, {
      nonce: "shared-nonce",
      port: 3737,
      ...(oldCa === undefined ? {} : { postgresCaFile: oldCa }),
      credentialDirectory: oldDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: oldFile }],
    });
    const running = launchdPrintText(oldSpec, "running", 777, oldEnvironment);
    const oldRunner = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: running },
    ]);
    await createSupervisor("launchd-user", {
      run: oldRunner.run,
      environment: oldEnvironment,
      platform: "darwin",
      uid: 501,
    }).start(oldSpec);
    const oldPlist = join(root, `daemon.${oldSpec.shortDigest}.${oldSpec.nonce}.plist`);
    expect(lstatSync(oldPlist).isFile()).toBe(true);
    const foreignPlist = join(root, `daemon.${oldSpec.shortDigest}.foreign.plist`);
    writeFileSync(foreignPlist, "foreign", { mode: 0o600 });
    const newDirectory = createManagedCredentialDirectory(root, "stale-new-credentials");
    const newFile = writeManagedCredentialFiles(newDirectory, { OPENAI_API_KEY: "new-secret" })[0]!;
    const newSpec = makeSpec("launchd-user", root, {
      nonce: oldSpec.nonce,
      port: 4747,
      ...(newCa === undefined ? {} : { postgresCaFile: newCa }),
      credentialDirectory: newDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: newFile }],
    });
    const stale = running
      .replace(`state = running`, "state = not running")
      .replace(`pid = 777`, "pid = 0");
    const previewRunner = fakeRunner([{ code: 0, stdout: stale }]);
    await expect(createSupervisor("launchd-user", {
      run: previewRunner.run,
      environment: newEnvironment,
      platform: "darwin",
      uid: 501,
    }).probe(newSpec)).resolves.toMatchObject({
      kind: "registered-stale-config",
      scopeDigest: newSpec.scopeDigest,
      nonce: oldSpec.nonce,
      port: oldSpec.port,
      name: newSpec.name,
    });
    const stopRunner = fakeRunner([
      { code: 0, stdout: stale },
      { code: 0, stdout: stale },
      { code: 0, stdout: "bootout" },
      { code: 113, stderr: "Could not find service" },
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: launchdPrintText(newSpec, "running", 777, newEnvironment) },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: stopRunner.run,
      environment: newEnvironment,
      platform: "darwin",
      uid: 501,
    }).stopAndStart(newSpec)).resolves.toMatchObject({ managerPid: 777, port: newSpec.port, nonce: newSpec.nonce });
    const newPlist = join(root, `daemon.${newSpec.shortDigest}.${newSpec.nonce}.plist`);
    expect(stopRunner.calls[5]?.args[2]).toBe(newPlist);
    expect(newPlist).toBe(oldPlist);
    expect(existsSync(oldDirectory)).toBe(false);
    expect(existsSync(newDirectory)).toBe(true);
    expect(existsSync(foreignPlist)).toBe(true);
    const document = readFileSync(newPlist, "utf8");
    if (newCa === undefined) expect(document).not.toContain("LCM_POSTGRES_CA_FILE");
    else expect(document).toContain(`<key>LCM_POSTGRES_CA_FILE</key><string>${newCa}</string>`);
  });
});
