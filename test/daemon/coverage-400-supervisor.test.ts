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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  managedLaunchEnvironment,
  managedLaunchEnvironmentDigest,
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
const originalXdgRuntimeDir = process.env.XDG_RUNTIME_DIR;

beforeEach(() => {
  const runtimeRoot = root();
  chmodSync(runtimeRoot, 0o700);
  process.env.XDG_RUNTIME_DIR = runtimeRoot;
});

afterEach(() => {
  if (originalXdgRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalXdgRuntimeDir;
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
  const environment = value.launchEnvironment ?? managedLaunchEnvironment(process.env);
  const environmentDigest = managedLaunchEnvironmentDigest(
    value,
    "systemd-user",
    typeof process.getuid === "function" ? process.getuid() : -1,
    environment,
  );
  return [
    "LoadState=loaded",
    `ActiveState=${state}`,
    `SubState=${state === "active" ? "running" : state}`,
    `MainPID=${state === "active" ? pid : 0}`,
    `Environment=LCM_SUPERVISOR_MARKER=${value.marker} LCM_SUPERVISOR_SCOPE=${value.scopeDigest} LCM_SUPERVISOR_PORT=${value.port} LCM_SUPERVISOR_NONCE=${value.nonce} LCM_SUPERVISOR_EXECUTABLE=${value.executable} LCM_SUPERVISOR_ARGS=${JSON.stringify(value.args)} LCM_SUPERVISOR_CWD=${value.cwd ?? ""} LCM_SUPERVISOR_ENV_DIGEST=${environmentDigest}${extra}`,
  ].join("\n");
}

function launchdText(value: SupervisorSpec, state = "running", pid = 123, extra = ""): string {
  const environment = value.launchEnvironment ?? managedLaunchEnvironment(process.env);
  const environmentDigest = managedLaunchEnvironmentDigest(value, "launchd-user", -1, environment);
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
    `LCM_SUPERVISOR_ENV_DIGEST => ${environmentDigest}`,
    value.entrypoint === undefined ? "" : `LCM_SUPERVISOR_ENTRYPOINT => ${value.entrypoint}`,
    value.runtimeDigest === undefined ? "" : `LCM_SUPERVISOR_RUNTIME_DIGEST => ${value.runtimeDigest}`,
    value.storageBackend === undefined ? "" : `LCM_SUPERVISOR_STORAGE_BACKEND => ${value.storageBackend}`,
    value.postgresCaFile === undefined ? "" : `LCM_POSTGRES_CA_FILE => ${value.postgresCaFile}`,
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
    const environment = `LCM_SUPERVISOR_MARKER=${value.marker} LCM_SUPERVISOR_SCOPE=${value.scopeDigest} LCM_SUPERVISOR_PORT=${value.port} LCM_SUPERVISOR_NONCE=${value.nonce} LCM_SUPERVISOR_EXECUTABLE=${value.executable} LCM_SUPERVISOR_ARGS=${JSON.stringify(value.args)} LCM_SUPERVISOR_CWD= LCM_SUPERVISOR_ENV_DIGEST=${managedLaunchEnvironmentDigest(value, "systemd-user", typeof process.getuid === "function" ? process.getuid() : -1, value.launchEnvironment ?? managedLaunchEnvironment(process.env))} ${escaped}`;
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

  it("keeps a systemd result code 5 as a generic command failure", async () => {
    const value = spec("systemd-user");
    const runner = runQueue([
      { code: 1, stderr: `Unit ${value.systemdUnit} is not-found` },
      { code: 5, stderr: "systemd-run failed" },
      { code: 1, stderr: `Unit ${value.systemdUnit} is not-found` },
    ]);
    await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).start(value)).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "command",
    });
  });

  it("preserves permission evidence from the post-start manager probe", async () => {
    const value = spec("systemd-user");
    const runner = runQueue([
      { code: 1, stderr: `Unit ${value.systemdUnit} is not-found` },
      { code: 0, stdout: "started" },
      { code: 1, stderr: "Operation not permitted" },
      { code: 1, stderr: `Unit ${value.systemdUnit} is not-found` },
    ]);
    await expect(createSupervisor("systemd-user", { run: runner.run, platform: "linux" }).start(value)).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "permission",
    });
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
    const stale = systemdText({ ...value, port: 8 }, "inactive", 0, ` LCM_SUPERVISOR_STATE_ROOT=${stateRoot} LCM_CREDENTIAL_DIRECTORY=${directory} LCM_CREDENTIAL_OPENAI_API_KEY_FILE=${file}`);
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

  it("contains observed credential cleanup to an authenticated matching state root", async () => {
    const parentRoot = root();
    const stateRoot = join(parentRoot, "state");
    mkdirSync(stateRoot);
    chmodSync(stateRoot, 0o700);
    const directory = createManagedCredentialDirectory(stateRoot, "state-root-fence");
    const file = writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "secret" })[0]!;
    const base = spec("systemd-user", stateRoot, {
      credentialDirectory: directory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: file }],
    });
    type MutableSupervisorSpec = Omit<SupervisorSpec, "stateRoot"> & { stateRoot: string };
    // Keep the observed parent root within both the old and new roots. The
    // mutable projection is a deterministic public-seam fixture for a state
    // root drift between authenticated stale re-probe and absence cleanup:
    // without the exact guard, the credential validator would accept and
    // delete this directory.
    const mutable = { ...base, stateRoot: parentRoot } as MutableSupervisorSpec;
    const metadata = (observedRoot: string): string =>
      ` LCM_SUPERVISOR_STATE_ROOT=${observedRoot} LCM_CREDENTIAL_DIRECTORY=${directory} LCM_CREDENTIAL_OPENAI_API_KEY_FILE=${file}`;
    const prior = { ...mutable, port: mutable.port + 1, nonce: "prior-stale" } as MutableSupervisorSpec;
    const foreignStale = systemdText(prior, "inactive", 0, metadata(parentRoot));
    const matchingRunning = systemdText(base, "active", 88, metadata(stateRoot));
    const queue: CommandResult[] = [
      { code: 0, stdout: foreignStale },
      { code: 0, stdout: foreignStale },
      { code: 0, stdout: "stopped" },
      { code: 1, stderr: "Unit is not-found" },
      { code: 1, stderr: "Unit is not-found" },
      { code: 0, stdout: "started" },
      { code: 0, stdout: matchingRunning },
    ];
    const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = [];
    const run = vi.fn(async (command: string, args: readonly string[], options: { timeoutMs: number }) => {
      calls.push({ command, args, timeoutMs: options.timeoutMs });
      const result = queue.shift() ?? { code: 0, stdout: "", stderr: "" };
      if (command === "systemctl" && args[1] === "stop") mutable.stateRoot = stateRoot;
      return result;
    });
    await expect(createSupervisor("systemd-user", { run, platform: "linux" }).stopAndStart(mutable)).resolves.toMatchObject({
      managerPid: 88,
    });
    expect(calls.some(({ command, args }) => command === "systemctl" && args[1] === "stop")).toBe(true);
    expect(existsSync(directory)).toBe(true);

    const matchingDirectory = createManagedCredentialDirectory(stateRoot, "matching-state-root");
    const matchingFile = writeManagedCredentialFiles(matchingDirectory, { OPENAI_API_KEY: "matching-secret" })[0]!;
    const matching = spec("systemd-user", stateRoot, {
      credentialDirectory: matchingDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: matchingFile }],
    });
    const matchingMetadata = ` LCM_SUPERVISOR_STATE_ROOT=${stateRoot} LCM_CREDENTIAL_DIRECTORY=${matchingDirectory} LCM_CREDENTIAL_OPENAI_API_KEY_FILE=${matchingFile}`;
    const matchingRunner = runQueue([
      { code: 0, stdout: systemdText(matching, "active", 89, matchingMetadata) },
      { code: 0, stdout: "stopped" },
      { code: 1, stderr: "Unit is not-found" },
    ]);
    await expect(createSupervisor("systemd-user", { run: matchingRunner.run, platform: "linux" }).stopAndAwaitAbsent(matching)).resolves.toBeUndefined();
    expect(existsSync(matchingDirectory)).toBe(false);
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

  it("retries an exact launchd bootstrap after the GUI domain settles an absent label", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const terminal = launchdText(value, "exited", 0);
    const absent = { code: 113, stderr: "Could not find service" };
    const running = launchdText(value, "running", 544);
    const runner = runQueue([
      { code: 0, stdout: terminal },
      { code: 0, stdout: terminal },
      { code: 0, stdout: "bootout" },
      absent,
      absent,
      { code: 5, stderr: "Bootstrap failed: 5: Input/output error" },
      absent,
      absent,
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: running },
    ]);
    const sleep = vi.fn(async () => undefined);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      sleep,
    }).start(value)).resolves.toMatchObject({ managerPid: 544 });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(2);
    expect(runner.calls.filter(({ args }) => args[0] === "bootout")).toHaveLength(1);
  });

  it("uses the bounded host timer when launchd absence must settle", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const terminal = launchdText(value, "exited", 0);
    const absent = { code: 113, stderr: "Could not find service" };
    const runner = runQueue([
      { code: 0, stdout: terminal },
      { code: 0, stdout: terminal },
      { code: 0, stdout: "bootout" },
      absent,
      absent,
      { code: 5, stderr: "Bootstrap failed: 5: Input/output error" },
      { code: 0, stdout: "unparseable launchd response" },
      absent,
      absent,
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: launchdText(value, "running", 545) },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      commandTimeoutMs: 1,
      now: () => 0,
    }).start(value)).resolves.toMatchObject({ managerPid: 545 });
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(2);
  });

  it("continues authenticated label-release settling after repeated numeric EIO results", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    // launchctl's human text varies by macOS build; the exact bootstrap
    // command and Darwin's numeric EIO result are the stable classification.
    const failed = { code: 5, stderr: "launchd diagnostic unavailable" };
    const runner = runQueue([
      absent,
      failed,
      absent,
      absent,
      failed,
      absent,
      absent,
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: launchdText(value, "running", 546) },
    ]);
    const sleep = vi.fn(async () => undefined);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      sleep,
    }).start(value)).resolves.toMatchObject({ managerPid: 546 });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 2_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2_000);
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(3);
  });

  it("keeps a numeric code-5 launchd permission failure authoritative", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const runner = runQueue([
      absent,
      { code: 5, stderr: "Bootstrap failed: 5: Operation not permitted" },
      absent,
    ]);
    const sleep = vi.fn(async () => undefined);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      sleep,
    }).start(value)).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "permission",
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(1);
  });

  it("retires an exact failed launchd registration before one bounded start retry", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const terminal = { code: 0, stdout: launchdText(value, "exited", 0) };
    const runner = runQueue([
      absent,
      { code: 5, stderr: "Bootstrap failed: 5: Input/output error" },
      terminal,
      terminal,
      terminal,
      { code: 0, stdout: "bootout" },
      absent,
      absent,
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: launchdText(value, "running", 549) },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      sleep: async () => undefined,
    }).start(value)).resolves.toMatchObject({ managerPid: 549 });
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(2);
    expect(runner.calls.filter(({ args }) => args[0] === "bootout")).toHaveLength(1);
  });

  it("preserves a failed launchd bootstrap when a retry proof is not absent", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const runner = runQueue([
      absent,
      { code: 5, stderr: "Bootstrap failed: 5: Input/output error" },
      { code: 0, stdout: launchdText(value, "running", 547) },
      { code: 0, stdout: launchdText(value, "running", 547) },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
    }).start(value)).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "ambiguous-state",
    });
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(1);
  });

  it("preserves a failed launchd bootstrap when its second absence proof changes", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const running = { code: 0, stdout: launchdText(value, "running", 548) };
    const runner = runQueue([
      absent,
      { code: 5, stderr: "Bootstrap failed: 5: Input/output error" },
      absent,
      running,
      running,
    ]);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      sleep: async () => undefined,
    }).start(value)).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "ambiguous-state",
    });
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(1);
  });

  it.each([
    { name: "after the first absence proof", times: [0, 0, 1] },
    { name: "after the settling delay", times: [0, 0, 0, 1] },
    { name: "after the second absence proof", times: [0, 0, 0, 0, 0, 1] },
  ])("preserves a failed launchd bootstrap when the deadline expires $name", async ({ times }) => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const runner = runQueue([
      absent,
      { code: 5, stderr: "Bootstrap failed: 5: Input/output error" },
      absent,
      absent,
    ]);
    const now = vi.fn();
    for (const time of times) now.mockReturnValueOnce(time);
    now.mockReturnValue(1);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      commandTimeoutMs: 1,
      now,
      sleep: async () => undefined,
    }).start(value)).rejects.toThrow("manager command");
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(1);
  });

  it("preserves malformed-state when its observation consumes the remaining deadline", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const runner = runQueue([
      absent,
      { code: 5, stderr: "diagnostic wording is not an authority" },
      { code: 0, stdout: "unparseable launchd response" },
      absent,
    ]);
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1);
    const sleep = vi.fn(async () => undefined);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      commandTimeoutMs: 1,
      now,
      sleep,
    }).start(value)).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "malformed-state",
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(1);
  });

  it("classifies an initial launchd bootstrap transport failure without retrying", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const runner = runQueue([absent, { code: null }, absent]);
    const sleep = vi.fn(async () => undefined);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      sleep,
    }).start(value)).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "transport",
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(1);
  });

  it("observes malformed launchd projections until two exact absences authorize one retry", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const malformed = { code: 0, stdout: "unparseable launchd response" };
    const runner = runQueue([
      absent,
      { code: 5, stderr: "diagnostic wording is not an authority" },
      malformed,
      absent,
      malformed,
      absent,
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: launchdText(value, "running", 550) },
    ]);
    const sleep = vi.fn(async () => undefined);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      sleep,
    }).start(value)).resolves.toMatchObject({ managerPid: 550 });
    expect(sleep.mock.calls).toEqual([[50], [2_000], [50]]);
    expect(runner.calls.map(({ args }) => args[0])).toEqual([
      "print",
      "bootstrap",
      "print",
      "print",
      "print",
      "print",
      "bootstrap",
      "print",
    ]);
  });

  it("fails with bounded malformed state when observation-only recovery exhausts its deadline", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const malformed = { code: 0, stdout: "unparseable launchd response" };
    const runner = runQueue([
      absent,
      { code: 5, stderr: "diagnostic wording is not an authority" },
      malformed,
      malformed,
      absent,
    ]);
    let currentTime = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      commandTimeoutMs: 100,
      now: () => currentTime,
      sleep,
    }).start(value)).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "malformed-state",
    });
    expect(sleep.mock.calls).toEqual([[50], [50]]);
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(1);
  });

  it.each([
    {
      name: "manager permission failure",
      proof: { code: 1, stderr: "Operation not permitted" },
      reason: "permission",
    },
    {
      name: "manager transport failure",
      proof: { code: null },
      reason: "transport",
    },
    {
      name: "manager command timeout",
      proof: { timedOut: true },
      reason: "timeout",
    },
  ])("keeps $name authoritative during label-release recovery", async ({ proof, reason }) => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const runner = runQueue([
      absent,
      { code: 5, stderr: "diagnostic wording is not an authority" },
      proof,
      absent,
    ]);
    const sleep = vi.fn(async () => undefined);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      sleep,
    }).start(value)).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason,
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(1);
  });

  it("does not retry a launchd bootstrap after its absence deadline expires", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const terminal = launchdText(value, "exited", 0);
    const absent = { code: 113, stderr: "Could not find service" };
    const runner = runQueue([
      { code: 0, stdout: terminal },
      { code: 0, stdout: terminal },
      { code: 0, stdout: "bootout" },
      absent,
      absent,
      { code: 5, stderr: "Bootstrap failed: 5: Input/output error" },
      absent,
    ]);
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      commandTimeoutMs: 1,
      now,
    }).start(value)).rejects.toThrow("manager command");
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(1);
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
    const oldCredentials = `LCM_CREDENTIAL_DIRECTORY => ${oldDirectory}\nLCM_CREDENTIAL_OPENAI_API_KEY_FILE => ${oldFile}`;
    const oldStart = runQueue([absent, { code: 0, stdout: "bootstrapped" }, { code: 0, stdout: launchdText(oldSpec, "running", 88, oldCredentials) }]);
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
