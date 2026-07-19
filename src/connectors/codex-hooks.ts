import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export const CODEX_HOOKS_PATH = "~/.codex/hooks.json";
export const CODEX_CONFIG_PATH = "~/.codex/config.toml";
export const LEGACY_CODEX_HOOKS_PATHS = [".codex/hooks.json"] as const;

type CodexCommandHook = {
  type?: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
  [key: string]: unknown;
};

type CodexHookGroup = {
  matcher?: string;
  hooks?: CodexCommandHook[];
  [key: string]: unknown;
};

type CodexHooksConfig = {
  hooks: Record<string, CodexHookGroup[]>;
  [key: string]: unknown;
};

function lcmCommand(command: string): string {
  return `lcm ${command} --client codex`;
}

function codexLcmHooks(): Record<string, CodexHookGroup[]> {
  return {
    SessionStart: [
      {
        matcher: "startup|resume|clear",
        hooks: [
          {
            type: "command",
            command: lcmCommand("restore"),
            timeout: 30,
            statusMessage: "Loading LCM memory",
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: lcmCommand("user-prompt"),
            timeout: 30,
            statusMessage: "Searching LCM memory",
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: lcmCommand("post-tool"),
            timeout: 10,
            statusMessage: "Recording LCM tool context",
          },
        ],
      },
    ],
    PreCompact: [
      {
        matcher: "manual|auto",
        hooks: [
          {
            type: "command",
            command: lcmCommand("session-snapshot"),
            timeout: 30,
            statusMessage: "Saving LCM memory before compaction",
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: lcmCommand("session-snapshot"),
            timeout: 30,
            statusMessage: "Saving LCM memory",
          },
        ],
      },
    ],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeHooksConfig(value: unknown): CodexHooksConfig {
  const config = isObject(value) ? { ...value } : {};
  if (!isObject(config.hooks)) {
    config.hooks = {};
  }
  return config as CodexHooksConfig;
}

function readHooksConfig(path: string): CodexHooksConfig {
  try {
    return normalizeHooksConfig(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return { hooks: {} };
  }
}

function isLcmHookCommand(command: unknown): boolean {
  return (
    typeof command === "string" &&
    /\blcm\s+(restore|user-prompt|post-tool|session-snapshot)\b/.test(command)
  );
}

function stripLcmHooks(config: CodexHooksConfig): { config: CodexHooksConfig; removed: boolean } {
  let removed = false;
  const next: CodexHooksConfig = { ...config, hooks: {} };

  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) continue;

    const keptGroups: CodexHookGroup[] = [];
    for (const group of groups) {
      const hooks = Array.isArray(group.hooks) ? group.hooks : [];
      const keptHooks = hooks.filter((hook) => !isLcmHookCommand(hook.command));
      if (keptHooks.length !== hooks.length) removed = true;

      if (keptHooks.length > 0) {
        keptGroups.push({ ...group, hooks: keptHooks });
      } else if (!Array.isArray(group.hooks)) {
        keptGroups.push(group);
      } else if (Object.keys(group).some((key) => key !== "hooks" && key !== "matcher")) {
        keptGroups.push({ ...group, hooks: keptHooks });
      }
    }

    if (keptGroups.length > 0) {
      next.hooks[event] = keptGroups;
    }
  }

  return { config: next, removed };
}

function hasAnyHookGroups(config: CodexHooksConfig): boolean {
  return Object.values(config.hooks).some((groups) => Array.isArray(groups) && groups.length > 0);
}

function hasNonHookKeys(config: CodexHooksConfig): boolean {
  return Object.keys(config).some((key) => key !== "hooks");
}

export function enableCodexHooksFeature(configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  let existing = "";
  try {
    existing = readFileSync(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const updated = setCodexHooksFeature(existing);
  if (updated !== existing) {
    writeFileSync(configPath, updated);
  }
}

export function setCodexHooksFeature(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trimEnd();
  if (!normalized) {
    return "[features]\nhooks = true\n";
  }

  const lines = normalized.split("\n");
  const sectionHeader = /^\s*\[features\]\s*(?:#.*)?$/;
  const anySectionHeader = /^\s*\[[^\]]+\]\s*(?:#.*)?$/;
  const hooksFeatureLine = /^(\s*hooks\s*=\s*).*(\s*)$/;
  const deprecatedFeatureLine = /^\s*codex_hooks\s*=.*$/;

  const featuresStart = lines.findIndex((line) => sectionHeader.test(line));
  if (featuresStart === -1) {
    return `${normalized}\n\n[features]\nhooks = true\n`;
  }

  let insertAt = featuresStart + 1;
  let featuresEnd = lines.length;
  let hooksLine = -1;
  for (let i = featuresStart + 1; i < lines.length; i++) {
    if (anySectionHeader.test(lines[i])) {
      featuresEnd = i;
      break;
    }
    if (hooksFeatureLine.test(lines[i])) {
      hooksLine = i;
    }
    insertAt = i + 1;
  }

  for (let i = featuresEnd - 1; i > featuresStart; i--) {
    if (deprecatedFeatureLine.test(lines[i])) {
      lines.splice(i, 1);
      if (hooksLine > i) hooksLine -= 1;
      featuresEnd -= 1;
      insertAt = Math.min(insertAt, featuresEnd);
    }
  }

  if (hooksLine !== -1) {
    lines[hooksLine] = lines[hooksLine].replace(hooksFeatureLine, "$1true");
    return `${lines.join("\n")}\n`;
  }

  lines.splice(Math.min(insertAt, featuresEnd), 0, "hooks = true");
  return `${lines.join("\n")}\n`;
}

export function installCodexHooks(hooksPath: string, configPath: string): void {
  mkdirSync(dirname(hooksPath), { recursive: true });
  enableCodexHooksFeature(configPath);

  const { config } = stripLcmHooks(readHooksConfig(hooksPath));
  const lcmHooks = codexLcmHooks();
  for (const [event, groups] of Object.entries(lcmHooks)) {
    config.hooks[event] = [...(config.hooks[event] ?? []), ...groups];
  }

  writeFileSync(hooksPath, JSON.stringify(config, null, 2) + "\n");
}

export function removeCodexHooks(hooksPath: string): boolean {
  const { config, removed } = stripLcmHooks(readHooksConfig(hooksPath));
  if (!removed) return false;

  if (!hasAnyHookGroups(config) && !hasNonHookKeys(config)) {
    unlinkSync(hooksPath);
    return true;
  }

  writeFileSync(hooksPath, JSON.stringify(config, null, 2) + "\n");
  return true;
}

export function hasCodexHooks(hooksPath: string): boolean {
  const config = readHooksConfig(hooksPath);
  return Object.values(config.hooks).some((groups) =>
    Array.isArray(groups) &&
    groups.some((group) =>
      Array.isArray(group.hooks) &&
      group.hooks.some((hook) => isLcmHookCommand(hook.command)),
    ),
  );
}
