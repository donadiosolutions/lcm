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

Connector installation manages one complete transport bundle per agent:

```bash
lcm connectors install <agent> [--transport cli|mcp] [--global]
lcm connectors remove <agent> [--global]
```

An explicit transport wins over stored
`connectors.transports.<agent-id>`, which wins over the registry default;
implicit defaults are not persisted. Claude Code, Qwen Code, and Zed default
to MCP. Codex and every other agent default to CLI, while Cline and Augment
are CLI-only until verifiable MCP adapters exist. CLI bundles use skill
guidance or rules fallback plus native hooks where implemented. MCP bundles use
MCP-only guidance plus native hooks where implemented; guidance never falls
back between transports. Removal is whole-bundle. The former component
selection option is removed.

Nested help is resolved before command execution. A help request therefore
never starts the daemon, changes a machine or project identity, installs or removes
a connector, or performs another command action. For known commands, this
preflight happens before required-argument validation, so `lcm store --help`
and other incomplete command forms still show the relevant help page.

The store command accepts one tag per occurrence using either long spelling;
the aliases can be mixed and retain command-line order:

```bash
lcm store 'Use ensureDaemon before background promote' --tag type:solution --tag scope:project --tag project:lcm --tag 'source:<actual-thread-uuid>'
```

In `lcm store`, `--tag` and `--tags` are repeatable single-tag aliases. This is
different from `lcm export --tags`, which remains a comma-separated filter,
for example `lcm export --tags decision,architecture`.

An unknown command writes an error and the complete command list to the
terminal, completes both outputs, and then exits with status 1.

## Healthy-daemon read routing

The following daemon-backed reads use a migration-free preflight when the
managed daemon is healthy:

| Command | Read performed by the daemon |
|---|---|
| `lcm search <query>` | Search episodic and promoted memory |
| `lcm grep <query>` | Search messages and summaries by exact text or regular expression |
| `lcm describe <nodeId>` | Read summary or stored-memory metadata |
| `lcm expand <nodeId>` | Expand a summary into source detail |
| `lcm status` | Read daemon and project status |
| `lcm stats --pool` | Read daemon connection-pool statistics |

Before using this route, LCM reads a bounded, no-follow configuration snapshot
without taking the private mutation/publication lock. It then requires a
present daemon token, authenticated healthy health response, matching storage
backend, and an unchanged configuration witness. This lets ordinary reads
continue while a publication consumer holds the exclusive lock.

The route is fail closed. A missing or unreadable configuration, missing token,
failed or ambiguous health check, backend mismatch, or configuration change
between the two snapshot reads returns to the existing authenticated migration
and daemon-lifecycle path. LCM never treats an uncertain snapshot as permission
to bypass migration, signal an unknown process, or mutate state. Commands that
are not one of the six reads above retain their existing migration and locking
behavior.

## Daemon-dependent resilience

`lcm doctor` limits the complete daemon health exchange to two seconds. The
deadline covers both the HTTP response and parsing its JSON body, so an
unresponsive or partially responding local daemon cannot hold up the remaining
diagnostics.

Authenticated daemon health includes a startup-captured SHA-256 digest of the
packaged `lcm.mjs` entrypoint. LCM reuses a running daemon only when its version,
storage backend, entrypoint, and runtime digest all match the invoking CLI. This
also replaces a daemon left running across a same-version rebuild. A missing or
mismatched digest makes the running daemon ineligible for reuse. When the
daemon is responsive, `lcm daemon restart` uses the authenticated lifecycle and
the owning systemd/launchd service to apply the replacement; the digest check
does not grant PID, pathname, or token authority for offline recovery. A
no-response or ambiguous service remains untouched and fails closed.

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

### Managed-daemon recovery

Use the public commands for daemon recovery:

```bash
lcm doctor
lcm daemon restart
```

`lcm doctor` checks the daemon, hooks, connector registration, MCP server, and
summarizer without asking an unknown process to stop. `lcm daemon restart`
validates the effective configuration, asks the host service manager to replace
the exact LCM service, and waits for authenticated health before returning.
After changing configuration, run the restart command once; do not start a
second daemon to work around a health failure.

Linux uses the current user's `systemd --user` manager and macOS uses the
current user's `launchd` agent. Both integrations are deliberately one-shot:
LCM does not request automatic restart (`Restart=`) or a launchd `KeepAlive`
policy. If a daemon reaches its idle timeout and exits normally, the next LCM
request recreates the registered service. This keeps idle terminals quiet while
retaining a single, authenticated service owner.

Health observation has three outcomes. An HTTP response (including an error
status, malformed body, or a body timeout after headers) stays on the normal
authenticated path. A transport failure or deadline before any response is a
**no-response** outcome and may be handed to the service manager only when the
exact managed service is still identifiable. An unknown or ambiguous outcome
is refused. LCM never turns an uncertain result into permission to signal a
numeric PID or delete state files.

Detached and foreground launches are compatibility/debug modes, not managed
recovery authorities. Windows, containers without a user service manager, and
any unsupported or ambiguous launch are refused rather than force-recovered.
Run `lcm doctor`, restore the host service manager, and retry `lcm daemon
restart`.

There is no detached offline force-recovery option. A service-manager identity
is an ownership authority for LCM, not a same-UID filesystem security boundary:
another process running as the same operating-system user can still read or
modify that user's files and runtime state. When recovery is refused, inspect
the host with `lcm doctor`, restore the manager, and retry one explicit
`lcm daemon restart`.

If a connector was removed or its installed paths are stale after an upgrade,
repair it through the connector manager and then re-run doctor:

```bash
lcm connectors install <agent>
lcm connectors doctor <agent>
lcm doctor
```

Do not edit hook files or use process-kill commands as a recovery procedure.
See [Managed daemon recovery](daemon-restart-recovery.md) for the platform
boundaries and the user-facing failure cases.
