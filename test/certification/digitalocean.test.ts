import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createDigitalOceanClient,
  listByTag,
  readDigitalOceanToken,
  runManagedCertification,
  runDigitalOceanLifecycle,
} from "../../scripts/certification-digitalocean.mjs";
import { runManagedMachinePair } from "../../scripts/certification-harness.mjs";
import { waitForControl } from "./machine-agent.mjs";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});
describe("certification DigitalOcean lifecycle", () => {
  it("reads a token only from a private regular file", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-do-token-"));
    const path = join(directory, "token");
    writeFileSync(path, "secret-token\n", { mode: 0o600 });
    expect(readDigitalOceanToken(path)).toBe("secret-token");
    chmodSync(path, 0o644);
    expect(() => readDigitalOceanToken(path)).toThrow("0600");
  });

  it.each([
    ["plain", "access-token: yaml-token\ncontext: default\n"],
    ["single-quoted", "access-token: 'yaml-token'\ncontext: default\n"],
    ["double-quoted", "access-token: \"yaml-token\"\ncontext: default\n"],
  ])("extracts one top-level access token from a %s doctl config", (_name, contents) => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-do-config-"));
    const path = join(directory, "config.yaml");
    writeFileSync(path, contents, { mode: 0o600 });

    expect(readDigitalOceanToken(path)).toBe("yaml-token");
  });

  it("rejects missing, repeated, and non-owner doctl credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-do-invalid-config-"));
    const missing = join(directory, "missing.yaml");
    const repeated = join(directory, "repeated.yaml");
    const foreign = join(directory, "foreign-token");
    writeFileSync(missing, "context: default\n", { mode: 0o600 });
    writeFileSync(repeated, "access-token: first\naccess-token: second\n", { mode: 0o600 });
    writeFileSync(foreign, "secret-token\n", { mode: 0o600 });

    expect(() => readDigitalOceanToken(missing)).toThrow("exactly one top-level access-token");
    expect(() => readDigitalOceanToken(repeated)).toThrow("exactly one top-level access-token");
    if (process.getuid) {
      const getuid = vi.spyOn(process, "getuid").mockReturnValue(process.getuid() + 1);
      try { expect(() => readDigitalOceanToken(foreign)).toThrow("owned by the current user"); }
      finally { getuid.mockRestore(); }
    }
  });

  it("uses a fixed origin, registers the token before I/O and rejects redirects", async () => {
    const order: string[] = [];
    const client = createDigitalOceanClient({
      token: "secret-token",
      registerSecret: (value: string) => { order.push(`secret:${value}`); },
      fetch: vi.fn(async (url: string, init: RequestInit) => {
        order.push(`fetch:${url}:${init.redirect}`);
        return Object.defineProperty(json({ databases: [] }), "redirected", { value: true });
      }) as any,
    });
    await expect(client.request("GET", "/v2/databases?tag_name=lcm-cert")).rejects.toThrow("redirect");
    expect(order[0]).toBe("secret:secret-token");
    expect(order[1]).toBe("fetch:https://api.digitalocean.com/v2/databases?tag_name=lcm-cert:error");
    await expect(client.request("GET", "https://evil.example/v2/databases")).rejects.toThrow("path");
  });

  it("exhausts fixed-origin pagination before proving tag uniqueness", async () => {
    const request = vi.fn(async (_method: string, path: string) => new URL(path, "https://api.digitalocean.com").searchParams.get("page") === "2"
      ? { body: { databases: [{ id: "second" }] } }
      : { body: { databases: [{ id: "first" }], links: { pages: { next: "https://api.digitalocean.com/v2/databases?tag_name=lcm-cert&page=2" } } } });
    await expect(listByTag({ request } as any, "lcm-cert")).resolves.toEqual([{ id: "first" }, { id: "second" }]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("creates, firewalls, allowlists evidence and destroys the exact owned cluster", async () => {
    const requests: Array<{ method: string; path: string; body?: any }> = [];
    const secrets: string[] = [];
    let deleted = false;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname + new URL(url).search;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init.method!, path, body });
      if (init.method === "POST" && path === "/v2/databases") return json({ database: { id: "cluster-1", name: body.name, tags: body.tags, status: "online", host: "db.example", port: 25060, user: "doadmin", password: "provider-password", uri: "postgresql://doadmin:provider-password@db.example:25060/defaultdb" } }, 201);
      if (init.method === "PUT" && path.endsWith("/firewall")) return json({ rules: body.rules });
      if (init.method === "GET" && path.endsWith("/firewall")) return json({ rules: [{ type: "ip_addr", value: "203.0.113.8", uuid: "rule-1", cluster_uuid: "cluster-1", created_at: "2026-10-26T00:00:00Z" }] });
      if (init.method === "GET" && path.endsWith("/ca")) return json({ ca: { certificate: "-----BEGIN CERTIFICATE-----\nprovider\n-----END CERTIFICATE-----\n" } });
      if (init.method === "POST" && path.endsWith("/dbs")) return json({ db: { name: body.name } }, 201);
      if (init.method === "POST" && path.endsWith("/users")) return json({ user: { name: body.name, password: `${body.name}-password` } }, 201);
      if (init.method === "GET" && path === "/v2/databases/cluster-1") return deleted ? json({}, 404) : json({ database: { id: "cluster-1", name: "lcm-cert-run12345", tags: ["lcm-cert", "lcm-cert-run-run12345"], status: "online", host: "db.example", port: 25060 } });
      if (init.method === "DELETE" && path === "/v2/databases/cluster-1") { deleted = true; return new Response(null, { status: 204 }); }
      if (init.method === "GET" && path.includes("tag_name=lcm-cert")) return json({ databases: [] });
      throw new Error(`${init.method} ${path}`);
    });
    const client = createDigitalOceanClient({ token: "secret-token", registerSecret: (value: string) => secrets.push(value), fetch: fetch as any });
    const receiptDirectory = mkdtempSync(join(tmpdir(), "lcm-cert-do-receipt-"));

    const result = await runDigitalOceanLifecycle({
      client, runId: "run12345", trustedIpv4: "203.0.113.8", receiptPath: join(receiptDirectory, "created.json"),
      useCluster: async (cluster: any, connection: any) => ({ host: cluster.host, runtimeUser: new URL(connection.runtimeUrl).username, observed: true }),
    });

    expect(result.cluster).toEqual({ id: "cluster-1", name: "lcm-cert-run12345", host: "db.example", port: 25060, status: "online", tags: ["lcm-cert", "lcm-cert-run-run12345"] });
    expect(JSON.stringify(result)).not.toContain("provider-password");
    expect(secrets).toEqual(expect.arrayContaining(["secret-token", "provider-password", expect.stringContaining("postgresql://") ]));
    expect(requests.filter((request) => request.method === "POST" && request.path === "/v2/databases")).toHaveLength(1);
    expect(requests.some((request) => request.method === "DELETE" && request.path === "/v2/databases/cluster-1")).toBe(true);
  });

  it("refuses a non-empty family preflight without deleting anything", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-do-preflight-"));
    const fetch = vi.fn(async () => json({ databases: [{ id: "foreign" }] }));
    const client = createDigitalOceanClient({ token: "token", registerSecret: vi.fn(), fetch: fetch as any });
    await expect(runDigitalOceanLifecycle({
      client, runId: "run12345", trustedIpv4: "203.0.113.8", receiptPath: join(directory, "receipt"),
      useCluster: vi.fn(),
    })).rejects.toThrow("family tag");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reconciles one ambiguous create by exact name and run tag without retrying POST", async () => {
    let postCount = 0;
    let deleted = false;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      if (init.method === "GET" && parsed.searchParams.get("tag_name") === "lcm-cert" && postCount === 0) return json({ databases: [] });
      if (init.method === "POST" && parsed.pathname === "/v2/databases") { postCount += 1; throw new TypeError("connection lost"); }
      if (init.method === "GET" && parsed.searchParams.get("tag_name") === "lcm-cert-run-run12345") return json({ databases: [{ id: "cluster-1", name: "lcm-cert-run12345", tags: ["lcm-cert", "lcm-cert-run-run12345"], status: "online", host: "db.example", port: 25060, user: "doadmin", password: "provider-password" }] });
      if (init.method === "GET" && parsed.pathname === "/v2/databases/cluster-1") return deleted ? json({}, 404) : json({ database: { id: "cluster-1", name: "lcm-cert-run12345", tags: ["lcm-cert", "lcm-cert-run-run12345"], status: "online", host: "db.example", port: 25060 } });
      if (init.method === "PUT") return json({ rules: [{ type: "ip_addr", value: "203.0.113.8" }] });
      if (init.method === "GET" && parsed.pathname.endsWith("/firewall")) return json({ rules: [{ type: "ip_addr", value: "203.0.113.8" }] });
      if (init.method === "GET" && parsed.pathname.endsWith("/ca")) return json({ ca: { certificate: "-----BEGIN CERTIFICATE-----\nprovider\n-----END CERTIFICATE-----\n" } });
      if (init.method === "POST" && parsed.pathname.endsWith("/dbs")) return json({ db: { name: JSON.parse(String(init.body)).name } }, 201);
      if (init.method === "POST" && parsed.pathname.endsWith("/users")) { const name = JSON.parse(String(init.body)).name; return json({ user: { name, password: `${name}-password` } }, 201); }
      if (init.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      if (init.method === "GET" && parsed.searchParams.get("tag_name") === "lcm-cert") return json({ databases: [] });
      throw new Error(`${init.method} ${url}`);
    });
    const client = createDigitalOceanClient({ token: "token", registerSecret: vi.fn(), fetch: fetch as any });
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-do-ambiguous-"));
    await runDigitalOceanLifecycle({ client, runId: "run12345", trustedIpv4: "203.0.113.8", receiptPath: join(directory, "receipt"), useCluster: async () => ({}) });
    expect(postCount).toBe(1);
  });

  it("destroys the exact cluster when receipt persistence fails after create", async () => {
    let deleted = false;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      if (init.method === "GET" && parsed.searchParams.has("tag_name")) return json({ databases: [] });
      if (init.method === "POST" && parsed.pathname === "/v2/databases") return json({ database: { id: "cluster-1", name: "lcm-cert-run12345", tags: ["lcm-cert", "lcm-cert-run-run12345"] } }, 201);
      if (init.method === "GET" && parsed.pathname === "/v2/databases/cluster-1") return deleted ? json({}, 404) : json({ database: { id: "cluster-1", name: "lcm-cert-run12345", tags: ["lcm-cert", "lcm-cert-run-run12345"] } });
      if (init.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      throw new Error(`${init.method} ${url}`);
    });
    const client = createDigitalOceanClient({ token: "token", registerSecret: vi.fn(), fetch: fetch as any });
    await expect(runDigitalOceanLifecycle({
      client, runId: "run12345", trustedIpv4: "203.0.113.8", receiptPath: "/unused/receipt",
      reserveReceipt: () => ({ commit: () => { throw new Error("receipt failed"); }, close: vi.fn() }),
      useCluster: vi.fn(),
    })).rejects.toThrow("receipt failed");
    expect(deleted).toBe(true);
  });

  it("settles provider cleanup when a managed signal aborts the workload", async () => {
    const controller = new AbortController();
    let deleted = false;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (init.method === "GET" && parsed.searchParams.has("tag_name")) return json({ databases: [] });
      if (init.method === "POST" && parsed.pathname === "/v2/databases") return json({ database: { id: "cluster-1", name: body.name, tags: body.tags, status: "online", host: "db.example", port: 25060, user: "doadmin", password: "pw" } }, 201);
      if (init.method === "GET" && parsed.pathname === "/v2/databases/cluster-1") return deleted ? json({}, 404) : json({ database: { id: "cluster-1", name: "lcm-cert-run12345", tags: ["lcm-cert", "lcm-cert-run-run12345"], status: "online", host: "db.example", port: 25060 } });
      if (init.method === "PUT") return json({});
      if (init.method === "GET" && parsed.pathname.endsWith("/firewall")) return json({ rules: [{ type: "ip_addr", value: "203.0.113.8" }] });
      if (init.method === "GET" && parsed.pathname.endsWith("/ca")) return json({ ca: { certificate: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----" } });
      if (init.method === "POST" && parsed.pathname.endsWith("/dbs")) return json({ db: { name: body.name } }, 201);
      if (init.method === "POST" && parsed.pathname.endsWith("/users")) return json({ user: { name: body.name, password: "pw" } }, 201);
      if (init.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      throw new Error(`${init.method} ${url}`);
    });
    const client = createDigitalOceanClient({ token: "token", registerSecret: vi.fn(), fetch: fetch as any });
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-do-signal-"));
    await expect(runDigitalOceanLifecycle({
      client, runId: "run12345", trustedIpv4: "203.0.113.8", receiptPath: join(directory, "receipt"), signal: controller.signal,
      useCluster: async () => { controller.abort(new Error("SIGTERM")); throw controller.signal.reason; },
    })).rejects.toThrow("SIGTERM");
    expect(deleted).toBe(true);
  });

  it("persists successful cleanup evidence when the managed workload fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-do-failed-workload-"));
    const failure = Object.assign(new Error("workload failed"), {
      providerCleanup: { destroyedId: "cluster-1", confirmed404: true, emptyFamilyTag: true, seconds: 12 },
    });
    await expect(runManagedCertification({
      evidenceDirectory: directory, profile: "full", contract: {}, contractSha256: "a".repeat(64),
    }, {
      environment: {
        LCM_CERT_RUN_ID: "run12345",
        LCM_CERT_TRUSTED_IPV4: "203.0.113.8",
        LCM_CERT_CREATED_ID_RECEIPT: join(directory, "receipt"),
        LCM_CERT_FAMILY_LOCK_FILE: join(directory, "family.lock"),
      },
      token: "token", client: {}, prepareEvidence: false,
      runLifecycle: async () => { throw failure; },
    })).rejects.toThrow("workload failed");
    expect(JSON.parse(readFileSync(join(directory, "cleanup.json"), "utf8"))).toMatchObject({
      verdict: "pass", residualResources: 0, familyTaggedProviderClusters: 0,
      privateRootsAbsent: true, ownedProcessesExited: true,
      providerDestroyConfirmedWithinSeconds: 12,
    });
  });

  it("preserves a managed signal exit after lifecycle cleanup completes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-do-top-signal-"));
    const signalEmitter = new EventEmitter();
    const promise = runManagedCertification({
      evidenceDirectory: directory, profile: "full", contract: {}, contractSha256: "a".repeat(64),
    }, {
      environment: {
        LCM_CERT_RUN_ID: "run12345",
        LCM_CERT_TRUSTED_IPV4: "203.0.113.8",
        LCM_CERT_CREATED_ID_RECEIPT: join(directory, "receipt"),
        LCM_CERT_FAMILY_LOCK_FILE: join(directory, "family.lock"),
      },
      token: "token", client: {}, prepareEvidence: false, signalEmitter,
      runLifecycle: async () => {
        signalEmitter.emit("SIGTERM");
        return { cleanup: { destroyedId: "cluster-1", confirmed404: true, emptyFamilyTag: true, seconds: 1 } };
      },
    });
    await expect(promise).rejects.toMatchObject({ exitCode: 143 });
    expect(JSON.parse(readFileSync(join(directory, "cleanup.json"), "utf8"))).toMatchObject({ verdict: "pass" });
    expect(signalEmitter.listenerCount("SIGTERM")).toBe(0);
  });

  it("runs managed setup controls through real file waits before workload readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-managed-pair-"));
    const evidenceDirectory = join(root, "evidence");
    const calls: string[][] = [];
    const events: string[] = [];
    const fakeAgents: Promise<void>[] = [];
    const setupMaxSeconds = 2;
    const writeControl = (machine: "a" | "b", file: string) => writeFileSync(
      join(evidenceDirectory, `machine-${machine}`, file), `${JSON.stringify({ machine, at: new Date().toISOString() })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    const fakeAgent = async (machine: "a" | "b") => {
      const directory = join(evidenceDirectory, `machine-${machine}`);
      const wait = (file: string) => waitForControl(join(directory, file), {
        deadlineMs: Date.now() + setupMaxSeconds * 1000,
        delay: async () => new Promise((resolve) => setTimeout(resolve, 1)),
      });
      await wait("migration-start.json");
      events.push(`verified-${machine}`);
      writeControl(machine, "verification-receipt.json");
      await wait("activation-start.json");
      events.push(`activated-${machine}`);
      writeControl(machine, "activation-receipt.json");
      await wait("runtime-ready.json");
      writeControl(machine, "daemon-started.json");
      writeControl(machine, "ready.json");
    };
    let wallNow = Date.parse("2026-10-26T10:00:00.000Z");
    const processRunner = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[1] === "inspect") {
        if (args.includes("{{json .State}}")) return { stdout: JSON.stringify({ Running: true }), stderr: "" };
        const name = args[2];
        const create = calls.find((candidate) => candidate.includes("create") && candidate.includes(name));
        const labels: Record<string, string> = {};
        if (create) for (let index = 0; index < create.length; index += 1) {
          if (create[index] === "--label") {
            const [key, value] = create[index + 1].split("=");
            labels[key] = value;
          }
        }
        return { stdout: JSON.stringify([args[0] === "container" ? { Config: { Labels: labels } } : { Labels: labels }]), stderr: "" };
      }
      if (args[1] === "start" && args[2]) {
        const machine = args[2].includes("machine-a") ? "a" : args[2].includes("machine-b") ? "b" : undefined;
      if (machine) fakeAgents.push(fakeAgent(machine));
      }
      if (args.includes("-e")) {
        const configuredMax = args[2].includes("machine-b") ? 3 : 2;
        return { stdout: JSON.stringify({ backend: "postgresql", pool: { status: "ready", configuredMax } }), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const phaseDelay = vi.fn(async () => undefined);
    const result = await runManagedMachinePair({
      cluster: { host: "db.example", port: 25060 },
      privateConnection: {
        ca: "-----BEGIN CERTIFICATE-----\nprovider\n-----END CERTIFICATE-----\n",
        runtimeUrl: "postgresql://runtime:secret@db.example:25060/lcm_cert_run12345",
        databaseName: "lcm_cert_run12345",
        migratorName: "lcm_cert_migrator_run12345",
        runtimeName: "lcm_cert_runtime_run12345",
      },
      wrongCa: "-----BEGIN CERTIFICATE-----\nwrong\n-----END CERTIFICATE-----\n",
      runId: "run12345",
      profile: "full",
      evidenceDirectory,
      secrets: ["secret"],
      contract: { timeline: { full: { setupMaxSeconds, secondDaemonStartOffsetSeconds: 150, warmupSeconds: 120 }, smoke: { warmupSeconds: 120 } } },
    }, {
      processRunner,
      containerCli: "podman",
      owner: { pid: 1, birth: "linux:12345678-1234-1234-1234-123456789abc:1", scope: "linux:12345678-1234-1234-1234-123456789abc:abc" },
      createRunRoot: () => join(root, "run"),
      stagePackage: (runRoot: string) => ({ root: join(runRoot, "package"), sha256: "a".repeat(64) }),
      captureExecutionProvenance: () => ({ dirty: false, testedCommit: "c".repeat(40), testedInputsSha256: "d".repeat(64), testedInputsCount: 1, lockfileSha256: "e".repeat(64), cliSha256: "f".repeat(64), stagedPackageSha256: "a".repeat(64), contractSha256: "b".repeat(64), approvalSha256: "9".repeat(64), node: process.version, executionHost: { capturedAt: "2026-10-26T10:00:00.000Z", hostnameSha256: "7".repeat(64) } }),
      resolveHost: async () => "203.0.113.7",
      waitForWarmupComplete: async () => { wallNow += 120_000; },
      waitForFaultReady: async () => undefined,
      waitForSteadyComplete: async () => undefined,
      waitForPartitionRecovery: async () => undefined,
      waitForDrain: async () => undefined,
      waitForExit: async () => undefined,
      prepareDatabase: async () => ({ transferName: "lcm_cert_transfer_run", transferUrl: "postgresql://transfer:secret@db.example:25060/lcm_cert_run12345" }),
      collectReadiness: async () => ({ serverVersionNum: 180000, residualEmpty: false, role: { superuser: false, createRole: false, createDb: false } }),
      collectResidualState: async () => ({ observedAt: new Date().toISOString(), residual: { machines: 0, projects: 0, conversations: 0, passive_events: 0 }, residualEmpty: true }),
      collectSetupSessionClosure: async () => ({ observedAt: new Date().toISOString(), roles: { migrator: 0, transfer: 0 }, totalConnections: 0, setupSessionsClosed: true }),
      grantRuntime: async () => { events.push("grant-runtime"); return { granted: true }; },
      revokeTransfer: async () => { events.push("revoke-transfer"); return { revoked: true }; },
      verifyRuntime: async () => { events.push("verify-runtime"); },
      collectRelationBytes: async () => 0,
      verifyIdentities: () => ({
        a: { machineId: "018f0000-0000-7000-8000-000000000001", identityKeySha256: "a".repeat(64) },
        b: { machineId: "018f0000-0000-7000-8000-000000000002", identityKeySha256: "b".repeat(64) },
      }),
      startClockMonitor: async () => ({ stop: async () => [] }),
      wallNow: () => wallNow,
      removeRunRoot: vi.fn(),
      delay: async () => new Promise((resolve) => setTimeout(resolve, 5)),
      monitorMachineDelay: phaseDelay,
    });
    await Promise.all(fakeAgents);
    expect(result.stageSha256).toBe("a".repeat(64));
    expect(calls.filter((args) => args[0] === "container" && args[1] === "create")).toHaveLength(2);
    expect(calls).toContainEqual(expect.arrayContaining(["network", "disconnect", expect.stringContaining("lcm-pg-net"), expect.stringContaining("machine-a")]));
    expect(calls).toContainEqual(expect.arrayContaining(["network", "connect", expect.stringContaining("lcm-pg-net"), expect.stringContaining("machine-a")]));
    const createText = calls.filter((args) => args[0] === "container" && args[1] === "create").flat().join("\n");
    expect(createText).toContain("wrong-run12345.invalid:203.0.113.7");
    expect(createText).toContain("/opt/lcm/certification/machine-agent.mjs");
    expect(createText).not.toContain("postgresql://");
    const startA = calls.findIndex((args) => args[0] === "container" && args[1] === "start" && args.some((value) => value.includes("machine-a")));
    const startB = calls.findIndex((args) => args[0] === "container" && args[1] === "start" && args.some((value) => value.includes("machine-b")));
    expect(startA).toBeGreaterThanOrEqual(0);
    expect(startB).toBeGreaterThan(startA);
    expect(phaseDelay).toHaveBeenCalledWith(expect.any(Array), 150_000);
    const readiness = JSON.parse(readFileSync(join(evidenceDirectory, "database-readiness.json"), "utf8"));
    expect(readiness).toMatchObject({
      residualEmpty: false,
      poolByMachine: { a: { configuredMax: 2 }, b: { configuredMax: 3 } },
      setupSessionsClosed: true,
    });
    expect(readiness.configuredPoolMax).toBeUndefined();
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "pre-activation-residual.json"), "utf8")).residualEmpty).toBe(true);
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "setup-session-closure.json"), "utf8")).totalConnections).toBe(0);
    expect(events).toEqual(["verified-a", "verified-b", "grant-runtime", "activated-a", "activated-b", "revoke-transfer", "verify-runtime"]);
    expect(readFileSync(join(evidenceDirectory, "machine-a", "runtime-ready.json"), "utf8")).toBeTruthy();
    expect(readFileSync(join(evidenceDirectory, "machine-b", "runtime-ready.json"), "utf8")).toBeTruthy();
    const phaseControl = JSON.parse(readFileSync(join(evidenceDirectory, "phase-control.json"), "utf8"));
    expect(Date.parse(phaseControl.steadyT0At) - Date.parse(phaseControl.warmupStartAt)).toBeGreaterThanOrEqual(120_000);
  });
});
