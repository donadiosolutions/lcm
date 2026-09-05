---
"@donadiosolutions/lcm": patch
---

Restore deep episodic search recall by giving messages and summaries at least
50 candidates (and up to the requested maximum) before the final result slice.
Tag filters now apply only to promoted memories, so tagged searches continue
to return untagged episodic history. The combined episodic response still fills
messages first and may reach its maximum before summaries appear.
