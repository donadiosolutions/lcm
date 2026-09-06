import { join } from "node:path";
import { daemonEntrypointMatches } from "../daemon/lifecycle-scope.js";
import { isStagedPostgreSqlHealth } from "../daemon/staged-postgresql.js";
import { PrivateMutationLockContentionError, processStartTime, readPrivateMutationLockOwner } from "../private-mutation-lock.js";

export const PUBLICATION_CONVERGENCE_MS = 2_000;
export const PUBLICATION_CONVERGENCE_POLL_MS = 50;

export type PublicationDaemonHealth = Readonly<{
  status?: string;
  pid?: number;
  version?: string;
  storageBackend?: "sqlite" | "postgresql";
  entrypoint?: string;
  runtimeDigest?: string;
}>;

export type PublicationDaemonIdentity = Readonly<{
  pid: number;
  version: string;
  storageBackend: "sqlite" | "postgresql";
  entrypoint: string;
  runtimeDigest: string;
}>;

export type PublicationConvergenceDeps = Readonly<{
  /** Monotonic elapsed milliseconds used for publication retry deadlines. */
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  readToken?: () => string | null;
  readOwner?: typeof readPrivateMutationLockOwner;
  processBirth?: typeof processStartTime;
  platform?: NodeJS.Platform;
  lockPath?: string;
  homeDir?: string;
  /** @internal deterministic installer admission seams. */
  _readDaemonConfigRawSnapshot?: (configPath: string) => {
    content: string;
    witness: Readonly<{
      presence: "present" | "absent";
      rawSha256: string | null;
      byteLength: number;
      dev: string | null;
      ino: string | null;
      mtimeMs: number | null;
    }>;
  };
  _assertBackendPublicationConfigReadAccess?: (
    configPath: string,
    backend: "sqlite" | "postgresql",
    witness: Readonly<{
      presence: "present" | "absent";
      rawSha256: string | null;
      byteLength: number;
      dev: string | null;
      ino: string | null;
    }>,
  ) => Readonly<{ journalChecksumSha256: string | null }>;
  _expectedVersionForTesting?: string;
  _expectedEntrypointForTesting?: string;
  _expectedRuntimeDigestForTesting?: string;
}>;

export type PublicationConvergence = Readonly<{
  identity: PublicationDaemonIdentity | undefined;
  port: number;
  deps: PublicationConvergenceDeps;
}> & { /** @internal Mutable only inside this module. */ deadline?: number };

function healthMatches(
  health: PublicationDaemonHealth | null,
  identity: PublicationDaemonIdentity,
  platform: NodeJS.Platform,
): boolean {
  return health !== null
    && health.status === "ok"
    && health.pid === identity.pid
    && health.version === identity.version
    && (health.storageBackend ?? "sqlite") === identity.storageBackend
    && daemonEntrypointMatches(health.entrypoint, identity.entrypoint, platform)
    && health.runtimeDigest === identity.runtimeDigest;
}

async function authenticatedHealth(
  deps: PublicationConvergenceDeps,
  port: number,
  timeoutMs: number,
): Promise<PublicationDaemonHealth | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const token = deps.readToken?.() ?? null;
    if (token === null || deps.fetch === undefined) return null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Daemon health check timed out"));
      }, timeoutMs);
    });
    const response = await Promise.race([
      (async () => {
        const result = await deps.fetch!(`http://127.0.0.1:${port}/health`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        const health = await result.json() as PublicationDaemonHealth | null;
        if (health === null || typeof health !== "object") return null;
        return (result.ok && health.status === "ok")
          || isStagedPostgreSqlHealth(result.status, health)
          ? health : null;
      })(),
      timeout,
    ]);
    return response;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function capturePublicationIdentity(input: Readonly<{
  port: number;
  expectedVersion: string | undefined;
  expectedStorageBackend: "sqlite" | "postgresql";
  expectedEntrypoint: string | undefined;
  expectedRuntimeDigest: string | undefined;
  deps?: PublicationConvergenceDeps;
}>): Promise<PublicationDaemonIdentity | undefined> {
  if (
    input.expectedVersion === undefined
    || input.expectedEntrypoint === undefined
    || input.expectedRuntimeDigest === undefined
  ) return undefined;
  const deps = input.deps ?? {};
  const health = await authenticatedHealth(deps, input.port, 2_000);
  if (
    health === null
    || typeof health.pid !== "number"
    || !Number.isSafeInteger(health.pid)
    || health.pid <= 0
    || health.version !== input.expectedVersion
    || (health.storageBackend ?? "sqlite") !== input.expectedStorageBackend
    || !daemonEntrypointMatches(health.entrypoint, input.expectedEntrypoint, deps.platform ?? process.platform)
    || health.runtimeDigest !== input.expectedRuntimeDigest
  ) return undefined;
  return Object.freeze({
    pid: health.pid,
    version: input.expectedVersion,
    storageBackend: input.expectedStorageBackend,
    entrypoint: input.expectedEntrypoint,
    runtimeDigest: input.expectedRuntimeDigest,
  });
}

export function createPublicationConvergence(input: Readonly<{
  port: number;
  identity?: PublicationDaemonIdentity;
  deps?: PublicationConvergenceDeps;
}>): PublicationConvergence {
  return {
    identity: input.identity,
    port: input.port,
    deps: input.deps ?? {},
    deadline: undefined,
  };
}

function currentDeadline(convergence: PublicationConvergence): number | undefined {
  return convergence.deadline;
}

async function retryDelay(
  convergence: PublicationConvergence,
  error: unknown,
): Promise<number | { expired: true } | undefined> {
  if (!(error instanceof PrivateMutationLockContentionError) || convergence.identity === undefined) return undefined;
  const now = convergence.deps.now ?? performance.now.bind(performance);
  const existingDeadline = currentDeadline(convergence);
  if (existingDeadline !== undefined && now() >= existingDeadline) return { expired: true };
  const ownerReader = convergence.deps.readOwner ?? readPrivateMutationLockOwner;
  const lockPath = convergence.deps.lockPath
    ?? (convergence.deps.homeDir === undefined ? undefined : join(convergence.deps.homeDir, ".lcm.backend-publication.lock"));
  if (lockPath === undefined) return undefined;
  let owner;
  try { owner = ownerReader(lockPath, "backend publication"); } catch { return undefined; }
  if (owner === null || owner.pid !== convergence.identity.pid || owner.processStartTime === null) return undefined;
  const deadline = existingDeadline ?? now() + PUBLICATION_CONVERGENCE_MS;
  const remainingBirth = Math.floor(deadline - now());
  if (remainingBirth <= 0) return { expired: true };
  let birth: string | null;
  try {
    birth = (convergence.deps.processBirth ?? processStartTime)(owner.pid, undefined, { timeoutMs: remainingBirth });
  } catch {
    return now() >= deadline ? { expired: true } : undefined;
  }
  if (birth !== owner.processStartTime) return now() >= deadline ? { expired: true } : undefined;
  const remainingHealth = deadline - now();
  if (remainingHealth <= 0) return { expired: true };
  const health = await authenticatedHealth(convergence.deps, convergence.port, Math.min(2_000, remainingHealth));
  if (now() >= deadline) return { expired: true };
  if (!healthMatches(health, convergence.identity, convergence.deps.platform ?? process.platform)) return undefined;
  convergence.deadline = deadline;
  const delay = Math.min(PUBLICATION_CONVERGENCE_POLL_MS, Math.max(1, deadline - now()));
  return delay;
}

export async function withPublicationAdmissionRetry<T>(
  run: () => T | Promise<T>,
  convergence: PublicationConvergence | undefined,
): Promise<T> {
  if (convergence === undefined) return await run();
  const now = convergence.deps.now ?? performance.now.bind(performance);
  let firstContention: PrivateMutationLockContentionError | undefined;
  while (true) {
    const deadline = currentDeadline(convergence);
    if (firstContention !== undefined && deadline !== undefined && now() >= deadline) throw firstContention;
    try {
      return await run();
    } catch (error) {
      const delay = await retryDelay(convergence, error);
      if (delay === undefined) throw error;
      if (typeof delay !== "number") throw firstContention ?? error;
      firstContention ??= error as PrivateMutationLockContentionError;
      await (convergence.deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))))(delay);
    }
  }
}
