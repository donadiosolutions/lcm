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

const REQUIRED_FUNCTION_PRIVILEGES = [
  ["lcm.normalize_search_text(input text)", undefined],
  ["public.digest(text, text)", "pgcrypto"],
  ["public.digest(bytea, text)", "pgcrypto"],
  ["public.similarity(text, text)", "pg_trgm"],
  ["public.similarity_op(text, text)", "pg_trgm"],
] as const;

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
    "Restore the packaged PostgreSQL schema and apply the exact reviewed runtime grants, then rerun readiness.";

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
  readonly timezone: unknown;
  readonly tls: unknown;
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
    || typeof row.timezone !== "string"
    || row.timezone.toUpperCase() !== "UTC"
    || row.tls !== true
  ) {
    throw readinessError("server-preflight", "inspectServerReadiness");
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
                    pg_catalog.pg_get_indexdef(index_relation.oid) AS definition
             FROM pg_catalog.pg_class AS index_relation
             JOIN pg_catalog.pg_index AS index_metadata
               ON index_metadata.indexrelid OPERATOR(pg_catalog.=) index_relation.oid
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) index_relation.relnamespace
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND index_relation.relkind OPERATOR(pg_catalog.=) 'i'
               AND index_metadata.indisvalid
               AND index_metadata.indisready
               AND index_relation.relname OPERATOR(pg_catalog.=) ANY ($2::pg_catalog.text[])
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
               AND relation.relname OPERATOR(pg_catalog.=) ANY ($7::pg_catalog.text[])
           ),
           actual_constraints AS (
             SELECT constraint_metadata.conname AS object_name,
                    relation.relname AS table_name,
                    constraint_metadata.contype::pg_catalog.text AS constraint_type,
                    pg_catalog.pg_get_constraintdef(constraint_metadata.oid, true) AS definition,
                    COALESCE(constraint_trigger_states.enabled_modes, '') AS enabled_modes
             FROM pg_catalog.pg_constraint AS constraint_metadata
             JOIN pg_catalog.pg_class AS relation
               ON relation.oid OPERATOR(pg_catalog.=) constraint_metadata.conrelid
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
             LEFT JOIN (
               SELECT trigger.tgconstraint AS constraint_oid,
                      pg_catalog.string_agg(trigger.tgenabled::pg_catalog.text, '' ORDER BY trigger.tgenabled)
                        AS enabled_modes
               FROM pg_catalog.pg_trigger AS trigger
               WHERE trigger.tgconstraint OPERATOR(pg_catalog.<>) 0
               GROUP BY trigger.tgconstraint
             ) AS constraint_trigger_states
               ON constraint_trigger_states.constraint_oid OPERATOR(pg_catalog.=)
                 constraint_metadata.oid
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND pg_catalog.concat_ws('|', relation.relname, constraint_metadata.conname)
                 OPERATOR(pg_catalog.=) ANY ($3::pg_catalog.text[])
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
                      AS collation_name
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
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND attribute.attgenerated OPERATOR(pg_catalog.<>) ''
               AND pg_catalog.concat_ws('|', relation.relname, attribute.attname)
                 OPERATOR(pg_catalog.=) ANY ($4::pg_catalog.text[])
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
                      AS collation_name
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
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND attribute.attnum OPERATOR(pg_catalog.>) 0
               AND NOT attribute.attisdropped
               AND attribute.attgenerated OPERATOR(pg_catalog.=) ''
               AND pg_catalog.concat_ws('|', relation.relname, attribute.attname)
                 OPERATOR(pg_catalog.=) ANY ($5::pg_catalog.text[])
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
               AND sequence_relation.relname OPERATOR(pg_catalog.=) ANY ($6::pg_catalog.text[])
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
               AND relation.relname OPERATOR(pg_catalog.=) ANY ($7::pg_catalog.text[])
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
             WHERE acl_relations.object_identity OPERATOR(pg_catalog.=) ANY ($8::pg_catalog.text[])
               AND NOT (
                 privilege.grantee OPERATOR(pg_catalog.=)
                   (SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname OPERATOR(pg_catalog.=) $14)
                 AND privilege.grantor OPERATOR(pg_catalog.=) acl_relations.owner_oid
                 AND privilege.is_grantable OPERATOR(pg_catalog.=) false
                 AND pg_catalog.concat(acl_relations.object_identity, '|', privilege.privilege_type)
                   OPERATOR(pg_catalog.=) ANY ($15::pg_catalog.text[])
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
                        OPERATOR(pg_catalog.=) ANY ($16::pg_catalog.text[]),
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
                 OPERATOR(pg_catalog.=) ANY ($9::pg_catalog.text[])
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
                      pg_catalog.concat_ws('|', table_name, object_name, constraint_type, definition, enabled_modes),
                      E'\\n' ORDER BY table_name, object_name, constraint_type, definition, enabled_modes), ''), 'sha256'), 'hex')
             FROM actual_constraints
             UNION ALL
             SELECT 'generated_column', pg_catalog.count(*)::pg_catalog.int4,
                    pg_catalog.encode(public.digest(COALESCE(pg_catalog.string_agg(
                      pg_catalog.concat_ws('|', table_name, column_name, data_type, not_null, generation_kind,
                        generation_expression, collation_name), E'\\n' ORDER BY table_name, column_name), ''), 'sha256'), 'hex')
             FROM actual_generated_columns
             UNION ALL
             SELECT 'column_acl', pg_catalog.count(*)::pg_catalog.int4,
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
                        identity_kind, collation_name), E'\\n' ORDER BY table_name, column_name), ''), 'sha256'), 'hex')
             FROM actual_ordinary_columns
           ),
           expected_groups(object_kind, expected_count, definition_sha256) AS (
             SELECT * FROM ROWS FROM (
               pg_catalog.unnest($11::pg_catalog.text[]),
               pg_catalog.unnest($12::pg_catalog.int4[]),
               pg_catalog.unnest($13::pg_catalog.text[])
             )
           )
           SELECT $1::pg_catalog.bool AS baseline_applied,
                  $10::pg_catalog.int4 AS expected_object_count,
                  pg_catalog.sum(actual_groups.existing_count)::pg_catalog.int4 AS existing_object_count,
                  pg_catalog.array_agg(actual_groups.existing_count ORDER BY pg_catalog.array_position(
                    $11::pg_catalog.text[], actual_groups.object_kind)) AS actual_definition_group_counts,
                  pg_catalog.array_agg(actual_groups.definition_sha256 ORDER BY pg_catalog.array_position(
                    $11::pg_catalog.text[], actual_groups.object_kind)) AS actual_definition_group_hashes,
                  ($10 - pg_catalog.sum(actual_groups.existing_count))::pg_catalog.int4
                    AS missing_object_count,
                  pg_catalog.count(*) FILTER (
                    WHERE actual_groups.existing_count OPERATOR(pg_catalog.<>) expected_groups.expected_count
                       OR actual_groups.definition_sha256 OPERATOR(pg_catalog.<>) expected_groups.definition_sha256
                  )::pg_catalog.int4 AS drifted_definition_group_count
           FROM expected_groups
           JOIN actual_groups USING (object_kind)`,
    values: [
      true,
      snapshot.indexNames,
      snapshot.constraintIdentities,
      snapshot.generatedColumnIdentities,
      snapshot.ordinaryColumnIdentities,
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
