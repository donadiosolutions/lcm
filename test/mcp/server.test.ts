import { describe, it, expect, vi, beforeEach } from "vitest";
import { __lcmMcpTestHooks, getMcpToolDefinitions, handleDaemonRequest } from "../../src/mcp/server.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";

const ensureDaemonMcpMock = vi.hoisted(() => vi.fn().mockResolvedValue({ connected: true, port: 9999, spawned: false }));

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: ensureDaemonMcpMock,
}));
vi.mock("../../src/daemon/config.js", () => ({
  loadDaemonConfig: vi.fn().mockReturnValue({ daemon: { port: 9999 }, storage: { backend: "sqlite" } }),
}));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: vi.fn().mockImplementation(function () {
    return {
      setRequestHandler: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(function () {
    return {};
  }),
}));
vi.mock("../../src/daemon/client.js", () => ({
  DaemonClient: vi.fn().mockImplementation(function () {
    return {
      post: vi.fn(),
    };
  }),
}));
vi.mock("../../src/daemon/version.js", () => ({
  PKG_VERSION: "9.9.9-test",
}));

describe("MCP tool definitions", () => {
  it("exposes exactly 7 tools", () => {
    const tools = getMcpToolDefinitions();
    expect(tools).toHaveLength(7);
    expect(tools.map((t: any) => t.name).sort()).toEqual(["lcm_describe", "lcm_doctor", "lcm_expand", "lcm_grep", "lcm_search", "lcm_stats", "lcm_store"]);
  });

  it("each tool has name, description, inputSchema", () => {
    for (const tool of getMcpToolDefinitions()) {
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("description");
      expect(tool).toHaveProperty("inputSchema");
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("lcm_grep description mentions conversation history", () => {
    const tool = getMcpToolDefinitions().find((t: any) => t.name === "lcm_grep");
    expect(tool!.description).toContain("conversation history");
  });

  it("lcm_search description mentions episodic", () => {
    const tool = getMcpToolDefinitions().find((t: any) => t.name === "lcm_search");
    expect(tool!.description).toContain("episodic");
  });
});

describe("handleDaemonRequest", () => {
  const ensureDaemonMock = vi.fn().mockResolvedValue({ connected: true, port: 9999, spawned: false });
  const opts = {
    port: 9999,
    pidFilePath: "/tmp/test-daemon.pid",
    storage: { backend: "sqlite" as const },
    _ensureDaemon: ensureDaemonMock,
  };

  beforeEach(() => { vi.clearAllMocks(); });

  it("returns result on success", async () => {
    const client = { post: vi.fn().mockResolvedValue({ result: "ok" }) };
    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('"result": "ok"');
  });

  it("does not retry on daemon HTTP errors (non-network)", async () => {
    const client = { post: vi.fn().mockRejectedValue(new Error("HTTP 422")) };
    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);
    expect(ensureDaemonMock).not.toHaveBeenCalled();
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(res.isError).toBe(true);
  });

  it("does not force-recover after a network failure", async () => {
    const client = {
      post: vi.fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce({ result: "recovered" }),
    };
    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);
    expect(ensureDaemonMock).not.toHaveBeenCalled();
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("lcm daemon unavailable (live-no-response); run 'lcm daemon restart' or 'lcm doctor'.");
    expect(res.content[0].text).not.toContain("fetch failed");
  });

  it("returns isError:true when both network attempts fail", async () => {
    const client = {
      post: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    };
    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("daemon unavailable");
  });

  it("treats a programming TypeError as non-transport and sanitizes its diagnostic", async () => {
    const client = {
      post: vi.fn().mockRejectedValue(new TypeError("connect parser bug /private/secret")),
    };

    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("lcm error:");
    expect(res.content[0].text).toContain("connect parser bug");
    expect(res.content[0].text).not.toContain("/private/secret");
    expect(ensureDaemonMock).not.toHaveBeenCalled();
  });

  it.each(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"])(
    "maps Node transport code %s to bounded remediation without lifecycle mutation",
    async (code) => {
      const ensure = vi.fn().mockResolvedValue({ connected: true });
      const client = { post: vi.fn().mockRejectedValue(Object.assign(new Error(`socket ${code} /private/secret`), { code })) };

      const res = await handleDaemonRequest(client, "/search", { q: "foo" }, { ...opts, _ensureDaemon: ensure });

      expect(res).toEqual({
        content: [{ type: "text", text: "lcm daemon unavailable (live-no-response); run 'lcm daemon restart' or 'lcm doctor'." }],
        isError: true,
      });
      expect(client.post).toHaveBeenCalledOnce();
      expect(ensure).not.toHaveBeenCalled();
      expect(res.content[0].text).not.toContain("/private/secret");
    },
  );

  it("maps AggregateError causes through the canonical transport classifier", async () => {
    const ensure = vi.fn().mockResolvedValue({ connected: true });
    const cause = Object.assign(new Error("broken pipe /private/secret"), { code: "EPIPE" });
    const client = { post: vi.fn().mockRejectedValue(new AggregateError([new Error("wrapper", { cause })], "request failed")) };

    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, { ...opts, _ensureDaemon: ensure });

    expect(res.content[0].text).toBe("lcm daemon unavailable (live-no-response); run 'lcm daemon restart' or 'lcm doctor'.");
    expect(client.post).toHaveBeenCalledOnce();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("sanitizes non-transport error diagnostics without exposing endpoint, PID, path, or secret", async () => {
    const client = {
      post: vi.fn().mockRejectedValue(new Error(
        "configuration failed https://alice:hunter2@secret.example.test:443/v1?token=abc host=secret.example pid=42 password=hunter2 at /private/secret",
      )),
    };

    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);

    expect(res).toEqual({ content: [{ type: "text", text: expect.stringContaining("lcm error:") }], isError: true });
    expect(res.content[0].text).not.toContain("secret.example");
    expect(res.content[0].text).not.toContain("hunter2");
    expect(res.content[0].text).not.toContain("/private/secret");
    expect(res.content[0].text).not.toContain("pid=42");
    expect(ensureDaemonMock).not.toHaveBeenCalled();
  });

  it("uses a bounded fallback for an empty non-transport diagnostic", async () => {
    const client = { post: vi.fn().mockRejectedValue(new Error("")) };

    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);

    expect(res.content[0].text).toBe("lcm error: request failed");
    expect(res.isError).toBe(true);
  });

  it("sanitizes an AggregateError transport diagnostic leaf through the url-display fallback branch", async () => {
    const ensure = vi.fn().mockResolvedValue({ connected: true });
    // A malformed protocol-relative credential URI reaches the url-display
    // sanitizer's inner catch fallback leaf inside safeMcpError.
    const cause = Object.assign(new Error("upstream failure"), { code: "ECONNREFUSED" });
    const client = {
      post: vi.fn().mockRejectedValue(new AggregateError([cause], "retry against //user:hunter2@[::1/nf")),
    };

    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, { ...opts, _ensureDaemon: ensure });

    expect(res.content[0].text).toBe("lcm daemon unavailable (live-no-response); run 'lcm daemon restart' or 'lcm doctor'.");
    expect(res.content[0].text).not.toContain("hunter2");
    expect(ensure).not.toHaveBeenCalled();
  });

  describe("safeMcpError redaction", () => {
    const { safeMcpError } = __lcmMcpTestHooks;

    it.each([
      ["host", "host=db.internal.example"],
      ["host mixed-case with colon", "HOST: db.internal.example"],
      ["host with spaces around separator", "host = db.internal.example"],
      ["hostname", "hostname=db.internal.example"],
      ["socket", "socket=/run/lcm/lcm.sock"],
      ["socket mixed-case with spaces", "SoCkEt : /run/lcm/lcm.sock"],
    ])("preserves the %s key and redacts only the value", (_label, fragment) => {
      const rendered = safeMcpError(new Error(`cannot reach ${fragment}, giving up`));

      const separatorMatch = fragment.match(/[=:]/u);
      const key = fragment.slice(0, separatorMatch!.index);
      const value = fragment.slice(separatorMatch!.index! + 1).trim();
      expect(rendered).toContain(`${key}=<redacted>`);
      expect(rendered).not.toContain(value);
      expect(rendered).not.toContain("$1");
    });

    it.each([
      ["password", "password=hunter2"],
      ["passwd mixed-case", "PASSWD:hunter2"],
      ["pwd with spaces", "pwd = hunter2"],
      ["token", "token=tok_live_9x7"],
      ["secret mixed-case", "SECRET: tok_live_9x7"],
      ["api key dashed", "api-key=tok_live_9x7"],
      ["api key spaced", "api key = tok_live_9x7"],
      ["api key underscored", "API_KEY:tok_live_9x7"],
      ["authorization bearer", "Authorization: Bearer tok_live_9x7"],
      ["authorization bearer mixed-case", "authorization = bearer tok_live_9x7"],
    ])("preserves the %s key, keeps the credential undislosed, and leaves no literal $1", (_label, fragment) => {
      const rendered = safeMcpError(new Error(`auth failed: ${fragment}; retry`));

      expect(rendered).not.toContain("hunter2");
      expect(rendered).not.toContain("tok_live_9x7");
      expect(rendered).not.toContain("$1");
      const keyPattern = fragment.slice(0, fragment.search(/[=:]/u));
      expect(rendered.toLowerCase()).toContain(keyPattern.toLowerCase());
    });

    it.each([
      ["postgres URI with inline credentials", "connect postgres://svc:hunter2@db.internal.example:5432/lcm?sslmode=require failed"],
      ["http URI with inline credentials", "fetch https://svc:hunter2@db.internal.example/v1?token=tok_live_9x7 failed"],
      ["connection-string assignment", "Server=db.internal.example;Database=lcm;User Id=svc;Password=hunter2;"],
      ["quoted connection-string password", `Server=db.internal.example;Password="hunter2";`],
    ])("redacts secrets inside %s without leaking host or credential text", (_label, fragment) => {
      const rendered = safeMcpError(new Error(fragment));

      expect(rendered).not.toContain("hunter2");
      expect(rendered).not.toContain("tok_live_9x7");
      expect(rendered).not.toContain("db.internal.example");
      expect(rendered).not.toContain("$1");
      expect(rendered).toContain("lcm error:");
    });

    it("keeps punctuation outside the redacted value", () => {
      const rendered = safeMcpError(new Error("host=db.internal.example, token=tok_live_9x7; socket=/run/lcm/lcm.sock."));
      expect(rendered).toContain("host=<redacted>,");
      expect(rendered).toContain("token=<redacted>;");
      expect(rendered).toContain("socket=<redacted>.");
      expect(rendered).not.toContain("$1");
    });

    it("annotates clean diagnostics without inventing redactions", () => {
      const rendered = safeMcpError(new Error("plain configuration parsing failure"));
      expect(rendered).toBe("lcm error: plain configuration parsing failure");
      expect(rendered).not.toContain("$1");
    });

    it("preserves the <redacted> marker rather than a literal capture-group token", () => {
      const combined = safeMcpError(new Error("host=h1 hostname=h2 socket=/s password=p1 token=t1"));
      expect(combined).not.toMatch(/\$\d/u);
      expect(combined.match(/<redacted>/gu)).toHaveLength(5);
    });
  });

  it("does not invoke lifecycle when the transport fails", async () => {
    ensureDaemonMock.mockRejectedValueOnce(new Error("spawn failed"));
    const client = {
      post: vi.fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce({ result: "ok" }),
    };
    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);
    expect(ensureDaemonMock).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toContain("spawn failed");
  });
});

describe("startMcpServer", () => {
  it("rejects PostgreSQL before lifecycle or MCP transport activity", async () => {
    ensureDaemonMcpMock.mockClear();
    vi.mocked(loadDaemonConfig).mockReturnValueOnce({
      daemon: { port: 9999 },
      storage: {
        backend: "postgresql",
        postgresql: {
          url: "postgresql://db.example/lcm", caFile: "/secure/ca.pem", poolMax: 5,
          connectionTimeoutMs: 10_000, idleTimeoutMs: 30_000, statementTimeoutMs: 60_000,
        },
      },
    } as never);
    const { startMcpServer } = await import("../../src/mcp/server.js");

    await expect(startMcpServer()).rejects.toThrow("postgresql storage backend is not available");
    expect(ensureDaemonMcpMock).not.toHaveBeenCalled();
  });

  it("refuses to register MCP handlers when daemon identity is unverified", async () => {
    ensureDaemonMcpMock.mockResolvedValueOnce({ connected: false, port: 9999, spawned: false });
    const { startMcpServer } = await import("../../src/mcp/server.js");
    await expect(startMcpServer()).rejects.toThrow("daemon endpoint identity could not be verified");
  });

  it("passes PKG_VERSION as expectedVersion to ensureDaemon", async () => {
    const { startMcpServer } = await import("../../src/mcp/server.js");

    await startMcpServer();

    // PKG_VERSION is mocked to "9.9.9-test" via vi.mock("../../src/daemon/version.js")
    expect(ensureDaemonMcpMock).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: "9.9.9-test",
        expectedStorageBackend: "sqlite",
        enforceUserManagerParent: true,
      }),
    );
  });

  it("uses the packaged runtime for daemon spawning and identity", async () => {
    ensureDaemonMcpMock.mockClear();
    const { startMcpServer } = await import("../../src/mcp/server.js");

    await startMcpServer();

    const call = ensureDaemonMcpMock.mock.calls.at(-1)?.[0];
    expect(call).toEqual(expect.objectContaining({
      spawnCommand: process.execPath,
      spawnArgs: [
        expect.stringContaining("dist/lcm.mjs"),
        "daemon",
        "start",
        "--foreground",
      ],
      expectedEntrypoint: expect.stringContaining("dist/lcm.mjs"),
      enforceUserManagerParent: true,
    }));
    expect(call.spawnArgs[0]).toBe(call.expectedEntrypoint);
  });
});

describe("handleDaemonRequest spawn opts propagation", () => {
  it("rejects PostgreSQL before lifecycle and network activity", async () => {
    const ensureDaemonSpy = vi.fn().mockResolvedValue({ connected: true, port: 9999, spawned: true });
    const optsWithSpawn = {
      port: 9999,
      pidFilePath: "/tmp/test-daemon.pid",
      spawnCommand: "/usr/local/bin/node",
      spawnArgs: ["/path/to/lcm.mjs", "daemon", "start"],
      expectedVersion: "1.2.3",
      storage: {
        backend: "postgresql" as const,
        postgresql: {
          url: "postgresql://db.example/lcm",
          caFile: "/secure/ca.pem",
          poolMax: 5,
          connectionTimeoutMs: 10_000,
          idleTimeoutMs: 30_000,
          statementTimeoutMs: 60_000,
        },
      },
      _ensureDaemon: ensureDaemonSpy,
    };

    const client = {
      post: vi.fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce({ result: "ok" }),
    };

    await expect(handleDaemonRequest(client, "/search", { q: "foo" }, optsWithSpawn))
      .resolves.toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("postgresql storage backend is not available") }],
      });

    expect(ensureDaemonSpy).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });

  it("does not consume spawn opts when the transport fails", async () => {
    const ensureDaemonSpy = vi.fn().mockResolvedValue({ connected: true, port: 9999, spawned: true });
    const optsMinimal = {
      port: 9999,
      pidFilePath: "/tmp/test-daemon.pid",
      storage: { backend: "sqlite" as const },
      _ensureDaemon: ensureDaemonSpy,
    };

    const client = {
      post: vi.fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce({ result: "ok" }),
    };

    await handleDaemonRequest(client, "/search", { q: "foo" }, optsMinimal);

    expect(ensureDaemonSpy).not.toHaveBeenCalled();
    expect(client.post).toHaveBeenCalledTimes(1);
  });
});
