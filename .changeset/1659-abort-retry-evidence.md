---
"@donadiosolutions/lcm": patch
---

Seal the manifest abort report of a retried migration abort to the evidence
the aborted journal persisted, so an abort interrupted after the journal was
terminalized settles byte-identically to an uninterrupted one.
