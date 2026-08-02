import { readFileSync } from "node:fs";

import {
  parseLlmRequestPolicyConfig,
  parseStoredConfig,
  type LlmRequestPolicyConfig,
  type SecurityConfig,
  type StorageBackend,
} from "./daemon/config.js";
import {
  assertBackendPublicationConfigAccess,
  assertBackendPublicationConsumerAccess,
  backendPublicationHomeForConfigPath,
  withBackendPublicationConfigLock,
} from "./storage/backend-publication.js";

export type StoredConfigProjection = {
  daemonPort: number;
  storage: { backend: StorageBackend };
  security: SecurityConfig;
};

function readStoredConfig(path: string): {
  readonly content: string;
  readonly observedContent: string | null;
} {
  try {
    const content = readFileSync(path, "utf8");
    return { content, observedContent: content };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { content: "{}", observedContent: null };
  }
}

/**
 * Load persisted settings that local-only consumers can use without resolving
 * environment-only secrets for a remote storage backend.
 */
export function loadStoredConfigProjection(path: string): StoredConfigProjection {
  return withBackendPublicationConfigLock(path, () => {
    const publicationHome = backendPublicationHomeForConfigPath(path);
    if (publicationHome !== undefined) {
      assertBackendPublicationConsumerAccess({ homeDir: publicationHome });
    }
    const { content, observedContent } = readStoredConfig(path);
    const stored = parseStoredConfig(content);
    const daemon = stored.daemon as { port?: number } | undefined;
    const storage = stored.storage as { backend?: StorageBackend } | undefined;
    const security = stored.security as Partial<SecurityConfig> | undefined;
    const projection: StoredConfigProjection = {
      daemonPort: daemon?.port ?? 3737,
      storage: { backend: storage?.backend ?? "sqlite" },
      security: {
        sensitivePatterns: security?.sensitivePatterns ?? [],
        ...(security?.notify_on_filter === undefined
          ? {}
          : { notify_on_filter: security.notify_on_filter }),
      },
    };
    assertBackendPublicationConfigAccess(
      path,
      projection.storage.backend,
      observedContent,
    );
    return projection;
  });
}

/** Load hook-only LLM policy settings without resolving storage credentials. */
export function loadStoredLlmRequestPolicyConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
): LlmRequestPolicyConfig {
  return withBackendPublicationConfigLock(path, () => {
    const publicationHome = backendPublicationHomeForConfigPath(path);
    if (publicationHome !== undefined) {
      assertBackendPublicationConsumerAccess({ homeDir: publicationHome });
    }
    const { content, observedContent } = readStoredConfig(path);
    const stored = parseStoredConfig(content);
    const storage = stored.storage as { backend?: StorageBackend } | undefined;
    assertBackendPublicationConfigAccess(
      path,
      storage?.backend ?? "sqlite",
      observedContent,
    );
    return parseLlmRequestPolicyConfig(content, env);
  });
}
