---
"@donadiosolutions/lcm": patch
---

Run every `lcm migration` subcommand while a maintenance hold exists. The root
legacy-home bootstrap ran before each of them and its publication admission
refused during the hold, so `report`, `verify`, `resume`, `abort`,
`activate` and `rollback` exited 1 without printing an envelope. The bootstrap
still runs first when a legacy home is waiting to be moved.
