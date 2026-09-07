---
"@donadiosolutions/lcm": patch
---

Converge a managed daemon's final backend-publication admission after startup
when its initial passive sweep briefly holds the publication lock. The bounded
retry is restricted to the exact authenticated child and fails closed on
identity, credential, birth, health, timeout, or cancellation changes.
