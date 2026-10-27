---
"@donadiosolutions/lcm": minor
---

Restore LCM memory in Codex after compaction and into forked conversations. The
Codex SessionStart hook now also runs for `compact` and `fork`, prefixes each
restoration with an `<!-- lcm-restoration -->` line, and skips `resume`, `fork`,
and `compact` when the session's own rollout already holds a restoration since
the latest compaction or rollback. A Codex compaction restores recent summaries,
promoted knowledge, and passive insights instead of orientation only, and a
recent LCM summarization no longer strips a Codex `resume` or `clear`. The
per-session restore lock is now released when the hook returns. Re-run
`lcm connectors install codex` to update the matcher; Codex may ask to re-trust
the changed hook.
