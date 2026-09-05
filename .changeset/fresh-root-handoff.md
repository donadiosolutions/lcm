---
"@donadiosolutions/lcm": patch
---

Fail closed when a newly bootstrapped LCM root disappears, is rebound, or
changes contents during backend publication handoff. The bootstrap retains
the root descriptor and compares its authenticated pre-handoff tree before
refreshing the home-parent witness.
