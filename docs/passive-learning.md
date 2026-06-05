# Passive Learning

Passive learning captures insights from your Claude Code sessions automatically — no manual `lcm_store()` calls needed. It observes tool usage patterns, user decisions, and session events, then promotes high-signal observations into cross-session memory.

## How It Works

### Event Capture

Two hooks capture events during your session:

- **PostToolUse** — fires after every tool call. Extracts structured metadata (tool name, command, file path) from tool inputs. Never captures raw tool output.
- **UserPromptSubmit** — fires on each user prompt. Detects decisions ("always use X"), role statements ("I'm a data scientist"), and intent patterns.

Events are written to a **sidecar SQLite database** (`~/.lcm/events/<project-hash>.db`) at <10ms cost. This is separate from the main LCM database — if the daemon is unavailable, events are safely queued.

### What Gets Captured

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

- Raw tool payload contents such as file contents and command stdout/stderr (only tool metadata and brief user answers are stored)
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

### Learned Insights

On SessionStart, recently promoted passive insights are surfaced in a `<learned-insights>` block. This closes the feedback loop — the system learns from your sessions and applies those learnings in future ones.

## Configuration

All thresholds are configurable in `~/.lcm/config.json` under `compaction.promotionThresholds`:

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
  - Processed events pruned after 7 days
  - Unprocessed events capped at 10,000 rows (oldest pruned first)
  - Schema versioned for future migrations (currently v3)

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
| Hard kill (SIGKILL) | Events survive in sidecar, scavenged on next SessionStart |
| Stale sidecars in other projects | `lcm events promote --all` drains all metadata-backed sidecars |
| Unprocessed cap exceeded | Oldest events pruned when > 10,000 rows or > 30 days |
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

Run `lcm doctor --verbose` to see the per-project breakdown and recent error details.

By default, doctor scans up to 50 passive-learning sidecar DBs. Use `lcm doctor --events-max-dbs <n>` to set another count limit, or `lcm doctor --events-max-dbs all` / `lcm doctor --events-max-dbs unlimited` to remove the count limit. Sidecars skipped because of the count or timeout budget are reported as skipped, not warnings.

Low nonzero backlog is reported as passing because the daemon processes queued events automatically. When the daemon is healthy but 200 or more queued events remain across project sidecars, `lcm doctor` warns and suggests `lcm events promote --all` instead of asking you to restart the daemon.

During the sidecar scan, lcm also prunes orphan sidecars that are safe to remove. A sidecar is pruned only when its project metadata is missing and it has no unprocessed events. Empty orphan sidecars are removed immediately; processed-only orphan sidecars are removed after the 30-day stale retention window.

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
