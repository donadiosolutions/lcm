---
"@donadiosolutions/lcm": patch
---

Treat Codex config.toml files with overflowing float values as invalid TOML, so
doctor reports hook state as unknown and install leaves the file unchanged.
