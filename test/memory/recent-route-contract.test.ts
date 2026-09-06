import { createServer, type AddressInfo, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../../src/daemon/client.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createRecentHandler } from "../../src/daemon/routes/recent.js";
import { createMemoryApi } from "../../src/memory/index.js";

const seams = vi.hoisted(() => ({
  validateCwd: vi.fn((cwd: string) => cwd),
  withProjectStorage: vi.fn(),
}));

vi.mock("../../src/daemon/validate-cwd.js", () => ({
  validateCwd: seams.validateCwd,
}));
vi.mock("../../src/daemon/routes/storage-lifecycle.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/daemon/routes/storage-lifecycle.js")>(),
  withProjectStorage: seams.withProjectStorage,
}));

const config = loadDaemonConfig("/tmp/lcm-recent-route-contract");
const fakeSummaries = [{
  summaryId: "sum-1",
  content: "A retrieved summary",
  depth: 2,
  tokenCount: 17,
  createdAt: new Date("2025-01-02T03:04:05.000Z"),
}];

async function listen(handler: ReturnType<typeof createRecentHandler>): Promise<{ server: Server; port: number; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    bodies.push(body);
    await handler(req, res, JSON.stringify(body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return { server, port: address.port, bodies };
}

describe("MemoryApi recent HTTP contract", () => {
  beforeEach(() => {
    seams.validateCwd.mockReset();
    seams.validateCwd.mockImplementation((cwd: string) => cwd);
    seams.withProjectStorage.mockReset();
    seams.withProjectStorage.mockImplementation(async (
      request: { cwd: string },
      callback: (project: unknown) => Promise<unknown>,
    ) => await callback({
      summaries: {
        listRecentSummaries: async (limit: number) => {
          expect(request.cwd).toBe("/workspace/project");
          expect(limit).toBe(2);
          return fakeSummaries;
        },
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retrieves summaries through the real client and route using cwd", async () => {
    const route = createRecentHandler(config);
    const { server, port, bodies } = await listen(route);
    try {
      const api = createMemoryApi(new DaemonClient(`http://127.0.0.1:${port}`, "/tmp/lcm-recent-route-contract-token"));
      const result = await api.recent("/workspace/project", 2);

      expect(JSON.stringify(bodies[0])).toBe(JSON.stringify({ cwd: "/workspace/project", limit: 2 }));
      expect(seams.validateCwd).toHaveBeenCalledWith("/workspace/project");
      expect(seams.withProjectStorage).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/workspace/project", mode: "existing" }),
        expect.any(Function),
      );
      expect(result).toEqual({
        summaries: [{
          summary_id: "sum-1",
          content: "A retrieved summary",
          depth: 2,
          token_count: 17,
          created_at: "2025-01-02 03:04:05",
        }],
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("propagates the route's existing invalid-limit rejection", async () => {
    const route = createRecentHandler(config);
    const { server, port, bodies } = await listen(route);
    try {
      const api = createMemoryApi(new DaemonClient(`http://127.0.0.1:${port}`, "/tmp/lcm-recent-route-contract-token"));
      await expect(api.recent("/workspace/project", 0)).rejects.toMatchObject({
        message: "invalid limit",
        statusCode: 400,
      });
      expect(JSON.stringify(bodies[0])).toBe(JSON.stringify({ cwd: "/workspace/project", limit: 0 }));
      expect(seams.validateCwd).not.toHaveBeenCalled();
      expect(seams.withProjectStorage).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
