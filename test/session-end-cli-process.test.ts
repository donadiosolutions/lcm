import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

let root: string;
let executable: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lcm-session-end-process-"));
  executable = join(root, "package", "dist", "lcm.mjs");
  mkdirSync(dirname(executable), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "package", "package.json"), readFileSync(resolve("package.json")));
  const redirectedImports = new Map([
    [resolve("src/hooks/dispatch.ts"), new Set(["../bootstrap.js", "./auto-heal.js", "./config.js"])],
    [resolve("src/hooks/session-end.ts"), new Set(["../daemon/lifecycle.js", "../daemon/config.js"])],
  ]);
  await build({
    entryPoints: [resolve("bin/lcm.ts")], outfile: executable,
    bundle: true, platform: "node", format: "esm", target: "node22",
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    plugins: [{
      name: "session-end-private-admission",
      setup(builder) {
        builder.onResolve({ filter: /^\./ }, args => {
          if (redirectedImports.get(args.importer)?.has(args.path)) {
            return { path: resolve("test/fixtures/session-end-process-admission.ts") };
          }
          return undefined;
        });
      },
    }],
  });
}, 30_000);

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

type Scenario = "acknowledged" | "stalled" | "dribbling" | "http-error" | "codex";

async function exercise(scenario: Scenario): Promise<void> {
  const home = mkdtempSync(join(root, "home-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, PWD: home,
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
    XDG_RUNTIME_DIR: join(home, "runtime"), TMPDIR: join(home, "tmp"),
    NODE_NO_WARNINGS: "1",
  };
  for (const path of [join(home, ".lcm"), ...Object.values(env).filter(value => value?.startsWith(home))]) {
    mkdirSync(path!, { recursive: true, mode: 0o700 });
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(join(home, ".lcm", "daemon.token"), token, { mode: 0o600 });
  const requests: Array<{ path: string; auth: string | undefined; body: unknown }> = [];
  const sockets = new Set<Socket>();
  let receiveCompletion!: (response: ServerResponse) => void;
  const completion = new Promise<ServerResponse>(resolveResponse => { receiveCompletion = resolveResponse; });
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", bytes => { body += bytes; });
    request.on("end", () => {
      requests.push({ path: request.url!, auth: request.headers.authorization, body: JSON.parse(body) });
      if (request.url === "/ingest") {
        response.setHeader("Content-Type", "application/json");
        response.end('{"ingested":2,"totalTokens":16}');
      } else if (request.url === "/session-complete") {
        receiveCompletion(response);
      }
      // Compact/promote responses deliberately remain pending. SessionEnd must
      // wait only for completion, not for these independent background jobs.
    });
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback TCP listener");
  env.LCM_TEST_COMPLETION_PORT = String(address.port);
  writeFileSync(join(home, ".lcm", "config.json"), JSON.stringify({
    storage: { backend: "sqlite" }, daemon: { port: address.port },
  }), { mode: 0o600 });
  const client = scenario === "codex" ? "codex" : "claude";
  const child = spawn(process.execPath, [executable, "session-end", "--client", client], {
    cwd: home, env, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; });
  child.stderr.on("data", bytes => { stderr += bytes; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
  let dribble: ReturnType<typeof setInterval> | undefined;
  try {
    child.stdin.end(JSON.stringify({ cwd: home, session_id: "process-session", client }));
    if (scenario !== "codex") {
      const response = await Promise.race([
        completion,
        exited.then(result => { throw new Error(`CLI exited before completion delivery: ${JSON.stringify(result)} ${stderr}`); }),
      ]);
      const receivedAt = performance.now();
      let responseClosed = false;
      response.once("close", () => { responseClosed = true; });
      if (scenario === "acknowledged") {
        // A controlled acknowledgment gate catches finish-only waiting as well
        // as immediate exit. This delay is server behavior, not a test retry.
        await new Promise(resolveGate => setTimeout(resolveGate, 75));
        expect(child.exitCode).toBeNull();
        expect(responseClosed).toBe(false);
        response.end('{"recorded":true}');
      } else if (scenario === "http-error") {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end('{"status":"blocked","error":"backend publication admission blocked"}');
      } else if (scenario === "dribbling") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write("{");
        dribble = setInterval(() => response.write(" "), 40);
      }
      const result = await exited;
      expect(result).toEqual({ code: 0, signal: null });
      if (scenario === "stalled" || scenario === "dribbling") {
        const elapsed = performance.now() - receivedAt;
        expect(elapsed).toBeGreaterThanOrEqual(750);
        expect(elapsed).toBeLessThan(3000);
        expect(responseClosed).toBe(true);
      }
      expect(requests.find(request => request.path === "/session-complete")).toEqual({
        path: "/session-complete", auth: `Bearer ${token}`,
        body: { session_id: "process-session", cwd: home, message_count: 2 },
      });
    } else {
      expect(await exited).toEqual({ code: 0, signal: null });
      expect(requests.some(request => request.path === "/session-complete")).toBe(false);
    }
    expect(requests.find(request => request.path === "/ingest")).toEqual({
      path: "/ingest", auth: `Bearer ${token}`,
      body: { cwd: home, session_id: "process-session", client },
    });
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  } finally {
    clearTimeout(watchdog);
    clearInterval(dribble);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    rmSync(home, { recursive: true, force: true });
  }
}

describe("native SessionEnd process delivery", () => {
  it("receives completion acknowledgment before explicit CLI exit", () => exercise("acknowledged"));
  it("bounds an accepted completion request that never responds", () => exercise("stalled"));
  it("bounds an active but unfinished completion response", () => exercise("dribbling"));
  it("keeps wire publication errors nonfatal", () => exercise("http-error"));
  it("does not mark a Codex turn complete", () => exercise("codex"));
});
