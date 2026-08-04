import {
  chmodSync,
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
    `Environment=LCM_SUPERVISOR_MARKER=${spec.marker} LCM_SUPERVISOR_SCOPE=${spec.scopeDigest} LCM_SUPERVISOR_PORT=${spec.port} LCM_SUPERVISOR_NONCE=${spec.nonce}`,
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
    expect(() => validateManagedCredentialDirectory(directory, root)).toThrow("validation");
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    rmSync(file);
    writeFileSync(join(directory, "unknown"), "x", { mode: 0o600 });
    expect(() => validateManagedCredentialDirectory(directory, root)).toThrow("unsupported");
    rmSync(join(directory, "unknown"));
    expect(() => createManagedCredentialDirectory(root, "bad nonce")).toThrow("nonce");
    expect(() => validateManagedCredentialDirectory(join(root, "missing"), root)).toThrow("unavailable");
    expect(() => cleanupManagedCredentialDirectory(join(root, "missing"), root)).not.toThrow();
    expect(() => validateManagedCredentialDirectory(root, root)).toThrow("escapes");
    expect(() => cleanupManagedCredentialDirectory(root, root)).toThrow("escapes");
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
    ];
    const runner = fakeRunner(responses);
    const supervisor = createSupervisor("systemd-user", { run: runner.run, platform: "linux" });
    expect((await supervisor.probe(spec)).kind).toBe("unavailable");
    expect((await supervisor.probe(spec)).kind).toBe("absent");
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-running-valid", managerPid: 111 });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-not-running-valid", terminal: "inactive" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-stale-config" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "registered-invalid-collision" });
    expect(await supervisor.probe(spec)).toMatchObject({ kind: "ambiguous" });
    expect(runner.calls.every((call) => call.timeoutMs === 5_000)).toBe(true);
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
});

describe("launchd-user supervisor", () => {
  it("writes a private plist without KeepAlive and uses gui UID bootstrap/print/bootout", async () => {
    const root = makeRoot();
    const credentialDirectory = createManagedCredentialDirectory(root, "launch-003");
    const files = writeManagedCredentialFiles(credentialDirectory, { OPENAI_API_KEY: "secret" });
    const spec = makeSpec("launchd-user", root, { credentialDirectory, credentialFiles: [{ name: "OPENAI_API_KEY", path: files[0] }] });
    const running = `state = running\npid = 543\nenvironment = {\n LCM_SUPERVISOR_MARKER => ${spec.marker}\n LCM_SUPERVISOR_SCOPE => ${spec.scopeDigest}\n LCM_SUPERVISOR_PORT => ${spec.port}\n LCM_SUPERVISOR_NONCE => ${spec.nonce}\n}`;
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
    expect(stopRunner.calls[1].args).toEqual(["bootout", "gui/501", `gui/501/${spec.launchdLabel}`]);
  });

  it("refuses unsupported platforms and unsafe credential references", async () => {
    const spec = makeSpec("launchd-user");
    const unsupported = createSupervisor("launchd-user", { run: vi.fn(), platform: "linux", uid: 501 });
    await expect(unsupported.start(spec)).rejects.toThrow("unavailable");
    const unsafe = makeSpec("launchd-user", spec.stateRoot, { credentialDirectory: spec.stateRoot, credentialFiles: [{ name: "OPENAI_API_KEY", path: join(spec.stateRoot, "secret") }] });
    const supervisor = createSupervisor("launchd-user", { run: vi.fn(async () => ({ code: 1, stderr: "Could not find service" })), platform: "darwin", uid: 501 });
    await expect(supervisor.start(unsafe)).rejects.toThrow("credential");
  });
});
