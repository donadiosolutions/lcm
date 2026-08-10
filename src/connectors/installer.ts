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
  removeManagedClaudeHooks,
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

const MANAGED_MARKERS = new Set<string>(
  MANAGED_MARKER_PAIRS.flatMap(({ START, END }) => [START, END]),
);
const MANAGED_START_MARKERS = new Set<string>(
  MANAGED_MARKER_PAIRS.map(({ START }) => START),
);

type MarkerLine = {
  lineStart: number;
  lineEnd: number;
  marker: string;
};

type MarkdownEol = '\n' | '\r\n';

type ManagedBlock = {
  startIdx: number;
  endIdx: number;
  endLength: number;
};

function findStandaloneManagedMarkerLines(content: string): MarkerLine[] {
  const lines: MarkerLine[] = [];
  let lineStart = 0;
  while (lineStart <= content.length) {
    let lineContentEnd = lineStart;
    while (lineContentEnd < content.length) {
      const character = content.charCodeAt(lineContentEnd);
      if (character === 0x0a || character === 0x0d) break;
      lineContentEnd += 1;
    }

    let markerStart = lineStart;
    while (markerStart < lineContentEnd) {
      const character = content.charCodeAt(markerStart);
      if (character !== 0x20 && character !== 0x09) break;
      markerStart += 1;
    }

    let markerEnd = lineContentEnd;
    while (markerEnd > markerStart) {
      const character = content.charCodeAt(markerEnd - 1);
      if (character !== 0x20 && character !== 0x09) break;
      markerEnd -= 1;
    }

    let lineEnd = lineContentEnd;
    if (lineContentEnd < content.length) {
      lineEnd += 1;
      if (content.charCodeAt(lineContentEnd) === 0x0d && content.charCodeAt(lineContentEnd + 1) === 0x0a) {
        lineEnd += 1;
      }
    }

    const marker = content.slice(markerStart, markerEnd);
    if (MANAGED_MARKERS.has(marker)) lines.push({ lineStart, lineEnd, marker });

    if (lineEnd === content.length) break;
    lineStart = lineEnd;
  }
  return lines;
}

function isGeneratedLcmBlock(content: string, start: MarkerLine, end: MarkerLine): boolean {
  return /^# Workflow Instruction(?:\r\n|\n|\r|$)/u.test(content.slice(start.lineEnd, end.lineStart));
}

function isWorkflowInstructionOnly(content: string, startIdx: number, endIdx: number): boolean {
  if (startIdx >= endIdx) return false;

  const lines = content.slice(startIdx, endIdx).split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  return lines.length > 0 && lines.every((line) => line === '# Workflow Instruction');
}

function managedBlock(start: MarkerLine, end: MarkerLine): ManagedBlock {
  return {
    startIdx: start.lineStart,
    endIdx: end.lineStart,
    endLength: end.lineEnd - end.lineStart,
  };
}

function findSameMarkerBlocks(
  content: string,
  markerLines: MarkerLine[],
  marker: string,
): ManagedBlock[] {
  const candidates: Array<{ line: MarkerLine; markerIndex: number }> = [];
  for (let markerIndex = 0; markerIndex < markerLines.length; markerIndex += 1) {
    const line = markerLines[markerIndex];
    if (line.marker === marker) candidates.push({ line, markerIndex });
  }

  const blocks: ManagedBlock[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const start = candidates[index].line;
    const nextSameMarker = candidates[index + 1]?.line;
    if (nextSameMarker && isGeneratedLcmBlock(content, start, nextSameMarker)) {
      blocks.push(managedBlock(start, nextSameMarker));
    }

    const nextMarker = markerLines[candidates[index].markerIndex + 1];
    const endIdx = nextMarker?.lineStart ?? content.length;
    if (isWorkflowInstructionOnly(content, start.lineEnd, endIdx)) {
      let partialStartIdx = start.lineStart;
      let previousMarkerIndex = candidates[index].markerIndex - 1;
      while (previousMarkerIndex >= 0) {
        const previousMarker = markerLines[previousMarkerIndex];
        if (previousMarker.lineEnd !== partialStartIdx || !MANAGED_START_MARKERS.has(previousMarker.marker)) break;
        partialStartIdx = previousMarker.lineStart;
        previousMarkerIndex -= 1;
      }
      blocks.push({ startIdx: partialStartIdx, endIdx, endLength: 0 });
    }
  }
  return blocks;
}

function advancePastLine(lines: MarkerLine[], index: number, lineEnd: number): number {
  while (index < lines.length && lines[index].lineStart < lineEnd) index += 1;
  return index;
}

function findDistinctMarkerBlocks(
  markerLines: MarkerLine[],
  startMarker: string,
  endMarker: string,
): ManagedBlock[] {
  const starts: MarkerLine[] = [];
  const ends: MarkerLine[] = [];
  for (const line of markerLines) {
    if (line.marker === startMarker) starts.push(line);
    if (line.marker === endMarker) ends.push(line);
  }

  const blocks: ManagedBlock[] = [];
  let startIndex = 0;
  let endIndex = 0;
  while (startIndex < starts.length && endIndex < ends.length) {
    const start = starts[startIndex];
    const end = ends[endIndex];
    if (end.lineStart <= start.lineStart) {
      endIndex += 1;
      continue;
    }

    blocks.push(managedBlock(start, end));
    startIndex = advancePastLine(starts, startIndex + 1, end.lineEnd);
    endIndex = advancePastLine(ends, endIndex + 1, end.lineEnd);
  }
  return blocks;
}

function compareManagedBlocks(left: ManagedBlock, right: ManagedBlock): number {
  return left.startIdx - right.startIdx;
}

function managedBlockEnd(block: ManagedBlock): number {
  return block.endIdx + block.endLength;
}

function mergeManagedBlockCandidates(candidateSets: ManagedBlock[][]): ManagedBlock[] {
  const indexes = candidateSets.map(() => 0);
  const blocks: ManagedBlock[] = [];
  let unionStartIdx: number | undefined;
  let unionEndIdx = 0;

  while (true) {
    let selectedSet = -1;
    let selected: ManagedBlock | undefined;
    for (let setIndex = 0; setIndex < candidateSets.length; setIndex += 1) {
      const candidate = candidateSets[setIndex][indexes[setIndex]];
      if (candidate && (!selected || compareManagedBlocks(candidate, selected) < 0)) {
        selectedSet = setIndex;
        selected = candidate;
      }
    }
    if (!selected) break;

    indexes[selectedSet] += 1;
    const selectedEndIdx = managedBlockEnd(selected);
    if (unionStartIdx === undefined || selected.startIdx > unionEndIdx) {
      if (unionStartIdx !== undefined) {
        blocks.push({ startIdx: unionStartIdx, endIdx: unionEndIdx, endLength: 0 });
      }
      unionStartIdx = selected.startIdx;
      unionEndIdx = selectedEndIdx;
    } else if (selectedEndIdx > unionEndIdx) {
      unionEndIdx = selectedEndIdx;
    }
  }

  if (unionStartIdx !== undefined) {
    blocks.push({ startIdx: unionStartIdx, endIdx: unionEndIdx, endLength: 0 });
  }

  return blocks;
}

function findManagedBlocks(content: string): ManagedBlock[] {
  const markerLines = findStandaloneManagedMarkerLines(content);
  const candidateSets = MANAGED_MARKER_PAIRS.map(({ START, END }) => (
    START === END
      ? findSameMarkerBlocks(content, markerLines, START)
      : findDistinctMarkerBlocks(markerLines, START, END)
  ));
  return mergeManagedBlockCandidates(candidateSets);
}

function hasManagedBlock(content: string): boolean {
  return findManagedBlocks(content).length > 0;
}

function establishedMarkdownEol(...contents: string[]): MarkdownEol {
  return contents.some(content => content.includes('\r\n')) ? '\r\n' : '\n';
}

function trimMarkdownLineBreaksAtStart(content: string): string {
  let contentStart = 0;
  while (contentStart < content.length) {
    const character = content.charCodeAt(contentStart);
    if (character !== 0x0a && character !== 0x0d) break;
    contentStart += 1;
  }
  return content.slice(contentStart);
}

function trimMarkdownLineBreaksAtEnd(content: string): string {
  let contentEnd = content.length;
  while (contentEnd > 0) {
    const character = content.charCodeAt(contentEnd - 1);
    if (character !== 0x0a && character !== 0x0d) break;
    contentEnd -= 1;
  }
  return content.slice(0, contentEnd);
}

function normalizeMarkdownLineEndings(content: string, eol: MarkdownEol): string {
  const parts: string[] = [];
  let segmentStart = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content.charCodeAt(index);
    if (character !== 0x0a && character !== 0x0d) continue;
    parts.push(content.slice(segmentStart, index), eol);
    if (character === 0x0d && content.charCodeAt(index + 1) === 0x0a) index += 1;
    segmentStart = index + 1;
  }
  parts.push(content.slice(segmentStart));
  return parts.join('');
}

function removeMarkers(content: string): string {
  const blocks = findManagedBlocks(content);
  if (blocks.length === 0) return content;

  const eol = establishedMarkdownEol(content);
  const retained: string[] = [];
  let cursor = 0;

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    let before = trimMarkdownLineBreaksAtEnd(content.slice(cursor, block.startIdx));
    if (index > 0) before = trimMarkdownLineBreaksAtStart(before);
    if (before) retained.push(before);
    cursor = block.endIdx + block.endLength;
  }

  const after = trimMarkdownLineBreaksAtEnd(
    trimMarkdownLineBreaksAtStart(content.slice(cursor)),
  );
  if (after) retained.push(after);

  return normalizeMarkdownLineEndings(retained.join(eol), eol);
}

function normalizeMarkdownEof(content: string, eol: MarkdownEol = establishedMarkdownEol(content)): string {
  return normalizeMarkdownLineEndings(trimMarkdownLineBreaksAtEnd(content), eol) + eol;
}

function appendMarkdown(existing: string, content: string): string {
  const cleaned = removeMarkers(existing);
  const eol = establishedMarkdownEol(existing, cleaned, content);
  const normalizedExisting = normalizeMarkdownLineEndings(trimMarkdownLineBreaksAtEnd(cleaned), eol);
  const normalizedContent = normalizeMarkdownEof(content, eol);
  if (!normalizedExisting) return normalizedContent;
  return `${normalizedExisting}${eol}${normalizedContent}`;
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
    // Remove old markers if present before re-appending.
    writeFileSync(filePath, appendMarkdown(existing, content));
  } else {
    writeFileSync(filePath, normalizeMarkdownEof(content));
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
  const cleaned = removeManagedClaudeHooks(existing);
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
  const eol = establishedMarkdownEol(content);
  if (cleaned.trim() === '') {
    unlinkSync(resolvedPath);
  } else {
    writeFileSync(resolvedPath, normalizeMarkdownEof(cleaned, eol));
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
