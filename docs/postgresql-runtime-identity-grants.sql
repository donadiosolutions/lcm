\set ON_ERROR_STOP on

\if :{?lcm_runtime_role}
\else
\echo 'Set lcm_runtime_role to the PostgreSQL runtime role before applying identity grants.'
\quit 3
\endif

BEGIN;

GRANT USAGE ON SCHEMA lcm TO :"lcm_runtime_role";
GRANT SELECT ON TABLE lcm.machines TO :"lcm_runtime_role";
GRANT INSERT (identity_key, display_name),
      UPDATE (display_name, last_seen_at)
ON TABLE lcm.machines TO :"lcm_runtime_role";

GRANT SELECT, DELETE ON TABLE lcm.projects TO :"lcm_runtime_role";
GRANT INSERT (identity_key, display_name)
ON TABLE lcm.projects TO :"lcm_runtime_role";

GRANT SELECT, DELETE ON TABLE lcm.project_aliases TO :"lcm_runtime_role";
GRANT INSERT (project_id, machine_id, path, normalized_path),
      UPDATE (project_id, path, linked_at)
ON TABLE lcm.project_aliases TO :"lcm_runtime_role";

COMMIT;
