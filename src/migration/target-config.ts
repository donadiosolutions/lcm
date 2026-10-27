import {
  readDaemonConfigRawSnapshot,
  resolvePostgreSqlStorageSettings,
  validateStorageSection,
  ConfigValidationError,
  type ResolvedPostgreSqlConfig,
} from "../daemon/config.js";

/**
 * Resolves the PostgreSQL migration target **independent of the currently
 * active `storage.backend`**, per the root's ruling on this item: `storage.backend`
 * names which backend is active; `storage.postgresql` (plus its
 * `LCM_POSTGRES_*` fallbacks) names how to reach PostgreSQL, and migration
 * commands read the latter regardless of the former. `resolveStorageConfig`
 * itself must keep gating on the active backend for every other caller
 * (issue #627's scope exclusion: SQLite stays the zero-configuration
 * default, and nothing on the ordinary storage path may silently reach
 * PostgreSQL) -- so this function exists specifically, and only, to be the
 * one place that bypasses that gate, reusing `resolveStorageConfig`'s own
 * validation (`validateStorageSection`, `resolvePostgreSqlStorageSettings`)
 * verbatim rather than re-deriving it.
 *
 * **Scope, binding:** this module is reachable only from the `lcm migration`
 * command surface. It must never be imported from `loadIdentityStorageConfig`,
 * from anything on the ordinary storage/daemon path, or exposed as a
 * general-purpose config accessor a future caller might reasonably assume
 * is safe to reuse outside migration. If you are reading this because you
 * want PostgreSQL connection settings for something that is not `lcm
 * migration plan|dry-run|apply|resume|verify|report|abort`, this is very likely the wrong
 * function -- use `resolveStorageConfig` (or `loadIdentityStorageConfig`)
 * instead, which correctly refuses while sqlite is active.
 */

export type MigrationTargetResolution =
  | Readonly<{ status: "resolved"; config: ResolvedPostgreSqlConfig }>
  | Readonly<{ status: "refuse"; reason: "migration-target-missing" | "migration-target-unresolvable"; evidence?: string }>;

export type MigrationTargetConfigOperations = Readonly<{
  readRawSnapshot: typeof readDaemonConfigRawSnapshot;
  validateStorageSection: typeof validateStorageSection;
  resolvePostgreSqlStorageSettings: typeof resolvePostgreSqlStorageSettings;
}>;

/**
 * `configPath` is read raw (unvalidated, unnarrowed) via the same bounded,
 * descriptor-safe reader `resolveStorageConfig`'s own caller
 * (`loadDaemonConfigWithHooks`) uses, so a missing file resolves to `"{}"`
 * exactly as it does for ordinary config loading -- never a distinct
 * "file missing" special case that could drift from that behavior.
 */
export function resolveMigrationTargetConfig(
  configPath: string,
  env: Record<string, string | undefined> = process.env,
  operations: Partial<MigrationTargetConfigOperations> = {},
): MigrationTargetResolution {
  const readRawSnapshot = operations.readRawSnapshot ?? readDaemonConfigRawSnapshot;
  const validate = operations.validateStorageSection ?? validateStorageSection;
  const resolveSettings = operations.resolvePostgreSqlStorageSettings ?? resolvePostgreSqlStorageSettings;
  let raw: ReturnType<typeof readDaemonConfigRawSnapshot>;
  try {
    raw = readRawSnapshot(configPath);
  } catch (error) {
    return {
      status: "refuse",
      reason: "migration-target-unresolvable",
      evidence: error instanceof Error ? error.name : "unknown-config-read-failure",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.content);
  } catch {
    return { status: "refuse", reason: "migration-target-unresolvable", evidence: "config-malformed-json" };
  }

  const storageValue = (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
    ? ((parsed as Record<string, unknown>).storage ?? {})
    : {};

  try {
    validate(storageValue, true);
    const postgresql = resolveSettings(storageValue as Record<string, unknown>, env);
    return { status: "resolved", config: { backend: "postgresql", postgresql } };
  } catch (error) {
    // ConfigValidationError's message embeds the failing config path and a
    // worked example (config.ts:709-714) -- exactly the dynamic, driver-style
    // text section 10 forbids in an envelope. Never surfaced; only the
    // closed reason and a static, non-message-derived evidence marker are.
    if (error instanceof ConfigValidationError) {
      return { status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" };
    }
    return {
      status: "refuse",
      reason: "migration-target-unresolvable",
      evidence: error instanceof Error ? error.name : "unknown-validation-failure",
    };
  }
}
