\set ON_ERROR_STOP on

\if :{?lcm_runtime_role}
\else
\echo 'Set lcm_runtime_role to the PostgreSQL runtime role before applying memory grants.'
\quit 3
\endif

BEGIN;

GRANT USAGE ON SCHEMA lcm TO :"lcm_runtime_role";
GRANT EXECUTE ON FUNCTION lcm.normalize_search_text(text)
TO :"lcm_runtime_role";

GRANT SELECT, DELETE ON TABLE lcm.promoted_memories
TO :"lcm_runtime_role";
GRANT INSERT (
  project_id,
  content,
  source_summary_id,
  source_project_id,
  session_id,
  depth,
  confidence,
  metadata
),
      UPDATE (content, confidence, metadata, archived_at)
ON TABLE lcm.promoted_memories TO :"lcm_runtime_role";

GRANT SELECT, DELETE ON TABLE lcm.promoted_memory_tags
TO :"lcm_runtime_role";
GRANT INSERT (project_id, memory_id, ordinal, tag)
ON TABLE lcm.promoted_memory_tags TO :"lcm_runtime_role";

GRANT SELECT, DELETE ON TABLE lcm.recall_surfacing
TO :"lcm_runtime_role";
GRANT INSERT (project_id, memory_id, session_id)
ON TABLE lcm.recall_surfacing TO :"lcm_runtime_role";
GRANT USAGE ON SEQUENCE lcm.recall_surfacing_surfacing_id_seq
TO :"lcm_runtime_role";

GRANT SELECT, DELETE ON TABLE lcm.redaction_counters
TO :"lcm_runtime_role";
GRANT INSERT (project_id, category, count),
      UPDATE (count, updated_at)
ON TABLE lcm.redaction_counters TO :"lcm_runtime_role";

GRANT SELECT, DELETE ON TABLE lcm.session_ingest_log
TO :"lcm_runtime_role";
GRANT INSERT (project_id, session_id, message_count),
      UPDATE (message_count, completed_at)
ON TABLE lcm.session_ingest_log TO :"lcm_runtime_role";

GRANT SELECT, DELETE ON TABLE lcm.session_instructions
TO :"lcm_runtime_role";
GRANT INSERT (
        project_id, machine_id, scope_hash, client_name, session_id,
        worktree_path, cwd_path, content, content_hash
      ),
      UPDATE (content, content_hash, updated_at)
ON TABLE lcm.session_instructions TO :"lcm_runtime_role";
GRANT USAGE ON SEQUENCE lcm.session_instructions_instruction_id_seq
TO :"lcm_runtime_role";

COMMIT;
