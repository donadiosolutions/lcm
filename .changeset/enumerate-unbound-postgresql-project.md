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
supported retired-identity fence does, so all four commands report it as
that project's own failure while every other selected project still runs.
`lcm compact --all` and `lcm export --all` name the `lcm project create` /
`lcm project link` remedy for that failure; `lcm compact --all` previously
reported it with the generic "project storage discovery failed" text
instead. `lcm promote --all` and `lcm import --all` still report it with
their own generic per-project failure text.
