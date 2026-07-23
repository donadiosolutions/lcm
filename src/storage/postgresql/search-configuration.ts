import type { QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlQueryExecutor,
  PostgreSqlSearchConfigurationStatus,
} from "./contracts.js";

export const POSTGRESQL_SEARCH_CONFIGURATION = "lcm.search_v1";
export const POSTGRESQL_SEARCH_CONFIGURATION_SHA256 =
  "7461327e424809adae678114286199753a7916253ecbb5459a7f1e211b30a568";

type SearchConfigurationRow = QueryResultRow & {
  actual_sha256: string | null;
  object_count: string;
  ownership_ready: boolean | null;
};

export class PostgreSqlSearchConfigurationPreflightError extends StorageOperationError {
  constructor(
    readonly searchConfiguration: PostgreSqlSearchConfigurationStatus,
    operation: string,
  ) {
    super("STORAGE_INITIALIZATION_FAILED", "postgresql", undefined, "factory", operation);
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), searchConfiguration: this.searchConfiguration };
  }
}

export async function inspectPostgreSqlSearchConfiguration(
  executor: PostgreSqlQueryExecutor,
  options: { readonly operation?: string; readonly signal?: AbortSignal } = {},
): Promise<PostgreSqlSearchConfigurationStatus> {
  const result = await executor.query<SearchConfigurationRow>({
    text: `WITH target AS (
             SELECT configuration.oid,
                    configuration.cfgparser,
                    configuration.cfgowner,
                    namespace.oid AS namespace_oid,
                    namespace.nspowner
             FROM pg_catalog.pg_ts_config AS configuration
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) configuration.cfgnamespace
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND configuration.cfgname OPERATOR(pg_catalog.=) 'search_v1'
           ),
           contract AS (
             SELECT target.oid,
                    target.cfgparser,
                    target.cfgowner OPERATOR(pg_catalog.=) target.nspowner AS config_owned,
                    mapping.maptokentype,
                    mapping.mapseqno,
                    dictionary.dictowner OPERATOR(pg_catalog.=) target.nspowner AS dictionary_owned,
                    dictionary_namespace.nspname AS dictionary_schema,
                    dictionary.dictname,
                    dictionary.dicttemplate,
                    COALESCE(dictionary.dictinitoption, '') AS dictionary_options
             FROM target
             LEFT JOIN pg_catalog.pg_ts_config_map AS mapping
               ON mapping.mapcfg OPERATOR(pg_catalog.=) target.oid
             LEFT JOIN pg_catalog.pg_ts_dict AS dictionary
               ON dictionary.oid OPERATOR(pg_catalog.=) mapping.mapdict
             LEFT JOIN pg_catalog.pg_namespace AS dictionary_namespace
               ON dictionary_namespace.oid OPERATOR(pg_catalog.=) dictionary.dictnamespace
           )
           SELECT CASE WHEN pg_catalog.count(*) OPERATOR(pg_catalog.=) 19
                         AND pg_catalog.count(DISTINCT oid) OPERATOR(pg_catalog.=) 1
                    THEN pg_catalog.encode(
                      public.digest(
                        pg_catalog.convert_to(
                          'parser=' OPERATOR(pg_catalog.||) pg_catalog.min(cfgparser)::text
                          OPERATOR(pg_catalog.||) E'\\n'
                          OPERATOR(pg_catalog.||) pg_catalog.string_agg(
                            pg_catalog.format(
                              '%s:%s:%I.%I:%s:%s',
                              maptokentype,
                              mapseqno,
                              dictionary_schema,
                              dictname,
                              dicttemplate,
                              dictionary_options
                            ),
                            E'\\n' ORDER BY maptokentype, mapseqno
                          ),
                          'UTF8'
                        ),
                        'sha256'
                      ),
                      'hex'
                    )
                    ELSE NULL
                  END AS actual_sha256,
                  pg_catalog.count(*)::text AS object_count,
                  pg_catalog.bool_and(config_owned AND dictionary_owned) AS ownership_ready
           FROM contract`,
  }, {
    domain: "factory",
    operation: options.operation ?? "inspectSearchConfiguration",
    signal: options.signal,
  });
  const row = result.rows[0];
  const actualSha256 = row?.actual_sha256 ?? null;
  const objectCount = Number.parseInt(row?.object_count ?? "0", 10);
  const ownershipReady = row?.ownership_ready === true;
  return {
    name: POSTGRESQL_SEARCH_CONFIGURATION,
    expectedSha256: POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
    actualSha256,
    objectCount: Number.isSafeInteger(objectCount) ? objectCount : 0,
    ownershipReady,
    ready: actualSha256 === POSTGRESQL_SEARCH_CONFIGURATION_SHA256
      && objectCount === 19
      && ownershipReady,
  };
}

export async function assertPostgreSqlSearchConfigurationReady(
  executor: PostgreSqlQueryExecutor,
  options: { readonly operation?: string; readonly signal?: AbortSignal } = {},
): Promise<PostgreSqlSearchConfigurationStatus> {
  const operation = options.operation ?? "preflightSearchConfiguration";
  const status = await inspectPostgreSqlSearchConfiguration(executor, { ...options, operation });
  if (!status.ready) throw new PostgreSqlSearchConfigurationPreflightError(status, operation);
  return status;
}
