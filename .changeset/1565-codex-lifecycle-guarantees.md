---
"@donadiosolutions/lcm": patch
---

Document the Codex lifecycle guarantees verified against native Codex 0.163.0
sessions: which edges are verified, best-effort, not covered or unverified, how
failures and context limits behave, and where to look when a hook does not run.
Correct the Codex MCP bundle setup (register with `codex mcp add lcm -- lcm mcp`
first) and document the `hooks.snapshotIntervalSec` Stop throttle.
