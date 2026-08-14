import type { QueryConfig, QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
} from "./contracts.js";
import {
  assertRequiredPostgreSqlExtensionsReady,
  PostgreSqlExtensionPreflightError,
} from "./extensions.js";
import {
  getPostgreSqlSchemaSnapshotExpectations,
  loadPostgreSqlMigrations,
  loadPostgreSqlSchemaSnapshots,
  selectLatestPostgreSqlSchemaSnapshot,
  validatePostgreSqlMigrations,
  validatePostgreSqlSchemaSnapshotRegistry,
  type PostgreSqlSchemaSnapshot,
} from "./migrations.js";
import {
  assertPostgreSqlSearchConfigurationReady,
  PostgreSqlSearchConfigurationPreflightError,
} from "./search-configuration.js";

const READINESS_DOMAIN = "factory" as const;
const MAX_POSTGRESQL_ROLE_BYTES = 63;

export type PostgreSqlRuntimePrivilegeKind =
  | "schema"
  | "relation"
  | "column"
  | "sequence"
  | "function";

export interface PostgreSqlRuntimePrivilegeEntry {
  readonly kind: PostgreSqlRuntimePrivilegeKind;
  readonly object: string;
  readonly privilege: string;
  readonly column?: string;
  readonly grantor: "object-owner";
  readonly extension?: "pgcrypto" | "pg_trgm";
}

export interface PostgreSqlRuntimePrivilegeManifest {
  readonly version: number;
  readonly required: readonly PostgreSqlRuntimePrivilegeEntry[];
  readonly optional: readonly PostgreSqlRuntimePrivilegeEntry[];
}

export interface PostgreSqlRuntimeReadiness {
  readonly currentMigrationIds: readonly string[];
  readonly expectedOwner: string;
  readonly runtimeRole: string;
  readonly managedObjectCount: number;
  readonly definitionObjectCount: number;
  readonly privilegeManifestVersion: number;
}

type RelationPrivilegeSpec = readonly [string, readonly string[]];
type ColumnPrivilegeSpec = readonly [string, string, string];

interface RequiredFunctionImplementation {
  readonly functionIdentity: string;
  readonly extension: "pgcrypto" | "pg_trgm" | null;
  readonly language: "c" | "internal";
  readonly library: string | null;
  readonly symbol: string;
  readonly returnType: string;
  readonly volatility: "i" | "s";
  readonly leakproof: boolean;
  readonly supportFunctionIdentity: string | null;
}

interface RequiredGinTrgmOperatorMapping {
  readonly strategyNumber: number;
  readonly operatorIdentity: string;
  readonly implementationIdentity: string;
  readonly commutatorIdentity: string | null;
  readonly negatorIdentity: string | null;
  readonly restrictionIdentity: string;
  readonly joinIdentity: string;
  readonly extension: "pg_trgm" | null;
  readonly canMerge: boolean;
  readonly canHash: boolean;
}

interface RequiredGinTrgmSupportFunction {
  readonly supportNumber: number;
  readonly functionIdentity: string;
  readonly dependencyKind: "family" | "operator-class";
}

function schemaEntry(object: string, privilege: string): PostgreSqlRuntimePrivilegeEntry {
  return { kind: "schema", object, privilege, grantor: "object-owner" };
}

function relationEntry(object: string, privilege: string): PostgreSqlRuntimePrivilegeEntry {
  return { kind: "relation", object: `lcm.${object}`, privilege, grantor: "object-owner" };
}

function columnEntry(
  object: string,
  column: string,
  privilege: string,
): PostgreSqlRuntimePrivilegeEntry {
  return {
    kind: "column",
    object: `lcm.${object}`,
    column,
    privilege,
    grantor: "object-owner",
  };
}

function sequenceEntry(object: string): PostgreSqlRuntimePrivilegeEntry {
  return {
    kind: "sequence",
    object: `lcm.${object}`,
    privilege: "USAGE",
    grantor: "object-owner",
  };
}

function functionEntry(
  object: string,
  extension: "pgcrypto" | "pg_trgm" | undefined,
): PostgreSqlRuntimePrivilegeEntry {
  return {
    kind: "function",
    object,
    privilege: "EXECUTE",
    grantor: "object-owner",
    ...(extension === undefined ? {} : { extension }),
  };
}

function expandRelationPrivileges(
  specifications: readonly RelationPrivilegeSpec[],
): readonly PostgreSqlRuntimePrivilegeEntry[] {
  return specifications.flatMap(([object, privileges]) => (
    privileges.map((privilege) => relationEntry(object, privilege))
  ));
}

function expandColumnPrivileges(
  specifications: readonly ColumnPrivilegeSpec[],
): readonly PostgreSqlRuntimePrivilegeEntry[] {
  return specifications.map(([object, column, privilege]) => (
    columnEntry(object, column, privilege)
  ));
}

const REQUIRED_RELATION_PRIVILEGES: readonly RelationPrivilegeSpec[] = [
  ["schema_migrations", ["SELECT"]],
  ["fenced_leases", ["SELECT", "DELETE"]],
  ["machines", ["SELECT"]],
  ["projects", ["SELECT", "DELETE"]],
  ["project_aliases", ["SELECT", "DELETE"]],
  ["conversations", ["SELECT"]],
  ["messages", ["SELECT", "DELETE"]],
  ["message_parts", ["SELECT"]],
  ["summary_messages", ["SELECT"]],
  ["context_items", ["SELECT", "DELETE"]],
  ["summaries", ["SELECT"]],
  ["summary_parents", ["SELECT"]],
  ["summary_large_files", ["SELECT"]],
  ["large_files", ["SELECT"]],
  ["promoted_memories", ["SELECT", "DELETE"]],
  ["promoted_memory_tags", ["SELECT", "DELETE"]],
  ["recall_surfacing", ["SELECT", "DELETE"]],
  ["redaction_counters", ["SELECT", "DELETE"]],
  ["session_ingest_log", ["SELECT", "DELETE"]],
  ["session_instructions", ["SELECT", "DELETE"]],
  ["passive_event_inbox", ["SELECT", "DELETE"]],
] as const;

const REQUIRED_COLUMN_PRIVILEGES: readonly ColumnPrivilegeSpec[] = [
  ["machines", "identity_key", "INSERT"],
  ["machines", "display_name", "INSERT"],
  ["machines", "display_name", "UPDATE"],
  ["machines", "last_seen_at", "UPDATE"],
  ["projects", "project_id", "INSERT"],
  ["projects", "identity_key", "INSERT"],
  ["projects", "display_name", "INSERT"],
  ["project_aliases", "project_id", "INSERT"],
  ["project_aliases", "machine_id", "INSERT"],
  ["project_aliases", "path", "INSERT"],
  ["project_aliases", "normalized_path", "INSERT"],
  ["project_aliases", "project_id", "UPDATE"],
  ["project_aliases", "path", "UPDATE"],
  ["project_aliases", "linked_at", "UPDATE"],
  ["conversations", "project_id", "INSERT"],
  ["conversations", "session_id", "INSERT"],
  ["conversations", "title", "INSERT"],
  ["conversations", "bootstrapped_at", "UPDATE"],
  ["conversations", "updated_at", "UPDATE"],
  ["messages", "project_id", "INSERT"],
  ["messages", "conversation_id", "INSERT"],
  ["messages", "seq", "INSERT"],
  ["messages", "role", "INSERT"],
  ["messages", "content", "INSERT"],
  ["messages", "token_count", "INSERT"],
  ["message_parts", "project_id", "INSERT"],
  ["message_parts", "conversation_id", "INSERT"],
  ["message_parts", "message_id", "INSERT"],
  ["message_parts", "session_id", "INSERT"],
  ["message_parts", "part_type", "INSERT"],
  ["message_parts", "ordinal", "INSERT"],
  ["message_parts", "text_content", "INSERT"],
  ["message_parts", "tool_call_id", "INSERT"],
  ["message_parts", "tool_name", "INSERT"],
  ["message_parts", "tool_input", "INSERT"],
  ["message_parts", "tool_output", "INSERT"],
  ["message_parts", "metadata", "INSERT"],
  ["summaries", "summary_id", "INSERT"],
  ["summaries", "project_id", "INSERT"],
  ["summaries", "conversation_id", "INSERT"],
  ["summaries", "kind", "INSERT"],
  ["summaries", "depth", "INSERT"],
  ["summaries", "content", "INSERT"],
  ["summaries", "token_count", "INSERT"],
  ["summaries", "earliest_at", "INSERT"],
  ["summaries", "latest_at", "INSERT"],
  ["summaries", "descendant_count", "INSERT"],
  ["summaries", "descendant_token_count", "INSERT"],
  ["summaries", "source_message_token_count", "INSERT"],
  ["summary_messages", "project_id", "INSERT"],
  ["summary_messages", "conversation_id", "INSERT"],
  ["summary_messages", "summary_key", "INSERT"],
  ["summary_messages", "message_id", "INSERT"],
  ["summary_messages", "ordinal", "INSERT"],
  ["summary_parents", "project_id", "INSERT"],
  ["summary_parents", "conversation_id", "INSERT"],
  ["summary_parents", "summary_key", "INSERT"],
  ["summary_parents", "parent_summary_key", "INSERT"],
  ["summary_parents", "ordinal", "INSERT"],
  ["summary_large_files", "project_id", "INSERT"],
  ["summary_large_files", "conversation_id", "INSERT"],
  ["summary_large_files", "summary_key", "INSERT"],
  ["summary_large_files", "file_id", "INSERT"],
  ["summary_large_files", "ordinal", "INSERT"],
  ["context_items", "project_id", "INSERT"],
  ["context_items", "conversation_id", "INSERT"],
  ["context_items", "ordinal", "INSERT"],
  ["context_items", "item_type", "INSERT"],
  ["context_items", "message_id", "INSERT"],
  ["context_items", "summary_key", "INSERT"],
  ["context_items", "ordinal", "UPDATE"],
  ["large_files", "file_id", "INSERT"],
  ["large_files", "project_id", "INSERT"],
  ["large_files", "conversation_id", "INSERT"],
  ["large_files", "file_name", "INSERT"],
  ["large_files", "mime_type", "INSERT"],
  ["large_files", "byte_size", "INSERT"],
  ["large_files", "storage_uri", "INSERT"],
  ["large_files", "exploration_summary", "INSERT"],
  ["promoted_memories", "project_id", "INSERT"],
  ["promoted_memories", "content", "INSERT"],
  ["promoted_memories", "source_summary_id", "INSERT"],
  ["promoted_memories", "source_project_id", "INSERT"],
  ["promoted_memories", "session_id", "INSERT"],
  ["promoted_memories", "depth", "INSERT"],
  ["promoted_memories", "confidence", "INSERT"],
  ["promoted_memories", "metadata", "INSERT"],
  ["promoted_memories", "content", "UPDATE"],
  ["promoted_memories", "confidence", "UPDATE"],
  ["promoted_memories", "metadata", "UPDATE"],
  ["promoted_memories", "archived_at", "UPDATE"],
  ["promoted_memory_tags", "project_id", "INSERT"],
  ["promoted_memory_tags", "memory_id", "INSERT"],
  ["promoted_memory_tags", "ordinal", "INSERT"],
  ["promoted_memory_tags", "tag", "INSERT"],
  ["recall_surfacing", "project_id", "INSERT"],
  ["recall_surfacing", "memory_id", "INSERT"],
  ["recall_surfacing", "session_id", "INSERT"],
  ["redaction_counters", "project_id", "INSERT"],
  ["redaction_counters", "category", "INSERT"],
  ["redaction_counters", "count", "INSERT"],
  ["redaction_counters", "count", "UPDATE"],
  ["redaction_counters", "updated_at", "UPDATE"],
  ["session_ingest_log", "project_id", "INSERT"],
  ["session_ingest_log", "session_id", "INSERT"],
  ["session_ingest_log", "message_count", "INSERT"],
  ["session_ingest_log", "message_count", "UPDATE"],
  ["session_ingest_log", "completed_at", "UPDATE"],
  ["session_instructions", "project_id", "INSERT"],
  ["session_instructions", "machine_id", "INSERT"],
  ["session_instructions", "scope_hash", "INSERT"],
  ["session_instructions", "client_name", "INSERT"],
  ["session_instructions", "session_id", "INSERT"],
  ["session_instructions", "worktree_path", "INSERT"],
  ["session_instructions", "cwd_path", "INSERT"],
  ["session_instructions", "content", "INSERT"],
  ["session_instructions", "content_hash", "INSERT"],
  ["session_instructions", "content", "UPDATE"],
  ["session_instructions", "content_hash", "UPDATE"],
  ["session_instructions", "updated_at", "UPDATE"],
  ["fenced_leases", "project_id", "INSERT"],
  ["fenced_leases", "resource_type", "INSERT"],
  ["fenced_leases", "resource_key", "INSERT"],
  ["fenced_leases", "owner_machine_id", "INSERT"],
  ["fenced_leases", "owner_process_id", "INSERT"],
  ["fenced_leases", "operation", "INSERT"],
  ["fenced_leases", "expires_at", "INSERT"],
  ["fenced_leases", "owner_machine_id", "UPDATE"],
  ["fenced_leases", "owner_process_id", "UPDATE"],
  ["fenced_leases", "operation", "UPDATE"],
  ["fenced_leases", "fencing_token", "UPDATE"],
  ["fenced_leases", "acquired_at", "UPDATE"],
  ["fenced_leases", "renewed_at", "UPDATE"],
  ["fenced_leases", "expires_at", "UPDATE"],
  ["fenced_leases", "released_at", "UPDATE"],
  ["passive_event_inbox", "project_id", "INSERT"],
  ["passive_event_inbox", "machine_id", "INSERT"],
  ["passive_event_inbox", "event_id", "INSERT"],
  ["passive_event_inbox", "event_version", "INSERT"],
  ["passive_event_inbox", "machine_sequence", "INSERT"],
  ["passive_event_inbox", "event_type", "INSERT"],
  ["passive_event_inbox", "payload", "INSERT"],
  ["passive_event_inbox", "status", "UPDATE"],
  ["passive_event_inbox", "attempt_count", "UPDATE"],
  ["passive_event_inbox", "next_attempt_at", "UPDATE"],
  ["passive_event_inbox", "claimed_at", "UPDATE"],
  ["passive_event_inbox", "claimed_by", "UPDATE"],
  ["passive_event_inbox", "applied_at", "UPDATE"],
  ["passive_event_inbox", "quarantined_at", "UPDATE"],
  ["passive_event_inbox", "quarantine_reason", "UPDATE"],
] as const;

const REQUIRED_SEQUENCE_PRIVILEGES = [
  "conversations_conversation_id_seq",
  "messages_message_id_seq",
  "fenced_leases_fencing_token_seq",
  "passive_event_inbox_inbox_id_seq",
  "recall_surfacing_surfacing_id_seq",
  "session_instructions_instruction_id_seq",
] as const;

function extensionFunctionImplementation(input: {
  readonly functionIdentity: string;
  readonly extension: "pgcrypto" | "pg_trgm";
  readonly symbol: string;
  readonly returnType: string;
  readonly volatility: "i" | "s";
}): RequiredFunctionImplementation {
  return {
    ...input,
    language: "c",
    library: `$libdir/${input.extension}`,
    leakproof: false,
    supportFunctionIdentity: null,
  };
}

function internalFunctionImplementation(input: {
  readonly functionIdentity: string;
  readonly symbol: string;
  readonly returnType: string;
  readonly volatility: "i" | "s";
  readonly leakproof?: boolean;
  readonly supportFunctionIdentity?: string;
}): RequiredFunctionImplementation {
  return {
    functionIdentity: input.functionIdentity,
    extension: null,
    language: "internal",
    library: null,
    symbol: input.symbol,
    returnType: input.returnType,
    volatility: input.volatility,
    leakproof: input.leakproof ?? false,
    supportFunctionIdentity: input.supportFunctionIdentity ?? null,
  };
}

const REQUIRED_RUNTIME_EXTENSION_FUNCTION_IMPLEMENTATIONS = [
  {
    functionIdentity: "public.digest(text, text)",
    extension: "pgcrypto",
    library: "$libdir/pgcrypto",
    symbol: "pg_digest",
    returnType: "bytea",
    volatility: "i",
    language: "c",
    leakproof: false,
    supportFunctionIdentity: null,
  },
  {
    functionIdentity: "public.digest(bytea, text)",
    extension: "pgcrypto",
    library: "$libdir/pgcrypto",
    symbol: "pg_digest",
    returnType: "bytea",
    volatility: "i",
    language: "c",
    leakproof: false,
    supportFunctionIdentity: null,
  },
  {
    functionIdentity: "public.similarity(text, text)",
    extension: "pg_trgm",
    library: "$libdir/pg_trgm",
    symbol: "similarity",
    returnType: "real",
    volatility: "i",
    language: "c",
    leakproof: false,
    supportFunctionIdentity: null,
  },
  {
    functionIdentity: "public.similarity_op(text, text)",
    extension: "pg_trgm",
    library: "$libdir/pg_trgm",
    symbol: "similarity_op",
    returnType: "boolean",
    volatility: "s",
    language: "c",
    leakproof: false,
    supportFunctionIdentity: null,
  },
] as const satisfies readonly RequiredFunctionImplementation[];

const REQUIRED_GIN_TRGM_FUNCTION_IMPLEMENTATIONS = [
  ...[
    ["public.word_similarity_commutator_op(text, text)", "word_similarity_commutator_op"],
    [
      "public.strict_word_similarity_commutator_op(text, text)",
      "strict_word_similarity_commutator_op",
    ],
    ["public.word_similarity_op(text, text)", "word_similarity_op"],
    ["public.strict_word_similarity_op(text, text)", "strict_word_similarity_op"],
  ].map(([functionIdentity, symbol]) => extensionFunctionImplementation({
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
  ].map(([functionIdentity, symbol, returnType]) => extensionFunctionImplementation({
    functionIdentity: functionIdentity!,
    extension: "pg_trgm",
    symbol: symbol!,
    returnType: returnType!,
    volatility: "i",
  })),
  internalFunctionImplementation({
    functionIdentity: "pg_catalog.btint4cmp(integer, integer)",
    symbol: "btint4cmp",
    returnType: "integer",
    volatility: "i",
    leakproof: true,
  }),
  internalFunctionImplementation({
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
  ].map(([functionIdentity, symbol, supportFunctionIdentity]) => (
    internalFunctionImplementation({
      functionIdentity: functionIdentity!,
      symbol: symbol!,
      returnType: "boolean",
      volatility: "i",
      supportFunctionIdentity,
    })
  )),
  ...[
    "textlike_support",
    "texticlike_support",
    "textregexeq_support",
    "texticregexeq_support",
  ].map((symbol) => internalFunctionImplementation({
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
  ].map(([symbol, finalArguments]) => internalFunctionImplementation({
    functionIdentity: `pg_catalog.${symbol}(internal, oid, internal, ${finalArguments})`,
    symbol: symbol!,
    returnType: "double precision",
    volatility: "s",
  })),
] as const satisfies readonly RequiredFunctionImplementation[];

const REQUIRED_TRUSTED_FUNCTION_IMPLEMENTATIONS = [
  ...REQUIRED_RUNTIME_EXTENSION_FUNCTION_IMPLEMENTATIONS,
  ...REQUIRED_GIN_TRGM_FUNCTION_IMPLEMENTATIONS,
] as const satisfies readonly RequiredFunctionImplementation[];

const REQUIRED_FUNCTION_PRIVILEGES = [
  ["lcm.normalize_search_text(input text)", undefined],
  ...REQUIRED_RUNTIME_EXTENSION_FUNCTION_IMPLEMENTATIONS.map(({ functionIdentity, extension }) => (
    [functionIdentity, extension] as const
  )),
] as const;

const REQUIRED_GIN_TRGM_OPERATOR_MAPPINGS = [
  {
    strategyNumber: 1,
    operatorIdentity: "public.%(text, text)",
    implementationIdentity: "public.similarity_op(text, text)",
    commutatorIdentity: "public.%(text, text)",
    negatorIdentity: null,
    restrictionIdentity: "pg_catalog.matchingsel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.matchingjoinsel(internal, oid, internal, smallint, internal)",
    extension: "pg_trgm",
    canMerge: false,
    canHash: false,
  },
  {
    strategyNumber: 3,
    operatorIdentity: "pg_catalog.~~(text, text)",
    implementationIdentity: "pg_catalog.textlike(text, text)",
    commutatorIdentity: null,
    negatorIdentity: "pg_catalog.!~~(text, text)",
    restrictionIdentity: "pg_catalog.likesel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.likejoinsel(internal, oid, internal, smallint, internal)",
    extension: null,
    canMerge: false,
    canHash: false,
  },
  {
    strategyNumber: 4,
    operatorIdentity: "pg_catalog.~~*(text, text)",
    implementationIdentity: "pg_catalog.texticlike(text, text)",
    commutatorIdentity: null,
    negatorIdentity: "pg_catalog.!~~*(text, text)",
    restrictionIdentity: "pg_catalog.iclikesel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.iclikejoinsel(internal, oid, internal, smallint, internal)",
    extension: null,
    canMerge: false,
    canHash: false,
  },
  {
    strategyNumber: 5,
    operatorIdentity: "pg_catalog.~(text, text)",
    implementationIdentity: "pg_catalog.textregexeq(text, text)",
    commutatorIdentity: null,
    negatorIdentity: "pg_catalog.!~(text, text)",
    restrictionIdentity: "pg_catalog.regexeqsel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.regexeqjoinsel(internal, oid, internal, smallint, internal)",
    extension: null,
    canMerge: false,
    canHash: false,
  },
  {
    strategyNumber: 6,
    operatorIdentity: "pg_catalog.~*(text, text)",
    implementationIdentity: "pg_catalog.texticregexeq(text, text)",
    commutatorIdentity: null,
    negatorIdentity: "pg_catalog.!~*(text, text)",
    restrictionIdentity: "pg_catalog.icregexeqsel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.icregexeqjoinsel(internal, oid, internal, smallint, internal)",
    extension: null,
    canMerge: false,
    canHash: false,
  },
  {
    strategyNumber: 7,
    operatorIdentity: "public.%>(text, text)",
    implementationIdentity: "public.word_similarity_commutator_op(text, text)",
    commutatorIdentity: "public.<%(text, text)",
    negatorIdentity: null,
    restrictionIdentity: "pg_catalog.matchingsel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.matchingjoinsel(internal, oid, internal, smallint, internal)",
    extension: "pg_trgm",
    canMerge: false,
    canHash: false,
  },
  {
    strategyNumber: 9,
    operatorIdentity: "public.%>>(text, text)",
    implementationIdentity: "public.strict_word_similarity_commutator_op(text, text)",
    commutatorIdentity: "public.<<%(text, text)",
    negatorIdentity: null,
    restrictionIdentity: "pg_catalog.matchingsel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.matchingjoinsel(internal, oid, internal, smallint, internal)",
    extension: "pg_trgm",
    canMerge: false,
    canHash: false,
  },
  {
    strategyNumber: 11,
    operatorIdentity: "pg_catalog.=(text, text)",
    implementationIdentity: "pg_catalog.texteq(text, text)",
    commutatorIdentity: "pg_catalog.=(text, text)",
    negatorIdentity: "pg_catalog.<>(text, text)",
    restrictionIdentity: "pg_catalog.eqsel(internal, oid, internal, integer)",
    joinIdentity: "pg_catalog.eqjoinsel(internal, oid, internal, smallint, internal)",
    extension: null,
    canMerge: true,
    canHash: true,
  },
] as const satisfies readonly RequiredGinTrgmOperatorMapping[];

const REQUIRED_GIN_TRGM_SUPPORT_FUNCTIONS = [
  {
    supportNumber: 1,
    functionIdentity: "pg_catalog.btint4cmp(integer, integer)",
    dependencyKind: "family",
  },
  {
    supportNumber: 2,
    functionIdentity: "public.gin_extract_value_trgm(text, internal)",
    dependencyKind: "operator-class",
  },
  {
    supportNumber: 3,
    functionIdentity:
      "public.gin_extract_query_trgm(text, internal, smallint, internal, internal, internal, internal)",
    dependencyKind: "operator-class",
  },
  {
    supportNumber: 4,
    functionIdentity:
      "public.gin_trgm_consistent(internal, smallint, text, integer, internal, internal, internal, internal)",
    dependencyKind: "family",
  },
  {
    supportNumber: 6,
    functionIdentity:
      "public.gin_trgm_triconsistent(internal, smallint, text, integer, internal, internal, internal)",
    dependencyKind: "family",
  },
] as const satisfies readonly RequiredGinTrgmSupportFunction[];

const OPTIONAL_RELATION_PRIVILEGES: readonly RelationPrivilegeSpec[] = [
  ["native_transcripts", ["SELECT"]],
  ["transcript_messages", ["SELECT"]],
  ["ingest_checkpoints", ["SELECT"]],
];

const OPTIONAL_COLUMN_PRIVILEGES: readonly ColumnPrivilegeSpec[] = [
  ["conversations", "project_id", "SELECT"],
  ["conversations", "conversation_id", "SELECT"],
  ["conversations", "session_id", "SELECT"],
  ["conversations", "session_id_sha256", "SELECT"],
  ["conversations", "created_at", "SELECT"],
  ["messages", "project_id", "SELECT"],
  ["messages", "conversation_id", "SELECT"],
  ["messages", "message_id", "SELECT"],
  ["messages", "seq", "SELECT"],
  ["messages", "role", "SELECT"],
  ["messages", "content", "SELECT"],
  ["native_transcripts", "project_id", "INSERT"],
  ["native_transcripts", "machine_id", "INSERT"],
  ["native_transcripts", "client_name", "INSERT"],
  ["native_transcripts", "format_name", "INSERT"],
  ["native_transcripts", "format_version", "INSERT"],
  ["native_transcripts", "native_session_id", "INSERT"],
  ["native_transcripts", "source_locator", "INSERT"],
  ["native_transcripts", "source_ordinal", "INSERT"],
  ["native_transcripts", "observed_at", "INSERT"],
  ["native_transcripts", "ingested_at", "INSERT"],
  ["native_transcripts", "scrubber_version", "INSERT"],
  ["native_transcripts", "content_sha256", "INSERT"],
  ["native_transcripts", "ingest_key", "INSERT"],
  ["native_transcripts", "native_payload", "INSERT"],
  ["transcript_messages", "project_id", "INSERT"],
  ["transcript_messages", "transcript_id", "INSERT"],
  ["transcript_messages", "conversation_id", "INSERT"],
  ["transcript_messages", "message_id", "INSERT"],
  ["transcript_messages", "source_ordinal", "INSERT"],
  ["ingest_checkpoints", "project_id", "INSERT"],
  ["ingest_checkpoints", "machine_id", "INSERT"],
  ["ingest_checkpoints", "client_name", "INSERT"],
  ["ingest_checkpoints", "source_locator", "INSERT"],
  ["ingest_checkpoints", "last_source_ordinal", "UPDATE"],
  ["ingest_checkpoints", "imported_count", "UPDATE"],
  ["ingest_checkpoints", "skipped_count", "UPDATE"],
  ["ingest_checkpoints", "quarantined_count", "UPDATE"],
  ["ingest_checkpoints", "revision", "UPDATE"],
  ["ingest_checkpoints", "checkpoint", "UPDATE"],
  ["ingest_checkpoints", "updated_at", "UPDATE"],
];

const requiredPrivileges = [
  schemaEntry("lcm", "USAGE"),
  schemaEntry("public", "USAGE"),
  ...expandRelationPrivileges(REQUIRED_RELATION_PRIVILEGES),
  ...expandColumnPrivileges(REQUIRED_COLUMN_PRIVILEGES),
  ...REQUIRED_SEQUENCE_PRIVILEGES.map(sequenceEntry),
  ...REQUIRED_FUNCTION_PRIVILEGES.map(([object, extension]) => (
    functionEntry(object, extension)
  )),
];

const optionalPrivileges = [
  ...expandRelationPrivileges(OPTIONAL_RELATION_PRIVILEGES),
  ...expandColumnPrivileges(OPTIONAL_COLUMN_PRIVILEGES),
];

function freezePrivilegeEntry(
  entry: PostgreSqlRuntimePrivilegeEntry,
): PostgreSqlRuntimePrivilegeEntry {
  return Object.freeze(entry);
}

export const POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST: PostgreSqlRuntimePrivilegeManifest = Object.freeze({
  version: 1,
  required: Object.freeze(requiredPrivileges.map(freezePrivilegeEntry)),
  optional: Object.freeze(optionalPrivileges.map(freezePrivilegeEntry)),
});

export type PostgreSqlRuntimeReadinessFailureReason =
  | "invalid-expected-owner"
  | "runtime-role-policy"
  | "server-preflight"
  | "extension-preflight"
  | "search-preflight"
  | "schema-ownership"
  | "migration-ledger"
  | "schema-fingerprint"
  | "acl-shape"
  | "effective-privilege";

export class PostgreSqlRuntimeReadinessError extends StorageOperationError {
  readonly remediation =
    "Remove unregistered foreign keys targeting LCM tables, restore the packaged PostgreSQL schema including validated NOT NULL state, and apply the exact reviewed runtime grants, then rerun readiness.";

  constructor(
    readonly reason: PostgreSqlRuntimeReadinessFailureReason,
    operation = "verifyRuntimeReadiness",
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      READINESS_DOMAIN,
      operation,
    );
    this.name = "PostgreSqlRuntimeReadinessError";
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      reason: this.reason,
      remediation: this.remediation,
    };
  }
}

interface RolePolicyRow extends QueryResultRow {
  readonly current_user_name: unknown;
  readonly session_user_name: unknown;
  readonly role_exists: unknown;
  readonly superuser: unknown;
  readonly create_role: unknown;
  readonly create_database: unknown;
  readonly database_create_privilege: unknown;
  readonly session_replication_role_set_privilege: unknown;
  readonly replication: unknown;
  readonly bypass_rls: unknown;
  readonly membership_count: unknown;
  readonly tls: unknown;
  readonly expected_owner_match: unknown;
  readonly expected_owner_count: unknown;
  readonly expected_owner_oid: unknown;
  readonly database_owner_count: unknown;
  readonly database_owner_oid_count: unknown;
  readonly database_owner_oid: unknown;
  readonly database_owner_match: unknown;
}

interface ServerReadinessRow extends QueryResultRow {
  readonly server_version_num: unknown;
  readonly server_encoding: unknown;
  readonly session_replication_role: unknown;
  readonly timezone: unknown;
  readonly tls: unknown;
}

interface RequiredExtensionFunctionRow extends QueryResultRow {
  readonly function_identity: unknown;
  readonly extension_name: unknown;
  readonly owner_matches_extension: unknown;
  readonly language_name: unknown;
  readonly probin: unknown;
  readonly prosrc: unknown;
  readonly return_type: unknown;
  readonly security_definer: unknown;
  readonly leakproof: unknown;
  readonly volatility: unknown;
  readonly parallel_safety: unknown;
  readonly strict: unknown;
  readonly returns_set: unknown;
  readonly function_kind: unknown;
  readonly support_function_identity: unknown;
  readonly configuration_is_null: unknown;
  readonly dependency_count: unknown;
  readonly extension_dependency_count: unknown;
  readonly namespace_dependency_count: unknown;
}

interface RequiredExtensionOperatorRow extends QueryResultRow {
  readonly schema_name: unknown;
  readonly operator_name: unknown;
  readonly operator_kind: unknown;
  readonly left_type: unknown;
  readonly right_type: unknown;
  readonly result_type: unknown;
  readonly extension_name: unknown;
  readonly owner_matches_extension: unknown;
  readonly implementation_matches: unknown;
  readonly commutator_matches: unknown;
  readonly negator_absent: unknown;
  readonly restriction_matches: unknown;
  readonly join_matches: unknown;
  readonly can_merge: unknown;
  readonly can_hash: unknown;
  readonly dependency_count: unknown;
  readonly extension_dependency_count: unknown;
  readonly implementation_dependency_count: unknown;
  readonly namespace_dependency_count: unknown;
}

interface RequiredGinTrgmOperatorClassRow extends QueryResultRow {
  readonly operator_class_schema: unknown;
  readonly operator_class_name: unknown;
  readonly operator_family_schema: unknown;
  readonly operator_family_name: unknown;
  readonly access_method_name: unknown;
  readonly input_type: unknown;
  readonly storage_type: unknown;
  readonly is_default: unknown;
  readonly operator_class_extension: unknown;
  readonly operator_family_extension: unknown;
  readonly operator_class_owner_matches_extension: unknown;
  readonly operator_family_owner_matches_extension: unknown;
  readonly operator_class_dependency_count: unknown;
  readonly operator_class_family_dependency_count: unknown;
  readonly operator_class_extension_dependency_count: unknown;
  readonly operator_class_namespace_dependency_count: unknown;
  readonly operator_family_dependency_count: unknown;
  readonly operator_family_extension_dependency_count: unknown;
  readonly operator_family_namespace_dependency_count: unknown;
}

interface RequiredGinTrgmOperatorRow extends QueryResultRow {
  readonly strategy_number: unknown;
  readonly purpose: unknown;
  readonly left_type: unknown;
  readonly right_type: unknown;
  readonly operator_identity: unknown;
  readonly operator_kind: unknown;
  readonly result_type: unknown;
  readonly implementation_identity: unknown;
  readonly commutator_identity: unknown;
  readonly negator_identity: unknown;
  readonly restriction_identity: unknown;
  readonly join_identity: unknown;
  readonly can_merge: unknown;
  readonly can_hash: unknown;
  readonly sort_family_identity: unknown;
  readonly access_method_name: unknown;
  readonly extension_name: unknown;
  readonly owner_matches_extension: unknown;
  readonly mapping_dependency_count: unknown;
  readonly mapping_family_dependency_count: unknown;
  readonly mapping_operator_dependency_count: unknown;
  readonly operator_dependency_count: unknown;
  readonly operator_extension_dependency_count: unknown;
  readonly operator_implementation_dependency_count: unknown;
  readonly operator_namespace_dependency_count: unknown;
}

interface RequiredGinTrgmSupportRow extends QueryResultRow {
  readonly support_number: unknown;
  readonly left_type: unknown;
  readonly right_type: unknown;
  readonly function_identity: unknown;
  readonly dependency_count: unknown;
  readonly family_auto_dependency_count: unknown;
  readonly operator_class_internal_dependency_count: unknown;
  readonly procedure_normal_dependency_count: unknown;
  readonly procedure_auto_dependency_count: unknown;
}

interface OwnershipRow extends QueryResultRow {
  readonly expected_owner_exists: unknown;
  readonly schema_exists: unknown;
  readonly schema_owned: unknown;
  readonly ledger_exists: unknown;
  readonly ledger_kind: unknown;
  readonly ledger_owned: unknown;
  readonly expected_object_count: unknown;
  readonly actual_object_count: unknown;
  readonly owned_object_count: unknown;
}

interface MigrationRow extends QueryResultRow {
  readonly id: unknown;
  readonly checksum_sha256: unknown;
}

interface AclRow extends QueryResultRow {
  readonly object_identity: unknown;
  readonly grantee_is_owner: unknown;
  readonly grantee_name: unknown;
  readonly grantor_is_owner: unknown;
  readonly privilege_type: unknown;
  readonly is_grantable: unknown;
}

interface SchemaAclRow extends AclRow {
  readonly schema_name: unknown;
}

interface FunctionAclRow extends AclRow {
  readonly function_identity: unknown;
  readonly extension_name: unknown;
}

interface DefinitionRow extends QueryResultRow {
  readonly baseline_applied: unknown;
  readonly expected_object_count: unknown;
  readonly existing_object_count: unknown;
  readonly actual_definition_group_counts: unknown;
  readonly actual_definition_group_hashes: unknown;
  readonly invalid_index_count: unknown;
  readonly missing_object_count: unknown;
  readonly drifted_definition_group_count: unknown;
}

interface IdentityFunctionRow extends QueryResultRow {
  readonly expected_function_count: unknown;
  readonly existing_function_count: unknown;
  readonly drifted_function_count: unknown;
}

interface EffectivePrivilegeRow extends QueryResultRow {
  readonly privilege_kind: unknown;
  readonly object_identity: unknown;
  readonly column_name: unknown;
  readonly privilege_type: unknown;
  readonly expected: unknown;
  readonly effective: unknown;
}

function readinessError(
  reason: PostgreSqlRuntimeReadinessFailureReason,
  operation: string,
): PostgreSqlRuntimeReadinessError {
  return new PostgreSqlRuntimeReadinessError(reason, operation);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isPrivilegeKind(value: unknown): value is PostgreSqlRuntimePrivilegeKind {
  return value === "schema"
    || value === "relation"
    || value === "column"
    || value === "sequence"
    || value === "function";
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRoleName(value: unknown): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") > 0
    && Buffer.byteLength(value, "utf8") <= MAX_POSTGRESQL_ROLE_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function readinessOptions(
  operation: string,
  signal: AbortSignal | undefined,
): PostgreSqlQueryOptions {
  return { domain: READINESS_DOMAIN, operation, ...(signal === undefined ? {} : { signal }) };
}

function assertExpectedOwner(expectedOwner: unknown): asserts expectedOwner is string {
  if (!isRoleName(expectedOwner)) throw readinessError("invalid-expected-owner", "validateExpectedOwner");
}

async function inspectRolePolicy(
  executor: PostgreSqlQueryExecutor,
  expectedOwner: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await executor.query<RolePolicyRow, [string]>({
    text: `WITH RECURSIVE expected_owner AS (
             SELECT role.oid
             FROM pg_catalog.pg_roles AS role
             WHERE role.rolname OPERATOR(pg_catalog.=) $1
           ),
           runtime_role AS (
             SELECT role.oid,
                    role.rolname::text AS current_user_name,
                    session_user::text AS session_user_name,
                    role.rolsuper,
                    role.rolcreaterole,
                    role.rolcreatedb,
                    role.rolreplication,
                    role.rolbypassrls
             FROM pg_catalog.pg_roles AS role
             WHERE role.rolname OPERATOR(pg_catalog.=) CURRENT_USER
           ),
           memberships(role_oid) AS (
             SELECT member.roleid
             FROM pg_catalog.pg_auth_members AS member
             CROSS JOIN runtime_role
             WHERE member.member OPERATOR(pg_catalog.=) runtime_role.oid
             UNION
             SELECT member.roleid
             FROM pg_catalog.pg_auth_members AS member
             JOIN memberships
               ON member.member OPERATOR(pg_catalog.=) memberships.role_oid
           ),
           database_owner AS (
             SELECT database.datdba::pg_catalog.text AS database_owner_oid,
                    database.datdba OPERATOR(pg_catalog.=) expected_owner.oid
                      AS database_owner_match
             FROM pg_catalog.pg_database AS database
             LEFT JOIN expected_owner ON true
             WHERE database.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()
           ),
           expected_owner_evidence AS (
             SELECT pg_catalog.count(*)::pg_catalog.int4 AS expected_owner_count,
                    pg_catalog.min(owner.oid::pg_catalog.text) AS expected_owner_oid
             FROM expected_owner AS owner
           ),
           database_owner_evidence AS (
             SELECT pg_catalog.count(*)::pg_catalog.int4 AS database_owner_count,
                    pg_catalog.count(database_owner.database_owner_oid)::pg_catalog.int4
                      AS database_owner_oid_count,
                    pg_catalog.min(database_owner.database_owner_oid) AS database_owner_oid,
                    pg_catalog.bool_and(database_owner.database_owner_match)
                      AS database_owner_match
             FROM database_owner
           )
           SELECT runtime_role.current_user_name,
                  runtime_role.session_user_name,
                  runtime_role.oid IS NOT NULL AS role_exists,
                  runtime_role.rolsuper AS superuser,
                  runtime_role.rolcreaterole AS create_role,
                  runtime_role.rolcreatedb AS create_database,
                  pg_catalog.has_database_privilege(
                    runtime_role.oid,
                    pg_catalog.current_database(),
                    'CREATE'
                  ) AS database_create_privilege,
                  pg_catalog.has_parameter_privilege(
                    runtime_role.oid,
                    'session_replication_role',
                    'SET'
                  ) AS session_replication_role_set_privilege,
                  runtime_role.rolreplication AS replication,
                  runtime_role.rolbypassrls AS bypass_rls,
                  (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM memberships)
                    AS membership_count,
                  COALESCE((
                    SELECT ssl
                    FROM pg_catalog.pg_stat_ssl
                    WHERE pid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()
                  ), false) AS tls
                  ,runtime_role.current_user_name OPERATOR(pg_catalog.=) $1
                    AS expected_owner_match,
                  expected_owner_evidence.expected_owner_count,
                  expected_owner_evidence.expected_owner_oid,
                  database_owner_evidence.database_owner_count,
                  database_owner_evidence.database_owner_oid_count,
                  database_owner_evidence.database_owner_oid,
                  database_owner_evidence.database_owner_match
           FROM runtime_role
           CROSS JOIN expected_owner_evidence
           CROSS JOIN database_owner_evidence`,
    values: [expectedOwner],
  }, readinessOptions("inspectRuntimeRolePolicy", signal));
  const row = result.rows[0];
  const runtimeRole = row?.current_user_name;
  if (
    result.rows.length !== 1
    || !row
    || !isRoleName(runtimeRole)
    || !isRoleName(row.session_user_name)
    || runtimeRole !== row.session_user_name
    || runtimeRole === expectedOwner
    || row.role_exists !== true
    || row.superuser !== false
    || row.create_role !== false
    || row.create_database !== false
    || row.database_create_privilege !== false
    || row.session_replication_role_set_privilege !== false
    || row.replication !== false
    || row.bypass_rls !== false
    || row.membership_count !== 0
    || row.tls !== true
    || row.expected_owner_match !== false
    || !isSafeCount(row.expected_owner_count)
    || row.expected_owner_count !== 1
    || typeof row.expected_owner_oid !== "string"
    || !/^[0-9]+$/u.test(row.expected_owner_oid)
    || !isSafeCount(row.database_owner_count)
    || row.database_owner_count !== 1
    || !isSafeCount(row.database_owner_oid_count)
    || row.database_owner_oid_count !== 1
    || typeof row.database_owner_oid !== "string"
    || !/^[0-9]+$/u.test(row.database_owner_oid)
    || !isBoolean(row.database_owner_match)
    || row.database_owner_match !== true
  ) {
    throw readinessError("runtime-role-policy", "inspectRuntimeRolePolicy");
  }
  return runtimeRole;
}

async function inspectServerReadiness(
  executor: PostgreSqlQueryExecutor,
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await executor.query<ServerReadinessRow>({
    text: `SELECT pg_catalog.current_setting('server_version_num')::pg_catalog.int4
                    AS server_version_num,
                  pg_catalog.current_setting('server_encoding') AS server_encoding,
                  pg_catalog.current_setting('session_replication_role')
                    AS session_replication_role,
                  pg_catalog.current_setting('TimeZone') AS timezone,
                  COALESCE((
                    SELECT ssl
                    FROM pg_catalog.pg_stat_ssl
                    WHERE pid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()
                  ), false) AS tls`,
  }, readinessOptions("inspectServerReadiness", signal));
  const row = result.rows[0];
  if (
    !row
    || !(typeof row.server_version_num === "number"
      && Math.floor(row.server_version_num / 10_000) === 18)
    || row.server_encoding !== "UTF8"
    || row.session_replication_role !== "origin"
    || typeof row.timezone !== "string"
    || row.timezone.toUpperCase() !== "UTC"
    || row.tls !== true
  ) {
    throw readinessError("server-preflight", "inspectServerReadiness");
  }
}

async function inspectRequiredExtensionFunctions(
  executor: PostgreSqlQueryExecutor,
  signal: AbortSignal | undefined,
): Promise<void> {
  const expectedByIdentity = new Map<string, RequiredFunctionImplementation>(
    REQUIRED_TRUSTED_FUNCTION_IMPLEMENTATIONS.map((implementation) => (
      [implementation.functionIdentity, implementation] as const
    )),
  );
  const result = await executor.query<RequiredExtensionFunctionRow, [readonly string[]]>({
    text: `SELECT pg_catalog.concat(
                    namespace.nspname,
                    '.',
                    procedure.proname,
                    '(',
                    pg_catalog.pg_get_function_identity_arguments(procedure.oid),
                    ')'
                  ) AS function_identity,
                  extension.extname::pg_catalog.text AS extension_name,
                  CASE WHEN extension.oid IS NULL THEN NULL
                    ELSE procedure.proowner OPERATOR(pg_catalog.=) extension.extowner
                  END AS owner_matches_extension,
                  language.lanname::pg_catalog.text AS language_name,
                  procedure.probin,
                  procedure.prosrc,
                  pg_catalog.format_type(
                    procedure.prorettype,
                    NULL::pg_catalog.int4
                  ) AS return_type,
                  procedure.prosecdef AS security_definer,
                  procedure.proleakproof AS leakproof,
                  procedure.provolatile::pg_catalog.text AS volatility,
                  procedure.proparallel::pg_catalog.text AS parallel_safety,
                  procedure.proisstrict AS strict,
                  procedure.proretset AS returns_set,
                  procedure.prokind::pg_catalog.text AS function_kind,
                  CASE
                    WHEN procedure.prosupport OPERATOR(pg_catalog.=) 0::pg_catalog.oid
                      THEN NULL
                    ELSE pg_catalog.concat(
                      support_namespace.nspname,
                      '.',
                      support.proname,
                      '(',
                      pg_catalog.pg_get_function_identity_arguments(support.oid),
                      ')'
                    )
                  END AS support_function_identity,
                  procedure.proconfig IS NULL AS configuration_is_null,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_proc')
                      AND dependency.objid OPERATOR(pg_catalog.=) procedure.oid
                  ) AS dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_proc')
                      AND dependency.objid OPERATOR(pg_catalog.=) procedure.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_extension')
                      AND dependency.refobjid OPERATOR(pg_catalog.=) extension.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'e'
                  ) AS extension_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_proc')
                      AND dependency.objid OPERATOR(pg_catalog.=) procedure.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_namespace')
                      AND dependency.refobjid OPERATOR(pg_catalog.=) namespace.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'n'
                  ) AS namespace_dependency_count
           FROM pg_catalog.pg_proc AS procedure
           JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid OPERATOR(pg_catalog.=) procedure.pronamespace
           JOIN pg_catalog.pg_language AS language
             ON language.oid OPERATOR(pg_catalog.=) procedure.prolang
           LEFT JOIN pg_catalog.pg_proc AS support
             ON support.oid OPERATOR(pg_catalog.=) procedure.prosupport
           LEFT JOIN pg_catalog.pg_namespace AS support_namespace
             ON support_namespace.oid OPERATOR(pg_catalog.=) support.pronamespace
           LEFT JOIN pg_catalog.pg_depend AS extension_dependency
             ON extension_dependency.classid OPERATOR(pg_catalog.=)
                  pg_catalog.to_regclass('pg_catalog.pg_proc')
            AND extension_dependency.objid OPERATOR(pg_catalog.=) procedure.oid
            AND extension_dependency.objsubid OPERATOR(pg_catalog.=) 0
            AND extension_dependency.refclassid OPERATOR(pg_catalog.=)
                  pg_catalog.to_regclass('pg_catalog.pg_extension')
            AND extension_dependency.refobjsubid OPERATOR(pg_catalog.=) 0
            AND extension_dependency.deptype OPERATOR(pg_catalog.=) 'e'
           LEFT JOIN pg_catalog.pg_extension AS extension
             ON extension.oid OPERATOR(pg_catalog.=) extension_dependency.refobjid
           WHERE pg_catalog.concat(
                    namespace.nspname, '.', procedure.proname, '(',
                    pg_catalog.pg_get_function_identity_arguments(procedure.oid), ')'
                 ) OPERATOR(pg_catalog.=) ANY ($1::pg_catalog.text[])
           ORDER BY function_identity`,
    values: [[...expectedByIdentity.keys()]],
  }, readinessOptions("inspectRequiredExtensionFunctions", signal));
  const observed = new Set<string>();
  for (const row of result.rows) {
    if (typeof row.function_identity !== "string") {
      throw readinessError("extension-preflight", "inspectRequiredExtensionFunctions");
    }
    const expected = expectedByIdentity.get(row.function_identity);
    if (
      expected === undefined
      || observed.has(row.function_identity)
      || row.extension_name !== expected.extension
      || row.owner_matches_extension !== (expected.extension === null ? null : true)
      || row.language_name !== expected.language
      || row.probin !== expected.library
      || row.prosrc !== expected.symbol
      || row.return_type !== expected.returnType
      || row.security_definer !== false
      || row.leakproof !== expected.leakproof
      || row.volatility !== expected.volatility
      || row.parallel_safety !== "s"
      || row.strict !== true
      || row.returns_set !== false
      || row.function_kind !== "f"
      || row.support_function_identity !== expected.supportFunctionIdentity
      || row.configuration_is_null !== true
      || row.dependency_count !== (expected.extension === null ? 0 : 2)
      || row.extension_dependency_count !== (expected.extension === null ? 0 : 1)
      || row.namespace_dependency_count !== (expected.extension === null ? 0 : 1)
    ) {
      throw readinessError("extension-preflight", "inspectRequiredExtensionFunctions");
    }
    observed.add(row.function_identity);
  }
  if (observed.size !== expectedByIdentity.size) {
    throw readinessError("extension-preflight", "inspectRequiredExtensionFunctions");
  }
}

async function inspectRequiredExtensionOperator(
  executor: PostgreSqlQueryExecutor,
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await executor.query<RequiredExtensionOperatorRow, [string, string, string, string]>({
    text: `SELECT namespace.nspname::pg_catalog.text AS schema_name,
                  catalog_operator.oprname::pg_catalog.text AS operator_name,
                  catalog_operator.oprkind::pg_catalog.text AS operator_kind,
                  pg_catalog.format_type(
                    catalog_operator.oprleft,
                    NULL::pg_catalog.int4
                  ) AS left_type,
                  pg_catalog.format_type(
                    catalog_operator.oprright,
                    NULL::pg_catalog.int4
                  ) AS right_type,
                  pg_catalog.format_type(
                    catalog_operator.oprresult,
                    NULL::pg_catalog.int4
                  ) AS result_type,
                  extension.extname::pg_catalog.text AS extension_name,
                  catalog_operator.oprowner OPERATOR(pg_catalog.=) extension.extowner
                    AS owner_matches_extension,
                  catalog_operator.oprcode OPERATOR(pg_catalog.=)
                    pg_catalog.to_regprocedure($1) AS implementation_matches,
                  catalog_operator.oprcom OPERATOR(pg_catalog.=) catalog_operator.oid
                    AS commutator_matches,
                  catalog_operator.oprnegate OPERATOR(pg_catalog.=) 0::pg_catalog.oid
                    AS negator_absent,
                  catalog_operator.oprrest OPERATOR(pg_catalog.=)
                    pg_catalog.to_regprocedure($2) AS restriction_matches,
                  catalog_operator.oprjoin OPERATOR(pg_catalog.=)
                    pg_catalog.to_regprocedure($3) AS join_matches,
                  catalog_operator.oprcanmerge AS can_merge,
                  catalog_operator.oprcanhash AS can_hash,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_operator')
                      AND dependency.objid OPERATOR(pg_catalog.=) catalog_operator.oid
                  ) AS dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    JOIN pg_catalog.pg_extension AS required_extension
                      ON required_extension.oid OPERATOR(pg_catalog.=) dependency.refobjid
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_operator')
                      AND dependency.objid OPERATOR(pg_catalog.=) catalog_operator.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_extension')
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'e'
                      AND required_extension.extname OPERATOR(pg_catalog.=) $4
                  ) AS extension_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_operator')
                      AND dependency.objid OPERATOR(pg_catalog.=) catalog_operator.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_proc')
                      AND dependency.refobjid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regprocedure($1)
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'n'
                  ) AS implementation_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_operator')
                      AND dependency.objid OPERATOR(pg_catalog.=) catalog_operator.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_namespace')
                      AND dependency.refobjid OPERATOR(pg_catalog.=) namespace.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'n'
                  ) AS namespace_dependency_count
           FROM pg_catalog.pg_operator AS catalog_operator
           JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid OPERATOR(pg_catalog.=) catalog_operator.oprnamespace
           LEFT JOIN pg_catalog.pg_depend AS extension_dependency
             ON extension_dependency.classid OPERATOR(pg_catalog.=)
                  pg_catalog.to_regclass('pg_catalog.pg_operator')
            AND extension_dependency.objid OPERATOR(pg_catalog.=) catalog_operator.oid
            AND extension_dependency.objsubid OPERATOR(pg_catalog.=) 0
            AND extension_dependency.refclassid OPERATOR(pg_catalog.=)
                  pg_catalog.to_regclass('pg_catalog.pg_extension')
            AND extension_dependency.refobjsubid OPERATOR(pg_catalog.=) 0
            AND extension_dependency.deptype OPERATOR(pg_catalog.=) 'e'
           LEFT JOIN pg_catalog.pg_extension AS extension
             ON extension.oid OPERATOR(pg_catalog.=) extension_dependency.refobjid
           WHERE namespace.nspname OPERATOR(pg_catalog.=) 'public'
             AND catalog_operator.oprname OPERATOR(pg_catalog.=) '%'
             AND catalog_operator.oprleft OPERATOR(pg_catalog.=)
                  'pg_catalog.text'::pg_catalog.regtype
             AND catalog_operator.oprright OPERATOR(pg_catalog.=)
                  'pg_catalog.text'::pg_catalog.regtype`,
    values: [
      "public.similarity_op(text,text)",
      "pg_catalog.matchingsel(internal,oid,internal,integer)",
      "pg_catalog.matchingjoinsel(internal,oid,internal,smallint,internal)",
      "pg_trgm",
    ],
  }, readinessOptions("inspectRequiredExtensionOperator", signal));
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || row?.schema_name !== "public"
    || row.operator_name !== "%"
    || row.operator_kind !== "b"
    || row.left_type !== "text"
    || row.right_type !== "text"
    || row.result_type !== "boolean"
    || row.extension_name !== "pg_trgm"
    || row.owner_matches_extension !== true
    || row.implementation_matches !== true
    || row.commutator_matches !== true
    || row.negator_absent !== true
    || row.restriction_matches !== true
    || row.join_matches !== true
    || row.can_merge !== false
    || row.can_hash !== false
    || row.dependency_count !== 3
    || row.extension_dependency_count !== 1
    || row.implementation_dependency_count !== 1
    || row.namespace_dependency_count !== 1
  ) {
    throw readinessError("extension-preflight", "inspectRequiredExtensionOperator");
  }
}

async function inspectRequiredGinTrgmOperatorClass(
  executor: PostgreSqlQueryExecutor,
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await executor.query<RequiredGinTrgmOperatorClassRow>({
    text: `SELECT operator_class_namespace.nspname::pg_catalog.text
                    AS operator_class_schema,
                  operator_class.opcname::pg_catalog.text AS operator_class_name,
                  operator_family_namespace.nspname::pg_catalog.text
                    AS operator_family_schema,
                  operator_family.opfname::pg_catalog.text AS operator_family_name,
                  access_method.amname::pg_catalog.text AS access_method_name,
                  pg_catalog.format_type(
                    operator_class.opcintype,
                    NULL::pg_catalog.int4
                  ) AS input_type,
                  pg_catalog.format_type(
                    operator_class.opckeytype,
                    NULL::pg_catalog.int4
                  ) AS storage_type,
                  operator_class.opcdefault AS is_default,
                  operator_class_extension.extname::pg_catalog.text
                    AS operator_class_extension,
                  operator_family_extension.extname::pg_catalog.text
                    AS operator_family_extension,
                  operator_class.opcowner OPERATOR(pg_catalog.=)
                    operator_class_extension.extowner
                    AS operator_class_owner_matches_extension,
                  operator_family.opfowner OPERATOR(pg_catalog.=)
                    operator_family_extension.extowner
                    AS operator_family_owner_matches_extension,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_opclass')
                      AND dependency.objid OPERATOR(pg_catalog.=) operator_class.oid
                  ) AS operator_class_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_opclass')
                      AND dependency.objid OPERATOR(pg_catalog.=) operator_class.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_opfamily')
                      AND dependency.refobjid OPERATOR(pg_catalog.=) operator_family.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'a'
                  ) AS operator_class_family_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_opclass')
                      AND dependency.objid OPERATOR(pg_catalog.=) operator_class.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_extension')
                      AND dependency.refobjid OPERATOR(pg_catalog.=)
                        operator_class_extension.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'e'
                  ) AS operator_class_extension_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_opclass')
                      AND dependency.objid OPERATOR(pg_catalog.=) operator_class.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_namespace')
                      AND dependency.refobjid OPERATOR(pg_catalog.=)
                        operator_class_namespace.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'n'
                  ) AS operator_class_namespace_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_opfamily')
                      AND dependency.objid OPERATOR(pg_catalog.=) operator_family.oid
                  ) AS operator_family_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_opfamily')
                      AND dependency.objid OPERATOR(pg_catalog.=) operator_family.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_extension')
                      AND dependency.refobjid OPERATOR(pg_catalog.=)
                        operator_family_extension.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'e'
                  ) AS operator_family_extension_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_opfamily')
                      AND dependency.objid OPERATOR(pg_catalog.=) operator_family.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_namespace')
                      AND dependency.refobjid OPERATOR(pg_catalog.=)
                        operator_family_namespace.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'n'
                  ) AS operator_family_namespace_dependency_count
           FROM pg_catalog.pg_opclass AS operator_class
           JOIN pg_catalog.pg_namespace AS operator_class_namespace
             ON operator_class_namespace.oid OPERATOR(pg_catalog.=)
                operator_class.opcnamespace
           JOIN pg_catalog.pg_am AS access_method
             ON access_method.oid OPERATOR(pg_catalog.=) operator_class.opcmethod
           JOIN pg_catalog.pg_opfamily AS operator_family
             ON operator_family.oid OPERATOR(pg_catalog.=) operator_class.opcfamily
           JOIN pg_catalog.pg_namespace AS operator_family_namespace
             ON operator_family_namespace.oid OPERATOR(pg_catalog.=)
                operator_family.opfnamespace
           LEFT JOIN pg_catalog.pg_depend AS operator_class_extension_dependency
             ON operator_class_extension_dependency.classid OPERATOR(pg_catalog.=)
                  pg_catalog.to_regclass('pg_catalog.pg_opclass')
            AND operator_class_extension_dependency.objid OPERATOR(pg_catalog.=)
                operator_class.oid
            AND operator_class_extension_dependency.objsubid OPERATOR(pg_catalog.=) 0
            AND operator_class_extension_dependency.refclassid OPERATOR(pg_catalog.=)
                  pg_catalog.to_regclass('pg_catalog.pg_extension')
            AND operator_class_extension_dependency.refobjsubid OPERATOR(pg_catalog.=) 0
            AND operator_class_extension_dependency.deptype OPERATOR(pg_catalog.=) 'e'
           LEFT JOIN pg_catalog.pg_extension AS operator_class_extension
             ON operator_class_extension.oid OPERATOR(pg_catalog.=)
                operator_class_extension_dependency.refobjid
           LEFT JOIN pg_catalog.pg_depend AS operator_family_extension_dependency
             ON operator_family_extension_dependency.classid OPERATOR(pg_catalog.=)
                  pg_catalog.to_regclass('pg_catalog.pg_opfamily')
            AND operator_family_extension_dependency.objid OPERATOR(pg_catalog.=)
                operator_family.oid
            AND operator_family_extension_dependency.objsubid OPERATOR(pg_catalog.=) 0
            AND operator_family_extension_dependency.refclassid OPERATOR(pg_catalog.=)
                  pg_catalog.to_regclass('pg_catalog.pg_extension')
            AND operator_family_extension_dependency.refobjsubid OPERATOR(pg_catalog.=) 0
            AND operator_family_extension_dependency.deptype OPERATOR(pg_catalog.=) 'e'
           LEFT JOIN pg_catalog.pg_extension AS operator_family_extension
             ON operator_family_extension.oid OPERATOR(pg_catalog.=)
                operator_family_extension_dependency.refobjid
           WHERE operator_class_namespace.nspname OPERATOR(pg_catalog.=) 'public'
             AND operator_class.opcname OPERATOR(pg_catalog.=) 'gin_trgm_ops'
             AND access_method.amname OPERATOR(pg_catalog.=) 'gin'`,
  }, readinessOptions("inspectRequiredGinTrgmOperatorClass", signal));
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || row?.operator_class_schema !== "public"
    || row.operator_class_name !== "gin_trgm_ops"
    || row.operator_family_schema !== "public"
    || row.operator_family_name !== "gin_trgm_ops"
    || row.access_method_name !== "gin"
    || row.input_type !== "text"
    || row.storage_type !== "integer"
    || row.is_default !== false
    || row.operator_class_extension !== "pg_trgm"
    || row.operator_family_extension !== "pg_trgm"
    || row.operator_class_owner_matches_extension !== true
    || row.operator_family_owner_matches_extension !== true
    || row.operator_class_dependency_count !== 3
    || row.operator_class_family_dependency_count !== 1
    || row.operator_class_extension_dependency_count !== 1
    || row.operator_class_namespace_dependency_count !== 1
    || row.operator_family_dependency_count !== 2
    || row.operator_family_extension_dependency_count !== 1
    || row.operator_family_namespace_dependency_count !== 1
  ) {
    throw readinessError("extension-preflight", "inspectRequiredGinTrgmOperatorClass");
  }
}

function catalogOperatorIdentitySql(operatorAlias: string, namespaceAlias: string): string {
  return `pg_catalog.concat(
            ${namespaceAlias}.nspname,
            '.',
            ${operatorAlias}.oprname,
            '(',
            pg_catalog.format_type(${operatorAlias}.oprleft, NULL::pg_catalog.int4),
            ', ',
            pg_catalog.format_type(${operatorAlias}.oprright, NULL::pg_catalog.int4),
            ')'
          )`;
}

function catalogFunctionIdentitySql(procedureAlias: string, namespaceAlias: string): string {
  return `pg_catalog.concat(
            ${namespaceAlias}.nspname,
            '.',
            ${procedureAlias}.proname,
            '(',
            pg_catalog.pg_get_function_identity_arguments(${procedureAlias}.oid),
            ')'
          )`;
}

async function inspectRequiredGinTrgmOperators(
  executor: PostgreSqlQueryExecutor,
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await executor.query<RequiredGinTrgmOperatorRow>({
    text: `SELECT mapping.amopstrategy AS strategy_number,
                  mapping.amoppurpose::pg_catalog.text AS purpose,
                  pg_catalog.format_type(
                    mapping.amoplefttype,
                    NULL::pg_catalog.int4
                  ) AS left_type,
                  pg_catalog.format_type(
                    mapping.amoprighttype,
                    NULL::pg_catalog.int4
                  ) AS right_type,
                  ${catalogOperatorIdentitySql("catalog_operator", "operator_namespace")}
                    AS operator_identity,
                  catalog_operator.oprkind::pg_catalog.text AS operator_kind,
                  pg_catalog.format_type(
                    catalog_operator.oprresult,
                    NULL::pg_catalog.int4
                  ) AS result_type,
                  ${catalogFunctionIdentitySql("implementation", "implementation_namespace")}
                    AS implementation_identity,
                  CASE
                    WHEN catalog_operator.oprcom OPERATOR(pg_catalog.=) 0::pg_catalog.oid
                      THEN NULL
                    ELSE ${catalogOperatorIdentitySql("commutator", "commutator_namespace")}
                  END AS commutator_identity,
                  CASE
                    WHEN catalog_operator.oprnegate OPERATOR(pg_catalog.=) 0::pg_catalog.oid
                      THEN NULL
                    ELSE ${catalogOperatorIdentitySql("negator", "negator_namespace")}
                  END AS negator_identity,
                  ${catalogFunctionIdentitySql("restriction", "restriction_namespace")}
                    AS restriction_identity,
                  ${catalogFunctionIdentitySql("join_estimator", "join_namespace")}
                    AS join_identity,
                  catalog_operator.oprcanmerge AS can_merge,
                  catalog_operator.oprcanhash AS can_hash,
                  CASE
                    WHEN mapping.amopsortfamily OPERATOR(pg_catalog.=) 0::pg_catalog.oid
                      THEN NULL
                    ELSE pg_catalog.concat(
                      sort_family_namespace.nspname,
                      '.',
                      sort_family.opfname
                    )
                  END AS sort_family_identity,
                  access_method.amname::pg_catalog.text AS access_method_name,
                  operator_extension.extname::pg_catalog.text AS extension_name,
                  CASE WHEN operator_extension.oid IS NULL THEN NULL
                    ELSE catalog_operator.oprowner OPERATOR(pg_catalog.=)
                      operator_extension.extowner
                  END AS owner_matches_extension,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_amop')
                      AND dependency.objid OPERATOR(pg_catalog.=) mapping.oid
                  ) AS mapping_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_amop')
                      AND dependency.objid OPERATOR(pg_catalog.=) mapping.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_opfamily')
                      AND dependency.refobjid OPERATOR(pg_catalog.=) operator_family.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'a'
                  ) AS mapping_family_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_amop')
                      AND dependency.objid OPERATOR(pg_catalog.=) mapping.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_operator')
                      AND dependency.refobjid OPERATOR(pg_catalog.=) catalog_operator.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'a'
                  ) AS mapping_operator_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_operator')
                      AND dependency.objid OPERATOR(pg_catalog.=) catalog_operator.oid
                  ) AS operator_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_operator')
                      AND dependency.objid OPERATOR(pg_catalog.=) catalog_operator.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_extension')
                      AND dependency.refobjid OPERATOR(pg_catalog.=) operator_extension.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'e'
                  ) AS operator_extension_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_operator')
                      AND dependency.objid OPERATOR(pg_catalog.=) catalog_operator.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_proc')
                      AND dependency.refobjid OPERATOR(pg_catalog.=) implementation.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'n'
                  ) AS operator_implementation_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_operator')
                      AND dependency.objid OPERATOR(pg_catalog.=) catalog_operator.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_namespace')
                      AND dependency.refobjid OPERATOR(pg_catalog.=) operator_namespace.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'n'
                  ) AS operator_namespace_dependency_count
           FROM pg_catalog.pg_amop AS mapping
           JOIN pg_catalog.pg_opfamily AS operator_family
             ON operator_family.oid OPERATOR(pg_catalog.=) mapping.amopfamily
           JOIN pg_catalog.pg_namespace AS operator_family_namespace
             ON operator_family_namespace.oid OPERATOR(pg_catalog.=)
                operator_family.opfnamespace
           JOIN pg_catalog.pg_am AS access_method
             ON access_method.oid OPERATOR(pg_catalog.=) operator_family.opfmethod
           JOIN pg_catalog.pg_operator AS catalog_operator
             ON catalog_operator.oid OPERATOR(pg_catalog.=) mapping.amopopr
           JOIN pg_catalog.pg_namespace AS operator_namespace
             ON operator_namespace.oid OPERATOR(pg_catalog.=) catalog_operator.oprnamespace
           JOIN pg_catalog.pg_proc AS implementation
             ON implementation.oid OPERATOR(pg_catalog.=) catalog_operator.oprcode
           JOIN pg_catalog.pg_namespace AS implementation_namespace
             ON implementation_namespace.oid OPERATOR(pg_catalog.=)
                implementation.pronamespace
           LEFT JOIN pg_catalog.pg_operator AS commutator
             ON commutator.oid OPERATOR(pg_catalog.=) catalog_operator.oprcom
           LEFT JOIN pg_catalog.pg_namespace AS commutator_namespace
             ON commutator_namespace.oid OPERATOR(pg_catalog.=) commutator.oprnamespace
           LEFT JOIN pg_catalog.pg_operator AS negator
             ON negator.oid OPERATOR(pg_catalog.=) catalog_operator.oprnegate
           LEFT JOIN pg_catalog.pg_namespace AS negator_namespace
             ON negator_namespace.oid OPERATOR(pg_catalog.=) negator.oprnamespace
           JOIN pg_catalog.pg_proc AS restriction
             ON restriction.oid OPERATOR(pg_catalog.=) catalog_operator.oprrest
           JOIN pg_catalog.pg_namespace AS restriction_namespace
             ON restriction_namespace.oid OPERATOR(pg_catalog.=) restriction.pronamespace
           JOIN pg_catalog.pg_proc AS join_estimator
             ON join_estimator.oid OPERATOR(pg_catalog.=) catalog_operator.oprjoin
           JOIN pg_catalog.pg_namespace AS join_namespace
             ON join_namespace.oid OPERATOR(pg_catalog.=) join_estimator.pronamespace
           LEFT JOIN pg_catalog.pg_opfamily AS sort_family
             ON sort_family.oid OPERATOR(pg_catalog.=) mapping.amopsortfamily
           LEFT JOIN pg_catalog.pg_namespace AS sort_family_namespace
             ON sort_family_namespace.oid OPERATOR(pg_catalog.=) sort_family.opfnamespace
           LEFT JOIN pg_catalog.pg_depend AS operator_extension_dependency
             ON operator_extension_dependency.classid OPERATOR(pg_catalog.=)
                  pg_catalog.to_regclass('pg_catalog.pg_operator')
            AND operator_extension_dependency.objid OPERATOR(pg_catalog.=) catalog_operator.oid
            AND operator_extension_dependency.objsubid OPERATOR(pg_catalog.=) 0
            AND operator_extension_dependency.refclassid OPERATOR(pg_catalog.=)
                  pg_catalog.to_regclass('pg_catalog.pg_extension')
            AND operator_extension_dependency.refobjsubid OPERATOR(pg_catalog.=) 0
            AND operator_extension_dependency.deptype OPERATOR(pg_catalog.=) 'e'
           LEFT JOIN pg_catalog.pg_extension AS operator_extension
             ON operator_extension.oid OPERATOR(pg_catalog.=)
                operator_extension_dependency.refobjid
           WHERE operator_family_namespace.nspname OPERATOR(pg_catalog.=) 'public'
             AND operator_family.opfname OPERATOR(pg_catalog.=) 'gin_trgm_ops'
             AND access_method.amname OPERATOR(pg_catalog.=) 'gin'
           ORDER BY mapping.amopstrategy`,
  }, readinessOptions("inspectRequiredGinTrgmOperators", signal));
  const expectedByStrategy = new Map<number, RequiredGinTrgmOperatorMapping>(
    REQUIRED_GIN_TRGM_OPERATOR_MAPPINGS.map((mapping) => (
      [mapping.strategyNumber, mapping] as const
    )),
  );
  const observed = new Set<number>();
  for (const row of result.rows) {
    if (typeof row.strategy_number !== "number") {
      throw readinessError("extension-preflight", "inspectRequiredGinTrgmOperators");
    }
    const expected = expectedByStrategy.get(row.strategy_number);
    const extensionMapping = expected?.extension !== null;
    if (
      expected === undefined
      || observed.has(row.strategy_number)
      || row.purpose !== "s"
      || row.left_type !== "text"
      || row.right_type !== "text"
      || row.operator_identity !== expected.operatorIdentity
      || row.operator_kind !== "b"
      || row.result_type !== "boolean"
      || row.implementation_identity !== expected.implementationIdentity
      || row.commutator_identity !== expected.commutatorIdentity
      || row.negator_identity !== expected.negatorIdentity
      || row.restriction_identity !== expected.restrictionIdentity
      || row.join_identity !== expected.joinIdentity
      || row.can_merge !== expected.canMerge
      || row.can_hash !== expected.canHash
      || row.sort_family_identity !== null
      || row.access_method_name !== "gin"
      || row.extension_name !== expected.extension
      || row.owner_matches_extension !== (extensionMapping ? true : null)
      || row.mapping_dependency_count !== (extensionMapping ? 2 : 1)
      || row.mapping_family_dependency_count !== 1
      || row.mapping_operator_dependency_count !== (extensionMapping ? 1 : 0)
      || row.operator_dependency_count !== (extensionMapping ? 3 : 0)
      || row.operator_extension_dependency_count !== (extensionMapping ? 1 : 0)
      || row.operator_implementation_dependency_count !== (extensionMapping ? 1 : 0)
      || row.operator_namespace_dependency_count !== (extensionMapping ? 1 : 0)
    ) {
      throw readinessError("extension-preflight", "inspectRequiredGinTrgmOperators");
    }
    observed.add(row.strategy_number);
  }
  if (observed.size !== expectedByStrategy.size) {
    throw readinessError("extension-preflight", "inspectRequiredGinTrgmOperators");
  }
}

async function inspectRequiredGinTrgmSupportFunctions(
  executor: PostgreSqlQueryExecutor,
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await executor.query<RequiredGinTrgmSupportRow>({
    text: `SELECT mapping.amprocnum AS support_number,
                  pg_catalog.format_type(
                    mapping.amproclefttype,
                    NULL::pg_catalog.int4
                  ) AS left_type,
                  pg_catalog.format_type(
                    mapping.amprocrighttype,
                    NULL::pg_catalog.int4
                  ) AS right_type,
                  ${catalogFunctionIdentitySql("procedure", "procedure_namespace")}
                    AS function_identity,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_amproc')
                      AND dependency.objid OPERATOR(pg_catalog.=) mapping.oid
                  ) AS dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_amproc')
                      AND dependency.objid OPERATOR(pg_catalog.=) mapping.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_opfamily')
                      AND dependency.refobjid OPERATOR(pg_catalog.=) operator_family.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'a'
                  ) AS family_auto_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_amproc')
                      AND dependency.objid OPERATOR(pg_catalog.=) mapping.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_opclass')
                      AND dependency.refobjid OPERATOR(pg_catalog.=) operator_class.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'i'
                  ) AS operator_class_internal_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_amproc')
                      AND dependency.objid OPERATOR(pg_catalog.=) mapping.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_proc')
                      AND dependency.refobjid OPERATOR(pg_catalog.=) procedure.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'n'
                  ) AS procedure_normal_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_amproc')
                      AND dependency.objid OPERATOR(pg_catalog.=) mapping.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_proc')
                      AND dependency.refobjid OPERATOR(pg_catalog.=) procedure.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'a'
                  ) AS procedure_auto_dependency_count
           FROM pg_catalog.pg_amproc AS mapping
           JOIN pg_catalog.pg_opfamily AS operator_family
             ON operator_family.oid OPERATOR(pg_catalog.=) mapping.amprocfamily
           JOIN pg_catalog.pg_namespace AS operator_family_namespace
             ON operator_family_namespace.oid OPERATOR(pg_catalog.=)
                operator_family.opfnamespace
           JOIN pg_catalog.pg_am AS access_method
             ON access_method.oid OPERATOR(pg_catalog.=) operator_family.opfmethod
           JOIN pg_catalog.pg_opclass AS operator_class
             ON operator_class.opcfamily OPERATOR(pg_catalog.=) operator_family.oid
            AND operator_class.opcmethod OPERATOR(pg_catalog.=) access_method.oid
           JOIN pg_catalog.pg_namespace AS operator_class_namespace
             ON operator_class_namespace.oid OPERATOR(pg_catalog.=)
                operator_class.opcnamespace
           JOIN pg_catalog.pg_proc AS procedure
             ON procedure.oid OPERATOR(pg_catalog.=) mapping.amproc
           JOIN pg_catalog.pg_namespace AS procedure_namespace
             ON procedure_namespace.oid OPERATOR(pg_catalog.=) procedure.pronamespace
           WHERE operator_family_namespace.nspname OPERATOR(pg_catalog.=) 'public'
             AND operator_family.opfname OPERATOR(pg_catalog.=) 'gin_trgm_ops'
             AND operator_class_namespace.nspname OPERATOR(pg_catalog.=) 'public'
             AND operator_class.opcname OPERATOR(pg_catalog.=) 'gin_trgm_ops'
             AND access_method.amname OPERATOR(pg_catalog.=) 'gin'
           ORDER BY mapping.amprocnum`,
  }, readinessOptions("inspectRequiredGinTrgmSupportFunctions", signal));
  const expectedBySupportNumber = new Map<number, RequiredGinTrgmSupportFunction>(
    REQUIRED_GIN_TRGM_SUPPORT_FUNCTIONS.map((mapping) => (
      [mapping.supportNumber, mapping] as const
    )),
  );
  const observed = new Set<number>();
  for (const row of result.rows) {
    if (typeof row.support_number !== "number") {
      throw readinessError("extension-preflight", "inspectRequiredGinTrgmSupportFunctions");
    }
    const expected = expectedBySupportNumber.get(row.support_number);
    const operatorClassDependency = expected?.dependencyKind === "operator-class";
    const familyDependency = expected?.dependencyKind === "family";
    const extensionProcedure = expected?.functionIdentity.startsWith("public.") === true;
    if (
      expected === undefined
      || observed.has(row.support_number)
      || row.left_type !== "text"
      || row.right_type !== "text"
      || row.function_identity !== expected.functionIdentity
      || row.dependency_count !== (extensionProcedure ? 2 : 1)
      || row.family_auto_dependency_count !== (familyDependency ? 1 : 0)
      || row.operator_class_internal_dependency_count !== (operatorClassDependency ? 1 : 0)
      || row.procedure_normal_dependency_count !== (operatorClassDependency ? 1 : 0)
      || row.procedure_auto_dependency_count !== (
        familyDependency && extensionProcedure ? 1 : 0
      )
    ) {
      throw readinessError("extension-preflight", "inspectRequiredGinTrgmSupportFunctions");
    }
    observed.add(row.support_number);
  }
  if (observed.size !== expectedBySupportNumber.size) {
    throw readinessError("extension-preflight", "inspectRequiredGinTrgmSupportFunctions");
  }
}

function managedCatalogQuery(): string {
  return `WITH expected_owner AS (
             SELECT role.oid
             FROM pg_catalog.pg_roles AS role
             WHERE role.rolname OPERATOR(pg_catalog.=) $1
           ),
           catalog_objects(object_identity, owner_oid) AS (
             SELECT pg_catalog.concat(
                      CASE relation.relkind
                        WHEN 'r' THEN 'table|'
                        WHEN 'S' THEN 'sequence|'
                      END,
                      relation.relname
                    ),
                    relation.relowner
             FROM pg_catalog.pg_class AS relation
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND relation.relkind OPERATOR(pg_catalog.=)
                 ANY (ARRAY['r', 'S']::pg_catalog."char"[])
             UNION ALL
             SELECT pg_catalog.concat(
                      'function|',
                      procedure.proname,
                      '|',
                      pg_catalog.pg_get_function_identity_arguments(procedure.oid)
                    ),
                    procedure.proowner
             FROM pg_catalog.pg_proc AS procedure
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) procedure.pronamespace
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND procedure.prokind OPERATOR(pg_catalog.=) 'f'
             UNION ALL
             SELECT pg_catalog.concat('dictionary|', dictionary.dictname),
                    dictionary.dictowner
             FROM pg_catalog.pg_ts_dict AS dictionary
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) dictionary.dictnamespace
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
             UNION ALL
             SELECT pg_catalog.concat('configuration|', configuration.cfgname),
                    configuration.cfgowner
             FROM pg_catalog.pg_ts_config AS configuration
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) configuration.cfgnamespace
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
           ),
           expected_objects AS (
             SELECT pg_catalog.unnest($2::pg_catalog.text[]) AS object_identity
           ),
           managed_inventory AS (
             SELECT expected_objects.object_identity,
                    catalog_objects.owner_oid
             FROM expected_objects
             LEFT JOIN catalog_objects
               ON catalog_objects.object_identity OPERATOR(pg_catalog.=)
                 expected_objects.object_identity
           ),
           schema_metadata AS (
             SELECT namespace.oid,
                    namespace.nspowner
             FROM pg_catalog.pg_namespace AS namespace
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
           ),
           ledger_metadata AS (
             SELECT relation.relkind,
                    relation.relowner
             FROM pg_catalog.pg_class AS relation
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND relation.relname OPERATOR(pg_catalog.=) 'schema_migrations'
           )
           SELECT EXISTS (SELECT 1 FROM expected_owner) AS expected_owner_exists,
                  EXISTS (SELECT 1 FROM schema_metadata) AS schema_exists,
                  COALESCE((
                    SELECT schema_metadata.nspowner OPERATOR(pg_catalog.=)
                      expected_owner.oid
                    FROM schema_metadata
                    CROSS JOIN expected_owner
                  ), false) AS schema_owned,
                  EXISTS (SELECT 1 FROM ledger_metadata) AS ledger_exists,
                  (SELECT ledger_metadata.relkind::pg_catalog.text
                   FROM ledger_metadata LIMIT 1) AS ledger_kind,
                  COALESCE((
                    SELECT ledger_metadata.relowner OPERATOR(pg_catalog.=)
                      expected_owner.oid
                    FROM ledger_metadata
                    CROSS JOIN expected_owner
                  ), false) AS ledger_owned,
                  pg_catalog.cardinality($2::pg_catalog.text[]) AS expected_object_count,
                  pg_catalog.count(managed_inventory.owner_oid)::pg_catalog.int4
                    AS actual_object_count,
                  pg_catalog.count(*) FILTER (
                    WHERE managed_inventory.owner_oid OPERATOR(pg_catalog.=)
                      expected_owner.oid
                  )::pg_catalog.int4 AS owned_object_count
           FROM managed_inventory
           CROSS JOIN expected_owner
           GROUP BY expected_owner.oid`;
}

async function inspectOwnership(
  executor: PostgreSqlQueryExecutor,
  expectedOwner: string,
  snapshot: PostgreSqlSchemaSnapshot,
  signal: AbortSignal | undefined,
): Promise<{ readonly managedObjectCount: number }> {
  const result = await executor.query<OwnershipRow, [string, readonly string[]]>({
    text: managedCatalogQuery(),
    values: [expectedOwner, snapshot.managedObjectIdentities],
  }, readinessOptions("inspectSchemaOwnership", signal));
  const row = result.rows[0];
  if (
    !row
    || row.expected_owner_exists !== true
    || row.schema_exists !== true
    || row.schema_owned !== true
    || row.ledger_exists !== true
    || row.ledger_kind !== "r"
    || row.ledger_owned !== true
    || !isSafeCount(row.expected_object_count)
    || row.expected_object_count !== snapshot.managedObjectIdentities.length
    || !isSafeCount(row.actual_object_count)
    || row.actual_object_count !== snapshot.managedObjectIdentities.length
    || !isSafeCount(row.owned_object_count)
    || row.owned_object_count !== snapshot.managedObjectIdentities.length
  ) {
    throw readinessError("schema-ownership", "inspectSchemaOwnership");
  }
  return { managedObjectCount: row.actual_object_count };
}

async function inspectMigrationHistory(
  executor: PostgreSqlQueryExecutor,
  migrations: ReturnType<typeof loadPostgreSqlMigrations>,
  signal: AbortSignal | undefined,
): Promise<readonly string[]> {
  const result = await executor.query<MigrationRow>({
    text: "SELECT id, checksum_sha256 FROM lcm.schema_migrations ORDER BY id",
  }, readinessOptions("readMigrations", signal));
  if (result.rows.length !== migrations.length) {
    throw readinessError("migration-ledger", "readMigrations");
  }
  const ids: string[] = [];
  for (let index = 0; index < migrations.length; index += 1) {
    const expected = migrations[index];
    const actual = result.rows[index];
    if (
      !expected
      || typeof actual?.id !== "string"
      || typeof actual.checksum_sha256 !== "string"
      || actual.id !== expected.id
      || actual.checksum_sha256 !== expected.sha256
    ) {
      throw readinessError("migration-ledger", "readMigrations");
    }
    ids.push(actual.id);
  }
  return Object.freeze(ids);
}

function privilegeKey(entry: PostgreSqlRuntimePrivilegeEntry): string {
  return [
    entry.kind,
    entry.object,
    entry.column ?? "",
    entry.privilege,
  ].join("|");
}

function effectivePrivilegeKey(
  privilegeKind: string,
  objectIdentity: string,
  columnName: string | null,
  privilegeType: string,
): string {
  return [privilegeKind, objectIdentity, columnName ?? "", privilegeType].join("|");
}

function actualAclIdentity(
  row: AclRow,
  runtimeRole: string,
  kind: PostgreSqlRuntimePrivilegeKind,
): string | null {
  if (
    typeof row.object_identity !== "string"
    || typeof row.privilege_type !== "string"
    || !isBoolean(row.grantee_is_owner)
    || !isBoolean(row.grantor_is_owner)
    || !isBoolean(row.is_grantable)
  ) return null;
  const grantee = row.grantee_is_owner
    ? "owner"
    : row.grantee_name === null
      ? "public"
      : row.grantee_name === runtimeRole
        ? "runtime"
        : typeof row.grantee_name === "string" ? row.grantee_name : null;
  const grantor = row.grantor_is_owner ? "owner" : "foreign";
  if (grantee === null) return null;
  return [kind, row.object_identity, grantee, grantor, row.privilege_type, row.is_grantable].join("|");
}

async function inspectSchemaAcl(
  executor: PostgreSqlQueryExecutor,
  runtimeRole: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await executor.query<SchemaAclRow, [readonly string[]]>({
    text: `WITH target AS (
             SELECT pg_catalog.unnest($1::pg_catalog.text[]) AS schema_name
           ),
           metadata AS (
             SELECT namespace.nspname AS schema_name,
                    namespace.nspowner,
                    COALESCE(
                      namespace.nspacl,
                      pg_catalog.acldefault('n', namespace.nspowner)
                    ) AS effective_acl
             FROM pg_catalog.pg_namespace AS namespace
             JOIN target
               ON target.schema_name OPERATOR(pg_catalog.=) namespace.nspname
           )
           SELECT metadata.schema_name,
                  privilege.grantee OPERATOR(pg_catalog.=) metadata.nspowner
                    AS grantee_is_owner,
                  grantee.rolname::text AS grantee_name,
                  privilege.grantor OPERATOR(pg_catalog.=) metadata.nspowner
                    AS grantor_is_owner,
                  privilege.privilege_type,
                  privilege.is_grantable::pg_catalog.bool AS is_grantable
           FROM metadata
           CROSS JOIN LATERAL pg_catalog.aclexplode(metadata.effective_acl) AS privilege
           LEFT JOIN pg_catalog.pg_roles AS grantee
             ON grantee.oid OPERATOR(pg_catalog.=) privilege.grantee
           ORDER BY metadata.schema_name, privilege.privilege_type`,
    values: [["lcm", "public"]],
  }, readinessOptions("inspectSchemaAcl", signal));
  const entries = [
    ...POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required,
    ...POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.optional,
  ];
  const required = new Set<string>();
  const allowed = new Set<string>();
  for (const schema of ["lcm", "public"]) {
    required.add(["schema", schema, "owner", "owner", "CREATE", false].join("|"));
    required.add(["schema", schema, "owner", "owner", "USAGE", false].join("|"));
  }
  for (const entry of entries.filter(({ kind }) => kind === "schema")) {
    required.add(["schema", entry.object, "runtime", "owner", entry.privilege, false].join("|"));
  }
  for (const entry of required) allowed.add(entry);
  allowed.add(["schema", "public", "public", "owner", "USAGE", false].join("|"));
  const actual = new Set<string>();
  for (const row of result.rows) {
    const schemaName = row.schema_name;
    const identity = actualAclIdentity(
      { ...row, object_identity: schemaName },
      runtimeRole,
      "schema",
    );
    if (typeof schemaName !== "string" || identity === null) {
      throw readinessError("acl-shape", "inspectSchemaAcl");
    }
    actual.add(identity);
  }
  if (
    [...actual].some((entry) => !allowed.has(entry))
    || [...required].some((entry) => !actual.has(entry))
  ) {
    throw readinessError("acl-shape", "inspectSchemaAcl");
  }
}

async function inspectRelationAcl(
  executor: PostgreSqlQueryExecutor,
  runtimeRole: string,
  snapshot: PostgreSqlSchemaSnapshot,
  signal: AbortSignal | undefined,
): Promise<ReadonlySet<string>> {
  const result = await executor.query<AclRow, [readonly string[]]>({
    text: `SELECT pg_catalog.concat(
                    CASE relation.relkind WHEN 'r' THEN 'table|' WHEN 'S' THEN 'sequence|' END,
                    relation.relname
                  ) AS object_identity,
                  privilege.grantee OPERATOR(pg_catalog.=) relation.relowner
                    AS grantee_is_owner,
                  grantee.rolname::text AS grantee_name,
                  privilege.grantor OPERATOR(pg_catalog.=) relation.relowner
                    AS grantor_is_owner,
                  privilege.privilege_type,
                  privilege.is_grantable::pg_catalog.bool AS is_grantable
           FROM pg_catalog.pg_class AS relation
           JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(
               relation.relacl,
               pg_catalog.acldefault(
                 CASE relation.relkind WHEN 'r' THEN 'r'::pg_catalog."char" ELSE 's'::pg_catalog."char" END,
                 relation.relowner
               )
             )
           ) AS privilege
           LEFT JOIN pg_catalog.pg_roles AS grantee
             ON grantee.oid OPERATOR(pg_catalog.=) privilege.grantee
           WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
             AND pg_catalog.concat(
               CASE relation.relkind WHEN 'r' THEN 'table|' WHEN 'S' THEN 'sequence|' END,
               relation.relname
             ) OPERATOR(pg_catalog.=) ANY ($1::pg_catalog.text[])
           ORDER BY object_identity, privilege.privilege_type`,
    values: [snapshot.relationAclIdentities],
  }, readinessOptions("inspectRelationAcl", signal));
  const ownerIdentities = new Set<string>();
  for (const object of snapshot.relationAclIdentities) {
    const relationKind = object.startsWith("table|") ? "table" : "sequence";
    const ownerPrivileges = relationKind === "table"
      ? ["DELETE", "INSERT", "MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"]
      : ["SELECT", "UPDATE", "USAGE"];
    for (const privilege of ownerPrivileges) {
      ownerIdentities.add(["relation", object, "owner", "owner", privilege, false].join("|"));
    }
  }
  const requiredIdentities = new Map<string, string>();
  for (const entry of POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required) {
    if (entry.kind !== "relation" && entry.kind !== "sequence") continue;
    const relationKind = entry.kind === "relation" ? "table" : "sequence";
    const objectIdentity = `${relationKind}|${entry.object.replace(/^lcm\./u, "")}`;
    requiredIdentities.set(
      privilegeKey(entry),
      ["relation", objectIdentity, "runtime", "owner", entry.privilege, false].join("|"),
    );
  }
  const optionalIdentities = new Map<string, string>();
  for (const entry of POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.optional) {
    if (entry.kind !== "relation") continue;
    const objectIdentity = `table|${entry.object.replace(/^lcm\./u, "")}`;
    optionalIdentities.set(
      privilegeKey(entry),
      ["relation", objectIdentity, "runtime", "owner", entry.privilege, false].join("|"),
    );
  }
  const mandatoryIdentities = new Set([
    ...ownerIdentities,
    ...requiredIdentities.values(),
  ]);
  const allowedIdentities = new Set([
    ...mandatoryIdentities,
    ...optionalIdentities.values(),
  ]);
  const actual = new Set<string>();
  for (const row of result.rows) {
    const identity = actualAclIdentity(row, runtimeRole, "relation");
    if (identity === null) throw readinessError("acl-shape", "inspectRelationAcl");
    actual.add(identity);
  }
  if (
    [...actual].some((entry) => !allowedIdentities.has(entry))
    || [...mandatoryIdentities].some((entry) => !actual.has(entry))
  ) {
    throw readinessError("acl-shape", "inspectRelationAcl");
  }
  return new Set(
    [...optionalIdentities]
      .filter(([, identity]) => actual.has(identity))
      .map(([key]) => key),
  );
}

async function inspectColumnAcl(
  executor: PostgreSqlQueryExecutor,
  runtimeRole: string,
  snapshot: PostgreSqlSchemaSnapshot,
  signal: AbortSignal | undefined,
): Promise<ReadonlySet<string>> {
  const result = await executor.query<AclRow, [readonly string[]]>({
    text: `SELECT pg_catalog.concat('lcm.', relation.relname, '|', attribute.attname)
                    AS object_identity,
                  privilege.grantee OPERATOR(pg_catalog.=) relation.relowner
                    AS grantee_is_owner,
                  grantee.rolname::text AS grantee_name,
                  privilege.grantor OPERATOR(pg_catalog.=) relation.relowner
                    AS grantor_is_owner,
                  privilege.privilege_type,
                  privilege.is_grantable::pg_catalog.bool AS is_grantable
           FROM pg_catalog.pg_attribute AS attribute
           JOIN pg_catalog.pg_class AS relation
             ON relation.oid OPERATOR(pg_catalog.=) attribute.attrelid
           JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
           CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
           LEFT JOIN pg_catalog.pg_roles AS grantee
             ON grantee.oid OPERATOR(pg_catalog.=) privilege.grantee
           WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
             AND relation.relkind OPERATOR(pg_catalog.=) 'r'
             AND attribute.attnum OPERATOR(pg_catalog.>) 0
             AND NOT attribute.attisdropped
             AND pg_catalog.concat('table|', relation.relname)
               OPERATOR(pg_catalog.=) ANY ($1::pg_catalog.text[])
           ORDER BY object_identity, privilege.privilege_type`,
    values: [snapshot.tableIdentities.map((table) => `table|${table}`)],
  }, readinessOptions("inspectColumnAcl", signal));
  const requiredIdentities = new Map<string, string>();
  for (const entry of POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required) {
    if (entry.kind !== "column" || entry.column === undefined) continue;
    requiredIdentities.set(
      privilegeKey(entry),
      ["column", `${entry.object}|${entry.column}`, "runtime", "owner", entry.privilege, false].join("|"),
    );
  }
  const optionalIdentities = new Map<string, string>();
  for (const entry of POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.optional) {
    if (entry.kind !== "column" || entry.column === undefined) continue;
    optionalIdentities.set(
      privilegeKey(entry),
      ["column", `${entry.object}|${entry.column}`, "runtime", "owner", entry.privilege, false].join("|"),
    );
  }
  const allowedIdentities = new Set([
    ...requiredIdentities.values(),
    ...optionalIdentities.values(),
  ]);
  const actual = new Set<string>();
  for (const row of result.rows) {
    const identity = actualAclIdentity(row, runtimeRole, "column");
    if (identity === null) throw readinessError("acl-shape", "inspectColumnAcl");
    actual.add(identity);
  }
  if (
    [...actual].some((entry) => !allowedIdentities.has(entry))
    || [...requiredIdentities.values()].some((entry) => !actual.has(entry))
  ) {
    throw readinessError("acl-shape", "inspectColumnAcl");
  }
  return new Set(
    [...optionalIdentities]
      .filter(([, identity]) => actual.has(identity))
      .map(([key]) => key),
  );
}

async function inspectFunctionAcl(
  executor: PostgreSqlQueryExecutor,
  runtimeRole: string,
  snapshot: PostgreSqlSchemaSnapshot,
  signal: AbortSignal | undefined,
): Promise<void> {
  const functionIdentities = [
    ...snapshot.managedObjectIdentities
      .filter((identity) => identity.startsWith("function|"))
      .map((identity) => {
        const [, name, args] = identity.split("|");
        return `lcm.${name}(${args})`;
      }),
    ...POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required
      .filter(({ kind }) => kind === "function")
      .map(({ object }) => object),
  ];
  const result = await executor.query<FunctionAclRow, [readonly string[]]>({
    text: `SELECT pg_catalog.concat(
                    namespace.nspname,
                    '.',
                    procedure.proname,
                    '(',
                    pg_catalog.pg_get_function_identity_arguments(procedure.oid),
                    ')'
                  ) AS function_identity,
                  privilege.grantee OPERATOR(pg_catalog.=) procedure.proowner
                    AS grantee_is_owner,
                  grantee.rolname::text AS grantee_name,
                  privilege.grantor OPERATOR(pg_catalog.=) procedure.proowner
                    AS grantor_is_owner,
                  privilege.privilege_type,
                  privilege.is_grantable::pg_catalog.bool AS is_grantable,
                  (
                    SELECT extension.extname::pg_catalog.text
                    FROM pg_catalog.pg_depend AS dependency
                    JOIN pg_catalog.pg_extension AS extension
                      ON extension.oid OPERATOR(pg_catalog.=) dependency.refobjid
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_proc')
                      AND dependency.objid OPERATOR(pg_catalog.=) procedure.oid
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'e'
                  ) AS extension_name
           FROM pg_catalog.pg_proc AS procedure
           JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid OPERATOR(pg_catalog.=) procedure.pronamespace
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(
               procedure.proacl,
               pg_catalog.acldefault('f', procedure.proowner)
             )
           ) AS privilege
           LEFT JOIN pg_catalog.pg_roles AS grantee
             ON grantee.oid OPERATOR(pg_catalog.=) privilege.grantee
           WHERE pg_catalog.concat(
                    namespace.nspname, '.', procedure.proname, '(',
                    pg_catalog.pg_get_function_identity_arguments(procedure.oid), ')'
                 ) OPERATOR(pg_catalog.=) ANY ($1::pg_catalog.text[])
           ORDER BY function_identity, privilege.privilege_type`,
    values: [functionIdentities],
  }, readinessOptions("inspectFunctionAcl", signal));
  const entries = [
    ...POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required,
    ...POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.optional,
  ].filter(({ kind }) => kind === "function");
  const expectedExtensions = new Map<string, string | null>();
  for (const functionIdentity of functionIdentities) {
    expectedExtensions.set(functionIdentity, null);
  }
  for (const entry of entries) {
    expectedExtensions.set(entry.object, entry.extension ?? null);
  }
  const required = new Set<string>();
  const allowed = new Set<string>();
  for (const functionIdentity of functionIdentities) {
    required.add(["function", functionIdentity, "owner", "owner", "EXECUTE", false].join("|"));
  }
  for (const entry of entries) {
    required.add(["function", entry.object, "runtime", "owner", "EXECUTE", false].join("|"));
  }
  for (const entry of required) allowed.add(entry);
  for (const entry of entries) {
    if (entry.extension !== undefined) {
      allowed.add(["function", entry.object, "public", "owner", "EXECUTE", false].join("|"));
    }
  }
  const actual = new Set<string>();
  for (const row of result.rows) {
    if (
      typeof row.function_identity !== "string"
      || (typeof row.extension_name !== "string" && row.extension_name !== null)
      || row.extension_name !== expectedExtensions.get(row.function_identity)
    ) {
      throw readinessError("acl-shape", "inspectFunctionAcl");
    }
    const identity = actualAclIdentity(
      { ...row, object_identity: row.function_identity },
      runtimeRole,
      "function",
    );
    if (identity === null) {
      throw readinessError("acl-shape", "inspectFunctionAcl");
    }
    actual.add(["function", row.function_identity, identity.split("|").slice(2).join("|")].join("|"));
  }
  if (
    [...actual].some((entry) => !allowed.has(entry))
    || [...required].some((entry) => !actual.has(entry))
  ) {
    throw readinessError("acl-shape", "inspectFunctionAcl");
  }
}

function definitionQuery(
  snapshot: PostgreSqlSchemaSnapshot,
  runtimeRole: string,
): QueryConfig<unknown[]> {
  const expectations = getPostgreSqlSchemaSnapshotExpectations(snapshot);
  const relationSanctions = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required
    .concat(POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.optional)
    .filter(({ kind }) => kind === "relation" || kind === "sequence")
    .map((entry) => (
      `${entry.kind === "relation" ? "table" : "sequence"}|${
        entry.object.replace(/^lcm\./u, "")
      }|${entry.privilege}`
    ));
  const columnSanctions = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required
    .concat(POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.optional)
    .filter(({ kind }) => kind === "column")
    .map((entry) => `${entry.object.replace(/^lcm\./u, "")}|${entry.column}|${entry.privilege}`);
  return {
    text: `WITH actual_indexes AS (
             SELECT index_relation.relname AS object_name,
                    pg_catalog.pg_get_indexdef(index_relation.oid) AS definition,
                    index_metadata.indisvalid AS is_valid
             FROM pg_catalog.pg_class AS index_relation
             JOIN pg_catalog.pg_index AS index_metadata
               ON index_metadata.indexrelid OPERATOR(pg_catalog.=) index_relation.oid
             JOIN pg_catalog.pg_namespace AS index_namespace
               ON index_namespace.oid OPERATOR(pg_catalog.=) index_relation.relnamespace
             JOIN pg_catalog.pg_class AS relation
               ON relation.oid OPERATOR(pg_catalog.=) index_metadata.indrelid
             JOIN pg_catalog.pg_namespace AS relation_namespace
               ON relation_namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
             WHERE index_namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND relation_namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND relation.relkind OPERATOR(pg_catalog.=) ANY (
                 ARRAY['r', 'p']::pg_catalog."char"[]
               )
               AND index_relation.relkind OPERATOR(pg_catalog.=) 'i'
               AND index_metadata.indisready
               AND index_metadata.indislive
               AND relation.relname OPERATOR(pg_catalog.=) ANY ($3::pg_catalog.text[])
           ),
           actual_triggers AS (
             SELECT trigger.tgname AS object_name,
                    pg_catalog.pg_get_triggerdef(trigger.oid, true) AS definition,
                    trigger.tgenabled::pg_catalog.text AS enabled_mode
             FROM pg_catalog.pg_trigger AS trigger
             JOIN pg_catalog.pg_class AS relation
               ON relation.oid OPERATOR(pg_catalog.=) trigger.tgrelid
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND NOT trigger.tgisinternal
               AND relation.relname OPERATOR(pg_catalog.=) ANY ($3::pg_catalog.text[])
           ),
           actual_rewrite_rules AS (
             SELECT relation.relname AS table_name,
                    rewrite.rulename AS object_name,
                    rewrite.ev_type::pg_catalog.text AS event_type,
                    rewrite.is_instead::pg_catalog.text AS is_instead,
                    rewrite.ev_enabled::pg_catalog.text AS enabled_mode,
                    pg_catalog.pg_get_ruledef(rewrite.oid, true) AS definition
             FROM pg_catalog.pg_rewrite AS rewrite
             JOIN pg_catalog.pg_class AS relation
               ON relation.oid OPERATOR(pg_catalog.=) rewrite.ev_class
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND relation.relkind OPERATOR(pg_catalog.=) ANY (
                 ARRAY['r', 'p']::pg_catalog."char"[]
               )
               AND relation.relname OPERATOR(pg_catalog.=) ANY ($3::pg_catalog.text[])
           ),
           constraint_trigger_entries AS (
             SELECT trigger.tgconstraint AS constraint_oid,
                    pg_catalog.concat_ws(
                      '|',
                      trigger_namespace.nspname,
                      trigger_relation.relname,
                      canonical_trigger.canonical_name,
                      COALESCE(constraint_relation_namespace.nspname, ''),
                      COALESCE(constraint_relation.relname, ''),
                      pg_catalog.replace(
                        pg_catalog.pg_get_triggerdef(trigger.oid, true),
                        pg_catalog.quote_ident(trigger.tgname),
                        pg_catalog.quote_ident(canonical_trigger.canonical_name)
                      ),
                      trigger.tgenabled::pg_catalog.text,
                      trigger.tgisinternal::pg_catalog.text,
                      trigger.tgdeferrable::pg_catalog.text,
                      trigger.tginitdeferred::pg_catalog.text,
                      (trigger.tgparentid OPERATOR(pg_catalog.<>) 0)::pg_catalog.text,
                      COALESCE(parent_trigger_namespace.nspname, ''),
                      COALESCE(parent_trigger_relation.relname, ''),
                      COALESCE(
                        CASE
                          WHEN parent_trigger.tgisinternal
                            AND parent_trigger.tgname OPERATOR(pg_catalog.~)
                              '^RI_ConstraintTrigger_[ac]_[0-9]+$'
                            THEN pg_catalog.regexp_replace(
                              parent_trigger.tgname,
                              '_[0-9]+$',
                              '_<oid>'
                            )
                          ELSE parent_trigger.tgname
                        END,
                        ''
                      )
                    ) AS trigger_fingerprint
             FROM pg_catalog.pg_trigger AS trigger
             JOIN pg_catalog.pg_class AS trigger_relation
               ON trigger_relation.oid OPERATOR(pg_catalog.=) trigger.tgrelid
             JOIN pg_catalog.pg_namespace AS trigger_namespace
               ON trigger_namespace.oid OPERATOR(pg_catalog.=) trigger_relation.relnamespace
             LEFT JOIN pg_catalog.pg_class AS constraint_relation
               ON constraint_relation.oid OPERATOR(pg_catalog.=) trigger.tgconstrrelid
             LEFT JOIN pg_catalog.pg_namespace AS constraint_relation_namespace
               ON constraint_relation_namespace.oid OPERATOR(pg_catalog.=)
                 constraint_relation.relnamespace
             LEFT JOIN pg_catalog.pg_trigger AS parent_trigger
               ON parent_trigger.oid OPERATOR(pg_catalog.=) trigger.tgparentid
             LEFT JOIN pg_catalog.pg_class AS parent_trigger_relation
               ON parent_trigger_relation.oid OPERATOR(pg_catalog.=) parent_trigger.tgrelid
             LEFT JOIN pg_catalog.pg_namespace AS parent_trigger_namespace
               ON parent_trigger_namespace.oid OPERATOR(pg_catalog.=)
                 parent_trigger_relation.relnamespace
             CROSS JOIN LATERAL (
               SELECT CASE
                 WHEN trigger.tgisinternal
                   AND trigger.tgname OPERATOR(pg_catalog.~)
                     '^RI_ConstraintTrigger_[ac]_[0-9]+$'
                   THEN pg_catalog.regexp_replace(
                     trigger.tgname,
                     '_[0-9]+$',
                     '_<oid>'
                   )
                 ELSE trigger.tgname
               END AS canonical_name
             ) AS canonical_trigger
             WHERE trigger.tgconstraint OPERATOR(pg_catalog.<>) 0
           ),
           constraint_trigger_states AS (
             SELECT constraint_oid,
                    pg_catalog.count(*)::pg_catalog.int4 AS trigger_count,
                    pg_catalog.string_agg(
                      trigger_fingerprint,
                      E'\\n'
                      ORDER BY trigger_fingerprint
                    ) AS trigger_fingerprints
             FROM constraint_trigger_entries
             GROUP BY constraint_oid
           ),
           actual_constraints AS (
             SELECT constraint_metadata.conname AS object_name,
                    owning_namespace.nspname AS owning_schema_name,
                    owning_relation.relname AS owning_table_name,
                    COALESCE(referenced_namespace.nspname, '') AS referenced_schema_name,
                    COALESCE(referenced_relation.relname, '') AS referenced_table_name,
                    constraint_metadata.contype::pg_catalog.text AS constraint_type,
                    pg_catalog.pg_get_constraintdef(constraint_metadata.oid, true) AS definition,
                    constraint_metadata.convalidated::pg_catalog.text AS validated,
                    constraint_metadata.conenforced::pg_catalog.text AS enforced,
                    constraint_metadata.connoinherit::pg_catalog.text AS no_inherit,
                    constraint_metadata.conislocal::pg_catalog.text AS is_local,
                    constraint_metadata.coninhcount::pg_catalog.text AS inherited_count,
                    (constraint_metadata.conparentid OPERATOR(pg_catalog.<>) 0)::pg_catalog.text
                      AS has_parent_constraint,
                    COALESCE(parent_constraint_namespace.nspname, '') AS parent_schema_name,
                    COALESCE(parent_constraint_relation.relname, '') AS parent_table_name,
                    COALESCE(parent_constraint.conname, '') AS parent_constraint_name,
                    COALESCE(constraint_trigger_states.trigger_count, 0)::pg_catalog.text
                      AS enforcement_trigger_count,
                    COALESCE(constraint_trigger_states.trigger_fingerprints, '')
                      AS enforcement_triggers
             FROM pg_catalog.pg_constraint AS constraint_metadata
             JOIN pg_catalog.pg_class AS owning_relation
               ON owning_relation.oid OPERATOR(pg_catalog.=) constraint_metadata.conrelid
             JOIN pg_catalog.pg_namespace AS owning_namespace
               ON owning_namespace.oid OPERATOR(pg_catalog.=) owning_relation.relnamespace
             LEFT JOIN pg_catalog.pg_class AS referenced_relation
               ON referenced_relation.oid OPERATOR(pg_catalog.=) constraint_metadata.confrelid
             LEFT JOIN pg_catalog.pg_namespace AS referenced_namespace
               ON referenced_namespace.oid OPERATOR(pg_catalog.=)
                 referenced_relation.relnamespace
             LEFT JOIN pg_catalog.pg_constraint AS parent_constraint
               ON parent_constraint.oid OPERATOR(pg_catalog.=) constraint_metadata.conparentid
             LEFT JOIN pg_catalog.pg_class AS parent_constraint_relation
               ON parent_constraint_relation.oid OPERATOR(pg_catalog.=)
                 parent_constraint.conrelid
             LEFT JOIN pg_catalog.pg_namespace AS parent_constraint_namespace
               ON parent_constraint_namespace.oid OPERATOR(pg_catalog.=)
                 parent_constraint_relation.relnamespace
             LEFT JOIN constraint_trigger_states
               ON constraint_trigger_states.constraint_oid OPERATOR(pg_catalog.=)
                 constraint_metadata.oid
             WHERE constraint_metadata.contype OPERATOR(pg_catalog.=) ANY (
                 ARRAY['c', 'f', 'p', 'u', 'x']::pg_catalog."char"[]
               )
               AND (
                 (
                   owning_namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                   AND owning_relation.relname OPERATOR(pg_catalog.=)
                     ANY ($3::pg_catalog.text[])
                 )
                 OR (
                   constraint_metadata.contype OPERATOR(pg_catalog.=) 'f'
                   AND referenced_namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                   AND referenced_relation.relname OPERATOR(pg_catalog.=)
                     ANY ($3::pg_catalog.text[])
                 )
               )
           ),
           not_null_constraint_entries AS (
             SELECT constraint_metadata.conrelid AS relation_oid,
                    constraint_key.attribute_number,
                    pg_catalog.concat_ws(
                      '|',
                      namespace.nspname,
                      relation.relname,
                      constraint_metadata.conname,
                      pg_catalog.pg_get_constraintdef(constraint_metadata.oid, true),
                      constraint_metadata.convalidated::pg_catalog.text,
                      constraint_metadata.conenforced::pg_catalog.text,
                      constraint_metadata.connoinherit::pg_catalog.text,
                      constraint_metadata.conislocal::pg_catalog.text,
                      constraint_metadata.coninhcount::pg_catalog.text,
                      (constraint_metadata.conparentid OPERATOR(pg_catalog.<>) 0)::pg_catalog.text,
                      COALESCE(parent_constraint_namespace.nspname, ''),
                      COALESCE(parent_constraint_relation.relname, ''),
                      COALESCE(parent_constraint.conname, '')
                    ) AS constraint_fingerprint
             FROM pg_catalog.pg_constraint AS constraint_metadata
             JOIN pg_catalog.pg_class AS relation
               ON relation.oid OPERATOR(pg_catalog.=) constraint_metadata.conrelid
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
             CROSS JOIN LATERAL pg_catalog.unnest(constraint_metadata.conkey)
               AS constraint_key(attribute_number)
             LEFT JOIN pg_catalog.pg_constraint AS parent_constraint
               ON parent_constraint.oid OPERATOR(pg_catalog.=) constraint_metadata.conparentid
             LEFT JOIN pg_catalog.pg_class AS parent_constraint_relation
               ON parent_constraint_relation.oid OPERATOR(pg_catalog.=)
                 parent_constraint.conrelid
             LEFT JOIN pg_catalog.pg_namespace AS parent_constraint_namespace
               ON parent_constraint_namespace.oid OPERATOR(pg_catalog.=)
                 parent_constraint_relation.relnamespace
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND relation.relname OPERATOR(pg_catalog.=) ANY ($3::pg_catalog.text[])
               AND constraint_metadata.contype OPERATOR(pg_catalog.=) 'n'
           ),
           not_null_constraint_states AS (
             SELECT relation_oid,
                    attribute_number,
                    pg_catalog.count(*)::pg_catalog.int4 AS constraint_count,
                    pg_catalog.string_agg(
                      constraint_fingerprint,
                      E'\\n'
                      ORDER BY constraint_fingerprint
                    ) AS constraint_fingerprints
             FROM not_null_constraint_entries
             GROUP BY relation_oid, attribute_number
           ),
           actual_generated_columns AS (
             SELECT relation.relname AS table_name,
                    attribute.attname AS column_name,
                    pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
                    attribute.attnotnull::pg_catalog.text AS not_null,
                    attribute.attgenerated::pg_catalog.text AS generation_kind,
                    pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid, true)
                      AS generation_expression,
                    pg_catalog.concat_ws('.', collation_namespace.nspname, collation_metadata.collname)
                      AS collation_name,
                    COALESCE(not_null_constraint_states.constraint_count, 0)::pg_catalog.text
                      AS not_null_constraint_count,
                    COALESCE(not_null_constraint_states.constraint_fingerprints, '')
                      AS not_null_constraints
             FROM pg_catalog.pg_attribute AS attribute
             JOIN pg_catalog.pg_class AS relation
               ON relation.oid OPERATOR(pg_catalog.=) attribute.attrelid
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
             JOIN pg_catalog.pg_attrdef AS attribute_default
               ON attribute_default.adrelid OPERATOR(pg_catalog.=) attribute.attrelid
              AND attribute_default.adnum OPERATOR(pg_catalog.=) attribute.attnum
             LEFT JOIN pg_catalog.pg_collation AS collation_metadata
               ON collation_metadata.oid OPERATOR(pg_catalog.=) attribute.attcollation
             LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
               ON collation_namespace.oid OPERATOR(pg_catalog.=) collation_metadata.collnamespace
             LEFT JOIN not_null_constraint_states
               ON not_null_constraint_states.relation_oid OPERATOR(pg_catalog.=)
                 attribute.attrelid
              AND not_null_constraint_states.attribute_number OPERATOR(pg_catalog.=)
                attribute.attnum
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND attribute.attnum OPERATOR(pg_catalog.>) 0
               AND NOT attribute.attisdropped
               AND attribute.attgenerated OPERATOR(pg_catalog.<>) ''
               AND relation.relname OPERATOR(pg_catalog.=) ANY ($3::pg_catalog.text[])
           ),
           actual_ordinary_columns AS (
             SELECT relation.relname AS table_name,
                    attribute.attname AS column_name,
                    pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
                    attribute.attnotnull::pg_catalog.text AS not_null,
                    COALESCE(pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid, true), '')
                      AS default_expression,
                    attribute.attidentity::pg_catalog.text AS identity_kind,
                    pg_catalog.concat_ws('.', collation_namespace.nspname, collation_metadata.collname)
                      AS collation_name,
                    COALESCE(not_null_constraint_states.constraint_count, 0)::pg_catalog.text
                      AS not_null_constraint_count,
                    COALESCE(not_null_constraint_states.constraint_fingerprints, '')
                      AS not_null_constraints
             FROM pg_catalog.pg_attribute AS attribute
             JOIN pg_catalog.pg_class AS relation
               ON relation.oid OPERATOR(pg_catalog.=) attribute.attrelid
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
             LEFT JOIN pg_catalog.pg_attrdef AS attribute_default
               ON attribute_default.adrelid OPERATOR(pg_catalog.=) attribute.attrelid
              AND attribute_default.adnum OPERATOR(pg_catalog.=) attribute.attnum
             LEFT JOIN pg_catalog.pg_collation AS collation_metadata
               ON collation_metadata.oid OPERATOR(pg_catalog.=) attribute.attcollation
             LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
               ON collation_namespace.oid OPERATOR(pg_catalog.=) collation_metadata.collnamespace
             LEFT JOIN not_null_constraint_states
               ON not_null_constraint_states.relation_oid OPERATOR(pg_catalog.=)
                 attribute.attrelid
              AND not_null_constraint_states.attribute_number OPERATOR(pg_catalog.=)
                attribute.attnum
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND attribute.attnum OPERATOR(pg_catalog.>) 0
               AND NOT attribute.attisdropped
               AND attribute.attgenerated OPERATOR(pg_catalog.=) ''
               AND relation.relname OPERATOR(pg_catalog.=) ANY ($3::pg_catalog.text[])
           ),
           actual_identity_sequences AS (
             SELECT sequence_relation.relname AS sequence_name,
                    sequence_relation.relpersistence::pg_catalog.text AS persistence,
                    pg_catalog.format_type(sequence_metadata.seqtypid, NULL) AS data_type,
                    sequence_metadata.seqincrement::pg_catalog.text AS increment_by,
                    sequence_metadata.seqmin::pg_catalog.text AS minimum_value,
                    sequence_metadata.seqmax::pg_catalog.text AS maximum_value,
                    sequence_metadata.seqstart::pg_catalog.text AS start_value,
                    sequence_metadata.seqcache::pg_catalog.text AS cache_size,
                    sequence_metadata.seqcycle::pg_catalog.text AS cycles,
                    dependency.deptype::pg_catalog.text AS dependency_type,
                    owning_relation.relname AS owning_table,
                    owning_attribute.attname AS owning_column
             FROM pg_catalog.pg_sequence AS sequence_metadata
             JOIN pg_catalog.pg_class AS sequence_relation
               ON sequence_relation.oid OPERATOR(pg_catalog.=) sequence_metadata.seqrelid
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) sequence_relation.relnamespace
             JOIN pg_catalog.pg_depend AS dependency
               ON dependency.classid OPERATOR(pg_catalog.=) pg_catalog.to_regclass('pg_catalog.pg_class')
              AND dependency.objid OPERATOR(pg_catalog.=) sequence_relation.oid
              AND dependency.objsubid OPERATOR(pg_catalog.=) 0
              AND dependency.refclassid OPERATOR(pg_catalog.=) pg_catalog.to_regclass('pg_catalog.pg_class')
              AND dependency.deptype OPERATOR(pg_catalog.=) 'i'
             JOIN pg_catalog.pg_class AS owning_relation
               ON owning_relation.oid OPERATOR(pg_catalog.=) dependency.refobjid
             JOIN pg_catalog.pg_attribute AS owning_attribute
               ON owning_attribute.attrelid OPERATOR(pg_catalog.=) dependency.refobjid
              AND owning_attribute.attnum OPERATOR(pg_catalog.=) dependency.refobjsubid
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND sequence_relation.relname OPERATOR(pg_catalog.=) ANY ($2::pg_catalog.text[])
           ),
           actual_tables AS (
             SELECT relation.relname AS table_name,
                    relation.relpersistence::pg_catalog.text AS persistence,
                    relation.relrowsecurity::pg_catalog.text AS row_security,
                    relation.relforcerowsecurity::pg_catalog.text AS force_row_security,
                    relation.relispartition::pg_catalog.text AS is_partition,
                    EXISTS (SELECT 1 FROM pg_catalog.pg_inherits AS inheritance
                            WHERE inheritance.inhrelid OPERATOR(pg_catalog.=) relation.oid)::text AS has_parent,
                    EXISTS (SELECT 1 FROM pg_catalog.pg_inherits AS inheritance
                            WHERE inheritance.inhparent OPERATOR(pg_catalog.=) relation.oid)::text AS has_child
             FROM pg_catalog.pg_class AS relation
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND relation.relkind OPERATOR(pg_catalog.=) 'r'
               AND relation.relname OPERATOR(pg_catalog.=) ANY ($3::pg_catalog.text[])
           ),
           acl_relations AS (
             SELECT pg_catalog.concat(
                      CASE relation.relkind WHEN 'r' THEN 'table|' WHEN 'S' THEN 'sequence|' END,
                      relation.relname
                    ) AS object_identity,
                    relation.relowner AS owner_oid,
                    COALESCE(
                      relation.relacl,
                      pg_catalog.acldefault(
                        CASE relation.relkind WHEN 'r' THEN 'r'::pg_catalog."char" ELSE 's'::pg_catalog."char" END,
                        relation.relowner
                      )
                    ) AS effective_acl
             FROM pg_catalog.pg_class AS relation
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND relation.relkind OPERATOR(pg_catalog.=) ANY (ARRAY['r', 'S']::pg_catalog."char"[])
           ),
           actual_relation_acls AS (
             SELECT acl_relations.object_identity,
                    CASE WHEN privilege.grantee OPERATOR(pg_catalog.=) acl_relations.owner_oid
                         THEN 'owner' ELSE privilege.grantee::pg_catalog.text END AS grantee,
                    CASE WHEN privilege.grantor OPERATOR(pg_catalog.=) acl_relations.owner_oid
                         THEN 'owner' ELSE privilege.grantor::pg_catalog.text END AS grantor,
                    privilege.privilege_type,
                    privilege.is_grantable::pg_catalog.text AS is_grantable
             FROM acl_relations
             CROSS JOIN LATERAL pg_catalog.aclexplode(acl_relations.effective_acl) AS privilege
             WHERE acl_relations.object_identity OPERATOR(pg_catalog.=) ANY ($4::pg_catalog.text[])
               AND NOT (
                 privilege.grantee OPERATOR(pg_catalog.=)
                   (SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname OPERATOR(pg_catalog.=) $10)
                 AND privilege.grantor OPERATOR(pg_catalog.=) acl_relations.owner_oid
                 AND privilege.is_grantable OPERATOR(pg_catalog.=) false
                 AND pg_catalog.concat(acl_relations.object_identity, '|', privilege.privilege_type)
                   OPERATOR(pg_catalog.=) ANY ($11::pg_catalog.text[])
               )
           ),
           raw_column_acls AS (
             SELECT pg_catalog.concat(relation.relname, '|', attribute.attname) AS object_identity,
                    COALESCE(CASE WHEN privilege.grantee OPERATOR(pg_catalog.=) relation.relowner
                                  THEN 'owner' ELSE privilege.grantee::pg_catalog.text END, '') AS grantee,
                    COALESCE(CASE WHEN privilege.grantor OPERATOR(pg_catalog.=) relation.relowner
                                  THEN 'owner' ELSE privilege.grantor::pg_catalog.text END, '') AS grantor,
                    COALESCE(privilege.privilege_type, '') AS privilege_type,
                    COALESCE(privilege.is_grantable::pg_catalog.text, '') AS is_grantable,
                    COALESCE(
                      privilege.grantee OPERATOR(pg_catalog.<>) 0::pg_catalog.oid
                      AND privilege.grantee OPERATOR(pg_catalog.<>) relation.relowner
                      AND privilege.grantor OPERATOR(pg_catalog.=) relation.relowner
                      AND privilege.is_grantable OPERATOR(pg_catalog.=) false
                      AND pg_catalog.concat(relation.relname, '|', attribute.attname, '|', privilege.privilege_type)
                        OPERATOR(pg_catalog.=) ANY ($12::pg_catalog.text[]),
                      false
                    ) AS sanctioned
             FROM pg_catalog.pg_attribute AS attribute
             JOIN pg_catalog.pg_class AS relation
               ON relation.oid OPERATOR(pg_catalog.=) attribute.attrelid
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
             LEFT JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege ON true
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND pg_catalog.concat_ws('|', relation.relname, attribute.attname)
                 OPERATOR(pg_catalog.=) ANY ($5::pg_catalog.text[])
           ),
           actual_column_acls AS (
             SELECT DISTINCT object_identity,
                    CASE WHEN sanctioned THEN '' ELSE grantee END AS grantee,
                    CASE WHEN sanctioned THEN '' ELSE grantor END AS grantor,
                    CASE WHEN sanctioned THEN '' ELSE privilege_type END AS privilege_type,
                    CASE WHEN sanctioned THEN '' ELSE is_grantable END AS is_grantable
             FROM raw_column_acls
           ),
           actual_groups(object_kind, existing_count, definition_sha256) AS (
             SELECT 'index', pg_catalog.count(*)::pg_catalog.int4,
                    pg_catalog.encode(public.digest(COALESCE(pg_catalog.string_agg(
                      pg_catalog.concat_ws('|', object_name, definition), E'\\n' ORDER BY object_name), ''), 'sha256'), 'hex')
             FROM actual_indexes
             UNION ALL
             SELECT 'trigger', pg_catalog.count(*)::pg_catalog.int4,
                    pg_catalog.encode(public.digest(COALESCE(pg_catalog.string_agg(
                      pg_catalog.concat_ws('|', object_name, definition, enabled_mode), E'\\n' ORDER BY object_name), ''), 'sha256'), 'hex')
             FROM actual_triggers
             UNION ALL
             SELECT 'constraint', pg_catalog.count(*)::pg_catalog.int4,
                    pg_catalog.encode(public.digest(COALESCE(pg_catalog.string_agg(
                      pg_catalog.concat_ws(
                        '|', owning_schema_name, owning_table_name, object_name,
                        referenced_schema_name, referenced_table_name, constraint_type,
                        definition, validated, enforced, no_inherit, is_local,
                        inherited_count, has_parent_constraint, parent_schema_name,
                        parent_table_name, parent_constraint_name,
                        enforcement_trigger_count, enforcement_triggers
                      ),
                      E'\\n' ORDER BY owning_schema_name, owning_table_name, object_name,
                        referenced_schema_name, referenced_table_name, constraint_type,
                        definition, validated, enforced, no_inherit, is_local,
                        inherited_count, has_parent_constraint, parent_schema_name,
                        parent_table_name, parent_constraint_name,
                        enforcement_trigger_count, enforcement_triggers), ''), 'sha256'), 'hex')
             FROM actual_constraints
             UNION ALL
             SELECT 'generated_column', pg_catalog.count(*)::pg_catalog.int4,
                    pg_catalog.encode(public.digest(COALESCE(pg_catalog.string_agg(
                      pg_catalog.concat_ws('|', table_name, column_name, data_type, not_null, generation_kind,
                        generation_expression, collation_name, not_null_constraint_count,
                        not_null_constraints), E'\\n' ORDER BY table_name, column_name), ''), 'sha256'), 'hex')
             FROM actual_generated_columns
             UNION ALL
             SELECT 'column_acl', pg_catalog.count(DISTINCT object_identity)::pg_catalog.int4,
                    pg_catalog.encode(public.digest(COALESCE(pg_catalog.string_agg(
                      pg_catalog.concat_ws('|', object_identity, grantee, grantor, privilege_type, is_grantable),
                      E'\\n' ORDER BY object_identity, grantee, grantor, privilege_type, is_grantable), ''), 'sha256'), 'hex')
             FROM actual_column_acls
             UNION ALL
             SELECT 'identity_sequence', pg_catalog.count(*)::pg_catalog.int4,
                    pg_catalog.encode(public.digest(COALESCE(pg_catalog.string_agg(
                      pg_catalog.concat_ws('|', sequence_name, persistence, data_type, increment_by, minimum_value,
                        maximum_value, start_value, cache_size, cycles, dependency_type, owning_table, owning_column),
                      E'\\n' ORDER BY sequence_name), ''), 'sha256'), 'hex')
             FROM actual_identity_sequences
             UNION ALL
             SELECT 'table', pg_catalog.count(*)::pg_catalog.int4,
                    pg_catalog.encode(public.digest(COALESCE(pg_catalog.string_agg(
                      pg_catalog.concat_ws('|', table_name, persistence, row_security, force_row_security,
                        is_partition, has_parent, has_child), E'\\n' ORDER BY table_name), ''), 'sha256'), 'hex')
             FROM actual_tables
             UNION ALL
             SELECT 'relation_acl', pg_catalog.count(DISTINCT object_identity)::pg_catalog.int4,
                    pg_catalog.encode(public.digest(COALESCE(pg_catalog.string_agg(
                      pg_catalog.concat_ws('|', object_identity, grantee, grantor, privilege_type, is_grantable),
                      E'\\n' ORDER BY object_identity, grantee, grantor, privilege_type, is_grantable), ''), 'sha256'), 'hex')
             FROM actual_relation_acls
             UNION ALL
             SELECT 'ordinary_column', pg_catalog.count(*)::pg_catalog.int4,
                    pg_catalog.encode(public.digest(COALESCE(pg_catalog.string_agg(
                      pg_catalog.concat_ws('|', table_name, column_name, data_type, not_null, default_expression,
                        identity_kind, collation_name, not_null_constraint_count,
                        not_null_constraints), E'\\n' ORDER BY table_name, column_name), ''), 'sha256'), 'hex')
             FROM actual_ordinary_columns
             UNION ALL
             SELECT 'rewrite_rule', pg_catalog.count(*)::pg_catalog.int4,
                    pg_catalog.encode(public.digest(COALESCE(pg_catalog.string_agg(
                      pg_catalog.concat_ws('|', table_name, object_name, event_type, is_instead,
                        enabled_mode, definition), E'\\n'
                        ORDER BY table_name, object_name, event_type, is_instead,
                          enabled_mode, definition), ''), 'sha256'), 'hex')
             FROM actual_rewrite_rules
           ),
           expected_groups(object_kind, expected_count, definition_sha256) AS (
             SELECT * FROM ROWS FROM (
               pg_catalog.unnest($7::pg_catalog.text[]),
               pg_catalog.unnest($8::pg_catalog.int4[]),
               pg_catalog.unnest($9::pg_catalog.text[])
             )
           )
           SELECT $1::pg_catalog.bool AS baseline_applied,
                  $6::pg_catalog.int4 AS expected_object_count,
                  pg_catalog.sum(actual_groups.existing_count)::pg_catalog.int4 AS existing_object_count,
                  pg_catalog.array_agg(actual_groups.existing_count ORDER BY pg_catalog.array_position(
                    $7::pg_catalog.text[], actual_groups.object_kind)) AS actual_definition_group_counts,
                  pg_catalog.array_agg(actual_groups.definition_sha256 ORDER BY pg_catalog.array_position(
                    $7::pg_catalog.text[], actual_groups.object_kind)) AS actual_definition_group_hashes,
                  (SELECT pg_catalog.count(*)::pg_catalog.int4
                   FROM actual_indexes
                   WHERE actual_indexes.is_valid IS DISTINCT FROM true) AS invalid_index_count,
                  ($6 - pg_catalog.sum(actual_groups.existing_count))::pg_catalog.int4
                    AS missing_object_count,
                  pg_catalog.count(*) FILTER (
                    WHERE actual_groups.existing_count OPERATOR(pg_catalog.<>) expected_groups.expected_count
                       OR actual_groups.definition_sha256 OPERATOR(pg_catalog.<>) expected_groups.definition_sha256
                  )::pg_catalog.int4 AS drifted_definition_group_count
           FROM expected_groups
           JOIN actual_groups USING (object_kind)`,
    values: [
      true,
      snapshot.identitySequenceIdentities,
      snapshot.tableIdentities,
      snapshot.relationAclIdentities,
      snapshot.columnAclIdentities,
      expectations.definitionObjectCount,
      expectations.definitionGroupKinds,
      expectations.definitionGroupCounts,
      expectations.definitionGroupHashes,
      runtimeRole,
      relationSanctions,
      columnSanctions,
    ],
  };
}

async function inspectDefinitions(
  executor: PostgreSqlQueryExecutor,
  runtimeRole: string,
  snapshot: PostgreSqlSchemaSnapshot,
  signal: AbortSignal | undefined,
): Promise<number> {
  const result = await executor.query<DefinitionRow, unknown[]>(
    definitionQuery(snapshot, runtimeRole),
    readinessOptions("inspectSchemaDefinitions", signal),
  );
  const row = result.rows[0];
  const expectations = getPostgreSqlSchemaSnapshotExpectations(snapshot);
  if (
    !row
    || row.baseline_applied !== true
    || row.expected_object_count !== expectations.definitionObjectCount
    || !isSafeCount(row.existing_object_count)
    || row.existing_object_count !== expectations.definitionObjectCount
    || !isSafeCount(row.invalid_index_count)
    || row.invalid_index_count !== 0
    || row.missing_object_count !== 0
    || row.drifted_definition_group_count !== 0
    || !Array.isArray(row.actual_definition_group_counts)
    || !Array.isArray(row.actual_definition_group_hashes)
    || row.actual_definition_group_counts.length !== expectations.definitionGroupCounts.length
    || row.actual_definition_group_hashes.length !== expectations.definitionGroupHashes.length
    || row.actual_definition_group_counts.some((value, index) => value !== expectations.definitionGroupCounts[index])
    || row.actual_definition_group_hashes.some((value, index) => value !== expectations.definitionGroupHashes[index])
  ) {
    throw readinessError("schema-fingerprint", "inspectSchemaDefinitions");
  }
  const identity = await executor.query<IdentityFunctionRow, [readonly string[], readonly string[]]>({
    text: `WITH expected_functions(function_name, prosrc_sha256) AS (
             SELECT * FROM ROWS FROM (
               pg_catalog.unnest($1::pg_catalog.text[]),
               pg_catalog.unnest($2::pg_catalog.text[])
             )
           ),
           actual_functions AS (
             SELECT procedure.proname AS function_name,
                    procedure.oid AS function_oid,
                    procedure.prosrc,
                    procedure.prosecdef,
                    procedure.proleakproof,
                    procedure.provolatile,
                    procedure.proparallel,
                    procedure.proconfig,
                    language.lanname,
                    procedure.prorettype,
                    (
                      SELECT pg_catalog.string_agg(
                        pg_catalog.concat_ws('|',
                          CASE WHEN privilege.grantee OPERATOR(pg_catalog.=) procedure.proowner
                               THEN 'owner' ELSE privilege.grantee::pg_catalog.text END,
                          CASE WHEN privilege.grantor OPERATOR(pg_catalog.=) procedure.proowner
                               THEN 'owner' ELSE privilege.grantor::pg_catalog.text END,
                          privilege.privilege_type,
                          privilege.is_grantable::pg_catalog.text
                        ), E'\\n' ORDER BY privilege.grantee, privilege.grantor,
                          privilege.privilege_type, privilege.is_grantable
                      )
                      FROM pg_catalog.aclexplode(COALESCE(
                        procedure.proacl, pg_catalog.acldefault('f', procedure.proowner)
                      )) AS privilege
                    ) AS normalized_acl
             FROM pg_catalog.pg_proc AS procedure
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) procedure.pronamespace
             JOIN pg_catalog.pg_language AS language
               ON language.oid OPERATOR(pg_catalog.=) procedure.prolang
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND procedure.prokind OPERATOR(pg_catalog.=) 'f'
               AND procedure.pronargs OPERATOR(pg_catalog.=) 0
               AND procedure.proname OPERATOR(pg_catalog.=) ANY ($1::pg_catalog.text[])
           )
           SELECT pg_catalog.count(*)::pg_catalog.int4 AS expected_function_count,
                  pg_catalog.count(actual_functions.function_oid)::pg_catalog.int4
                    AS existing_function_count,
                  pg_catalog.count(*) FILTER (
                    WHERE actual_functions.function_oid IS NULL
                       OR pg_catalog.encode(public.digest(actual_functions.prosrc, 'sha256'), 'hex')
                            OPERATOR(pg_catalog.<>) expected_functions.prosrc_sha256
                       OR actual_functions.lanname OPERATOR(pg_catalog.<>) 'plpgsql'
                       OR actual_functions.prorettype OPERATOR(pg_catalog.<>)
                            pg_catalog.to_regtype('pg_catalog.trigger')
                       OR actual_functions.prosecdef
                       OR actual_functions.proleakproof
                       OR actual_functions.provolatile OPERATOR(pg_catalog.<>) 'v'
                       OR actual_functions.proparallel OPERATOR(pg_catalog.<>) 'u'
                       OR actual_functions.proconfig IS DISTINCT FROM
                            ARRAY['search_path=pg_catalog, public']::pg_catalog.text[]
                       OR actual_functions.normalized_acl IS DISTINCT FROM
                            'owner|owner|EXECUTE|false'
                  )::pg_catalog.int4 AS drifted_function_count
           FROM expected_functions
           LEFT JOIN actual_functions USING (function_name)`,
    values: [
      snapshot.identityFunctions.map(({ name }) => name),
      snapshot.identityFunctions.map(({ sha256 }) => sha256),
    ],
  }, readinessOptions("inspectIdentityFunctions", signal));
  const identityRow = identity.rows[0];
  if (
    !identityRow
    || identityRow.expected_function_count !== snapshot.identityFunctions.length
    || identityRow.existing_function_count !== snapshot.identityFunctions.length
    || identityRow.drifted_function_count !== 0
  ) {
    throw readinessError("schema-fingerprint", "inspectIdentityFunctions");
  }
  return expectations.definitionObjectCount;
}

function allPrivilegeEntries(): readonly PostgreSqlRuntimePrivilegeEntry[] {
  return [
    ...POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required,
    ...POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.optional,
  ];
}

async function inspectEffectivePrivileges(
  executor: PostgreSqlQueryExecutor,
  runtimeRole: string,
  snapshot: PostgreSqlSchemaSnapshot,
  optionalPrivilegesPresent: boolean,
  signal: AbortSignal | undefined,
): Promise<void> {
  const entries = allPrivilegeEntries();
  const required = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required;
  const optional = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.optional;
  const tableObjects = snapshot.relationAclIdentities
    .filter((identity) => identity.startsWith("table|"))
    .map((identity) => `lcm.${identity.slice(identity.indexOf("|") + 1)}`);
  const sequenceObjects = snapshot.identitySequenceIdentities.map((name) => `lcm.${name}`);
  const relationPrivilegeNames = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    "MAINTAIN",
  ];
  const sequencePrivilegeNames = ["USAGE", "SELECT", "UPDATE"];
  const columnEntries = snapshot.columnAclIdentities.map((identity) => {
    const separator = identity.indexOf("|");
    return [
      `lcm.${identity.slice(0, separator)}`,
      identity.slice(separator + 1),
    ] as const;
  });
  const requiredPrivilegeKeys = new Set(required.map(privilegeKey));
  const optionalPrivilegeKeys = new Set(optional.map(privilegeKey));
  const isExpected = (
    kind: PostgreSqlRuntimePrivilegeKind,
    object: string,
    column: string | null,
    privilege: string,
  ): boolean => {
    const key = effectivePrivilegeKey(kind, object, column, privilege);
    return requiredPrivilegeKeys.has(key)
      || (optionalPrivilegesPresent && optionalPrivilegeKeys.has(key));
  };
  const relationPrivileges = tableObjects.flatMap((object) => relationPrivilegeNames.map((privilege) => ({
    object,
    privilege,
    expected: isExpected("relation", object, null, privilege),
  })));
  const sequencePrivileges = sequenceObjects.flatMap((object) => sequencePrivilegeNames.map((privilege) => ({
    object,
    privilege,
    expected: isExpected("sequence", object, null, privilege),
  })));
  const columnPrivileges = columnEntries.flatMap(([object, column]) => (
    ["SELECT", "INSERT", "UPDATE"].map((privilege) => ({
      object,
      column,
      privilege,
      expected: isExpected("relation", object, null, privilege)
        || isExpected("column", object, column, privilege),
    }))
  ));
  const schemaObjects = ["lcm", "public"];
  const schemaPrivileges = schemaObjects.flatMap((object) => ["USAGE", "CREATE"].map((privilege) => ({
    object,
    privilege,
    expected: isExpected("schema", object, null, privilege),
  })));
  const functionEntries = entries.filter(({ kind }) => kind === "function");
  const functionPrivileges = functionEntries.map(({ object, privilege }) => ({
    object,
    lookupObject: object === "lcm.normalize_search_text(input text)"
      ? "lcm.normalize_search_text(text)"
      : object,
    privilege,
    expected: isExpected("function", object, null, privilege),
  }));
  const config: QueryConfig<unknown[]> = {
    text: `WITH schema_privileges(object_identity, privilege_type, expected) AS (
             SELECT * FROM ROWS FROM (
               pg_catalog.unnest($2::pg_catalog.text[]),
               pg_catalog.unnest($3::pg_catalog.text[]),
               pg_catalog.unnest($4::pg_catalog.bool[])
             )
           ),
           relation_privileges(object_identity, privilege_type, expected) AS (
             SELECT * FROM ROWS FROM (
               pg_catalog.unnest($5::pg_catalog.text[]),
               pg_catalog.unnest($6::pg_catalog.text[]),
               pg_catalog.unnest($7::pg_catalog.bool[])
             )
           ),
           sequence_privileges(object_identity, privilege_type, expected) AS (
             SELECT * FROM ROWS FROM (
               pg_catalog.unnest($8::pg_catalog.text[]),
               pg_catalog.unnest($9::pg_catalog.text[]),
               pg_catalog.unnest($10::pg_catalog.bool[])
             )
           ),
           column_privileges(object_identity, column_name, privilege_type, expected) AS (
             SELECT * FROM ROWS FROM (
               pg_catalog.unnest($11::pg_catalog.text[]),
               pg_catalog.unnest($12::pg_catalog.text[]),
               pg_catalog.unnest($13::pg_catalog.text[]),
               pg_catalog.unnest($14::pg_catalog.bool[])
             )
           ),
           function_privileges(object_identity, lookup_identity, expected) AS (
             SELECT * FROM ROWS FROM (
               pg_catalog.unnest($15::pg_catalog.text[]),
               pg_catalog.unnest($16::pg_catalog.text[]),
               pg_catalog.unnest($17::pg_catalog.bool[])
             )
           )
           SELECT 'schema'::pg_catalog.text AS privilege_kind,
                  schema_privileges.object_identity,
                  NULL::pg_catalog.text AS column_name,
                  schema_privileges.privilege_type,
                  schema_privileges.expected,
                  pg_catalog.has_schema_privilege($1, schema_privileges.object_identity,
                    schema_privileges.privilege_type) AS effective
           FROM schema_privileges
           UNION ALL
           SELECT 'relation', relation_privileges.object_identity, NULL,
                  relation_privileges.privilege_type, relation_privileges.expected,
                  pg_catalog.has_table_privilege($1, relation_privileges.object_identity,
                    relation_privileges.privilege_type)
           FROM relation_privileges
           UNION ALL
           SELECT 'sequence', sequence_privileges.object_identity, NULL,
                  sequence_privileges.privilege_type, sequence_privileges.expected,
                  pg_catalog.has_sequence_privilege($1, sequence_privileges.object_identity,
                    sequence_privileges.privilege_type)
           FROM sequence_privileges
           UNION ALL
           SELECT 'column', column_privileges.object_identity, column_privileges.column_name,
                  column_privileges.privilege_type, column_privileges.expected,
                  pg_catalog.has_column_privilege($1, column_privileges.object_identity,
                    column_privileges.column_name, column_privileges.privilege_type)
           FROM column_privileges
           UNION ALL
           SELECT 'function', function_privileges.object_identity, NULL, 'EXECUTE',
                  function_privileges.expected,
                  pg_catalog.has_function_privilege($1, function_privileges.lookup_identity, 'EXECUTE')
           FROM function_privileges
           ORDER BY privilege_kind, object_identity, column_name, privilege_type`,
    values: [
      runtimeRole,
      schemaPrivileges.map(({ object }) => object),
      schemaPrivileges.map(({ privilege }) => privilege),
      schemaPrivileges.map(({ expected }) => expected),
      relationPrivileges.map(({ object }) => object),
      relationPrivileges.map(({ privilege }) => privilege),
      relationPrivileges.map(({ expected }) => expected),
      sequencePrivileges.map(({ object }) => object),
      sequencePrivileges.map(({ privilege }) => privilege),
      sequencePrivileges.map(({ expected }) => expected),
      columnPrivileges.map(({ object }) => object),
      columnPrivileges.map(({ column }) => column),
      columnPrivileges.map(({ privilege }) => privilege),
      columnPrivileges.map(({ expected }) => expected),
      functionPrivileges.map(({ object }) => object),
      functionPrivileges.map(({ lookupObject }) => lookupObject),
      functionPrivileges.map(({ expected }) => expected),
    ],
  };
  const expectedRows = new Map<string, boolean>();
  const registerExpected = (
    kind: PostgreSqlRuntimePrivilegeKind,
    object: string,
    column: string | null,
    privilege: string,
    expected: boolean,
  ): void => {
    const key = effectivePrivilegeKey(kind, object, column, privilege);
    expectedRows.set(key, expected);
  };
  for (const entry of schemaPrivileges) {
    registerExpected("schema", entry.object, null, entry.privilege, entry.expected);
  }
  for (const entry of relationPrivileges) {
    registerExpected("relation", entry.object, null, entry.privilege, entry.expected);
  }
  for (const entry of sequencePrivileges) {
    registerExpected("sequence", entry.object, null, entry.privilege, entry.expected);
  }
  for (const entry of columnPrivileges) {
    registerExpected("column", entry.object, entry.column, entry.privilege, entry.expected);
  }
  for (const entry of functionPrivileges) {
    registerExpected("function", entry.object, null, entry.privilege, entry.expected);
  }
  const result = await executor.query<EffectivePrivilegeRow, unknown[]>(
    config,
    readinessOptions("inspectEffectivePrivileges", signal),
  );
  if (result.rows.length !== expectedRows.size) {
    throw readinessError("effective-privilege", "inspectEffectivePrivileges");
  }
  const observedRows = new Set<string>();
  for (const row of result.rows) {
    if (
      !isPrivilegeKind(row.privilege_kind)
      || typeof row.object_identity !== "string"
      || (row.column_name !== null && typeof row.column_name !== "string")
      || typeof row.privilege_type !== "string"
      || !isBoolean(row.expected)
      || !isBoolean(row.effective)
    ) {
      throw readinessError("effective-privilege", "inspectEffectivePrivileges");
    }
    const key = effectivePrivilegeKey(
      row.privilege_kind,
      row.object_identity,
      row.column_name,
      row.privilege_type,
    );
    if (
      !expectedRows.has(key)
      || observedRows.has(key)
      || row.expected !== expectedRows.get(key)
      || row.effective !== row.expected
    ) {
      throw readinessError("effective-privilege", "inspectEffectivePrivileges");
    }
    observedRows.add(key);
  }
}

export async function verifyPostgreSqlRuntimeSchema(
  executor: PostgreSqlQueryExecutor,
  options: { readonly expectedOwner: string; readonly signal?: AbortSignal },
): Promise<PostgreSqlRuntimeReadiness> {
  assertExpectedOwner(options.expectedOwner);
  const signal = options.signal;
  try {
    const migrations = loadPostgreSqlMigrations();
    const snapshots = loadPostgreSqlSchemaSnapshots();
    validatePostgreSqlMigrations(migrations);
    validatePostgreSqlSchemaSnapshotRegistry(migrations, snapshots);
    await inspectServerReadiness(executor, signal);
    const runtimeRole = await inspectRolePolicy(executor, options.expectedOwner, signal);
    await assertRequiredPostgreSqlExtensionsReady(executor, {
      operation: "runtimeReadinessExtensions",
      signal,
    });
    await inspectRequiredExtensionFunctions(executor, signal);
    await inspectRequiredExtensionOperator(executor, signal);
    await inspectRequiredGinTrgmOperatorClass(executor, signal);
    await inspectRequiredGinTrgmOperators(executor, signal);
    await inspectRequiredGinTrgmSupportFunctions(executor, signal);
    await assertPostgreSqlSearchConfigurationReady(executor, {
      operation: "runtimeReadinessSearchConfiguration",
      signal,
    });
    const currentMigrationIds = await inspectMigrationHistory(executor, migrations, signal);
    const snapshot = selectLatestPostgreSqlSchemaSnapshot(currentMigrationIds, snapshots);
    if (snapshot === null) {
      throw readinessError("migration-ledger", "readMigrations");
    }
    const ownership = await inspectOwnership(executor, options.expectedOwner, snapshot, signal);
    const definitionObjectCount = await inspectDefinitions(executor, runtimeRole, snapshot, signal);
    await inspectSchemaAcl(executor, runtimeRole, signal);
    const relationOptionalPrivileges = await inspectRelationAcl(
      executor,
      runtimeRole,
      snapshot,
      signal,
    );
    const columnOptionalPrivileges = await inspectColumnAcl(
      executor,
      runtimeRole,
      snapshot,
      signal,
    );
    const observed = new Set([
      ...relationOptionalPrivileges,
      ...columnOptionalPrivileges,
    ]);
    const exactOptionalKeys = new Set(
      POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.optional.map(privilegeKey),
    );
    if (
      observed.size !== 0
      && (
        observed.size !== exactOptionalKeys.size
        || [...exactOptionalKeys].some((key) => !observed.has(key))
      )
    ) {
      throw readinessError("acl-shape", "inspectOptionalPrivileges");
    }
    const optionalPrivilegesPresent = observed.size > 0;
    await inspectFunctionAcl(executor, runtimeRole, snapshot, signal);
    await inspectEffectivePrivileges(
      executor,
      runtimeRole,
      snapshot,
      optionalPrivilegesPresent,
      signal,
    );
    return Object.freeze({
      currentMigrationIds: Object.freeze([...currentMigrationIds]),
      expectedOwner: options.expectedOwner,
      runtimeRole,
      managedObjectCount: ownership.managedObjectCount,
      definitionObjectCount,
      privilegeManifestVersion: POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.version,
    });
  } catch (error) {
    if (error instanceof PostgreSqlRuntimeReadinessError) throw error;
    if (error instanceof PostgreSqlExtensionPreflightError) {
      throw readinessError("extension-preflight", "runtimeReadinessExtensions");
    }
    if (error instanceof PostgreSqlSearchConfigurationPreflightError) {
      throw readinessError("search-preflight", "runtimeReadinessSearchConfiguration");
    }
    throw readinessError("server-preflight", "verifyRuntimeReadiness");
  }
}
