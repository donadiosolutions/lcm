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

## Healthy-daemon routing

The following six read commands use a migration-free preflight when the
managed daemon is healthy. The shared preflight acquires an authenticated
daemon client for each read:

| Command | Operation performed by the daemon |
|---|---|
| `lcm search <query>` | Search episodic and promoted memory |
| `lcm grep <query>` | Search messages and summaries by exact text or regular expression |
| `lcm describe <nodeId>` | Read summary or stored-memory metadata |
| `lcm expand <nodeId>` | Expand a summary into source detail |
| `lcm status` | Read daemon and project status |
| `lcm stats --pool` | Read daemon connection-pool statistics |

Before using this route, LCM reads a bounded, no-follow configuration snapshot
without taking the private mutation/publication lock. If `config.json` is
absent, the snapshot uses validated defaults and records an absent witness;
absence alone is not a reason to fall back. For an existing file, the snapshot
must be readable, well-formed, within the size limit, a regular non-symlink
file, and otherwise valid. LCM then requires a present daemon token and an
authenticated healthy health response from the current
LCM version with both private identity markers—a matching packaged `entrypoint`
and authenticated matching packaged `runtimeDigest`. If the invoking CLI cannot
resolve or hash its local packaged entrypoint, it falls back to the locked
lifecycle path rather than treating either missing identity as a wildcard. The
health response must also report a matching storage backend, and the
configuration witness must remain unchanged.
This lets ordinary reads continue while a publication consumer holds the
exclusive lock without reusing a stale packaged daemon after a rebuild.

Authenticated daemon read responses are buffered until request-time admission
is repeated after the handler finishes. LCM compares both the configuration
witness and terminal publication-journal checksum before releasing up to 10 MiB
of buffered output. If publication begins, completes, aborts, or changes
evidence during the handler, the buffered result is discarded and the request
returns a blocked response instead of leaking a stale or mixed-backend result.
An existing publication directory without a journal is incomplete evidence,
not the legacy SQLite no-evidence case. This response buffering applies to
read routes; `lcm store` remains a mutation.

`lcm store <text>` first completes legacy-home bootstrap admission through the
same locked migration gate, then reuses the authenticated healthy daemon client
without redundant lifecycle discovery. The daemon still revalidates backend,
configuration, and publication state and performs the write through
operation-scoped publication admission. If the client preflight cannot prove
identity, health, or a stable configuration, `lcm store` returns to the
existing daemon-lifecycle path without rerunning the completed legacy gate.

The route is fail closed. An unreadable, malformed, oversized, symlinked, or
otherwise invalid configuration, missing token, failed or ambiguous health
check, backend mismatch, or configuration change between the two snapshot
reads returns to the existing authenticated migration and daemon-lifecycle
path. Daemon request admission independently rejects an unsafe or replaced
private root before reading storage and revalidates it before releasing the
buffered response. LCM never treats an uncertain snapshot as
permission to bypass migration, signal an unknown process, or mutate state.
Other mutation-requiring commands retain their existing migration and locking
behavior; pure exits and explicit read exceptions such as help, diagnose,
usage-only parent actions, `connectors list`, and `connectors doctor` remain
exempt according to the command-routing policy. When connector inspection is
unavailable, `connectors doctor` reads its stored transport hint through the
same bounded, stable, lock-free configuration admission.

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

On Linux, managed-daemon admission also proves that the configured
`127.0.0.1` listener belongs to the authenticated systemd service. LCM first
uses direct process-descriptor evidence when the caller can read it. If a
`PrivateTmp`-isolated user unit runs in a sibling user namespace that hides
those descriptor links, LCM
uses the operating system's fixed `ss` socket-diagnostic command to compare
the listener's kernel cgroup with systemd's exact `ControlGroup` for the
registered service. Missing tools, malformed output, mixed ownership, or a
cgroup mismatch remain fail-closed; health plus a matching PID is never enough
to authorize reuse or replacement.

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

## Compact concurrency and cancellation

`lcm compact` accepts a bounded worker-pool setting for manual batch work:

```bash
lcm compact --all --max-concurrency 4
lcm compact --all --replay                 # always sequential
lcm compact --all --dry-run                # validate and preview only
```

The persistent setting is `llm.maxConcurrency` in `~/.lcm/config.json` (default
`1`, valid range `1..32`):

```bash
lcm config set llm.maxConcurrency 4 --json
lcm config get llm.maxConcurrency --effective
```

`--max-concurrency` overrides the stored value for one invocation and does not
write the configuration file. It must be canonical unsigned decimal text and
is rejected outside `1..32`. `--replay` always uses one worker so each summary
sees the previous summary's context; a stored value is clamped to `1`, while an
explicit value above `1` is rejected. The limit counts only in-flight `/compact`
requests. Discovery and rendering are outside the limit, and promotion remains
sequential. Compacted projects are promoted in deterministic discovery order.

`--dry-run` validates configuration and discovery, but does not start the
daemon, register an invocation lease, dispatch compact/provider work, write
summaries, or promote anything.

Every non-hook manual compact is bound to an authenticated daemon invocation.
The lease is refreshed while work runs. A heartbeat failure, transport
disconnect, lease expiry, or signal begins a drain: no new work is admitted,
queued and active local work settles, and invocation-owned promotion is
cancelled. An atomic pass admitted before cancellation may finish, but later
passes cannot acquire a durable-write permit.

Ctrl+C (`SIGINT`) returns `130`; `SIGTERM` returns `143`. Both statuses are
returned only after the drain proves zero daemon-owned and local work. Repeated
signals keep waiting and print a diagnostic instead of interrupting settlement.
Provider work already accepted by a remote service may continue remotely; the
local guarantee covers LCM-owned queued/active requests, SDK retries, provider
processes/groups, locks, and invocation-scoped promotion only.

If cancellation cannot prove that the managed daemon and its owned provider
work disappeared, LCM does not signal an unknown process or claim success. It
stays in draining state, reports the missing proof, and fails closed. This also
applies when a managed restart cannot prove old-instance disappearance and
replacement identity.
