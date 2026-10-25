---
"@donadiosolutions/lcm": patch
---

Correct three `lcm migration` outcome-accuracy defects. `apply --dry-run` no
longer reports `applied: true` when an unexpected failure interrupts it before
any write. A failed fresh hold entry now reports `applied: true` when it left a
`maintenance-entering` hold (or the journal cannot be read back), so the
operator inspects it with `lcm migration report` before recovering. A
`maintenance-aborted` journal that belongs to another generation is no longer
routed as that generation's abort cell: it lands on the route-contradiction
cell, and the unreachable `abort-other-generation` refusal is removed.
