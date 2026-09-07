import type { BackendDiagnosticSnapshot } from "../storage/diagnostics.js";

export interface CheckResult {
  name: string;
  category: string;
  status: "pass" | "warn" | "fail" | "skip";
  message: string;
  backendDiagnostics?: BackendDiagnosticSnapshot;
}

export interface DoctorDeps {
  collectBackendSnapshot: (homeDir: string) => Promise<BackendDiagnosticSnapshot>;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: string) => string;
  spawnSync: (cmd: string, args: string[], opts?: object) => { status: number | null; stdout: string; stderr: string };
  fetch: typeof globalThis.fetch;
  homedir: string;
  platform: NodeJS.Platform;
  cwd?: string;
  /** Internal deterministic seam for the Linux managed-daemon executable path. */
  managedDaemonPath?: string;
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
  /** Internal packaged runtime digest seam used by deterministic tests. */
  _expectedRuntimeDigestForTesting?: string;
  /** Test seam for transport-aware Claude guidance validation. */
  _claudeTransport?: "cli" | "mcp";
  renderClaudeSkill?: (transport: "cli" | "mcp") => string;
}
