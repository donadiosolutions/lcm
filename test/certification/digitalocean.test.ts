import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createDigitalOceanClient,
  readDigitalOceanToken,
  runDigitalOceanLifecycle,
} from "../../scripts/certification-digitalocean.mjs";
import { runManagedMachinePair } from "../../scripts/certification-harness.mjs";

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
      if (init.method === "GET" && path.endsWith("/firewall")) return json({ rules: [{ type: "ip_addr", value: "203.0.113.8" }] });
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
    const fetch = vi.fn(async () => json({ databases: [{ id: "foreign" }] }));
    const client = createDigitalOceanClient({ token: "token", registerSecret: vi.fn(), fetch: fetch as any });
    await expect(runDigitalOceanLifecycle({
      client, runId: "run12345", trustedIpv4: "203.0.113.8", receiptPath: "/private/unused",
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

  it("wires both managed machines through the shared agent and injects the partition", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-managed-pair-"));
    const evidenceDirectory = join(root, "evidence");
    const calls: string[][] = [];
    const processRunner = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[1] === "inspect") {
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
      return { stdout: "", stderr: "" };
    });
    const result = await runManagedMachinePair({
      cluster: { host: "db.example", port: 25060 },
      privateConnection: {
        ca: "-----BEGIN CERTIFICATE-----\nprovider\n-----END CERTIFICATE-----\n",
        runtimeUrl: "postgresql://runtime:secret@db.example:25060/lcm_cert_run12345",
      },
      wrongCa: "-----BEGIN CERTIFICATE-----\nwrong\n-----END CERTIFICATE-----\n",
      runId: "run12345",
      profile: "full",
      evidenceDirectory,
      secrets: ["secret"],
    }, {
      processRunner,
      containerCli: "podman",
      owner: { pid: 1, birth: "linux:12345678-1234-1234-1234-123456789abc:1", scope: "linux:12345678-1234-1234-1234-123456789abc:abc" },
      createRunRoot: () => join(root, "run"),
      stagePackage: (runRoot: string) => ({ root: join(runRoot, "package"), sha256: "a".repeat(64) }),
      resolveHost: async () => "203.0.113.7",
      waitForReady: async () => undefined,
      waitForFaultReady: async () => undefined,
      waitForPartitionRecovery: async () => undefined,
      waitForDrain: async () => undefined,
      waitForExit: async () => undefined,
      prepareDatabase: async () => undefined,
      collectReadiness: async () => ({ serverVersionNum: 180000, role: { superuser: false, createRole: false, createDb: false } }),
      verifyIdentities: () => ({
        a: { machineId: "018f0000-0000-7000-8000-000000000001", identityKeySha256: "a".repeat(64) },
        b: { machineId: "018f0000-0000-7000-8000-000000000002", identityKeySha256: "b".repeat(64) },
      }),
      startClockMonitor: async () => ({ stop: async () => [] }),
      delay: async () => undefined,
      removeRunRoot: vi.fn(),
    });
    expect(result.stageSha256).toBe("a".repeat(64));
    expect(calls.filter((args) => args[0] === "container" && args[1] === "create")).toHaveLength(2);
    expect(calls).toContainEqual(expect.arrayContaining(["network", "disconnect", expect.stringContaining("lcm-cert-net"), expect.stringContaining("machine-a")]));
    expect(calls).toContainEqual(expect.arrayContaining(["network", "connect", expect.stringContaining("lcm-cert-net"), expect.stringContaining("machine-a")]));
    const createText = calls.filter((args) => args[0] === "container" && args[1] === "create").flat().join("\n");
    expect(createText).toContain("wrong-run12345.invalid:203.0.113.7");
    expect(createText).toContain("/opt/lcm/certification/machine-agent.mjs");
    expect(createText).not.toContain("postgresql://");
  });
});
