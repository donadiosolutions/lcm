# Command-line behavior

LCM uses its own help renderer so every command has consistent usage,
options, and examples.

Use `lcm --help` for the complete command list and
`lcm <command> --help` for command-specific help. Commands grouped under
`daemon`, `config`, `machine`, `project`, `events`, and `connectors` use the parent command's
help page:

```bash
lcm daemon start --help
lcm config set --help
lcm machine recover --help
lcm project link --help
lcm connectors install --help
```

Nested help is resolved before command execution. A help request therefore
never starts the daemon, changes a machine or project identity, installs or removes
a connector, or performs another command action.

An unknown command writes an error and the complete command list to the
terminal, completes both outputs, and then exits with status 1.

## Daemon-dependent resilience

`lcm doctor` limits the complete daemon health exchange to two seconds. The
deadline covers both the HTTP response and parsing its JSON body, so an
unresponsive or partially responding local daemon cannot hold up the remaining
diagnostics.

Authenticated daemon health includes a startup-captured SHA-256 digest of the
packaged `lcm.mjs` entrypoint. LCM reuses a running daemon only when its version,
storage backend, entrypoint, and runtime digest all match the invoking CLI. This
also replaces a daemon left running across a same-version rebuild. A missing or
mismatched digest can restart only a token-authenticated daemon whose PID and
LCM process identity were verified; unrelated processes are never stopped.

After `lcm compact` creates summaries, automatic promotion normally uses the
same verified daemon connection. If that connection fails at the transport
layer, LCM runs the managed-daemon recovery check, creates a fresh client, and
retries promotion for that project once. It does not rerun compaction.
Application-level promotion errors are not retried, and each later project gets
its own independent recovery opportunity.

`lcm compact --all` reports each SQLite project that it cannot open, migrate, or
scan as a failure in the Compact phase while continuing with readable projects.
These failures produce a nonzero exit status and are not reported as “Nothing to
compact.” A failed scan does not mark any session as processed. Back up the
reported project database, resolve the SQLite or schema error, and rerun the
command; the still-eligible sessions will be discovered again.

### Planned kernel-backed wedged-daemon recovery

LCM currently preserves a managed daemon when its bounded health check produces
no response, because a PID and pathname alone are not safe authority to stop a
possibly replaced process. The planned Linux x64 recovery path is limited to an
explicit `lcm daemon restart`, requires authenticated launch evidence, and uses
descriptor-bound state transitions and PIDFD-only signalling. It remains
disabled until its native helper and integration are released; unsupported,
legacy, or ambiguous cases continue to fail closed. See
[the protocol contract](daemon-restart-recovery.md) for the exact boundaries
and recovery-state guarantees.
