import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TERMINAL_STDIN_MAX_BYTES } from "../../src/cli/terminal-stdin.js";

const TOKEN = "process-test-token";
const FIXTURE = `
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const { MODE, POST_MODE, TOKEN, ENTRYPOINT, DIGEST, VERSION, OUT } = process.env;
const server = createServer((req, res) => {
  const authorized = req.headers.authorization === "Bearer " + TOKEN;
  const reply = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/health") {
    if (MODE === "hang-health") return;
    const identity = { status: "ok", version: VERSION, storageBackend: "sqlite", pid: process.pid };
    return reply(200, req.headers.authorization === undefined ? identity : { ...identity, entrypoint: ENTRYPOINT, runtimeDigest: DIGEST });
  }
  if (req.url === "/stats/pool") return reply(authorized ? 200 : 401, {});
  if (req.url === "/ingest/terminal") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      appendFileSync(OUT, JSON.stringify({ authorized, body: JSON.parse(body) }) + "\\n");
      if (POST_MODE !== "hang") reply(202, { accepted: true });
    });
    return;
  }
  reply(404, {});
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;
const UPTIME_PROBE = `
const { writeFileSync } = require("node:fs");
process.on("exit", () => {
  writeFileSync(process.env.UPTIME_OUT + ".home", require("node:os").homedir());
  writeFileSync(process.env.UPTIME_OUT, String(process.uptime() * 1000));
});
`;

type Result = { code: number | null; stdout: string; stderr: string; wallMs: number; nodeMs: number };

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const readOrUndefined = (path: string): string | undefined => {
  try { return readFileSync(path, "utf-8"); } catch { return undefined; }
};

/** What the child saw and left behind, appended to any failed assertion about a run. */
function describeRun(home: string, result: Result): string {
  const lcm = join(home, ".lcm");
  const log = join(lcm, "logs", "events.log");
  const requests = readOrUndefined(join(home, "fixture-requests.jsonl"));
  const state = (name: string): string => `${name}: ${existsSync(join(lcm, name)) ? "present" : "missing"}`;
  return [
    `exit code: ${String(result.code)}; node uptime ms: ${result.nodeMs}; wall ms: ${Math.round(result.wallMs)}`,
    `stdout: ${JSON.stringify(result.stdout)}`,
    `stderr: ${JSON.stringify(result.stderr)}`,
    `expected home: ${home}`,
    `home seen by the child: ${readOrUndefined(join(home, "uptime.txt.home")) ?? "missing"}`,
    `hook error log path: ${log}`,
    `hook error log: ${readOrUndefined(log) ?? "missing"}`,
    `daemon state: ${["config.json", "daemon.token", "daemon.pid"].map(state).join("; ")}`,
    `fixture requests: ${requests === undefined ? "no fixture" : requests.split("\n").filter(Boolean).length}`,
  ].join("\n");
}

function diagnose(home: string, result: Result, assertions: () => void): void {
  try {
    assertions();
  } catch (error) {
    if (error instanceof Error) error.message += `\n--- child diagnostics ---\n${describeRun(home, result)}`;
    throw error;
  }
}

describe.skipIf(process.platform !== "linux")("packaged lcm session-snapshot --terminal", () => {
  let root: string;
  let runtime: string;
  let digest: string;
  let version: string;
  let probe: string;
  let fixturePath: string;
  const children: ChildProcess[] = [];
  let counter = 0;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lcm-terminal-process-"));
    runtime = join(root, "package", "dist", "lcm.mjs");
    mkdirSync(join(root, "package", "dist"), { recursive: true });
    const manifest = readFileSync(resolve("package.json"));
    writeFileSync(join(root, "package", "package.json"), manifest);
    version = (JSON.parse(manifest.toString()) as { version: string }).version;
    buildSync({
      entryPoints: [resolve("bin/lcm.ts")], outfile: runtime,
      bundle: true, platform: "node", format: "esm", target: "node22",
      banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    });
    digest = createHash("sha256").update(readFileSync(runtime)).digest("hex");
    probe = join(root, "uptime-probe.cjs");
    writeFileSync(probe, UPTIME_PROBE);
    fixturePath = join(root, "fixture-daemon.mjs");
    writeFileSync(fixturePath, FIXTURE);
  });
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null) {
        const exited = new Promise((done) => child.once("exit", done));
        child.kill("SIGKILL");
        await exited;
      }
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function makeHome(port: number): { home: string; lcm: string; transcript: string; log: string } {
    const home = join(root, `home-${counter++}`);
    const lcm = join(home, ".lcm");
    mkdirSync(lcm, { recursive: true, mode: 0o700 });
    writeFileSync(join(lcm, "config.json"), JSON.stringify({ daemon: { port } }), { mode: 0o600 });
    writeFileSync(join(lcm, "daemon.token"), TOKEN, { mode: 0o600 });
    const transcript = join(home, "rollout.jsonl");
    writeFileSync(transcript, "{}\n");
    return { home, lcm, transcript, log: join(lcm, "logs", "events.log") };
  }

  async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((done) => server.close(() => done()));
    return port;
  }

  async function startFixture(
    home: string,
    env: Record<string, string>,
  ): Promise<{ port: number; out: string }> {
    const out = join(home, "fixture-requests.jsonl");
    writeFileSync(out, "");
    const child = spawn(process.execPath, [fixturePath], {
      env: { PATH: "/usr/bin:/bin", TOKEN, ENTRYPOINT: runtime, DIGEST: digest, VERSION: version, OUT: out, ...env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    children.push(child);
    const port = await new Promise<number>((done, fail) => {
      child.once("error", fail);
      child.stdout!.once("data", (chunk) => done(Number(String(chunk).trim())));
    });
    writeFileSync(join(home, ".lcm", "daemon.pid"), String(child.pid), { mode: 0o600 });
    return { port, out };
  }

  async function run(
    home: string,
    input: { stdin?: string | Buffer | "open"; env?: Record<string, string> },
  ): Promise<Result> {
    const uptimeOut = join(home, "uptime.txt");
    const started = performance.now();
    // Codex runs hook commands through a login shell with a 3 second cap. The
    // host's login profile may export anything, so `env -i` rebuilds the child's
    // environment from this allowlist after the profile has run.
    const env: Record<string, string> = {
      PATH: "/usr/bin:/bin", HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"),
      XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"), TMPDIR: home,
      NODE_NO_WARNINGS: "1", UPTIME_OUT: uptimeOut, ...input.env,
    };
    const assignments = Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}`).join(" ");
    const child = spawn("/bin/sh", ["-lc", `/usr/bin/env -i ${assignments} "${process.execPath}" --require "${probe}" "${runtime}" session-snapshot --client codex --terminal`], {
      cwd: home,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => { stdout += chunk; });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    child.stdin!.on("error", () => undefined);
    if (input.stdin !== "open") child.stdin!.end(input.stdin ?? "");
    else child.stdin!.write("{");
    const code = await new Promise<number | null>((done) => child.once("close", done));
    const wallMs = performance.now() - started;
    let nodeMs = Number.NaN;
    try { nodeMs = Number(readFileSync(uptimeOut, "utf-8")); } catch { /* the probe did not run */ }
    return { code, stdout, stderr, wallMs, nodeMs };
  }

  const payload = (home: string, transcript: string, event = "SessionEnd"): string => JSON.stringify({
    hook_event_name: event, session_id: "process-session", cwd: home, transcript_path: transcript, reason: "other",
  });
  const logged = (log: string): Array<{ hook: string; error: string; cwd?: string }> => {
    try {
      return readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch { return []; }
  };
  const expectSilentSuccess = (result: Result): void => {
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    // Node's own budget, then Codex's cap for the whole command including the shell.
    expect(result.nodeMs).toBeLessThan(1500);
    expect(result.wallMs).toBeLessThan(3000);
  };

  it("hands the transcript to a running, verified daemon and logs nothing", async () => {
    const { home, transcript, log } = makeHome(0);
    const fixture = await startFixture(home, { MODE: "daemon" });
    writeFileSync(join(home, ".lcm", "config.json"), JSON.stringify({ daemon: { port: fixture.port } }), { mode: 0o600 });
    chmodSync(join(home, ".lcm", "config.json"), 0o600);

    const result = await run(home, { stdin: payload(home, transcript, "Interrupt") });

    diagnose(home, result, () => {
      expectSilentSuccess(result);
      const requests = readFileSync(fixture.out, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
      expect(requests).toEqual([{
        authorized: true,
        body: { session_id: "process-session", cwd: home, transcript_path: transcript, client: "codex", event: "Interrupt" },
      }]);
      expect(logged(log)).toEqual([]);
    });
  });

  it("logs unconfirmed and still leaves within the Node budget when the daemon never acknowledges", async () => {
    const { home, transcript, log } = makeHome(0);
    const fixture = await startFixture(home, { MODE: "daemon", POST_MODE: "hang" });
    writeFileSync(join(home, ".lcm", "config.json"), JSON.stringify({ daemon: { port: fixture.port } }), { mode: 0o600 });

    const result = await run(home, { stdin: payload(home, transcript) });

    diagnose(home, result, () => {
      expectSilentSuccess(result);
      expect(logged(log).map(({ hook, error }) => [hook, error])).toEqual([["SessionEnd", "unconfirmed"]]);
      expect(result.nodeMs).toBeGreaterThan(1000);
    });
  });

  it("refuses at once, without starting anything, when no daemon is running", async () => {
    const { home, lcm, transcript, log } = makeHome(await freePort());
    const config = readFileSync(join(lcm, "config.json"), "utf-8");

    const result = await run(home, { stdin: payload(home, transcript) });

    diagnose(home, result, () => {
      expectSilentSuccess(result);
      expect(logged(log).map(({ hook, error, cwd }) => [hook, error, cwd])).toEqual([["SessionEnd", "daemon-unavailable", undefined]]);
      expect(readFileSync(join(lcm, "config.json"), "utf-8")).toBe(config);
      expect(() => readFileSync(join(lcm, "daemon.pid"))).toThrow();
    });
  });

  it("gives up on a daemon whose health check hangs within the verification cap", async () => {
    const { home, transcript, log } = makeHome(0);
    const fixture = await startFixture(home, { MODE: "hang-health" });
    writeFileSync(join(home, ".lcm", "config.json"), JSON.stringify({ daemon: { port: fixture.port } }), { mode: 0o600 });

    const result = await run(home, { stdin: payload(home, transcript) });

    diagnose(home, result, () => {
      expectSilentSuccess(result);
      expect(logged(log).map(({ error }) => error)).toEqual(["daemon-unavailable"]);
      expect(result.nodeMs).toBeLessThan(1000);
    });
  });

  it("stops reading a payload that never reaches EOF after the stdin cap", async () => {
    const { home, log } = makeHome(await freePort());

    const result = await run(home, { stdin: "open" });

    diagnose(home, result, () => {
      expectSilentSuccess(result);
      expect(logged(log).map(({ error }) => error)).toEqual(["deadline-exhausted"]);
      expect(result.nodeMs).toBeLessThan(1000);
    });
  });

  it("refuses an oversize payload without parsing it", async () => {
    const { home, log } = makeHome(await freePort());

    const result = await run(home, { stdin: Buffer.alloc(TERMINAL_STDIN_MAX_BYTES + 1, "x") });

    diagnose(home, result, () => {
      expectSilentSuccess(result);
      expect(logged(log).map(({ error }) => error)).toEqual(["invalid-input"]);
    });
  });

  it("does nothing at all, not even reading stdin, when LCM_ENABLED is false", async () => {
    const { home, log } = makeHome(await freePort());

    const result = await run(home, { stdin: "open", env: { LCM_ENABLED: "false" } });

    diagnose(home, result, () => {
      expectSilentSuccess(result);
      expect(logged(log)).toEqual([]);
      expect(result.nodeMs).toBeLessThan(1000);
    });
  });
});

