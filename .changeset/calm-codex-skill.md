---
"@donadiosolutions/lcm": patch
---

Make generated Markdown connector installs byte-idempotent, preserving the
established LF or CRLF style when appending managed rules blocks and avoiding
extra blank lines in generated `SKILL.md` files.
