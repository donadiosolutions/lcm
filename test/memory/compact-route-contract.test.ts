import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { DaemonClient } from "../../src/daemon/client.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createCompactHandler } from "../../src/daemon/routes/compact.js";
import { createMemoryApi } from "../../src/memory/index.js";

const testRoot = mkdtempSync(join(tmpdir(), "lcm-compact-route-contract-"));
const config = loadDaemonConfig(join(testRoot, "config.json"));
const transcriptPath = join(tmpdir(), "lcm-compact-route-contract-transcript.jsonl");

async function listen(handler: ReturnType<typeof createCompactHandler>): Promise<{
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

describe("MemoryApi compact HTTP contract", () => {
  afterAll(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("forwards cwd to the real compact route before admission", async () => {
    const route = createCompactHandler(config);
    const { server, port, bodies } = await listen(route);
    try {
      const api = createMemoryApi(new DaemonClient(`http://127.0.0.1:${port}`));
      await expect(api.compact("compact-session", transcriptPath, testRoot)).rejects.toMatchObject({
        message: "backend publication admission blocked",
        statusCode: 503,
      });
      expect(bodies).toEqual([{
        session_id: "compact-session",
        transcript_path: transcriptPath,
        cwd: testRoot,
      }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("keeps the route's missing-cwd validation rejection", async () => {
    const route = createCompactHandler(config);
    const { server, port, bodies } = await listen(route);
    try {
      const client = new DaemonClient(`http://127.0.0.1:${port}`);
      await expect(client.post("/compact", {
        session_id: "compact-session",
        transcript_path: transcriptPath,
      })).rejects.toMatchObject({
        message: "cwd must be a non-empty string",
        statusCode: 400,
      });
      expect(bodies).toEqual([{
        session_id: "compact-session",
        transcript_path: transcriptPath,
      }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
