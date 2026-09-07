---
"@donadiosolutions/lcm": patch
---

Wait up to one second for Claude session-completion acknowledgment before the hook exits, so a promptly responding daemon can persist the completion record. Completion remains best-effort on admission or transport failure; a timeout may occur after persistence. Codex turn behavior and background compaction/promotion remain unchanged.

Read authenticated hook settings before ingestion to avoid dropping completion when a post-ingest configuration reload contends with daemon writes. Settings remain consistent throughout the invocation; configuration admission failures now prevent ingestion before any transcript is stored.
