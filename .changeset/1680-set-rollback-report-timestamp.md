---
"@donadiosolutions/lcm": patch
---

Fix cutover-set rollback sometimes failing to complete a member with "migration report timestamp is outside the effect boundary" when the clock advanced between the report timestamp and the completion timestamp.
