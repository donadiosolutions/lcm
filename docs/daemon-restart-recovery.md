# Managed daemon recovery

LCM runs one managed daemon for the current user. Recovery is intentionally
small and visible: use `lcm doctor` to inspect the installation and
`lcm daemon restart` to apply a validated replacement. LCM does not expose an
offline process-kill protocol, and a PID or pathname by itself is never
authority to stop a process.

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
its bounded `deactivating`/`stop-*` transition and prove manager absence before
requesting same-name recreation. A different identity, unknown transition, or
unresolved manager state remains a fail-closed refusal.

The service is deliberately not a supervisor loop. LCM does not configure a
systemd `Restart=` policy or a launchd `KeepAlive` policy. A daemon that exits
normally after `daemon.idleTimeoutMs` remains registered but does not consume a
process. The next lifecycle request recreates the registered service through
the same manager. Idle recreation is therefore safe and quiet, while a
crashed or wedged process is not silently replaced in the background.
If launchd reports a spawned service that has crashed, run `lcm doctor` and
`lcm daemon restart`; do not manually kill or boot out the job.

On macOS, launchd can briefly retain a service label after reporting that exact
job absent. If the next exact bootstrap returns launchd's numeric code 5
(input/output error), LCM enters a bounded label-release check. Before every
retry it confirms the exact label absent, waits the fixed two-second settle
interval, and confirms the label absent again. If launchd repeats code 5, LCM
may repeat that authenticated check only while the original five-second command
deadline has budget. This handles label release that takes more than one settle
interval without turning other failures into generic retries.

The numeric result is used because launchd's accompanying human text varies by
macOS version. Permission failures remain permission failures even if they use
code 5. A timeout, transport failure, malformed or ambiguous manager response,
registered label, permission error, other command result, or code 5 that lasts
to the deadline stops immediately with a bounded failure classification. LCM
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
