import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlMigration,
  PostgreSqlMigrationResult,
  PostgreSqlQueryExecutor,
} from "./contracts.js";
import {
  assertRequiredPostgreSqlExtensionCatalogReady,
  assertRequiredPostgreSqlExtensionsReady,
} from "./extensions.js";
import { assertPostgreSqlSearchConfigurationReady } from "./search-configuration.js";

const MIGRATION_MANIFEST = [
  {
    id: "0001_migration_ledger",
    filename: "0001_migration_ledger.sql",
    sha256: "e2c0f7e366ba291032f6c62436e8db21b3b5bf3589f7f6c889b18a315eb81e63",
  },
  {
    id: "0002_schema_baseline",
    filename: "0002_schema_baseline.sql",
    sha256: "3f255f3c3a402047313f197c63434742259033cbb0ef590276569eb684d8d260",
  },
  {
    id: "0003_machine_identity_key",
    filename: "0003_machine_identity_key.sql",
    sha256: "bdc38d19bde5825eb1d59e9044769cbf9cac52be5c9fe34237f93ec347c3807b",
  },
  {
    id: "0004_machine_display_name",
    filename: "0004_machine_display_name.sql",
    sha256: "f12b4e5493da187e4c8cd4083766010b896961225cadd6fe568e4e99264e3421",
  },
] as const;

type MigrationRow = QueryResultRow & { id: string; checksum_sha256: string };
type MigrationLedgerRelationRow = QueryResultRow & {
  current_user_name: unknown;
  ledger_exists: unknown;
  owned_by_current_user: unknown;
  relation_kind: unknown;
};
type SessionReplicationRoleRow = QueryResultRow & {
  session_replication_role: unknown;
};
type ServerVersionRow = QueryResultRow & { server_version_num: unknown };
type PostmasterEpochRow = QueryResultRow & { postmaster_started_at: Date | string };
type PostmasterContinuityRow = QueryResultRow & { preflight_still_valid: boolean };
type SchemaOwnershipRow = QueryResultRow & {
  current_user_name: unknown;
  schema_exists: unknown;
  owned_by_current_user: unknown;
};
type SchemaAclRow = QueryResultRow & {
  schema_exists: unknown;
  public_create: unknown;
};
type ServerEncodingRow = QueryResultRow & { server_encoding: unknown };
type ManagedObjectOwnershipRow = QueryResultRow & {
  current_user_name: unknown;
  expected_object_count: unknown;
  existing_object_count: unknown;
  unowned_object_count: unknown;
};
type ExpectedBaselineDefinitionInventory = {
  readonly columnAclIdentities: readonly string[];
  readonly constraintIdentities: readonly string[];
  readonly generatedColumnIdentities: readonly string[];
  readonly identitySequenceIdentities: readonly string[];
  readonly indexNames: readonly string[];
  readonly managedObjectIdentities: readonly string[];
  readonly ordinaryColumnIdentities: readonly string[];
  readonly relationAclIdentities: readonly string[];
  readonly tableIdentities: readonly string[];
  readonly triggerIdentities: readonly string[];
};
export type PostgreSqlSchemaSnapshot = ExpectedBaselineDefinitionInventory & {
  readonly definitionHashes: {
    readonly columnAcl: string;
    readonly constraint: string;
    readonly generatedColumn: string;
    readonly identitySequence: string;
    readonly index: string;
    readonly ordinaryColumn: string;
    readonly relationAcl: string;
    readonly table: string;
    readonly trigger: string;
  };
  readonly identityFunctions: readonly {
    readonly name: string;
    readonly sha256: string;
  }[];
  readonly migrationId: string;
};
type PostgreSqlSchemaSnapshotExpectations = {
  readonly definitionGroupCounts: readonly number[];
  readonly definitionGroupHashes: readonly string[];
  readonly definitionGroupKinds: readonly string[];
  readonly definitionObjectCount: number;
  readonly identityFunctionHashes: readonly string[];
  readonly identityFunctionNames: readonly string[];
};
type BaselineDefinitionInventoryRow = QueryResultRow & {
  actual_definition_group_counts: unknown;
  actual_definition_group_hashes: unknown;
  baseline_applied: unknown;
  expected_object_count: unknown;
  existing_object_count: unknown;
  missing_object_count: unknown;
  drifted_definition_group_count: unknown;
};
export type PostgreSqlDefinitionGroupFingerprint = {
  readonly objectKind: string;
  readonly objectCount: number;
  readonly definitionSha256: string;
};
type IdentityFunctionFingerprintRow = QueryResultRow & {
  baseline_applied: unknown;
  expected_function_count: unknown;
  existing_function_count: unknown;
  drifted_function_count: unknown;
};

export const REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION = 18 as const;
export const REQUIRED_POSTGRESQL_SERVER_ENCODING = "UTF8" as const;

function expectedBaselineDefinitionInventory(): ExpectedBaselineDefinitionInventory {
const EXPECTED_BASELINE_INDEX_NAMES = `
  project_aliases_project_idx conversations_project_order_idx conversations_session_lookup_idx
  messages_project_created_idx messages_search_document_idx messages_content_trgm_idx
  message_parts_type_idx native_transcripts_source_order_idx native_transcripts_session_idx
  native_transcripts_machine_idx native_transcripts_payload_idx transcript_messages_message_idx
  summaries_identity_lookup_idx summaries_conversation_order_idx summaries_project_recent_idx
  summaries_search_document_idx summaries_content_trgm_idx summary_messages_message_idx
  summary_messages_summary_idx summary_parents_parent_idx summary_parents_summary_idx
  context_items_message_idx context_items_summary_idx large_files_identity_lookup_idx
  large_files_conversation_order_idx summary_large_files_file_idx summary_large_files_summary_idx
  promoted_memories_active_order_idx promoted_memories_source_summary_idx
  promoted_memories_source_project_idx promoted_memories_metadata_idx
  promoted_memories_search_document_idx promoted_memories_content_trgm_idx
  promoted_memory_tags_lookup_idx promoted_memory_tags_normalized_lookup_idx
  promoted_memory_tags_search_document_idx promoted_memory_tags_tag_trgm_idx
  recall_surfacing_memory_order_idx recall_surfacing_session_order_idx
  ingest_checkpoints_payload_idx ingest_checkpoints_machine_idx
  session_ingest_log_identity_lookup_idx session_ingest_log_completed_idx
  session_instructions_machine_idx passive_event_inbox_ready_idx passive_event_inbox_retry_idx
  passive_event_inbox_claimed_idx passive_event_inbox_payload_idx passive_event_inbox_project_idx
  fenced_leases_owner_idx fenced_leases_expiry_idx fenced_leases_owner_machine_idx
`.trim().split(/\s+/u);

const EXPECTED_BASELINE_TRIGGER_IDENTITIES = [
  "large_files|large_files_enforce_file_id_uniqueness",
  "session_ingest_log|session_ingest_log_enforce_session_id_uniqueness",
  "summaries|summaries_enforce_summary_id_uniqueness",
] as const;

const EXPECTED_BASELINE_GENERATED_COLUMN_IDENTITIES = [
  "conversations|session_id_sha256",
  "large_files|file_id_sha256",
  "messages|search_document",
  "native_transcripts|native_session_id_sha256",
  "promoted_memories|search_document",
  "promoted_memories|source_summary_id_sha256",
  "promoted_memory_tags|normalized_tag",
  "promoted_memory_tags|normalized_tag_sha256",
  "promoted_memory_tags|search_document",
  "promoted_memory_tags|tag_sha256",
  "recall_surfacing|session_id_sha256",
  "session_ingest_log|session_id_sha256",
  "summaries|search_document",
  "summaries|summary_id_sha256",
  "summary_large_files|file_id_sha256",
] as const;

const EXPECTED_BASELINE_IDENTITY_SEQUENCE_IDENTITIES = [
  "conversations_conversation_id_seq",
  "fenced_leases_fencing_token_seq",
  "messages_message_id_seq",
  "passive_event_inbox_inbox_id_seq",
  "recall_surfacing_surfacing_id_seq",
  "session_instructions_instruction_id_seq",
] as const;

const EXPECTED_BASELINE_TABLE_IDENTITIES = `
  schema_migrations machines projects project_aliases conversations messages message_parts
  native_transcripts transcript_messages summaries summary_messages summary_parents
  context_items large_files summary_large_files promoted_memories promoted_memory_tags
  recall_surfacing redaction_counters ingest_checkpoints session_ingest_log
  session_instructions passive_event_inbox fenced_leases
`.trim().split(/\s+/u);

const EXPECTED_BASELINE_RELATION_ACL_IDENTITIES = [
  ...EXPECTED_BASELINE_TABLE_IDENTITIES.map((name) => `table|${name}`),
  ...EXPECTED_BASELINE_IDENTITY_SEQUENCE_IDENTITIES.map((name) => `sequence|${name}`),
];

const EXPECTED_BASELINE_MANAGED_OBJECT_IDENTITIES = [
  ...EXPECTED_BASELINE_RELATION_ACL_IDENTITIES,
  "dictionary|simple_v1",
  "configuration|search_v1",
  "function|normalize_search_text|input text",
  "function|enforce_summary_id_uniqueness|",
  "function|enforce_large_file_id_uniqueness|",
  "function|enforce_session_ingest_id_uniqueness|",
];

const EXPECTED_BASELINE_ORDINARY_COLUMN_IDENTITIES = `
  schema_migrations|id schema_migrations|checksum_sha256 schema_migrations|applied_at
  machines|machine_id machines|identity_key machines|display_name machines|registered_at
  machines|last_seen_at projects|project_id projects|identity_key projects|display_name
  projects|created_at projects|updated_at project_aliases|project_id project_aliases|machine_id
  project_aliases|path project_aliases|normalized_path project_aliases|linked_at
  conversations|conversation_id conversations|project_id conversations|session_id
  conversations|title conversations|bootstrapped_at conversations|created_at
  conversations|updated_at messages|message_id messages|project_id messages|conversation_id
  messages|seq messages|role messages|content messages|token_count messages|created_at
  message_parts|part_id message_parts|project_id message_parts|conversation_id
  message_parts|message_id message_parts|session_id message_parts|part_type
  message_parts|ordinal message_parts|text_content message_parts|is_ignored
  message_parts|is_synthetic message_parts|tool_call_id message_parts|tool_name
  message_parts|tool_status message_parts|tool_input message_parts|tool_output
  message_parts|tool_error message_parts|tool_title message_parts|patch_hash
  message_parts|patch_files message_parts|file_mime message_parts|file_name
  message_parts|file_url message_parts|subtask_prompt message_parts|subtask_desc
  message_parts|subtask_agent message_parts|step_reason message_parts|step_cost
  message_parts|step_tokens_in message_parts|step_tokens_out message_parts|snapshot_hash
  message_parts|compaction_auto message_parts|metadata native_transcripts|transcript_id
  native_transcripts|project_id native_transcripts|machine_id native_transcripts|client_name
  native_transcripts|format_name native_transcripts|format_version
  native_transcripts|native_session_id native_transcripts|source_locator
  native_transcripts|source_ordinal native_transcripts|observed_at
  native_transcripts|ingested_at native_transcripts|scrubber_version
  native_transcripts|content_sha256 native_transcripts|ingest_key
  native_transcripts|native_payload transcript_messages|project_id
  transcript_messages|transcript_id transcript_messages|conversation_id
  transcript_messages|message_id transcript_messages|source_ordinal summaries|summary_key
  summaries|summary_id summaries|project_id summaries|conversation_id summaries|kind
  summaries|depth summaries|content summaries|token_count summaries|earliest_at
  summaries|latest_at summaries|descendant_count summaries|descendant_token_count
  summaries|source_message_token_count summaries|created_at summary_messages|project_id
  summary_messages|conversation_id summary_messages|summary_key summary_messages|message_id
  summary_messages|ordinal summary_parents|project_id summary_parents|conversation_id
  summary_parents|summary_key summary_parents|parent_summary_key summary_parents|ordinal
  context_items|project_id context_items|conversation_id context_items|ordinal
  context_items|item_type context_items|message_id context_items|summary_key
  context_items|created_at large_files|file_key large_files|file_id large_files|project_id
  large_files|conversation_id large_files|file_name large_files|mime_type
  large_files|byte_size large_files|storage_uri large_files|exploration_summary
  large_files|created_at summary_large_files|project_id summary_large_files|conversation_id
  summary_large_files|summary_key summary_large_files|file_id summary_large_files|ordinal
  promoted_memories|memory_id promoted_memories|project_id promoted_memories|content
  promoted_memories|source_summary_id promoted_memories|source_project_id
  promoted_memories|session_id promoted_memories|depth promoted_memories|confidence
  promoted_memories|metadata promoted_memories|created_at promoted_memories|archived_at
  promoted_memory_tags|project_id promoted_memory_tags|memory_id
  promoted_memory_tags|ordinal promoted_memory_tags|tag recall_surfacing|surfacing_id
  recall_surfacing|project_id recall_surfacing|memory_id recall_surfacing|session_id
  recall_surfacing|surfaced_at
  redaction_counters|project_id redaction_counters|category redaction_counters|count
  redaction_counters|updated_at ingest_checkpoints|project_id ingest_checkpoints|machine_id
  ingest_checkpoints|client_name ingest_checkpoints|source_locator
  ingest_checkpoints|last_source_ordinal ingest_checkpoints|imported_count
  ingest_checkpoints|skipped_count ingest_checkpoints|quarantined_count
  ingest_checkpoints|revision ingest_checkpoints|checkpoint ingest_checkpoints|updated_at
  session_ingest_log|ingest_key
  session_ingest_log|project_id session_ingest_log|session_id
  session_ingest_log|message_count session_ingest_log|completed_at
  session_instructions|instruction_id session_instructions|project_id
  session_instructions|machine_id session_instructions|scope_hash
  session_instructions|client_name session_instructions|session_id
  session_instructions|worktree_path session_instructions|cwd_path
  session_instructions|content
  session_instructions|content_hash session_instructions|updated_at
  passive_event_inbox|inbox_id passive_event_inbox|project_id
  passive_event_inbox|machine_id passive_event_inbox|event_id
  passive_event_inbox|event_version passive_event_inbox|machine_sequence
  passive_event_inbox|event_type passive_event_inbox|payload passive_event_inbox|status
  passive_event_inbox|attempt_count passive_event_inbox|received_at
  passive_event_inbox|next_attempt_at passive_event_inbox|claimed_at
  passive_event_inbox|claimed_by passive_event_inbox|applied_at
  passive_event_inbox|quarantined_at passive_event_inbox|quarantine_reason
  fenced_leases|project_id fenced_leases|resource_type fenced_leases|resource_key
  fenced_leases|owner_machine_id fenced_leases|owner_process_id fenced_leases|operation
  fenced_leases|fencing_token fenced_leases|acquired_at fenced_leases|renewed_at
  fenced_leases|expires_at fenced_leases|released_at
`.trim().split(/\s+/u);

const EXPECTED_BASELINE_CONSTRAINT_NAMES = `
  context_items_item_type_check context_items_check context_items_ordinal_check
  context_items_project_id_conversation_id_message_id_fkey
  context_items_project_id_conversation_id_fkey
  context_items_project_id_conversation_id_summary_key_fkey context_items_pkey
  conversations_check1 conversations_check conversations_project_id_fkey conversations_pkey
  conversations_project_id_conversation_id_key fenced_leases_operation_check
  fenced_leases_owner_process_id_check fenced_leases_resource_key_check
  fenced_leases_resource_type_check fenced_leases_check1 fenced_leases_fencing_token_check
  fenced_leases_check2 fenced_leases_check fenced_leases_owner_machine_id_fkey
  fenced_leases_project_id_fkey fenced_leases_pkey ingest_checkpoints_client_name_check
  ingest_checkpoints_imported_count_check ingest_checkpoints_checkpoint_check
  ingest_checkpoints_last_source_ordinal_check ingest_checkpoints_quarantined_count_check
  ingest_checkpoints_revision_check
  ingest_checkpoints_skipped_count_check ingest_checkpoints_source_locator_check
  ingest_checkpoints_machine_id_fkey ingest_checkpoints_project_id_fkey ingest_checkpoints_pkey
  large_files_storage_uri_check large_files_byte_size_check large_files_file_key_check
  large_files_project_id_conversation_id_fkey large_files_pkey
  large_files_project_id_conversation_id_file_key_key machines_identity_key_check
  machines_display_name_check machines_check machines_machine_id_check machines_pkey
  machines_identity_key_key message_parts_ordinal_check message_parts_part_type_check
  message_parts_step_cost_check message_parts_step_tokens_in_check
  message_parts_step_tokens_out_check message_parts_project_id_conversation_id_message_id_fkey
  message_parts_pkey message_parts_project_id_conversation_id_message_id_ordinal_key
  messages_role_check messages_seq_check messages_token_count_check
  messages_project_id_conversation_id_fkey messages_pkey
  messages_project_id_conversation_id_message_id_key
  messages_project_id_conversation_id_seq_key native_transcripts_client_name_check
  native_transcripts_format_name_check native_transcripts_format_version_check
  native_transcripts_native_session_id_check native_transcripts_scrubber_version_check
  native_transcripts_content_sha256_check native_transcripts_check
  native_transcripts_ingest_key_check native_transcripts_native_payload_check
  native_transcripts_source_locator_check native_transcripts_source_ordinal_check
  native_transcripts_transcript_id_check native_transcripts_machine_id_fkey
  native_transcripts_project_id_fkey native_transcripts_pkey
  native_transcripts_project_id_machine_id_ingest_key_key
  native_transcripts_project_id_transcript_id_key passive_event_inbox_check7
  passive_event_inbox_attempt_count_check passive_event_inbox_event_type_check
  passive_event_inbox_check1 passive_event_inbox_check6 passive_event_inbox_claimed_by_check
  passive_event_inbox_event_version_check passive_event_inbox_payload_check
  passive_event_inbox_machine_sequence_check passive_event_inbox_check
  passive_event_inbox_check8 passive_event_inbox_check5
  passive_event_inbox_quarantine_reason_check passive_event_inbox_status_check
  passive_event_inbox_check3 passive_event_inbox_check2 passive_event_inbox_check4
  passive_event_inbox_machine_id_fkey passive_event_inbox_project_id_fkey
  passive_event_inbox_pkey passive_event_inbox_machine_id_event_id_key
  passive_event_inbox_machine_id_machine_sequence_key project_aliases_normalized_path_check
  project_aliases_path_check project_aliases_machine_id_fkey project_aliases_project_id_fkey
  project_aliases_pkey project_aliases_machine_id_path_key projects_display_name_check
  projects_identity_key_check projects_check
  projects_project_id_check projects_pkey projects_identity_key_key promoted_memories_check
  promoted_memories_confidence_check promoted_memories_content_check
  promoted_memories_depth_check promoted_memories_metadata_check
  promoted_memories_project_id_fkey promoted_memories_pkey
  promoted_memories_project_id_memory_id_key promoted_memory_tags_ordinal_check
  promoted_memory_tags_project_id_memory_id_fkey promoted_memory_tags_pkey
  recall_surfacing_project_id_fkey recall_surfacing_pkey redaction_counters_category_check
  redaction_counters_count_check redaction_counters_project_id_fkey redaction_counters_pkey
  schema_migrations_checksum_sha256_check schema_migrations_pkey
  session_ingest_log_message_count_check session_ingest_log_ingest_key_check
  session_ingest_log_project_id_fkey session_ingest_log_pkey
  session_instructions_scope_hash_check session_instructions_client_name_check
  session_instructions_session_id_check session_instructions_worktree_path_check
  session_instructions_cwd_path_check session_instructions_machine_id_fkey
  session_instructions_project_id_fkey session_instructions_pkey
  session_instructions_project_id_machine_id_scope_hash_key summaries_depth_check
  summaries_descendant_count_check summaries_descendant_token_count_check summaries_check
  summaries_kind_check summaries_source_message_token_count_check summaries_token_count_check
  summaries_summary_key_check summaries_project_id_conversation_id_fkey summaries_pkey
  summaries_project_id_conversation_id_summary_key_key summary_large_files_ordinal_check
  summary_large_files_project_id_conversation_id_summary_key_fkey summary_large_files_pkey
  summary_messages_ordinal_check summary_messages_project_id_conversation_id_message_id_fkey
  summary_messages_project_id_conversation_id_summary_key_fkey summary_messages_pkey
  summary_messages_project_id_summary_key_ordinal_key summary_parents_ordinal_check
  summary_parents_check summary_parents_project_id_conversation_id_parent_summary__fkey
  summary_parents_project_id_conversation_id_summary_key_fkey summary_parents_pkey
  summary_parents_project_id_summary_key_ordinal_key transcript_messages_source_ordinal_check
  transcript_messages_project_id_conversation_id_message_id_fkey
  transcript_messages_project_id_transcript_id_fkey transcript_messages_pkey
  transcript_messages_project_id_transcript_id_source_ordinal_key
`.trim().split(/\s+/u);

const EXPECTED_BASELINE_CONSTRAINT_TABLES = [
  "context_items",
  "conversations",
  "fenced_leases",
  "ingest_checkpoints",
  "large_files",
  "machines",
  "message_parts",
  "messages",
  "native_transcripts",
  "passive_event_inbox",
  "project_aliases",
  "projects",
  "promoted_memories",
  "promoted_memory_tags",
  "recall_surfacing",
  "redaction_counters",
  "schema_migrations",
  "session_ingest_log",
  "session_instructions",
  "summaries",
  "summary_large_files",
  "summary_messages",
  "summary_parents",
  "transcript_messages",
] as const;

const EXPECTED_BASELINE_CONSTRAINT_IDENTITIES =
  EXPECTED_BASELINE_CONSTRAINT_NAMES.map((constraintName) => {
    const tableName = EXPECTED_BASELINE_CONSTRAINT_TABLES.find(
      (candidate) => constraintName.startsWith(`${candidate}_`),
    )!;
    return `${tableName}|${constraintName}`;
  });

  return {
    columnAclIdentities: [
      ...EXPECTED_BASELINE_ORDINARY_COLUMN_IDENTITIES,
      ...EXPECTED_BASELINE_GENERATED_COLUMN_IDENTITIES,
    ],
    constraintIdentities: EXPECTED_BASELINE_CONSTRAINT_IDENTITIES,
    generatedColumnIdentities: EXPECTED_BASELINE_GENERATED_COLUMN_IDENTITIES,
    identitySequenceIdentities: EXPECTED_BASELINE_IDENTITY_SEQUENCE_IDENTITIES,
    indexNames: EXPECTED_BASELINE_INDEX_NAMES,
    managedObjectIdentities: EXPECTED_BASELINE_MANAGED_OBJECT_IDENTITIES,
    ordinaryColumnIdentities: EXPECTED_BASELINE_ORDINARY_COLUMN_IDENTITIES,
    relationAclIdentities: EXPECTED_BASELINE_RELATION_ACL_IDENTITIES,
    tableIdentities: EXPECTED_BASELINE_TABLE_IDENTITIES,
    triggerIdentities: EXPECTED_BASELINE_TRIGGER_IDENTITIES,
  } as const;
}

export function loadPostgreSqlSchemaSnapshots(): readonly PostgreSqlSchemaSnapshot[] {
  const baseline: PostgreSqlSchemaSnapshot = {
    ...expectedBaselineDefinitionInventory(),
    definitionHashes: {
      columnAcl: "e2581c7c70cbec57d64bb02ac1520fe27336efb326618b36add668cb1431e98c",
      constraint: "8bb79c117c498a89c920826ff65b88ad615f871ba3e8607e4b00d1d115d9aa1a",
      generatedColumn: "78a5508248b93c86a59ea633136154ae4ab7cf3569e020053a1dc0d1c2fc0590",
      identitySequence: "907a4bbb955d22d4ed88199acd38dc27e5095a0b943d51480f82a50464367702",
      index: "6d95eda805e9cd5d0b246daaa763a6919262f64e1129dc93f0ee95291276a7fd",
      ordinaryColumn: "e0daf9a1d97b62f6baf491c35d3b45d5082336538e44da8651afaa1180e11e8a",
      relationAcl: "f9ace407bb5e2cae0310c03df6e156644ea9716fc45d3d55ce2b0c2d7a77d31b",
      table: "5ccf4137ba8c1dbe8462176414b89f30616b26622d9680d77c5e2ae271d2f64d",
      trigger: "229e8dd0e6a1c953dd18b4220da95be28121db72f4fbba199e1d6808c4b7afcc",
    },
    identityFunctions: [
      {
        name: "enforce_summary_id_uniqueness",
        sha256: "2e4d8b18c207e251edfbc81dac50cd0e0dba45dc0768ef50eeded33f5571d975",
      },
      {
        name: "enforce_large_file_id_uniqueness",
        sha256: "89d25e96d0ccc63954135183605c7aadbcb4c726143c8c56c67b9cd49398957b",
      },
      {
        name: "enforce_session_ingest_id_uniqueness",
        sha256: "9904bce7ff1f89e2317d1b4d156f43b9033574d230b99e4368b7fe59b20172d0",
      },
    ],
    migrationId: "0002_schema_baseline",
  };
  return [
    baseline,
    {
      ...baseline,
      definitionHashes: {
        ...baseline.definitionHashes,
        constraint: "4698227bc02a8d777955eb41286a4964dda8da82d1561c9a154b67e2a034906f",
      },
      migrationId: "0003_machine_identity_key",
    },
    {
      ...baseline,
      definitionHashes: {
        ...baseline.definitionHashes,
        constraint: "1cf8dc0e9303c7bdd086bcae679edc31493d26f67c81999c8e5b2fba491e0778",
      },
      migrationId: "0004_machine_display_name",
    },
  ];
}

export function selectLatestPostgreSqlSchemaSnapshot(
  migrationIds: readonly string[],
  snapshots: readonly PostgreSqlSchemaSnapshot[],
): PostgreSqlSchemaSnapshot | null {
  const snapshotsByMigrationId = new Map(
    snapshots.map((snapshot) => [snapshot.migrationId, snapshot]),
  );
  for (let index = migrationIds.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshotsByMigrationId.get(migrationIds[index]!);
    if (snapshot) return snapshot;
  }
  return null;
}

export function getPostgreSqlSchemaSnapshotExpectations(
  snapshot: PostgreSqlSchemaSnapshot,
): PostgreSqlSchemaSnapshotExpectations {
  const definitionGroups = [
    ["index", snapshot.indexNames.length, snapshot.definitionHashes.index],
    ["trigger", snapshot.triggerIdentities.length, snapshot.definitionHashes.trigger],
    ["constraint", snapshot.constraintIdentities.length, snapshot.definitionHashes.constraint],
    [
      "generated_column",
      snapshot.generatedColumnIdentities.length,
      snapshot.definitionHashes.generatedColumn,
    ],
    [
      "column_acl",
      snapshot.columnAclIdentities.length,
      snapshot.definitionHashes.columnAcl,
    ],
    [
      "identity_sequence",
      snapshot.identitySequenceIdentities.length,
      snapshot.definitionHashes.identitySequence,
    ],
    ["table", snapshot.tableIdentities.length, snapshot.definitionHashes.table],
    [
      "relation_acl",
      snapshot.relationAclIdentities.length,
      snapshot.definitionHashes.relationAcl,
    ],
    [
      "ordinary_column",
      snapshot.ordinaryColumnIdentities.length,
      snapshot.definitionHashes.ordinaryColumn,
    ],
  ] as const;
  return {
    definitionGroupCounts: definitionGroups.map(([, count]) => count),
    definitionGroupHashes: definitionGroups.map(([, , hash]) => hash),
    definitionGroupKinds: definitionGroups.map(([kind]) => kind),
    definitionObjectCount: definitionGroups.reduce((total, [, count]) => total + count, 0),
    identityFunctionHashes: snapshot.identityFunctions.map(({ sha256 }) => sha256),
    identityFunctionNames: snapshot.identityFunctions.map(({ name }) => name),
  };
}

export class PostgreSqlServerVersionPreflightError extends StorageOperationError {
  constructor(
    readonly serverVersionNumber: number | null,
    readonly serverMajorVersion: number | null,
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "preflightServerVersion",
    );
  }

  readonly requiredServerMajorVersion = REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION;

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      serverVersionNumber: this.serverVersionNumber,
      serverMajorVersion: this.serverMajorVersion,
      requiredServerMajorVersion: this.requiredServerMajorVersion,
    };
  }
}

export class PostgreSqlServerEncodingPreflightError extends StorageOperationError {
  constructor(
    readonly serverEncoding: string | null,
    operation = "preflightServerEncoding",
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      operation,
    );
  }

  readonly requiredServerEncoding = REQUIRED_POSTGRESQL_SERVER_ENCODING;
  readonly remediation =
    "Create or restore the LCM database with server_encoding UTF8, then rerun readiness.";

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      serverEncoding: this.serverEncoding,
      requiredServerEncoding: this.requiredServerEncoding,
      remediation: this.remediation,
    };
  }
}

export class PostgreSqlSchemaOwnershipPreflightError extends StorageOperationError {
  constructor(
    readonly schemaExists: boolean | null,
    readonly ownedByMigrator: boolean | null,
    readonly requiredOwner: string | null,
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "preflightSchemaOwnership",
    );
    this.remediation = requiredOwner === null
      ? null
      : `Transfer ownership of schema "lcm" and its LCM-owned objects to PostgreSQL role ${quoteIdentifier(requiredOwner)}, then rerun migrations.`;
  }

  readonly schemaName = "lcm";
  readonly remediation: string | null;

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      schemaName: this.schemaName,
      schemaExists: this.schemaExists,
      ownedByMigrator: this.ownedByMigrator,
      requiredOwner: this.requiredOwner,
      remediation: this.remediation,
    };
  }
}

export class PostgreSqlManagedObjectOwnershipPreflightError extends StorageOperationError {
  constructor(
    readonly baselineApplied: boolean | null,
    readonly expectedObjectCount: number | null,
    readonly existingObjectCount: number | null,
    readonly missingObjectCount: number | null,
    readonly unownedObjectCount: number | null,
    readonly requiredOwner: string | null,
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "preflightManagedObjectOwnership",
    );
    this.remediation = missingObjectCount !== null && missingObjectCount > 0
      ? "Restore every missing LCM-managed object from the matching packaged migration artifact or a verified backup, then rerun migrations."
      : requiredOwner === null
        ? null
        : `Transfer ownership of every LCM-managed object in schema "lcm" to PostgreSQL role ${quoteIdentifier(requiredOwner)}, then rerun migrations.`;
  }

  readonly schemaName = "lcm";
  readonly remediation: string | null;

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      schemaName: this.schemaName,
      baselineApplied: this.baselineApplied,
      expectedObjectCount: this.expectedObjectCount,
      existingObjectCount: this.existingObjectCount,
      missingObjectCount: this.missingObjectCount,
      unownedObjectCount: this.unownedObjectCount,
      requiredOwner: this.requiredOwner,
      remediation: this.remediation,
    };
  }
}

export class PostgreSqlMigrationLedgerRelationPreflightError extends StorageOperationError {
  constructor(
    readonly ledgerExists: boolean | null,
    readonly relationKind: string | null,
    readonly ownedByMigrator: boolean | null,
    readonly requiredOwner: string | null,
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "preflightMigrationLedgerRelation",
    );
  }

  readonly schemaName = "lcm";
  readonly relationName = "schema_migrations";
  readonly requiredRelationKind = "r";
  readonly remediation =
    "Restore lcm.schema_migrations as an ordinary table owned by the migration role, then rerun migrations.";

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      schemaName: this.schemaName,
      relationName: this.relationName,
      ledgerExists: this.ledgerExists,
      relationKind: this.relationKind,
      requiredRelationKind: this.requiredRelationKind,
      ownedByMigrator: this.ownedByMigrator,
      requiredOwner: this.requiredOwner,
      remediation: this.remediation,
    };
  }
}

export class PostgreSqlIdentityFunctionPreflightError extends StorageOperationError {
  constructor(
    readonly baselineApplied: boolean | null,
    readonly expectedFunctionCount: number | null,
    readonly existingFunctionCount: number | null,
    readonly driftedFunctionCount: number | null,
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "preflightIdentityFunctionDefinitions",
    );
  }

  readonly schemaName = "lcm";
  readonly remediation =
    "Restore the packaged LCM identity-enforcement functions and their security configuration, then rerun migrations.";

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      schemaName: this.schemaName,
      baselineApplied: this.baselineApplied,
      expectedFunctionCount: this.expectedFunctionCount,
      existingFunctionCount: this.existingFunctionCount,
      driftedFunctionCount: this.driftedFunctionCount,
      remediation: this.remediation,
    };
  }
}

export class PostgreSqlBaselineDefinitionPreflightError extends StorageOperationError {
  constructor(
    readonly baselineApplied: boolean | null,
    readonly expectedObjectCount: number | null,
    readonly existingObjectCount: number | null,
    readonly missingObjectCount: number | null,
    readonly driftedDefinitionGroupCount: number | null,
    readonly actualDefinitionGroups:
      readonly PostgreSqlDefinitionGroupFingerprint[] | null,
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "preflightBaselineDefinitions",
    );
  }

  readonly schemaName = "lcm";
  readonly remediation =
    "Restore every missing or changed LCM baseline table, relation ACL, column ACL, index, trigger, constraint, identity sequence, ordinary column, and generated column from the matching packaged migration artifact or a verified backup, then rerun migrations.";

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      schemaName: this.schemaName,
      baselineApplied: this.baselineApplied,
      expectedObjectCount: this.expectedObjectCount,
      existingObjectCount: this.existingObjectCount,
      missingObjectCount: this.missingObjectCount,
      driftedDefinitionGroupCount: this.driftedDefinitionGroupCount,
      remediation: this.remediation,
    };
  }
}

export class PostgreSqlSessionReplicationRolePreflightError extends StorageOperationError {
  constructor(readonly sessionReplicationRole: "local" | "origin" | "replica" | null) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "preflightSessionReplicationRole",
    );
  }

  readonly requiredSessionReplicationRole = "origin";
  readonly remediation =
    "Set session_replication_role to origin on the migration connection, or reconnect with its default session state, then rerun migrations.";

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      sessionReplicationRole: this.sessionReplicationRole,
      requiredSessionReplicationRole: this.requiredSessionReplicationRole,
      remediation: this.remediation,
    };
  }
}

export class PostgreSqlSchemaAclPreflightError extends StorageOperationError {
  constructor(
    readonly schemaExists: boolean | null,
    readonly publicCreate: boolean | null,
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "preflightSchemaAcl",
    );
  }

  readonly schemaName = "lcm";
  readonly remediation = "REVOKE CREATE ON SCHEMA \"lcm\" FROM PUBLIC;";

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      schemaName: this.schemaName,
      schemaExists: this.schemaExists,
      publicCreate: this.publicCreate,
      remediation: this.remediation,
    };
  }
}

export class PostgreSqlSchemaSnapshotRegistryError extends StorageOperationError {
  constructor(
    readonly reason:
      | "duplicate_identity_function"
      | "duplicate_migration_id"
      | "identity_function_mismatch"
      | "unknown_migration_id",
    readonly migrationId: string,
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "validateSchemaSnapshotRegistry",
    );
    this.message = {
      duplicate_identity_function:
        `PostgreSQL schema snapshot ${migrationId} contains duplicate identity function names`,
      duplicate_migration_id:
        `PostgreSQL schema snapshot registry contains duplicate migrationId ${migrationId}`,
      identity_function_mismatch:
        `PostgreSQL schema snapshot ${migrationId} identity functions do not match managed zero-argument functions`,
      unknown_migration_id:
        `PostgreSQL schema snapshot registry references unknown migrationId ${migrationId}`,
    }[reason];
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), reason: this.reason, migrationId: this.migrationId };
  }
}

function sanitizeServerVersionNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function sanitizeBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function sanitizeSessionReplicationRole(
  value: unknown,
): "local" | "origin" | "replica" | null {
  return value === "local" || value === "origin" || value === "replica"
    ? value
    : null;
}

function sanitizeNonnegativeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function sanitizeDefinitionGroupFingerprints(
  objectKinds: readonly string[],
  objectCounts: unknown,
  definitionHashes: unknown,
): readonly PostgreSqlDefinitionGroupFingerprint[] | null {
  if (
    !Array.isArray(objectCounts)
    || !Array.isArray(definitionHashes)
    || objectCounts.length !== objectKinds.length
    || definitionHashes.length !== objectKinds.length
  ) return null;
  const fingerprints: PostgreSqlDefinitionGroupFingerprint[] = [];
  for (let index = 0; index < objectKinds.length; index += 1) {
    const objectCount = sanitizeNonnegativeCount(objectCounts[index]);
    const definitionSha256 = definitionHashes[index];
    if (
      objectCount === null
      || typeof definitionSha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(definitionSha256)
    ) return null;
    fingerprints.push({
      objectKind: objectKinds[index]!,
      objectCount,
      definitionSha256,
    });
  }
  return fingerprints;
}

export function sanitizePostgreSqlServerEncoding(value: unknown): string | null {
  return typeof value === "string"
    && /^[A-Z0-9_-]{1,32}$/u.test(value)
    ? value
    : null;
}

function sanitizeRoleName(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function migrationError(operation: string): StorageOperationError {
  return new StorageOperationError(
    "STORAGE_INITIALIZATION_FAILED",
    "postgresql",
    undefined,
    "factory",
    operation,
  );
}

export function loadPostgreSqlMigrations(
  readMigration: typeof readFileSync = readFileSync,
): PostgreSqlMigration[] {
  return MIGRATION_MANIFEST.map((entry) => {
    let sql: string;
    try {
      sql = readMigration(new URL(`./migrations/${entry.filename}`, import.meta.url), "utf8");
    } catch {
      throw migrationError("loadMigrations");
    }
    const sha256 = createHash("sha256").update(sql).digest("hex");
    if (sha256 !== entry.sha256) throw migrationError("verifyMigrationArtifact");
    return { ...entry, sql };
  });
}

function validateMigrations(migrations: readonly PostgreSqlMigration[]): void {
  let previous = "";
  const ids = new Set<string>();
  for (const migration of migrations) {
    const actual = createHash("sha256").update(migration.sql).digest("hex");
    if (
      !/^[0-9]{4}_[a-z0-9_]+$/u.test(migration.id)
      || ids.has(migration.id)
      || migration.id <= previous
      || migration.sha256 !== actual
    ) {
      throw migrationError("validateMigrations");
    }
    ids.add(migration.id);
    previous = migration.id;
  }
}

function validateSchemaSnapshotRegistry(
  migrations: readonly PostgreSqlMigration[],
  snapshots: readonly PostgreSqlSchemaSnapshot[],
): void {
  const migrationIds = new Set(migrations.map(({ id }) => id));
  const snapshotIds = new Set<string>();
  for (const snapshot of snapshots) {
    if (snapshotIds.has(snapshot.migrationId)) {
      throw new PostgreSqlSchemaSnapshotRegistryError(
        "duplicate_migration_id",
        snapshot.migrationId,
      );
    }
    if (!migrationIds.has(snapshot.migrationId)) {
      throw new PostgreSqlSchemaSnapshotRegistryError(
        "unknown_migration_id",
        snapshot.migrationId,
      );
    }
    const identityFunctionNames = snapshot.identityFunctions.map(({ name }) => name);
    if (new Set(identityFunctionNames).size !== identityFunctionNames.length) {
      throw new PostgreSqlSchemaSnapshotRegistryError(
        "duplicate_identity_function",
        snapshot.migrationId,
      );
    }
    const managedZeroArgumentFunctions = snapshot.managedObjectIdentities
      .filter((identity) => identity.startsWith("function|"))
      .map((identity) => identity.split("|"))
      .filter(([, , argumentsIdentity]) => argumentsIdentity === "")
      .map(([, name]) => name!)
      .sort();
    if (
      identityFunctionNames.length !== managedZeroArgumentFunctions.length
      || [...identityFunctionNames].sort().some(
        (name, index) => name !== managedZeroArgumentFunctions[index],
      )
    ) {
      throw new PostgreSqlSchemaSnapshotRegistryError(
        "identity_function_mismatch",
        snapshot.migrationId,
      );
    }
    snapshotIds.add(snapshot.migrationId);
  }
}

export async function runPostgreSqlMigrations(
  executor: PostgreSqlQueryExecutor & {
    transaction<T>(
      callback: (transaction: PostgreSqlQueryExecutor) => Promise<T>,
      options: { domain: "factory"; operation: string; signal?: AbortSignal },
    ): Promise<T>;
  },
  options: {
    migrations?: readonly PostgreSqlMigration[];
    schemaSnapshots?: readonly PostgreSqlSchemaSnapshot[];
    signal?: AbortSignal;
  } = {},
): Promise<PostgreSqlMigrationResult> {
  const migrations = [...(options.migrations ?? loadPostgreSqlMigrations())];
  const schemaSnapshots = [...(options.schemaSnapshots ?? loadPostgreSqlSchemaSnapshots())];
  validateMigrations(migrations);
  validateSchemaSnapshotRegistry(migrations, schemaSnapshots);
  // The functional pg_stat_statements probe can raise SQLSTATE 55000 when the
  // library was not preloaded. Run it before opening the all-or-nothing DDL
  // transaction so that expected readiness failure cannot poison that scope.
  const postmasterEpoch = await executor.query<PostmasterEpochRow>({
    text: "SELECT pg_catalog.pg_postmaster_start_time()::text AS postmaster_started_at",
  }, { domain: "factory", operation: "capturePostmasterEpoch", signal: options.signal });
  const postmasterStartedAt = postmasterEpoch.rows[0]?.postmaster_started_at;
  if (!(postmasterStartedAt instanceof Date) && typeof postmasterStartedAt !== "string") {
    throw migrationError("capturePostmasterEpoch");
  }
  const serverEncodingResult = await executor.query<ServerEncodingRow>({
    text: "SELECT pg_catalog.current_setting('server_encoding') AS server_encoding",
  }, { domain: "factory", operation: "preflightServerEncoding", signal: options.signal });
  const serverEncoding = sanitizePostgreSqlServerEncoding(
    serverEncodingResult.rows[0]?.server_encoding,
  );
  if (serverEncoding !== REQUIRED_POSTGRESQL_SERVER_ENCODING) {
    throw new PostgreSqlServerEncodingPreflightError(serverEncoding);
  }
  await assertRequiredPostgreSqlExtensionsReady(executor, { signal: options.signal });
  return executor.transaction(async (transaction) => {
    await transaction.query({
      text: "SET LOCAL search_path = pg_catalog, public",
    }, { domain: "factory", operation: "pinMigrationSearchPath", signal: options.signal });
    await transaction.query({
      text: "SET LOCAL quote_all_identifiers = off",
    }, { domain: "factory", operation: "pinMigrationDeparserSettings", signal: options.signal });

    const replicationRole = await transaction.query<SessionReplicationRoleRow>({
      text: `SELECT pg_catalog.current_setting(
               'session_replication_role'
             ) AS session_replication_role`,
    }, {
      domain: "factory",
      operation: "preflightSessionReplicationRole",
      signal: options.signal,
    });
    const sessionReplicationRole = sanitizeSessionReplicationRole(
      replicationRole.rows[0]?.session_replication_role,
    );
    if (sessionReplicationRole !== "origin") {
      throw new PostgreSqlSessionReplicationRolePreflightError(
        sessionReplicationRole,
      );
    }

    await transaction.query({
      text: `SELECT pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          pg_catalog.current_database() OPERATOR(pg_catalog.||) ':lcm:migrations',
          0
        )
      )`,
    }, { domain: "factory", operation: "lockMigrations", signal: options.signal });

    const serverVersion = await transaction.query<ServerVersionRow>({
      text: "SELECT pg_catalog.current_setting('server_version_num')::integer AS server_version_num",
    }, { domain: "factory", operation: "preflightServerVersion", signal: options.signal });
    const serverVersionNumber = sanitizeServerVersionNumber(
      serverVersion.rows[0]?.server_version_num,
    );
    const serverMajorVersion = serverVersionNumber === null
      ? null
      : Math.floor(serverVersionNumber / 10_000);
    if (serverMajorVersion !== REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION) {
      throw new PostgreSqlServerVersionPreflightError(
        serverVersionNumber,
        serverMajorVersion,
      );
    }

    const continuity = await transaction.query<PostmasterContinuityRow>({
      text: `SELECT
               pg_catalog.pg_postmaster_start_time()::text OPERATOR(pg_catalog.=) $1::text
               AND EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_get_loaded_modules() AS loaded
                 WHERE loaded.module_name OPERATOR(pg_catalog.=) 'pg_stat_statements'
                    OR loaded.file_name OPERATOR(pg_catalog.~)
                      '(^|/)pg_stat_statements([.][^/]*)?$'
               ) AS preflight_still_valid`,
      values: [postmasterStartedAt],
    }, { domain: "factory", operation: "verifyPostmasterContinuity", signal: options.signal });
    if (continuity.rows[0]?.preflight_still_valid !== true) {
      throw migrationError("verifyPostmasterContinuity");
    }

    await assertRequiredPostgreSqlExtensionCatalogReady(transaction, {
      operation: "revalidateRequiredExtensionCatalog",
      pgStatStatementsPreloaded: true,
      signal: options.signal,
    });

    const schemaOwnership = await transaction.query<SchemaOwnershipRow>({
      text: `SELECT
        CURRENT_USER::text AS current_user_name,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_namespace
          WHERE nspname = 'lcm'
        ) AS schema_exists,
        COALESCE((
          SELECT namespace.nspowner = role.oid
          FROM pg_catalog.pg_namespace AS namespace
          INNER JOIN pg_catalog.pg_roles AS role ON role.rolname = CURRENT_USER
          WHERE namespace.nspname = 'lcm'
        ), false) AS owned_by_current_user`,
    }, { domain: "factory", operation: "preflightSchemaOwnership", signal: options.signal });
    const schemaExists = sanitizeBoolean(schemaOwnership.rows[0]?.schema_exists);
    const ownedByMigrator = sanitizeBoolean(schemaOwnership.rows[0]?.owned_by_current_user);
    const requiredOwner = sanitizeRoleName(schemaOwnership.rows[0]?.current_user_name);
    const ownershipReady = requiredOwner !== null
      && ((schemaExists === false && ownedByMigrator === false)
        || (schemaExists === true && ownedByMigrator === true));
    if (!ownershipReady) {
      throw new PostgreSqlSchemaOwnershipPreflightError(
        schemaExists,
        ownedByMigrator,
        requiredOwner,
      );
    }

    const schemaAcl = await transaction.query<SchemaAclRow>({
      text: `SELECT
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_namespace AS namespace
          WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
        ) AS schema_exists,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_namespace AS namespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(
              namespace.nspacl,
              pg_catalog.acldefault('n', namespace.nspowner)
            )
          ) AS privilege
          WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
            AND privilege.grantee OPERATOR(pg_catalog.=) 0
            AND privilege.privilege_type OPERATOR(pg_catalog.=) 'CREATE'
        ) AS public_create`,
    }, { domain: "factory", operation: "preflightSchemaAcl", signal: options.signal });
    const aclSchemaExists = sanitizeBoolean(schemaAcl.rows[0]?.schema_exists);
    const publicCreate = sanitizeBoolean(schemaAcl.rows[0]?.public_create);
    if (
      aclSchemaExists === null
      || publicCreate === null
      || aclSchemaExists !== schemaExists
      || (aclSchemaExists === false && publicCreate !== false)
      || publicCreate
    ) {
      throw new PostgreSqlSchemaAclPreflightError(aclSchemaExists, publicCreate);
    }

    const ledgerRelation = await transaction.query<MigrationLedgerRelationRow>({
      text: `WITH migration_role AS (
               SELECT role.oid, role.rolname
               FROM pg_catalog.pg_roles AS role
               WHERE role.rolname OPERATOR(pg_catalog.=) CURRENT_USER
             ),
             ledger_relation AS (
               SELECT relation.relkind, relation.relowner
               FROM pg_catalog.pg_class AS relation
               JOIN pg_catalog.pg_namespace AS namespace
                 ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
               WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                 AND relation.relname OPERATOR(pg_catalog.=) 'schema_migrations'
             )
             SELECT migration_role.rolname::pg_catalog.text AS current_user_name,
                    ledger_relation.relkind IS NOT NULL AS ledger_exists,
                    ledger_relation.relkind::pg_catalog.text AS relation_kind,
                    CASE
                      WHEN ledger_relation.relkind IS NULL THEN NULL
                      ELSE ledger_relation.relowner OPERATOR(pg_catalog.=) migration_role.oid
                    END AS owned_by_current_user
             FROM migration_role
             LEFT JOIN ledger_relation ON true`,
    }, {
      domain: "factory",
      operation: "preflightMigrationLedgerRelation",
      signal: options.signal,
    });
    const ledgerExists = sanitizeBoolean(ledgerRelation.rows[0]?.ledger_exists);
    const rawRelationKind = ledgerRelation.rows[0]?.relation_kind;
    const relationKind = typeof rawRelationKind === "string" && rawRelationKind.length === 1
      ? rawRelationKind
      : null;
    const rawLedgerOwnership = ledgerRelation.rows[0]?.owned_by_current_user;
    const ledgerOwnedByMigrator = sanitizeBoolean(rawLedgerOwnership);
    const ledgerRequiredOwner = sanitizeRoleName(
      ledgerRelation.rows[0]?.current_user_name,
    );
    const absentLedgerIsValid = ledgerExists === false
      && rawRelationKind === null
      && rawLedgerOwnership === null;
    const presentLedgerIsValid = ledgerExists === true
      && relationKind === "r"
      && ledgerOwnedByMigrator === true;
    if (
      ledgerRequiredOwner === null
      || ledgerRequiredOwner !== requiredOwner
      || (!absentLedgerIsValid && !presentLedgerIsValid)
    ) {
      throw new PostgreSqlMigrationLedgerRelationPreflightError(
        ledgerExists,
        relationKind,
        ledgerOwnedByMigrator,
        ledgerRequiredOwner,
      );
    }

    const inspectManagedObjects = async (
      managedObjectIdentities: readonly string[],
      baselineApplied: boolean | null,
      requireComplete: boolean,
    ): Promise<void> => {
      const managedOwnership = await transaction.query<ManagedObjectOwnershipRow>({
        text: `WITH migration_role AS (
                 SELECT role.oid
                 FROM pg_catalog.pg_roles AS role
                 WHERE role.rolname OPERATOR(pg_catalog.=) CURRENT_USER
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
                   AND relation.relkind OPERATOR(pg_catalog.=) ANY (
                     ARRAY['r', 'S']::pg_catalog."char"[]
                   )
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
               managed_objects AS (
                 SELECT catalog_objects.owner_oid
                 FROM catalog_objects
                 WHERE catalog_objects.object_identity OPERATOR(pg_catalog.=)
                   ANY ($2::pg_catalog.text[])
               )
               SELECT CURRENT_USER::pg_catalog.text AS current_user_name,
                      $1::pg_catalog.int4 AS expected_object_count,
                      pg_catalog.count(*)::pg_catalog.int4 AS existing_object_count,
                      pg_catalog.count(*) FILTER (
                        WHERE managed_objects.owner_oid OPERATOR(pg_catalog.<>) migration_role.oid
                      )::pg_catalog.int4 AS unowned_object_count
               FROM managed_objects
               CROSS JOIN migration_role`,
        values: [managedObjectIdentities.length, managedObjectIdentities],
      }, {
        domain: "factory",
        operation: "preflightManagedObjectOwnership",
        signal: options.signal,
      });
      const expectedObjectCount = sanitizeNonnegativeCount(
        managedOwnership.rows[0]?.expected_object_count,
      );
      const existingObjectCount = sanitizeNonnegativeCount(
        managedOwnership.rows[0]?.existing_object_count,
      );
      const unownedObjectCount = sanitizeNonnegativeCount(
        managedOwnership.rows[0]?.unowned_object_count,
      );
      const managedRequiredOwner = sanitizeRoleName(
        managedOwnership.rows[0]?.current_user_name,
      );
      const missingObjectCount = requireComplete
        && expectedObjectCount !== null
        && existingObjectCount !== null
        ? expectedObjectCount - existingObjectCount
        : null;
      if (
        expectedObjectCount !== managedObjectIdentities.length
        || existingObjectCount === null
        || existingObjectCount > expectedObjectCount
        || unownedObjectCount === null
        || unownedObjectCount > existingObjectCount
        || unownedObjectCount !== 0
        || managedRequiredOwner === null
        || managedRequiredOwner !== requiredOwner
        || (requireComplete && missingObjectCount !== 0)
      ) {
        throw new PostgreSqlManagedObjectOwnershipPreflightError(
          baselineApplied,
          expectedObjectCount,
          existingObjectCount,
          missingObjectCount,
          unownedObjectCount,
          managedRequiredOwner,
        );
      }
    };
    const knownManagedObjectIdentities = [
      ...new Set(schemaSnapshots.flatMap(({ managedObjectIdentities }) => (
        managedObjectIdentities
      ))),
    ];
    await inspectManagedObjects(knownManagedObjectIdentities, null, false);

    const current = ledgerExists
      ? (await transaction.query<MigrationRow>({
        text: "SELECT id, checksum_sha256 FROM lcm.schema_migrations ORDER BY id",
      }, { domain: "factory", operation: "readMigrations", signal: options.signal })).rows
      : [];

    if (current.length > migrations.length) throw migrationError("verifyMigrationHistory");
    for (let index = 0; index < current.length; index += 1) {
      const expected = migrations[index];
      const applied = current[index];
      if (!expected || applied.id !== expected.id || applied.checksum_sha256 !== expected.sha256) {
        throw migrationError("verifyMigrationHistory");
      }
    }
    const currentSnapshot = selectLatestPostgreSqlSchemaSnapshot(
      current.map(({ id }) => id),
      schemaSnapshots,
    );
    if (currentSnapshot) {
      await inspectManagedObjects(currentSnapshot.managedObjectIdentities, true, true);
    }

    const assertSchemaSnapshot = async (
      expectedBaselineDefinitions: PostgreSqlSchemaSnapshot,
    ): Promise<void> => {
    const baselineApplied = true;
    const snapshotExpectations =
      getPostgreSqlSchemaSnapshotExpectations(expectedBaselineDefinitions);
    const baselineDefinitions =
      await transaction.query<BaselineDefinitionInventoryRow>({
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
                   AND index_relation.relname OPERATOR(pg_catalog.=)
                     ANY ($2::pg_catalog.text[])
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
                   AND pg_catalog.concat_ws(
                     '|',
                     relation.relname,
                     trigger.tgname
                   ) OPERATOR(pg_catalog.=) ANY ($3::pg_catalog.text[])
               ),
               actual_constraints AS (
                 SELECT constraint_metadata.conname AS object_name,
                        relation.relname AS table_name,
                        constraint_metadata.contype::pg_catalog.text AS constraint_type,
                        pg_catalog.pg_get_constraintdef(
                          constraint_metadata.oid,
                          true
                        ) AS definition,
                        COALESCE(
                          constraint_trigger_states.enabled_modes,
                          ''
                        ) AS enabled_modes
                 FROM pg_catalog.pg_constraint AS constraint_metadata
                 JOIN pg_catalog.pg_class AS relation
                   ON relation.oid OPERATOR(pg_catalog.=) constraint_metadata.conrelid
                 JOIN pg_catalog.pg_namespace AS namespace
                   ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
                 LEFT JOIN (
                   SELECT trigger.tgconstraint AS constraint_oid,
                          pg_catalog.string_agg(
                            trigger.tgenabled::pg_catalog.text,
                            ''
                            ORDER BY trigger.tgenabled
                          ) AS enabled_modes
                   FROM pg_catalog.pg_trigger AS trigger
                   WHERE trigger.tgconstraint OPERATOR(pg_catalog.<>) 0
                   GROUP BY trigger.tgconstraint
                 ) AS constraint_trigger_states
                   ON constraint_trigger_states.constraint_oid
                     OPERATOR(pg_catalog.=) constraint_metadata.oid
                 WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                   AND pg_catalog.concat_ws(
                     '|',
                     relation.relname,
                     constraint_metadata.conname
                   ) OPERATOR(pg_catalog.=) ANY ($4::pg_catalog.text[])
               ),
               actual_generated_columns AS (
                 SELECT relation.relname AS table_name,
                        attribute.attname AS column_name,
                        pg_catalog.format_type(
                          attribute.atttypid,
                          attribute.atttypmod
                        ) AS data_type,
                        attribute.attnotnull::pg_catalog.text AS not_null,
                        attribute.attgenerated::pg_catalog.text AS generation_kind,
                        pg_catalog.pg_get_expr(
                          attribute_default.adbin,
                          attribute_default.adrelid,
                          true
                        ) AS generation_expression,
                        pg_catalog.concat_ws(
                          '.',
                          collation_namespace.nspname,
                          collation_metadata.collname
                        ) AS collation_name
                 FROM pg_catalog.pg_attribute AS attribute
                 JOIN pg_catalog.pg_class AS relation
                   ON relation.oid OPERATOR(pg_catalog.=) attribute.attrelid
                 JOIN pg_catalog.pg_namespace AS namespace
                   ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
                 JOIN pg_catalog.pg_attrdef AS attribute_default
                   ON attribute_default.adrelid OPERATOR(pg_catalog.=) attribute.attrelid
                  AND attribute_default.adnum OPERATOR(pg_catalog.=) attribute.attnum
                 LEFT JOIN pg_catalog.pg_collation AS collation_metadata
                   ON collation_metadata.oid OPERATOR(pg_catalog.=)
                     attribute.attcollation
                 LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
                   ON collation_namespace.oid OPERATOR(pg_catalog.=)
                     collation_metadata.collnamespace
                 WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                   AND attribute.attgenerated OPERATOR(pg_catalog.<>) ''
                   AND pg_catalog.concat_ws(
                     '|',
                     relation.relname,
                     attribute.attname
                   ) OPERATOR(pg_catalog.=) ANY ($5::pg_catalog.text[])
               ),
               actual_ordinary_columns AS (
                 SELECT relation.relname AS table_name,
                        attribute.attname AS column_name,
                        pg_catalog.format_type(
                          attribute.atttypid,
                          attribute.atttypmod
                        ) AS data_type,
                        attribute.attnotnull::pg_catalog.text AS not_null,
                        COALESCE(
                          pg_catalog.pg_get_expr(
                            attribute_default.adbin,
                            attribute_default.adrelid,
                            true
                          ),
                          ''
                        ) AS default_expression,
                        attribute.attidentity::pg_catalog.text AS identity_kind,
                        pg_catalog.concat_ws(
                          '.',
                          collation_namespace.nspname,
                          collation_metadata.collname
                        ) AS collation_name
                 FROM pg_catalog.pg_attribute AS attribute
                 JOIN pg_catalog.pg_class AS relation
                   ON relation.oid OPERATOR(pg_catalog.=) attribute.attrelid
                 JOIN pg_catalog.pg_namespace AS namespace
                   ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
                 LEFT JOIN pg_catalog.pg_attrdef AS attribute_default
                   ON attribute_default.adrelid OPERATOR(pg_catalog.=) attribute.attrelid
                  AND attribute_default.adnum OPERATOR(pg_catalog.=) attribute.attnum
                 LEFT JOIN pg_catalog.pg_collation AS collation_metadata
                   ON collation_metadata.oid OPERATOR(pg_catalog.=)
                     attribute.attcollation
                 LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
                   ON collation_namespace.oid OPERATOR(pg_catalog.=)
                     collation_metadata.collnamespace
                 WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                   AND attribute.attnum OPERATOR(pg_catalog.>) 0
                   AND NOT attribute.attisdropped
                   AND attribute.attgenerated OPERATOR(pg_catalog.=) ''
                   AND pg_catalog.concat_ws(
                     '|',
                     relation.relname,
                     attribute.attname
                   ) OPERATOR(pg_catalog.=) ANY ($6::pg_catalog.text[])
               ),
               actual_identity_sequences AS (
                 SELECT sequence_relation.relname AS sequence_name,
                        sequence_relation.relpersistence::pg_catalog.text
                          AS persistence,
                        pg_catalog.format_type(
                          sequence_metadata.seqtypid,
                          NULL
                        ) AS data_type,
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
                   ON sequence_relation.oid OPERATOR(pg_catalog.=)
                     sequence_metadata.seqrelid
                 JOIN pg_catalog.pg_namespace AS namespace
                   ON namespace.oid OPERATOR(pg_catalog.=)
                     sequence_relation.relnamespace
                 JOIN pg_catalog.pg_depend AS dependency
                   ON dependency.classid OPERATOR(pg_catalog.=)
                     pg_catalog.to_regclass('pg_catalog.pg_class')
                  AND dependency.objid OPERATOR(pg_catalog.=) sequence_relation.oid
                  AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                  AND dependency.refclassid OPERATOR(pg_catalog.=)
                    pg_catalog.to_regclass('pg_catalog.pg_class')
                  AND dependency.deptype OPERATOR(pg_catalog.=) 'i'
                 JOIN pg_catalog.pg_class AS owning_relation
                   ON owning_relation.oid OPERATOR(pg_catalog.=) dependency.refobjid
                 JOIN pg_catalog.pg_attribute AS owning_attribute
                   ON owning_attribute.attrelid OPERATOR(pg_catalog.=)
                     dependency.refobjid
                  AND owning_attribute.attnum OPERATOR(pg_catalog.=)
                    dependency.refobjsubid
                 WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                   AND sequence_relation.relname OPERATOR(pg_catalog.=)
                     ANY ($7::pg_catalog.text[])
               ),
               actual_tables AS (
                 SELECT relation.relname AS table_name,
                        relation.relpersistence::pg_catalog.text AS persistence,
                        relation.relrowsecurity::pg_catalog.text AS row_security,
                        relation.relforcerowsecurity::pg_catalog.text
                          AS force_row_security,
                        relation.relispartition::pg_catalog.text AS is_partition,
                        EXISTS (
                          SELECT 1
                          FROM pg_catalog.pg_inherits AS inheritance
                          WHERE inheritance.inhrelid OPERATOR(pg_catalog.=)
                            relation.oid
                        )::pg_catalog.text AS has_parent,
                        EXISTS (
                          SELECT 1
                          FROM pg_catalog.pg_inherits AS inheritance
                          WHERE inheritance.inhparent OPERATOR(pg_catalog.=)
                            relation.oid
                        )::pg_catalog.text AS has_child
                 FROM pg_catalog.pg_class AS relation
                 JOIN pg_catalog.pg_namespace AS namespace
                   ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
                 WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                   AND relation.relkind OPERATOR(pg_catalog.=) 'r'
                   AND relation.relname OPERATOR(pg_catalog.=)
                     ANY ($8::pg_catalog.text[])
               ),
               acl_relations AS (
                 SELECT pg_catalog.concat(
                          CASE relation.relkind
                            WHEN 'r' THEN 'table|'
                            WHEN 'S' THEN 'sequence|'
                          END,
                          relation.relname
                        ) AS object_identity,
                        relation.relowner AS owner_oid,
                        COALESCE(
                          relation.relacl,
                          pg_catalog.acldefault(
                            CASE relation.relkind
                              WHEN 'r' THEN 'r'::pg_catalog."char"
                              WHEN 'S' THEN 's'::pg_catalog."char"
                            END,
                            relation.relowner
                          )
                        ) AS effective_acl
                 FROM pg_catalog.pg_class AS relation
                 JOIN pg_catalog.pg_namespace AS namespace
                   ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
                 WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                   AND relation.relkind OPERATOR(pg_catalog.=) ANY (
                     ARRAY['r', 'S']::pg_catalog."char"[]
                   )
               ),
               actual_relation_acls AS (
                 SELECT acl_relations.object_identity,
                        CASE
                          WHEN privilege.grantee OPERATOR(pg_catalog.=)
                            acl_relations.owner_oid
                            THEN 'owner'
                          ELSE privilege.grantee::pg_catalog.text
                        END AS grantee,
                        CASE
                          WHEN privilege.grantor OPERATOR(pg_catalog.=)
                            acl_relations.owner_oid
                            THEN 'owner'
                          ELSE privilege.grantor::pg_catalog.text
                        END AS grantor,
                        privilege.privilege_type,
                        privilege.is_grantable::pg_catalog.text AS is_grantable
                 FROM acl_relations
                 CROSS JOIN LATERAL pg_catalog.aclexplode(
                   acl_relations.effective_acl
                 ) AS privilege
                 WHERE acl_relations.object_identity OPERATOR(pg_catalog.=)
                   ANY ($9::pg_catalog.text[])
                   AND NOT (
                     privilege.grantee OPERATOR(pg_catalog.<>) 0::pg_catalog.oid
                     AND privilege.grantee OPERATOR(pg_catalog.<>) acl_relations.owner_oid
                     AND privilege.grantor OPERATOR(pg_catalog.=) acl_relations.owner_oid
                     AND privilege.is_grantable OPERATOR(pg_catalog.=) false
                     AND (
                       (
                         acl_relations.object_identity OPERATOR(pg_catalog.=)
                           'table|machines'
                         AND privilege.privilege_type OPERATOR(pg_catalog.=) 'SELECT'
                       )
                       OR (
                         acl_relations.object_identity OPERATOR(pg_catalog.=)
                           'table|projects'
                         AND privilege.privilege_type OPERATOR(pg_catalog.=)
                           ANY (ARRAY['SELECT', 'DELETE']::pg_catalog.text[])
                       )
                       OR (
                         acl_relations.object_identity OPERATOR(pg_catalog.=)
                           'table|project_aliases'
                         AND privilege.privilege_type OPERATOR(pg_catalog.=)
                           ANY (ARRAY['SELECT', 'DELETE']::pg_catalog.text[])
                       )
                       OR (
                         acl_relations.object_identity OPERATOR(pg_catalog.=)
                           'table|conversations'
                         AND privilege.privilege_type OPERATOR(pg_catalog.=) 'SELECT'
                       )
                       OR (
                         acl_relations.object_identity OPERATOR(pg_catalog.=)
                           ANY (
                             ARRAY[
                               'table|native_transcripts',
                               'table|transcript_messages',
                               'table|ingest_checkpoints'
                             ]::pg_catalog.text[]
                           )
                         AND privilege.privilege_type OPERATOR(pg_catalog.=) 'SELECT'
                       )
                       OR (
                         acl_relations.object_identity OPERATOR(pg_catalog.=)
                           ANY (
                             ARRAY[
                               'table|promoted_memories',
                               'table|promoted_memory_tags',
                               'table|recall_surfacing',
                               'table|redaction_counters',
                               'table|session_ingest_log',
                               'table|session_instructions'
                             ]::pg_catalog.text[]
                           )
                         AND privilege.privilege_type OPERATOR(pg_catalog.=)
                           ANY (ARRAY['SELECT', 'DELETE']::pg_catalog.text[])
                       )
                       OR (
                         acl_relations.object_identity OPERATOR(pg_catalog.=)
                           'table|fenced_leases'
                         AND privilege.privilege_type OPERATOR(pg_catalog.=)
                           ANY (ARRAY['SELECT', 'DELETE']::pg_catalog.text[])
                       )
                       OR (
                         acl_relations.object_identity OPERATOR(pg_catalog.=)
                           'table|passive_event_inbox'
                         AND privilege.privilege_type OPERATOR(pg_catalog.=)
                           'SELECT'
                       )
                       OR (
                         acl_relations.object_identity OPERATOR(pg_catalog.=)
                           ANY (
                             ARRAY[
                               'table|messages',
                               'table|context_items'
                             ]::pg_catalog.text[]
                           )
                         AND privilege.privilege_type OPERATOR(pg_catalog.=)
                           ANY (ARRAY['SELECT', 'DELETE']::pg_catalog.text[])
                       )
                       OR (
                         acl_relations.object_identity OPERATOR(pg_catalog.=)
                           ANY (
                             ARRAY[
                               'table|message_parts',
                               'table|summary_messages'
                             ]::pg_catalog.text[]
                           )
                         AND privilege.privilege_type OPERATOR(pg_catalog.=) 'SELECT'
                       )
                       OR (
                         acl_relations.object_identity OPERATOR(pg_catalog.=)
                           ANY (
                             ARRAY[
                               'sequence|conversations_conversation_id_seq',
                               'sequence|messages_message_id_seq',
                               'sequence|fenced_leases_fencing_token_seq',
                               'sequence|recall_surfacing_surfacing_id_seq',
                               'sequence|session_instructions_instruction_id_seq'
                             ]::pg_catalog.text[]
                           )
                         AND privilege.privilege_type OPERATOR(pg_catalog.=) 'USAGE'
                       )
                     )
                   )
               ),
               raw_column_acls AS (
                 SELECT pg_catalog.concat_ws(
                          '|',
                          relation.relname,
                          attribute.attname
                        ) AS object_identity,
                        COALESCE(
                          CASE
                            WHEN privilege.grantee OPERATOR(pg_catalog.=)
                              relation.relowner
                              THEN 'owner'
                            ELSE privilege.grantee::pg_catalog.text
                          END,
                          ''
                        ) AS grantee,
                        COALESCE(
                          CASE
                            WHEN privilege.grantor OPERATOR(pg_catalog.=)
                              relation.relowner
                              THEN 'owner'
                            ELSE privilege.grantor::pg_catalog.text
                          END,
                          ''
                        ) AS grantor,
                        COALESCE(privilege.privilege_type, '') AS privilege_type,
                        COALESCE(
                          privilege.is_grantable::pg_catalog.text,
                          ''
                        ) AS is_grantable,
                        COALESCE(
                          privilege.grantee OPERATOR(pg_catalog.<>) 0::pg_catalog.oid
                          AND privilege.grantee OPERATOR(pg_catalog.<>) relation.relowner
                          AND privilege.grantor OPERATOR(pg_catalog.=) relation.relowner
                          AND privilege.is_grantable OPERATOR(pg_catalog.=) false
                          AND (
                            (
                              relation.relname OPERATOR(pg_catalog.=) 'machines'
                              AND (
                                (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY['identity_key', 'display_name']::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type OPERATOR(pg_catalog.=) 'INSERT'
                                )
                                OR (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY['display_name', 'last_seen_at']::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type OPERATOR(pg_catalog.=) 'UPDATE'
                                )
                              )
                            )
                            OR (
                              relation.relname OPERATOR(pg_catalog.=) 'projects'
                              AND attribute.attname OPERATOR(pg_catalog.=)
                                ANY (
                                  ARRAY['identity_key', 'display_name']::pg_catalog.text[]
                                )
                              AND privilege.privilege_type OPERATOR(pg_catalog.=) 'INSERT'
                            )
                            OR (
                              relation.relname OPERATOR(pg_catalog.=) 'project_aliases'
                              AND (
                                (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'project_id',
                                        'machine_id',
                                        'path',
                                        'normalized_path'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type OPERATOR(pg_catalog.=) 'INSERT'
                                )
                                OR (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'project_id',
                                        'path',
                                        'linked_at'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type OPERATOR(pg_catalog.=) 'UPDATE'
                                )
                              )
                            )
                            OR (
                              relation.relname OPERATOR(pg_catalog.=) 'conversations'
                              AND (
                                (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'project_id',
                                        'conversation_id',
                                        'session_id',
                                        'session_id_sha256',
                                        'created_at'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type
                                    OPERATOR(pg_catalog.=) 'SELECT'
                                )
                                OR (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'project_id',
                                        'session_id',
                                        'title'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type OPERATOR(pg_catalog.=) 'INSERT'
                                )
                                OR (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'bootstrapped_at',
                                        'updated_at'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type OPERATOR(pg_catalog.=) 'UPDATE'
                                )
                              )
                            )
                            OR (
                              relation.relname OPERATOR(pg_catalog.=) 'messages'
                              AND (
                                (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'project_id',
                                        'conversation_id',
                                        'message_id',
                                        'seq',
                                        'role',
                                        'content'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type
                                    OPERATOR(pg_catalog.=) 'SELECT'
                                )
                                OR (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'project_id',
                                        'conversation_id',
                                        'seq',
                                        'role',
                                        'content',
                                        'token_count'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type
                                    OPERATOR(pg_catalog.=) 'INSERT'
                                )
                              )
                            )
                            OR (
                              relation.relname OPERATOR(pg_catalog.=) 'message_parts'
                              AND attribute.attname OPERATOR(pg_catalog.=)
                                ANY (
                                  ARRAY[
                                    'project_id',
                                    'conversation_id',
                                    'message_id',
                                    'session_id',
                                    'part_type',
                                    'ordinal',
                                    'text_content',
                                    'tool_call_id',
                                    'tool_name',
                                    'tool_input',
                                    'tool_output',
                                    'metadata'
                                  ]::pg_catalog.text[]
                                )
                              AND privilege.privilege_type OPERATOR(pg_catalog.=) 'INSERT'
                            )
                            OR (
                              relation.relname OPERATOR(pg_catalog.=)
                                'native_transcripts'
                              AND attribute.attname OPERATOR(pg_catalog.=)
                                ANY (
                                  ARRAY[
                                    'project_id',
                                    'machine_id',
                                    'client_name',
                                    'format_name',
                                    'format_version',
                                    'native_session_id',
                                    'source_locator',
                                    'source_ordinal',
                                    'observed_at',
                                    'ingested_at',
                                    'scrubber_version',
                                    'content_sha256',
                                    'ingest_key',
                                    'native_payload'
                                  ]::pg_catalog.text[]
                                )
                              AND privilege.privilege_type OPERATOR(pg_catalog.=)
                                'INSERT'
                            )
                            OR (
                              relation.relname OPERATOR(pg_catalog.=)
                                'transcript_messages'
                              AND attribute.attname OPERATOR(pg_catalog.=)
                                ANY (
                                  ARRAY[
                                    'project_id',
                                    'transcript_id',
                                    'conversation_id',
                                    'message_id',
                                    'source_ordinal'
                                  ]::pg_catalog.text[]
                                )
                              AND privilege.privilege_type OPERATOR(pg_catalog.=)
                                'INSERT'
                            )
                            OR (
                              relation.relname OPERATOR(pg_catalog.=)
                                'ingest_checkpoints'
                              AND (
                                (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'project_id',
                                        'machine_id',
                                        'client_name',
                                        'source_locator'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type
                                    OPERATOR(pg_catalog.=) 'INSERT'
                                )
                                OR (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'last_source_ordinal',
                                        'imported_count',
                                        'skipped_count',
                                        'quarantined_count',
                                        'revision',
                                        'checkpoint',
                                        'updated_at'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type
                                    OPERATOR(pg_catalog.=) 'UPDATE'
                                )
                              )
                            )
                            OR (
                              relation.relname OPERATOR(pg_catalog.=)
                                'promoted_memories'
                              AND (
                                (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'project_id',
                                        'content',
                                        'source_summary_id',
                                        'source_project_id',
                                        'session_id',
                                        'depth',
                                        'confidence',
                                        'metadata'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type
                                    OPERATOR(pg_catalog.=) 'INSERT'
                                )
                                OR (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'content',
                                        'confidence',
                                        'metadata',
                                        'archived_at'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type
                                    OPERATOR(pg_catalog.=) 'UPDATE'
                                )
                              )
                            )
                            OR (
                              relation.relname OPERATOR(pg_catalog.=)
                                'promoted_memory_tags'
                              AND attribute.attname OPERATOR(pg_catalog.=)
                                ANY (
                                  ARRAY[
                                    'project_id',
                                    'memory_id',
                                    'ordinal',
                                    'tag'
                                  ]::pg_catalog.text[]
                                )
                              AND privilege.privilege_type
                                OPERATOR(pg_catalog.=) 'INSERT'
                            )
                            OR (
                              relation.relname OPERATOR(pg_catalog.=)
                                'recall_surfacing'
                              AND attribute.attname OPERATOR(pg_catalog.=)
                                ANY (
                                  ARRAY[
                                    'project_id',
                                    'memory_id',
                                    'session_id'
                                  ]::pg_catalog.text[]
                                )
                              AND privilege.privilege_type
                                OPERATOR(pg_catalog.=) 'INSERT'
                            )
                            OR (
                              relation.relname OPERATOR(pg_catalog.=)
                                'redaction_counters'
                              AND (
                                (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'project_id',
                                        'category',
                                        'count'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type
                                    OPERATOR(pg_catalog.=) 'INSERT'
                                )
                                OR (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY['count', 'updated_at']::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type
                                    OPERATOR(pg_catalog.=) 'UPDATE'
                                )
                              )
                            )
                            OR (
                              relation.relname OPERATOR(pg_catalog.=)
                                'session_ingest_log'
                              AND (
                                (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'project_id',
                                        'session_id',
                                        'message_count'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type
                                    OPERATOR(pg_catalog.=) 'INSERT'
                                )
                                OR (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'message_count',
                                        'completed_at'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type
                                    OPERATOR(pg_catalog.=) 'UPDATE'
                                )
                              )
                            )
                            OR (
                              relation.relname OPERATOR(pg_catalog.=)
                                'session_instructions'
                              AND (
                                (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'project_id',
                                        'machine_id',
                                        'scope_hash',
                                        'client_name',
                                        'session_id',
                                        'worktree_path',
                                        'cwd_path',
                                        'content',
                                        'content_hash'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type
                                    OPERATOR(pg_catalog.=) 'INSERT'
                                )
                                OR (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'content',
                                        'content_hash',
                                        'updated_at'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type
                                    OPERATOR(pg_catalog.=) 'UPDATE'
                                )
                              )
                            )
                            OR (
                              relation.relname OPERATOR(pg_catalog.=)
                                'fenced_leases'
                              AND (
                                (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'project_id',
                                        'resource_type',
                                        'resource_key',
                                        'owner_machine_id',
                                        'owner_process_id',
                                        'operation',
                                        'expires_at'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type
                                    OPERATOR(pg_catalog.=) 'INSERT'
                                )
                                OR (
                                  attribute.attname OPERATOR(pg_catalog.=)
                                    ANY (
                                      ARRAY[
                                        'owner_machine_id',
                                        'owner_process_id',
                                        'operation',
                                        'fencing_token',
                                        'acquired_at',
                                        'renewed_at',
                                        'expires_at',
                                        'released_at'
                                      ]::pg_catalog.text[]
                                    )
                                  AND privilege.privilege_type
                                    OPERATOR(pg_catalog.=) 'UPDATE'
                                )
                              )
                            )
                            OR (
                              relation.relname OPERATOR(pg_catalog.=)
                                'passive_event_inbox'
                              AND attribute.attname OPERATOR(pg_catalog.=)
                                ANY (
                                  ARRAY[
                                    'status',
                                    'attempt_count',
                                    'claimed_at',
                                    'claimed_by'
                                  ]::pg_catalog.text[]
                                )
                              AND privilege.privilege_type
                                OPERATOR(pg_catalog.=) 'UPDATE'
                            )
                          ),
                          false
                        ) AS sanctioned
                 FROM pg_catalog.pg_attribute AS attribute
                 JOIN pg_catalog.pg_class AS relation
                   ON relation.oid OPERATOR(pg_catalog.=) attribute.attrelid
                 JOIN pg_catalog.pg_namespace AS namespace
                   ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
                 LEFT JOIN LATERAL pg_catalog.aclexplode(attribute.attacl)
                   AS privilege ON true
                 WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                   AND pg_catalog.concat_ws(
                     '|',
                     relation.relname,
                     attribute.attname
                   ) OPERATOR(pg_catalog.=) ANY ($10::pg_catalog.text[])
               ),
               actual_column_acls AS (
                 SELECT DISTINCT object_identity,
                        CASE WHEN sanctioned THEN '' ELSE grantee END AS grantee,
                        CASE WHEN sanctioned THEN '' ELSE grantor END AS grantor,
                        CASE
                          WHEN sanctioned THEN ''
                          ELSE privilege_type
                        END AS privilege_type,
                        CASE
                          WHEN sanctioned THEN ''
                          ELSE is_grantable
                        END AS is_grantable
                 FROM raw_column_acls
               ),
               actual_groups(object_kind, existing_count, definition_sha256) AS (
                 SELECT 'index'::pg_catalog.text,
                        pg_catalog.count(*)::pg_catalog.int4,
                        pg_catalog.encode(
                          public.digest(
                            COALESCE(
                              pg_catalog.string_agg(
                                pg_catalog.concat_ws('|', object_name, definition),
                                E'\\n'
                                ORDER BY object_name
                              ),
                              ''
                            ),
                            'sha256'
                          ),
                          'hex'
                        )
                 FROM actual_indexes
                 UNION ALL
                 SELECT 'trigger'::pg_catalog.text,
                        pg_catalog.count(*)::pg_catalog.int4,
                        pg_catalog.encode(
                          public.digest(
                            COALESCE(
                              pg_catalog.string_agg(
                                pg_catalog.concat_ws(
                                  '|',
                                  object_name,
                                  definition,
                                  enabled_mode
                                ),
                                E'\\n'
                                ORDER BY object_name
                              ),
                              ''
                            ),
                            'sha256'
                          ),
                          'hex'
                        )
                 FROM actual_triggers
                 UNION ALL
                 SELECT 'constraint'::pg_catalog.text,
                        pg_catalog.count(*)::pg_catalog.int4,
                        pg_catalog.encode(
                          public.digest(
                            COALESCE(
                              pg_catalog.string_agg(
                                pg_catalog.concat_ws(
                                  '|',
                                  table_name,
                                  object_name,
                                  constraint_type,
                                  definition,
                                  enabled_modes
                                ),
                                E'\\n'
                                ORDER BY table_name, object_name, constraint_type,
                                  definition, enabled_modes
                              ),
                              ''
                            ),
                            'sha256'
                          ),
                          'hex'
                        )
                 FROM actual_constraints
                 UNION ALL
                 SELECT 'generated_column'::pg_catalog.text,
                        pg_catalog.count(*)::pg_catalog.int4,
                        pg_catalog.encode(
                          public.digest(
                            COALESCE(
                              pg_catalog.string_agg(
                                pg_catalog.concat_ws(
                                  '|',
                                  table_name,
                                  column_name,
                                  data_type,
                                  not_null,
                                  generation_kind,
                                  generation_expression,
                                  collation_name
                                ),
                                E'\\n'
                                ORDER BY table_name, column_name
                              ),
                              ''
                            ),
                            'sha256'
                          ),
                          'hex'
                        )
                 FROM actual_generated_columns
                 UNION ALL
                 SELECT 'column_acl'::pg_catalog.text,
                        pg_catalog.count(
                          DISTINCT object_identity
                        )::pg_catalog.int4,
                        pg_catalog.encode(
                          public.digest(
                            COALESCE(
                              pg_catalog.string_agg(
                                pg_catalog.concat_ws(
                                  '|',
                                  object_identity,
                                  grantee,
                                  grantor,
                                  privilege_type,
                                  is_grantable
                                ),
                                E'\\n'
                                ORDER BY object_identity, grantee, grantor,
                                  privilege_type, is_grantable
                              ),
                              ''
                            ),
                            'sha256'
                          ),
                          'hex'
                        )
                 FROM actual_column_acls
                 UNION ALL
                 SELECT 'identity_sequence'::pg_catalog.text,
                        pg_catalog.count(*)::pg_catalog.int4,
                        pg_catalog.encode(
                          public.digest(
                            COALESCE(
                              pg_catalog.string_agg(
                                pg_catalog.concat_ws(
                                  '|',
                                  sequence_name,
                                  persistence,
                                  data_type,
                                  increment_by,
                                  minimum_value,
                                  maximum_value,
                                  start_value,
                                  cache_size,
                                  cycles,
                                  dependency_type,
                                  owning_table,
                                  owning_column
                                ),
                                E'\\n'
                                ORDER BY sequence_name
                              ),
                              ''
                            ),
                            'sha256'
                          ),
                          'hex'
                        )
                 FROM actual_identity_sequences
                 UNION ALL
                 SELECT 'table'::pg_catalog.text,
                        pg_catalog.count(*)::pg_catalog.int4,
                        pg_catalog.encode(
                          public.digest(
                            COALESCE(
                              pg_catalog.string_agg(
                                pg_catalog.concat_ws(
                                  '|',
                                  table_name,
                                  persistence,
                                  row_security,
                                  force_row_security,
                                  is_partition,
                                  has_parent,
                                  has_child
                                ),
                                E'\\n'
                                ORDER BY table_name
                              ),
                              ''
                            ),
                            'sha256'
                          ),
                          'hex'
                        )
                 FROM actual_tables
                 UNION ALL
                 SELECT 'relation_acl'::pg_catalog.text,
                        pg_catalog.count(
                          DISTINCT object_identity
                        )::pg_catalog.int4,
                        pg_catalog.encode(
                          public.digest(
                            COALESCE(
                              pg_catalog.string_agg(
                                pg_catalog.concat_ws(
                                  '|',
                                  object_identity,
                                  grantee,
                                  grantor,
                                  privilege_type,
                                  is_grantable
                                ),
                                E'\\n'
                                ORDER BY object_identity, grantee, grantor,
                                  privilege_type, is_grantable
                              ),
                              ''
                            ),
                            'sha256'
                          ),
                          'hex'
                        )
                 FROM actual_relation_acls
                 UNION ALL
                 SELECT 'ordinary_column'::pg_catalog.text,
                        pg_catalog.count(*)::pg_catalog.int4,
                        pg_catalog.encode(
                          public.digest(
                            COALESCE(
                              pg_catalog.string_agg(
                                pg_catalog.concat_ws(
                                  '|',
                                  table_name,
                                  column_name,
                                  data_type,
                                  not_null,
                                  default_expression,
                                  identity_kind,
                                  collation_name
                                ),
                                E'\\n'
                                ORDER BY table_name, column_name
                              ),
                              ''
                            ),
                            'sha256'
                          ),
                          'hex'
                        )
                 FROM actual_ordinary_columns
               ),
               expected_groups(
                 object_kind,
                 expected_count,
                 definition_sha256
               ) AS (
                 SELECT *
                 FROM ROWS FROM (
                   pg_catalog.unnest($12::pg_catalog.text[]),
                   pg_catalog.unnest($13::pg_catalog.int4[]),
                   pg_catalog.unnest($14::pg_catalog.text[])
                 )
               )
               SELECT $1::pg_catalog.bool AS baseline_applied,
                      $11::pg_catalog.int4 AS expected_object_count,
                      pg_catalog.sum(actual_groups.existing_count)::pg_catalog.int4
                        AS existing_object_count,
                      pg_catalog.array_agg(
                        actual_groups.existing_count
                        ORDER BY pg_catalog.array_position(
                          $12::pg_catalog.text[],
                          actual_groups.object_kind
                        )
                      ) AS actual_definition_group_counts,
                      pg_catalog.array_agg(
                        actual_groups.definition_sha256
                        ORDER BY pg_catalog.array_position(
                          $12::pg_catalog.text[],
                          actual_groups.object_kind
                        )
                      ) AS actual_definition_group_hashes,
                      CASE
                        WHEN $1::pg_catalog.bool THEN (
                          $11 - pg_catalog.sum(actual_groups.existing_count)
                        )::pg_catalog.int4
                        ELSE 0::pg_catalog.int4
                      END AS missing_object_count,
                      CASE
                        WHEN $1::pg_catalog.bool THEN pg_catalog.count(*) FILTER (
                          WHERE actual_groups.existing_count
                              OPERATOR(pg_catalog.<>) expected_groups.expected_count
                            OR actual_groups.definition_sha256
                              OPERATOR(pg_catalog.<>) expected_groups.definition_sha256
                        )::pg_catalog.int4
                        ELSE 0::pg_catalog.int4
                      END AS drifted_definition_group_count
               FROM expected_groups
               JOIN actual_groups USING (object_kind)`,
        values: [
          baselineApplied,
          expectedBaselineDefinitions.indexNames,
          expectedBaselineDefinitions.triggerIdentities,
          expectedBaselineDefinitions.constraintIdentities,
          expectedBaselineDefinitions.generatedColumnIdentities,
          expectedBaselineDefinitions.ordinaryColumnIdentities,
          expectedBaselineDefinitions.identitySequenceIdentities,
          expectedBaselineDefinitions.tableIdentities,
          expectedBaselineDefinitions.relationAclIdentities,
          expectedBaselineDefinitions.columnAclIdentities,
          snapshotExpectations.definitionObjectCount,
          snapshotExpectations.definitionGroupKinds,
          snapshotExpectations.definitionGroupCounts,
          snapshotExpectations.definitionGroupHashes,
        ],
      }, {
        domain: "factory",
        operation: "preflightBaselineDefinitions",
        signal: options.signal,
      });
    const definitionBaselineApplied = sanitizeBoolean(
      baselineDefinitions.rows[0]?.baseline_applied,
    );
    const expectedDefinitionObjectCount = sanitizeNonnegativeCount(
      baselineDefinitions.rows[0]?.expected_object_count,
    );
    const existingDefinitionObjectCount = sanitizeNonnegativeCount(
      baselineDefinitions.rows[0]?.existing_object_count,
    );
    const missingDefinitionObjectCount = sanitizeNonnegativeCount(
      baselineDefinitions.rows[0]?.missing_object_count,
    );
    const driftedDefinitionGroupCount = sanitizeNonnegativeCount(
      baselineDefinitions.rows[0]?.drifted_definition_group_count,
    );
    const actualDefinitionGroups = sanitizeDefinitionGroupFingerprints(
      snapshotExpectations.definitionGroupKinds,
      baselineDefinitions.rows[0]?.actual_definition_group_counts,
      baselineDefinitions.rows[0]?.actual_definition_group_hashes,
    );
    if (
      definitionBaselineApplied === null
      || definitionBaselineApplied !== baselineApplied
      || expectedDefinitionObjectCount !== snapshotExpectations.definitionObjectCount
      || existingDefinitionObjectCount === null
      || existingDefinitionObjectCount > expectedDefinitionObjectCount
      || missingDefinitionObjectCount === null
      || (baselineApplied
        && existingDefinitionObjectCount + missingDefinitionObjectCount
          !== expectedDefinitionObjectCount)
      || missingDefinitionObjectCount !== 0
      || driftedDefinitionGroupCount === null
      || driftedDefinitionGroupCount > snapshotExpectations.definitionGroupKinds.length
      || driftedDefinitionGroupCount !== 0
      || actualDefinitionGroups === null
    ) {
      throw new PostgreSqlBaselineDefinitionPreflightError(
        definitionBaselineApplied,
        expectedDefinitionObjectCount,
        existingDefinitionObjectCount,
        missingDefinitionObjectCount,
        driftedDefinitionGroupCount,
        actualDefinitionGroups,
      );
    }

    const identityFunctionFingerprints =
      await transaction.query<IdentityFunctionFingerprintRow>({
        text: `WITH expected_functions(function_name, prosrc_sha256) AS (
                 SELECT *
                 FROM ROWS FROM (
                   pg_catalog.unnest($2::pg_catalog.text[]),
                   pg_catalog.unnest($3::pg_catalog.text[])
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
                            pg_catalog.concat_ws(
                              '|',
                              CASE
                                WHEN privilege.grantee
                                  OPERATOR(pg_catalog.=) procedure.proowner
                                  THEN 'owner'
                                ELSE privilege.grantee::pg_catalog.text
                              END,
                              CASE
                                WHEN privilege.grantor
                                  OPERATOR(pg_catalog.=) procedure.proowner
                                  THEN 'owner'
                                ELSE privilege.grantor::pg_catalog.text
                              END,
                              privilege.privilege_type,
                              privilege.is_grantable::pg_catalog.text
                            ),
                            E'\\n'
                            ORDER BY privilege.grantee, privilege.grantor,
                              privilege.privilege_type, privilege.is_grantable
                          )
                          FROM pg_catalog.aclexplode(
                            COALESCE(
                              procedure.proacl,
                              pg_catalog.acldefault('f', procedure.proowner)
                            )
                          ) AS privilege
                        ) AS normalized_acl
                 FROM pg_catalog.pg_proc AS procedure
                 JOIN pg_catalog.pg_namespace AS namespace
                   ON namespace.oid OPERATOR(pg_catalog.=) procedure.pronamespace
                 JOIN pg_catalog.pg_language AS language
                   ON language.oid OPERATOR(pg_catalog.=) procedure.prolang
                 WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                   AND procedure.prokind OPERATOR(pg_catalog.=) 'f'
                   AND procedure.pronargs OPERATOR(pg_catalog.=) 0
                   AND procedure.proname OPERATOR(pg_catalog.=)
                     ANY ($2::pg_catalog.text[])
               )
               SELECT $1::pg_catalog.bool AS baseline_applied,
                      pg_catalog.count(*)::pg_catalog.int4 AS expected_function_count,
                      pg_catalog.count(actual_functions.function_oid)::pg_catalog.int4
                        AS existing_function_count,
                      CASE
                        WHEN $1::pg_catalog.bool THEN pg_catalog.count(*) FILTER (
                          WHERE actual_functions.function_oid IS NULL
                            OR pg_catalog.encode(
                              public.digest(actual_functions.prosrc, 'sha256'),
                              'hex'
                            ) OPERATOR(pg_catalog.<>) expected_functions.prosrc_sha256
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
                        )::pg_catalog.int4
                        ELSE 0::pg_catalog.int4
                      END AS drifted_function_count
               FROM expected_functions
               LEFT JOIN actual_functions USING (function_name)`,
        values: [
          baselineApplied,
          snapshotExpectations.identityFunctionNames,
          snapshotExpectations.identityFunctionHashes,
        ],
      }, {
        domain: "factory",
        operation: "preflightIdentityFunctionDefinitions",
        signal: options.signal,
      });
    const fingerprintBaselineApplied = sanitizeBoolean(
      identityFunctionFingerprints.rows[0]?.baseline_applied,
    );
    const expectedFunctionCount = sanitizeNonnegativeCount(
      identityFunctionFingerprints.rows[0]?.expected_function_count,
    );
    const existingFunctionCount = sanitizeNonnegativeCount(
      identityFunctionFingerprints.rows[0]?.existing_function_count,
    );
    const driftedFunctionCount = sanitizeNonnegativeCount(
      identityFunctionFingerprints.rows[0]?.drifted_function_count,
    );
    if (
      fingerprintBaselineApplied === null
      || fingerprintBaselineApplied !== baselineApplied
      || expectedFunctionCount !== snapshotExpectations.identityFunctionNames.length
      || existingFunctionCount === null
      || existingFunctionCount > expectedFunctionCount
      || driftedFunctionCount === null
      || driftedFunctionCount > expectedFunctionCount
      || driftedFunctionCount !== 0
    ) {
      throw new PostgreSqlIdentityFunctionPreflightError(
        fingerprintBaselineApplied,
        expectedFunctionCount,
        existingFunctionCount,
        driftedFunctionCount,
      );
    }
    };

    if (currentSnapshot) await assertSchemaSnapshot(currentSnapshot);

    const applied: string[] = [];
    for (const migration of migrations.slice(current.length)) {
      await transaction.query({ text: migration.sql }, {
        domain: "factory",
        operation: `applyMigration:${migration.id}`,
        signal: options.signal,
      });
      await transaction.query({
        text: "INSERT INTO lcm.schema_migrations (id, checksum_sha256) VALUES ($1, $2)",
        values: [migration.id, migration.sha256],
      }, { domain: "factory", operation: "recordMigration", signal: options.signal });
      applied.push(migration.id);
    }
    if (applied.length > 0) {
      const targetSnapshot = selectLatestPostgreSqlSchemaSnapshot(
        migrations.map(({ id }) => id),
        schemaSnapshots,
      );
      if (targetSnapshot) {
        await inspectManagedObjects(targetSnapshot.managedObjectIdentities, true, true);
        await assertSchemaSnapshot(targetSnapshot);
      }
    }
    await assertPostgreSqlSearchConfigurationReady(transaction, { signal: options.signal });
    return {
      applied,
      current: migrations.map((migration) => migration.id),
    };
  }, { domain: "factory", operation: "migrate", signal: options.signal });
}
