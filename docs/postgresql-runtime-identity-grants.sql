\set ON_ERROR_STOP on

\if :{?lcm_runtime_role}
\else
\echo 'Set lcm_runtime_role to the PostgreSQL runtime role before applying identity grants.'
\quit 3
\endif

BEGIN;

GRANT USAGE ON SCHEMA lcm TO :"lcm_runtime_role";

-- Common project-mutation admission reads the reserved publication guard.
-- Domain roles do not receive lease INSERT, UPDATE, DELETE, or sequence use.
GRANT SELECT ON TABLE lcm.fenced_leases TO :"lcm_runtime_role";
GRANT SELECT ON TABLE lcm.machines TO :"lcm_runtime_role";
GRANT INSERT (identity_key, display_name),
      UPDATE (display_name, last_seen_at)
ON TABLE lcm.machines TO :"lcm_runtime_role";

GRANT SELECT, DELETE ON TABLE lcm.projects TO :"lcm_runtime_role";
-- identity_key is an opaque random 32-byte value generated once per remote
-- project creation. It is not a local path hash and remains immutable. The
-- repository preallocates project_id with pg_catalog.uuidv7() so runtime
-- admission can guard that exact project before the INSERT callback begins.
-- This remains a column grant; the role has no table-wide INSERT privilege.
GRANT INSERT (project_id, identity_key, display_name)
ON TABLE lcm.projects TO :"lcm_runtime_role";

GRANT SELECT, DELETE ON TABLE lcm.project_aliases TO :"lcm_runtime_role";
GRANT INSERT (project_id, machine_id, path, normalized_path),
      UPDATE (project_id, path, linked_at)
ON TABLE lcm.project_aliases TO :"lcm_runtime_role";

COMMIT;
