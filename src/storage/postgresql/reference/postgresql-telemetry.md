# PostgreSQL telemetry and redaction contract

This guide is the normative contract that issues #637, #638, #639, and #640
implement for PostgreSQL operational observations. #637 implements the query
fingerprint (statement statistics) family, #638 implements the runtime health
families `pool`, `migration`, `extensions`, and `queue`, and #639
implements the incident diagnostics runbook and sanitization canaries. The
#640 production-shaped load certification is still a contract. The implemented
surface is the sanitized backend snapshot described in
[observational diagnostics](../../../../docs/cli.md#observational-diagnostics).
Each implementing issue encodes its rules in code and tests and updates this
guide when it adds a metric, label, or status.

## Scope and principles

In this guide, telemetry means local, on-demand, read-only observations that
LCM surfaces through the sanitized backend snapshot already used by
`stats`, `status`, pool diagnostics, and `doctor`.

- LCM never uploads telemetry. There is no hosted monitoring, background
  exporter, second collector, or automatic tuning. A future local exporter may
  only render this same allowlisted snapshot.
- Telemetry applies to the PostgreSQL backend only. SQLite, the default,
  reports every telemetry family as `not-applicable`. A configured PostgreSQL
  backend never falls back to SQLite telemetry.
- Only cataloged fields may be emitted. Each catalog entry fixes a name, a
  type, a unit, and its permitted dimensions. A collector drops everything
  else.
- Collection never mutates application or administrative state. It calls no
  reset function, runs no DDL, runs no `CREATE EXTENSION` or `ALTER EXTENSION`,
  and performs no repair, pruning, or settings change. The probe statements
  themselves appear in `pg_stat_statements` as ordinary statistics. That is
  not a mutation of LCM data and not a reset.
- Failing to observe a family is different from observing a bad condition. A
  family that cannot be observed reports its own status. That status never
  changes application correctness, admission, or startup, and never hides an
  existing classification in the snapshot. A valid observation of an unhealthy
  condition, such as pool saturation, may feed the documented health thresholds
  that #638 owns. A missing collector privilege or missing telemetry blocks
  production certification under #640; it does not block ordinary operation.

## Forbidden content

The following content is never exported, never logged, and never placed in an
error or remediation message. Where the table says "never read", the
collector does not even receive it.

| Content | Rule |
|---|---|
| Statement text of any kind: `pg_stat_statements.query`, `pg_stat_activity.query`, plan or `EXPLAIN` output text | Never read, except for the single bounded exception in [Query fingerprints](#query-fingerprints). Normalization does not make text safe: constants can remain in stored text, such as utility statements or entries kept after high deallocation. |
| SQL literals and bound parameter values | Never exported or logged. |
| Transcript, message, summary, memory, tag, prompt, inference input or output, file content, and search terms | Never exported or logged. |
| Credentials: connection URLs, passwords, client keys and certificates, tokens, authorization headers, and `LCM_POSTGRES_URL` values | Never exported or logged. |
| CA bytes, certificate bodies, certificate fingerprints, and CA file paths | Never exported or logged. |
| API keys of any provider | Never exported or logged. |
| Real host names, IP addresses, ports, database names, role or user names, `application_name`, `client_addr`, backend process IDs, local paths, raw driver or server error text, and SQLSTATE detail or hint fields | Never exported or logged. Roles and databases appear only as the fixed aliases in [Labels and cardinality](#labels-and-cardinality). |
| Unbounded labels: any label value not fixed when the package is built, such as free text, IDs from data rows, conversation, session, or event IDs, UUIDs, timestamps, and query identifiers | Never used as a label value. |

A collector may use a SQLSTATE code internally to classify a failure. Only the
closed status in [Observation status](#observation-status) leaves the process.

## Observation status

Every telemetry family reports one status from a closed set, together with
`observedAt` (UTC milliseconds). Apart from the cataloged
`statements_stats_reset`, epoch values are internal comparison data and never
leave the process (see [Epochs, resets, and rates](#epochs-resets-and-rates)).

| Status | Meaning |
|---|---|
| `not-applicable` | The backend is SQLite, or the family does not apply. |
| `disabled` | The source exists but server configuration turned it off. For the statement family this means `pg_stat_statements.track = none` only. |
| `unavailable` | The family source is absent, or a family-wide probe failure prevents a usable observation: missing or unloaded extension, connection failure, malformed result, or no computable query identifier. Explicit privilege denial and deadline or cancellation use their specific statuses instead. |
| `permission-denied` | The server denied the probe: SQLSTATE 42501, 28000, or 28P01, or another explicit privilege denial. |
| `timeout` | The probe hit a deadline or was cancelled: SQLSTATE 57014, the snapshot deadline, or the caller signal. |
| `stale` | `observedAt` is older than the family's declared freshness bound, or the values are not tied to the current epoch. |
| `reset` | The comparison epoch changed since the previous observation. Current cumulative values are valid, and no rate is computable across that boundary. This does not prove that counters restarted: a server restart can preserve statement statistics. |
| `partial` | Cataloged fields or entries are missing for a reason other than the expected absences listed below: a previously contributing scoped entry disappeared, a family cap was reached, a value is out of range or has invalid inputs, a sub-probe failed, or a counter decreased without an explained cause. |
| `observed` | Complete and fresh, allowing the expected omissions, with no established higher-priority family fact. Each contributing entry is internally consistent. A pooled record may contain entries with different statistics windows; no common interval is required. A first observation may be observed without a baseline. Temporal comparisons follow the per-entry epoch, membership, and mapping rules in [Comparison context](#comparison-context). |

Rows that belong to other roles are excluded by design and are not a
permission condition. `pg_stat_statements.track_planning` and
`track_io_timing` being off omit only the dependent fields (reason
`disabled-setting`); they never change the family status.

When several family-level facts apply, the family status is the first that
applies, among facts actually established:

```text
not-applicable > disabled > permission-denied > timeout > unavailable >
stale > reset > partial > observed
```

Apply this ladder only to established family-level facts. Permission-denied,
timeout, and unavailable describe failures that prevent a usable observation
of the family. If a sub-probe fails while usable family observations remain,
retain its specific reason on each affected field and establish `partial`,
rather than promoting that field failure to a family-wide failure. A
`stale` or `reset` fact still outranks `partial`. Stale values cannot be
compared, so `stale` outranks `reset`. Reset and partial can occur together;
reset is the stronger constraint on interpretation. Per-field reasons remain
present under whichever family status wins.

A family lists each omitted field from its closed field catalog with one
reason:

| Reason | Meaning | Lowers family status? |
|---|---|---|
| `unavailable` | The field's source or sub-probe failed. | Yes, to `partial`. |
| `timeout` | The sub-probe hit its deadline. | Yes, to `partial`. |
| `permission-denied` | The sub-probe was denied. | Yes, to `partial`. |
| `out-of-range` | The value is not finite or is negative, or an integer counter is not an exact safe integer (above 2^53 - 1). | Yes, to `partial`. |
| `invalid-input` | A derived value's inputs are finite and in range but cannot define it: a zero denominator, or counts that contradict each other, such as more idle than total connections. | Yes, to `partial`. |
| `reset` | The value cannot be compared across a reset. | Accompanies `reset`. |
| `disabled-setting` | The controlling server setting is off. | No. |
| `no-entry` | No row exists for a cataloged operation, or, for the queue, no qualifying event exists. This is never reported as zero. | No. |
| `limit-reached` | A family cap was reached, so the exact value is unavailable. | Yes, to `partial`. |
| `no-baseline` | No prior observation or other proof can establish the value. | No. |

In this table, "Yes, to `partial`" means that the omission establishes
`partial` unless a higher-priority family fact applies. The expected omissions
(`disabled-setting`, `no-entry`, and `no-baseline`) do not establish `partial`.

An unknown telemetry status renders as `unavailable`. Telemetry families are
new nested sections of the same snapshot; the existing readiness and
classification values are unchanged, and an unknown readiness still renders as
`unverified` and an unknown classification as `unavailable`.

On-demand observations are fresh within the shared snapshot deadline
(`BACKEND_DIAGNOSTIC_DEADLINE_MS`, currently 2000 ms). Each family runs within
the remaining deadline. A family that retains samples declares its own
freshness bound. #637 and #638 declare their measured share of the deadline in
their pull requests, and #640 certifies overhead.

## Epochs, resets, and rates

Cumulative counters are only comparable inside one epoch.

Epoch values decide comparability and the family status. The
`pg_stat_statements_info.stats_reset` timestamp is the one exception to the
internal-only rule: it is exported as the cataloged family-level
`statements_stats_reset`. Every other epoch value is internal
comparison-context data and is never emitted: `pg_postmaster_start_time()`
and the per-entry `stats_since` and `minmax_stats_since` values have no
catalog entry and do not count toward the cardinality bound.

- The statement epoch is the tuple of `pg_postmaster_start_time()`, the
  `pg_stat_statements_info.stats_reset` timestamp, and the entry's
  `stats_since`. It governs calls, rows, totals, block and WAL counters, mean,
  and standard deviation.
- The min/max epoch is the entry's `minmax_stats_since`. It governs only the
  execution-time minimum and maximum. A min/max-only reset is not a full reset.
- `pg_stat_statements_info.stats_reset` advances when all statement statistics
  are discarded. A targeted reset that is not min/max-only discards the
  matching entries, and eviction also removes entries. Until an entry is
  re-created it is absent; it does not show an in-place `stats_since` change. A
  cataloged operation with no entry reports `no-entry`. When a previously
  contributing entry disappears, the contributor membership changes, no
  operation-wide rate is computable, and the family is `partial`. Absence
  alone does not establish a reset. A re-created entry has a new
  `stats_since`, and an established epoch change invalidates comparison,
  whatever the cause.
- Monotonic counters never decrease inside an epoch. A decrease without an
  epoch change leaves no computable rate and marks the family `partial`
  without asserting a cause. With an epoch change the family is `reset`.
  Changes in min, max, mean, or standard deviation never imply a reset on
  their own.
- `pg_stat_statements_info.dealloc` is a server-wide counter, while the family
  covers only the runtime role and the current database. A previously
  contributing scoped entry disappearing establishes partial, whether or not
  dealloc grew; an established statement-epoch change establishes reset,
  subject to the status precedence above. Growth of
  `pg_stat_statements_info.dealloc` alone establishes neither.
- Server timestamps are compared only with server timestamps.
- This contract catalogs cumulative values only and emits no rate fields. A
  rate is derived by a consumer, or by a future catalog revision, from two
  comparable cumulative observations in the same epoch; with any other pair
  no rate is valid. An exported rate needs its own catalog entry: name, unit,
  the source counters it derives from, dimensions, and an updated cardinality
  bound.
- LCM reports aggregates only and never synthesizes percentiles. Workload
  latency percentiles belong to #629.
- Every number is finite and non-negative. Integer counters, including the
  numeric WAL byte total, must also be exact safe integers (at most
  2^53 - 1); floating-point durations, means, deviations, and ratios need not
  be integral. A field that violates this rule is omitted with reason
  `out-of-range`, never rounded or clamped.

### Comparison context

Statuses derived by comparison (`reset`, and `partial` from a decrease or a
membership change) and the validity of any rate derived from two observations
need a prior observation. #637 owns a bounded comparison context
inside the shared snapshot path:

- at most one prior context, with no more than 64 live entries or disappearance
  tombstones;
- only allowlisted counters plus internal identity and epoch data;
- invalidation on runtime role, database, publication, or mapping change; and
- no background collector, persistence file, exporter, or timer.

The #638 runtime health families are on-demand gauges. They keep no comparison
state and never report `reset`, `stale`, or a rate. #640 drives sequential
observations to certify the comparison context.

Comparison is per entry: same role and database scope, top-level statement,
same internal query identifier. It requires that entry's statement epoch to be
unchanged, and the operation's existing contributing entries and mapping to be
unchanged. A contributor absent from the prior observation is a newly created
entry: it adds only calls made after it appeared, does not invalidate the
comparison, and makes no comparison claim of its own. A previously contributing
entry disappearing makes the family `partial`; LCM never compares only the
surviving contributors. Re-creation with a new `stats_since` establishes
`reset`. A min/max-only change invalidates the extrema comparison and nothing
else.

The first observation has no prior context. It reports cumulative values,
retains its internal epoch data in the comparison context, has
status `observed` if it is otherwise complete, and has no computable rate.
It makes no reset, decrease, or membership-change claim. The
missing baseline is a per-field reason, never a false reset.

The context is committed only after the snapshot's final publication-witness
recheck. Concurrent observations use a compare-and-swap sequence; an older
observation cannot overwrite a newer commit. A disappearing entry becomes a
bounded tombstone so the disappearance is reported once. If it later reappears
with a different `stats_since`, the family reports `reset`. The internal
postmaster start, entry timestamps, query identifiers, and tombstones never
leave the process. Only `statements_stats_reset` is exported as epoch metadata.

## Query fingerprints

#637 owns the statement-statistics family, which reads
`pg_stat_statements` for the LCM runtime role.

The implemented family is `BackendDiagnosticSnapshot.telemetry.statements`.
It runs after ordinary backend and outbox observations and before the final
publication-witness recheck. It has a 750 ms local budget inside the shared
2000 ms snapshot deadline and preserves 100 ms for publication revalidation.
The family runs last so a timeout or telemetry failure cannot change backend
classification, application startup, or application traffic.

### Operation identity

- The exported identity is an LCM operation identifier of the form
  `<domain>.<operation>` from the packaged starter catalog in
  `src/storage/postgresql/query-operations.ts`. The current catalog contains
  13 operations and 14 exact repository SQL templates, covering bounded
  conversation, summary, context, and promoted-memory lookups. It deliberately
  does not claim search, transcript, or ingest coverage. The catalog has at
  most 64 entries. Only cataloged operations are exported. An unknown or
  drifted operation is omitted (fail closed) and never fails startup.
- Source rows are filtered to `toplevel = true`, `userid` equal to the OID of
  the runtime role, and `dbid` equal to the current database. This filter runs
  before any aggregation. The runtime role's OID comes from `pg_roles` for
  `current_user`, never from `pg_authid`. Rows of other roles may be visible as
  statistics, but LCM excludes them and never folds them into any bucket. The
  collector needs no `pg_read_all_stats` or `pg_monitor` membership, and LCM
  does not recommend either.
- The query identifier is an internal join key only. LCM never exports it,
  never uses it as a label, and never retains it past the bounded comparison
  context. One operation maps to zero or more identifiers, because different
  templates and `search_path` values produce different ones. Unrelated
  statements of the same role and database can collide into one identifier;
  the contract accepts that as a known limitation.
- LCM exports no bucket for statements that do not map to a cataloged
  operation. Utility statements are therefore never exported, and no text is
  read to classify them.

### Mapping

The mapping from operation to query identifier belongs to #637. Whatever
mechanism it chooses must:

- read no statement text;
- never use `ANALYZE`;
- stay within a bounded cost inside the snapshot deadline;
- preserve the exact signed 64-bit identifier, carried as a string internally;
  and
- ship tests proving that the mapping matches real executions.

The implementation uses a bounded `EXPLAIN (GENERIC_PLAN, VERBOSE, FORMAT
JSON)` of a packaged statement template. PostgreSQL shows the query identifier
only in verbose output. This is the one exception to the rule that plan output
is never read: the collector may receive that result transiently, solely to
extract the top-level query identifier. It retains, logs, emits, or uses
nothing else from it, and it never runs on SQL that is not packaged with LCM.
If the server computes no identifier at all, the family is `unavailable`;
there is no text-based fallback. A cataloged operation that simply has no entry
gets reason `no-entry` per field.

Each observation performs one context read, 14 mapping probes for the current
catalog, and one counter read. The mapping-probe cap is 16. With the runtime's
cancellation preflight, the current catalog therefore uses at most 32 wire
statements: two statements for each of 16 signalled calls, plus at most one
`pg_cancel_backend` call after cancellation. Plan output is accepted only up to
256 KiB. The counter read accepts at most 64 candidate rows, and retained
comparison state accepts at most 64 entries. Reaching either of those caps
reports `partial`. A catalog or mapping-probe cap reports `partial` only when at
least one effective identifier keeps the observation usable. If no effective
mapping remains, the unusable family follows the no-mapping rule below. State
that exceeds the comparison cap is not committed.

A statement-family observation is usable only when the counter read succeeds
and at least one operation produces an effective query identifier. A successful
probe with no identifier makes that operation unavailable; a failed probe keeps
its specific per-field reason. Either case yields `partial` when another
operation remains mapped. If no operation maps, the family is `unavailable`
when any probe successfully returned no identifier, otherwise it uses the
highest-ranked probe failure. Cross-operation identifier collisions exclude
every colliding operation; if no effective mapping remains, the family is
`unavailable`. The counter query never selects statement text.

### Scope

Query counters are role-and-database aggregates, even inside a
selected-project request. A selected-project request still returns the query
family, labelled `scope=aggregate`. LCM never labels or presents these
counters as project-specific and emits no project-scoped query series.

### Metric catalog

Each operation record carries the following 22 metrics. JSON output may use the
camelCase form of the same names.

| Metric | Unit | Source column | Condition |
|---|---|---|---|
| `query_calls_total` | count | `calls` | |
| `query_rows_total` | count | `rows` | |
| `query_exec_time_total_ms` | ms | `total_exec_time` | |
| `query_exec_time_min_ms` | ms | `min_exec_time` | Extrema rules below |
| `query_exec_time_max_ms` | ms | `max_exec_time` | Extrema rules below |
| `query_exec_time_mean_ms` | ms | derived | |
| `query_exec_time_stddev_ms` | ms | derived | |
| `query_plan_time_total_ms` | ms | `total_plan_time` | Only when `pg_stat_statements.track_planning` is on |
| `query_shared_blks_hit_total`, `query_shared_blks_read_total`, `query_shared_blks_dirtied_total`, `query_shared_blks_written_total` | blocks | `shared_blks_*` | |
| `query_local_blks_hit_total`, `query_local_blks_read_total`, `query_local_blks_dirtied_total`, `query_local_blks_written_total` | blocks | `local_blks_*` | |
| `query_temp_blks_read_total`, `query_temp_blks_written_total` | blocks | `temp_blks_*` | |
| `query_shared_blk_read_time_ms`, `query_shared_blk_write_time_ms` | ms | `shared_blk_read_time`, `shared_blk_write_time` | Only when `track_io_timing` is on |
| `query_wal_records_total` | count | `wal_records` | |
| `query_wal_bytes_total` | bytes | `wal_bytes` | |

Three family-level values accompany the records: `statements_dealloc_total`
(count), `statements_stats_reset` (server timestamp), and `block_size` (bytes,
from `current_setting('block_size')`, reported once). The first two are
server-wide values: `statements_dealloc_total` is informational only, counts
evictions across all roles and databases, and does not by itself degrade the
family status. The collector reads
`current_setting` for `pg_stat_statements.track`,
`pg_stat_statements.track_planning`, and `track_io_timing`. An off setting omits
the dependent fields with reason `disabled-setting`, never as zero. LCM never
enables any of these settings.
When the server reports no reset timestamp, `statements_stats_reset` is omitted
with reason `no-baseline`.

### Aggregation

An operation record is a pooled summary over its contributing entries, each
over its own statistics window. The per-entry `stats_since` and
`minmax_stats_since` values naturally differ, so the record is never described
as covering one common interval. For entry i, let n_i be the call count, m_i
the mean execution time, and s_i the population standard deviation, and let N
be the sum of n_i.

- Calls, rows, totals, block counters, and WAL counters are sums.
- The pooled mean is the sum of `total_exec_time` divided by N.
- The pooled standard deviation uses the stable population formula
  `sqrt(sum(n_i * (s_i^2 + (m_i - mean)^2)) / N)`.
- LCM omits mean and standard deviation if N is 0, if any input is missing, or
  if the variance is negative or not finite.
- After aggregation, LCM rechecks every numeric value for finiteness and
  non-negativity. Integer counter fields, including WAL bytes, must also
  remain exact safe integers; floating-point durations, means, deviations,
  and ratios are not required to be integral. Every omission carries a
  per-field reason.

PostgreSQL has four source min/max columns; only the execution-time minimum
and maximum are cataloged. The pooled minimum is the smallest and the pooled
maximum the largest contributing value. LCM omits an extremum when it cannot
establish that the window's extrema are initialized. After a min/max-only
reset, PostgreSQL reports 0 until the next execution, and lifetime calls do not
prove initialization. A fresh observation may conservatively omit ambiguous
extrema with reason `no-baseline`; a comparison context can establish
initialization. An entry is initialized when it has calls and its
`minmax_stats_since` equals `stats_since`, or when the comparison context has
the same two epochs and either already established initialization or observes a
higher call count. #637 includes a fixture for this sequence: pre-reset calls,
min/max-only reset, no execution, then resumed execution. A zero-call aggregate
omits mean, standard deviation, minimum, and maximum with `no-baseline`.

Mapping probes themselves can add planning work when
`pg_stat_statements.track_planning` is enabled. They never execute the packaged
statement and their own planning statistics are outside the cataloged operation
mapping.

The existing runtime role needs no new grant. Collection relies on `USAGE` for
schema `public`, `EXECUTE` on `public.pg_stat_statements(boolean)`, and `SELECT`
on `public.pg_stat_statements_info`. The extension grants the latter two to
`PUBLIC` by default. Revoking function execution makes only this family
`permission-denied`; recovery restores that exact execution grant and never
grants a monitoring role or resets statistics.

## Runtime health families

#638 adds four families to the backend snapshot, nested under `telemetry`:
`pool`, `migration`, `extensions`, and `queue`. #637 adds the sibling
`telemetry.statements` family separately. The families use the snapshot's
existing path: the diagnostic-probe runtime, or the daemon pool counters, as
recorded in the pool origin. They are bounded, cancellable, and cannot starve
runtime pools. #638 owns their thresholds and remediation text.

### Structure

Every family carries:

- `status`, one value of the closed set in [Observation status](#observation-status);
- `observedAt`, the UTC milliseconds at which LCM completed or captured that
  family's observation. It is never an underlying event timestamp, and every
  status carries it;
- `omitted`, a list of `{field, reason}` records. The field comes from the
  family's catalog below and the reason from the closed reason table, so the
  list has at most one record for each catalog field; and
- for every status except `not-applicable`, `health` and `remediation`.

`health` is `healthy`, `degraded`, or `unavailable`. A family that proves a bad
condition is `degraded` even when another field is omitted. A family is
`healthy` only when its status is `observed` and no threshold is crossed. Every
other family is `unavailable`, so a missing or partial observation never claims
`healthy`. `remediation` is one fixed string from the [remediation
table](#thresholds-and-remediation). The renderer ignores the value in a
snapshot and selects the same fixed string from the validated family values.

SQLite reports all four families as `not-applicable`, without health or
remediation, on every path, including timeout and failure snapshots. A failure
snapshot of a PostgreSQL or unknown backend mirrors its failure
(`permission-denied`, `timeout`, or `unavailable`) in all four families and is
never `not-applicable`. A snapshot from an older daemon that has no `telemetry`
renders each family as `unavailable`.

### Field catalog

JSON uses the camelCase name. Every number is finite and non-negative, and
every count is an exact safe integer. No ID, checksum, SQL, schema name, path,
or error text is emitted.

| Family | Field (JSON) | Type and unit | Source | Omission reasons | Labels and finite bound |
|---|---|---|---|---|---|
| Pool | `pool_saturation_ratio` (`saturationRatio`) | number, unitless | `(total - idle) / configuredMax` of the origin-tagged pool counters. It is not clamped, so it can exceed 1. | `invalid-input` when the maximum is 0 or idle exceeds total; `out-of-range` when a counter is negative, non-finite, fractional, or not an exact safe integer; `unavailable` when a counter is missing or non-numeric, or the counters are otherwise unverified | origin, scope; 1 value |
| Migration | `migration_applied_count` (`appliedCount`) | count | rows of an ordered ledger read capped at the packaged count plus one | `limit-reached` when the cap is reached; `unavailable` for a malformed ledger | scope; 1 value |
| Migration | `migration_expected_count` (`expectedCount`) | count | the verified packaged migration list | the family failure reason when the family fails before the probe | scope; 1 value |
| Migration | `migration_history_status` (`historyStatus`) | closed enum | positional comparison of ledger IDs and checksums with the packaged list | none; `unavailable` is a value | scope; 1 value |
| Extensions | `entries` (one record per extension) | `name`: the four fixed names; `status`: the existing closed readiness status; `installedVersion` and `defaultVersion`: version string | the health result's extension observations, picked into these fields only | `unavailable` for a missing, duplicate, or invalid record, named by extension; the family failure reason for every extension when the family fails | extension; at most 4 records (exactly 4 when observed), at most 16 scalar fields |
| Queue | `outbox_oldest_pending_age_seconds` (`outboxOldestPendingAgeSeconds`) | number, seconds | local wall clock minus the oldest capture time of a pending or retry local event | `no-entry` when no such event exists; `unavailable` for an unread or skipped source, which takes precedence; `out-of-range` when every source was read and any source's reported oldest pending timestamp is invalid, or the overall oldest timestamp is in the future; `permission-denied` or `timeout` when the local read fails on a partial family | scope; 1 value |
| Queue | `inbox_claimed_count` (`inboxClaimed`), `inbox_quarantined_count` (`inboxQuarantined`) | counts | server inbox rows in the `claimed` and `quarantined` states | `limit-reached`, `out-of-range`, or the probe failure reason | scope; 2 values |
| Queue | `replay_lag_seconds` (`replayLagSeconds`) | number, seconds | server clock minus the oldest `next_attempt_at` of a due `pending` or `retry` row | `no-entry` when no row is due; `limit-reached`, `out-of-range`, or the probe failure reason | scope; 1 value |

Every omittable field above, including `expectedCount`, also carries the family
failure reason (`unavailable`, `permission-denied`, or `timeout`) when the whole
family fails before it is observed, and then the family has no value for it.

The four pool counters and the failure latch remain the existing `pool` snapshot
fields with origin `daemon`, `diagnostic-probe`, or `local`. A version is emitted
only when it matches `^[0-9]+(\.[0-9]+){0,2}$`, and a missing or other version
is `unrecognized`. `no-entry` for the queue means that no qualifying event exists;
it is never reported as zero, and an unread source is `unavailable` instead.

`migration_history_status` is `current`, `behind` (including an empty ledger),
`ahead`, `drift`, `checksum-mismatch`, or `unavailable`. Drift outranks a checksum
mismatch, which outranks a count mismatch. Reaching the cap proves `ahead` (or
drift or a mismatch in the inspected prefix) without an exact total.

Per-project values need a selected scope. The server counts use a bound
parameter for the admitted selected UUID, and the aggregate scope reports totals
only, never a per-project breakdown. Selected scope without an observed local
binding leaves the local age `unavailable`. The queue family then reports only the
server values and is `partial`. "Progress" here means the current queue state and
overdue scheduling lag, not a persisted progress series or a cumulative replay
rate.

### Status derivation

Each family applies the status ladder only to established family-level facts.
The on-demand gauge families here establish no `disabled`, `stale`, or `reset`
fact, keep no comparison state, and emit no rate. A sub-probe failure that
leaves usable values makes the family `partial` with the specific reason on each
affected field. A family with no usable value reports the strongest failure
reason as its status. A ready local outbox quarantine count is a usable value,
and so is an observed cap sentinel: a reached cap makes the family `partial`
even when no other value is usable.

| Family | Condition | Status | Health |
|---|---|---|---|
| Pool | counters verified, relationship valid | `observed` | `degraded` at a daemon-origin ratio of 1 or more with waiting above 0, or with the failure latch; otherwise `healthy` |
| Pool | maximum is 0 or idle exceeds total | `partial` | `degraded` only by the failure latch; otherwise `unavailable` |
| Pool | a counter is negative or not an exact safe integer | `partial` | `unavailable` |
| Pool | counters missing or unverified | `unavailable` | `unavailable` |
| Migration | full ledger within the cap | `observed` | `healthy` for `current`; otherwise `degraded` |
| Migration | cap reached | `partial` | `degraded` (`ahead`, `drift`, or `checksum-mismatch`) |
| Migration | malformed ledger or probe failure | `unavailable` or the failure status | `unavailable` |
| Extensions | four validated records | `observed` | `degraded` if any is not `current`; otherwise `healthy` |
| Extensions | some records missing or invalid | `partial` | `degraded` if a valid record is not `current`; otherwise `unavailable` |
| Extensions | no usable record | `unavailable` or the failure status | `unavailable` |
| Queue | all sub-probes usable, no cap | `observed` | `degraded` on a threshold below; otherwise `healthy` |
| Queue | a sub-probe failed with another value usable, or the cap was reached | `partial` | `degraded` only on a proven threshold; otherwise `unavailable` |
| Queue | no usable value and no cap | strongest failure status | `unavailable` |

An observed bad condition is `degraded` health on an `observed` family, not an
unavailable one. A family health of `degraded` raises a `healthy` snapshot
classification to `degraded` and nothing else. It never changes `unavailable`,
`permission-denied`, `timeout`, `stale-publication`, or an existing `degraded`
classification. Existing readiness checks still decide the top-level
classification, and the families are sequential observations, not one atomic
database snapshot.

### Thresholds and remediation

| Condition | Health | Fixed remediation |
|---|---|---|
| Pool: daemon origin only, saturation ratio of 1 or more and waiting above 0 | `degraded` | Reduce concurrent database load or raise `storage.postgresql.poolMax`, then run `lcm doctor`. |
| Pool: failure latch | `degraded` | Check backend connectivity, then run `lcm doctor` again. |
| Migration: `behind` | `degraded` | Run `lcm postgres migrate` with the migration role, then run `lcm doctor`. |
| Migration: `ahead` | `degraded` | Upgrade LCM to a release that includes every applied migration, then run `lcm doctor`. |
| Migration: `drift` or `checksum-mismatch` | `degraded` | Restore the packaged PostgreSQL schema history; never edit applied migrations. |
| Extensions: any record is not `current` | `degraded` | Have a database administrator install or update the required PostgreSQL extensions and verify their schema and preload configuration, then run `lcm doctor`. |
| Queue: inbox quarantined above 0, or a ready local outbox with quarantined above 0 | `degraded` | Inspect with `lcm events quarantine` and replay with `lcm events replay <event-id>`. |
| Queue: local pending age or replay lag above 900 seconds | `degraded` | Check daemon delivery with `lcm events status`, then run `lcm doctor`. |
| Any healthy family | `healthy` | No action required. |
| Any other family | `unavailable` | Run `lcm doctor` and review the storage configuration. |

Quarantine guidance takes precedence over backlog guidance. Exactly 900 seconds
is healthy. The 900 second limit is an advisory backlog interpretation of
roughly three replication sweeps, not a correctness deadline. Pool saturation
applies only to the daemon origin, because the diagnostic-probe pool of a CLI
`lcm doctor` run cannot establish daemon saturation. `lcm doctor` stays
observational: it prints this text and executes nothing.

The queue is not a delivery-loss measurement. The acceptance terms resolve as
follows. Age is the two queue gauges. Saturation is the pool ratio with the
waiting gauge. The thresholds are the table above. No rate is emitted, because
these families have no cumulative counters. They establish no reset. Loss is
visible only as the quarantine counts. `pool_acquire_timeouts_total` is not
supported, because the pool supplies no defined counter. Its absence is neither
a zero timeout count nor evidence of timeout-free operation.

### Clocks, statements, and rows

- The local outbox age uses the local wall clock over local files. The inbox
  counts and the replay lag come from server rows, and the lag uses the server
  `clock_timestamp()` read once per statement, so the due filter and the
  subtraction share one instant.
- The migration read is one statement over the ordered ledger with a bound limit
  of the packaged count plus one. Its result is compared in process with the
  verified packaged list, which is finite packaged work that the signal cannot
  interrupt. Readiness loads that list again.
- The queue read is one statement. It materializes at most 4096 candidate
  inbox rows in the `pending`, `retry`, `claimed`, and `quarantined` states, plus one
  sentinel row, before it aggregates them. If the sentinel appears, the exact
  totals and the lag are omitted with `limit-reached`, the family is `partial`, and
  an incomplete queue is never healthy. The cap bounds the rows materialized and
  transferred, not every tuple PostgreSQL visits, which the deadline bounds.
- The extensions family reuses the health result and runs no statement. Local
  pending age adds a column to the existing sidecar read.
- The two new reads are two application statements and two of the runtime's
  existing process ID lookups for signalled queries, and a cancellation can open
  one more connection. The reads run one at a time, so they use one data
  connection, and the pool maximum is unchanged. Neither read passes project
  options, which would enter the runtime's writer admission transaction.

Scoped exception for the #638 runtime-health reads and the #637
statement-statistics reads. The Privilege boundaries rule that every statement
has a `statement_timeout` within the remaining snapshot deadline does not apply
to these reads because both use the existing #619 diagnostic runtime:
`statement_timeout` is set at runtime creation to the smaller of the configured
statement timeout and the snapshot duration, at most 2000 ms, while signals
enforce the shared deadline. Before each of the two #638 database reads, a
remaining-time guard reports `timeout` instead of launching when less than 100
ms remains. That floor is provisional and was calibrated from PostgreSQL 18
harness measurements recorded in the #638 pull request. For #637, a child
signal enforces the smaller of the 750 ms family budget and the remaining time
less the 100 ms publication-revalidation reserve; when that budget is not
positive, the launch guard reports `timeout` without a statement-statistics
probe. These guards are launch policies, not reservations for process-ID
lookup, SQL execution, or cancellation setup, and they do not guarantee that
asynchronous resource cleanup has completed when the snapshot DTO returns.

## Labels and cardinality

The [incident diagnostics runbook](../../../../docs/incident-diagnostics.md)
keeps three separate closed lists:

- Snapshot labels remain the unchanged collector labels documented below.
- Runbook aliases are `runtime`, `migration`, and `administrator` role classes,
  database alias `lcm-db`, and application alias `lcm`; they are documentation
  identifiers with fixed cardinality five, never collector labels.
- Provider credential classes are `provider-read` and `provider-recover`.
  They describe authority and are not identifiers or telemetry dimensions.

The #639 unit and PostgreSQL harness tests validate the runbook registry,
positive jq projection, approved SQL rows, and encoded leak canaries. The
integration seeds the exact #903/#924/#925 regression inputs:
`file://host.invalid?q=(file://host.invalid/Users/canary/private.db`,
`file://host.invalid?q=[a=b]file://host.invalid/Users/canary/private.db`,
`file://host.invalid?next=1file://host.invalid/Users/canary/private.db`,
`file://outer.invalid?q=prefix-file://host.invalid/Users/canary/private.db`,
`file://outer.invalid#q=prefix-file://host.invalid/Users/canary/private.db`,
`file://host"name/Users/canary/private.db`, and
`file://host'name/Users/canary/private.db`. Their shared local path must not
appear in approved evidence. Existing sanitizer regression tests remain the
redaction proof; the incident tests prove that those inputs do not escape
through the runbook's approved surfaces.

Label keys and values are fixed when the package is built. The family is the
structural snapshot section identifier, not a dimension on emitted values.

| Label | Permitted values |
|---|---|
| `operation` | The #637 operation catalog, at most 64 entries. |
| `extension` | `pg_stat_statements`, `pg_trgm`, `pgcrypto`, `unaccent`. |
| `origin` | `daemon`, `diagnostic-probe`, `local`. |
| `scope` | `aggregate`, `selected`. |

Each family uses only its own label tuple:

| Family | Label tuple |
|---|---|
| Query | operation, scope |
| Pool | origin, scope |
| Migration | scope |
| Extensions | extension |
| Queue and replay | scope |

The observation status is one value per family, not a series dimension. The
three runbook role classes, database alias `lcm-db`, and application alias
`lcm` exist only in #639 documentation and are never collector dimensions.
Project and machine UUIDs remain snapshot metadata and are never labels. A
query identifier is never a label.

The query family emits at most 22 metrics for each of 64 operations plus the 3
family-level values, which is 1411 scalar values per snapshot. #637 and #638
declare finite limits for candidate rows read, mapping probes, and retained
comparison entries. Their tests prove truncation, not just a SQL `LIMIT`:
reaching a limit yields status `partial`.

## Privilege boundaries

- Collectors use the existing restricted runtime role and its reviewed grants.
  They need no superuser, `pg_monitor`, `pg_read_all_stats`, or
  `pg_read_all_settings`; reading the listed settings with `current_setting`
  needs none of them. A new grant enters only through a reviewed change to the
  runtime grant scripts and the readiness verifier in the pull request that
  needs it.
- LCM never calls `pg_stat_statements_reset` or any `pg_stat_reset*` function
  and never uses `ANALYZE` inside `EXPLAIN`.
- Each family declares a finite maximum number of statements, including its
  statistics reads, role and setting lookups, and any packaged-template
  mapping probes. Combine reads where practical. Every statement is
  cancellable through the caller's signal and has a `statement_timeout`
  within the remaining shared snapshot deadline. The combined work stays
  within that deadline and the declared row, mapping-probe, and
  comparison-entry limits.
  The #638 runtime-health reads and #637 statement-statistics reads use the
  shared scoped exception documented in
  [Clocks, statements, and rows](#clocks-statements-and-rows).
- A #639 runbook that needs another role, such as a provider administrator,
  documents that requirement and sanitizes its output to role-class and
  database aliases.

## Sanitization canaries

Implementations prove the forbidden-content rules with seeded canaries. Each
test seeds unique values in:

- SQL parameter values and a literal inside a utility statement;
- message, summary, memory, tag, prompt, and inference text;
- a project path;
- a URL password, a client key, and a CA PEM body;
- provider API keys in the `sk-`, `sk-ant-`, and `ghp_` shapes;
- real role, database, and host names; and
- `application_name`.

The test then asserts that none of them appears in JSON, rendered text,
verbose output, error responses, logs, or standard error. It checks the raw
value and its JSON-escaped, URL-encoded, base64, and hex forms.

#637 fixtures, #639 runbook tests, and #640 load runs consume these canaries.
They complement the existing redaction tests. The closure evidence and
regression coverage of the closed sanitizer bugs #903, #917, #924, #925, #1332,
#1336, #1344, #1346, #1349, and #1374 are #640 gate inputs and are not owned
here.

## Deeper audit policy

`pg_stat_monitor` and `pgaudit` are not part of the required P4 delivery. LCM
does not install, configure, require, or read them. It also does not use
`auto_explain`, statement or parameter logging, or server-log scraping.

They remain future opt-in research, considered only after a measured need that
`pg_stat_statements` plus the runtime health families cannot answer. Any such
work needs a separate issue, a privacy review, and an explicit operator opt-in
that is off by default. It must obey the same forbidden-content, label, and
canary rules. Statement and audit logs contain statement text and parameters by
design, so they never feed LCM telemetry directly.

## Changing the contract

A pull request that adds a metric, label, or status updates this guide in the
same pull request and adds canary coverage for it.

See also the [schema reference](postgresql-schema.md) for extension readiness
and the [privacy guide](../../../../docs/privacy.md) for the overall local data
boundary.
