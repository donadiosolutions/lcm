---
"@donadiosolutions/lcm": minor
---

Manage daemon recovery through the current user's systemd or launchd service
manager, recreate normally idle services on demand, preserve the tri-state
no-response boundary, and provide canonical doctor, restart, and connector
repair guidance instead of offline process recovery.

Foreground or detached compatibility daemons are not eligible for automatic offline force recovery: if they stop returning HTTP responses, `lcm daemon restart` refuses and gives operator/manual recovery guidance instead of signaling or replacing the process.
