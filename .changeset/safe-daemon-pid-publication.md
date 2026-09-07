---
"@donadiosolutions/lcm": patch
---

Publish foreground and detached daemon PID files through private atomic
replacement. Existing symlink and hardlink targets remain unchanged, the
published PID file is mode `0600`, and its state directory is tightened to
mode `0700`; startup reports a failure when secure publication cannot finish.
Publication failure does not use unpublished PID state to signal a process
that may already have bound or spawned.
