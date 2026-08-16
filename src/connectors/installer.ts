import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, statSync, chmodSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Agent, ConnectorSurface, ConnectorTransport } from "./types.js";
import { CONNECTOR_SURFACES, requiresRestart } from "./types.js";
import { LCM_HISTORICAL_SKILL_SHA256, LCM_MANAGED_SKILL_MARKER, LCM_MARKERS } from "./constants.js";
import { generateContent } from "./template-service.js";
import { findAgent, AGENTS, resolveAgentTransport } from "./registry.js";
import { CODEX_CONFIG_PATH, LEGACY_CODEX_HOOKS_PATHS, hasCodexHooks, installCodexHooks, removeCodexHooks } from "./codex-hooks.js";
import {
  canonicalHookCommand,
  removeManagedClaudeHooks,
  REQUIRED_HOOKS,
} from "../installer/settings.js";
import { packageExecutable } from "../runtime-root.js";
import {
  clearConnectorTransport,
  readConnectorTransport,
  setConnectorTransport,
} from "../config-manager.js";
import { configPath as defaultConfigPath } from "../runtime-paths.js";

export interface InstallResult {
  success: boolean;
  path: string;
  paths?: string[];
  requiresRestart: boolean;
  manual?: string;
  transport?: ConnectorTransport;
  partial?: boolean;
  failures?: string[];
}

export interface InstalledConnector {
  agentId: string;
  agentName: string;
  type: ConnectorSurface;
  path: string;
}

export type CodexMcpInspectionState = "installed" | "absent" | "unknown";

export interface CodexMcpInspection {
  readonly state: CodexMcpInspectionState;
  readonly reason?: "collision" | "unavailable";
}

export interface ConnectorInventoryOptions {
  readonly codexCliRunner?: CodexCliRunner;
  readonly codexMcpRunner?: CodexMcpRunner;
}

export interface ConnectorInventory {
  readonly installed: readonly InstalledConnector[];
  readonly codexMcp: CodexMcpInspection;
}

function resolveConfigPath(configPath: string, cwd: string): string {
  if (configPath.startsWith('~/')) {
    return join(homedir(), configPath.slice(2));
  }
  return join(cwd, configPath);
}

function surfaceRequiresRestart(surface: ConnectorSurface): boolean {
  return surface !== "rules";
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

  const generatedPairs: boolean[] = [];
  for (let index = 0; index + 1 < candidates.length; index += 1) {
    generatedPairs.push(isGeneratedLcmBlock(content, candidates[index].line, candidates[index + 1].line));
  }

  const selectedPairs: boolean[] = [];
  for (let index = generatedPairs.length - 1; index >= 0; index -= 1) {
    if (generatedPairs[index] && !selectedPairs[index + 1]) selectedPairs[index] = true;
  }

  const blocks: ManagedBlock[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const start = candidates[index].line;
    const nextSameMarker = candidates[index + 1]?.line;
    if (selectedPairs[index] && nextSameMarker) {
      blocks.push(managedBlock(start, nextSameMarker));
    }

    if (!selectedPairs[index] && !selectedPairs[index - 1]) {
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

  const retainedRaw: string[] = [];
  let cursor = 0;
  for (const block of blocks) {
    retainedRaw.push(content.slice(cursor, block.startIdx));
    cursor = block.endIdx + block.endLength;
  }
  retainedRaw.push(content.slice(cursor));

  const eol = establishedMarkdownEol(...retainedRaw);
  const retained: string[] = [];
  for (let index = 0; index < retainedRaw.length; index += 1) {
    let segment = trimMarkdownLineBreaksAtEnd(retainedRaw[index]);
    if (index > 0) segment = trimMarkdownLineBreaksAtStart(segment);
    if (segment) retained.push(segment);
  }

  if (retained.length === 0) return '';
  return `${normalizeMarkdownLineEndings(retained.join(eol), eol)}${eol}`;
}

function normalizeMarkdownEof(content: string, eol: MarkdownEol = establishedMarkdownEol(content)): string {
  return normalizeMarkdownLineEndings(trimMarkdownLineBreaksAtEnd(content), eol) + eol;
}

function appendMarkdown(existing: string, content: string): string {
  const cleaned = removeMarkers(existing);
  const eol = establishedMarkdownEol(cleaned, content);
  const normalizedExisting = normalizeMarkdownLineEndings(trimMarkdownLineBreaksAtEnd(cleaned), eol);
  const normalizedContent = normalizeMarkdownEof(content, eol);
  if (!normalizedExisting) return normalizedContent;
  return `${normalizedExisting}${eol}${normalizedContent}`;
}

function yamlFrontmatterEnd(content: string): number | undefined {
  if (!content.startsWith('---')) return undefined;
  const firstLineEnd = content.indexOf('\n');
  if (firstLineEnd === -1 || content.slice(0, firstLineEnd).replace(/\r$/u, '') !== '---') return undefined;
  let lineStart = firstLineEnd + 1;
  while (lineStart <= content.length) {
    const lineFeed = content.indexOf('\n', lineStart);
    const lineEnd = lineFeed === -1 ? content.length : lineFeed;
    const line = content.slice(lineStart, lineEnd).replace(/\r$/u, '');
    if (line === '---') return lineFeed === -1 ? content.length : lineFeed + 1;
    if (lineFeed === -1) break;
    lineStart = lineFeed + 1;
  }
  return undefined;
}

function hasManagedSkillMarker(content: string): boolean {
  const frontmatterEnd = yamlFrontmatterEnd(content);
  if (frontmatterEnd === undefined) return false;
  let lineStart = frontmatterEnd;
  while (lineStart <= content.length) {
    const lineFeed = content.indexOf('\n', lineStart);
    const lineEnd = lineFeed === -1 ? content.length : lineFeed;
    const line = content.slice(lineStart, lineEnd).replace(/\r$/u, '');
    if (line === LCM_MANAGED_SKILL_MARKER) return true;
    if (line.trim() !== '') return false;
    if (lineFeed === -1) break;
    lineStart = lineFeed + 1;
  }
  return false;
}

function managedSkillContent(content: string): string {
  const eol = establishedMarkdownEol(content);
  const normalized = normalizeMarkdownEof(content, eol);
  if (hasManagedSkillMarker(normalized)) return normalized;
  const frontmatterEnd = yamlFrontmatterEnd(normalized) ?? 0;
  return `${normalized.slice(0, frontmatterEnd)}${LCM_MANAGED_SKILL_MARKER}${eol}${normalized.slice(frontmatterEnd)}`;
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isHistoricalSkill(content: Buffer): boolean {
  return LCM_HISTORICAL_SKILL_SHA256.includes(sha256(content) as (typeof LCM_HISTORICAL_SKILL_SHA256)[number]);
}

function withoutManagedSkillMarker(content: string): string {
  const eol = establishedMarkdownEol(content);
  const markerLine = `${LCM_MANAGED_SKILL_MARKER}${eol}`;
  return content.replace(markerLine, "");
}

function isOwnedSkill(content: Buffer, generated: string | readonly string[]): boolean {
  const generatedContents = typeof generated === "string" ? [generated] : generated;
  const generatedBuffers = generatedContents.flatMap((candidate) => [
    Buffer.from(candidate, 'utf-8'),
    Buffer.from(withoutManagedSkillMarker(candidate), 'utf-8'),
  ]);
  return hasManagedSkillMarker(content.toString('utf-8'))
    || generatedBuffers.some((candidate) => content.equals(candidate))
    || isHistoricalSkill(content);
}

function skillCollision(filePath: string): Error {
  return new Error(`Refusing to overwrite an unowned LCM skill at ${filePath}`);
}

function preflightSkill(filePath: string, generated: string): void {
  if (!existsSync(filePath)) return;
  let stats;
  try { stats = lstatSync(filePath); } catch (error) { throw new Error(`Unable to inspect LCM skill at ${filePath}`, { cause: error }); }
  if (!stats.isFile()) throw skillCollision(filePath);
  const existing = readFileSync(filePath);
  if (!isOwnedSkill(existing, generated)) throw skillCollision(filePath);
}

function installSkill(content: string, filePath: string): void {
  preflightSkill(filePath, content);
  const expected = Buffer.from(managedSkillContent(content), 'utf-8');
  if (existsSync(filePath) && readFileSync(filePath).equals(expected)) return;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, expected);
  if (!readFileSync(filePath).equals(expected)) throw new Error(`Installed LCM skill failed ownership verification at ${filePath}`);
}

function removeSkill(filePath: string, generated: string | readonly string[], strict = false): boolean {
  if (!existsSync(filePath)) return false;
  let stats;
  try { stats = lstatSync(filePath); } catch (error) {
    if (!strict && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`Unable to inspect LCM skill at ${filePath}`, { cause: error });
  }
  if (!stats.isFile()) {
    if (strict) throw skillCollision(filePath);
    return false;
  }
  const content = readFileSync(filePath);
  if (!isOwnedSkill(content, generated)) {
    if (strict) throw new Error(`Refusing to remove an unowned LCM skill at ${filePath}`);
    return false;
  }
  unlinkSync(filePath);
  return true;
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
function installMcpJson(filePath: string, strict = false): void {
  mkdirSync(dirname(filePath), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      existing = readJsonObject(filePath);
    } catch (error) {
      if (strict) throw error;
      if (!(error instanceof SyntaxError) && !(error instanceof Error && error.message === `${filePath} must contain a JSON object`)) throw error;
    }
  }
  const servers = existing.mcpServers;
  if (servers === undefined) {
    existing.mcpServers = {};
  } else if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
    if (strict) throw new Error(`${filePath}.mcpServers must contain a JSON object`);
    existing.mcpServers = {};
  }
  const mcpServers = existing.mcpServers as Record<string, unknown>;
  if (mcpServers.lcm !== undefined && !isOwnedMcpEntry(mcpServers.lcm)) {
    throw new Error(`Refusing to overwrite a non-LCM MCP entry named lcm in ${filePath}`);
  }
  if (isOwnedMcpEntry(mcpServers.lcm)) return;
  mcpServers.lcm = { type: 'stdio', command: 'lcm', args: ['mcp'] };
  writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n');
  const verified = readJsonObject(filePath);
  if (!isOwnedMcpEntry(verified.mcpServers && (verified.mcpServers as Record<string, unknown>).lcm)) {
    throw new Error(`Installed MCP entry failed ownership verification at ${filePath}`);
  }
}

function removeMcpJson(filePath: string, strict = false): boolean {
  if (filePath.endsWith('.toml')) return false; // TOML removal not supported
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    if (!strict) return false;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`Unable to parse MCP configuration at ${filePath}`, { cause: error });
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    if (strict) throw new Error(`${filePath} must contain a JSON object`);
    return false;
  }
  const root = config as Record<string, unknown>;
  const servers = root.mcpServers;
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    if (strict) throw new Error(`${filePath}.mcpServers must contain a JSON object`);
    return false;
  }
  const lcm = (servers as Record<string, unknown> | undefined)?.lcm;
  if (lcm === undefined) return false;
  if (!isOwnedMcpEntry(lcm)) {
    if (strict) throw new Error(`Refusing to remove a non-LCM MCP entry named lcm in ${filePath}`);
    return false;
  }
  const mcpServers = servers as Record<string, unknown>;
  delete mcpServers.lcm;
  writeFileSync(filePath, JSON.stringify(root, null, 2) + '\n');
  return true;
}

function isOwnedMcpEntry(value: unknown): value is Record<string, unknown> & { command: "lcm"; args: ["mcp"] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return entry.type === "stdio"
    && entry.command === "lcm"
    && Array.isArray(entry.args)
    && entry.args.length === 1
    && entry.args[0] === "mcp";
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

function hasClaudeHooks(filePath: string, transports: readonly ConnectorTransport[] = ["cli", "mcp"]): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const existing = readJsonObject(filePath);
    const hooks = existing.hooks;
    if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return false;
    const runtimePath = packageExecutable(import.meta.url, 3);
    const expectedCommands = new Map(
      REQUIRED_HOOKS.map(({ event, command }) => [
        event,
        transports.map((transport) => canonicalHookCommand(
          runtimePath,
          command,
          process.execPath,
          process.platform,
          transport,
        )),
      ] as const),
    );
    return REQUIRED_HOOKS.every(({ event, command }) => {
      const entries = (hooks as Record<string, unknown>)[event];
      if (!Array.isArray(entries)) return false;
      const expected = expectedCommands.get(event)!;
      return entries.some((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
        const commands = (entry as Record<string, unknown>).hooks;
        return Array.isArray(commands) && commands.some((hook) =>
          hook !== null
          && typeof hook === "object"
          && !Array.isArray(hook)
          && (hook as Record<string, unknown>).type === "command"
          && expected.includes((hook as Record<string, unknown>).command as string)
        );
      });
    });
  } catch {
    return false;
  }
}

function claudeHookTransportsForInventory(): readonly ConnectorTransport[] {
  try {
    return [resolveAgentTransport("claude-code").transport];
  } catch {
    return ["cli", "mcp"];
  }
}

export type CodexMcpEntry = {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly disabled_reason?: string | null;
  readonly transport?: CodexMcpTransport;
  readonly enabled_tools?: readonly string[] | null;
  readonly disabled_tools?: readonly string[] | null;
  readonly startup_timeout_sec?: number | null;
  readonly tool_timeout_sec?: number | null;
  readonly [key: string]: unknown;
};

export type CodexMcpTransport = {
  readonly type?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: unknown;
  readonly env_vars?: readonly string[];
  readonly cwd?: string | null;
  readonly [key: string]: unknown;
};

export type CodexCliRunRequest = {
  readonly executable: "codex";
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly timeout: 5_000;
  readonly maxBuffer: 1_048_576;
};

export type CodexCliRunResult = {
  readonly status: number | null;
  readonly stdout?: string | Buffer;
  readonly stderr?: string | Buffer;
  readonly error?: Error;
};

/** Injectable low-level Codex CLI seam. It must not execute a shell command. */
export type CodexCliRunner = (request: CodexCliRunRequest) => CodexCliRunResult;

/** Injectable native Codex MCP seam used by convergence and deterministic tests. */
export interface CodexMcpRunner {
  get(): readonly CodexMcpEntry[];
  add(): void;
  remove(): void;
  restore?(entries: readonly CodexMcpEntry[]): void;
}

export interface ConnectorInstallerOptions {
  readonly configPath?: string;
  readonly codexCliRunner?: CodexCliRunner;
  readonly codexMcpRunner?: CodexMcpRunner;
  readonly onPhase?: (phase: ConnectorInstallPhase) => void;
  readonly failAt?: ConnectorInstallPhase;
  /** CLI defaults set this false so an implicit default never writes config. */
  readonly persistTransport?: boolean;
  /** Explicit Codex CLI switches may inspect and remove one verified MCP entry. */
  readonly queryCodexMcp?: boolean;
  readonly cwd?: string;
}

export type ConnectorInstallPhase =
  | "snapshot"
  | "stage"
  | "verify"
  | "remove-superseded"
  | "persist"
  | "complete";

export interface RemoveResult {
  readonly success: boolean;
  readonly removed: boolean;
  readonly paths: readonly string[];
  readonly failures: readonly string[];
}

function isConnectorSurface(value: unknown): value is ConnectorSurface {
  return typeof value === "string" && (CONNECTOR_SURFACES as readonly string[]).includes(value);
}

function surfacePath(agent: Agent, surface: ConnectorSurface, cwd: string): string | undefined {
  const configPath = agent.configPaths[surface];
  if (!configPath) return undefined;
  const resolved = resolveConfigPath(configPath, cwd);
  return surface === "skill" ? join(resolved, "lcm-memory", "SKILL.md") : resolved;
}

function installComponent(
  agent: Agent,
  surface: ConnectorSurface,
  cwd: string,
  strictMcp = false,
  transport: ConnectorTransport = "cli",
): InstallResult {
  if (surface === "hook") {
    if (agent.id === "codex") {
      const hookConfigPath = agent.configPaths.hook;
      if (!hookConfigPath) throw new Error(`No config path defined for ${agent.name} with type hook`);
      const hooksPath = resolveConfigPath(hookConfigPath, cwd);
      const configPath = resolveConfigPath(CODEX_CONFIG_PATH, cwd);
      installCodexHooks(hooksPath, configPath, transport);
      for (const legacyPath of LEGACY_CODEX_HOOKS_PATHS.map((path) => resolveConfigPath(path, cwd))) {
        if (legacyPath !== hooksPath) removeCodexHooks(legacyPath);
      }
      return { success: true, path: hooksPath, requiresRestart: surfaceRequiresRestart(surface) };
    }
    if (agent.id === "claude-code") {
      return {
        success: true,
        path: "",
        requiresRestart: false,
        manual: "Run `lcm install` to migrate any recognized Marketplace installation and install Claude Code hooks safely.",
      };
    }
    throw new Error(`Native hook installation is not implemented for ${agent.name}`);
  }

  const configPath = agent.configPaths[surface];
  if (surface === "mcp" && !configPath) {
    return {
      success: true,
      path: "",
      requiresRestart: surfaceRequiresRestart(surface),
      manual: `Add the lcm MCP server to ${agent.name} manually:\n\nServer name: lcm\nCommand: lcm\nArgs: mcp`,
    };
  }
  if (!configPath) {
    throw new Error(`Agent "${agent.name}" does not support connector type "${surface}"; No config path defined for ${agent.name} with type ${surface}`);
  }

  const resolvedPath = resolveConfigPath(configPath, cwd);
  if (surface === "mcp") {
    if (configPath.endsWith(".toml")) {
      return {
        success: true,
        path: resolvedPath,
        requiresRestart: surfaceRequiresRestart(surface),
        manual: `Add the following to ${configPath}:\n\n[mcp_servers.lcm]\ncommand = "lcm"\nargs = ["mcp"]`,
      };
    }
    installMcpJson(resolvedPath, strictMcp);
    return { success: true, path: resolvedPath, requiresRestart: surfaceRequiresRestart(surface) };
  }

  if (surface === "skill") {
    const skillPath = join(resolvedPath, "lcm-memory", "SKILL.md");
    installSkill(generateContent(agent, surface, transport), skillPath);
    return { success: true, path: skillPath, requiresRestart: surfaceRequiresRestart(surface) };
  }

  installMarkdown(generateContent(agent, surface, transport), resolvedPath, agent.writeMode ?? "overwrite");
  return { success: true, path: resolvedPath, requiresRestart: surfaceRequiresRestart(surface) };
}

function removeComponent(agent: Agent, surface: ConnectorSurface, cwd: string, strictSkill = false): boolean {
  const configPath = agent.configPaths[surface];
  if (!configPath) return false;
  const resolvedPath = resolveConfigPath(configPath, cwd);
  if (surface === "hook" && agent.id === "codex") return removeCodexHooks(resolvedPath);
  if (surface === "hook" && agent.id === "claude-code") return removeClaudeHooks(resolvedPath);
  if (surface === "mcp") return removeMcpJson(resolvedPath);
  if (surface === "skill") {
    const skillPath = join(resolvedPath, "lcm-memory", "SKILL.md");
    return removeSkill(skillPath, [
      generateContent(agent, surface, "cli"),
      generateContent(agent, surface, "mcp"),
    ], strictSkill);
  }

  let content: string;
  try { content = readFileSync(resolvedPath, "utf-8"); } catch { return false; }
  if (!hasManagedBlock(content)) return false;
  const cleaned = removeMarkers(content);
  const eol = establishedMarkdownEol(cleaned);
  if (cleaned === "") unlinkSync(resolvedPath);
  else writeFileSync(resolvedPath, normalizeMarkdownEof(cleaned, eol));
  return true;
}

function legacyDefaultSurfaces(agent: Agent): readonly ConnectorSurface[] {
  if (agent.id === "codex") return ["hook", "skill"];
  if (["claude-code", "gemini-cli", "opencode", "warp", "auggie-cli", "cursor", "windsurf", "trae", "qoder", "antigravity", "github-copilot", "roo-code", "kilo-code", "amp", "kiro", "junie", "openclaw"].includes(agent.id)) {
    return [agent.configPaths.skill ? "skill" : "rules"];
  }
  return ["mcp"];
}

function installLegacyDefault(agent: Agent, cwd: string): InstallResult {
  const targets = legacyDefaultSurfaces(agent);
  const results = targets.map((surface) => installComponent(agent, surface, cwd, false, "cli"));
  for (const surface of targets) verifySurface(agent, surface, cwd, undefined, "cli");
  if (agent.id === "codex") removeComponent(agent, "rules", cwd);
  const paths = results.map((result) => result.path).filter((path) => path.length > 0);
  return {
    success: results.every((result) => result.success),
    path: paths.join(", "),
    paths,
    requiresRestart: results.some((result) => result.requiresRestart),
    manual: results.map((result) => result.manual).filter((manual): manual is string => Boolean(manual)).join("\n\n") || undefined,
  };
}

function removeLegacyDefault(agent: Agent, cwd: string): boolean {
  let removed = false;
  for (const surface of legacyDefaultSurfaces(agent)) removed = removeComponent(agent, surface, cwd) || removed;
  if (agent.id === "codex") removed = removeComponent(agent, "rules", cwd) || removed;
  return removed;
}

function nativeCodexMcpEnvironment(cwd: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_COLLATE",
    "LC_CTYPE",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_NUMERIC",
    "LC_TIME",
    "TZ",
  ]) {
    const value = process.env[name];
    if (typeof value !== "string" || value.length === 0 || value.length > 4096) continue;
    if (/[\u0000\r\n]/u.test(value)) continue;
    environment[name] = value;
  }
  if (!environment.PATH) environment.PATH = "/usr/bin:/bin";
  environment.CODEX_HOME = resolveConfigPath("~/.codex", cwd);
  return environment;
}

const CODEX_MCP_TIMEOUT_MS = 5_000;
const CODEX_MCP_MAX_OUTPUT = 1_048_576;

class CodexCliCommandError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "CodexCliCommandError";
  }
}

function defaultCodexCliRunner(request: CodexCliRunRequest): CodexCliRunResult {
  const result = spawnSync(request.executable, [...request.argv], {
    cwd: request.cwd,
    env: request.env,
    shell: request.shell,
    timeout: request.timeout,
    maxBuffer: request.maxBuffer,
    encoding: "utf-8",
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" || Buffer.isBuffer(result.stdout) ? result.stdout : undefined,
    stderr: typeof result.stderr === "string" || Buffer.isBuffer(result.stderr) ? result.stderr : undefined,
    error: result.error instanceof Error ? result.error : undefined,
  };
}

function runnerText(value: string | Buffer | undefined): string {
  return value === undefined ? "" : Buffer.isBuffer(value) ? value.toString("utf-8") : value;
}

function runNativeCodexMcp(
  cwd: string,
  args: readonly string[],
  runner: CodexCliRunner = defaultCodexCliRunner,
): string {
  const request: CodexCliRunRequest = {
    executable: "codex",
    argv: [...args],
    cwd,
    env: nativeCodexMcpEnvironment(cwd),
    shell: false,
    timeout: CODEX_MCP_TIMEOUT_MS,
    maxBuffer: CODEX_MCP_MAX_OUTPUT,
  };
  let result: CodexCliRunResult;
  try {
    result = runner(request);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex CLI runner failed: ${detail}`);
  }
  if (result.error) {
    const detail = result.error.message || result.error.name || "unknown runner error";
    throw new Error(`Codex CLI runner failed: ${detail}`, { cause: result.error });
  }
  if (result.status !== 0) {
    const stderr = runnerText(result.stderr).trim();
    const detail = stderr.length > 0 ? `: ${stderr}` : "";
    throw new CodexCliCommandError(
      `Codex CLI command ${request.argv.join(" ")} exited with status ${String(result.status)}${detail}`,
      result.status,
      stderr,
    );
  }
  return runnerText(result.stdout);
}

function normalizeCodexMcpEntries(value: unknown): readonly CodexMcpEntry[] {
  if (Array.isArray(value)) {
    if (!value.every((entry) => !!entry && typeof entry === "object" && !Array.isArray(entry))) {
      throw new Error("codex mcp get returned malformed JSON");
    }
    return value as CodexMcpEntry[];
  }
  if (!value || typeof value !== "object") throw new Error("codex mcp get returned malformed JSON");
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.servers)) return normalizeCodexMcpEntries(object.servers);
  if (typeof object.name === "string") return [object];
  if (Object.hasOwn(object, "lcm")) {
    const entry = object.lcm;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [{ name: "lcm", transport: undefined }];
    return [{ name: "lcm", ...(entry as Record<string, unknown>) }];
  }
  return Object.entries(object)
    .map(([name, entry]) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("codex mcp get returned malformed JSON");
      return { name, ...(entry as Record<string, unknown>) };
    });
}

function parseCodexMcpJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error("Codex MCP get returned malformed JSON", { cause: error });
  }
}

function defaultCodexMcpRunner(cwd: string, cliRunner: CodexCliRunner = defaultCodexCliRunner): CodexMcpRunner {
  const get = (): readonly CodexMcpEntry[] => {
    try {
      return normalizeCodexMcpEntries(parseCodexMcpJson(runNativeCodexMcp(cwd, ["mcp", "get", "lcm", "--json"], cliRunner)));
    } catch (error) {
      if (error instanceof CodexCliCommandError
        && error.status !== 0
        && error.stderr === "No MCP server named 'lcm' found.") {
        return [];
      }
      throw error;
    }
  };
  return {
    get,
    add: () => { runNativeCodexMcp(cwd, ["mcp", "add", "lcm", "--", "lcm", "mcp"], cliRunner); },
    remove: () => { runNativeCodexMcp(cwd, ["mcp", "remove", "lcm"], cliRunner); },
  };
}

const CODEX_MCP_ENTRY_KEYS = new Set([
  "name",
  "enabled",
  "disabled_reason",
  "transport",
  "enabled_tools",
  "disabled_tools",
  "startup_timeout_sec",
  "tool_timeout_sec",
]);

const CODEX_MCP_TRANSPORT_KEYS = new Set(["type", "command", "args", "env", "env_vars", "cwd"]);

function isCanonicalCodexMcpEntry(entry: CodexMcpEntry): boolean {
  if (entry.name !== "lcm" || !Object.keys(entry).every((key) => CODEX_MCP_ENTRY_KEYS.has(key))) return false;
  if (entry.enabled !== true || entry.disabled_reason !== null
    || entry.enabled_tools !== null || entry.disabled_tools !== null
    || entry.startup_timeout_sec !== null || entry.tool_timeout_sec !== null) return false;
  const transport = entry.transport;
  return !!transport
    && !Array.isArray(transport)
    && Object.keys(transport).every((key) => CODEX_MCP_TRANSPORT_KEYS.has(key))
    && transport.type === "stdio"
    && transport.command === "lcm"
    && Array.isArray(transport.args)
    && transport.args.length === 1
    && transport.args[0] === "mcp"
    && transport.env === null
    && Array.isArray(transport.env_vars)
    && transport.env_vars.length === 0
    && transport.cwd === null;
}

function findCodexLcmEntry(entries: readonly CodexMcpEntry[]): CodexMcpEntry | undefined {
  return entries.find((entry) => entry.name === "lcm");
}

function installCodexMcp(runner: CodexMcpRunner): boolean {
  const current = runner.get();
  const existing = findCodexLcmEntry(current);
  if (existing && !isCanonicalCodexMcpEntry(existing)) throw new Error("Refusing to overwrite an unverified Codex MCP entry named lcm");
  if (!existing) runner.add();
  const verified = findCodexLcmEntry(runner.get());
  if (!verified || !isCanonicalCodexMcpEntry(verified)) throw new Error("Codex MCP lcm entry failed JSON readback verification");
  return !existing;
}

function removeCodexMcp(runner: CodexMcpRunner): boolean {
  const current = runner.get();
  const existing = findCodexLcmEntry(current);
  if (!existing) return false;
  if (!isCanonicalCodexMcpEntry(existing)) throw new Error("Refusing to remove an unverified Codex MCP entry named lcm");
  runner.remove();
  if (findCodexLcmEntry(runner.get())) throw new Error("Codex MCP lcm entry remained after removal");
  return true;
}

function codexMcpEntriesEqual(left: readonly CodexMcpEntry[], right: readonly CodexMcpEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compensateCodexMcp(runner: CodexMcpRunner, prior: readonly CodexMcpEntry[]): void {
  const current = runner.get();

  if (runner.restore) {
    runner.restore(prior);
  } else {
    const currentEntry = findCodexLcmEntry(current);
    if (currentEntry) {
      if (!isCanonicalCodexMcpEntry(currentEntry)) {
        throw new Error("current Codex MCP entry is not safely removable");
      }
      runner.remove();
    }
    if (findCodexLcmEntry(prior)) runner.add();
  }

  const restored = runner.get();
  if (!codexMcpEntriesEqual(restored, prior)) throw new Error("Codex MCP compensation readback mismatch");
}

type OwnedFileSnapshot = { readonly path: string; readonly content?: Buffer; readonly mode?: number; readonly nonFile?: boolean };

function snapshotOwnedFiles(paths: readonly string[]): OwnedFileSnapshot[] {
  const snapshots: OwnedFileSnapshot[] = [];
  for (const path of [...new Set(paths)]) {
    if (!existsSync(path)) {
      snapshots.push({ path });
      continue;
    }
    const stats = statSync(path);
    if (!stats.isFile()) {
      snapshots.push({ path, nonFile: true });
      continue;
    }
    snapshots.push({ path, content: readFileSync(path), mode: stats.mode & 0o777 });
  }
  return snapshots;
}

function fileSnapshotsEqual(left: readonly OwnedFileSnapshot[], right: readonly OwnedFileSnapshot[]): boolean {
  return left.every((snapshot, index) => {
    const other = right[index];
    return snapshot.path === other.path
      && snapshot.nonFile === other.nonFile
      && snapshot.mode === other.mode
      && ((snapshot.content === undefined && other.content === undefined)
        || (snapshot.content !== undefined && other.content !== undefined && snapshot.content.equals(other.content)));
  });
}

function restoreOwnedFiles(snapshots: readonly OwnedFileSnapshot[]): void {
  for (const snapshot of snapshots) {
    if (snapshot.nonFile) continue;
    if (snapshot.content === undefined) {
      if (existsSync(snapshot.path)) {
        try { unlinkSync(snapshot.path); } catch { /* preserve a non-file user surface */ }
      }
      continue;
    }
    mkdirSync(dirname(snapshot.path), { recursive: true });
    // A file snapshot always records its mode; absent snapshots have no content
    // and return through the branch above.
    writeFileSync(snapshot.path, snapshot.content, { mode: snapshot.mode! });
  }
}

function phase(options: ConnectorInstallerOptions, name: ConnectorInstallPhase): void {
  options.onPhase?.(name);
  if (options.failAt === name) throw new Error(`Injected connector installer failure at ${name}`);
}

function bundleSurfaces(agent: Agent, transport: ConnectorTransport): ConnectorSurface[] {
  const capabilities = agent.capabilities[transport];
  if (!capabilities) throw new Error(`Agent "${agent.name}" does not support connector transport "${transport}"`);
  const guidance = capabilities.guidance.find((surface) => Boolean(agent.configPaths[surface]));
  if (!guidance) throw new Error(`Agent "${agent.name}" has no guidance surface for connector transport "${transport}"`);
  const surfaces: ConnectorSurface[] = [guidance];
  if (capabilities.nativeHook && agent.configPaths.hook) surfaces.push("hook");
  if (transport === "mcp" && capabilities.mcpAdapter) surfaces.push("mcp");
  return surfaces;
}

function allOwnedPaths(agent: Agent, cwd: string): string[] {
  const paths: string[] = [];
  for (const surface of CONNECTOR_SURFACES) {
    const path = surfacePath(agent, surface, cwd);
    if (path) paths.push(path);
  }
  if (agent.id === "codex") {
    paths.push(resolveConfigPath(CODEX_CONFIG_PATH, cwd));
    for (const path of LEGACY_CODEX_HOOKS_PATHS) paths.push(resolveConfigPath(path, cwd));
  }
  return paths;
}

function verifySurface(
  agent: Agent,
  surface: ConnectorSurface,
  cwd: string,
  runner?: CodexMcpRunner,
  transport: ConnectorTransport = "cli",
): void {
  if (surface === "mcp" && agent.id === "codex") {
    const entry = findCodexLcmEntry(runner!.get());
    if (!entry || !isCanonicalCodexMcpEntry(entry)) throw new Error("Codex MCP lcm entry failed verification");
    return;
  }
  if (surface === "hook" && agent.id === "claude-code") return;
  const path = surfacePath(agent, surface, cwd);
  if (!path) throw new Error(`No config path defined for ${agent.name} with type ${surface}`);
  if (surface === "skill") {
    if (!existsSync(path)) throw new Error(`Installed skill is missing at ${path}`);
    const expected = Buffer.from(managedSkillContent(generateContent(agent, surface, transport)), 'utf-8');
    if (!readFileSync(path).equals(expected)) throw new Error(`Installed skill failed ownership verification at ${path}`);
    return;
  }
  if (surface === "hook") {
    if (!hasCodexHooks(path)) throw new Error(`Installed hook is missing at ${path}`);
    return;
  }
  if (surface === "rules") {
    if (!existsSync(path)) throw new Error(`Installed rules are missing at ${path}`);
    if (!hasManagedBlock(readFileSync(path, "utf-8"))) throw new Error(`Installed rules failed ownership verification at ${path}`);
    return;
  }
  if (!existsSync(path)) throw new Error(`Installed MCP configuration is missing at ${path}`);
  const config = readJsonObject(path);
  if (!isOwnedMcpEntry(config.mcpServers && (config.mcpServers as Record<string, unknown>).lcm)) {
    throw new Error(`Installed MCP entry failed ownership verification at ${path}`);
  }
}

function removeSurface(agent: Agent, surface: ConnectorSurface, cwd: string, runner?: CodexMcpRunner, strictSkill = false): boolean {
  if (surface === "mcp" && agent.id === "codex") return removeCodexMcp(runner!);
  if (surface === "mcp") {
    const path = surfacePath(agent, surface, cwd);
    return path ? removeMcpJson(path, true) : false;
  }
  return removeComponent(agent, surface, cwd, strictSkill);
}

function restoreTransportChoice(configFile: string, agentId: string, prior: ConnectorTransport | undefined): void {
  if (prior === undefined) clearConnectorTransport(configFile, agentId);
  else setConnectorTransport(configFile, agentId, prior);
}

function installTransportBundle(
  agent: Agent,
  transport: ConnectorTransport,
  cwd: string,
  options: ConnectorInstallerOptions,
  resolutionSource: "explicit" | "stored" | "default",
): InstallResult {
  const configFile = options.configPath ?? defaultConfigPath();
  const targetSurfaces = bundleSurfaces(agent, transport);
  const priorTransport = readConnectorTransport(configFile, agent.id);
  const paths = allOwnedPaths(agent, cwd);
  const snapshots = snapshotOwnedFiles(paths);
  const codexMcpTouched = agent.id === "codex" && (
    targetSurfaces.includes("mcp")
    || options.queryCodexMcp === true
    || resolutionSource !== "default"
  );
  const runner = codexMcpTouched
    ? (options.codexCliRunner
      ? defaultCodexMcpRunner(cwd, options.codexCliRunner)
      : options.codexMcpRunner ?? defaultCodexMcpRunner(cwd))
    : undefined;
  const priorCodexMcp = runner ? structuredClone(runner.get()) : undefined;
  const configSnapshot = snapshotOwnedFiles([configFile]);
  let filesMutated = false;
  let configMutated = false;
  let codexMcpMutationAttempted = false;
  let codexMcpMutated = false;
  try {
    phase(options, "snapshot");
    phase(options, "stage");
    for (const surface of targetSurfaces) {
      if (surface === "skill") {
        const skillPath = surfacePath(agent, surface, cwd);
        preflightSkill(skillPath!, generateContent(agent, surface, transport));
      }
    }
    const staged: InstallResult[] = [];
    for (const surface of targetSurfaces) {
      if (surface === "mcp" && agent.id === "codex") {
        codexMcpMutationAttempted = true;
        codexMcpMutated = installCodexMcp(runner!);
        staged.push({ success: true, path: "", requiresRestart: true });
      } else {
        staged.push(installComponent(agent, surface, cwd, true, transport));
        filesMutated ||= !fileSnapshotsEqual(snapshots, snapshotOwnedFiles(paths));
      }
    }

    phase(options, "verify");
    for (const surface of targetSurfaces) verifySurface(agent, surface, cwd, runner, transport);

    phase(options, "remove-superseded");
    for (const surface of CONNECTOR_SURFACES) {
      if (targetSurfaces.includes(surface)) continue;
      if (surface === "mcp" && agent.id === "codex" && !codexMcpTouched) continue;
      if (surface === "mcp" && agent.id === "codex") codexMcpMutationAttempted = true;
      const removed = removeSurface(agent, surface, cwd, runner, true);
      if (surface === "mcp" && agent.id === "codex") codexMcpMutated ||= removed;
      else filesMutated ||= !fileSnapshotsEqual(snapshots, snapshotOwnedFiles(paths));
    }

    const persistTransport = options.persistTransport ?? resolutionSource === "explicit";
    if (persistTransport) {
      phase(options, "persist");
      setConnectorTransport(configFile, agent.id, transport);
      configMutated ||= !fileSnapshotsEqual(configSnapshot, snapshotOwnedFiles([configFile]));
    }
    phase(options, "complete");
    const resultPaths = staged.map((result) => result.path).filter((path) => path.length > 0);
    return {
      success: staged.every((result) => result.success),
      path: resultPaths.join(", "),
      paths: resultPaths,
      requiresRestart: staged.some((result) => result.requiresRestart),
      manual: staged.map((result) => result.manual).filter((manual): manual is string => Boolean(manual)).join("\n\n") || undefined,
      transport,
    };
  } catch (error) {
    const failures: string[] = [];
    filesMutated ||= !fileSnapshotsEqual(snapshots, snapshotOwnedFiles(paths));
    configMutated ||= !fileSnapshotsEqual(configSnapshot, snapshotOwnedFiles([configFile]));
    if (runner && priorCodexMcp && codexMcpMutationAttempted) {
      try {
        codexMcpMutated ||= !codexMcpEntriesEqual(runner.get(), priorCodexMcp);
      } catch (readbackError) {
        codexMcpMutated = true;
        failures.push(`Codex MCP state readback: ${String(readbackError)}`);
      }
    }
    if (filesMutated) {
      try {
        restoreOwnedFiles(snapshots);
        if (!fileSnapshotsEqual(snapshots, snapshotOwnedFiles(paths))) throw new Error("owned state compensation readback mismatch");
      } catch (restoreError) { failures.push(`owned state: ${String(restoreError)}`); }
    }
    if (runner && priorCodexMcp && codexMcpMutated) {
      try { compensateCodexMcp(runner, priorCodexMcp); } catch (restoreError) { failures.push(`Codex MCP state: ${String(restoreError)}`); }
    }
    if (configMutated) {
      try {
        restoreTransportChoice(configFile, agent.id, priorTransport);
        if (readConnectorTransport(configFile, agent.id) !== priorTransport) throw new Error("transport config compensation readback mismatch");
      } catch (restoreError) { failures.push(`transport config: ${String(restoreError)}`); }
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(failures.length > 0 ? `${detail}; rollback incomplete (${failures.join("; ")})` : detail, { cause: error });
  }
}

function parseInstallerArguments(
  cwdOrOptions: string | ConnectorInstallerOptions | undefined,
  options: ConnectorInstallerOptions | undefined,
): { cwd: string; options: ConnectorInstallerOptions; optionsSupplied: boolean } {
  if (typeof cwdOrOptions === "object" && cwdOrOptions !== null) {
    return { cwd: cwdOrOptions.cwd ?? process.cwd(), options: cwdOrOptions, optionsSupplied: true };
  }
  return { cwd: cwdOrOptions ?? process.cwd(), options: options ?? {}, optionsSupplied: options !== undefined };
}

/** Install one transport bundle. Component surfaces remain available only for legacy direct callers. */
export function installConnector(
  agentIdOrName: string,
  transportOrSurface?: ConnectorTransport | ConnectorSurface,
  cwdOrOptions?: string | ConnectorInstallerOptions,
  options?: ConnectorInstallerOptions,
): InstallResult {
  const agent = findAgent(agentIdOrName);
  if (!agent) throw new Error(`Unknown agent: ${agentIdOrName}`);
  const parsed = parseInstallerArguments(cwdOrOptions, options);
  const isNewTransportCall = transportOrSurface === "cli" || parsed.optionsSupplied;
  if (!isNewTransportCall) {
    if (transportOrSurface === undefined) return installLegacyDefault(agent, parsed.cwd);
    return installComponent(agent, transportOrSurface, parsed.cwd);
  }
  if (transportOrSurface !== undefined && transportOrSurface !== "cli" && transportOrSurface !== "mcp") {
    throw new Error(`Unsupported connector transport ${JSON.stringify(transportOrSurface)}; choose cli or mcp`);
  }
  const resolved = resolveAgentTransport(
    agent.id,
    transportOrSurface === undefined ? undefined : transportOrSurface as ConnectorTransport,
    { configPath: parsed.options.configPath },
  );
  return installTransportBundle(agent, resolved.transport, parsed.cwd, parsed.options, resolved.source);
}

function removeTransportBundle(agent: Agent, cwd: string, options: ConnectorInstallerOptions): RemoveResult {
  const configFile = options.configPath ?? defaultConfigPath();
  const failures: string[] = [];
  const paths: string[] = allOwnedPaths(agent, cwd);
  let removed = false;
  const codexMcp = agent.id === "codex"
    ? (options.codexCliRunner
      ? defaultCodexMcpRunner(cwd, options.codexCliRunner)
      : options.codexMcpRunner ?? defaultCodexMcpRunner(cwd))
    : undefined;
  for (const surface of ["hook", "skill", "rules", "mcp"] as const) {
    try {
      removed = removeSurface(agent, surface, cwd, codexMcp, true) || removed;
    } catch (error) {
      failures.push(`${surface}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length === 0) {
    try { clearConnectorTransport(configFile, agent.id); } catch (error) {
      failures.push(`transport config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { success: failures.length === 0, removed, paths, failures };
}

/** Remove a complete transport bundle; legacy component calls return a boolean for compatibility. */
export function removeConnector(
  agentIdOrName: string,
  cwdOrSurface?: string | ConnectorSurface | ConnectorInstallerOptions,
  cwdOrOptions?: string | ConnectorInstallerOptions,
): boolean | RemoveResult {
  const agent = findAgent(agentIdOrName);
  if (!agent) throw new Error(`Unknown agent: ${agentIdOrName}`);
  if (isConnectorSurface(cwdOrSurface)) {
    return removeComponent(agent, cwdOrSurface, typeof cwdOrOptions === "string" ? cwdOrOptions : process.cwd());
  }
  if (cwdOrSurface === undefined && typeof cwdOrOptions === "string") return removeLegacyDefault(agent, cwdOrOptions);
  const parsed = parseInstallerArguments(cwdOrSurface, typeof cwdOrOptions === "object" ? cwdOrOptions : undefined);
  return removeTransportBundle(agent, parsed.cwd, parsed.options);
}

export function listConnectors(cwd: string = process.cwd()): InstalledConnector[] {
  const installed: InstalledConnector[] = [];
  const claudeHookTransports = claudeHookTransportsForInventory();

  for (const agent of AGENTS) {
    for (const type of CONNECTOR_SURFACES) {
      const configPath = agent.configPaths[type];
      if (!configPath) continue;

      const resolvedPath = resolveConfigPath(configPath, cwd);

      if (type === 'mcp') {
        if (resolvedPath.endsWith('.toml')) continue; // Skip TOML files
        if (existsSync(resolvedPath)) {
          try {
            const config = JSON.parse(readFileSync(resolvedPath, 'utf-8'));
            if (isOwnedMcpEntry(config.mcpServers?.lcm)) {
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
        if (hasClaudeHooks(resolvedPath, claudeHookTransports)) {
          installed.push({ agentId: agent.id, agentName: agent.name, type, path: resolvedPath });
        }
      } else if (type === 'skill') {
        const skillPath = join(resolvedPath, 'lcm-memory', 'SKILL.md');
        if (existsSync(skillPath) && (() => {
          try {
            return lstatSync(skillPath).isFile() && isOwnedSkill(readFileSync(skillPath), [
              generateContent(agent, type, "cli"),
              generateContent(agent, type, "mcp"),
            ]);
          } catch {
            return false;
          }
        })()) {
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

function inspectCodexMcp(runner: CodexMcpRunner): CodexMcpInspection {
  try {
    const entries = runner.get();
    const entry = findCodexLcmEntry(entries);
    if (!entry && entries.length === 0) return { state: "absent" };
    if (entry && isCanonicalCodexMcpEntry(entry)) return { state: "installed" };
    return { state: "unknown", reason: "collision" };
  } catch (error) {
    if (error instanceof Error && error.message.includes("malformed")) {
      return { state: "unknown", reason: "collision" };
    }
    return { state: "unknown", reason: "unavailable" };
  }
}

/**
 * Inspect connector surfaces and native Codex MCP state without reading or
 * writing Codex TOML. The native check is intentionally one bounded `get`
 * operation through the supplied seam.
 */
export function listConnectorInventory(
  cwd: string = process.cwd(),
  options: ConnectorInventoryOptions = {},
): ConnectorInventory {
  // listConnectors intentionally skips Codex's TOML path; native Codex MCP
  // is inspected separately below, so no surface filtering is necessary.
  const installed = listConnectors(cwd);
  const runner = options.codexMcpRunner ?? defaultCodexMcpRunner(cwd, options.codexCliRunner);
  const codexMcp = inspectCodexMcp(runner);
  if (codexMcp.state === "installed") {
    const codex = AGENTS.find((agent) => agent.id === "codex");
    if (codex) installed.push({ agentId: codex.id, agentName: codex.name, type: "mcp", path: "codex mcp" });
  }
  return { installed, codexMcp };
}
