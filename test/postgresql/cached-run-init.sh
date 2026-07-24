#!/usr/bin/env bash
set -Eeuo pipefail
: "${LCM_POSTGRES_TEMPLATE_MARKER:?LCM_POSTGRES_TEMPLATE_MARKER is required}"

ADMIN_PASSWORD="$(< /run/lcm-private/admin-password)"
MIGRATOR_PASSWORD="$(< /run/lcm-private/migrator-password)"
RUNTIME_PASSWORD="$(< /run/lcm-private/runtime-password)"
RUN_ID="$(< /run/lcm-private/run-id)"
DATABASE_NAME="$(< /run/lcm-private/database-name)"

psql --set=ON_ERROR_STOP=1 \
  --username postgres \
  --dbname postgres \
  --set=admin_password="$ADMIN_PASSWORD" \
  --set=migrator_password="$MIGRATOR_PASSWORD" \
  --set=runtime_password="$RUNTIME_PASSWORD" \
  --set=run_id="$RUN_ID" \
  --set=database_name="$DATABASE_NAME" \
  --set=template_marker="$LCM_POSTGRES_TEMPLATE_MARKER" <<'SQL'
SELECT set_config('lcm.template_marker', :'template_marker', false);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.__lcm_template_marker
    WHERE marker = current_setting('lcm.template_marker')
  ) THEN
    RAISE EXCEPTION 'cached PostgreSQL template marker is invalid';
  END IF;
END
$$;

ALTER ROLE lcm_harness_admin SUPERUSER LOGIN PASSWORD :'admin_password';
ALTER ROLE lcm_test_migrator LOGIN PASSWORD :'migrator_password';
ALTER ROLE lcm_test_runtime LOGIN PASSWORD :'runtime_password';

CREATE DATABASE :"database_name"
  WITH TEMPLATE lcm_harness_template
       OWNER lcm_harness_admin;

\connect :database_name
DO $$
DECLARE
  installed_extension_count integer;
BEGIN
  SELECT count(*)
  INTO installed_extension_count
  FROM pg_extension
  WHERE extname IN ('pg_trgm', 'unaccent', 'pgcrypto', 'pg_stat_statements');

  IF installed_extension_count <> 4 OR EXISTS (
    SELECT 1
    FROM unnest(ARRAY['pg_trgm', 'unaccent', 'pgcrypto', 'pg_stat_statements']::text[]) AS expected(extname)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_extension AS installed
      WHERE installed.extname = expected.extname
    )
  ) THEN
    RAISE EXCEPTION 'cached PostgreSQL template extension inventory is invalid';
  END IF;
  IF current_setting('server_version_num')::integer / 10000 <> 18 THEN
    RAISE EXCEPTION 'cached PostgreSQL template server version is invalid';
  END IF;
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'cached PostgreSQL template encoding is invalid';
  END IF;
END
$$;

CREATE TABLE public.__lcm_test_run_sentinel (
  run_id text PRIMARY KEY,
  database_name text NOT NULL,
  runtime_role text NOT NULL CHECK (runtime_role = 'lcm_test_runtime')
);
ALTER TABLE public.__lcm_test_run_sentinel OWNER TO lcm_harness_admin;
INSERT INTO public.__lcm_test_run_sentinel (run_id, database_name, runtime_role)
VALUES (:'run_id', :'database_name', 'lcm_test_runtime');

REVOKE ALL ON public.__lcm_test_run_sentinel FROM PUBLIC;
GRANT SELECT ON public.__lcm_test_run_sentinel TO lcm_test_migrator, lcm_test_runtime;
GRANT CONNECT, CREATE ON DATABASE :"database_name" TO lcm_test_migrator;
GRANT CONNECT ON DATABASE :"database_name" TO lcm_test_runtime;
SQL

printf '%s\n' \
  'local all all trust' \
  'hostssl all all all scram-sha-256' \
  > "$PGDATA/pg_hba.conf"

psql --set=ON_ERROR_STOP=1 \
  --username postgres \
  --dbname postgres \
  --command 'SELECT pg_reload_conf()' \
  >/dev/null
