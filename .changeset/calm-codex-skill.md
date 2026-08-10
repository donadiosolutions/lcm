---
"@donadiosolutions/lcm": patch
---

Make generated Markdown connector installs byte-idempotent, preserving the
established LF or CRLF style when appending managed rules blocks and avoiding
extra blank lines in generated `SKILL.md` files. Rules installs also recover
from unmatched standalone LCM marker lines and header-only partial generated
regions, and heal duplicate current or legacy managed blocks by removing the
maximal union of overlapping ranges without duplicating the generated managed
block or altering inline and user-authored Markdown outside those regions.
