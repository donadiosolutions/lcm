import { createServer, type Server } from "node:http";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexProcessSummarizer } from "../../src/llm/codex-process.js";
import { createCodexResponsesGateway, type CodexResponsesGateway } from "../../src/llm/codex-responses-gateway.js";

const PROMPT = "SYSTEM: summarize only\n\nUSER: transcript text";

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  return child;
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not expose a TCP address");
  return `http://127.0.0.1:${address.port}/v1/responses`;
}

describe("Codex Responses process diagnostics", () => {
  const upstreams: Server[] = [];

  afterEach(async () => {
    for (const upstream of upstreams.splice(0)) {
      if (upstream.listening) await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

  it("observes the real gateway stream category before a fake child exits", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("provider details must stay private");
    });
    upstreams.push(upstream);
    const upstreamUrl = await listen(upstream);

    let gateway: CodexResponsesGateway | undefined;
    let observedCategory: CodexResponsesGateway["upstreamFailureCategory"];
    let childRequestDone!: () => void;
    const childRequest = new Promise<void>(resolve => { childRequestDone = resolve; });
    const child = makeChild();
    const spawn = vi.fn((_command: string, args: readonly string[]) => {
      const providerConfig = args.find(argument => argument.includes("base_url="));
      const baseUrl = providerConfig?.match(/base_url=(".*?"),wire_api/u)?.[1];
      if (baseUrl === undefined) throw new Error("gateway endpoint missing");
      const endpoint = `${JSON.parse(baseUrl) as string}/responses`;
      void (async () => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: "Bearer test-token" },
          body: JSON.stringify({ model: "gpt-5.4", input: [], tools: [], stream: true }),
        });
        expect(response.status).toBe(502);
        expect(await response.text()).toBe("codex responses gateway request failed\n");
        observedCategory = gateway?.upstreamFailureCategory;
        child.stderr.emit("data", "codex responses gateway request failed");
        child.emit("close", 1);
        childRequestDone();
      })();
      return child;
    });

    const summarizer = createCodexProcessSummarizer({
      spawn: spawn as never,
      mkdtempSync: vi.fn(() => mkdtempSync(join(tmpdir(), "lcm-codex-"))) as never,
      readFileSync: vi.fn(() => "summary") as never,
      rmSync: vi.fn() as never,
      platform: "win32",
      _resolveConfig: vi.fn(() => undefined),
      _createGateway: async options => {
        gateway = await createCodexResponsesGateway({ ...options, _upstreamUrl: upstreamUrl });
        return gateway;
      },
    });

    await expect(summarizer("private transcript", false)).rejects.toThrow(
      "Codex compaction upstream stream failed.",
    );
    await childRequest;
    expect(observedCategory).toBe("upstream-stream");
    expect(gateway?.upstreamFailureCategory).toBe("upstream-stream");
    expect(spawn).toHaveBeenCalledOnce();
  });
});
