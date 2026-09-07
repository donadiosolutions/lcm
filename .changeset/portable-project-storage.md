---
"@donadiosolutions/lcm": minor
---

Route CLI retrieval, compaction discovery, transcript import and version 1 knowledge transfer through the configured SQLite or PostgreSQL backend. Preserve clean JSON output, authenticated project bindings and atomic retry of knowledge imports. Native imports now retain scrubbed transcript records with message links and checkpoints on both backends.

Add production canonical SQLite and PostgreSQL transfer adapters with bounded preflight, durable batch receipts, resume validation and complete SQL readback. SQLite recovery archives expose typed native transcript, checkpoint, instruction and passive-event reads. Snapshot creation, migration fencing, cutover and archive activation remain separate operations.

Keep publication admission held throughout selected CLI storage work and cleanup. Retry only before project preparation starts, so a later failure cannot automatically replay committed work.
