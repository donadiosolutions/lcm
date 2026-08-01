\set ON_ERROR_STOP on

\if :{?lcm_data_migration_role}
\else
\echo 'Set lcm_data_migration_role to the dedicated PostgreSQL data-migration role.'
\quit 3
\endif

BEGIN;

GRANT USAGE ON SCHEMA lcm TO :"lcm_data_migration_role";
GRANT EXECUTE ON FUNCTION lcm.normalize_search_text(text),
  lcm.enforce_summary_id_uniqueness(),
  lcm.enforce_large_file_id_uniqueness(),
  lcm.enforce_session_ingest_id_uniqueness()
TO :"lcm_data_migration_role";

GRANT SELECT ON TABLE
  lcm.schema_migrations,
  lcm.machines,
  lcm.projects,
  lcm.project_aliases,
  lcm.conversations,
  lcm.messages,
  lcm.message_parts,
  lcm.native_transcripts,
  lcm.transcript_messages,
  lcm.summaries,
  lcm.summary_messages,
  lcm.summary_parents,
  lcm.context_items,
  lcm.large_files,
  lcm.summary_large_files,
  lcm.promoted_memories,
  lcm.promoted_memory_tags,
  lcm.recall_surfacing,
  lcm.redaction_counters,
  lcm.ingest_checkpoints,
  lcm.session_ingest_log,
  lcm.session_instructions,
  lcm.passive_event_inbox,
  lcm.fenced_leases
TO :"lcm_data_migration_role";

GRANT INSERT ON TABLE
  lcm.conversations,
  lcm.messages,
  lcm.message_parts,
  lcm.summaries,
  lcm.summary_messages,
  lcm.summary_parents,
  lcm.context_items,
  lcm.large_files,
  lcm.summary_large_files,
  lcm.promoted_memories,
  lcm.promoted_memory_tags,
  lcm.recall_surfacing,
  lcm.redaction_counters,
  lcm.session_ingest_log,
  lcm.session_instructions
TO :"lcm_data_migration_role";

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE lcm.fenced_leases
TO :"lcm_data_migration_role";

GRANT USAGE, SELECT, UPDATE ON SEQUENCE
  lcm.conversations_conversation_id_seq,
  lcm.messages_message_id_seq,
  lcm.recall_surfacing_surfacing_id_seq,
  lcm.session_instructions_instruction_id_seq,
  lcm.fenced_leases_fencing_token_seq
TO :"lcm_data_migration_role";

COMMIT;
