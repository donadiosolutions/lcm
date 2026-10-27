import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseDaemonConfig } from "../../src/daemon/config.js";
import { runDoctor } from "../../src/doctor/doctor.js";
import { renderBackendDiagnostics } from "../../src/storage/diagnostic-renderer.js";
import { collectBackendDiagnostics } from "../../src/storage/diagnostics.js";
import { buildPostgreSqlClientConfig } from "../../src/storage/postgresql/client-config.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  assertHarnessReady,
  settings,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

const context = { domain: "factory", operation: "incidentRunbookFixture" } as const;

const regressionSeeds = [
  "file://host.invalid?q=(file://host.invalid/Users/canary/private.db",
  "file://host.invalid?q=[a=b]file://host.invalid/Users/canary/private.db",
  "file://host.invalid?next=1file://host.invalid/Users/canary/private.db",
  "file://outer.invalid?q=prefix-file://host.invalid/Users/canary/private.db",
  "file://outer.invalid#q=prefix-file://host.invalid/Users/canary/private.db",
  'file://host"name/Users/canary/private.db',
  "file://host'name/Users/canary/private.db",
] as const;

const contractCanaries = {
  message: "incident-message-content-canary",
  summary: "incident-summary-content-canary",
  memory: "incident-memory-content-canary",
  tag: "incident-tag-content-canary",
  prompt: "incident-subtask-prompt-canary",
  inference: "incident-inference-content-canary",
  sqlParameter: "incident-sql-parameter-canary",
  utilityLiteral: "incident-utility-literal-canary",
  projectPath: "/private/incident-project-path-canary",
  urlPassword: "postgresql://runtime:incident-url-password-canary@host.invalid/lcm",
  clientKey: "-----BEGIN PRIVATE KEY-----incident-client-key-canary",
  caPem: "-----BEGIN CERTIFICATE-----\nINCIDENT_CA_BODY_CANARY\n-----END CERTIFICATE-----",
  caBody: "INCIDENT_CA_BODY_CANARY",
  providerKeys: "sk-incident-provider sk-ant-incident-provider ghp_incident_provider",
  applicationName: "incident-app-canary",
} as const;

function readRunbookSql(id: "session-context" | "recovery-state"): string {
  const source = readFileSync(join(process.cwd(), "docs/incident-diagnostics.md"), "utf8");
  const marker = `<!-- incident: id=${id} phase=observe share=approved kind=sql role=runtime -->\n\`\`\`sql\n`;
  const start = source.indexOf(marker);
  const end = start < 0 ? -1 : source.indexOf("\n```", start + marker.length);
  if (start < 0 || end < 0) throw new Error(`missing approved SQL block ${id}`);
  return source.slice(start + marker.length, end);
}

async function applyRuntimeGrants(database: PostgreSqlTestDatabase): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
  try {
    for (const part of ["readiness", "identity", "conversation", "summary-context", "memory", "search", "coordination", "transcript"]) {
      const template = readFileSync(join(
        process.cwd(), `src/storage/postgresql/reference/postgresql-runtime-${part}-grants.sql`,
      ), "utf8");
      const sql = template.split("\n").filter((line) => !line.startsWith("\\"))
        .join("\n").replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
      await administrator.query({ text: sql }, context);
    }
  } finally {
    await administrator.close();
  }
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

function assertNoCanary(surface: string, canaries: readonly string[]): void {
  for (const [index, canary] of canaries.entries()) {
    for (const form of encodedForms(canary)) {
      if (surface.includes(form)) throw new Error(`incident evidence leaked canary ${index}`);
    }
  }
}

async function captureProcessStreams<T>(action: () => Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    return { value: await action(), stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

async function seedCanaries(database: PostgreSqlTestDatabase): Promise<{
  readonly projectId: string;
  readonly machineId: string;
}> {
  const project = await database.migrator.query<{ project_id: string }>({
    text: "INSERT INTO lcm.projects (identity_key, display_name) VALUES ($1, $2) RETURNING project_id",
    values: [createHash("sha256").update("incident-runbook").digest("hex"), contractCanaries.projectPath],
  }, context);
  const projectId = project.rows[0]!.project_id;
  const machine = await database.migrator.query<{ machine_id: string }>({
    text: "INSERT INTO lcm.machines (identity_key) VALUES ($1) RETURNING machine_id",
    values: [`machine:${"c".repeat(64)}`],
  }, context);
  const machineId = machine.rows[0]!.machine_id;
  const conversation = await database.migrator.query<{ conversation_id: string }>({
    text: "INSERT INTO lcm.conversations (project_id, session_id) VALUES ($1, $2) RETURNING conversation_id",
    values: [projectId, "incident-session-parameter-canary"],
  }, context);
  const conversationId = conversation.rows[0]!.conversation_id;
  const allContent = [contractCanaries.message, ...regressionSeeds].join("\n");
  const message = await database.migrator.query<{ message_id: string }>({
    text: `INSERT INTO lcm.messages (project_id, conversation_id, seq, role, content, token_count)
           VALUES ($1, $2, 0, 'user', $3, 1) RETURNING message_id`,
    values: [projectId, conversationId, allContent],
  }, context);
  await database.migrator.query({
    text: `INSERT INTO lcm.summaries
             (summary_id, project_id, conversation_id, kind, content, token_count)
           VALUES ($1, $2, $3, 'leaf', $4, 1)`,
    values: ["incident-summary-id-canary", projectId, conversationId, contractCanaries.summary],
  }, context);
  const memory = await database.migrator.query<{ memory_id: string }>({
    text: `INSERT INTO lcm.promoted_memories (project_id, content, metadata)
           VALUES ($1, $2, $3::pg_catalog.jsonb) RETURNING memory_id`,
    values: [projectId, contractCanaries.memory, JSON.stringify({
      projectPath: contractCanaries.projectPath,
      urlPassword: contractCanaries.urlPassword,
      caPem: contractCanaries.caPem,
      providerKeys: contractCanaries.providerKeys,
    })],
  }, context);
  await database.migrator.query({
    text: `INSERT INTO lcm.promoted_memory_tags (project_id, memory_id, ordinal, tag)
           VALUES ($1, $2, 0, $3)`,
    values: [projectId, memory.rows[0]!.memory_id, contractCanaries.tag],
  }, context);
  await database.migrator.query({
    text: `INSERT INTO lcm.message_parts
             (project_id, conversation_id, message_id, session_id, part_type,
              ordinal, text_content, subtask_prompt, tool_output, metadata)
           VALUES ($1, $2, $3, $4, 'subtask', 0, $5, $6, $7, $8)`,
    values: [projectId, conversationId, message.rows[0]!.message_id,
      "incident-session-parameter-canary", contractCanaries.inference,
      contractCanaries.prompt, contractCanaries.clientKey, contractCanaries.providerKeys],
  }, context);
  await database.migrator.query({
    text: `INSERT INTO lcm.passive_event_inbox
             (project_id, machine_id, event_id, event_version, machine_sequence,
              event_type, payload, status, quarantined_at, quarantine_reason)
           VALUES ($1, $2, gen_random_uuid(), 1, 0, 'incident-canary',
                   $3::pg_catalog.jsonb, 'quarantined', pg_catalog.clock_timestamp(), $4)`,
    values: [projectId, machineId,
      JSON.stringify({ content: allContent, ca: contractCanaries.caPem }),
      [contractCanaries.message, ...regressionSeeds].join("\n")],
  }, context);
  await database.runtime.query({ text: "SELECT $1::pg_catalog.text", values: [contractCanaries.sqlParameter] }, context);
  await database.runtime.query({ text: "SET application_name = 'incident-utility-literal-canary'" }, context);
  return { projectId, machineId };
}

describe("incident runbook PostgreSQL evidence", () => {
  it("executes the approved SQL with runtime grants and rejects seeded leaks", async () => {
    await withPostgreSqlTestDatabase("incident-runbook", async (database) => {
      await applyRuntimeGrants(database);
      const { projectId, machineId } = await seedCanaries(database);
      const home = mkdtempSync(join(tmpdir(), "lcm-incident-runbook-"));
      mkdirSync(join(home, ".lcm"), { mode: 0o700 });
      writeFileSync(join(home, ".lcm", "config.json"), "{}", { mode: 0o600 });
      const held = new Client(buildPostgreSqlClientConfig(
        settings(database.runtimeUrl), { applicationName: contractCanaries.applicationName },
      ));
      try {
        await held.connect();
        await held.query("SELECT 1");
        const session = await database.runtime.query({ text: readRunbookSql("session-context") }, context);
        const recovery = await database.runtime.query({ text: readRunbookSql("recovery-state") }, context);
        expect(session.rows).toHaveLength(1);
        expect(session.fields.map((field) => [field.name, field.dataTypeID])).toEqual([
          ["max_connections", 23],
          ["superuser_reserved_connections", 23],
          ["reserved_connections", 23],
          ["runtime_role_client_sessions", 23],
          ["server_observed_at", 25],
        ]);
        const sessionRow = session.rows[0] as Record<string, unknown>;
        for (const field of ["max_connections", "superuser_reserved_connections", "reserved_connections", "runtime_role_client_sessions"]) {
          expect(Number.isSafeInteger(sessionRow[field]) && Number(sessionRow[field]) >= 0, field).toBe(true);
        }
        expect(sessionRow.runtime_role_client_sessions).toBeGreaterThanOrEqual(2);
        expect(sessionRow.server_observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
        expect(recovery.rows).toHaveLength(1);
        expect(recovery.fields.map((field) => [field.name, field.dataTypeID])).toEqual([
          ["in_recovery", 16],
          ["server_observed_at", 25],
        ]);
        expect(typeof (recovery.rows[0] as Record<string, unknown>).in_recovery).toBe("boolean");
        expect((recovery.rows[0] as Record<string, unknown>).server_observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);

        const connection = new URL(database.runtimeUrl);
        const ca = readFileSync(settings(database.runtimeUrl).caFile, "utf8");
        const canaries = [
          ...Object.values(contractCanaries), ...regressionSeeds,
          "/Users/canary/private.db", database.name, "lcm_test_runtime",
          connection.hostname, connection.password, ca,
        ];
        const approvedRows = JSON.stringify([session.rows, recovery.rows]);
        assertNoCanary(approvedRows, canaries);

        const config = parseDaemonConfig("{}");
        config.storage = { backend: "postgresql", postgresql: { ...settings(database.runtimeUrl), migrationRole: "lcm_test_migrator" } };
        const captured = await captureProcessStreams(async () => {
          const snapshot = await collectBackendDiagnostics({
            cwd: "/incident-fixture",
            homeDir: home,
            _dependencies: { observePublication: () => ({
              config,
              witness: "incident-witness",
              machineId,
              mapContent: JSON.stringify({ ["a".repeat(64)]: {
                canonical: "/incident-fixture", aliases: [], remoteProjectId: projectId,
              } }),
            }) },
          });
          expect(snapshot.schema).toBe("ready");
          expect(snapshot.project).toMatchObject({ scope: "selected", status: "ready", projectId });
          expect(snapshot.identity).toMatchObject({ status: "ready", machineId });
          const rendered = renderBackendDiagnostics(snapshot);
          const doctor = await runDoctor({
            homedir: home,
            cwd: home,
            fetch: vi.fn(),
            spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" }),
            collectBackendSnapshot: vi.fn().mockResolvedValue(snapshot),
          });
          const backendHealth = doctor.find((result) => result.name === "backend-health");
          expect(backendHealth).toMatchObject({ message: rendered, backendDiagnostics: snapshot });
          return { rendered, backendHealth, doctor };
        });
        const { rendered, backendHealth, doctor } = captured.value;
        const privateSurfaces = [
          rendered, JSON.stringify(backendHealth), JSON.stringify(doctor), captured.stdout, captured.stderr,
        ].join("\n");
        assertNoCanary(privateSurfaces, [...Object.values(contractCanaries), ...regressionSeeds]);
        expect(rendered).toContain(projectId);
        expect(rendered).toContain(machineId);

        const leaking = await database.runtime.query<{ application_name: string; content: string }>({
          text: `SELECT activity.application_name, message.content
                 FROM pg_catalog.pg_stat_activity AS activity
                 CROSS JOIN lcm.messages AS message
                 WHERE activity.application_name OPERATOR(pg_catalog.=) $1
                   AND message.project_id OPERATOR(pg_catalog.=) $2::pg_catalog.uuid
                 LIMIT 1`,
          values: [contractCanaries.applicationName, projectId],
        }, context);
        expect(leaking.rows).toHaveLength(1);
        expect(() => assertNoCanary(JSON.stringify(leaking.rows), canaries)).toThrow(/leaked canary/u);
      } finally {
        try {
          await held.end();
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      }
    });
  }, 30_000);

  it("proves the process-stream control captures a leak", async () => {
    const canary = "incident-control-stream-canary";
    const captured = await captureProcessStreams(async () => {
      process.stdout.write(canary);
      process.stderr.write(canary);
      return true;
    });
    expect(captured).toEqual({ value: true, stdout: canary, stderr: canary });
    expect(() => assertNoCanary(`${captured.stdout}\n${captured.stderr}`, [canary])).toThrow(/leaked canary/u);
  });
});
