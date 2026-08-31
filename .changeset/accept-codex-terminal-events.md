---
"@donadiosolutions/lcm": patch
---

Accept Codex process summaries when the authenticated Responses stream reaches
its successful terminal event, even if Codex closes before HTTP transport EOF.
Malformed, failed, incomplete, post-terminal, and truncated streams continue to
fail closed without requiring an exact Codex CLI version.
