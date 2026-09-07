---
"@donadiosolutions/lcm": patch
---

Bound fixed SQLite transfer-ledger controls before driver materialization so a
malformed resume database cannot return an oversized scalar before refusal.
