-- Completion re-checks only the copy pipeline's own checkpoint chain
-- today; it never re-reads canonical rows, so a canonical mutation made
-- through any other path (a second run, promotion/dedup, compaction, a
-- direct edit) between verify() and complete() goes undetected. This
-- column lets the completion transaction cheaply re-verify the exact
-- rows this run wrote without a second connection or an out-of-order
-- decode: content_sha256 fingerprints the same SQL projection
-- readCanonicalRow already returns for this record's native_key, taken
-- immediately after this run inserted it.
--
-- An installation that has already run a PostgreSQL transfer still holds its
-- transfer_identities rows: 0006 restricts deletion and the ledger retains
-- every run, completed or not. Adding the column as NOT NULL in a single
-- statement would abort on those rows and leave the installation unable to
-- apply this migration at all, so add it nullable first.
--
-- Rows written before the column existed predate the write-time capture, so
-- no real fingerprint can be reconstructed for them. Record an explicit
-- unknown-content sentinel instead: sha256 of
-- 'lcm-transfer-identity-content-unknown-v1', which cannot equal the
-- fingerprint of any actual row projection. Completion recognises the
-- sentinel and refuses to complete a run that carries one, so an upgrade
-- admits existing rows without letting an unverifiable row pass, while every
-- row written after this migration still carries a real digest under NOT NULL.
ALTER TABLE lcm.transfer_identities
  ADD COLUMN content_sha256 text CHECK (content_sha256 ~ '^[0-9a-f]{64}$');

UPDATE lcm.transfer_identities
  SET content_sha256 =
    '106c113eea9ab6e29e549a7e46b8c84514e65e1569442af3d5f33349497692c5'
  WHERE content_sha256 IS NULL;

ALTER TABLE lcm.transfer_identities
  ALTER COLUMN content_sha256 SET NOT NULL;
