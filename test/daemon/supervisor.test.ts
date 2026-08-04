import {
  chmodSync,
  existsSync,
  lstatSync,
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
  scavengeStaleManagedCredentialDirectories,
  validateManagedCredentialDirectory,
  writeManagedCredentialFiles,
} from "../../src/daemon/managed-credentials.js";
import {
  canonicalSupervisorScope,
  createSupervisor,
  createSupervisorSpec,
  isSupervisorPreflightUnavailableReason,
  MANAGED_LAUNCH_ENV_ALLOWLIST,
  managedLaunchEnvironment,
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

function managerText(
  spec: SupervisorSpec,
  state = "active",
  pid = 1234,
  subState = state === "active" ? "running" : state,
): string {
  const credentialMetadata = spec.credentialDirectory === undefined
    ? ""
    : ` LCM_CREDENTIAL_DIRECTORY=${spec.credentialDirectory}${(spec.credentialFiles ?? []).map(({ name, path }) => ` LCM_CREDENTIAL_${name}_FILE=${path}`).join("")}`;
  return [
    "LoadState=loaded",
    `ActiveState=${state}`,
    `SubState=${subState}`,
    `MainPID=${state === "active" ? pid : 0}`,
    `Environment=LCM_SUPERVISOR_MARKER=${spec.marker} LCM_SUPERVISOR_SCOPE=${spec.scopeDigest} LCM_SUPERVISOR_STATE_ROOT=${spec.stateRoot} LCM_SUPERVISOR_PORT=${spec.port} LCM_SUPERVISOR_NONCE=${spec.nonce} LCM_SUPERVISOR_EXECUTABLE=${spec.executable} LCM_SUPERVISOR_ARGS=${JSON.stringify(spec.args)} LCM_SUPERVISOR_CWD=${spec.cwd ?? ""}${spec.entrypoint === undefined ? "" : ` LCM_SUPERVISOR_ENTRYPOINT=${spec.entrypoint}`}${spec.runtimeDigest === undefined ? "" : ` LCM_SUPERVISOR_RUNTIME_DIGEST=${spec.runtimeDigest}`}${spec.storageBackend === undefined ? "" : ` LCM_SUPERVISOR_STORAGE_BACKEND=${spec.storageBackend}`}${spec.postgresCaFile === undefined ? "" : ` LCM_POSTGRES_CA_FILE=${spec.postgresCaFile}`}${credentialMetadata}`,
  ].join("\n");
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
    expect(environment).toEqual({ HOME: "/home/test", PATH: "/usr/bin" });
    expect(managedLaunchEnvironment({
      HOME: "/home/test",
      PATH: "/usr/bin",
      XDG_RUNTIME_DIR: runtimeRoot,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    })).toEqual({
      HOME: "/home/test",
      PATH: "/usr/bin",
      XDG_RUNTIME_DIR: runtimeRoot,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
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

  it("scavenges only lifecycle-shaped stale directories after an exact manager absence proof", () => {
    const root = makeRoot();
    const stale = createManagedCredentialDirectory(root, "old-launch-abcdef0123456789");
    writeManagedCredentialFiles(stale, { OPENAI_API_KEY: "stale" });
    const preserved = createManagedCredentialDirectory(root, "current-launch-0123456789abcdef");
    writeManagedCredentialFiles(preserved, { OPENAI_API_KEY: "current" });
    const unrelated = createManagedCredentialDirectory(root, "manual-directory");
    writeManagedCredentialFiles(unrelated, { OPENAI_API_KEY: "manual" });

    scavengeStaleManagedCredentialDirectories(root, "new-manager-nonce", preserved);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(preserved)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    cleanupManagedCredentialDirectory(preserved, root);
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
    expect(runner.calls[1].args).toContain(`--setenv=LCM_CREDENTIAL_OPENAI_API_KEY_FILE=${files[0]}`);
    expect(runner.calls[1].args).toContain("/usr/bin/env");
    expect(runner.calls[1].args).toContain("-i");
    expect(runner.calls[1].args).toContain(`CREDENTIALS_DIRECTORY=/run/user/${process.getuid?.() ?? -1}/credentials/${spec.systemdUnit}`);
    expect(runner.calls[1].args).toContain("LCM_SYSTEMD_CRED_IDS=OPENAI_API_KEY");
    expect(runner.calls[1].args.join(" ")).not.toContain("secret");
  });

  it("projects only the non-secret PostgreSQL CA path into both manager launch surfaces", async () => {
    const caFile = "/etc/lcm/ca.crt";
    for (const kind of ["systemd-user", "launchd-user"] as const) {
      const spec = makeSpec(kind, makeRoot(), { postgresCaFile: caFile });
      const runner = fakeRunner(kind === "systemd-user"
        ? [{ code: 1, stderr: "Unit is not-found" }, { code: 0, stdout: "started" }, { code: 0, stdout: managerText(spec, "active", 444) }]
        : [{ code: 113, stderr: "Could not find service" }, { code: 0, stdout: "bootstrap" }, { code: 0, stdout: managerText(spec, "active", 444) }]);
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
      }).start(spec)).rejects.toThrow("manager command");
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
      { code: 1, stderr: "Unit is not-found" },
    ]);
    await expect(createSupervisor("systemd-user", { run: stop.run, platform: "linux" }).stopAndAwaitAbsent(spec)).resolves.toBeUndefined();
    expect(stop.calls[1].args).toEqual(["--user", "stop", spec.systemdUnit]);
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
    const identity = ` LCM_SUPERVISOR_EXECUTABLE=${spec.executable} LCM_SUPERVISOR_ARGS=${JSON.stringify(spec.args)} LCM_SUPERVISOR_CWD=`;
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
      `Environment=LCM_SUPERVISOR_MARKER=${spec.marker} LCM_SUPERVISOR_SCOPE=${spec.scopeDigest} LCM_SUPERVISOR_PORT=${spec.port} LCM_SUPERVISOR_NONCE=${spec.nonce} LCM_SUPERVISOR_EXECUTABLE=${spec.executable} LCM_SUPERVISOR_CWD= \"LCM_SUPERVISOR_ARGS=[\\\"20\\\"]\"`,
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
    const quoted = `LoadState=loaded\nActiveState=active\npid='123'\nfoo.LCM_SUPERVISOR_MARKER='${spec.marker}'\nfoo.LCM_SUPERVISOR_SCOPE='${spec.scopeDigest}'\nfoo.LCM_SUPERVISOR_PORT='${spec.port}'\nfoo.LCM_SUPERVISOR_NONCE='${spec.nonce}'\nLCM_SUPERVISOR_EXECUTABLE='${spec.executable}'\nLCM_SUPERVISOR_ARGS='${JSON.stringify(spec.args)}'\nLCM_SUPERVISOR_CWD=''`;
    const oversized = `LoadState=loaded\nActiveState=active\nMainPID=999999999999999999999\nLCM_SUPERVISOR_MARKER=${spec.marker}\nLCM_SUPERVISOR_SCOPE=${spec.scopeDigest}\nLCM_SUPERVISOR_PORT=999999999999999999999\nLCM_SUPERVISOR_NONCE=${spec.nonce}\nBig=${"x".repeat(70_000)}`;
    const staleScope = managerText({ ...spec, scopeDigest: "0".repeat(64) }, "inactive");
    const staleRoot = `${managerText(spec, "inactive")}\nLCM_SUPERVISOR_STATE_ROOT=/other/root`;
    const staleNonce = managerText({ ...spec, nonce: "other" }, "inactive");
    const stalePort = managerText({ ...spec, port: 9 }, "inactive");
    const unknownState = managerText(spec, "mystery", 0);
    const directKeys = `LoadState=loaded\nActiveState=active\npid=123\nmarker=${spec.marker}\nscopeDigest=${spec.scopeDigest}\nport=${spec.port}\nnonce=${spec.nonce}\nexecutable=${spec.executable}\nargs=${JSON.stringify(spec.args)}\ncwd=`;
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
    const running = `state = running\npid = 543\nenvironment = {\n LCM_SUPERVISOR_MARKER => ${spec.marker}\n LCM_SUPERVISOR_SCOPE => ${spec.scopeDigest}\n LCM_SUPERVISOR_PORT => ${spec.port}\n LCM_SUPERVISOR_NONCE => ${spec.nonce}\n LCM_SUPERVISOR_EXECUTABLE => ${spec.executable}\n LCM_SUPERVISOR_ARGS => ${JSON.stringify(spec.args)}\n LCM_SUPERVISOR_CWD => ${spec.cwd}\n LCM_SUPERVISOR_ENTRYPOINT => ${spec.entrypoint}\n LCM_SUPERVISOR_RUNTIME_DIGEST => ${spec.runtimeDigest}\n LCM_SUPERVISOR_STORAGE_BACKEND => ${spec.storageBackend}\n LCM_CREDENTIAL_DIRECTORY => ${credentialDirectory}\n LCM_CREDENTIAL_OPENAI_API_KEY_FILE => ${files[0]}\n}`;
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
    const running = `state = running\npid = 543\nenvironment = {\n LCM_SUPERVISOR_MARKER => ${first.marker}\n LCM_SUPERVISOR_SCOPE => ${first.scopeDigest}\n LCM_SUPERVISOR_PORT => ${first.port}\n LCM_SUPERVISOR_NONCE => ${first.nonce}\n LCM_SUPERVISOR_EXECUTABLE => ${first.executable}\n LCM_SUPERVISOR_ARGS => ${JSON.stringify(first.args)}\n LCM_SUPERVISOR_CWD => `;
    const initial = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: running },
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
    const credentialTampering = [
      (document: string) => document.replace("</dict><key>RunAtLoad", "<key>OPENAI_API_KEY</key><string>secret</string></dict><key>RunAtLoad"),
      (document: string) => document.replace("<string>LCM_SUPERVISOR_MARKER=", "<string>LCM_SUPERVISOR_RUNTIME_DIGEST=unexpected</string><string>LCM_SUPERVISOR_MARKER="),
      (document: string) => document.replace(`<string>LCM_CREDENTIAL_DIRECTORY=${firstDirectory}</string>`, ""),
      (document: string) => document.replace(`<string>LCM_CREDENTIAL_OPENAI_API_KEY_FILE=${firstFiles[0]}</string>`, "<string>LCM_CREDENTIAL_OPENAI_API_KEY_FILE=/tmp/outside</string>"),
      (document: string) => document.replace(`<key>LCM_CREDENTIAL_OPENAI_API_KEY_FILE</key><string>${firstFiles[0]}</string>`, "<key>LCM_CREDENTIAL_OPENAI_API_KEY_FILE</key><string>/tmp/other</string>"),
      (document: string) => document.replace(`<key>LCM_CREDENTIAL_DIRECTORY</key><string>${firstDirectory}</string>`, "<key>LCM_CREDENTIAL_DIRECTORY</key><string>/tmp/other</string>"),
      (document: string) => document.replace("<key>LCM_SYSTEMD_CRED_IDS</key><string>OPENAI_API_KEY</string>", "<key>LCM_SYSTEMD_CRED_IDS</key><string>BAD</string>"),
    ];
    for (const tamper of credentialTampering) {
      const tampered = tamper(firstDocument);
      expect(tampered).not.toBe(firstDocument);
      writeFileSync(firstPlist, tampered, { mode: 0o600 });
      chmodSync(firstPlist, 0o600);
      const collision = fakeRunner([{ code: 113, stderr: "Could not find service" }, { code: 113, stderr: "Could not find service" }]);
      await expect(createSupervisor("launchd-user", { run: collision.run, platform: "darwin", uid: 501 }).start(second)).rejects.toThrow("manager command");
      expect(readFileSync(firstPlist, "utf8")).toBe(tampered);
      writeFileSync(firstPlist, firstDocument, { mode: 0o600 });
      chmodSync(firstPlist, 0o600);
    }
    const emptyCredentialDirectory = createManagedCredentialDirectory(root, "empty-replacement");
    const noCredentials = makeSpec("launchd-user", root, {
      nonce: first.nonce,
      credentialDirectory: emptyCredentialDirectory,
      credentialFiles: [],
    });
    const noCredentialRepair = fakeRunner([{ code: 113, stderr: "Could not find service" }, { code: 0, stdout: "bootstrap" }, { code: 0, stdout: running }]);
    await expect(createSupervisor("launchd-user", { run: noCredentialRepair.run, platform: "darwin", uid: 501 }).start(noCredentials)).resolves.toMatchObject({ managerPid: 543 });
    const replacement = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: running },
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
      { code: 0, stdout: running },
    ]);
    await expect(createSupervisor("launchd-user", { run: shrink.run, platform: "darwin", uid: 501 }).start(third)).resolves.toMatchObject({ managerPid: 543 });
    expect(existsSync(secondDirectory)).toBe(false);
    const cleanup = fakeRunner([{ code: 113, stderr: "Could not find service" }]);
    await expect(createSupervisor("launchd-user", { run: cleanup.run, platform: "darwin", uid: 501 }).stopAndAwaitAbsent(third)).resolves.toBeUndefined();
    expect(existsSync(thirdDirectory)).toBe(false);

    const plain = makeSpec("launchd-user", root, { nonce: "plain-replace" });
    const plainRunning = `state = running\npid = 543\nenvironment = {\n LCM_SUPERVISOR_MARKER => ${plain.marker}\n LCM_SUPERVISOR_SCOPE => ${plain.scopeDigest}\n LCM_SUPERVISOR_PORT => ${plain.port}\n LCM_SUPERVISOR_NONCE => ${plain.nonce}\n LCM_SUPERVISOR_EXECUTABLE => ${plain.executable}\n LCM_SUPERVISOR_ARGS => ${JSON.stringify(plain.args)}\n LCM_SUPERVISOR_CWD => `;
    const plainStart = fakeRunner([{ code: 113, stderr: "Could not find service" }, { code: 0, stdout: "bootstrap" }, { code: 0, stdout: plainRunning }]);
    await expect(createSupervisor("launchd-user", { run: plainStart.run, platform: "darwin", uid: 501 }).start(plain)).resolves.toMatchObject({ managerPid: 543 });
    const plainDirectory = createManagedCredentialDirectory(root, "plain-replacement");
    const plainFile = writeManagedCredentialFiles(plainDirectory, { OPENAI_API_KEY: "plain-secret" })[0]!;
    const plainReplacement = makeSpec("launchd-user", root, {
      nonce: plain.nonce,
      credentialDirectory: plainDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: plainFile }],
    });
    const plainRepair = fakeRunner([{ code: 113, stderr: "Could not find service" }, { code: 0, stdout: "bootstrap" }, { code: 0, stdout: plainRunning }]);
    await expect(createSupervisor("launchd-user", { run: plainRepair.run, platform: "darwin", uid: 501 }).start(plainReplacement)).resolves.toMatchObject({ managerPid: 543 });
    expect(readFileSync(join(root, `daemon.${plain.shortDigest}.${plain.nonce}.plist`), "utf8")).toContain(`<string>LCM_CREDENTIAL_DIRECTORY=${plainDirectory}</string>`);
  });

  it("refuses tampered launchd plist structure and bounded-environment assignments", async () => {
    const root = makeRoot();
    const spec = makeSpec("launchd-user", root, {
      cwd: "/tmp",
      entrypoint: "entry",
      runtimeDigest: VALID_RUNTIME_DIGEST,
      storageBackend: "sqlite",
    });
    const running = `state = running\npid = 543\nenvironment = {\n LCM_SUPERVISOR_MARKER => ${spec.marker}\n LCM_SUPERVISOR_SCOPE => ${spec.scopeDigest}\n LCM_SUPERVISOR_PORT => ${spec.port}\n LCM_SUPERVISOR_NONCE => ${spec.nonce}\n LCM_SUPERVISOR_EXECUTABLE => ${spec.executable}\n LCM_SUPERVISOR_ARGS => ${JSON.stringify(spec.args)}\n LCM_SUPERVISOR_CWD => ${spec.cwd}\n LCM_SUPERVISOR_ENTRYPOINT => ${spec.entrypoint}\n LCM_SUPERVISOR_RUNTIME_DIGEST => ${spec.runtimeDigest}\n LCM_SUPERVISOR_STORAGE_BACKEND => ${spec.storageBackend}`;
    const initial = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: running },
    ]);
    await expect(createSupervisor("launchd-user", { run: initial.run, platform: "darwin", uid: 501 }).start(spec)).resolves.toMatchObject({ managerPid: 543 });
    const plist = join(root, `daemon.${spec.shortDigest}.${spec.nonce}.plist`);
    const original = readFileSync(plist, "utf8");
    for (const tamper of [
      (document: string) => document.replace("</dict></plist>\n", "<key>OPENAI_API_KEY</key><string>secret</string></dict></plist>\n"),
      (document: string) => document.replace(/<string>HOME=[^<]*<\/string>/u, `<string>HOME=${"x".repeat(4_097)}</string>`),
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
      (document: string) => document.replace(/<string>PATH=[^<]*<\/string>/u, ""),
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

  it("cleans an absent launchd descriptor after bounded environment drift but never executes it while running", async () => {
    const root = makeRoot();
    const firstEnvironment = { HOME: "/home/managed", PATH: "/usr/bin" };
    const replacementEnvironment = { HOME: "/home/other", PATH: "/usr/bin" };
    const spec = makeSpec("launchd-user", root);
    const running = `state = running\npid = 543\nenvironment = {\n LCM_SUPERVISOR_MARKER => ${spec.marker}\n LCM_SUPERVISOR_SCOPE => ${spec.scopeDigest}\n LCM_SUPERVISOR_PORT => ${spec.port}\n LCM_SUPERVISOR_NONCE => ${spec.nonce}\n LCM_SUPERVISOR_EXECUTABLE => ${spec.executable}\n LCM_SUPERVISOR_ARGS => ${JSON.stringify(spec.args)}\n LCM_SUPERVISOR_CWD => `;
    const initial = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: running },
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
      { code: 0, stdout: running },
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
    const runningSpec = makeSpec("launchd-user", runningRoot);
    const runningOutput = `state = running\npid = 777\nenvironment = {\n LCM_SUPERVISOR_MARKER => ${runningSpec.marker}\n LCM_SUPERVISOR_SCOPE => ${runningSpec.scopeDigest}\n LCM_SUPERVISOR_PORT => ${runningSpec.port}\n LCM_SUPERVISOR_NONCE => ${runningSpec.nonce}\n LCM_SUPERVISOR_EXECUTABLE => ${runningSpec.executable}\n LCM_SUPERVISOR_ARGS => ${JSON.stringify(runningSpec.args)}\n LCM_SUPERVISOR_CWD => `;
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
    }).start(runningSpec)).resolves.toMatchObject({ managerPid: 777 });
    expect(runningWinner.calls).toHaveLength(1);
    expect(readFileSync(runningPlist, "utf8")).toBe(runningDocument);
  });

  it("covers launchd terminal, collision, timeout, UID, and exact cleanup/refusal paths", async () => {
    const root = makeRoot();
    const spec = makeSpec("launchd-user", root);
    const running = `state = running\npid = 777\nLCM_SUPERVISOR_MARKER => ${spec.marker}\nLCM_SUPERVISOR_SCOPE => ${spec.scopeDigest}\nLCM_SUPERVISOR_PORT => ${spec.port}\nLCM_SUPERVISOR_NONCE => ${spec.nonce}\nLCM_SUPERVISOR_EXECUTABLE => ${spec.executable}\nLCM_SUPERVISOR_ARGS => ${JSON.stringify(spec.args)}\nLCM_SUPERVISOR_CWD => `;
    const terminal = `state = exited\npid = 0\nLCM_SUPERVISOR_MARKER => ${spec.marker}\nLCM_SUPERVISOR_SCOPE => ${spec.scopeDigest}\nLCM_SUPERVISOR_PORT => ${spec.port}\nLCM_SUPERVISOR_NONCE => ${spec.nonce}\nLCM_SUPERVISOR_EXECUTABLE => ${spec.executable}\nLCM_SUPERVISOR_ARGS => ${JSON.stringify(spec.args)}\nLCM_SUPERVISOR_CWD => `;
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
    const oldSpec = makeSpec("launchd-user", root, { nonce: "old-nonce", port: 3737, ...(oldCa === undefined ? {} : { postgresCaFile: oldCa }) });
    const running = [
      "state = running",
      "pid = 777",
      `LCM_SUPERVISOR_MARKER => ${oldSpec.marker}`,
      `LCM_SUPERVISOR_SCOPE => ${oldSpec.scopeDigest}`,
      `LCM_SUPERVISOR_PORT => ${oldSpec.port}`,
      `LCM_SUPERVISOR_NONCE => ${oldSpec.nonce}`,
      `LCM_SUPERVISOR_EXECUTABLE => ${oldSpec.executable}`,
      `LCM_SUPERVISOR_ARGS => ${JSON.stringify(oldSpec.args)}`,
      "LCM_SUPERVISOR_CWD =>",
      ...(oldCa === undefined ? [] : [`LCM_POSTGRES_CA_FILE => ${oldCa}`]),
    ].join("\n");
    const oldRunner = fakeRunner([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: running },
    ]);
    await createSupervisor("launchd-user", { run: oldRunner.run, platform: "darwin", uid: 501 }).start(oldSpec);
    const oldPlist = join(root, `daemon.${oldSpec.shortDigest}.${oldSpec.nonce}.plist`);
    expect(lstatSync(oldPlist).isFile()).toBe(true);
    const foreignPlist = join(root, `daemon.${oldSpec.shortDigest}.foreign.plist`);
    writeFileSync(foreignPlist, "foreign", { mode: 0o600 });
    const newSpec = makeSpec("launchd-user", root, { nonce: "new-nonce", port: 4747, ...(newCa === undefined ? {} : { postgresCaFile: newCa }) });
    const stale = running
      .replace(`state = running`, "state = not running")
      .replace(`pid = 777`, "pid = 0");
    const previewRunner = fakeRunner([{ code: 0, stdout: stale }]);
    await expect(createSupervisor("launchd-user", { run: previewRunner.run, platform: "darwin", uid: 501 }).probe(newSpec)).resolves.toMatchObject({
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
      { code: 0, stdout: (oldCa === undefined
        ? `${running}\nLCM_POSTGRES_CA_FILE => ${newCa}`
        : running.replace(`LCM_POSTGRES_CA_FILE => ${oldCa}`, newCa === undefined ? "" : `LCM_POSTGRES_CA_FILE => ${newCa}`))
        .replaceAll(oldSpec.port.toString(), newSpec.port.toString())
        .replaceAll(oldSpec.nonce, newSpec.nonce) },
    ]);
    await expect(createSupervisor("launchd-user", { run: stopRunner.run, platform: "darwin", uid: 501 }).stopAndStart(newSpec)).resolves.toMatchObject({ managerPid: 777, port: newSpec.port, nonce: newSpec.nonce });
    const newPlist = join(root, `daemon.${newSpec.shortDigest}.${newSpec.nonce}.plist`);
    expect(stopRunner.calls[5]?.args[2]).toBe(newPlist);
    expect(existsSync(oldPlist)).toBe(false);
    expect(existsSync(foreignPlist)).toBe(true);
    const document = readFileSync(newPlist, "utf8");
    if (newCa === undefined) expect(document).not.toContain("LCM_POSTGRES_CA_FILE");
    else expect(document).toContain(`<key>LCM_POSTGRES_CA_FILE</key><string>${newCa}</string>`);
  });
});
