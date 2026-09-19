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
supported retired-identity fence does, so every other selected project
still runs. `lcm compact --all` and `lcm export --all` report it as that
project's own failure and name the `lcm project create` / `lcm project link`
remedy; `lcm compact --all` previously reported it with the generic
"project storage discovery failed" text instead. `lcm promote --all`
reports a generic per-project failure naming the project path, without
the remedy. `lcm import --all` is session-driven, not project-driven: it
fails that project's sessions rather than naming the project, and a
project with no sessions to import produces no failure at all.
`lcm import --all --dry-run` contacts no project storage, so it does not
surface this condition at all.
