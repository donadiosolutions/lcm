#!/usr/bin/env bash
set -Eeuo pipefail
: "${LCM_POSTGRES_TEMPLATE_MARKER:?LCM_POSTGRES_TEMPLATE_MARKER is required}"

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE lcm_harness_admin NOLOGIN;
CREATE ROLE lcm_test_migrator NOLOGIN;
CREATE ROLE lcm_test_runtime NOLOGIN;

CREATE TABLE public.__lcm_template_marker (
  marker text PRIMARY KEY
);

CREATE DATABASE lcm_harness_template
  WITH TEMPLATE template0
       OWNER lcm_harness_admin
       ENCODING 'UTF8';

\connect lcm_harness_template
CREATE EXTENSION pg_trgm WITH SCHEMA public;
CREATE EXTENSION unaccent WITH SCHEMA public;
CREATE EXTENSION pgcrypto WITH SCHEMA public;
CREATE EXTENSION pg_stat_statements WITH SCHEMA public;

\connect postgres
ALTER DATABASE lcm_harness_template IS_TEMPLATE true;
ALTER DATABASE lcm_harness_template ALLOW_CONNECTIONS false;
SQL

printf '%s\n' \
  'local all all trust' \
  'host all all all reject' \
  > "$PGDATA/pg_hba.conf"

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=template_marker="$LCM_POSTGRES_TEMPLATE_MARKER" <<'SQL'
INSERT INTO public.__lcm_template_marker (marker)
VALUES (:'template_marker');
SQL
