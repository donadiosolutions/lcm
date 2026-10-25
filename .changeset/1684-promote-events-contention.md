---
"@donadiosolutions/lcm": patch
---

Make `lcm events promote` (and `--all`) answer a retryable busy status instead of a server error when publication work holds the backend lock, such as the daemon's background sweep. The command now prints "backend publication work is in progress; retry the promotion" and exits non-zero. The daemon also waits briefly for another process holding the lock before answering.
