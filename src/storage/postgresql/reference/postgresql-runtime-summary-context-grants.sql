\set ON_ERROR_STOP on

\if :{?lcm_runtime_role}
\else
\echo 'Set lcm_runtime_role to the PostgreSQL runtime role before applying summary/context grants.'
\quit 3
\endif

BEGIN;

GRANT USAGE ON SCHEMA lcm TO :"lcm_runtime_role";
-- Project-scoped operations fail closed while backend publication is unresolved.
GRANT SELECT ON TABLE lcm.fenced_leases TO :"lcm_runtime_role";

-- Summary inserts evaluate the stored generated search_document expression
-- under the runtime role. PUBLIC execution remains revoked.
GRANT EXECUTE ON FUNCTION lcm.normalize_search_text(text)
TO :"lcm_runtime_role";

GRANT SELECT ON TABLE
  lcm.conversations,
  lcm.messages,
  lcm.summaries,
  lcm.summary_messages,
  lcm.summary_parents,
  lcm.context_items,
  lcm.large_files,
  lcm.summary_large_files
TO :"lcm_runtime_role";

GRANT INSERT (
  summary_id,
  project_id,
  conversation_id,
  kind,
  depth,
  content,
  token_count,
  earliest_at,
  latest_at,
  descendant_count,
  descendant_token_count,
  source_message_token_count
)
ON TABLE lcm.summaries TO :"lcm_runtime_role";

GRANT INSERT (
  project_id,
  conversation_id,
  summary_key,
  message_id,
  ordinal
)
ON TABLE lcm.summary_messages TO :"lcm_runtime_role";

GRANT INSERT (
  project_id,
  conversation_id,
  summary_key,
  parent_summary_key,
  ordinal
)
ON TABLE lcm.summary_parents TO :"lcm_runtime_role";

GRANT INSERT (
  project_id,
  conversation_id,
  summary_key,
  file_id,
  ordinal
)
ON TABLE lcm.summary_large_files TO :"lcm_runtime_role";

GRANT INSERT (
  project_id,
  conversation_id,
  ordinal,
  item_type,
  message_id,
  summary_key
),
      UPDATE (ordinal)
ON TABLE lcm.context_items TO :"lcm_runtime_role";
GRANT DELETE ON TABLE lcm.context_items TO :"lcm_runtime_role";

GRANT INSERT (
  file_id,
  project_id,
  conversation_id,
  file_name,
  mime_type,
  byte_size,
  storage_uri,
  exploration_summary
)
ON TABLE lcm.large_files TO :"lcm_runtime_role";

COMMIT;
