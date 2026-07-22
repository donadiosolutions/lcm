import { readFileSync } from "node:fs";

import {
  parseLlmRequestPolicyConfig,
  parseStoredConfig,
  type LlmRequestPolicyConfig,
  type SecurityConfig,
  type StorageBackend,
} from "./daemon/config.js";

export type StoredConfigProjection = {
  daemonPort: number;
  storage: { backend: StorageBackend };
  security: SecurityConfig;
};

function readStoredConfig(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "{}";
  }
}

/**
 * Load persisted settings that local-only consumers can use without resolving
 * environment-only secrets for a remote storage backend.
 */
export function loadStoredConfigProjection(path: string): StoredConfigProjection {
  const stored = parseStoredConfig(readStoredConfig(path));
  const daemon = stored.daemon as { port?: number } | undefined;
  const storage = stored.storage as { backend?: StorageBackend } | undefined;
  const security = stored.security as Partial<SecurityConfig> | undefined;
  return {
    daemonPort: daemon?.port ?? 3737,
    storage: { backend: storage?.backend ?? "sqlite" },
    security: {
      sensitivePatterns: security?.sensitivePatterns ?? [],
      ...(security?.notify_on_filter === undefined
        ? {}
        : { notify_on_filter: security.notify_on_filter }),
    },
  };
}

/** Load hook-only LLM policy settings without resolving storage credentials. */
export function loadStoredLlmRequestPolicyConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
): LlmRequestPolicyConfig {
  return parseLlmRequestPolicyConfig(readStoredConfig(path), env);
}
