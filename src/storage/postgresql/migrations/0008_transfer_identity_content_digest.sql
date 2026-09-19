-- Completion re-checks only the copy pipeline's own checkpoint chain
-- today; it never re-reads canonical rows, so a canonical mutation made
-- through any other path (a second run, promotion/dedup, compaction, a
-- direct edit) between verify() and complete() goes undetected. This
-- column lets the completion transaction cheaply re-verify the exact
-- rows this run wrote without a second connection or an out-of-order
-- decode: content_sha256 fingerprints the same SQL projection
-- readCanonicalRow already returns for this record's native_key, taken
-- immediately after this run inserted it.
ALTER TABLE lcm.transfer_identities
  ADD COLUMN content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$');
