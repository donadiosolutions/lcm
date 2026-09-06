import { renderBackendDiagnostics } from "../storage/diagnostic-renderer.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { DaemonClient } from "../daemon/client.js";
import { loadDaemonConfig, type DaemonConfig, type ResolvedStorageConfig } from "../daemon/config.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { configPath as defaultConfigPath, daemonPidPath } from "../runtime-paths.js";
import { PKG_VERSION } from "../daemon/version.js";
import { mapDaemonRefusalToRemediation } from "../daemon/remediation.js";
import { packageExecutable } from "../runtime-root.js";
import { lcmGrepTool } from "./tools/lcm-grep.js";
import { lcmExpandTool } from "./tools/lcm-expand.js";
import { lcmDescribeTool } from "./tools/lcm-describe.js";
import { lcmSearchTool } from "./tools/lcm-search.js";
import { lcmStoreTool } from "./tools/lcm-store.js";
import { lcmStatsTool } from "./tools/lcm-stats.js";
import { lcmDoctorTool } from "./tools/lcm-doctor.js";
import {
  assertStorageBackendPublication,
} from "../storage/backend.js";
import {
  BackendPublicationJournalError,
  backendPublicationHomeForConfigPath,
} from "../storage/backend-publication.js";
import { isDaemonTransportFailure } from "../daemon/http-url.js";
import { sanitizeHookErrorDiagnostic } from "../hooks/hook-error-diagnostic.js";

const TOOLS = [lcmGrepTool, lcmExpandTool, lcmDescribeTool, lcmSearchTool, lcmStoreTool, lcmStatsTool, lcmDoctorTool];

const TOOL_ROUTES: Record<string, string> = {
  lcm_grep: "/grep",
  lcm_expand: "/expand",
  lcm_describe: "/describe",
  lcm_search: "/search",
  lcm_store: "/store",
};

/**
 * Remove code points that untrusted text could use to forge the private-use
 * markers used by the protected-label pass.  Iterating by code point keeps
 * valid supplementary Unicode intact; lone surrogate code units are removed
 * as malformed input.
 */
function stripUntrustedMarkerCodePoints(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!;
    const isMalformedSurrogate = codePoint >= 0xD800 && codePoint <= 0xDFFF;
    const isBmpPrivateUse = codePoint >= 0xE000 && codePoint <= 0xF8FF;
    const isPlane15PrivateUse = codePoint >= 0xF0000 && codePoint <= 0xFFFFD;
    const isPlane16PrivateUse = codePoint >= 0x100000 && codePoint <= 0x10FFFD;
    return isMalformedSurrogate || isBmpPrivateUse || isPlane15PrivateUse || isPlane16PrivateUse ? "" : character;
  }).join("");
}

const MCP_ASSIGNMENT_PREFIX_PATTERN = /(["']?)\b(host|hostname|socket|server|password|passwd|pwd|token|secret|api[-_ ]?key|authorization)\1(\s*)[:=]\s*(?:(?:basic|bearer)\s+)?/giu;
const MAX_MCP_QUOTED_VALUE_LENGTH = 256;

function findBoundedQuotedValueEnd(value: string, start: number, quote: string): number | undefined {
  const limit = Math.min(value.length - 1, start + 1 + MAX_MCP_QUOTED_VALUE_LENGTH);
  let index = start + 1;
  while (index <= limit) {
    const character = value[index];
    if (character === quote) return index + 1;
    if (character === "\\") {
      if (index + 1 > limit) return undefined;
      index += 2;
    } else {
      index += 1;
    }
  }
  return undefined;
}

function redactQuotedMcpAssignments(value: string, redactionKeyMarker: string, redactionSeparator: string): string {
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(MCP_ASSIGNMENT_PREFIX_PATTERN)) {
    const start = match.index!;
    if (start < cursor) continue;

    const valueStart = start + match[0].length;
    const quote = value[valueStart];
    if (quote !== "\"" && quote !== "'") continue;

    const redactedAssignment = `${match[2].slice(0, 1)}${redactionKeyMarker}${match[2].slice(1)}${match[3]}${redactionSeparator}<redacted>`;
    const valueEnd = findBoundedQuotedValueEnd(value, valueStart, quote);
    result += value.slice(cursor, start);
    result += redactedAssignment;
    if (valueEnd === undefined) {
      // A malformed or overlong quoted value is not safe to scan incrementally.
      // Drop the remainder so a partial match can never expose the payload.
      cursor = value.length;
      break;
    }
    cursor = valueEnd;
  }
  return result + value.slice(cursor);
}

const LOCAL_TOOLS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  lcm_stats: async (args) => {
    const { collectStats, formatNumber, StatsUnavailableError } = await import("../stats.js");
    let stats;
    try { stats = await collectStats(); }
    catch (error) {
      if (!(error instanceof StatsUnavailableError)) throw error;
      return renderBackendDiagnostics(error.diagnostics);
    }
    const verbose = args.verbose === true;
    const lines: string[] = [renderBackendDiagnostics(stats.backendDiagnostics), ""];

    // Memory section
    lines.push("## 🧠 Memory");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Projects | ${stats.projects} |`);
    lines.push(`| Conversations | ${stats.conversations} |`);
    lines.push(`| Messages | ${formatNumber(stats.messages)} |`);
    lines.push(`| Summaries | ${formatNumber(stats.summaries)} |`);
    lines.push(`| DAG depth | ${stats.maxDepth} |`);
    lines.push(`| Promoted memories | ${stats.promotedCount} |`);
    if ((stats.eventsCaptured ?? 0) > 0) {
      lines.push(`| Events | ${formatNumber(stats.eventsCaptured!)} captured (${stats.eventsUnprocessed} unprocessed, ${stats.eventsErrors} errors (30d)) |`);
    }

    // Compression section (only when summarization has happened)
    if (stats.summaries > 0) {
      lines.push("");
      lines.push("## Compression");
      lines.push("");
      lines.push("| Metric | Value |");
      lines.push("|--------|-------|");

      const rawStr = formatNumber(stats.rawTokens);
      const sumStr = formatNumber(stats.summaryTokens);
      const savedPct = stats.rawTokens > 0
        ? ((1 - stats.summaryTokens / stats.rawTokens) * 100).toFixed(1)
        : "0.0";
      const ratio = stats.ratio > 0 ? stats.ratio.toFixed(1) + "x" : "–";

      const barWidth = 30;
      const filled = stats.rawTokens > 0
        ? Math.round((1 - stats.summaryTokens / stats.rawTokens) * barWidth)
        : 0;
      const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

      lines.push(`| Compacted | ${stats.compactedConversations} of ${stats.conversations} conversations |`);
      lines.push(`| Tokens | ${rawStr} → ${sumStr} |`);
      lines.push(`| Ratio | ${ratio} |`);
      lines.push(`| | ${savedPct}% compressed |`);
      lines.push(`| | \`${bar}\` |`);

      // Per Conversation (verbose, compacted-only)
      if (verbose) {
        const compactedDetails = (stats.conversationDetails ?? []).filter((c) => c.summaries > 0);
        if (compactedDetails.length > 0) {
          lines.push("");
          lines.push("## Per Conversation");
          lines.push("");
          lines.push("| # | msgs | sums | depth | tokens | ratio |");
          lines.push("|---|------|------|-------|--------|-------|");
          for (const c of compactedDetails) {
            const tokensStr = `${formatNumber(c.rawTokens)} → ${formatNumber(c.summaryTokens)}`;
            const r = c.ratio > 0 ? c.ratio.toFixed(1) + "x" : "–";
            lines.push(`| ${c.conversationId} | ${c.messages} | ${c.summaries} | ${c.maxDepth} | ${tokensStr} | ${r} |`);
          }
        }
      }
    }

    // Security section (always shown)
    {
      const rc = stats.redactionCounts;
      lines.push("");
      lines.push("## 🔒 Security");
      lines.push("");
      lines.push("| Metric | Value |");
      lines.push("|--------|-------|");
      if (rc.total === 0) {
        lines.push(`| Redactions | 0 |`);
      } else {
        lines.push(`| Redactions | ${rc.total} total (built-in: ${rc.builtIn}  global: ${rc.global}  project: ${rc.project}) |`);
      }
    }

    return lines.join("\n");
  },
  lcm_doctor: async () => {
    const { runDoctor, formatResultsPlain } = await import("../doctor/doctor.js");
    const results = await runDoctor();
    return formatResultsPlain(results);
  },
};

// Build per-tool allowlist from tool definitions (keyed by tool name)
const TOOL_ALLOWED_KEYS: Record<string, Set<string>> = {};
for (const tool of TOOLS) {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (props) {
    TOOL_ALLOWED_KEYS[tool.name] = new Set(Object.keys(props));
  }
}

export function getMcpToolDefinitions() { return TOOLS; }

export type DaemonRequestOpts = {
  port: number;
  pidFilePath: string;
  storage: ResolvedStorageConfig;
  spawnCommand?: string;
  spawnArgs?: string[];
  expectedEntrypoint?: string;
  expectedVersion?: string;
  /** Canonical config path used for fresh request-time publication admission. */
  publicationConfigPath?: string;
  _ensureDaemon?: typeof ensureDaemon;
};

function assertMcpStorageAdmission(
  configPath: string,
  expectedBackend?: ResolvedStorageConfig["backend"],
): DaemonConfig {
  const config = loadDaemonConfig(configPath);
  if (expectedBackend !== undefined && config.storage.backend !== expectedBackend) {
    throw new BackendPublicationJournalError(
      "unexpected-state",
      "MCP request backend differs from the authenticated config backend",
    );
  }
  const homeDir = backendPublicationHomeForConfigPath(configPath);
  assertStorageBackendPublication({ backend: config.storage.backend, homeDir });
  return config;
}

/**
 * Keep MCP failures useful without crossing the process/configuration boundary
 * with an arbitrary exception message.  Publication refusal is a fixed,
 * user-facing diagnostic and contains no request or host data.
 */
function safeMcpError(err: unknown): string {
  if (err instanceof BackendPublicationJournalError) {
    return "lcm error: backend publication admission blocked; complete or recover the publication before retrying";
  }
  // Private-use sentinels keep the shared scrubber from interpreting protected labels as secrets.
  const redactionKeyMarker = "\uE000";
  const redactionSeparator = "\uE001";
  const raw = err instanceof Error ? err.message : String(err);
  // Strip private-use and malformed code points before matching.  The marker
  // restoration below is therefore only able to consume markers generated by
  // this function, never marker-shaped text supplied by the caller.
  const markerSafeRaw = stripUntrustedMarkerCodePoints(raw);
  const protectedRaw = redactQuotedMcpAssignments(markerSafeRaw, redactionKeyMarker, redactionSeparator).replace(
    /\b(host|hostname|socket|server|password|passwd|pwd|token|secret|api[-_ ]?key|authorization)(\s*)[:=]\s*(?:(?:basic|bearer)\s+)?([^\s,;]+?)([.!?])?(?=\s|[,;]|$)/giu,
    (_match, key: string, spacing: string, _value: string, terminalPunctuation: string = "") =>
      `${key.slice(0, 1)}${redactionKeyMarker}${key.slice(1)}${spacing}${redactionSeparator}<redacted>${terminalPunctuation}`,
  );
  const diagnostic = sanitizeHookErrorDiagnostic(
    protectedRaw,
  )
    .replace(/\b(?:https?:\/\/|localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1)[^\s,;]*/giu, "<endpoint>")
    .replace(/\b(?:pid|process\s+id)\s*[=:]?\s*\d+\b/giu, "pid=<redacted>")
    .replaceAll(redactionKeyMarker, "")
    .replaceAll(redactionSeparator, "=");
  return `lcm error: ${diagnostic || "request failed"}`;
}

/** Narrow seam so tests can assert the exact redaction contract deterministically. */
export const __lcmMcpTestHooks = { safeMcpError };

/** Exported for testing. Calls a daemon route without lifecycle recovery. */
export async function handleDaemonRequest(
  client: Pick<DaemonClient, "post">,
  route: string,
  body: Record<string, unknown>,
  opts: DaemonRequestOpts,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (opts.publicationConfigPath === undefined) {
      assertStorageBackendPublication(opts.storage);
    } else {
      assertMcpStorageAdmission(opts.publicationConfigPath, opts.storage.backend);
    }
  } catch (err) {
    return { content: [{ type: "text", text: safeMcpError(err) }], isError: true };
  }
  let result: unknown;
  try {
    result = await client.post(route, body);
  } catch (err) {
    // Daemon HTTP/programming failures are not transport loss and must not
    // trigger lifecycle recovery or expose the underlying exception text.
    if (!isDaemonTransportFailure(err)) {
      return { content: [{ type: "text", text: safeMcpError(err) }], isError: true };
    }
    // An MCP request must not signal, restart, or spawn a daemon based only on
    // a transport failure.  Lifecycle recovery belongs to explicit CLI/hooks;
    // return the bounded remediation message without exposing transport text.
    return {
      content: [{ type: "text", text: mapDaemonRefusalToRemediation("live-no-response").message }],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export async function startMcpServer(): Promise<void> {
  const publicationConfigPath = defaultConfigPath();
  const config = assertMcpStorageAdmission(publicationConfigPath);
  const port = config.daemon.port;
  const pidFilePath = daemonPidPath();

  const lcmBin = packageExecutable(import.meta.url, 3);
  const daemon = await ensureDaemon({
    port, pidFilePath, spawnTimeoutMs: 10000,
    expectedVersion: PKG_VERSION,
    expectedStorageBackend: config.storage.backend,
    spawnCommand: process.execPath,
    spawnArgs: [lcmBin, "daemon", "start", "--foreground"],
    expectedEntrypoint: lcmBin,
    enforceUserManagerParent: true,
  });
  if (!daemon.connected) {
    throw new Error("Refusing to start MCP server: daemon endpoint identity could not be verified.");
  }

  const client = new DaemonClient(`http://127.0.0.1:${port}`);
  const server = new Server({ name: "lcm", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const rawArgs = req.params.arguments ?? {};
    // Guard: ensure rawArgs is a plain object
    if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
      return { content: [{ type: "text", text: `Invalid arguments for tool ${req.params.name}: must be an object` }], isError: true };
    }
    const allowedKeys = TOOL_ALLOWED_KEYS[req.params.name];
    const filteredArgs: Record<string, unknown> = {};
    if (allowedKeys) {
      for (const key of allowedKeys) {
        if (key in rawArgs) filteredArgs[key] = (rawArgs as Record<string, unknown>)[key];
      }
    } else {
      // No schema properties defined — default-deny: pass nothing through.
      // This is safer than a denylist-based approach which could miss unknown keys.
      void rawArgs;
    }

    const localHandler = LOCAL_TOOLS[req.params.name];
    if (localHandler) {
      try {
        const text = await localHandler(filteredArgs);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: safeMcpError(err) }], isError: true };
      }
    }

    const route = TOOL_ROUTES[req.params.name];
    if (!route) return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
    const body = { ...filteredArgs, cwd: process.env.PWD ?? process.cwd() };
    return handleDaemonRequest(client, route, body, {
      port, pidFilePath,
      spawnCommand: process.execPath,
      spawnArgs: [lcmBin, "daemon", "start", "--foreground"],
      expectedEntrypoint: lcmBin,
      expectedVersion: PKG_VERSION,
      storage: config.storage,
      publicationConfigPath,
    });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
