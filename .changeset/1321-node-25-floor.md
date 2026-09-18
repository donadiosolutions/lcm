---
"@donadiosolutions/lcm": major
---

Remove Node.js 22 support and declare Node.js 25.0.0 as the supported runtime.
Installing on Node.js 22 now reports an `EBADENGINE` mismatch, which npm
enforces as a refusal only when `engine-strict` is enabled and otherwise
reports as a warning, so the unsupported runtime is stated at install time
instead of failing later at runtime. The previous `>=22.12.0` floor was never
functional: `node:sqlite` does not exist on Node.js 22.12 without
`--experimental-sqlite`, which the CLI never passes. Node.js 22.13 through
22.15 do provide `StatementSync.iterate()` but still lack
`DatabaseSync.isTransaction`, which production code calls without a fallback,
so no Node.js 22 release below 22.16 could run LCM as written. CI now runs the
coverage gate on the declared floor so the supported runtime is exercised
rather than assumed.
