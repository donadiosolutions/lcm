import { dirname } from "node:path";
import {
  parseLlmRequestPolicyConfig,
  parseStoredConfig,
  type LlmRequestPolicyConfig,
  type SecurityConfig,
  type StorageBackend,
} from "./daemon/config.js";
import { OWNER_ONLY_FILE_MODES, readBoundedRegularFile } from "./security-files.js";
import {
  assertBackendPublicationConfigAccess,
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
    const content = readBoundedRegularFile(path, {
      allowedRoot: dirname(path),
      maxBytes: 4 * 1024 * 1024,
      allowedModes: OWNER_ONLY_FILE_MODES,
    });
    return {
      content,
      observedContent: content,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: "{}", observedContent: null };
    }
    throw error;
  }
}

/**
 * Load persisted settings that local-only consumers can use without resolving
 * environment-only secrets for a remote storage backend.
 */
export function loadStoredConfigProjection(path: string): StoredConfigProjection {
  return withBackendPublicationConfigLock(path, (lockToken) => {
    const file = readStoredConfig(path);
    const stored = parseStoredConfig(file.content);
    const daemon = stored.daemon as { port?: number } | undefined;
    const storage = stored.storage as { backend?: StorageBackend } | undefined;
    const security = stored.security as Partial<SecurityConfig> | undefined;
    const backend = storage?.backend ?? "sqlite";
    assertBackendPublicationConfigAccess(path, backend, file.observedContent, undefined, lockToken);
    return {
      daemonPort: daemon?.port ?? 3737,
      storage: { backend },
      security: {
        sensitivePatterns: security?.sensitivePatterns ?? [],
        ...(security?.notify_on_filter === undefined
          ? {}
          : { notify_on_filter: security.notify_on_filter }),
      },
    };
  });
}

/** Load hook-only LLM policy settings without resolving storage credentials. */
export function loadStoredLlmRequestPolicyConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
): LlmRequestPolicyConfig {
  return withBackendPublicationConfigLock(path, (lockToken) => {
    const file = readStoredConfig(path);
    const stored = parseStoredConfig(file.content);
    const backend = (stored.storage as { backend?: StorageBackend } | undefined)?.backend ?? "sqlite";
    assertBackendPublicationConfigAccess(path, backend, file.observedContent, undefined, lockToken);
    return parseLlmRequestPolicyConfig(file.content, env);
  });
}
