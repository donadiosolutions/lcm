import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../../src/daemon/client.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createSearchHandler } from "../../src/daemon/routes/search.js";
import type { ProjectStorage, StorageBackendFactory } from "../../src/storage/index.js";
import { createMemoryApi } from "../../src/memory/index.js";

const projectIdentityMock = vi.hoisted(() => vi.fn((cwd: string) => ({
  id: "fixture-project",
  canonical: cwd,
  localProjectId: "fixture-project",
})));

vi.mock("../../src/daemon/project.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/daemon/project.js")>(),
  projectIdentity: projectIdentityMock,
}));

const testRoot = mkdtempSync(join(tmpdir(), "lcm-search-route-contract-"));
const config = loadDaemonConfig(join(testRoot, "config.json"));
const tokenPath = join(testRoot, "token");

const project = {
  close: vi.fn(),
  lexicalSearch: {
    searchMessages: vi.fn(async () => [{
      messageId: 11,
      conversationId: 7,
      role: "user" as const,
      snippet: "fixture episodic result",
      createdAt: new Date("2025-01-02T03:04:05.000Z"),
    }]),
    searchSummaries: vi.fn(async () => []),
    searchPromoted: vi.fn(async () => [{ id: "fixture-promoted", content: "fixture promoted result" }]),
  },
} as unknown as ProjectStorage;

const openExistingProject = vi.fn(async () => project);
const factory = {
  backend: "sqlite" as const,
  capabilities: {},
  openExistingProject,
  projectExists: vi.fn(),
  openProject: vi.fn(),
  health: vi.fn(),
  close: vi.fn(),
} as unknown as StorageBackendFactory;

async function listen(handler: ReturnType<typeof createSearchHandler>): Promise<{
  server: Server;
  port: number;
  bodies: unknown[];
}> {
  const bodies: unknown[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString("utf8");
    bodies.push(JSON.parse(rawBody));
    await handler(req, res, rawBody);
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

describe("MemoryApi search HTTP contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectIdentityMock.mockImplementation((cwd: string) => ({
      id: "fixture-project",
      canonical: cwd,
      localProjectId: "fixture-project",
    }));
    openExistingProject.mockResolvedValue(project);
  });

  afterAll(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("admits the explicit fixture cwd and returns both project layers", async () => {
    const route = createSearchHandler(config, factory);
    const { server, port, bodies } = await listen(route);
    try {
      const api = createMemoryApi(new DaemonClient(`http://127.0.0.1:${port}`, tokenPath));
      const result = await api.search("fixture", {
        cwd: testRoot,
        limit: 2,
        layers: ["episodic", "promoted"],
        projectId: "legacy-project-id",
        threshold: 0.25,
      });

      expect(bodies).toEqual([{
        query: "fixture",
        cwd: testRoot,
        limit: 2,
        layers: ["episodic", "promoted"],
        projectId: "legacy-project-id",
        threshold: 0.25,
      }]);
      expect(projectIdentityMock).toHaveBeenCalledWith(testRoot, config.storage, undefined);
      expect(openExistingProject).toHaveBeenCalledWith(
        expect.objectContaining({ canonical: testRoot, localProjectId: "fixture-project" }),
        undefined,
        expect.any(AbortSignal),
      );
      expect(result).toEqual({
        episodic: [{
          messageId: 11,
          conversationId: 7,
          role: "user",
          snippet: "fixture episodic result",
          createdAt: "2025-01-02T03:04:05.000Z",
        }],
        promoted: [{ id: "fixture-promoted", content: "fixture promoted result" }],
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("rejects relative cwd through the real validator before storage admission", async () => {
    const route = createSearchHandler(config, factory);
    const { server, port, bodies } = await listen(route);
    try {
      const api = createMemoryApi(new DaemonClient(`http://127.0.0.1:${port}`, tokenPath));
      await expect(api.search("fixture", { cwd: "relative/project" })).rejects.toMatchObject({
        message: "cwd must be an absolute path",
        statusCode: 400,
      });
      expect(bodies).toEqual([{ query: "fixture", cwd: "relative/project" }]);
      expect(openExistingProject).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("keeps omitted cwd as an empty response without storage admission", async () => {
    const route = createSearchHandler(config, factory);
    const { server, port, bodies } = await listen(route);
    try {
      const api = createMemoryApi(new DaemonClient(`http://127.0.0.1:${port}`, tokenPath));
      await expect(api.search("fixture")).resolves.toEqual({ episodic: [], promoted: [] });
      expect(bodies).toEqual([{ query: "fixture" }]);
      expect(openExistingProject).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
