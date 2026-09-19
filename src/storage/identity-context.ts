import type { ResolvedStorageConfig } from "../daemon/config.js";
import { requireMachineIdentity } from "../machine-identity.js";
import type { BoundProjectIdentity, ProjectIdentity } from "../project-map.js";
import type { StorageIdentityContext } from "./contracts.js";

export class StorageIdentityConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageIdentityConfigurationError";
  }
}

/**
 * An unbound PostgreSQL project failure transported across the daemon HTTP
 * boundary (HTTP 409 with the unbound-project reason).
 *
 * Deliberately not a StorageIdentityConfigurationError: promote --all
 * rethrows that class as a machine-wide identity/publication admission stop
 * (pinned by test/bin/lcm-run-cli.test.ts), while a transported failure is
 * a per-project condition that carries the same static remedy.
 */
export class TransportedUnboundProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportedUnboundProjectError";
  }
}

export const UNBOUND_POSTGRESQL_PROJECT_MESSAGE =
  "local project has no PostgreSQL binding; from the affected project directory, "
  + "run `lcm project create` or `lcm project link <project-id>`";

export const STORAGE_IDENTITY_REQUIRED_ERROR_CODE = "STORAGE_IDENTITY_REQUIRED" as const;

export const STORAGE_IDENTITY_REQUIRED_UNBOUND_REASON = "unbound-postgresql-project" as const;

export const STORAGE_IDENTITY_REQUIRED_MACHINE_REASON = "machine-identity-unavailable" as const;

export type StorageIdentityRequiredReason =
  | typeof STORAGE_IDENTITY_REQUIRED_UNBOUND_REASON
  | typeof STORAGE_IDENTITY_REQUIRED_MACHINE_REASON;

export function resolveStorageIdentityContext(
  config: Extract<ResolvedStorageConfig, { backend: "sqlite" }>,
  local: ProjectIdentity,
  homeDir?: string,
  selectedPath?: string,
): StorageIdentityContext & { readonly localProjectId: string };
export function resolveStorageIdentityContext(
  config: Extract<ResolvedStorageConfig, { backend: "postgresql" }>,
  local: BoundProjectIdentity,
  homeDir?: string,
  selectedPath?: string,
): StorageIdentityContext & { readonly localProjectId: string };
export function resolveStorageIdentityContext(
  config: ResolvedStorageConfig,
  local: ProjectIdentity,
  homeDir?: string,
  selectedPath?: string,
): StorageIdentityContext & { readonly localProjectId: string } {
  if (config.backend === "sqlite") {
    return {
      ...local,
      id: local.id,
      localProjectId: local.id,
    };
  }
  if (!local.remoteProjectId) {
    throw new StorageIdentityConfigurationError(
      UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
    );
  }
  const machine = requireMachineIdentity(homeDir);
  return {
    id: local.remoteProjectId,
    localProjectId: local.id,
    canonical: local.canonical,
    remoteProjectId: local.remoteProjectId,
    machineId: machine.machineId,
    ...(selectedPath === undefined ? {} : { selectedPath }),
  };
}

/**
 * Resolve PostgreSQL storage identity for a maybe-unbound project identity.
 *
 * Refuses loudly with the static unbound-project remedy instead of letting
 * the caller degrade into a permanent unbound refusal. Call sites that hold
 * only a hook-durability or otherwise unbound identity cannot pass it to
 * the postgresql overload directly; they go through here explicitly.
 */
export function resolveBoundStorageIdentityContext(
  config: Extract<ResolvedStorageConfig, { backend: "postgresql" }>,
  local: ProjectIdentity,
  homeDir?: string,
  selectedPath?: string,
): StorageIdentityContext & { readonly localProjectId: string } {
  const remoteProjectId = local.remoteProjectId;
  if (remoteProjectId === undefined) {
    throw new StorageIdentityConfigurationError(
      UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
    );
  }
  const bound: BoundProjectIdentity = {
    id: local.id,
    canonical: local.canonical,
    remoteProjectId,
  };
  return resolveStorageIdentityContext(config, bound, homeDir, selectedPath);
}
