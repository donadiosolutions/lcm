---
"@donadiosolutions/lcm": patch
---

Restore normal configuration loading after SQLite migration maintenance is
aborted or target selection completes. Continue to reject active maintenance,
backend mismatches, changed configuration witnesses, and invalid journals.
