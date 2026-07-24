import type { ResolvedStorageConfig } from "../daemon/config.js";
import { requireMachineIdentity } from "../machine-identity.js";
import type { ProjectIdentity } from "../project-map.js";
import type { StorageIdentityContext } from "./contracts.js";

export class StorageIdentityConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageIdentityConfigurationError";
  }
}

export function resolveStorageIdentityContext(
  config: ResolvedStorageConfig,
  local: ProjectIdentity,
  homeDir?: string,
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
      `local project ${local.id} has no PostgreSQL binding; run \`lcm project create ${local.canonical}\` or \`lcm project link <project-id> ${local.canonical}\``,
    );
  }
  const machine = requireMachineIdentity(homeDir);
  return {
    id: local.remoteProjectId,
    localProjectId: local.id,
    canonical: local.canonical,
    remoteProjectId: local.remoteProjectId,
    machineId: machine.machineId,
  };
}
