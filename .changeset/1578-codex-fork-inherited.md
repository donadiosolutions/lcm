---
"@donadiosolutions/lcm": patch
---

Stop storing a Codex fork's copied parent history again. A fork that copied its
parent's rollout now stores, and links in the native transcript archive, only
the messages after its own settings event, in both `/ingest` and `/compact`.
A session that was stored before keeps following the history it already holds.
