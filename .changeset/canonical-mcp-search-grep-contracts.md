---
"@donadiosolutions/lcm": major
---

Canonicalize MCP search layers to `episodic` and `promoted` (defaulting to
both) and grep scopes to `messages`, `summaries`, and `both` (defaulting to
`both`). Deprecated `semantic` and `all` inputs remain accepted as aliases.
This is a compile-time breaking migration: the previously published required
`SearchResult.semantic` field never matched runtime and is removed. Callers
and typed mocks must migrate to the required canonical `promoted` field.
Daemon/runtime responses continue to return only `episodic` and `promoted` and
never include an own `semantic` key. The deprecated `semantic` and `all` input
aliases remain accepted at the input boundary and are not advertised.
