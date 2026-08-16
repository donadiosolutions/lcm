import { configPath as defaultConfigPath } from "../runtime-paths.js";
import { readConnectorTransport } from "../config-manager.js";
import type {
  Agent,
  AgentCategory,
  ConnectorCapabilities,
  ConnectorTransport,
} from "./types.js";
import { CONNECTOR_TRANSPORTS } from "./types.js";

const CLI_GUIDANCE: ConnectorCapabilities = {
  guidance: ["skill", "rules"],
};
const CLI_RULES: ConnectorCapabilities = {
  guidance: ["rules"],
};
const CLI_SKILL: ConnectorCapabilities = {
  guidance: ["skill"],
};
const CLI_WITH_HOOKS: ConnectorCapabilities = {
  guidance: ["skill", "rules"],
  nativeHook: true,
};
const CODEX_CLI_WITH_HOOKS: ConnectorCapabilities = {
  guidance: ["skill"],
  nativeHook: true,
};
const MCP_WITH_SKILL: ConnectorCapabilities = {
  guidance: ["skill", "rules"],
  mcpAdapter: true,
};
const MCP_WITH_RULES: ConnectorCapabilities = {
  guidance: ["rules"],
  mcpAdapter: true,
};
const MCP_WITH_SKILL_AND_HOOKS: ConnectorCapabilities = {
  guidance: ["skill", "rules"],
  nativeHook: true,
  mcpAdapter: true,
};

export const AGENTS: Agent[] = [
  // CLI tools (7)
  {
    id: "claude-code",
    name: "Claude Code",
    category: "cli",
    defaultTransport: "mcp",
    capabilities: { cli: CLI_WITH_HOOKS, mcp: MCP_WITH_SKILL_AND_HOOKS },
    configPaths: {
      rules: "CLAUDE.md",
      hook: "~/.claude/settings.json",
      mcp: ".mcp.json",
      skill: ".claude/skills/",
    },
    writeMode: "append",
  },
  {
    id: "codex",
    name: "Codex",
    category: "cli",
    defaultTransport: "cli",
    capabilities: { cli: CODEX_CLI_WITH_HOOKS, mcp: MCP_WITH_SKILL_AND_HOOKS },
    configPaths: {
      rules: "~/.codex/AGENTS.md",
      hook: "~/.codex/hooks.json",
      // Codex MCP is managed through `codex mcp`, not TOML editing.
      mcp: "~/.codex/config.toml",
      skill: ".codex/skills/",
    },
    writeMode: "append",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    category: "cli",
    defaultTransport: "cli",
    capabilities: { cli: CLI_GUIDANCE },
    configPaths: { rules: "GEMINI.md", skill: ".gemini/skills/" },
  },
  {
    id: "opencode",
    name: "OpenCode",
    category: "cli",
    defaultTransport: "cli",
    capabilities: { cli: CLI_GUIDANCE },
    configPaths: { rules: ".opencode/rules.md", skill: ".opencode/skills/" },
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    category: "cli",
    defaultTransport: "mcp",
    capabilities: { cli: CLI_GUIDANCE, mcp: MCP_WITH_RULES },
    configPaths: { rules: ".qwen/rules.md", mcp: ".qwen/mcp.json" },
  },
  {
    id: "warp",
    name: "Warp",
    category: "cli",
    defaultTransport: "cli",
    capabilities: { cli: CLI_GUIDANCE },
    configPaths: { rules: ".warp/rules.md", skill: ".warp/skills/" },
  },
  {
    id: "auggie-cli",
    name: "Auggie CLI",
    category: "cli",
    defaultTransport: "cli",
    capabilities: { cli: CLI_GUIDANCE },
    configPaths: { rules: ".auggie/rules.md", skill: ".auggie/skills/" },
  },

  // AI IDEs (6)
  {
    id: "cursor",
    name: "Cursor",
    category: "ai-ide",
    defaultTransport: "cli",
    capabilities: { cli: CLI_GUIDANCE, mcp: MCP_WITH_SKILL },
    configPaths: {
      rules: ".cursor/rules/lcm.mdc",
      mcp: ".cursor/mcp.json",
      skill: ".cursor/skills/",
    },
    header: "---\ndescription: lcm Memory\nalwaysApply: true\n---",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    category: "ai-ide",
    defaultTransport: "cli",
    capabilities: { cli: CLI_GUIDANCE },
    configPaths: { rules: ".windsurf/rules/lcm.md", skill: ".windsurf/skills/" },
    header: "---\ntrigger: always_on\n---",
  },
  {
    id: "zed",
    name: "Zed",
    category: "ai-ide",
    defaultTransport: "mcp",
    capabilities: { cli: CLI_GUIDANCE, mcp: MCP_WITH_RULES },
    configPaths: { rules: "agent-context.rules", mcp: ".zed/settings.json" },
  },
  {
    id: "trae",
    name: "Trae.ai",
    category: "ai-ide",
    defaultTransport: "cli",
    capabilities: { cli: CLI_GUIDANCE },
    configPaths: { rules: ".trae/rules/lcm.md", skill: ".trae/skills/" },
  },
  {
    id: "qoder",
    name: "Qoder",
    category: "ai-ide",
    defaultTransport: "cli",
    capabilities: { cli: CLI_GUIDANCE },
    configPaths: { rules: ".qoder/rules/lcm.md", skill: ".qoder/skills/" },
    header: "---\ntrigger: always_on\nalwaysApply: true\n---",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    category: "ai-ide",
    defaultTransport: "cli",
    capabilities: { cli: CLI_GUIDANCE },
    configPaths: { rules: ".antigravity/rules.md", skill: ".antigravity/skills/" },
  },

  // VS Code Extensions (8)
  {
    id: "cline",
    name: "Cline",
    category: "vscode-ext",
    defaultTransport: "cli",
    capabilities: { cli: CLI_RULES },
    configPaths: { rules: ".clinerules/lcm.md" },
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    category: "vscode-ext",
    defaultTransport: "cli",
    capabilities: { cli: CLI_GUIDANCE },
    configPaths: { rules: ".github/copilot-instructions.md", skill: ".github/skills/" },
    writeMode: "append",
  },
  {
    id: "roo-code",
    name: "Roo Code",
    category: "vscode-ext",
    defaultTransport: "cli",
    capabilities: { cli: CLI_GUIDANCE },
    configPaths: { rules: ".roo/rules/lcm.md", skill: ".roo/skills/" },
  },
  {
    id: "kilo-code",
    name: "Kilo Code",
    category: "vscode-ext",
    defaultTransport: "cli",
    capabilities: { cli: CLI_GUIDANCE },
    configPaths: { rules: ".kilo/rules/lcm.md", skill: ".kilo/skills/" },
  },
  {
    id: "augment-code",
    name: "Augment Code",
    category: "vscode-ext",
    defaultTransport: "cli",
    capabilities: { cli: CLI_RULES },
    configPaths: { rules: ".augment/rules.md" },
    header: "---\ntype: \"always_apply\"\n---",
  },
  {
    id: "amp",
    name: "Amp",
    category: "vscode-ext",
    defaultTransport: "cli",
    capabilities: { cli: CLI_GUIDANCE },
    configPaths: { rules: ".amp/rules/lcm.md", skill: ".amp/skills/" },
  },
  {
    id: "kiro",
    name: "Kiro",
    category: "vscode-ext",
    defaultTransport: "cli",
    capabilities: { cli: CLI_GUIDANCE },
    configPaths: { rules: ".kiro/steering/lcm.md", skill: ".kiro/skills/" },
    header: "---\ninclusion: always\n---",
  },
  {
    id: "junie",
    name: "Junie",
    category: "vscode-ext",
    defaultTransport: "cli",
    capabilities: { cli: CLI_GUIDANCE },
    configPaths: { rules: ".junie/rules/lcm.md", skill: ".junie/skills/" },
  },

  // Other (1)
  {
    id: "openclaw",
    name: "OpenClaw",
    category: "other",
    defaultTransport: "cli",
    capabilities: { cli: CLI_SKILL },
    configPaths: { skill: ".openclaw/skills/" },
  },
];

export interface ResolveAgentTransportOptions {
  readonly configPath?: string;
}

export interface ResolvedAgentTransport {
  readonly agent: Agent;
  readonly transport: ConnectorTransport;
  readonly source: "explicit" | "stored" | "default";
}

function isTransport(value: unknown): value is ConnectorTransport {
  return typeof value === "string" && (CONNECTOR_TRANSPORTS as readonly string[]).includes(value);
}

/** Resolve one agent's transport using explicit > stored > registry precedence. */
export function resolveAgentTransport(
  idOrName: string,
  explicitTransport?: ConnectorTransport,
  options: ResolveAgentTransportOptions = {},
): ResolvedAgentTransport {
  const agent = findAgent(idOrName);
  if (!agent) throw new Error(`Unknown agent: ${idOrName}`);

  if (explicitTransport !== undefined) {
    if (!isTransport(explicitTransport)) {
      throw new Error(`Unsupported connector transport ${JSON.stringify(explicitTransport)}; choose cli or mcp`);
    }
    if (agent.capabilities[explicitTransport] === undefined) {
      throw new Error(`Agent "${agent.name}" does not support connector transport "${explicitTransport}"`);
    }
    return { agent, transport: explicitTransport, source: "explicit" };
  }

  const stored = readConnectorTransport(options.configPath ?? defaultConfigPath(), agent.id);
  if (stored !== undefined) {
    if (agent.capabilities[stored] === undefined) {
      throw new Error(`Stored connector transport "${stored}" is unsupported for agent "${agent.name}"`);
    }
    return { agent, transport: stored, source: "stored" };
  }
  return { agent, transport: agent.defaultTransport, source: "default" };
}

export function findAgent(idOrName: string): Agent | undefined {
  const lower = idOrName.toLowerCase();
  return AGENTS.find((agent) => agent.id === lower || agent.name.toLowerCase() === lower);
}

export function getAgentsByCategory(category: AgentCategory): Agent[] {
  return AGENTS.filter((agent) => agent.category === category);
}
