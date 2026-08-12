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

  it.each([
    { name: "numeric code-5", initial: { code: 5, stderr: "Operation not permitted" } },
    { name: "mixed absent-channel", initial: { code: 113, stdout: "Could not find service", stderr: "Operation not permitted" } },
  ])("keeps initial launchd $name permission evidence authoritative before bootstrap", async ({ initial }) => {
    const value = spec("launchd-user", root());
    const runner = runQueue([initial]);

    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
    }).start(value)).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "permission",
    });

    expect(runner.calls.map(({ args }) => args[0])).toEqual(["print"]);
  });

  it("still bootstraps from a true initial launchd absence", async () => {
    const value = spec("launchd-user", root());
    const runner = runQueue([
      { code: 113, stderr: "Could not find service" },
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: launchdText(value, "running", 554) },
    ]);

    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
    }).start(value)).resolves.toMatchObject({ managerPid: 554 });

    expect(runner.calls.map(({ args }) => args[0])).toEqual(["print", "bootstrap", "print"]);
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

const LEGACY_INVOCATION_ID = "1234567890abcdef1234567890abcdef";
const CHANGED_LEGACY_INVOCATION_ID = "abcdef1234567890abcdef1234567890";

type LegacySystemdUnitTestShape = Readonly<{
  name: string;
  managerPid: number;
  invocationId: string;
}>;
type LegacySystemdDiscoveryTestShape =
  | Readonly<{ kind: "candidates"; candidates: readonly LegacySystemdUnitTestShape[] }>
  | Readonly<{ kind: "unavailable"; reason: string }>;
type LegacySystemdCapabilitiesTestShape = {
  readonly discoverLegacySystemdUnits?: (options?: { readonly deadline?: number }) => Promise<LegacySystemdDiscoveryTestShape>;
  readonly stopLegacySystemdUnit?: (candidate: LegacySystemdUnitTestShape, options?: { readonly deadline?: number }) => Promise<void>;
};

function legacySystemdCapabilities(value: unknown): LegacySystemdCapabilitiesTestShape {
  return value as LegacySystemdCapabilitiesTestShape;
}

function legacySystemdCandidate(
  overrides: Partial<LegacySystemdUnitTestShape> = {},
): LegacySystemdUnitTestShape {
  return {
    name: "lcm-daemon-1234-1720000000000.service",
    managerPid: 4242,
    invocationId: LEGACY_INVOCATION_ID,
    ...overrides,
  };
}

function legacySystemdShowArgsForTest(name: string): readonly string[] {
  return [
    "--user",
    "show",
    "--no-pager",
    "--property=LoadState,ActiveState,SubState,MainPID,InvocationID",
    name,
  ];
}

function legacySystemdList(...names: readonly string[]): string {
  return names.map((name) => `${name} loaded active running legacy`).join("\n");
}

type LegacySystemdTestActiveState =
  | "active"
  | "reloading"
  | "refreshing"
  | "activating"
  | "deactivating"
  | "maintenance"
  | "inactive"
  | "failed"
  | "future-state";

function legacySystemdState(
  state: LegacySystemdTestActiveState | "malformed" | "not-found" | "unloaded" = "active",
  pid: number | string | null = 4242,
  subState:
    | "running"
    | "start"
    | "start-post"
    | "reload"
    | "stop"
    | "stop-sigterm"
    | "stop-sigkill"
    | "stop-watchdog"
    | "stop-post"
    | "final-sigterm"
    | "final-sigkill"
    | "final-watchdog"
    | "failed"
    | "dead"
    | "unexpected-transition"
    | "cleaning"
    | "auto-restart"
    | "auto-restart-queued" = "running",
  invocationId: string | null = LEGACY_INVOCATION_ID,
): string {
  if (state === "not-found" || state === "unloaded") {
    return `LoadState=${state}\nActiveState=inactive\nSubState=dead\nMainPID=0`;
  }
  if (state === "malformed") return "LoadState=loaded\nActiveState=unknown\nSubState=unknown\nMainPID=not-a-pid";
  return [
    "LoadState=loaded",
    `ActiveState=${state}`,
    `SubState=${subState}`,
    ...(pid === null ? [] : [`MainPID=${pid}`]),
    ...(invocationId === null ? [] : [`InvocationID=${invocationId}`]),
  ].join("\n");
}

describe("legacy generated systemd discovery and exact stop", () => {
  it("discovers only strict legacy names and returns authenticated manager PIDs", async () => {
    spec("systemd-user");
    const runner = runQueue([
      {
        code: 0,
        stdout: legacySystemdList(
          "lcm-daemon-1234-1720000000000.service",
          "lcm-daemon-0123456789abcdef0123.service",
          "lcm-daemon-1234-not-a-time.service",
          "lcm-daemon-0-1720000000000.service",
          "lcm-daemon-1234-0.service",
          "lcm-daemon-1234-1720000000000.service.bak",
          "other.service",
          "lcm-daemon-1234-1720000000000.service",
        ),
        stderr: "list-unit diagnostic must not escape",
      },
      { code: 0, stdout: legacySystemdState("active", 4242), stderr: "show diagnostic must not escape" },
    ]);
    const supervisor = createSupervisor("systemd-user", { run: runner.run, platform: "linux" });
    const capabilities = legacySystemdCapabilities(supervisor);
    expect(capabilities.discoverLegacySystemdUnits).toBeTypeOf("function");
    const result = await capabilities.discoverLegacySystemdUnits!();

    expect(result).toEqual({
      kind: "candidates",
      candidates: [{
        name: "lcm-daemon-1234-1720000000000.service",
        managerPid: 4242,
        invocationId: LEGACY_INVOCATION_ID,
      }],
    });
    expect(result).not.toHaveProperty("stdout");
    expect(result).not.toHaveProperty("stderr");
    expect(runner.calls.map(({ command, args }) => ({ command, args }))).toEqual([
      {
        command: "systemctl",
        args: ["--user", "list-units", "--type=service", "--all", "--no-legend", "--no-pager", "--plain"],
      },
      {
        command: "systemctl",
        args: ["--user", "show", "--no-pager", "--property=LoadState,ActiveState,SubState,MainPID,InvocationID", "lcm-daemon-1234-1720000000000.service"],
      },
    ]);
  });

  it.each([
    {
      name: "zero candidates",
      list: legacySystemdList("other.service"),
      shows: [] as readonly CommandResult[],
      expected: { kind: "candidates", candidates: [] },
    },
    {
      name: "multiple candidates",
      list: legacySystemdList("lcm-daemon-20-200.service", "lcm-daemon-10-100.service"),
      shows: [
        { code: 0, stdout: legacySystemdState("active", 10) },
        { code: 0, stdout: legacySystemdState("active", 20) },
      ],
      expected: {
        kind: "candidates",
        candidates: [
          { name: "lcm-daemon-10-100.service", managerPid: 10, invocationId: LEGACY_INVOCATION_ID },
          { name: "lcm-daemon-20-200.service", managerPid: 20, invocationId: LEGACY_INVOCATION_ID },
        ],
      },
    },
    {
      name: "malformed PID",
      list: legacySystemdList("lcm-daemon-10-100.service"),
      shows: [{ code: 0, stdout: legacySystemdState("malformed") }],
      expected: { kind: "unavailable", reason: "state-conflict" },
    },
    {
      name: "missing invocation witness",
      list: legacySystemdList("lcm-daemon-10-100.service"),
      shows: [{ code: 0, stdout: legacySystemdState("active", 10, "running", null) }],
      expected: { kind: "unavailable", reason: "state-conflict" },
    },
    {
      name: "malformed invocation witness",
      list: legacySystemdList("lcm-daemon-10-100.service"),
      shows: [{ code: 0, stdout: legacySystemdState("active", 10, "running", "not-an-id") }],
      expected: { kind: "unavailable", reason: "state-conflict" },
    },
    {
      name: "zero invocation witness",
      list: legacySystemdList("lcm-daemon-10-100.service"),
      shows: [{ code: 0, stdout: legacySystemdState("active", 10, "running", "0".repeat(32)) }],
      expected: { kind: "unavailable", reason: "state-conflict" },
    },
    {
      name: "uppercase invocation witness",
      list: legacySystemdList("lcm-daemon-10-100.service"),
      shows: [{ code: 0, stdout: legacySystemdState("active", 10, "running", LEGACY_INVOCATION_ID.toUpperCase()) }],
      expected: { kind: "unavailable", reason: "state-conflict" },
    },
    {
      name: "oversized invocation witness",
      list: legacySystemdList("lcm-daemon-10-100.service"),
      shows: [{ code: 0, stdout: legacySystemdState("active", 10, "running", `${LEGACY_INVOCATION_ID}0`) }],
      expected: { kind: "unavailable", reason: "state-conflict" },
    },
    {
      name: "non-running state",
      list: legacySystemdList("lcm-daemon-10-100.service"),
      shows: [{ code: 0, stdout: legacySystemdState("failed", 0, "failed") }],
      expected: { kind: "unavailable", reason: "state-conflict" },
    },
    {
      name: "explicit not-found state",
      list: legacySystemdList("lcm-daemon-10-100.service"),
      shows: [{ code: 0, stdout: legacySystemdState("not-found", 0, "dead") }],
      expected: { kind: "candidates", candidates: [] },
    },
    {
      name: "explicit unloaded state",
      list: legacySystemdList("lcm-daemon-10-100.service"),
      shows: [{ code: 0, stdout: legacySystemdState("unloaded", 0, "dead") }],
      expected: { kind: "unavailable", reason: "state-conflict" },
    },
    {
      name: "not-found race",
      list: legacySystemdList("lcm-daemon-10-100.service"),
      shows: [{ code: 1, stderr: "Unit lcm-daemon-10-100.service not found" }],
      expected: { kind: "candidates", candidates: [] },
    },
  ])("returns $expected.kind for $name", async ({ list, shows, expected }) => {
    const runner = runQueue([{ code: 0, stdout: list }, ...shows]);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
    }));
    expect(capabilities.discoverLegacySystemdUnits).toBeTypeOf("function");
    await expect(capabilities.discoverLegacySystemdUnits!()).resolves.toEqual(expected);
  });

  it.each([
    ["reloading", "reload", 4242],
    ["refreshing", "reload", 4242],
    ["activating", "start", 0],
    ["activating", "start-post", 4242],
    ["deactivating", "stop", 4242],
    ["deactivating", "stop-sigterm", 4242],
    ["maintenance", "failed", 0],
    ["inactive", "dead", 0],
    ["failed", "failed", 0],
    ["future-state", "running", 4242],
  ] as const)("classifies a strict %s/%s legacy unit under the complete state policy", async (state, subState, managerPid) => {
    const name = "lcm-daemon-1234-1720000000000.service";
    const runner = runQueue([
      { code: 0, stdout: `${name} loaded ${state} ${subState} legacy` },
      { code: 0, stdout: legacySystemdState(state, managerPid, subState) },
    ]);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
    }));

    await expect(capabilities.discoverLegacySystemdUnits!()).resolves.toEqual({
      kind: "unavailable",
      reason: "state-conflict",
    });
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["--user", "list-units", "--type=service", "--all", "--no-legend", "--no-pager", "--plain"],
      ["--user", "show", "--no-pager", "--property=LoadState,ActiveState,SubState,MainPID,InvocationID", name],
    ]);
    expect(runner.calls.some(({ args }) => args.includes("stop"))).toBe(false);
  });

  it.each([
    { name: "list timeout", list: { timedOut: true }, expected: { kind: "unavailable", reason: "manager-timeout" } },
    { name: "list permission failure", list: { code: 1, stderr: "Operation not permitted" }, expected: { kind: "unavailable", reason: "manager-command-failed" } },
    { name: "list unexpected status", list: { code: 1, stderr: "manager exploded" }, expected: { kind: "unavailable", reason: "manager-command-failed" } },
    { name: "show timeout", list: { code: 0, stdout: legacySystemdList("lcm-daemon-10-100.service") }, show: { timedOut: true }, expected: { kind: "unavailable", reason: "manager-timeout" } },
    { name: "show permission failure", list: { code: 0, stdout: legacySystemdList("lcm-daemon-10-100.service") }, show: { code: 1, stderr: "Operation not permitted" }, expected: { kind: "unavailable", reason: "manager-command-failed" } },
    { name: "show unexpected status", list: { code: 0, stdout: legacySystemdList("lcm-daemon-10-100.service") }, show: { code: 2, stderr: "bad manager state" }, expected: { kind: "unavailable", reason: "manager-command-failed" } },
  ])("fails closed with no raw output for $name", async ({ list, show, expected }) => {
    const runner = runQueue([list, ...(show === undefined ? [] : [show])]);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
    }));
    expect(capabilities.discoverLegacySystemdUnits).toBeTypeOf("function");
    const result = await capabilities.discoverLegacySystemdUnits!();
    expect(result).toEqual(expected);
    expect(result).not.toHaveProperty("stdout");
    expect(result).not.toHaveProperty("stderr");
  });

  it("returns bounded unavailability when the operation deadline is exhausted", async () => {
    const runner = runQueue([]);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
      now: () => 100,
    }));
    expect(capabilities.discoverLegacySystemdUnits).toBeTypeOf("function");
    await expect(capabilities.discoverLegacySystemdUnits!({ deadline: 99 })).resolves.toEqual({
      kind: "unavailable",
      reason: "manager-timeout",
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("does not expose Linux discovery on launchd", async () => {
    const capabilities = legacySystemdCapabilities(createSupervisor("launchd-user", {
      run: vi.fn(),
      platform: "darwin",
      uid: 501,
    }));
    expect(capabilities.discoverLegacySystemdUnits).toBeUndefined();
    expect(capabilities.stopLegacySystemdUnit).toBeUndefined();
  });

  it("stops one exact active candidate and accepts daemon-owned PID-file disappearance", async () => {
    const candidate = legacySystemdCandidate();
    const runner = runQueue([
      { code: 0, stdout: legacySystemdState("active", 4242) },
      { code: 0, stdout: "stop queued" },
      { code: 0, stdout: legacySystemdState("not-found") },
    ]);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
    }));
    expect(capabilities.stopLegacySystemdUnit).toBeTypeOf("function");
    await expect(capabilities.stopLegacySystemdUnit!(candidate)).resolves.toBeUndefined();
    expect(runner.calls.map(({ command, args }) => ({ command, args }))).toEqual([
      {
        command: "systemctl",
        args: legacySystemdShowArgsForTest(candidate.name),
      },
      { command: "systemctl", args: ["--user", "stop", candidate.name] },
      {
        command: "systemctl",
        args: legacySystemdShowArgsForTest(candidate.name),
      },
    ]);
  });

  it.each([
    ["reloading", "reload", 4242],
    ["refreshing", "reload", 4242],
    ["activating", "start", 0],
    ["activating", "start-post", 4242],
    ["deactivating", "stop", 4242],
    ["deactivating", "stop-sigterm", 4242],
    ["maintenance", "failed", 0],
    ["inactive", "dead", 0],
    ["failed", "failed", 0],
    ["future-state", "running", 4242],
    ["not-found", "dead", 0],
    ["unloaded", "dead", 0],
  ] as const)("refuses exact untrusted %s/%s state before issuing stop", async (state, subState, managerPid) => {
    const candidate = legacySystemdCandidate();
    const runner = runQueue([
      { code: 0, stdout: legacySystemdState(state, managerPid, subState) },
    ]);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
    }));

    await expect(capabilities.stopLegacySystemdUnit!(candidate)).rejects.toThrow("manager command");
    expect(runner.calls.map(({ args }) => args)).toEqual([
      legacySystemdShowArgsForTest(candidate.name),
    ]);
    expect(runner.calls.some(({ args }) => args.includes("stop"))).toBe(false);
  });

  it("refuses malformed exact state before issuing stop", async () => {
    const candidate = legacySystemdCandidate();
    const runner = runQueue([{ code: 0, stdout: legacySystemdState("malformed") }]);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
    }));

    await expect(capabilities.stopLegacySystemdUnit!(candidate)).rejects.toThrow("manager command");
    expect(runner.calls.map(({ args }) => args)).toEqual([
      legacySystemdShowArgsForTest(candidate.name),
    ]);
    expect(runner.calls.some(({ args }) => args.includes("stop"))).toBe(false);
  });

  it.each([
    { name: "explicit not-found state", result: { code: 0, stdout: "LoadState=not-found\nMainPID=0" } },
    { name: "not-found command status", result: { code: 1, stderr: "Unit lcm-daemon-1234-1720000000000.service not-found" } },
  ])("accepts $name as exact unit absence", async ({ result }) => {
    const candidate = legacySystemdCandidate();
    const runner = runQueue([
      { code: 0, stdout: legacySystemdState("active", 4242) },
      { code: 0, stdout: "stop queued" },
      result,
    ]);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
      sleep: vi.fn(async () => undefined),
    }));
    await expect(capabilities.stopLegacySystemdUnit!(candidate)).resolves.toBeUndefined();
  });

  it.each([
    ["stop", 4242],
    ["stop", 0],
    ["stop-sigterm", 4242],
    ["stop-sigterm", 0],
    ["stop-sigkill", 4242],
    ["stop-sigkill", 0],
    ["stop-watchdog", 4242],
    ["stop-watchdog", 0],
    ["stop-post", 4242],
    ["stop-post", 0],
    ["final-sigterm", 4242],
    ["final-sigterm", 0],
    ["final-sigkill", 4242],
    ["final-sigkill", 0],
    ["final-watchdog", 4242],
    ["final-watchdog", 0],
  ] as const)("polls authenticated legacy shutdown %s with MainPID %i until exact absence", async (subState, managerPid) => {
    const candidate = legacySystemdCandidate();
    const runner = runQueue([
      { code: 0, stdout: legacySystemdState("active", 4242) },
      { code: 0, stdout: "stop queued" },
      { code: 0, stdout: legacySystemdState("deactivating", managerPid, subState) },
      { code: 0, stdout: legacySystemdState("not-found") },
    ]);
    const sleep = vi.fn(async () => undefined);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
      stopTimeoutMs: 100,
      sleep,
      now: () => 0,
    }));

    await expect(capabilities.stopLegacySystemdUnit!(candidate)).resolves.toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(50);
    expect(runner.calls.map(({ args }) => args)).toEqual([
      legacySystemdShowArgsForTest(candidate.name),
      ["--user", "stop", candidate.name],
      legacySystemdShowArgsForTest(candidate.name),
      legacySystemdShowArgsForTest(candidate.name),
    ]);
  });

  it.each([
    { name: "manager PID changes", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("active", 9999) },
    { name: "deactivating manager PID changes", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("deactivating", 9999, "stop") },
    { name: "deactivating PID is missing", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("deactivating", null, "stop") },
    { name: "deactivating PID has leading zero", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("deactivating", "00", "stop") },
    { name: "deactivating PID is nonnumeric", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("deactivating", "not-a-pid", "stop") },
    { name: "deactivating invocation witness is missing", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("deactivating", 4242, "stop", null) },
    { name: "deactivating invocation witness is malformed", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("deactivating", 4242, "stop", "not-an-id") },
    { name: "deactivating invocation witness changes", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("deactivating", 4242, "stop", CHANGED_LEGACY_INVOCATION_ID) },
    { name: "active invocation witness is missing", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("active", 4242, "running", null) },
    { name: "active invocation witness changes", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("active", 4242, "running", CHANGED_LEGACY_INVOCATION_ID) },
    { name: "deactivating running substate", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("deactivating", 4242, "running") },
    { name: "deactivating unknown substate", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("deactivating", 4242, "unexpected-transition") },
    { name: "deactivating cleaning substate", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("deactivating", 4242, "cleaning") },
    { name: "deactivating auto-restart substate", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("deactivating", 4242, "auto-restart") },
    { name: "deactivating auto-restart queued substate", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("deactivating", 4242, "auto-restart-queued") },
    { name: "active dead substate", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("active", 4242, "dead") },
    { name: "activating start transition", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("activating", 4242, "start") },
    { name: "reloading transition", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("reloading", 4242, "reload") },
    { name: "refreshing transition", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("refreshing", 4242, "reload") },
    { name: "maintenance state", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("maintenance", 0, "failed") },
    { name: "future manager state", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("future-state", 4242, "running") },
    { name: "loaded inactive unit remains", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("inactive", 0, "dead") },
    { name: "loaded failed unit remains", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("failed", 0, "failed") },
    { name: "unloaded unit remains", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("unloaded", 0, "dead") },
    { name: "malformed post-stop state", initial: legacySystemdState("active", 4242), afterStop: legacySystemdState("malformed") },
  ])("refuses $name after exact stop", async ({ initial, afterStop }) => {
    const candidate = legacySystemdCandidate();
    const runner = runQueue([
      { code: 0, stdout: initial },
      { code: 0, stdout: "stop queued" },
      { code: 0, stdout: afterStop },
    ]);
    const sleep = vi.fn(async () => undefined);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
      sleep,
    }));
    expect(capabilities.stopLegacySystemdUnit).toBeTypeOf("function");
    await expect(capabilities.stopLegacySystemdUnit!(candidate)).rejects.toThrow("manager command");
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls.filter(({ args }) => args.includes("stop"))).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing candidate invocation witness", candidate: { name: "lcm-daemon-1234-1720000000000.service", managerPid: 4242 } },
    { name: "empty candidate invocation witness", candidate: legacySystemdCandidate({ invocationId: "" }) },
    { name: "zero candidate invocation witness", candidate: legacySystemdCandidate({ invocationId: "0".repeat(32) }) },
    { name: "malformed candidate invocation witness", candidate: legacySystemdCandidate({ invocationId: "not-an-id" }) },
    { name: "initial invocation witness changes", candidate: legacySystemdCandidate(), initial: legacySystemdState("active", 4242, "running", CHANGED_LEGACY_INVOCATION_ID) },
    { name: "initial invocation witness is missing", candidate: legacySystemdCandidate(), initial: legacySystemdState("active", 4242, "running", null) },
    { name: "initial invocation witness is malformed", candidate: legacySystemdCandidate(), initial: legacySystemdState("active", 4242, "running", "not-an-id") },
  ])("refuses $name before issuing exact stop", async ({ candidate, initial }) => {
    const runner = runQueue(initial === undefined ? [] : [{ code: 0, stdout: initial }]);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
    }));

    await expect(capabilities.stopLegacySystemdUnit!(candidate as LegacySystemdUnitTestShape)).rejects.toThrow("manager command");
    expect(runner.calls.some(({ args }) => args.includes("stop"))).toBe(false);
    expect(runner.calls).toHaveLength(initial === undefined ? 0 : 1);
  });

  it("bounds a persistent authenticated legacy shutdown transition", async () => {
    const candidate = legacySystemdCandidate();
    const runner = runQueue([
      { code: 0, stdout: legacySystemdState("active", 4242) },
      { code: 0, stdout: "stop queued" },
      { code: 0, stdout: legacySystemdState("deactivating", 4242, "stop-sigterm") },
      { code: 0, stdout: legacySystemdState("deactivating", 0, "stop-post") },
    ]);
    const sleep = vi.fn(async () => undefined);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
      stopTimeoutMs: 100,
      sleep,
      now: () => 0,
    }));

    await expect(capabilities.stopLegacySystemdUnit!(candidate)).rejects.toThrow("manager command");
    expect(runner.calls).toHaveLength(4);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it.each([
    { name: "stable name", candidate: legacySystemdCandidate({ name: "lcm-daemon-aaaaaaaaaaaaaaaaaaaa.service" }) },
    { name: "arbitrary name", candidate: legacySystemdCandidate({ name: "other.service" }) },
    { name: "zero PID", candidate: legacySystemdCandidate({ managerPid: 0 }) },
    { name: "non-integer PID", candidate: legacySystemdCandidate({ managerPid: 1.5 }) },
  ])("refuses a smuggled $name without invoking systemd", async ({ candidate }) => {
    const runner = runQueue([]);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
    }));
    expect(capabilities.stopLegacySystemdUnit).toBeTypeOf("function");
    await expect(capabilities.stopLegacySystemdUnit!(candidate)).rejects.toThrow("manager command");
    expect(runner.calls).toHaveLength(0);
  });

  it.each([
    { name: "initial PID mismatch", results: [{ code: 0, stdout: legacySystemdState("active", 9999) }] },
    { name: "show timeout", results: [{ timedOut: true }] },
    { name: "stop timeout", results: [{ code: 0, stdout: legacySystemdState("active", 4242) }, { timedOut: true }] },
    { name: "stop error", results: [{ code: 0, stdout: legacySystemdState("active", 4242) }, { code: 1, stderr: "permission denied" }] },
    { name: "post-stop timeout", results: [{ code: 0, stdout: legacySystemdState("active", 4242) }, { code: 0, stdout: "stop queued" }, { timedOut: true }] },
    { name: "post-stop command error", results: [{ code: 0, stdout: legacySystemdState("active", 4242) }, { code: 0, stdout: "stop queued" }, { code: 1, stderr: "permission denied" }] },
  ])("refuses $name", async ({ results }) => {
    const candidate = legacySystemdCandidate();
    const runner = runQueue(results);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
    }));
    expect(capabilities.stopLegacySystemdUnit).toBeTypeOf("function");
    await expect(capabilities.stopLegacySystemdUnit!(candidate)).rejects.toThrow("manager command");
    expect(runner.calls.filter(({ args }) => args.includes("stop"))).toHaveLength(
      results.length > 1 ? 1 : 0,
    );
  });

  it("requires exact absence after a successful stop and honors the deadline", async () => {
    const candidate = legacySystemdCandidate();
    const runner = runQueue([
      { code: 0, stdout: legacySystemdState("active", 4242) },
      { code: 0, stdout: "stop queued" },
      { code: 0, stdout: legacySystemdState("active", 4242) },
    ]);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
      now: () => 100,
      sleep: vi.fn(async () => undefined),
    }));
    expect(capabilities.stopLegacySystemdUnit).toBeTypeOf("function");
    await expect(capabilities.stopLegacySystemdUnit!(candidate, { deadline: 99 })).rejects.toThrow("manager command");
    expect(runner.calls).toHaveLength(0);
  });

  it("rethrows an unexpected discovery deadline failure without exposing manager output", async () => {
    let nowCalls = 0;
    const runner = runQueue([{ code: 0, stdout: legacySystemdList("lcm-daemon-10-100.service") }]);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
      now: () => {
        nowCalls += 1;
        if (nowCalls > 1) throw new Error("clock failed");
        return 0;
      },
    }));
    await expect(capabilities.discoverLegacySystemdUnits!({ deadline: 100 })).rejects.toThrow("clock failed");
  });

  it("bounds a persistent exact-stop transition at one poll", async () => {
    const candidate = legacySystemdCandidate();
    const runner = runQueue([
      { code: 0, stdout: legacySystemdState("active", 4242) },
      { code: 0, stdout: "stop queued" },
      { code: 0, stdout: legacySystemdState("active", 4242) },
    ]);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
      stopTimeoutMs: 1,
      sleep: vi.fn(async () => undefined),
      now: () => 0,
    }));
    await expect(capabilities.stopLegacySystemdUnit!(candidate)).rejects.toThrow("manager command");
  });

  it("polls a persistent exact-stop transition within multiple bounded intervals", async () => {
    const candidate = legacySystemdCandidate();
    const runner = runQueue([
      { code: 0, stdout: legacySystemdState("active", 4242) },
      { code: 0, stdout: "stop queued" },
      { code: 0, stdout: legacySystemdState("active", 4242) },
      { code: 0, stdout: legacySystemdState("active", 4242) },
    ]);
    const sleep = vi.fn(async () => undefined);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
      stopTimeoutMs: 100,
      sleep,
      now: () => 0,
    }));
    await expect(capabilities.stopLegacySystemdUnit!(candidate)).rejects.toThrow("manager command");
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it("uses the bounded default sleep for a persistent exact-stop transition", async () => {
    const candidate = legacySystemdCandidate();
    const runner = runQueue([
      { code: 0, stdout: legacySystemdState("active", 4242) },
      { code: 0, stdout: "stop queued" },
      { code: 0, stdout: legacySystemdState("active", 4242) },
      { code: 0, stdout: legacySystemdState("active", 4242) },
    ]);
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
      stopTimeoutMs: 100,
      now: () => 0,
    }));
    await expect(capabilities.stopLegacySystemdUnit!(candidate)).rejects.toThrow("manager command");
  });

  it("stops immediately when the exact-stop deadline expires after a persistent poll", async () => {
    const candidate = legacySystemdCandidate();
    const runner = runQueue([
      { code: 0, stdout: legacySystemdState("active", 4242) },
      { code: 0, stdout: "stop queued" },
      { code: 0, stdout: legacySystemdState("active", 4242) },
    ]);
    let nowCalls = 0;
    const capabilities = legacySystemdCapabilities(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
      stopTimeoutMs: 100,
      now: () => {
        nowCalls += 1;
        return nowCalls >= 7 ? 100 : 0;
      },
    }));
    await expect(capabilities.stopLegacySystemdUnit!(candidate)).rejects.toThrow("manager command");
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
    const runner = runQueue([{ code: 0, stdout: stale }, { code: 0, stdout: stale }, { code: 0, stdout: "stopped" }, { code: 1, stderr: "Unit is not-found" }, { code: 1, stderr: "Unit is not-found" }]);
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

  it("re-observes transient launchd metadata-malformed state after bootstrap", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const transient = launchdText(value, "starting", 0);
    const running = launchdText(value, "running", 551);
    const runner = runQueue([
      absent,
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: transient },
      { code: 0, stdout: running },
    ]);
    const sleep = vi.fn(async () => undefined);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      sleep,
    }).start(value)).resolves.toMatchObject({ managerPid: 551 });
    expect(sleep).toHaveBeenCalledWith(50);
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(1);
    expect(runner.calls.filter(({ args }) => args[0] === "bootout")).toHaveLength(0);
  });

  it("uses the bounded host timer for launchd post-start re-observation", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const transient = launchdText(value, "starting", 0);
    const running = launchdText(value, "running", 552);
    const runner = runQueue([
      absent,
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: transient },
      { code: 0, stdout: running },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      commandTimeoutMs: 100,
    }).start(value)).resolves.toMatchObject({ managerPid: 552 });
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(1);
  });

  it("fails closed when launchd metadata-malformed state persists to the poll deadline", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const transient = launchdText(value, "starting", 0);
    const runner = runQueue([
      absent,
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: transient },
      { code: 0, stdout: transient },
      { code: 0, stdout: transient },
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
      commandTimeoutMs: 101,
      now: () => currentTime,
      sleep,
    }).start(value)).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "malformed-state",
    });
    expect(sleep.mock.calls).toEqual([[50], [50], [1]]);
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(1);
    expect(runner.calls.filter(({ args }) => args[0] === "bootout")).toHaveLength(0);
  });

  it("keeps re-observing launchd metadata-malformed state past five seconds while the operation deadline remains", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const transient = { code: 0, stdout: launchdText(value, "starting", 0) };
    const running = { code: 0, stdout: launchdText(value, "running", 553) };
    const runner = runQueue([
      absent,
      { code: 0, stdout: "bootstrapped" },
      ...Array.from({ length: 101 }, () => transient),
      running,
    ]);
    let currentTime = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });

    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      commandTimeoutMs: 60_000,
      now: () => currentTime,
      sleep,
    }).start(value, { deadline: 6_000 })).resolves.toMatchObject({ managerPid: 553 });

    expect(currentTime).toBe(5_050);
    expect(sleep).toHaveBeenCalledTimes(101);
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(1);
    expect(runner.calls.filter(({ args }) => args[0] === "bootout")).toHaveLength(0);
  });

  it("does not give absent launchd post-start polling a fresh timeout after its implicit deadline", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const runner = runQueue([
      absent,
      { code: 0, stdout: "bootstrapped" },
      absent,
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
      reason: "ambiguous-state",
    });

    expect(currentTime).toBe(100);
    expect(sleep.mock.calls).toEqual([[50], [50]]);
    expect(runner.calls.map(({ args }) => args[0])).toEqual(["print", "bootstrap", "print", "print"]);
    expect(runner.calls.map(({ timeoutMs }) => timeoutMs)).toEqual([100, 100, 100, 50]);
    expect(runner.calls.filter(({ args }) => args[0] === "bootout")).toHaveLength(0);
  });

  it("keeps persistent launchd metadata-malformed state bounded by the terminal operation deadline", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const transient = { code: 0, stdout: launchdText(value, "starting", 0) };
    const runner = runQueue([
      absent,
      { code: 0, stdout: "bootstrapped" },
      ...Array.from({ length: 121 }, () => transient),
    ]);
    let currentTime = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });

    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      commandTimeoutMs: 60_000,
      now: () => currentTime,
      sleep,
    }).start(value, { deadline: 6_000 })).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "malformed-state",
    });

    expect(currentTime).toBe(6_000);
    expect(sleep).toHaveBeenCalledTimes(120);
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(1);
    expect(runner.calls.filter(({ args }) => args[0] === "bootout")).toHaveLength(0);
  });

  it("keeps systemd metadata-malformed post-start state fail closed", async () => {
    const value = spec("systemd-user");
    const absent = { code: 1, stderr: "Unit is not-found" };
    const runner = runQueue([
      absent,
      { code: 0, stdout: "started" },
      { code: 0, stdout: systemdText(value, "activating", 0) },
      absent,
    ]);
    const sleep = vi.fn(async () => undefined);
    await expect(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
      sleep,
    }).start(value)).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "malformed-state",
    });
    expect(sleep).not.toHaveBeenCalled();
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

  it("honors the caller deadline across terminal stop/start label-release recovery", async () => {
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
      commandTimeoutMs: 5_000,
      now: () => currentTime,
      sleep,
    }).stopAndStart(value, { deadline: 2_500 })).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "label-release-deadline",
    });
    expect(sleep.mock.calls).toEqual([[2_000], [500]]);
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(1);
    expect(runner.calls.find(({ args }) => args[0] === "bootstrap")?.timeoutMs).toBe(500);
  });

  it("rejects a non-finite caller deadline before manager access", async () => {
    const runner = runQueue([]);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
    }).start(spec("launchd-user"), { deadline: Number.NaN })).rejects.toThrow("deadline");
    expect(runner.run).not.toHaveBeenCalled();
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
    // `launchctl print` may project arbitrary manager data.  Permission-like
    // text in a successful projection is not failed-command evidence and must
    // not preempt the bounded, read-only malformed-state reprobe.
    const malformed = {
      code: 0,
      stdout: launchdText(value, "starting", 0, "manager value => Permission denied"),
    };
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
    // `launchctl print` may project arbitrary manager data. Permission-like
    // text in a successful projection is not failed-command evidence and must
    // not preempt the bounded, read-only malformed-state reprobe.
    const malformed = {
      code: 0,
      stdout: launchdText(value, "starting", 0, "manager value => Permission denied"),
    };
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

  it.each([
    { name: "before the label-release settle", proofs: 1, expectedSleeps: [] as number[][] },
    { name: "after the label-release settle", proofs: 2, expectedSleeps: [[2_000]] },
  ])("keeps mixed-channel permission evidence authoritative $name", async ({ proofs, expectedSleeps }) => {
    const value = spec("launchd-user", root());
    const absent = { code: 113, stderr: "Could not find service" };
    const mixedPermission = {
      code: 113,
      stdout: "Could not find service",
      stderr: "Operation not permitted",
    };
    const runner = runQueue([
      absent,
      { code: 5, stderr: "Bootstrap failed: 5: Input/output error" },
      ...(proofs === 2 ? [absent] : []),
      mixedPermission,
      mixedPermission,
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
    expect(sleep.mock.calls).toEqual(expectedSleeps);
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
  it("does not mutate a stale launchd registration after the caller deadline expires during transition observation", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot, { stopTimeoutMs: 100 });
    const stale = launchdText({ ...value, nonce: "stale-transition-nonce" }, "not running", 0);
    const runner = runQueue([
      { code: 0, stdout: stale },
      { code: 0, stdout: "unparseable launchd response" },
    ]);
    const now = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(100);
    const sleep = vi.fn(async () => undefined);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      now,
      sleep,
    }).stopAndStart(value, { deadline: 100 })).rejects.toThrow("manager command");
    expect(sleep).not.toHaveBeenCalled();
    expect(runner.calls.map(({ args }) => args[0])).toEqual(["print", "print"]);
  });

  it("re-observes a stale launchd transition within the caller deadline before refusing ambiguity", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot, { stopTimeoutMs: 100 });
    const stale = launchdText({ ...value, nonce: "stale-transition-nonce" }, "not running", 0);
    const runner = runQueue([
      { code: 0, stdout: stale },
      { code: 0, stdout: "unparseable launchd response" },
      { code: 0, stdout: "unparseable launchd response" },
    ]);
    const sleep = vi.fn(async () => undefined);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      now: () => 0,
      sleep,
    }).stopAndStart(value, { deadline: 100 })).rejects.toThrow("manager command");
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(50);
    expect(runner.calls.map(({ args }) => args[0])).toEqual(["print", "print", "print"]);
  });

  it("stops before absence polling when a caller deadline is exhausted after the manager stop", async () => {
    const value = spec("systemd-user", root(), { stopTimeoutMs: 100 });
    const runner = runQueue([
      { code: 0, stdout: systemdText(value, "active", 12) },
      { code: 0, stdout: "stopped" },
    ]);
    const now = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1);
    const sleep = vi.fn(async () => undefined);
    await expect(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
      now,
      sleep,
    }).stopAndAwaitAbsent(value, { deadline: 1 })).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "timeout",
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(runner.calls.map(({ args }) => args[1] ?? args[0])).toEqual(["show", "stop"]);
  });

  it("fails an already-expired caller deadline before any manager command", async () => {
    const runner = runQueue([]);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      now: () => 0,
    }).start(spec("launchd-user"), { deadline: 0 })).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "timeout",
    });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("uses the caller deadline for successful launchd post-start polling", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const runner = runQueue([
      absent,
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: launchdText(value, "running", 900) },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      now: () => 0,
    }).start(value, { deadline: 100 })).resolves.toMatchObject({ managerPid: 900 });
    expect(runner.calls.find(({ args }) => args[0] === "bootstrap")?.timeoutMs).toBe(100);
  });

  it("caps operation-scoped launchd probes and label-release retries at the configured timeout", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const configuredCommandTimeoutMs = 100;
    const runner = runQueue([
      absent,
      { code: 5, stderr: "Bootstrap failed: 5: Input/output error" },
      absent,
      absent,
      { code: 0, stdout: "bootstrapped" },
      { code: 0, stdout: launchdText(value, "running", 901) },
    ]);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      commandTimeoutMs: configuredCommandTimeoutMs,
      now: () => 0,
      sleep: async () => undefined,
    }).start(value, { deadline: 1_000 })).resolves.toMatchObject({ managerPid: 901 });
    expect(runner.calls.map(({ args }) => args[0])).toEqual([
      "print",
      "bootstrap",
      "print",
      "print",
      "bootstrap",
      "print",
    ]);
    expect(runner.calls.map(({ timeoutMs }) => timeoutMs)).toEqual(
      Array(runner.calls.length).fill(configuredCommandTimeoutMs),
    );
  });

  it.each([
    { configuredCommandTimeoutMs: 7.5, expectedTimeoutMs: 7 },
    { configuredCommandTimeoutMs: 60_001.5, expectedTimeoutMs: 60_000 },
  ])("clamps direct probe timeout $configuredCommandTimeoutMs to the runner bounds", async ({ configuredCommandTimeoutMs, expectedTimeoutMs }) => {
    const value = spec("systemd-user", root());
    const runner = runQueue([{ code: 0, stdout: systemdText(value, "active", 904) }]);
    await expect(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
      commandTimeoutMs: configuredCommandTimeoutMs,
    }).probe(value)).resolves.toMatchObject({ kind: "registered-running-valid", managerPid: 904 });
    expect(runner.calls.map(({ timeoutMs }) => timeoutMs)).toEqual([expectedTimeoutMs]);
  });

  it("classifies a non-finite configured probe timeout without invoking the manager", async () => {
    const value = spec("systemd-user", root());
    const runner = runQueue([]);
    await expect(createSupervisor("systemd-user", {
      run: runner.run,
      platform: "linux",
      commandTimeoutMs: Number.NaN,
    }).probe(value)).resolves.toMatchObject({
      kind: "unavailable",
      reason: "manager-timeout",
    });
    expect(runner.calls).toEqual([]);
  });

  it.each([
    { name: "permission", failure: { code: 1, stderr: "Operation not permitted" }, reason: "permission" },
    { name: "timeout", failure: { timedOut: true }, reason: "timeout" },
    { name: "transport", failure: { code: null }, reason: "transport" },
  ])("keeps an authoritative $name failure despite a later terminal re-probe", async ({ failure, reason }) => {
    const value = spec("launchd-user", root());
    const absent = { code: 113, stderr: "Could not find service" };
    const terminal = { code: 0, stdout: launchdText(value, "exited", 0) };
    const runner = runQueue([absent, failure, terminal]);

    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
    }).start(value)).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason,
    });
    expect(runner.calls.map(({ args }) => args[0])).toEqual(["print", "bootstrap", "print"]);
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(1);
  });

  it("retries one exact immediate-exit registration after a successful bootstrap", async () => {
    const value = spec("launchd-user", root());
    const absent = { code: 113, stderr: "Could not find service" };
    const terminal = { code: 0, stdout: launchdText(value, "exited", 0) };
    const running = { code: 0, stdout: launchdText(value, "running", 902) };
    const runner = runQueue([
      absent,
      { code: 0, stdout: "bootstrapped" },
      terminal,
      terminal,
      terminal,
      { code: 0, stdout: "bootout" },
      absent,
      absent,
      { code: 0, stdout: "bootstrapped" },
      running,
    ]);

    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      sleep: async () => undefined,
    }).start(value)).resolves.toMatchObject({ managerPid: 902 });
    expect(runner.calls.filter(({ args }) => args[0] === "bootstrap")).toHaveLength(2);
  });

  it("bounds terminal post-start cleanup and its exact absence probe by the same caller deadline", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const terminal = { code: 0, stdout: launchdText(value, "exited", 0) };
    const queue = [
      absent,
      { code: 0, stdout: "bootstrapped" },
      terminal,
      terminal,
      terminal,
      { code: 0, stdout: "bootout" },
      absent,
    ];
    let currentTime = 0;
    const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = [];
    const run = vi.fn(async (command: string, args: readonly string[], options: { timeoutMs: number }) => {
      calls.push({ command, args, timeoutMs: options.timeoutMs });
      const result = queue.shift() ?? { code: 0, stdout: "", stderr: "" };
      if (calls.length === 3) currentTime = 998;
      return result;
    });
    const sleep = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    await expect(createSupervisor("launchd-user", {
      run,
      platform: "darwin",
      uid: 501,
      commandTimeoutMs: 60_000,
      now: () => currentTime,
      sleep,
    }).start(value, { deadline: 1_000 })).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "timeout",
    });
    expect(calls.map(({ args }) => args[0])).toEqual([
      "print",
      "bootstrap",
      "print",
      "print",
      "print",
      "bootout",
      "print",
    ]);
    expect(calls.map(({ timeoutMs }) => timeoutMs)).toEqual([1_000, 1_000, 1_000, 2, 2, 2, 2]);
    expect(sleep).toHaveBeenCalledWith(2);
  });

  it("does not begin terminal post-start cleanup after its operation deadline expires", async () => {
    const stateRoot = root();
    const value = spec("launchd-user", stateRoot);
    const absent = { code: 113, stderr: "Could not find service" };
    const terminal = { code: 0, stdout: launchdText(value, "exited", 0) };
    const runner = runQueue([absent, { code: 0, stdout: "bootstrapped" }, terminal]);
    const now = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(1);
    await expect(createSupervisor("launchd-user", {
      run: runner.run,
      platform: "darwin",
      uid: 501,
      now,
    }).start(value, { deadline: 1 })).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "ambiguous-state",
    });
    expect(runner.calls.map(({ args }) => args[0])).toEqual(["print", "bootstrap", "print"]);
  });

  it("preserves timeout classification and independent stop and reset-failed budgets", async () => {
    const value = spec("systemd-user", root(), { stopTimeoutMs: 100 });
    const configuredCommandTimeoutMs = 7;
    const timedOutStop = runQueue([
      { code: 0, stdout: systemdText(value, "active", 12) },
      { timedOut: true },
    ]);
    await expect(createSupervisor("systemd-user", {
      run: timedOutStop.run,
      platform: "linux",
      commandTimeoutMs: configuredCommandTimeoutMs,
    }).stopAndAwaitAbsent(value)).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "timeout",
    });
    expect(timedOutStop.calls.map(({ timeoutMs }) => timeoutMs)).toEqual([7, 100]);

    const timedOutReset = runQueue([
      { code: 0, stdout: systemdText(value, "failed") },
      { code: 0, stdout: "stopped" },
      { timedOut: true },
    ]);
    await expect(createSupervisor("systemd-user", {
      run: timedOutReset.run,
      platform: "linux",
      commandTimeoutMs: configuredCommandTimeoutMs,
    }).stopAndAwaitAbsent(value)).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "timeout",
    });
    expect(timedOutReset.calls.map(({ timeoutMs }) => timeoutMs)).toEqual([7, 100, 100]);

    const deadlineBoundStop = runQueue([
      { code: 0, stdout: systemdText(value, "active", 12) },
      { timedOut: true },
    ]);
    await expect(createSupervisor("systemd-user", {
      run: deadlineBoundStop.run,
      platform: "linux",
      commandTimeoutMs: configuredCommandTimeoutMs,
      now: () => 0,
    }).stopAndAwaitAbsent(value, { deadline: 50 })).rejects.toMatchObject({
      name: "SupervisorCommandError",
      reason: "timeout",
    });
    expect(deadlineBoundStop.calls.map(({ timeoutMs }) => timeoutMs)).toEqual([7, 50]);
  });

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
