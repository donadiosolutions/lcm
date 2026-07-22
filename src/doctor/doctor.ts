import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CheckResult, DoctorDeps } from "./types.js";
import { mergeClaudeSettings, REQUIRED_HOOKS, resolveBinaryPath, ensureLcmMd } from "../../installer/install.js";
import { NATIVE_PATTERNS, ScrubEngine, readGitleaksSyncDate } from "../scrub.js";
import { GITLEAKS_PATTERNS } from "../generated-patterns.js";
import { projectDir } from "../daemon/project.js";
import { collectEventStats, collectDetailedEventStats } from "../db/events-stats.js";
import { validateRegex } from "../store/regex-safety.js";
import { configPath, daemonPidPath } from "../runtime-paths.js";
import { projectMapPath, validateProjectMap, type ProjectMapValidation } from "../project-map.js";
import { packageEntrypoint, packageRootFor } from "../runtime-root.js";
import { sanitizeTerminalText } from "../terminal-sanitize.js";
import { managedDaemonPath } from "../daemon/managed-path.js";
import {
  ConfigValidationError,
  DEFAULT_DAEMON_PORT,
  parseDaemonConfig,
  resolveDaemonConfigEnv,
  type LlmRetryPolicy,
  type ResolvedStorageConfig,
} from "../daemon/config.js";
import { selectStorageBackend } from "../storage/backend.js";

const COLORS = {
  green: "\x1b[0;32m",
  yellow: "\x1b[1;33m",
  red: "\x1b[0;31m",
  cyan: "\x1b[0;36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  nc: "\x1b[0m",
};

function defaultDeps(): DoctorDeps {
  return {
    existsSync,
    readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
    writeFileSync,
    mkdirSync: (p, o) => mkdirSync(p, o),
    spawnSync: (cmd, args, opts) => {
      const r = spawnSync(cmd, args, { encoding: "utf-8", ...opts });
      return { status: r.status, stdout: r.stdout as string, stderr: r.stderr as string };
    },
    fetch: globalThis.fetch,
    homedir: homedir(),
    platform: platform(),
  };
}

interface DoctorConfig {
  port: number;
  storageBackend: "sqlite" | "postgresql" | "unavailable";
  storage?: ResolvedStorageConfig;
  storageSelectionError?: Error;
  summarizer: string;
  apiMode?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  requestTimeoutMs?: number;
  retry?: LlmRetryPolicy;
  validationError?: ConfigValidationError;
}

const MANUAL_DAEMON_RESTART_FIX = "stop the stale daemon process, then run: lcm daemon start";
const PASSIVE_BACKLOG_WARN_THRESHOLD = 200;

export interface DoctorRunOptions {
  verbose?: boolean;
  eventsMaxDbs?: number;
}

function normalizeDoctorOptions(options: boolean | DoctorRunOptions = false): Required<DoctorRunOptions> {
  if (typeof options === "boolean") {
    return { verbose: options, eventsMaxDbs: 50 };
  }
  const requestedMaxDbs = options.eventsMaxDbs;
  const eventsMaxDbs = typeof requestedMaxDbs === "number"
    && Number.isInteger(requestedMaxDbs)
    && Number.isFinite(requestedMaxDbs)
    && requestedMaxDbs > 0
    ? requestedMaxDbs
    : 50;
  return {
    verbose: options.verbose ?? false,
    eventsMaxDbs,
  };
}

function recoverConfiguredPort(content: string): number {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_DAEMON_PORT;
    const daemon = (parsed as Record<string, unknown>).daemon;
    if (daemon === null || typeof daemon !== "object" || Array.isArray(daemon)) return DEFAULT_DAEMON_PORT;
    const port = (daemon as Record<string, unknown>).port;
    return typeof port === "number"
      && Number.isInteger(port)
      && port >= 1
      && port <= 65535
      ? port
      : DEFAULT_DAEMON_PORT;
  } catch {
    return DEFAULT_DAEMON_PORT;
  }
}

function loadConfig(deps: DoctorDeps): DoctorConfig {
  const resolvedConfigPath = configPath(deps.homedir);
  if (!deps.existsSync(resolvedConfigPath)) {
    return { port: DEFAULT_DAEMON_PORT, storageBackend: "sqlite", storage: { backend: "sqlite" }, summarizer: "disabled" };
  }

  let content: string | undefined;
  try {
    content = deps.readFileSync(resolvedConfigPath, "utf-8");
    const config = parseDaemonConfig(content, {}, resolveDaemonConfigEnv(process.env));
    try {
      selectStorageBackend(config.storage);
    } catch (error) {
      return {
        port: config.daemon.port,
        storageBackend: "unavailable",
        storage: config.storage,
        storageSelectionError: error as Error,
        summarizer: config.llm.provider,
        apiMode: config.llm.apiMode,
        reasoningEffort: config.llm.reasoningEffort,
        fastMode: config.llm.fastMode,
        requestTimeoutMs: config.llm.provider === "openai" ? config.llm.requestTimeoutMs : undefined,
        retry: config.llm.provider === "openai" ? config.llm.retry : undefined,
      };
    }
    return {
      port: config.daemon.port,
      storageBackend: config.storage.backend,
      storage: config.storage,
      summarizer: config.llm.provider,
      apiMode: config.llm.apiMode,
      reasoningEffort: config.llm.reasoningEffort,
      fastMode: config.llm.fastMode,
      requestTimeoutMs: config.llm.provider === "openai" ? config.llm.requestTimeoutMs : undefined,
      retry: config.llm.provider === "openai" ? config.llm.retry : undefined,
    };
  } catch (error) {
    const validationError = error instanceof ConfigValidationError
      ? error
      : new ConfigValidationError("$", error instanceof Error ? error.message : String(error));
    return {
      port: typeof content === "string" ? recoverConfiguredPort(content) : DEFAULT_DAEMON_PORT,
      storageBackend: "unavailable",
      summarizer: "disabled",
      validationError,
    };
  }
}

function checkProjectMap(results: CheckResult[], deps: DoctorDeps): void {
  let validation: ProjectMapValidation;
  try {
    validation = validateProjectMap({ homeDir: deps.homedir, fix: true });
  } catch (err) {
    results.push({
      name: "project-map",
      category: "Project Map",
      status: "fail",
      message: `${projectMapPath(deps.homedir)}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  if (!validation.ok) {
    results.push({
      name: "project-map",
      category: "Project Map",
      status: "fail",
      message: `${validation.path}: ${validation.errors.join("; ")}`,
    });
    return;
  }

  if (validation.fixApplied) {
    const detail = validation.warnings.length > 0
      ? validation.warnings.join("; ")
      : "formatted map.json";
    const backup = validation.backupPath ? `; backup: ${validation.backupPath}` : "";
    results.push({
      name: "project-map",
      category: "Project Map",
      status: "warn",
      message: `${detail}${backup}`,
      fixApplied: true,
    });
    return;
  }

  const count = validation.map ? Object.keys(validation.map).length : 0;
  const mapExists = existsSync(validation.path);
  results.push({
    name: "project-map",
    category: "Project Map",
    status: "pass",
    message: !mapExists
      ? "map.json not created yet"
      : `${count} mapped project${count === 1 ? "" : "s"}`,
  });
}

function daemonProcessPath(deps: DoctorDeps, pid: number | undefined): string | undefined {
  if (deps.platform !== "linux" || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  try {
    const environment = deps.readFileSync(`/proc/${pid}/environ`, "latin1");
    const pathEntry = environment.split("\0").find((entry) => entry.startsWith("PATH="));
    return pathEntry === undefined ? undefined : pathEntry.slice("PATH=".length);
  } catch {
    return undefined;
  }
}

function checkBinary(deps: DoctorDeps, command: string, daemonPath: string): boolean {
  const onLinux = deps.platform === "linux";
  const opts = onLinux
    ? { env: { PATH: daemonPath } }
    : {};
  return deps.spawnSync(onLinux ? "/bin/sh" : "sh", ["-c", `command -v ${command}`], opts).status === 0;
}

function addClaudeProcessChecks(results: CheckResult[], deps: DoctorDeps, daemonPath: string): void {
  if (checkBinary(deps, "claude", daemonPath)) {
    results.push({ name: "claude-process", category: "Summarizer", status: "pass", message: deps.platform === "linux" ? "claude CLI found on managed daemon PATH" : "claude CLI found" });
  } else {
    results.push({ name: "claude-process", category: "Summarizer", status: "fail", message: `${deps.platform === "linux" ? "claude CLI not found on managed daemon PATH" : "claude CLI not found"}\n     Fix: npm install -g @anthropic-ai/claude-code alongside lcm` });
  }
}

function addCodexProcessChecks(results: CheckResult[], deps: DoctorDeps, daemonPath: string): void {
  if (checkBinary(deps, "codex", daemonPath)) {
    results.push({ name: "codex-process", category: "Summarizer", status: "pass", message: deps.platform === "linux" ? "codex CLI found on managed daemon PATH" : "codex CLI found" });
  } else {
    results.push({ name: "codex-process", category: "Summarizer", status: "fail", message: `${deps.platform === "linux" ? "codex CLI not found on managed daemon PATH" : "codex CLI not found"}\n     Fix: npm install -g @openai/codex alongside lcm` });
  }
}


function testMcpHandshake(): Promise<CheckResult> {
  return new Promise((resolve) => {
    const initMsg = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "doctor", version: "0.1" } } });
    const listMsg = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    // Resolve the binary relative to this file so it works outside Claude Code's PATH
    const root = packageRootFor(import.meta.url, 3);
    const defaultBin = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "lcm.js");
    const binPath = packageEntrypoint(import.meta.url, root, defaultBin);
    const child = spawn(process.execPath, [binPath, "mcp"], { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    let finished = false;
    let stopRequested = false;
    let termination: Promise<void> | undefined;
    let recordChildClose!: () => void;
    const childClosed = new Promise<void>((resolveChildClose) => {
      recordChildClose = resolveChildClose;
    });
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const resultFromOutput = (): CheckResult => {
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const parsed = JSON.parse(line) as { id?: unknown; result?: { tools?: unknown } };
          if (parsed.id !== 2 || !Array.isArray(parsed.result?.tools)) continue;
          const count = parsed.result.tools.length;
          return { name: "mcp-handshake-lcm", category: "MCP Servers", status: count === 7 ? "pass" : "warn", message: `lcm: ${count}/7 tools` };
        } catch {}
      }
      return { name: "mcp-handshake-lcm", category: "MCP Servers", status: "warn", message: "lcm: 0/7 tools" };
    };

    const finish = (result: CheckResult): void => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      resolve(result);
    };

    const childIsLive = (): boolean => child.exitCode === null && child.signalCode === null;
    const signalChild = (signal: NodeJS.Signals): boolean => {
      if (!childIsLive()) return true;
      try { return child.kill(signal); } catch { return false; }
    };
    const waitForClose = async (timeoutMs: number): Promise<void> => {
      let resolveTimeout!: () => void;
      const timeout = new Promise<void>((resolve) => {
        resolveTimeout = resolve;
      });
      const timer = setTimeout(resolveTimeout, timeoutMs);
      await Promise.race([
        childClosed,
        timeout,
      ]);
      clearTimeout(timer);
    };
    const stopChild = (): Promise<void> => {
      stopRequested = true;
      if (!childIsLive()) return Promise.resolve();
      termination ??= (async () => {
        const termSent = signalChild("SIGTERM");
        if (termSent && childIsLive()) await waitForClose(250);
        if (childIsLive()) signalChild("SIGKILL");
        if (childIsLive()) await childClosed;
      })();
      return termination;
    };
    const stopChildForPipeFailure = (): void => {
      if (finished) return;
      void stopChild();
    };
    const stdinIsWritable = (): boolean => !finished
      && !stopRequested
      && childIsLive()
      && child.stdin.writable
      && !child.stdin.destroyed
      && !child.stdin.writableEnded;

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stdout.on("error", stopChildForPipeFailure);
    child.on("close", () => {
      recordChildClose();
      finish(resultFromOutput());
    });
    child.on("error", () => {
      if (stopRequested) return;
      finish({ name: "mcp-handshake-lcm", category: "MCP Servers", status: "warn", message: "Could not spawn MCP process" });
    });
    child.stdin.on("error", stopChildForPipeFailure);
    child.stdin.on("close", () => {
      if (!child.stdin.writableEnded) stopChildForPipeFailure();
    });

    timers.add(setTimeout(() => {
      void (async () => {
        try {
          await stopChild();
        } finally {
          finish(resultFromOutput());
        }
      })();
    }, 6000));

    // Send initialize, wait 300ms, then send tools/list, then close stdin after 500ms
    if (!stdinIsWritable()) {
      stopChildForPipeFailure();
      return;
    }
    timers.add(setTimeout(() => {
      if (!stdinIsWritable()) {
        stopChildForPipeFailure();
        return;
      }
      timers.add(setTimeout(() => {
        if (!stdinIsWritable()) {
          stopChildForPipeFailure();
          return;
        }
        try {
          child.stdin.end();
        } catch {
          stopChildForPipeFailure();
        }
      }, 500));
      try {
        child.stdin.write(listMsg + "\n");
      } catch {
        stopChildForPipeFailure();
      }
    }, 300));
    try {
      child.stdin.write(initMsg + "\n");
    } catch {
      stopChildForPipeFailure();
    }
  });
}

function formatTimeAgo(date: Date): string {
  const ms = Math.max(0, Date.now() - date.getTime());
  if (ms === 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function checkPassiveLearning(
  results: CheckResult[],
  options: Required<DoctorRunOptions>,
  daemonHealthy: boolean,
): Promise<void> {
  const statsOptions = { timeoutMs: 2000, maxDbs: options.eventsMaxDbs, pruneOrphanSidecars: true };
  const stats = options.verbose
    ? await collectDetailedEventStats(statsOptions)
    : await collectEventStats(statsOptions);

  if ((stats.prunedSidecars ?? 0) > 0) {
    results.push({
      name: "events-sidecar-prune",
      category: "Passive Learning",
      status: "pass",
      message: `pruned ${stats.prunedSidecars} empty/stale orphan sidecar${stats.prunedSidecars === 1 ? "" : "s"}`,
      fixApplied: true,
    });
  }

  // Capture check
  if (stats.captured === 0) {
    results.push({ name: "events-capture", category: "Passive Learning", status: "warn", message: "No events captured — passive learning may not be active\n     Fix: run 'lcm install' to re-register hooks, then use a Bash or Edit tool to trigger the first event capture; re-run /lcm-doctor to verify" });
  } else if (stats.unprocessed >= PASSIVE_BACKLOG_WARN_THRESHOLD) {
    const sidecarCount = stats.sidecarsWithUnprocessed ?? 0;
    const orphanCount = stats.orphanedSidecarsWithUnprocessed ?? 0;
    if (daemonHealthy) {
      const scope = sidecarCount > 0
        ? ` across ${sidecarCount} project sidecar${sidecarCount === 1 ? "" : "s"}`
        : "";
      const orphanNote = orphanCount > 0
        ? `; ${orphanCount} sidecar${orphanCount === 1 ? "" : "s"} missing metadata`
        : "";
      if (orphanCount > 0 && orphanCount === sidecarCount) {
        results.push({ name: "events-capture", category: "Passive Learning", status: "warn", message: `${stats.captured} events (${stats.unprocessed} unprocessed${scope}${orphanNote}) — project metadata is missing; lcm events promote --all can only report orphaned sidecars — remove stale orphan sidecars or trigger new activity after lcm install` });
      } else if (orphanCount > 0) {
        results.push({ name: "events-capture", category: "Passive Learning", status: "warn", message: `${stats.captured} events (${stats.unprocessed} unprocessed${scope}${orphanNote}) — daemon is up — run: lcm events promote --all for metadata-backed sidecars; orphaned sidecars need metadata repair or pruning` });
      } else {
        results.push({ name: "events-capture", category: "Passive Learning", status: "warn", message: `${stats.captured} events (${stats.unprocessed} unprocessed${scope}${orphanNote}) — daemon is up — run: lcm events promote --all` });
      }
    } else {
      results.push({ name: "events-capture", category: "Passive Learning", status: "warn", message: `${stats.captured} events (${stats.unprocessed} unprocessed) — daemon may be offline — run: lcm daemon start` });
    }
  } else {
    const pending = stats.unprocessed > 0
      ? `; ${stats.unprocessed} queued for automatic daemon processing`
      : "; queue empty";
    results.push({ name: "events-capture", category: "Passive Learning", status: "pass", message: `${stats.captured} events captured${pending}` });
  }

  // Error check
  if (stats.errors >= 50) {
    results.push({ name: "events-errors", category: "Passive Learning", status: "fail", message: `${stats.errors} hook errors (30d) — check ~/.lcm/logs/events.log` });
  } else if (stats.errors > 0) {
    results.push({ name: "events-errors", category: "Passive Learning", status: "warn", message: `${stats.errors} hook errors (30d) — check ~/.lcm/logs/events.log` });
  } else {
    results.push({ name: "events-errors", category: "Passive Learning", status: "pass", message: "0 hook errors" });
  }

  if ((stats.scanErrors ?? 0) > 0) {
    results.push({ name: "events-sidecar-scan", category: "Passive Learning", status: "warn", message: `${stats.scanErrors} sidecar${stats.scanErrors === 1 ? "" : "s"} failed to scan — run lcm doctor --verbose to identify the affected .db file${stats.scanErrors === 1 ? "" : "s"}` });
  }
  if ((stats.scanSkipped ?? 0) > 0) {
    results.push({
      name: "events-sidecar-scan-skipped",
      category: "Passive Learning",
      status: "skip",
      message: `${stats.scanSkipped} sidecar${stats.scanSkipped === 1 ? "" : "s"} skipped by scan budget — run lcm doctor --events-max-dbs all to remove the count limit; timeout skips may still require retrying`,
    });
  }

  // Staleness check
  if (stats.lastCapture) {
    const isoLastCapture = `${stats.lastCapture.replace(" ", "T")}Z`;
    const lastCaptureDate = new Date(isoLastCapture);
    const lastCaptureTime = lastCaptureDate.getTime();
    if (Number.isNaN(lastCaptureTime)) return;
    const daysSince = (Date.now() - lastCaptureTime) / (1000 * 60 * 60 * 24);
    if (daysSince >= 7) {
      results.push({ name: "events-staleness", category: "Passive Learning", status: "warn", message: `last capture ${Math.floor(daysSince)}d ago — hooks may not be firing if project is active` });
    } else {
      const ago = daysSince < 1 ? `${Math.floor(daysSince * 24)}h ago` : `${Math.floor(daysSince)}d ago`;
      results.push({ name: "events-staleness", category: "Passive Learning", status: "pass", message: `last capture ${ago}` });
    }
  }

  // Verbose: per-project breakdown
  if (options.verbose && "projects" in stats) {
    const detailed = stats as import("../db/events-stats.js").DetailedEventStats;
    for (const p of detailed.projects) {
      const safeFile = sanitizeTerminalText(p.file);
      const safePath = sanitizeTerminalText(p.path);
      if (p.pruned) {
        results.push({ name: `events-project-${safeFile}`, category: "Passive Learning", status: "pass", message: `${safeFile.slice(0, 8)}… pruned: ${sanitizeTerminalText(p.pruneReason ?? "orphan sidecar")} — ${safePath}` });
        continue;
      }
      if (p.scanError) {
        results.push({ name: `events-project-${safeFile}`, category: "Passive Learning", status: "warn", message: `${safeFile.slice(0, 8)}… scan failed: ${sanitizeTerminalText(p.scanError)} — ${safePath}` });
        continue;
      }
      if (p.scanSkipped) {
        results.push({ name: `events-project-${safeFile}`, category: "Passive Learning", status: "skip", message: `${safeFile.slice(0, 8)}… scan skipped: ${sanitizeTerminalText(p.scanSkipped)} — ${safePath}` });
        continue;
      }
      const ago = p.lastCapture ? formatTimeAgo(new Date(`${p.lastCapture.replace(" ", "T")}Z`)) : "never";
      const projectLabel = p.cwd ?? (p.metadataMissing ? "metadata missing" : p.projectId);
      results.push({ name: `events-project-${safeFile}`, category: "Passive Learning", status: "pass", message: `${safeFile.slice(0, 8)}… ${p.captured} events (${p.unprocessed} unprocessed) last: ${ago} — ${sanitizeTerminalText(projectLabel)}` });
    }
    if (detailed.recentErrors.length > 0) {
      const errorLines = detailed.recentErrors.map(e =>
        `  ${sanitizeTerminalText(e.created_at)} ${sanitizeTerminalText(e.hook)}: ${sanitizeTerminalText(e.error)}`
      ).join("\n");
      results.push({ name: "events-recent-errors", category: "Passive Learning", status: "warn", message: `Recent errors:\n${errorLines}` });
    }
  }
}

export async function runDoctor(overrides?: Partial<DoctorDeps>, doctorOptions: boolean | DoctorRunOptions = false): Promise<CheckResult[]> {
  const deps = { ...defaultDeps(), ...overrides };
  const options = normalizeDoctorOptions(doctorOptions);
  const results: CheckResult[] = [];
  const config = loadConfig(deps);

  // ── Stack info ──
  results.push({
    name: "stack",
    category: "Stack",
    status: "pass",
    message: `Storage: ${config.storageBackend}; ` + (config.validationError
      ? `Summarizer: unavailable (${config.validationError.name}: ${config.validationError.message})`
      : config.summarizer === "auto"
      ? `Summarizer: auto (Claude->claude-process, Codex->codex-process); reasoning effort: ${config.reasoningEffort ?? "default"}; fast mode: ${config.fastMode ? "on" : "off"}`
      : `Summarizer: ${config.summarizer}${config.apiMode ? `; API mode: ${config.apiMode}` : ""}${config.reasoningEffort && config.summarizer !== "claude-process" && config.summarizer !== "codex-process" ? `; reasoning effort: ${config.reasoningEffort}` : ""}` +
        `${config.summarizer === "claude-process" || config.summarizer === "codex-process" ? `; reasoning effort: ${config.reasoningEffort ?? "default"}; fast mode: ${config.fastMode ? "on" : "off"}` : ""}` +
        `${config.requestTimeoutMs !== undefined ? `; timeout: ${config.requestTimeoutMs}ms` : ""}` +
        `${config.retry ? `; retry: ${config.retry.maxAttempts} attempts, ${config.retry.initialDelayMs}-${config.retry.maxDelayMs}ms x${config.retry.multiplier}` : ""}`),
  });

  // ── 1. Binary version ──
  // dist/src/doctor/doctor.js → ../../.. → project root
  const pkgPath = join(packageRootFor(import.meta.url, 3), "package.json");
  let pkgVersion: string | undefined;
  try {
    const pkg = JSON.parse(deps.readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    pkgVersion = typeof pkg.version === "string" ? pkg.version : undefined;
    results.push({ name: "version", category: "Stack", status: pkgVersion ? "pass" : "warn", message: pkgVersion ? `v${pkgVersion}` : "Could not read version" });
  } catch {
    results.push({ name: "version", category: "Stack", status: "warn", message: "Could not read version" });
  }

  // ── 2. config.json ──
  const resolvedConfigPath = configPath(deps.homedir);
  if (deps.existsSync(resolvedConfigPath)) {
    results.push(config.validationError
      ? { name: "config", category: "Stack", status: "fail", message: `${resolvedConfigPath}: ${config.validationError.name}: ${config.validationError.message}` }
      : { name: "config", category: "Stack", status: "pass", message: resolvedConfigPath });
  } else {
    results.push({ name: "config", category: "Stack", status: "fail", message: `Missing — run: lcm install` });
  }

  // ── Project path aliases ──
  checkProjectMap(results, deps);

  // ── Daemon ──
  let daemonHealthy = false;
  let daemonVersion: string | undefined;
  let daemonPid: number | undefined;
  if (!config.storageSelectionError) {
    try {
      const res = await deps.fetch(`http://127.0.0.1:${config.port}/health`);
      if (res.ok) {
        const h = (await res.json()) as { status?: string; version?: string; pid?: number };
        daemonHealthy = h.status === "ok";
        daemonVersion = h.version;
      }
    } catch {}
  }

  if (config.storageSelectionError) {
    results.push({
      name: "daemon", category: "Daemon", status: "fail",
      message: `localhost:${config.port} — automatic start skipped: ${config.storageSelectionError.message}`,
      fixApplied: false,
    });
  } else if (config.validationError || config.storageBackend === "unavailable") {
    results.push(daemonHealthy
      ? {
          name: "daemon", category: "Daemon", status: "warn",
          message: `localhost:${config.port} (up) — automatic validation and repair skipped because config is invalid`,
          fixApplied: false,
        }
      : {
          name: "daemon", category: "Daemon", status: "fail",
          message: `localhost:${config.port} not responding — automatic start skipped because config is invalid\n     Fix: correct config.json, then run: lcm daemon start`,
          fixApplied: false,
        });
  } else if (daemonHealthy) {
    const pidFilePath = daemonPidPath(deps.homedir);
    const versionMismatch = Boolean(pkgVersion && daemonVersion !== pkgVersion);
    const daemonVersionLabel = daemonVersion ? `v${daemonVersion}` : "unknown version";
    try {
      selectStorageBackend(config.storage!);
      const { ensureDaemon } = await import("../daemon/lifecycle.js");
      const ensureResult = await ensureDaemon({
        port: config.port,
        pidFilePath,
        spawnTimeoutMs: 10000,
        expectedVersion: pkgVersion,
        expectedStorageBackend: config.storageBackend,
        enforceUserManagerParent: true,
      });
      if (ensureResult.connected) daemonPid = ensureResult.pid;

      let postRestartVersion: string | undefined;
      let postRestartOk = false;
      if (ensureResult.connected) {
        try {
          const res = await deps.fetch(`http://127.0.0.1:${config.port}/health`);
          if (res.ok) {
            const h = (await res.json()) as { status?: string; version?: string };
            postRestartOk = h.status === "ok";
            postRestartVersion = h.version;
          }
        } catch { /* non-fatal */ }
      }

      if (versionMismatch) {
        const fixApplied = ensureResult.connected && postRestartOk && postRestartVersion === pkgVersion;
        if (fixApplied) {
          const warning = ensureResult.warning ? `\n     Warning: ${ensureResult.warning}` : "";
          results.push({
            name: "daemon", category: "Daemon", status: "warn",
            message: `localhost:${config.port} — restarted (${daemonVersionLabel} → v${pkgVersion})${warning}`,
            fixApplied: true,
          });
          daemonHealthy = true;
        } else if (ensureResult.connected) {
          const runningVersionLabel = postRestartVersion ? `v${postRestartVersion}` : daemonVersionLabel;
          results.push({
            name: "daemon", category: "Daemon", status: "warn",
            message: `localhost:${config.port} — version mismatch (${runningVersionLabel} running, v${pkgVersion} installed); restart did not fix mismatch\n     Fix: ${MANUAL_DAEMON_RESTART_FIX}`,
            fixApplied: false,
          });
          daemonHealthy = false;
        } else {
          results.push({
            name: "daemon", category: "Daemon", status: "fail",
            message: `localhost:${config.port} — version mismatch (${daemonVersionLabel} running, v${pkgVersion} installed); restart failed\n     Fix: ${MANUAL_DAEMON_RESTART_FIX}`,
            fixApplied: false,
          });
          daemonHealthy = false;
        }
      } else if (!ensureResult.connected) {
        results.push({
          name: "daemon", category: "Daemon", status: "fail",
          message: `localhost:${config.port} — running daemon could not be validated or restarted\n     Fix: ${MANUAL_DAEMON_RESTART_FIX}`,
          fixApplied: false,
        });
        daemonHealthy = false;
      } else if (ensureResult.restartedForParent) {
        const warning = ensureResult.warning ? `\n     Warning: ${ensureResult.warning}` : "";
        results.push({
          name: "daemon", category: "Daemon", status: "warn",
          message: `localhost:${config.port} — restarted under user systemd${warning}`,
          fixApplied: true,
        });
        daemonHealthy = true;
      } else if (ensureResult.warning) {
        results.push({
          name: "daemon", category: "Daemon", status: "warn",
          message: `localhost:${config.port} (up)\n     Warning: ${ensureResult.warning}`,
          fixApplied: false,
        });
        daemonHealthy = true;
      } else {
        results.push({ name: "daemon", category: "Daemon", status: "pass", message: `localhost:${config.port} (up)` });
        daemonHealthy = true;
      }
    } catch {
      daemonHealthy = false;
      if (versionMismatch) {
        results.push({ name: "daemon", category: "Daemon", status: "warn",
          message: `localhost:${config.port} — version mismatch (${daemonVersionLabel} running, v${pkgVersion} installed)\n     Fix: ${MANUAL_DAEMON_RESTART_FIX}` });
      } else {
        results.push({ name: "daemon", category: "Daemon", status: "warn",
          message: `localhost:${config.port} — daemon validation failed\n     Fix: ${MANUAL_DAEMON_RESTART_FIX}` });
      }
    }
  } else {
    // Auto-fix: try ensureDaemon
    try {
      selectStorageBackend(config.storage!);
      const { ensureDaemon } = await import("../daemon/lifecycle.js");
      const ensureResult = await ensureDaemon({
        port: config.port,
        pidFilePath: daemonPidPath(deps.homedir),
        spawnTimeoutMs: 10000,
        expectedVersion: pkgVersion,
        expectedStorageBackend: config.storageBackend,
        enforceUserManagerParent: true,
      });
      if (ensureResult.connected) {
        daemonPid = ensureResult.pid;
        const warning = ensureResult.warning ? `\n     Warning: ${ensureResult.warning}` : "";
        results.push({ name: "daemon", category: "Daemon", status: "warn", message: `localhost:${config.port} — started${warning}`, fixApplied: true });
        daemonHealthy = true;
      } else {
        results.push({ name: "daemon", category: "Daemon", status: "fail", message: `localhost:${config.port} not responding\n     Fix: lcm daemon start` });
      }
    } catch {
      results.push({ name: "daemon", category: "Daemon", status: "fail", message: `localhost:${config.port} not responding\n     Fix: lcm daemon start` });
    }
  }

  // ── Settings ──
  const settingsPath = join(deps.homedir, ".claude", "settings.json");
  const readSettings = (): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(deps.readFileSync(settingsPath, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  };
  let settingsData: Record<string, unknown> = {};
  try {
    settingsData = readSettings();
  } catch {}

  // Hooks are owned by plugin.json, not settings.json.
  // If hooks leaked into settings.json (old installer), clean them up.
  const hooks = settingsData.hooks as Record<string, unknown[]> | undefined;
  const duplicateHooks: string[] = [];

  for (const { event, command } of REQUIRED_HOOKS) {
    const entries = hooks?.[event];
    const found = Array.isArray(entries) && entries.some((e: any) =>
      Array.isArray(e?.hooks) && e.hooks.some((h: any) => h.command === command)
    );
    if (found) duplicateHooks.push(event);
  }

  if (duplicateHooks.length > 0) {
    try {
      settingsData = mergeClaudeSettings(settingsData);
      deps.writeFileSync(settingsPath, JSON.stringify(settingsData, null, 2));
      results.push({
        name: "hooks",
        category: "Settings",
        status: "warn",
        message: `Removed duplicate ${duplicateHooks.join(", ")} from settings.json (plugin.json owns hooks)`,
        fixApplied: true,
      });
    } catch {
      results.push({
        name: "hooks",
        category: "Settings",
        status: "warn",
        message: `Duplicate ${duplicateHooks.join(", ")} hook ${duplicateHooks.length === 1 ? "entry" : "entries"} in ${settingsPath} — remove the \`hooks.${duplicateHooks[0]}\` block(s) from that file, then run: lcm install`,
      });
    }
  } else {
    results.push({
      name: "hooks",
      category: "Settings",
      status: "pass",
      message: REQUIRED_HOOKS.map(h => `${h.event} \u2713`).join("  "),
    });
  }

  // Re-read settings in case the hooks cleanup branch already modified the file
  let currentSettings: Record<string, unknown> = {};
  try { currentSettings = readSettings(); } catch {}
  const mcpServers = currentSettings.mcpServers as Record<string, unknown> | undefined;
  // For local installs, settings.json is the canonical source for MCP servers (written by lcm install / doctor);
  // plugin.json may also declare mcpServers.lcm but is a secondary/optional registration path.
  if (mcpServers?.["lcm"]) {
    results.push({ name: "mcp-lcm", category: "Settings", status: "pass", message: "mcpServers.lcm registered in settings.json" });
  } else {
    try {
      const merged = mergeClaudeSettings(currentSettings);
      if (typeof merged.mcpServers !== "object" || merged.mcpServers === null) merged.mcpServers = {};
      // Use resolveBinaryPath for consistent binary resolution with installer
      const lcmBinary = resolveBinaryPath(deps);
      (merged.mcpServers as Record<string, unknown>)["lcm"] = { command: lcmBinary, args: ["mcp"] };
      deps.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
      results.push({ name: "mcp-lcm", category: "Settings", status: "warn", message: "mcpServers.lcm missing from settings.json — re-added automatically", fixApplied: true });
    } catch {
      results.push({ name: "mcp-lcm", category: "Settings", status: "fail", message: "mcpServers.lcm missing from settings.json — run: lcm install" });
    }
  }

  // ── lcm.md (Claude Code memory guidance file) ──
  const lcmMdPath = join(deps.homedir, ".claude", "lcm.md");
  const claudeMdPath = join(deps.homedir, ".claude", "CLAUDE.md");
  const lcmMdExists = deps.existsSync(lcmMdPath);
  const claudeMdHasRef = (() => {
    if (!deps.existsSync(claudeMdPath)) return false;
    try {
      const claudeContent = deps.readFileSync(claudeMdPath, "utf-8");
      const lcmBlockMatch = claudeContent.match(/<!--\s*lcm:start\s*-->[\s\S]*?<!--\s*lcm:end\s*-->/);
      if (!lcmBlockMatch) return false;
      return /@lcm\.md/.test(lcmBlockMatch[0]);
    } catch {
      return false;
    }
  })();

  const { LCM_MD_CONTENT } = await import("../daemon/orientation.js");
  const lcmMdStale = lcmMdExists
    ? (() => { try { return deps.readFileSync(lcmMdPath, "utf-8") !== LCM_MD_CONTENT; } catch { return true; } })()
    : false;

  if (lcmMdExists && claudeMdHasRef && !lcmMdStale) {
    results.push({ name: "lcm-md", category: "Settings", status: "pass", message: "~/.claude/lcm.md installed and referenced in CLAUDE.md" });
  } else {
    try {
      const { lcmMdWritten, claudeMdPatched } = ensureLcmMd(deps, LCM_MD_CONTENT, deps.homedir);
      const detail = [
        !lcmMdExists ? "wrote ~/.claude/lcm.md" : lcmMdWritten ? "updated stale ~/.claude/lcm.md" : null,
        claudeMdPatched ? "added @lcm.md to CLAUDE.md" : null,
      ].filter(Boolean).join(", ");
      results.push({ name: "lcm-md", category: "Settings", status: "warn", message: `lcm.md restored (${detail})`, fixApplied: true });
    } catch (err) {
      results.push({ name: "lcm-md", category: "Settings", status: "fail", message: `lcm.md repair failed: ${err instanceof Error ? err.message : String(err)} — run: lcm install` });
    }
  }

  // ── Summarizer (conditional) ──
  const effectiveDaemonPath = deps.managedDaemonPath
    ?? daemonProcessPath(deps, daemonPid)
    ?? managedDaemonPath(process.execPath, [process.argv[1]], deps.cwd);
  if (config.summarizer === "auto") {
    addClaudeProcessChecks(results, deps, effectiveDaemonPath);
    addCodexProcessChecks(results, deps, effectiveDaemonPath);
  } else if (config.summarizer === "claude-process") {
    addClaudeProcessChecks(results, deps, effectiveDaemonPath);
  } else if (config.summarizer === "codex-process") {
    addCodexProcessChecks(results, deps, effectiveDaemonPath);
  } else if (config.summarizer === "anthropic") {
    if (process.env.ANTHROPIC_API_KEY) {
      results.push({ name: "anthropic-key", category: "Summarizer", status: "pass", message: "ANTHROPIC_API_KEY set" });
    } else {
      results.push({ name: "anthropic-key", category: "Summarizer", status: "warn", message: "ANTHROPIC_API_KEY not set in environment" });
    }
  }

  // ── MCP handshake ──
  if (daemonHealthy) {
    try {
      const handshake = deps._testMcpHandshake ?? testMcpHandshake;
      const mcpResult = await handshake();
      results.push(mcpResult);
    } catch {
      results.push({ name: "mcp-handshake-lcm", category: "MCP Servers", status: "warn", message: "Could not test MCP handshake" });
    }
  }

  // ── Security ──

  // Gitleaks health check: verify generated-patterns.js exists and exports non-empty array
  const syncDate = readGitleaksSyncDate();
  const gitleaksCount = GITLEAKS_PATTERNS.length;
  if (gitleaksCount === 0) {
    results.push({
      name: "secret-detection",
      category: "Security",
      status: "fail",
      message: "No gitleaks patterns were loaded (GITLEAKS_PATTERNS is empty) — run: npx tsx scripts/update-gitleaks-patterns.ts",
    });
  } else {
    const syncNote = syncDate ? ` (synced ${syncDate})` : "";
    results.push({
      name: "secret-detection",
      category: "Security",
      status: "pass",
      message: `Secret detection\n     Built-in patterns:  ${gitleaksCount} (gitleaks${syncNote}) + ${NATIVE_PATTERNS.length} (native)\n     Manage patterns:    lcm sensitive add/remove`,
    });
  }

  const cwd = deps.cwd ?? process.cwd();
  const patternsFile = join(projectDir(cwd), "sensitive-patterns.txt");
  const projectPatterns = await ScrubEngine.loadProjectPatterns(patternsFile);

  // Load global user patterns count for informational display
  let globalUserPatternCount = 0;
  try {
    const { loadDaemonConfig } = await import("../daemon/config.js");
    const globalConfigPath = configPath(deps.homedir);
    const config = loadDaemonConfig(globalConfigPath);
    globalUserPatternCount = config.security?.sensitivePatterns?.length ?? 0;
  } catch {
    // config may not exist
  }

  // User patterns: informational only (no warning for zero patterns)
  if (projectPatterns.length > 0) {
    const invalidPatterns: string[] = [];
    for (const pat of projectPatterns) {
      try { validateRegex(pat); } catch { invalidPatterns.push(pat); }
    }
    if (invalidPatterns.length > 0) {
      results.push({
        name: "user-patterns",
        category: "Security",
        status: "warn",
        message: `User patterns:  ${globalUserPatternCount} global, ${projectPatterns.length} project (${invalidPatterns.length} invalid regex — will be skipped)`,
      });
    } else {
      results.push({
        name: "user-patterns",
        category: "Security",
        status: "pass",
        message: `User patterns:  ${globalUserPatternCount} global, ${projectPatterns.length} project`,
      });
    }
  } else {
    results.push({
      name: "user-patterns",
      category: "Security",
      status: "pass",
      message: `User patterns:  ${globalUserPatternCount} global, 0 project`,
    });
  }

  // ── Passive Learning ──
  // The hooks check above always reports pass or warn, so passive-learning
  // diagnostics are always applicable by the time this point is reached.
  await checkPassiveLearning(results, options, daemonHealthy);

  return results;
}

export function printResults(results: CheckResult[]): void {
  console.log(`\n${COLORS.bold}🧠 lcm${COLORS.nc}`);

  let currentCategory = "";

  for (const r of results) {
    if (r.category !== currentCategory) {
      currentCategory = r.category;
      const label = ` ${currentCategory} `;
      const dashes = "─".repeat(42 - 3 - label.length);
      console.log(`\n${COLORS.cyan}──${label}${dashes}${COLORS.nc}`);
    }
    if (r.name === "stack") {
      console.log(`    ${COLORS.dim}${r.message}${COLORS.nc}`);
      continue;
    }

    const icon =
      r.status === "pass" ? `${COLORS.green}✅${COLORS.nc}` :
      r.status === "warn" ? `${COLORS.yellow}⚠️ ${COLORS.nc}` :
      r.status === "skip" ? `${COLORS.dim}⏭️ ${COLORS.nc}` :
                            `${COLORS.red}❌${COLORS.nc}`;
    const suffix = r.fixApplied ? ` ${COLORS.dim}(auto-fixed)${COLORS.nc}` : "";
    console.log(`    ${icon} ${COLORS.dim}${r.name}${COLORS.nc}  ${r.message}${suffix}`);
  }

  const pass = results.filter(r => r.status === "pass" && r.name !== "stack").length;
  const fail = results.filter(r => r.status === "fail").length;
  const warn = results.filter(r => r.status === "warn").length;
  const skip = results.filter(r => r.status === "skip").length;

  console.log(`\n  ${pass} passed · ${fail} failed · ${warn} warnings · ${skip} skipped\n`);
}

export function formatResultsPlain(results: CheckResult[]): string {
  const lines: string[] = [];

  // Group results by category
  const categories: Map<string, CheckResult[]> = new Map();
  for (const r of results) {
    if (!categories.has(r.category)) categories.set(r.category, []);
    categories.get(r.category)!.push(r);
  }

  for (const [category, items] of categories) {
    lines.push(`## ${category}`);

    // Stack entries (name === "stack") go as plain text before the table
    for (const r of items) {
      if (r.name === "stack") {
        lines.push(r.message);
      }
    }

    const tableItems = items.filter(r => r.name !== "stack");
    if (tableItems.length > 0) {
      lines.push("");
      lines.push("| Check | Status |");
      lines.push("|---|---|");
      for (const r of tableItems) {
        const icon = r.status === "pass" ? "✅" : r.status === "warn" ? "⚠️" : r.status === "skip" ? "⏭️" : "❌";
        const suffix = r.fixApplied ? " (auto-fixed)" : "";
        lines.push(`| ${r.name} | ${icon} ${r.message}${suffix} |`);
      }
    }

    lines.push("");
  }

  const pass = results.filter(r => r.status === "pass" && r.name !== "stack").length;
  const fail = results.filter(r => r.status === "fail").length;
  const warn = results.filter(r => r.status === "warn").length;
  const skip = results.filter(r => r.status === "skip").length;
  lines.push(`${pass} passed · ${fail} failed · ${warn} warnings · ${skip} skipped`);
  return lines.join("\n");
}
