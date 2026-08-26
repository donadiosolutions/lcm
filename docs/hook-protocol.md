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

**Response:** Normal capture exits with code `0`. This hook runs on every tool
call and must be fast; it does no network I/O and only writes to a local
sidecar SQLite database. The local event is appended before any selected-state
publication admission is attempted. After that durable boundary:

- missing publication evidence is treated as a successful best-effort outcome
  (`0`) and does not emit a failure diagnostic;
- typed private publication-lock contention is also a successful best-effort
  outcome (`0`), while its ordinary typed error is recorded safely;
- malformed, tampered, unsafe, mismatched, or unresolved publication evidence
  remains fail-closed for selected-state work. After the local event is
  preserved, the hook stops before selected-state mutation, records the fixed
  diagnostic below, and returns code `0` with a protocol-safe JSON
  `systemMessage` on stdout. This is a successful observer-hook protocol
  result, not permission to continue selected-state work and not a hook
  process failure.

If publication admission fails before the local event can be durably appended,
the hook does not report a successful observer result; the direct top-level CLI
path retains its fixed stderr diagnostic and exit code `1`.

The fixed diagnostic is:

```text
lcm: backend publication admission blocked; preserve the evidence, run 'lcm doctor', and resolve the authenticated publication before retrying.
```

Raw publication messages, causes, stacks, paths, URLs, credentials, and journal
contents are never included in that user-facing line.

For a post-enqueue refusal, stdout contains exactly one JSON property:

```json
{"systemMessage":"lcm: backend publication admission blocked; preserve the evidence, run 'lcm doctor', and resolve the authenticated publication before retrying."}
```

The `daemon_port` payload field is ignored. PostToolUse never sends the daemon
bearer token or captured event data to a payload-selected listener; queued
events are collected by the daemon's bounded background processing instead.

### Codex native PostToolUse capture

The Codex connector uses the following exact hook entry in the canonical
`~/.codex/hooks.json` file (or the equivalent path selected by the existing
connector install scope):

```json
{
  "PostToolUse": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "lcm post-tool --client codex"
        }
      ]
    }
  ]
}
```

The `matcher`, hook `type`, and command are structural contract values. The
installed connector may also retain its timeout and status-message metadata,
but the command must remain exactly `lcm post-tool --client codex`; extra
arguments do not satisfy the contract. Install it with:

```bash
lcm connectors install codex
lcm connectors doctor codex
```

The `--global` option selects the existing global connector scope; no new
configuration option is required for native command capture, and the 2,000-
character adapter bound is fixed rather than configurable.

Codex sends native tool names `functions.exec` and `functions.exec_command`.
For those names, lcm accepts only the bounded semantic command (`command`, or
`cmd` when `command` is absent) and a direct status projection. `tool_output` is
checked before `tool_response`; status fields are considered in this order:
`isError`, `is_error`, `exit_code`, and `exitCode`. Boolean values are used
directly, while finite numeric exit codes map zero to success and nonzero to an
error. A valid false or zero value is authoritative. Nested or invalid values
are ignored.

The adapter does not persist raw Codex responses, stdout, stderr, or unknown
fields, and it does not infer file events from shell text or unrecognized
file-like fields. The existing event truncation and scrubbing pipeline still
runs on derived event data. Commands whose trimmed text begins with `lcm
store` are suppressed to prevent LCM's own writes from feeding back into
passive learning.

`lcm connectors doctor codex` performs two checks for the targeted Codex
connector. It first verifies the exact structural hook contract above. Only
when that check passes does it run the native-exec functional probe. The probe
is pure and in-memory: it exercises normalization and extraction without
invoking the PostToolUse handler, opening an EventsDb, appending sidecar
events, writing hook files, or creating a database. A structurally absent or
incomplete hook never reports functional success; its functional result is
reported as:

```text
Codex: native exec capture functional check skipped
```

When the exact structure and the pure probe both pass, doctor reports:

```text
✓ Codex: PostToolUse hook installed
✓ Codex: native exec capture functional
```

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
