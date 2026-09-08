---
"@donadiosolutions/lcm": patch
---

Keep session-end background scheduling failures independent so ordinary publication contention does not prevent later promotion requests or Claude session completion. Preserve fail-closed handling of local publication-journal errors.
