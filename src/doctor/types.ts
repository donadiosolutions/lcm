export interface CheckResult {
  name: string;
  category: string;
  status: "pass" | "warn" | "fail" | "skip";
  message: string;
  fixApplied?: boolean;
}

export interface DoctorDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, content: string) => void;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  lstatSync?: typeof import("node:fs").lstatSync;
  readdirSync?: typeof import("node:fs").readdirSync;
  spawnSync: (cmd: string, args: string[], opts?: object) => { status: number | null; stdout: string; stderr: string };
  fetch: typeof globalThis.fetch;
  homedir: string;
  platform: string;
  cwd?: string;
  /** Internal deterministic seam for the Linux managed-daemon executable path. */
  managedDaemonPath?: string;
  /** Internal deterministic seam for exercising MCP handshake failures. */
  _testMcpHandshake?: () => Promise<CheckResult>;
  /** Internal seam for testing backend-publication admission independently. */
  _assertBackendPublication?: (homeDir: string, backend: "sqlite" | "postgresql") => void;
  /** Internal bounded config-read seam used by deterministic doctor tests. */
  _readBoundedConfig?: (path: string, maxBytes: number) => string;
  /** Internal convergence clock seam used by deterministic publication tests. */
  _publicationConvergenceNow?: () => number;
  /** Internal convergence wait seam used by deterministic publication tests. */
  _publicationConvergenceSleep?: (delayMs: number) => Promise<void>;
  /** Internal packaged runtime digest seam used by deterministic tests. */
  _expectedRuntimeDigestForTesting?: string;
  /** Test seam for transport-aware Claude guidance repair. */
  _claudeTransport?: "cli" | "mcp";
  renderClaudeSkill?: (transport: "cli" | "mcp") => string;
}
