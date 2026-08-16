import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { mergeClaudeSettings } from "../installer/settings.js";
import { configPath as defaultConfigPath, lcmPath } from "../runtime-paths.js";
import { resolveAgentTransport } from "../connectors/registry.js";
import type { ConnectorTransport } from "../connectors/types.js";

export interface AutoHealDeps {
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, data: string) => void;
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  appendFileSync: (path: string, data: string) => void;
  settingsPath: string;
  logPath: string;
  binaryPath: string;
  nodePath?: string;
  configPath?: string;
  transport?: ConnectorTransport;
}

function defaultDeps(): AutoHealDeps {
  return {
    readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
    writeFileSync,
    existsSync,
    mkdirSync,
    appendFileSync,
    settingsPath: join(homedir(), ".claude", "settings.json"),
    logPath: lcmPath("auto-heal.log"),
    binaryPath: isAbsolute(process.argv[1] ?? "") ? process.argv[1] : "",
    configPath: defaultConfigPath(),
  };
}

export function validateAndFixHooks(
  deps: AutoHealDeps = defaultDeps(),
  currentTransport?: ConnectorTransport,
): void {
  try {
    if (!deps.existsSync(deps.settingsPath)) return;

    if (!deps.binaryPath) throw new Error("cannot resolve absolute LCM executable for hook repair");
    const settings: unknown = JSON.parse(deps.readFileSync(deps.settingsPath, "utf-8"));
    const transport = resolveAgentTransport(
      "claude-code",
      currentTransport ?? deps.transport,
      { configPath: deps.configPath ?? defaultConfigPath() },
    ).transport;
    const merged = mergeClaudeSettings(settings, deps.binaryPath, deps.nodePath, transport);
    if (JSON.stringify(settings) === JSON.stringify(merged)) return;
    deps.mkdirSync(dirname(deps.settingsPath), { recursive: true });
    deps.writeFileSync(deps.settingsPath, JSON.stringify(merged, null, 2));
  } catch (err) {
    try {
      deps.mkdirSync(dirname(deps.logPath), { recursive: true });
      const msg = `[${new Date().toISOString()}] auto-heal error: ${err instanceof Error ? err.message : String(err)}\n`;
      deps.appendFileSync(deps.logPath, msg);
    } catch {
      // Last resort: silently fail
    }
  }
}
