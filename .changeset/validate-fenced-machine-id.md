---
"@donadiosolutions/lcm": patch
---

Validate fenced PostgreSQL summary, context, and large-file repository machine
identities as canonical UUIDv7 values. Case-insensitive inputs are normalized
to lowercase, while invalid identities fail synchronously without exposing the
supplied value in diagnostics.
