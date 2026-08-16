import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, chmodSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { ensureCore } from "../src/bootstrap.js";
import { bootstrapLcmHome, lcmHomeDir } from "../src/runtime-paths.js";
import {
  atomicWritePrivateFile,
  atomicWritePrivateFileDurable,
  OWNER_ONLY_FILE_MODES,
  readBoundedRegularFile,
} from "../src/security-files.js";
import { parseStoredConfig } from "../src/daemon/config.js";
import { resolveAgentTransport } from "../src/connectors/registry.js";
import { renderGuidance } from "../src/connectors/template-service.js";
import type { ConnectorTransport } from "../src/connectors/types.js";
import { LCM_HISTORICAL_SKILL_SHA256, LCM_MANAGED_SKILL_MARKER } from "../src/connectors/constants.js";
import {
  assertBackendPublicationConfigAccess,
  assertBackendPublicationConfigMutation,
  assertBackendPublicationConsumerAccess,
  backendPublicationHomeForConfigPath,
  withBackendPublicationConfigLock,
  type BackendPublicationLockToken,
} from "../src/storage/backend-publication.js";
import { packageExecutable, packageRootFor } from "../src/runtime-root.js";
import {
  hasCanonicalClaudeMcpEntry,
  mergeClaudeMcpEntry,
  mergeClaudeSettings,
} from "../src/installer/settings.js";
export {
  REQUIRED_HOOKS,
  canonicalHookCommand,
  hasCanonicalClaudeMcpEntry,
  hasManagedClaudeSettings,
  mergeClaudeMcpEntry,
  mergeClaudeSettings,
} from "../src/installer/settings.js";

export interface ServiceDeps {
  spawnSync: (cmd: string, args: string[], opts?: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, data: string) => void;
  mkdirSync: (path: string, opts?: any) => void;
  existsSync: (path: string) => boolean;
  chmodSync?: (path: string, mode: number) => void;
  lstatSync?: typeof lstatSync;
  atomicWritePrivateFile?: typeof atomicWritePrivateFile;
  atomicWritePrivateFileDurable?: typeof atomicWritePrivateFileDurable;
  readBoundedRegularFile?: typeof readBoundedRegularFile;
  ensureLcmHome?: (homeDir: string) => void;
  readdirSync?: typeof readdirSync;
  copyFileSync?: typeof copyFileSync;
  rmSync?: typeof rmSync;
  commandsSourceDir?: string;
  skillSourceDir?: string;
  cwd?: string;
  binaryPath?: string;
  dryRun?: boolean;
  previewWriteFile?: (path: string, data: string) => void;
  promptUser: (question: string) => Promise<string>;
  ensureDaemon?: (opts: { port: number; pidFilePath: string; spawnTimeoutMs: number }) => Promise<{ connected: boolean }>;
  runDoctor?: () => Promise<Array<{ name: string; status: string; category?: string; message?: string }>>;
  /** Test seam for the canonical package-rendered Claude skill. */
  renderClaudeSkill?: (transport: ConnectorTransport) => string;
  /** Deterministic test seam; production resolves from stored config. */
  claudeTransport?: ConnectorTransport;
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

export async function readlinePrompt(question: string): Promise<string> {
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

const defaultDeps: ServiceDeps = {
  spawnSync: spawnSync as ServiceDeps["spawnSync"],
  readFileSync: readFileSync as ServiceDeps["readFileSync"],
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  lstatSync,
  readdirSync,
  rmSync,
  atomicWritePrivateFile,
  atomicWritePrivateFileDurable,
  readBoundedRegularFile,
  ensureLcmHome: bootstrapLcmHome,
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

const MAX_INSTALL_CONFIG_BYTES = 4 * 1024 * 1024;

function readInstallConfig(deps: ServiceDeps, path: string): string {
  if (deps.readBoundedRegularFile !== undefined) {
    return deps.readBoundedRegularFile(path, {
      allowedRoot: dirname(path),
      maxBytes: MAX_INSTALL_CONFIG_BYTES,
      expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
      allowedModes: OWNER_ONLY_FILE_MODES,
      requireSingleLink: true,
    });
  }
  // Explicit test dependencies may only expose a string reader. Keep that
  // compatibility seam bounded, while production always uses the descriptor
  // reader above before allocating the full config string.
  const content = deps.readFileSync(path, "utf-8");
  if (Buffer.byteLength(content, "utf8") > MAX_INSTALL_CONFIG_BYTES) {
    throw new Error("configuration file exceeds the 4 MiB safety limit");
  }
  return content;
}

type InstallConfigState = Readonly<{
  exists: boolean;
  content: string | null;
}>;

function inspectInstallConfig(
  deps: ServiceDeps,
  path: string,
  lockToken?: BackendPublicationLockToken,
): InstallConfigState {
  if (!safeConfigExists(deps, path)) {
    return { exists: false, content: null };
  }
  const content = readInstallConfig(deps, path);
  const stored = parseStoredConfig(content);
  const backend = (
    stored.storage as { backend?: string } | undefined
  )?.backend === "postgresql" ? "postgresql" : "sqlite";
  assertBackendPublicationConfigAccess(path, backend, content, undefined, lockToken);
  return { exists: true, content };
}

/** @internal Deterministic installer configuration-preparation seam. */
export function prepareInstallConfig(deps: ServiceDeps, path: string): InstallConfigState {
  const homeDir = backendPublicationHomeForConfigPath(path);
  if (deps.ensureLcmHome === undefined) {
    // Unit/dry-run dependencies intentionally do not authenticate or mutate
    // the real home. Their config existence seam is sufficient for the
    // installer orchestration tests.
    return { exists: safeConfigExists(deps, path), content: null };
  }
  if (homeDir === undefined) {
    return inspectInstallConfig(deps, path);
  }
  return withBackendPublicationConfigLock(path, (lockToken) => {
    if (!safeConfigExists(deps, path)) {
      assertBackendPublicationConsumerAccess({ homeDir, lockToken });
      return { exists: false, content: null };
    }
    const content = readInstallConfig(deps, path);
    const stored = parseStoredConfig(content);
    const backend = (
      stored.storage as { backend?: string } | undefined
    )?.backend === "postgresql" ? "postgresql" : "sqlite";
    assertBackendPublicationConfigAccess(path, backend, content, undefined, lockToken);
    return { exists: true, content };
  });
}

function readMergedClaudeSettings(
  deps: Pick<ServiceDeps, "existsSync" | "readFileSync">,
  settingsPath: string,
  lcmBin: string,
  transport: ConnectorTransport = "mcp",
): Record<string, unknown> {
  if (!deps.existsSync(settingsPath)) return mergeClaudeSettings({}, lcmBin, process.execPath, transport);
  let parsed: unknown;
  try {
    parsed = JSON.parse(deps.readFileSync(settingsPath, "utf-8"));
  } catch {
    throw new Error(`Refusing to modify malformed Claude settings: ${settingsPath}`);
  }
  return mergeClaudeSettings(parsed, lcmBin, process.execPath, transport);
}

function persistVerifiedNativeClaudeSettings(
  deps: Pick<ServiceDeps, "existsSync" | "readFileSync" | "writeFileSync" | "mkdirSync" | "dryRun" | "previewWriteFile">,
  settingsPath: string,
  lcmBin: string,
  transport: ConnectorTransport = "mcp",
  previewDryRun = false,
): void {
  const merged = readMergedClaudeSettings(deps, settingsPath, lcmBin, transport);
  const mcpServers = merged.mcpServers as Record<string, unknown>;
  if (transport === "mcp") {
    mcpServers.lcm = mergeClaudeMcpEntry(mcpServers.lcm, lcmBin);
  } else if (hasCanonicalClaudeMcpEntry(mcpServers.lcm, lcmBin)) {
    // CLI transport owns only the exact npm stdio entry. A same-named user
    // server or a stale/collision entry is left byte-for-byte intact.
    delete mcpServers.lcm;
  }
  if (transport === "cli" && Object.keys(mcpServers).length === 0) delete merged.mcpServers;
  else merged.mcpServers = mcpServers;

  const serialized = JSON.stringify(merged, null, 2);
  if (deps.dryRun) {
    if (!previewDryRun && deps.previewWriteFile !== undefined) {
      // Preview the destination topology through the injected dry-run seam;
      // production dry-run dependencies implement this as an in-memory/no-op.
      deps.mkdirSync(dirname(settingsPath), { recursive: true });
    }
    if (previewDryRun) deps.previewWriteFile?.(settingsPath, serialized);
    return;
  }

  deps.mkdirSync(dirname(settingsPath), { recursive: true });
  deps.writeFileSync(settingsPath, serialized);

  let persisted: unknown;
  try {
    persisted = JSON.parse(deps.readFileSync(settingsPath, "utf-8"));
  } catch {
    throw new Error(`Could not verify native Claude settings after writing: ${settingsPath}`);
  }
  const verified = mergeClaudeSettings(persisted, lcmBin, process.execPath, transport);
  const persistedRecord = persisted as Record<string, unknown>;
  // mergeClaudeSettings always normalizes mcpServers to an object before it
  // returns, so the persisted entry can be read directly after verification.
  const persistedMcpEntry = (verified.mcpServers as Record<string, unknown>).lcm;
  if (JSON.stringify(persistedRecord.hooks) !== JSON.stringify(verified.hooks)
      || (transport === "mcp" && !hasCanonicalClaudeMcpEntry(persistedMcpEntry, lcmBin))
      || (transport === "cli" && hasCanonicalClaudeMcpEntry(persistedMcpEntry, lcmBin))) {
    throw new Error(`Native Claude settings did not persist correctly: ${settingsPath}`);
  }
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

export interface ClaudeSkillInstallDeps {
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string, encoding: string) => string;
  readonly writeFileSync: (path: string, content: string) => void;
  readonly mkdirSync: (path: string, opts?: any) => void;
  readonly lstatSync?: typeof lstatSync;
  readonly readdirSync?: typeof readdirSync;
  readonly rmSync?: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
  readonly dryRun?: boolean;
  readonly previewWriteFile?: (path: string, content: string) => void;
  readonly renderClaudeSkill?: (transport: ConnectorTransport) => string;
  readonly removeCurrentSkill?: boolean;
}

function yamlFrontmatterEnd(content: string): number | undefined {
  if (!content.startsWith("---")) return undefined;
  const firstLineEnd = content.indexOf("\n");
  if (firstLineEnd === -1 || content.slice(0, firstLineEnd).replace(/\r$/u, "") !== "---") return undefined;
  let lineStart = firstLineEnd + 1;
  while (lineStart <= content.length) {
    const lineFeed = content.indexOf("\n", lineStart);
    const lineEnd = lineFeed === -1 ? content.length : lineFeed;
    if (content.slice(lineStart, lineEnd).replace(/\r$/u, "") === "---") {
      return lineFeed === -1 ? content.length : lineFeed + 1;
    }
    if (lineFeed === -1) break;
    lineStart = lineFeed + 1;
  }
  return undefined;
}

function hasCanonicalSkillMarker(content: string): boolean {
  const frontmatterEnd = yamlFrontmatterEnd(content);
  if (frontmatterEnd === undefined) return false;
  const lineFeed = content.indexOf("\n", frontmatterEnd);
  const lineEnd = lineFeed === -1 ? content.length : lineFeed;
  return content.slice(frontmatterEnd, lineEnd).replace(/\r$/u, "") === LCM_MANAGED_SKILL_MARKER;
}

function historicalSkillDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function ownedCanonicalSkill(existing: string, generated: string): boolean {
  return existing === generated
    || hasCanonicalSkillMarker(existing)
    || LCM_HISTORICAL_SKILL_SHA256.includes(
      historicalSkillDigest(existing) as (typeof LCM_HISTORICAL_SKILL_SHA256)[number],
    );
}

/** Stage and verify the package-rendered Claude skill before any migration. */
export function installClaudeSkill(
  deps: ClaudeSkillInstallDeps,
  transport: ConnectorTransport,
  homeDirPath: string = homedir(),
): string {
  const path = join(homeDirPath, ".claude", "skills", "lcm-memory", "SKILL.md");
  const generated = deps.renderClaudeSkill?.(transport) ?? renderGuidance("skill", transport);
  if (deps.existsSync(path)) {
    const existing = deps.readFileSync(path, "utf-8");
    if (!ownedCanonicalSkill(existing, generated)) {
      throw new Error(`Refusing to overwrite an unowned LCM skill at ${path}`);
    }
  }
  if (deps.dryRun) {
    deps.previewWriteFile?.(path, generated);
    return path;
  }
  deps.mkdirSync(dirname(path), { recursive: true });
  deps.writeFileSync(path, generated);
  if (deps.readFileSync(path, "utf-8") !== generated) {
    throw new Error(`Installed LCM skill failed byte verification at ${path}`);
  }
  return path;
}

function removeRecognizedClaudeLegacy(
  deps: ClaudeSkillInstallDeps,
  homeDirPath: string,
  legacyLcmMdContent?: string,
): void {
  const claudeDir = join(homeDirPath, ".claude");
  const currentSkill = join(claudeDir, "skills", "lcm-memory", "SKILL.md");
  if (deps.removeCurrentSkill && deps.existsSync(currentSkill)) {
    let owned = false;
    try {
      owned = ownedCanonicalSkill(
        deps.readFileSync(currentSkill, "utf-8"),
        "",
      );
    } catch { /* preserve unreadable collisions */ }
    if (owned) {
      if (deps.dryRun) console.log(`[dry-run] would remove ${currentSkill}`);
      else (deps.rmSync ?? rmSync)(currentSkill, { force: true });
    } else {
      console.warn(`Warning: preserving unrecognized Claude skill collision at ${currentSkill}`);
    }
  }
  const legacySkill = join(claudeDir, "skills", "lcm-context");
  if (deps.existsSync(legacySkill)) {
    let owned = false;
    if (deps.lstatSync !== undefined && deps.readdirSync !== undefined) {
      try {
        const stat = deps.lstatSync(legacySkill);
        if (stat.isDirectory()) {
          const entries = deps.readdirSync(legacySkill)
            .filter((entry): entry is string => typeof entry === "string");
          owned = entries.length > 0 && entries.every((entry) => {
            if (!entry.endsWith(".md")) return false;
            try {
              return deps.readFileSync(join(legacySkill, entry), "utf-8").toLowerCase().includes("lcm");
            } catch { return false; }
          });
        }
      } catch { /* preserve unrecognized or unreadable legacy collisions */ }
    }
    if (owned) {
      if (deps.dryRun) console.log(`[dry-run] would remove ${legacySkill}`);
      else (deps.rmSync ?? rmSync)(legacySkill, { recursive: true, force: true });
    } else {
      console.warn(`Warning: preserving unrecognized Claude legacy skill collision at ${legacySkill}`);
    }
  }

  const lcmMdPath = join(claudeDir, "lcm.md");
  if (deps.existsSync(lcmMdPath)) {
    let owned = false;
    try {
      const content = deps.readFileSync(lcmMdPath, "utf-8");
      owned = (legacyLcmMdContent !== undefined && content === legacyLcmMdContent)
        || /long context manager|lcm memory/iu.test(content);
    } catch { /* preserve unreadable legacy files and continue to CLAUDE.md */ }
    if (owned) {
      if (deps.dryRun) console.log(`[dry-run] would remove ${lcmMdPath}`);
      else (deps.rmSync ?? rmSync)(lcmMdPath, { force: true });
    } else {
      console.warn(`Warning: preserving unrecognized Claude legacy file at ${lcmMdPath}`);
    }
  }

  const claudeMdPath = join(claudeDir, "CLAUDE.md");
  if (!deps.existsSync(claudeMdPath)) return;
  let existing: string;
  try { existing = deps.readFileSync(claudeMdPath, "utf-8"); } catch (error) { throw error; }
  const blockRange = findLcmMdBlock(existing);
  if (!blockRange) return;
  const block = existing.slice(blockRange.start, blockRange.end).replace(/\r\n/g, "\n").trim();
  if (block !== `${LCM_BLOCK_START}\n<!-- Claude Code include: @lcm.md -->\n${LCM_BLOCK_END}`
      && block !== `${LCM_BLOCK_START}\n@lcm.md\n${LCM_BLOCK_END}`) {
    console.warn(`Warning: preserving modified Claude managed include in ${claudeMdPath}`);
    return;
  }
  if (deps.dryRun) {
    console.log(`[dry-run] would remove managed include from ${claudeMdPath}`);
    return;
  }
  const updated = existing.slice(0, blockRange.start) + existing.slice(blockRange.end);
  deps.writeFileSync(claudeMdPath, updated);
}

/** Remove only recognized legacy Claude guidance assets after verification. */
export function removeClaudeLegacyAssets(
  deps: ClaudeSkillInstallDeps,
  homeDirPath: string = homedir(),
  legacyLcmMdContent?: string,
): void {
  removeRecognizedClaudeLegacy(deps, homeDirPath, legacyLcmMdContent);
}

export function resolveClaudeTransport(configPathValue: string): ConnectorTransport {
  try {
    return resolveAgentTransport("claude-code", undefined, { configPath: configPathValue }).transport;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "mcp";
    throw error;
  }
}

export async function install(deps: ServiceDeps = defaultDeps): Promise<void> {
  const lcDir = lcmHomeDir();

  const configPath = join(lcDir, "config.json");
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const lcmBin = deps.binaryPath ?? packageExecutable(import.meta.url, 2);
  if (!isAbsolute(lcmBin)) {
    throw new Error("Could not resolve an absolute npm-installed lcm executable path");
  }

  // The installer is the operator-assisted root creator. Production deps use
  // descriptor-bound topology authentication; test/dry-run deps can inject a
  // no-op seam without causing the installer to mutate the real home.
  deps.ensureLcmHome?.(homedir());
  if (deps.ensureLcmHome === undefined) {
    // Compatibility seam for explicit test dependencies. The production
    // default never takes this recursive/pathname creation branch.
    deps.mkdirSync(lcDir, { recursive: true, mode: 0o700 });
    deps.chmodSync?.(lcDir, 0o700);
  }

  const claudeTransport = deps.claudeTransport ?? resolveClaudeTransport(configPath);

  // Validate settings before making any migration or installation changes.
  readMergedClaudeSettings(deps, settingsPath, lcmBin, claudeTransport);

  // 1-3. Core setup (config + settings cleanup + daemon)
  // ensureCore handles: creating config.json, merging settings.json hooks, and starting daemon
  // For install, we inject summarizer config into the default config if creating fresh
  const initialConfig = prepareInstallConfig(deps, configPath);
  if (!initialConfig.exists) {
    const summarizerConfig = await pickSummarizer(deps);
    const { daemonConfigForPersistence, loadDaemonConfig } = await import("../src/daemon/config.js");
    const defaults = loadDaemonConfig("/nonexistent");
    defaults.llm = { ...defaults.llm, ...summarizerConfig };
    const serialized = JSON.stringify(daemonConfigForPersistence(defaults), null, 2);
    const create = (lockToken?: BackendPublicationLockToken): boolean => {
      if (safeConfigExists(deps, configPath)) return false;
      if (lockToken !== undefined) {
        assertBackendPublicationConfigMutation(
          configPath,
          "sqlite",
          "sqlite",
          serialized,
          null,
          undefined,
          lockToken,
        );
      }
      try {
        if (deps.atomicWritePrivateFileDurable !== undefined) {
          deps.atomicWritePrivateFileDurable(configPath, serialized, { requireAbsent: true });
        } else {
          // Explicit dependency injection only. The default path has already
          // authenticated the root and uses the durable writer above.
          deps.mkdirSync(dirname(configPath), { recursive: true });
          if (deps.atomicWritePrivateFile) deps.atomicWritePrivateFile(configPath, serialized);
          else deps.writeFileSync(configPath, serialized);
          try { (deps.chmodSync ?? chmodSync)(configPath, 0o600); } catch { /* best-effort */ }
        }
      } catch (error) {
        if (safeConfigExists(deps, configPath)) return false;
        throw error;
      }
      return true;
    };
    const created = deps.ensureLcmHome !== undefined
      && backendPublicationHomeForConfigPath(configPath) !== undefined
      ? withBackendPublicationConfigLock(configPath, (lockToken) => create(lockToken))
      : create();
    if (created) console.log(`Created ${configPath}`);
  }

  // Stage and byte-verify the canonical skill before touching native Claude
  // MCP state or removing any legacy guidance. A renderer/write/readback
  // failure therefore leaves the previous working integration intact.
  const canonicalSkillPath = (deps.ensureLcmHome !== undefined || deps.renderClaudeSkill !== undefined)
    ? installClaudeSkill(deps, claudeTransport, homedir())
    : undefined;

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
    atomicWritePrivateFileDurable: deps.atomicWritePrivateFileDurable,
    ensureRuntimeHome: deps.ensureLcmHome,
    binaryPath: lcmBin,
    transport: claudeTransport,
    ensureDaemon: deps.ensureDaemon ?? (async (opts) => {
      const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
      return ensureDaemon(opts);
    }),
  });

  // Establish and read back the native hook and MCP settings before removing a
  // working Marketplace plugin. If the settings write is not durable, the
  // legacy integration remains untouched.
  persistVerifiedNativeClaudeSettings(deps, settingsPath, lcmBin, claudeTransport, true);
  console.log(`Updated ${settingsPath}`);

  migrateClaudeMarketplacePlugins(deps, deps.cwd ?? process.cwd());

  // Claude's plugin uninstaller may rewrite settings. Re-read that result,
  // preserve its unrelated mutations, and restore only LCM-owned fields.
  persistVerifiedNativeClaudeSettings(deps, settingsPath, lcmBin, claudeTransport);

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
  // 5. Stage and byte-verify the canonical skill first. Legacy cleanup is
  // deliberately after this boundary so a renderer/write/readback failure
  // leaves the prior guidance surface untouched.
  if (canonicalSkillPath !== undefined) {
    console.log(`Installed canonical Claude skill to ${canonicalSkillPath}`);
    const { LCM_MD_CONTENT } = await import("../src/daemon/orientation.js");
    removeRecognizedClaudeLegacy(deps, homedir(), LCM_MD_CONTENT);
  } else {
    // Compatibility-only injected test fixtures may not model a byte-readable
    // home. The production dependency set always takes the verified path.
    if (deps.skillSourceDir !== undefined) {
      const legacySkillSource = deps.skillSourceDir;
      const legacySkillDestination = join(homedir(), ".claude", "skills", "lcm-context");
      copyMarkdownFiles(deps, legacySkillSource, legacySkillDestination);
    }
    console.log("Skipped Claude skill fixture without a filesystem verification seam");
  }

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
