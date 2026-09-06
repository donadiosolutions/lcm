import { renderBackendDiagnostics } from "./storage/diagnostic-renderer.js";
import { readDiagnosticSqlite } from "./db/diagnostic-sqlite.js";
import { lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectsDir as lcmProjectsDir } from "./runtime-paths.js";
import {
  assertPrivateDirectoryEntry,
  openPrivateDirectory,
  openPrivateDirectoryIfExists,
  type PrivateDirectoryHandle,
} from "./security-files.js";

import { collectBackendDiagnostics, type BackendDiagnosticSnapshot, type CollectBackendDiagnosticOptions } from "./storage/diagnostics.js";

export interface DiagnosticRecallStats {
  memoriesSurfaced: number;
  memoriesActedUpon: number;
  recallPrecision: number | null;
}
export type RecallStats = DiagnosticRecallStats;

export class StatsUnavailableError extends Error {
  constructor(readonly diagnostics: BackendDiagnosticSnapshot) {
    super("Statistics unavailable; run lcm doctor to inspect backend readiness.");
    this.name = "StatsUnavailableError";
  }
}

interface ConversationStats {
  conversationId: number;
  messages: number;
  summaries: number;
  maxDepth: number;
  rawTokens: number;
  summaryTokens: number;
  ratio: number;
  promotedCount: number;
}

export interface RedactionCounts {
  builtIn: number;
  global: number;
  project: number;
  total: number;
}

export interface OverallStats {
  backendDiagnostics: BackendDiagnosticSnapshot;
  projects: number;
  conversations: number;
  compactedConversations: number;
  messages: number;
  summaries: number;
  maxDepth: number;
  rawTokens: number;
  summaryTokens: number;
  ratio: number;
  promotedCount: number;
  conversationDetails?: ConversationStats[];
  redactionCounts: RedactionCounts;
  eventsCaptured?: number;
  eventsUnprocessed?: number;
  eventsErrors?: number;
  recallStats: RecallStats;
  staleCount?: number;
}

type ProjectStats = Omit<OverallStats, "projects" | "backendDiagnostics" | "recallStats" | "staleCount" | "conversationDetails"> & {
  conversationDetails: ConversationStats[];
  recallStats: RecallStats;
  staleCount: number;
};

type DatabaseFileWitness = Readonly<{
  device: bigint;
  inode: bigint;
}>;

type RetainedDirectory = Readonly<{
  handle: PrivateDirectoryHandle;
  path: string;
}>;

const STATS_ADMISSION_MESSAGE = "stats database topology is not trusted; restore owner-only LCM state directories and a regular project database";

/** A stats database path failed private-state admission. */
export class StatsDatabaseAdmissionError extends Error {
  constructor(readonly code?: "EACCES" | "EPERM") {
    super(STATS_ADMISSION_MESSAGE);
    this.name = "StatsDatabaseAdmissionError";
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function normalizeStatsFilesystemError(
  error: unknown,
): StatsDatabaseAdmissionError {
  if (error instanceof StatsDatabaseAdmissionError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return new StatsDatabaseAdmissionError(code === "EACCES" || code === "EPERM" ? code : undefined);
}

function admitFilesystemOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw normalizeStatsFilesystemError(error);
  }
}

function openOptionalStatsDirectory(path: string): PrivateDirectoryHandle | undefined {
  return admitFilesystemOperation(() => openPrivateDirectoryIfExists(path));
}

function openStatsDirectory(path: string): PrivateDirectoryHandle {
  return admitFilesystemOperation(() => openPrivateDirectory(path));
}

function assertStatsDirectories(directories: readonly RetainedDirectory[]): void {
  for (const directory of directories) {
    admitFilesystemOperation(
      () => assertPrivateDirectoryEntry(
        directory.handle,
        directory.path,
        directory.handle.witness.uid,
      ),
    );
  }
}

function closeStatsDirectories(
  handles: readonly (PrivateDirectoryHandle | undefined)[],
  operationFailed: boolean,
): void {
  let closeFailure: StatsDatabaseAdmissionError | undefined;
  for (const handle of handles) {
    if (!handle) continue;
    try {
      handle.close();
    } catch (error) {
      closeFailure ??= normalizeStatsFilesystemError(error);
    }
  }
  if (closeFailure && !operationFailed) throw closeFailure;
}

function inspectStatsDatabasePath(path: string): DatabaseFileWitness | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile()) throw new StatsDatabaseAdmissionError();
    return { device: stat.dev, inode: stat.ino };
  } catch (error) {
    if (isMissing(error)) return null;
    if (error instanceof StatsDatabaseAdmissionError) throw error;
    throw normalizeStatsFilesystemError(error);
  }
}

function sameDatabaseFile(
  left: DatabaseFileWitness,
  right: DatabaseFileWitness,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function assertStatsDatabasePath(
  path: string,
  expected: DatabaseFileWitness,
): void {
  const actual = inspectStatsDatabasePath(path);
  if (actual === null || !sameDatabaseFile(expected, actual)) {
    throw new StatsDatabaseAdmissionError();
  }
}

function assertNumericCounts(values: readonly unknown[]): void {
  if (!values.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Statistics unavailable");
  }
}

async function queryProjectStats(
  dbPath: string,
  projectId: string,
  staleCfg: { staleAfterDays: number; staleSurfacingWithoutUseLimit: number },
  directories: readonly RetainedDirectory[],
  signal?: AbortSignal,
): Promise<ProjectStats | null> {
  assertStatsDirectories(directories);
  const expectedDatabase = inspectStatsDatabasePath(dbPath);
  if (expectedDatabase === null) return null;
  const cutoff = new Date(Date.now() - staleCfg.staleAfterDays * 86_400_000)
    .toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  // The worker reads only numeric aggregates. Neither content nor arbitrary tags
  // cross its message boundary. Termination bounds even a blocked native query.
  const usedMemory = `SELECT substr(tag.value, 11) FROM json_each(
    CASE WHEN json_valid(p.tags) THEN p.tags ELSE '[]' END
  ) tag WHERE tag.type = 'text' AND substr(tag.value, 1, 10) = 'memory_id:' ORDER BY tag.key LIMIT 1`;
  let rows: unknown[];
  try {
    rows = await readDiagnosticSqlite({
      path: dbPath, expected: expectedDatabase, signal,
      parents: directories.map(directory => ({
        path: directory.path, fd: directory.handle.fd,
        device: BigInt(directory.handle.witness.dev), inode: BigInt(directory.handle.witness.ino),
      })),
      statements: [
        { sql: `SELECT COUNT(*) as count, COALESCE(SUM(token_count), 0) as tokens FROM messages`, mode: "get" },
        { sql: `SELECT COUNT(*) as count, COALESCE(SUM(token_count), 0) as tokens, COALESCE(MAX(depth), 0) as maxDepth FROM summaries`, mode: "get" },
        { sql: `SELECT COUNT(*) as count FROM promoted`, mode: "get" },
        { sql: `SELECT category, COALESCE(SUM(count), 0) as count FROM redaction_stats WHERE project_id = ? GROUP BY category`, params: [projectId], mode: "all" },
        { sql: `SELECT c.conversation_id,
            COALESCE(m.msg_count, 0) as messages, COALESCE(s.sum_count, 0) as summaries,
            COALESCE(s.max_depth, 0) as max_depth, COALESCE(m.raw_tokens, 0) as raw_tokens,
            COALESCE(s.sum_tokens, 0) as summary_tokens
          FROM conversations c
          LEFT JOIN (SELECT conversation_id, COUNT(*) as msg_count, SUM(token_count) as raw_tokens
            FROM messages GROUP BY conversation_id) m ON m.conversation_id = c.conversation_id
          LEFT JOIN (SELECT conversation_id, COUNT(*) as sum_count, SUM(token_count) as sum_tokens,
            MAX(depth) as max_depth FROM summaries GROUP BY conversation_id) s ON s.conversation_id = c.conversation_id
          ORDER BY c.conversation_id DESC`, mode: "all" },
        { sql: `SELECT
          (SELECT COUNT(DISTINCT memory_id) FROM recall_surfacing) AS surfaced,
          (SELECT COUNT(DISTINCT (${usedMemory})) FROM promoted p
            WHERE p.archived_at IS NULL AND p.tags LIKE '%"signal:memory_used"%') AS acted`, mode: "get" },
        { sql: `SELECT COUNT(*) AS count FROM promoted candidate
          WHERE archived_at IS NULL AND created_at < ? AND project_id = ?
          AND NOT EXISTS (SELECT 1 FROM promoted usage
            WHERE usage.archived_at IS NULL AND usage.tags LIKE '%"signal:memory_used"%'
            AND EXISTS (SELECT 1 FROM json_each(
              CASE WHEN json_valid(usage.tags) THEN usage.tags ELSE '[]' END
            ) tag WHERE tag.type = 'text' AND tag.value = 'memory_id:' || candidate.id))
          AND ((SELECT COUNT(*) FROM recall_surfacing WHERE memory_id = candidate.id) = 0
            OR (SELECT COUNT(*) FROM recall_surfacing WHERE memory_id = candidate.id) >= ?)`,
          params: [cutoff, projectId, staleCfg.staleSurfacingWithoutUseLimit], mode: "get" },
      ],
    });
  } catch (error) {
    assertStatsDirectories(directories);
    const currentDatabase = inspectStatsDatabasePath(dbPath);
    if (currentDatabase === null) return null;
    if (!sameDatabaseFile(expectedDatabase, currentDatabase)) throw new StatsDatabaseAdmissionError();
    throw error;
  }
  assertStatsDirectories(directories);
  assertStatsDatabasePath(dbPath, expectedDatabase);
  const [msgStats, sumStats, promoted, redactionRows, convRows, recallRow, stale] = rows as [
    { count: number; tokens: number },
    { count: number; tokens: number; maxDepth: number },
    { count: number },
    Array<{ category: string; count: number }>,
    Array<{ conversation_id: number; messages: number; summaries: number; max_depth: number; raw_tokens: number; summary_tokens: number }>,
    { surfaced: number; acted: number },
    { count: number },
  ];
  const redactionMap = Object.fromEntries(redactionRows.map(row => [row.category, row.count]));
  const redactionCounts: RedactionCounts = {
    builtIn: redactionMap["built_in"] ?? 0, global: redactionMap["global"] ?? 0,
    project: redactionMap["project"] ?? 0, total: 0,
  };
  redactionCounts.total = redactionCounts.builtIn + redactionCounts.global + redactionCounts.project;
  assertNumericCounts([msgStats.count, sumStats.count, sumStats.maxDepth, promoted.count, ...Object.values(redactionCounts)]);
  for (const row of convRows) assertNumericCounts(Object.values(row));
  const conversationDetails: ConversationStats[] = convRows.map((r) => ({
    conversationId: r.conversation_id,
    messages: r.messages,
    summaries: r.summaries,
    maxDepth: r.max_depth,
    rawTokens: r.raw_tokens,
    summaryTokens: r.summary_tokens,
    ratio: r.summary_tokens > 0 && r.raw_tokens > 0 ? r.raw_tokens / r.summary_tokens : 0,
    promotedCount: 0,
  }));

  // Compression metrics only count conversations where summarization happened
  const compacted = conversationDetails.filter((c) => c.summaries > 0);
  const compactedRaw = compacted.reduce((s, c) => s + c.rawTokens, 0);
  const compactedSum = compacted.reduce((s, c) => s + c.summaryTokens, 0);

  const recallStats: DiagnosticRecallStats = {
    memoriesSurfaced: recallRow.surfaced,
    memoriesActedUpon: recallRow.acted,
    recallPrecision: recallRow.surfaced > 0
      ? Math.min(100, recallRow.acted / recallRow.surfaced * 100) : null,
  };
  const staleCount = stale.count;
  assertNumericCounts([recallRow.surfaced, recallRow.acted, staleCount]);

  const result: ProjectStats = {
    conversations: convRows.length,
    compactedConversations: compacted.length,
    messages: msgStats.count,
    summaries: sumStats.count,
    maxDepth: sumStats.maxDepth,
    rawTokens: compactedRaw,
    summaryTokens: compactedSum,
    ratio: compactedSum > 0 && compactedRaw > 0 ? compactedRaw / compactedSum : 0,
    promotedCount: promoted.count,
    conversationDetails,
    redactionCounts,
    eventsCaptured: 0, eventsUnprocessed: 0, eventsErrors: 0,
    recallStats,
    staleCount,
  };
  assertStatsDirectories(directories);
  assertStatsDatabasePath(dbPath, expectedDatabase);
  return result;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function formatRatio(before: number, after: number): string {
  if (before > 0 && after > 0) return (before / after).toFixed(1);
  return "\u2013";
}

function pad(s: string, width: number, align: "left" | "right" = "right"): string {
  return align === "left" ? s.padEnd(width) : s.padStart(width);
}

function sectionHeader(name: string): string {
  const cyan = "\x1b[36m";
  const reset = "\x1b[0m";
  const totalWidth = 42;
  // "── Name ────..."
  const prefix = `── ${name} `;
  const remaining = totalWidth - prefix.length;
  const dashes = "─".repeat(Math.max(0, remaining));
  return `    ${cyan}${prefix}${dashes}${reset}`;
}

export function printStats(stats: OverallStats, verbose: boolean): void {
  const dim = "\x1b[2m";
  const cyan = "\x1b[36m";
  const green = "\x1b[32m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";

  console.log();
  console.log(`    ${bold}${cyan}🧠 Long Context Manager (LCM)${reset}`);
  if (stats.backendDiagnostics) {
    console.log(renderBackendDiagnostics(stats.backendDiagnostics));
  }
  console.log();

  // Memory section
  console.log(sectionHeader("Memory"));
  console.log();

  const memRows: [string, string][] = [
    ["Projects", String(stats.projects)],
    ["Messages", formatNumber(stats.messages)],
    ["Summaries", formatNumber(stats.summaries)],
    ["DAG depth", String(stats.maxDepth)],
    ["Promoted memories", String(stats.promotedCount)],
  ];

  if ((stats.eventsCaptured ?? 0) > 0) {
    memRows.push(["Events", `${formatNumber(stats.eventsCaptured!)} captured (${stats.eventsUnprocessed} unprocessed, ${stats.eventsErrors} errors (30d))`]);
  }

  const labelWidth = Math.max(...memRows.map(([l]) => l.length));
  for (const [label, value] of memRows) {
    console.log(`    ${dim}${pad(label, labelWidth, "left")}${reset}  ${value}`);
  }

  // Compression section (only when summarization has happened)
  if (stats.summaries > 0) {
    console.log();
    console.log(sectionHeader("Compression"));
    console.log();

    const rawStr = formatNumber(stats.rawTokens);
    const sumStr = formatNumber(stats.summaryTokens);
    const savedPct = stats.rawTokens > 0
      ? ((1 - stats.summaryTokens / stats.rawTokens) * 100).toFixed(1)
      : "0.0";
    const ratioStr = stats.ratio > 0 ? stats.ratio.toFixed(1) + "x" : "–";
    const barColor = stats.ratio > 10 ? green : cyan;

    const compactedStr = `${stats.compactedConversations} of ${stats.conversations} conversations`;
    const tokensStr = `${rawStr} → ${sumStr}`;

    const compRows: [string, string][] = [
      ["Compacted", compactedStr],
      ["Tokens", tokensStr],
      ["Ratio", ratioStr],
    ];

    const cLabelWidth = Math.max(...compRows.map(([l]) => l.length));
    for (const [label, value] of compRows) {
      console.log(`    ${dim}${pad(label, cLabelWidth, "left")}${reset}  ${value}`);
    }

    // Percentage line
    console.log(`    ${" ".repeat(cLabelWidth)}  ${savedPct}% compressed`);

    // Visual bar (30 chars wide)
    const barWidth = 30;
    const filled = stats.rawTokens > 0
      ? Math.round((1 - stats.summaryTokens / stats.rawTokens) * barWidth)
      : 0;
    const empty = barWidth - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);
    console.log(`    ${" ".repeat(cLabelWidth)}  ${barColor}${bar}${reset}`);
  }

  // Security section (always shown)
  {
    const rc = stats.redactionCounts;
    console.log();
    console.log(sectionHeader("Security"));
    console.log();

    if (rc.total === 0) {
      console.log(`    ${dim}redactions${reset}  0`);
    } else {
      const detail = `(built-in: ${rc.builtIn}  global: ${rc.global}  project: ${rc.project})`;
      console.log(`    ${dim}redactions${reset}  ${rc.total} total  ${dim}${detail}${reset}`);
    }
  }

  // Recall section (only when any surfacing data exists)
  if (stats.recallStats.memoriesSurfaced > 0 || stats.recallStats.memoriesActedUpon > 0) {
    const rc = stats.recallStats;
    console.log();
    console.log(sectionHeader("Recall"));
    console.log();

    const precisionStr = rc.recallPrecision !== null
      ? `${rc.recallPrecision.toFixed(1)}%`
      : "–";

    const recallRows: [string, string][] = [
      ["Surfaced", String(rc.memoriesSurfaced)],
      ["Acted upon", String(rc.memoriesActedUpon)],
      ["Precision", precisionStr],
    ];
    const rLabelWidth = Math.max(...recallRows.map(([l]) => l.length));
    for (const [label, value] of recallRows) {
      console.log(`    ${dim}${pad(label, rLabelWidth, "left")}${reset}  ${value}`);
    }

  }

  // Per Conversation (verbose only, compacted only)
  if (verbose) {
    // Stale memories section (verbose only)
    if ((stats.staleCount ?? 0) > 0) {
      const yellow = "\x1b[33m";
      console.log();
      console.log(sectionHeader("Stale Memories"));
      console.log();
      console.log(`    ${dim}candidates${reset}  ${yellow}${stats.staleCount}${reset} promoted memories may be stale`);
      console.log(`    ${dim}${reset}           Call ${cyan}POST /review-stale${reset} to inspect and archive.`);
    }

    const compactedDetails = (stats.conversationDetails ?? []).filter((c) => c.summaries > 0);
    if (compactedDetails.length > 0) {
      console.log();
      console.log(sectionHeader("Per Conversation"));
      console.log();

      const hdr = ["#", "msgs", "sums", "depth", "tokens", "ratio"];
      const colWidths = [4, 6, 6, 5, 16, 6];

      const header = hdr.map((h, i) => pad(h, colWidths[i])).join("  ");
      console.log(`    ${dim}${header}${reset}`);
      console.log(`    ${dim}${"─".repeat(header.length)}${reset}`);

      for (const c of compactedDetails) {
        const tokensStr = `${formatNumber(c.rawTokens)} → ${formatNumber(c.summaryTokens)}`;
        const r = c.ratio > 0 ? c.ratio.toFixed(1) + "x" : "–";

        const cells = [
          pad(String(c.conversationId), colWidths[0]),
          pad(formatNumber(c.messages), colWidths[1]),
          pad(formatNumber(c.summaries), colWidths[2]),
          pad(String(c.maxDepth), colWidths[3]),
          pad(tokensStr, colWidths[4]),
          pad(r, colWidths[5]),
        ];
        console.log(`    ${cells.join("  ")}`);
      }
    }
  }

  console.log();
}

export interface CollectStatsOptions {
  homeDir?: string;
  signal?: AbortSignal;
  projectId?: string;
  cwd?: string;
  storageFactory?: CollectBackendDiagnosticOptions["storageFactory"];
}

export async function collectStats(options: CollectStatsOptions = {}): Promise<OverallStats> {
  let sqlite: Omit<OverallStats, "backendDiagnostics"> | undefined;
  const diagnostics = await collectBackendDiagnostics({
    ...options,
    collectSqlite: async (readOptions) => {
      sqlite = await collectSqliteStats(readOptions);
    },
  });
  if (diagnostics.classification !== "healthy" && diagnostics.classification !== "degraded") {
    throw new StatsUnavailableError(diagnostics);
  }
  const metrics = diagnostics.backend === "sqlite" ? sqlite : diagnostics.metrics;
  if (!metrics) throw new StatsUnavailableError(diagnostics);
  return {
    ...metrics,
    backendDiagnostics: diagnostics,
    eventsCaptured: diagnostics.outbox.captured,
    eventsUnprocessed: diagnostics.outbox.unprocessed,
    eventsErrors: diagnostics.outbox.errors,
  };
}

async function collectSqliteStats(options: CollectStatsOptions & {
  staleAfterDays: number;
  staleSurfacingWithoutUseLimit: number;
}): Promise<Omit<OverallStats, "backendDiagnostics">> {
  const baseDir = lcmProjectsDir(options.homeDir);
  const stateRoot = dirname(baseDir);
  const emptyStats = (): Omit<OverallStats, "backendDiagnostics"> & { staleCount: number; conversationDetails: ConversationStats[] } => ({
    projects: 0, conversations: 0, compactedConversations: 0, messages: 0, summaries: 0,
    maxDepth: 0, rawTokens: 0, summaryTokens: 0, ratio: 0,
    promotedCount: 0, conversationDetails: [],
    redactionCounts: { builtIn: 0, global: 0, project: 0, total: 0 },
    eventsCaptured: 0, eventsUnprocessed: 0, eventsErrors: 0,
    recallStats: { memoriesSurfaced: 0, memoriesActedUpon: 0, recallPrecision: null },
    staleCount: 0,
  });
  let rootHandle: PrivateDirectoryHandle | undefined;
  let projectsHandle: PrivateDirectoryHandle | undefined;
  let collectionFailed = false;
  try {
    options.signal?.throwIfAborted();
    rootHandle = openOptionalStatsDirectory(stateRoot);
    if (!rootHandle) throw new Error("Statistics unavailable");
    const rootDirectory = { handle: rootHandle, path: stateRoot };
    assertStatsDirectories([rootDirectory]);
    projectsHandle = openOptionalStatsDirectory(baseDir);
    assertStatsDirectories([rootDirectory]);
    if (!projectsHandle) throw new Error("Statistics unavailable");
    const directories = [rootDirectory, { handle: projectsHandle, path: baseDir }];
    assertStatsDirectories(directories);
    const entries = admitFilesystemOperation(() => readdirSync(baseDir, { withFileTypes: true }));
    assertStatsDirectories(directories);
    const result = emptyStats();
    let matched = options.projectId === undefined;
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      if (!entry.isDirectory() || (options.projectId !== undefined && entry.name !== options.projectId)) continue;
      matched = true;
      assertStatsDirectories(directories);
      const projectPath = join(baseDir, entry.name);
      let projectHandle: PrivateDirectoryHandle | undefined;
      let projectFailed = false;
      try {
        projectHandle = openStatsDirectory(projectPath);
        const projectDirectories = [...directories, { handle: projectHandle, path: projectPath }];
        assertStatsDirectories(projectDirectories);
        const project = await queryProjectStats(join(projectPath, "db.sqlite"), entry.name, options, projectDirectories, options.signal);
        if (!project) throw new Error("Statistics unavailable");
        result.projects++;
        result.conversations += project.conversations;
        result.compactedConversations += project.compactedConversations;
        result.messages += project.messages;
        result.summaries += project.summaries;
        result.maxDepth = Math.max(result.maxDepth, project.maxDepth);
        result.rawTokens += project.rawTokens;
        result.summaryTokens += project.summaryTokens;
        result.promotedCount += project.promotedCount;
        result.staleCount += project.staleCount;
        result.conversationDetails.push(...project.conversationDetails);
        for (const key of ["builtIn", "global", "project", "total"] as const) {
          result.redactionCounts[key] += project.redactionCounts[key];
        }
        result.recallStats.memoriesSurfaced += project.recallStats.memoriesSurfaced;
        result.recallStats.memoriesActedUpon += project.recallStats.memoriesActedUpon;
      } catch (error) {
        projectFailed = true;
        throw error;
      } finally {
        closeStatsDirectories([projectHandle], projectFailed);
      }
    }
    if (!matched) throw new Error("Statistics unavailable");
    result.ratio = result.summaryTokens > 0 ? result.rawTokens / result.summaryTokens : 0;
    result.recallStats.recallPrecision = result.recallStats.memoriesSurfaced > 0
      ? Math.min(100, result.recallStats.memoriesActedUpon / result.recallStats.memoriesSurfaced * 100) : null;
    return result;
  } catch (error) {
    collectionFailed = true;
    throw error;
  } finally {
    closeStatsDirectories([projectsHandle, rootHandle], collectionFailed);
  }
}
