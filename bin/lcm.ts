#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { argv, exit, stdin, stdout } from "node:process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { packageRootFor } from "../src/runtime-root.js";
import { DaemonClient } from "../src/daemon/client.js";
import {
  ConfigValidationError,
  LLM_REASONING_EFFORTS,
  reasoningEffortsForProvider,
  resolveLlmRequestPolicy,
  supportsFastMode,
  supportsRequestTimeout,
  type LlmInvocationRequestPolicy,
  type LlmProvider,
  type LlmRequestPolicyConfig,
  type LlmReasoningEffort,
} from "../src/daemon/config.js";
import {
  configPath as defaultConfigPath,
  daemonPidPath,
  daemonTokenPath,
  lcmHomeDir,
  migrateLegacyHomeIfNeeded,
  projectsDir as lcmProjectsDir,
} from "../src/runtime-paths.js";
import type { ProgressState } from "../src/cli/progress-state.js";
import { StorageBackendUnavailableError } from "../src/storage/backend.js";
import { sanitizeTerminalText } from "../src/terminal-sanitize.js";
import { isDaemonTransportFailure } from "../src/daemon/http-url.js";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (stdin.isTTY) { resolve(""); return; }
    const chunks: Buffer[] = [];
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; stdin.destroy(); resolve(Buffer.concat(chunks).toString("utf-8")); }
    }, 5000);
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    stdin.on("end", () => {
      if (!resolved) { resolved = true; clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf-8")); }
    });
  });
}

export function withHookOverrides(
  stdinText: string,
  client: unknown,
  reasoningEffort: LlmReasoningEffort | undefined,
  requestPolicy?: LlmInvocationRequestPolicy,
  fastMode?: boolean,
): string {
  try {
    const parsed = JSON.parse(stdinText || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return stdinText;
    return JSON.stringify({
      ...parsed,
      ...(client === "claude" || client === "codex" ? { client } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(fastMode !== undefined ? { fast_mode: fastMode } : {}),
      ...(requestPolicy ? {
        request_timeout_ms: requestPolicy.requestTimeoutMs,
        ...(requestPolicy.retry ? { retry: {
          max_attempts: requestPolicy.retry.maxAttempts,
          initial_delay_ms: requestPolicy.retry.initialDelayMs,
          max_delay_ms: requestPolicy.retry.maxDelayMs,
          multiplier: requestPolicy.retry.multiplier,
        } } : {}),
      } : {}),
    });
  } catch {
    return stdinText;
  }
}

type CompactRequestPolicyOptions = {
  timeoutMs?: string;
  retryMaxAttempts?: string;
  retryInitialDelayMs?: string;
  retryMaxDelayMs?: string;
  retryMultiplier?: string;
};

type CompactOptions = CompactRequestPolicyOptions & {
  all?: boolean;
  dryRun?: boolean;
  replay?: boolean;
  promote?: boolean;
  reasoningEffort?: LlmReasoningEffort;
  fastMode?: boolean;
  verbose?: boolean;
  hook?: boolean;
  client?: unknown;
  help?: boolean;
};

function numericOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") return Number.NaN;
  return Number(value);
}

function hasCompactRequestPolicyOverride(options: CompactRequestPolicyOptions): boolean {
  return options.timeoutMs !== undefined
    || options.retryMaxAttempts !== undefined
    || options.retryInitialDelayMs !== undefined
    || options.retryMaxDelayMs !== undefined
    || options.retryMultiplier !== undefined;
}

/** Validate and resolve one-invocation timeout/retry flags over loaded config. */
export function resolveCompactRequestPolicyOverride(
  config: LlmRequestPolicyConfig,
  options: CompactRequestPolicyOptions,
): LlmInvocationRequestPolicy | undefined {
  const requestTimeoutMs = numericOption(options.timeoutMs);
  const retry = {
    maxAttempts: numericOption(options.retryMaxAttempts),
    initialDelayMs: numericOption(options.retryInitialDelayMs),
    maxDelayMs: numericOption(options.retryMaxDelayMs),
    multiplier: numericOption(options.retryMultiplier),
  };
  const hasRetryOverride = Object.values(retry).some((value) => value !== undefined);
  const hasOverride = requestTimeoutMs !== undefined || hasRetryOverride;
  if (!hasOverride) return undefined;
  if (requestTimeoutMs !== undefined && !supportsRequestTimeout(config.llm.provider)) {
    throw new ConfigValidationError(
      "compact",
      "timeout overrides require llm.provider=\"auto\", \"openai\", \"claude-process\", or \"codex-process\"",
    );
  }
  if (hasRetryOverride && config.llm.provider !== "openai") {
    throw new ConfigValidationError(
      "compact",
      "retry overrides require llm.provider=\"openai\"",
    );
  }
  const effectivePolicy = resolveLlmRequestPolicy(
    { requestTimeoutMs: config.llm.requestTimeoutMs, retry: config.llm.retry },
    {
      requestTimeoutMs,
      retry: hasRetryOverride ? retry : undefined,
    },
    "compact",
  );
  return config.llm.provider === "openai"
    ? effectivePolicy
    : { requestTimeoutMs: effectivePolicy.requestTimeoutMs };
}

export function compactFailureExitCode(failures: number): 1 | undefined {
  return failures > 0 ? 1 : undefined;
}

/** Manual batch requests identify as Claude, so auto resolves to its process provider. */
export function resolveManualCompactProvider(provider: LlmProvider): LlmProvider {
  return provider === "auto" ? "claude-process" : provider;
}

function withHookClient(stdinText: string, client: unknown): string {
  return withHookOverrides(stdinText, client, undefined);
}

async function withCustomHelp(cmd: Command, commandName: string): Promise<never> {
  const { printHelp } = await import("../src/cli-help.js");
  printHelp(commandName);
  exit(0);
}

type DaemonStartOptions = {
  help?: boolean;
  detach?: boolean;
  foreground?: boolean;
};

type DaemonRootOptions = {
  help?: boolean;
};

export function shouldRunMain(invokedPath: string | undefined, currentFilePath: string): boolean {
  if (!invokedPath) return false;

  try {
    return realpathSync(invokedPath) === realpathSync(currentFilePath);
  } catch {
    return invokedPath === currentFilePath;
  }
}

type CustomHelpRequest = {
  command?: string;
};

/** Resolve custom help before Commander can dispatch a nested command action. */
function resolveCustomHelpRequest(cliArgv: string[]): CustomHelpRequest | undefined {
  const args = cliArgv.slice(2);
  if (args.length === 0) return {};
  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) return {};
  if (!args.includes("-h") && !args.includes("--help")) return undefined;

  const [command] = args;
  return args.length >= 3 && ["daemon", "config", "connectors"].includes(command)
    ? { command }
    : undefined;
}



export function registerMemoryCommands(program: Command): void {
  program
    .command("search <query>")
    .description("Search memory across episodic and promoted layers")
    .option("--limit <n>", "Max results per layer", "5")
    .option("--layer <name>", "Layer to search: episodic or promoted (repeatable)", collectRepeatedOption, [])
    .option("--tag <tag>", "Require a tag on matching entries (repeatable)", collectRepeatedOption, [])
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (query: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("search"); exit(0);
      }

      const layers = normalizeStringList(opts.layer);
      const tags = normalizeStringList(opts.tag) ?? [];
      ensureAllowedValues(layers, ["episodic", "promoted"], "--layer");

      const client = await createDaemonClientOrExit();
      const result = await client.post("/search", {
        cwd: process.cwd(),
        query,
        limit: parsePositiveInteger(String(opts.limit ?? "5"), "--limit"),
        layers,
        tags,
      });
      printJson(result);
    });

  program
    .command("grep <query>")
    .description("Search raw messages and summaries by keyword or regex")
    .option("--mode <mode>", "Search mode: full_text or regex", "full_text")
    .option("--scope <scope>", "Scope: messages, summaries, or both", "both")
    .option("--since <iso>", "Only include matches on or after this ISO timestamp")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (query: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("grep"); exit(0);
      }

      const mode = ensureAllowedValue(opts.mode, ["full_text", "regex"], "--mode");
      const scope = ensureAllowedValue(opts.scope, ["messages", "summaries", "both"], "--scope");

      const client = await createDaemonClientOrExit();
      const result = await client.post("/grep", {
        cwd: process.cwd(),
        query,
        mode,
        scope,
        since: typeof opts.since === "string" && opts.since.length > 0 ? opts.since : undefined,
      });
      printJson(result);
    });

  program
    .command("describe <nodeId>")
    .description("Inspect metadata for a summary or stored memory node")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (nodeId: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("describe"); exit(0);
      }

      const client = await createDaemonClientOrExit();
      const result = await client.post("/describe", { cwd: process.cwd(), nodeId });
      printJson(result);
    });

  program
    .command("expand <nodeId>")
    .description("Expand a summary node back into source detail")
    .option("--depth <n>", "Traversal depth", "1")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (nodeId: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("expand"); exit(0);
      }

      const client = await createDaemonClientOrExit();
      const result = await client.post("/expand", {
        cwd: process.cwd(),
        nodeId,
        depth: parsePositiveInteger(String(opts.depth ?? "1"), "--depth"),
      });
      printJson(result);
    });

  program
    .command("store <text>")
    .description("Store a durable memory entry for the current project")
    .option("--tag <tag>", "Attach a tag to the stored memory (repeatable)", collectRepeatedOption, [])
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (text: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("store"); exit(0);
      }

      const client = await createDaemonClientOrExit();
      const result = await client.post("/store", {
        cwd: process.cwd(),
        text,
        tags: normalizeStringList(opts.tag) ?? [],
        metadata: {},
      });
      printJson(result);
    });
}

async function loadIdentityStorageConfig() {
  const { loadDaemonConfig } = await import("../src/daemon/config.js");
  return loadDaemonConfig(defaultConfigPath()).storage;
}

export function registerProjectCommand(program: Command): void {
  type ProjectOptions = {
    help?: boolean;
    json?: boolean;
    name?: string;
    allowExistingData?: boolean;
    dryRun?: boolean;
  };

  const projectError = (err: unknown, opts: { json?: boolean } = {}): never => {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      printJson({ error: message });
    } else {
      console.error(`Error: ${message}`);
    }
    exit(1);
  };

  const projectCmd = new Command("project").description("Manage local and PostgreSQL project identities");
  projectCmd.helpOption(false).option("-h, --help", "Show help");
  const projectHelpRequested = (opts: ProjectOptions): boolean =>
    opts.help === true || projectCmd.opts<ProjectOptions>().help === true;
  projectCmd.action(async (opts: ProjectOptions) => {
    if (projectHelpRequested(opts)) {
      const { printHelp } = await import("../src/cli-help.js");
      printHelp("project"); exit(0);
    }
    console.error("Usage: lcm project <create|link|unlink|list|show|reconcile-worktrees> [options]");
    exit(1);
  });

  projectCmd
    .command("reconcile-worktrees [path]")
    .description("Preview or reconcile local state from linked and deleted Codex worktrees")
    .option("--dry-run", "Preview without changing local state")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (path: string | undefined, opts: ProjectOptions) => {
      if (projectHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("project"); exit(0);
      }
      try {
        const { reconcileWorktrees } = await import("../src/worktree-reconciliation.js");
        const result = reconcileWorktrees(path ?? process.cwd(), { dryRun: opts.dryRun });
        if (opts.json) {
          printJson(result);
          return;
        }
        console.log(`worktree reconciliation: ${result.status}`);
        console.log(`  canonical: ${sanitizeTerminalText(result.canonical)}`);
        console.log(`  project: ${result.targetHash}`);
        console.log(`  sources: ${result.sourceHashes.length}`);
        if (result.journalPath) {
          console.log(`  journal: ${sanitizeTerminalText(result.journalPath)}`);
        }
        for (const backup of result.backupPaths) {
          console.log(`  backup: ${sanitizeTerminalText(backup)}`);
        }
        if (result.reason) console.log(`  reason: ${sanitizeTerminalText(result.reason)}`);
      } catch (err) {
        projectError(err, opts);
      }
    });

  projectCmd
    .command("list")
    .description("List local projects and configured PostgreSQL identities")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts: ProjectOptions) => {
      if (projectHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("project"); exit(0);
      }
      try {
        const { listProjects } = await import("../src/identity-service.js");
        const result = await listProjects(await loadIdentityStorageConfig());
        if (opts.json) {
          printJson(result);
          return;
        }
        for (const entry of result.local) {
          console.log(entry.hash);
          console.log(`  canonical: ${sanitizeTerminalText(entry.canonical)}`);
          if (entry.remoteProjectId) console.log(`  PostgreSQL project: ${entry.remoteProjectId}`);
          for (const alias of entry.aliases) {
            console.log(`  alias: ${sanitizeTerminalText(alias)}`);
          }
        }
        if (result.remote) {
          console.log("PostgreSQL projects:");
          for (const remote of result.remote) {
            console.log(`  ${remote.projectId}  ${sanitizeTerminalText(remote.displayName)}`);
            for (const alias of remote.aliases) {
              console.log(`    ${alias.machineId}: ${sanitizeTerminalText(alias.path)}`);
            }
          }
        }
      } catch (err) {
        projectError(err, opts);
      }
    });

  projectCmd
    .command("show [target]")
    .description("Show one local project and its PostgreSQL identity")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (target: string | undefined, opts: ProjectOptions) => {
      if (projectHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("project"); exit(0);
      }
      try {
        const { showProject } = await import("../src/identity-service.js");
        const shown = await showProject(await loadIdentityStorageConfig(), target);
        if (opts.json) {
          printJson(shown);
          return;
        }
        console.log(shown.hash);
        console.log(`  canonical: ${sanitizeTerminalText(shown.entry.canonical)}`);
        if (shown.entry.remoteProjectId) {
          console.log(`  PostgreSQL project: ${shown.entry.remoteProjectId}`);
        }
        for (const alias of shown.entry.aliases) {
          console.log(`  alias: ${sanitizeTerminalText(alias)}`);
        }
        if (shown.remote) console.log(`  name: ${sanitizeTerminalText(shown.remote.displayName)}`);
      } catch (err) {
        projectError(err, opts);
      }
    });

  projectCmd
    .command("link [target] [path]")
    .description("Link a path to a PostgreSQL UUID or local project target")
    .option("--allow-existing-data", "Acknowledge rebinding a data-bearing local project")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (target: string | undefined, path: string | undefined, opts: ProjectOptions) => {
      if (projectHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("project"); exit(0);
      }
      try {
        if (!target) throw new Error("missing required argument 'target'");
        const { linkProject } = await import("../src/identity-service.js");
        const result = await linkProject(
          await loadIdentityStorageConfig(),
          target,
          path,
          { allowExistingData: opts.allowExistingData },
        );
        if (opts.json) {
          printJson(result);
          return;
        }
        console.log(`Linked ${sanitizeTerminalText(result.local.canonical)}`);
        console.log(`  local hash: ${result.local.id}`);
        if (result.local.remoteProjectId) {
          console.log(`  PostgreSQL project: ${result.local.remoteProjectId}`);
        }
      } catch (err) {
        projectError(err, opts);
      }
    });

  projectCmd
    .command("unlink [path]")
    .description("Remove a local alias or PostgreSQL project binding")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (path: string | undefined, opts: ProjectOptions) => {
      if (projectHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("project"); exit(0);
      }
      try {
        const { unlinkProject } = await import("../src/identity-service.js");
        const result = await unlinkProject(await loadIdentityStorageConfig(), path);
        if (opts.json) {
          printJson(result);
          return;
        }
        console.log(
          `${result.aliasRemoved ? "Removed project alias from" : "Unbound PostgreSQL project from"} ${result.hash}`,
        );
      } catch (err) {
        projectError(err, opts);
      }
    });

  projectCmd
    .command("create [path]")
    .description("Create a PostgreSQL project and bind a local path")
    .option("--name <display-name>", "Human-readable project name")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (path: string | undefined, opts: ProjectOptions) => {
      if (projectHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("project"); exit(0);
      }
      try {
        const { createProject } = await import("../src/identity-service.js");
        const result = await createProject(
          await loadIdentityStorageConfig(),
          path,
          { displayName: opts.name },
        );
        if (opts.json) {
          printJson(result);
          return;
        }
        console.log(`Created PostgreSQL project ${result.remote.projectId}`);
        console.log(`  local hash: ${result.local.id}`);
        console.log(`  path: ${sanitizeTerminalText(result.local.canonical)}`);
      } catch (err) {
        projectError(err, opts);
      }
    });

  program.addCommand(projectCmd);
}

export function registerMachineCommand(program: Command): void {
  type MachineOptions = {
    help?: boolean;
    json?: boolean;
    name?: string;
    force?: boolean;
  };
  const machineError = (err: unknown, opts: MachineOptions): never => {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) printJson({ error: message });
    else console.error(`Error: ${message}`);
    exit(1);
  };
  const machineCmd = new Command("machine").description("Manage this machine's PostgreSQL identity");
  machineCmd.helpOption(false).option("-h, --help", "Show help");
  const machineHelpRequested = (opts: MachineOptions): boolean =>
    opts.help === true || machineCmd.opts<MachineOptions>().help === true;
  machineCmd.action(async (opts: MachineOptions) => {
    if (machineHelpRequested(opts)) {
      const { printHelp } = await import("../src/cli-help.js");
      printHelp("machine"); exit(0);
    }
    console.error("Usage: lcm machine <register|show|recover> [options]");
    exit(1);
  });

  machineCmd
    .command("register")
    .description("Register or refresh this machine in PostgreSQL")
    .option("--name <display-name>", "Human-readable machine name")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts: MachineOptions) => {
      if (machineHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("machine"); exit(0);
      }
      try {
        const { registerMachine } = await import("../src/identity-service.js");
        const result = await registerMachine(
          await loadIdentityStorageConfig(),
          { displayName: opts.name },
        );
        const output = {
          registered: true,
          created: result.created,
          machineId: result.identity.machineId,
          displayName: result.identity.displayName,
          version: result.identity.version,
        };
        if (opts.json) {
          printJson(output);
          return;
        }
        console.log(`${result.created ? "Registered" : "Refreshed"} machine ${output.machineId}`);
        console.log(`  name: ${output.displayName}`);
      } catch (err) {
        machineError(err, opts);
      }
    });

  machineCmd
    .command("show")
    .description("Show this machine's local identity")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts: MachineOptions) => {
      if (machineHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("machine"); exit(0);
      }
      try {
        const { showMachine } = await import("../src/identity-service.js");
        const shown = showMachine();
        if (!shown) throw new Error("machine identity is not registered; run `lcm machine register`");
        const output = {
          version: shown.version,
          status: shown.machineId === null ? "pending" : "registered",
          machineId: shown.machineId,
          displayName: shown.displayName,
        };
        if (opts.json) {
          printJson(output);
          return;
        }
        console.log(output.machineId ?? "pending");
        console.log(`  status: ${output.status}`);
        console.log(`  name: ${output.displayName}`);
      } catch (err) {
        machineError(err, opts);
      }
    });

  machineCmd
    .command("recover [machine-id]")
    .description("Recover a machine identity by its PostgreSQL UUID")
    .option("--force", "Replace and privately back up a conflicting local identity")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (machineId: string | undefined, opts: MachineOptions) => {
      if (machineHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("machine"); exit(0);
      }
      try {
        if (!machineId) throw new Error("missing required argument 'machine-id'");
        const { recoverMachine } = await import("../src/identity-service.js");
        const result = await recoverMachine(
          await loadIdentityStorageConfig(),
          machineId,
          { force: opts.force },
        );
        const output = {
          recovered: true,
          machineId: result.identity.machineId,
          displayName: result.identity.displayName,
          ...(result.backupPath ? { backupPath: result.backupPath } : {}),
        };
        if (opts.json) {
          printJson(output);
          return;
        }
        console.log(`Recovered machine ${output.machineId}`);
        console.log(`  name: ${output.displayName}`);
        if (output.backupPath) console.log(`  backup: ${output.backupPath}`);
      } catch (err) {
        machineError(err, opts);
      }
    });

  program.addCommand(machineCmd);
}

export function registerPostgreSqlCommand(program: Command): void {
  type PostgreSqlOptions = {
    help?: boolean;
    json?: boolean;
  };
  const postgresCmd = new Command("postgres")
    .description("Provision and maintain PostgreSQL storage");
  postgresCmd.helpOption(false).option("-h, --help", "Show help");
  const helpRequested = (opts: PostgreSqlOptions): boolean =>
    opts.help === true || postgresCmd.opts<PostgreSqlOptions>().help === true;
  postgresCmd.action(async (opts: PostgreSqlOptions) => {
    if (helpRequested(opts)) {
      const { printHelp } = await import("../src/cli-help.js");
      printHelp("postgres"); exit(0);
    }
    console.error("Usage: lcm postgres migrate [--json]");
    exit(1);
  });

  postgresCmd
    .command("migrate")
    .description("Apply packaged PostgreSQL schema migrations")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts: PostgreSqlOptions) => {
      if (helpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("postgres"); exit(0);
      }
      try {
        const { provisionPostgreSql } = await import(
          "../src/storage/postgresql/provisioning.js"
        );
        const result = await provisionPostgreSql(await loadIdentityStorageConfig());
        const output = {
          backend: "postgresql",
          applied: [...result.applied],
          current: [...result.current],
        };
        if (opts.json) {
          printJson(output);
          return;
        }
        if (output.applied.length === 0) {
          console.log("PostgreSQL schema is current.");
        } else {
          console.log(
            `Applied ${output.applied.length} PostgreSQL migration${output.applied.length === 1 ? "" : "s"}: ${output.applied.join(", ")}`,
          );
        }
        console.log(`  current migrations: ${output.current.length}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (opts.json) printJson({ error: message });
        else console.error(`Error: ${message}`);
        exit(1);
      }
    });

  program.addCommand(postgresCmd);
}

function collectRepeatedOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    console.error(`Invalid ${optionName}: ${value}`);
    exit(1);
  }
  return parsed;
}

function parsePositiveIntegerOrAll(value: string, optionName: string): number {
  if (value === "all" || value === "unlimited") return Number.MAX_SAFE_INTEGER;
  return parsePositiveInteger(value, optionName);
}

function ensureAllowedValues(values: string[] | undefined, allowed: readonly string[], optionName: string): void {
  if (!values) return;
  const invalid = values.filter((value) => !allowed.includes(value));
  if (invalid.length > 0) {
    console.error(`Invalid ${optionName}: ${invalid.join(", ")}`);
    exit(1);
  }
}

function ensureAllowedValue(value: unknown, allowed: readonly string[], optionName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    console.error(`Invalid ${optionName}: ${String(value)}`);
    exit(1);
  }
  return value;
}

function printJson(value: unknown): void {
  stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** @internal Output seams used by the executable's Commander configuration. */
export function writeCliOutput(value: string): void {
  stdout.write(value);
}

/** @internal Output seams used by the executable's Commander configuration. */
export function writeCliError(value: string): void {
  process.stderr.write(value);
}

async function createDaemonClientOrExit(
  options: { readonly preflightStorage?: boolean } = {},
): Promise<DaemonClient> {
  const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
  const { loadDaemonConfig } = await import("../src/daemon/config.js");
  const { selectStorageBackend } = await import("../src/storage/backend.js");

  migrateLegacyHomeIfNeeded();
  const config = loadDaemonConfig(defaultConfigPath());
  if (options.preflightStorage !== false) selectStorageBackend(config.storage);
  const port = config.daemon?.port ?? 3737;
  const pidFilePath = daemonPidPath();
  const tokenPath = daemonTokenPath();
  const { connected } = await ensureDaemon({
    port,
    pidFilePath,
    spawnTimeoutMs: 5000,
    expectedStorageBackend: config.storage.backend,
    enforceUserManagerParent: true,
  });

  if (!connected) {
    console.error("  Daemon not available. Start it with: lcm daemon start --detach");
    exit(1);
  }

  return new DaemonClient(`http://127.0.0.1:${port}`, tokenPath);
}

/** @internal CLI entry seam; defaults preserve the published executable behavior. */
export async function runCli(cliArgv: string[] = process.argv): Promise<void> {
  migrateLegacyHomeIfNeeded();
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const pkgPath = join(packageRootFor(import.meta.url, 2), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  const program = new Command();
  program
    .name("lcm")
    .description("Long Context Manager for coding agents")
    .version(pkg.version, "-V, --version")
    .helpCommand(false)
    .addHelpCommand(false)
    .configureOutput({
      writeOut: writeCliOutput,
      writeErr: writeCliError,
    });

  // Disable Commander's built-in help entirely — we handle it manually below
  program.helpOption(false);

  // ─── help command ──────────────────────────────────────────────────────────
  program
    .command("help [command]")
    .description("Show help for a command")
    .action(async (subcommand?: string) => {
      const { printHelp } = await import("../src/cli-help.js");
      printHelp(subcommand);
      exit(0);
    });

  // ─── daemon ────────────────────────────────────────────────────────────────
  const daemonCmd = new Command("daemon").description("Start the context daemon");
  daemonCmd.helpOption(false).option("-h, --help", "Show help");
  daemonCmd.command("start")
    .description("Start the context daemon")
    .option("--detach", "Run in the background (compatibility alias)")
    .option("--foreground", "Run in the foreground for debugging")
    .option("-h, --help", "Show help")
    .action(async (opts: DaemonStartOptions) => {
      if (opts.help) await withCustomHelp(daemonCmd, "daemon");
      if (!opts.foreground) {
        const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
        const { loadDaemonConfig } = await import("../src/daemon/config.js");
        const config = loadDaemonConfig(defaultConfigPath());
        const port = config.daemon?.port ?? 3737;
        const result = await ensureDaemon({
          port,
          pidFilePath: daemonPidPath(),
          spawnTimeoutMs: 10000,
          expectedVersion: typeof pkg.version === "string" ? pkg.version : undefined,
          expectedStorageBackend: config.storage.backend,
          enforceUserManagerParent: true,
        });
        if (!result.connected) {
          console.error("  Daemon not available. Try: lcm daemon start --foreground");
          if (result.warning) console.error(`  Warning: ${result.warning}`);
          exit(1);
        }
        if (result.warning) console.warn(`Warning: ${result.warning}`);
        if (result.restartedForParent) {
          console.log(`lcm daemon restarted under user systemd on port ${port}${result.pid ? ` (PID ${result.pid})` : ""}`);
        } else if (result.spawned) {
          console.log(`lcm daemon started on port ${port}${result.pid ? ` (PID ${result.pid})` : ""}`);
        } else {
          console.log(`lcm daemon already running on port ${port}${result.pid ? ` (PID ${result.pid})` : ""}`);
        }
        exit(0);
      }
      const { createDaemon } = await import("../src/daemon/server.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { ensureAuthToken } = await import("../src/daemon/auth.js");
      const { writeFileSync, mkdirSync, readFileSync, unlinkSync } = await import("node:fs");
      const lcDir = lcmHomeDir();
      const tokenPath = join(lcDir, "daemon.token");
      ensureAuthToken(tokenPath);
      const config = loadDaemonConfig(join(lcDir, "config.json"));
      const pidFilePath = daemonPidPath();
      const cleanupPidFile = (): void => {
        try {
          if (readFileSync(pidFilePath, "utf-8").trim() === String(process.pid)) {
            unlinkSync(pidFilePath);
          }
        } catch {
          // Best-effort cleanup; stale PID files are handled by ensureDaemon.
        }
      };
      const daemon = await createDaemon(config, { tokenPath });
      mkdirSync(lcDir, { recursive: true });
      writeFileSync(pidFilePath, String(process.pid));
      process.on("exit", cleanupPidFile);
      console.log(`lcm daemon started on port ${daemon.address().port}`);
      process.on("SIGTERM", () => exit(0));
      process.on("SIGINT", () => exit(0));
    });
  daemonCmd.command("restart")
    .description("Restart the managed context daemon and reload configuration")
    .option("-h, --help", "Show help")
    .action(async (opts: { help?: boolean }) => {
      if (opts.help) await withCustomHelp(daemonCmd, "daemon");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { restartDaemon } = await import("../src/daemon/lifecycle.js");
      const config = loadDaemonConfig(defaultConfigPath());
      const port = config.daemon?.port ?? 3737;
      const result = await restartDaemon({
        port,
        pidFilePath: daemonPidPath(),
        spawnTimeoutMs: 10000,
        expectedVersion: typeof pkg.version === "string" ? pkg.version : undefined,
        expectedStorageBackend: config.storage.backend,
        enforceUserManagerParent: true,
        validateBeforeRestart: () => { loadDaemonConfig(defaultConfigPath()); },
      });
      if (!result.connected) {
        console.error("  Daemon restart failed. Try: lcm daemon start --foreground");
        if (result.warning) console.error(`  Warning: ${result.warning}`);
        exit(1);
      }
      if (result.warning) console.warn(`Warning: ${result.warning}`);
      const action = result.restarted ? "restarted" : result.spawned ? "started" : "already running";
      console.log(`lcm daemon ${action} on port ${port}${result.pid ? ` (PID ${result.pid})` : ""}`);
      exit(0);
    });
  daemonCmd.action(async (opts: DaemonRootOptions) => {
    if (opts.help) await withCustomHelp(daemonCmd, "daemon");
  });
  program.addCommand(daemonCmd);

  // ─── config ────────────────────────────────────────────────────────────────
  const configCmd = new Command("config").description("Inspect or update validated local configuration");
  configCmd.helpOption(false).option("-h, --help", "Show help");
  configCmd.command("get")
    .description("Read a configuration value")
    .argument("<path>", "Dotted JSON configuration path")
    .option("--effective", "Include defaults and environment-variable overrides")
    .option("-h, --help", "Show help")
    .action(async (path: string, opts: { effective?: boolean; help?: boolean }) => {
      if (opts.help) await withCustomHelp(configCmd, "config");
      try {
        const { formatConfigValue, getConfigValue } = await import("../src/config-manager.js");
        console.log(formatConfigValue(getConfigValue({
          configPath: defaultConfigPath(),
          path,
          effective: opts.effective ?? false,
        })));
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Unable to read configuration");
        exit(1);
      }
    });
  configCmd.command("set")
    .description("Write a validated configuration value")
    .argument("<path>", "Dotted JSON configuration path")
    .argument("<value>", "String value, or JSON when --json is supplied")
    .option("--json", "Parse value as JSON")
    .option("-h, --help", "Show help")
    .action(async (path: string, value: string, opts: { json?: boolean; help?: boolean }) => {
      if (opts.help) await withCustomHelp(configCmd, "config");
      try {
        const { formatConfigValue, normalizeConfigPath, setConfigValue } = await import("../src/config-manager.js");
        const stored = setConfigValue({
          configPath: defaultConfigPath(),
          path,
          value,
          json: opts.json ?? false,
        });
        console.log(`Updated ${normalizeConfigPath(path)} = ${formatConfigValue(stored)}`);
        console.log("Restart the daemon to apply this change: lcm daemon restart");
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Unable to update configuration");
        exit(1);
      }
    });
  configCmd.action(async () => {
    await withCustomHelp(configCmd, "config");
  });
  program.addCommand(configCmd);

  // ─── compact ───────────────────────────────────────────────────────────────
  program
    .command("compact")
    .description("Compact conversation context into DAG summary nodes")
    .option("--all", "Compact all tracked projects")
    .option("--dry-run", "Show what would be compacted without writing")
    .option("--replay", "Compact sequentially with threaded context")
    .option("--no-promote", "Skip the automatic promote step")
    .addOption(new Option("--reasoning-effort <value>", "Override provider reasoning effort for this invocation")
      .choices([...LLM_REASONING_EFFORTS]))
    .option("--fast-mode", "Enable provider fast mode for this invocation")
    .option("--no-fast-mode", "Disable provider fast mode for this invocation")
    .option("--timeout-ms <ms>", "Override OpenAI-compatible request timeout for this invocation")
    .option("--retry-max-attempts <n>", "Override OpenAI-compatible maximum attempts for this invocation")
    .option("--retry-initial-delay-ms <ms>", "Override OpenAI-compatible initial retry delay")
    .option("--retry-max-delay-ms <ms>", "Override OpenAI-compatible maximum retry delay")
    .option("--retry-multiplier <n>", "Override OpenAI-compatible retry multiplier")
    .option("-v, --verbose", "Show per-session token details")
    .addOption(new Option("--hook", "Hook dispatch mode (internal)").hideHelp())
    .addOption(new Option("--client <client>", "Hook client identity (internal)").hideHelp())
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts: CompactOptions) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("compact"); exit(0);
      }
      const all: boolean = opts.all ?? false;
      const dryRun: boolean = opts.dryRun ?? false;
      const verbose: boolean = opts.verbose ?? false;
      const replay: boolean = opts.replay ?? false;
      const reasoningEffort = opts.reasoningEffort;
      const fastMode = opts.fastMode;
      // Hook dispatch only when --hook is explicit; all other invocations go to batch.
      const hook: boolean = opts.hook ?? false;
      if (!hook) {
        const { batchCompact } = await import("../src/batch-compact.js");
        const { loadDaemonConfig } = await import("../src/daemon/config.js");
        const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
        const { selectStorageBackend } = await import("../src/storage/backend.js");
        const config = loadDaemonConfig(defaultConfigPath());
        selectStorageBackend(config.storage);
        const requestPolicy = resolveCompactRequestPolicyOverride(config, opts);
        const effectiveProvider = resolveManualCompactProvider(config.llm.provider);
        const supportedEfforts = reasoningEffortsForProvider(effectiveProvider, config.llm.apiMode);
        if (reasoningEffort && !supportedEfforts.includes(reasoningEffort)) {
          console.error(`  --reasoning-effort ${reasoningEffort} is not supported by the effective provider "${effectiveProvider}"${effectiveProvider === "openai" ? ` with llm.apiMode="${config.llm.apiMode}"` : ""}; supported values: ${supportedEfforts.join(", ") || "none"}`);
          exit(1);
        }
        if (fastMode !== undefined && !supportsFastMode(effectiveProvider)) {
          console.error(`  --${fastMode ? "fast-mode" : "no-fast-mode"} requires llm.provider="auto", "claude-process", or "codex-process"`);
          exit(1);
        }
        const port = config.daemon?.port ?? 3737;
        const pidFilePath = daemonPidPath();
        const { connected } = await ensureDaemon({
          port,
          pidFilePath,
          spawnTimeoutMs: 10000,
          expectedStorageBackend: config.storage.backend,
          enforceUserManagerParent: true,
        });
        if (!connected) {
          console.error("Could not connect to daemon. Start it with: lcm daemon start --detach");
          exit(1);
        }
        const noPromote: boolean = !opts.promote;
        const minTokens = config.compaction.autoCompactMinTokens;
        const cwd = all ? undefined : process.cwd();
        const tokenPath = daemonTokenPath();
        let client = new DaemonClient(`http://127.0.0.1:${port}`, tokenPath);

        const { NinjaRenderer } = await import("../src/cli/pipeline-runner.js");
        const { makeProgressState } = await import("../src/cli/progress-state.js");
        const isTTY = process.stdout.isTTY ?? false;
        const renderOpts = { isTTY, width: process.stdout.columns ?? 80, color: isTTY, verbose };
        const compactState = makeProgressState({ phases: [
          { name: "Compact", status: "active" },
          ...(!noPromote ? [{ name: "Promote", status: "pending" } as const] : []),
        ], dryRun });
        const compactRenderer = new NinjaRenderer({ state: compactState, renderOpts });
        compactRenderer.start();

        let totalFailures = 0;
        let totalPromoted = 0;
        try {
          const { compacted, failures, compactedProjects } = await batchCompact({
            minTokens, dryRun, port, cwd, replay, verbose, tokenPath, reasoningEffort, fastMode, requestPolicy,
            onProgress: (patch: Partial<ProgressState>): void => {
              Object.assign(compactState, patch);
              if (patch.lastResult) compactRenderer.sessionDone();
            },
          });

          compactState.phases[0].status = "done";

          // Auto-promote after a successful compact: new summaries are prime promotion candidates.
          let promotionFailures = 0;
          if (compacted > 0 && !noPromote) {
            compactState.phases[1]!.status = "active";
            for (const promoteCwd of compactedProjects) {
              compactState.currentProject = promoteCwd;
              if (!isTTY || verbose) console.log(`  promoting: ${promoteCwd}...`);
              try {
                const promotionBody = { cwd: promoteCwd, dry_run: dryRun };
                let result: { processed: number; promoted: number };
                try {
                  result = await client.post("/promote", promotionBody);
                } catch (error) {
                  if (!isDaemonTransportFailure(error)) throw error;
                  const recovery = await ensureDaemon({
                    port,
                    pidFilePath,
                    spawnTimeoutMs: 10000,
                    expectedStorageBackend: config.storage.backend,
                    enforceUserManagerParent: true,
                  });
                  if (!recovery.connected) throw error;
                  client = new DaemonClient(`http://127.0.0.1:${port}`, tokenPath);
                  result = await client.post("/promote", promotionBody);
                }
                totalPromoted += result.promoted;
              } catch (error) {
                promotionFailures++;
                const message = error instanceof Error ? error.message : "request failed";
                compactState.phaseErrors.push({ phase: "Promote", target: promoteCwd, message });
                console.error(`  promotion failed for ${promoteCwd}: ${message}`);
              }
            }
            compactState.currentProject = undefined;
          }
          if (!noPromote) compactState.phases[1]!.status = "done";
          totalFailures = failures + promotionFailures;
        } finally {
          compactRenderer.stop();
        }
        if (isTTY) compactRenderer.printSummary();
        if (totalPromoted > 0) {
          console.log(`  → ${totalPromoted} insight${totalPromoted !== 1 ? "s" : ""} promoted`);
        }
        process.exitCode = compactFailureExitCode(totalFailures);
        return;
      }
      // Piped stdin — hook dispatch (PreCompact hook invocation)
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      let requestPolicy: LlmInvocationRequestPolicy | undefined;
      if (hasCompactRequestPolicyOverride(opts)) {
        const { loadStoredLlmRequestPolicyConfig } = await import("../src/config-projection.js");
        requestPolicy = resolveCompactRequestPolicyOverride(
          loadStoredLlmRequestPolicyConfig(defaultConfigPath()),
          opts,
        );
      }
      const input = withHookOverrides(await readStdin(), opts.client, reasoningEffort, requestPolicy, fastMode);
      const r = await dispatchHook("compact", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── restore (hook) ────────────────────────────────────────────────────────
  program
    .command("restore")
    .description("Dispatch the restore hook")
    .helpOption(false)
    .addOption(new Option("--client <client>", "Hook client identity (internal)").hideHelp())
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("restore"); exit(0);
      }
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = withHookClient(await readStdin(), opts.client);
      const r = await dispatchHook("restore", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── session-end (hook) ────────────────────────────────────────────────────
  program
    .command("session-end")
    .description("Dispatch the session-end hook")
    .helpOption(false)
    .addOption(new Option("--client <client>", "Hook client identity (internal)").hideHelp())
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("session-end"); exit(0);
      }
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = withHookClient(await readStdin(), opts.client);
      const r = await dispatchHook("session-end", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── user-prompt (hook) ────────────────────────────────────────────────────
  program
    .command("user-prompt")
    .description("Dispatch the user-prompt hook")
    .helpOption(false)
    .addOption(new Option("--client <client>", "Hook client identity (internal)").hideHelp())
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("user-prompt"); exit(0);
      }
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = withHookClient(await readStdin(), opts.client);
      const r = await dispatchHook("user-prompt", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── post-tool (hook) ──────────────────────────────────────────────────────
  program
    .command("post-tool")
    .description("Dispatch the post-tool hook (PostToolUse event)")
    .helpOption(false)
    .addOption(new Option("--client <client>", "Hook client identity (internal)").hideHelp())
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("post-tool"); exit(0);
      }
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = withHookClient(await readStdin(), opts.client);
      const r = await dispatchHook("post-tool", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── session-snapshot (hook) ─────────────────────────────────────────────
  program
    .command("session-snapshot")
    .description("Rolling ingest snapshot (called by Stop hook)")
    .helpOption(false)
    .addOption(new Option("--client <client>", "Hook client identity (internal)").hideHelp())
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("session-snapshot"); exit(0);
      }
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = withHookClient(await readStdin(), opts.client);
      const r = await dispatchHook("session-snapshot", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── mcp ───────────────────────────────────────────────────────────────────
  program
    .command("mcp")
    .description("Start the lcm MCP server")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("mcp"); exit(0);
      }
      const { startMcpServer } = await import("../src/mcp/server.js");
      await startMcpServer();
    });

  // ─── install ───────────────────────────────────────────────────────────────
  program
    .command("install")
    .description("Set up lcm: register hooks, configure daemon, connect MCP")
    .option("--dry-run", "Preview all changes without writing anything")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("install"); exit(0);
      }
      const dryRun: boolean = opts.dryRun ?? false;
      const { install } = await import("../installer/install.js");
      if (dryRun) {
        const { DryRunServiceDeps } = await import("../installer/dry-run-deps.js");
        console.log("\n  lcm install --dry-run\n");
        await install(new DryRunServiceDeps());
        console.log("\n  No changes written.");
      } else {
        await install();
      }
    });

  // ─── uninstall ─────────────────────────────────────────────────────────────
  program
    .command("uninstall")
    .description("Remove lcm hooks and MCP registration")
    .option("--dry-run", "Preview removals without writing anything")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("uninstall"); exit(0);
      }
      const dryRun: boolean = opts.dryRun ?? false;
      const { uninstall } = await import("../installer/uninstall.js");
      if (dryRun) {
        const { DryRunServiceDeps } = await import("../installer/dry-run-deps.js");
        console.log("\n  lcm uninstall --dry-run\n");
        await uninstall(new DryRunServiceDeps());
        console.log("\n  No changes written.");
      } else {
        await uninstall();
      }
    });

  // ─── status ────────────────────────────────────────────────────────────────
  program
    .command("status")
    .description("Show daemon status and project memory statistics")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("status"); exit(0);
      }
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const config = loadDaemonConfig(defaultConfigPath());
      const jsonFlag: boolean = opts.json ?? false;
      const client = await createDaemonClientOrExit({ preflightStorage: false });

      let daemonStatus = "down";
      let statusData: any = null;

      try {
        const health = await client.health();
        if (health) {
          daemonStatus = "up";
          if (health.status === "unavailable") {
            statusData = {
              daemon: {
                status: "up",
                version: health.version,
                uptime: health.uptime,
                port: config.daemon.port,
                storageBackend: health.storageBackend,
                storageStatus: "unavailable",
              },
            };
          }
        }

        // Also fetch /status endpoint if daemon is up
        if (daemonStatus === "up" && !statusData) {
          statusData = await client.post("/status", { cwd: process.cwd() });
        }
      } catch {}

      if (jsonFlag) {
        const result = {
          daemon: daemonStatus === "up" ? statusData?.daemon : { status: "down" },
          project: statusData?.project,
        };
        stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        const provider = config.llm?.provider ?? "unknown";
        const providerDisplay = provider === "auto"
          ? "auto (Claude->claude-process, Codex->codex-process)"
          : provider;

        if (statusData) {
          console.log(`Daemon: ${daemonStatus}`);
          console.log(`  Version: ${statusData.daemon.version}`);
          console.log(`  Uptime: ${statusData.daemon.uptime}s`);
          console.log(`  Port: ${statusData.daemon.port}`);
          console.log(`  Provider: ${providerDisplay}`);
          if (statusData.daemon.storageBackend) {
            console.log(
              `  Storage: ${statusData.daemon.storageBackend} (${statusData.daemon.storageStatus})`,
            );
          }
          if (statusData.project) {
            console.log();
            console.log("Project:");
            console.log(`  Messages: ${statusData.project.messageCount}`);
            console.log(`  Summaries: ${statusData.project.summaryCount}`);
            console.log(`  Promoted: ${statusData.project.promotedCount}`);
            if (statusData.project.lastIngest) console.log(`  Last Ingest: ${statusData.project.lastIngest}`);
            if (statusData.project.lastCompact) console.log(`  Last Compact: ${statusData.project.lastCompact}`);
            if (statusData.project.lastPromote) console.log(`  Last Promote: ${statusData.project.lastPromote}`);
          }
        } else {
          console.log(`daemon: ${daemonStatus} · provider: ${providerDisplay}`);
        }
      }
    });

  // ─── stats ─────────────────────────────────────────────────────────────────
  program
    .command("stats")
    .description("Show memory inventory and compression ratios")
    .option("-v, --verbose", "Show per-conversation breakdown")
    .option("--pool", "Show connection pool statistics from the daemon")
    .option("--json", "Output structured JSON (use with --pool)")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("stats"); exit(0);
      }

      if (opts.pool) {
        const jsonFlag: boolean = opts.json ?? false;
        const client = await createDaemonClientOrExit();

        let poolData: any = null;
        try {
          poolData = await client.get("/stats/pool");
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : "could not load pool stats"}`);
          exit(1);
        }

        if (jsonFlag) {
          stdout.write(JSON.stringify(poolData, null, 2) + "\n");
        } else {
          const dim = "\x1b[2m";
          const cyan = "\x1b[36m";
          const bold = "\x1b[1m";
          const reset = "\x1b[0m";
          console.log();
          console.log(`    ${bold}${cyan}🔌 Connection Pool${reset}`);
          console.log();
          const rows: [string, string][] = [
            ["Total", String(poolData.totalConnections)],
            ["Active", String(poolData.activeConnections)],
            ["Idle", String(poolData.idleConnections)],
          ];
          const labelWidth = Math.max(...rows.map(([l]) => l.length));
          for (const [label, value] of rows) {
            console.log(`    ${dim}${label.padEnd(labelWidth)}${reset}  ${value}`);
          }
          if (poolData.connections && poolData.connections.length > 0) {
            console.log();
            console.log(`    ${dim}Connections:${reset}`);
            for (const conn of poolData.connections) {
              const status = conn.status === "active" ? `${cyan}active${reset}` : `${dim}idle${reset}`;
              console.log(`    ${dim}refs=${conn.refs}${reset}  ${status}  ${conn.path}`);
            }
          }
          console.log();
        }
        return;
      }

      const verbose: boolean = opts.verbose ?? false;
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { selectStorageBackend } = await import("../src/storage/backend.js");
      selectStorageBackend(loadDaemonConfig(defaultConfigPath()).storage);
      const { collectStats, printStats } = await import("../src/stats.js");
      printStats(await collectStats(), verbose);
    });

  // ─── doctor ────────────────────────────────────────────────────────────────
  program
    .command("doctor")
    .description("Run diagnostics: daemon, hooks, MCP, summarizer")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .option("--verbose", "Show detailed diagnostic output")
    .option("--events-max-dbs <n|all|unlimited>", "Maximum passive-learning sidecar DBs to scan", "50")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("doctor"); exit(0);
      }
      const verbose: boolean = opts.verbose ?? false;
      const eventsMaxDbs = parsePositiveIntegerOrAll(String(opts.eventsMaxDbs ?? "50"), "--events-max-dbs");
      const { runDoctor, printResults } = await import("../src/doctor/doctor.js");
      const results = await runDoctor(undefined, { verbose, eventsMaxDbs });
      printResults(results);
      const failures = results.filter((r: { status: string }) => r.status === "fail");
      exit(failures.length > 0 ? 1 : 0);
    });

  // ─── events ────────────────────────────────────────────────────────────────
  const eventsCmd = new Command("events").description("Manage passive-learning sidecar events");
  eventsCmd.helpOption(false).option("-h, --help", "Show help");
  eventsCmd.action(async (opts) => {
    if (opts.help || cliArgv.includes("-h") || cliArgv.includes("--help")) {
      const { printHelp } = await import("../src/cli-help.js");
      printHelp("events"); exit(0);
    }
    console.error("Usage: lcm events promote [--all] [--json]");
    exit(1);
  });

  eventsCmd
    .command("promote")
    .description("Promote queued passive-learning events")
    .option("--all", "Promote events from all metadata-backed sidecars")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help || cliArgv.includes("-h") || cliArgv.includes("--help")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("events"); exit(0);
      }

      const all: boolean = opts.all ?? false;
      const jsonFlag: boolean = opts.json ?? false;
      const client = await createDaemonClientOrExit();
      const result = all
        ? await client.post<any>("/promote-events/all", {})
        : await client.post<any>("/promote-events", { cwd: process.cwd(), drain: true });
      const failed = all
        ? ((result.errors ?? 0) > 0 || (result.failedProjects ?? 0) > 0)
        : ((result.errors ?? 0) > 0 || result.incomplete === true);

      if (jsonFlag) {
        stdout.write(JSON.stringify(result, null, 2) + "\n");
        if (failed) process.exitCode = 1;
        return;
      }

      if (all) {
        console.log(`Promoted ${result.promoted} passive event${result.promoted === 1 ? "" : "s"} from ${result.processedProjects} project${result.processedProjects === 1 ? "" : "s"} (${result.skipped} skipped, ${result.errors} errors).`);
        if (result.orphanedProjects > 0) {
          console.log(`${result.orphanedProjects} sidecar${result.orphanedProjects === 1 ? "" : "s"} could not be promoted because project metadata is missing.`);
        }
      } else {
        console.log(`Promoted ${result.promoted} passive event${result.promoted === 1 ? "" : "s"} (${result.skipped} skipped, ${result.errors} errors).`);
        if (typeof result.batches === "number" && result.batches > 1) {
          console.log(`Drained ${result.batches} batches.`);
        }
        if (result.message) console.log(result.message);
      }
      if (failed) exit(1);
    });

  program.addCommand(eventsCmd);

  registerMachineCommand(program);
  registerProjectCommand(program);
  registerPostgreSqlCommand(program);
  registerMemoryCommands(program);

  // ─── diagnose ──────────────────────────────────────────────────────────────
  program
    .command("diagnose")
    .description("Scan recent sessions for hook failures and issues")
    .option("--all", "Scan all tracked projects")
    .option("--days <n>", "Scan the last N days (default: 7)", "7")
    .option("--verbose", "Include full event details")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("diagnose"); exit(0);
      }
      const all: boolean = opts.all ?? false;
      const verbose: boolean = opts.verbose ?? false;
      const json: boolean = opts.json ?? false;
      const days = Number(opts.days);

      if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(days)) {
        console.error("Usage: lcm diagnose [--all] [--days N] [--verbose] [--json]");
        exit(1);
      }

      const { diagnose, formatDiagnoseResult } = await import("../src/diagnose.js");
      const result = await diagnose({ all, days, verbose });

      if (json) {
        stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        stdout.write(formatDiagnoseResult(result, { days, verbose }));
      }
    });

  // ─── connectors ────────────────────────────────────────────────────────────
  const connectorsCmd = new Command("connectors").description("Manage connectors for coding agents");
  connectorsCmd.helpOption(false).option("-h, --help", "Show help");
  connectorsCmd.action(async (opts) => {
    if (opts.help) {
      const { printHelp } = await import("../src/cli-help.js");
      printHelp("connectors"); exit(0);
    }
    console.error("Usage: lcm connectors <list|install|remove|doctor> [options]");
    exit(1);
  });

  connectorsCmd
    .command("list")
    .description("List available agents and installed connectors")
    .option("--format <format>", "Output format: text or json", "text")
    .option("--global", "Inspect the global agent config in your home directory")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("connectors"); exit(0);
      }
      const format: string = opts.format ?? "text";
      const { listConnectors } = await import("../src/connectors/installer.js");
      const { AGENTS } = await import("../src/connectors/registry.js");
      const installed = listConnectors(opts.global ? homedir() : process.cwd());

      if (format === "json") {
        const result = AGENTS.map((a: any) => ({
          id: a.id,
          name: a.name,
          category: a.category,
          defaultType: a.defaultTypes ?? a.defaultType,
          supportedTypes: a.supportedTypes,
          installed: installed.filter((c: any) => c.agentId === a.id).map((c: any) => c.type),
        }));
        stdout.write(JSON.stringify({ agents: result }, null, 2) + "\n");
      } else {
        const rows = AGENTS.map((agent: any) => {
          const agentInstalled = installed.filter((c: any) => c.agentId === agent.id);
          return {
            agent: agent.name,
            installed: agentInstalled.length > 0 ? agentInstalled.map((c: any) => c.type).join(", ") : "-",
            defaults: (agent.defaultTypes ?? [agent.defaultType]).join(", "),
            supported: agent.supportedTypes.join(", "),
          };
        });
        const agentWidth = Math.max("Agent".length, ...rows.map((row) => row.agent.length));
        const installedWidth = Math.max("Installed".length, ...rows.map((row) => row.installed.length));
        const defaultWidth = Math.max("Default".length, ...rows.map((row) => row.defaults.length));

        console.log("\n  Available agents:\n");
        console.log(`  ${"Agent".padEnd(agentWidth)}  ${"Installed".padEnd(installedWidth)}  ${"Default".padEnd(defaultWidth)}  Supported`);
        console.log("  " + "─".repeat(70));
        for (const row of rows) {
          console.log(`  ${row.agent.padEnd(agentWidth)}  ${row.installed.padEnd(installedWidth)}  ${row.defaults.padEnd(defaultWidth)}  ${row.supported}`);
        }
        console.log();
      }
    });

  connectorsCmd
    .command("install <agent>")
    .description("Install a connector for an agent")
    .option("--type <type>", "Connector type: rules, hook, mcp, or skill")
    .option("--global", "Install into the global agent config in your home directory")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (agentName: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("connectors"); exit(0);
      }
      if (!agentName) { console.error("Usage: lcm connectors install <agent> [--type rules|hook|mcp|skill] [--global]"); exit(1); }
      const type: any = opts.type;
      const { installConnector } = await import("../src/connectors/installer.js");
      try {
        const result = installConnector(agentName, type, opts.global ? homedir() : process.cwd());
        if ((result as any).manual) {
          console.log(`\n  ${(result as any).manual}\n`);
        } else {
          console.log(`\n  ✓ Installed ${type ?? "default"} connector for ${agentName}`);
          const paths = Array.isArray((result as any).paths) ? (result as any).paths : [(result as any).path];
          for (const path of paths.filter((path: string) => path.length > 0)) {
            console.log(`    Path: ${path}`);
          }
          if ((result as any).requiresRestart) console.log("    Restart the agent to activate.");
          console.log();
        }
      } catch (err: any) {
        console.error(`  Error: ${err.message}`);
        exit(1);
      }
    });

  connectorsCmd
    .command("remove <agent>")
    .description("Remove a connector for an agent")
    .option("--type <type>", "Connector type: rules, hook, mcp, or skill")
    .option("--global", "Remove from the global agent config in your home directory")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (agentName: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("connectors"); exit(0);
      }
      if (!agentName) { console.error("Usage: lcm connectors remove <agent> [--type rules|hook|mcp|skill] [--global]"); exit(1); }
      const type: any = opts.type;
      const { removeConnector } = await import("../src/connectors/installer.js");
      try {
        const removed = removeConnector(agentName, type, opts.global ? homedir() : process.cwd());
        if (removed) {
          console.log(`\n  ✓ Removed connector for ${agentName}\n`);
        } else {
          console.log(`\n  No connector found for ${agentName}\n`);
        }
      } catch (err: any) {
        console.error(`  Error: ${err.message}`);
        exit(1);
      }
    });

  connectorsCmd
    .command("doctor [agent]")
    .description("Check connector health")
    .option("--global", "Inspect the global agent config in your home directory")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (agentName: string | undefined, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("connectors"); exit(0);
      }
      const { AGENTS } = await import("../src/connectors/registry.js");
      const { listConnectors } = await import("../src/connectors/installer.js");
      const { findAgent } = await import("../src/connectors/registry.js");
      const found = agentName ? findAgent(agentName) : undefined;
      const agents = found ? [found] : agentName ? [] : AGENTS;

      if (agents.length === 0) { console.error(`  Unknown agent: ${agentName}`); exit(1); }

      const installed = listConnectors(opts.global ? homedir() : process.cwd());
      console.log("\n  Connector health:\n");
      for (const agent of agents) {
        const agentConnectors = installed.filter((c: any) => c.agentId === (agent as any).id);
        if ((agentConnectors as any[]).length === 0) {
          console.log(`  ⚠ ${(agent as any).name}: no connectors installed`);
        } else {
          for (const c of agentConnectors as any[]) {
            console.log(`  ✓ ${(agent as any).name}: ${c.type} at ${c.path}`);
          }
        }
      }
      console.log();
    });

  program.addCommand(connectorsCmd);

  // ─── sensitive ─────────────────────────────────────────────────────────────
  program
    .command("sensitive [args...]")
    .description("Manage sensitive patterns for automatic redaction")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .allowUnknownOption(true)
    .action(async (args: string[], opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("sensitive"); exit(0);
      }
      const { handleSensitive } = await import("../src/sensitive.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const configPath = defaultConfigPath();
      const r = await handleSensitive(args, process.cwd(), configPath);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── import ────────────────────────────────────────────────────────────────
  program
    .command("import")
    .description("Import Claude Code and Codex session transcripts into lossless memory")
    .option("--all", "Import all projects")
    .option("--provider <provider>", "Transcript provider: claude, codex, or all", "claude")
    .option("--codex", "Shorthand for --provider codex")
    .option("--verbose", "Show per-session import detail")
    .option("--dry-run", "Preview without importing")
    .option("--replay", "Replay compaction for each imported session")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("import"); exit(0);
      }
      const all: boolean = opts.all ?? false;
      const verbose: boolean = opts.verbose ?? false;
      const dryRun: boolean = opts.dryRun ?? false;
      const replay: boolean = opts.replay ?? false;

      const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
      const { DaemonClient } = await import("../src/daemon/client.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { selectStorageBackend } = await import("../src/storage/backend.js");
      const { NinjaRenderer } = await import("../src/cli/pipeline-runner.js");
      const { makeProgressState } = await import("../src/cli/progress-state.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const { existsSync, readdirSync } = await import("node:fs");
      const { importSessions, cwdToProjectHash, findSessionFiles } = await import("../src/import.js");
      const { findAllCodexTranscripts } = await import("../src/codex-transcript.js");
      type ImportProvider = import("../src/import.js").ImportProvider;

      // --codex is a shorthand for --provider codex
      let provider: ImportProvider = "claude";
      if (opts.codex) {
        provider = "codex";
      } else if (opts.provider) {
        const provVal = opts.provider as string;
        if (provVal === "claude" || provVal === "codex" || provVal === "all") {
          provider = provVal as ImportProvider;
        } else {
          console.error(`  Unknown provider "${provVal}". Use: claude, codex, all`);
          exit(1);
        }
      }

      const config = loadDaemonConfig(defaultConfigPath());
      selectStorageBackend(config.storage);
      const port = config.daemon?.port ?? 3737;
      const pidFilePath = daemonPidPath();
      const { connected } = await ensureDaemon({
        port,
        pidFilePath,
        spawnTimeoutMs: 5000,
        expectedStorageBackend: config.storage.backend,
        enforceUserManagerParent: true,
      });
      if (!connected) { console.error("  Daemon not available"); exit(1); }

      // Pre-scan for session count (enables accurate live progress bar)
      const claudeProjectsDir = join(homedir(), ".claude", "projects");
      let sessionCount = 0;
      if (provider === "claude" || provider === "all") {
        if (all) {
          if (existsSync(claudeProjectsDir)) {
            for (const entry of readdirSync(claudeProjectsDir, { withFileTypes: true })) {
              if (!entry.isDirectory()) continue;
              sessionCount += findSessionFiles(join(claudeProjectsDir, entry.name)).length;
            }
          }
        } else {
          const cwd = process.cwd();
          const hash = cwdToProjectHash(cwd);
          const dir = join(claudeProjectsDir, hash);
          if (existsSync(dir)) sessionCount = findSessionFiles(dir).length;
        }
      }
      if (provider === "codex" || provider === "all") {
        sessionCount += findAllCodexTranscripts().length;
      }

      const isTTY = process.stdout.isTTY ?? false;
      const renderOpts = { isTTY, width: process.stdout.columns ?? 80, color: isTTY, verbose };
      const state = makeProgressState({
        phases: [{ name: "Import", status: "active" }],
        total: sessionCount,
        dryRun,
      });
      const renderer = new NinjaRenderer({ state, renderOpts });

      const providerLabel =
        provider === "codex" ? "Codex CLI" :
        provider === "all"   ? "Claude Code + Codex CLI" :
                               "Claude Code";
      console.log(`\n  Importing ${providerLabel} sessions${all ? " (all projects)" : ""}...\n`);
      renderer.start();

      const client = new DaemonClient(`http://127.0.0.1:${port}`);
      const result = await importSessions(client, {
        all, verbose, dryRun, replay, provider,
        onProgress: (patch) => {
          Object.assign(state, patch);
          if (patch.lastResult) renderer.sessionDone();
        },
      });

      renderer.stop();

      if (isTTY && !verbose) {
        state.phases[0].status = "done";
        renderer.printSummary();
        const { printCodexResolutionSummary } = await import("../src/import-summary.js");
        printCodexResolutionSummary(result);
      } else {
        const { printImportSummary } = await import("../src/import-summary.js");
        if (dryRun) console.log("  [dry-run] No changes written.\n");
        printImportSummary(result, { replay });
        console.log();
      }
    });

  // ─── promote ───────────────────────────────────────────────────────────────
  program
    .command("promote")
    .description("Scan summaries and promote durable insights to long-term memory")
    .option("--all", "Promote across all tracked projects")
    .option("--verbose", "Show per-project counts")
    .option("--dry-run", "Preview promotions without writing")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("promote"); exit(0);
      }
      const all: boolean = opts.all ?? false;
      const verbose: boolean = opts.verbose ?? false;
      const dryRun: boolean = opts.dryRun ?? false;

      const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { selectStorageBackend } = await import("../src/storage/backend.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const config = loadDaemonConfig(defaultConfigPath());
      selectStorageBackend(config.storage);
      const port = config.daemon?.port ?? 3737;
      const pidFilePath = daemonPidPath();
      const { connected } = await ensureDaemon({
        port,
        pidFilePath,
        spawnTimeoutMs: 5000,
        expectedStorageBackend: config.storage.backend,
        enforceUserManagerParent: true,
      });
      if (!connected) {
        console.error("  Daemon not available. Start it with: lcm daemon start --detach");
        exit(1);
      }

      const client = new DaemonClient(`http://127.0.0.1:${port}`);
      const { readdirSync, existsSync, readFileSync } = await import("node:fs");

      if (dryRun) console.log("  [dry-run] No changes will be written.\n");

      // Collect project cwds to promote
      const cwds: string[] = [];
      if (all) {
        const projectsDir = lcmProjectsDir();
        if (existsSync(projectsDir)) {
          for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const metaPath = join(projectsDir, entry.name, "meta.json");
            if (!existsSync(metaPath)) continue;
            try {
              const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
              if (meta.cwd) cwds.push(meta.cwd);
            } catch { /* skip unreadable */ }
          }
        }
      } else {
        cwds.push(process.cwd());
      }

      let totalProcessed = 0;
      let totalPromoted = 0;
      const total = cwds.length;

      for (let i = 0; i < cwds.length; i++) {
        const cwd = cwds[i];
        if (total > 1) {
          process.stdout.write(`\r  scanning project ${i + 1}/${total}...`);
        } else {
          process.stdout.write(`\r  scanning...`);
        }

        try {
          const result = await client.post<{ processed: number; promoted: number; conversations?: number }>("/promote", {
            cwd,
            dry_run: dryRun,
          });

          totalProcessed += result.processed;
          totalPromoted += result.promoted;

          if (verbose) {
            process.stdout.write("\r");
            const convLabel = result.conversations !== undefined ? `, ${result.conversations} conversation${result.conversations !== 1 ? "s" : ""}` : "";
            console.log(`  ${cwd}: ${result.processed} scanned${convLabel}, ${result.promoted} promoted`);
          }
        } catch (err) {
          if (verbose) console.error(`  promote failed for ${cwd}: ${err instanceof Error ? err.message : "request failed"}`);
          continue;
        }
      }
      // Clear the progress line
      process.stdout.write("\r  \r");

      if (totalPromoted === 0) {
        console.log("  Nothing to promote — no new insights found.");
      } else {
        console.log(`  ${totalPromoted} insight${totalPromoted !== 1 ? "s" : ""} promoted to long-term memory`);
      }
      if (verbose) console.log(`  (${totalProcessed} summaries scanned across ${cwds.length} project${cwds.length !== 1 ? "s" : ""})`);
      if (dryRun) console.log("  [dry-run] No changes written.");
      console.log();
    });

  // ─── export ────────────────────────────────────────────────────────────────
  program
    .command("export")
    .description("Export promoted knowledge to a portable JSON file")
    .option("--all", "Export all projects (one JSON per project, written to files)")
    .option("--tags <tags>", "Only export entries matching these comma-separated tags")
    .option("--since <date>", "Only export entries created on or after this ISO date (e.g. 2026-01-01)")
    .option("--output <file>", "Write output to file instead of stdout")
    .option("--format <format>", "Output format: json (default)", "json")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("export"); exit(0);
      }

      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { selectStorageBackend } = await import("../src/storage/backend.js");
      selectStorageBackend(loadDaemonConfig(defaultConfigPath()).storage);
      const { exportKnowledge } = await import("../src/portable-knowledge.js");
      const { homedir } = await import("node:os");
      const { join } = await import("node:path");
      const { existsSync, readdirSync, readFileSync } = await import("node:fs");

      const tags: string[] | undefined = opts.tags
        ? (opts.tags as string).split(",").map((t: string) => t.trim()).filter(Boolean)
        : undefined;
      const since: string | undefined = opts.since;
      const output: string | undefined = opts.output;
      const all: boolean = opts.all ?? false;

      let cwds: string[] = [];
      if (all) {
        const { reconcileWorktrees } = await import("../src/worktree-reconciliation.js");
        const projectsDir = lcmProjectsDir();
        const candidates: string[] = [];
        if (existsSync(projectsDir)) {
          for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const metaPath = join(projectsDir, entry.name, "meta.json");
            if (!existsSync(metaPath)) continue;
            try {
              const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
              if (typeof meta.cwd === "string" && meta.cwd) candidates.push(meta.cwd);
            } catch { /* skip */ }
          }
        }
        const reconciled = new Map<string, string>();
        for (const candidate of candidates) {
          try {
            const result = reconcileWorktrees(candidate);
            reconciled.set(result.targetHash, result.canonical);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`  Warning: could not reconcile ${candidate}: ${message}\n`);
          }
        }
        cwds = [...reconciled.values()];
      } else {
        cwds.push(process.cwd());
      }

      let total = 0;
      for (const cwd of cwds) {
        let outFile: string | undefined = output;
        if (all && output === undefined) {
          // When --all and no --output, generate filenames automatically
          const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").slice(-40);
          outFile = join(process.cwd(), `lcm-export-${slug}.json`);
        }
        try {
          const result = await exportKnowledge(cwd, { tags, since, output: outFile });
          total += result.exported;
          if (all) {
            console.log(`  ${cwd}: ${result.exported} entries → ${outFile}`);
          } else if (outFile) {
            console.log(`  Exported ${result.exported} entries to ${outFile}`);
          }
        } catch (err: any) {
          process.stderr.write(`  Warning: ${err.message}\n`);
        }
      }

      if (all) console.log(`\n  Total: ${total} entries exported`);
    });

  // ─── import-knowledge ──────────────────────────────────────────────────────
  program
    .command("import-knowledge <file>")
    .description("Import exported knowledge JSON into lossless memory")
    .option("--merge", "Merge with existing entries, deduplicating (default)")
    .option("--dry-run", "Preview import without writing anything")
    .option("--confidence <n>", "Override confidence for all imported entries (0.0–1.0)")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (file: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("import-knowledge"); exit(0);
      }

      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { selectStorageBackend } = await import("../src/storage/backend.js");
      selectStorageBackend(loadDaemonConfig(defaultConfigPath()).storage);
      const { importKnowledge } = await import("../src/portable-knowledge.js");
      const { readFileSync } = await import("node:fs");

      const dryRun: boolean = opts.dryRun ?? false;
      const confidence: number | undefined = opts.confidence !== undefined
        ? parseFloat(opts.confidence as string)
        : undefined;

      if (confidence !== undefined && (isNaN(confidence) || confidence < 0 || confidence > 1)) {
        console.error("  --confidence must be a number between 0.0 and 1.0");
        exit(1);
      }

      let raw: string;
      try {
        raw = readFileSync(file, "utf-8");
      } catch (err: any) {
        console.error(`  Cannot read file: ${err.message}`);
        exit(1);
      }

      let doc: any;
      try {
        doc = JSON.parse(raw);
      } catch {
        console.error("  Invalid JSON in export file");
        exit(1);
      }

      if (!doc || typeof doc.version !== "number" || !Array.isArray(doc.entries)) {
        console.error("  File does not look like an lcm export (missing version or entries)");
        exit(1);
      }

      const cwd = process.cwd();

      if (dryRun) {
        console.log(`\n  [dry-run] Would import ${doc.entries.length} entries into ${cwd}`);
        console.log("  No changes written.\n");
        exit(0);
      }

      try {
        const result = await importKnowledge(cwd, doc, { merge: true, dryRun, confidence });
        if (result.dryRun) {
          console.log(`\n  [dry-run] Would import ${result.total} entries. No changes written.\n`);
        } else {
          console.log(`\n  Imported ${result.imported} entries (${result.skipped} skipped) into ${cwd}\n`);
        }
      } catch (err: any) {
        console.error(`  Import failed: ${err.message}`);
        exit(1);
      }
    });

  // ─── Unknown command fallback ──────────────────────────────────────────────
  let unknownCommandCompletion: Promise<void> | undefined;
  program.on("command:*", (operands: string[]) => {
    unknownCommandCompletion = (async () => {
      process.stderr.write(`lcm: unknown command '${operands[0]}'\n\n`);
      const { printHelp } = await import("../src/cli-help.js");
      printHelp();
      exit(1);
    })();
  });

  // Resolve unsafe nested help from argv before parsing. Commander does not
  // reliably expose a child help option to these nested actions, and those
  // actions may read or mutate state before help can be rendered.
  const customHelp = resolveCustomHelpRequest(cliArgv);
  if (customHelp) {
    const { printHelp } = await import("../src/cli-help.js");
    printHelp(customHelp.command);
    exit(0);
  }

  await program.parseAsync(cliArgv);
  await unknownCommandCompletion;
}

/** @internal Top-level rejection handler kept separate for deterministic tests. */
export function handleCliError(err: unknown): never {
  console.error(err instanceof ConfigValidationError || err instanceof StorageBackendUnavailableError ? err.message : err);
  return exit(1);
}

/** @internal Execute only when this module is the resolved process entrypoint. */
export function runMainIfInvoked(
  invokedPath: string | undefined,
  currentFilePath: string,
  runner: () => Promise<void> = runCli,
  onError: (error: unknown) => unknown = handleCliError,
): void {
  if (shouldRunMain(invokedPath, currentFilePath)) {
    void runner().catch(onError);
  }
}

runMainIfInvoked(argv[1], fileURLToPath(import.meta.url));
