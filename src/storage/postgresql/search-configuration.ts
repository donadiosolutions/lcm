import type { QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlQueryExecutor,
  PostgreSqlSearchConfigurationStatus,
} from "./contracts.js";

export const POSTGRESQL_SEARCH_CONFIGURATION = "lcm.search_v1";
export const POSTGRESQL_SEARCH_CONFIGURATION_SHA256 =
  "2ffff1a443e48f12879e1fd2b6e47a05ba93d5cd0ae828171ffe84146f5e5dfc";

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
           mapping_contract AS (
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
           ),
           configuration_contract AS (
             SELECT pg_catalog.count(maptokentype) AS mapping_count,
                    pg_catalog.count(DISTINCT oid) AS configuration_count,
                    pg_catalog.min(cfgparser) AS parser_oid,
                    pg_catalog.string_agg(
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
                    ) FILTER (WHERE maptokentype IS NOT NULL) AS mappings,
                    pg_catalog.bool_and(config_owned AND dictionary_owned)
                      AS configuration_owned
             FROM mapping_contract
           ),
           function_contract AS (
             SELECT pg_catalog.count(*) AS function_count,
                    pg_catalog.min(pg_catalog.pg_get_functiondef(procedure.oid))
                      AS function_definition,
                    pg_catalog.bool_and(
                      procedure.proowner OPERATOR(pg_catalog.=) namespace.nspowner
                    ) AS function_owned,
                    pg_catalog.bool_and(NOT procedure.prosecdef) AS function_invoker,
                    pg_catalog.bool_and(
                      EXISTS (
                        SELECT 1
                        FROM pg_catalog.aclexplode(
                          COALESCE(
                            procedure.proacl,
                            pg_catalog.acldefault('f', procedure.proowner)
                          )
                        ) AS owner_privilege
                        WHERE owner_privilege.grantee
                                OPERATOR(pg_catalog.=) procedure.proowner
                          AND owner_privilege.grantor
                                OPERATOR(pg_catalog.=) procedure.proowner
                          AND owner_privilege.privilege_type
                                OPERATOR(pg_catalog.=) 'EXECUTE'
                          AND owner_privilege.is_grantable
                                OPERATOR(pg_catalog.=) false
                      )
                      AND NOT EXISTS (
                        SELECT 1
                        FROM pg_catalog.aclexplode(
                          COALESCE(
                            procedure.proacl,
                            pg_catalog.acldefault('f', procedure.proowner)
                          )
                        ) AS privilege
                        WHERE privilege.grantee OPERATOR(pg_catalog.=) 0::pg_catalog.oid
                           OR privilege.grantor
                                OPERATOR(pg_catalog.<>) procedure.proowner
                           OR privilege.privilege_type
                                OPERATOR(pg_catalog.<>) 'EXECUTE'
                           OR privilege.is_grantable
                                OPERATOR(pg_catalog.<>) false
                      )
                    ) AS function_acl_ready,
                    pg_catalog.min(
                      COALESCE(pg_catalog.array_to_string(procedure.proconfig, E'\\n'), '')
                    ) AS function_config
             FROM pg_catalog.pg_proc AS procedure
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) procedure.pronamespace
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND procedure.proname OPERATOR(pg_catalog.=) 'normalize_search_text'
               AND procedure.proargtypes OPERATOR(pg_catalog.=)
                 '25'::pg_catalog.oidvector
           )
           SELECT CASE WHEN configuration_contract.mapping_count
                              OPERATOR(pg_catalog.=) 19
                         AND configuration_contract.configuration_count
                              OPERATOR(pg_catalog.=) 1
                         AND function_contract.function_count
                              OPERATOR(pg_catalog.=) 1
                    THEN pg_catalog.encode(
                      public.digest(
                        pg_catalog.convert_to(
                          'parser=' OPERATOR(pg_catalog.||)
                            configuration_contract.parser_oid::text
                          OPERATOR(pg_catalog.||) E'\\n'
                          OPERATOR(pg_catalog.||) configuration_contract.mappings
                          OPERATOR(pg_catalog.||) E'\\nfunction_definition='
                          OPERATOR(pg_catalog.||) function_contract.function_definition
                          OPERATOR(pg_catalog.||) E'\\nfunction_owner='
                          OPERATOR(pg_catalog.||) function_contract.function_owned::text
                          OPERATOR(pg_catalog.||) E'\\nfunction_security_invoker='
                          OPERATOR(pg_catalog.||) function_contract.function_invoker::text
                          OPERATOR(pg_catalog.||) E'\\nfunction_config='
                          OPERATOR(pg_catalog.||) function_contract.function_config,
                          'UTF8'
                        ),
                        'sha256'
                      ),
                      'hex'
                    )
                    ELSE NULL
                  END AS actual_sha256,
                  configuration_contract.mapping_count::text AS object_count,
                  COALESCE(
                    configuration_contract.configuration_owned
                    AND function_contract.function_owned
                    AND function_contract.function_acl_ready,
                    false
                  ) AS ownership_ready
           FROM configuration_contract
           CROSS JOIN function_contract`,
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
