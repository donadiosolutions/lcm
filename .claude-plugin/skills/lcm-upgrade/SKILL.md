---
name: lcm-upgrade
description: |
  Rebuild, reinstall, and restart Long Context Manager (LCM) from source.
  Fixes hooks, restarts daemon, runs diagnostics.
  Trigger: /lcm:upgrade
user-invocable: true
---

# Long Context Manager (LCM) Upgrade (lcm)

Rebuild from source, restart daemon, and verify installation.

## Instructions

1. Derive the **repo root** from this skill's base directory (go up 3 levels — remove `/skills/lcm-upgrade` from the path, then remove `.claude-plugin`).
2. Run with Bash:
   ```bash
   cd <REPO_ROOT> && npm run build && npm link
   ```
3. Restart daemon with Bash:
   ```bash
   PID_FILE="$HOME/.lcm/daemon.pid"
   if [ -f "$PID_FILE" ]; then
     PID=$(cat "$PID_FILE")
     if ps -p "$PID" -o args= 2>/dev/null | grep -q 'lcm.*daemon'; then
       kill "$PID" 2>/dev/null
     fi
     rm -f "$PID_FILE"
   fi
   lcm daemon start --detach
   ```
4. Run doctor with Bash:
   ```bash
   lcm doctor
   ```
5. **IMPORTANT**: After all Bash commands complete, re-display key results as markdown text directly in the conversation. Format as:
   ```bash
   ## Long Context Manager (LCM) upgrade
   - [x] Built from source
   - [x] npm linked globally
   - [x] Daemon restarted (PID XXXX)
   - [x] Hooks configured
   - [x] Doctor: all checks PASS
   ```
   Use `[x]` for success, `[ ]` for failure. Show actual version and any warnings.
   Tell the user to **restart their Claude Code session** to pick up the new version.
