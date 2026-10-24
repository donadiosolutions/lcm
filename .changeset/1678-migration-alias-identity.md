---
"@donadiosolutions/lcm": patch
---

`lcm migration apply` now carries a project's project-map aliases to
PostgreSQL with the project, so a project with extra alias paths no longer
fails the copy after the hold. It refuses with `alias-conflict` before the
hold when the aliases cannot be minted exactly. A generation that an earlier
version already held and failed stays on `resume`: abort it, then run a fresh
`plan` and `apply`.
