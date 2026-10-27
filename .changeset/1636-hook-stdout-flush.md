---
"@donadiosolutions/lcm": patch
---

Deliver the complete output of the compact, restore, session-end, user-prompt,
post-tool, pre-tool and session-snapshot hooks when stdout is a pipe. The hooks
called `process.exit()` right after writing, which discarded output still
queued in the pipe, so a restoration larger than about 8 KiB could reach Codex
truncated. They now wait for the write to be flushed (or to fail, for example
when the reader has gone away) before exiting with the same exit code.
