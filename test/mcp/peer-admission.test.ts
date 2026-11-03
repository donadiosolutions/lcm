import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const state = vi.hoisted(() => ({
  port: 0,
  handlers: new Map<unknown, (request: unknown) => Promise<unknown>>(),
  peer: vi.fn((): { pid: number; birth: string } | null => ({ pid: 42, birth: "birth" })),
}));
vi.mock("../../src/daemon/peer-admission.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/daemon/peer-admission.js")>(),
  admitCurrentDaemonPeer: state.peer,
}));
vi.mock("../../src/daemon/lifecycle.js", () => ({ ensureDaemon: vi.fn(async () => ({ connected: true })) }));
vi.mock("../../src/daemon/config.js", () => ({ loadDaemonConfig: () => ({ daemon: { port: state.port }, storage: { backend: "sqlite" } }) }));
vi.mock("../../src/storage/backend.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/storage/backend.js")>(),
  assertStorageBackendPublication: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
  setRequestHandler(schema: unknown, handler: (request: unknown) => Promise<unknown>) { state.handlers.set(schema, handler); }
  async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));

import { startMcpServer } from "../../src/mcp/server.js";
import { daemonTokenPath } from "../../src/runtime-paths.js";
import * as auth from "../../src/daemon/auth.js";

describe("MCP request recipient admission", () => {
  let server: Server;
  let requests: Array<{ authorization: string | undefined; path: string | undefined; body: string }>;
  beforeEach(async () => {
    state.peer.mockReset().mockReturnValue({ pid: 42, birth: "birth" });
    state.handlers.clear();
    mkdirSync(dirname(daemonTokenPath()), { recursive: true, mode: 0o700 });
    writeFileSync(daemonTokenPath(), "mcp-test-token", { mode: 0o600 });
    requests = [];
    server = createServer((request, response) => {
      let body = "";
      request.on("data", chunk => { body += String(chunk); });
      request.on("end", () => {
        requests.push({ authorization: request.headers.authorization, path: request.url, body });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ results: [], stored: true }));
      });
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    state.port = (server.address() as AddressInfo).port;
    await startMcpServer();
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    vi.restoreAllMocks();
  });
  const call = (name: string, args: Record<string, unknown>) => state.handlers.get(CallToolRequestSchema)!({ params: { name, arguments: args } });

  it("sends an admitted query and re-admits the later cached-token store", async () => {
    await call("lcm_search", { query: "first", cwd: "/test/project" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ path: "/search", authorization: "Bearer mcp-test-token" });
    state.peer.mockReturnValue(null);
    const result = await call("lcm_store", { content: "private second", cwd: "/private" });
    expect(result).toMatchObject({ isError: true });
    expect(requests).toHaveLength(1);
    expect(state.peer).toHaveBeenCalledTimes(2);
  });

  it("does not load the token or send a refused first query", async () => {
    state.peer.mockReturnValue(null);
    const readToken = vi.spyOn(auth, "readAuthToken");
    expect(await call("lcm_search", { query: "private", cwd: "/private" })).toMatchObject({ isError: true });
    expect(readToken).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});
