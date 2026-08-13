\set ON_ERROR_STOP on

\if :{?lcm_runtime_role}
\else
\echo 'Set lcm_runtime_role to the PostgreSQL runtime role before applying runtime readiness grants.'
\quit 3
\endif

BEGIN;

-- Runtime readiness itself is catalog-only, but the ledger's complete history
-- must be readable so the verifier can prove that no migration is pending.
GRANT SELECT ON TABLE lcm.schema_migrations TO :"lcm_runtime_role";

-- Search fingerprints use the extension namespace explicitly, even when a
-- hardened deployment has removed PUBLIC defaults.
GRANT USAGE ON SCHEMA public TO :"lcm_runtime_role";
GRANT EXECUTE ON FUNCTION public.digest(text, text), public.digest(bytea, text)
TO :"lcm_runtime_role";

COMMIT;
