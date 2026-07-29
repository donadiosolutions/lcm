\set ON_ERROR_STOP on

\if :{?lcm_runtime_role}
\else
\echo 'Set lcm_runtime_role to the PostgreSQL runtime role before applying coordination grants.'
\quit 3
\endif

BEGIN;

GRANT USAGE ON SCHEMA lcm TO :"lcm_runtime_role";

GRANT SELECT, DELETE ON TABLE lcm.fenced_leases
TO :"lcm_runtime_role";
GRANT INSERT (
  project_id,
  resource_type,
  resource_key,
  owner_machine_id,
  owner_process_id,
  operation,
  expires_at
),
      UPDATE (
        owner_machine_id,
        owner_process_id,
        operation,
        fencing_token,
        acquired_at,
        renewed_at,
        expires_at,
        released_at
      )
ON TABLE lcm.fenced_leases TO :"lcm_runtime_role";
GRANT USAGE ON SEQUENCE lcm.fenced_leases_fencing_token_seq
TO :"lcm_runtime_role";

GRANT SELECT ON TABLE lcm.passive_event_inbox
TO :"lcm_runtime_role";
GRANT UPDATE (
  status,
  attempt_count,
  claimed_at,
  claimed_by
)
ON TABLE lcm.passive_event_inbox TO :"lcm_runtime_role";

COMMIT;
