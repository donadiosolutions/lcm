import { renderBackendDiagnostics } from "../../src/storage/diagnostic-renderer.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { __lcmMcpTestHooks, getMcpToolDefinitions, handleDaemonRequest } from "../../src/mcp/server.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import * as storageBackend from "../../src/storage/backend.js";
import { DEFAULT_SEARCH_RESULT_LIMIT, MAX_SEARCH_RESULT_LIMIT } from "../../src/retrieval.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StatsUnavailableError } from "../../src/stats.js";
import type { BackendDiagnosticSnapshot } from "../../src/storage/diagnostics.js";

type LocalToolHandler = (request: { params: { name: string; arguments?: Record<string, unknown> } }) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;
const localStatsMocks = vi.hoisted(() => ({
  handlers: new Map<unknown, LocalToolHandler>(),
  collectStats: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../../src/stats.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/stats.js")>();
  return { ...actual, collectStats: localStatsMocks.collectStats };
});

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
      setRequestHandler: vi.fn((schema: unknown, handler: LocalToolHandler) => localStatsMocks.handlers.set(schema, handler)),
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
      post: localStatsMocks.post,
    };
  }),
}));
vi.mock("../../src/daemon/version.js", () => ({
  PKG_VERSION: "9.9.9-test",
}));

const SYNTHETIC_CREDENTIAL = "SYNTHETIC_MCP_CREDENTIAL";
const SYNTHETIC_TOKEN = "SYNTHETIC_MCP_TOKEN";
const SYNTHETIC_PRIVATE_PATH = "/private/synthetic-mcp-path";
const SYNTHETIC_USER = "SYNTHETIC_MCP_USER";

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

  it("advertises canonical search and grep contracts with defaults", () => {
    const search = getMcpToolDefinitions().find((t: any) => t.name === "lcm_search") as any;
    const grep = getMcpToolDefinitions().find((t: any) => t.name === "lcm_grep") as any;
    expect(search.inputSchema.properties.layers.items.enum).toEqual(["episodic", "promoted"]);
    expect(search.inputSchema.properties.layers.default).toEqual(["episodic", "promoted"]);
    expect(search.inputSchema.properties.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: MAX_SEARCH_RESULT_LIMIT,
      default: DEFAULT_SEARCH_RESULT_LIMIT,
    });
    expect(grep.inputSchema.properties.scope.enum).toEqual(["messages", "summaries", "both"]);
    expect(grep.inputSchema.properties.scope.default).toBe("both");
    expect(grep.inputSchema.properties.mode.enum).toEqual(["full_text", "regex"]);
    expect(grep.inputSchema.properties.mode.default).toBe("full_text");
    expect(grep.inputSchema.properties.mode.description).toContain("full-text");
    expect(grep.inputSchema.properties.mode.description).toContain("regex");
    expect(grep.inputSchema.properties.since.description).toContain("inclusive");
    expect(grep.inputSchema.properties.since.description).toContain("UTC years must be 0001-9999");
    expect(grep.inputSchema.properties.since.description).toContain("HTTP 400");
    expect(grep.inputSchema.properties.since.description).toContain("1-3 fractional digits");
    expect(grep.inputSchema.properties.since.description).toContain("+/-HH:mm");
    expect(grep.inputSchema.properties.query.description).toBe(
      "Keyword, phrase, or pattern to search; interpretation follows mode (full_text by default, regex when selected)",
    );
    expect(search.description).toContain("promoted");
    expect(search.description).not.toContain("Qdrant");
    expect(search.description).not.toContain("semantic");
    expect(search.inputSchema.properties.tags.description).toContain("promoted");
    expect(search.inputSchema.properties.tags.description).toContain("episodic results remain unfiltered");
  });

  it("advertises the expand depth contract", () => {
    const expand = getMcpToolDefinitions().find((t: any) => t.name === "lcm_expand") as any;
    expect(expand.inputSchema.properties.depth).toMatchObject({
      type: "integer",
      minimum: 1,
      default: 1,
    });
    expect(expand.inputSchema.properties.depth).not.toHaveProperty("maximum");
    expect(expand.inputSchema.properties.depth.description).toContain("positive integer");
    expect(expand.inputSchema.properties.depth.description).toContain("default: 1");
  });

  it("lcm_store describes fields without embedding agent policy", () => {
    const tool = getMcpToolDefinitions().find((t: any) => t.name === "lcm_store");
    const description = tool!.inputSchema.properties.tags.description;
    expect(tool!.description).toContain("Store a memory");
    expect(tool!.description).toContain("lcm_search");
    expect(description).toContain("Optional string tags");
    expect(description).toContain("<prefix>:<value>");
    for (const policyText of ["Immediately", "type:", "scope:", "signal:", "memory_id", "rationale", "feedback"]) {
      expect(tool!.description).not.toContain(policyText);
      expect(description).not.toContain(policyText);
    }
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

  it.each([
    ["/grep", { query: "q" }],
    ["/search", { query: "q" }],
    ["/describe", { nodeId: "sum_1" }],
    ["/expand", { nodeId: "sum_1" }],
  ])("routes %s through the daemon without the staged SQLite selector", async (route, body) => {
    const selector = vi.spyOn(storageBackend, "selectStorageBackend");
    const client = { post: vi.fn().mockResolvedValue({ route }) };
    try {
      const res = await handleDaemonRequest(client, route, body, opts);
      expect(res.isError).toBeUndefined();
      expect(client.post).toHaveBeenCalledWith(route, body);
      expect(selector).not.toHaveBeenCalled();
    } finally {
      selector.mockRestore();
    }
  });

  it("refuses a request whose publication scope is not canonical", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-mcp-publication-"));
    expect(dirname(home)).toBe(tmpdir());
    const publicationDir = join(home, ".lcm", "backend-publication");
    mkdirSync(publicationDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(publicationDir, "journal.json"), "{", { mode: 0o600 });
    const client = { post: vi.fn().mockResolvedValue({ result: "should not run" }) };
    try {
      const res = await handleDaemonRequest(
        client,
        "/search",
        { q: "foo" },
        { ...opts, publicationConfigPath: join(home, ".lcm", "config.json") },
      );

      expect(res).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "lcm error: backend publication admission blocked; complete or recover the publication before retrying" }],
      });
      expect(client.post).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
      post: vi.fn().mockRejectedValue(new TypeError(`connect parser bug ${SYNTHETIC_PRIVATE_PATH}`)),
    };

    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("lcm error:");
    expect(res.content[0].text).toContain("connect parser bug");
    expect(res.content[0].text).not.toContain(SYNTHETIC_PRIVATE_PATH);
    expect(ensureDaemonMock).not.toHaveBeenCalled();
  });

  it.each(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"])(
    "maps Node transport code %s to bounded remediation without lifecycle mutation",
    async (code) => {
      const ensure = vi.fn().mockResolvedValue({ connected: true });
      const client = { post: vi.fn().mockRejectedValue(Object.assign(new Error(`socket ${code} ${SYNTHETIC_PRIVATE_PATH}`), { code })) };

      const res = await handleDaemonRequest(client, "/search", { q: "foo" }, { ...opts, _ensureDaemon: ensure });

      expect(res).toEqual({
        content: [{ type: "text", text: "lcm daemon unavailable (live-no-response); run 'lcm daemon restart' or 'lcm doctor'." }],
        isError: true,
      });
      expect(client.post).toHaveBeenCalledOnce();
      expect(ensure).not.toHaveBeenCalled();
      expect(res.content[0].text).not.toContain(SYNTHETIC_PRIVATE_PATH);
    },
  );

  it("maps AggregateError causes through the canonical transport classifier", async () => {
    const ensure = vi.fn().mockResolvedValue({ connected: true });
    const cause = Object.assign(new Error(`broken pipe ${SYNTHETIC_PRIVATE_PATH}`), { code: "EPIPE" });
    const client = { post: vi.fn().mockRejectedValue(new AggregateError([new Error("wrapper", { cause })], "request failed")) };

    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, { ...opts, _ensureDaemon: ensure });

    expect(res.content[0].text).toBe("lcm daemon unavailable (live-no-response); run 'lcm daemon restart' or 'lcm doctor'.");
    expect(client.post).toHaveBeenCalledOnce();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("sanitizes non-transport error diagnostics without exposing endpoint, PID, path, or secret", async () => {
    const client = {
      post: vi.fn().mockRejectedValue(new Error(
        `configuration failed https://${SYNTHETIC_USER}:${SYNTHETIC_CREDENTIAL}@synthetic.example.test:443/v1?token=${SYNTHETIC_TOKEN} host=synthetic.example pid=42 password=${SYNTHETIC_CREDENTIAL} at ${SYNTHETIC_PRIVATE_PATH}`,
      )),
    };

    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);

    expect(res).toEqual({ content: [{ type: "text", text: expect.stringContaining("lcm error:") }], isError: true });
    expect(res.content[0].text).not.toContain("synthetic.example");
    expect(res.content[0].text).not.toContain(SYNTHETIC_CREDENTIAL);
    expect(res.content[0].text).not.toContain(SYNTHETIC_TOKEN);
    expect(res.content[0].text).not.toContain(SYNTHETIC_PRIVATE_PATH);
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
      post: vi.fn().mockRejectedValue(new AggregateError([cause], `retry against //${SYNTHETIC_USER}:${SYNTHETIC_CREDENTIAL}@[::1/nf`)),
    };

    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, { ...opts, _ensureDaemon: ensure });

    expect(res.content[0].text).toBe("lcm daemon unavailable (live-no-response); run 'lcm daemon restart' or 'lcm doctor'.");
    expect(res.content[0].text).not.toContain(SYNTHETIC_CREDENTIAL);
    expect(ensure).not.toHaveBeenCalled();
  });

  describe("safeMcpError redaction", () => {
    const { safeMcpError } = __lcmMcpTestHooks;
    const bmpPrivateUseRange = Array.from(
      { length: 0xF8FF - 0xE000 + 1 },
      (_, index) => String.fromCharCode(0xE000 + index),
    ).join("");

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
      ["password", `password=${SYNTHETIC_CREDENTIAL}`],
      ["passwd mixed-case", `PASSWD:${SYNTHETIC_CREDENTIAL}`],
      ["pwd with spaces", `pwd = ${SYNTHETIC_CREDENTIAL}`],
      ["token", `token=${SYNTHETIC_TOKEN}`],
      ["secret mixed-case", `SECRET: ${SYNTHETIC_TOKEN}`],
      ["api key dashed", `api-key=${SYNTHETIC_TOKEN}`],
      ["api key spaced", `api key = ${SYNTHETIC_TOKEN}`],
      ["api key underscored", `API_KEY:${SYNTHETIC_TOKEN}`],
      ["authorization bearer", `Authorization: Bearer ${SYNTHETIC_TOKEN}`],
      ["authorization bearer mixed-case", `authorization = bearer ${SYNTHETIC_TOKEN}`],
      ["authorization basic", `Authorization: Basic ${SYNTHETIC_CREDENTIAL}`],
    ])("preserves the %s key, keeps the credential undislosed, and leaves no literal $1", (_label, fragment) => {
      const rendered = safeMcpError(new Error(`auth failed: ${fragment}; retry`));

      expect(rendered).not.toContain(SYNTHETIC_CREDENTIAL);
      expect(rendered).not.toContain(SYNTHETIC_TOKEN);
      expect(rendered).not.toContain("$1");
      const keyPattern = fragment.slice(0, fragment.search(/[=:]/u));
      expect(rendered.toLowerCase()).toContain(keyPattern.toLowerCase());
    });

    it("redacts JSON quoted keys and values as complete assignments", () => {
      const rendered = safeMcpError(new Error(
        `auth failed: {"password":"${SYNTHETIC_CREDENTIAL}","api-key":"${SYNTHETIC_TOKEN}"}; retrying`,
      ));

      expect(rendered).toContain("auth failed:");
      expect(rendered).toContain("password=<redacted>");
      expect(rendered).toContain("api-key=<redacted>");
      expect(rendered).toContain("retrying");
      expect(rendered).not.toContain(SYNTHETIC_CREDENTIAL);
      expect(rendered).not.toContain(SYNTHETIC_TOKEN);
    });

    it("redacts whitespace-bearing and escaped quoted values without partial matches", () => {
      const rendered = safeMcpError(new Error(
        `auth failed: password="${SYNTHETIC_CREDENTIAL} with spaces \\\"and quotes\\\" token=${SYNTHETIC_TOKEN}"; retrying`,
      ));

      expect(rendered).toContain("password=<redacted>;");
      expect(rendered).toContain("retrying");
      expect(rendered).not.toContain(SYNTHETIC_CREDENTIAL);
      expect(rendered).not.toContain(SYNTHETIC_TOKEN);
      expect(rendered).not.toContain("with spaces");
    });

    it("redacts a quoted Basic authorization payload as one complete value", () => {
      const rendered = safeMcpError(new Error(
        `auth failed: Authorization: Basic "${SYNTHETIC_CREDENTIAL} with spaces"; retrying`,
      ));

      expect(rendered).toContain("Authorization=<redacted>;");
      expect(rendered).not.toContain(SYNTHETIC_CREDENTIAL);
      expect(rendered).not.toContain("with spaces");
    });

    it.each([
      ["missing closing quote", `auth failed: password="${SYNTHETIC_CREDENTIAL}`],
      ["escaped trailing byte", `auth failed: password="${SYNTHETIC_CREDENTIAL}\\`],
      ["overlong quoted value", `auth failed: password="${SYNTHETIC_CREDENTIAL}${"x".repeat(257)}"; trailing detail`],
      ["overlong escaped value", `auth failed: password="${"x".repeat(256)}\\${SYNTHETIC_CREDENTIAL}"; trailing detail`],
    ])("fails closed for %s", (_label, diagnostic) => {
      const rendered = safeMcpError(new Error(diagnostic));

      expect(rendered).toContain("password=<redacted>");
      expect(rendered).not.toContain(SYNTHETIC_CREDENTIAL);
      expect(rendered).not.toContain("trailing detail");
    });

    it("keeps ordinary diagnostic context readable around a redacted quoted assignment", () => {
      const rendered = safeMcpError(new Error(
        `connection rejected while opening synthetic.service: password="${SYNTHETIC_CREDENTIAL} with spaces"; retry later`,
      ));

      expect(rendered).toBe("lcm error: connection rejected while opening synthetic.service: password=<redacted>; retry later");
      expect(rendered).not.toContain(SYNTHETIC_CREDENTIAL);
    });

    it.each([
      ["postgres URI with inline credentials", `connect postgres://svc:${SYNTHETIC_CREDENTIAL}@db.internal.example:5432/lcm?sslmode=require failed`],
      ["http URI with inline credentials", `fetch https://svc:${SYNTHETIC_CREDENTIAL}@db.internal.example/v1?token=${SYNTHETIC_TOKEN} failed`],
      ["connection-string assignment", `Server=db.internal.example;Database=lcm;User Id=svc;Password=${SYNTHETIC_CREDENTIAL};`],
      ["quoted connection-string password", `Server=db.internal.example;Password="${SYNTHETIC_CREDENTIAL}";`],
    ])("redacts secrets inside %s without leaking host or credential text", (_label, fragment) => {
      const rendered = safeMcpError(new Error(fragment));

      expect(rendered).not.toContain(SYNTHETIC_CREDENTIAL);
      expect(rendered).not.toContain(SYNTHETIC_TOKEN);
      expect(rendered).not.toContain("db.internal.example");
      expect(rendered).not.toContain("$1");
      expect(rendered).toContain("lcm error:");
    });

    it("keeps punctuation outside the redacted value", () => {
      const rendered = safeMcpError(new Error(`host=db.internal.example, token=${SYNTHETIC_TOKEN}; socket=/run/lcm/lcm.sock.`));
      expect(rendered).toContain("host=<redacted>,");
      expect(rendered).toContain("token=<redacted>;");
      expect(rendered).toContain("socket=<redacted>.");
      expect(rendered).not.toContain("$1");
    });

    it("does not treat attacker-supplied marker code points as trusted redaction markers", () => {
      const rendered = safeMcpError(new Error([
        `pass\uE000word=${SYNTHETIC_CREDENTIAL}`,
        `secr\uE001et=${SYNTHETIC_TOKEN}`,
        "ho\uE000stname=db.internal.example",
        "host\uE001=db.internal.example",
        `user\uE000name=${SYNTHETIC_USER}`,
        `https://svc\uE001:${SYNTHETIC_CREDENTIAL}@db.internal.example/v1?token=${SYNTHETIC_TOKEN}`,
      ].join("; ")));

      expect(rendered).not.toContain(SYNTHETIC_CREDENTIAL);
      expect(rendered).not.toContain(SYNTHETIC_TOKEN);
      expect(rendered).not.toContain("db.internal.example");
      expect(rendered).not.toContain(SYNTHETIC_USER);
      expect(rendered).not.toMatch(/[\uE000-\uF8FF]/u);
      expect(rendered).toContain("password=<redacted>");
      expect(rendered).toContain("secret=<redacted>");
    });

    it.each([
      ["password", `pass${bmpPrivateUseRange}word=${SYNTHETIC_CREDENTIAL}`, SYNTHETIC_CREDENTIAL],
      ["secret", `secr${bmpPrivateUseRange}et=${SYNTHETIC_TOKEN}`, SYNTHETIC_TOKEN],
      ["hostname", `host${bmpPrivateUseRange}name=db.internal.example`, "db.internal.example"],
      ["host", `ho${bmpPrivateUseRange}st=db.internal.example`, "db.internal.example"],
      ["username", `user${bmpPrivateUseRange}name=${SYNTHETIC_USER}`, SYNTHETIC_USER],
      ["URL", `ht${bmpPrivateUseRange}tps://svc:${SYNTHETIC_CREDENTIAL}@db.internal.example/v1?token=${SYNTHETIC_TOKEN}`, SYNTHETIC_CREDENTIAL],
    ])("neutralizes the complete BMP private-use range around %s before scrubbing", (_label, fragment, secret) => {
      const rendered = safeMcpError(new Error(fragment));

      expect(rendered).not.toContain(secret);
      expect(rendered).not.toMatch(/[\uE000-\uF8FF]/u);
    });

    it("removes malformed surrogate code units, strips supplementary private-use code points, and preserves valid Unicode", () => {
      const rendered = safeMcpError(new Error([
        `pass\uD800word=${SYNTHETIC_CREDENTIAL}`,
        `secr\uDC00et=${SYNTHETIC_TOKEN}`,
        "host\u{F0000}name=db.internal.example",
        "ho\u{100000}st=db.internal.example",
        "normal message 🚀",
      ].join("; ")));

      expect(rendered).not.toContain(SYNTHETIC_CREDENTIAL);
      expect(rendered).not.toContain(SYNTHETIC_TOKEN);
      expect(rendered).not.toContain("db.internal.example");
      expect(rendered).not.toMatch(/[\uD800-\uDFFF\uE000-\uF8FF]/u);
      expect(rendered).toContain("normal message 🚀");
    });

    it("annotates clean diagnostics without inventing redactions", () => {
      const rendered = safeMcpError(new Error("plain configuration parsing failure 🚀"));
      expect(rendered).toBe("lcm error: plain configuration parsing failure 🚀");
      expect(rendered).not.toContain("$1");
    });

    it("preserves the <redacted> marker rather than a literal capture-group token", () => {
      const combined = safeMcpError(new Error(`host=SYNTHETIC_HOST hostname=SYNTHETIC_HOST_2 socket=/synthetic/socket password=${SYNTHETIC_CREDENTIAL} token=${SYNTHETIC_TOKEN}`));
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

    await expect(startMcpServer()).rejects.toThrow("PostgreSQL selection has no completed backend publication evidence");
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
        content: [{ text: "lcm error: backend publication admission blocked; complete or recover the publication before retrying" }],
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

describe("local lcm_stats diagnostic failures", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    localStatsMocks.handlers.clear();
    localStatsMocks.collectStats.mockReset();
    const { startMcpServer } = await import("../../src/mcp/server.js");
    await startMcpServer();
    // Connection startup is operational; the individual stats invocation is not.
    ensureDaemonMcpMock.mockClear();
  });

  it.each(["unavailable", "permission-denied", "timeout", "stale-publication"] as const)(
    "returns fixed %s observations without leaking exception data or invoking lifecycle",
    async (classification) => {
      const diagnostics: BackendDiagnosticSnapshot = {
        backend: "postgresql", classification,
        publication: "unverified", tls: "unverified", schema: "unavailable",
        extensions: "unverified", search: "unverified",
        pool: { origin: "diagnostic-probe", status: "unavailable" },
        project: { scope: "aggregate", status: "unverified" }, identity: { status: "unverified" }, outbox: { status: "unverified" },
        remediation: "Run `lcm doctor` and review the storage configuration.",
      };
      const canaries = [
        "RAW_SQL_VALUE_CANARY", "PRIVATE_TRANSCRIPT_CANARY", SYNTHETIC_CREDENTIAL,
        SYNTHETIC_PRIVATE_PATH, "postgresql://secret:password@private-host.example/db",
      ];
      const error = new StatsUnavailableError(diagnostics);
      error.message = canaries.join(" ");
      error.cause = new Error(canaries.join("\n"));
      localStatsMocks.collectStats.mockRejectedValueOnce(error);

      const result = await localStatsMocks.handlers.get(CallToolRequestSchema)!({
        params: { name: "lcm_stats", arguments: { verbose: true } },
      });

      expect(result).toEqual({ content: [{
        type: "text",
        text: renderBackendDiagnostics(diagnostics),
      }] });
      for (const canary of canaries) expect(JSON.stringify(result)).not.toContain(canary);
      expect(result.content[0].text).not.toContain("| Projects |");
      expect(localStatsMocks.collectStats).toHaveBeenCalledExactlyOnceWith();
      expect(ensureDaemonMcpMock).not.toHaveBeenCalled();
      expect(localStatsMocks.post).not.toHaveBeenCalled();
    },
  );

  it("preserves structured MCP failure handling for unclassified stats errors", async () => {
    localStatsMocks.collectStats.mockRejectedValueOnce(new Error(`password=${SYNTHETIC_CREDENTIAL}`));

    const result = await localStatsMocks.handlers.get(CallToolRequestSchema)!({
      params: { name: "lcm_stats" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("password=<redacted>");
    expect(result.content[0].text).not.toContain(SYNTHETIC_CREDENTIAL);
    expect(ensureDaemonMcpMock).not.toHaveBeenCalled();
    expect(localStatsMocks.post).not.toHaveBeenCalled();
  });
});
