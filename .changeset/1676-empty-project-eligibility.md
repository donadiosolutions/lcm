---
"@donadiosolutions/lcm": patch
---

Let a migration verification of a project with no messages become activation
eligible. The search probe previously reported not-run whenever the source had
no message to search for, so an empty enrolled project could never pass. The
probe now runs the production search once on a fixed query and, when it returns
no rows while the source and the fenced destination census both report zero
messages, records the public-search receipt. Projects with messages keep the
correlated self-match proof unchanged.
