\set ON_ERROR_STOP on

\if :{?lcm_runtime_role}
\else
\echo 'Set lcm_runtime_role to the dedicated canonical transfer role before applying transfer grants.'
\quit 3
\endif

-- Apply after all reviewed runtime grant scripts, including transcript grants.
-- This exact augmented profile is admitted by verifyPostgreSqlTransferSchema.
-- Ordinary runtime readiness intentionally rejects these additional privileges.
BEGIN;

GRANT SELECT, INSERT ON TABLE
  lcm.transfer_runs,
  lcm.transfer_batches,
  lcm.transfer_identities
TO :"lcm_runtime_role";

GRANT UPDATE (
  state,
  current_domain,
  checkpoint_bytes,
  checkpoint_sha256
)
ON TABLE lcm.transfer_runs TO :"lcm_runtime_role";

-- Preserve canonical identities, timestamps, recovery state, and typed fields.
GRANT INSERT (
  bootstrapped_at,
  created_at,
  updated_at
)
ON TABLE lcm.conversations TO :"lcm_runtime_role";

GRANT INSERT (
  created_at
)
ON TABLE lcm.messages TO :"lcm_runtime_role";

GRANT INSERT (
  part_id,
  is_ignored,
  is_synthetic,
  tool_status,
  tool_error,
  tool_title,
  patch_hash,
  patch_files,
  file_mime,
  file_name,
  file_url,
  subtask_prompt,
  subtask_desc,
  subtask_agent,
  step_reason,
  step_cost,
  step_tokens_in,
  step_tokens_out,
  snapshot_hash,
  compaction_auto
)
ON TABLE lcm.message_parts TO :"lcm_runtime_role";

GRANT INSERT (
  created_at
)
ON TABLE lcm.large_files TO :"lcm_runtime_role";

GRANT INSERT (
  created_at
)
ON TABLE lcm.summaries TO :"lcm_runtime_role";

GRANT INSERT (
  created_at
)
ON TABLE lcm.context_items TO :"lcm_runtime_role";

GRANT INSERT (
  memory_id,
  created_at,
  archived_at
)
ON TABLE lcm.promoted_memories TO :"lcm_runtime_role";

GRANT INSERT (
  surfaced_at
)
ON TABLE lcm.recall_surfacing TO :"lcm_runtime_role";

GRANT INSERT (
  completed_at
)
ON TABLE lcm.session_ingest_log TO :"lcm_runtime_role";

GRANT INSERT (
  updated_at
)
ON TABLE lcm.session_instructions TO :"lcm_runtime_role";

GRANT INSERT (
  last_source_ordinal,
  imported_count,
  skipped_count,
  quarantined_count,
  revision,
  checkpoint,
  updated_at
)
ON TABLE lcm.ingest_checkpoints TO :"lcm_runtime_role";

GRANT INSERT (
  status,
  received_at,
  next_attempt_at,
  applied_at,
  quarantined_at,
  quarantine_reason
)
ON TABLE lcm.passive_event_inbox TO :"lcm_runtime_role";

COMMIT;
