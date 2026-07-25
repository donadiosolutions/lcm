\set ON_ERROR_STOP on

\if :{?lcm_runtime_role}
\else
\echo 'Set lcm_runtime_role to the PostgreSQL runtime role before applying conversation grants.'
\quit 3
\endif

BEGIN;

GRANT USAGE ON SCHEMA lcm TO :"lcm_runtime_role";
-- Message inserts evaluate the stored generated search_document expression
-- under the runtime role. PUBLIC execution is intentionally revoked.
GRANT EXECUTE ON FUNCTION lcm.normalize_search_text(text)
TO :"lcm_runtime_role";

GRANT SELECT ON TABLE lcm.conversations TO :"lcm_runtime_role";
GRANT INSERT (project_id, session_id, title),
      UPDATE (bootstrapped_at, updated_at)
ON TABLE lcm.conversations TO :"lcm_runtime_role";
GRANT USAGE ON SEQUENCE lcm.conversations_conversation_id_seq
TO :"lcm_runtime_role";

GRANT SELECT, DELETE ON TABLE lcm.messages TO :"lcm_runtime_role";
GRANT INSERT (project_id, conversation_id, seq, role, content, token_count)
ON TABLE lcm.messages TO :"lcm_runtime_role";
GRANT USAGE ON SEQUENCE lcm.messages_message_id_seq
TO :"lcm_runtime_role";

GRANT SELECT ON TABLE lcm.message_parts TO :"lcm_runtime_role";
GRANT INSERT (
  project_id,
  conversation_id,
  message_id,
  session_id,
  part_type,
  ordinal,
  text_content,
  tool_call_id,
  tool_name,
  tool_input,
  tool_output,
  metadata
)
ON TABLE lcm.message_parts TO :"lcm_runtime_role";

-- Message deletion preserves summarized messages and removes active context
-- references before deleting eligible source messages.
GRANT SELECT ON TABLE lcm.summary_messages TO :"lcm_runtime_role";
GRANT SELECT, DELETE ON TABLE lcm.context_items TO :"lcm_runtime_role";

COMMIT;
