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
  platform: NodeJS.Platform;
  cwd?: string;
  /** Internal deterministic seam for the Linux managed-daemon executable path. */
  managedDaemonPath?: string;
  /** Internal deterministic seam for exercising MCP handshake failures. */
  _testMcpHandshake?: () => Promise<CheckResult>;
  /**
   * Internal seam replacing the lock-free raw config snapshot reader inside
   * the single production admission path. Tests use it to inject config bytes
   * and deterministic descriptor witnesses.
   */
  _readDaemonConfigRawSnapshot?: typeof import("../daemon/config.js").readDaemonConfigRawSnapshot;
  /**
   * Internal seam replacing the lock-free publication read admission inside
   * the single production admission path.
   */
  _assertPublicationReadAccess?: typeof import("../storage/backend-publication.js").assertBackendPublicationConfigReadAccess;
  /** Internal seam invoked between the two lock-free config snapshots. */
  _betweenConfigSnapshotsForTesting?: () => void;
  /** Internal seam for the LCM root shape inspection used by deterministic tests. */
  _lstatLcmRootForTesting?: typeof import("node:fs").lstatSync;
  /** Internal seam invoked between the two convergence stage attempts. */
  _betweenConvergenceAttemptsForTesting?: () => void;
  /** Internal convergence clock seam used by deterministic publication tests. */
  _publicationConvergenceNow?: () => number;
  /** Internal convergence wait seam used by deterministic publication tests. */
  _publicationConvergenceSleep?: (delayMs: number) => Promise<void>;
  /** Internal lock-owner reader seam used by deterministic convergence tests. */
  _readPrivateMutationLockOwnerForTesting?: typeof import("../private-mutation-lock.js").readPrivateMutationLockOwner;
  /** Internal process-birth reader seam used by deterministic convergence tests. */
  _processStartTimeForTesting?: typeof import("../private-mutation-lock.js").processStartTime;
  /** Internal packaged runtime digest seam used by deterministic tests. */
  _expectedRuntimeDigestForTesting?: string;
  /** Test seam for transport-aware Claude guidance repair. */
  _claudeTransport?: "cli" | "mcp";
  renderClaudeSkill?: (transport: "cli" | "mcp") => string;
}
