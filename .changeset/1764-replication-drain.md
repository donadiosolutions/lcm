---
"@donadiosolutions/lcm": patch
---

Passive-event replication now drains a saturated backlog in short follow-up passes about one second apart instead of moving one bounded batch every five minutes. Follow-ups yield to local promotion and continue only while a pass is still saturated and made terminal progress.
