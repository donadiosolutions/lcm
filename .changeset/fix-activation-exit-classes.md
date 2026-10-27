---
"@donadiosolutions/lcm": patch
---

Fix two exit classes in the migration cutover. `lcm migration activate` now refuses a fenced-lease row it cannot decode with exit 5 `activation-refused-evidence` (`lease-unresolvable`) instead of an unexpected failure that claims `applied`; a decodable lease held by another publication keeps exit 4. A daemon left running on the previous backend now answers `GET /health/observe` with its identity, so the restart check reports exit 8 (restart required) instead of exit 5 `cutover-restart-contradiction`. A daemon binary from before this change still gives exit 5; run `lcm daemon status`, resolve it, then run `report`.
