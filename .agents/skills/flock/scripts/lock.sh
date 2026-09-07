# Source this file in a dedicated Bash shell; lock retains descriptor 9.
lock() {
    local resource thread runtime directory digest lockfile acquired status
    if [ "$#" -ne 1 ]; then
        printf 'Usage: lock <resource-name>\n' >&2
        return 2
    fi
    resource=$1
    thread=${CODEX_THREAD_ID:-}
    if ! [[ $thread =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]]; then
        printf 'Current Codex thread UUID is unavailable in CODEX_THREAD_ID.\n' >&2
        return 2
    fi
    if [ -L /proc/self/fd/9 ]; then
        printf 'Descriptor 9 is already open; use a dedicated shell for this lock.\n' >&2
        return 2
    fi
    runtime=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
    if ! [[ $runtime = /* && -d $runtime && -O $runtime ]]; then
        printf 'A local, user-owned runtime directory is required.\n' >&2
        return 2
    fi
    if [ "$(stat -Lc '%a' -- "$runtime")" != 700 ]; then
        printf 'The shared runtime directory must have mode 700.\n' >&2
        return 2
    fi
    directory=$runtime/codex-locks
    umask 077
    mkdir -m 700 -p -- "$directory" || return 2
    if ! [[ -d $directory && -O $directory && ! -L $directory ]]; then
        printf 'Unsafe lock directory: %s\n' "$directory" >&2
        return 2
    fi
    chmod 700 -- "$directory" || return 2
    digest=$(printf '%s' "$resource" | sha256sum) || return 2
    lockfile=$directory/${digest%% *}.lock
    if [[ -L $lockfile || ( -e $lockfile && ! -f $lockfile ) ]]; then
        printf 'Unsafe lockfile: %s\n' "$lockfile" >&2
        return 2
    fi
    exec 9<>"$lockfile" || return 2
    if flock -x -n -E 75 9; then
        acquired=$(date '+%Y-%m-%dT%H:%M:%S%:z') &&
            printf 'thread=%s\nacquired=%s\nresource=%s\n' \
                "$thread" "$acquired" "$resource" >/proc/self/fd/9 || {
                    exec 9>&-
                    return 2
                }
        printf 'Acquired: %s\n' "$resource"
    else
        status=$?
        if [ "$status" -eq 75 ]; then
            printf 'Resource busy; observed holder metadata:\n' >&2
            cat <&9 >&2
        else
            printf 'flock failed (status %s).\n' "$status" >&2
        fi
        exec 9>&-
        return "$status"
    fi
}
