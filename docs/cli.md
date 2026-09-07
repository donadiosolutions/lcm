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

Storage-backed commands use the backend selected in the authenticated LCM
configuration. SQLite remains the default. With `storage.backend` set to
`postgresql`, reads, writes, native session import, compaction, and promoted
knowledge transfer use that PostgreSQL database. Each selected project must
already be linked to a registered remote project and the local machine must
be registered. Missing bindings or database failures stop the operation;
commands never fall back to a local SQLite database. Backend selection applies
to the configured home and daemon, rather than individual projects.

`lcm export --all`, `lcm promote --all`, and `lcm compact --all` enumerate authenticated locally known
project paths and bindings, including bindings that have no SQLite database or
`meta.json`. Aliases of the same selected project are processed once. This does
not enumerate every project hosted by the PostgreSQL server. An unbound local
project requires `lcm project create` or `lcm project link <project-id>` before
it can be selected with PostgreSQL.

`lcm promote --all` processes the canonical paths from those bindings even when
no local `meta.json` exists. `--verbose` reports each project's counts and
`--dry-run` previews the same selected projects. Progress and summaries go to
stderr. A failed project request is reported and makes the command exit with
status 1; other admitted projects may still complete. Identity or publication
refusals stop the command, and no successful empty-result message hides a failed
scan.

Unbound-project errors explain how to run `lcm project create` or
`lcm project link <project-id>`. Missing local storage errors direct you to
`lcm import` or `lcm import-knowledge <file>` in the intended project. CLI
remedies for these known failures are fixed messages; database diagnostics,
connection strings, and mutable exception text are not printed. Unknown
failures retain a generic diagnostic and exit with status 1.

`lcm export` without `--output` writes only the version-1 promoted-knowledge
JSON document to stdout. Progress and status messages go to stderr. With
`--all`, one file is written per project using a path-derived unique suffix;
`--all --output <file>` is rejected because one file cannot represent multiple
project exports. Any project failure makes the command exit with status 1,
including partial exports; files already completed remain available. Successful
commands exit with status 0. Native session import also exits with status 1
when any session fails.

`lcm sensitive purge` currently refuses PostgreSQL explicitly before deleting
local data. Statistics, status and doctor use the configured backend through
read-only diagnostic snapshots; observing them does not bootstrap or migrate
storage, prune local events, or fall back to a different backend.

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

`lcm export` writes JSON by default. The optional `--format` value accepts
only `json`; unsupported values are rejected before export work or output
writes begin.

An unknown command writes an error and the complete command list to the
terminal, completes both outputs, and then exits with status 1.

## Healthy-daemon routing

The following daemon reads use a migration-free preflight when the managed
daemon is healthy. The shared preflight acquires an authenticated daemon
client for each read:

| Command | Operation performed by the daemon |
|---|---|
| `lcm search <query>` | Search episodic and promoted memory |
| `lcm grep <query>` | Search messages and summaries by exact text or regular expression; optional inclusive `--since` accepts `YYYY-MM-DDTHH:mm:ss[.S{1,3}](Z|+/-HH:mm)` with normalized UTC years 0001-9999, and malformed or out-of-range values return HTTP 400 |
| `lcm describe <nodeId>` | Read summary or stored-memory metadata |
| `lcm expand <nodeId>` | Expand a summary into source detail |

When `--since` is supplied, its value is forwarded to the daemon exactly as
provided. An empty or whitespace-only value is therefore invalid and returns
HTTP 400; omit the option when no lower-bound filter is wanted.

The local inspection commands `machine show`, `project list`, `project show`,
`config get`, `events status`, `events validate`,
`events quarantine`, `sensitive list`, `sensitive test`, and `export` also
complete the authenticated legacy-home migration gate. When a healthy managed
daemon is the owner of a private publication lock, the gate and the selected
read preparation retry only the lock-acquisition callback. Output, exit status,
and export file writes happen once after the callback succeeds. Mutation and
lifecycle commands keep their existing admission and migration behavior.

The first authenticated health probe used to identify a retryable daemon can
take up to two seconds. After the first qualifying contention, retries share a
single two-second monotonic elapsed deadline and poll at most every 50
milliseconds; time spent in process-birth and health checks counts against that
deadline. Wall-clock corrections do not extend or shorten this retry duration.
Bootstrap migration attempts have their own existing bounds. Worktree
reconciliation lock acquisition uses a five-second monotonic retry window and
polls at most every 50 milliseconds; wall-clock corrections do not extend or
shorten that window. Ordinary command I/O plus an in-flight attempt can extend
total command time. Missing, foreign, malformed, stale, or unhealthy
publication evidence still fails closed and exits with status 1. Before the
retry deadline's expiry is recognized, a refusal reports the current typed
contention; after recognized expiry, the first contention for the current
lock-acquisition callback is preserved only if that callback admitted at least
one retry; otherwise, the current contention is reported. Exhausted or
rejected export admission exits unsuccessfully, including with `--output` or
`--all`. An `--all` export may have already written earlier projects when a
later project fails; those outputs remain, and the command exits with status 1.

The process-local catalogue discovery cache uses a monotonic elapsed-time TTL
capped at 1,000 milliseconds; wall-clock corrections do not extend or shorten
it, and identity and state guards still invalidate stale entries.

`lcm search <query> --limit <n>` accepts a positive integer from 1 through
1000 and defaults to 5. The limit is a maximum applied independently to each
selected layer. Episodic candidate recall grows to at least 50 records per
store before the final maximum is applied. Episodic results concatenate
messages first and then summaries, so messages can fill the maximum before a
summary appears. `--tag <tag>` filters promoted entries by all supplied tags;
episodic history remains unfiltered. Use `--layer promoted` for tag-only
recall. All required promoted tags are applied before the caller's result
maximum, so the maximum counts eligible records. Omitted or empty tags do not
filter either layer. Values outside this
range or that are not integers are rejected by the daemon with HTTP 400
(`invalid limit`).

`lcm expand <nodeId> --depth <n>` accepts any positive integer and defaults to
`1`; no upper bound is imposed. Malformed explicit depths are rejected by the
daemon with HTTP 400 (`invalid depth`) before project admission. The direct
daemon request body must be a JSON object; top-level `null`, arrays, and other
JSON primitives receive HTTP 400 (`invalid request body`) before project
admission. Malformed JSON syntax keeps the existing server error behavior.

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
An existing publication directory without a journal, including an empty
directory, is incomplete evidence, not the legacy SQLite no-evidence case.
Removal or inode rebinding during admission is unsafe storage. This response
buffering applies to read routes; `lcm store` remains a mutation.

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

The configuration read used by `lcm doctor` and by connector transport
resolution is also lock-free and authenticated: two descriptor-bound snapshots
of `config.json` and two reads of the terminal publication journal must agree
before the bytes are trusted. Each journal admission retains the authenticated
publication-directory identity through journal reading and evidence
enumeration, and rejects removal or rebinding. When a private canonical `.lcm`
root is present, both readers open it without following a symlink and retain
that directory descriptor across both snapshots and both publication
admissions, rejecting a root replacement or unsafe publication root. A legacy
SQLite installation with an absent root, or a non-private root without
publication evidence, remains read-compatible without a retained descriptor;
every boundary rechecks for a new admissible root or publication evidence and
fails closed if either becomes unsafe. Any subsequent configuration write,
including an explicit transport
preference, still takes the normal authenticated mutation lock and remains fail
closed if that lock is held by another operation.

Doctor's map validation and worktree inspection are observational. It reports
invalid or ambiguous mappings without normalization, duplicate removal, or
reconciliation writes. Existing-daemon health is bounded and authenticated;
readiness is not inferred from public liveness. Missing installed version or
packaged runtime digest, mismatched identity, and unreadable credentials leave
managed-daemon readiness unverified. Run doctor from the installed `lcm.mjs`
artifact; reinstall LCM if that artifact is unreadable or damaged.

Doctor does not acquire publication mutation locks, wait for a lock holder to
repair state, or retry lifecycle stages. Use `lcm daemon restart` for an
explicit lifecycle repair, `lcm install` for Claude Code settings/hooks/managed
guidance, or `lcm connectors install <agent>` for another connector. Review and
resolve project mapping findings explicitly, then rerun doctor. There is no
automatic-repair mode.

`lcm install` uses bounded publication admission for its preflight
migration and each installer lock-taking stage, including daemon lifecycle
publication assertions. A retry re-attempts only a lock-acquisition callback;
the callback body has not run when contention is raised, so prompts, settings
writes, skill installation, and daemon startup are not repeated. The shared
window is armed at the first qualifying contention, lasts up to two seconds of
monotonic elapsed time, and polls every 50 milliseconds. Wall-clock corrections
do not extend or shorten this publication retry duration. Bootstrap-lock retries
remain unchanged and
may add a bounded overshoot of up to one second when both locks contend.
Identity, token, process-birth, health, entrypoint, version, backend, or
runtime-digest mismatches still fail closed and exit with status 1. Before the
retry deadline's expiry is recognized, a refusal reports the current typed
contention; after recognized expiry, the first contention for the current
lock-acquisition callback is preserved only if that callback admitted at least
one retry; otherwise, the current contention is reported.

Lock-free configuration preparation also rejects a configuration or
publication journal that changes between its two authenticated snapshots. Once
the active publication has settled, rerun `lcm install` manually. This drift
refusal is not retried automatically, and rerunning the installer does not imply
that unrelated installation failures have resolved.
The refusal is reported as a stable diagnostic so you can rerun once concurrent publication activity has settled.

Before `lcm install` reuses a healthy daemon identity for those retries, it
revalidates the complete configuration snapshot and terminal publication
journal after the authenticated health response and its JSON body have been
read. A private canonical `.lcm` root is retained across that exchange and its
exact directory entry is checked again around the final reads. If any of that
evidence changes, the captured identity is discarded; rerun `lcm install` once
publication settles if lock contention remains. A legacy non-private SQLite
root without publication evidence keeps its existing read compatibility.

## Observational diagnostics

`lcm stats`, `lcm stats --pool`, `lcm status`, and `lcm doctor` inspect the
selected SQLite or PostgreSQL backend without starting or restarting the
daemon. They skip legacy-home bootstrap migration and publication-convergence
retries. These commands do not register machines or projects, repair settings
or identity maps, migrate schema, prune orphan event sidecars, or create
missing project databases. Repairs remain explicit operator actions.

The CLI, local MCP `lcm_stats`, and daemon `/stats`, `/stats/pool`, and `/status`
surfaces use the same sanitized backend diagnostic snapshot. It includes the
selected backend, publication admission, verified TLS readiness where
applicable, schema/migration and extension readiness, safe project and machine
identifiers, pool observations, and local outbox counts when available.
Configuration alone never proves readiness. Unobserved subfacts are
`unverified`, failed observations are `unavailable`, and facts that do not apply
to the selected backend are `not-applicable`; verified facts are `ready`.

Text output shows these readiness fields even when statistics are unavailable,
including search readiness, pool origin and counts, project scope, machine
identity, local outbox delivery counts, and a fixed next action. It never
renders a database error or arbitrary configuration value as guidance.

The `project` snapshot field distinguishes `aggregate` observations from a
`selected` project. A ready selection includes its admitted PostgreSQL UUID
or SQLite project hash and, when available, the associated local hash used
for outbox counts. No project paths are printed. An unknown selection is
reported as unavailable and never falls back to aggregating all projects.
A selected remote UUID without an observed local binding leaves the local
outbox unverified. Failures retain the requested scope but discard identifiers
when their observation cannot be trusted.

SQLite does not require machine registration: an absent machine identity is
`not-applicable`. If a machine UUID is present and validated, it is shown as
an identity observed in this configured home. PostgreSQL still requires its
machine identity to be verified. Aggregate project scope means no individual
project ID was selected; an absent ID is not evidence of a missing project.

| Snapshot state | Meaning and next action |
|---|---|
| `healthy` | All required readiness observations verified. |
| `degraded` | Readiness verified, but the observed pool still reports a recovery failure condition. Inspect the backend service and repeat the diagnostic after recovery. |
| `unavailable` | Storage could not be safely read or a required observation could not be verified. Check configuration, service readiness, and the fixed guidance in the output. |
| `permission-denied` | A trusted local or database permission failure prevented observation. Restore the intended access or runtime grants, then retry. |
| `timeout` | Collection reached its deadline or the caller cancelled it. Check service responsiveness and retry. |
| `stale-publication` | Publication evidence is unresolved or inconsistent, or authenticated evidence changed during collection. Preserve the evidence and follow the [publication recovery guidance](backend-publication.md#journal-less-publication-evidence). |

Backend snapshot collection has a default deadline of 2000 milliseconds and
honors caller cancellation. SQLite project and event-sidecar reads share one
owned child process for the complete snapshot, so additional projects do not
incur a new process launch for every database. All discovered sidecars are
considered within that same deadline. A timeout is reported even if a probe stalls;
cleanup does not replace the primary failure classification. A diagnostic
probe owns and closes its own resources, while a daemon's shared pool stays
open. `lcm stats --pool` reports safe pool counts and whether they came from
the daemon or a diagnostic probe. PostgreSQL observations include configured
maximum, total, idle, and waiting connections and the observed failure latch.
Daemon pool counts are observed independently before the remote probe starts.
They may remain available when that probe times out or fails, provided the
publication and configuration still authenticate. A ready pool observation
means its counts were available; it does not establish remote backend health.
The snapshot retains its failure classification and recovery action.
Unavailable counts are omitted rather than reported as zero.

Numeric statistics such as token totals, compression, recall counters, and
local outbox counts are included only when observed. Partial or unavailable
remote metrics do not become empty-project totals. Diagnostic output contains
no recalled-text previews (`topRecalled`), transcript or memory payloads, raw
errors, SQL values, connection URLs, role names, CA paths, or arbitrary local
paths. Verbose output follows the same boundary.

Publication and configuration are authenticated before and after asynchronous
probes. If their witnesses differ, the result is `stale-publication` and the
collected metrics are discarded. This is an optimistic observation of matching
evidence; it is not a transaction-wide authority or consistency guarantee.
The snapshot takes no publication mutation lock and writes no authority,
configuration, or witness files.

SQLite statistics open existing databases read-only after authenticating the
LCM root, project directories, and database leaves. The root and project
directories must be owner-held with exact mode `0700`. Missing databases remain
missing. An old or unreadable schema is reported without migration. Reads
include committed data in the live WAL; SQLite may create necessary `-wal` or
`-shm` read-coordination artifacts. This engine bookkeeping does not authorize
checkpointing, journal-mode changes, repair, or sidecar deletion. If a safe
read requires durable content changes, the diagnostic reports `unavailable`.

The SQLite pathname API still leaves a narrow same-account swap-and-restore
race between identity checks. Authentication checks surround opening and
reading, but do not provide isolation from another process with the same
filesystem authority. Event scans likewise preserve existing sidecars and
report skipped or failed observations without pruning them.

`lcm status` reports verified daemon details, available numeric project counts,
and the same backend diagnostic snapshot. If authenticated daemon health is
available but its status request fails, the daemon remains reported as up and
the command performs a fresh local diagnostic observation. The output identifies
that fallback; backend readiness can change between the two observations.
It omits the former `lastIngest`,
`lastCompact`, and `lastPromote` fields: project metadata values are not part of
the diagnostic allowlist. A missing or unreadable project has no numeric
project object, so an unavailable observation cannot be confused with an
observed empty database.

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

Automatic promotion records its most recent timestamp in project metadata on a
best-effort basis. Metadata is bounded to 1 MiB and published atomically with
0600 permissions, including when tightening a legacy file that was more
permissive. Invalid, unreadable, or untrusted metadata is left unchanged and
does not undo promoted memories; promotion counts and results are independent
of this metadata update. If reopening the authenticated metadata parent fails
directly because the process or system file-descriptor limit is exhausted
(`EMFILE` or `ENFILE`), or because the target filesystem has no space
(`ENOSPC`), LCM skips the metadata update and returns the completed promotion
result. Parent absence, symlink loops, non-directory components, ownership or
mode rejection, and other topology failures remain fail-closed and return an
error. `--dry-run` never writes metadata. On platforms with a POSIX UID, the
existing metadata file must be owned by the current UID; where UIDs are
unavailable, that ownership check is skipped.

`lcm compact --all` reports each selected project that it cannot open, prepare, or
scan as a failure in the Compact phase while continuing with readable projects.
These failures produce a nonzero exit status and are not reported as “Nothing to
compact.” A failed scan does not mark any session as processed. Back up the
reported project database, resolve its storage or schema error, and rerun the
command; the still-eligible sessions will be discovered again.

### Managed-daemon recovery

Use the public commands for daemon recovery:

```bash
lcm doctor
lcm daemon restart
```

`lcm doctor` observes the daemon, hooks, connector registration, static MCP
setup, and summarizer configuration. Its MCP protocol capability check is
reported as not probed: doctor does not spawn an MCP server or perform a live
handshake. It never starts, stops, or repairs a daemon. `lcm daemon restart`
validates the effective configuration, asks the host service manager to replace
the exact LCM service, and waits for authenticated health before returning.
After changing configuration, run the restart command once; do not start a
second daemon to work around a health failure.

When a failed start or restart reports a newly created daemon temporary
directory with clipped owner permissions, the CLI retains the mapped recovery
command and the trusted lifecycle guidance on one line:

```text
lcm daemon unavailable (startup-failure); run 'lcm daemon restart' or 'lcm doctor'. newly created daemon temp directory lacked required owner permissions, was removed, and retry should use an owner-preserving umask such as 0077
```

Follow the [managed-daemon temporary-storage recovery](daemon-temporary-storage.md)
steps before retrying under an owner-preserving umask such as `0077`.

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

On Linux, a normal host-context `lcm install` records an owner-only,
checksummed witness that the canonical HOME parent was observed as host UID 0.
A `PrivateTmp` user namespace may use that direct-host-root-observed,
integrity-checked historical evidence only when its parent appears as the
kernel overflow UID and `/proc/self/uid_map` proves host UID 0 is unmapped.
The canonical HOME and parent paths, device/inode identities, parent mode, and
parent ctime must still match. Missing, malformed, unsafe, stale, or changed
evidence fails closed.

When the witness is genuinely absent (no file at all), a constrained
namespace can bootstrap it without a host-context install. LCM asks the
per-user service manager, through the fixed `/usr/bin/systemd-run --user
--wait --collect --pipe --quiet` launcher with no mount, PID, or system-scope
properties, to run a bounded same-UID Node helper that opens the canonical
HOME parent without following symlinks and reports its owner, identity, mode,
ctime, and its own `/proc/self/uid_map`. The helper's TMPDIR is the
authenticated HOME, never host `/tmp`. LCM accepts that evidence only when
the helper's namespace maps UID 0 to host UID 0, the parent owner is UID 0,
and the device, inode, mode, and ctime equal the caller's retained
observation; it then records the witness under the normal publication locks.
A missing user manager, timeout, signal, nonzero exit, any stderr output,
malformed or non-canonical output, a non-root helper namespace, a non-root or
overflow owner, or a topology mismatch fails closed. An existing witness that
is malformed, unsafe, stale, or unreadable is never replaced through this
helper; remove it deliberately or rerun `lcm install` from a normal host
context.
This witness is not a secret, MAC, or cryptographically unforgeable root
credential. Same-UID processes remain outside the filesystem security boundary
and can edit or delete the witness along with other runtime state.

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
summaries, or promote anything. SQLite preview discovery opens only existing
authenticated database files and does not run schema migrations or change
`PRAGMA user_version`. A missing database is not created. A schema that cannot
be read is reported as a discovery failure. Unresolved legacy worktree identities
with a separate database are refused explicitly; preview never merges or
removes that data. Resolve the normal worktree reconciliation first, or use the
recovery/migration owner when native archive facts require it.

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
replacement identity. Replacement proof requires the packaged runtime digest
of the invoking CLI to exactly match the new daemon. When that digest is
unavailable, including source-style CLI execution without packaged build
metadata, the drain remains unproved and reports the missing identity proof.
