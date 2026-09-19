---
"@donadiosolutions/lcm": patch
---

Report unbound and unopenable projects honestly across CLI enumeration surfaces.

`lcm --help` now lists `project renew-retired-identity` in the top-level Runtime summary, matching the detailed `lcm project --help` grammar.

`lcm promote --all` and `lcm import --all` name the static `lcm project create` / `lcm project link <project-id>` remedy for an unbound PostgreSQL project instead of a generic per-project failure; other per-project failures keep their generic text. `lcm export --all` names the affected project path alongside the remedy. Under PostgreSQL, `lcm import --dry-run` opens each selected project without importing, so a project that cannot be opened is reported as a failure with exit 1 and the dry-run preview agrees with a real run; under SQLite `--dry-run` stays a discovery preview.

Hook-durability identities (`localProjectIdentity`) no longer satisfy call sites that require a PostgreSQL remote binding at compile time; such call sites resolve loudly through a dedicated helper instead of degrading into a permanent unbound refusal.

When enumeration succeeds but every selected project fails to open, `lcm compact --all` reports how many selected projects failed instead of claiming project discovery failed.
