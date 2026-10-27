---
"@donadiosolutions/lcm": patch
---

Re-running a migration rollback now completes it when its own backend
publication was aborted by something else. The restored configuration and
project map are checked against what the publication recorded, the destination
and the activation authority are verified again, and the publication then
resumes forward; a drifted destination refuses with the effect pending and the
lease held.
