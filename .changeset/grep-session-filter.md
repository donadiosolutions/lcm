---
"@donadiosolutions/lcm": patch
---

Honor the `lcm_grep` sessionId filter by selecting the canonical newest
conversation, rejecting malformed identifiers, and returning an empty result
for unknown sessions.
