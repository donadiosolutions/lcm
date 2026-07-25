import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ConnectorType } from "./types.js";
import { requiresRestart } from "./types.js";
import { LCM_MARKERS } from "./constants.js";
import { generateContent } from "./template-service.js";
import { findAgent, AGENTS } from "./registry.js";
import { CODEX_CONFIG_PATH, LEGACY_CODEX_HOOKS_PATHS, hasCodexHooks, installCodexHooks, removeCodexHooks } from "./codex-hooks.js";
import {
  canonicalHookCommand,
  removeManagedClaudeSettings,
  REQUIRED_HOOKS,
} from "../installer/settings.js";
import { packageExecutable } from "../runtime-root.js";

export interface InstallResult {
  success: boolean;
  path: string;
  paths?: string[];
  requiresRestart: boolean;
  manual?: string;
}

export interface InstalledConnector {
  agentId: string;
  agentName: string;
  type: ConnectorType;
  path: string;
}

function resolveConfigPath(configPath: string, cwd: string): string {
  if (configPath.startsWith('~/')) {
    return join(homedir(), configPath.slice(2));
  }
  return join(cwd, configPath);
}

const MANAGED_MARKER_PAIRS = [
  LCM_MARKERS,
  {
    START: '<!-- [LCM_CONNECTOR_START] -->',
    END: '<!-- [LCM_CONNECTOR_END] -->',
  },
] as const;

type MarkerLine = {
  lineStart: number;
  lineEnd: number;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findStandaloneMarkerLines(content: string, marker: string): MarkerLine[] {
  const lines: MarkerLine[] = [];
  const pattern = new RegExp(`(^|\\r?\\n)[ \\t]*${escapeRegExp(marker)}[ \\t]*(?:\\r?\\n|$)`, 'g');
  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    const lineStart = match.index + match[1].length;
    lines.push({
      lineStart,
      lineEnd: match.index + match[0].length,
    });
  }
  return lines;
}

function isGeneratedLcmBlock(content: string, start: MarkerLine, end: MarkerLine): boolean {
  return content.slice(start.lineEnd, end.lineStart).trimStart().startsWith('# Workflow Instruction');
}

function findManagedBlock(content: string): { startIdx: number; endIdx: number; endLength: number } | undefined {
  let found: { startIdx: number; endIdx: number; endLength: number } | undefined;
  for (const markers of MANAGED_MARKER_PAIRS) {
    const starts = findStandaloneMarkerLines(content, markers.START);
    const ends = markers.START === markers.END ? starts : findStandaloneMarkerLines(content, markers.END);
    for (const start of starts) {
      for (const end of ends) {
        if (end.lineStart <= start.lineStart) continue;
        if (markers.START === markers.END && !isGeneratedLcmBlock(content, start, end)) continue;
        if (!found || start.lineStart < found.startIdx) {
          found = {
            startIdx: start.lineStart,
            endIdx: end.lineStart,
            endLength: end.lineEnd - end.lineStart,
          };
        }
        break;
      }
    }
  }
  return found;
}

function hasManagedBlock(content: string): boolean {
  return findManagedBlock(content) !== undefined;
}

function removeMarkers(content: string): string {
  const block = findManagedBlock(content);
  if (!block) return content;
  const before = content.slice(0, block.startIdx).trimEnd();
  const after = content.slice(block.endIdx + block.endLength).trimStart();
  if (!before) return after.trim();
  if (!after) return before.trim();
  return `${before}\n${after}`.trim();
}

// Strategy 1: Markdown targets (rules, skill)
function installMarkdown(content: string, filePath: string, writeMode: 'append' | 'overwrite'): void {
  mkdirSync(dirname(filePath), { recursive: true });
  if (writeMode === 'append') {
    let existing = '';
    try {
      existing = readFileSync(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Remove old markers if present before re-appending
    const cleaned = removeMarkers(existing);
    writeFileSync(filePath, cleaned + (cleaned.endsWith('\n') || cleaned === '' ? '' : '\n') + content + '\n');
  } else {
    writeFileSync(filePath, content + '\n');
  }
}

// Strategy 2: Structured targets (MCP JSON)
function installMcpJson(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  let existing: any = {};
  try { existing = JSON.parse(readFileSync(filePath, 'utf-8')); } catch { existing = {}; }
  if (typeof existing !== 'object' || existing === null) existing = {};
  if (typeof existing.mcpServers !== 'object' || existing.mcpServers === null || Array.isArray(existing.mcpServers)) {
    existing.mcpServers = {};
  }
  existing.mcpServers.lcm = { type: 'stdio', command: 'lcm', args: ['mcp'] };
  writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n');
}

function removeMcpJson(filePath: string): boolean {
  if (filePath.endsWith('.toml')) return false; // TOML removal not supported
  let config: any;
  try { config = JSON.parse(readFileSync(filePath, 'utf-8')); } catch { return false; }
  if (!config.mcpServers?.lcm) return false;
  delete config.mcpServers.lcm;
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
  return true;
}

function readJsonObject(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function removeClaudeHooks(filePath: string): boolean {
  let existing: Record<string, unknown>;
  try {
    existing = readJsonObject(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const cleaned = removeManagedClaudeSettings(existing);
  if (JSON.stringify(existing) === JSON.stringify(cleaned)) return false;
  writeFileSync(filePath, JSON.stringify(cleaned, null, 2) + "\n");
  return true;
}

function hasClaudeHooks(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const existing = readJsonObject(filePath);
    const hooks = existing.hooks;
    if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return false;
    const runtimePath = packageExecutable(import.meta.url, 3);
    return REQUIRED_HOOKS.every(({ event, command }) => {
      const entries = (hooks as Record<string, unknown>)[event];
      if (!Array.isArray(entries)) return false;
      const expected = canonicalHookCommand(runtimePath, command);
      return entries.some((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
        const commands = (entry as Record<string, unknown>).hooks;
        return Array.isArray(commands) && commands.some((hook) =>
          hook !== null
          && typeof hook === "object"
          && !Array.isArray(hook)
          && (hook as Record<string, unknown>).type === "command"
          && (hook as Record<string, unknown>).command === expected
        );
      });
    });
  } catch {
    return false;
  }
}

export function installConnector(agentIdOrName: string, type?: ConnectorType, cwd: string = process.cwd()): InstallResult {
  const agent = findAgent(agentIdOrName);
  if (!agent) throw new Error(`Unknown agent: ${agentIdOrName}`);

  if (!type && agent.defaultTypes && agent.defaultTypes.length > 0) {
    const results = agent.defaultTypes.map((defaultType) => installConnector(agentIdOrName, defaultType, cwd));
    const paths = results.map((result) => result.path).filter((path) => path.length > 0);
    return {
      success: results.every((result) => result.success),
      path: paths.join(", "),
      paths,
      requiresRestart: results.some((result) => result.requiresRestart),
      manual: results.map((result) => result.manual).filter((manual): manual is string => Boolean(manual)).join("\n\n") || undefined,
    };
  }

  const connectorType = type ?? agent.defaultType;
  if (!agent.supportedTypes.includes(connectorType)) {
    throw new Error(`Agent "${agent.name}" does not support connector type "${connectorType}". Supported: ${agent.supportedTypes.join(', ')}`);
  }

  if (connectorType === 'hook') {
    if (agent.id === 'codex') {
      const hookConfigPath = agent.configPaths.hook;
      if (!hookConfigPath) {
        throw new Error(`No config path defined for ${agent.name} with type hook`);
      }
      const hooksPath = resolveConfigPath(hookConfigPath, cwd);
      const configPath = resolveConfigPath(CODEX_CONFIG_PATH, cwd);
      installCodexHooks(hooksPath, configPath);
      for (const legacyPath of LEGACY_CODEX_HOOKS_PATHS.map((path) => resolveConfigPath(path, cwd))) {
        if (legacyPath !== hooksPath) removeCodexHooks(legacyPath);
      }
      return {
        success: true,
        path: hooksPath,
        requiresRestart: requiresRestart(connectorType),
      };
    }

    if (agent.id === 'claude-code') {
      return {
        success: true,
        path: '',
        requiresRestart: false,
        manual: "Run `lcm install` to migrate any recognized Marketplace installation and install Claude Code hooks safely.",
      };
    }

    throw new Error(`Native hook installation is not implemented for ${agent.name}`);
  }

  const configPath = agent.configPaths[connectorType];

  if (connectorType === 'mcp' && !configPath) {
    return { success: true, path: '', requiresRestart: true, manual: `Add the lcm MCP server to ${agent.name} manually:\n\nServer name: lcm\nCommand: lcm\nArgs: mcp` };
  }
  if (!configPath) throw new Error(`No config path defined for ${agent.name} with type ${connectorType}`);

  const resolvedPath = resolveConfigPath(configPath, cwd);

  if (connectorType === 'mcp') {
    if (configPath.endsWith('.toml')) {
      return {
        success: true,
        path: resolvedPath,
        requiresRestart: requiresRestart(connectorType),
        manual: `Add the following to ${configPath}:\n\n[mcp_servers.lcm]\ncommand = "lcm"\nargs = ["mcp"]`,
      };
    }
    installMcpJson(resolvedPath);
    return { success: true, path: resolvedPath, requiresRestart: requiresRestart(connectorType) };
  }

  if (connectorType === 'skill') {
    const content = generateContent(agent, connectorType);
    const skillPath = join(resolvedPath, 'lcm-memory', 'SKILL.md');
    installMarkdown(content, skillPath, 'overwrite');
    return { success: true, path: skillPath, requiresRestart: requiresRestart(connectorType) };
  }

  // rules
  const content = generateContent(agent, connectorType);
  const writeMode = agent.writeMode ?? 'overwrite';
  installMarkdown(content, resolvedPath, writeMode);
  return { success: true, path: resolvedPath, requiresRestart: requiresRestart(connectorType) };
}

export function removeConnector(agentIdOrName: string, type?: ConnectorType, cwd: string = process.cwd()): boolean {
  const agent = findAgent(agentIdOrName);
  if (!agent) throw new Error(`Unknown agent: ${agentIdOrName}`);

  if (!type && agent.defaultTypes && agent.defaultTypes.length > 0) {
    let removed = false;
    for (const defaultType of agent.defaultTypes) {
      removed = removeConnector(agentIdOrName, defaultType, cwd) || removed;
    }
    return removed;
  }

  const connectorType = type ?? agent.defaultType;
  const configPath = agent.configPaths[connectorType];
  if (!configPath) return false;

  const resolvedPath = resolveConfigPath(configPath, cwd);

  if (connectorType === 'hook' && agent.id === 'codex') {
    return removeCodexHooks(resolvedPath);
  }
  if (connectorType === 'hook' && agent.id === 'claude-code') {
    return removeClaudeHooks(resolvedPath);
  }

  if (connectorType === 'mcp') {
    return removeMcpJson(resolvedPath);
  }

  if (connectorType === 'skill') {
    const skillPath = join(resolvedPath, 'lcm-memory', 'SKILL.md');
    if (existsSync(skillPath)) {
      unlinkSync(skillPath);
      return true;
    }
    return false;
  }

  // rules: remove markers from file
  let content: string;
  try { content = readFileSync(resolvedPath, 'utf-8'); } catch { return false; }
  if (!hasManagedBlock(content)) return false;
  const cleaned = removeMarkers(content);
  if (cleaned.trim() === '') {
    unlinkSync(resolvedPath);
  } else {
    writeFileSync(resolvedPath, cleaned + '\n');
  }
  return true;
}

export function listConnectors(cwd: string = process.cwd()): InstalledConnector[] {
  const installed: InstalledConnector[] = [];

  for (const agent of AGENTS) {
    for (const type of agent.supportedTypes) {
      const configPath = agent.configPaths[type as ConnectorType];
      if (!configPath) continue;

      const resolvedPath = resolveConfigPath(configPath, cwd);

      if (type === 'mcp') {
        if (resolvedPath.endsWith('.toml')) continue; // Skip TOML files
        if (existsSync(resolvedPath)) {
          try {
            const config = JSON.parse(readFileSync(resolvedPath, 'utf-8'));
            if (config.mcpServers?.lcm) {
              installed.push({ agentId: agent.id, agentName: agent.name, type, path: resolvedPath });
            }
          } catch {
            // ignore malformed JSON
          }
        }
      } else if (type === 'hook' && agent.id === 'codex') {
        if (hasCodexHooks(resolvedPath)) {
          installed.push({ agentId: agent.id, agentName: agent.name, type, path: resolvedPath });
        }
      } else if (type === 'hook' && agent.id === 'claude-code') {
        if (hasClaudeHooks(resolvedPath)) {
          installed.push({ agentId: agent.id, agentName: agent.name, type, path: resolvedPath });
        }
      } else if (type === 'skill') {
        const skillPath = join(resolvedPath, 'lcm-memory', 'SKILL.md');
        if (existsSync(skillPath)) {
          installed.push({ agentId: agent.id, agentName: agent.name, type, path: skillPath });
        }
      } else {
        // rules / hook
        if (existsSync(resolvedPath)) {
          const content = readFileSync(resolvedPath, 'utf-8');
          if (hasManagedBlock(content)) {
            installed.push({ agentId: agent.id, agentName: agent.name, type, path: resolvedPath });
          }
        }
      }
    }
  }

  return installed;
}
