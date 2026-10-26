import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMachineContainerArgs,
  collectDatabaseReadiness,
  createDeterministicSchedule,
  parseCertificationArguments,
  prepareManagedDatabase,
  recordFaultStep,
  runLocalCertification,
  stageBuiltPackage,
  verifyDistinctMachineIdentities,
} from "../../scripts/certification-harness.mjs";

describe("certification harness", () => {
  it("executes PostgreSQL readiness with CURRENT_USER and validates the complete witness", async () => {
    const queries: string[] = [];
    const client = {
      connect: async () => undefined,
      end: async () => undefined,
      query: async (text: string) => {
        queries.push(text);
        if (text === "SHOW max_connections") return { rows: [{ max_connections: "100" }] };
        if (text === "SHOW superuser_reserved_connections") return { rows: [{ superuser_reserved_connections: "3" }] };
        if (text.includes("server_version_num")) return { rows: [{ server_version_num: 180004, server_address: "10.0.0.1", server_port: 5432, database_name: "db", role_name: "runtime", rolsuper: false, rolcreaterole: false, rolcreatedb: false }] };
        if (text.includes("pg_extension")) return { rows: ["pg_stat_statements", "pg_trgm", "pgcrypto", "unaccent"].map((name) => ({ name, schema: "public" })) };
        if (text.includes("schema_migrations")) return { rows: [{ count: 9 }] };
        if (text.includes("lcm.machines")) return { rows: [{ machines: 0, projects: 0, conversations: 0, passive_events: 0 }] };
        if (text.includes("pg_control_system")) return { rows: [{ system_identifier: "123" }] };
        throw new Error(text);
      },
    };
    await expect(collectDatabaseReadiness({
      url: "postgresql://runtime:pw@db:5432/db", ca: "ca", expectedVersionNum: 180004,
      expectedDatabase: "db", expectedPort: 5432, expectedRole: "runtime", expectedMigrationCount: 9,
      clientFactory: () => client,
    })).resolves.toMatchObject({ residualEmpty: true, setupSessionsClosed: true });
    expect(queries[0]).toContain("CURRENT_USER::text");
    expect(queries[0]).not.toContain("pg_catalog.current_user");
  });

  it("exposes manual certification scripts without a build or postbuild", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(packageJson.scripts["test:certification:local"]).toBe(
      "LCM_TEST_CONTAINER_CLI=podman timeout -k 60 10800 node scripts/certification-harness.mjs --lane local",
    );
    expect(packageJson.scripts["test:certification:managed"]).toBe(
      "node scripts/certification-harness.mjs --lane managed",
    );
    expect(packageJson.scripts["test:certification:gate"]).toBe(
      "node --experimental-strip-types scripts/certification-gate.mjs",
    );
    expect(packageJson.scripts["test:certification:local"]).not.toContain("build");
    expect(packageJson.scripts["test:certification:managed"]).not.toContain("build");
  });

  it("accepts only explicit lane, profile and evidence directory values", () => {
    expect(parseCertificationArguments(["--lane", "local", "--profile", "smoke", "--evidence-dir", "/private/evidence"])).toEqual({
      lane: "local", profile: "smoke", evidenceDirectory: "/private/evidence",
    });
    expect(() => parseCertificationArguments(["--lane", "other", "--profile", "smoke", "--evidence-dir", "/tmp/e"])).toThrow("lane");
    expect(() => parseCertificationArguments(["--lane", "local", "--profile", "smoke", "--evidence-dir", "relative"])).toThrow("absolute");
  });

  it("pins ownership, identity, limits and safe mount modes in machine argv", () => {
    const args = buildMachineContainerArgs({
      machine: "a",
      name: "lcm-pg-machine-a-abc",
      hostname: "lcm-cert-a",
      network: "lcm-pg-net-abc",
      image: "node@sha256:" + "a".repeat(64),
      ownerLabels: { "com.donadiosolutions.lcm.test.run": "abc", kind: "machine-a" },
      stagedPackage: "/private/stage",
      home: "/private/home-a",
      caFile: "/private/ca.crt",
      evidenceDirectory: "/private/evidence/a",
      wrongHost: { host: "wrong.example", address: "203.0.113.7" },
    });
    expect(args).toEqual(expect.arrayContaining([
      "--cpus", "1", "--memory", "1g", "--pids-limit", "256",
      "--user", "1000:1000", "--hostname", "lcm-cert-a",
      "--add-host", "wrong.example:203.0.113.7",
      "--volume", "/private/stage:/opt/lcm:ro,z",
      "--volume", "/private/home-a:/home/lcm:Z",
      "--volume", "/private/ca.crt:/run/lcm-ca/ca.crt:ro,z",
    ]));
    expect(args.join("\n")).not.toMatch(/\/private\/stage:.*:ro,Z/u);
    expect(args.join("\n")).not.toContain("postgresql://");
  });

  it("stages a complete already-built package without invoking a command", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-stage-source-"));
    const target = mkdtempSync(join(tmpdir(), "lcm-cert-stage-target-"));
    mkdirSync(join(root, "dist", "src", "prompts"), { recursive: true });
    mkdirSync(join(root, "dist", "src", "connectors", "templates"), { recursive: true });
    mkdirSync(join(root, "dist", "src", "storage", "postgresql", "migrations"), { recursive: true });
    for (const path of [
      "dist/lcm.mjs", "dist/src/prompts/default.yaml",
      "dist/src/connectors/templates/config.json",
      "dist/src/storage/postgresql/migrations/0001.sql",
    ]) writeFileSync(join(root, path), path);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@donadiosolutions/lcm", version: "1.2.3" }));
    writeFileSync(join(root, "test-agent.mjs"), "export {};\n");

    const result = stageBuiltPackage({ sourceRoot: root, destination: target, machineAgentPath: join(root, "test-agent.mjs") });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(readFileSync(join(target, "dist", "lcm.mjs"), "utf8")).toBe("dist/lcm.mjs");
    expect(readFileSync(join(target, "certification", "machine-agent.mjs"), "utf8")).toBe("export {};\n");
  });

  it("creates the exact full schedule and records fault transitions", () => {
    const schedule = createDeterministicSchedule({ profile: "full", machine: "a", runId: "run" });
    expect(schedule.filter((entry: any) => entry.op === "hook")).toHaveLength(600);
    expect(schedule.filter((entry: any) => entry.op === "search")).toHaveLength(1200);
    expect(schedule.filter((entry: any) => entry.op === "store")).toHaveLength(600);
    expect(schedule.filter((entry: any) => entry.op === "snapshot")).toHaveLength(100);
    expect(schedule.filter((entry: any) => entry.op === "compact")).toHaveLength(20);
    expect(recordFaultStep({ id: "partition-a", kind: "partition-machine", target: "a" }, {
      requestedAt: "r", appliedAt: "a", clearedAt: "c", recoveredAt: "z",
    })).toEqual({ id: "partition-a", kind: "partition-machine", target: "a", requestedAt: "r", appliedAt: "a", clearedAt: "c", recoveredAt: "z" });
  });

  it("proves the two private homes contain distinct machine identities", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-identities-"));
    const homes = { a: join(root, "a"), b: join(root, "b") };
    for (const machine of ["a", "b"] as const) {
      mkdirSync(join(homes[machine], ".lcm"), { recursive: true });
      writeFileSync(join(homes[machine], ".lcm", "machine.json"), JSON.stringify({
        version: 1,
        machineId: `018f0000-0000-7000-8000-00000000000${machine === "a" ? "1" : "2"}`,
        identityKey: `machine:${(machine === "a" ? "a" : "b").repeat(64)}`,
        displayName: machine,
      }));
    }
    const result = verifyDistinctMachineIdentities(homes);
    expect(result.a.machineId).not.toBe(result.b.machineId);
    expect(result.a.identityKeySha256).not.toBe(result.b.identityKeySha256);
    expect(JSON.stringify(result)).not.toContain("machine:");
  });

  it("prepares managed extensions, migrations and runtime grants without secret argv", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-managed-setup-"));
    const caFile = join(root, "ca.crt");
    writeFileSync(caFile, "certificate", { mode: 0o600 });
    const calls: Array<{ command: string; args: string[]; options: any }> = [];
    const processRunner = async (command: string, args: string[], options: any) => {
      calls.push({ command, args, options });
      if (args[1] === "inspect") {
        const name = args[2];
        const create = calls.find((call) => call.args[0] === "container" && call.args[1] === "create" && call.args.includes(name));
        const labels: Record<string, string> = {};
        if (create) for (let index = 0; index < create.args.length; index += 1) {
          if (create.args[index] === "--label") {
            const [key, value] = create.args[index + 1].split("=");
            labels[key] = value;
          }
        }
        return { stdout: JSON.stringify([{ Config: { Labels: labels }, State: { Running: false } }]), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    await prepareManagedDatabase({
      privateConnection: {
        databaseName: "lcm_cert_run12345",
        migratorName: "lcm_cert_migrator_run12345",
        runtimeName: "lcm_cert_runtime_run12345",
        adminUrl: "postgresql://admin:admin-secret@db.example:25060/lcm_cert_run12345",
        migratorUrl: "postgresql://migrator:migrator-secret@db.example:25060/lcm_cert_run12345",
      },
      runRoot: root,
      caFile,
      containerCli: "podman",
      processRunner,
      secrets: ["admin-secret", "migrator-secret"],
      sourceRoot: new URL("../..", import.meta.url).pathname,
      names: { restore: "lcm-pg-restore-aaaaaaaaaaaaaaaaaaaa", runner: "lcm-pg-runner-aaaaaaaaaaaaaaaaaaaa" },
      owner: { pid: 1, birth: "linux:12345678-1234-1234-1234-123456789abc:1", scope: "linux:12345678-1234-1234-1234-123456789abc:abc" },
      runId: "a".repeat(32),
    });
    expect(calls.filter((call) => call.command === "podman" && call.args[0] === "container" && call.args[1] === "create")).toHaveLength(2);
    expect(calls.filter((call) => call.command === process.execPath)).toHaveLength(3);
    expect(calls.flatMap((call) => call.args).join("\n")).not.toContain("admin-secret");
    expect(calls.flatMap((call) => call.args).join("\n")).not.toContain("migrator-secret");
    expect(calls.some((call) => call.args.includes("postgres") && call.args.includes("migrate"))).toBe(true);
    expect(calls.filter((call) => call.args[0] === "container" && call.args[1] === "create").at(-1)?.args.join("\n"))
      .toContain("postgresql-runtime-*-grants.sql");
    const setupCreates = calls.filter((call) => call.args[0] === "container" && call.args[1] === "create").flatMap((call) => call.args);
    expect(setupCreates).toEqual(expect.arrayContaining(["--cpus", "1", "--memory", "512m", "--pids-limit", "128"]));
    expect(setupCreates.join("\n")).toContain(":/run/lcm-ca/ca.crt:ro,z");
  });

  it("persists incomplete cleanup evidence when the local harness fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-local-failure-"));
    const evidenceDirectory = join(root, "evidence");
    await expect(runLocalCertification({
      evidenceDirectory, profile: "smoke", contract: {}, contractSha256: "a".repeat(64),
    }, {
      environment: { LCM_TEST_CONTAINER_CLI: "podman" },
      runHarness: async () => { throw new Error("harness failed"); },
    })).rejects.toThrow("harness failed");
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "cleanup.json"), "utf8"))).toMatchObject({
      verdict: "incomplete", privateRootsAbsent: false, ownedProcessesExited: false,
    });
  });
});
