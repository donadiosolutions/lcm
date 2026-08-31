---
"@donadiosolutions/lcm": patch
---

Accept Codex process summaries when the authenticated Responses stream reaches
its successful terminal event, even if Codex closes before HTTP transport EOF.
Malformed, failed, incomplete, terminal-chunk suffix, and truncated streams
continue to fail closed without requiring an exact Codex CLI version. Unread
upstream bytes after the terminal frame are canceled rather than relayed.
