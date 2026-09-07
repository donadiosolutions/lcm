CREATE TABLE migration_receipt_v1_epochs (
  project_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  first_machine_sequence TEXT NOT NULL CHECK (
    length(first_machine_sequence) = 19
    AND first_machine_sequence NOT GLOB '*[^0-9]*'
    AND first_machine_sequence <= '9223372036854775808'
  ),
  established_at TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL CHECK (
    length(checksum_sha256) = 64
    AND checksum_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  PRIMARY KEY (project_id, machine_id),
  UNIQUE (epoch_id)
);
CREATE TABLE migration_receipt_v1_events (
  project_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  event_uuid TEXT NOT NULL,
  machine_sequence TEXT NOT NULL CHECK (
    length(machine_sequence) = 19
    AND machine_sequence NOT GLOB '*[^0-9]*'
    AND machine_sequence <= '9223372036854775807'
  ),
  envelope_sha256 TEXT NOT NULL CHECK (
    length(envelope_sha256) = 64
    AND envelope_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no-effect')),
  effect_witness_json TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL CHECK (
    length(checksum_sha256) = 64
    AND checksum_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  PRIMARY KEY (project_id, machine_id, event_uuid),
  UNIQUE (project_id, machine_id, machine_sequence),
  FOREIGN KEY (epoch_id) REFERENCES migration_receipt_v1_epochs(epoch_id)
);
