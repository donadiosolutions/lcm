---
"@donadiosolutions/lcm": patch
---

Reject unsafe project sensitive-pattern leaves before listing, testing, adding,
or removing patterns. Project pattern files must now be regular, owned by the
current user when the platform exposes an effective user ID, and single-link.
