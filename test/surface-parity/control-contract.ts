import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runCli } from "../../bin/lcm.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { applyBackendPublicationConfigFile } from "../../src/config-manager.js";
import { applyBackendPublicationProjectMapFile } from "../../src/project-map.js";
import { BackendPublicationCoordinator, captureBackendPublicationState, type BackendPublicationRecoveryFile } from "../../src/storage/backend-publication.js";
import { AGENTS } from "../../src/connectors/registry.js";
import { DryRunServiceDeps } from "../../installer/dry-run-deps.js";

// Only external process/service/agent-installation boundaries are doubled.
// Commander, command actions, config validation, publication and writes are real.
const seams = vi.hoisted(() => ({
  exit: (code?: string | number | null): never => { throw { controlExit: Number(code ?? 0) }; },
  ensureDaemon: vi.fn(), restartDaemon: vi.fn(), install: vi.fn(), uninstall: vi.fn(),
  startMcpServer: vi.fn(), installConnector: vi.fn(), removeConnector: vi.fn(),
  listConnectorInventory: vi.fn(), createInstallerPublicationConvergence: vi.fn(),
}));
vi.mock("node:process", async original => ({
  ...(await original<typeof import("node:process")>()), exit: seams.exit,
}));
vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: seams.ensureDaemon, restartDaemon: seams.restartDaemon,
}));
vi.mock("../../installer/install.js", () => ({
  install: seams.install,
  createInstallerPublicationConvergence: seams.createInstallerPublicationConvergence,
}));
vi.mock("../../installer/uninstall.js", () => ({ uninstall: seams.uninstall }));
vi.mock("../../src/mcp/server.js", () => ({ startMcpServer: seams.startMcpServer }));
vi.mock("../../src/connectors/installer.js", () => ({
  installConnector: seams.installConnector, removeConnector: seams.removeConnector,
  listConnectorInventory: seams.listConnectorInventory,
  listConnectors: () => [],
}));

export const CONTROL_PATHS = [
  "<root>", "help", "daemon", "config", "events", "machine", "project", "postgres", "connectors",
  "daemon start", "daemon restart", "config get", "config set", "install", "uninstall", "mcp",
  "connectors list", "connectors install", "connectors remove", "connectors doctor",
] as const;
type ControlPath = typeof CONTROL_PATHS[number];
type Backend = "sqlite" | "postgresql";
type Observation = { code: number; out: string; err: string };
export type ControlRowEvidence = {
  id: string; assertions: string[]; verdict: "passed" | "failed"; digest: string;
};
type Fixture = { root: string; home: string; config: string; before: Record<string, string> };
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function recoveryFile(content: string): BackendPublicationRecoveryFile {
  return { presence: "present", content: Buffer.from(content), mode: 0o600,
    uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0,
    nlink: "1", dev: "1", ino: "2", parentDev: "3", parentIno: "4" };
}

function snapshot(root: string): Record<string, string> {
  const entries: Array<[string, string]> = [];
  function walk(directory: string): void {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const key = relative(root, path);
      if (stat.isDirectory()) {
        entries.push([key + "/", String(stat.mode & 0o777)]);
        walk(path);
      } else {
        expect(stat.isFile()).toBe(true);
        entries.push([key, hash([stat.mode & 0o777, createHash("sha256").update(readFileSync(path)).digest("hex")])]);
      }
    }
  }
  walk(root);
  return Object.fromEntries(entries);
}

async function configure(root: string, backend: Backend): Promise<Fixture> {
  const home = join(root, "home");
  for (const directory of [home, join(home, ".lcm"), "tmp", "config", "data", "cache", "state", "runtime"].map(
    path => path.startsWith(root) ? path : join(root, path),
  )) mkdirSync(directory, { recursive: true, mode: 0o700 });
  // No caller credentials or provider selection are inherited by either leg.
  for (const key of Object.keys(process.env)) {
    if ((key.startsWith("LCM_") && !key.startsWith("LCM_TEST_"))
      || /^(OPENAI|ANTHROPIC|CODEX|CLAUDE)_/u.test(key)) vi.stubEnv(key, undefined);
  }
  for (const key of ["HOME", "USERPROFILE"]) vi.stubEnv(key, home);
  for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, join(root, "tmp"));
  for (const [key, directory] of Object.entries({ XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data",
    XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", XDG_RUNTIME_DIR: "runtime" })) vi.stubEnv(key, join(root, directory));
  const config = join(home, ".lcm", "config.json");
  const source = JSON.stringify({ storage: { backend: "sqlite" }, daemon: { port: 49321 }, llm: { provider: "auto" } }) + "\n";
  writeFileSync(config, source, { mode: 0o600 });
  writeFileSync(join(home, ".lcm", "map.json"), "{}\n", { mode: 0o600 });
  if (backend === "postgresql") {
    const ca = join(root, "control-ca.pem");
    writeFileSync(ca, "control fixture: never used to establish a connection\n", { mode: 0o600 });
    vi.stubEnv("LCM_POSTGRES_URL", "postgresql://control:control@127.0.0.1:1/control");
    vi.stubEnv("LCM_POSTGRES_CA_FILE", ca);
    vi.stubEnv("LCM_POSTGRES_MIGRATION_ROLE", "control_migrator");
    const target = JSON.stringify({ ...JSON.parse(source), storage: { backend: "postgresql" } }) + "\n";
    const coordinator = new BackendPublicationCoordinator({ homeDir: home, driver: {
      observeLocalState: async () => captureBackendPublicationState(home),
      publishConfig: input => applyBackendPublicationConfigFile(input),
      restoreConfig: input => applyBackendPublicationConfigFile(input),
      publishProjectMap: input => applyBackendPublicationProjectMapFile(input),
      restoreProjectMap: input => applyBackendPublicationProjectMapFile(input),
    } });
    await coordinator.prepare({ publicationId: "control-contract", sourceBackend: "sqlite", targetBackend: "postgresql",
      material: { source: { config: recoveryFile(source), projectMap: recoveryFile("{}\n") },
        target: { config: recoveryFile(target), projectMap: recoveryFile("{}\n") } }, projects: [] });
    expect((await coordinator.resume()).phase).toBe("completed");
  }
  expect(loadDaemonConfig(config).storage.backend).toBe(backend);
  return { root, home, config, before: snapshot(root) };
}

function resetSeams(): void {
  for (const value of Object.values(seams)) if (vi.isMockFunction(value)) value.mockReset();
  seams.ensureDaemon.mockResolvedValue({ connected: true, spawned: true, pid: 42 });
  seams.restartDaemon.mockResolvedValue({ connected: true, restarted: true, pid: 42 });
  seams.install.mockResolvedValue(undefined);
  seams.uninstall.mockResolvedValue(undefined);
  seams.startMcpServer.mockResolvedValue(undefined);
  seams.createInstallerPublicationConvergence.mockResolvedValue(undefined);
  seams.installConnector.mockReturnValue({ path: "", requiresRestart: true });
  seams.removeConnector.mockReturnValue(true);
  seams.listConnectorInventory.mockReturnValue({ installed: [], codexMcp: { state: "absent" } });
}

function callCounts(): Record<string, number> {
  return Object.fromEntries(Object.entries(seams).filter(([, value]) => vi.isMockFunction(value))
    .map(([key, value]) => [key, vi.isMockFunction(value) ? value.mock.calls.length : 0]));
}

async function invoke(args: string[]): Promise<Observation> {
  let out = "";
  let err = "";
  const spies = [
    vi.spyOn(process, "exit").mockImplementation(seams.exit),
    vi.spyOn(process.stdout, "write").mockImplementation(chunk => { out += String(chunk); return true; }),
    vi.spyOn(process.stderr, "write").mockImplementation(chunk => { err += String(chunk); return true; }),
    vi.spyOn(console, "log").mockImplementation((...values) => { out += values.join(" ") + "\n"; }),
    vi.spyOn(console, "warn").mockImplementation((...values) => { err += values.join(" ") + "\n"; }),
    vi.spyOn(console, "error").mockImplementation((...values) => { err += values.join(" ") + "\n"; }),
  ];
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    // Bootstrap migration is an external home-migration seam, never a data-row substitute.
    await runCli(["node", "lcm", ...args], { migrate: () => undefined });
    return { code: Number(process.exitCode ?? 0), out, err };
  } catch (error) {
    if (error && typeof error === "object" && "controlExit" in error) {
      return { code: Number(error.controlExit), out, err };
    }
    throw error;
  } finally {
    process.exitCode = originalExitCode;
    for (const spy of spies.reverse()) spy.mockRestore();
  }
}

async function variants(path: ControlPath, fixture: Fixture): Promise<Observation[]> {
  const observations: Observation[] = [];
  const before = snapshot(fixture.root);
  async function observe(args: string[]): Promise<Observation> {
    const value = await invoke(args);
    observations.push(value);
    expect(snapshot(fixture.root)).toEqual(before);
    return value;
  }
  resetSeams();
  if (path === "install" || path === "uninstall") {
    const result = await observe([path, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toBe(`\n  lcm ${path} --dry-run\n\n\n  No changes written.\n`);
    const installer = path === "install" ? seams.install : seams.uninstall;
    expect(installer).toHaveBeenCalledExactlyOnceWith(expect.any(DryRunServiceDeps));
  } else if (path === "daemon start" || path === "daemon restart") {
    const lifecycle = path === "daemon start" ? seams.ensureDaemon : seams.restartDaemon;
    lifecycle.mockResolvedValue({ connected: false });
    const result = await observe(path.split(" "));
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("daemon");
    expect(lifecycle).toHaveBeenCalledOnce();
  } else if (path === "config set") {
    const result = await observe(["config", "set", "daemon.port", "{", "--json"]);
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("Invalid JSON configuration value");
    const denied = await observe(["config", "set", "__proto__.polluted", "true", "--json"]);
    expect(denied.code).toBe(1);
    expect(denied.out).toBe("");
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(Object.values(callCounts()).every(count => count === 0)).toBe(true);
  } else if (path === "config get") {
    const missing = await observe(["config", "get"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("missing required argument 'path'");
    expect(Object.values(callCounts()).every(count => count === 0)).toBe(true);
  } else if (path === "connectors list") {
    const result = await observe(["connectors", "list", "--format", "xml"]);
    expect(result).toEqual({ code: 1, out: "", err: "Invalid --format: expected text or json.\n" });
    expect(seams.listConnectorInventory).not.toHaveBeenCalled();
  } else if (path === "connectors install") {
    const invalid = await observe(["connectors", "install", "claude-code", "--transport", "invalid"]);
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain("Allowed choices are cli, mcp");
    expect(seams.installConnector).not.toHaveBeenCalled();
    seams.installConnector.mockImplementation(() => { throw new Error("control-install-refused"); });
    const result = await observe(["connectors", "install", "claude-code", "--global"]);
    expect(result).toEqual({ code: 1, out: "", err: "  Error: control-install-refused\n" });
    expect(seams.installConnector).toHaveBeenCalledExactlyOnceWith("claude-code", undefined, fixture.home, { persistTransport: false, queryCodexMcp: false });
  } else if (path === "connectors remove") {
    seams.removeConnector.mockReturnValue(false);
    const result = await observe(["connectors", "remove", "claude-code", "--global"]);
    expect(result).toEqual({ code: 0, out: "\n  No connector found for claude-code\n\n", err: "" });
    expect(seams.removeConnector).toHaveBeenCalledExactlyOnceWith("claude-code", fixture.home, {});
  } else if (path === "connectors doctor") {
    const result = await observe(["connectors", "doctor", "control-unknown-agent"]);
    expect(result).toEqual({ code: 1, out: "", err: "  Unknown agent: control-unknown-agent\n" });
    expect(seams.listConnectorInventory).not.toHaveBeenCalled();
  }
  return observations;
}

const groupUsage: Partial<Record<ControlPath, string>> = {
  events: "Usage: lcm events <promote|status|validate|quarantine|replay> [options]",
  machine: "Usage: lcm machine <register|show|recover> [options]",
  project: "Usage: lcm project <create|link|unlink|list|show|reconcile-worktrees> [options]",
  postgres: "Usage: lcm postgres migrate [--json]",
  connectors: "Usage: lcm connectors <list|install|remove|doctor> [options]",
};
const validArgs: Partial<Record<ControlPath, string[]>> = {
  "<root>": [], help: ["help", "config"], "daemon start": ["daemon", "start", "--detach"],
  "config get": ["config", "get", "daemon.port", "--effective"],
  "config set": ["config", "set", "daemon.port", "49322", "--json"],
  "connectors list": ["connectors", "list", "--format", "json", "--global"],
  "connectors install": ["connectors", "install", "claude-code", "--transport", "mcp", "--global"],
  "connectors remove": ["connectors", "remove", "claude-code", "--global"],
  "connectors doctor": ["connectors", "doctor", "claude-code", "--global"],
};

async function exercise(path: ControlPath, backend: Backend, fixture: Fixture, completed: string[]): Promise<unknown> {
  const args = validArgs[path] ?? path.split(" ");
  // Parsing is real: invalid options must stop before any action or config write.
  const grammarArgs = path === "<root>" ? ["--control-invalid"]
    : path === "help" ? ["help", "config", "--control-invalid"] : [...args, "--control-invalid"];
  const grammar = await invoke(grammarArgs);
  expect(grammar.code).toBe(1);
  expect(grammar.err).toContain("unknown option '--control-invalid'");
  expect(Object.values(callCounts()).every(count => count === 0)).toBe(true);
  expect(snapshot(fixture.root)).toEqual(fixture.before);
  completed.push("grammar");

  const result = await invoke(args);
  const usage = groupUsage[path];
  expect(result.code).toBe(usage ? 1 : 0);
  if (usage) expect(result.err.trim()).toBe(usage);
  else expect(result.err).toBe("");
  switch (path) {
    case "<root>": expect(result.out).toContain("Usage: lcm <command> [options]"); break;
    case "help": case "config": expect(result.out).toContain("lcm config <get|set>"); break;
    case "daemon": expect(result.out).toBe(""); break;
    case "daemon start": expect(result.out).toBe("lcm daemon started on port 49321 (PID 42)\n"); break;
    case "daemon restart": expect(result.out).toBe("lcm daemon restarted on port 49321 (PID 42)\n"); break;
    case "config get": expect(result.out).toBe("49321\n"); break;
    case "config set": expect(result.out).toBe("Updated daemon.port = 49322\nRestart the daemon to apply this change: lcm daemon restart\n"); break;
    case "connectors list": {
      const rows = JSON.parse(result.out).agents;
      expect(rows.map((row: { id: string }) => row.id)).toEqual(AGENTS.map(agent => agent.id));
      for (const row of rows) expect(row).toMatchObject({ installed: [], installedTransports: [] });
      break;
    }
    case "connectors install": expect(result.out).toContain("Installed mcp connector for claude-code"); expect(result.out).toContain("Restart the agent to activate."); break;
    case "connectors remove": expect(result.out).toContain("Removed connector for claude-code"); break;
    case "connectors doctor": expect(result.out).toBe("\n  Connector health:\n\n  ⚠ Claude Code: no connectors installed\n\n"); break;
    case "install": case "uninstall": case "mcp": expect(result.out).toBe(""); break;
  }
  if (path === "<root>") {
    const version = await invoke(["--version"]);
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(version).toEqual({ code: 0, out: pkg.version + "\n", err: "" });
  }
  completed.push("result");

  const expectedCalls = Object.fromEntries(Object.keys(callCounts()).map(key => [key, 0]));
  const selectedSeam: Partial<Record<ControlPath, keyof typeof seams>> = {
    "daemon start": "ensureDaemon", "daemon restart": "restartDaemon", install: "install", uninstall: "uninstall",
    mcp: "startMcpServer", "connectors install": "installConnector", "connectors remove": "removeConnector",
    "connectors list": "listConnectorInventory", "connectors doctor": "listConnectorInventory",
  };
  const selected = selectedSeam[path];
  if (selected) expectedCalls[selected] = 1;
  if (path === "config get" || path === "install") expectedCalls.createInstallerPublicationConvergence = 1;
  expect(callCounts()).toEqual(expectedCalls);
  if (path === "daemon start" || path === "daemon restart") {
    const call = (path === "daemon start" ? seams.ensureDaemon : seams.restartDaemon).mock.calls[0]![0];
    expect(call).toMatchObject({ port: 49321, expectedStorageBackend: backend,
      pidFilePath: join(fixture.home, ".lcm", "daemon.pid"), spawnTimeoutMs: 10000, enforceUserManagerParent: true });
    if (path === "daemon restart") expect(() => call.validateBeforeRestart()).not.toThrow();
  }
  if (path === "connectors install") expect(seams.installConnector).toHaveBeenCalledWith("claude-code", "mcp", fixture.home, { persistTransport: true, queryCodexMcp: false });
  if (path === "connectors remove") expect(seams.removeConnector).toHaveBeenCalledWith("claude-code", fixture.home, {});
  if (path === "connectors doctor" || path === "connectors list") expect(seams.listConnectorInventory).toHaveBeenCalledWith(fixture.home);
  if (path === "install") expect(seams.install).toHaveBeenCalledWith(undefined, undefined);
  if (path === "uninstall") expect(seams.uninstall).toHaveBeenCalledWith();
  if (path === "mcp") expect(seams.startMcpServer).toHaveBeenCalledWith();
  const after = snapshot(fixture.root);
  if (path === "config set") {
    const configKey = relative(fixture.root, fixture.config);
    expect(after[configKey]).not.toBe(fixture.before[configKey]);
    expect({ ...after, [configKey]: fixture.before[configKey] }).toEqual(fixture.before);
    expect(JSON.parse(readFileSync(fixture.config, "utf8"))).toEqual({ storage: { backend }, daemon: { port: 49322 }, llm: { provider: "auto" } });
    expect(statSync(fixture.config).mode & 0o777).toBe(0o600);
  } else expect(after).toEqual(fixture.before);
  expect(loadDaemonConfig(fixture.config).storage.backend).toBe(backend);
  const calls = callCounts();
  const variantResults = await variants(path, fixture);
  completed.push("effects");
  // Backend selection is asserted above; no paths/credentials enter certificate observations.
  return { grammar, result, calls, variants: variantResults, changedConfig: path === "config set" };
}

/** Same registrar and complete assertion denominator for Core and each admitted PG leg. */
export function registerControlContract(options: {
  emit?: (backend: Backend, rows: ControlRowEvidence[], cleanup: boolean) => void | Promise<void>;
} = {}): void {
  const sqliteObservations = new Map<ControlPath, unknown>();
  for (const backend of ["sqlite", "postgresql"] as const) describe(`surface controls ${backend}`, () => {
    const rows: ControlRowEvidence[] = [];
    let cleaned = true;
    for (const path of CONTROL_PATHS) it(path, async () => {
      const root = mkdtempSync(join(tmpdir(), "lcm-surface-controls-"));
      const assertions: string[] = [];
      let verdict: ControlRowEvidence["verdict"] = "failed";
      let observation: unknown = { failure: "fixture" };
      resetSeams();
      try {
        const fixture = await configure(root, backend);
        observation = await exercise(path, backend, fixture, assertions);
        if (backend === "sqlite") sqliteObservations.set(path, observation);
        else expect(observation).toEqual(sqliteObservations.get(path));
        verdict = "passed";
      } catch {
        // Bounded fixed IDs replace arbitrary filesystem/credential/value diffs in harness output.
        observation = { failure: ["grammar", "result", "effects"][assertions.length] ?? "unknown" };
        throw new Error(`control-contract:${path}:${assertions.length}`);
      } finally {
        try { rmSync(root, { recursive: true, force: true }); }
        catch { cleaned = false; throw new Error("control-contract:cleanup"); }
        finally {
          vi.restoreAllMocks();
          vi.unstubAllEnvs();
          rows.push({ id: `cli:${path}`, assertions, verdict, digest: hash(observation) });
        }
      }
    }, 120_000);
    afterAll(async () => { await options.emit?.(backend, rows, cleaned); }, 120_000);
  });
}
