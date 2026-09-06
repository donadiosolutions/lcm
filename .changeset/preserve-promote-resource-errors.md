---
"@donadiosolutions/lcm": patch
---

Keep completed promotion successful when the best-effort metadata timestamp
cannot reopen its parent because file descriptors or filesystem space are
exhausted. Untrusted or invalid parent topology remains a promotion error.
