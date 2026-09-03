---
"@donadiosolutions/lcm": patch
---

Reject the misleading `expectedContentSha256` option in the generic durable
private-file writer and document the portable same-UID replacement boundary.
Callers that require conditional replacement must use a protocol-specific
operation with its own recovery grammar.
