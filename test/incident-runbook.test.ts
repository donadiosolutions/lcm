import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readRepositoryFile(file: string): string {
  return readFileSync(join(repositoryRoot, file), "utf8");
}

const SQL_RECOVERY_STATE = `SELECT pg_catalog.pg_is_in_recovery() AS in_recovery,
       pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS server_observed_at;`;

const SQL_SESSION_CONTEXT = `SELECT pg_catalog.current_setting('max_connections')::pg_catalog.int4 AS max_connections,
       pg_catalog.current_setting('superuser_reserved_connections')::pg_catalog.int4 AS superuser_reserved_connections,
       pg_catalog.current_setting('reserved_connections')::pg_catalog.int4 AS reserved_connections,
       (pg_catalog.count(*) FILTER (
         WHERE activity.usename OPERATOR(pg_catalog.=) CURRENT_USER
           AND activity.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()
           AND activity.backend_type OPERATOR(pg_catalog.=) 'client backend'
       ))::pg_catalog.int4 AS runtime_role_client_sessions,
       pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS server_observed_at
FROM pg_catalog.pg_stat_activity AS activity;`;

const JQ_PROGRAM = `def p($keys):
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
end`;

const STATUS_BUNDLE = `set -o pipefail
lcm status --json | jq -e '${JQ_PROGRAM}'`;

type Phase = "observe" | "recover";
type Sharing = "approved" | "private";
type Kind = "lcm" | "doctl" | "sql" | "psql" | "shell" | "example";
type Role = "runtime" | "migration" | "administrator" | "provider-read" | "provider-recover";

interface RegistryEntry {
  readonly phase: Phase;
  readonly share: Sharing;
  readonly kind: Kind;
  readonly role: Role;
  readonly body?: string;
  readonly sha256?: string;
}

const registry = {
  "capture-time": { phase: "observe", share: "approved", kind: "shell", role: "runtime", body: "date -u +%Y-%m-%dT%H:%M:%SZ" },
  "status-bundle": { phase: "observe", share: "approved", kind: "shell", role: "runtime", body: STATUS_BUNDLE },
  "psql-services": { phase: "recover", share: "private", kind: "example", role: "administrator", body: `[lcm-db-runtime]
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
options=-c statement_timeout=2000 -c lock_timeout=1000` },
  "psql-runtime": { phase: "observe", share: "private", kind: "psql", role: "runtime", body: "psql -X -W --set=ON_ERROR_STOP=1 --set=HISTFILE=/dev/null --set=PROMPT1='lcm-db=> ' --set=PROMPT2='lcm-db-> ' 'service=lcm-db-runtime'" },
  "doctl-auth-read": { phase: "recover", share: "private", kind: "doctl", role: "provider-read", body: "doctl auth init --context lcm-read" },
  "doctl-auth-recover": { phase: "recover", share: "private", kind: "doctl", role: "provider-recover", body: "doctl auth init --context lcm-recover" },
  "pool": { phase: "observe", share: "private", kind: "lcm", role: "runtime", body: "lcm stats --pool" },
  "provider-state": { phase: "observe", share: "approved", kind: "doctl", role: "provider-read", body: "doctl --context lcm-read databases get <cluster-id> --format Status,NumNodes --no-header" },
  "session-context": { phase: "observe", share: "approved", kind: "sql", role: "runtime", sha256: "2ad458832a313c34ddaf5977271ec3c23797b59c7d58ae5597dbf8567a191e6f" },
  "doctor": { phase: "observe", share: "private", kind: "lcm", role: "runtime", body: "lcm doctor" },
  "events-status": { phase: "observe", share: "private", kind: "lcm", role: "runtime", body: "lcm events status" },
  "recovery-state": { phase: "observe", share: "approved", kind: "sql", role: "runtime", sha256: "817247afbd1e336baad3ee4a4c6a1ad4c270224997996199a9ceda8199e87627" },
  "private-directory": { phase: "recover", share: "private", kind: "shell", role: "administrator", body: `umask 077
mkdir -m 0700 -- "<private-dir>"` },
  "backup-preview": { phase: "recover", share: "private", kind: "doctl", role: "provider-read", body: `set -o pipefail
doctl --context lcm-read databases backups <source-cluster-id> --format Size,Created --no-header | head -n 20
pipeline_status=("\${PIPESTATUS[@]}")
(( pipeline_status[1] == 0 && (pipeline_status[0] == 0 || pipeline_status[0] == 141) ))` },
  "restore-fork": { phase: "recover", share: "private", kind: "doctl", role: "provider-recover", body: "doctl --context lcm-recover databases fork <new-name> --restore-from-cluster-id <source-cluster-id> --restore-from-timestamp \"<YYYY-MM-DD HH:MM:SS +0000 UTC>\" --wait --wait-timeout 10m >\"<private-dir>/fork.out\" 2>\"<private-dir>/fork.err\"" },
  "restore-list": { phase: "recover", share: "private", kind: "doctl", role: "provider-read", body: "doctl --context lcm-read databases list --format ID,Name,Status --no-header" },
  "postgres-migrate": { phase: "recover", share: "private", kind: "lcm", role: "migration", body: "LCM_POSTGRES_URL=\"$LCM_POSTGRES_MIGRATION_URL\" lcm postgres migrate" },
  "machine-recover": { phase: "recover", share: "private", kind: "lcm", role: "runtime", body: "lcm machine recover <machine-uuid>" },
  "project-link": { phase: "recover", share: "private", kind: "lcm", role: "runtime", body: "lcm project link -- <project-uuid> <absolute-path>" },
  "daemon-restart": { phase: "recover", share: "private", kind: "lcm", role: "runtime", body: "lcm daemon restart" },
  "events-quarantine": { phase: "recover", share: "private", kind: "lcm", role: "runtime", body: "lcm events quarantine --limit 20" },
  "events-replay": { phase: "recover", share: "private", kind: "lcm", role: "runtime", body: "lcm events replay <event-id> --machine <machine-id>" },
  "psql-administrator": { phase: "recover", share: "private", kind: "psql", role: "administrator", body: "psql -X -W --set=ON_ERROR_STOP=1 --set=HISTFILE=/dev/null --set=PROMPT1='lcm-db=> ' --set=PROMPT2='lcm-db-> ' 'service=lcm-db-administrator'" },
  "password-runtime": { phase: "recover", share: "private", kind: "psql", role: "administrator", body: "\\password <runtime-role>" },
} as const satisfies Record<string, RegistryEntry>;

interface IncidentBlock {
  readonly id: string;
  readonly phase: Phase;
  readonly share: Sharing;
  readonly kind: Kind;
  readonly role: Role;
  readonly language: string;
  readonly body: string;
}

const annotationPattern = /<!-- incident: id=([a-z0-9-]+) phase=(observe|recover) share=(approved|private) kind=(lcm|doctl|sql|psql|shell|example) role=(runtime|migration|administrator|provider-read|provider-recover) -->\n```([a-z]+)\n([\s\S]*?)\n```/gu;

function blocksOf(source: string): IncidentBlock[] {
  return [...source.matchAll(annotationPattern)].map((match) => ({
    id: match[1]!,
    phase: match[2]! as Phase,
    share: match[3]! as Sharing,
    kind: match[4]! as Kind,
    role: match[5]! as Role,
    language: match[6]!,
    body: match[7]!,
  }));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertDoctl(block: IncidentBlock): void {
  const command = block.body.split("\n").find((line) => line.startsWith("doctl ")) ?? block.body;
  const words = command.match(/"[^"]*"|'[^']*'|\S+/gu) ?? [];
  const forbidden = words.find((word) => ["--show", "--trace", "-v", "--verbose", "-o", "--output", "-t", "--access-token"].includes(word));
  if (forbidden !== undefined) throw new Error(`forbidden doctl flag ${forbidden}`);
  const databases = words.indexOf("databases");
  if (databases >= 0 && ["connection", "user", "get-ca", "pool"].includes(words[databases + 1] ?? "")) {
    throw new Error(`forbidden doctl subcommand ${words[databases + 1]}`);
  }
  const format = words.indexOf("--format");
  if (format >= 0 && /(?:^|,)URI(?:,|$)/u.test(words[format + 1] ?? "")) throw new Error("forbidden doctl URI column");
  const allowedColumns: Record<string, string> = {
    get: "Status,NumNodes",
    list: "ID,Name,Status",
    backups: "Size,Created",
  };
  const subcommand = words[databases + 1] ?? "";
  if (format >= 0 && subcommand in allowedColumns && words[format + 1] !== allowedColumns[subcommand]) {
    throw new Error(`unapproved doctl columns for ${subcommand}`);
  }
  if (format >= 0 && ["get", "list", "backups"].includes(words[databases + 1] ?? "") && !words.includes("--no-header")) {
    throw new Error("doctl tabular output requires --no-header");
  }
  if (block.id === "restore-fork" && (!block.body.includes('>"<private-dir>/fork.out"') || !block.body.includes('2>"<private-dir>/fork.err"'))) {
    throw new Error("fork must capture stdout and stderr privately");
  }
}

function assertSql(block: IncidentBlock): void {
  if (/\bSELECT\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?\*/iu.test(block.body)) throw new Error("SQL wildcard projection");
  if (/\b(?:string_agg|array_agg|json_agg|jsonb_agg)\s*\(/iu.test(block.body)) throw new Error("SQL text aggregate");
  if (/\b(?:queryid|query|application_name|client_addr|client_hostname|ssl|pem|content|payload|quarantine_reason)\b/iu.test(block.body)) {
    throw new Error("SQL forbidden identifier");
  }
  const expectedAliases = block.id === "session-context"
    ? ["max_connections", "superuser_reserved_connections", "reserved_connections", "runtime_role_client_sessions", "server_observed_at"]
    : ["in_recovery", "server_observed_at"];
  const projection = block.body.split(/\nFROM /u)[0]!;
  const aliases = [...projection.matchAll(/\bAS\s+([a-z_][a-z0-9_]*)/giu)].map((match) => match[1]);
  if (JSON.stringify(aliases) !== JSON.stringify(expectedAliases)) throw new Error("SQL result schema changed");
}

function assertExample(block: IncidentBlock): void {
  if (/(?:https?|postgres(?:ql)?):\/\/|-----BEGIN|\b(?:sk-|sk-ant-|ghp_)[A-Za-z0-9_-]*|(?:^|[^<\d])(?:\d{1,3}\.){3}\d{1,3}(?:$|[^>\d])|[A-Fa-f0-9:]{2,}:[A-Fa-f0-9:]{2,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/imu.test(block.body)) {
    throw new Error("example contains a sensitive value");
  }
  if (block.body.split("\n").length > 30) throw new Error("example is unbounded");
}

function validateRunbook(source: string): IncidentBlock[] {
  const blocks = blocksOf(source);
  const fenceCount = (source.match(/^```/gmu) ?? []).length / 2;
  if (fenceCount !== blocks.length) throw new Error("unannotated fenced block");
  if (new Set(blocks.map((block) => block.id)).size !== blocks.length) throw new Error("duplicate incident block ID");
  if (JSON.stringify(blocks.map((block) => block.id).sort()) !== JSON.stringify(Object.keys(registry).sort())) {
    throw new Error("incident block registry mismatch");
  }
  for (const block of blocks) {
    const expected = registry[block.id as keyof typeof registry];
    if (expected === undefined) throw new Error(`unknown incident block ${block.id}`);
    for (const field of ["phase", "share", "kind", "role"] as const) {
      if (block[field] !== expected[field]) throw new Error(`${block.id} ${field} changed`);
    }
    if (block.phase === "recover" && block.share !== "private") throw new Error("recovery block must stay private");
    if (block.kind === "doctl") assertDoctl(block);
    if (block.kind === "sql") assertSql(block);
    if (block.kind === "example") assertExample(block);
    if (block.kind === "psql" && /postgres(?:ql)?:\/\//iu.test(block.body)) throw new Error("psql URL on argv");
    if (block.kind === "lcm" && /^lcm events\b[\s\S]*\s--json(?:\s|$)/u.test(block.body)) throw new Error("event JSON is forbidden");
    if ("body" in expected && block.body !== expected.body) throw new Error(`${block.id} command template changed`);
    if ("sha256" in expected && hash(block.body) !== expected.sha256) throw new Error(`${block.id} SQL changed`);
  }
  const registeredCommands = new Set(blocks.map((block) => block.body));
  const forbiddenInline = new Set(["lcm events ... --json"]);
  for (const match of source.matchAll(/`([^`\n]+)`/gu)) {
    const command = match[1]!;
    if (/^(?:lcm|doctl|psql|SELECT)(?:\s|$)/u.test(command)
      && !registeredCommands.has(command) && !forbiddenInline.has(command)) {
      throw new Error(`unregistered inline command ${command}`);
    }
  }
  return blocks;
}

function encodedForms(value: string): string[] {
  return [
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    Buffer.from(value, "utf8").toString("base64"),
    Buffer.from(value, "utf8").toString("hex"),
  ];
}

function nestedCanaries(value: unknown): string[] {
  if (typeof value === "string" && value.startsWith("DROP_CANARY_")) return [value];
  if (Array.isArray(value)) return value.flatMap(nestedCanaries);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(nestedCanaries);
  return [];
}

function statusFixture(): Record<string, unknown> {
  return {
    diagnosticSource: "daemon",
    daemon: { status: "up", port: "DROP_CANARY_DAEMON_PORT", endpoint: "DROP_CANARY_DAEMON_ENDPOINT" },
    project: "DROP_CANARY_ENVELOPE_PROJECT",
    metrics: { content: "DROP_CANARY_ENVELOPE_METRICS" },
    unknown: "DROP_CANARY_ENVELOPE_UNKNOWN",
    backendDiagnostics: {
      backend: "postgresql", classification: "healthy", publication: "ready", tls: "ready", schema: "ready", extensions: "ready", search: "ready",
      unknown: "DROP_CANARY_BACKEND_UNKNOWN",
      pool: { origin: "daemon", status: "ready", configuredMax: 4, total: 2, idle: 1, waiting: 0, failed: false, endpoint: "DROP_CANARY_POOL_ENDPOINT" },
      project: { scope: "selected", status: "ready", projectId: "019ce627-88da-7000-8000-000000000001", localProjectId: "a".repeat(64), path: "DROP_CANARY_PROJECT_PATH" },
      identity: { status: "ready", machineId: "019ce627-88da-7000-8000-000000000002", key: "DROP_CANARY_MACHINE_KEY" },
      outbox: { status: "ready", captured: 4, unprocessed: 1, errors: 0, deliveryPending: 1, deliveryClaimed: 0, deliveryRetry: 0, deliveryReplicated: 2, deliveryAcknowledged: 1, deliveryAwaitingRemotePrune: 0, deliveryQuarantined: 0, eventId: "DROP_CANARY_EVENT_ID" },
      telemetry: {
        pool: { status: "observed", observedAt: 10, health: "healthy", omitted: [{ field: "saturationRatio", reason: "no-entry", detail: "DROP_CANARY_POOL_OMISSION" }], remediation: "No action required.", saturationRatio: 0.25, extra: "DROP_CANARY_POOL_EXTRA" },
        migration: { status: "observed", observedAt: 11, health: "healthy", omitted: [], remediation: "No action required.", historyStatus: "current", appliedCount: 7, expectedCount: 7, migrationId: "DROP_CANARY_MIGRATION_ID" },
        extensions: { status: "observed", observedAt: 12, health: "healthy", omitted: [], remediation: "No action required.", entries: [{ name: "pgcrypto", status: "current", installedVersion: "1.3", defaultVersion: "1.3", schema: "DROP_CANARY_EXTENSION_SCHEMA" }], extra: "DROP_CANARY_EXTENSIONS_EXTRA" },
        queue: { status: "observed", observedAt: 13, health: "healthy", omitted: [], remediation: "No action required.", outboxOldestPendingAgeSeconds: 1, inboxClaimed: 0, inboxQuarantined: 0, replayLagSeconds: 0, reason: "DROP_CANARY_QUEUE_REASON" },
        statements: { status: "observed", observedAt: 14, scope: "aggregate", statementsDeallocTotal: 0, statementsStatsReset: "2026-10-20T00:00:00.000000Z", blockSize: 8192, query: "DROP_CANARY_STATEMENT_TEXT", queryid: "DROP_CANARY_QUERY_ID", omitted: { blockSize: "permission-denied", secret: "DROP_CANARY_STATEMENT_OMISSION" }, operations: [{ operation: "conversations.getMessageCount", values: { queryCallsTotal: 2, queryRowsTotal: 2, queryText: "DROP_CANARY_QUERY_TEXT" }, omitted: { queryWalBytesTotal: "no-entry", queryText: "DROP_CANARY_QUERY_OMITTED" }, queryid: "DROP_CANARY_OPERATION_ID" }] },
        extra: "DROP_CANARY_TELEMETRY_EXTRA",
      },
      metrics: { content: "DROP_CANARY_BACKEND_METRICS" },
      remediation: "Run `lcm doctor` to recheck backend readiness.",
    },
  };
}

describe("incident diagnostics runbook", () => {
  it("registers every copyable block and keeps recovery output private", () => {
    const source = readRepositoryFile("docs/incident-diagnostics.md");
    const blocks = validateRunbook(source);
    expect(blocks.filter((block) => block.phase === "recover").every((block) => block.share === "private")).toBe(true);
    expect(source).toContain("runtime, migration, administrator");
    expect(source).toContain("lcm-db");
    expect(source).toContain("Application alias: **lcm**");
    expect(source).toContain("`database:create` authority is wider than database forking");
  });

  it("requires evidence, interpretation, rollback, and escalation for every incident family", () => {
    const source = readRepositoryFile("docs/incident-diagnostics.md");
    for (const section of ["Saturation", "Slow patterns", "Migration and extension state", "Queue backlog", "Failover", "Restore", "Rotation"]) {
      const start = source.indexOf(`## ${section}`);
      const end = source.indexOf("\n## ", start + 4);
      const body = source.slice(start, end < 0 ? undefined : end);
      expect(start, section).toBeGreaterThanOrEqual(0);
      for (const heading of ["Evidence", "Interpretation", "Rollback", "Escalation"]) expect(body, `${section}: ${heading}`).toContain(`### ${heading}`);
    }
    expect(source).toContain("`statementsStatsReset` (the contract's `statements_stats_reset` value)");
    expect(source).toContain("same daemon");
    expect(source).toContain("A missing value is never zero");
  });

  it("executes the documented jq program and exposes only recursively allowlisted keys", () => {
    const source = readRepositoryFile("docs/incident-diagnostics.md");
    const block = validateRunbook(source).find((candidate) => candidate.id === "status-bundle")!;
    const program = /\| jq -e '([\s\S]+)'$/u.exec(block.body)?.[1];
    expect(program).toBe(JQ_PROGRAM);
    const input = statusFixture();
    const output = execFileSync("/usr/bin/jq", ["-e", program!], { input: JSON.stringify(input), encoding: "utf8" });
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed).toEqual({
      diagnosticSource: "daemon",
      backendDiagnostics: {
        backend: "postgresql", classification: "healthy", publication: "ready", tls: "ready", schema: "ready", extensions: "ready", search: "ready",
        pool: { origin: "daemon", status: "ready", configuredMax: 4, total: 2, idle: 1, waiting: 0, failed: false },
        project: { scope: "selected", status: "ready" }, identity: { status: "ready" },
        outbox: { status: "ready", captured: 4, unprocessed: 1, errors: 0, deliveryPending: 1, deliveryClaimed: 0, deliveryRetry: 0, deliveryReplicated: 2, deliveryAcknowledged: 1, deliveryAwaitingRemotePrune: 0, deliveryQuarantined: 0 },
        telemetry: {
          pool: { status: "observed", observedAt: 10, health: "healthy", omitted: [{ field: "saturationRatio", reason: "no-entry" }], remediation: "No action required.", saturationRatio: 0.25 },
          migration: { status: "observed", observedAt: 11, health: "healthy", omitted: [], remediation: "No action required.", historyStatus: "current", appliedCount: 7, expectedCount: 7 },
          extensions: { status: "observed", observedAt: 12, health: "healthy", omitted: [], remediation: "No action required.", entries: [{ name: "pgcrypto", status: "current", installedVersion: "1.3", defaultVersion: "1.3" }] },
          queue: { status: "observed", observedAt: 13, health: "healthy", omitted: [], remediation: "No action required.", outboxOldestPendingAgeSeconds: 1, inboxClaimed: 0, inboxQuarantined: 0, replayLagSeconds: 0 },
          statements: { status: "observed", observedAt: 14, scope: "aggregate", statementsDeallocTotal: 0, statementsStatsReset: "2026-10-20T00:00:00.000000Z", blockSize: 8192, omitted: { blockSize: "permission-denied" }, operations: [{ operation: "conversations.getMessageCount", values: { queryCallsTotal: 2, queryRowsTotal: 2 }, omitted: { queryWalBytesTotal: "no-entry" } }] },
        },
        remediation: "Run `lcm doctor` to recheck backend readiness.",
      },
    });
    for (const canary of nestedCanaries(input)) for (const encoded of encodedForms(canary)) expect(output).not.toContain(encoded);
    expect(output).not.toContain("019ce627-88da-7000-8000-000000000001");
    expect(output).not.toContain("019ce627-88da-7000-8000-000000000002");
    expect(output).not.toContain("a".repeat(64));
  });

  it("rejects leak-prone mutations before the exact registry check", () => {
    const source = readRepositoryFile("docs/incident-diagnostics.md");
    const cases: Array<[string, string, RegExp]> = [
      ["wildcard", source.replace("pg_catalog.count(*) FILTER", "SELECT * FROM pg_catalog.pg_stat_activity; -- pg_catalog.count(*) FILTER"), /wildcard projection/u],
      ["text aggregate", source.replace("pg_catalog.count(*) FILTER", "pg_catalog.string_agg(activity.application_name, ',') FILTER"), /text aggregate/u],
      ["content as count", source.replace("pg_catalog.count(*) FILTER", "activity.application_name AS max_connections, pg_catalog.count(*) FILTER"), /forbidden identifier/u],
      ["query identifier", source.replace("FROM pg_catalog.pg_stat_activity", ", activity.queryid AS queryid\nFROM pg_catalog.pg_stat_activity"), /forbidden identifier/u],
      ["JSON output", source.replace("--format Status,NumNodes", "-o json --format Status,NumNodes"), /forbidden doctl flag/u],
      ["show", source.replace("--format Status,NumNodes", "--show --format Status,NumNodes"), /forbidden doctl flag/u],
      ["argv token", source.replace("--context lcm-read databases get", "-t secret --context lcm-read databases get"), /forbidden doctl flag/u],
      ["URI column", source.replace("--format Status,NumNodes", "--format Status,NumNodes,URI"), /URI column/u],
      ["connection", source.replace("databases get <cluster-id>", "databases connection <cluster-id>"), /forbidden doctl subcommand/u],
      ["stdout-only fork", source.replace(' 2>"<private-dir>/fork.err"', ""), /capture stdout and stderr/u],
      ["event JSON", source.replace("lcm events quarantine --limit 20", "lcm events quarantine --limit 20 --json"), /event JSON/u],
      ["psql URL", source.replace("'service=lcm-db-runtime'", "'postgresql://runtime:secret@host/lcm'"), /psql URL/u],
      ["example URL", source.replace("host=<direct-node-host>", "host=https://private.invalid"), /sensitive value/u],
      ["unannotated", source.replace(/<!-- incident: id=capture-time[^\n]+ -->\n/u, ""), /unannotated fenced block/u],
    ];
    for (const [name, mutation, error] of cases) expect(() => validateRunbook(mutation), name).toThrow(error);
  });

  it("keeps the explicit forbidden surface and exact sanitizer regression seeds", () => {
    const source = readRepositoryFile("docs/incident-diagnostics.md");
    for (const forbidden of [
      "databases connection", "databases user", "databases get-ca", "databases pool", "--show", "--trace", "--verbose", "--output json", "--access-token",
      "lcm events ... --json", "pg_stat_statements_reset", "pg_stat_reset", "pg_monitor", "pg_read_all_stats", "pgaudit", "pg_stat_monitor", "log_statement", "auto_explain",
    ]) expect(source, forbidden).toContain(forbidden);
    for (const seed of [
      "file://host.invalid?q=(file://host.invalid/Users/canary/private.db",
      "file://host.invalid?q=[a=b]file://host.invalid/Users/canary/private.db",
      "file://host.invalid?next=1file://host.invalid/Users/canary/private.db",
      "file://outer.invalid?q=prefix-file://host.invalid/Users/canary/private.db",
      "file://outer.invalid#q=prefix-file://host.invalid/Users/canary/private.db",
      "file://host\"name/Users/canary/private.db",
      "file://host'name/Users/canary/private.db",
    ]) expect(source, seed).toContain(seed);
    expect(source).toContain("#903");
    expect(source).toContain("#924");
    expect(source).toContain("#925");
  });
});

export { SQL_RECOVERY_STATE, SQL_SESSION_CONTEXT, validateRunbook };
