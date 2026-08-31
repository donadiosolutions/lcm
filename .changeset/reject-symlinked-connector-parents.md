---
"@donadiosolutions/lcm": patch
---

Anchor connector parent traversal through retained Linux proc descriptors so
intermediate symlinks cannot redirect project or home writes. Filesystem-backed
connector install/remove now refuse on unsupported platforms or without the
required proc/flag guarantees, and the default pathname-based native Codex MCP
add/remove path emits manual guidance instead of mutating automatically.
