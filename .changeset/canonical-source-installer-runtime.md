---
"@donadiosolutions/lcm": patch
---

Align the source-clone installer with the packaged `dist/lcm.mjs` CLI
entrypoint. Existing authenticated daemons started from an older source or
intermediate entrypoint may require one restart to adopt the canonical runtime
identity on the next install or use.
