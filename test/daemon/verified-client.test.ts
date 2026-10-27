import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/daemon/peer-admission.js", () => ({
  admitDaemonPeer: vi.fn(() => ({ pid: 42, birth: "birth" })),
}));

import { DaemonPeerRefusalError, verifiedLocalDaemonClient } from "../../src/daemon/client.js";
import { admitDaemonPeer } from "../../src/daemon/peer-admission.js";

describe("verified local daemon client", () => {
  let homeDir: string;
  let server: Server;
  let port: number;
  let requests: Array<{ route: string; authorization: string | undefined; body: string }>;

  beforeEach(async () => {
    vi.mocked(admitDaemonPeer).mockReset().mockReturnValue({ pid: 42, birth: "birth" });
    homeDir = mkdtempSync(join(tmpdir(), "lcm-verified-client-"));
    mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
    writeFileSync(join(homeDir, ".lcm", "daemon.token"), "test-token", { mode: 0o600 });
    requests = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({ route: request.url ?? "", authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8") });
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ status: "ok", pid: 42, version: "1.4.2", storageBackend: "sqlite",
          entrypoint: "/opt/lcm.mjs", runtimeDigest: "a".repeat(64) }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("re-admits each cached-token POST and refuses a changed listener before payload", async () => {
    const client = verifiedLocalDaemonClient(port, join(homeDir, ".lcm", "daemon.token"), homeDir);
    await expect(client.post("/search", { query: "first" })).resolves.toMatchObject({ pid: 42 });
    vi.mocked(admitDaemonPeer).mockReturnValueOnce(null);
    await expect(client.post("/search", { query: "private second", cwd: "/secret" }))
      .rejects.toBeInstanceOf(DaemonPeerRefusalError);
    expect(requests).toEqual([{ route: "/search", authorization: "Bearer test-token", body: '{"query":"first"}' }]);
    expect(admitDaemonPeer).toHaveBeenCalledTimes(2);
  });

  it("refuses mismatched token and home paths before any request", async () => {
    const client = verifiedLocalDaemonClient(port, join(homeDir, "foreign.token"), homeDir);
    await expect(client.post("/search", { query: "secret" })).rejects.toBeInstanceOf(DaemonPeerRefusalError);
    expect(admitDaemonPeer).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("preserves a typed peer refusal on health and observation", async () => {
    const client = verifiedLocalDaemonClient(port, undefined, homeDir);
    vi.mocked(admitDaemonPeer).mockReturnValue(null);
    await expect(client.health()).rejects.toBeInstanceOf(DaemonPeerRefusalError);
    await expect(client.observe()).rejects.toBeInstanceOf(DaemonPeerRefusalError);
    expect(requests).toEqual([]);
  });
});
