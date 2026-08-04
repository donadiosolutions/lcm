import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createManagedCredentialDirectory,
  writeManagedCredentialFiles,
} from "../../src/daemon/managed-credentials.js";
import {
  createSupervisor,
  createSupervisorSpec,
  type SupervisorDependencies,
  type SupervisorObservation,
  type SupervisorSpec,
} from "../../src/daemon/supervisor.js";

type CommandResult = Readonly<{
  code?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}>;

type CommandCall = Readonly<{
  command: string;
  args: readonly string[];
}>;

const MAX_CAPTURED_MANAGER_OUTPUT = 64 * 1024;
const MAX_MANAGER_EXEC_BUFFER = 1024 * 1024;
const FIXTURE_NONCE = "launchd-integration";
const CHILD_SOURCE = `
import { createServer } from "node:http";

const port = Number(process.env.LCM_SUPERVISOR_PORT);
const metadata = () => ({
  status: "ok",
  marker: process.env.LCM_SUPERVISOR_MARKER,
  scope: process.env.LCM_SUPERVISOR_SCOPE,
  stateRoot: process.env.LCM_SUPERVISOR_STATE_ROOT,
  nonce: process.env.LCM_SUPERVISOR_NONCE,
  port,
  pid: process.pid,
});

const server = createServer((request, response) => {
  response.setHeader("Connection", "close");
  if (request.url === "/health") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(metadata()));
    return;
  }
  if (request.url === "/exit") {
    response.statusCode = 200;
    response.end("bye", () => {
      server.close();
      const timer = setTimeout(() => process.exit(0), 25);
      timer.unref();
    });
    return;
  }
  response.statusCode = 404;
  response.end();
});

server.listen(port, "127.0.0.1");
`;

const fixtureRoots = new Set<string>();

afterEach(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  fixtureRoots.clear();
});

function boundedText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_CAPTURED_MANAGER_OUTPUT) : "";
}

/** Run only the exact launchctl command requested by the supervisor. */
function runLaunchctl(
  command: string,
  args: readonly string[],
  options: Parameters<SupervisorDependencies["run"]>[2],
): Promise<CommandResult> {
  if (command !== "launchctl") {
    return Promise.resolve({ code: 127, stdout: "", stderr: "unsupported command" });
  }
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: options.env === undefined ? process.env : { ...process.env, ...options.env },
        encoding: "utf8",
        // A whole GUI domain can be larger than the bounded observation text;
        // retain only the bounded prefix returned to the supervisor parser.
        maxBuffer: MAX_MANAGER_EXEC_BUFFER,
        timeout: options.timeoutMs,
      },
      (error, stdout, stderr) => {
        const output = {
          stdout: boundedText(stdout),
          stderr: boundedText(stderr),
        };
        if (error === null) {
          resolve({ code: 0, ...output });
          return;
        }
        const errorCode = typeof error.code === "number" ? error.code : null;
        const unavailable = error.code === "ENOENT";
        resolve({
          code: unavailable ? 127 : errorCode,
          ...output,
          ...(error.killed === true || error.signal === "SIGTERM" ? { timedOut: true } : {}),
        });
      },
    );
  });
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      if (port === undefined) {
        server.close(() => reject(new Error("launchd fixture port was not allocated")));
        return;
      }
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve(port);
      });
    });
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type ExactHealth = {
  status: "ok";
  marker: string;
  scope: string;
  stateRoot: string;
  nonce: string;
  port: number;
  pid: number;
};

function isExactHealth(
  value: unknown,
  spec: SupervisorSpec,
  managerPid: number,
): value is ExactHealth {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  return body.status === "ok"
    && body.marker === spec.marker
    && body.scope === spec.scopeDigest
    && body.stateRoot === spec.stateRoot
    && body.nonce === spec.nonce
    && body.port === spec.port
    && body.pid === managerPid;
}

async function waitForExactHealth(
  spec: SupervisorSpec,
  managerPid: number,
): Promise<ExactHealth> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${spec.port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200) {
        const body: unknown = await response.json();
        if (isExactHealth(body, spec, managerPid)) return body;
      }
    } catch {
      // The launchd child may still be between bootstrap and listen().
    }
    await wait(100);
  }
  throw new Error("launchd fixture health did not become exact");
}

async function waitForTerminal(
  supervisor: ReturnType<typeof createSupervisor>,
  spec: SupervisorSpec,
): Promise<SupervisorObservation & { kind: "registered-not-running-valid" }> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const observed = await supervisor.probe(spec);
    if (observed.kind === "registered-not-running-valid") return observed;
    await wait(100);
  }
  throw new Error("launchd fixture did not reach registered terminal state");
}

describe("real launchd daemon lifecycle", () => {
  it.runIf(process.platform === "darwin")(
    "starts, authenticates, observes terminal exit, and boots out one scoped job",
    { timeout: 60_000 },
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "lcm-launchd-integration-")));
      fixtureRoots.add(root);
      const nonce = `${FIXTURE_NONCE}-${process.pid}`;
      const credentialDirectory = createManagedCredentialDirectory(root, nonce);
      const credentialFile = writeManagedCredentialFiles(credentialDirectory, {
        OPENAI_API_KEY: "fixture-value",
      })[0];
      const childEntrypoint = join(root, "health-child.mjs");
      writeFileSync(childEntrypoint, CHILD_SOURCE, { mode: 0o700 });
      const port = await allocatePort();
      const uid = typeof process.getuid === "function" ? process.getuid() : -1;
      expect(uid).toBeGreaterThanOrEqual(0);

      const calls: CommandCall[] = [];
      const run: SupervisorDependencies["run"] = async (command, args, options) => {
        calls.push(Object.freeze({ command, args: [...args] }));
        return runLaunchctl(command, args, options);
      };

      // A Darwin worker without a GUI bootstrap domain cannot safely exercise
      // launchd user services. It is an integration failure, never a skip.
      const guiDomain = `gui/${uid}`;
      const guiProbe = await run("launchctl", ["print", guiDomain], { timeoutMs: 5_000 });
      expect(guiProbe.timedOut).toBe(false);
      expect(guiProbe.code).toBe(0);

      const spec = createSupervisorSpec({
        kind: "launchd-user",
        stateRoot: root,
        port,
        nonce,
        executable: process.execPath,
        args: [childEntrypoint],
        cwd: root,
        credentialDirectory,
        credentialFiles: [{ name: "OPENAI_API_KEY", path: credentialFile }],
        stopTimeoutMs: 10_000,
      });
      expect(spec.stateRoot).toBe(root);
      expect(spec.credentialDirectory).toBe(credentialDirectory);
      expect(spec.launchdLabel).toMatch(/^com\.donadiosolutions\.lcm\.daemon\.[0-9a-f]{20}$/u);
      expect(spec.port).toBeGreaterThan(0);
      expect(existsSync(credentialFile)).toBe(true);

      const supervisor = createSupervisor("launchd-user", { run, platform: "darwin", uid });
      let managerReady = true;
      try {
        const started = await supervisor.start(spec);
        expect(started.kind).toBe("launchd-user");
        expect(started.name).toBe(spec.launchdLabel);
        expect(started.scopeDigest).toBe(spec.scopeDigest);
        expect(started.port).toBe(spec.port);
        expect(started.nonce).toBe(spec.nonce);
        expect(started.managerPid).toBeTypeOf("number");

        const managerPid = started.managerPid!;
        const running = await supervisor.probe(spec);
        expect(running).toMatchObject({
          kind: "registered-running-valid",
          managerPid,
          marker: spec.marker,
          scopeDigest: spec.scopeDigest,
          stateRoot: spec.stateRoot,
          port: spec.port,
          nonce: spec.nonce,
          name: spec.launchdLabel,
        });
        const health = await waitForExactHealth(spec, managerPid);
        expect(health).toEqual({
          status: "ok",
          marker: spec.marker,
          scope: spec.scopeDigest,
          stateRoot: spec.stateRoot,
          nonce: spec.nonce,
          port: spec.port,
          pid: managerPid,
        });

        const exitResponse = await fetch(`http://127.0.0.1:${spec.port}/exit`, {
          signal: AbortSignal.timeout(5_000),
        });
        expect(exitResponse.status).toBe(200);
        const terminal = await waitForTerminal(supervisor, spec);
        expect(terminal).toMatchObject({
          kind: "registered-not-running-valid",
          marker: spec.marker,
          scopeDigest: spec.scopeDigest,
          stateRoot: spec.stateRoot,
          port: spec.port,
          nonce: spec.nonce,
          name: spec.launchdLabel,
        });
        expect(["inactive", "failed", "last-exit"]).toContain(terminal.terminal);

        await supervisor.stopAndAwaitAbsent(spec);
        managerReady = false;
        expect(await supervisor.probe(spec)).toMatchObject({ kind: "absent", name: spec.launchdLabel });
        const plistPath = join(spec.stateRoot, `daemon.${spec.shortDigest}.${spec.nonce}.plist`);
        expect(existsSync(plistPath)).toBe(false);
        expect(existsSync(credentialFile)).toBe(false);
        expect(existsSync(credentialDirectory)).toBe(false);
        expect(readdirSync(spec.stateRoot).filter((entry) => entry.endsWith(".plist"))).toEqual([]);

        const bootstrapCalls = calls.filter((call) => call.args[0] === "bootstrap");
        expect(bootstrapCalls).toHaveLength(1);
        expect(bootstrapCalls[0]?.args).toEqual([
          "bootstrap",
          guiDomain,
          plistPath,
        ]);
        const bootoutCalls = calls.filter((call) => call.args[0] === "bootout");
        expect(bootoutCalls).toHaveLength(1);
        expect(bootoutCalls[0]?.args).toEqual([
          "bootout",
          `${guiDomain}/${spec.launchdLabel}`,
        ]);
      } finally {
        if (managerReady) await supervisor.stopAndAwaitAbsent(spec);
        rmSync(root, { recursive: true, force: true });
        fixtureRoots.delete(root);
      }
    },
  );
});
