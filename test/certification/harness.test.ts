import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DATABASE_IDENTITY_SQL,
  MACHINE_DATABASE_CLEARANCE_SCRIPT,
  assertExecutionProvenance,
  buildMachineContainerArgs,
  captureExecutionHost,
  captureExecutionProvenance,
  collectDatabaseReadiness,
  collectResidualState,
  collectSetupSessionClosure,
  createDeterministicSchedule,
  machineDatabaseClearanceArgs,
  parseCertificationArguments,
  prepareManagedDatabase,
  recordFaultStep,
  runLocalCertification,
  runMachineActivationBarrier,
  stageBuiltPackage,
  startClockMonitor,
  validateRunnerSku,
  verifyDistinctMachineIdentities,
  waitForMachineFiles,
  waitForMachineDatabaseClearance,
} from "../../scripts/certification-harness.mjs";
import { createRunNames } from "../../scripts/postgresql-harness.mjs";
import { loadCertificationContract } from "./contract.mjs";
import { createGitCheckoutFixture } from "./git-checkout-fixture.js";
import { waitForControl } from "./machine-agent.mjs";

// Scripted failures for the mocked PostgreSQL client: each connect fails while
// connectFailures is positive, as a connection refused during a database restart does.
const pgScript = vi.hoisted(() => ({ connectFailures: 0, connects: 0 }));
vi.mock("pg", () => ({
  Client: class {
    on() { return this; }
    async connect() {
      pgScript.connects += 1;
      if (pgScript.connectFailures > 0) {
        pgScript.connectFailures -= 1;
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
      }
    }
    async query(text: string) {
      return text.includes("clock_timestamp")
        ? { rows: [{ now: "2026-10-26T10:00:00.000Z" }] }
        : { rows: [] };
    }
    async end() {}
  },
}));

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
    })).resolves.toMatchObject({ residualEmpty: true });
    expect(queries[0]).toContain("CURRENT_USER::text");
    expect(queries[0]).not.toContain("pg_catalog.current_user");
  });

  it("separates pre-activation residual state from measured setup-session closure", async () => {
    const clients = [
      { connect: async () => undefined, end: async () => undefined, query: async () => ({ rows: [{ machines: 0, projects: 0, conversations: 0, passive_events: 0 }] }) },
      { connect: async () => undefined, end: async () => undefined, query: async () => ({ rows: [{ role_name: "migrator", connections: 1 }] }) },
    ];
    await expect(collectResidualState({ url: "postgresql://x", ca: "ca", clientFactory: () => clients.shift() })).resolves.toMatchObject({ residualEmpty: true });
    await expect(collectSetupSessionClosure({ url: "postgresql://x", ca: "ca", roles: ["migrator", "transfer"], clientFactory: () => clients.shift() })).resolves.toMatchObject({
      setupSessionsClosed: false,
      totalConnections: 1,
      roles: { migrator: 1, transfer: 0 },
    });
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
    expect(parseCertificationArguments(["--lane", "local", "--", "--profile", "smoke", "--evidence-dir", "/private/evidence"])).toEqual({
      lane: "local", profile: "smoke", evidenceDirectory: "/private/evidence",
    });
    expect(() => parseCertificationArguments(["--lane", "other", "--profile", "smoke", "--evidence-dir", "/tmp/e"])).toThrow("lane");
    expect(() => parseCertificationArguments(["--lane", "local", "--profile", "smoke", "--evidence-dir", "relative"])).toThrow("absolute");
  });

  it("accepts the valueless --with-faults option only for a local smoke run", () => {
    const expected = { lane: "local", profile: "smoke", evidenceDirectory: "/private/evidence", withFaults: true };
    expect(parseCertificationArguments(["--lane", "local", "--", "--profile", "smoke", "--with-faults", "--evidence-dir", "/private/evidence"])).toEqual(expected);
    expect(parseCertificationArguments(["--lane", "local", "--with-faults", "--profile", "smoke", "--evidence-dir", "/private/evidence"])).toEqual(expected);
    for (const [lane, profile] of [["local", "full"], ["managed", "smoke"], ["managed", "full"]]) {
      expect(() => parseCertificationArguments(["--lane", lane, "--profile", profile, "--with-faults", "--evidence-dir", "/private/evidence"]))
        .toThrow("--with-faults requires the local lane and the smoke profile");
    }
    expect(() => parseCertificationArguments(["--lane", "local", "--profile", "smoke", "--evidence-dir"])).toThrow("invalid certification arguments");
  });

  it("records a dirty exploratory smoke but rejects dirty certifying provenance", () => {
    const provenance = { dirty: true, testedCommit: "a".repeat(40) };

    expect(assertExecutionProvenance("smoke", provenance)).toBe(provenance);
    expect(() => assertExecutionProvenance("full", provenance)).toThrow("clean");
  });

  it("captures the execution-host witness with a hashed hostname and runner metadata from the environment", () => {
    const seams = {
      environment: { RUNNER_NAME: "blacksmith-8vcpu-ubuntu-2404", RUNNER_OS: "Linux", RUNNER_ARCH: "X64", LCM_CERT_RUNNER_SKU: "blacksmith/8vcpu-ubuntu-24.04:v1" },
      containerCli: "podman",
      readFile: (path: string) => { if (path !== "/etc/os-release") throw new Error("unexpected"); return 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n'; },
      engineVersion: (cli: string) => `${cli}-5.2.3\n`,
      os: { arch: () => "x64", cpus: () => Array.from({ length: 8 }, () => ({ model: "AMD EPYC 9R14" })), hostname: () => "testbox-01", release: () => "6.8.0-45-generic", totalmem: () => 33_000_000_000 },
    };
    const host = captureExecutionHost(seams);
    expect(host).toMatchObject({
      osId: "ubuntu", osVersionId: "24.04", kernelRelease: "6.8.0-45-generic", architecture: "x64", cpuModel: "AMD EPYC 9R14", logicalCpus: 8,
      totalMemoryBytes: 33_000_000_000, containerEngine: "podman", containerEngineVersion: "podman-5.2.3",
      runnerName: "blacksmith-8vcpu-ubuntu-2404", runnerOs: "Linux", runnerArch: "X64", runnerSku: "blacksmith/8vcpu-ubuntu-24.04:v1",
    });
    expect(host.hostnameSha256).toBe(createHash("sha256").update("testbox-01").digest("hex"));
    expect(JSON.stringify(host)).not.toContain("testbox-01");
    expect(Number.isFinite(Date.parse(host.capturedAt))).toBe(true);
    expect(Object.keys(host).sort()).toEqual([
      "architecture", "capturedAt", "containerEngine", "containerEngineVersion", "cpuModel", "hostnameSha256", "kernelRelease", "logicalCpus",
      "osId", "osVersionId", "runnerArch", "runnerName", "runnerOs", "runnerSku", "totalMemoryBytes",
    ]);
  });

  it("records missing runner metadata, os-release and engine version as null rather than failing", () => {
    const host = captureExecutionHost({
      environment: {}, containerCli: "podman",
      readFile: () => { throw new Error("ENOENT"); },
      engineVersion: () => { throw new Error("not installed"); },
      os: { arch: () => "arm64", cpus: () => [{ model: "Apple M3" }], hostname: () => "laptop", release: () => "24.0.0", totalmem: () => 16_000_000_000 },
    });
    expect(host).toMatchObject({ osId: null, osVersionId: null, containerEngineVersion: null, runnerName: null, runnerOs: null, runnerArch: null, runnerSku: null, logicalCpus: 1 });
  });

  it("validates an operator-declared runner SKU only when it is set", () => {
    expect(validateRunnerSku(undefined)).toBeNull();
    expect(validateRunnerSku("")).toBeNull();
    expect(validateRunnerSku("blacksmith-8vcpu-ubuntu-2404")).toBe("blacksmith-8vcpu-ubuntu-2404");
    expect(() => validateRunnerSku("has space")).toThrow("LCM_CERT_RUNNER_SKU");
    expect(() => validateRunnerSku("-leading")).toThrow("LCM_CERT_RUNNER_SKU");
    expect(() => validateRunnerSku("x".repeat(129))).toThrow("LCM_CERT_RUNNER_SKU");
    expect(() => captureExecutionHost({ environment: { LCM_CERT_RUNNER_SKU: "bad sku" }, readFile: () => "", engineVersion: () => "1", os: { arch: () => "x64", cpus: () => [{ model: "m" }], hostname: () => "h", release: () => "r", totalmem: () => 1 } })).toThrow("LCM_CERT_RUNNER_SKU");
  });

  it("withholds a runner name that names the host so the hostname is published only as its digest", () => {
    const capture = (hostname: string, runnerName: string) => captureExecutionHost({
      environment: { RUNNER_NAME: runnerName }, containerCli: "podman", readFile: () => "", engineVersion: () => "5.2.3",
      os: { arch: () => "x64", cpus: () => [{ model: "m" }], hostname: () => hostname, release: () => "r", totalmem: () => 1 },
    });
    for (const [hostname, runnerName] of [
      ["lcm-testbox-07", "lcm-testbox-07"],
      ["lcm-testbox-07", " LCM-Testbox-07 "],
      ["lcm-testbox-07.ci.example.internal", "lcm-testbox-07"],
      ["lcm-testbox-07", "lcm-testbox-07.ci.example.internal"],
    ]) {
      const host = capture(hostname, runnerName);
      expect(host.runnerName).toBeNull();
      expect(host.hostnameSha256).toBe(createHash("sha256").update(hostname).digest("hex"));
      expect(JSON.stringify(host).toLowerCase()).not.toContain("lcm-testbox-07");
    }
    expect(capture("lcm-testbox-07", "blacksmith-8vcpu-ubuntu-2404").runnerName).toBe("blacksmith-8vcpu-ubuntu-2404");
  });

  it("refuses provenance for a checkout without .git instead of claiming a commit", () => {
    const copy = mkdtempSync(join(tmpdir(), "lcm-cert-rsync-copy-"));
    writeFileSync(join(copy, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    expect(() => captureExecutionProvenance(copy, "a".repeat(64), "b".repeat(64), "c".repeat(64), { executionHost: {} })).toThrow(/no \.git.*cannot be certified/u);
  });

  it("attaches the host witness to Git checkout provenance without the repository build output", () => {
    const checkout = createGitCheckoutFixture();
    const witness = { capturedAt: "2026-10-27T00:00:00.000Z", hostnameSha256: "7".repeat(64) };
    const provenance = captureExecutionProvenance(checkout.root, "a".repeat(64), "b".repeat(64), "c".repeat(64), { executionHost: witness });
    expect(provenance).toMatchObject({
      testedCommit: checkout.head,
      dirty: false,
      testedInputsCount: 3,
      lockfileSha256: createHash("sha256").update(checkout.lockfile).digest("hex"),
      cliSha256: createHash("sha256").update(checkout.cli).digest("hex"),
      stagedPackageSha256: "b".repeat(64),
      contractSha256: "a".repeat(64),
      approvalSha256: "c".repeat(64),
      node: process.version,
    });
    expect(provenance.testedInputsSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(provenance.executionHost).toBe(witness);
    expect(provenance).not.toHaveProperty("observerSettings");
  });

  it("records the run's observer read settings when given its contract", () => {
    const checkout = createGitCheckoutFixture();
    const { contract } = loadCertificationContract(new URL("./contract-v3.json", import.meta.url));
    const provenance = captureExecutionProvenance(checkout.root, "a".repeat(64), "b".repeat(64), "c".repeat(64), {
      executionHost: { capturedAt: "2026-10-27T00:00:00.000Z", hostnameSha256: "7".repeat(64) }, contract,
    });
    expect(provenance.observerSettings).toEqual({ pollSeconds: 1, busyTimeoutMs: 200, perQueryDeadlineMs: 250, maxPollGapSeconds: 2 });
  });

  it("fails a phase immediately when a machine exits and preserves redacted logs", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[1] === "inspect") return { stdout: JSON.stringify({ Running: false, ExitCode: 1 }), stderr: "" };
      if (args[1] === "logs") return { stdout: "machine setup failed", stderr: "" };
      throw new Error(args.join(" "));
    });
    const delay = vi.fn(async () => undefined);

    await expect(waitForMachineFiles({
      paths: ["/evidence/ready.json"],
      machineNames: ["machine-a"],
      run,
      exists: () => false,
      timeoutMs: 600_000,
      delay,
    })).rejects.toThrow("machine-a exited with code 1 before phase completed: machine setup failed");
    expect(delay).not.toHaveBeenCalled();
  });

  it("revokes transfer only after both activations and starts daemons afterward", async () => {
    const order: string[] = [];
    await runMachineActivationBarrier({
      verifyA: async () => { order.push("verify-a"); },
      verifyB: async () => { order.push("verify-b"); },
      grantRuntime: async () => { order.push("grant-runtime"); },
      activateA: async () => { order.push("activate-a"); },
      activateB: async () => { order.push("activate-b"); },
      revokeTransfer: async () => { order.push("revoke-transfer"); },
      verifyRuntime: async () => { order.push("verify-runtime"); },
      startDaemonA: async () => { order.push("start-daemon-a"); },
      startDaemonB: async () => { order.push("start-daemon-b"); },
      stagger: async () => { order.push("stagger"); },
    });
    expect(order).toEqual([
      "verify-a", "verify-b", "grant-runtime", "activate-a", "activate-b", "revoke-transfer", "verify-runtime",
      "start-daemon-a", "stagger", "start-daemon-b",
    ]);
  });

  it("samples both machine clocks concurrently at each monitor tick", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-clock-monitor-"));
    const clockCalls: string[] = [];
    const monitor = await startClockMonitor({
      machineNames: { a: "machine-a", b: "machine-b" },
      run: async (args: string[]) => {
        clockCalls.push(args[2]);
        return { stdout: JSON.stringify({ wallMs: 100, monotonicNs: "100" }), stderr: "" };
      },
      url: "postgresql://runtime@db/cert",
      ca: "ca",
      evidenceDirectory: root,
      intervalMs: 60_000,
    });
    expect(clockCalls.slice(0, 2)).toEqual(["machine-a", "machine-b"]);
    await monitor.stop();
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
      nodeModules: "/private/node_modules",
      homeParent: "/private/home-parent-a",
      caFile: "/private/ca.crt",
      evidenceDirectory: "/private/evidence/a",
      wrongHost: { host: "wrong.example", address: "203.0.113.7" },
    });
    expect(args).toEqual(expect.arrayContaining([
      "--cpus", "1", "--memory", "1g", "--pids-limit", "256",
      "--user", "1000:1000", "--hostname", "lcm-cert-a",
      "--add-host", "wrong.example:203.0.113.7",
      "--volume", "/private/stage:/opt/lcm:ro,z",
      "--volume", "/private/node_modules:/opt/lcm/node_modules:ro,z",
      "--volume", "/private/home-parent-a:/home/lcm-parent:Z",
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
    // The machines receive only the approved v3 contract and its approval record.
    const certification = join(target, "certification");
    const approvedContractSha256 = "ea6ccaaa77212c3c7486cdc85af03a985dde05eeef18096a4511163d0f490839";
    expect(readdirSync(certification).filter((name) => name.startsWith("contract-v")).sort()).toEqual(["contract-v3.approval.json", "contract-v3.json"]);
    expect(createHash("sha256").update(readFileSync(join(certification, "contract-v3.json"))).digest("hex")).toBe(approvedContractSha256);
    expect(JSON.parse(readFileSync(join(certification, "contract-v3.approval.json"), "utf8"))).toMatchObject({ contractSha256: approvedContractSha256 });
    expect(loadCertificationContract(join(certification, "contract-v3.json"))).toMatchObject({ status: "approved", sha256: approvedContractSha256, contract: { version: 3 } });
  });

  it("creates the exact full schedule and records fault transitions", () => {
    const schedule = createDeterministicSchedule({ profile: "full", machine: "a", runId: "run" });
    expect(schedule.filter((entry: any) => entry.op === "hook")).toHaveLength(600);
    expect([...new Set(schedule.filter((entry: any) => entry.op === "hook").map((entry: any) => entry.primaryTextBytes))].sort((left, right) => left - right))
      .toEqual([256, 1024, 6144]);
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
    const publishBackend = vi.fn(async () => ({ phase: "completed" }));
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
        containerAdminUrl: "postgresql://admin:container-secret@lcm-pg-alias:5432/lcm_cert_run12345",
        migratorUrl: "postgresql://migrator:migrator-secret@db.example:25060/lcm_cert_run12345",
        runtimeUrl: "postgresql://runtime:runtime-secret@db.example:25060/lcm_cert_run12345",
      },
      runRoot: root,
      caFile,
      setupNetwork: "lcm-pg-network",
      containerCli: "podman",
      processRunner,
      publishBackend,
      secrets: ["admin-secret", "container-secret", "migrator-secret", "runtime-secret"],
      sourceRoot: new URL("../..", import.meta.url).pathname,
      names: { restore: "lcm-pg-restore-aaaaaaaaaaaaaaaaaaaa", runner: "lcm-pg-runner-aaaaaaaaaaaaaaaaaaaa" },
      owner: { pid: 1, birth: "linux:12345678-1234-1234-1234-123456789abc:1", scope: "linux:12345678-1234-1234-1234-123456789abc:abc" },
      runId: "a".repeat(32),
    });
    expect(calls.filter((call) => call.command === "podman" && call.args[0] === "container" && call.args[1] === "create")).toHaveLength(2);
    expect(calls.filter((call) => call.command === process.execPath)).toHaveLength(2);
    expect(calls.flatMap((call) => call.args).join("\n")).not.toContain("admin-secret");
    expect(calls.flatMap((call) => call.args).join("\n")).not.toContain("migrator-secret");
    expect(readFileSync(join(root, "managed-sql.env"), "utf8")).toMatch(
      /^LCM_CERT_ADMIN_URL=postgresql:\/\/admin:container-secret@lcm-pg-alias:5432\/lcm_cert_run12345\nLCM_CERT_TRANSFER_PASSWORD=[A-Za-z0-9_-]+\n$/u,
    );
    expect(readFileSync(join(root, "managed-setup.sql"), "utf8")).toContain(
      "ALTER DATABASE :\"database_name\" OWNER TO :\"migrator_role\";",
    );
    expect(calls.some((call) => call.args.includes("postgres") && call.args.includes("migrate"))).toBe(true);
    expect(publishBackend).toHaveBeenCalledWith(expect.objectContaining({
      homeDir: join(root, "migration-home"),
      packageRoot: new URL("../..", import.meta.url).pathname,
    }));
    expect(calls.some((call) => call.args.includes("storage.backend"))).toBe(false);
    expect(calls.filter((call) => call.args[0] === "container" && call.args[1] === "create").at(-1)?.args.join("\n"))
      .toContain("postgresql-runtime-*-grants.sql");
    const setupCreates = calls.filter((call) => call.args[0] === "container" && call.args[1] === "create").flatMap((call) => call.args);
    expect(setupCreates).toEqual(expect.arrayContaining(["--cpus", "1", "--memory", "512m", "--pids-limit", "128"]));
    expect(setupCreates).toEqual(expect.arrayContaining(["--network", "lcm-pg-network"]));
    expect(setupCreates.join("\n")).toContain(":/run/lcm-ca/ca.crt:ro,z");
  });

  it("persists incomplete cleanup evidence when the local harness fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-local-failure-"));
    const evidenceDirectory = join(root, "evidence");
    const approval = { contractSha256: "a".repeat(64), approvedBy: "owner", approvedAt: "2026-10-26T10:00:00Z", note: "recorded", approvalRef: "issue #629" };
    await expect(runLocalCertification({
      evidenceDirectory, profile: "smoke", contract: {}, contractSha256: "a".repeat(64), approval, approvalSha256: "b".repeat(64),
    }, {
      environment: { LCM_TEST_CONTAINER_CLI: "podman" },
      runHarness: async () => { throw new Error("harness failed"); },
    })).rejects.toThrow("harness failed");
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "cleanup.json"), "utf8"))).toMatchObject({
      verdict: "incomplete", privateRootsAbsent: false, ownedProcessesExited: false,
    });
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "run.json"), "utf8"))).toMatchObject({
      contractSha256: "a".repeat(64), approval, approvalSha256: "b".repeat(64),
    });
  });

  it("refuses evidence collection without an approval receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-missing-approval-"));
    await expect(runLocalCertification({
      evidenceDirectory: join(root, "evidence"), profile: "smoke", contract: {}, contractSha256: "a".repeat(64),
    }, { environment: { LCM_TEST_CONTAINER_CLI: "podman" }, runHarness: async () => undefined })).rejects.toThrow("approval");
  });

  it("prepares the fresh local database before machine setup", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-local-prepare-"));
    const evidenceDirectory = join(root, "evidence");
    const harnessDirectory = join(root, "harness");
    const caFile = join(root, "ca.crt");
    writeFileSync(caFile, "certificate", { mode: 0o600 });
    const order: string[] = [];
    const approval = { contractSha256: "a".repeat(64), approvedBy: "owner", approvedAt: "2026-10-26T10:00:00Z", note: "recorded", approvalRef: "issue #629" };

    await expect(runLocalCertification({
      evidenceDirectory, profile: "smoke", contract: {}, contractSha256: "a".repeat(64), approval, approvalSha256: "b".repeat(64),
    }, {
      environment: { LCM_TEST_CONTAINER_CLI: "podman" },
      runHarness: async ({ runTests }: any) => runTests({
        runId: "a".repeat(32),
        names: {
          controlDatabase: "lcm_harness_test", restore: "restore", runner: "runner",
        },
        directory: harnessDirectory,
        environment: {
          LCM_TEST_POSTGRES_ADMIN_URL: "postgresql://admin:secret@localhost/db",
          LCM_TEST_POSTGRES_MIGRATOR_URL: "postgresql://migrator:secret@localhost/db",
          LCM_TEST_POSTGRES_RUNTIME_URL: "postgresql://runtime:secret@localhost/db",
          LCM_TEST_POSTGRES_CA_FILE: caFile,
        },
        owner: { pid: 1, birth: "birth", scope: "scope" },
        containerCli: "podman",
        processRunner: async () => ({ stdout: "", stderr: "" }),
        secrets: ["secret"],
        inNetworkEnvironment: {},
      }),
      stagePackage: () => ({ root: join(root, "package"), sha256: "b".repeat(64) }),
      captureExecutionProvenance: () => ({ dirty: false }),
      prepareDatabase: async () => { order.push("prepare"); throw new Error("stop after prepare"); },
    })).rejects.toThrow("stop after prepare");
    expect(order).toEqual(["prepare"]);
  });
});

describe("certification fault clearance probes", () => {
  const fastDelay = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
  const localExpected = { expectedVersionNum: 180004, expectedDatabase: "lcm_harness_aaaaaaaaaaaaaaaaaaaa", expectedPort: 5432, expectedRole: "lcm_test_runtime" };
  const identityRow = (overrides: Record<string, unknown> = {}) => ({
    server_version_num: 180004, server_address: "10.89.0.2", server_port: 5432,
    database_name: "lcm_harness_aaaaaaaaaaaaaaaaaaaa", role_name: "lcm_test_runtime",
    rolsuper: false, rolcreaterole: false, rolcreatedb: false, ...overrides,
  });

  it("runs one fixed in-machine script that reads the runtime URL and CA by name", () => {
    expect(machineDatabaseClearanceArgs("machine-a")).toEqual(["container", "exec", "machine-a", "node", "--input-type=module", "-e", MACHINE_DATABASE_CLEARANCE_SCRIPT]);
    expect(MACHINE_DATABASE_CLEARANCE_SCRIPT).toContain("connectionString: process.env.LCM_POSTGRES_RUNTIME_URL");
    expect(MACHINE_DATABASE_CLEARANCE_SCRIPT).toContain('readFileSync(process.env.LCM_POSTGRES_CA_FILE, "utf8"), rejectUnauthorized: true');
    expect(MACHINE_DATABASE_CLEARANCE_SCRIPT).toContain(JSON.stringify(DATABASE_IDENTITY_SQL));
    expect(MACHINE_DATABASE_CLEARANCE_SCRIPT).not.toMatch(/LCM_POSTGRES_URL\b|postgresql:\/\/|doctor/u);
  });

  it("retries the probe until PostgreSQL accepts it and returns the verified identity", async () => {
    const attempts: string[][] = [];
    const run = async (args: string[]) => {
      attempts.push(args);
      if (attempts.length < 3) throw new Error("the database system is starting up");
      return { stdout: `${JSON.stringify(identityRow())}\n`, stderr: "" };
    };
    await expect(waitForMachineDatabaseClearance({ name: "machine-a", run, expected: localExpected, timeoutMs: 10_000, delay: fastDelay }))
      .resolves.toEqual(identityRow());
    expect(attempts).toEqual(Array.from({ length: 3 }, () => machineDatabaseClearanceArgs("machine-a")));
  });

  it("fails at once on another role, database or port, and after its bound when every attempt fails", async () => {
    for (const overrides of [{ role_name: "lcm_cert_transfer_aaaaaaaaaaaaaaaa" }, { database_name: "lcm_harness_other" }, { server_port: 15432 }]) {
      const run = vi.fn(async () => ({ stdout: JSON.stringify(identityRow(overrides)), stderr: "" }));
      await expect(waitForMachineDatabaseClearance({ name: "machine-a", run, expected: localExpected, timeoutMs: 10_000, delay: fastDelay }))
        .rejects.toThrow("certification machine machine-a database clearance failed: certification database identity or least-privilege readiness failed");
      expect(run).toHaveBeenCalledTimes(1);
    }
    const unreachable = vi.fn(async () => { throw new Error("connect ECONNREFUSED"); });
    // A scripted clock: one second passes per retry pause, so a 2.5 s bound allows exactly
    // three attempts however slowly the test runs.
    let clock = 0;
    await expect(waitForMachineDatabaseClearance({
      name: "machine-a", run: unreachable, expected: localExpected, timeoutMs: 2_500,
      now: () => clock, delay: async () => { clock += 1_000; },
    }))
      .rejects.toThrow("certification machine machine-a database clearance failed: certification machine phase timed out");
    expect(unreachable).toHaveBeenCalledTimes(3);
    const controller = new AbortController();
    controller.abort(new Error("certification aborted by test"));
    await expect(waitForMachineDatabaseClearance({ name: "machine-a", run: unreachable, expected: localExpected, timeoutMs: 10_000, delay: fastDelay, signal: controller.signal }))
      .rejects.toThrow("certification aborted by test");
  });

  // Drives runLocalCertification through its fault phases with fake machine agents. The fake
  // container runner answers an exec in a machine from the env file that machine was created
  // with: the clearance probe connects with the file's LCM_POSTGRES_RUNTIME_URL, and any other
  // command (such as `lcm doctor`) connects with its LCM_POSTGRES_URL, the transfer role that
  // setup revoked, and fails the way certifying run 1 did.
  async function runLocalFaultPath(variant: { profile: "full" | "smoke"; withFaults?: boolean; clearanceFailures?: number; identity?: Record<string, unknown> }) {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-local-faults-"));
    const evidenceDirectory = join(root, "evidence");
    const harnessDirectory = join(root, "harness");
    mkdirSync(harnessDirectory);
    const caFile = join(root, "ca.crt");
    writeFileSync(caFile, "certificate", { mode: 0o600 });
    const { contract } = loadCertificationContract(new URL("./contract-v3.json", import.meta.url));
    const names = createRunNames("a".repeat(32));
    const hostUrl = (role: string) => `postgresql://${role}:${role}-secret@127.0.0.1:15432/${names.controlDatabase}`;
    const networkUrl = (role: string) => `postgresql://${role}:${role}-secret@${names.alias}:5432/${names.controlDatabase}`;
    const transferRole = "lcm_cert_transfer_aaaaaaaaaaaaaaaa";
    const calls: string[][] = [];
    const environmentFiles = new Map<string, Record<string, string>>();
    const agents: Promise<unknown>[] = [];
    const faults = variant.profile === "full" || variant.withFaults === true;
    let clearanceFailures = variant.clearanceFailures ?? 0;
    let agentsStopped = false;
    const agentDelay = async () => {
      if (agentsStopped) throw new Error("fake agent stopped");
      await fastDelay();
    };
    const fakeAgent = async (machine: "a" | "b") => {
      const directory = join(evidenceDirectory, `machine-${machine}`);
      const wait = (file: string) => waitForControl(join(directory, file), { deadlineMs: Date.now() + 10_000, delay: agentDelay });
      const write = (file: string) => writeFileSync(join(directory, file), `${JSON.stringify({ machine, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
      await wait("migration-start.json");
      write("verification-receipt.json");
      await wait("activation-start.json");
      write("activation-receipt.json");
      await wait("runtime-ready.json");
      write("daemon-started.json");
      const home = join(harnessDirectory, `machine-${machine}-home-parent`, "home");
      mkdirSync(join(home, ".lcm"), { recursive: true });
      writeFileSync(join(home, ".lcm", "machine.json"), JSON.stringify({
        machineId: `018f0000-0000-7000-8000-00000000000${machine === "a" ? 1 : 2}`, identityKey: `machine:${machine.repeat(64)}`,
      }));
      write("ready.json");
      await wait("warmup-control.json");
      write("warmup-complete.json");
      await wait("phase-control.json");
      write("steady-complete.json");
      write("fault-ready.json");
      if (faults) {
        await wait("partition-cleared.json");
        write("partition-recovered.json");
        write("restart-ready.json");
        await wait("restart-cleared.json");
        write("restart-recovered.json");
      }
      write("drain.json");
      await wait("clock-finished.json");
    };
    const processRunner = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      const [kind, action, target] = args;
      if (kind === "container" && action === "create") {
        const lines = readFileSync(args[args.indexOf("--env-file") + 1], "utf8").trim().split("\n");
        environmentFiles.set(args[args.indexOf("--name") + 1], Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])));
      }
      if (kind === "container" && action === "start" && (target === names.machineA || target === names.machineB)) {
        agents.push(fakeAgent(target === names.machineA ? "a" : "b").catch((error: unknown) => error));
      }
      if (kind === "container" && action === "inspect") return { stdout: JSON.stringify({ Running: true }), stderr: "" };
      if (kind === "container" && action === "exec") {
        if (args.at(-1)?.includes("/stats/pool")) return { stdout: JSON.stringify({ backend: "postgresql", pool: { status: "ready", configuredMax: 2 } }), stderr: "" };
        const environment = environmentFiles.get(target) ?? {};
        if (JSON.stringify(args) === JSON.stringify(machineDatabaseClearanceArgs(target))) {
          if (clearanceFailures > 0) {
            clearanceFailures -= 1;
            throw new Error("the database system is starting up");
          }
          const url = new URL(environment.LCM_POSTGRES_RUNTIME_URL);
          return {
            stdout: JSON.stringify({ ...identityRow({ server_port: Number(url.port), database_name: url.pathname.slice(1), role_name: decodeURIComponent(url.username) }), ...variant.identity }),
            stderr: "",
          };
        }
        throw new Error(`permission denied for schema lcm (role ${decodeURIComponent(new URL(environment.LCM_POSTGRES_URL).username)})`);
      }
      return { stdout: "", stderr: "" };
    });
    const collectReadiness = vi.fn(async () => ({ serverVersionNum: 180004 }));
    const approval = { contractSha256: "a".repeat(64), approvedBy: "owner", approvedAt: "2026-10-26T10:00:00Z", note: "recorded", approvalRef: "issue #629" };
    let error: unknown;
    try {
      await runLocalCertification({
        evidenceDirectory, profile: variant.profile, ...(variant.withFaults ? { withFaults: true } : {}),
        contract, contractSha256: "a".repeat(64), approval, approvalSha256: "b".repeat(64),
      }, {
        environment: { LCM_TEST_CONTAINER_CLI: "podman" },
        runHarness: async ({ runTests }: any) => runTests({
          runId: "a".repeat(32),
          names,
          directory: harnessDirectory,
          environment: {
            LCM_TEST_POSTGRES_ADMIN_URL: hostUrl("lcm_harness_admin"),
            LCM_TEST_POSTGRES_MIGRATOR_URL: hostUrl("lcm_test_migrator"),
            LCM_TEST_POSTGRES_RUNTIME_URL: hostUrl("lcm_test_runtime"),
            LCM_TEST_POSTGRES_CA_FILE: caFile,
            LCM_TEST_POSTGRES_WRONG_CA_FILE: caFile,
          },
          inNetworkEnvironment: {
            LCM_TEST_POSTGRES_ADMIN_URL: networkUrl("lcm_harness_admin"),
            LCM_TEST_POSTGRES_RUNTIME_URL: networkUrl("lcm_test_runtime"),
          },
          owner: { pid: 1, birth: "birth", scope: "scope" },
          containerCli: "podman",
          processRunner,
          secrets: ["lcm_harness_admin-secret", "lcm_test_migrator-secret", "lcm_test_runtime-secret", `${transferRole}-secret`],
        }),
        stagePackage: () => ({ root: join(root, "package"), sha256: "b".repeat(64) }),
        captureExecutionProvenance: () => ({ dirty: false }),
        prepareDatabase: async () => ({ transferName: transferRole, transferUrl: hostUrl(transferRole) }),
        collectResidualState: async () => ({ observedAt: new Date().toISOString(), residual: { machines: 0, projects: 0, conversations: 0, passive_events: 0 }, residualEmpty: true }),
        grantRuntime: async () => ({ granted: true }),
        revokeTransfer: async () => ({ revoked: true }),
        verifyRuntime: async () => undefined,
        collectReadiness,
        collectSetupSessionClosure: async () => ({ observedAt: new Date().toISOString(), roles: { migrator: 0, transfer: 0 }, totalConnections: 0, setupSessionsClosed: true }),
        startClockMonitor: async () => ({ stop: async () => [] }),
        collectRelationBytes: async () => 0,
        monitorMachineDelay: async () => undefined,
        delay: fastDelay,
      });
    } catch (caught) {
      error = caught;
      agentsStopped = true;
    }
    await Promise.all(agents);
    const clearances = calls.filter((args) => args[0] === "container" && args[1] === "exec" && !args.at(-1)?.includes("/stats/pool"));
    return { error, calls, clearances, environmentFiles, collectReadiness, names, evidenceDirectory, hostUrl, networkUrl };
  }

  it.each([
    ["the full profile", { profile: "full" as const }],
    ["a fault smoke", { profile: "smoke" as const, withFaults: true }],
  ])("clears both local faults with the runtime-role probe inside machine A in %s", async (_label, variant) => {
    const run = await runLocalFaultPath(variant);
    expect(run.error).toBeUndefined();
    const probe = machineDatabaseClearanceArgs(run.names.machineA);
    expect(run.clearances).toEqual([probe, probe]);
    const probeAt = run.calls.flatMap((args, index) => JSON.stringify(args) === JSON.stringify(probe) ? [index] : []);
    expect(probeAt[0]).toBe(run.calls.findIndex((args) => args[0] === "network" && args[1] === "connect" && args[3] === run.names.machineA) + 1);
    expect(probeAt[1]).toBe(run.calls.findIndex((args) => args[0] === "container" && args[1] === "start" && args[2] === run.names.container) + 1);
    // The probe runs in machine A's container environment: the env file it was created with.
    const createA = run.calls.find((args) => args[0] === "container" && args[1] === "create" && args.includes(run.names.machineA));
    expect(createA).toEqual(expect.arrayContaining(["--env-file"]));
    expect(run.environmentFiles.get(run.names.machineA)).toMatchObject({
      HOME: "/home/lcm-parent/home",
      LCM_POSTGRES_RUNTIME_URL: run.networkUrl("lcm_test_runtime"),
      LCM_POSTGRES_CA_FILE: "/run/lcm-ca/ca.crt",
    });
    expect(run.calls.flat().join("\n")).not.toMatch(/postgresql:\/\/|-secret/u);
    const runtimeReadiness = expect.objectContaining({
      url: run.hostUrl("lcm_test_runtime"), expectedVersionNum: 180004, expectedDatabase: run.names.controlDatabase,
      expectedPort: 5432, expectedRole: "lcm_test_runtime", requireResidualEmpty: false,
    });
    expect(run.collectReadiness).toHaveBeenCalledTimes(3);
    expect(run.collectReadiness).toHaveBeenNthCalledWith(2, runtimeReadiness);
    expect(run.collectReadiness).toHaveBeenNthCalledWith(3, runtimeReadiness);
    const faults = JSON.parse(readFileSync(join(run.evidenceDirectory, "faults.json"), "utf8"));
    expect(faults.map((fault: { id: string }) => fault.id)).toEqual(["partition-a", "restart-database"]);
    expect(JSON.parse(readFileSync(join(run.evidenceDirectory, "cleanup.json"), "utf8")).verdict).toBe("pass");
    expect(JSON.parse(readFileSync(join(run.evidenceDirectory, "run.json"), "utf8")).withFaults).toBe(variant.withFaults);
    for (const name of [run.names.machineA, run.names.machineB]) {
      expect(run.environmentFiles.get(name)?.LCM_CERT_WITH_FAULTS).toBe(variant.withFaults ? "1" : undefined);
    }
  });

  it("retries machine A's probe while the database is not yet accepting connections", async () => {
    const run = await runLocalFaultPath({ profile: "full", clearanceFailures: 2 });
    expect(run.error).toBeUndefined();
    expect(run.clearances).toHaveLength(4);
  });

  // The local lane controls both ends, so its server port must still be 5432.
  it.each([
    ["another database", { database_name: "lcm_harness_other" }],
    ["another server port", { server_port: 15432 }],
  ])("aborts before clearing the partition when machine A reaches %s", async (_label, identity) => {
    const run = await runLocalFaultPath({ profile: "full", identity });
    expect(String(run.error)).toContain("database clearance failed");
    expect(run.clearances).toHaveLength(1);
    expect(existsSync(join(run.evidenceDirectory, "machine-a", "partition-cleared.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(run.evidenceDirectory, "cleanup.json"), "utf8")).verdict).toBe("incomplete");
  });

  it("injects no fault and runs no probe in a plain smoke", async () => {
    const run = await runLocalFaultPath({ profile: "smoke" });
    expect(run.error).toBeUndefined();
    expect(run.clearances).toEqual([]);
    expect(run.calls.some((args) => args[0] === "network" && args[1] === "disconnect")).toBe(false);
    expect(existsSync(join(run.evidenceDirectory, "faults.json"))).toBe(false);
    expect(run.environmentFiles.get(run.names.machineA)?.LCM_CERT_WITH_FAULTS).toBeUndefined();
  });
});

describe("certification clock sample retries", () => {
  afterEach(() => { pgScript.connectFailures = 0; });

  // A scripted wall clock for the retry policy: each container exec advances it by execMs
  // and reports it as the machine clock; each retry pause advances it by the pause.
  function scriptedClock() {
    const state = { clock: 1_000_000, execMs: 10 };
    return {
      state,
      start: (evidenceDirectory: string) => startClockMonitor({
        machineNames: { a: "machine-a" },
        run: async () => {
          state.clock += state.execMs;
          return { stdout: JSON.stringify({ wallMs: state.clock, monotonicNs: String(BigInt(state.clock) * 1_000_000n) }), stderr: "" };
        },
        url: "postgresql://runtime@db/cert", ca: "ca", evidenceDirectory, intervalMs: 3_600_000,
        now: () => state.clock, delay: async (milliseconds: number) => { state.clock += milliseconds; },
      }),
    };
  }
  const failure = (attempt: number, startedAtMs: number) => ({ attempt, errorClass: "Error", code: "ECONNREFUSED", startedAtMs, failedAtMs: startedAtMs + 10 });

  it("retries a sample that failed before measuring and records every attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-clock-retry-"));
    const clock = scriptedClock();
    pgScript.connectFailures = 2;
    const samples = await (await clock.start(root)).stop();
    expect(samples).toEqual([
      expect.objectContaining({
        phase: "start", machine: "a", verdict: "pass", radiusMs: 5, attempt: 3,
        t0: { wallMs: 1_001_030, monotonicNs: "1001030000000" },
        failedAttempts: [failure(1, 1_000_000), failure(2, 1_000_510)],
      }),
      expect.objectContaining({ phase: "end", machine: "a", verdict: "pass", attempt: 1, failedAttempts: [] }),
    ]);
    expect(JSON.parse(readFileSync(join(root, "clock-witness.json"), "utf8"))).toEqual(samples);
  });

  it("records a sample whose attempts all failed as incomplete after the attempt limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-clock-exhausted-"));
    const clock = scriptedClock();
    const monitor = await clock.start(root);
    pgScript.connectFailures = 100;
    const end = (await monitor.stop()).at(-1);
    expect(end).toMatchObject({ phase: "end", machine: "a", verdict: "incomplete", attempt: 5, errorClass: "Error", code: "ECONNREFUSED" });
    expect(end.failedAttempts.map((entry: { attempt: number }) => entry.attempt)).toEqual([1, 2, 3, 4]);
    expect(end).not.toHaveProperty("t0");
  });

  it("stops retrying when the next attempt would start outside the retry window", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-clock-window-"));
    const clock = scriptedClock();
    const monitor = await clock.start(root);
    // Each attempt now spends 1.6 s before failing: the second starts 2.1 s after the first,
    // and a third would start 4.2 s after it, outside the 3 s window.
    clock.state.execMs = 1_600;
    pgScript.connectFailures = 100;
    const end = (await monitor.stop()).at(-1);
    expect(end).toMatchObject({ phase: "end", verdict: "incomplete", attempt: 2 });
    expect(end.failedAttempts).toHaveLength(1);
  });

  it("never retries a measured bracket, even one over the radius bound", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-clock-breach-"));
    const clock = scriptedClock();
    const monitor = await clock.start(root);
    clock.state.execMs = 600;
    const connects = pgScript.connects;
    const end = (await monitor.stop()).at(-1);
    expect(end).toMatchObject({ phase: "end", verdict: "fail", radiusMs: 300, attempt: 1, failedAttempts: [] });
    expect(pgScript.connects - connects).toBe(1);
  });

  it("still stops the run when the start sample fails on every attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-clock-start-"));
    pgScript.connectFailures = 100;
    await expect(scriptedClock().start(root)).rejects.toThrow("certification clock monitor could not sample machine a at start (Error)");
    expect(existsSync(join(root, "clock-witness.json"))).toBe(false);
  });
});
