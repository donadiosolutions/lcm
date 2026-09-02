import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readSync,
  readlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, relative, basename, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { Agent, ConnectorSurface, ConnectorTransport } from "./types.js";
import { CONNECTOR_SURFACES } from "./types.js";
import { LCM_HISTORICAL_SKILL_SHA256, LCM_MANAGED_SKILL_MARKER, LCM_MARKERS } from "./constants.js";
import { generateContent } from "./template-service.js";
import { findAgent, AGENTS, resolveAgentTransport } from "./registry.js";
import {
  CODEX_CONFIG_PATH,
  LEGACY_CODEX_HOOKS_PATHS,
  hasCodexHooksContent,
  mergeCodexHooksContent,
  removeCodexHooksContent,
  setCodexHooksFeature,
  captureConnectorLeaf,
  mutateConnectorLeaf,
  compensateConnectorLeaf,
  finalizeConnectorLeaf,
  type ConnectorLeafDecision,
  type ConnectorLeafReceipt,
  type ConnectorLeafState,
  type ConnectorLeafMutationResult,
} from "./codex-hooks.js";
import {
  canonicalHookCommand,
  hasCanonicalClaudeMcpEntry,
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
  const body = content.slice(start.lineEnd, end.lineStart);
  return /^# Workflow Instruction(?:\r\n|\n|\r|$)/u.test(body)
    || /^\*\*Before starting any substantive kind of work\*\* or when needing to gather further project understanding, \*\*use the \$lcm-memory skill\*\*\.(?:\r\n|\n|\r)?$/u.test(body)
    || /^\*\*Before doing any kind of work\*\*, inspection or simply project understanding, \*\*use the \$lcm-memory skill\*\* to recover project memories\.(?:\r\n|\n|\r)?$/u.test(body);
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

function appendMarkdown(existing: string, content: string, blankLineBeforeManagedBlock = false): string {
  const cleaned = removeMarkers(existing);
  const eol = establishedMarkdownEol(cleaned, content);
  const normalizedExisting = normalizeMarkdownLineEndings(trimMarkdownLineBreaksAtEnd(cleaned), eol);
  const normalizedContent = normalizeMarkdownEof(content, eol);
  if (!normalizedExisting) return normalizedContent;
  const separator = blankLineBeforeManagedBlock ? `${eol}${eol}` : eol;
  return `${normalizedExisting}${separator}${normalizedContent}`;
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
  if (content.length === 0) return true;
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

const NO_FOLLOW_FLAGS = constants.O_NOFOLLOW | constants.O_NONBLOCK;

type MutationTargetSpec = Readonly<{
  displayPath: string;
  rootPath: string;
  allowCreate: boolean;
}>;

type RootHandle = Readonly<{ rootPath: string; canonicalPath: string; fd: number }>;

type AbsentOwnedFileSnapshot = Readonly<{ path: string; state: "absent" }>;
type NonFileOwnedFileSnapshot = Readonly<{ path: string; state: "non-file" }>;
type RegularOwnedFileSnapshot = Readonly<{
  path: string;
  state: "regular";
  content: Buffer;
  mode: number;
  dev: number | bigint;
  ino: number | bigint;
}>;
type OwnedFileSnapshot = AbsentOwnedFileSnapshot | NonFileOwnedFileSnapshot | RegularOwnedFileSnapshot;

/**
 * Linux-only authority for connector mutations. Descendants are addressed
 * through retained directory descriptors in /proc; ordinary display paths
 * remain separate so diagnostics never expose the operation pathname.
 */
class ConnectorMutationAuthority {
  private readonly roots = new Map<string, RootHandle>();
  private readonly operations = new Map<string, string>();
  private readonly parentOperations = new Map<string, string>();
  private readonly procDisplays = new Map<string, string>();
  private readonly absent = new Set<string>();
  private readonly descriptors: number[] = [];
  readonly snapshots = new Map<string, OwnedFileSnapshot>();
  readonly receipts = new Map<string, ConnectorLeafReceipt>();
  private readonly mutationOrder: string[] = [];

  constructor(targets: readonly MutationTargetSpec[]) {
    try {
      this.requireSupport();
      const unique = [...new Map(targets.map((target) => [target.displayPath, target])).values()];
      for (const target of unique) this.preflightTarget(target);
      for (const target of unique) this.prepareTarget(target);
    } catch (error) {
      const sanitized = this.displayError(error);
      this.close();
      throw sanitized;
    }
  }

  private requireSupport(): void {
    for (const flag of [constants.O_DIRECTORY, constants.O_NOFOLLOW, constants.O_NONBLOCK]) {
      if (typeof flag !== "number" || !Number.isSafeInteger(flag)) {
        throw new Error("Connector filesystem mutation requires strict Linux open flags");
      }
    }
  }

  private recordProcDisplay(operationPath: string, displayPath: string): void {
    this.procDisplays.set(operationPath, displayPath);
  }

  private withDisplay(error: unknown, displayPath: string): Error {
    const sanitized = this.displayError(error).message;
    const message = sanitized.includes(displayPath) ? sanitized : `${sanitized} at ${displayPath}`;
    const wrapped = new Error(message);
    const code = (error as NodeJS.ErrnoException)?.code;
    if (typeof code === "string") Object.assign(wrapped, { code });
    return wrapped;
  }

  private root(rootPath: string, displayPath: string): RootHandle {
    const existing = this.roots.get(rootPath);
    if (existing) return existing;
    let canonicalPath: string;
    let fd: number;
    try {
      canonicalPath = realpathSync(rootPath);
      fd = openSync(canonicalPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      const wrapped = this.withDisplay(error, displayPath);
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") Object.assign(wrapped, { rootMissing: true });
      throw wrapped;
    }
    try {
      this.recordProcDisplay(`/proc/self/fd/${fd}`, rootPath);
      const descriptorTarget = readlinkSync(`/proc/self/fd/${fd}`);
      if (typeof descriptorTarget !== "string" || descriptorTarget.length === 0) {
        throw new Error("empty proc descriptor target");
      }
      const descriptorStatsValue = fstatSync(fd);
      if (!descriptorStatsValue.isDirectory()) throw new Error(`Connector root is not a directory: ${rootPath}`);
      const pathStats = lstatSync(canonicalPath);
      if (!pathStats.isDirectory() || pathStats.dev !== descriptorStatsValue.dev || pathStats.ino !== descriptorStatsValue.ino) {
        throw new Error(`Connector root identity changed: ${rootPath}`);
      }
      if (realpathSync(rootPath) !== canonicalPath) throw new Error(`Connector root resolution changed: ${rootPath}`);
      const handle = { rootPath, canonicalPath, fd };
      this.roots.set(rootPath, handle);
      this.descriptors.push(fd);
      return handle;
    } catch (error) {
      closeSync(fd);
      throw this.withDisplay(error, displayPath);
    }
  }

  private components(target: MutationTargetSpec): { root: RootHandle; parts: string[] } | undefined {
    let root: RootHandle;
    try {
      root = this.root(target.rootPath, target.displayPath);
    } catch (error) {
      if (!target.allowCreate
        && (error as NodeJS.ErrnoException).code === "ENOENT"
        && (error as { rootMissing?: boolean }).rootMissing === true) {
        this.absent.add(target.displayPath);
        return undefined;
      }
      throw error;
    }
    const raw = relative(target.rootPath, target.displayPath);
    if (isAbsolute(raw) || raw.length === 0 || raw === ".") {
      throw new Error(`Refusing unsafe connector registry path ${target.displayPath}`);
    }
    const parts = raw.split(/[\\/]/u);
    if (parts.some((part) => part.length === 0 || part === "." || part === "..") || parts.includes("")) {
      throw new Error(`Refusing unsafe connector registry path ${target.displayPath}`);
    }
    return { root, parts };
  }

  private childPath(fd: number, component: string, displayPath: string): string {
    const path = `/proc/self/fd/${fd}/${component}`;
    this.recordProcDisplay(`/proc/self/fd/${fd}`, dirname(displayPath));
    this.recordProcDisplay(path, displayPath);
    try {
      const target = readlinkSync(`/proc/self/fd/${fd}`);
      if (typeof target !== "string" || target.length === 0) throw new Error("empty proc descriptor target");
    } catch (error) {
      throw this.withDisplay(new Error("Connector proc descendant lookup is unavailable", { cause: error }), displayPath);
    }
    return path;
  }

  private openDirectory(path: string, displayPath: string): number {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "ENOTDIR" || code === "EISDIR") {
        throw this.withDisplay(new Error(`Refusing unsafe connector parent ${displayPath}`, { cause: error }), displayPath);
      }
      throw this.withDisplay(error, displayPath);
    }
    try {
      const descriptorStatsValue = fstatSync(fd);
      if (!descriptorStatsValue.isDirectory()) throw new Error(`Connector parent is not a directory: ${displayPath}`);
      const pathStats = lstatSync(path);
      if (!pathStats.isDirectory() || pathStats.dev !== descriptorStatsValue.dev || pathStats.ino !== descriptorStatsValue.ino) {
        throw new Error(`Connector parent identity changed: ${displayPath}`);
      }
      return fd;
    } catch (error) {
      closeSync(fd);
      throw this.withDisplay(error, displayPath);
    }
  }

  private preflightTarget(target: MutationTargetSpec): void {
    const components = this.components(target);
    if (!components) return;
    const { root, parts } = components;
    let fd = root.fd;
    const temporary: number[] = [];
    try {
      for (let index = 0; index < parts.length - 1; index += 1) {
        const component = parts[index];
        const path = this.childPath(fd, component, target.displayPath);
        try {
          const next = this.openDirectory(path, target.displayPath);
          temporary.push(next);
          fd = next;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            if (!target.allowCreate) this.absent.add(target.displayPath);
            return;
          }
          throw error;
        }
      }
      // Leaf ownership and no-follow checks remain in each content operation;
      // parent authority is established here before any surface can mutate.
    } finally {
      for (let index = temporary.length - 1; index >= 0; index -= 1) closeSync(temporary[index]);
    }
  }

  private prepareTarget(target: MutationTargetSpec): void {
    const components = this.components(target);
    if (!components || this.absent.has(target.displayPath)) return;
    const { root, parts } = components;
    let fd = root.fd;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const component = parts[index];
      const path = this.childPath(fd, component, target.displayPath);
      try {
        const next = this.openDirectory(path, target.displayPath);
        this.descriptors.push(next);
        fd = next;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!target.allowCreate) {
          this.absent.add(target.displayPath);
          return;
        }
        try {
          mkdirSync(path, { mode: 0o755 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw this.withDisplay(mkdirError, target.displayPath);
        }
        const next = this.openDirectory(path, target.displayPath);
        this.descriptors.push(next);
        fd = next;
      }
    }
    const leaf = parts.at(-1)!;
    this.operations.set(target.displayPath, this.childPath(fd, leaf, target.displayPath));
    this.parentOperations.set(target.displayPath, `/proc/self/fd/${fd}`);
  }

  operationPath(displayPath: string): string {
    const operation = this.operations.get(displayPath);
    if (this.absent.has(displayPath)) {
      throw Object.assign(new Error(`Connector mutation target is absent: ${displayPath}`), { code: "ENOENT" });
    }
    if (!operation) throw new Error(`Unmapped connector mutation target ${displayPath}`);
    return operation;
  }

  hasTarget(displayPath: string): boolean {
    return this.operations.has(displayPath);
  }

  private recordReceipt(displayPath: string, receipt: ConnectorLeafReceipt): void {
    if (!this.receipts.has(displayPath)) this.mutationOrder.push(displayPath);
    this.receipts.set(displayPath, receipt);
  }

  mutate(displayPath: string, decide: (base: ConnectorLeafState) => ConnectorLeafDecision): ConnectorLeafMutationResult {
    const operationPath = this.operationPath(displayPath);
    const parentOperationPath = this.parentOperations.get(displayPath);
    if (!parentOperationPath) throw new Error(`Unmapped connector mutation parent ${displayPath}`);
    const prior = this.receipts.get(displayPath);
    const expected = prior?.current ?? (() => {
      const snapshot = this.snapshots.get(displayPath);
      if (!snapshot || snapshot.state === "non-file") throw skillCollision(displayPath);
      return snapshot.state === "absent" ? { state: "absent" as const } : snapshot;
    })();
    let result: ConnectorLeafMutationResult;
    try {
      result = mutateConnectorLeaf({
        displayPath,
        operationPath,
        parentOperationPath,
        expected,
        decide,
      }, prior);
    } catch (error) {
      const receipt = (error as Error & { connectorLeafReceipt?: ConnectorLeafReceipt }).connectorLeafReceipt;
      if (receipt?.mutationCommitted) this.recordReceipt(displayPath, receipt);
      throw error;
    }
    if (result.changed) this.recordReceipt(displayPath, result.receipt);
    return result;
  }

  registerSnapshots(snapshots: readonly OwnedFileSnapshot[]): void {
    for (const snapshot of snapshots) this.snapshots.set(snapshot.path, snapshot);
  }

  hasMutations(): boolean {
    return this.receipts.size > 0;
  }

  compensateOwnedFiles(): string[] {
    const failures: string[] = [];
    const compensated: ConnectorLeafReceipt[] = [];
    for (const path of [...this.mutationOrder].reverse()) {
      const receipt = this.receipts.get(path);
      if (!receipt) continue;
      const receiptFailures = compensateConnectorLeaf(receipt);
      if (receiptFailures.length > 0) failures.push(...receiptFailures);
      else compensated.push(receipt);
    }
    for (const receipt of compensated) {
      const cleanupFailures = finalizeConnectorLeaf(receipt);
      failures.push(...cleanupFailures.map((failure) => `compensated receipt finalization: ${failure}`));
    }
    return failures;
  }

  finalizeOwnedFiles(): string[] {
    const failures: string[] = [];
    for (const path of this.mutationOrder) {
      const receipt = this.receipts.get(path);
      if (receipt) failures.push(...finalizeConnectorLeaf(receipt));
    }
    return failures;
  }

  displayError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    let sanitized = message;
    const mappings = new Map(this.procDisplays);
    for (const [displayPath, operationPath] of this.operations) mappings.set(operationPath, displayPath);
    for (const [operationPath, displayPath] of [...mappings.entries()].sort(([left], [right]) => right.length - left.length)) {
      sanitized = sanitized.replaceAll(operationPath, displayPath);
    }
    if (!(error instanceof Error)) return new Error(sanitized);
    const wrapped = new Error(sanitized);
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string") Object.assign(wrapped, { code });
    return wrapped;
  }

  close(): void {
    for (let index = this.descriptors.length - 1; index >= 0; index -= 1) {
      try { closeSync(this.descriptors[index]); } catch { /* preserve primary failure */ }
    }
    this.descriptors.length = 0;
  }
}

let activeMutationAuthority: ConnectorMutationAuthority | undefined;

function ioPath(displayPath: string): string {
  if (!activeMutationAuthority) return displayPath;
  return activeMutationAuthority.operationPath(displayPath);
}

function withMutationAuthority<T>(targets: readonly MutationTargetSpec[], callback: () => T): T {
  if (targets.length === 0) return callback();
  const authority = new ConnectorMutationAuthority(targets);
  const prior = activeMutationAuthority;
  activeMutationAuthority = authority;
  try {
    const result = callback();
    const cleanupFailures = authority.finalizeOwnedFiles();
    if (cleanupFailures.length > 0) throw new Error(`connector cleanup incomplete (${cleanupFailures.join("; ")})`);
    return result;
  } catch (error) {
    throw authority.displayError(error);
  } finally {
    activeMutationAuthority = prior;
    authority.close();
  }
}

function openNoFollow(filePath: string, flags: number): number {
  const safeFlags = flags | NO_FOLLOW_FLAGS;
  return openSync(ioPath(filePath), safeFlags);
}

function openNoFollowUnmapped(filePath: string, flags: number): number {
  const safeFlags = flags | NO_FOLLOW_FLAGS;
  return openSync(filePath, safeFlags);
}

function descriptorStats(descriptor: number, filePath: string): ReturnType<typeof fstatSync> {
  const stats = fstatSync(descriptor);
  if (!stats.isFile()) throw skillCollision(filePath);
  return stats;
}

function readDescriptor(descriptor: number, filePath: string): Buffer {
  const stats = descriptorStats(descriptor, filePath);
  const size = Number(stats.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Unable to read LCM file at ${filePath}: invalid file size`);
  }
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const bytesRead = readSync(descriptor, content, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === size ? content : content.subarray(0, offset);
}

function readRegularFileNoFollow(filePath: string): Buffer {
  const descriptor = openNoFollow(filePath, constants.O_RDONLY);
  try {
    return readDescriptor(descriptor, filePath);
  } finally {
    closeSync(descriptor);
  }
}

function readOptionalRegularFileNoFollow(filePath: string): Buffer | undefined {
  try {
    return readRegularFileNoFollow(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function updateRegularFileNoFollow(
  filePath: string,
  update: (existing: Buffer, created: boolean) => Buffer | undefined,
  mode = 0o666,
  create = true,
): Buffer {
  const snapshot = activeMutationAuthority!.snapshots?.get(filePath);
  if (!create && snapshot?.state === "absent" && !activeMutationAuthority!.receipts?.has(filePath)) {
    throw Object.assign(new Error(`Connector mutation target is absent: ${filePath}`), { code: "ENOENT" });
  }
  let resultContent: Buffer | undefined;
  const result = activeMutationAuthority!.mutate(filePath, (base) => {
    const existing = base.state === "regular" ? Buffer.from(base.content) : Buffer.alloc(0);
    const updated = update(existing, base.state === "absent");
    resultContent = updated ? Buffer.from(updated) : existing;
    if (updated === undefined) return { state: "unchanged" };
    return { state: "regular", content: Buffer.from(updated), mode: base.state === "regular" ? base.mode : mode };
  });
  return resultContent ?? result.content ?? Buffer.alloc(0);
}

function preflightSkill(filePath: string, generated: string): void {
  let existing: Buffer | undefined;
  try {
    existing = readOptionalRegularFileNoFollow(filePath);
  } catch (error) {
    if (["ELOOP", "EISDIR", "ENOTDIR", "ENOENT", "EAGAIN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw skillCollision(filePath);
    }
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`Unable to inspect LCM skill at ${filePath}${typeof code === "string" ? `: ${code}` : ""}`, { cause: error });
  }
  if (existing === undefined) return;
  if (!isOwnedSkill(existing, generated)) throw skillCollision(filePath);
}

function installSkill(content: string, filePath: string): void {
  preflightSkill(filePath, content);
  const expected = Buffer.from(managedSkillContent(content), 'utf-8');
  try {
    activeMutationAuthority!.mutate(filePath, (base) => {
      if (base.state === "regular") {
        if (!isOwnedSkill(base.content, content)) throw skillCollision(filePath);
        if (base.content.equals(expected)) return { state: "unchanged" };
        return { state: "regular", content: expected, mode: base.mode };
      }
      return { state: "regular", content: expected, mode: 0o666 };
    });
  } catch (error) {
    if (["ELOOP", "EISDIR", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw skillCollision(filePath);
    }
    throw error;
  }
}

function removeSkill(filePath: string, generated: string | readonly string[], strict = false): boolean {
  try {
    const snapshot = activeMutationAuthority!.snapshots?.get(filePath);
    if (!snapshot || snapshot.state === "absent") return false;
    const result = activeMutationAuthority!.mutate(filePath, (base) => {
      if (base.state !== "regular" || base.content.length === 0) return { state: "unchanged" };
      if (!isOwnedSkill(base.content, generated)) {
        if (strict) throw new Error(`Refusing to remove an unowned LCM skill at ${filePath}`);
        return { state: "unchanged" };
      }
      return { state: "absent" };
    });
    return result.changed;
  } catch (error) {
    if (!strict && (error as NodeJS.ErrnoException).code === "EAGAIN") return false;
    if (error instanceof Error && error.message.startsWith("Refusing to overwrite an unowned LCM skill")) {
      if (strict) throw error;
      return false;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (["ELOOP", "EISDIR", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      if (strict) throw skillCollision(filePath);
      return false;
    }
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`Unable to inspect LCM skill at ${filePath}${typeof code === "string" ? `: ${code}` : ""}`, { cause: error });
  }
}

// Strategy 1: Markdown targets (rules, skill)
function installMarkdown(
  content: string,
  filePath: string,
  writeMode: 'append' | 'overwrite',
  blankLineBeforeManagedBlock = false,
): void {
  if (writeMode === 'append') {
    updateRegularFileNoFollow(filePath, (existing) => (
      // Remove old markers if present before re-appending.
      Buffer.from(appendMarkdown(existing.toString('utf-8'), content, blankLineBeforeManagedBlock), 'utf-8')
    ));
  } else {
    updateRegularFileNoFollow(filePath, () => Buffer.from(normalizeMarkdownEof(content), 'utf-8'));
  }
}

// Strategy 2: Structured targets (MCP JSON)
function installMcpJson(filePath: string, strict = false): void {
  let changed = false;
  const verifiedBytes = updateRegularFileNoFollow(filePath, (existingBytes, created) => {
    let existing: Record<string, unknown> = {};
    if (!created && existingBytes.length > 0) {
      try {
        existing = parseJsonObject(filePath, existingBytes);
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
    if (isOwnedMcpEntry(mcpServers.lcm)) return undefined;
    mcpServers.lcm = { type: 'stdio', command: 'lcm', args: ['mcp'] };
    changed = true;
    return Buffer.from(JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  });
  if (!changed) return;
  parseJsonObject(filePath, verifiedBytes);
}

function removeMcpJson(filePath: string, strict = false): boolean {
  if (filePath.endsWith('.toml')) return false; // TOML removal not supported
  let removed = false;
  try {
    updateRegularFileNoFollow(filePath, (content) => {
      let config: unknown;
      try {
        config = JSON.parse(content.toString('utf-8'));
      } catch (error) {
        if (!strict) return undefined;
        throw new Error(`Unable to parse MCP configuration at ${filePath}`, { cause: error });
      }
      if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        if (strict) throw new Error(`${filePath} must contain a JSON object`);
        return undefined;
      }
      const root = config as Record<string, unknown>;
      const servers = root.mcpServers;
      if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
        if (strict) throw new Error(`${filePath}.mcpServers must contain a JSON object`);
        return undefined;
      }
      const lcm = (servers as Record<string, unknown> | undefined)?.lcm;
      if (lcm === undefined) return undefined;
      if (!isOwnedMcpEntry(lcm)) {
        if (strict) throw new Error(`Refusing to remove a non-LCM MCP entry named lcm in ${filePath}`);
        return undefined;
      }
      delete (servers as Record<string, unknown>).lcm;
      removed = true;
      return Buffer.from(JSON.stringify(root, null, 2) + '\n', 'utf-8');
    }, 0o666, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if (!strict && ((error as NodeJS.ErrnoException).code === "EAGAIN")) return false;
    throw error;
  }
  return removed;
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

function parseJsonObject(filePath: string, content: Buffer): Record<string, unknown> {
  const parsed: unknown = JSON.parse(content.toString("utf-8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function readJsonObject(filePath: string): Record<string, unknown> {
  return parseJsonObject(filePath, readRegularFileNoFollow(filePath));
}

function removeClaudeHooks(filePath: string, strict = false): boolean {
  let removed = false;
  try {
    updateRegularFileNoFollow(filePath, (content) => {
      const existing = parseJsonObject(filePath, content);
      const cleaned = removeManagedClaudeHooks(existing);
      if (JSON.stringify(existing) === JSON.stringify(cleaned)) return undefined;
      removed = true;
      return Buffer.from(JSON.stringify(cleaned, null, 2) + "\n", "utf-8");
    }, 0o666, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (!strict && ((error as NodeJS.ErrnoException).code === "EAGAIN")) return false;
    throw error;
  }
  return removed;
}

function removeClaudeNativeMcp(filePath: string): boolean {
  let removed = false;
  let verifiedBytes: Buffer;
  try {
    verifiedBytes = updateRegularFileNoFollow(filePath, (content) => {
      const settings = parseJsonObject(filePath, content);
      const servers = settings.mcpServers;
      if (servers === undefined) return undefined;
      if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
        throw new Error(`${filePath}.mcpServers must contain a JSON object`);
      }

      const mcpServers = servers as Record<string, unknown>;
      if (mcpServers.lcm === undefined) return undefined;
      const runtimePath = packageExecutable(import.meta.url, 3);
      if (!hasCanonicalClaudeMcpEntry(mcpServers.lcm, runtimePath, process.execPath, process.platform)) {
        throw new Error(`Refusing to remove a non-LCM native MCP entry named lcm in ${filePath}`);
      }

      delete mcpServers.lcm;
      if (Object.keys(mcpServers).length === 0) delete settings.mcpServers;
      removed = true;
      return Buffer.from(JSON.stringify(settings, null, 2) + "\n", "utf-8");
    }, 0o666, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!removed) return false;

  const verified = parseJsonObject(filePath, verifiedBytes);
  const servers = verified.mcpServers;
  if (servers !== undefined && servers !== null && typeof servers === "object" && !Array.isArray(servers)
      && (servers as Record<string, unknown>).lcm !== undefined) {
    throw new Error(`Claude native MCP entry remained after removal at ${filePath}`);
  }
  return true;
}

function hasClaudeHooks(filePath: string, transports: readonly ConnectorTransport[] = ["cli", "mcp"]): boolean {
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
  readonly add?: () => void;
  readonly remove?: () => void;
  restore?(entries: readonly CodexMcpEntry[]): void;
  readonly pathnameBased?: boolean;
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
      updateRegularFileNoFollow(configPath, (existing) => {
        const updated = setCodexHooksFeature(existing.toString("utf-8"));
        return updated === existing.toString("utf-8") ? undefined : Buffer.from(updated, "utf-8");
      });
      updateRegularFileNoFollow(hooksPath, (existing) => Buffer.from(mergeCodexHooksContent(existing.toString("utf-8"), transport), "utf-8"));
      for (const legacyPath of LEGACY_CODEX_HOOKS_PATHS.map((path) => resolveConfigPath(path, cwd))) {
        if (legacyPath !== hooksPath) {
          const legacyContent = readOptionalRegularFileNoFollow(legacyPath)?.toString("utf-8");
          if (legacyContent !== undefined) {
            const result = removeCodexHooksContent(legacyContent);
            if (result.state === "remove") {
              activeMutationAuthority!.mutate(legacyPath, (base) => base.state === "regular" ? { state: "absent" } : { state: "unchanged" });
            } else if (result.state === "rewrite") {
              updateRegularFileNoFollow(legacyPath, (existing) => {
                const next = removeCodexHooksContent(existing.toString("utf-8"));
                return next.state === "rewrite" ? Buffer.from(next.content, "utf-8") : undefined;
              }, 0o666, false);
            }
          }
        }
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

  installMarkdown(
    generateContent(agent, surface, transport),
    resolvedPath,
    agent.writeMode ?? "overwrite",
    agent.id === "codex",
  );
  return { success: true, path: resolvedPath, requiresRestart: surfaceRequiresRestart(surface) };
}

function removeComponent(agent: Agent, surface: ConnectorSurface, cwd: string, strictSkill = false): boolean {
  const configPath = agent.configPaths[surface];
  if (!configPath) return false;
  const resolvedPath = resolveConfigPath(configPath, cwd);
  if (surface === "hook" && agent.id === "codex") {
    const content = readOptionalRegularFileNoFollow(resolvedPath)?.toString("utf-8");
    if (content === undefined) return false;
    const result = removeCodexHooksContent(content);
    if (result.state === "unchanged") return false;
    try {
      const mutation = activeMutationAuthority!.mutate(resolvedPath, (base) => {
        if (base.state !== "regular") return { state: "unchanged" };
        const next = removeCodexHooksContent(base.content.toString("utf-8"));
        if (next.state === "unchanged") return { state: "unchanged" };
        if (next.state === "remove") return { state: "absent" };
        return { state: "regular", content: Buffer.from(next.content, "utf-8"), mode: base.mode };
      });
      return mutation.changed;
    } catch (error) {
      if (!strictSkill && (error as NodeJS.ErrnoException).code === "EAGAIN") return false;
      throw error;
    }
  }
  if (surface === "hook" && agent.id === "claude-code") return removeClaudeHooks(resolvedPath, strictSkill);
  if (surface === "mcp") return removeMcpJson(resolvedPath);
  if (surface === "skill") {
    const skillPath = join(resolvedPath, "lcm-memory", "SKILL.md");
    return removeSkill(skillPath, [
      generateContent(agent, surface, "cli"),
      generateContent(agent, surface, "mcp"),
    ], strictSkill);
  }

  try {
    const snapshot = activeMutationAuthority!.snapshots?.get(resolvedPath);
    if (!snapshot || snapshot.state === "absent") return false;
    const mutation = activeMutationAuthority!.mutate(resolvedPath, (base) => {
      if (base.state !== "regular") return { state: "unchanged" };
      const content = base.content.toString("utf-8");
      if (!hasManagedBlock(content)) return { state: "unchanged" };
      const cleaned = removeMarkers(content);
      const eol = establishedMarkdownEol(cleaned);
      const updated = cleaned === "" ? { state: "absent" as const } : { state: "regular" as const, content: Buffer.from(normalizeMarkdownEof(cleaned, eol), "utf-8"), mode: base.mode };
      return updated;
    });
    return mutation.changed;
  } catch (error) {
    if (strictSkill) throw error;
    return false;
  }
}

function legacyDefaultSurfaces(agent: Agent): readonly ConnectorSurface[] {
  if (agent.id === "codex") return ["hook", "skill", "rules"];
  if (["claude-code", "gemini-cli", "opencode", "warp", "auggie-cli", "cursor", "windsurf", "trae", "qoder", "antigravity", "github-copilot", "roo-code", "kilo-code", "amp", "kiro", "junie", "openclaw"].includes(agent.id)) {
    return [agent.configPaths.skill ? "skill" : "rules"];
  }
  return ["mcp"];
}

function installLegacyDefault(agent: Agent, cwd: string): InstallResult {
  const targets = legacyDefaultSurfaces(agent);
  const results = targets.map((surface) => installComponent(agent, surface, cwd, false, "cli"));
  for (const surface of targets) verifySurface(agent, surface, cwd, undefined, "cli");
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

function isCodexMcpAbsence(error: CodexCliCommandError): boolean {
  return typeof error.status === "number"
    && Number.isSafeInteger(error.status)
    && error.status > 0
    && (error.stderr === "No MCP server named 'lcm' found."
      || error.stderr === "Error: No MCP server named 'lcm' found.");
}

function defaultCodexMcpRunner(cwd: string, cliRunner: CodexCliRunner = defaultCodexCliRunner): CodexMcpRunner {
  const get = (): readonly CodexMcpEntry[] => {
    try {
      return normalizeCodexMcpEntries(parseCodexMcpJson(runNativeCodexMcp(cwd, ["mcp", "get", "lcm", "--json"], cliRunner)));
    } catch (error) {
      if (error instanceof CodexCliCommandError && isCodexMcpAbsence(error)) {
        return [];
      }
      throw error;
    }
  };
  return {
    get,
    pathnameBased: true,
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

function installCodexMcp(runner: CodexMcpRunner, preflighted: readonly CodexMcpEntry[]): boolean {
  const current = preflighted;
  const existing = findCodexLcmEntry(current);
  if (!existing) {
    if (!runner.add) throw new Error("Codex MCP mutation runner does not provide add");
    runner.add();
  }
  const verified = findCodexLcmEntry(runner.get());
  if (!verified || !isCanonicalCodexMcpEntry(verified)) throw new Error("Codex MCP lcm entry failed JSON readback verification");
  return !existing;
}

function preflightCodexMcpInstall(runner: CodexMcpRunner): readonly CodexMcpEntry[] {
  const current = runner.get();
  const existing = findCodexLcmEntry(current);
  if (existing && !isCanonicalCodexMcpEntry(existing)) {
    throw new Error("Refusing to overwrite an unverified Codex MCP entry named lcm");
  }
  if (!existing && runner.pathnameBased) {
    throw new Error("Automatic Codex MCP add is unavailable for pathname-based native state; add the lcm MCP server manually");
  }
  return current;
}

function preflightCodexMcpRemove(runner: CodexMcpRunner): void {
  const existing = findCodexLcmEntry(runner.get());
  if (!existing) return;
  if (!isCanonicalCodexMcpEntry(existing)) {
    throw new Error("Refusing to remove an unverified Codex MCP entry named lcm");
  }
  if (runner.pathnameBased) {
    throw new Error("Automatic Codex MCP removal is unavailable for pathname-based native state; remove the lcm MCP server manually");
  }
}

function removeCodexMcp(runner: CodexMcpRunner): boolean {
  const current = runner.get();
  const existing = findCodexLcmEntry(current);
  if (!existing) return false;
  if (!isCanonicalCodexMcpEntry(existing)) throw new Error("Refusing to remove an unverified Codex MCP entry named lcm");
  if (runner.pathnameBased) throw new Error("Automatic Codex MCP removal is unavailable for pathname-based native state; remove the lcm MCP server manually");
  if (!runner.remove) throw new Error("Codex MCP mutation runner does not provide remove");
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
      if (!runner.remove) throw new Error("Codex MCP mutation runner does not provide remove");
      runner.remove();
    }
    if (findCodexLcmEntry(prior)) {
      if (!runner.add) throw new Error("Codex MCP mutation runner does not provide add");
      runner.add();
    }
  }

  const restored = runner.get();
  if (!codexMcpEntriesEqual(restored, prior)) throw new Error("Codex MCP compensation readback mismatch");
}

function snapshotOwnedFiles(paths: readonly string[], anchored = true): OwnedFileSnapshot[] {
  const snapshots: OwnedFileSnapshot[] = [];
  for (const path of [...new Set(paths)]) {
    let descriptor: number;
    try {
      descriptor = anchored ? openNoFollow(path, constants.O_RDONLY) : openNoFollowUnmapped(path, constants.O_RDONLY);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        snapshots.push({ path, state: "absent" });
        continue;
      }
      if (["ELOOP", "EISDIR", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        snapshots.push({ path, state: "non-file" });
        continue;
      }
      throw error;
    }
    try {
      const stats = fstatSync(descriptor);
      if (!stats.isFile()) {
        snapshots.push({ path, state: "non-file" });
        continue;
      }
      snapshots.push({
        path,
        state: "regular",
        content: readDescriptor(descriptor, path),
        mode: Number(stats.mode) & 0o777,
        dev: stats.dev,
        ino: stats.ino,
      });
    } finally {
      closeSync(descriptor);
    }
  }
  return snapshots;
}

function fileSnapshotsEqual(left: readonly OwnedFileSnapshot[], right: readonly OwnedFileSnapshot[]): boolean {
  return left.length === right.length && left.every((snapshot, index) => {
    const other = right[index];
    if (!other || snapshot.path !== other.path || snapshot.state !== other.state) return false;
    if (snapshot.state !== "regular" || other.state !== "regular") return true;
    return snapshot.mode === other.mode
      && snapshot.dev === other.dev
      && snapshot.ino === other.ino
      && snapshot.content.length === other.content.length
      && snapshot.content.equals(other.content);
  });
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
  if (agent.id === "codex" && transport === "cli" && guidance !== "rules") surfaces.push("rules");
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

function mutationTargetSpecs(
  agent: Agent,
  cwd: string,
  surfaces: readonly ConnectorSurface[],
  allowCreate: boolean,
): MutationTargetSpec[] {
  const specs: MutationTargetSpec[] = [];
  for (const surface of surfaces) {
    const configPath = agent.configPaths[surface];
    if (!configPath) continue;
    const rawParts = configPath.split("/");
    const declarativeParts = rawParts.at(-1) === "" ? rawParts.slice(0, -1) : rawParts;
    if (configPath.startsWith("/") || declarativeParts.some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`Refusing unsafe connector registry path ${configPath}`);
    }
    const path = surfacePath(agent, surface, cwd);
    specs.push({ displayPath: path!, rootPath: configPath.startsWith("~/") ? homedir() : cwd, allowCreate });
    if (surface === "hook" && agent.id === "codex") {
      const config = resolveConfigPath(CODEX_CONFIG_PATH, cwd);
      specs.push({ displayPath: config, rootPath: homedir(), allowCreate });
      for (const legacy of LEGACY_CODEX_HOOKS_PATHS) {
        specs.push({ displayPath: resolveConfigPath(legacy, cwd), rootPath: cwd, allowCreate });
      }
    }
  }
  return specs;
}

function mutationTargetsForPaths(
  agent: Agent,
  cwd: string,
  surfaces: readonly ConnectorSurface[],
  allowCreate: boolean,
): readonly MutationTargetSpec[] {
  return mutationTargetSpecs(agent, cwd, surfaces, allowCreate);
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
    const expected = Buffer.from(managedSkillContent(generateContent(agent, surface, transport)), 'utf-8');
    let installed: Buffer | undefined;
    try { installed = readOptionalRegularFileNoFollow(path); } catch { installed = undefined; }
    if (installed === undefined) throw new Error(`Installed skill is missing at ${path}`);
    if (!installed.equals(expected)) throw new Error(`Installed skill failed ownership verification at ${path}`);
    return;
  }
  if (surface === "hook") {
    const installed = readOptionalRegularFileNoFollow(path);
    if (installed === undefined || !hasCodexHooksContent(installed.toString("utf-8"))) throw new Error(`Installed hook is missing at ${path}`);
    return;
  }
  if (surface === "rules") {
    const installed = readOptionalRegularFileNoFollow(path);
    if (installed === undefined) throw new Error(`Installed rules are missing at ${path}`);
    if (!hasManagedBlock(installed.toString("utf-8"))) throw new Error(`Installed rules failed ownership verification at ${path}`);
    return;
  }
  let config: Record<string, unknown>;
  try {
    config = readJsonObject(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Installed MCP configuration is missing at ${path}`);
    throw error;
  }
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
  activeMutationAuthority!.registerSnapshots(snapshots);
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
  const configSnapshot = snapshotOwnedFiles([configFile], false);
  let filesMutated = false;
  let configMutated = false;
  let codexMcpMutationAttempted = false;
  let codexMcpMutated = false;
  try {
    phase(options, "snapshot");
    let codexMcpPreflight: readonly CodexMcpEntry[] | undefined;
    if (runner && targetSurfaces.includes("mcp") && agent.id === "codex") codexMcpPreflight = preflightCodexMcpInstall(runner);
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
        codexMcpMutated = installCodexMcp(runner!, codexMcpPreflight!);
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
      configMutated ||= !fileSnapshotsEqual(configSnapshot, snapshotOwnedFiles([configFile], false));
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
    filesMutated ||= activeMutationAuthority!.hasMutations()
      || !fileSnapshotsEqual(snapshots, snapshotOwnedFiles(paths));
    configMutated ||= !fileSnapshotsEqual(configSnapshot, snapshotOwnedFiles([configFile], false));
    if (runner && priorCodexMcp && codexMcpMutationAttempted) {
      try {
        codexMcpMutated ||= !codexMcpEntriesEqual(runner.get(), priorCodexMcp);
      } catch (readbackError) {
        codexMcpMutated = true;
        failures.push(`Codex MCP state readback: ${activeMutationAuthority!.displayError(readbackError).message}`);
      }
    }
    if (filesMutated) {
      const ownedFailures = activeMutationAuthority!.compensateOwnedFiles();
      failures.push(...ownedFailures.map((failure) => `owned state: ${failure}`));
    }
    if (runner && priorCodexMcp && codexMcpMutated) {
      try { compensateCodexMcp(runner, priorCodexMcp); } catch (restoreError) {
        failures.push(`Codex MCP state: ${activeMutationAuthority!.displayError(restoreError).message}`);
      }
    }
    if (configMutated) {
      try {
        restoreTransportChoice(configFile, agent.id, priorTransport);
        if (readConnectorTransport(configFile, agent.id) !== priorTransport) throw new Error("transport config compensation readback mismatch");
      } catch (restoreError) {
        failures.push(`transport config: ${activeMutationAuthority!.displayError(restoreError).message}`);
      }
    }
    const detail = activeMutationAuthority!.displayError(error).message;
    throw new Error(failures.length > 0 ? `${detail}; rollback incomplete (${failures.join("; ")})` : detail);
  }
}

function withInstallAuthority<T>(agent: Agent, surfaces: readonly ConnectorSurface[], cwd: string, callback: () => T, createRoot = true): T {
  // Preserve the legacy ability to bootstrap a not-yet-created project cwd;
  // installs create only the selected root itself, while removal remains a
  // read-only no-op when the project root is absent.
  if (process.platform !== "linux") throw new Error("Connector filesystem mutation requires Linux proc-descriptor anchoring");
  if (!existsSync(cwd) && createRoot) mkdirSync(cwd);
  if (createRoot && !existsSync(homedir())) mkdirSync(homedir(), { recursive: true });
  const specs = mutationTargetsForPaths(agent, cwd, surfaces, createRoot);
  return withMutationAuthority(specs, () => {
    const snapshots = snapshotOwnedFiles(specs.map((spec) => spec.displayPath));
    activeMutationAuthority?.registerSnapshots(snapshots);
    return callback();
  });
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
    if (transportOrSurface === undefined) {
      const surfaces = legacyDefaultSurfaces(agent);
      return withInstallAuthority(agent, surfaces, parsed.cwd, () => installLegacyDefault(agent, parsed.cwd));
    }
    const surface = transportOrSurface;
    const configPath = agent.configPaths[surface];
    if ((surface === "mcp" && (!configPath || configPath.endsWith(".toml")))
      || (surface === "hook" && agent.id === "claude-code")) {
      return installComponent(agent, surface, parsed.cwd);
    }
    return withInstallAuthority(agent, [surface], parsed.cwd, () => installComponent(agent, surface, parsed.cwd));
  }
  if (transportOrSurface !== undefined && transportOrSurface !== "cli" && transportOrSurface !== "mcp") {
    throw new Error(`Unsupported connector transport ${JSON.stringify(transportOrSurface)}; choose cli or mcp`);
  }
  const resolved = resolveAgentTransport(
    agent.id,
    transportOrSurface === undefined ? undefined : transportOrSurface as ConnectorTransport,
    { configPath: parsed.options.configPath },
  );
  return withInstallAuthority(agent, CONNECTOR_SURFACES, parsed.cwd, () => (
    installTransportBundle(agent, resolved.transport, parsed.cwd, parsed.options, resolved.source)
  ));
}

function removeTransportBundle(agent: Agent, cwd: string, options: ConnectorInstallerOptions): RemoveResult {
  const configFile = options.configPath ?? defaultConfigPath();
  const failures: string[] = [];
  const failureMessage = (error: unknown): string => activeMutationAuthority!.displayError(error).message;
  const paths: string[] = allOwnedPaths(agent, cwd);
  const hadAnchoredTarget = paths.some((path) => activeMutationAuthority!.hasTarget(path));
  let removed = false;
  const codexMcp = agent.id === "codex"
    ? (options.codexCliRunner
      ? defaultCodexMcpRunner(cwd, options.codexCliRunner)
      : options.codexMcpRunner ?? defaultCodexMcpRunner(cwd))
    : undefined;
  if (codexMcp) {
    try { preflightCodexMcpRemove(codexMcp); } catch (error) {
      failures.push(`mcp: ${failureMessage(error)}`);
      return { success: false, removed: false, paths, failures };
    }
  }
  if (agent.id === "claude-code") {
    const settingsPath = surfacePath(agent, "hook", cwd);
    if (settingsPath) {
      try { removed = removeClaudeNativeMcp(settingsPath) || removed; } catch (error) {
        failures.push(`native-mcp: ${failureMessage(error)}`);
      }
    }
  }
  for (const surface of ["hook", "skill", "rules", "mcp"] as const) {
    try {
      removed = removeSurface(agent, surface, cwd, codexMcp, true) || removed;
    } catch (error) {
      failures.push(`${surface}: ${failureMessage(error)}`);
    }
  }
  if (failures.length === 0 && (removed || hadAnchoredTarget)) {
    try { clearConnectorTransport(configFile, agent.id); } catch (error) {
      failures.push(`transport config: ${failureMessage(error)}`);
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
    const cwd = typeof cwdOrOptions === "string" ? cwdOrOptions : process.cwd();
    const configPath = agent.configPaths[cwdOrSurface];
    if (cwdOrSurface === "mcp" && (!configPath || configPath.endsWith(".toml"))) {
      return removeComponent(agent, cwdOrSurface, cwd);
    }
    return withInstallAuthority(agent, [cwdOrSurface], cwd, () => removeComponent(agent, cwdOrSurface, cwd), false);
  }
  if (cwdOrSurface === undefined && typeof cwdOrOptions === "string") {
    return withInstallAuthority(agent, legacyDefaultSurfaces(agent), cwdOrOptions, () => removeLegacyDefault(agent, cwdOrOptions), false);
  }
  const parsed = parseInstallerArguments(cwdOrSurface, typeof cwdOrOptions === "object" ? cwdOrOptions : undefined);
  return withInstallAuthority(agent, CONNECTOR_SURFACES, parsed.cwd, () => removeTransportBundle(agent, parsed.cwd, parsed.options), false);
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
        try {
          const content = readOptionalRegularFileNoFollow(resolvedPath);
          if (content !== undefined) {
            const config = JSON.parse(content.toString('utf-8')) as Record<string, unknown>;
            const servers = config.mcpServers;
            if (servers && typeof servers === "object" && !Array.isArray(servers)
              && isOwnedMcpEntry((servers as Record<string, unknown>).lcm)) {
              installed.push({ agentId: agent.id, agentName: agent.name, type, path: resolvedPath });
            }
          }
        } catch {
          // ignore malformed JSON
        }
      } else if (type === 'hook' && agent.id === 'codex') {
        const content = readOptionalRegularFileNoFollow(resolvedPath);
        if (content !== undefined && hasCodexHooksContent(content.toString("utf-8"))) {
          installed.push({ agentId: agent.id, agentName: agent.name, type, path: resolvedPath });
        }
      } else if (type === 'hook' && agent.id === 'claude-code') {
        if (hasClaudeHooks(resolvedPath, claudeHookTransports)) {
          installed.push({ agentId: agent.id, agentName: agent.name, type, path: resolvedPath });
        }
      } else if (type === 'skill') {
        const skillPath = join(resolvedPath, 'lcm-memory', 'SKILL.md');
        try {
          const content = readOptionalRegularFileNoFollow(skillPath);
          if (content !== undefined && content.length > 0 && isOwnedSkill(content, [
            generateContent(agent, type, "cli"),
            generateContent(agent, type, "mcp"),
          ])) {
            installed.push({ agentId: agent.id, agentName: agent.name, type, path: skillPath });
          }
        } catch {
          // ignore malformed or unsafe skills
        }
      } else {
        // rules / hook
        try {
          const content = readOptionalRegularFileNoFollow(resolvedPath);
          if (content !== undefined && hasManagedBlock(content.toString('utf-8'))) {
            installed.push({ agentId: agent.id, agentName: agent.name, type, path: resolvedPath });
          }
        } catch {
          // ignore missing or malformed rules
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
