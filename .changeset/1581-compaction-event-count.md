---
"@donadiosolutions/lcm": minor
---

Store transcript messages that follow a compaction event. `/ingest` and
`/compact` no longer count compaction event rows as transcript messages when
deciding what is new, so a session that was compacted keeps ingesting its later
messages, and native linkage skips event rows.
`postgresql-runtime-transcript-grants.sql` now also grants column-limited
`SELECT` on `message_parts` so native linkage can recognize event rows. The
conversation grants' table `SELECT` on `message_parts` already covers that read
and runtime readiness, so these column grants are the least-privilege delta for
a role without that table `SELECT`; re-applying the transcript script is
harmless and not required.

Custom `ConversationRepository` implementations must add the new required
`getTranscriptSlotSnapshot` method, which returns the session-wide transcript
row count and the compaction event rows with their slot markers.
