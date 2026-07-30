# Claude Code Hook Protocol

This document describes the stdin payload fields that Claude Code delivers to each lcm hook command.

All hooks receive a JSON object via stdin. lcm hooks are invoked as shell commands:

```
lcm <hook-command> < <stdin-json>
```

## Local passive-event durability

Passive-event capture is an explicit offline boundary. `PostToolUse` and
`UserPromptSubmit` commit only to the per-project SQLite sidecar under
`~/.lcm/events/`; they never open PostgreSQL, resolve PostgreSQL credentials, or
wait for a network request. Daemon notification remains best-effort and is not
part of the hook commit.

Every captured row has a versioned local delivery envelope:

| Envelope field | Purpose |
|-------|-------------|
| `event_uuid` | Stable UUID used for idempotent remote insertion and exact replay |
| `event_version` | Compatibility version for decoding the event |
| `machine_id` | Durable registered machine UUID, or assigned before first delivery when capture occurred before registration |
| `machine_sequence` | Installation-global, 19-digit exact-`bigint` sequence used for per-machine ordering |
| `type` and payload columns | Scrubbed event type plus session sequence, category, data, priority, source hook, predecessor, and capture time |
| delivery state and timestamps | Durable claim, retry, replication, acknowledgement, quarantine, and remote-prune checkpoints |

Local promotion may add predecessor correlation while an envelope is still
pending. That metadata is frozen atomically when the first delivery claim
begins, so a later local correlation pass cannot change an envelope that may
already exist in PostgreSQL.

The sequence allocator is a separate local SQLite file,
`~/.lcm/events/.machine-sequence.sqlite`. Reservation and checkpoint update are
one transaction. A crash between reservation and sidecar insertion can leave a
gap, but no committed event can reuse a sequence.

Legacy sidecars upgrade transactionally. Immutable legacy content derives a
deterministic compatibility UUID, existing local `processed_at` metadata is
preserved, and delivery starts independently. Local passive-learning
processing does not imply PostgreSQL acknowledgement and cannot prevent later
delivery.

This release decodes envelope version `1`. A positive but unsupported version
is quarantined locally before any network insertion, remains visible through
`lcm events quarantine`, and can be replayed by exact UUID after compatible
software is installed. Later machine-sequence events may continue because the
quarantine is an explicit terminal checkpoint, not a retryable outage. A drain
that encounters an already-remote unsupported claim applies the same
quarantine policy instead of invoking an incompatible effect decoder.

The staged replication worker owns all PostgreSQL I/O. It resolves uncertain
insertion, application, and pruning through exact readback before advancing the
local checkpoint. Hooks are therefore unchanged by PostgreSQL outages: they
commit locally and return successfully while the durable backlog waits.

## PreCompact Hook

**Command:** `lcm compact --hook`

Invoked by Claude Code before it runs its built-in compaction. When the admitted
daemon is available, lcm writes a DAG summary and may return summary text on
stdout. The hook exits `0`, so Claude Code can continue its own compaction.

The installed command has no timeout or retry overrides. Its wrapper does not
resolve PostgreSQL connection credentials before entering the fail-open hook
path. If the configured backend is unavailable, its runtime credentials are
absent, or daemon admission fails, the hook exits `0` with no output and does
not block Claude Code's compaction. A customized hook command with explicit
`--timeout-ms` or `--retry-*` overrides reads only the secret-free LLM request
policy projection needed to validate those flags; it still does not resolve
PostgreSQL credentials before dispatch.

This fail-open behavior is specific to the installed best-effort hook. Manual
CLI operations, daemon startup and restart, and MCP request admission continue
to resolve the full effective configuration and fail closed when required
credentials or backend support are unavailable.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory of the Claude Code session |
| `hook_event_name` | string | `"PreCompact"` |

**Response:** Exit code `0`, with summary text on stdout when lcm compaction
succeeds or no output when lcm defers to Claude Code.

## SessionStart Hook

**Command:** `lcm restore`

Invoked at the start of a Claude Code session. lcm restores recent summaries and promoted memory, injects them as a user message prefix, and prints a `<context>` block on stdout.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `hook_event_name` | string | `"SessionStart"` |

**Response:** Exit code `0`. Context is injected via stdout (printed as a `<context>` block that Claude Code prepends to the session).

## SessionEnd Hook

**Command:** `lcm session-end`

Invoked when the Claude Code session ends. lcm ingests the completed session transcript and triggers passive-learning event promotion.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `hook_event_name` | string | `"SessionEnd"` |

**Response:** Exit code `0`. Runs best-effort; failures do not block session exit.

## UserPromptSubmit Hook

**Command:** `lcm user-prompt`

Invoked on each user prompt. lcm searches memory for relevant hints and injects a `<memory-hints>` block into the prompt.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `prompt` | string | The user's prompt text |
| `hook_event_name` | string | `"UserPromptSubmit"` |

**Response:** Exit code `0`. Hints are injected via stdout when relevant matches are found.

## PostToolUse Hook

**Command:** `lcm post-tool`

Invoked after every tool call. lcm extracts structured events (decisions, errors, git ops, etc.) and writes them to the passive-learning sidecar database.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `tool_name` | string | Name of the tool that was called |
| `tool_input` | object | The tool's input arguments |
| `tool_response` | any | The tool's response object |
| `tool_output` | string | Plaintext output (if available) |
| `hook_event_name` | string | `"PostToolUse"` |

**Response:** Always exit code `0`. This hook runs on every tool call and must be fast; it does no network I/O and only writes to a local sidecar SQLite database.

The `daemon_port` payload field is ignored. PostToolUse never sends the daemon
bearer token or captured event data to a payload-selected listener; queued
events are collected by the daemon's bounded background processing instead.

## SessionSnapshot Hook

**Command:** `lcm session-snapshot`

An optional periodic hook that incrementally ingests the live session transcript between `SessionEnd` events. This is used for long-running sessions where you want memory to be updated without waiting for the session to end. Codex uses this command on `Stop` for rolling snapshots and on `PreCompact` to force-ingest deltas immediately before manual or automatic compaction.

Snapshot ingestion is skipped when daemon bootstrap cannot verify the configured daemon PID, installed version, and exact loopback listener. This prevents transcript paths, request bodies, and bearer credentials from being sent to an occupied but unverified port.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `transcript_path` | string | Path to the live JSONL session transcript |
| `hook_event_name` | string | `"SessionSnapshot"` or `"PreCompact"` (if provided) |

**Response:** Exit code `0`.

## Auto-heal

All lcm hooks self-repair on each invocation: before dispatching, `validateAndFixHooks()` checks that all required hook entries remain registered in `~/.claude/settings.json` and re-adds any missing entries. This means lcm hooks survive `claude settings reset` or manual edits to the settings file.
