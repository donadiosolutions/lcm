import { isAbsolute, win32 } from "node:path";
import { legacyLcmCommand, legacyLcmMcpServerName } from "../legacy-names.js";
import type { ConnectorTransport } from "../connectors/types.js";

export const REQUIRED_HOOKS: { event: string; command: string }[] = [
  { event: "PostToolUse", command: "post-tool" },
  { event: "PreCompact", command: "compact --hook" },
  { event: "SessionStart", command: "restore" },
  { event: "SessionEnd", command: "session-end" },
  { event: "UserPromptSubmit", command: "user-prompt" },
  { event: "Stop", command: "session-snapshot" },
];

function quoteCommandPath(path: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return `"${path.replaceAll('"', '""')}"`;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

export function canonicalHookCommand(
  runtimePath: string,
  command: string,
  nodePath = process.execPath,
  platform: NodeJS.Platform = process.platform,
  transport: ConnectorTransport = "mcp",
): string {
  const pathIsAbsolute = platform === "win32" ? win32.isAbsolute : isAbsolute;
  if (!pathIsAbsolute(runtimePath)) {
    throw new Error(`LCM runtime path must be absolute: ${runtimePath}`);
  }
  if (!pathIsAbsolute(nodePath)) {
    throw new Error(`Node executable path must be absolute: ${nodePath}`);
  }
  if (command === "user-prompt" && transport !== "cli" && transport !== "mcp") {
    throw new Error(`Unsupported hook transport: ${transport}`);
  }
  const suffix = command === "user-prompt" ? ` --transport ${transport}` : "";
  return `${quoteCommandPath(nodePath, platform)} ${quoteCommandPath(runtimePath, platform)} ${command}${suffix}`;
}

function isManagedCommand(value: unknown, command: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const current = `lcm ${command}`;
  const legacy = legacyLcmCommand(current);
  if (trimmed === current || trimmed === legacy) return true;
  if (command === "user-prompt" &&
      (trimmed === `${current} --transport cli` || trimmed === `${current} --transport mcp` ||
       trimmed === `${legacy} --transport cli` || trimmed === `${legacy} --transport mcp`)) return true;
  if (command === "compact --hook" &&
      (trimmed === "lcm compact" || trimmed === legacyLcmCommand("lcm compact"))) return true;
  // Native npm installations quote their absolute executable. Older direct
  // installations may have used an unquoted absolute executable.
  const suffixes = command === "user-prompt"
    ? [` ${command}`, ` ${command} --transport cli`, ` ${command} --transport mcp`]
    : [` ${command}`];
  const suffix = suffixes.find((candidate) => trimmed.endsWith(candidate));
  if (suffix === undefined) return false;
  const executable = trimmed.slice(0, -suffix.length).trimEnd();
  const singleQuotedMatch = /(?:^|\s)'((?:[^']|'\\'')*)'$/.exec(executable);
  const executableMatch = /(?:^|\s)(?:"((?:\\?""|\\.|[^"\\])+)"|([^"'\s]+))$/.exec(executable);
  if (!singleQuotedMatch && !executableMatch) return false;
  const executablePath = singleQuotedMatch
    ? singleQuotedMatch[1].replaceAll("'\\''", "'")
    : (executableMatch![1] ?? executableMatch![2])
      .replaceAll('""', '"')
      .replaceAll('\\"', '"')
      .replaceAll("\\\\", "\\");
  return /(^|[\\/])lcm(?:\.mjs)?$/.test(executablePath);
}

function asSettingsObject(existing: unknown): Record<string, any> {
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error("Claude settings must contain a JSON object");
  }
  return structuredClone(existing) as Record<string, any>;
}

function canonicalClaudeMcpFields(
  runtimePath: string,
  nodePath: string,
  platform: NodeJS.Platform,
): { type: "stdio"; command: string; args: [string, "mcp"] } {
  const pathIsAbsolute = platform === "win32" ? win32.isAbsolute : isAbsolute;
  if (!pathIsAbsolute(runtimePath)) {
    throw new Error(`LCM runtime path must be absolute: ${runtimePath}`);
  }
  if (!pathIsAbsolute(nodePath)) {
    throw new Error(`Node executable path must be absolute: ${nodePath}`);
  }
  return { type: "stdio", command: nodePath, args: [runtimePath, "mcp"] };
}

const CLAUDE_REMOTE_MCP_FIELDS = ["url", "headers", "transport"] as const;

/**
 * Merge the fields owned by LCM into a Claude MCP server entry.
 *
 * Unknown fields belong to Claude or the user and must survive repairs. Known
 * remote-transport fields cannot coexist with a stdio command, so they are
 * removed while type, command, and args are normalized. A malformed entry
 * cannot be merged safely, so it is replaced with the minimal canonical entry.
 */
export function mergeClaudeMcpEntry(
  existing: unknown,
  runtimePath: string,
  nodePath = process.execPath,
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> {
  const canonical = canonicalClaudeMcpFields(runtimePath, nodePath, platform);
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
    return canonical;
  }
  const preserved = structuredClone(existing) as Record<string, unknown>;
  for (const field of CLAUDE_REMOTE_MCP_FIELDS) delete preserved[field];
  return { ...preserved, ...canonical };
}

export function hasCanonicalClaudeMcpEntry(
  existing: unknown,
  runtimePath: string,
  nodePath = process.execPath,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
    return false;
  }
  const canonical = canonicalClaudeMcpFields(runtimePath, nodePath, platform);
  const entry = existing as Record<string, unknown>;
  return entry.type === canonical.type
    && CLAUDE_REMOTE_MCP_FIELDS.every((field) => !(field in entry))
    && entry.command === canonical.command
    && Array.isArray(entry.args)
    && entry.args.length === canonical.args.length
    && entry.args.every((value, index) => value === canonical.args[index]);
}

export function hasManagedClaudeSettings(existing: unknown): boolean {
  const settings = asSettingsObject(existing);
  if (settings.mcpServers !== undefined &&
      (settings.mcpServers === null || typeof settings.mcpServers !== "object" || Array.isArray(settings.mcpServers))) {
    throw new Error("Claude settings mcpServers must be a JSON object");
  }
  if (settings.mcpServers?.lcm !== undefined ||
      settings.mcpServers?.[legacyLcmMcpServerName()] !== undefined) return true;

  if (settings.hooks === undefined) return false;
  if (settings.hooks === null || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw new Error("Claude settings hooks must be a JSON object");
  }
  for (const { event, command } of REQUIRED_HOOKS) {
    const entries = settings.hooks[event];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) throw new Error(`Claude settings hooks.${event} must be an array`);
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry) || entry.hooks === undefined) continue;
      if (!Array.isArray(entry.hooks)) {
        throw new Error(`Claude settings hooks.${event} entry hooks must be an array`);
      }
      if (entry.hooks.some((hook: any) => isManagedCommand(hook?.command, command))) return true;
    }
  }
  return false;
}

export function mergeClaudeSettings(
  existing: unknown,
  runtimePath: string,
  nodePath = process.execPath,
  transport: ConnectorTransport = "mcp",
): any {
  const settings = asSettingsObject(existing);
  const hooks = settings.hooks === undefined
    ? {}
    : settings.hooks;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error("Claude settings hooks must be a JSON object");
  }

  for (const { event, command } of REQUIRED_HOOKS) {
    const existingEntries = hooks[event];
    if (existingEntries !== undefined && !Array.isArray(existingEntries)) {
      throw new Error(`Claude settings hooks.${event} must be an array`);
    }
    const entries: any[] = existingEntries ?? [];
    const preserved = entries.flatMap((entry: any) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [entry];
      if (entry.hooks === undefined) return [entry];
      if (!Array.isArray(entry.hooks)) {
        throw new Error(`Claude settings hooks.${event} entry hooks must be an array`);
      }
      const remaining = entry.hooks.filter((hook: any) => !isManagedCommand(hook?.command, command));
      if (remaining.length === 0) {
        const otherKeys = Object.keys(entry).filter((key) => key !== "hooks" && key !== "matcher");
        return otherKeys.length === 0 ? [] : [{ ...entry, hooks: [] }];
      }
      return [{ ...entry, hooks: remaining }];
    });
    preserved.push({
      matcher: "",
      hooks: [{ type: "command", command: canonicalHookCommand(runtimePath, command, nodePath, process.platform, transport) }],
    });
    hooks[event] = preserved;
  }
  settings.hooks = hooks;

  if (settings.mcpServers !== undefined &&
      (settings.mcpServers === null || typeof settings.mcpServers !== "object" || Array.isArray(settings.mcpServers))) {
    throw new Error("Claude settings mcpServers must be a JSON object");
  }
  settings.mcpServers = settings.mcpServers ?? {};
  delete settings.mcpServers[legacyLcmMcpServerName()];
  return settings;
}

export function removeManagedClaudeHooks(existing: unknown): any {
  const settings = asSettingsObject(existing);
  if (settings.hooks !== undefined) {
    if (settings.hooks === null || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
      throw new Error("Claude settings hooks must be a JSON object");
    }
    for (const { event, command } of REQUIRED_HOOKS) {
      const entries = settings.hooks[event];
      if (entries === undefined) continue;
      if (!Array.isArray(entries)) throw new Error(`Claude settings hooks.${event} must be an array`);
      settings.hooks[event] = entries.flatMap((entry: any) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry) || entry.hooks === undefined) return [entry];
        if (!Array.isArray(entry.hooks)) throw new Error(`Claude settings hooks.${event} entry hooks must be an array`);
        const remaining = entry.hooks.filter((hook: any) => !isManagedCommand(hook?.command, command));
        if (remaining.length === 0 && Object.keys(entry).every((key) => key === "hooks" || key === "matcher")) return [];
        return [{ ...entry, hooks: remaining }];
      });
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  return settings;
}

export function removeManagedClaudeSettings(existing: unknown): any {
  const settings = removeManagedClaudeHooks(existing);
  if (settings.mcpServers !== undefined) {
    if (settings.mcpServers === null || typeof settings.mcpServers !== "object" || Array.isArray(settings.mcpServers)) {
      throw new Error("Claude settings mcpServers must be a JSON object");
    }
    delete settings.mcpServers.lcm;
    delete settings.mcpServers[legacyLcmMcpServerName()];
    if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
  }
  return settings;
}
