import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MANAGED_CREDENTIAL_NAMES,
  createManagedCredentialDirectory,
  writeManagedCredentialFiles,
} from "../../src/daemon/managed-credentials.js";
import {
  createSupervisor,
  createSupervisorSpec,
  type SupervisorDependencies,
  type SupervisorObservation,
  type SupervisorSpec,
  type SupervisorStartResult,
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

const launchdProductLabel: { value?: string } = {};

/** Record the actual derived launchd product label privately for the trap. */
function exposeProductLabel(spec: SupervisorSpec): void {
  const resourceRoot = process.env.LCM_LAUNCHD_RESOURCE_ROOT;
  const manifestLabel = process.env.LCM_LAUNCHD_LABEL;
  if (resourceRoot === undefined || manifestLabel === undefined) return;
  if (spec.launchdLabel !== launchdProductLabel.value && launchdProductLabel.value !== undefined) {
    throw new Error("launchd integration derived more than one product label");
  }
  launchdProductLabel.value = spec.launchdLabel;
  // The workflow holds the manifest's run-scope label in $LCM_LAUNCHD_LABEL.
  // We store the actual privately derived product label keyed to that manifest,
  // so the EXIT trap reads a pinned marker instead of re-deriving one itself.
  const marker = join(resourceRoot, "launchd.label");
  writeFileSync(marker, spec.launchdLabel, { mode: 0o600 });
}

const MAX_CAPTURED_MANAGER_OUTPUT = 64 * 1024;
const MAX_MANAGER_EXEC_BUFFER = 1024 * 1024;
const FIXTURE_NONCE = "launchd-integration";
const CHILD_SOURCE = `
import { createServer } from "node:http";
import { existsSync } from "node:fs";

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
const credentialPath = process.env.LCM_CREDENTIAL_OPENAI_API_KEY_FILE;
const wedgePath = process.env.LCM_TEST_WEDGE_FILE;
const expectedCredentialLength = Number(process.env.LCM_TEST_EXPECTED_CREDENTIAL_LENGTH ?? "0");
const exitRequest = (response) => {
  response.statusCode = 200;
  response.end("bye", () => {
    server.close();
    const timer = setTimeout(() => process.exit(0), 25);
    timer.unref();
  });
};

const server = createServer((request, response) => {
  response.setHeader("Connection", "close");
  if (request.url === "/health") {
    if (wedgePath !== undefined && existsSync(wedgePath)) return;
    void (async () => {
      let additions = "";
      if (credentialPath !== undefined) {
        const { stat, readFile } = await import("node:fs/promises");
        const stats = await stat(credentialPath);
        const credentialMode = stats.mode & 0o777;
        // The exact secret value is never echoed; the response is limited to
        // its redacted evidence so captured output cannot leak the credential.
        const value = (await readFile(credentialPath, "utf8")).trim();
        additions = JSON.stringify({
          credentialLength: value.length,
          credentialMode,
          credentialClaimed: expectedCredentialLength > 0 && Number(value.length) === expectedCredentialLength,
        }).slice(1, -1) + ",";
      }
      response.setHeader("Content-Type", "application/json");
      const body = JSON.stringify(metadata());
      response.end(additions === "" ? body : "{" + additions + body.slice(1));
    })().catch((error) => {
      response.statusCode = 500;
      response.end(String(error));
    });
    return;
  }
  if (request.url === "/exit") {
    exitRequest(response);
    return;
  }
  response.statusCode = 404;
  response.end();
});

server.listen(port, "127.0.0.1");
`;

const fixtureRoots = new Set<string>();

function launchdIntegrationEnvironment(extra: Record<string, string | undefined>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const managed of MANAGED_CREDENTIAL_NAMES) delete environment[managed];
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

type LaunchdIntegrationFixture = Readonly<{
  root: string;
  childEntrypoint: string;
  port: number;
  calls: readonly CommandCall[];
  supervisor: ReturnType<typeof createSupervisor>;
  guiDomain: string;
  uid: number;
  nonce: string;
  buildSpec: (options?: {
    nonce?: string;
    credentialDirectory?: string;
    credentialFiles?: ReadonlyArray<{ readonly name: string; readonly path: string }>;
    launchEnvironment?: Readonly<Record<string, string>>;
  }) => SupervisorSpec;
}>;

async function createLaunchdFixture(options?: {
  nonceSuffix?: string;
  launchEnvironmentExtra?: Record<string, string>;
}): Promise<LaunchdIntegrationFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lcm-launchd-integration-")));
  fixtureRoots.add(root);
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  expect(uid).toBeGreaterThanOrEqual(0);
  const guiDomain = `gui/${uid}`;
  const nonce = `${FIXTURE_NONCE}-${process.pid}${options?.nonceSuffix ?? ""}`;
  const childEntrypoint = join(root, "health-child.mjs");
  writeFileSync(childEntrypoint, CHILD_SOURCE, { mode: 0o700 });
  const port = await allocatePort();

  const calls: CommandCall[] = [];
  const run: SupervisorDependencies["run"] = async (command, args, runOptions) => {
    calls.push(Object.freeze({ command, args: [...args] }));
    return runLaunchctl(command, args, runOptions);
  };

  const supervisor = createSupervisor("launchd-user", {
    run,
    platform: "darwin",
    uid,
  });

  const buildSpec: LaunchdIntegrationFixture["buildSpec"] = (buildOptions = {}) => {
    const launchEnvironment = launchdIntegrationEnvironment(options?.launchEnvironmentExtra ?? {});
    const spec = createSupervisorSpec({
      kind: "launchd-user",
      stateRoot: root,
      port,
      nonce: buildOptions.nonce ?? nonce,
      executable: process.execPath,
      args: [childEntrypoint],
      cwd: root,
      launchEnvironment,
      credentialDirectory: buildOptions.credentialDirectory,
      credentialFiles: buildOptions.credentialFiles,
      stopTimeoutMs: 10_000,
    });
    return spec;
  };

  return Object.freeze({
    root,
    childEntrypoint,
    port,
    calls,
    supervisor,
    guiDomain,
    uid,
    nonce,
    buildSpec,
  });
}

async function cleanupLaunchdFixture(fixture: LaunchdIntegrationFixture, spec: SupervisorSpec): Promise<void> {
  try {
    await fixture.supervisor.stopAndAwaitAbsent(spec);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    fixtureRoots.delete(fixture.root);
  }
}

afterEach(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  fixtureRoots.clear();
});

function boundedText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_CAPTURED_MANAGER_OUTPUT) : "";
}

function publishLaunchdEvidence(spec: SupervisorSpec): void {
  const resourceRoot = process.env.LCM_LAUNCHD_RESOURCE_ROOT;
  const evidenceToken = process.env.LCM_LAUNCHD_EVIDENCE_TOKEN;
  if (resourceRoot === undefined || evidenceToken === undefined) return;
  if (spec.stateRoot !== realpathSync(resourceRoot)) {
    throw new Error("launchd integration must use the workflow resource root");
  }
  writeFileSync(join(resourceRoot, "launchd.label"), `${evidenceToken} ${spec.launchdLabel}\n`, {
    mode: 0o600,
  });
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
  credentialLength?: number;
  credentialMode?: number;
  credentialClaimed?: boolean;
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
  it.runIf(process.platform === "darwin" && process.env.LCM_LAUNCHD_INTEGRATION === "1")(
    "starts, authenticates, observes terminal exit, and boots out one scoped job",
    { timeout: 60_000 },
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "lcm-launchd-integration-")));
      fixtureRoots.add(root);
      const configuredResourceRoot = process.env.LCM_LAUNCHD_RESOURCE_ROOT;
      const stateRoot = configuredResourceRoot === undefined
        ? root
        : realpathSync(configuredResourceRoot);
      if (configuredResourceRoot !== undefined) {
        expect(statSync(stateRoot).mode & 0o777).toBe(0o700);
      }
      const nonce = `${FIXTURE_NONCE}-${process.pid}`;
      const credentialDirectory = createManagedCredentialDirectory(stateRoot, nonce);
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

      const guiDomain = `gui/${uid}`;
      const guiProbe = await run("launchctl", ["print", guiDomain], { timeoutMs: 5_000 });
      expect(guiProbe.timedOut).not.toBe(true);
      expect(guiProbe.code).toBe(0);

      const spec = createSupervisorSpec({
        kind: "launchd-user",
        stateRoot,
        port,
        nonce,
        executable: process.execPath,
        args: [childEntrypoint],
        cwd: root,
        credentialDirectory,
        credentialFiles: [{ name: "OPENAI_API_KEY", path: credentialFile }],
        stopTimeoutMs: 10_000,
      });
      expect(spec.stateRoot).toBe(stateRoot);
      expect(spec.credentialDirectory).toBe(credentialDirectory);
      expect(spec.launchdLabel).toMatch(/^com\.donadiosolutions\.lcm\.daemon\.[0-9a-f]{20}$/u);
      expect(spec.port).toBeGreaterThan(0);
      expect(existsSync(credentialFile)).toBe(true);

      const supervisor = createSupervisor("launchd-user", { run, platform: "darwin", uid });
      let managerReady = true;
      try {
        exposeProductLabel(spec);
        const started = await supervisor.start(spec);
        publishLaunchdEvidence(spec);
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
        expect(bootstrapCalls[0]?.args).toEqual(["bootstrap", guiDomain, plistPath]);
        const bootoutCalls = calls.filter((call) => call.args[0] === "bootout");
        expect(bootoutCalls).toHaveLength(1);
        expect(bootoutCalls[0]?.args).toEqual(["bootout", `${guiDomain}/${spec.launchdLabel}`]);
      } finally {
        if (managerReady) await supervisor.stopAndAwaitAbsent(spec);
        rmSync(root, { recursive: true, force: true });
        fixtureRoots.delete(root);
      }
    },
  );

  it.runIf(process.platform === "darwin" && process.env.LCM_LAUNCHD_INTEGRATION === "1")(
    "claims one exact credential with mode 0600 through a healthy managed admission and removes it on exact cleanup",
    { timeout: 60_000 },
    async () => {
      const fixture = await createLaunchdFixture({ nonceSuffix: "-claim" });
      const credentialDirectory = createManagedCredentialDirectory(fixture.root, fixture.nonce);
      const secretValue = "sk-proj-launchd-real-redaction-fixture-value";
      const credentialFile = writeManagedCredentialFiles(credentialDirectory, {
        OPENAI_API_KEY: secretValue,
      })[0];
      const launchEnvironment = launchdIntegrationEnvironment({
        LCM_TEST_EXPECTED_CREDENTIAL_MODE: "384",
        LCM_TEST_EXPECTED_CREDENTIAL_LENGTH: String(secretValue.length),
      });
      const spec = createSupervisorSpec({
        kind: "launchd-user",
        stateRoot: fixture.root,
        port: fixture.port,
        nonce: fixture.nonce,
        executable: process.execPath,
        args: [fixture.childEntrypoint],
        cwd: fixture.root,
        credentialDirectory,
        credentialFiles: [{ name: "OPENAI_API_KEY", path: credentialFile }],
        launchEnvironment,
        stopTimeoutMs: 10_000,
      });
      expect(existsSync(credentialFile)).toBe(true);
      expect(statSync(credentialFile).mode & 0o777).toBe(0o600);

      let managerReady = true;
      try {
        exposeProductLabel(spec);
        const started = await fixture.supervisor.start(spec);
        expect(started.kind).toBe("launchd-user");
        expect(started.managerPid).toBeTypeOf("number");
        expect(started.name).toBe(spec.launchdLabel);

        const health = await waitForExactHealth(spec, started.managerPid!);
        expect(health).toMatchObject({
          status: "ok",
          marker: spec.marker,
          scope: spec.scopeDigest,
          stateRoot: spec.stateRoot,
          nonce: spec.nonce,
          port: spec.port,
          pid: started.managerPid,
          credentialLength: secretValue.length,
          credentialMode: 0o600,
          credentialClaimed: true,
        });
        const serializedHealth = JSON.stringify(health);
        expect(serializedHealth.includes(secretValue)).toBe(false);

        await fixture.supervisor.stopAndAwaitAbsent(spec);
        managerReady = false;
        const finalObservation = await fixture.supervisor.probe(spec);
        expect(finalObservation).toMatchObject({ kind: "absent", name: spec.launchdLabel });

        expect(existsSync(credentialFile)).toBe(false);
        expect(existsSync(credentialDirectory)).toBe(false);
      } finally {
        if (managerReady) await fixture.supervisor.stopAndAwaitAbsent(spec);
        rmSync(fixture.root, { recursive: true, force: true });
        fixtureRoots.delete(fixture.root);
      }
    },
  );

  it.runIf(process.platform === "darwin" && process.env.LCM_LAUNCHD_INTEGRATION === "1")(
    "redacts the one-launch secret from every bounded manager output while restarting a wedged no-response job through launchctl without legacy signals",
    { timeout: 60_000 },
    async () => {
      const fixture = await createLaunchdFixture({ nonceSuffix: "-restart" });
      const credentialDirectory = createManagedCredentialDirectory(fixture.root, fixture.nonce);
      const secretValue = "sk-proj-launchd-real-redaction-fixture-value";
      const credentialFile = writeManagedCredentialFiles(credentialDirectory, {
        OPENAI_API_KEY: secretValue,
      })[0];
      const wedgePath = join(fixture.root, "wedged");
      const launchEnvironment = launchdIntegrationEnvironment({
        LCM_TEST_WEDGE_FILE: wedgePath,
        LCM_TEST_EXPECTED_CREDENTIAL_MODE: "384",
        LCM_TEST_EXPECTED_CREDENTIAL_LENGTH: String(secretValue.length),
      });
      const spec = createSupervisorSpec({
        kind: "launchd-user",
        stateRoot: fixture.root,
        port: fixture.port,
        nonce: fixture.nonce,
        executable: process.execPath,
        args: [fixture.childEntrypoint],
        cwd: fixture.root,
        credentialDirectory,
        credentialFiles: [{ name: "OPENAI_API_KEY", path: credentialFile }],
        launchEnvironment,
        stopTimeoutMs: 10_000,
      });
      expect(existsSync(credentialFile)).toBe(true);
      expect(statSync(credentialFile).mode & 0o777).toBe(0o600);

      const guiProbe = await fixture.supervisor.probe(spec);
      if (guiProbe.kind === "unavailable") {
        throw new Error(`launchd integration GUI domain unavailable: ${guiProbe.reason}`);
      }

      let managerReady = true;
      try {
        exposeProductLabel(spec);
        const started = await fixture.supervisor.start(spec);
        expect(started.kind).toBe("launchd-user");
        const initialManagerPid = started.managerPid!;
        await waitForExactHealth(spec, initialManagerPid);

        writeFileSync(wedgePath, "wedged\n");
        const controller = new AbortController();
        const noResponse = await Promise.race([
          fetch(`http://127.0.0.1:${spec.port}/health`, { signal: controller.signal })
            .then(() => false)
            .catch(() => true),
          wait(500).then(() => true),
        ]);
        controller.abort();
        expect(noResponse).toBe(true);
        rmSync(wedgePath, { force: true });

        const wedgedObservation = await fixture.supervisor.probe(spec);
        expect(wedgedObservation).toMatchObject({
          kind: "registered-running-valid",
          managerPid: initialManagerPid,
          scopeDigest: spec.scopeDigest,
          nonce: spec.nonce,
          name: spec.launchdLabel,
        });

        const restarted = await fixture.supervisor.stopAndStart(spec);
        expect(restarted.kind).toBe("launchd-user");
        expect(restarted.managerPid).toBeGreaterThan(0);
        expect(restarted.managerPid).not.toBe(initialManagerPid);

        const recoveryHealth = await waitForExactHealth(spec, restarted.managerPid!);
        expect(recoveryHealth).toMatchObject({
          status: "ok",
          pid: restarted.managerPid,
          credentialLength: secretValue.length,
          credentialMode: 0o600,
          credentialClaimed: true,
        });

        const bootoutCalls = fixture.calls.filter(call => call.args[0] === "bootout");
        expect(bootoutCalls.some(call => call.args[1] === `${fixture.guiDomain}/${spec.launchdLabel}`)).toBe(true);
        const bootstrapCalls = fixture.calls.filter(call => call.args[0] === "bootstrap");
        expect(bootstrapCalls.length).toBeGreaterThanOrEqual(2);
        expect(fixture.calls.some(call => /^(?:kill|pkill|killall)$/u.test(call.command))).toBe(false);

        const boundedOutputs = fixture.calls.map(call => {
          return `${call.command} ${call.args.join(" ")}`;
        }).join("\n");
        expect(boundedOutputs.includes(secretValue)).toBe(false);

        // A second proof of absence must never depend on an unconstrained raw
        // print of the final plist; assert the exact observed JSON and the
        // absence verdict after an exact-scoped cleanup.
        const observation = await fixture.supervisor.probe(spec);
        expect(observation).toMatchObject({
          kind: "registered-running-valid",
          managerPid: restarted.managerPid,
          scopeDigest: spec.scopeDigest,
          nonce: spec.nonce,
          name: spec.launchdLabel,
        });

        await fixture.supervisor.stopAndAwaitAbsent(spec);
        managerReady = false;
        expect(await fixture.supervisor.probe(spec)).toMatchObject({
          kind: "absent",
          name: spec.launchdLabel,
        });
        expect(existsSync(credentialFile)).toBe(false);
        expect(existsSync(credentialDirectory)).toBe(false);
      } finally {
        if (managerReady) await fixture.supervisor.stopAndAwaitAbsent(spec);
        rmSync(fixture.root, { recursive: true, force: true });
        fixtureRoots.delete(fixture.root);
      }
    },
  );

  it.runIf(process.platform === "darwin" && process.env.LCM_LAUNCHD_INTEGRATION === "1")(
    "recreates a prior-nonce terminal clean-exit registration exactly once and admits the replacement before cleanup",
    { timeout: 90_000 },
    async () => {
      const firstNonce = `launchd-integration-${process.pid}-first`;
      const recreatedNonce = `launchd-integration-${process.pid}-recreated`;
      const fixture = await createLaunchdFixture({ nonceSuffix: "-terminal", launchEnvironmentExtra: {} });
      const firstCredentialDirectory = createManagedCredentialDirectory(fixture.root, firstNonce);
      const firstCredentialFile = writeManagedCredentialFiles(firstCredentialDirectory, {
        OPENAI_API_KEY: "sk-proj-launchd-real-redaction-fixture-value",
      })[0];
      const firstSpec = fixture.buildSpec({
        nonce: firstNonce,
        credentialDirectory: firstCredentialDirectory,
        credentialFiles: [{ name: "OPENAI_API_KEY", path: firstCredentialFile }],
        launchEnvironment: launchdIntegrationEnvironment({
          LCM_TEST_EXPECTED_CREDENTIAL_MODE: "384",
          LCM_TEST_EXPECTED_CREDENTIAL_LENGTH: String("sk-proj-launchd-real-redaction-fixture-value".length),
        }),
      });
      const recreatedCredentialDirectory = createManagedCredentialDirectory(fixture.root, recreatedNonce);
      const recreatedCredentialFile = writeManagedCredentialFiles(recreatedCredentialDirectory, {
        OPENAI_API_KEY: "sk-proj-launchd-real-redaction-fixture-value",
      })[0];
      const recreatedSpec = fixture.buildSpec({
        nonce: recreatedNonce,
        credentialDirectory: recreatedCredentialDirectory,
        credentialFiles: [{ name: "OPENAI_API_KEY", path: recreatedCredentialFile }],
        launchEnvironment: launchdIntegrationEnvironment({
          LCM_TEST_EXPECTED_CREDENTIAL_MODE: "384",
          LCM_TEST_EXPECTED_CREDENTIAL_LENGTH: String("sk-proj-launchd-real-redaction-fixture-value".length),
        }),
      });

      let managerReady = true;
      let recreatedStarted: SupervisorStartResult | undefined;
      try {
        exposeProductLabel(firstSpec);
        const firstStarted = await fixture.supervisor.start(firstSpec);
        expect(firstStarted.managerPid).toBeTypeOf("number");
        await waitForExactHealth(firstSpec, firstStarted.managerPid!);

        // Trigger the intentional idle exit; the supervisor must observe
        // registered-not-running before any recreation authority exists.
        const exitResponse = await fetch(`http://127.0.0.1:${firstSpec.port}/exit`, {
          signal: AbortSignal.timeout(5_000),
        });
        expect(exitResponse.status).toBe(200);
        const terminal = await waitForTerminal(fixture.supervisor, firstSpec);
        expect(terminal).toMatchObject({
          kind: "registered-not-running-valid",
          scopeDigest: firstSpec.scopeDigest,
          nonce: firstSpec.nonce,
          name: firstSpec.launchdLabel,
        });
        expect(["inactive", "failed", "last-exit"]).toContain(terminal.terminal);

        // The prior nonce observed terminal existed but has already exited;
        // its private runtime artifacts must not be present for recreation.
        expect(existsSync(firstCredentialFile)).toBe(false);

        const restarted = await fixture.supervisor.stopAndStart(recreatedSpec);
        recreatedStarted = restarted;
        expect(restarted.kind).toBe("launchd-user");
        expect(restarted.managerPid).toBeGreaterThan(0);
        expect(restarted.nonce).toBe(recreatedSpec.nonce);
        await waitForExactHealth(recreatedSpec, restarted.managerPid!);
        const admitted = await fixture.supervisor.probe(recreatedSpec);
        expect(admitted).toMatchObject({
          kind: "registered-running-valid",
          managerPid: restarted.managerPid,
          scopeDigest: recreatedSpec.scopeDigest,
          nonce: recreatedSpec.nonce,
          name: recreatedSpec.launchdLabel,
        });

        await fixture.supervisor.stopAndAwaitAbsent(recreatedSpec);
        managerReady = false;
        expect(await fixture.supervisor.probe(recreatedSpec)).toMatchObject({
          kind: "absent",
          name: recreatedSpec.launchdLabel,
        });
        expect(existsSync(recreatedCredentialFile)).toBe(false);
        expect(existsSync(recreatedCredentialDirectory)).toBe(false);
        expect(readdirSync(fixture.root).filter(entry => entry.endsWith(".plist"))).toEqual([]);

        const bootoutCalls = fixture.calls.filter(call => call.args[0] === "bootout");
        expect(bootoutCalls.some(call => call.args[1] === `${fixture.guiDomain}/${firstSpec.launchdLabel}`)).toBe(true);
        expect(bootoutCalls.some(call => call.args[1] === `${fixture.guiDomain}/${recreatedSpec.launchdLabel}`)).toBe(true);
        expect(fixture.calls.some(call => /^(?:kill|pkill|killall)$/u.test(call.command))).toBe(false);
      } finally {
        if (managerReady) await fixture.supervisor.stopAndAwaitAbsent(recreatedSpec);
        rmSync(fixture.root, { recursive: true, force: true });
        fixtureRoots.delete(fixture.root);
      }
      if (recreatedStarted !== undefined) {
        expect(recreatedStarted.kind).toBe("launchd-user");
      }
    },
  );
});
