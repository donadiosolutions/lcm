import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, chmodSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { ensureCore } from "../src/bootstrap.js";
import { lcmHomeDir } from "../src/runtime-paths.js";
import { atomicWritePrivateFile } from "../src/security-files.js";
import { packageExecutable, packageRootFor } from "../src/runtime-root.js";
import { mergeClaudeSettings } from "../src/installer/settings.js";
export { REQUIRED_HOOKS, canonicalHookCommand, hasManagedClaudeSettings, mergeClaudeSettings } from "../src/installer/settings.js";

export interface ServiceDeps {
  spawnSync: (cmd: string, args: string[], opts?: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, data: string) => void;
  mkdirSync: (path: string, opts?: any) => void;
  existsSync: (path: string) => boolean;
  chmodSync?: (path: string, mode: number) => void;
  lstatSync?: typeof lstatSync;
  atomicWritePrivateFile?: typeof atomicWritePrivateFile;
  readdirSync?: typeof readdirSync;
  copyFileSync?: typeof copyFileSync;
  rmSync?: typeof rmSync;
  commandsSourceDir?: string;
  skillSourceDir?: string;
  cwd?: string;
  binaryPath?: string;
  dryRun?: boolean;
  promptUser: (question: string) => Promise<string>;
  ensureDaemon?: (opts: { port: number; pidFilePath: string; spawnTimeoutMs: number }) => Promise<{ connected: boolean }>;
  runDoctor?: () => Promise<Array<{ name: string; status: string; category?: string; message?: string }>>;
}

const CLAUDE_PLUGIN_REPOSITORIES = new Set([
  "donadiosolutions/lcm",
  "lossless-claude/lcm",
]);
const CLAUDE_PLUGIN_SCOPES = new Set(["user", "project", "local"]);

export interface InstalledClaudePlugin {
  identifier: string;
  repository: string;
  scope: "user" | "project" | "local";
  cwd?: string;
}

function normalizeRepository(value: string): string | undefined {
  const normalized = value.trim()
    .replace(/^github:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  return CLAUDE_PLUGIN_REPOSITORIES.has(normalized) ? normalized : undefined;
}

function parseJsonArray(stdout: string, description: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${description} returned malformed JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${description} returned an unsupported shape`);
  return parsed;
}

function lcmPluginIdentifier(candidate: unknown): string | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const id = (candidate as Record<string, unknown>).id;
  if (typeof id !== "string") return undefined;
  const separator = id.lastIndexOf("@");
  return (separator > 0 ? id.slice(0, separator) : id) === "lcm" ? id : undefined;
}

function marketplaceRepositories(stdout: string): Map<string, string> {
  const repositories = new Map<string, string>();
  for (const candidate of parseJsonArray(stdout, "Claude marketplace list")) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.repo !== "string") continue;
    const repository = normalizeRepository(record.repo);
    if (repository) repositories.set(record.name, repository);
  }
  return repositories;
}

function explicitRepository(record: Record<string, unknown>): string | undefined {
  if (typeof record.repository === "string") return normalizeRepository(record.repository);
  if (typeof record.repo === "string") return normalizeRepository(record.repo);
  if (typeof record.source === "string") return normalizeRepository(record.source);
  if (record.source && typeof record.source === "object" && !Array.isArray(record.source)) {
    const repo = (record.source as Record<string, unknown>).repo;
    if (typeof repo === "string") return normalizeRepository(repo);
  }
  return undefined;
}

export function parseInstalledClaudePlugins(
  stdout: string,
  marketplaceStdout: string = "[]",
): InstalledClaudePlugin[] {
  const candidates = parseJsonArray(stdout, "Claude plugin list");
  const marketplaces = marketplaceRepositories(marketplaceStdout);

  const recognized: InstalledClaudePlugin[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.id !== "string") continue;
    const separator = record.id.lastIndexOf("@");
    const pluginName = separator > 0 ? record.id.slice(0, separator) : record.id;
    const marketplaceName = separator > 0 ? record.id.slice(separator + 1) : undefined;
    if (pluginName !== "lcm") continue;
    const repository = explicitRepository(record)
      ?? (marketplaceName ? marketplaces.get(marketplaceName) : undefined);
    if (!repository) continue;
    const scopeValue = typeof record.scope === "string" ? record.scope : "user";
    if (!CLAUDE_PLUGIN_SCOPES.has(scopeValue)) {
      throw new Error(`Recognized LCM Claude plugin has unsupported scope: ${scopeValue}`);
    }
    recognized.push({
      identifier: record.id,
      repository,
      scope: scopeValue as InstalledClaudePlugin["scope"],
      cwd: typeof record.cwd === "string"
        ? record.cwd
        : typeof record.projectPath === "string" ? record.projectPath : undefined,
    });
  }
  return recognized;
}

export function migrateClaudeMarketplacePlugins(
  deps: Pick<ServiceDeps, "spawnSync" | "dryRun">,
  cwd: string,
): void {
  const list = deps.spawnSync("claude", ["plugin", "list", "--json"], { encoding: "utf-8", cwd });
  // Claude may be absent; npm-native installation still supports Codex-only use.
  if (list.status !== 0) {
    if ((list.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw new Error("Could not list installed Claude plugins");
  }
  const listedPlugins = parseJsonArray(list.stdout, "Claude plugin list");
  const hasPotentialLcmPlugin = listedPlugins.some((candidate) => lcmPluginIdentifier(candidate) !== undefined);
  if (!hasPotentialLcmPlugin) return;
  const marketplaces = deps.spawnSync("claude", ["plugin", "marketplace", "list", "--json"], { encoding: "utf-8", cwd });
  if (marketplaces.status !== 0) {
    throw new Error("Could not verify configured Claude plugin marketplaces");
  }
  const installed = parseInstalledClaudePlugins(list.stdout, marketplaces.stdout);
  for (const plugin of installed) {
    const pluginCwd = plugin.cwd ?? cwd;
    if (deps.dryRun) {
      console.log(
        `[dry-run] would uninstall Claude Marketplace plugin ${plugin.identifier} `
        + `(${plugin.scope}, ${plugin.repository}) in ${pluginCwd}`,
      );
      continue;
    }
    const removal = deps.spawnSync("claude", [
      "plugin", "uninstall", plugin.identifier,
      "--scope", plugin.scope,
      "--yes", "--keep-data",
    ], { encoding: "utf-8", cwd: pluginCwd });
    if (removal.status !== 0) {
      throw new Error(`Could not uninstall Claude Marketplace plugin ${plugin.identifier} (${plugin.scope})`);
    }
  }
  if (installed.length === 0) {
    throw new Error(
      "An LCM Claude plugin is installed, but its marketplace repository could not be verified; "
      + "remove it manually before running lcm install",
    );
  }
  if (deps.dryRun) return;
  const verify = deps.spawnSync("claude", ["plugin", "list", "--json"], { encoding: "utf-8", cwd });
  if (verify.status !== 0) throw new Error("Could not verify Claude Marketplace plugin removal");
  const remaining = parseJsonArray(verify.stdout, "Claude plugin list")
    .map(lcmPluginIdentifier)
    .find((identifier) => identifier !== undefined);
  if (remaining) {
    throw new Error(`Claude Marketplace plugin remains installed: ${remaining}`);
  }
}

function copyMarkdownFiles(
  deps: ServiceDeps,
  source: string,
  destination: string,
): void {
  if (!deps.existsSync(source)) return;
  deps.mkdirSync(destination, { recursive: true });
  for (const file of (deps.readdirSync ?? readdirSync)(source)) {
    if (typeof file === "string" && file.endsWith(".md")) {
      (deps.copyFileSync ?? copyFileSync)(join(source, file), join(destination, file));
    }
  }
}

async function readlinePrompt(question: string): Promise<string> {
  const rl = (await import("node:readline/promises")).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export { readlinePrompt as _readlinePromptForTesting };

const defaultDeps: ServiceDeps = {
  spawnSync: spawnSync as ServiceDeps["spawnSync"],
  readFileSync: readFileSync as ServiceDeps["readFileSync"],
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  lstatSync,
  rmSync,
  atomicWritePrivateFile,
  promptUser: readlinePrompt,
};

function safeConfigExists(deps: ServiceDeps, path: string): boolean {
  if (!deps.lstatSync) return deps.existsSync(path);
  try {
    const stat = deps.lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to use a symlink config path: ${path}`);
    }
    if (!stat.isFile()) throw new Error(`config path is not a regular file: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function readMergedClaudeSettings(
  deps: Pick<ServiceDeps, "existsSync" | "readFileSync">,
  settingsPath: string,
  lcmBin: string,
): Record<string, unknown> {
  if (!deps.existsSync(settingsPath)) return mergeClaudeSettings({}, lcmBin);
  let parsed: unknown;
  try {
    parsed = JSON.parse(deps.readFileSync(settingsPath, "utf-8"));
  } catch {
    throw new Error(`Refusing to modify malformed Claude settings: ${settingsPath}`);
  }
  return mergeClaudeSettings(parsed, lcmBin);
}

export interface ResolveBinaryDeps {
  spawnSync: (cmd: string, args: string[], opts?: SpawnSyncOptionsWithStringEncoding) => { status: number | null; stdout: string | Buffer };
  existsSync: (path: string) => boolean;
}

export function resolveBinaryPath(deps: ResolveBinaryDeps = defaultDeps): string {
  const result = deps.spawnSync("sh", ["-c", "command -v lcm"], { encoding: "utf-8" });
  if (result.status === 0 && typeof result.stdout === "string" && result.stdout.trim()) {
    return result.stdout.trim();
  }

  const fallbacks = [
    join(homedir(), ".npm-global", "bin", "lcm"),
    "/usr/local/bin/lcm",
    "/opt/homebrew/bin/lcm",
  ];
  for (const p of fallbacks) {
    if (deps.existsSync(p)) return p;
  }

  return "lcm";
}


type SummarizerConfig = {
  provider: "auto" | "anthropic" | "openai";
  model: string;
  apiKey: string;
  baseUrl: string;
};

const AUTO_SUMMARIZER_CONFIG: SummarizerConfig = {
  provider: "auto",
  model: "",
  apiKey: "",
  baseUrl: "",
};

async function promptRequiredValue(
  deps: Pick<ServiceDeps, "promptUser">,
  question: string,
): Promise<string | null> {
  const value = (await deps.promptUser(question)).trim();
  if (value) return value;

  console.log("  A value is required — please try once more.");
  const retry = (await deps.promptUser(question)).trim();
  if (retry) return retry;

  console.log("  Still empty — using the native CLI default instead.");
  return null;
}

async function pickSummarizer(deps: ServiceDeps): Promise<SummarizerConfig> {
  // Non-TTY (CI, piped stdin): skip interactive picker, default to auto.
  if (!process.stdin.isTTY) {
    return AUTO_SUMMARIZER_CONFIG;
  }

  console.log("\n  ─── Summarizer (for conversation compaction)\n");
  console.log("  1) Native CLI default (recommended — Claude uses claude-process, Codex uses codex-process)");
  console.log("  2) Anthropic API     (direct API access — requires API key)");
  console.log("  3) Custom server     (any OpenAI-compatible URL)");
  console.log("");

  let choice = (await deps.promptUser("  Pick [1]: ")).trim();
  if (!["1", "2", "3"].includes(choice)) {
    console.log("  Invalid choice — please enter 1, 2, or 3.");
    choice = (await deps.promptUser("  Pick [1]: ")).trim();
  }
  if (!["1", "2", "3"].includes(choice)) {
    choice = "1"; // default after two invalid attempts
  }

  if (choice === "1") {
    return AUTO_SUMMARIZER_CONFIG;
  }

  if (choice === "2") {
    const apiKey = process.env.ANTHROPIC_API_KEY ? "${ANTHROPIC_API_KEY}" : "";
    return { provider: "anthropic", model: "claude-haiku-4-5-20251001", apiKey, baseUrl: "" };
  }

  const baseUrl = await promptRequiredValue(deps, "  Server URL (e.g. http://192.168.1.x:8080/v1): ");
  if (baseUrl === null) return AUTO_SUMMARIZER_CONFIG;

  const model = await promptRequiredValue(deps, "  Model name: ");
  if (model === null) return AUTO_SUMMARIZER_CONFIG;

  return { provider: "openai", model, apiKey: "", baseUrl };
}

const LCM_BLOCK_START = "<!-- lcm:start -->";
const LCM_BLOCK_END = "<!-- lcm:end -->";

function findLcmMdBlock(content: string): { start: number; end: number } | undefined {
  const startMarker = /^\s*<!--\s*lcm:start\s*-->\s*$/;
  const endMarker = /^\s*<!--\s*lcm:end\s*-->\s*$/;
  let blockStart: number | undefined;
  let offset = 0;

  while (offset < content.length) {
    const newline = content.indexOf("\n", offset);
    const lineEnd = newline === -1 ? content.length : newline;
    const line = content.slice(offset, lineEnd).replace(/\r$/, "");
    if (blockStart === undefined) {
      if (startMarker.test(line)) blockStart = offset;
    } else if (endMarker.test(line)) {
      return { start: blockStart, end: newline === -1 ? content.length : newline + 1 };
    }
    if (newline === -1) break;
    offset = newline + 1;
  }
  return undefined;
}

export function ensureLcmMd(
  deps: Pick<ServiceDeps, "readFileSync" | "writeFileSync" | "existsSync" | "mkdirSync">,
  lcmMdContent: string,
  homeDirPath: string = homedir(),
): { lcmMdWritten: boolean; claudeMdPatched: boolean } {
  const claudeDir = join(homeDirPath, ".claude");
  deps.mkdirSync(claudeDir, { recursive: true });

  // Always overwrite lcm.md to keep content up-to-date with the installed version
  const lcmMdPath = join(claudeDir, "lcm.md");
  let lcmMdWritten = false;
  let existingLcmMd = "";
  if (deps.existsSync(lcmMdPath)) {
    try {
      existingLcmMd = deps.readFileSync(lcmMdPath, "utf-8");
    } catch {
      // treat unreadable as stale — overwrite
    }
  }
  if (existingLcmMd !== lcmMdContent) {
    deps.writeFileSync(lcmMdPath, lcmMdContent);
    lcmMdWritten = true;
  }

  // Ensure @lcm.md appears in CLAUDE.md inside a managed block
  const claudeMdPath = join(claudeDir, "CLAUDE.md");
  let claudeMdPatched = false;
  let existing = "";
  if (deps.existsSync(claudeMdPath)) {
    try { existing = deps.readFileSync(claudeMdPath, "utf-8"); } catch {}
  }

  const block = `${LCM_BLOCK_START}\n<!-- Claude Code include: @lcm.md -->\n${LCM_BLOCK_END}`;
  const blockRange = findLcmMdBlock(existing);

  if (blockRange) {
    // Block exists — replace it in case content changed
    const updated = existing.slice(0, blockRange.start) + block + "\n" + existing.slice(blockRange.end);
    if (updated !== existing) {
      deps.writeFileSync(claudeMdPath, updated);
      claudeMdPatched = true;
    }
  } else {
    // No block yet — append
    deps.writeFileSync(claudeMdPath, existing ? existing.trimEnd() + "\n" + block + "\n" : block + "\n");
    claudeMdPatched = true;
  }

  return { lcmMdWritten, claudeMdPatched };
}

export async function install(deps: ServiceDeps = defaultDeps): Promise<void> {
  const lcDir = lcmHomeDir();
  deps.mkdirSync(lcDir, { recursive: true, mode: 0o700 });
  deps.chmodSync?.(lcDir, 0o700);

  const configPath = join(lcDir, "config.json");
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const lcmBin = deps.binaryPath ?? packageExecutable(import.meta.url, 2);
  if (!isAbsolute(lcmBin)) {
    throw new Error("Could not resolve an absolute npm-installed lcm executable path");
  }

  // Validate settings before making any migration or installation changes.
  readMergedClaudeSettings(deps, settingsPath, lcmBin);

  // 1-3. Core setup (config + settings cleanup + daemon)
  // ensureCore handles: creating config.json, merging settings.json hooks, and starting daemon
  // For install, we inject summarizer config into the default config if creating fresh
  if (!safeConfigExists(deps, configPath)) {
    const summarizerConfig = await pickSummarizer(deps);
    const { daemonConfigForPersistence, loadDaemonConfig } = await import("../src/daemon/config.js");
    const defaults = loadDaemonConfig("/nonexistent");
    defaults.llm = { ...defaults.llm, ...summarizerConfig };
    deps.mkdirSync(dirname(configPath), { recursive: true });
    const serialized = JSON.stringify(daemonConfigForPersistence(defaults), null, 2);
    if (deps.atomicWritePrivateFile) deps.atomicWritePrivateFile(configPath, serialized);
    else deps.writeFileSync(configPath, serialized);
    try { deps.chmodSync?.(configPath, 0o600); } catch { /* best-effort */ }
    console.log(`Created ${configPath}`);
  }

  migrateClaudeMarketplacePlugins(deps, deps.cwd ?? process.cwd());

  // ensureCore will:
  // - Skip config creation (already exists or just created above)
  // - Merge settings.json hooks (remove duplicates, clean old commands)
  // - Start the daemon
  await ensureCore({
    configPath,
    settingsPath,
    existsSync: deps.existsSync,
    readFileSync: deps.readFileSync,
    writeFileSync: deps.writeFileSync,
    mkdirSync: deps.mkdirSync,
    binaryPath: lcmBin,
    ensureDaemon: deps.ensureDaemon ?? (async (opts) => {
      const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
      return ensureDaemon(opts);
    }),
  });

  // Register the npm-owned MCP server directly in Claude settings.
  const merged: any = readMergedClaudeSettings(deps, settingsPath, lcmBin);
  const mcpServers = merged.mcpServers;
  mcpServers["lcm"] = { command: process.execPath, args: [lcmBin, "mcp"] };
  (merged as any).mcpServers = mcpServers;

  deps.mkdirSync(dirname(settingsPath), { recursive: true });
  deps.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
  console.log(`Updated ${settingsPath}`);

  // 4. Install slash commands to ~/.claude/commands/
  const claudeTemplates = join(packageRootFor(import.meta.url, 2), "dist", "src", "connectors", "templates", "claude");
  const commandsSrc = deps.commandsSourceDir ?? join(claudeTemplates, "commands");
  const commandsDst = join(homedir(), ".claude", "commands");
  const retiredDogfoodCommand = join(commandsDst, "lcm-dogfood.md");
  (deps.rmSync ?? rmSync)(retiredDogfoodCommand, { force: true });
  copyMarkdownFiles(deps, commandsSrc, commandsDst);
  if (deps.existsSync(commandsSrc)) {
    console.log(`Installed slash commands to ${commandsDst}`);
  }
  const skillSrc = deps.skillSourceDir ?? join(claudeTemplates, "skills", "lcm-context");
  const skillDst = join(homedir(), ".claude", "skills", "lcm-context");
  copyMarkdownFiles(deps, skillSrc, skillDst);
  if (deps.existsSync(skillSrc)) console.log(`Installed lcm-context skill to ${skillDst}`);

  // 5. Install lcm.md and @lcm.md reference in CLAUDE.md
  const { LCM_MD_CONTENT } = await import("../src/daemon/orientation.js");
  const { lcmMdWritten, claudeMdPatched } = ensureLcmMd(deps, LCM_MD_CONTENT);
  if (lcmMdWritten) console.log(`Installed ~/.claude/lcm.md`);
  if (claudeMdPatched) console.log(`Added @lcm.md to ~/.claude/CLAUDE.md`);

  // 7. Final verification
  console.log("\nRunning doctor...");
  const _runDoctor = deps.runDoctor ?? (async () => {
    const { runDoctor, printResults: _print } = await import("../src/doctor/doctor.js");
    const _results = await runDoctor();
    _print(_results);
    return _results;
  });
  const results = await _runDoctor();
  const failures = results.filter((r: { status: string }) => r.status === "fail");
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed. Run 'lcm doctor' for details.`);
  } else {
    console.log("lcm installed successfully! All checks passed.");
  }
}

// Re-export rmSync so uninstall.ts can share the pattern
export { rmSync };
