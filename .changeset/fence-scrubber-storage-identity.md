---
"@donadiosolutions/lcm": patch
---

Prevent store, ingest, and promote from using project-sensitive scrubber
patterns when the authenticated project identity changes before storage opens.
Identity drift now returns the bounded backend-publication blocked response.
