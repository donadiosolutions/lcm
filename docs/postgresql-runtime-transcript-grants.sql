\set ON_ERROR_STOP on

\if :{?lcm_runtime_role}
\else
\echo 'Set lcm_runtime_role to the PostgreSQL runtime role before applying transcript grants.'
\quit 3
\endif

BEGIN;

GRANT USAGE ON SCHEMA lcm TO :"lcm_runtime_role";

GRANT SELECT ON TABLE lcm.native_transcripts TO :"lcm_runtime_role";
GRANT INSERT (
  project_id,
  machine_id,
  client_name,
  format_name,
  format_version,
  native_session_id,
  source_locator,
  source_ordinal,
  observed_at,
  scrubber_version,
  content_sha256,
  ingest_key,
  native_payload
)
ON TABLE lcm.native_transcripts TO :"lcm_runtime_role";

GRANT SELECT ON TABLE lcm.transcript_messages TO :"lcm_runtime_role";
GRANT INSERT (
  project_id,
  transcript_id,
  conversation_id,
  message_id,
  source_ordinal
)
ON TABLE lcm.transcript_messages TO :"lcm_runtime_role";

GRANT SELECT ON TABLE lcm.ingest_checkpoints TO :"lcm_runtime_role";
GRANT INSERT (
  project_id,
  machine_id,
  client_name,
  source_locator
),
      UPDATE (
        last_source_ordinal,
        imported_count,
        skipped_count,
        quarantined_count,
        checkpoint,
        updated_at
      )
ON TABLE lcm.ingest_checkpoints TO :"lcm_runtime_role";

COMMIT;
