---
"@donadiosolutions/lcm": minor
---

Add the `lcm migration` command group for the reversible SQLite-to-PostgreSQL
cutover: `plan`, `dry-run`, `apply`, `resume`, `verify`, `report`, `abort`,
`activate` and `rollback`. `plan` previews the next migration generation without
mutating anything; `dry-run` checks the SQLite source in isolation; `apply`
captures the source, mints a migration manifest, and copies the captured data to
PostgreSQL; `resume` runs the one step a held generation is waiting for and stops
at the next checkpoint; `verify` verifies a copied generation against PostgreSQL,
finishes a pending verification from persisted evidence, and confirms a verified
one; `activate` switches a verified generation to PostgreSQL and releases the
maintenance hold; `rollback` returns an activated generation to SQLite; `report`
is a read-only account of one generation that names the command to run next,
shows the activation and rollback evidence, and checks whether a daemon needs a
restart; `abort` is the recovery exit from a held attempt and is safe to repeat.

Every command that acts on an existing generation asks one router which command
owns the state it is in, so a command that does not own it refuses and names the
one that does. `activate` and `rollback` each need `--confirm-generation` and
`--confirm-backend` (`postgresql` and `sqlite`), their `--dry-run` never exits 0
because it cannot evaluate the checks that decide the outcome, and their exit
codes are a closed table: an interrupted activation is exit 6 (run it again), and
a running daemon that still holds the previous backend is exit 8. `apply` no
longer creates the local project map entry or the destination PostgreSQL project
until its `--confirm-generation` matches, and never creates either while a hold
exists.

**`activate` runs under the PostgreSQL transfer role, so swap the grants before
starting the daemon:** add the runtime grants to the daemon's runtime role, then
revoke the transfer grants. `rollback` refuses while any other project is
remotely bound, because the backend selection is global.

See `docs/migration-operations.md` for the full operator runbook, including the
exit-code vocabulary, refusal reasons, the JSON envelope, the daemon-presence
policy, and what this command group does and does not protect against.
