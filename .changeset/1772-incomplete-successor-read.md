---
"@donadiosolutions/lcm": patch
---

Migration manifest reads now return the current head when the next revision
directory is empty or holds only an authenticated writer scratch file, so an
interrupted update no longer blocks reads, including migration abort, until it
is retried. A next revision that holds a manifest, or anything that cannot be
authenticated, still reports `recovery-required`.
