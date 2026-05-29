---
"@donadiosolutions/lcm": patch
---

Prune empty or stale orphan passive-learning sidecars during sidecar scans, and report doctor sidecars skipped by scan limits as skipped instead of warnings. `lcm doctor` also now accepts `--events-max-dbs <n|all>` to control the passive-learning sidecar scan count limit.
