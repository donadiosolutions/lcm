---
"@donadiosolutions/lcm": patch
---

Reject non-object JSON request bodies across daemon memory, lifecycle, stale
review, and passive-event routes with HTTP 400 (`invalid request body`) before
route effects. The `/recent` endpoint now rejects primitives that it previously
treated as an empty request; empty bodies and malformed JSON syntax keep their
existing route-specific behavior.
