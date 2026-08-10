---
"@donadiosolutions/lcm": patch
---

Make generated Markdown connector installs byte-idempotent, preserving the
established LF or CRLF style when appending managed rules blocks and avoiding
extra blank lines in generated `SKILL.md` files. Rules installs also recover
from unmatched standalone LCM marker lines without duplicating the generated
managed block or altering inline and user-authored Markdown.
