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
  version: string | undefined;
  storageBackend: "sqlite" | "postgresql";
  entrypoint: string | undefined;
  runtimeDigest: string | undefined;
}>;

export type PublicationConvergenceDeps = Readonly<{
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  readToken?: () => string | null;
  readOwner?: typeof readPrivateMutationLockOwner;
  processBirth?: typeof processStartTime;
  platform?: NodeJS.Platform;
  lockPath?: string;
  homeDir?: string;
}>;

export type PublicationConvergence = Readonly<{
  identity: PublicationDaemonIdentity | undefined;
  port: number;
  expectedRuntimeDigest: string | undefined;
  expectedEntrypoint: string | undefined;
  deps: PublicationConvergenceDeps;
}> & { /** @internal Mutable only inside this module. */ deadline?: number };

function healthMatches(
  health: PublicationDaemonHealth | null,
  identity: PublicationDaemonIdentity,
  expectedRuntimeDigest: string | undefined,
  expectedEntrypoint: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  return health !== null
    && health.status === "ok"
    && health.pid === identity.pid
    && health.version === identity.version
    && (health.storageBackend ?? "sqlite") === identity.storageBackend
    && daemonEntrypointMatches(health.entrypoint, expectedEntrypoint, platform)
    && (expectedRuntimeDigest === undefined || health.runtimeDigest === expectedRuntimeDigest);
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
    || (input.expectedRuntimeDigest !== undefined && health.runtimeDigest !== input.expectedRuntimeDigest)
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
  expectedRuntimeDigest?: string;
  expectedEntrypoint?: string;
  deps?: PublicationConvergenceDeps;
}>): PublicationConvergence {
  return {
    identity: input.identity,
    port: input.port,
    expectedRuntimeDigest: input.expectedRuntimeDigest,
    expectedEntrypoint: input.expectedEntrypoint,
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
): Promise<number | undefined> {
  if (!(error instanceof PrivateMutationLockContentionError) || convergence.identity === undefined) return undefined;
  const now = convergence.deps.now ?? Date.now;
  const existingDeadline = currentDeadline(convergence);
  if (existingDeadline !== undefined && now() >= existingDeadline) return undefined;
  const ownerReader = convergence.deps.readOwner ?? readPrivateMutationLockOwner;
  const lockPath = convergence.deps.lockPath
    ?? (convergence.deps.homeDir === undefined ? undefined : join(convergence.deps.homeDir, ".lcm.backend-publication.lock"));
  if (lockPath === undefined) return undefined;
  let owner;
  try { owner = ownerReader(lockPath, "backend publication"); } catch { return undefined; }
  if (owner === null || owner.pid !== convergence.identity.pid || owner.processStartTime === null) return undefined;
  const deadline = existingDeadline ?? now() + PUBLICATION_CONVERGENCE_MS;
  const remainingBirth = deadline - now();
  if (remainingBirth <= 0) return undefined;
  let birth: string | null;
  try {
    birth = (convergence.deps.processBirth ?? processStartTime)(owner.pid, undefined, { timeoutMs: remainingBirth });
  } catch {
    return undefined;
  }
  if (birth !== owner.processStartTime) return undefined;
  const remainingHealth = deadline - now();
  if (remainingHealth <= 0) return undefined;
  const health = await authenticatedHealth(convergence.deps, convergence.port, Math.min(2_000, remainingHealth));
  if (!healthMatches(health, convergence.identity, convergence.expectedRuntimeDigest, convergence.expectedEntrypoint, convergence.deps.platform ?? process.platform)) return undefined;
  if (now() >= deadline) return undefined;
  convergence.deadline = deadline;
  const delay = Math.min(PUBLICATION_CONVERGENCE_POLL_MS, Math.max(1, deadline - now()));
  return delay;
}

export async function withPublicationAdmissionRetry<T>(
  run: () => T | Promise<T>,
  convergence: PublicationConvergence | undefined,
): Promise<T> {
  if (convergence === undefined) return await run();
  let firstContention: PrivateMutationLockContentionError | undefined;
  while (true) {
    const deadline = currentDeadline(convergence);
    if (firstContention !== undefined && deadline !== undefined && (convergence.deps.now ?? Date.now)() >= deadline) throw firstContention;
    try {
      return await run();
    } catch (error) {
      const delay = await retryDelay(convergence, error);
      if (delay === undefined) {
        throw firstContention !== undefined && error instanceof PrivateMutationLockContentionError
          ? firstContention
          : error;
      }
      firstContention ??= error as PrivateMutationLockContentionError;
      await (convergence.deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))))(delay);
    }
  }
}
