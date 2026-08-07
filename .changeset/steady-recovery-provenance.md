---
"@donadiosolutions/lcm": patch
---

Allow trusted immutable-release recovery to authenticate a manually published
release when an exact failed draft workflow for the same signed tag and commit
completed before publication, while preserving all tag, ancestry, history,
artifact, and npm ordering checks.
