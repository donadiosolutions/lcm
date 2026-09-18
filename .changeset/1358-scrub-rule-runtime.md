---
"@donadiosolutions/lcm": patch
---

Stop bundled Gitleaks detectors from monopolizing the daemon during native
transcript backfill. Five imported rules carried a redundant nested lazy prefix
over the same character class, costing about 25x more per rule than the
equivalent single prefix and together 70% of the whole scan, and every
secret-free string was scrubbed a second time to verify no residual secret
remained.
