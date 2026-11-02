---
"@donadiosolutions/lcm": patch
---

Refuse passive-event uploads and cross-project recovery payloads that require redaction, preserving the retained local envelope and identifiers. Quarantine unsafe replicated rows so later safe rows can continue through bounded recovery.
