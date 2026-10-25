---
"@donadiosolutions/lcm": patch
---

Passive-event replication no longer holds back the healthy rows of an upload
batch because one row's copy in the bound project differs from it. That row is
now retried on its own, and quarantined locally once it has been attempted the
configured number of times, whichever row of the batch the failed upload named;
the other rows upload in the same pass.
