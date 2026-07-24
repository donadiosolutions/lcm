\if :{?lcm_runtime_role}
\else
\echo 'Set lcm_runtime_role to the PostgreSQL runtime role before applying identity grants.'
\quit 3
\endif

BEGIN;

GRANT USAGE ON SCHEMA lcm TO :"lcm_runtime_role";
GRANT SELECT, INSERT, UPDATE ON TABLE lcm.machines TO :"lcm_runtime_role";
GRANT SELECT, INSERT, DELETE ON TABLE lcm.projects TO :"lcm_runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE lcm.project_aliases TO :"lcm_runtime_role";

COMMIT;
