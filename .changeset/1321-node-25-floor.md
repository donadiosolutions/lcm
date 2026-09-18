---
"@donadiosolutions/lcm": major
---

Remove Node.js 22 support and declare Node.js 25.0.0 as the supported runtime.
npm now refuses to install LCM on Node.js 22 instead of letting it fail at
runtime. The previous `>=22.12.0` floor was never functional: `node:sqlite`
does not exist on Node.js 22.12 without `--experimental-sqlite`, which the CLI
never passes, and Node.js 22.12 through 22.15 lack both
`StatementSync.iterate()` and `DatabaseSync.isTransaction`, which production
code calls without a fallback. CI now runs the coverage gate on the declared
floor so the supported runtime is exercised rather than assumed.
