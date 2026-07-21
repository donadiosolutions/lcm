import { readFileSync } from "node:fs";
import { parseStoredConfig, type SecurityConfig, type StorageBackend } from "../daemon/config.js";

export type HookConfig = {
  daemonPort: number;
  storage: { backend: StorageBackend };
  security: SecurityConfig;
};

/**
 * Load the persisted settings hooks can safely use without resolving runtime
 * secrets for a remote storage backend.
 */
export function loadHookConfig(path: string): HookConfig {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    content = "{}";
  }

  const stored = parseStoredConfig(content);
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
