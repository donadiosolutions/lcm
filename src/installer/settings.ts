import { isAbsolute, win32 } from "node:path";
import { legacyLcmCommand, legacyLcmMcpServerName } from "../legacy-names.js";

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
): string {
  const pathIsAbsolute = platform === "win32" ? win32.isAbsolute : isAbsolute;
  if (!pathIsAbsolute(runtimePath)) {
    throw new Error(`LCM runtime path must be absolute: ${runtimePath}`);
  }
  if (!pathIsAbsolute(nodePath)) {
    throw new Error(`Node executable path must be absolute: ${nodePath}`);
  }
  return `${quoteCommandPath(nodePath, platform)} ${quoteCommandPath(runtimePath, platform)} ${command}`;
}

function isManagedCommand(value: unknown, command: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const current = `lcm ${command}`;
  const legacy = legacyLcmCommand(current);
  if (trimmed === current || trimmed === legacy) return true;
  if (command === "compact --hook" &&
      (trimmed === "lcm compact" || trimmed === legacyLcmCommand("lcm compact"))) return true;
  // Native npm installations quote their absolute executable. Older direct
  // installations may have used an unquoted absolute executable.
  const suffix = ` ${command}`;
  if (!trimmed.endsWith(suffix)) return false;
  const executable = trimmed.slice(0, -suffix.length).trimEnd();
  const executableMatch = /(?:^|\s)(?:"((?:\\?""|\\.|[^"\\])+)"|'([^']+)'|([^"'\s]+))$/.exec(executable);
  if (!executableMatch) return false;
  const executablePath = (executableMatch[1] ?? executableMatch[2] ?? executableMatch[3])
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

export function mergeClaudeSettings(existing: unknown, runtimePath: string, nodePath = process.execPath): any {
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
      hooks: [{ type: "command", command: canonicalHookCommand(runtimePath, command, nodePath) }],
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
