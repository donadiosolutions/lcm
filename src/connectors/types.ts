/** Public connector installation transports. */
export const CONNECTOR_TRANSPORTS = ["cli", "mcp"] as const;
export type ConnectorTransport = (typeof CONNECTOR_TRANSPORTS)[number];

/** Internal surfaces used to compose a transport bundle. */
export const CONNECTOR_SURFACES = ["rules", "hook", "mcp", "skill"] as const;
export type ConnectorSurface = (typeof CONNECTOR_SURFACES)[number];
export const CONNECTOR_GUIDANCE = ["skill", "rules"] as const;
export type ConnectorGuidance = (typeof CONNECTOR_GUIDANCE)[number];

export interface ConnectorCapabilities {
  /** Ordered guidance preference; the first configured surface wins. */
  readonly guidance: readonly ConnectorGuidance[];
  /** Whether the agent has an LCM-native lifecycle-hook integration. */
  readonly nativeHook?: boolean;
  /** Whether this transport has a verifiable native MCP adapter. */
  readonly mcpAdapter?: boolean;
}

export type AgentCategory = 'cli' | 'ai-ide' | 'vscode-ext' | 'other';

export interface Agent {
  id: string;
  name: string;
  category: AgentCategory;
  defaultTransport: ConnectorTransport;
  capabilities: Readonly<{
    cli: ConnectorCapabilities;
    mcp?: ConnectorCapabilities;
  }>;
  configPaths: Partial<Record<ConnectorSurface, string>>;
  writeMode?: 'append' | 'overwrite'; // default: 'overwrite'
  header?: string; // YAML frontmatter for rules files
}

/**
 * Whether a transport bundle needs an agent restart to take effect.
 * Both supported transports can install a skill, native hook, or MCP server.
 */
export function requiresRestart(transport: ConnectorTransport): boolean {
  return CONNECTOR_TRANSPORTS.includes(transport);
}
