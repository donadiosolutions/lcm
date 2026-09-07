---
name: flock
description: Use when cooperating workers need exclusive ownership of a named resource on the same Linux host through an advisory flock mutex.
---

# Named resource mutex

## Directives

The sole argument is the exact resource name; quote names containing spaces.
Ownership comes from `flock`, not metadata. This is cooperative local exclusion,
not a lease, distributed lock or recovery service. Never delete/replace lockfiles,
steal ownership, inspect stale PIDs or kill holders.

Use one resource per dedicated Bash shell. Keep that shell and descriptor 9 alive
through the entire protected operation, including across tool calls. Subshells,
command substitution and completed one-shot calls cannot retain ownership for
later calls. The helper reserves descriptor 9 and sets the shell's umask to 077.

## Acquire, work, release

From the repository root (otherwise source the helper by absolute path):

```bash
source .agents/skills/flock/scripts/lock.sh
lock 'lcm-daemon-update' || exit "$?"
# Protected work stays in this live shell/session.
exec 9>&-
```

The helper reads `AGENT_THREAD_ID`, falling back to `CODEX_THREAD_ID` for existing
sessions. If absent, obtain the current thread's canonical UUID from the runtime
and export `AGENT_THREAD_ID` internally. Never invent an identity, substitute a
task name or ask the caller for its UUID. If unavailable, stop without acquiring.

All participants use the **same local runtime directory**, not isolated fixture
XDG roots: `$XDG_RUNTIME_DIR`, or `/run/user/$(id -u)`. It must be user-owned with
mode 700. The compatibility namespace `codex-locks/` is deliberately unchanged;
renaming it would split existing mutexes. Lock names hash the exact resource bytes
with SHA-256; directory mode is 700 and new files are 600.

The helper rejects symlink/non-regular lockfiles, opens without truncation and
attempts nonblocking exclusive acquisition. Only after success does it replace
metadata through `/proc/self/fd/9`, targeting the held inode:

```text
thread=0199b4ef-dfde-7a81-b33e-c439d91932d8
acquired=2026-09-06T18:03:42-03:00
resource=powerhome/lcm:worktree-499
```

Everything after the initial `resource=` is the verbatim resource, including
embedded newlines, not additional fields.

Status **75** means contention; report observed metadata without modifying it.
It may be stale, empty, partial or changing: do not assert a verified current
identity. Contact the recorded UUID only when appropriate and permitted. Other
failures also prohibit protected work.

Release with `exec 9>&-`, shell exit, or explicit `flock -u 9`. Close descriptor 9
in children that must outlive protected work; inherited descriptors can retain
the lock. Leave metadata in place on release; it is historical, not proof of
ownership, even when read during a later contention attempt.
