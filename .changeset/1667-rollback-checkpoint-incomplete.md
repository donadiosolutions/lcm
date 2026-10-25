---
"@donadiosolutions/lcm": patch
---

Make `lcm migration report --set` and the write detection of `rollback --set`
distinguish a rollback checkpoint whose member records were written but never
committed from an empty store: `report --set` now prints
`rollbackRecords: incomplete`, and a rollback that stopped at the checkpoint
step after writing member records is reported as having applied a write. A
rollback whose stored checkpoint records differ from the ones it would write is
now refused before any member record is written when the stored records can be
read.
