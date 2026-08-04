import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
import {
  canonicalSupervisorScope,
  createSupervisor,
  createSupervisorSpec,
  isSupervisorPreflightUnavailableReason,
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

function managerText(spec: SupervisorSpec, state = "active", pid = 1234): string {
  return [
    "LoadState=loaded",
    `ActiveState=${state}`,
    `SubState=${state === "active" ? "running" : state}`,
    `MainPID=${state === "active" ? pid : 0}`,
    `Environment=LCM_SUPERVISOR_MARKER=${spec.marker} LCM_SUPERVISOR_SCOPE=${spec.scopeDigest} LCM_SUPERVISOR_PORT=${spec.port} LCM_SUPERVISOR_NONCE=${spec.nonce} LCM_SUPERVISOR_EXECUTABLE=${spec.executable} LCM_SUPERVISOR_ARGS=${JSON.stringify(spec.args)} LCM_SUPERVISOR_CWD=${spec.cwd ?? ""}${spec.entrypoint === undefined ? "" : ` LCM_SUPERVISOR_ENTRYPOINT=${spec.entrypoint}`}${spec.runtimeDigest === undefined ? "" : ` LCM_SUPERVISOR_RUNTIME_DIGEST=${spec.runtimeDigest}`}${spec.storageBackend === undefined ? "" : ` LCM_SUPERVISOR_STORAGE_BACKEND=${spec.storageBackend}`}`,
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
  it("allows detached compatibility only for read-only manager absence reasons", () => {
    const reasons = [
      "manager-unavailable",
      "manager-timeout",
      "manager-command-failed",
      "manager-not-found",
      "metadata-missing",
      "metadata-mismatch",
      "foreign-job",
      "pid-missing",
      "pid-invalid",
      "state-conflict",
      "credential-invalid",
      "cleanup-failed",
      "unsupported-platform",
    ] as const;
    expect(reasons.map(isSupervisorPreflightUnavailableReason)).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
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
    expect(createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, command: "/bin/node", argv: ["daemon"], cwd: "/tmp", entrypoint: "entry", runtimeDigest: "runtime", storageBackend: "sqlite" })).toMatchObject({ executable: "/bin/node", args: ["daemon"], cwd: "/tmp" });
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, executable: "/bin/node", entrypoint: "" })).toThrow("metadata");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, executable: "/bin/node", runtimeDigest: "line\nfeed" })).toThrow("metadata");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot: root, port: 1, executable: "/bin/node", credentialFiles: [{ name: "bad\nname", path: "/tmp/credential" }] })).toThrow("credential");
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
    expect(() => createManagedCredentialDirectory(root, "n", uid)).toThrow("private");
    chmodSync(join(root, "credentials"), 0o700);
    const directory = createManagedCredentialDirectory(root, "n", uid);
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
    expect(runner.calls[1].args.join(" ")).not.toContain("secret");
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
    const spec = makeSpec("systemd-user", makeRoot(), { cwd: "/tmp", entrypoint: "entry", runtimeDigest: "runtime", storageBackend: "sqlite" });
    const variants = [
      managerText({ ...spec, executable: "/usr/bin/other" }, "active", 1),
      managerText({ ...spec, args: ["different"] }, "active", 1),
      managerText({ ...spec, cwd: "/var/tmp" }, "active", 1),
      managerText({ ...spec, entrypoint: "old" }, "active", 1),
      managerText({ ...spec, runtimeDigest: "old" }, "active", 1),
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
      runtimeDigest: "runtime",
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
    const absentLaunchd = fakeRunner([{ code: 1, stderr: "Could not find service" }]);
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
  });
});

describe("launchd-user supervisor", () => {
  it("writes a private plist without KeepAlive and uses gui UID bootstrap/print/bootout", async () => {
    const root = makeRoot();
    const credentialDirectory = createManagedCredentialDirectory(root, "launch-003");
    const files = writeManagedCredentialFiles(credentialDirectory, { OPENAI_API_KEY: "secret" });
    const spec = makeSpec("launchd-user", root, {
      cwd: "/tmp",
      entrypoint: "entry",
      runtimeDigest: "runtime",
      storageBackend: "sqlite",
      credentialDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: files[0] }],
    });
    const running = `state = running\npid = 543\nenvironment = {\n LCM_SUPERVISOR_MARKER => ${spec.marker}\n LCM_SUPERVISOR_SCOPE => ${spec.scopeDigest}\n LCM_SUPERVISOR_PORT => ${spec.port}\n LCM_SUPERVISOR_NONCE => ${spec.nonce}\n LCM_SUPERVISOR_EXECUTABLE => ${spec.executable}\n LCM_SUPERVISOR_ARGS => ${JSON.stringify(spec.args)}\n LCM_SUPERVISOR_CWD => ${spec.cwd}\n LCM_SUPERVISOR_ENTRYPOINT => ${spec.entrypoint}\n LCM_SUPERVISOR_RUNTIME_DIGEST => ${spec.runtimeDigest}\n LCM_SUPERVISOR_STORAGE_BACKEND => ${spec.storageBackend}\n}`;
    const runner = fakeRunner([
      { code: 1, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrap" },
      { code: 0, stdout: running },
    ]);
    const supervisor = createSupervisor("launchd-user", { run: runner.run, platform: "darwin", uid: 501 });
    expect(await supervisor.start(spec)).toMatchObject({ kind: "launchd-user", managerPid: 543 });
    const plist = join(root, `daemon.${spec.shortDigest}.${spec.nonce}.plist`);
    const document = readFileSync(plist, "utf8");
    expect(document).toContain(`<key>Label</key><string>${spec.launchdLabel}</string>`);
    expect(document).not.toContain("KeepAlive");
    expect(lstatSync(plist).mode & 0o777).toBe(0o600);
    expect(runner.calls[1]).toMatchObject({ command: "launchctl", args: ["bootstrap", "gui/501", plist] });

    const stopRunner = fakeRunner([
      { code: 0, stdout: running },
      { code: 0, stdout: "bootout" },
      { code: 1, stderr: "Could not find service" },
    ]);
    await expect(createSupervisor("launchd-user", { run: stopRunner.run, platform: "darwin", uid: 501 }).stopAndAwaitAbsent(spec)).resolves.toBeUndefined();
    expect(stopRunner.calls[1].args).toEqual(["bootout", `gui/501/${spec.launchdLabel}`]);
  });

  it("refuses unsupported platforms and unsafe credential references", async () => {
    const spec = makeSpec("launchd-user");
    const unsupported = createSupervisor("launchd-user", { run: vi.fn(), platform: "linux", uid: 501 });
    await expect(unsupported.start(spec)).rejects.toThrow("unavailable");
    const unsafe = makeSpec("launchd-user", spec.stateRoot, { credentialDirectory: spec.stateRoot, credentialFiles: [{ name: "OPENAI_API_KEY", path: join(spec.stateRoot, "secret") }] });
    const supervisor = createSupervisor("launchd-user", { run: vi.fn(async () => ({ code: 1, stderr: "Could not find service" })), platform: "darwin", uid: 501 });
    await expect(supervisor.start(unsafe)).rejects.toThrow("credential");
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
      { code: 1, stderr: "Could not find service" },
      { code: 1, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: running },
    ]);
    const supervisor = createSupervisor("launchd-user", { run: runner.run, platform: "darwin", uid: 501 });
    await expect(supervisor.start(spec)).resolves.toMatchObject({ managerPid: 777 });

    const second = fakeRunner([
      { code: 1, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrapped" },
      { code: 1, stderr: "Could not find service" },
    ]);
    await expect(createSupervisor("launchd-user", { run: second.run, platform: "darwin", uid: 501 }).start(spec)).rejects.toThrow("manager command");

    const badPlist = join(root, `daemon.${spec.shortDigest}.${spec.nonce}.plist`);
    writeFileSync(badPlist, "foreign", { mode: 0o644 });
    const collision = fakeRunner([{ code: 1, stderr: "Could not find service" }, { code: 1, stderr: "Could not find service" }]);
    await expect(createSupervisor("launchd-user", { run: collision.run, platform: "darwin", uid: 501 }).start(spec)).rejects.toThrow("manager command");
    rmSync(badPlist, { force: true });

    writeFileSync(badPlist, "foreign", { mode: 0o600 });
    chmodSync(badPlist, 0o644);
    const modeCollision = fakeRunner([{ code: 1, stderr: "Could not find service" }]);
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

    const absentStop = fakeRunner([{ code: 1, stderr: "Could not find service" }]);
    await expect(createSupervisor("launchd-user", { run: absentStop.run, platform: "darwin", uid: 501 }).stopAndAwaitAbsent(spec)).resolves.toBeUndefined();

    const unavailableRestart = fakeRunner([{ code: 127, stderr: "launchctl not found" }]);
    await expect(createSupervisor("launchd-user", { run: unavailableRestart.run, platform: "darwin", uid: 501 }).stopAndStart(spec)).rejects.toThrow("unavailable");

    const unsafeRestart = makeSpec("launchd-user", root, { credentialDirectory: root, credentialFiles: [{ name: "OPENAI_API_KEY", path: join(root, "not-private") }] });
    const unsafeRestartRunner = fakeRunner([]);
    await expect(createSupervisor("launchd-user", { run: unsafeRestartRunner.run, platform: "darwin", uid: 501 }).stopAndStart(unsafeRestart)).rejects.toThrow("credential");
    expect(unsafeRestartRunner.calls).toHaveLength(0);
  });

  it("removes only the authenticated old launchd plist during stale-config repair", async () => {
    const root = makeRoot();
    const oldSpec = makeSpec("launchd-user", root, { nonce: "old-nonce", port: 3737 });
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
    ].join("\n");
    const oldRunner = fakeRunner([
      { code: 1, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: running },
    ]);
    await createSupervisor("launchd-user", { run: oldRunner.run, platform: "darwin", uid: 501 }).start(oldSpec);
    const oldPlist = join(root, `daemon.${oldSpec.shortDigest}.${oldSpec.nonce}.plist`);
    expect(lstatSync(oldPlist).isFile()).toBe(true);
    const foreignPlist = join(root, `daemon.${oldSpec.shortDigest}.foreign.plist`);
    writeFileSync(foreignPlist, "foreign", { mode: 0o600 });
    const newSpec = makeSpec("launchd-user", root, { nonce: "new-nonce", port: 4747 });
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
      { code: 1, stderr: "Could not find service" },
      { code: 1, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: running
        .replaceAll(oldSpec.port.toString(), newSpec.port.toString())
        .replaceAll(oldSpec.nonce, newSpec.nonce) },
    ]);
    await expect(createSupervisor("launchd-user", { run: stopRunner.run, platform: "darwin", uid: 501 }).stopAndStart(newSpec)).resolves.toMatchObject({ managerPid: 777 });
    expect(existsSync(oldPlist)).toBe(false);
    expect(existsSync(foreignPlist)).toBe(true);
  });
});
