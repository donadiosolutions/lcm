---
"@donadiosolutions/lcm": patch
---

Make generated Markdown connector installs byte-idempotent, preserving the
established LF or CRLF style in normal rules append-mode installs and avoiding
extra blank lines in generated `SKILL.md` files. Rules installs heal recognized
duplicate current or legacy managed blocks, including the maximal union of
overlapping or touching recognized ranges, and recover the narrowly recognized
header-only partial region consisting of a current marker followed only by
exact `# Workflow Instruction` lines. Arbitrary ambiguous or malformed
unmatched marker/header combinations remain preserved conservatively and may
require a second reinstall to become byte-stable; user-authored Markdown,
including heading lines, outside recognized regions is not removed.
