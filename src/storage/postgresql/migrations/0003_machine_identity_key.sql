ALTER TABLE lcm.machines
  DROP CONSTRAINT machines_identity_key_check,
  ADD CONSTRAINT machines_identity_key_check CHECK (
    pg_catalog.octet_length(identity_key) OPERATOR(pg_catalog.=) 72
    AND identity_key OPERATOR(pg_catalog.~) '^machine:[0-9a-f]{64}$'
  );
