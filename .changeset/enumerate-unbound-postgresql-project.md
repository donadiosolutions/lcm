---
"@donadiosolutions/lcm": patch
---

Enumerate an unbound PostgreSQL project instead of aborting `--all` discovery.

`lcm compact --all`, `lcm import --all`, `lcm export --all`, and
`lcm promote --all` call `listCliProjects()` to select every authenticated
local project. With `storage.backend` set to `postgresql`, a single local
project that had never been linked with `lcm project create` or
`lcm project link <project-id>` made `listCliProjects()` reject outright,
so none of these commands processed any other project either. The unbound
entry now enumerates under its own local identity, the same way an already
supported retired-identity fence does, so it is reported as that project's
own failure carrying the `lcm project create` / `lcm project link` remedy
while every other selected project still runs. `lcm compact --all` reports
this failure with the actionable remedy instead of the previous generic
"project storage discovery failed" text.

