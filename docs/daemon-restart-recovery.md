# Managed daemon recovery

LCM runs one managed daemon for the current user. Recovery is intentionally
small and visible: use `lcm doctor` to inspect the installation and
`lcm daemon restart` to apply a validated replacement. LCM does not expose an
offline process-kill protocol, and a PID or pathname by itself is never
authority to stop a process.

Daemon cleanup coalesces concurrent close initiation, and a successful close
remains latched; if the selected storage factory reports a close failure, a
second attempt in the same terminal cleanup pass retries it. PostgreSQL is
currently retryable because it clears its failed close memo, while SQLite close
is permanently memoized over `Promise.allSettled` and cannot reject. No API,
configuration, or schema migration is involved.

## Service-manager ownership

On Linux, a normal background start is owned by the current user's
`systemd --user` manager. On macOS, it is owned by the current user's
`launchd` agent. The service is scoped to the LCM invocation and carries the
authenticated state needed for the daemon to prove that it belongs to this
installation. LCM asks the manager to stop and recreate that exact service; it
does not scan for a process with a matching name or port.

Default managed lifecycle calls use the same packaged runtime entrypoint in the
manager arguments, even when the CLI was launched through a wrapper or shim.
During an explicit restart, LCM also waits for the exact systemd unit to leave
its bounded `deactivating` stop/final transition and prove manager absence
before requesting same-name recreation. A different identity, unknown
transition, or unresolved manager state remains a fail-closed refusal.

The service is deliberately not a supervisor loop. LCM does not configure a
systemd `Restart=` policy or a launchd `KeepAlive` policy. A daemon that exits
normally after `daemon.idleTimeoutMs` remains registered but does not consume a
process. The next lifecycle request recreates the registered service through
the same manager. Idle recreation is therefore safe and quiet, while a
crashed or wedged process is not silently replaced in the background.
If launchd reports a spawned service that has crashed, run `lcm doctor` and
`lcm daemon restart`; do not manually kill or boot out the job.

On macOS, launchd can briefly retain a service label after reporting that exact
job is absent. If the next exact bootstrap returns launchd's numeric code 5
(input/output error), LCM enters a bounded label-release check. Before every
retry it confirms the exact label absent, waits up to the two-second settle
interval as capped by the remaining internal `spawnTimeoutMs` deadline, and
confirms the label absent again. If launchd repeats code 5, LCM may repeat that
authenticated check only while the same monotonic `spawnTimeoutMs` lifecycle
deadline has budget. For terminal-job recreation, that deadline is established
before manager stop and label settling and is carried into the replacement
start, so recovery cannot silently reset the lifecycle budget. This handles
label release that takes more than one settle interval without turning other
failures into generic retries.

`spawnTimeoutMs` is an internal lifecycle budget. It establishes the absolute
deadline for one lifecycle operation, including owned failed-admission manager
cleanup; each manager command remains capped by the configured per-command
limit (at most 60 seconds) and the deadline's remaining budget. It is not a
user-facing configuration setting and cannot be
changed in `config.json` or with `lcm config set`. The public
`daemon.idleTimeoutMs` setting is separate: it controls normal idle daemon
lifetime and does not change manager-command deadlines.

Process-birth evidence collected during startup admission is optional and
bounded within that same lifecycle deadline. Each sample receives at most 100
milliseconds and at most one quarter of the time remaining when it starts,
rounded down to a whole millisecond; LCM skips the sample when less than one
millisecond remains or startup has been interrupted. A slow, unavailable, or
failed sample can therefore omit the authenticated recovery witness and its
publication-convergence retry, while ordinary token, process, manager, runtime,
and backend admission checks remain unchanged. Missing process-birth evidence
never authorizes recovery.

During that code-5 recovery only, a transient malformed metadata observation
does not authorize bootstrap. LCM may wait briefly and observe the exact label
again within the same deadline, but it still requires both exact absence proofs
before retrying. Malformed metadata that persists to the deadline ends with the
bounded `malformed-state` reason.

After a successful launchd bootstrap, the exact label can also briefly expose a
metadata-malformed projection while its registration settles. LCM re-observes
that projection read-only at the existing bounded poll interval and deadline;
it never treats malformed metadata as success or as authority for a manager
mutation. Only a later authenticated running observation admits the start. A
persisting projection ends with the bounded `malformed-state` reason. This
launchd-only settling exception does not change systemd's separate authenticated
activation fence; other systemd and launchd observations remain fail closed.

The numeric result is used because launchd's accompanying human text varies by
macOS version. Permission failures remain permission failures even if they use
code 5. A timeout, transport failure, registered label, permission error, other
ambiguous manager response, malformed response outside the active code-5
recovery or bounded post-start launchd settling, other command result, or code 5
that lasts to the deadline stops with a bounded failure classification. LCM
never includes raw manager output, plist paths, or credentials in that error,
and it never falls back to manual process signaling.

Use these commands for normal operation:

```bash
lcm doctor
lcm daemon restart
```

Managed macOS launch credentials are one-shot inputs. LCM consumes each
authenticated file at the first configuration load and keeps the resulting
value only in memory for later reloads in that daemon process; it does not
reread a file that was removed or replaced. Run `lcm daemon restart` after
changing a managed credential so launchd receives a new private credential
set. A daemon process accepts at most 16 distinct launchd marker contexts;
after that bounded allowance, a new context fails closed without opening its
credential files, and established snapshots are never evicted.

`lcm doctor` reports service-manager availability, daemon health, connector
registration, MCP setup, and summarizer readiness. `lcm daemon restart`
validates the complete effective configuration before asking the manager to
replace the service, then waits for authenticated health. Run it once after a
configuration or package update instead of starting a competing daemon.

### Doctor recovery for stale daemon configuration

When the daemon is healthy and its version matches the installed LCM version,
`lcm doctor` first performs the normal non-destructive daemon validation. If
that validation identifies the managed service registration as exactly
`stale-config`, doctor performs one authenticated restart using the same
validated port, state paths, storage identity, executable, entrypoint, and
user-service-manager safeguards. It then checks authenticated daemon health
again before reporting the result.

This behavior adds no new configuration options. It uses the existing daemon
port, storage backend, runtime/entrypoint, state paths, and user manager
configuration, and is invoked with `lcm doctor`.

A successful repair is reported as a warning with `fixApplied: true` because
doctor changed the managed service state; the output explicitly says that the
stale configuration was repaired and the daemon restarted. Other lifecycle
refusals are not converted into restart permission. If the explicit repair is
refused, doctor reports a failure and keeps the lifecycle refusal's exact
remediation, such as running `lcm daemon restart` for another explicit,
fail-closed attempt. Do not manually stop a process or start a competing
daemon.

## One-time migration after a Linux upgrade

An installation upgraded from LCM v1.4.1 to v1.4.2 may still have its daemon
inside the older generated transient systemd unit. v1.4.2 uses a stable
state-root unit name, so the stable unit can initially appear absent while the
older daemon is still serving requests.

During `lcm doctor` or an explicit `lcm daemon restart`, LCM can migrate that
old unit once, but only when all of these independent checks agree:

- the canonical `daemon.pid` is a stable, regular, non-symlink file naming a
  live process;
- exactly one strictly formatted historical unit name is reported by the
  current user's systemd manager, its manager PID matches the PID file, and it
  carries a valid nonzero systemd invocation ID;
- the daemon answers public health and token-authenticated health/access
  requests with the same PID, owner, storage identity, and an older
  `major.minor.patch` version in the installed major/minor line;
- the process command and entrypoint identify an LCM daemon, and that same PID
  owns the configured `127.0.0.1` listener; and
- a fresh discovery immediately before mutation still identifies the same
  single unit.

Legacy migration reads at most 64 raw bytes from `daemon.pid` and 4,096 raw
bytes from `daemon.token`, before trimming whitespace. LCM opens each leaf
without following symlinks and in nonblocking mode. Oversized files, FIFOs,
other non-regular leaves, and multiply-linked files are unsafe evidence, so
migration refuses them without waiting for a FIFO writer.

Discovery enumerates all systemd user services before applying the strict
historical-name filter, so `reloading`, `refreshing`, `activating`,
`deactivating`, `maintenance`, inactive, failed, and future manager states
cannot disappear behind a state-filtered query. Only exact
`loaded`/`active`/`running` state with a positive manager PID is an
authenticatable candidate only when it also has a valid systemd invocation ID.
A strict unit in any other discoverable state, or without that witness, is
preserved and blocks stable startup; LCM never issues an exact stop for it.
Only an exact `LoadState=not-found` projection with no PID, or systemd's exact
not-found command result, proves a listed unit disappeared during discovery.

Only after those checks pass does LCM stop that exact unit through
`systemctl --user`. The state that authorizes that command remains strictly
`loaded`/`active`/`running` with the original positive PID. After the command
succeeds, LCM may poll through a bounded, manager-owned shutdown transition:
the unit must remain loaded and `deactivating`, its substate must be one of
systemd's recognized stop/final substates, and its PID must remain the original
PID or become 0 as part of that same transition. Every observation must retain
the exact invocation ID authenticated before stop; PID 0 alone is never an
identity witness or success. This narrow post-stop state is retryable
observation only—it never retroactively authorizes a stop and never counts as
cleanup or success. A missing, malformed, or changed invocation ID, changed
positive PID, other state or substate, manager error, or timeout is a refusal.
Only exact unit absence completes the manager stop.

LCM then requires PID death and starts the stable managed unit only when the
authenticated legacy daemon also removes `daemon.pid` while exiting. If any
PID path remains after the stop—an unchanged regular file, a replacement, a
symlink, a hardlink, or malformed evidence—LCM preserves it and refuses the
stable start. LCM does not unlink a post-stop PID pathname after checking a
descriptor because the pathname can be replaced between those operations.

LCM also treats descriptor cleanup as part of PID-evidence authentication. If
closing the descriptor fails, the evidence is unsafe and migration stops before
discovery, exact stop, unlink, or stable startup.

If `daemon.pid` is already missing, LCM first performs the same bounded,
strict legacy-unit discovery. A discovered historical unit cannot be
authenticated without its PID evidence, so LCM preserves it and refuses a
stable start. Normal absent startup continues only when discovery proves that
no historical candidate exists. Unavailable or failed discovery also refuses
rather than assuming absence.

Ambiguous, replaced, symlinked, hardlinked, malformed, unauthorized, or
otherwise incomplete evidence is left untouched. LCM refuses multiple or
changing candidates, any PID path remaining after stop, failed stops, live
PIDs, and unresolved manager states; it does not start a competing daemon
after such a refusal. Do not use wildcard service stops, `kill`, `pkill`, or a
second manual daemon start.
Run the canonical commands and preserve their refusal guidance:

```bash
lcm doctor
lcm daemon restart
```

## Root-bootstrap contention during CLI startup

Any non-help `lcm` invocation may briefly overlap another authenticated LCM
operation that is bootstrapping the user root. The CLI retries that one
root-bootstrap migration boundary for at most 20 total attempts, with 50
milliseconds between attempts. The fixed maximum wait is therefore 950
milliseconds per invocation; there is no user configuration for this budget.
After a successful preflight, daemon-backed commands do not perform a second
bootstrap migration.

Retry is enabled only when the runtime has authenticated a verified live owner
of the bootstrap lock and raises `BootstrapLockContentionError`. The CLI does
not inspect, delete, rename, or reclaim the lock while retrying. If the
competing LCM operation completes within the budget, the original command
continues normally, including ordinary commands such as `lcm search`.

Ambiguous or unavailable owner liveness, malformed or tampered metadata,
stale-lock recovery already in progress, a lock changed during stale-owner
recovery, and a concurrent successor or reclaim claim remain immediate
fail-closed errors. Those states do not prove one authenticated live bootstrap
owner and are never converted into retryable contention.

When the verified live owner remains through all 20 attempts, LCM reports that
automatic lock recovery was not attempted. Retry after the competing LCM
operation completes, and do not delete the bootstrap lock manually. `lcm doctor`
does not diagnose the root-bootstrap lock; use the safe message from
the failed invocation and retry only after the competing operation has ended.

## Configuration and security boundary

`daemon.idleTimeoutMs` controls how long an otherwise idle daemon may remain
running; it does not enable, disable, or authorize recovery. Managed recovery
has no force flag and no configuration switch for offline replacement. A
detached or foreground daemon that gives no response is intentionally left
untouched; inspect it with `lcm doctor` and use one explicit `lcm daemon
restart` only after the service manager can prove ownership.

Service-manager ownership is an authority boundary for LCM, not a same-UID
filesystem security boundary. Another process running as the same operating
system user can read or modify files and state in that user's home and runtime
directories. Private modes, canonical-path checks, authenticated daemon
metadata, and manager identity checks reduce accidental or cross-user access;
they do not turn same-UID filesystem state into a capability. LCM therefore
does not offer detached offline force-recovery or a PID/pathname-only fallback.

## The three health outcomes

The lifecycle client keeps the response boundary distinct from transport
failure. This prevents a responding daemon from being mistaken for an
invisible process:

| Outcome | Meaning | Recovery behavior |
| --- | --- | --- |
| **Response** | An HTTP response was received, including an error status, malformed JSON, or a body that timed out after headers. | Stay on the authenticated lifecycle path. The response is evidence that the service answered; no offline replacement is attempted. |
| **No-response** | The connection or transport deadline ended before any HTTP response existed. | The manager may be asked to recreate the exact managed service only after ownership, platform, and state checks succeed. |
| **Unknown** | The caller cannot establish whether response headers were received, or service identity/state is ambiguous. | Refuse recovery and preserve the process and state. `lcm doctor` prints the next safe action. |

No-response is not a license to signal a numeric PID. LCM does not remove a
PID/token file, delete a service it cannot identify, or fall back to
`kill`, `pkill`, or a pathname-only check. If the exact managed service cannot
be proved, the command fails closed and tells the operator to restore the
manager or inspect the host before retrying.

## Preserved credential directories

If the daemon start environment includes managed credentials, each managed
launch stages one private credential directory at
`<stateRoot>/credentials/<nonce>/`, where the full directory name is the
per-launch nonce itself. The directory is mode `0700` and holds mode `0600`
credential files, so treat every preserved directory as live secret-bearing
evidence. When a launch is refused or its outcome is ambiguous, LCM
intentionally preserves that directory: at refusal time a broad sweep cannot
tell abandoned debris apart from a concurrent sibling launch's staged
credentials, so deleting on suspicion could strip secrets from a launch that
is about to succeed.

Inspect before removing anything, and only ever remove a directory you have
positively identified as inactive. `lcm doctor` reports whether the daemon
is up or down; it never reports whether the daemon is idle. Doctor output is
context only and is never deletion authority:

```bash
lcm doctor
ls -la <stateRoot>/credentials/
```

Delete the directory only after positive out-of-band host evidence that the
exact nonce is not referenced by any of the following:

- a systemd or launchd job, active or registered;
- a running `lcm daemon` start or restart process; or
- an active or pending launch.

Deletion is exact and single-directory: name one positively identified
inactive directory by its full path, one at a time:

```bash
rm -r -- <stateRoot>/credentials/<exact-nonce>
```

The owner can delete the mode `0600` files directly; no `chmod` is needed.
Never glob the `credentials/` base directory, never remove a directory whose
launch may still exist, and never pre-create or rename these directories as
a recovery step. If you cannot positively identify a directory as inactive,
leave it in place and include it in the recovery report below.

The no-response classifier accepts only the closed Node transport-code set and
bounded standard fetch/network failure messages (including their bounded,
known suffixes). Unrelated programming exceptions, including generic
`TypeError` values, remain application diagnostics and are sanitized by MCP;
they never trigger managed-daemon recovery.

## Unsupported launch contexts

The following contexts are intentionally outside managed recovery:

- a compatibility detached launch or a foreground/debug launch;
- Windows, where this release has no supported per-user service-manager path;
- a container or remote session without an available per-user systemd/launchd
  manager; and
- a service whose identity, state directory, token, listener, or manager
  ownership is missing, replaced, or ambiguous.

These cases are refused rather than force-recovered. Run `lcm doctor`, repair
the host's user service manager, and then retry `lcm daemon restart`. Keep a
foreground launch for debugging only; it does not create managed recovery
authority.

## Connector recovery

Pending project opens are cancelled when a request disconnects or the daemon
shuts down. A request that remains writable during shutdown receives a
cancellation or error response instead of a normal empty success; admitted
cleanup still completes in order. After the daemon restarts, retry the
request.

Connector files are client configuration, not daemon ownership evidence. If an
upgrade leaves a connector missing or stale, reinstall it through LCM and let
the connector-specific doctor check the result:

```bash
lcm connectors install <agent>
lcm connectors doctor <agent>
lcm doctor
```

For Claude Code, `lcm install` is the native installer and also repairs the
MCP and hook registration. For Codex or GitHub Copilot, use the corresponding
`lcm connectors install` command. Do not edit generated hook files manually or
use process-kill commands as a connector or daemon recovery procedure.

## What to report when recovery is refused

Keep the complete `lcm doctor` output, the platform, and whether the daemon was
started through the managed command. Do not delete the daemon's state root
(for example `~/.lcm`) or retry with multiple daemon processes. A refusal
means LCM could not prove safe ownership; it is not evidence that another
process may be stopped. Restore the service manager or reinstall the
connector as directed, then run the canonical doctor and restart commands
again.
