---
"@donadiosolutions/lcm": patch
---

Stop bundled Gitleaks detectors from monopolizing the daemon during native
transcript backfill. Imported patterns collapse redundant nested lazy prefixes,
and structurally verified required keywords now skip rules that cannot match the
current text. Rules without a mechanical proof continue scanning in full.
Secret-free strings also avoid a redundant residual scrub pass.
