---
"@donadiosolutions/lcm": patch
---

Prevent connector removal and install rollback from deleting or overwriting a
replacement at an authenticated connector pathname. Linux connector mutations
now stage complete candidates privately, claim existing leaves by atomic rename,
and publish with no-replace hard links. Wholly managed leaves are physically
removed after validation; concurrent replacements remain intact and named
recovery artifacts are reported when compensation cannot restore the receipt.

Sanitize connector removal and rollback diagnostics so retained descriptor
operation paths and nested low-level error causes are never exposed publicly.
