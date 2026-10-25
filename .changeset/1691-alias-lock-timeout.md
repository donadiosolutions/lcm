---
"@donadiosolutions/lcm": patch
---

Report a migration `apply` that cannot reconcile the destination project's
aliases because another session holds an uncommitted alias write as a
`migration-target-identity-unresolvable` refusal with evidence
`alias-lock-timeout`, after a 5 second wait, instead of a generic storage
error once the statement timeout cancels the lock request.
