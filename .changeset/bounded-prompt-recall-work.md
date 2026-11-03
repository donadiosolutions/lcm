---
"@donadiosolutions/lcm": patch
---

Bound prompt recall query bytes, word occurrences, candidate windows and evidence
work before opening storage or tokenizing enabled requests. Over-budget queries
return no hints without truncating the query or changing disabled recall behavior.
