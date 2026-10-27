---
"@donadiosolutions/lcm": patch
---

`lcm connectors doctor codex` now reports whether Codex can actually run each
LCM hook (missing, disabled, untrusted, modified, or ready) instead of
only checking that the hook is installed, and reinstalling the Codex hooks
keeps your per-hook enable and trust choices and any explicit
`[features] hooks = false`.
