#!/usr/bin/env bash
set -Eeuo pipefail

MIGRATOR_PASSWORD="$(< /run/lcm-private/migrator-password)"
RUNTIME_PASSWORD="$(< /run/lcm-private/runtime-password)"
RUN_ID="$(< /run/lcm-private/run-id)"

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=migrator_password="$MIGRATOR_PASSWORD" \
  --set=runtime_password="$RUNTIME_PASSWORD" \
  --set=run_id="$RUN_ID" \
  --set=database_name="$POSTGRES_DB" <<'SQL'
CREATE ROLE lcm_test_migrator LOGIN PASSWORD :'migrator_password';
CREATE ROLE lcm_test_runtime LOGIN PASSWORD :'runtime_password';

CREATE EXTENSION pg_trgm;
CREATE EXTENSION unaccent;
CREATE EXTENSION pgcrypto;
CREATE EXTENSION pg_stat_statements;

CREATE TABLE public.__lcm_test_run_sentinel (
  run_id text PRIMARY KEY,
  database_name text NOT NULL,
  runtime_role text NOT NULL CHECK (runtime_role = 'lcm_test_runtime')
);
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
