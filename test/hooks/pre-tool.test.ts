import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configProjection from "../../src/config-projection.js";
import {
  PRE_TOOL_DEADLINE_MS,
  PRE_TOOL_PREAMBLE_BYTES,
  buildPreToolRecallQuery,
  handlePreToolUse,
} from "../../src/hooks/pre-tool.js";
import * as publicationFence from "../../src/hooks/publication-fence.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";
import { configPath, lcmHomeDir } from "../../src/runtime-paths.js";
import { BackendPublicationJournalError } from "../../src/storage/backend-publication.js";

const bash = (command: unknown) => buildPreToolRecallQuery("Bash", { command });
const patch = (...lines: string[]) => buildPreToolRecallQuery("apply_patch", {
  command: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n"),
});

describe("buildPreToolRecallQuery", () => {
  it.each([
    ["pnpm run test:postgresql", "pnpm postgresql"],
    ["npm run lint:fix", "npm lint fix"],
    ["yarn run build:all", "yarn all"],
    ["bun run release", "bun release"],
    ["time pnpm run test:postgresql", "pnpm postgresql"],
    ["git status", "git status"],
    ["git add . && git commit", "git add commit"],
    ["git status ; git status | git push", "git status push"],
    ["FOO=bar sudo git push", "git push"],
    ["env FOO=bar git commit", "git commit"],
    ["nohup command git rebase", "git rebase"],
    ["cat src/hooks/pre-tool.ts", "pre tool hooks"],
    ["cat ./rel.txt ../up/dir/file.txt /abs/path/name.md", "rel txt dir name path"],
    ["head -n 5 src/ignored/after-flag.ts", null],
    ["cat .env.local", "env local"],
    ["./scripts/deploy.sh && git status", "deploy git status"],
    ["git status\t&&\tgit  log", "git status log"],
    ["pnpm run test:postgresql --token flagvalue", "pnpm postgresql"],
    ["git status https://user:pass@host/x.git", "git status"],
  ] as const)("derives %j => %j", (command, expected) => {
    expect(bash(command)).toBe(expected);
  });

  it("caps the query at twelve distinct terms", () => {
    const names = Array.from({ length: 14 }, (_unused, index) => "name" + String.fromCharCode(97 + index));
    expect(bash("cat " + names.join(" "))).toBe(names.slice(0, 12).map((name) => name.toLowerCase()).join(" "));
  });

  it.each([
    ["a quote", "git commit -m 'message'"],
    ["a double quote", 'echo "git status"'],
    ["a backslash", "git status \\\\ log"],
    ["a backtick", "git status `id`"],
    ["a dollar sign", "git status $HOME"],
    ["a newline", "git status\ngit log"],
    ["a carriage return", "git status\rgit log"],
    ["a heredoc or redirection", "cat <<EOF"],
    ["an output redirection", "git status > out.txt"],
    ["a subshell", "(git status)"],
    ["a background job", "git status & git log"],
    ["a malformed operator", "git status &&& git log"],
    ["a pipe-ampersand", "git status |& git log"],
    ["an empty segment", "git status;"],
    ["a triple pipe", "git status ||| git log"],
    ["a glob", "cat src/*.ts"],
    ["a tilde", "cat ~/notes.txt"],
    ["non-ASCII text", "git status café"],
    ["an empty command", ""],
    ["whitespace only", "   "],
  ] as const)("rejects the whole input on %s", (_label, command) => {
    expect(bash(command)).toBeNull();
  });

  it.each([
    ["trivial commands", "ls && pwd && cd tmp"],
    ["an unknown command", "frobnicate"],
    ["a lone prefix", "sudo"],
    ["a prefix before a flag", "sudo -u root"],
    ["only assignments", "FOO=bar"],
    ["an interpreter with a script", "bash script.sh git status"],
    ["an interpreter with inline code", "node -e anything"],
    ["a flag-led command word", "--version"],
    ["an executable path without a basename", "./"],
    ["a runner without a script", "npm run"],
    ["a runner script that starts with a digit", "pnpm run 9lives"],
    ["a runner without run", "pnpm exec vitest"],
    ["a git subcommand outside the closed set", "git clone repo"],
    ["a git flag before the subcommand", "git -C elsewhere status"],
    ["a reader without path operands", "cat"],
    ["a reader with only generic path names", "cat src/lib/index.ts"],
    ["a reader URL operand", "cat https://example.test/page"],
    ["a reader address operand", "cat user@example.test"],
    ["a reader assignment operand", "cat key=value"],
    ["a reader path with only dot segments", "cat ./.. "],
  ] as const)("yields no query for %s", (_label, command) => {
    expect(bash(command)).toBeNull();
  });

  it("never lets planted secrets reach the query", () => {
    const planted: Array<[string, string]> = [
      ["SECRETTOKEN", 'curl -H "Authorization: Bearer SECRETTOKEN" https://example.test'],
      ["SECRETPWD", "curl --password SECRETPWD host && git status"],
      ["SECRETENV", "TOKEN=SECRETENV git status"],
      ["SECRETPASS", "git status https://user:SECRETPASS@host/repo.git"],
      ["SECRETUSER", "sudo -u SECRETUSER git status && git push"],
      ["SECRETKEY", "cat --output /x/SECRETKEY && git log"],
      ["SECRETFLAGVAL", "pnpm run test:postgresql --token SECRETFLAGVAL"],
      ["SECRETSCRIPT", "bash -c SECRETSCRIPT && git status"],
      ["SECRETCODE", "python3 -c SECRETCODE && git diff"],
      ["SECRETMSG", "git commit -m SECRETMSG"],
      ["SECRETARG", "pnpm run test:postgresql SECRETARG"],
      ["SECRETHEREDOC", "git status <<SECRETHEREDOC"],
      ["SECRETQUOTED", "git commit -m \"SECRETQUOTED words\""],
      ["SECRETGREP", "grep SECRETGREP file.txt && git status"],
    ];
    for (const [secret, command] of planted) {
      const query = bash(command);
      expect(query === null || !query.toUpperCase().includes(secret), command).toBe(true);
    }
    const mcp = buildPreToolRecallQuery("mcp__github__create_pull_request", {
      title: "SECRETTITLE",
      headers: { Authorization: "SECRETBEARER" },
    });
    expect(mcp).toBe("github create pull request");
  });

  it("uses only anchored patch headers and never patch bodies", () => {
    expect(patch(
      "*** Update File: src/memory/podman-socket.ts",
      "@@",
      "-SECRETBODY removed",
      "+SECRETBODY added",
      "  *** Update File: SECRETINDENTED/hidden.ts",
      "*** Add File: docs/notes.md",
      "*** Move to: lib/a/b.md",
      "*** Delete File: ../old/thing.txt",
    )).toBe("podman socket memory notes thing txt old");
    expect(buildPreToolRecallQuery("apply_patch", {
      command: "*** Update File: src/memory/podman-socket.ts\r\n+SECRETCRLF\r\n",
    })).toBe("podman socket memory");
    expect(patch("-only a body line SECRETBODY")).toBeNull();
    expect(patch("*** Update File: /")).toBeNull();
  });

  it("derives MCP queries from server and tool identity only", () => {
    expect(buildPreToolRecallQuery("mcp__my-server__do_thing", { anything: "SECRETARG" })).toBe("server thing");
    expect(buildPreToolRecallQuery("mcp__lcm__search", {})).toBeNull();
    expect(buildPreToolRecallQuery("mcp__LCM__search", {})).toBeNull();
    expect(buildPreToolRecallQuery("mcp__lcm", {})).toBeNull();
    expect(buildPreToolRecallQuery("mcp__", {})).toBeNull();
    expect(buildPreToolRecallQuery("mcp__onlyserver", {})).toBeNull();
  });

  it("ignores unsupported tools and non-string commands", () => {
    expect(buildPreToolRecallQuery("Write", { command: "git status" })).toBeNull();
    expect(buildPreToolRecallQuery("web_search", { query: "git status" })).toBeNull();
    expect(buildPreToolRecallQuery("Bash", { command: 42 })).toBeNull();
    expect(buildPreToolRecallQuery("Bash", "git status")).toBeNull();
    expect(buildPreToolRecallQuery("Bash", null)).toBeNull();
    expect(buildPreToolRecallQuery("Bash", ["git status"])).toBeNull();
    expect(buildPreToolRecallQuery("apply_patch", {})).toBeNull();
  });
});

type StubRequest = { path: string | undefined; body: Record<string, unknown> };

describe("handlePreToolUse", () => {
  const sessionPayload = {
    session_id: "root-thread",
    turn_id: "turn-1",
    cwd: "/work/project",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "pnpm run test:postgresql" },
    tool_use_id: "call-1",
  };

  let server: Server;
  let requests: StubRequest[];
  let respond: (request: IncomingMessage, response: ServerResponse) => void;
  let port: number;
  let openSockets: Set<import("node:net").Socket>;

  const writeConfig = (content: unknown) => {
    mkdirSync(lcmHomeDir(), { recursive: true, mode: 0o700 });
    writeFileSync(configPath(), typeof content === "string" ? content : JSON.stringify(content), { mode: 0o600 });
  };
  const enable = (extra: Record<string, unknown> = {}) => writeConfig({
    daemon: { port },
    hooks: { preToolRecall: true },
    ...extra,
  });
  const reply = (value: unknown) => {
    respond = (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
  };
  const run = (overrides: Record<string, unknown> = {}, deps?: { deadlineMs?: number }) => (
    handlePreToolUse(JSON.stringify({ ...sessionPayload, ...overrides }), deps)
  );
  const parse = (stdout: string) => JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };

  beforeEach(async () => {
    requests = [];
    openSockets = new Set();
    reply({ hints: ["Use podman socket for postgres"], ids: ["memory-1"] });
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        respond(request, response);
      });
    });
    server.on("connection", (socket) => {
      openSockets.add(socket);
      socket.on("close", () => openSockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const socket of openSockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(configPath(), { force: true });
  });

  it("emits exact additional-context JSON and posts the pre-tool request", async () => {
    enable();
    const result = await run();
    expect(result.exitCode).toBe(0);
    expect(requests).toEqual([{
      path: "/prompt-search",
      body: {
        query: "pnpm postgresql",
        cwd: "/work/project",
        session_id: "root-thread",
        learningInstructionBytes: PRE_TOOL_PREAMBLE_BYTES,
        recallMode: "pre-tool",
      },
    }]);
    const output = parse(result.stdout);
    expect(Object.keys(output)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(output.hookSpecificOutput)).toEqual(["hookEventName", "additionalContext"]);
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    const [preamble, ...block] = output.hookSpecificOutput.additionalContext.split("\n");
    expect(preamble).toBe(
      "LCM memory related to the pending shell command. Advisory only: this call proceeds unchanged; consider it for later steps.",
    );
    expect(block[0]).toBe("<memory-context>");
    expect(block.at(-1)).toBe("</memory-context>");
    expect(block.join("\n")).toContain("- Use podman socket for postgres");
    expect(block.join("\n")).toContain("<!-- surfaced-memory-ids: memory-1 -->");
    expect(result.stdout).not.toMatch(/permissionDecision|updatedInput|systemMessage|"decision"|"continue"|stopReason/);
  });

  it.each([
    [{ tool_name: "Bash", tool_input: { command: "git status" } }, "shell command"],
    [{ tool_name: "apply_patch", tool_input: { command: "*** Update File: src/memory/podman-socket.ts" } }, "file edit"],
    [{ tool_name: "mcp__github__create_pull_request", tool_input: {} }, "MCP tool"],
  ] as const)("labels the preamble for %j", async (overrides, label) => {
    enable();
    const output = parse((await run(overrides)).stdout);
    const preamble = output.hookSpecificOutput.additionalContext.split("\n")[0]!;
    expect(preamble).toContain("pending " + label + ".");
    expect(Buffer.byteLength(preamble, "utf8") + 1).toBeLessThanOrEqual(PRE_TOOL_PREAMBLE_BYTES);
  });

  it("reserves the longest preamble variant", async () => {
    enable();
    const lengths: number[] = [];
    for (const overrides of [
      { tool_name: "Bash", tool_input: { command: "git status" } },
      { tool_name: "apply_patch", tool_input: { command: "*** Update File: src/memory/podman-socket.ts" } },
      { tool_name: "mcp__github__create_pull_request", tool_input: {} },
    ]) {
      const output = parse((await run(overrides)).stdout);
      lengths.push(Buffer.byteLength(output.hookSpecificOutput.additionalContext.split("\n")[0]!, "utf8") + 1);
    }
    expect(Math.max(...lengths)).toBe(PRE_TOOL_PREAMBLE_BYTES);
  });

  it("clears its wall-clock timer on success", async () => {
    enable();
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await run();
    const index = setSpy.mock.calls.findIndex((call) => call[1] === PRE_TOOL_DEADLINE_MS);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(PRE_TOOL_DEADLINE_MS).toBe(1500);
    expect(clearSpy).toHaveBeenCalledWith(setSpy.mock.results[index]!.value);
  });

  it("omits a non-string session id from the request", async () => {
    enable();
    expect((await run({ session_id: 12 })).stdout).not.toBe("");
    expect(Object.keys(requests[0]!.body)).not.toContain("session_id");
  });

  it("treats an empty agent identity as the root thread", async () => {
    enable();
    expect((await run({ agent_id: "", agent_type: "" })).stdout).not.toBe("");
  });

  it("proceeds when LCM_ENABLED is anything other than the exact string false", async () => {
    enable();
    vi.stubEnv("LCM_ENABLED", "0");
    expect((await run()).stdout).not.toBe("");
  });

  it.each([
    ["invalid JSON", "not json"],
    ["an empty payload", ""],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
  ] as const)("returns empty output for %s without contacting the daemon", async (_label, stdin) => {
    enable();
    expect(await handlePreToolUse(stdin)).toEqual({ exitCode: 0, stdout: "" });
    expect(requests).toEqual([]);
  });

  it.each([
    ["a subagent agent_id", { agent_id: "agent-1" }],
    ["a subagent agent_type", { agent_type: "worker" }],
    ["a non-string agent_id", { agent_id: 7 }],
    ["a null agent_id", { agent_id: null }],
    ["a non-string agent_type", { agent_type: {} }],
    ["a missing tool name", { tool_name: undefined }],
    ["a non-string tool name", { tool_name: 5 }],
    ["a missing cwd", { cwd: undefined }],
    ["a blank cwd", { cwd: "  " }],
    ["an unsupported tool", { tool_name: "Write" }],
    ["the LCM MCP server", { tool_name: "mcp__lcm__search" }],
    ["a command with no useful terms", { tool_input: { command: "ls -la" } }],
    ["a command with unsupported shell syntax", { tool_input: { command: "echo $(git status)" } }],
  ] as const)("returns empty output for %s without contacting the daemon", async (_label, overrides) => {
    enable();
    expect(await run(overrides)).toEqual({ exitCode: 0, stdout: "" });
    expect(requests).toEqual([]);
  });

  it("returns empty output when LCM is disabled through the environment", async () => {
    enable();
    vi.stubEnv("LCM_ENABLED", "false");
    expect(await run()).toEqual({ exitCode: 0, stdout: "" });
    expect(requests).toEqual([]);
  });

  it.each([
    ["an absent config", undefined],
    ["an explicitly disabled config", { daemon: { port: 1 }, hooks: { preToolRecall: false } }],
    ["a config without the key", { daemon: { port: 1 }, hooks: { snapshotIntervalSec: 30 } }],
    ["a malformed config", "{ not json"],
    ["a non-boolean setting", { daemon: { port: 1 }, hooks: { preToolRecall: "true" } }],
  ] as const)("returns empty output for %s", async (_label, content) => {
    if (content !== undefined) writeConfig(content);
    expect(await run()).toEqual({ exitCode: 0, stdout: "" });
    expect(requests).toEqual([]);
  });

  it("returns empty output when the LCM root is not established", async () => {
    enable();
    vi.spyOn(publicationFence, "assertHookRootEstablished").mockImplementation(() => {
      throw new Error("missing root");
    });
    expect(await run()).toEqual({ exitCode: 0, stdout: "" });
    expect(requests).toEqual([]);
  });

  it("returns empty output on publication-lock contention while loading settings", async () => {
    vi.spyOn(configProjection, "loadStoredPreToolRecallSettings").mockImplementation(() => {
      throw new PrivateMutationLockContentionError("busy");
    });
    expect(await run()).toEqual({ exitCode: 0, stdout: "" });
    expect(requests).toEqual([]);
  });

  it("returns empty output when publication evidence is missing", async () => {
    enable();
    vi.spyOn(publicationFence, "assertHookPublicationFence").mockImplementation(() => {
      throw new BackendPublicationJournalError("publication-evidence-missing", "missing");
    });
    expect(await run()).toEqual({ exitCode: 0, stdout: "" });
    expect(requests).toEqual([]);
  });

  it("rethrows any other publication journal error before contacting the daemon", async () => {
    enable();
    const failure = new BackendPublicationJournalError("unresolved-publication", "unresolved");
    vi.spyOn(publicationFence, "assertHookPublicationFence").mockImplementation(() => { throw failure; });
    await expect(run()).rejects.toBe(failure);
    expect(requests).toEqual([]);
  });

  it("returns empty output when the daemon is unavailable", async () => {
    enable({ daemon: { port: 1 } });
    expect(await run()).toEqual({ exitCode: 0, stdout: "" });
  });

  it.each([
    ["an HTTP error", (_request: IncomingMessage, response: ServerResponse) => { response.writeHead(503); response.end("{}"); }],
    ["a non-JSON body", (_request: IncomingMessage, response: ServerResponse) => { response.writeHead(200); response.end("nope"); }],
  ] as const)("returns empty output for %s from the daemon", async (_label, handler) => {
    enable();
    respond = handler;
    expect(await run()).toEqual({ exitCode: 0, stdout: "" });
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["JSON null", null],
    ["a JSON array", []],
    ["an object without hints", {}],
    ["non-array hints", { hints: "x" }],
    ["no hints", { hints: [] }],
    ["only blank or non-string hints", { hints: ["", "   ", 5, null], ids: ["a", "b", "c", "d"] }],
  ] as const)("returns empty output for %s", async (_label, body) => {
    enable();
    reply(body);
    expect(await run()).toEqual({ exitCode: 0, stdout: "" });
  });

  it.each([
    ["aligned ids", { hints: ["one", "two"], ids: ["id-1", "id-2"] }, "id-1,id-2", ["- one", "- two"]],
    ["blank hints dropped with their ids", { hints: ["", "two"], ids: ["id-1", "id-2"] }, "id-2", ["- two"]],
    ["non-string hints dropped with their ids", { hints: [7, "two", "three"], ids: ["id-1", "id-2", "id-3"] }, "id-2,id-3", ["- two", "- three"]],
    ["fewer ids than hints", { hints: ["one", "two"], ids: ["id-1"] }, undefined, ["- one", "- two"]],
    ["a blank id", { hints: ["one", "two"], ids: ["id-1", " "] }, undefined, ["- one", "- two"]],
    ["a non-string id", { hints: ["one", "two"], ids: ["id-1", 2] }, undefined, ["- one", "- two"]],
    ["ids that are not an array", { hints: ["one"], ids: "id-1" }, undefined, ["- one"]],
    ["absent ids", { hints: ["one"] }, undefined, ["- one"]],
  ] as const)("renders %s", async (_label, body, expectedIds, expectedLines) => {
    enable();
    reply(body);
    const context = parse((await run()).stdout).hookSpecificOutput.additionalContext;
    for (const line of expectedLines) expect(context).toContain(line);
    if (expectedIds === undefined) expect(context).not.toContain("surfaced-memory-ids");
    else expect(context).toContain("<!-- surfaced-memory-ids: " + expectedIds + " -->");
  });

  it("abandons a silent daemon at the wall-clock deadline", async () => {
    enable();
    respond = () => undefined;
    const started = Date.now();
    expect(await run({}, { deadlineMs: 150 })).toEqual({ exitCode: 0, stdout: "" });
    expect(Date.now() - started).toBeLessThan(1400);
  });

  it("abandons a trickling response at the wall-clock deadline", async () => {
    enable();
    const timers: NodeJS.Timeout[] = [];
    respond = (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write("{");
      const timer = setInterval(() => response.write(" "), 40);
      timers.push(timer);
      response.on("close", () => clearInterval(timer));
    };
    const started = Date.now();
    try {
      expect(await run({}, { deadlineMs: 300 })).toEqual({ exitCode: 0, stdout: "" });
      expect(Date.now() - started).toBeLessThan(1400);
    } finally {
      for (const timer of timers) clearInterval(timer);
    }
  });
});
