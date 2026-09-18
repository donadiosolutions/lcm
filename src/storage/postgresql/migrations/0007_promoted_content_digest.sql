ALTER TABLE lcm.promoted_memories
  ADD COLUMN content_sha256 bytea GENERATED ALWAYS AS (
    public.digest(content, 'sha256')
  ) STORED;

CREATE INDEX promoted_memories_content_sha256_idx
  ON lcm.promoted_memories (
    project_id, content_sha256, created_at DESC, memory_id DESC
  )
  WHERE archived_at IS NULL;
