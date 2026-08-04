import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsFaults = vi.hoisted(() => ({
  write: false,
  unlink: false,
  open: false,
  openCode: undefined as string | undefined,
  close: false,
  lstatPath: undefined as string | undefined,
  lstatHits: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      if (fsFaults.write) throw new Error("short write");
      return actual.writeSync(...args);
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (fsFaults.open) {
        const error = new Error("open unavailable") as NodeJS.ErrnoException;
        if (fsFaults.openCode !== undefined) error.code = fsFaults.openCode;
        throw error;
      }
      return actual.openSync(...args);
    },
    closeSync: (...args: Parameters<typeof actual.closeSync>) => {
      if (fsFaults.close) throw new Error("close unavailable");
      return actual.closeSync(...args);
    },
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      const stats = actual.lstatSync(...args);
      if (fsFaults.lstatPath !== undefined && String(args[0]) === fsFaults.lstatPath && ++fsFaults.lstatHits >= 3) {
        const adjusted = Object.create(Object.getPrototypeOf(stats)) as typeof stats;
        Object.assign(adjusted, stats, { mode: 0o644 });
        Object.defineProperty(adjusted, "isSymbolicLink", { value: () => false });
        Object.defineProperty(adjusted, "isFile", { value: () => true });
        return adjusted;
      }
      return stats;
    },
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      if (fsFaults.unlink) throw new Error("unlink unavailable");
      return actual.unlinkSync(...args);
    },
  };
});
import {
  cleanupManagedCredentialDirectory,
  createManagedCredentialDirectory,
  writeManagedCredentialFiles,
} from "../../src/daemon/managed-credentials.js";
import {
  createSupervisor,
  createSupervisorSpec,
  type SupervisorKind,
  type SupervisorSpec,
} from "../../src/daemon/supervisor.js";

type CommandResult = Readonly<{
  code?: number | null;
  status?: number | null;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}>;

const roots: string[] = [];
const DIGEST_A = "a".repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-supervisor-coverage-"));
  roots.push(value);
  return value;
}

function spec(kind: SupervisorKind, stateRoot = root(), overrides: Partial<SupervisorSpec> = {}): SupervisorSpec {
  return createSupervisorSpec({
    kind,
    stateRoot,
    port: 3737,
    nonce: "coverage-nonce",
    executable: "/usr/bin/node",
    args: ["daemon", "run-managed"],
    ...overrides,
  });
}

function runQueue(results: readonly CommandResult[]): {
  readonly run: ReturnType<typeof vi.fn>;
  readonly calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }>;
} {
  const queue = [...results];
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = [];
  const run = vi.fn(async (command: string, args: readonly string[], options: { timeoutMs: number }) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    return queue.shift() ?? { code: 0, stdout: "", stderr: "" };
  });
  return { run, calls };
}

function systemdText(
  value: SupervisorSpec,
  state = "active",
  pid = 123,
  extra = "",
): string {
  return [
    "LoadState=loaded",
    `ActiveState=${state}`,
    `SubState=${state === "active" ? "running" : state}`,
    `MainPID=${state === "active" ? pid : 0}`,
    `Environment=LCM_SUPERVISOR_MARKER=${value.marker} LCM_SUPERVISOR_SCOPE=${value.scopeDigest} LCM_SUPERVISOR_PORT=${value.port} LCM_SUPERVISOR_NONCE=${value.nonce} LCM_SUPERVISOR_EXECUTABLE=${value.executable} LCM_SUPERVISOR_ARGS=${JSON.stringify(value.args)} LCM_SUPERVISOR_CWD=${value.cwd ?? ""}${extra}`,
  ].join("\n");
}

function launchdText(value: SupervisorSpec, state = "running", pid = 123, extra = ""): string {
  return [
    `state = ${state}`,
    `pid = ${state === "running" ? pid : 0}`,
    `LCM_SUPERVISOR_MARKER => ${value.marker}`,
    `LCM_SUPERVISOR_SCOPE => ${value.scopeDigest}`,
    `LCM_SUPERVISOR_PORT => ${value.port}`,
    `LCM_SUPERVISOR_NONCE => ${value.nonce}`,
    `LCM_SUPERVISOR_EXECUTABLE => ${value.executable}`,
    `LCM_SUPERVISOR_ARGS => ${JSON.stringify(value.args)}`,
    `LCM_SUPERVISOR_CWD => ${value.cwd ?? ""}`,
    value.entrypoint === undefined ? "" : `LCM_SUPERVISOR_ENTRYPOINT => ${value.entrypoint}`,
    value.runtimeDigest === undefined ? "" : `LCM_SUPERVISOR_RUNTIME_DIGEST => ${value.runtimeDigest}`,
    value.storageBackend === undefined ? "" : `LCM_SUPERVISOR_STORAGE_BACKEND => ${value.storageBackend}`,
    extra,
  ].join("\n");
}

type PlistRacePhase = "before-open" | "after-read" | "before-unlink";

function plistRace(
  expectedPhase: PlistRacePhase,
  replacement: string,
  removeOnly = false,
): {
  readonly dependencies: {
    readonly _plistRaceForTesting: (path: string, phase: PlistRacePhase) => void;
  };
  readonly wasTriggered: () => boolean;
} {
  let triggered = false;
  return {
    dependencies: {
      _plistRaceForTesting: (path, phase) => {
        if (triggered || phase !== expectedPhase) return;
        triggered = true;
        if (removeOnly) {
          rmSync(path, { force: true });
          return;
        }
        const replacementPath = `${path}.replacement`;
        writeFileSync(replacementPath, replacement, { flag: "wx", mode: 0o600 });
        chmodSync(replacementPath, 0o600);
        renameSync(replacementPath, path);
      },
    },
    wasTriggered: () => triggered,
  };
}

describe("supervisor coverage: validation and bounded parsing", () => {
  it("fails closed for an unknown preflight reason at the runtime boundary", async () => {
    const { isSupervisorPreflightUnavailableReason } = await import("../../src/daemon/supervisor.js");
    expect(isSupervisorPreflightUnavailableReason("unknown" as never)).toBe(false);
  });

  it("exercises every metadata and argument validation boundary", () => {
    const stateRoot = root();
    const path = `/${"p".repeat(4095)}`;
    expect(createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 0, executable: "/bin/node", args: [] }).port).toBe(0);
    expect(createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 65_535, executable: "/bin/node", args: [] }).port).toBe(65_535);
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot, port: Number.NaN, executable: "/bin/node" })).toThrow("port");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 1, executable: "/bin/node", nonce: "" })).toThrow("nonce");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 1, executable: "/bin/node", nonce: "x".repeat(129) })).toThrow("nonce");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 1, executable: "/bin/node", args: [1 as unknown as string] })).toThrow("argument");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 1, executable: "/bin/node", args: new Array(129).fill("x") })).toThrow("argument");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 1, executable: "/bin/node", storageBackend: "" })).toThrow("metadata");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 1, executable: "/bin/node", storageBackend: "x".repeat(513) })).toThrow("metadata");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 1, executable: "/bin/node", storageBackend: "bad\nvalue" })).toThrow("metadata");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 1, executable: "/bin/node", entrypoint: "bad\rvalue" })).toThrow("metadata");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 1, executable: "/bin/node", postgresCaFile: "relative.crt" })).toThrow("CA file");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 1, executable: "/bin/node", postgresCaFile: "/tmp/ca\nfile" })).toThrow("CA file");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 1, executable: "/bin/node", cwd: path, entrypoint: path, credentialDirectory: path, credentialFiles: [{ name: "OPENAI_API_KEY", path }] })).not.toThrow();
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 1, executable: "/bin/node", credentialFiles: [{ name: "", path: "/tmp/credential" }] })).toThrow("credential name");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 1, executable: "/bin/node", credentialFiles: [{ name: "OPENAI_API_KEY", path: "/tmp/\ncredential" }] })).toThrow("credential");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 1, executable: "/bin/node", credentialDirectory: "" })).toThrow("credential directory");
    expect(() => createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 1, executable: "/bin/node", stopTimeoutMs: 60_001 })).toThrow("timeout");
    expect(createSupervisorSpec({ kind: "systemd-user", stateRoot, port: 1, executable: "/bin/node", nonce: undefined }).nonce).toMatch(/^[A-Za-z0-9]/u);
  });

  it("handles command result aliases, bounded output, and unavailable reason text", async () => {
    const value = spec("systemd-user");
    const outputs: CommandResult[] = [
      { code: null, stdout: "", stderr: "failed to connect to bus" },
      { status: null, stdout: "", stderr: "no user manager" },
      { exitCode: null, stdout: "", stderr: "unexpected" },
      {},
      { code: 1, stdout: "", stderr: "connection refused" },
    ];
    const runner = runQueue(outputs);
    const supervisor = createSupervisor("systemd-user", { run: runner.run, platform: "linux" });
    await expect(supervisor.probe(value)).resolves.toMatchObject({ kind: "unavailable", reason: "manager-unavailable" });
    await expect(supervisor.probe(value)).resolves.toMatchObject({ kind: "unavailable", reason: "manager-unavailable" });
    await expect(supervisor.probe(value)).resolves.toMatchObject({ kind: "unavailable", reason: "manager-command-failed" });
    await expect(supervisor.probe(value)).resolves.toMatchObject({ kind: "ambiguous", reason: "metadata-malformed" });
    await expect(supervisor.probe(value)).resolves.toMatchObject({ kind: "unavailable", reason: "manager-unavailable" });
  });

  it("decodes quoted assignment escapes and rejects malformed assignment tokens", async () => {
    const value = spec("systemd-user");
    const escaped = ["a", "b", "e", "f", "n", "r", "s", "t", "v", "x41"].map((item) => `LCM_PADDING_${item}=\\${item}`).join(" ");
    const environment = `LCM_SUPERVISOR_MARKER=${value.marker} LCM_SUPERVISOR_SCOPE=${value.scopeDigest} LCM_SUPERVISOR_PORT=${value.port} LCM_SUPERVISOR_NONCE=${value.nonce} LCM_SUPERVISOR_EXECUTABLE=${value.executable} LCM_SUPERVISOR_ARGS=${JSON.stringify(value.args)} LCM_SUPERVISOR_CWD= ${escaped}`;
    const malformed = [
      `Environment="LCM_SUPERVISOR_MARKER=${value.marker}unterminated`,
      "Environment=LCM_SUPERVISOR_MARKER=bad\\x",
      "Environment=LCM_SUPERVISOR_MARKER=bad\\xzz",
      "Environment=LCM_SUPERVISOR_MARKER=valueOther=broken",
      "Environment=1BAD=value",
      "Environment=LCM_SUPERVISOR_MARKER=value LCM_SUPERVISOR_MARKER=value",
      `Environment="LCM_SUPERVISOR_MARKER=${value.marker}"tail`,
      "Environment=LCM_SUPERVISOR_MARKER",
      "Environment==value",
      "Environment=LCM_PADDING=foo\\",
      "Environment=\"bad\"",
      "Environment=LCM_PADDING=\"foo\"tail",
      "Environment=",
      "{\"environment\":\"\\\"bad\\\"\"}",
      "{\"environment\":\"\"}",
      `{"environment":"${Array.from({ length: 129 }, (_, index) => `\"K${index}=x\"`).join(" ")}"}`,
    ];
    const runner = runQueue([
      { code: 0, stdout: `LoadState=loaded\nActiveState=active\nMainPID=123\nEnvironment=${environment}` },
      ...malformed.map((text) => ({ code: 0, stdout: `LoadState=loaded\nActiveState=active\nMainPID=123\n${text}` })),
    ]);
    const supervisor = createSupervisor("systemd-user", { run: runner.run, platform: "linux" });
    await expect(supervisor.probe(value)).resolves.toMatchObject({ kind: "registered-running-valid", managerPid: 123 });
    for (let index = 0; index < malformed.length; index += 1) {
      const observed = await supervisor.probe(value);
      expect(observed.kind).not.toBe("registered-running-valid");
    }
    const manyAssignments = Array.from({ length: 129 }, (_, index) => `K${index}=x`).join(" ");
    const countRunner = runQueue([{ code: 0, stdout: `LoadState=loaded\nActiveState=active\nMainPID=123\nEnvironment=${manyAssignments}` }]);
    expect((await createSupervisor("systemd-user", { run: countRunner.run, platform: "linux" }).probe(value)).kind).not.toBe("registered-running-valid");
    const jsonCases = [
      { environment: "\"bad\"" },
      { environment: "'bad'" },
      { environment: "KEY=x KEY=x" },
      { environment: "\"KEY=x\" \"KEY=x\"" },
      { environment: "" },
      { environment: "   " },
      { environment: `${String.fromCharCode(34)}LCM_PADDING=foo${String.fromCharCode(92)}` },
      { environment: Array.from({ length: 129 }, (_, index) => `\"K${index}=x\"`).join(" ") },
    ];
    const jsonRunner = runQueue(jsonCases.map((payload) => ({ code: 0, stdout: JSON.stringify(payload) })));
    const jsonSupervisor = createSupervisor("systemd-user", { run: jsonRunner.run, platform: "linux" });
    for (let index = 0; index < jsonCases.length; index += 1) {
      expect((await jsonSupervisor.probe(value)).kind).not.toBe("registered-running-valid");
    }
  });

  it("exercises parser byte ceilings after the command-output seam", async () => {
    const value = spec("systemd-user");
    const originalByteLength = Buffer.byteLength;
    const byteLength = vi.spyOn(Buffer, "byteLength").mockImplementation((input: string | NodeJS.TypedArray | ArrayBufferLike, encoding?: BufferEncoding): number => {
      if (typeof input === "string" && input.length === 1) return 1_000;
      return originalByteLength(input as never, encoding);
    });
    try {
      const plain = `LCM_PADDING=${"x".repeat(500)}`;
      const escaped = `LCM_PADDING=${"\\x41".repeat(500)}`;
      const quoted = `\"LCM_PADDING=${"x".repeat(500)}\"`;
      const quotedEscaped = `\"LCM_PADDING=${"\\x41".repeat(500)}\"`;
      const runner = runQueue([plain, escaped, quoted, quotedEscaped].map((environment) => ({ code: 0, stdout: JSON.stringify({ environment }) })));
      const supervisor = createSupervisor("systemd-user", { run: runner.run, platform: "linux" });
      await expect(supervisor.probe(value)).resolves.not.toMatchObject({ kind: "registered-running-valid" });
      await expect(supervisor.probe(value)).resolves.not.toMatchObject({ kind: "registered-running-valid" });
      await expect(supervisor.probe(value)).resolves.not.toMatchObject({ kind: "registered-running-valid" });
      await expect(supervisor.probe(value)).resolves.not.toMatchObject({ kind: "registered-running-valid" });
    } finally {
      byteLength.mockRestore();
    }
  }, 60_000);

  it("keeps parser per-key limits strict and handles JSON flattening failures", async () => {
    const value = spec("systemd-user");
    const common = `LoadState=loaded\nActiveState=active\nMainPID=321\nEnvironment=LCM_SUPERVISOR_MARKER=${value.marker} LCM_SUPERVISOR_SCOPE=${value.scopeDigest} LCM_SUPERVISOR_PORT=${value.port} LCM_SUPERVISOR_NONCE=${value.nonce} LCM_SUPERVISOR_EXECUTABLE=${value.executable} LCM_SUPERVISOR_ARGS=${JSON.stringify(value.args)} LCM_SUPERVISOR_CWD=`;
    const cases = [
      common.replace(`LCM_SUPERVISOR_PORT=${value.port}`, `LCM_SUPERVISOR_PORT=${"9".repeat(6)}`),
      common.replace(`LCM_SUPERVISOR_NONCE=${value.nonce}`, `LCM_SUPERVISOR_NONCE=${"x".repeat(129)}`),
      common.replace(`LCM_SUPERVISOR_SCOPE=${value.scopeDigest}`, `LCM_SUPERVISOR_SCOPE=${"a".repeat(65)}`),
      common.replace(`LCM_SUPERVISOR_MARKER=${value.marker}`, `LCM_SUPERVISOR_MARKER=${"x".repeat(40)}`),
      common.replace(`LCM_SUPERVISOR_EXECUTABLE=${value.executable}`, `LCM_SUPERVISOR_EXECUTABLE=/${"x".repeat(4096)}`),
      common.replace(`LCM_SUPERVISOR_ARGS=${JSON.stringify(value.args)}`, `LCM_SUPERVISOR_ARGS=${JSON.stringify(["x".repeat(70_000)])}`),
      "{invalid json",
      "[1, {\"environment\": {\"LCM_SUPERVISOR_MARKER\": \"x\"}}]",
    ];
    const runner = runQueue(cases.map((stdout) => ({ code: 0, stdout })));
    const supervisor = createSupervisor("systemd-user", { run: runner.run, platform: "linux" });
    for (let index = 0; index < cases.length; index += 1) {
      expect((await supervisor.probe(value)).kind).not.toBe("registered-running-valid");
    }
  });
});

describe("supervisor coverage: manager states and lifecycle boundaries", () => {
  it("covers optional stale metadata paths and all numeric identity refusals", async () => {
    const value = spec("systemd-user", root(), { cwd: "/tmp", entrypoint: "entry", runtimeDigest: DIGEST_A, storageBackend: "sqlite" });
    const complete = systemdText(value, "inactive", 0, ` LCM_SUPERVISOR_ENTRYPOINT=${value.entrypoint} LCM_SUPERVISOR_RUNTIME_DIGEST=${value.runtimeDigest} LCM_SUPERVISOR_STORAGE_BACKEND=${value.storageBackend}`);
    const cases = [
      complete.replace(`LCM_SUPERVISOR_CWD=${value.cwd}`, ""),
      complete.replace("LCM_SUPERVISOR_ENTRYPOINT=entry", ""),
      complete.replace(`LCM_SUPERVISOR_RUNTIME_DIGEST=${DIGEST_A}`, ""),
      complete.replace("LCM_SUPERVISOR_STORAGE_BACKEND=sqlite", ""),
      complete.replace("MainPID=0", "MainPID=999"),
      complete.replace("MainPID=0", "MainPID=not-a-pid"),
      complete.replace("ActiveState=inactive", "ActiveState=unknown"),
      complete.replace("SubState=inactive", "SubState=running"),
      complete.replace(`LCM_SUPERVISOR_CWD=${value.cwd}`, "LCM_SUPERVISOR_CWD=/other"),
      complete.replace("LCM_SUPERVISOR_ENTRYPOINT=entry", "LCM_SUPERVISOR_ENTRYPOINT=old"),
      complete.replace(`LCM_SUPERVISOR_RUNTIME_DIGEST=${DIGEST_A}`, `LCM_SUPERVISOR_RUNTIME_DIGEST=${"b".repeat(64)}`),
      complete.replace("LCM_SUPERVISOR_STORAGE_BACKEND=sqlite", "LCM_SUPERVISOR_STORAGE_BACKEND=postgresql"),
    ];
    const runner = runQueue(cases.map((stdout) => ({ code: 0, stdout })));
    const supervisor = createSupervisor("systemd-user", { run: runner.run, platform: "linux" });
    expect(await supervisor.probe(value)).toMatchObject({ kind: "registered-stale-config", reason: "metadata-missing" });
    expect(await supervisor.probe(value)).toMatchObject({ kind: "registered-stale-config", reason: "metadata-missing" });
    expect(await supervisor.probe(value)).toMatchObject({ kind: "registered-stale-config", reason: "metadata-missing" });
    expect(await supervisor.probe(value)).toMatchObject({ kind: "registered-stale-config", reason: "metadata-missing" });
    expect(await supervisor.probe(value)).toMatchObject({ kind: "ambiguous", reason: "state-conflict" });
    expect(await supervisor.probe(value)).toMatchObject({ kind: "ambiguous", reason: "pid-invalid" });
    expect(await supervisor.probe(value)).toMatchObject({ kind: "registered-not-running-valid", terminal: "inactive" });
    expect(await supervisor.probe(value)).toMatchObject({ kind: "ambiguous", reason: "state-conflict" });
    expect(await supervisor.probe(value)).toMatchObject({ kind: "registered-stale-config", reason: "metadata-mismatch" });
    expect(await supervisor.probe(value)).toMatchObject({ kind: "registered-stale-config", reason: "metadata-mismatch" });
    expect(await supervisor.probe(value)).toMatchObject({ kind: "registered-stale-config", reason: "metadata-mismatch" });
    expect(await supervisor.probe(value)).toMatchObject({ kind: "registered-stale-config", reason: "metadata-mismatch" });
    const directOptional = [
      "LCM_SUPERVISOR_CWD=/other",
      "LCM_SUPERVISOR_ENTRYPOINT=old",
      `LCM_SUPERVISOR_RUNTIME_DIGEST=${"b".repeat(64)}`,
      "LCM_SUPERVISOR_STORAGE_BACKEND=postgresql",
    ];
    const directRunner = runQueue(directOptional.map((field) => ({ code: 0, stdout: `${systemdText(value, "inactive")}\nLCM_SUPERVISOR_CWD=/tmp\n${field}` })));
    const directSupervisor = createSupervisor("systemd-user", { run: directRunner.run, platform: "linux" });
    for (const field of directOptional) {
      const observed = await directSupervisor.probe(value);
      expect(observed).toMatchObject({ kind: "registered-stale-config", reason: "metadata-mismatch" });
      expect(observed.cwd).toBe(field.includes("CWD") ? "/other" : "/tmp");
      if (field.includes("ENTRYPOINT")) expect(observed.entrypoint).toBe("old");
      if (field.includes("RUNTIME_DIGEST")) expect(observed.runtimeDigest).toBe("b".repeat(64));
      if (field.includes("STORAGE_BACKEND")) expect(observed.storageBackend).toBe("postgresql");
    }
    const environmentOptional = [
      " LCM_SUPERVISOR_ENTRYPOINT=old",
      ` LCM_SUPERVISOR_RUNTIME_DIGEST=${"b".repeat(64)}`,
      " LCM_SUPERVISOR_STORAGE_BACKEND=postgresql",
    ];
    const environmentRunner = runQueue(environmentOptional.map((extra) => ({ code: 0, stdout: systemdText(value, "inactive", 0, extra) })));
    const environmentSupervisor = createSupervisor("systemd-user", { run: environmentRunner.run, platform: "linux" });
    for (const extra of environmentOptional) {
      const observed = await environmentSupervisor.probe(value);
      expect(observed).toMatchObject({ kind: "registered-stale-config", reason: "metadata-mismatch", cwd: "/tmp" });
      if (extra.includes("ENTRYPOINT")) expect(observed.entrypoint).toBe("old");
      if (extra.includes("RUNTIME_DIGEST")) expect(observed.runtimeDigest).toBe("b".repeat(64));
      if (extra.includes("STORAGE_BACKEND")) expect(observed.storageBackend).toBe("postgresql");
    }
    const dynamicOptionalCases: Array<readonly [keyof SupervisorSpec, string]> = [
      ["entrypoint", "old"],
      ["runtimeDigest", "b".repeat(64)],
      ["storageBackend", "postgresql"],
    ];
    for (const [field, observedValue] of dynamicOptionalCases) {
      const dynamicOptional = { ...value } as SupervisorSpec & Record<string, unknown>;
      Object.defineProperty(dynamicOptional, field, { configurable: true, get: () => field === "entrypoint" ? "entry" : field === "runtimeDigest" ? DIGEST_A : "sqlite" });
      const key = field === "entrypoint" ? "LCM_SUPERVISOR_ENTRYPOINT" : field === "runtimeDigest" ? "LCM_SUPERVISOR_RUNTIME_DIGEST" : "LCM_SUPERVISOR_STORAGE_BACKEND";
      const runner = runQueue([{ code: 0, stdout: systemdText(value, "inactive", 0, ` ${key}=${observedValue}`) }]);
      await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).probe(dynamicOptional)).resolves.toMatchObject({ kind: "registered-stale-config", reason: "metadata-mismatch" });
    }
    const numericSpec = spec("systemd-user");
    const zeroPid = runQueue([{ code: 0, stdout: systemdText(numericSpec, "active", 0) }]);
    await expect(createSupervisor("systemd-user", { run: zeroPid.run, platform: "linux" }).probe(numericSpec)).resolves.toMatchObject({ kind: "ambiguous", reason: "pid-missing" });
    const overPort = runQueue([{ code: 0, stdout: systemdText(numericSpec, "active", 1).replace(`LCM_SUPERVISOR_PORT=${numericSpec.port}`, "LCM_SUPERVISOR_PORT=65536") }]);
    await expect(createSupervisor("systemd-user", { run: overPort.run, platform: "linux" }).probe(numericSpec)).resolves.not.toMatchObject({ kind: "registered-running-valid" });
    const optionalOnUnconfigured = [
      " LCM_SUPERVISOR_ENTRYPOINT=old",
      ` LCM_SUPERVISOR_RUNTIME_DIGEST=${"b".repeat(64)}`,
      " LCM_SUPERVISOR_STORAGE_BACKEND=postgresql",
    ];
    const unconfiguredRunner = runQueue(optionalOnUnconfigured.map((extra) => ({ code: 0, stdout: systemdText(numericSpec, "inactive", 0, extra) })));
    const unconfiguredSupervisor = createSupervisor("systemd-user", { run: unconfiguredRunner.run, platform: "linux" });
    for (let index = 0; index < optionalOnUnconfigured.length; index += 1) {
      expect(await unconfiguredSupervisor.probe(numericSpec)).toMatchObject({ kind: "registered-stale-config", reason: "metadata-mismatch" });
    }

    const originalTest = RegExp.prototype.test;
    const regex = vi.spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, input: string): boolean {
      if (this.source === "^[A-Za-z][A-Za-z0-9_.-]*$" && input === "LCM_PADDING") return false;
      return originalTest.call(this, input);
    });
    try {
      const malformedKey = runQueue([{ code: 0, stdout: JSON.stringify({ environment: "LCM_PADDING=x" }) }]);
    expect((await createSupervisor("systemd-user", { run: malformedKey.run, platform: "linux" }).probe(numericSpec)).kind).not.toBe("registered-running-valid");
    } finally {
      regex.mockRestore();
    }

    let cwdReads = 0;
    const dynamic = { ...numericSpec } as SupervisorSpec & { cwd?: string };
    Object.defineProperty(dynamic, "cwd", { configurable: true, get: () => (++cwdReads === 1 ? "/expected" : undefined) });
    const dynamicRunner = runQueue([{ code: 0, stdout: `${systemdText(numericSpec, "inactive")}\nLCM_SUPERVISOR_CWD=` }]);
    await expect(createSupervisor("systemd-user", { run: dynamicRunner.run, platform: "linux" }).probe(dynamic)).resolves.toMatchObject({ kind: "registered-not-running-valid", terminal: "inactive" });
  });

  it("distinguishes launchd terminal, missing manager, unsupported platform, and uid fences", async () => {
    const value = spec("launchd-user");
    const terminal = launchdText(value, "not running", 0, "last exit code = 36");
    await expect(createSupervisor("launchd-user", { run: runQueue([{ code: 0, stdout: terminal }]).run, platform: "darwin", uid: 501 }).probe(value)).resolves.toMatchObject({ kind: "registered-not-running-valid", terminal: "inactive" });
    await expect(createSupervisor("launchd-user", { run: runQueue([{ code: 0, stdout: terminal.replace("state = not running\n", "") }]).run, platform: "darwin", uid: 501 }).probe(value)).resolves.toMatchObject({ kind: "registered-not-running-valid", terminal: "last-exit" });
    await expect(createSupervisor("launchd-user", { run: runQueue([{ code: 127, stderr: "launchctl not found" }]).run, platform: "darwin", uid: 501 }).probe(value)).resolves.toMatchObject({ kind: "unavailable", reason: "manager-not-found" });
    await expect(createSupervisor("launchd-user", { run: runQueue([{ code: 1, stderr: "no medium" }]).run, platform: "darwin", uid: 501 }).probe(value)).resolves.toMatchObject({ kind: "unavailable", reason: "manager-unavailable" });
    await expect(createSupervisor("launchd-user", { run: vi.fn(), uid: 501 }).probe(value)).resolves.toMatchObject({ kind: "unavailable", reason: "unsupported-platform" });
    await expect(createSupervisor("launchd-user", { run: vi.fn(), platform: "darwin", uid: -1 }).probe(value)).resolves.toMatchObject({ kind: "unavailable", reason: "manager-unavailable" });
    await expect(createSupervisor("launchd-user", { run: vi.fn(async () => ({ code: 0, stdout: terminal })), platform: "darwin", uid: Number.NaN }).probe(value)).rejects.toThrow("uid");
  });

  it("covers start mutation timeout, immediate terminal retry, bounded polling, and runner errors", async () => {
    const value = spec("systemd-user");
    const commandFailed = runQueue([{ code: 1, stderr: "Unit is not-found" }, { code: 1, stderr: "permission denied" }, { code: 1, stderr: "Unit is not-found" }]);
    await expect(createSupervisor("systemd-user", { run: commandFailed.run, platform: "linux" }).start(value)).rejects.toThrow("manager command");
    const timeout = runQueue([{ code: 1, stderr: "Unit is not-found" }, { timedOut: true }, { code: 1, stderr: "Unit is not-found" }]);
    await expect(createSupervisor("systemd-user", { run: timeout.run, platform: "linux" }).start(value)).rejects.toThrow("manager command");
    const immediateTerminal = runQueue([
      { code: 0, stdout: systemdText(value, "inactive") },
      { code: 0, stdout: "stopped" },
      { code: 1, stderr: "Unit is not-found" },
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: systemdText(value, "inactive") },
      { code: 0, stdout: systemdText(value, "inactive") },
    ]);
    await expect(createSupervisor("systemd-user", { run: immediateTerminal.run, platform: "linux" }).start(value)).rejects.toThrow("manager command");
    const terminalTwice = runQueue([
      { code: 0, stdout: systemdText(value, "inactive") },
      { code: 0, stdout: systemdText(value, "inactive") },
      { code: 0, stdout: "stopped" },
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: systemdText(value, "inactive") },
    ]);
    await expect(createSupervisor("systemd-user", { run: terminalTwice.run, platform: "linux" }).start(value)).rejects.toThrow("manager command");
    const terminalAfterMutation = runQueue([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: systemdText(value, "inactive") },
      { code: 0, stdout: systemdText(value, "inactive") },
      { code: 0, stdout: systemdText(value, "inactive") },
      { code: 0, stdout: "stopped" },
      { code: 1, stderr: "Unit is not-found" },
    ]);
    await expect(createSupervisor("systemd-user", { run: terminalAfterMutation.run, platform: "linux" }).start(value)).rejects.toThrow("manager command");
    const terminalCleanupFailure = runQueue([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: systemdText(value, "inactive") },
      { code: 0, stdout: systemdText(value, "inactive") },
      { code: 0, stdout: systemdText(value, "inactive") },
      { timedOut: true },
    ]);
    await expect(createSupervisor("systemd-user", { run: terminalCleanupFailure.run, platform: "linux" }).start(value)).rejects.toThrow("manager command");
    const polling = runQueue([{ code: 1, stderr: "Unit is not-found" }, { code: 0, stdout: "started" }, { code: 1, stderr: "Unit is not-found" }, { code: 0, stdout: systemdText(value, "active", 77) }]);
    const sleep = vi.fn(async () => undefined);
    await expect(createSupervisor("systemd-user", { run: polling.run, platform: "linux", sleep }).start(value)).resolves.toMatchObject({ managerPid: 77 });
    expect(sleep).toHaveBeenCalled();
    const rejected = createSupervisor("systemd-user", { run: async () => { throw new Error("runner"); }, platform: "linux" });
    await expect(rejected.probe(value)).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("covers activation metadata fences and the monotonic start deadline", async () => {
    const rejectAfterPoll = async (value: SupervisorSpec, after: string): Promise<void> => {
      const runner = runQueue([
        { code: 1, stderr: "Unit is not-found" },
        { code: 0, stdout: "started" },
        { code: 0, stdout: after },
        { code: 1, stderr: "Unit is not-found" },
      ]);
      await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).start(value)).rejects.toThrow("manager command");
    };

    const missingLoad = spec("systemd-user");
    await rejectAfterPoll(
      missingLoad,
      systemdText(missingLoad, "activating", 0)
        .replace("LoadState=loaded", "LoadState=unknown")
        .replace("SubState=activating", "SubState=start"),
    );
    const wrongActive = spec("systemd-user");
    const wrongActiveRunner = runQueue([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: systemdText(wrongActive, "active", 44) },
    ]);
    await expect(createSupervisor("systemd-user", { run: wrongActiveRunner.run, platform: "linux" }).start(wrongActive)).resolves.toMatchObject({ managerPid: 44 });
    const wrongSubState = spec("systemd-user");
    await rejectAfterPoll(
      wrongSubState,
      systemdText(wrongSubState, "activating", 0).replace("SubState=activating", "SubState=verify"),
    );
    const missingLoadState = spec("systemd-user");
    await rejectAfterPoll(
      missingLoadState,
      systemdText(missingLoadState, "activating", 0)
        .replace("LoadState=loaded\n", "")
        .replace("SubState=activating", "SubState=start"),
    );
    const missingActiveState = spec("systemd-user");
    await rejectAfterPoll(
      missingActiveState,
      systemdText(missingActiveState, "activating", 0)
        .replace("ActiveState=activating\n", "")
        .replace("SubState=activating", "SubState=start"),
    );
    const missingSubState = spec("systemd-user");
    await rejectAfterPoll(
      missingSubState,
      systemdText(missingSubState, "activating", 0).replace("SubState=activating\n", ""),
    );

    const deadlineSpec = spec("systemd-user");
    const deadlineRunner = runQueue([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 1, stderr: "Unit is not-found" },
      { code: 1, stderr: "Unit is not-found" },
    ]);
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(7);
    const sleep = vi.fn(async () => undefined);
    await expect(createSupervisor("systemd-user", {
      run: deadlineRunner.run,
      platform: "linux",
      commandTimeoutMs: 6,
      now,
      sleep,
    }).start(deadlineSpec)).rejects.toThrow("manager command");
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("supervisor coverage: credentials and private launch files", () => {
  it("classifies credential-directory and allow-list metadata mismatches", async () => {
    const stateRoot = root();
    const expectedDirectory = join(stateRoot, "expected-credentials");
    const expectedFile = join(expectedDirectory, "OPENAI_API_KEY");
    const expected = spec("systemd-user", stateRoot, {
      credentialDirectory: expectedDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: expectedFile }],
    });
    const differentDirectory = join(stateRoot, "different-credentials");
    const directoryMismatch = runQueue([{
      code: 0,
      stdout: systemdText(expected, "inactive", 0, ` LCM_CREDENTIAL_DIRECTORY=${differentDirectory} LCM_CREDENTIAL_OPENAI_API_KEY_FILE=${join(differentDirectory, "OPENAI_API_KEY")}`),
    }]);
    await expect(createSupervisor("systemd-user", { run: directoryMismatch.run, platform: "linux" }).probe(expected)).resolves.toMatchObject({
      kind: "registered-stale-config",
      reason: "metadata-mismatch",
    });

    const filesOnly = spec("systemd-user", stateRoot, {
      credentialFiles: [{ name: "OPENAI_API_KEY", path: expectedFile }],
    });
    const missingFiles = runQueue([{ code: 0, stdout: systemdText(filesOnly, "inactive") }]);
    await expect(createSupervisor("systemd-user", { run: missingFiles.run, platform: "linux" }).probe(filesOnly)).resolves.toMatchObject({
      kind: "registered-stale-config",
      reason: "metadata-missing",
    });

    const noFiles = spec("systemd-user", stateRoot);
    const unexpectedFile = runQueue([{
      code: 0,
      stdout: systemdText(noFiles, "inactive", 0, ` LCM_CREDENTIAL_OPENAI_API_KEY_FILE=${expectedFile}`),
    }]);
    await expect(createSupervisor("systemd-user", { run: unexpectedFile.run, platform: "linux" }).probe(noFiles)).resolves.toMatchObject({
      kind: "registered-stale-config",
      reason: "metadata-mismatch",
    });
  });

  it("checks credential path, mode, symlink, and cleanup races", async () => {
    const stateRoot = root();
    const directory = createManagedCredentialDirectory(stateRoot, "credential-coverage");
    const file = writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "secret" })[0]!;
    const value = spec("systemd-user", stateRoot, { credentialDirectory: directory, credentialFiles: [{ name: "OPENAI_API_KEY", path: file }] });
    const mismatch = spec("systemd-user", stateRoot, { credentialDirectory: directory, credentialFiles: [{ name: "OPENAI_API_KEY", path: join(directory, "other") }] });
    await expect(createSupervisor("systemd-user", { run: runQueue([{ code: 1, stderr: "Unit is not-found" }]).run, platform: "linux" }).start(mismatch)).rejects.toThrow("credential");
    chmodSync(file, 0o644);
    await expect(createSupervisor("systemd-user", { run: runQueue([{ code: 1, stderr: "Unit is not-found" }]).run, platform: "linux" }).start(value)).rejects.toThrow("credential");
    chmodSync(file, 0o600);
    rmSync(file);
    symlinkSync(join(stateRoot, "outside"), file);
    await expect(createSupervisor("systemd-user", { run: runQueue([{ code: 1, stderr: "Unit is not-found" }]).run, platform: "linux" }).start(value)).rejects.toThrow("credential");
    rmSync(file);
    writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "secret" });
    const validStart = runQueue([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: systemdText(value, "active", 77, ` LCM_CREDENTIAL_DIRECTORY=${directory} LCM_CREDENTIAL_OPENAI_API_KEY_FILE=${file}`) },
    ]);
    await expect(createSupervisor("systemd-user", { run: validStart.run, platform: "linux" }).start(value)).resolves.toMatchObject({ managerPid: 77 });
    const emptyDirectory = createManagedCredentialDirectory(stateRoot, "empty-credentials");
    const emptySpec = spec("systemd-user", stateRoot, { credentialDirectory: emptyDirectory });
    const emptyStart = runQueue([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: systemdText(emptySpec, "active", 78, ` LCM_CREDENTIAL_DIRECTORY=${emptyDirectory}`) },
    ]);
    await expect(createSupervisor("systemd-user", { run: emptyStart.run, platform: "linux" }).start(emptySpec)).resolves.toMatchObject({ managerPid: 78 });
    const running = systemdText(value, "active", 7, ` LCM_CREDENTIAL_DIRECTORY=${directory} LCM_CREDENTIAL_OPENAI_API_KEY_FILE=${file}`);
    const cleanupRunner = runQueue([{ code: 0, stdout: running }, { code: 0, stdout: "stopped" }, { code: 1, stderr: "Unit is not-found" }]);
    await expect(createSupervisor("systemd-user", { run: cleanupRunner.run, platform: "linux" }).stopAndAwaitAbsent(value)).resolves.toBeUndefined();
    expect(existsSync(directory)).toBe(false);
    cleanupManagedCredentialDirectory(directory, stateRoot);
  });

  it("rejects unsafe observed credentials and preserves mismatched cleanup evidence", async () => {
    const stateRoot = root();
    const directory = createManagedCredentialDirectory(stateRoot, "observed-coverage");
    const file = writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "secret" })[0]!;
    const value = spec("systemd-user", stateRoot, { credentialDirectory: directory, credentialFiles: [{ name: "OPENAI_API_KEY", path: file }] });
    const stale = systemdText({ ...value, port: 8 }, "inactive", 0, ` LCM_CREDENTIAL_DIRECTORY=${directory} LCM_CREDENTIAL_OPENAI_API_KEY_FILE=${file}`);
    const runner = runQueue([{ code: 0, stdout: stale }, { code: 0, stdout: stale }, { code: 0, stdout: "stopped" }, { code: 1, stderr: "Unit is not-found" }]);
    await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).stopAndStart(value)).rejects.toThrow("manager command");
    expect(existsSync(directory)).toBe(false);
    const secondRoot = root();
    const secondDir = createManagedCredentialDirectory(secondRoot, "state-mismatch");
    const secondFile = writeManagedCredentialFiles(secondDir, { OPENAI_API_KEY: "secret" })[0]!;
    const second = spec("systemd-user", secondRoot, { credentialDirectory: secondDir, credentialFiles: [{ name: "OPENAI_API_KEY", path: secondFile }] });
    const foreignState = systemdText({ ...second, port: 8 }, "inactive", 0, ` LCM_CREDENTIAL_DIRECTORY=${secondDir} LCM_CREDENTIAL_OPENAI_API_KEY_FILE=${secondFile} LCM_SUPERVISOR_STATE_ROOT=/foreign`);
    const secondRunner = runQueue([{ code: 0, stdout: foreignState }, { code: 1, stderr: "Unit is not-found" }]);
    await expect(createSupervisor("systemd-user", { run: secondRunner.run, platform: "linux" }).stopAndStart(second)).rejects.toThrow("manager command");
    expect(existsSync(secondDir)).toBe(true);
  });

  it("fails closed when a credential leaf changes after directory validation", async () => {
    const stateRoot = root();
    const directory = createManagedCredentialDirectory(stateRoot, "credential-race");
    const file = writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "secret" })[0]!;
    const value = spec("systemd-user", stateRoot, { credentialDirectory: directory, credentialFiles: [{ name: "OPENAI_API_KEY", path: file }] });
    fsFaults.lstatPath = file;
    fsFaults.lstatHits = 0;
    try {
      await expect(createSupervisor("systemd-user", { run: runQueue([{ code: 1, stderr: "Unit is not-found" }]).run, platform: "linux" }).start(value)).rejects.toThrow("credential");
      expect(fsFaults.lstatHits).toBeGreaterThanOrEqual(2);
    } finally {
      fsFaults.lstatPath = undefined;
      fsFaults.lstatHits = 0;
    }
  });

  it("exercises launchd plist creation, cleanup, collision, and stale candidate validation", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot, { cwd: "/tmp", entrypoint: "entry", runtimeDigest: DIGEST_A, storageBackend: "sqlite" });
    const absent = { code: 113, stderr: "Could not find service" };
    const runner = runQueue([absent, { code: 0, stdout: "bootstrapped" }, { code: 0, stdout: launchdText(value, "running", 88) }]);
    await expect(createSupervisor("launchd-user", { run: runner.run, platform: "darwin", uid: 501 }).start(value)).resolves.toMatchObject({ managerPid: 88 });
    const plist = join(stateRoot, `daemon.${value.shortDigest}.${value.nonce}.plist`);
    expect(readFileSync(plist, "utf8")).toContain("RunAtLoad");
    expect(lstatSync(plist).mode & 0o777).toBe(0o600);
    fsFaults.open = true;
    fsFaults.openCode = "EACCES";
    try {
      const readFailure = runQueue([absent, absent]);
      await expect(createSupervisor("launchd-user", { run: readFailure.run, platform: "darwin", uid: 501 }).start(value)).rejects.toThrow("manager command");
    } finally {
      fsFaults.open = false;
      fsFaults.openCode = undefined;
    }
    const stop = runQueue([{ code: 0, stdout: launchdText(value, "running", 88) }, { code: 0, stdout: "bootout" }, absent]);
    await expect(createSupervisor("launchd-user", { run: stop.run, platform: "darwin", uid: 501 }).stopAndAwaitAbsent(value)).resolves.toBeUndefined();
    expect(existsSync(plist)).toBe(false);
    const collision = join(stateRoot, `daemon.${value.shortDigest}.${value.nonce}.plist`);
    mkdirSync(collision);
    const collisionRunner = runQueue([absent]);
    await expect(createSupervisor("launchd-user", { run: collisionRunner.run, platform: "darwin", uid: 501 }).start(value)).rejects.toThrow("manager command");
    rmSync(collision, { recursive: true, force: true });
    const malformedStale = launchdText({ ...value, nonce: "old", port: 8 }, "not running", 0).replace(`LCM_SUPERVISOR_ARGS => ${JSON.stringify(value.args)}`, "LCM_SUPERVISOR_ARGS => invalid-json");
    const staleRunner = runQueue([{ code: 0, stdout: malformedStale }]);
    await expect(createSupervisor("launchd-user", { run: staleRunner.run, platform: "darwin", uid: 501 }).stopAndStart(value)).rejects.toThrow("manager command");
  });

  it.each(["before-open", "after-read", "before-unlink"] as const)(
    "preserves a replaced exact launchd plist before bootstrap (%s)",
    async (phase) => {
      const stateRoot = root();
      const value = spec("launchd-user", stateRoot);
      const absent = { code: 113, stderr: "Could not find service" };
      const initial = runQueue([absent, { code: 0, stdout: "bootstrapped" }, { code: 0, stdout: launchdText(value, "running", 88) }]);
      await expect(createSupervisor("launchd-user", { run: initial.run, platform: "darwin", uid: 501 }).start(value)).resolves.toMatchObject({ managerPid: 88 });
      const plist = join(stateRoot, `daemon.${value.shortDigest}.${value.nonce}.plist`);
      const exactDocument = readFileSync(plist, "utf8");

      const exactReuse = runQueue([absent, { code: 0, stdout: "bootstrapped" }, { code: 0, stdout: launchdText(value, "running", 89) }]);
      await expect(createSupervisor("launchd-user", { run: exactReuse.run, platform: "darwin", uid: 501 }).start(value)).resolves.toMatchObject({ managerPid: 89 });
      expect(readFileSync(plist, "utf8")).toBe(exactDocument);

      const injected = plistRace(phase, "foreign-bootstrap-evidence");
      const raced = runQueue([absent, absent]);
      await expect(createSupervisor("launchd-user", {
        run: raced.run,
        platform: "darwin",
        uid: 501,
        ...injected.dependencies,
      }).start(value)).rejects.toThrow("manager command");
      expect(injected.wasTriggered()).toBe(true);
      expect(readFileSync(plist, "utf8")).toBe("foreign-bootstrap-evidence");
      expect(raced.calls.some((call) => call.command === "launchctl" && call.args[0] === "bootstrap")).toBe(false);
    },
  );

  it.each(["before-open", "after-read", "before-unlink"] as const)(
    "preserves a replaced launchd plist during absence cleanup (%s)",
    async (phase) => {
      const stateRoot = root();
      const value = spec("launchd-user", stateRoot);
      const absent = { code: 113, stderr: "Could not find service" };
      const initial = runQueue([absent, { code: 0, stdout: "bootstrapped" }, { code: 0, stdout: launchdText(value, "running", 88) }]);
      await expect(createSupervisor("launchd-user", { run: initial.run, platform: "darwin", uid: 501 }).start(value)).resolves.toMatchObject({ managerPid: 88 });
      const plist = join(stateRoot, `daemon.${value.shortDigest}.${value.nonce}.plist`);
      const injected = plistRace(phase, "foreign-cleanup-evidence");
      const cleanup = runQueue([absent]);
      await expect(createSupervisor("launchd-user", {
        run: cleanup.run,
        platform: "darwin",
        uid: 501,
        ...injected.dependencies,
      }).stopAndAwaitAbsent(value)).rejects.toThrow("plist collision");
      expect(injected.wasTriggered()).toBe(true);
      expect(readFileSync(plist, "utf8")).toBe("foreign-cleanup-evidence");
    },
  );

  it("treats a plist that disappears immediately before cleanup unlink as idempotently absent", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const initial = runQueue([absent, { code: 0, stdout: "bootstrapped" }, { code: 0, stdout: launchdText(value, "running", 88) }]);
    await expect(createSupervisor("launchd-user", { run: initial.run, platform: "darwin", uid: 501 }).start(value)).resolves.toMatchObject({ managerPid: 88 });
    const plist = join(stateRoot, `daemon.${value.shortDigest}.${value.nonce}.plist`);
    const injected = plistRace("before-unlink", "", true);
    const cleanup = runQueue([absent]);
    await expect(createSupervisor("launchd-user", {
      run: cleanup.run,
      platform: "darwin",
      uid: 501,
      ...injected.dependencies,
    }).stopAndAwaitAbsent(value)).resolves.toBeUndefined();
    expect(injected.wasTriggered()).toBe(true);
    expect(existsSync(plist)).toBe(false);
  });

  it("fails closed when an existing plist disappears before descriptor open", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const initial = runQueue([absent, { code: 0, stdout: "bootstrapped" }, { code: 0, stdout: launchdText(value, "running", 88) }]);
    await expect(createSupervisor("launchd-user", { run: initial.run, platform: "darwin", uid: 501 }).start(value)).resolves.toMatchObject({ managerPid: 88 });
    const plist = join(stateRoot, `daemon.${value.shortDigest}.${value.nonce}.plist`);
    const injected = plistRace("before-open", "", true);
    const raced = runQueue([absent, absent]);
    await expect(createSupervisor("launchd-user", {
      run: raced.run,
      platform: "darwin",
      uid: 501,
      ...injected.dependencies,
    }).start(value)).rejects.toThrow("manager command");
    expect(injected.wasTriggered()).toBe(true);
    expect(existsSync(plist)).toBe(false);
  });

  it("keeps stale launch metadata parsing fail-closed", async () => {
    const value = spec("launchd-user");
    const stale = launchdText({ ...value, nonce: "old", port: 8 }, "not running", 0);
    const parseArgs = JSON.stringify(value.args);
    const runCandidate = async (candidate: unknown, throwCandidate = false): Promise<void> => {
      const runner = runQueue([{ code: 0, stdout: stale }, { code: 0, stdout: stale }]);
      const originalParse = JSON.parse;
      let parseCalls = 0;
      const parse = vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
        parseCalls += 1;
        if (parseCalls === 5) {
          if (throwCandidate) throw new Error("candidate parse failed");
          return candidate;
        }
        return originalParse(text) as unknown;
      });
      try {
        await expect(createSupervisor("launchd-user", { run: runner.run, platform: "darwin", uid: 501 }).stopAndStart(value)).rejects.toThrow("manager command");
        expect(parseCalls).toBeGreaterThanOrEqual(3);
      } finally {
        parse.mockRestore();
      }
    };
    await runCandidate({ bad: true });
    await runCandidate(undefined, true);
    expect(parseArgs).toContain("daemon");

    const rich = spec("launchd-user", root(), { cwd: "/tmp", entrypoint: "entry", runtimeDigest: DIGEST_A, storageBackend: "sqlite" });
    const richObserved = { ...rich, nonce: "old", port: 8, cwd: undefined, entrypoint: undefined, runtimeDigest: undefined, storageBackend: undefined };
    const richStale = launchdText(richObserved, "not running", 0);
    const richRunner = runQueue([{ code: 0, stdout: richStale }, { code: 0, stdout: richStale }]);
    await expect(createSupervisor("launchd-user", { run: richRunner.run, platform: "darwin", uid: 501 }).stopAndStart(rich)).rejects.toThrow("manager command");
    const richCompleteStale = launchdText({ ...rich, nonce: "old", port: 8 }, "not running", 0);
    const richCompleteRunner = runQueue([{ code: 0, stdout: richCompleteStale }, { code: 0, stdout: richCompleteStale }]);
    await expect(createSupervisor("launchd-user", { run: richCompleteRunner.run, platform: "darwin", uid: 501 }).stopAndStart(rich)).rejects.toThrow("manager command");
    for (const override of [{ entrypoint: "entry" }, { runtimeDigest: DIGEST_A }, { storageBackend: "sqlite" }]) {
      const oneOptional = spec("launchd-user", root(), override);
      const observed = launchdText({ ...oneOptional, nonce: "old", port: 8, entrypoint: undefined, runtimeDigest: undefined, storageBackend: undefined }, "not running", 0);
      const oneRunner = runQueue([{ code: 0, stdout: observed }, { code: 0, stdout: observed }]);
      await expect(createSupervisor("launchd-user", { run: oneRunner.run, platform: "darwin", uid: 501 }).stopAndStart(oneOptional)).rejects.toThrow("manager command");
    }
    const invalidNonce = launchdText({ ...value, nonce: "bad nonce", port: 8 }, "not running", 0);
    const nonceRunner = runQueue([{ code: 0, stdout: invalidNonce }, { code: 0, stdout: invalidNonce }]);
    await expect(createSupervisor("launchd-user", { run: nonceRunner.run, platform: "darwin", uid: 501 }).stopAndStart(value)).rejects.toThrow("manager command");
  });

  it("cleans partial plist evidence when the private write seam fails", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const runner = runQueue([absent, absent]);
    fsFaults.write = true;
    try {
      await expect(createSupervisor("launchd-user", { run: runner.run, platform: "darwin", uid: 501 }).start(value)).rejects.toThrow("manager command");
    } finally {
      fsFaults.write = false;
    }
    const unlinkRunner = runQueue([absent, absent]);
    fsFaults.write = true;
    fsFaults.unlink = true;
    try {
      await expect(createSupervisor("launchd-user", { run: unlinkRunner.run, platform: "darwin", uid: 501 }).start(spec("launchd-user", root()))).rejects.toThrow("manager command");
    } finally {
      fsFaults.write = false;
      fsFaults.unlink = false;
    }
    const openRunner = runQueue([absent, absent]);
    fsFaults.open = true;
    try {
      await expect(createSupervisor("launchd-user", { run: openRunner.run, platform: "darwin", uid: 501 }).start(spec("launchd-user", root()))).rejects.toThrow("manager command");
    } finally {
      fsFaults.open = false;
    }
    const closeRunner = runQueue([absent, absent]);
    fsFaults.close = true;
    try {
      await expect(createSupervisor("launchd-user", { run: closeRunner.run, platform: "darwin", uid: 501 }).start(spec("launchd-user", root()))).rejects.toThrow("manager command");
    } finally {
      fsFaults.close = false;
    }
    const uidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined, writable: true });
    try {
      await expect(createSupervisor("launchd-user", { run: vi.fn(), platform: "darwin" }).probe(value)).resolves.toMatchObject({ kind: "unavailable", reason: "manager-unavailable" });
    } finally {
      if (uidDescriptor !== undefined) Object.defineProperty(process, "getuid", uidDescriptor);
    }
    const cleanupRoot = root();
    const cleanupSpec = spec("launchd-user", cleanupRoot);
    const cleanupPath = join(cleanupRoot, `daemon.${cleanupSpec.shortDigest}.${cleanupSpec.nonce}.plist`);
    const launchRunner = runQueue([{ code: 113, stderr: "Could not find service" }, { code: 0, stdout: "bootstrapped" }, { code: 0, stdout: launchdText(cleanupSpec, "running", 12) }]);
    await expect(createSupervisor("launchd-user", { run: launchRunner.run, platform: "darwin", uid: 501 }).start(cleanupSpec)).resolves.toMatchObject({ managerPid: 12 });
    const cleanupDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined, writable: true });
    try {
      const stopRunner = runQueue([{ code: 0, stdout: launchdText(cleanupSpec, "running", 12) }, { code: 0, stdout: "bootout" }, { code: 113, stderr: "Could not find service" }]);
      await expect(createSupervisor("launchd-user", { run: stopRunner.run, platform: "darwin", uid: 501 }).stopAndAwaitAbsent(cleanupSpec)).resolves.toBeUndefined();
      expect(existsSync(cleanupPath)).toBe(false);
    } finally {
      if (cleanupDescriptor !== undefined) Object.defineProperty(process, "getuid", cleanupDescriptor);
    }
  });

  it("reconstructs complete stale launchd metadata before restarting", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot, {
      cwd: "/tmp",
      entrypoint: "entry",
      runtimeDigest: DIGEST_A,
      storageBackend: "sqlite",
    });
    const directory = createManagedCredentialDirectory(stateRoot, "launchd-stale-credentials");
    const file = writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "secret" })[0]!;
    const stale = {
      ...value,
      nonce: "stale-nonce",
      port: 4747,
      credentialDirectory: directory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: file }],
    };
    const stalePlist = join(stateRoot, `daemon.${value.shortDigest}.${stale.nonce}.plist`);
    const credentials = `LCM_CREDENTIAL_DIRECTORY => ${directory}\nLCM_CREDENTIAL_OPENAI_API_KEY_FILE => ${file}`;
    const absent = { code: 113, stderr: "Could not find service" };
    const runner = runQueue([
      absent,
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: launchdText(stale, "running", 77, credentials) },
      { code: 0, stdout: launchdText(stale, "not running", 0, credentials) },
      { code: 0, stdout: launchdText(stale, "not running", 0, credentials) },
      { code: 0, stdout: "bootout" },
      absent,
      absent,
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: launchdText(value, "running", 88) },
    ]);
    await expect(createSupervisor("launchd-user", { run: runner.run, platform: "darwin", uid: 501 }).start(stale)).resolves.toMatchObject({ managerPid: 77 });
    await expect(createSupervisor("launchd-user", { run: runner.run, platform: "darwin", uid: 501 }).stopAndStart(value)).resolves.toMatchObject({
      managerPid: 88,
    });
    expect(existsSync(stalePlist)).toBe(false);
  });

  it("preserves authenticated launchd evidence when old credential cleanup or plist unlink fails", async () => {
    const stateRoot = root();
    const oldDirectory = createManagedCredentialDirectory(stateRoot, "old-cleanup");
    const oldFile = writeManagedCredentialFiles(oldDirectory, { OPENAI_API_KEY: "old" })[0]!;
    const oldSpec = spec("launchd-user", stateRoot, {
      nonce: "cleanup-nonce",
      credentialDirectory: oldDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: oldFile }],
    });
    const absent = { code: 113, stderr: "Could not find service" };
    const oldStart = runQueue([absent, { code: 0, stdout: "bootstrapped" }, { code: 0, stdout: launchdText(oldSpec, "running", 88) }]);
    await expect(createSupervisor("launchd-user", { run: oldStart.run, platform: "darwin", uid: 501 }).start(oldSpec)).resolves.toMatchObject({ managerPid: 88 });

    const replacementDirectory = createManagedCredentialDirectory(stateRoot, "replacement-cleanup");
    const replacementFile = writeManagedCredentialFiles(replacementDirectory, { OPENAI_API_KEY: "replacement" })[0]!;
    const replacement = spec("launchd-user", stateRoot, {
      nonce: oldSpec.nonce,
      credentialDirectory: replacementDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: replacementFile }],
    });
    chmodSync(oldFile, 0o644);
    try {
      const cleanupFailure = runQueue([absent, absent]);
      await expect(createSupervisor("launchd-user", { run: cleanupFailure.run, platform: "darwin", uid: 501 }).start(replacement)).rejects.toThrow("manager command");
      expect(existsSync(oldDirectory)).toBe(true);
    } finally {
      chmodSync(oldFile, 0o600);
    }

    rmSync(oldDirectory, { recursive: true, force: true });
    fsFaults.unlink = true;
    try {
      const unlinkFailure = runQueue([absent, absent]);
      await expect(createSupervisor("launchd-user", { run: unlinkFailure.run, platform: "darwin", uid: 501 }).start(replacement)).rejects.toThrow("manager command");
    } finally {
      fsFaults.unlink = false;
    }

    const cleanup = runQueue([absent]);
    await expect(createSupervisor("launchd-user", { run: cleanup.run, platform: "darwin", uid: 501 }).stopAndAwaitAbsent(replacement)).resolves.toBeUndefined();
    expect(existsSync(replacementDirectory)).toBe(false);
  });
});

describe("supervisor coverage: stop deadlines and cleanup decisions", () => {
  it("keeps default polling monotonic across wall-clock jumps", async () => {
    const value = spec("systemd-user", root(), { stopTimeoutMs: 3 });
    const runner = runQueue([
      { code: 0, stdout: systemdText(value, "active", 12) },
      { code: 0, stdout: "stopped" },
      { code: 0, stdout: systemdText(value, "active", 12) },
    ]);
    const sleep = vi.fn(async () => undefined);
    const wallClock = vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(Number.MAX_SAFE_INTEGER);
    const monotonicClock = vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValue(101);
    try {
      await expect(createSupervisor("systemd-user", {
        run: runner.run,
        platform: "linux",
        sleep,
      }).stopAndAwaitAbsent(value)).rejects.toThrow("manager command");
      expect(wallClock).not.toHaveBeenCalled();
      expect(monotonicClock).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledOnce();
      expect(sleep).toHaveBeenCalledWith(2);
    } finally {
      wallClock.mockRestore();
      monotonicClock.mockRestore();
    }
  });

  it("covers reset-failed failure, nonzero stop, deadline expiry, and sleep seams", async () => {
    const value = spec("systemd-user", root(), { stopTimeoutMs: 3 });
    const resetFailure = runQueue([{ code: 0, stdout: systemdText(value, "failed") }, { code: 0, stdout: "stopped" }, { code: 1, stderr: "reset failed" }]);
    await expect(createSupervisor("systemd-user", { run: resetFailure.run, platform: "linux" }).stopAndAwaitAbsent(value)).rejects.toThrow("manager command");
    const nonzeroStop = runQueue([{ code: 0, stdout: systemdText(value, "active", 12) }, { code: 1, stderr: "stop failed" }, { code: 0, stdout: systemdText(value, "active", 12) }]);
    await expect(createSupervisor("systemd-user", { run: nonzeroStop.run, platform: "linux" }).stopAndAwaitAbsent(value)).rejects.toThrow("manager command");
    const now = vi.fn().mockReturnValueOnce(100).mockReturnValue(200);
    const expired = runQueue([{ code: 0, stdout: systemdText(value, "active", 12) }, { code: 0, stdout: "stopped" }, { code: 0, stdout: systemdText(value, "active", 12) }]);
    await expect(createSupervisor("systemd-user", { run: expired.run, platform: "linux", now, sleep: vi.fn() }).stopAndAwaitAbsent(value)).rejects.toThrow("manager command");
    const sleeping = runQueue([{ code: 0, stdout: systemdText(value, "active", 12) }, { code: 0, stdout: "stopped" }, { code: 0, stdout: systemdText(value, "active", 12) }]);
    const sleep = vi.fn(async () => undefined);
    const delayedNow = vi.fn().mockReturnValue(0);
    await expect(createSupervisor("systemd-user", { run: sleeping.run, platform: "linux", now: delayedNow, sleep }).stopAndAwaitAbsent(value)).rejects.toThrow("manager command");
    expect(sleep).toHaveBeenCalled();
    const defaultSleep = runQueue([{ code: 0, stdout: systemdText(value, "active", 12) }, { code: 0, stdout: "stopped" }, { code: 0, stdout: systemdText(value, "active", 12) }]);
    await expect(createSupervisor("systemd-user", { run: defaultSleep.run, platform: "linux", now: () => 0 }).stopAndAwaitAbsent(value)).rejects.toThrow("manager command");
    const onePoll = runQueue([{ code: 1, stderr: "Unit is not-found" }, { code: 0, stdout: "started" }, { code: 1, stderr: "Unit is not-found" }]);
    await expect(createSupervisor("systemd-user", { run: onePoll.run, platform: "linux", commandTimeoutMs: 1 }).start(value)).rejects.toThrow("manager command");
    const expiredStartNow = vi.fn().mockReturnValueOnce(0).mockReturnValue(1_000);
    const expiredStartSleep = vi.fn(async () => undefined);
    const activating = systemdText(value, "activating", 0).replace("SubState=activating", "SubState=start");
    const expiredStart = runQueue([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: activating },
      { code: 1, stderr: "Unit is not-found" },
    ]);
    await expect(createSupervisor("systemd-user", {
      run: expiredStart.run,
      platform: "linux",
      commandTimeoutMs: 100,
      now: expiredStartNow,
      sleep: expiredStartSleep,
    }).start(value)).rejects.toThrow("manager command");
    expect(expiredStartSleep).not.toHaveBeenCalled();
    const unavailableStop = runQueue([
      { code: 0, stdout: systemdText(value, "active", 12) },
      { code: 127, stderr: "systemctl not found" },
      { code: 1, stderr: "Unit is not-found" },
    ]);
    await expect(createSupervisor("systemd-user", { run: unavailableStop.run, platform: "linux" }).stopAndAwaitAbsent(value)).rejects.toMatchObject({ name: "SupervisorManagerError", reason: "manager-not-found" });
    const unavailableInitial = runQueue([{ code: 127, stderr: "systemctl not found" }]);
    await expect(createSupervisor("systemd-user", { run: unavailableInitial.run, platform: "linux" }).stopAndAwaitAbsent(value)).rejects.toMatchObject({ name: "SupervisorManagerError", reason: "manager-not-found" });
    const genericStop = runQueue([
      { code: 0, stdout: systemdText(value, "active", 12) },
      { code: 1, stderr: "permission denied" },
      { code: 1, stderr: "Unit is not-found" },
    ]);
    await expect(createSupervisor("systemd-user", { run: genericStop.run, platform: "linux" }).stopAndAwaitAbsent(value)).rejects.toThrow("manager command");
    const absentRestart = runQueue([{ code: 1, stderr: "Unit is not-found" }, { code: 1, stderr: "Unit is not-found" }, { code: 0, stdout: "started" }, { code: 0, stdout: systemdText(value, "active", 101) }]);
    await expect(createSupervisor("systemd-user", { run: absentRestart.run, platform: "linux" }).stopAndStart(value)).resolves.toMatchObject({ managerPid: 101 });
  });

  it("uses stale observation candidates and exact stop cleanup only after absence", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot, { nonce: "new", port: 4747 });
    const stale = launchdText({ ...value, nonce: "old", port: 3737 }, "not running", 0);
    const staleRunner = runQueue([{ code: 0, stdout: stale }, { code: 0, stdout: stale }, { code: 0, stdout: "bootout" }, { code: 113, stderr: "Could not find service" }]);
    await expect(createSupervisor("launchd-user", { run: staleRunner.run, platform: "darwin", uid: 501 }).stopAndAwaitAbsent(value)).rejects.toThrow("manager command");
    const noCandidate = launchdText({ ...value, nonce: "old", port: 3737 }, "not running", 0);
    const noCandidateRunner = runQueue([{ code: 0, stdout: noCandidate }, { code: 0, stdout: noCandidate }]);
    await expect(createSupervisor("launchd-user", { run: noCandidateRunner.run, platform: "darwin", uid: 501 }).stopAndStart(value)).rejects.toThrow("manager command");
    const staleThenAbsent = runQueue([{ code: 0, stdout: stale }, { code: 113, stderr: "Could not find service" }]);
    await expect(createSupervisor("launchd-user", { run: staleThenAbsent.run, platform: "darwin", uid: 501 }).stopAndStart(value)).rejects.toThrow("manager command");
  });

  it("covers credential-directory mismatch and incomplete stale launchd candidates", async () => {
    const stateRoot = root();
    const expectedDirectory = createManagedCredentialDirectory(stateRoot, "expected-credentials");
    const observedDirectory = join(stateRoot, "observed-credentials");
    const value = spec("systemd-user", stateRoot, { cwd: "/tmp", credentialDirectory: expectedDirectory });
    const mismatch = runQueue([{
      code: 0,
      stdout: systemdText(value, "active", 44, ` LCM_CREDENTIAL_DIRECTORY=${observedDirectory}`),
    }]);
    await expect(createSupervisor("systemd-user", { run: mismatch.run, platform: "linux" }).probe(value)).resolves.toMatchObject({
      kind: "registered-stale-config",
      reason: "metadata-mismatch",
      credentialDirectory: observedDirectory,
    });
    const noCredentialRoot = root();
    const noCredentialValue = spec("systemd-user", noCredentialRoot, { cwd: "/tmp" });
    const unexpectedCredential = join(noCredentialRoot, "unexpected-credentials");
    const unexpected = runQueue([{
      code: 0,
      stdout: systemdText(noCredentialValue, "active", 46, ` LCM_CREDENTIAL_DIRECTORY=${unexpectedCredential}`),
    }]);
    await expect(createSupervisor("systemd-user", { run: unexpected.run, platform: "linux" }).probe(noCredentialValue)).resolves.toMatchObject({
      kind: "registered-stale-config",
      reason: "metadata-mismatch",
    });
    const matching = runQueue([{
      code: 0,
      stdout: systemdText(value, "active", 45, ` LCM_CREDENTIAL_DIRECTORY=${expectedDirectory}`),
    }]);
    await expect(createSupervisor("systemd-user", { run: matching.run, platform: "linux" }).probe(value)).resolves.toMatchObject({
      kind: "registered-running-valid",
      credentialDirectory: expectedDirectory,
    });

    const directoryCandidateRoot = root();
    const directoryCandidate = spec("launchd-user", directoryCandidateRoot, {
      credentialDirectory: createManagedCredentialDirectory(directoryCandidateRoot, "candidate-credentials"),
    });
    const fileCandidate = spec("launchd-user", root(), { credentialFiles: [] });
    for (const candidate of [directoryCandidate, fileCandidate]) {
      const stale = launchdText({ ...candidate, nonce: "old", port: 8 }, "not running", 0);
      const runner = runQueue([{ code: 0, stdout: stale }]);
      await expect(createSupervisor("launchd-user", { run: runner.run, platform: "darwin", uid: 501 }).stopAndStart(candidate)).rejects.toThrow("manager command");
    }
  });

  it("cleans loser credentials only after reconstructing an exact concurrent winner", async () => {
    const stateRoot = root();
    for (const secondWinnerPid of [555, 556]) {
      const loserDirectory = createManagedCredentialDirectory(stateRoot, `winner-loser-${secondWinnerPid}`);
      const loserFile = writeManagedCredentialFiles(loserDirectory, { OPENAI_API_KEY: "loser" })[0]!;
      const winnerDirectory = join(stateRoot, `winner-${secondWinnerPid}`);
      const winnerFile = join(winnerDirectory, "OPENAI_API_KEY");
      const loser = spec("systemd-user", stateRoot, {
        nonce: "loser-nonce",
        cwd: "/tmp",
        entrypoint: "entry",
        runtimeDigest: DIGEST_A,
        storageBackend: "sqlite",
        credentialDirectory: loserDirectory,
        credentialFiles: [{ name: "OPENAI_API_KEY", path: loserFile }],
      });
      const winner = spec("systemd-user", stateRoot, {
        nonce: "winner-nonce",
        cwd: "/tmp",
        entrypoint: "entry",
        runtimeDigest: DIGEST_A,
        storageBackend: "sqlite",
        credentialDirectory: winnerDirectory,
        credentialFiles: [{ name: "OPENAI_API_KEY", path: winnerFile }],
      });
      const winnerOutput = (pid: number): string => systemdText(
        winner,
        "active",
        pid,
        ` LCM_SUPERVISOR_STATE_ROOT=${stateRoot} LCM_SUPERVISOR_ENTRYPOINT=entry LCM_SUPERVISOR_RUNTIME_DIGEST=${DIGEST_A} LCM_SUPERVISOR_STORAGE_BACKEND=sqlite LCM_CREDENTIAL_DIRECTORY=${winnerDirectory} LCM_CREDENTIAL_OPENAI_API_KEY_FILE=${winnerFile}`,
      );
      const runner = runQueue([
        { code: 1, stderr: "Unit is not-found" },
        { code: 0, stdout: "started" },
        { code: 0, stdout: winnerOutput(555) },
        { code: 0, stdout: winnerOutput(555) },
        { code: 0, stdout: winnerOutput(secondWinnerPid) },
      ]);
      await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).start(loser)).rejects.toThrow("manager command");
      expect(existsSync(loserDirectory)).toBe(secondWinnerPid === 556);
    }
  });

  it("keeps a winner unresolved when optional metadata is explicitly empty", async () => {
    const stateRoot = root();
    const loserDirectory = createManagedCredentialDirectory(stateRoot, "empty-winner-loser");
    const loserFile = writeManagedCredentialFiles(loserDirectory, { OPENAI_API_KEY: "loser" })[0]!;
    const loser = spec("systemd-user", stateRoot, {
      nonce: "loser-nonce",
      credentialDirectory: loserDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: loserFile }],
    });
    const winner = spec("systemd-user", stateRoot, { nonce: "winner-nonce" });
    const winnerOutput = systemdText(
      winner,
      "active",
      556,
      ` LCM_SUPERVISOR_STATE_ROOT=${stateRoot} LCM_SUPERVISOR_ENTRYPOINT= LCM_SUPERVISOR_RUNTIME_DIGEST= LCM_SUPERVISOR_STORAGE_BACKEND=`,
    );
    const runner = runQueue([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: winnerOutput },
      { code: 0, stdout: winnerOutput },
    ]);
    await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).start(loser)).rejects.toThrow("manager command");
    expect(existsSync(loserDirectory)).toBe(true);
  });

  it("rejects a winner observation from a different state root before reconstruction", async () => {
    const stateRoot = root();
    const loserDirectory = createManagedCredentialDirectory(stateRoot, "foreign-winner-loser");
    const loserFile = writeManagedCredentialFiles(loserDirectory, { OPENAI_API_KEY: "loser" })[0]!;
    const loser = spec("systemd-user", stateRoot, {
      nonce: "loser-nonce",
      credentialDirectory: loserDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: loserFile }],
    });
    const winner = spec("systemd-user", stateRoot, { nonce: "winner-nonce" });
    const winnerOutput = systemdText(
      winner,
      "active",
      557,
      ` LCM_SUPERVISOR_STATE_ROOT=/foreign-state-root`,
    );
    const runner = runQueue([
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: winnerOutput },
      { code: 0, stdout: winnerOutput },
    ]);
    await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).start(loser)).rejects.toThrow("manager command");
    expect(existsSync(loserDirectory)).toBe(true);
  });
});
