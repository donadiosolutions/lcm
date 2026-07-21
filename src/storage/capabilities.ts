import type { StorageBackendName, StorageCapabilities } from "./contracts.js";
import { StorageOperationError } from "./errors.js";

export type BooleanStorageCapability = "transactions" | "lexicalSearch" | "regexSearch";
export type StorageCapability = BooleanStorageCapability | "nativeFullTextSearch";

export function sqliteStorageCapabilities(nativeFullTextSearch: boolean | "unknown"): StorageCapabilities {
  return Object.freeze({
    transactions: true,
    lexicalSearch: true,
    regexSearch: true,
    nativeFullTextSearch: nativeFullTextSearch === "unknown"
      ? "unknown" as const
      : nativeFullTextSearch ? "available" as const : "unavailable" as const,
    coordination: "local" as const,
  });
}

export function requireStorageCapability(
  capabilities: StorageCapabilities,
  capability: StorageCapability,
  backend: StorageBackendName,
  projectId?: string,
): void {
  if (capability === "nativeFullTextSearch") {
    if (capabilities.nativeFullTextSearch === "available") return;
  } else if (capabilities[capability]) {
    return;
  }
  throw new StorageOperationError(
    "STORAGE_UNSUPPORTED_CAPABILITY",
    backend,
    projectId,
    "factory",
    capability,
  );
}
