import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

const migrationMockState = vi.hoisted(() => ({
  duplicateColumnIdentity: false,
  returnNoLatestSnapshot: false,
}));

vi.mock("../../src/storage/postgresql/migrations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/storage/postgresql/migrations.js")>();
  return {
    ...actual,
    loadPostgreSqlSchemaSnapshots: () => {
      const snapshots = actual.loadPostgreSqlSchemaSnapshots();
      if (!migrationMockState.duplicateColumnIdentity) return snapshots;
      const last = snapshots.at(-1)!;
      return [
        ...snapshots.slice(0, -1),
        {
          ...last,
          columnAclIdentities: [
            ...last.columnAclIdentities,
            last.columnAclIdentities[0]!,
          ],
        },
      ];
    },
    selectLatestPostgreSqlSchemaSnapshot: (...args: Parameters<typeof actual.selectLatestPostgreSqlSchemaSnapshot>) => (
      migrationMockState.returnNoLatestSnapshot
        ? null
        : actual.selectLatestPostgreSqlSchemaSnapshot(...args)
    ),
  };
});

import type {
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
} from "../../src/storage/postgresql/contracts.js";
import {
  POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST,
  PostgreSqlRuntimeReadinessError,
  verifyPostgreSqlRuntimeSchema,
  type PostgreSqlRuntimePrivilegeEntry,
} from "../../src/storage/postgresql/runtime-readiness.js";
import {
  getPostgreSqlSchemaSnapshotExpectations,
  loadPostgreSqlMigrations,
  loadPostgreSqlSchemaSnapshots,
} from "../../src/storage/postgresql/migrations.js";
import { REQUIRED_POSTGRESQL_EXTENSIONS } from "../../src/storage/postgresql/extensions.js";
import { POSTGRESQL_SEARCH_CONFIGURATION_SHA256 } from "../../src/storage/postgresql/search-configuration.js";

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function executor(): {
  readonly seam: PostgreSqlQueryExecutor;
  readonly queries: readonly { config: unknown; options: PostgreSqlQueryOptions }[];
} {
  const queries: { config: unknown; options: PostgreSqlQueryOptions }[] = [];
  const query = vi.fn(async (
    config: unknown,
    options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<QueryResultRow>> => {
    queries.push({ config, options });
    return result([]);
  });
  return { seam: { query }, queries };
}

interface ReadyExecutorOptions {
  readonly includeSequenceRuntimeGrant?: boolean;
  readonly omitLcmPublicDefault?: boolean;
  readonly omitPublicSchemaUsage?: boolean;
  readonly omitPublicFunctionExecute?: boolean;
  readonly omitOptionalDirectGrants?: boolean;
  readonly partialOptionalDirectGrants?: boolean;
  readonly partialOptionalEffectiveGrants?: boolean;
  readonly incompleteEffectivePrivileges?: boolean;
  readonly operationOverrides?: Readonly<Record<string, ReadyExecutorOverride>>;
}

type ReadyExecutorBaseResult = QueryResult<QueryResultRow>;
type ReadyExecutorOverride =
  | readonly QueryResultRow[]
  | ReadyExecutorBaseResult
  | { readonly error: unknown }
  | ((base: ReadyExecutorBaseResult) => ReadyExecutorBaseResult | readonly QueryResultRow[]);

function trustedFunctionRow(input: {
  readonly functionIdentity: string;
  readonly extension?: "pgcrypto" | "pg_trgm";
  readonly language?: "c" | "internal";
  readonly symbol: string;
  readonly returnType: string;
  readonly volatility: "i" | "s";
  readonly leakproof?: boolean;
  readonly supportFunctionIdentity?: string;
}) {
  const extension = input.extension ?? null;
  return {
    function_identity: input.functionIdentity,
    extension_name: extension,
    owner_matches_extension: extension === null ? null : true,
    language_name: input.language ?? (extension === null ? "internal" : "c"),
    probin: extension === null ? null : `$libdir/${extension}`,
    prosrc: input.symbol,
    return_type: input.returnType,
    security_definer: false,
    leakproof: input.leakproof ?? false,
    volatility: input.volatility,
    parallel_safety: "s",
    strict: true,
    returns_set: false,
    function_kind: "f",
    support_function_identity: input.supportFunctionIdentity ?? null,
    configuration_is_null: true,
    dependency_count: extension === null ? 0 : 2,
    extension_dependency_count: extension === null ? 0 : 1,
    namespace_dependency_count: extension === null ? 0 : 1,
  };
}

const REQUIRED_EXTENSION_FUNCTION_ROWS = [
  trustedFunctionRow({
    functionIdentity: "public.digest(text, text)",
    extension: "pgcrypto",
    symbol: "pg_digest",
    returnType: "bytea",
    volatility: "i",
  }),
  trustedFunctionRow({
    functionIdentity: "public.digest(bytea, text)",
    extension: "pgcrypto",
    symbol: "pg_digest",
    returnType: "bytea",
    volatility: "i",
  }),
  trustedFunctionRow({
    functionIdentity: "public.similarity(text, text)",
    extension: "pg_trgm",
    symbol: "similarity",
    returnType: "real",
    volatility: "i",
  }),
  trustedFunctionRow({
    functionIdentity: "public.similarity_op(text, text)",
    extension: "pg_trgm",
    symbol: "similarity_op",
    returnType: "boolean",
    volatility: "s",
  }),
  ...[
    ["public.word_similarity_commutator_op(text, text)", "word_similarity_commutator_op"],
    [
      "public.strict_word_similarity_commutator_op(text, text)",
      "strict_word_similarity_commutator_op",
    ],
    ["public.word_similarity_op(text, text)", "word_similarity_op"],
    ["public.strict_word_similarity_op(text, text)", "strict_word_similarity_op"],
  ].map(([functionIdentity, symbol]) => trustedFunctionRow({
    functionIdentity: functionIdentity!,
    extension: "pg_trgm",
    symbol: symbol!,
    returnType: "boolean",
    volatility: "s",
  })),
  ...[
    ["public.gin_extract_value_trgm(text, internal)", "gin_extract_value_trgm", "internal"],
    [
      "public.gin_extract_query_trgm(text, internal, smallint, internal, internal, internal, internal)",
      "gin_extract_query_trgm",
      "internal",
    ],
    [
      "public.gin_trgm_consistent(internal, smallint, text, integer, internal, internal, internal, internal)",
      "gin_trgm_consistent",
      "boolean",
    ],
    [
      "public.gin_trgm_triconsistent(internal, smallint, text, integer, internal, internal, internal)",
      "gin_trgm_triconsistent",
      '"char"',
    ],
  ].map(([functionIdentity, symbol, returnType]) => trustedFunctionRow({
    functionIdentity: functionIdentity!,
    extension: "pg_trgm",
    symbol: symbol!,
    returnType: returnType!,
    volatility: "i",
  })),
  trustedFunctionRow({
    functionIdentity: "pg_catalog.btint4cmp(integer, integer)",
    symbol: "btint4cmp",
    returnType: "integer",
    volatility: "i",
    leakproof: true,
  }),
  trustedFunctionRow({
    functionIdentity: "pg_catalog.texteq(text, text)",
    symbol: "texteq",
    returnType: "boolean",
    volatility: "i",
    leakproof: true,
  }),
  ...[
    ["pg_catalog.textlike(text, text)", "textlike", "pg_catalog.textlike_support(internal)"],
    [
      "pg_catalog.texticlike(text, text)",
      "texticlike",
      "pg_catalog.texticlike_support(internal)",
    ],
    [
      "pg_catalog.textregexeq(text, text)",
      "textregexeq",
      "pg_catalog.textregexeq_support(internal)",
    ],
    [
      "pg_catalog.texticregexeq(text, text)",
      "texticregexeq",
      "pg_catalog.texticregexeq_support(internal)",
    ],
  ].map(([functionIdentity, symbol, supportFunctionIdentity]) => trustedFunctionRow({
    functionIdentity: functionIdentity!,
    symbol: symbol!,
    returnType: "boolean",
    volatility: "i",
    supportFunctionIdentity,
  })),
  ...[
    "textlike_support",
    "texticlike_support",
    "textregexeq_support",
    "texticregexeq_support",
  ].map((symbol) => trustedFunctionRow({
    functionIdentity: `pg_catalog.${symbol}(internal)`,
    symbol,
    returnType: "internal",
    volatility: "i",
  })),
  ...[
    ["matchingsel", "integer"],
    ["matchingjoinsel", "smallint, internal"],
    ["likesel", "integer"],
    ["likejoinsel", "smallint, internal"],
    ["iclikesel", "integer"],
    ["iclikejoinsel", "smallint, internal"],
    ["regexeqsel", "integer"],
    ["regexeqjoinsel", "smallint, internal"],
    ["icregexeqsel", "integer"],
    ["icregexeqjoinsel", "smallint, internal"],
    ["eqsel", "integer"],
    ["eqjoinsel", "smallint, internal"],
  ].map(([symbol, finalArguments]) => trustedFunctionRow({
    functionIdentity: `pg_catalog.${symbol}(internal, oid, internal, ${finalArguments})`,
    symbol: symbol!,
    returnType: "double precision",
    volatility: "s",
  })),
  ...[
    ["pg_catalog.textnlike(text, text)", "textnlike", false],
    ["pg_catalog.texticnlike(text, text)", "texticnlike", false],
    ["pg_catalog.textregexne(text, text)", "textregexne", false],
    ["pg_catalog.texticregexne(text, text)", "texticregexne", false],
    ["pg_catalog.textne(text, text)", "textne", true],
  ].map(([functionIdentity, symbol, leakproof]) => trustedFunctionRow({
    functionIdentity: functionIdentity!,
    symbol: symbol!,
    returnType: "boolean",
    volatility: "i",
    leakproof: leakproof as boolean,
  })),
  ...[
    ["nlikesel", "integer"],
    ["nlikejoinsel", "smallint, internal"],
    ["icnlikesel", "integer"],
    ["icnlikejoinsel", "smallint, internal"],
    ["regexnesel", "integer"],
    ["regexnejoinsel", "smallint, internal"],
    ["icregexnesel", "integer"],
    ["icregexnejoinsel", "smallint, internal"],
    ["neqsel", "integer"],
    ["neqjoinsel", "smallint, internal"],
  ].map(([symbol, finalArguments]) => trustedFunctionRow({
    functionIdentity: `pg_catalog.${symbol}(internal, oid, internal, ${finalArguments})`,
    symbol: symbol!,
    returnType: "double precision",
    volatility: "s",
  })),
] as const;

const REQUIRED_EXTENSION_OPERATOR_ROWS = [{
  schema_name: "public",
  operator_name: "%",
  operator_kind: "b",
  left_type: "text",
  right_type: "text",
  result_type: "boolean",
  extension_name: "pg_trgm",
  owner_matches_extension: true,
  implementation_matches: true,
  commutator_matches: true,
  negator_absent: true,
  restriction_matches: true,
  join_matches: true,
  can_merge: false,
  can_hash: false,
  dependency_count: 3,
  extension_dependency_count: 1,
  implementation_dependency_count: 1,
  namespace_dependency_count: 1,
}] as const;

const REQUIRED_GIN_TRGM_OPERATOR_CLASS_ROWS = [{
  operator_class_schema: "public",
  operator_class_name: "gin_trgm_ops",
  operator_family_schema: "public",
  operator_family_name: "gin_trgm_ops",
  access_method_name: "gin",
  input_type: "text",
  storage_type: "integer",
  is_default: false,
  operator_class_extension: "pg_trgm",
  operator_family_extension: "pg_trgm",
  operator_class_owner_matches_extension: true,
  operator_family_owner_matches_extension: true,
  operator_class_dependency_count: 3,
  operator_class_family_dependency_count: 1,
  operator_class_extension_dependency_count: 1,
  operator_class_namespace_dependency_count: 1,
  operator_family_dependency_count: 2,
  operator_family_extension_dependency_count: 1,
  operator_family_namespace_dependency_count: 1,
}] as const;

function ginTrgmOperatorRow(input: {
  readonly strategyNumber: number;
  readonly operatorIdentity: string;
  readonly implementationIdentity: string;
  readonly commutatorIdentity: string | null;
  readonly negatorIdentity: string | null;
  readonly restrictionIdentity: string;
  readonly joinIdentity: string;
  readonly extension?: "pg_trgm";
  readonly canMerge?: boolean;
  readonly canHash?: boolean;
}) {
  const extension = input.extension ?? null;
  return {
    strategy_number: input.strategyNumber,
    purpose: "s",
    left_type: "text",
    right_type: "text",
    operator_identity: input.operatorIdentity,
    operator_kind: "b",
    result_type: "boolean",
    implementation_identity: input.implementationIdentity,
    commutator_identity: input.commutatorIdentity,
    negator_identity: input.negatorIdentity,
    restriction_identity: input.restrictionIdentity,
    join_identity: input.joinIdentity,
    can_merge: input.canMerge ?? false,
    can_hash: input.canHash ?? false,
    sort_family_identity: null,
    access_method_name: "gin",
    extension_name: extension,
    owner_matches_extension: extension === null ? null : true,
    mapping_dependency_count: extension === null ? 1 : 2,
    mapping_family_dependency_count: 1,
    mapping_operator_dependency_count: extension === null ? 0 : 1,
    operator_dependency_count: extension === null ? 0 : 3,
    operator_extension_dependency_count: extension === null ? 0 : 1,
    operator_implementation_dependency_count: extension === null ? 0 : 1,
    operator_namespace_dependency_count: extension === null ? 0 : 1,
  };
}

const REQUIRED_GIN_TRGM_OPERATOR_ROWS = [
  ginTrgmOperatorRow({
    strategyNumber: 1,
    operatorIdentity: "public.%(text, text)",
    implementationIdentity: "public.similarity_op(text, text)",
    commutatorIdentity: "public.%(text, text)",
    negatorIdentity: null,
    restrictionIdentity: "pg_catalog.matchingsel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.matchingjoinsel(internal, oid, internal, smallint, internal)",
    extension: "pg_trgm",
  }),
  ginTrgmOperatorRow({
    strategyNumber: 3,
    operatorIdentity: "pg_catalog.~~(text, text)",
    implementationIdentity: "pg_catalog.textlike(text, text)",
    commutatorIdentity: null,
    negatorIdentity: "pg_catalog.!~~(text, text)",
    restrictionIdentity: "pg_catalog.likesel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.likejoinsel(internal, oid, internal, smallint, internal)",
  }),
  ginTrgmOperatorRow({
    strategyNumber: 4,
    operatorIdentity: "pg_catalog.~~*(text, text)",
    implementationIdentity: "pg_catalog.texticlike(text, text)",
    commutatorIdentity: null,
    negatorIdentity: "pg_catalog.!~~*(text, text)",
    restrictionIdentity: "pg_catalog.iclikesel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.iclikejoinsel(internal, oid, internal, smallint, internal)",
  }),
  ginTrgmOperatorRow({
    strategyNumber: 5,
    operatorIdentity: "pg_catalog.~(text, text)",
    implementationIdentity: "pg_catalog.textregexeq(text, text)",
    commutatorIdentity: null,
    negatorIdentity: "pg_catalog.!~(text, text)",
    restrictionIdentity: "pg_catalog.regexeqsel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.regexeqjoinsel(internal, oid, internal, smallint, internal)",
  }),
  ginTrgmOperatorRow({
    strategyNumber: 6,
    operatorIdentity: "pg_catalog.~*(text, text)",
    implementationIdentity: "pg_catalog.texticregexeq(text, text)",
    commutatorIdentity: null,
    negatorIdentity: "pg_catalog.!~*(text, text)",
    restrictionIdentity: "pg_catalog.icregexeqsel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.icregexeqjoinsel(internal, oid, internal, smallint, internal)",
  }),
  ginTrgmOperatorRow({
    strategyNumber: 7,
    operatorIdentity: "public.%>(text, text)",
    implementationIdentity: "public.word_similarity_commutator_op(text, text)",
    commutatorIdentity: "public.<%(text, text)",
    negatorIdentity: null,
    restrictionIdentity: "pg_catalog.matchingsel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.matchingjoinsel(internal, oid, internal, smallint, internal)",
    extension: "pg_trgm",
  }),
  ginTrgmOperatorRow({
    strategyNumber: 9,
    operatorIdentity: "public.%>>(text, text)",
    implementationIdentity: "public.strict_word_similarity_commutator_op(text, text)",
    commutatorIdentity: "public.<<%(text, text)",
    negatorIdentity: null,
    restrictionIdentity: "pg_catalog.matchingsel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.matchingjoinsel(internal, oid, internal, smallint, internal)",
    extension: "pg_trgm",
  }),
  ginTrgmOperatorRow({
    strategyNumber: 11,
    operatorIdentity: "pg_catalog.=(text, text)",
    implementationIdentity: "pg_catalog.texteq(text, text)",
    commutatorIdentity: "pg_catalog.=(text, text)",
    negatorIdentity: "pg_catalog.<>(text, text)",
    restrictionIdentity: "pg_catalog.eqsel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.eqjoinsel(internal, oid, internal, smallint, internal)",
    canMerge: true,
    canHash: true,
  }),
] as const;

function ginTrgmIndirectOperatorRow(input: {
  readonly strategyNumber: number;
  readonly referringOperatorIdentity: string;
  readonly referenceKind: "commutator" | "negator";
  readonly referencedOperatorOid: number;
  readonly referencedOperatorIdentity: string;
  readonly implementationIdentity: string;
  readonly commutatorIdentity: string | null;
  readonly negatorIdentity: string | null;
  readonly restrictionIdentity: string;
  readonly joinIdentity: string;
  readonly extension?: "pg_trgm";
  readonly canMerge?: boolean;
  readonly canHash?: boolean;
  readonly reciprocalMatches?: boolean;
}) {
  const extension = input.extension ?? null;
  return {
    strategy_number: input.strategyNumber,
    referring_operator_identity: input.referringOperatorIdentity,
    reference_kind: input.referenceKind,
    referenced_operator_oid: input.referencedOperatorOid,
    referenced_operator_identity: input.referencedOperatorIdentity,
    operator_kind: "b",
    left_type: "text",
    right_type: "text",
    result_type: "boolean",
    implementation_identity: input.implementationIdentity,
    commutator_identity: input.commutatorIdentity,
    negator_identity: input.negatorIdentity,
    restriction_identity: input.restrictionIdentity,
    join_identity: input.joinIdentity,
    can_merge: input.canMerge ?? false,
    can_hash: input.canHash ?? false,
    reciprocal_matches: input.reciprocalMatches ?? true,
    extension_name: extension,
    owner_matches_extension: extension === null ? null : true,
    dependency_count: extension === null ? 0 : 3,
    extension_dependency_count: extension === null ? 0 : 1,
    implementation_dependency_count: extension === null ? 0 : 1,
    namespace_dependency_count: extension === null ? 0 : 1,
  };
}

const REQUIRED_GIN_TRGM_INDIRECT_OPERATOR_ROWS = [
  ginTrgmIndirectOperatorRow({
    strategyNumber: 7,
    referringOperatorIdentity: "public.%>(text, text)",
    referenceKind: "commutator",
    referencedOperatorOid: 7001,
    referencedOperatorIdentity: "public.<%(text, text)",
    implementationIdentity: "public.word_similarity_op(text, text)",
    commutatorIdentity: "public.%>(text, text)",
    negatorIdentity: null,
    restrictionIdentity: "pg_catalog.matchingsel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.matchingjoinsel(internal, oid, internal, smallint, internal)",
    extension: "pg_trgm",
  }),
  ginTrgmIndirectOperatorRow({
    strategyNumber: 9,
    referringOperatorIdentity: "public.%>>(text, text)",
    referenceKind: "commutator",
    referencedOperatorOid: 7002,
    referencedOperatorIdentity: "public.<<%(text, text)",
    implementationIdentity: "public.strict_word_similarity_op(text, text)",
    commutatorIdentity: "public.%>>(text, text)",
    negatorIdentity: null,
    restrictionIdentity: "pg_catalog.matchingsel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.matchingjoinsel(internal, oid, internal, smallint, internal)",
    extension: "pg_trgm",
  }),
  ...[
    [3, "pg_catalog.~~(text, text)", 7103, "pg_catalog.!~~(text, text)", "pg_catalog.textnlike(text, text)", "pg_catalog.~~(text, text)", "pg_catalog.nlikesel(internal, oid, internal, integer)", "pg_catalog.nlikejoinsel(internal, oid, internal, smallint, internal)"],
    [4, "pg_catalog.~~*(text, text)", 7104, "pg_catalog.!~~*(text, text)", "pg_catalog.texticnlike(text, text)", "pg_catalog.~~*(text, text)", "pg_catalog.icnlikesel(internal, oid, internal, integer)", "pg_catalog.icnlikejoinsel(internal, oid, internal, smallint, internal)"],
    [5, "pg_catalog.~(text, text)", 7105, "pg_catalog.!~(text, text)", "pg_catalog.textregexne(text, text)", "pg_catalog.~(text, text)", "pg_catalog.regexnesel(internal, oid, internal, integer)", "pg_catalog.regexnejoinsel(internal, oid, internal, smallint, internal)"],
    [6, "pg_catalog.~*(text, text)", 7106, "pg_catalog.!~*(text, text)", "pg_catalog.texticregexne(text, text)", "pg_catalog.~*(text, text)", "pg_catalog.icregexnesel(internal, oid, internal, integer)", "pg_catalog.icregexnejoinsel(internal, oid, internal, smallint, internal)"],
    [11, "pg_catalog.=(text, text)", 7111, "pg_catalog.<>(text, text)", "pg_catalog.textne(text, text)", "pg_catalog.=(text, text)", "pg_catalog.neqsel(internal, oid, internal, integer)", "pg_catalog.neqjoinsel(internal, oid, internal, smallint, internal)"],
  ].map(([strategyNumber, referringOperatorIdentity, referencedOperatorOid, referencedOperatorIdentity, implementationIdentity, negatorIdentity, restrictionIdentity, joinIdentity]) => ginTrgmIndirectOperatorRow({
    strategyNumber: strategyNumber as number,
    referringOperatorIdentity: referringOperatorIdentity as string,
    referenceKind: "negator",
    referencedOperatorOid: referencedOperatorOid as number,
    referencedOperatorIdentity: referencedOperatorIdentity as string,
    implementationIdentity: implementationIdentity as string,
    commutatorIdentity: strategyNumber === 11 ? referencedOperatorIdentity as string : null,
    negatorIdentity: negatorIdentity as string,
    restrictionIdentity: restrictionIdentity as string,
    joinIdentity: joinIdentity as string,
  })),
] as const;

const REQUIRED_GIN_TRGM_SUPPORT_ROWS = [
  {
    support_number: 1,
    left_type: "text",
    right_type: "text",
    function_identity: "pg_catalog.btint4cmp(integer, integer)",
    dependency_count: 1,
    family_auto_dependency_count: 1,
    operator_class_internal_dependency_count: 0,
    procedure_normal_dependency_count: 0,
    procedure_auto_dependency_count: 0,
  },
  ...[
    [2, "public.gin_extract_value_trgm(text, internal)"],
    [
      3,
      "public.gin_extract_query_trgm(text, internal, smallint, internal, internal, internal, internal)",
    ],
  ].map(([supportNumber, functionIdentity]) => ({
    support_number: supportNumber,
    left_type: "text",
    right_type: "text",
    function_identity: functionIdentity,
    dependency_count: 2,
    family_auto_dependency_count: 0,
    operator_class_internal_dependency_count: 1,
    procedure_normal_dependency_count: 1,
    procedure_auto_dependency_count: 0,
  })),
  ...[
    [
      4,
      "public.gin_trgm_consistent(internal, smallint, text, integer, internal, internal, internal, internal)",
    ],
    [
      6,
      "public.gin_trgm_triconsistent(internal, smallint, text, integer, internal, internal, internal)",
    ],
  ].map(([supportNumber, functionIdentity]) => ({
    support_number: supportNumber,
    left_type: "text",
    right_type: "text",
    function_identity: functionIdentity,
    dependency_count: 2,
    family_auto_dependency_count: 1,
    operator_class_internal_dependency_count: 0,
    procedure_normal_dependency_count: 0,
    procedure_auto_dependency_count: 1,
  })),
] as const;

function mutateRows(
  mutation: (rows: QueryResultRow[]) => void,
): (base: ReadyExecutorBaseResult) => ReadyExecutorBaseResult {
  return (base) => {
    const rows = base.rows.map((row) => ({ ...row }));
    mutation(rows);
    return replaceRows(base, rows);
  };
}

function replaceRows(
  base: ReadyExecutorBaseResult,
  rows: readonly QueryResultRow[],
): ReadyExecutorBaseResult {
  return { ...base, rowCount: rows.length, rows };
}

function readyExecutor(fixtureOptions: ReadyExecutorOptions = {}): {
  readonly seam: PostgreSqlQueryExecutor;
  readonly queries: readonly { config: unknown; options: PostgreSqlQueryOptions }[];
} {
  const queries: { config: unknown; options: PostgreSqlQueryOptions }[] = [];
  const migrations = loadPostgreSqlMigrations();
  const snapshot = loadPostgreSqlSchemaSnapshots().at(-1)!;
  const expectations = getPostgreSqlSchemaSnapshotExpectations(snapshot);
  const runtimeRole = "lcm_test_runtime";
  const includeSequenceRuntimeGrant = fixtureOptions.includeSequenceRuntimeGrant ?? true;
  const optionalRelationEntries = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.optional
    .filter(({ kind }) => kind === "relation");
  const optionalColumnEntries = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.optional
    .filter(({ kind }) => kind === "column");
  const selectedOptionalRelationEntries = fixtureOptions.omitOptionalDirectGrants
    ? []
    : fixtureOptions.partialOptionalDirectGrants
      ? optionalRelationEntries.slice(0, 1)
      : optionalRelationEntries;
  const selectedOptionalColumnEntries = fixtureOptions.omitOptionalDirectGrants
    ? []
    : fixtureOptions.partialOptionalDirectGrants
      ? []
      : optionalColumnEntries;
  const omitLcmPublicDefault = fixtureOptions.omitLcmPublicDefault ?? true;
  const ownerRow = {
    grantee_is_owner: true,
    grantee_name: null,
    grantor_is_owner: true,
    is_grantable: false,
  };
  const runtimeRow = {
    grantee_is_owner: false,
    grantee_name: runtimeRole,
    grantor_is_owner: true,
    is_grantable: false,
  };
  const publicRow = {
    grantee_is_owner: false,
    grantee_name: null,
    grantor_is_owner: true,
    is_grantable: false,
  };
  const query = vi.fn(async (
    config: unknown,
    queryOptions: PostgreSqlQueryOptions,
  ): Promise<QueryResult<QueryResultRow>> => {
    queries.push({ config, options: queryOptions });
    const operation = queryOptions.operation;
    const applyOverride = (base: ReadyExecutorBaseResult): ReadyExecutorBaseResult => {
      const override = fixtureOptions.operationOverrides?.[operation];
      if (override === undefined) return base;
      if (typeof override === "function") {
        const replacement = override(base);
        return Array.isArray(replacement) ? replaceRows(base, replacement) : replacement;
      }
      if (Array.isArray(override)) return replaceRows(base, override);
      if ("error" in override) throw override.error;
      return override;
    };
    if (operation === "inspectServerReadiness") {
      return applyOverride(result([{
        server_version_num: 180004,
        server_encoding: "UTF8",
        session_replication_role: "origin",
        timezone: "UTC",
        tls: true,
      }]));
    }
    if (operation === "inspectRuntimeRolePolicy") {
      return applyOverride(result([{
        current_user_name: runtimeRole,
        session_user_name: runtimeRole,
        role_exists: true,
        superuser: false,
        create_role: false,
        create_database: false,
        database_create_privilege: false,
        session_replication_role_set_privilege: false,
        replication: false,
        bypass_rls: false,
        membership_count: 0,
        tls: true,
        expected_owner_match: false,
        expected_owner_count: 1,
        expected_owner_oid: "100",
        database_owner_count: 1,
        database_owner_oid_count: 1,
        database_owner_oid: "100",
        database_owner_match: true,
      }]));
    }
    if (operation === "runtimeReadinessExtensions") {
      return applyOverride(result(REQUIRED_POSTGRESQL_EXTENSIONS.map((name) => ({
        name,
        default_version: "1.0",
        installed_version: "1.0",
        installed_schema: "public",
        relocatable: true,
        preloaded: name === "pg_stat_statements" ? true : null,
      }))));
    }
    if (operation === "runtimeReadinessExtensions:probePgStatStatements") {
      return applyOverride(result([{ stats_reset: new Date() }]));
    }
    if (operation === "inspectRequiredExtensionFunctions") {
      return applyOverride(result(REQUIRED_EXTENSION_FUNCTION_ROWS.map((row) => ({ ...row }))));
    }
    if (operation === "inspectRequiredExtensionOperator") {
      return applyOverride(result(REQUIRED_EXTENSION_OPERATOR_ROWS.map((row) => ({ ...row }))));
    }
    if (operation === "inspectRequiredGinTrgmOperatorClass") {
      return applyOverride(result(
        REQUIRED_GIN_TRGM_OPERATOR_CLASS_ROWS.map((row) => ({ ...row })),
      ));
    }
    if (operation === "inspectRequiredGinTrgmOperators") {
      return applyOverride(result(REQUIRED_GIN_TRGM_OPERATOR_ROWS.map((row) => ({ ...row }))));
    }
    if (operation === "inspectRequiredGinTrgmIndirectOperators") {
      return applyOverride(result(
        REQUIRED_GIN_TRGM_INDIRECT_OPERATOR_ROWS.map((row) => ({ ...row })),
      ));
    }
    if (operation === "inspectRequiredGinTrgmSupportFunctions") {
      return applyOverride(result(REQUIRED_GIN_TRGM_SUPPORT_ROWS.map((row) => ({ ...row }))));
    }
    if (operation === "runtimeReadinessSearchConfiguration") {
      return applyOverride(result([{
        actual_sha256: POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
        object_count: "19",
        ownership_ready: true,
      }]));
    }
    if (operation === "readMigrations") {
      return applyOverride(result(migrations.map(({ id, sha256 }) => ({ id, checksum_sha256: sha256 }))));
    }
    if (operation === "inspectSchemaOwnership") {
      return applyOverride(result([{
        expected_owner_exists: true,
        schema_exists: true,
        schema_owned: true,
        ledger_exists: true,
        ledger_kind: "r",
        ledger_owned: true,
        expected_object_count: snapshot.managedObjectIdentities.length,
        actual_object_count: snapshot.managedObjectIdentities.length,
        owned_object_count: snapshot.managedObjectIdentities.length,
      }]));
    }
    if (operation === "inspectSchemaDefinitions") {
      return applyOverride(result([{
        baseline_applied: true,
        expected_object_count: expectations.definitionObjectCount,
        existing_object_count: expectations.definitionObjectCount,
        actual_definition_group_counts: expectations.definitionGroupCounts,
        actual_definition_group_hashes: expectations.definitionGroupHashes,
        invalid_index_count: 0,
        missing_object_count: 0,
        drifted_definition_group_count: 0,
      }]));
    }
    if (operation === "inspectIdentityFunctions") {
      return applyOverride(result([{
        expected_function_count: snapshot.identityFunctions.length,
        existing_function_count: snapshot.identityFunctions.length,
        drifted_function_count: 0,
      }]));
    }
    if (operation === "inspectSchemaAcl") {
      return applyOverride(result([
        ...["lcm", "public"].flatMap((schema_name) => [
          { schema_name, object_identity: schema_name, privilege_type: "CREATE", ...ownerRow },
          { schema_name, object_identity: schema_name, privilege_type: "USAGE", ...ownerRow },
          ...(!(omitLcmPublicDefault && schema_name === "lcm")
            && !(fixtureOptions.omitPublicSchemaUsage && schema_name === "public")
            ? [{ schema_name, object_identity: schema_name, privilege_type: "USAGE", ...publicRow }]
            : []),
        ]),
        { schema_name: "lcm", object_identity: "lcm", privilege_type: "USAGE", ...runtimeRow },
        { schema_name: "public", object_identity: "public", privilege_type: "USAGE", ...runtimeRow },
      ]));
    }
    if (operation === "inspectRelationAcl") {
      const ownerPrivileges = (object: string): readonly string[] => (
        object.startsWith("table|")
          ? ["DELETE", "INSERT", "MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"]
          : ["SELECT", "UPDATE", "USAGE"]
      );
      const required = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required;
      const objects = (config as { values?: unknown[] }).values?.[0] as string[];
      const rows = [
        ...objects.flatMap((object) => [
          ...ownerPrivileges(object).map((privilege_type) => ({ object_identity: object, privilege_type, ...ownerRow })),
          ...required
            .filter((entry) => (
              entry.kind === "relation"
                ? `table|${entry.object.replace(/^lcm\./u, "")}` === object
                : entry.kind === "sequence" && includeSequenceRuntimeGrant
                  ? `sequence|${entry.object.replace(/^lcm\./u, "")}` === object
                  : false
            ))
            .map(({ privilege }) => ({ object_identity: object, privilege_type: privilege, ...runtimeRow })),
          ...selectedOptionalRelationEntries
            .filter(({ object: entryObject }) => (
              `table|${entryObject.replace(/^lcm\./u, "")}` === object
            ))
            .map(({ privilege }) => ({ object_identity: object, privilege_type: privilege, ...runtimeRow })),
        ]),
      ];
      return applyOverride(result(rows));
    }
    if (operation === "inspectColumnAcl") {
      const columns = [
        ...POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required,
        ...selectedOptionalColumnEntries,
      ].filter(({ kind }) => kind === "column") as readonly PostgreSqlRuntimePrivilegeEntry[];
      return applyOverride(result(columns.map((entry) => ({
        object_identity: `${entry.object}|${entry.column}`,
        privilege_type: entry.privilege,
        ...runtimeRow,
      }))));
    }
    if (operation === "inspectFunctionAcl") {
      const identities = [...new Set([
        ...snapshot.managedObjectIdentities
          .filter((identity) => identity.startsWith("function|"))
          .map((identity) => {
            const [, name, args] = identity.split("|");
            return `lcm.${name}(${args ?? ""})`;
          }),
        ...POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required
          .filter(({ kind }) => kind === "function")
          .map(({ object }) => object),
      ])];
      const functions = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required
        .filter(({ kind }) => kind === "function");
      return applyOverride(result([
        ...identities.flatMap((function_identity) => {
          const entry = functions.find((candidate) => candidate.object === function_identity);
          const extension_name = entry?.object.startsWith("public.digest(")
            ? "pgcrypto"
            : entry?.object.startsWith("public.similarity")
              ? "pg_trgm"
              : null;
          return [
            { function_identity, object_identity: function_identity, extension_name, privilege_type: "EXECUTE", ...ownerRow },
            ...(entry === undefined ? [] : [
              { function_identity, object_identity: function_identity, extension_name, privilege_type: "EXECUTE", ...runtimeRow },
              ...(entry.extension !== undefined && !fixtureOptions.omitPublicFunctionExecute
                ? [{ function_identity, object_identity: function_identity, extension_name, privilege_type: "EXECUTE", ...publicRow }]
                : []),
            ]),
          ];
        }),
      ]));
    }
    if (operation === "inspectEffectivePrivileges") {
      const values = (config as { values?: unknown[] }).values ?? [];
      const functionObjects = values[14] as unknown[];
      const functionExpected = values[16] as unknown[];
      const rows: QueryResultRow[] = [];
      let flippedOptionalEffective = false;
      const addRows = (
        privilege_kind: string,
        objects: readonly unknown[],
        columns: readonly unknown[] | null,
        privileges: readonly unknown[],
        expected: readonly unknown[],
      ): void => {
        for (let index = 0; index < objects.length; index += 1) {
          const object_identity = objects[index];
          const column_name = columns === null ? null : columns[index];
          const privilege_type = privileges[index];
          const expectedValue = expected[index];
          const optional = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.optional.some((entry) => (
            entry.kind === privilege_kind
              && entry.object === object_identity
              && (entry.column ?? null) === column_name
              && entry.privilege === privilege_type
          ));
          const effective = fixtureOptions.partialOptionalEffectiveGrants
            && optional
            && expectedValue === true
            && !flippedOptionalEffective
            ? (flippedOptionalEffective = true, false)
            : expectedValue;
          rows.push({
            privilege_kind,
            object_identity,
            column_name,
            privilege_type,
            expected: expectedValue,
            effective,
          });
        }
      };
      addRows("schema", values[1] as unknown[], null, values[2] as unknown[], values[3] as unknown[]);
      addRows("relation", values[4] as unknown[], null, values[5] as unknown[], values[6] as unknown[]);
      addRows("sequence", values[7] as unknown[], null, values[8] as unknown[], values[9] as unknown[]);
      addRows("column", values[10] as unknown[], values[11] as unknown[], values[12] as unknown[], values[13] as unknown[]);
      addRows("function", functionObjects, null, [
        ...functionObjects.map(() => "EXECUTE"),
      ], functionExpected);
      return applyOverride(result(fixtureOptions.incompleteEffectivePrivileges ? rows.slice(0, -1) : rows));
    }
    return applyOverride(result([]));
  });
  return { seam: { query }, queries };
}

const EXPECTED_OWNER = "lcm_test_migrator";

function mutateFirstField(field: string, value: unknown): ReadyExecutorOverride {
  return mutateRows((rows) => {
    if (rows[0] === undefined) throw new Error(`fixture row missing for ${field}`);
    rows[0][field] = value;
  });
}

function mutateEffectiveRow(
  mutation: (row: QueryResultRow, rows: QueryResultRow[]) => void,
): ReadyExecutorOverride {
  return mutateRows((rows) => {
    if (rows[0] === undefined) throw new Error("effective fixture row missing");
    mutation(rows[0], rows);
  });
}

async function expectReadinessFailure(
  fake: ReturnType<typeof readyExecutor>,
  reason: string,
): Promise<PostgreSqlRuntimeReadinessError> {
  const failure = await verifyPostgreSqlRuntimeSchema(fake.seam, {
    expectedOwner: EXPECTED_OWNER,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(PostgreSqlRuntimeReadinessError);
  expect(failure).toMatchObject({ reason });
  return failure as PostgreSqlRuntimeReadinessError;
}

describe("PostgreSQL runtime schema and grant readiness", () => {
  const deparserOperations = [
    "inspectRequiredExtensionFunctions",
    "inspectRequiredExtensionOperator",
    "inspectRequiredGinTrgmOperatorClass",
    "inspectRequiredGinTrgmOperators",
    "inspectRequiredGinTrgmIndirectOperators",
    "inspectRequiredGinTrgmSupportFunctions",
    "inspectSchemaOwnership",
    "inspectFunctionAcl",
    "inspectSchemaDefinitions",
  ] as const;

  it("pins and semantically consumes deparser settings in every sensitive query", async () => {
    const fake = readyExecutor();
    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: EXPECTED_OWNER,
    })).resolves.toBeDefined();

    const sensitiveCalls = /pg_catalog\.(?:pg_get_[a-z_]+|format_type|quote_ident)\s*\(/gu;
    const settingCte = /runtime_deparser_settings\s+AS\s+MATERIALIZED\s*\(\s*SELECT\s+pg_catalog\.set_config\(\s*'search_path'\s*,\s*'pg_catalog, public'\s*,\s*true\s*\)\s+AS\s+search_path\s*,\s*pg_catalog\.set_config\(\s*'quote_all_identifiers'\s*,\s*'off'\s*,\s*true\s*\)\s+AS\s+quote_all_identifiers\s*\)/u;
    for (const operation of deparserOperations) {
      const calls = fake.queries.filter(({ options }) => options.operation === operation);
      expect(calls, operation).toHaveLength(1);
      const text = String((calls[0]?.config as { readonly text?: unknown } | undefined)?.text ?? "");
      expect(text, operation).toMatch(settingCte);
      expect(text, operation).toContain("CROSS JOIN runtime_deparser_settings AS settings");

      const matches = [...text.matchAll(sensitiveCalls)];
      expect(matches.length, operation).toBeGreaterThan(0);
      for (const match of matches) {
        const callOffset = match.index ?? -1;
        expect(callOffset, operation).toBeGreaterThanOrEqual(0);
        const preceding = text.slice(0, callOffset);
        const caseOffset = preceding.lastIndexOf("CASE");
        const followingEnd = text.indexOf("END", callOffset);
        expect(caseOffset, `${operation} guard start`).toBeGreaterThanOrEqual(0);
        expect(followingEnd, `${operation} guard end`).toBeGreaterThan(callOffset);
        const guard = text.slice(caseOffset, followingEnd + 3);
        expect(guard, `${operation} search_path guard`).toMatch(
          /settings\.search_path\s+OPERATOR\(pg_catalog\.=\)\s*'pg_catalog, public'/u,
        );
        expect(guard, `${operation} quote_all_identifiers guard`).toMatch(
          /settings\.quote_all_identifiers\s+OPERATOR\(pg_catalog\.=\)\s*'off'/u,
        );
        expect(guard, `${operation} non-elidable fallback`).toMatch(/ELSE\s+NULL/u);
      }
    }
  });

  it("exposes an immutable versioned privilege manifest and verifier seam", () => {
    expect(POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.version).toBeGreaterThan(0);
    expect(Object.isFrozen(POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST)).toBe(true);
    expect(Object.isFrozen(POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required)).toBe(true);
    expect(typeof verifyPostgreSqlRuntimeSchema).toBe("function");
  });

  it("requires the exact passive-event inbox write columns from the coordination grant", () => {
    const entries = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required
      .filter(({ kind, object }) => kind === "column" && object === "lcm.passive_event_inbox")
      .map(({ column, privilege }) => `${privilege}|${column}`);

    expect(entries).toEqual([
      "INSERT|project_id",
      "INSERT|machine_id",
      "INSERT|event_id",
      "INSERT|event_version",
      "INSERT|machine_sequence",
      "INSERT|event_type",
      "INSERT|payload",
      "UPDATE|status",
      "UPDATE|attempt_count",
      "UPDATE|next_attempt_at",
      "UPDATE|claimed_at",
      "UPDATE|claimed_by",
      "UPDATE|applied_at",
      "UPDATE|quarantined_at",
      "UPDATE|quarantine_reason",
    ]);
  });

  it("uses the exact PostgreSQL function identity signatures without duplicates", () => {
    const identities = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required
      .filter(({ kind }) => kind === "function")
      .map(({ object }) => object);

    expect(identities).toEqual([
      "lcm.normalize_search_text(input text)",
      "public.digest(text, text)",
      "public.digest(bytea, text)",
      "public.similarity(text, text)",
      "public.similarity_op(text, text)",
    ]);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it.each(REQUIRED_EXTENSION_FUNCTION_ROWS.map(({ function_identity }) => [function_identity]))(
    "rejects a spoofed trusted implementation for %s before later readiness work",
    async (functionIdentity) => {
      const fake = readyExecutor({
        operationOverrides: {
          inspectRequiredExtensionFunctions: mutateRows((rows) => {
            const row = rows.find(({ function_identity }) => function_identity === functionIdentity);
            if (row !== undefined) row.prosrc = "spoofed_entry_point";
          }),
        },
      });

      const failure = await expectReadinessFailure(fake, "extension-preflight");
      expect(failure.operation).toBe("inspectRequiredExtensionFunctions");
      expect(fake.queries.map(({ options }) => options.operation)).toEqual([
        "inspectServerReadiness",
        "inspectRuntimeRolePolicy",
        "runtimeReadinessExtensions",
        "runtimeReadinessExtensions:probePgStatStatements",
        "inspectRequiredExtensionFunctions",
      ]);
    },
  );

  it.each([
    ["malformed identity", (rows: QueryResultRow[]) => { rows[0]!.function_identity = null; }],
    ["unknown identity", (rows: QueryResultRow[]) => {
      rows[0]!.function_identity = "public.digest(uuid, text)";
    }],
    ["wrong extension membership", (rows: QueryResultRow[]) => {
      rows[0]!.extension_name = "pg_trgm";
    }],
    ["malformed owner evidence", (rows: QueryResultRow[]) => {
      rows[0]!.owner_matches_extension = "true";
    }],
    ["foreign extension owner", (rows: QueryResultRow[]) => {
      rows[0]!.owner_matches_extension = false;
    }],
    ["non-C language", (rows: QueryResultRow[]) => { rows[0]!.language_name = "sql"; }],
    ["foreign shared library", (rows: QueryResultRow[]) => {
      rows[0]!.probin = "$libdir/foreign";
    }],
    ["wrong return type", (rows: QueryResultRow[]) => { rows[0]!.return_type = "text"; }],
    ["security definer", (rows: QueryResultRow[]) => { rows[0]!.security_definer = true; }],
    ["leakproof", (rows: QueryResultRow[]) => { rows[0]!.leakproof = true; }],
    ["wrong volatility", (rows: QueryResultRow[]) => { rows[0]!.volatility = "v"; }],
    ["parallel unsafe", (rows: QueryResultRow[]) => { rows[0]!.parallel_safety = "u"; }],
    ["non-strict", (rows: QueryResultRow[]) => { rows[0]!.strict = false; }],
    ["set-returning", (rows: QueryResultRow[]) => { rows[0]!.returns_set = true; }],
    ["wrong function kind", (rows: QueryResultRow[]) => { rows[0]!.function_kind = "p"; }],
    ["foreign planner support function", (rows: QueryResultRow[]) => {
      rows[0]!.support_function_identity = "pg_catalog.foreign_support(internal)";
    }],
    ["procedure configuration", (rows: QueryResultRow[]) => {
      rows[0]!.configuration_is_null = false;
    }],
    ["malformed dependency count", (rows: QueryResultRow[]) => {
      rows[0]!.dependency_count = "2";
    }],
    ["extra dependency", (rows: QueryResultRow[]) => { rows[0]!.dependency_count = 3; }],
    ["missing extension dependency", (rows: QueryResultRow[]) => {
      rows[0]!.extension_dependency_count = 0;
    }],
    ["missing namespace dependency", (rows: QueryResultRow[]) => {
      rows[0]!.namespace_dependency_count = 0;
    }],
    ["duplicate overload", (rows: QueryResultRow[]) => { rows.push({ ...rows[0]! }); }],
    ["missing overload", (rows: QueryResultRow[]) => { rows.splice(0, 1); }],
  ] as const)("rejects malformed or spoofed required extension metadata: %s", async (_label, mutate) => {
    await expectReadinessFailure(
      readyExecutor({
        operationOverrides: {
          inspectRequiredExtensionFunctions: mutateRows(mutate),
        },
      }),
      "extension-preflight",
    );
  });

  it.each([
    ["foreign built-in extension", "pg_catalog.btint4cmp(integer, integer)", "extension_name", "pg_trgm"],
    ["malformed built-in owner", "pg_catalog.btint4cmp(integer, integer)", "owner_matches_extension", true],
    ["built-in dependency", "pg_catalog.btint4cmp(integer, integer)", "dependency_count", 1],
    ["missing planner support", "pg_catalog.textlike(text, text)", "support_function_identity", null],
    [
      "foreign planner support",
      "pg_catalog.textlike(text, text)",
      "support_function_identity",
      "pg_catalog.textregexeq_support(internal)",
    ],
  ] as const)(
    "rejects spoofed trusted built-in procedure metadata: %s",
    async (_label, functionIdentity, field, value) => {
      const fake = readyExecutor({
        operationOverrides: {
          inspectRequiredExtensionFunctions: mutateRows((rows) => {
            const row = rows.find(({ function_identity }) => function_identity === functionIdentity);
            if (row !== undefined) row[field] = value;
          }),
        },
      });

      const failure = await expectReadinessFailure(fake, "extension-preflight");
      expect(failure.operation).toBe("inspectRequiredExtensionFunctions");
    },
  );

  it.each([
    ["malformed schema", "schema_name", null],
    ["foreign schema", "schema_name", "foreign"],
    ["malformed name", "operator_name", null],
    ["foreign name", "operator_name", "#"],
    ["malformed kind", "operator_kind", null],
    ["non-binary kind", "operator_kind", "l"],
    ["malformed left type", "left_type", null],
    ["foreign left type", "left_type", "bytea"],
    ["malformed right type", "right_type", null],
    ["foreign right type", "right_type", "bytea"],
    ["malformed result type", "result_type", null],
    ["foreign result type", "result_type", "integer"],
    ["malformed extension membership", "extension_name", null],
    ["foreign extension membership", "extension_name", "foreign"],
    ["malformed owner match", "owner_matches_extension", "true"],
    ["foreign owner", "owner_matches_extension", false],
    ["malformed implementation match", "implementation_matches", "true"],
    ["foreign implementation", "implementation_matches", false],
    ["malformed commutator match", "commutator_matches", "true"],
    ["foreign commutator", "commutator_matches", false],
    ["malformed negator evidence", "negator_absent", "true"],
    ["foreign negator", "negator_absent", false],
    ["malformed restriction match", "restriction_matches", "true"],
    ["foreign restriction estimator", "restriction_matches", false],
    ["malformed join match", "join_matches", "true"],
    ["foreign join estimator", "join_matches", false],
    ["malformed merge capability", "can_merge", "false"],
    ["merge capability", "can_merge", true],
    ["malformed hash capability", "can_hash", "false"],
    ["hash capability", "can_hash", true],
    ["malformed dependency count", "dependency_count", "3"],
    ["extra dependency", "dependency_count", 4],
    ["malformed extension dependency count", "extension_dependency_count", "1"],
    ["missing extension dependency", "extension_dependency_count", 0],
    ["malformed implementation dependency count", "implementation_dependency_count", "1"],
    ["foreign implementation dependency", "implementation_dependency_count", 0],
    ["malformed namespace dependency count", "namespace_dependency_count", "1"],
    ["foreign namespace dependency", "namespace_dependency_count", 0],
  ] as const)(
    "rejects malformed or spoofed required operator metadata: %s",
    async (_label, field, value) => {
      const fake = readyExecutor({
        operationOverrides: {
          inspectRequiredExtensionOperator: mutateRows((rows) => {
            rows[0]![field] = value;
          }),
        },
      });

      const failure = await expectReadinessFailure(fake, "extension-preflight");
      expect(failure.operation).toBe("inspectRequiredExtensionOperator");
    },
  );

  it.each([
    ["missing", (rows: QueryResultRow[]) => { rows.splice(0, 1); }],
    ["duplicate", (rows: QueryResultRow[]) => { rows.push({ ...rows[0]! }); }],
  ] as const)("rejects a %s required operator row before later readiness work", async (_label, mutate) => {
    const fake = readyExecutor({
      operationOverrides: {
        inspectRequiredExtensionOperator: mutateRows(mutate),
      },
    });

    const failure = await expectReadinessFailure(fake, "extension-preflight");
    expect(failure.operation).toBe("inspectRequiredExtensionOperator");
    expect(fake.queries.map(({ options }) => options.operation)).toEqual([
      "inspectServerReadiness",
      "inspectRuntimeRolePolicy",
      "runtimeReadinessExtensions",
      "runtimeReadinessExtensions:probePgStatStatements",
      "inspectRequiredExtensionFunctions",
      "inspectRequiredExtensionOperator",
    ]);
  });

  it.each([
    ["operator class schema", "operator_class_schema", "foreign"],
    ["operator class name", "operator_class_name", "foreign_ops"],
    ["operator family schema", "operator_family_schema", "foreign"],
    ["operator family name", "operator_family_name", "foreign_ops"],
    ["access method", "access_method_name", "btree"],
    ["input type", "input_type", "bytea"],
    ["storage type", "storage_type", "text"],
    ["default property", "is_default", true],
    ["operator class extension", "operator_class_extension", "foreign"],
    ["operator family extension", "operator_family_extension", "foreign"],
    ["operator class owner", "operator_class_owner_matches_extension", false],
    ["operator family owner", "operator_family_owner_matches_extension", false],
    ["operator class dependency count", "operator_class_dependency_count", "3"],
    ["operator class family dependency", "operator_class_family_dependency_count", 0],
    ["operator class extension dependency", "operator_class_extension_dependency_count", 0],
    ["operator class namespace dependency", "operator_class_namespace_dependency_count", 0],
    ["operator family dependency count", "operator_family_dependency_count", 3],
    ["operator family extension dependency", "operator_family_extension_dependency_count", 0],
    ["operator family namespace dependency", "operator_family_namespace_dependency_count", 0],
  ] as const)(
    "rejects malformed or spoofed gin_trgm_ops identity metadata: %s",
    async (_label, field, value) => {
      const fake = readyExecutor({
        operationOverrides: {
          inspectRequiredGinTrgmOperatorClass: mutateRows((rows) => {
            rows[0]![field] = value;
          }),
        },
      });

      const failure = await expectReadinessFailure(fake, "extension-preflight");
      expect(failure.operation).toBe("inspectRequiredGinTrgmOperatorClass");
    },
  );

  it.each([
    ["missing", (rows: QueryResultRow[]) => { rows.splice(0, 1); }],
    ["duplicate", (rows: QueryResultRow[]) => { rows.push({ ...rows[0]! }); }],
  ] as const)("rejects a %s gin_trgm_ops identity row fail-fast", async (_label, mutate) => {
    const fake = readyExecutor({
      operationOverrides: {
        inspectRequiredGinTrgmOperatorClass: mutateRows(mutate),
      },
    });

    const failure = await expectReadinessFailure(fake, "extension-preflight");
    expect(failure.operation).toBe("inspectRequiredGinTrgmOperatorClass");
    expect(fake.queries.map(({ options }) => options.operation)).toEqual([
      "inspectServerReadiness",
      "inspectRuntimeRolePolicy",
      "runtimeReadinessExtensions",
      "runtimeReadinessExtensions:probePgStatStatements",
      "inspectRequiredExtensionFunctions",
      "inspectRequiredExtensionOperator",
      "inspectRequiredGinTrgmOperatorClass",
    ]);
  });

  it.each(REQUIRED_GIN_TRGM_OPERATOR_ROWS.map(({ strategy_number }) => [strategy_number]))(
    "rejects a redirected gin_trgm_ops strategy %s operator implementation",
    async (strategyNumber) => {
      const fake = readyExecutor({
        operationOverrides: {
          inspectRequiredGinTrgmOperators: mutateRows((rows) => {
            const row = rows.find(({ strategy_number }) => strategy_number === strategyNumber);
            if (row !== undefined) row.implementation_identity = "public.foreign(text, text)";
          }),
        },
      });

      const failure = await expectReadinessFailure(fake, "extension-preflight");
      expect(failure.operation).toBe("inspectRequiredGinTrgmOperators");
    },
  );

  it.each([
    ["strategy number", "strategy_number", "1"],
    ["purpose", "purpose", "o"],
    ["left type", "left_type", "bytea"],
    ["right type", "right_type", "bytea"],
    ["operator identity", "operator_identity", "public.#(text, text)"],
    ["operator kind", "operator_kind", "l"],
    ["result type", "result_type", "integer"],
    ["commutator", "commutator_identity", null],
    ["negator", "negator_identity", "public.!(text, text)"],
    ["restriction estimator", "restriction_identity", "pg_catalog.eqsel(internal)"],
    ["join estimator", "join_identity", "pg_catalog.eqjoinsel(internal)"],
    ["merge property", "can_merge", true],
    ["hash property", "can_hash", true],
    ["sort family", "sort_family_identity", "pg_catalog.integer_ops"],
    ["access method", "access_method_name", "btree"],
    ["extension", "extension_name", "foreign"],
    ["owner", "owner_matches_extension", false],
    ["mapping dependency count", "mapping_dependency_count", "2"],
    ["mapping family dependency", "mapping_family_dependency_count", 0],
    ["mapping operator dependency", "mapping_operator_dependency_count", 0],
    ["operator dependency count", "operator_dependency_count", 4],
    ["operator extension dependency", "operator_extension_dependency_count", 0],
    ["operator implementation dependency", "operator_implementation_dependency_count", 0],
    ["operator namespace dependency", "operator_namespace_dependency_count", 0],
  ] as const)(
    "rejects malformed or spoofed gin_trgm_ops operator metadata: %s",
    async (_label, field, value) => {
      const fake = readyExecutor({
        operationOverrides: {
          inspectRequiredGinTrgmOperators: mutateRows((rows) => {
            rows[0]![field] = value;
          }),
        },
      });

      const failure = await expectReadinessFailure(fake, "extension-preflight");
      expect(failure.operation).toBe("inspectRequiredGinTrgmOperators");
    },
  );

  it.each([
    ["foreign built-in extension", "extension_name", "pg_trgm"],
    ["malformed built-in owner", "owner_matches_extension", true],
    ["extra built-in mapping dependency", "mapping_dependency_count", 2],
    ["foreign built-in operator dependency", "mapping_operator_dependency_count", 1],
  ] as const)("rejects spoofed built-in operator metadata: %s", async (_label, field, value) => {
    const fake = readyExecutor({
      operationOverrides: {
        inspectRequiredGinTrgmOperators: mutateRows((rows) => {
          rows[1]![field] = value;
        }),
      },
    });

    const failure = await expectReadinessFailure(fake, "extension-preflight");
    expect(failure.operation).toBe("inspectRequiredGinTrgmOperators");
  });

  it.each([
    ["missing", (rows: QueryResultRow[]) => { rows.splice(0, 1); }],
    ["duplicate", (rows: QueryResultRow[]) => { rows.push({ ...rows[0]! }); }],
    ["extra", (rows: QueryResultRow[]) => {
      rows.push({ ...rows[0]!, strategy_number: 13, operator_identity: "public.foreign(text, text)" });
    }],
  ] as const)("rejects a %s gin_trgm_ops operator mapping fail-fast", async (_label, mutate) => {
    const fake = readyExecutor({
      operationOverrides: {
        inspectRequiredGinTrgmOperators: mutateRows(mutate),
      },
    });

    const failure = await expectReadinessFailure(fake, "extension-preflight");
    expect(failure.operation).toBe("inspectRequiredGinTrgmOperators");
    expect(fake.queries.at(-1)?.options.operation).toBe("inspectRequiredGinTrgmOperators");
  });

  it("authenticates every indirect gin_trgm operator edge before support functions", async () => {
    const fake = readyExecutor();
    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: EXPECTED_OWNER,
    })).resolves.toBeDefined();
    expect(fake.queries.map(({ options }) => options.operation)).toContain(
      "inspectRequiredGinTrgmIndirectOperators",
    );
    expect(fake.queries.map(({ options }) => options.operation)).toEqual(expect.arrayContaining([
      "inspectRequiredGinTrgmOperators",
      "inspectRequiredGinTrgmIndirectOperators",
      "inspectRequiredGinTrgmSupportFunctions",
    ]));
  });

  it.each(REQUIRED_GIN_TRGM_INDIRECT_OPERATOR_ROWS.map(({ strategy_number, reference_kind }) => [
    strategy_number,
    reference_kind,
  ] as const))(
    "rejects a redirected indirect operator implementation for edge %s/%s",
    async (strategyNumber, referenceKind) => {
      const fake = readyExecutor({
        operationOverrides: {
          inspectRequiredGinTrgmIndirectOperators: mutateRows((rows) => {
            const row = rows.find((candidate) => (
              candidate.strategy_number === strategyNumber
              && candidate.reference_kind === referenceKind
            ));
            if (row !== undefined) row.implementation_identity = "public.foreign(text, text)";
          }),
        },
      });

      const failure = await expectReadinessFailure(fake, "extension-preflight");
      expect(failure.operation).toBe("inspectRequiredGinTrgmIndirectOperators");
    },
  );

  it.each([
    ["strategy number", "strategy_number", "7"],
    ["referring identity", "referring_operator_identity", "public.#(text, text)"],
    ["reference kind", "reference_kind", "other"],
    ["referenced oid", "referenced_operator_oid", "7001"],
    ["referenced identity", "referenced_operator_identity", "public.#(text, text)"],
    ["operator kind", "operator_kind", "l"],
    ["left type", "left_type", "bytea"],
    ["right type", "right_type", "bytea"],
    ["result type", "result_type", "integer"],
    ["implementation", "implementation_identity", "public.#(text, text)"],
    ["commutator", "commutator_identity", "public.#(text, text)"],
    ["negator", "negator_identity", "public.#(text, text)"],
    ["restriction", "restriction_identity", "pg_catalog.eqsel(internal)"],
    ["join", "join_identity", "pg_catalog.eqjoinsel(internal)"],
    ["merge capability", "can_merge", true],
    ["hash capability", "can_hash", true],
    ["reciprocal", "reciprocal_matches", false],
    ["extension", "extension_name", "foreign"],
    ["owner", "owner_matches_extension", false],
    ["dependency count", "dependency_count", "3"],
    ["extension dependency", "extension_dependency_count", 0],
    ["implementation dependency", "implementation_dependency_count", 0],
    ["namespace dependency", "namespace_dependency_count", 0],
  ] as const)(
    "rejects malformed or spoofed indirect operator metadata: %s",
    async (_label, field, value) => {
      const fake = readyExecutor({
        operationOverrides: {
          inspectRequiredGinTrgmIndirectOperators: mutateRows((rows) => {
            rows[0]![field] = value;
          }),
        },
      });

      const failure = await expectReadinessFailure(fake, "extension-preflight");
      expect(failure.operation).toBe("inspectRequiredGinTrgmIndirectOperators");
    },
  );

  it.each([
    ["missing", (rows: QueryResultRow[]) => { rows.splice(0, 1); }],
    ["duplicate", (rows: QueryResultRow[]) => { rows.push({ ...rows[0]! }); }],
    ["extra", (rows: QueryResultRow[]) => {
      rows.push({
        ...rows[0]!,
        strategy_number: 13,
        reference_kind: "commutator",
        referring_operator_identity: "public.foreign(text, text)",
      });
    }],
  ] as const)("rejects a %s indirect gin_trgm operator edge fail-fast", async (_label, mutate) => {
    const fake = readyExecutor({
      operationOverrides: {
        inspectRequiredGinTrgmIndirectOperators: mutateRows(mutate),
      },
    });

    const failure = await expectReadinessFailure(fake, "extension-preflight");
    expect(failure.operation).toBe("inspectRequiredGinTrgmIndirectOperators");
    expect(fake.queries.at(-1)?.options.operation).toBe("inspectRequiredGinTrgmIndirectOperators");
  });

  it.each(REQUIRED_GIN_TRGM_SUPPORT_ROWS.map(({ support_number }) => [support_number]))(
    "rejects a redirected gin_trgm_ops support function %s",
    async (supportNumber) => {
      const fake = readyExecutor({
        operationOverrides: {
          inspectRequiredGinTrgmSupportFunctions: mutateRows((rows) => {
            const row = rows.find(({ support_number }) => support_number === supportNumber);
            if (row !== undefined) row.function_identity = "public.foreign(text, internal)";
          }),
        },
      });

      const failure = await expectReadinessFailure(fake, "extension-preflight");
      expect(failure.operation).toBe("inspectRequiredGinTrgmSupportFunctions");
    },
  );

  it.each([
    ["support number", "support_number", "1"],
    ["left type", "left_type", "bytea"],
    ["right type", "right_type", "bytea"],
    ["function identity", "function_identity", null],
    ["dependency count", "dependency_count", "1"],
    ["family dependency", "family_auto_dependency_count", 0],
    ["operator class dependency", "operator_class_internal_dependency_count", 1],
    ["normal procedure dependency", "procedure_normal_dependency_count", 1],
    ["automatic procedure dependency", "procedure_auto_dependency_count", 1],
  ] as const)(
    "rejects malformed or spoofed gin_trgm_ops support metadata: %s",
    async (_label, field, value) => {
      const fake = readyExecutor({
        operationOverrides: {
          inspectRequiredGinTrgmSupportFunctions: mutateRows((rows) => {
            rows[0]![field] = value;
          }),
        },
      });

      const failure = await expectReadinessFailure(fake, "extension-preflight");
      expect(failure.operation).toBe("inspectRequiredGinTrgmSupportFunctions");
    },
  );

  it.each([
    ["missing", (rows: QueryResultRow[]) => { rows.splice(0, 1); }],
    ["duplicate", (rows: QueryResultRow[]) => { rows.push({ ...rows[0]! }); }],
    ["extra", (rows: QueryResultRow[]) => {
      rows.push({ ...rows[0]!, support_number: 5, function_identity: "public.foreign(text)" });
    }],
  ] as const)("rejects a %s gin_trgm_ops support mapping fail-fast", async (_label, mutate) => {
    const fake = readyExecutor({
      operationOverrides: {
        inspectRequiredGinTrgmSupportFunctions: mutateRows(mutate),
      },
    });

    const failure = await expectReadinessFailure(fake, "extension-preflight");
    expect(failure.operation).toBe("inspectRequiredGinTrgmSupportFunctions");
    expect(fake.queries.map(({ options }) => options.operation).slice(0, 10)).toEqual([
      "inspectServerReadiness",
      "inspectRuntimeRolePolicy",
      "runtimeReadinessExtensions",
      "runtimeReadinessExtensions:probePgStatStatements",
      "inspectRequiredExtensionFunctions",
      "inspectRequiredExtensionOperator",
      "inspectRequiredGinTrgmOperatorClass",
      "inspectRequiredGinTrgmOperators",
      "inspectRequiredGinTrgmIndirectOperators",
      "inspectRequiredGinTrgmSupportFunctions",
    ]);
  });

  it("propagates the caller signal to every readiness query", async () => {
    const fake = readyExecutor();
    const controller = new AbortController();

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: EXPECTED_OWNER,
      signal: controller.signal,
    })).resolves.toBeDefined();

    expect(fake.queries.length).toBeGreaterThan(0);
    expect(fake.queries.every(({ options }) => options.signal === controller.signal)).toBe(true);
  });

  it.each([
    ["missing role row", []],
    ["malformed current role", mutateFirstField("current_user_name", 17)],
    ["malformed session role", mutateFirstField("session_user_name", null)],
    ["session role mismatch", mutateFirstField("session_user_name", "other_runtime")],
    ["owner role", mutateRows((rows) => {
      rows[0]!.current_user_name = EXPECTED_OWNER;
      rows[0]!.session_user_name = EXPECTED_OWNER;
    })],
    ["missing role flag", mutateFirstField("role_exists", false)],
    ["superuser", mutateFirstField("superuser", true)],
    ["role creation", mutateFirstField("create_role", true)],
    ["database creation", mutateFirstField("create_database", true)],
    ["replication", mutateFirstField("replication", true)],
    ["row-security bypass", mutateFirstField("bypass_rls", true)],
    ["membership", mutateFirstField("membership_count", 1)],
    ["TLS", mutateFirstField("tls", false)],
    ["malformed boolean", mutateFirstField("superuser", "false")],
    ["expected owner match", mutateFirstField("expected_owner_match", true)],
  ] as const)("rejects runtime role policy: %s", async (_label, override) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { inspectRuntimeRolePolicy: override } }),
      "runtime-role-policy",
    );
  });

  it.each([
    ["malformed", "false"],
    ["granted", true],
  ] as const)(
    "rejects %s database CREATE privilege evidence before domain work",
    async (_label, databaseCreatePrivilege) => {
      const fake = readyExecutor({
        operationOverrides: {
          inspectRuntimeRolePolicy: mutateFirstField(
            "database_create_privilege",
            databaseCreatePrivilege,
          ),
        },
      });

      const failure = await expectReadinessFailure(fake, "runtime-role-policy");
      expect(failure.operation).toBe("inspectRuntimeRolePolicy");
      expect(fake.queries.map(({ options }) => options.operation)).toEqual([
        "inspectServerReadiness",
        "inspectRuntimeRolePolicy",
      ]);
    },
  );

  it.each([
    ["malformed", "false"],
    ["granted", true],
    ["null", null],
  ] as const)(
    "rejects %s session_replication_role SET privilege evidence before domain work",
    async (_label, sessionReplicationRoleSetPrivilege) => {
      const fake = readyExecutor({
        operationOverrides: {
          inspectRuntimeRolePolicy: mutateFirstField(
            "session_replication_role_set_privilege",
            sessionReplicationRoleSetPrivilege,
          ),
        },
      });

      const failure = await expectReadinessFailure(fake, "runtime-role-policy");
      expect(failure.operation).toBe("inspectRuntimeRolePolicy");
      expect(fake.queries.map(({ options }) => options.operation)).toEqual([
        "inspectServerReadiness",
        "inspectRuntimeRolePolicy",
      ]);
    },
  );

  it("accepts exact false database CREATE privilege evidence", async () => {
    const fake = readyExecutor();
    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: EXPECTED_OWNER,
    })).resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });

    const rolePolicyQuery = fake.queries.find(({ options }) => (
      options.operation === "inspectRuntimeRolePolicy"
    ));
    const text = (rolePolicyQuery?.config as { readonly text?: string } | undefined)?.text ?? "";
    expect(text).toContain("pg_catalog.has_database_privilege");
    expect(text).toContain("pg_catalog.has_parameter_privilege");
    expect(text).toContain("'session_replication_role'");
    expect(text).toContain("'SET'");
    expect(text).toContain("pg_catalog.current_database()");
  });

  it.each([
    ["runtime role owns the current database", mutateRows((rows) => {
      rows[0]!.database_owner_oid = "200";
      rows[0]!.database_owner_match = false;
    })],
    ["foreign role owns the current database", mutateRows((rows) => {
      rows[0]!.database_owner_oid = "300";
      rows[0]!.database_owner_match = false;
    })],
    ["database owner evidence is missing", mutateFirstField("database_owner_count", 0)],
    ["database owner evidence is duplicated", mutateFirstField("database_owner_count", 2)],
    ["database owner evidence is malformed", mutateFirstField("database_owner_oid", null)],
    ["expected owner evidence is malformed", mutateFirstField("expected_owner_oid", "not-an-oid")],
    ["database owner match is malformed", mutateFirstField("database_owner_match", "false")],
    ["role policy evidence is duplicated", (base: ReadyExecutorBaseResult) => (
      replaceRows(base, [...base.rows, ...base.rows])
    )],
  ] as const)("rejects database-owner authority evidence: %s before domain work", async (_label, override) => {
    const fake = readyExecutor({ operationOverrides: { inspectRuntimeRolePolicy: override } });
    await expectReadinessFailure(fake, "runtime-role-policy");
    expect(fake.queries.map(({ options }) => options.operation)).toEqual([
      "inspectServerReadiness",
      "inspectRuntimeRolePolicy",
    ]);
  });

  it.each([
    ["missing server row", []],
    ["unsupported major", mutateFirstField("server_version_num", 170000)],
    ["malformed version", mutateFirstField("server_version_num", "180004")],
    ["non-UTF8 encoding", mutateFirstField("server_encoding", "SQL_ASCII")],
    ["replica session replication role", mutateFirstField("session_replication_role", "replica")],
    ["local session replication role", mutateFirstField("session_replication_role", "local")],
    ["malformed session replication role", mutateFirstField("session_replication_role", null)],
    ["non-UTC timezone", mutateFirstField("timezone", "America/Sao_Paulo")],
    ["malformed timezone", mutateFirstField("timezone", null)],
    ["unencrypted connection", mutateFirstField("tls", false)],
  ] as const)("rejects server preflight: %s", async (_label, override) => {
    const fake = readyExecutor({ operationOverrides: { inspectServerReadiness: override } });
    await expectReadinessFailure(fake, "server-preflight");
    expect(fake.queries.map(({ options }) => options.operation)).toEqual([
      "inspectServerReadiness",
    ]);
  });

  it("accepts the exact 18.0.0 server version spelling", async () => {
    await expect(verifyPostgreSqlRuntimeSchema(
      readyExecutor({
        operationOverrides: { inspectServerReadiness: mutateFirstField("server_version_num", 180000) },
      }).seam,
      { expectedOwner: EXPECTED_OWNER },
    )).resolves.toBeDefined();
  });

  it("maps extension and search preflight errors to stable readiness reasons", async () => {
    await expectReadinessFailure(
      readyExecutor({
        operationOverrides: {
          "runtimeReadinessExtensions": mutateFirstField("installed_version", "2.0"),
        },
      }),
      "extension-preflight",
    );
    await expectReadinessFailure(
      readyExecutor({
        operationOverrides: {
          runtimeReadinessSearchConfiguration: mutateFirstField("actual_sha256", "0".repeat(64)),
        },
      }),
      "search-preflight",
    );
  });

  it.each([
    ["wrong ledger length", mutateRows((rows) => rows.pop())],
    ["malformed ledger id", mutateFirstField("id", 17)],
    ["malformed ledger checksum", mutateFirstField("checksum_sha256", 17)],
    ["ledger id drift", mutateFirstField("id", "0001_wrong")],
    ["ledger checksum drift", mutateFirstField("checksum_sha256", "0".repeat(64))],
  ] as const)("rejects migration ledger: %s", async (_label, override) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { readMigrations: override } }),
      "migration-ledger",
    );
  });

  it.each([
    ["missing ownership row", []],
    ["expected owner missing", mutateFirstField("expected_owner_exists", false)],
    ["schema missing", mutateFirstField("schema_exists", false)],
    ["schema ownership", mutateFirstField("schema_owned", false)],
    ["ledger missing", mutateFirstField("ledger_exists", false)],
    ["ledger kind", mutateFirstField("ledger_kind", "v")],
    ["ledger ownership", mutateFirstField("ledger_owned", false)],
    ["malformed expected count", mutateFirstField("expected_object_count", "1")],
    ["expected count drift", mutateFirstField("expected_object_count", 0)],
    ["malformed actual count", mutateFirstField("actual_object_count", "1")],
    ["actual count drift", mutateFirstField("actual_object_count", 0)],
    ["malformed owned count", mutateFirstField("owned_object_count", "1")],
    ["owned count drift", mutateFirstField("owned_object_count", 0)],
  ] as const)("rejects schema ownership: %s", async (_label, override) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { inspectSchemaOwnership: override } }),
      "schema-ownership",
    );
  });

  it.each([
    ["missing definition row", []],
    ["baseline not applied", mutateFirstField("baseline_applied", false)],
    ["definition expected count", mutateFirstField("expected_object_count", 0)],
    ["definition existing count malformed", mutateFirstField("existing_object_count", "1")],
    ["definition existing count drift", mutateFirstField("existing_object_count", 0)],
    ["definition missing count", mutateFirstField("missing_object_count", 1)],
    ["definition drift count", mutateFirstField("drifted_definition_group_count", 1)],
    ["invalid index count missing", mutateFirstField("invalid_index_count", undefined)],
    ["invalid index count malformed", mutateFirstField("invalid_index_count", "0")],
    ["invalid index count negative", mutateFirstField("invalid_index_count", -1)],
    ["invalid index count nonzero", mutateFirstField("invalid_index_count", 1)],
    ["definition counts malformed", mutateFirstField("actual_definition_group_counts", "bad")],
    ["definition hashes malformed", mutateFirstField("actual_definition_group_hashes", "bad")],
    ["definition counts length", mutateRows((rows) => {
      rows[0]!.actual_definition_group_counts = [];
    })],
    ["definition hashes length", mutateRows((rows) => {
      rows[0]!.actual_definition_group_hashes = [];
    })],
    ["definition count drift", mutateRows((rows) => {
      const counts = [...rows[0]!.actual_definition_group_counts as number[]];
      counts[0] = (counts[0] ?? 0) + 1;
      rows[0]!.actual_definition_group_counts = counts;
    })],
    ["definition hash drift", mutateRows((rows) => {
      const hashes = [...rows[0]!.actual_definition_group_hashes as string[]];
      hashes[0] = "0".repeat(64);
      rows[0]!.actual_definition_group_hashes = hashes;
    })],
  ] as const)("rejects schema definition fingerprint: %s", async (_label, override) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { inspectSchemaDefinitions: override } }),
      "schema-fingerprint",
    );
  });

  it("uses managed-table scope for every write-affecting definition inventory", async () => {
    const fake = readyExecutor();
    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });

    const definitionCall = fake.queries.find(({ options }) => (
      options.operation === "inspectSchemaDefinitions"
    ));
    expect(definitionCall).toBeDefined();
    const definitionConfig = definitionCall?.config as {
      readonly text?: string;
      readonly values?: readonly unknown[];
    };
    const snapshot = loadPostgreSqlSchemaSnapshots().at(-1)!;
    const expectations = getPostgreSqlSchemaSnapshotExpectations(snapshot);
    expect(definitionConfig.values).toHaveLength(12);
    expect(definitionConfig.values?.[1]).toEqual(snapshot.identitySequenceIdentities);
    expect(definitionConfig.values?.[2]).toEqual(snapshot.tableIdentities);
    expect(definitionConfig.values?.[5]).toBe(expectations.definitionObjectCount);
    expect(definitionConfig.values?.[6]).toEqual(expectations.definitionGroupKinds);
    expect(definitionConfig.values?.[7]).toEqual(expectations.definitionGroupCounts);
    expect(definitionConfig.values?.[8]).toEqual(expectations.definitionGroupHashes);
    expect(definitionConfig.values?.[9]).toBe("lcm_test_runtime");

    const text = definitionConfig.text ?? "";
    const section = (name: string, nextName: string): string => {
      const start = text.indexOf(name);
      const end = text.indexOf(nextName, start + name.length);
      return text.slice(start, end < 0 ? undefined : end);
    };
    const constraintInventory = section(
      "constraint_trigger_entries AS",
      "not_null_constraint_entries AS",
    );
    expect(constraintInventory).toContain("^RI_ConstraintTrigger_[ac]_[0-9]+$");
    expect(constraintInventory).toContain("constraint_metadata.conrelid");
    expect(constraintInventory).toContain("constraint_metadata.confrelid");
    expect(constraintInventory).toContain(
      "referenced_relation.relname OPERATOR(pg_catalog.=)",
    );
    expect(constraintInventory).toContain("ANY ($3::pg_catalog.text[])");
    expect(constraintInventory).toContain("OR (");
    expect(constraintInventory).not.toContain("ANY ($2::pg_catalog.text[])");
    const indexInventory = section("actual_indexes AS", "actual_triggers AS");
    expect(indexInventory).toContain("index_metadata.indisvalid AS is_valid");
    expect(indexInventory).toContain("index_metadata.indisready");
    expect(indexInventory).toContain("index_metadata.indislive");
    expect(indexInventory).not.toContain("AND index_metadata.indisvalid");
    expect(text).toContain("WHERE actual_indexes.is_valid IS DISTINCT FROM true");
    expect(text).toContain("AS invalid_index_count");
    const tableInventory = section("actual_tables AS", "acl_relations AS");
    expect(tableInventory).toContain("access_method.amname AS access_method");
    expect(tableInventory).toContain("JOIN pg_catalog.pg_am AS access_method");
    expect(tableInventory).toContain(
      "access_method.oid OPERATOR(pg_catalog.=) relation.relam",
    );
    expect(section("SELECT 'table'", "SELECT 'relation_acl'"))
      .toContain("table_name, access_method, persistence");
    const notNullInventory = section(
      "not_null_constraint_entries AS",
      "actual_identity_sequences AS",
    );
    expect(notNullInventory).toContain(
      "constraint_metadata.contype OPERATOR(pg_catalog.=) 'n'",
    );
    expect(notNullInventory).toContain("not_null_constraint_count");
    expect(notNullInventory).toContain("not_null_constraints");
    expect(section("actual_generated_columns AS", "actual_ordinary_columns AS"))
      .toContain("relation.relname OPERATOR(pg_catalog.=) ANY ($3::pg_catalog.text[])");
    expect(section("actual_ordinary_columns AS", "actual_identity_sequences AS"))
      .toContain("relation.relname OPERATOR(pg_catalog.=) ANY ($3::pg_catalog.text[])");
    expect(section("actual_generated_columns AS", "actual_ordinary_columns AS"))
      .not.toContain("ANY ($4::pg_catalog.text[])");
    expect(section("actual_ordinary_columns AS", "actual_identity_sequences AS"))
      .not.toContain("ANY ($4::pg_catalog.text[])");
    const columnAclGroup = section("SELECT 'column_acl'", "SELECT 'identity_sequence'");
    expect(columnAclGroup).toContain(
      "pg_catalog.count(DISTINCT object_identity)::pg_catalog.int4",
    );
    expect(columnAclGroup).not.toContain("pg_catalog.count(*)");
  });

  it.each([
    ["missing identity row", []],
    ["identity expected count", mutateFirstField("expected_function_count", 0)],
    ["identity existing count", mutateFirstField("existing_function_count", 0)],
    ["identity drift count", mutateFirstField("drifted_function_count", 1)],
  ] as const)("rejects identity function fingerprint: %s", async (_label, override) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { inspectIdentityFunctions: override } }),
      "schema-fingerprint",
    );
  });

  const aclOperations = [
    "inspectSchemaAcl",
    "inspectRelationAcl",
    "inspectColumnAcl",
    "inspectFunctionAcl",
  ] as const;

  it.each(aclOperations)("rejects malformed ACL rows for %s", async (operation) => {
    const override = operation === "inspectSchemaAcl"
      ? mutateFirstField("schema_name", null)
      : operation === "inspectFunctionAcl"
        ? mutateFirstField("function_identity", 17)
        : mutateFirstField("object_identity", 17);
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { [operation]: override } }),
      "acl-shape",
    );
  });

  it.each(aclOperations)("rejects missing ACL rows for %s", async (operation) => {
    await expectReadinessFailure(
      readyExecutor({
        operationOverrides: {
          [operation]: mutateRows((rows) => { rows.shift(); }),
        },
      }),
      "acl-shape",
    );
  });

  it.each([
    ["foreign grantee", (rows: QueryResultRow[]) => {
      rows[0]!.grantee_is_owner = false;
      rows[0]!.grantee_name = "foreign_role";
    }],
    ["foreign grantor", (rows: QueryResultRow[]) => { rows[0]!.grantor_is_owner = false; }],
    ["grant option", (rows: QueryResultRow[]) => { rows[0]!.is_grantable = true; }],
    ["extra", (rows: QueryResultRow[]) => {
      rows.push({ ...rows[0]!, privilege_type: "UNEXPECTED" });
    }],
  ] as const)("rejects %s ACL rows for every ACL category", async (_label, mutation) => {
    for (const operation of aclOperations) {
      await expectReadinessFailure(
        readyExecutor({ operationOverrides: { [operation]: mutateRows(mutation) } }),
        "acl-shape",
      );
    }
  });

  it("rejects a non-string ACL grantee after the boolean shape is valid", async () => {
    await expectReadinessFailure(
      readyExecutor({
        operationOverrides: {
          inspectSchemaAcl: mutateRows((rows) => {
            rows[0]!.grantee_is_owner = false;
            rows[0]!.grantee_name = 17;
          }),
        },
      }),
      "acl-shape",
    );
  });

  it.each(aclOperations)("rejects malformed ACL booleans for %s", async (operation) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { [operation]: mutateFirstField("is_grantable", "false") } }),
      "acl-shape",
    );
  });

  it.each([
    ["kind", mutateEffectiveRow((row) => { row.privilege_kind = "invalid"; })],
    ["object", mutateEffectiveRow((row) => { row.object_identity = 17; })],
    ["column", mutateEffectiveRow((row) => { row.column_name = 17; })],
    ["privilege", mutateEffectiveRow((row) => { row.privilege_type = 17; })],
    ["expected boolean", mutateEffectiveRow((row) => { row.expected = "true"; })],
    ["effective boolean", mutateEffectiveRow((row) => { row.effective = "true"; })],
  ] as const)("rejects malformed effective %s rows", async (_label, override) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { inspectEffectivePrivileges: override } }),
      "effective-privilege",
    );
  });

  it.each([
    ["duplicate", mutateEffectiveRow((_row, rows) => { rows[1] = { ...rows[0]! }; })],
    ["extra", mutateEffectiveRow((row) => { row.object_identity = "lcm.unexpected"; })],
    ["expected mismatch", mutateEffectiveRow((row) => { row.expected = false; })],
    ["effective mismatch", mutateEffectiveRow((row) => { row.effective = false; })],
  ] as const)("rejects effective privilege %s", async (_label, override) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { inspectEffectivePrivileges: override } }),
      "effective-privilege",
    );
  });

  it("rejects duplicate generated effective privilege keys", async () => {
    migrationMockState.duplicateColumnIdentity = true;
    try {
      await expectReadinessFailure(readyExecutor(), "effective-privilege");
    } finally {
      migrationMockState.duplicateColumnIdentity = false;
    }
  });

  it("rejects a valid migration ledger when no matching snapshot exists", async () => {
    migrationMockState.returnNoLatestSnapshot = true;
    try {
      await expectReadinessFailure(readyExecutor(), "migration-ledger");
    } finally {
      migrationMockState.returnNoLatestSnapshot = false;
    }
  });

  it("sanitizes an unexpected executor error while preserving known readiness errors", async () => {
    const unexpected = await verifyPostgreSqlRuntimeSchema(readyExecutor({
      operationOverrides: {
        inspectServerReadiness: { error: new Error("secret executor detail") },
      },
    }).seam, { expectedOwner: EXPECTED_OWNER }).catch((error: unknown) => error);
    expect(unexpected).toMatchObject({
      reason: "server-preflight",
      operation: "verifyRuntimeReadiness",
    });
    expect(JSON.stringify(unexpected)).not.toContain("secret executor detail");

    const known = await verifyPostgreSqlRuntimeSchema(readyExecutor({
      operationOverrides: { inspectServerReadiness: [] },
    }).seam, { expectedOwner: EXPECTED_OWNER }).catch((error: unknown) => error);
    expect(known).toMatchObject({
      reason: "server-preflight",
      operation: "inspectServerReadiness",
    });
  });

  it("accepts sequence runtime USAGE using sequence identities in direct ACL verification", async () => {
    const fake = readyExecutor({ includeSequenceRuntimeGrant: true });

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });
  });

  it("accepts the hardened lcm schema ACL without a PUBLIC USAGE default", async () => {
    const fake = readyExecutor({ omitLcmPublicDefault: true });

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });
  });

  it("accepts hardened public schema and extension function ACL defaults", async () => {
    const fake = readyExecutor({
      omitPublicSchemaUsage: true,
      omitPublicFunctionExecute: true,
    });

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });
  });

  it.each([
    ["missing", null],
    ["malformed", 17],
    ["detached", null],
    ["wrong extension", "foreign_extension"],
  ] as const)("rejects %s extension ownership evidence for required functions", async (_label, extensionName) => {
    await expectReadinessFailure(
      readyExecutor({
        operationOverrides: {
          inspectFunctionAcl: mutateRows((rows) => {
            const row = rows.find(({ function_identity }) => function_identity === "public.digest(text, text)");
            if (row !== undefined) row.extension_name = extensionName;
          }),
        },
      }),
      "acl-shape",
    );
  });

  it("accepts readiness when the optional transcript grant set is entirely absent", async () => {
    const fake = readyExecutor({ omitOptionalDirectGrants: true });

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });
    expect(fake.queries.map(({ options: queryOptions }) => queryOptions.operation))
      .toContain("inspectEffectivePrivileges");
  });

  it("rejects a partial optional effective grant set", async () => {
    const fake = readyExecutor({ partialOptionalEffectiveGrants: true });

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).rejects.toMatchObject({ reason: "effective-privilege" });
  });

  it("rejects a partial optional direct grant set after inspecting relation and column ACLs", async () => {
    const fake = readyExecutor({ partialOptionalDirectGrants: true });

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).rejects.toMatchObject({ reason: "acl-shape" });
    expect(fake.queries.map(({ options: queryOptions }) => queryOptions.operation))
      .toEqual(expect.arrayContaining(["inspectRelationAcl", "inspectColumnAcl"]));
  });

  it("probes tables separately from sequences and probes SELECT column privileges", async () => {
    const fake = readyExecutor();
    await verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    });

    expect(fake.queries.map(({ options: queryOptions }) => queryOptions.operation))
      .toContain("inspectEffectivePrivileges");

    const effective = fake.queries.find(({ options: queryOptions }) => (
      queryOptions.operation === "inspectEffectivePrivileges"
    ));
    expect(effective).toBeDefined();
    const config = effective!.config as { readonly text: string; readonly values: readonly unknown[] };
    const relationObjects = config.values[4] as readonly string[];
    const sequenceObjects = config.values[7] as readonly string[];
    const columnPrivileges = config.values[12] as readonly string[];
    const functionObjects = config.values[14] as readonly string[];
    const functionLookupObjects = config.values[15] as readonly string[];
    const functionExpected = config.values[16] as readonly boolean[];

    expect(relationObjects.every((object) => !object.includes("_seq"))).toBe(true);
    expect(sequenceObjects).toEqual(expect.arrayContaining([
      "lcm.conversations_conversation_id_seq",
      "lcm.messages_message_id_seq",
    ]));
    expect(columnPrivileges).toContain("SELECT");
    expect(functionObjects).toContain("lcm.normalize_search_text(input text)");
    expect(functionLookupObjects).toContain("lcm.normalize_search_text(text)");
    expect(functionExpected.every((expected) => expected === true)).toBe(true);
    expect(config.text).toContain("has_table_privilege");
    expect(config.text).toContain("has_sequence_privilege");
    expect(config.text).toContain("has_column_privilege");
  });

  it("rejects an incomplete effective privilege probe result", async () => {
    const fake = readyExecutor({ incompleteEffectivePrivileges: true });

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).rejects.toMatchObject({ reason: "effective-privilege" });
  });

  it("returns only a frozen sanitized witness after complete read-only readiness", async () => {
    const fake = readyExecutor();

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).resolves.toMatchObject({
      currentMigrationIds: expect.any(Array),
      expectedOwner: "lcm_test_migrator",
      runtimeRole: expect.any(String),
      managedObjectCount: expect.any(Number),
      definitionObjectCount: expect.any(Number),
      privilegeManifestVersion: POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.version,
    });
    const witness = await verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    });
    expect(Object.isFrozen(witness)).toBe(true);
    expect(Object.isFrozen(witness.currentMigrationIds)).toBe(true);
    expect(Object.keys(witness).sort()).toEqual([
      "currentMigrationIds",
      "definitionObjectCount",
      "expectedOwner",
      "managedObjectCount",
      "privilegeManifestVersion",
      "runtimeRole",
    ]);
  });

  it("fails closed without exposing observed ownership, memberships, SQL, or values", async () => {
    const fake = executor();
    const error = await verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    }).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      backend: "postgresql",
      operation: expect.any(String),
    });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain("attacker_owner");
    expect(serialized).not.toContain("lcm_test_runtime");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("SELECT");
  });

  it("binds expected-owner checks and never emits mutating or migration-lock SQL", async () => {
    const fake = readyExecutor();
    await verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "attacker_owner",
    }).catch(() => undefined);

    expect(fake.queries.some(({ config }) => (
      typeof config === "object"
      && config !== null
      && "values" in config
      && Array.isArray((config as { values?: unknown[] }).values)
      && (config as { values: unknown[] }).values.includes("attacker_owner")
    ))).toBe(true);
    for (const { config } of fake.queries) {
      const text = typeof config === "object" && config !== null && "text" in config
        ? String((config as { text?: unknown }).text)
        : "";
      const sqlWithoutStringLiterals = text.replace(/'(?:''|[^'])*'/gu, "''");
      expect(sqlWithoutStringLiterals).not.toMatch(
        /\b(?:CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE)\b/iu,
      );
      expect(text).not.toContain("pg_advisory");
      expect(text).not.toContain("schema_migrations (id");
    }
  });

  it.each([
    "",
    "attacker\nowner",
    "a".repeat(64),
  ])("rejects malformed configured owner %j before database access", async (expectedOwner) => {
    const fake = executor();
    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, { expectedOwner }))
      .rejects.toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED" });
    expect(fake.queries).toHaveLength(0);
  });
});
