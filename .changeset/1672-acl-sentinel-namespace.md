---
"@donadiosolutions/lcm": patch
---

PostgreSQL readiness now refuses an extra ACL grantee whose role name equals
`runtime`, `owner`, or `public` instead of treating it as a sanctioned grant.
