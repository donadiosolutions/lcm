---
"@donadiosolutions/lcm": patch
---

Accept an optional lockToken on BackendPublicationCoordinator's
prepareMaintenanceSelection, completeMaintenanceSelection,
abortMaintenance, prepare, resume, abort and recoverPending, mirroring
the existing enterMaintenance parameter. A caller already holding the
publication lock can now invoke these methods without contending with
itself. The parameter is optional, the untokened #locked branch is
unedited, and the seven methods have zero production callers today, so
omitting the token preserves today's behaviour exactly.
