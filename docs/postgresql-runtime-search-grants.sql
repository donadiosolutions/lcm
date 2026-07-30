\set ON_ERROR_STOP on

\if :{?lcm_runtime_role}
\else
\echo 'Set lcm_runtime_role to the PostgreSQL runtime role before applying lexical-search grants.'
\quit 3
\endif

BEGIN;

GRANT USAGE ON SCHEMA lcm TO :"lcm_runtime_role";

-- Search query normalization is pinned by the released schema baseline.
-- PUBLIC execution is intentionally revoked.
GRANT EXECUTE ON FUNCTION lcm.normalize_search_text(text)
TO :"lcm_runtime_role";

-- Lexical search is read-only. It does not require sequence, DML, schema
-- creation, or access to conversation/message-part provenance.
GRANT SELECT ON TABLE
  lcm.messages,
  lcm.summaries,
  lcm.promoted_memories,
  lcm.promoted_memory_tags
TO :"lcm_runtime_role";

COMMIT;
