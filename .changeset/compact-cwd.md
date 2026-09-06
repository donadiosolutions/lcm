---
"@donadiosolutions/lcm": patch
---

Repair `memory.compact` so it sends the project `cwd` required by the daemon,
while preserving two-argument callers through an invocation-time working
directory default and supporting explicit project directories.
