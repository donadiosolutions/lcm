---
name: flock
description: Use when cooperating Codex threads need exclusive ownership of a named resource on the same Linux host, using an advisory flock mutex.
---

# flock

**The caller names the resource. The skill handles everything else.**

Invoke with exactly one resource name: `$flock lcm-daemon`. Other examples:
`$flock git-worktree-499`, `$flock deployment-production`, `$flock gpu-b300-0`,
or `$flock powerhome/lcm:worktree-499`. Quote names containing spaces.

## Acquire and use

In a dedicated Bash shell at the repository root, source
[scripts/lock.sh](scripts/lock.sh), then call `lock` with the resource as its sole
argument. From another directory, use the absolute path to this repository
skill's helper:

```sh
source .agents/skills/flock/scripts/lock.sh
lock 'lcm-daemon' || exit "$?"
# Perform the protected work here, while this shell still owns descriptor 9.
```

The helper automatically reads and validates `CODEX_THREAD_ID`, generates an
ISO-8601 timestamp with timezone offset, and hashes the exact resource bytes
with SHA-256. Files live in `$XDG_RUNTIME_DIR/codex-locks/` (fallback:
`/run/user/$(id -u)/codex-locks/`), with directory mode 700 and new files mode 600.
The runtime directory must be user-owned with mode 700. All cooperating threads
must use the same local runtime directory.

If the environment lacks the UUID, obtain the current thread's canonical UUID
from the collaboration surface and export it internally as `CODEX_THREAD_ID`.
Never guess, generate an identity, substitute a task name, or ask the caller to
supply its own UUID. If neither source exposes it, stop without acquiring.

The helper opens without truncation, attempts exclusive nonblocking `flock`,
rejects pre-existing symlink or non-regular lockfiles, then replaces metadata
through the locked descriptor only after acquisition:

```text
thread=0199b4ef-dfde-7a81-b33e-c439d91932d8
acquired=2026-09-06T18:03:42-03:00
resource=powerhome/lcm:worktree-499
```

The resource is preserved verbatim, including any embedded newlines; everything
after the initial `resource=` is the resource, not additional metadata fields.

## Contention and release

Exit status 75 means contention. The helper reads and reports the existing
metadata without modifying it. Report the recorded thread, time, and resource;
when appropriate and permitted, contact that UUID directly through the
collaboration surface. Metadata may briefly show the previous owner or be empty,
partial, or changing during acquisition/release: report it as observed metadata,
never as independently verified current identity.

Keep the owning shell alive for the entire protected operation. For work across
tool calls, retain one live interactive shell session and use that session until
finished. A completed one-shot shell call has already released its lock. Use one
resource per dedicated shell; do not run acquisition in a subshell or command
substitution. The helper reserves descriptor 9 and sets that shell's umask to 077.

Release with `exec 9>&-` or by exiting the owning shell. Avoid leaving background
children with inherited descriptor 9; close it in children that must outlive the
protected work. Explicit `flock -u 9` is also acceptable when finished.

Never delete or replace the lockfile, steal a lock, look up PIDs, detect stale
PIDs, or kill a holder. Leave metadata on release; it is historical unless a
fresh `flock` attempt reports contention. This is a cooperative local-host mutex,
not a lease, distributed service, or recovery protocol.

**`flock` determines ownership; the lockfile contents identify the owner.**
