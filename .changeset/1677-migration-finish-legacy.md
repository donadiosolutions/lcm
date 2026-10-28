---
"@donadiosolutions/lcm": patch
---

`lcm migration` subcommands now finish an interrupted legacy home migration (journal phase `published`, `removing` or `retaining`) when publication admission allows. If admission refuses, the subcommand continues without finishing it and a later bootstrapping command does.
