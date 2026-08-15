# Passive Learning

Passive learning captures insights from your Claude Code sessions automatically — no manual `lcm_store()` calls needed. It observes tool usage patterns, user decisions, and session events, then promotes high-signal observations into cross-session memory.

## How It Works

### Event Capture

Two hooks capture events during your session:

- **PostToolUse** — fires after every tool call. Extracts structured metadata (tool name, command, file path) from tool inputs. Never captures raw tool output. For Codex, the native `functions.exec` and `functions.exec_command` calls are adapted into the existing Bash event semantics.
- **UserPromptSubmit** — fires on each user prompt. Detects decisions ("always use X"), role statements ("I'm a data scientist"), and intent patterns.

Events are written to a **sidecar SQLite database**
(`~/.lcm/events/<project-hash>.db`) at <10ms cost. This is separate from the
main LCM database—if the daemon or PostgreSQL is unavailable, events are safely
queued. Hooks never wait for PostgreSQL and never send captured data over the
network.

Each captured row also carries a backward-compatible delivery envelope:

- a stable event UUID and envelope version;
- the registered machine UUID when it is available;
- an installation-global, exact-`bigint`, monotonically allocated machine
  sequence;
- the event type and structured payload fields;
- capture, retry, claim, acknowledgement, quarantine, and pruning timestamps.

The global sequence checkpoint is stored at
`~/.lcm/events/.machine-sequence.sqlite`. Sequence reservation commits before
the sidecar insert, so a crash may leave a harmless gap but can never reuse a
committed value. Legacy sidecars receive deterministic compatibility UUIDs and
new global sequences during their transactional schema upgrade.

### What Gets Captured

#### Codex native command capture

The Codex connector recognizes only PostToolUse payloads marked with
`client: "codex"` whose `tool_name` is exactly `functions.exec` or
`functions.exec_command`. The adapter accepts the string `tool_input.command`
first, or the string `tool_input.cmd` when `command` is not a string. Other
command-like, path-like, and file-like fields are ignored; a blank `command`
does not fall back to `cmd`.

The adapter passes only bounded semantic information into the existing Bash
extractor:

- A command is limited to 2,000 characters at the adapter boundary; longer
  commands are clipped with `...` before event classification.
- The existing event-data truncation and event scrubbing still run after
  classification, including the normal sensitive-path redaction rules.
- Status is read only from direct, top-level fields. `tool_output` wins over
  `tool_response` when it contains a valid status. Within either object, the
  precedence is `isError`, `is_error`, `exit_code`, then `exitCode`; boolean
  values are used directly and finite numeric exit codes treat zero as
  success and any other value as an error. Invalid, nested, string, `NaN`, and
  infinite values are ignored.
- The raw Codex response, stdout, stderr, and unknown output fields are never
  copied into the normalized event. Shell text is not parsed into file events.
- A command whose trimmed text begins with `lcm store` is suppressed so LCM's
  own storage activity cannot create a passive-learning feedback loop.

Only events recognized by the existing Bash extractor are queued. The command
itself is not stored as a transcript.

| Category | Examples | Priority |
|----------|----------|----------|
| Decisions | User answers to AskUserQuestion, "always use TypeScript" | 1 (immediate) |
| Plan approvals | EnterPlanMode / ExitPlanMode events | 1 (immediate) |
| Errors | Bash commands that fail (isError: true) | 1 (immediate) |
| Git operations | Commits, merges, branch switches | 2 (batch) |
| Environment | `npm install`, `pip install`, `brew install` | 2 (batch) |
| File access | Read/Edit/Write/Glob/Grep with file paths | 3 (pattern-only) |
| MCP tools | Which MCP tools are used (tool name only) | 3 (pattern-only) |
| Skills | Which skills are invoked | 3 (pattern-only) |

### What Is NOT Captured

- Raw tool payload contents such as file contents, command stdout/stderr, and
  unknown Codex response fields (only bounded semantic metadata and brief user
  answers are stored)
- Sensitive file paths (`.env`, `.ssh/`, `credentials`, `.npmrc`)
- LCM's own `lcm_store` calls (prevents feedback loops)

### Automatic Queue Processing

Captured events are normally processed by the daemon in the background. Hooks write to the sidecar database, notify the daemon that a project has queued work, and then return without waiting for promotion.

The daemon uses bounded triggers so passive learning stays fresh without making hooks expensive:

- Priority 1 events schedule processing after about 250 ms.
- Normal events are debounced for about 3 seconds.
- Active projects with 10 or more queued events use the near-immediate path.
- A startup sweep and a 5-minute periodic sweep scan up to 20 metadata-backed sidecars per pass.
- Active-project background processing promotes at most one batch per pass, then requeues remaining work.

While a larger passive-learning batch is running, the daemon can remain alive
and own its configured listener even if bounded health checks cannot complete.
Lifecycle admission preserves that exact likely-LCM process and its PID/token
state instead of signaling it or starting a replacement, and reports a
busy/unavailable warning with `connected: false`. Let the current batch finish,
then retry the command. If health remains unavailable after processing should
be idle, run `lcm doctor`, then `lcm daemon restart`; do not stop a process
manually.

If a queued event's recorded working directory is unavailable, the daemon
keeps its sidecar events pending and records the missing-directory evidence in
that sidecar. It requires three observations at least five minutes apart before
parking local promotion. The evidence has no expiry window: it survives daemon
idle restarts and converges even when a large installation revisits a sidecar
only every 20 minutes. Until the third observation, no local `processed_at`
checkpoint is advanced and no hook-error-ledger entry is added.

The three-observation threshold and five-minute minimum spacing are fixed
safety constants; they are not configurable in `~/.lcm/config.json`.

After confirmation, the daemon durably parks **local promotion**, not the
events themselves. The sidecar records its parked state but leaves every event
unprocessed, preserving event payloads, historical rows, and independent
delivery state exactly as captured. While the cwd remains absent, later sweeps
perform only a cheap availability/state check and return the terminal parked
outcome; they do not rescan the events for promotion or add repeated errors.
`lcm events promote --all` reports the same terminal state for a metadata-backed
sidecar.

If the directory returns at any later time, normal promotion clears the durable
missing-CWD state and promotes the preserved unprocessed events. This makes a
long mount outage, workspace rebuild, or rename reversible even after it was
previously parked. A sidecar that no longer exists is treated as terminal
immediately because it contains no local work to preserve.

Only a genuinely missing cwd (`ENOENT`, including an absent ancestor reported
as `ENOTDIR`) enters this confirmation flow. Permission failures such as
`EACCES`/`EPERM`, malformed paths, and unreadable or corrupt sidecars fail
closed: they are reported to the caller and do not create parking evidence,
advance `processed_at`, or otherwise consume queued events.

`lcm search` stays read-only: it searches already promoted memory and does not process queued sidecar events.

### Three-Tier Promotion

When the daemon processes queued events, it applies three promotion tiers:

**Tier 1 — Immediate promotion** (priority 1): Decisions, plan approvals, and error→fix pairs are promoted directly with high confidence (0.4–0.7).

**Tier 2 — Batch promotion** (priority 2): Git and environment events are promoted with moderate confidence (0.3).

**Tier 3 — Pattern reinforcement** (priority 3): File access and tool usage events start as low-confidence signals. A one-off event is skipped unless it matches an existing entry in the promoted store. To bootstrap a new promotion without a seed, the same pattern must appear at least three times across at least two distinct sessions in recent sidecar history. That reinforcement boost only applies on the insert path for a new memory, not when re-confirming an already-promoted entry.

### Error→Fix Correlation

When a tool error is followed by a successful command with a matching prefix (within 20 events), the system correlates them as an error→fix pair. These are tagged `category:solution` and promoted with higher priority.

### Manual Backlog Drain

Automatic processing should keep active projects near zero queued events. If `lcm doctor` reports a large backlog, or you are debugging daemon downtime or stale sidecars from projects you have not opened recently, drain all metadata-backed sidecars manually:

```bash
lcm events promote --all
```

Sidecars that are missing project metadata are reported separately because their hash cannot be reversed back to a project path automatically.

### Separate PostgreSQL event delivery

When PostgreSQL storage is configured, issue #91 provides a separate explicit
event-delivery worker for the local outbox. It is not started automatically by
the daemon and is distinct from the daemon's selected `ProjectStorage` route
consumer. The worker:

1. acquires and renews the existing #90 fenced drain lease;
2. claims a ready local sequence prefix in a bounded batch;
3. inserts envelopes idempotently into the existing
   `lcm.passive_event_inbox`;
4. applies remotely claimed events and their `applied` transition in one short
   PostgreSQL transaction;
5. resolves uncertain commits by exact inbox readback;
6. durably acknowledges the local row after remote `applied` proof; and
7. prunes only the exact applied inbox row, recording local prune completion
   after deletion or missing-row proof.

Per-machine ordering is preserved. Independent machines can progress
concurrently. Retry delay uses bounded exponential backoff with deterministic
jitter, stale claims are recoverable, and poison events remain inspectable
until exact replay.

The staged operator commands are:

```bash
lcm events status [--json]
lcm events validate [--limit 100] [--json]
lcm events quarantine [--limit 100] [--json]
lcm events replay <event-id> [--machine <machine-id>] [--json]
```

They require PostgreSQL configuration, a registered machine, and a linked
remote project. `status` and `validate` expose the durable checkpoints;
`quarantine` lists local compatibility failures and remote poison rows; and
`replay` retries one exact local or remote event. These commands do not start
replication. CLI/import-export remains #618-owned; passive-learning stats and
doctor presentation remain #619-owned.

### Learned Insights

On SessionStart, recently promoted passive insights are surfaced in a `<learned-insights>` block. This closes the feedback loop — the system learns from your sessions and applies those learnings in future ones.

## Configuration

Promotion-confidence thresholds are configurable in `~/.lcm/config.json`
under `compaction.promotionThresholds`. The missing-CWD confirmation constants
described above are intentionally not part of this configuration:

```json
{
  "compaction": {
    "promotionThresholds": {
      "eventConfidence": {
        "decision": 0.5,
        "plan": 0.7,
        "errorFix": 0.4,
        "batch": 0.3,
        "pattern": 0.2
      },
      "reinforcementBoost": 0.3,
      "maxConfidence": 1.0,
      "insightsMaxAgeDays": 90
    }
  }
}
```

When a pattern crosses the reinforcement threshold, `reinforcementBoost` is added to the base pattern confidence, capped by `maxConfidence`, only when bootstrapping a new promoted entry.

## Data Storage

- **Sidecar DB**: `~/.lcm/events/<sha256-of-project-path>.db`
  - Per-project SQLite database in WAL mode
  - Local promotion state and remote delivery state are independent
  - Processed events are pruned after 7 days only when remote delivery is
    acknowledged and any remote applied row is proven pruned
  - Unprocessed and replayable events are never discarded by age or row-count
    retention guards; a maintenance diagnostic records guard breaches
  - Schema versioned for future migrations (currently v5)

- **Machine sequence DB**: `~/.lcm/events/.machine-sequence.sqlite`
  - Shared by every local project sidecar
  - Reserves exact PostgreSQL-`bigint` sequence values transactionally
  - Allows gaps after a crash, but never reuse

- **Remote inbox**: `lcm.passive_event_inbox`
  - Existing #90 project-scoped queue with machine/event and machine/sequence
    uniqueness
  - `pending`, `claimed`, `retry`, `applied`, and `quarantined` states
  - Not an offline read replica or a dual-write project-memory cache

- **Error log**: `error_log` table in each sidecar DB
  - Records hook errors with timestamp and session ID
  - Pruned after 30 days on SessionStart
  - Queryable by `lcm doctor` for health diagnostics

- **Promoted store**: Events promoted via `deduplicateAndInsert()` into the main LCM database
  - Tagged with `source:passive-capture` and `hook:<PostToolUse|UserPromptSubmit>`
  - Searchable via `lcm search` and `lcm grep`
  - Deduplicated via BM25 matching

## Negative-Match Guards

The UserPromptSubmit extractor includes guards against false-positive decisions. Phrases like "don't worry", "never mind", "not sure", "doesn't matter", and "up to you" suppress decision extraction to prevent noise.

## Recovery

| Scenario | Behavior |
|----------|----------|
| Clean session end | Events promoted via `/promote-events` |
| Ctrl+C (SIGINT) | Stop hook triggers best-effort promotion |
| Pre-compact | Events promoted before context is compacted |
| Daemon available during capture | Hooks notify `/promote-events/notify`; daemon processes queued events in the background |
| Daemon unavailable | Events queued in sidecar, processed by startup/session lifecycle drains or manual remediation later |
| PostgreSQL unavailable | Hooks continue local commits; selected project-storage batches fail closed and the local outbox remains retryable |
| Hard kill (SIGKILL) | Events survive in sidecar, scavenged on next SessionStart |
| Stale sidecars in other projects | `lcm events promote --all` drains all metadata-backed sidecars |
| Recorded cwd remains unavailable for three observations at least five minutes apart | Durable reversible parking state is recorded; event rows stay unprocessed and retain payload, history, and delivery state |
| A durably parked cwd returns | Parking state is cleared and the preserved unprocessed backlog is promoted normally |
| Unprocessed cap or age guard exceeded | Events remain durable; a maintenance diagnostic reports the retained backlog |
| Worker crashes after inbox insert | Exact immutable readback proves whether insertion committed |
| Worker crashes during apply | PostgreSQL transaction rollback or exact `applied` readback resolves the outcome |
| Worker crashes after local acknowledgement | The next drain retries exact applied-row pruning |
| Poison event | Event remains quarantined and inspectable until exact-ID replay |
| Error log pruning | Entries older than 30 days removed on SessionStart |

## Observability

### `lcm doctor`

When passive learning hooks are installed, `lcm doctor` includes a "Passive Learning" category with sidecar health checks:

| Check | What it monitors |
|-------|-----------------|
| `events-capture` | Total events captured, unprocessed count |
| `events-errors` | Hook error count (last 30 days) |
| `events-sidecar-prune` | Empty or stale orphan sidecars removed during the scan |
| `events-sidecar-scan` | Sidecar DBs that failed to scan because of corruption or I/O errors |
| `events-sidecar-scan-skipped` | Sidecar DBs intentionally skipped by the scan count or timeout budget |
| `events-staleness` | Time since last event capture |

`lcm events status` adds delivery-specific local counts (`pending`, `claimed`,
`retry`, `replicated`, `acknowledged`, `awaiting remote prune`, and
`quarantined`) plus the existing #90 PostgreSQL queue and lease counts. Use
`lcm events validate` when a crash or outage makes a local/remote checkpoint
uncertain.

Run `lcm doctor --verbose` to see the per-project breakdown and recent error details.

By default, doctor scans up to 50 passive-learning sidecar DBs. Use `lcm doctor --events-max-dbs <n>` to set another count limit, or `lcm doctor --events-max-dbs all` / `lcm doctor --events-max-dbs unlimited` to remove the count limit. Sidecars skipped because of the count or timeout budget are reported as skipped, not warnings.

Low nonzero backlog is reported as passing when both the daemon and its storage
backend are healthy, because the daemon processes queued events automatically.
If the daemon process is reachable while PostgreSQL storage is unavailable,
`lcm doctor` warns that the queue cannot drain until storage recovers. When the
daemon and storage are healthy but 200 or more queued events remain across
project sidecars, `lcm doctor` warns and suggests `lcm events promote --all`
instead of asking you to restart the daemon.

During the sidecar scan, lcm also prunes orphan sidecars that are safe to
remove. A sidecar is pruned only when its project metadata is missing, it has
no unprocessed events, and it has no pending, claimed, retryable, replicated,
or quarantined delivery. Empty orphan sidecars are removed immediately;
acknowledged-only orphan sidecars are removed after the 30-day stale retention
window, but only after every acknowledged row has a durable
`remote_pruned_at` checkpoint. An acknowledged row still awaiting exact remote
pruning retains the sidecar.

### `lcm stats`

A single line is added to the Memory section when events have been captured:

```
Events          1,234 captured (42 unprocessed, 3 errors (30d))
```

### Error Handling

All hooks use a three-layer error fence (`safeLogError`):

1. **Layer 1**: Write to sidecar DB `error_log` table (queryable by doctor/stats)
2. **Layer 2**: Append to `~/.lcm/logs/events.log` (flat file fallback)
3. **Layer 3**: Swallow silently — hooks must never crash or interfere with Claude Code
