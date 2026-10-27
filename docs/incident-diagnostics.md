# Incident diagnostics

This runbook collects bounded incident evidence without exposing LCM content,
credentials, connection details, provider identifiers, or raw SQL text. Start
with LCM's existing sanitized observations. Use the two SQL queries only for
questions LCM cannot answer. Every recovery step is private and requires an
operator decision.

## Before you start

The runbook role classes are **runtime, migration, administrator**. `runtime`
is the restricted LCM login with the reviewed production grants. `migration`
owns the schema and is used only for migrations. `administrator` is the
provider's administrative login and is used only for private recovery; on
DigitalOcean, `doadmin` is not a PostgreSQL superuser.

The database alias is **lcm-db**. Application alias: **lcm**. The application
alias is the fixed documentation name for LCM's default `application_name`;
real application names are never copied. These three roles and two aliases are
the complete runbook identifier set, with fixed cardinality five. They are
documentation aliases, never telemetry labels.

Use two provider credential classes. `provider-read` has exactly
`database:read`, `regions:read`, `sizes:read`, and `actions:read`.
`provider-recover` adds `database:create` only for a restore fork. The
`database:create` authority is wider than database forking, so keep that token
private, short-lived, and separate. Never add `database:view_credentials`,
`database:update`, `database:delete`, or `api:read`. See DigitalOcean's
[database read scope](https://docs.digitalocean.com/reference/api/scopes/database/read/)
and [database create scope](https://docs.digitalocean.com/reference/api/scopes/database/create/),
checked 2026-10-20.

Provision named doctl contexts interactively in a private terminal. The auth
configuration directory must be private and its files mode `0600`. Context
names do not prove token scopes; provision the exact scopes above. Never put a
token on argv.

<!-- incident: id=doctl-auth-read phase=recover share=private kind=doctl role=provider-read -->
```sh
doctl auth init --context lcm-read
```

<!-- incident: id=doctl-auth-recover phase=recover share=private kind=doctl role=provider-recover -->
```sh
doctl auth init --context lcm-recover
```

Capture local UTC immediately before each observation. Keep each diagnostic
family's `observedAt` value and each SQL row's `server_observed_at`. The two
clocks are independent evidence; do not compare them or infer clock skew.

<!-- incident: id=capture-time phase=observe share=approved kind=shell role=runtime -->
```sh
date -u +%Y-%m-%dT%H:%M:%SZ
```

The approved shareable bundle is limited to that local UTC value, successful
stdout from the projection below, and successful result rows from the two SQL
blocks in this guide. The output-only `Status,NumNodes` provider observation
may be shared separately. Command argv, cluster IDs, and provider stderr stay
private. Raw status JSON, LCM doctor output, pool output, event output and
errors, logs, service files, quarantine data, event IDs, all doctl discovery or
recovery sessions, and all credential sessions stay private.

The jq program is a positive projection of a current, already-sanitized LCM
snapshot. It is not a general JSON sanitizer. Future fields remain excluded
until reviewed. Missing numeric fields remain absent rather than becoming zero.
A missing `backendDiagnostics` object returns a fixed error; its stderr stays
private. `jq` is an operator prerequisite. The pipe uses `pipefail`, and only
exit-zero stdout is evidence.

<!-- incident: id=status-bundle phase=observe share=approved kind=shell role=runtime -->
```sh
set -o pipefail
lcm status --json | jq -e 'def p($keys):
  (. // {}) | with_entries(
    select(.key as $key | ($keys | index($key)) != null)
  );
def common:
  p(["status","observedAt","health","omitted","remediation"])
  | .omitted |= ((. // []) | map(p(["field","reason"])));
def metric_keys:
  ["queryCallsTotal","queryRowsTotal","queryExecTimeTotalMs",
   "queryExecTimeMinMs","queryExecTimeMaxMs","queryExecTimeMeanMs",
   "queryExecTimeStddevMs","queryPlanTimeTotalMs",
   "querySharedBlksHitTotal","querySharedBlksReadTotal",
   "querySharedBlksDirtiedTotal","querySharedBlksWrittenTotal",
   "queryLocalBlksHitTotal","queryLocalBlksReadTotal",
   "queryLocalBlksDirtiedTotal","queryLocalBlksWrittenTotal",
   "queryTempBlksReadTotal","queryTempBlksWrittenTotal",
   "querySharedBlkReadTimeMs","querySharedBlkWriteTimeMs",
   "queryWalRecordsTotal","queryWalBytesTotal"];
def telemetry:
  {
    pool: (.pool | common + p(["saturationRatio"])),
    migration: (.migration | common
      + p(["historyStatus","appliedCount","expectedCount"])),
    extensions: (.extensions | common
      + {entries: ((.entries // [])
        | map(p(["name","status","installedVersion","defaultVersion"])))}),
    queue: (.queue | common
      + p(["outboxOldestPendingAgeSeconds","inboxClaimed",
           "inboxQuarantined","replayLagSeconds"])),
    statements: (.statements
      | p(["status","observedAt","scope","statementsDeallocTotal",
           "statementsStatsReset","blockSize"])
      + {
        omitted: (.omitted | p(
          ["statementsDeallocTotal","statementsStatsReset","blockSize"])),
        operations: ((.operations // []) | map({
          operation: .operation,
          values: (.values | p(metric_keys)),
          omitted: (.omitted | p(metric_keys))
        }))
      })
  };
if (.backendDiagnostics | type) != "object" then
  error("backend diagnostics unavailable")
else
  {
    diagnosticSource:
      (if .diagnosticSource == "daemon" then "daemon"
       elif .diagnosticSource == "local" then "local"
       else "unavailable" end),
    backendDiagnostics: (.backendDiagnostics | {
      backend, classification, publication, tls, schema, extensions, search,
      pool: (.pool | p(
        ["origin","status","configuredMax","total","idle","waiting","failed"])),
      project: (.project | p(["scope","status"])),
      identity: (.identity | p(["status"])),
      outbox: (.outbox | p(
        ["status","captured","unprocessed","errors","deliveryPending",
         "deliveryClaimed","deliveryRetry","deliveryReplicated",
         "deliveryAcknowledged","deliveryAwaitingRemotePrune",
         "deliveryQuarantined"])),
      telemetry: (.telemetry | telemetry),
      remediation
    })
  }
end'
```

For the two SQL blocks, privately provision both service entries below in
`~/.pg_service.conf` with file mode `0600`. Use the direct PostgreSQL node
endpoint, never a transaction pool. Do not set ambient `PG*` variables, point
psql at LCM's staged credential files, or add URL parameters to
`LCM_POSTGRES_URL`.

<!-- incident: id=psql-services phase=recover share=private kind=example role=administrator -->
```ini
[lcm-db-runtime]
host=<direct-node-host>
port=<port>
dbname=<database>
user=<runtime-role>
sslmode=verify-full
sslrootcert=<absolute-ca-file>
connect_timeout=5
options=-c statement_timeout=2000 -c lock_timeout=1000 -c default_transaction_read_only=on

[lcm-db-administrator]
host=<direct-node-host>
port=<port>
dbname=<database>
user=<administrator-role>
sslmode=verify-full
sslrootcert=<absolute-ca-file>
connect_timeout=5
options=-c statement_timeout=2000 -c lock_timeout=1000
```

Use the runtime service for both observation queries. The alias prompt does not
sanitize the password prompt, banner, or errors. Keep the complete session
private and share only successful approved result rows. Share a fixed failure
category such as cannot connect, permission denied, or timeout, together with
the evidence timestamps.

<!-- incident: id=psql-runtime phase=observe share=private kind=psql role=runtime -->
```sh
psql -X -W --set=ON_ERROR_STOP=1 --set=HISTFILE=/dev/null --set=PROMPT1='lcm-db=> ' --set=PROMPT2='lcm-db-> ' 'service=lcm-db-runtime'
```

## Saturation

### Evidence

Use the private LCM pool observation first. It is bounded and contains counts,
not client identities.

<!-- incident: id=pool phase=observe share=private kind=lcm role=runtime -->
```sh
lcm stats --pool
```

Then capture the provider's bounded output. Run it privately and share only its
two-column stdout after removing the private command context.

<!-- incident: id=provider-state phase=observe share=approved kind=doctl role=provider-read -->
```sh
doctl --context lcm-read databases get <cluster-id> --format Status,NumNodes --no-header
```

Run SQL-SESSION-CONTEXT as the runtime role. It reports configured limits and
the current database's sessions for that same role. Runtime catalog access is
sufficient under the reviewed grants. A denial is a permission-denied result,
never a reason to add privileges.

<!-- incident: id=session-context phase=observe share=approved kind=sql role=runtime -->
```sql
SELECT pg_catalog.current_setting('max_connections')::pg_catalog.int4 AS max_connections,
       pg_catalog.current_setting('superuser_reserved_connections')::pg_catalog.int4 AS superuser_reserved_connections,
       pg_catalog.current_setting('reserved_connections')::pg_catalog.int4 AS reserved_connections,
       (pg_catalog.count(*) FILTER (
         WHERE activity.usename OPERATOR(pg_catalog.=) CURRENT_USER
           AND activity.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()
           AND activity.backend_type OPERATOR(pg_catalog.=) 'client backend'
       ))::pg_catalog.int4 AS runtime_role_client_sessions,
       pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS server_observed_at
FROM pg_catalog.pg_stat_activity AS activity;
```

### Interpretation

Daemon-origin pool ratios describe local pool pressure. Diagnostic-probe origin
describes only the temporary observer. SQL-SESSION-CONTEXT does not report free
slots or cluster-wide usage; never subtract its own-role count from
`max_connections` to claim headroom. The diagnostic session counts itself, and
its count need not equal the LCM pool because other clients may share the role.
Masked or missing values are never zero.

### Rollback

These observations are read-only. Stop after a connection, permission, or
timeout failure and preserve the private error evidence.

### Escalation

If cluster capacity remains unresolved, escalate privately to the provider
administrator. Never grant `pg_monitor` or `pg_read_all_stats` to the runtime
role.

## Slow patterns

### Evidence

Use only `backendDiagnostics.telemetry.statements` from the approved jq bundle:
status, operation IDs, cumulative numeric values, and
`statementsStatsReset` (the contract's `statements_stats_reset` value). Do not
query raw `pg_stat_statements`.

### Interpretation

Compare samples only from the same daemon. A reset, daemon or server restart,
stale publication, partial mapping, or deallocation can break comparability.
Treat `reset`, `stale`, `partial`, and omitted fields as explicit unknowns. A
missing counter is never zero.

### Rollback

Observation changes no statistics. Never reset statistics to make two samples
comparable.

### Escalation

Escalate with the projected samples and both capture times. Keep raw SQL text,
query identifiers, raw status, and stderr private.

## Migration and extension state

### Evidence

Use the private doctor output for the migration and extension families.

<!-- incident: id=doctor phase=observe share=private kind=lcm role=runtime -->
```sh
lcm doctor
```

### Interpretation

Use the fixed family statuses and remediations. `behind`, `ahead`, `drift`, and
`checksum-mismatch` are different conditions. Extension versions are useful
only with each entry's status. Permission denied means restore the exact
reviewed grant; do not add a monitoring role.

### Rollback

Doctor is read-only. If a prior operator changed grants or extensions, restore
the reviewed configuration through the owning administrative procedure before
retrying.

### Escalation

Escalate drift, unexpected history, or extension catalog disagreement with the
private doctor evidence. Do not paste database errors into the shared bundle.

## Queue backlog

### Evidence

Use the text command privately. Its results and errors are never part of the
shareable bundle.

<!-- incident: id=events-status phase=observe share=private kind=lcm role=runtime -->
```sh
lcm events status
```

Use the queue family from the approved projection for shareable counts.

### Interpretation

The backlog threshold is 900 seconds. Quarantine takes precedence over age.
`limit-reached` means the exact count and lag are unavailable. A missing value is never zero.
Local pending age uses the local clock; inbox counts and replay lag use the
database clock.

### Rollback

Status inspection is read-only. Keep quarantine inspection and replay in the
private recovery procedure below.

### Escalation

Escalate when quarantines remain, the 900-second threshold persists, or the
family is partial or unavailable. Share only the projected family and capture
time.

## Failover

### Evidence

Capture provider state with the approved two-column observation above. Run
SQL-RECOVERY-STATE as the runtime role, then repeat the private doctor check.

<!-- incident: id=recovery-state phase=observe share=approved kind=sql role=runtime -->
```sql
SELECT pg_catalog.pg_is_in_recovery() AS in_recovery,
       pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS server_observed_at;
```

### Interpretation

The query reports recovery state at the server timestamp. It does not expose
postmaster start time. A failover or restart may make the statements family
`reset` or `stale`; interpret that family by its contract.

### Rollback

Provider failover has no runbook rollback. Do not attempt another provider
action to manufacture the prior topology.

### Escalation

Escalate to provider support with the approved bundle, the output-only provider
observation, and private provider identifiers supplied through the provider's
secure channel.

## Restore

Restore is `phase=recover` and private. Quiesce every LCM writer on every
machine. Preserve the original cluster and all local state.

### Evidence

Create a task-owned private directory before capturing provider output. Its
directory mode is `0700`; the new output files inherit mode `0600` from umask
`077`.

<!-- incident: id=private-directory phase=recover share=private kind=shell role=administrator -->
```sh
umask 077
mkdir -m 0700 -- "<private-dir>"
```

Preview at most 20 provider-returned backup rows. This does not claim ordering.
Run the preview in Bash.
The checked pipeline distinguishes a provider failure from expected `head`
termination. If the required time is absent or ambiguous, stop and inspect the
control panel privately. Never infer that there are no backups from empty
output.

<!-- incident: id=backup-preview phase=recover share=private kind=doctl role=provider-read -->
```bash
set -o pipefail
doctl --context lcm-read databases backups <source-cluster-id> --format Size,Created --no-header | head -n 20
pipeline_status=("${PIPESTATUS[@]}")
(( pipeline_status[1] == 0 && (pipeline_status[0] == 0 || pipeline_status[0] == 141) ))
```

Fork once. Both streams are private; stdout contains credentials. Never display
or attach `fork.out`.

<!-- incident: id=restore-fork phase=recover share=private kind=doctl role=provider-recover -->
```sh
doctl --context lcm-recover databases fork <new-name> --restore-from-cluster-id <source-cluster-id> --restore-from-timestamp "<YYYY-MM-DD HH:MM:SS +0000 UTC>" --wait --wait-timeout 10m >"<private-dir>/fork.out" 2>"<private-dir>/fork.err"
```

Read the returned destination ID privately from that table. If output is
incomplete, use the list only as a reconciliation fallback and verify the
source, time, and intended name. Never select the first result automatically.

<!-- incident: id=restore-list phase=recover share=private kind=doctl role=provider-read -->
```sh
doctl --context lcm-read databases list --format ID,Name,Status --no-header
```

Read back that exact destination with the approved provider-state template.
Obtain credentials and CA privately through the control panel. Never use a
connection, user, or CA command.

Restore extensions and readiness, verify the migration history and chosen
recovery point, and exclude every writer from the abandoned timeline. Let
database-clock lease expiry govern takeover. Never lower the fencing sequence
manually or acknowledge an event only because a restored checkpoint says it
was applied. Run migrations with the separate migration secret only when the
history is behind.

<!-- incident: id=postgres-migrate phase=recover share=private kind=lcm role=migration -->
```sh
LCM_POSTGRES_URL="$LCM_POSTGRES_MIGRATION_URL" lcm postgres migrate
```

Recover local identity only if local state was lost.

<!-- incident: id=machine-recover phase=recover share=private kind=lcm role=runtime -->
```sh
lcm machine recover <machine-uuid>
```

<!-- incident: id=project-link phase=recover share=private kind=lcm role=runtime -->
```sh
lcm project link -- <project-uuid> <absolute-path>
```

Repoint one machine through its secure environment source, restart it, and run
the private doctor check. Then repoint every remaining machine. A missed writer
continues writing to the original cluster.

<!-- incident: id=daemon-restart phase=recover share=private kind=lcm role=runtime -->
```sh
lcm daemon restart
```

Inspect and replay quarantines only in this private phase. Use text output; do
not attach it.

<!-- incident: id=events-quarantine phase=recover share=private kind=lcm role=runtime -->
```sh
lcm events quarantine --limit 20
```

<!-- incident: id=events-replay phase=recover share=private kind=lcm role=runtime -->
```sh
lcm events replay <event-id> --machine <machine-id>
```

### Interpretation

A failed or timed-out fork may already have created a cluster. Confirm provider
state before any further write. Never retry, re-fork, or delete automatically.

### Rollback

Repointing to the original cluster is valid only before any writer has used the
fork. After a new write, stop for a reconciliation decision; never blind-repoint
between diverged timelines.

### Escalation

Escalate every ambiguous fork, recovery-point mismatch, abandoned writer,
fencing disagreement, or post-fork write conflict. Preserve both clusters and
all private evidence.

## Rotation

Rotation is `phase=recover` and private. Keep administrator access, quiesce all
writers, and rotate through an interactive administrator session.

### Evidence

<!-- incident: id=psql-administrator phase=recover share=private kind=psql role=administrator -->
```sh
psql -X -W --set=ON_ERROR_STOP=1 --set=HISTFILE=/dev/null --set=PROMPT1='lcm-db=> ' --set=PROMPT2='lcm-db-> ' 'service=lcm-db-administrator'
```

Use psql's client-side SCRAM prompt. Never put the new password in a transcript.

<!-- incident: id=password-runtime phase=recover share=private kind=psql role=administrator -->
```text
\password <runtime-role>
```

Verify a fresh connection with the runtime service. Update the secure source of
`LCM_POSTGRES_URL`, restart every daemon, restart separately managed MCP and
programmatic clients, and run the private doctor check. Rotate the migration
credential the same way as a separate operator secret; it needs no daemon
restart and is supplied only for a migration. Follow the existing CA rotation
procedure in the [PostgreSQL development guide](../src/storage/postgresql/reference/postgresql-development.md).
Revoke and regenerate provider tokens in the control panel.

### Interpretation

A successful password change is not complete until a fresh new-secret
connection authenticates and every process has restarted from the updated
secret source.

### Rollback

On failure, stay quiesced and rotate again to a known new secret through the
preserved administrator access. If the previous secret remains in the operator
secret store, set it back through the same interactive procedure.

### Escalation

If administrator access is lost, recover it in the provider control panel. Do
not broaden the runtime or migration role to work around credential recovery.

## Forbidden commands and settings

Do not use DigitalOcean `databases connection`, `databases user` commands,
`databases get-ca`, `databases pool` commands, `--show`, `--trace`, `-v` or
`--verbose`, `-o` or `--output json`, `-t` or `--access-token`, or `URI` and
`Created` columns on database list/get. `Created` is permitted only in the
bounded backup preview. Do not use `lcm events ... --json`.

Do not run `pg_stat_statements_reset`, any `pg_stat_reset` function, or grant
`pg_monitor` or `pg_read_all_stats`. Do not enable `pgaudit`,
`pg_stat_monitor`, `log_statement`, or `auto_explain` for this runbook.

The incident canaries include the exact regressions from #903, #924, and #925;
their fixes remain owned by PRs #1065, #1075, and #1080. Tests seed these seven
complete values into content and quarantine reason fields, while a separate
short marker covers `application_name` truncation:

- `file://host.invalid?q=(file://host.invalid/Users/canary/private.db`
- `file://host.invalid?q=[a=b]file://host.invalid/Users/canary/private.db`
- `file://host.invalid?next=1file://host.invalid/Users/canary/private.db`
- `file://outer.invalid?q=prefix-file://host.invalid/Users/canary/private.db`
- `file://outer.invalid#q=prefix-file://host.invalid/Users/canary/private.db`
- `file://host"name/Users/canary/private.db`
- `file://host'name/Users/canary/private.db`
