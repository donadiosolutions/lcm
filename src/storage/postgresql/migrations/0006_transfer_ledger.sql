-- Durable transfer evidence shares the transaction of the native domain writes.
-- Receipts and identity mappings are append-only for the transfer role.
CREATE TABLE lcm.transfer_runs (
  run_id text PRIMARY KEY CHECK (run_id <> ''),
  target_generation text NOT NULL CHECK (target_generation <> ''),
  project_id uuid NOT NULL REFERENCES lcm.projects(project_id) ON DELETE RESTRICT,
  manifest_bytes bytea NOT NULL,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  schema_sha256 text NOT NULL CHECK (schema_sha256 ~ '^[0-9a-f]{64}$'),
  project_sha256 text NOT NULL CHECK (project_sha256 ~ '^[0-9a-f]{64}$'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_witness_sha256 text NOT NULL CHECK (source_witness_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('active', 'completed')),
  current_domain text CHECK (current_domain <> ''),
  checkpoint_bytes bytea,
  checkpoint_sha256 text CHECK (checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT transfer_runs_generation_project_key UNIQUE (project_id, target_generation),
  CONSTRAINT transfer_runs_checkpoint_pair CHECK (
    (checkpoint_bytes IS NULL) = (checkpoint_sha256 IS NULL)
  )
);

CREATE TABLE lcm.transfer_batches (
  run_id text NOT NULL REFERENCES lcm.transfer_runs(run_id) ON DELETE RESTRICT,
  domain text NOT NULL CHECK (domain <> ''),
  prior_checkpoint_sha256 text NOT NULL CHECK (prior_checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
  batch_sha256 text NOT NULL CHECK (batch_sha256 ~ '^[0-9a-f]{64}$'),
  checkpoint_bytes bytea NOT NULL,
  checkpoint_sha256 text NOT NULL CHECK (checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
  first_ordinal bigint NOT NULL CHECK (first_ordinal >= 0),
  next_ordinal bigint NOT NULL CHECK (next_ordinal >= first_ordinal),
  PRIMARY KEY (run_id, domain, prior_checkpoint_sha256),
  CONSTRAINT transfer_batches_checkpoint_key UNIQUE (run_id, domain, checkpoint_sha256)
);

CREATE TABLE lcm.transfer_identities (
  run_id text NOT NULL REFERENCES lcm.transfer_runs(run_id) ON DELETE RESTRICT,
  domain text NOT NULL CHECK (domain <> ''),
  identity_sha256 text NOT NULL CHECK (identity_sha256 ~ '^[0-9a-f]{64}$'),
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  native_key text NOT NULL,
  record_sha256 text NOT NULL CHECK (record_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (run_id, domain, identity_sha256),
  CONSTRAINT transfer_identities_ordinal_key UNIQUE (run_id, domain, ordinal)
);

REVOKE ALL ON TABLE lcm.transfer_runs, lcm.transfer_batches, lcm.transfer_identities FROM PUBLIC;
