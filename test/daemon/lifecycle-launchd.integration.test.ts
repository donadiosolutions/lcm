import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

const integrationEnabled = process.platform === "darwin" && process.env.LCM_LAUNCHD_INTEGRATION === "1";
const launchdProductLabel: { value?: string } = {};
const LAUNCHD_MANAGER_ACTIVITY_SENTINEL = "launchd-user";
let sharedStateRoot: string | undefined;
let ownsSharedStateRoot = false;
let managerActivityReported = false;

function getSharedStateRoot(): string {
  if (sharedStateRoot === undefined) throw new Error("launchd integration state root is unavailable");
  return sharedStateRoot;
}

beforeAll(() => {
  if (!integrationEnabled) return;
  const workflowStateRoot = process.env.LCM_LAUNCHD_RESOURCE_ROOT;
  if (workflowStateRoot !== undefined) {
    if (!existsSync(workflowStateRoot) || !statSync(workflowStateRoot).isDirectory()) {
      throw new Error("launchd integration workflow state root is unavailable");
    }
    sharedStateRoot = realpathSync(workflowStateRoot);
    return;
  }
  sharedStateRoot = realpathSync(mkdtempSync(join(tmpdir(), "lcm-launchd-run-")));
  ownsSharedStateRoot = true;
});

afterAll(() => {
  if (ownsSharedStateRoot && sharedStateRoot !== undefined) {
    rmSync(sharedStateRoot, { recursive: true, force: true });
  }
  sharedStateRoot = undefined;
  ownsSharedStateRoot = false;
});

/**
 * Record the actual derived launchd product label privately for the trap.
 *
 * The workflow passes one fresh unpredictable run evidence token via
 * LCM_LAUNCHD_EVIDENCE_TOKEN. We bind the exact derived product label to that
 * token (0600, "<uuid> <label>") so the EXIT trap can prove the marker was
 * written by the current workflow run before any bootout. Without the token
 * the marker is not written at all; the workflow then fails hard because no
 * fresh current-run evidence exists.
 */
function exposeProductLabel(spec: SupervisorSpec): void {
  const resourceRoot = process.env.LCM_LAUNCHD_RESOURCE_ROOT;
  const manifestLabel = process.env.LCM_LAUNCHD_LABEL;
  const evidenceToken = process.env.LCM_LAUNCHD_EVIDENCE_TOKEN;
  if (resourceRoot === undefined || manifestLabel === undefined || evidenceToken === undefined) return;
  if (spec.stateRoot !== getSharedStateRoot()) {
    throw new Error("launchd integration must use one run-owned state root");
  }
  if (spec.launchdLabel !== launchdProductLabel.value && launchdProductLabel.value !== undefined) {
    throw new Error("launchd integration derived more than one product label");
  }
  launchdProductLabel.value = spec.launchdLabel;
  const marker = join(resourceRoot, "launchd.label");
  writeFileSync(marker, `${evidenceToken} ${spec.launchdLabel}\n`, { mode: 0o600 });
}

const MAX_CAPTURED_MANAGER_OUTPUT = 64 * 1024;
const MAX_MANAGER_EXEC_BUFFER = 1024 * 1024;
const FIXTURE_NONCE = "launchd-integration";
const CHILD_SOURCE = `
import { createServer } from "node:http";
import { existsSync } from "node:fs";

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

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
const wedgePath = argument("--wedge-file");
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
        const value = await readFile(credentialPath);
        additions = JSON.stringify({
          credentialLength: value.byteLength,
          credentialMode,
          credentialClaimed: stats.isFile() && value.byteLength > 0,
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

function launchdIntegrationEnvironment(extra: Readonly<Record<string, string | undefined>>): Record<string, string> {
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
  stateRoot: string;
  root: string;
  homeRoot: string;
  runtimeRoot: string;
  wedgePath: string;
  childEntrypoint: string;
  port: number;
  calls: readonly CommandCall[];
  run: SupervisorDependencies["run"];
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
}): Promise<LaunchdIntegrationFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lcm-launchd-integration-")));
  fixtureRoots.add(root);
  const stateRoot = getSharedStateRoot();
  const homeRoot = join(root, "home");
  const runtimeRoot = join(root, "runtime");
  mkdirSync(homeRoot, { mode: 0o700 });
  mkdirSync(runtimeRoot, { mode: 0o700 });
  const wedgePath = join(runtimeRoot, "wedged");
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  expect(uid).toBeGreaterThanOrEqual(0);
  const guiDomain = `gui/${uid}`;
  const nonce = `${FIXTURE_NONCE}-${process.pid}${options?.nonceSuffix ?? ""}`;
  const childEntrypoint = join(root, "health-child.mjs");
  writeFileSync(childEntrypoint, CHILD_SOURCE, { mode: 0o700 });
  const port = await allocatePort();
  const launchEnvironment = launchdIntegrationEnvironment({
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    TMPDIR: runtimeRoot,
    TMP: runtimeRoot,
    TEMP: runtimeRoot,
    XDG_RUNTIME_DIR: runtimeRoot,
  });

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
    const environment = buildOptions.launchEnvironment === undefined
      ? launchEnvironment
      : launchdIntegrationEnvironment({ ...launchEnvironment, ...buildOptions.launchEnvironment });
    const spec = createSupervisorSpec({
      kind: "launchd-user",
      stateRoot,
      port,
      nonce: buildOptions.nonce ?? nonce,
      executable: process.execPath,
      args: [childEntrypoint, "--wedge-file", wedgePath],
      cwd: root,
      launchEnvironment: environment,
      credentialDirectory: buildOptions.credentialDirectory,
      credentialFiles: buildOptions.credentialFiles,
      stopTimeoutMs: 10_000,
    });
    return spec;
  };

  return Object.freeze({
    stateRoot,
    root,
    homeRoot,
    runtimeRoot,
    wedgePath,
    childEntrypoint,
    port,
    calls,
    run,
    supervisor,
    guiDomain,
    uid,
    nonce,
    buildSpec,
  });
}

async function cleanupLaunchdFixture(
  fixture: LaunchdIntegrationFixture,
  managerReady: boolean,
  spec: SupervisorSpec,
  primaryError: unknown,
): Promise<void> {
  let cleanupError: unknown;
  if (managerReady) {
    try {
      await fixture.supervisor.stopAndAwaitAbsent(spec);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError === undefined && primaryError === undefined) {
    // launchctl print can report an exact label absent before the GUI domain
    // releases that label for a subsequent bootstrap. Keep sequential cases
    // isolated without weakening the supervisor's fail-closed observation.
    await wait(2_000);
  }
  try {
    rmSync(fixture.root, { recursive: true, force: true });
  } catch (error) {
    cleanupError ??= error;
  }
  fixtureRoots.delete(fixture.root);
  if (cleanupError === undefined) return;
  if (primaryError !== undefined) {
    console.error("launchd fixture cleanup failed after the primary test failure", cleanupError);
    return;
  }
  throw cleanupError;
}

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
        if (isExactHealth(body, spec, managerPid)) {
          if (!managerActivityReported) {
            managerActivityReported = true;
            console.log(LAUNCHD_MANAGER_ACTIVITY_SENTINEL);
          }
          return body;
        }
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
  it.runIf(integrationEnabled)(
    "starts, authenticates, observes terminal exit, and boots out one scoped job",
    { timeout: 60_000 },
    async () => {
      const fixture = await createLaunchdFixture({ nonceSuffix: "-terminal" });
      const credentialDirectory = createManagedCredentialDirectory(fixture.stateRoot, fixture.nonce);
      const credentialFile = writeManagedCredentialFiles(credentialDirectory, {
        OPENAI_API_KEY: "fixture-value",
      })[0];

      // A Darwin worker without a GUI bootstrap domain cannot safely exercise
      // launchd user services. It is an integration failure, never a skip.
      const guiProbe = await fixture.run("launchctl", ["print", fixture.guiDomain], { timeoutMs: 5_000 });
      expect(guiProbe.timedOut).not.toBe(true);
      expect(guiProbe.code).toBe(0);

      const spec = fixture.buildSpec({
        credentialDirectory,
        credentialFiles: [{ name: "OPENAI_API_KEY", path: credentialFile }],
      });
      expect(spec.stateRoot).toBe(fixture.stateRoot);
      expect(spec.cwd).toBe(fixture.root);
      expect(spec.launchEnvironment?.HOME).toBe(fixture.homeRoot);
      expect(spec.launchEnvironment?.XDG_RUNTIME_DIR).toBe(fixture.runtimeRoot);
      expect(spec.credentialDirectory).toBe(credentialDirectory);
      expect(spec.launchdLabel).toMatch(/^com\.donadiosolutions\.lcm\.daemon\.[0-9a-f]{20}$/u);
      expect(spec.port).toBeGreaterThan(0);
      expect(existsSync(credentialFile)).toBe(true);

      let managerReady = true;
      let primaryError: unknown;
      try {
        exposeProductLabel(spec);
        const started = await fixture.supervisor.start(spec);
        expect(started.kind).toBe("launchd-user");
        expect(started.name).toBe(spec.launchdLabel);
        expect(started.scopeDigest).toBe(spec.scopeDigest);
        expect(started.port).toBe(spec.port);
        expect(started.nonce).toBe(spec.nonce);
        expect(started.managerPid).toBeTypeOf("number");

        const managerPid = started.managerPid!;
        const running = await fixture.supervisor.probe(spec);
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
          credentialLength: "fixture-value".length,
          credentialMode: 0o600,
          credentialClaimed: true,
        });
        expect(JSON.stringify(health).includes("fixture-value")).toBe(false);

        const exitResponse = await fetch(`http://127.0.0.1:${spec.port}/exit`, {
          signal: AbortSignal.timeout(5_000),
        });
        expect(exitResponse.status).toBe(200);
        const terminal = await waitForTerminal(fixture.supervisor, spec);
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

        await fixture.supervisor.stopAndAwaitAbsent(spec);
        managerReady = false;
        expect(await fixture.supervisor.probe(spec)).toMatchObject({ kind: "absent", name: spec.launchdLabel });
        const plistPath = join(spec.stateRoot, `daemon.${spec.shortDigest}.${spec.nonce}.plist`);
        expect(existsSync(plistPath)).toBe(false);
        expect(existsSync(credentialFile)).toBe(false);
        expect(existsSync(credentialDirectory)).toBe(false);
        expect(readdirSync(spec.stateRoot).filter((entry) => entry.endsWith(".plist"))).toEqual([]);

        const bootstrapCalls = fixture.calls.filter((call) => call.args[0] === "bootstrap");
        expect(bootstrapCalls).toHaveLength(1);
        expect(bootstrapCalls[0]?.args).toEqual([
          "bootstrap",
          fixture.guiDomain,
          plistPath,
        ]);
        const bootoutCalls = fixture.calls.filter((call) => call.args[0] === "bootout");
        expect(bootoutCalls).toHaveLength(1);
        expect(bootoutCalls[0]?.args).toEqual([
          "bootout",
          `${fixture.guiDomain}/${spec.launchdLabel}`,
        ]);
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        await cleanupLaunchdFixture(fixture, managerReady, spec, primaryError);
      }
    },
  );

  it.runIf(integrationEnabled)(
    "claims one exact credential with mode 0600 through a healthy managed admission and removes it on exact cleanup",
    { timeout: 60_000 },
    async () => {
      const fixture = await createLaunchdFixture({ nonceSuffix: "-claim" });
      const credentialDirectory = createManagedCredentialDirectory(fixture.stateRoot, fixture.nonce);
      const secretValue = "sk-proj-launchd-real-redaction-fixture-value";
      const credentialFile = writeManagedCredentialFiles(credentialDirectory, {
        OPENAI_API_KEY: secretValue,
      })[0];
      const spec = fixture.buildSpec({
        credentialDirectory,
        credentialFiles: [{ name: "OPENAI_API_KEY", path: credentialFile }],
      });
      expect(existsSync(credentialFile)).toBe(true);
      expect(statSync(credentialFile).mode & 0o777).toBe(0o600);

      let managerReady = true;
      let primaryError: unknown;
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
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        await cleanupLaunchdFixture(fixture, managerReady, spec, primaryError);
      }
    },
  );

  it.runIf(integrationEnabled)(
    "redacts the one-launch secret from every bounded manager output while restarting a wedged no-response job through launchctl without legacy signals",
    { timeout: 60_000 },
    async () => {
      const fixture = await createLaunchdFixture({ nonceSuffix: "-restart" });
      const credentialDirectory = createManagedCredentialDirectory(fixture.stateRoot, fixture.nonce);
      const secretValue = "sk-proj-launchd-real-redaction-fixture-value";
      const credentialFile = writeManagedCredentialFiles(credentialDirectory, {
        OPENAI_API_KEY: secretValue,
      })[0];
      const spec = fixture.buildSpec({
        credentialDirectory,
        credentialFiles: [{ name: "OPENAI_API_KEY", path: credentialFile }],
      });
      const recoveryNonce = `${fixture.nonce}-recovered`;
      const recoveryCredentialDirectory = createManagedCredentialDirectory(fixture.stateRoot, recoveryNonce);
      const recoveryCredentialFile = writeManagedCredentialFiles(recoveryCredentialDirectory, {
        OPENAI_API_KEY: secretValue,
      })[0];
      const recoverySpec = fixture.buildSpec({
        nonce: recoveryNonce,
        credentialDirectory: recoveryCredentialDirectory,
        credentialFiles: [{ name: "OPENAI_API_KEY", path: recoveryCredentialFile }],
      });
      const wedgePath = fixture.wedgePath;
      expect(existsSync(credentialFile)).toBe(true);
      expect(statSync(credentialFile).mode & 0o777).toBe(0o600);

      const guiProbe = await fixture.supervisor.probe(spec);
      if (guiProbe.kind === "unavailable") {
        throw new Error(`launchd integration GUI domain unavailable: ${guiProbe.reason}`);
      }

      let managerReady = true;
      let primaryError: unknown;
      try {
        exposeProductLabel(spec);
        const started = await fixture.supervisor.start(spec);
        expect(started.kind).toBe("launchd-user");
        const initialManagerPid = started.managerPid!;
        const initialHealth = await waitForExactHealth(spec, initialManagerPid);
        expect(initialHealth).toMatchObject({
          credentialLength: secretValue.length,
          credentialMode: 0o600,
          credentialClaimed: true,
        });
        expect(JSON.stringify(initialHealth).includes(secretValue)).toBe(false);

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

        // Recovery receives a newly staged one-shot snapshot and nonce. The
        // supervisor must authenticate and retire the wedged prior launch
        // before admitting this replacement; reusing the consumed launch's
        // credential path would not model the production lifecycle.
        const restarted = await fixture.supervisor.stopAndStart(recoverySpec);
        expect(restarted.kind).toBe("launchd-user");
        expect(restarted.managerPid).toBeGreaterThan(0);
        expect(restarted.managerPid).not.toBe(initialManagerPid);
        expect(restarted.nonce).toBe(recoverySpec.nonce);

        const recoveryHealth = await waitForExactHealth(recoverySpec, restarted.managerPid!);
        expect(recoveryHealth).toMatchObject({
          status: "ok",
          pid: restarted.managerPid,
          credentialLength: secretValue.length,
          credentialMode: 0o600,
          credentialClaimed: true,
        });
        expect(JSON.stringify(recoveryHealth).includes(secretValue)).toBe(false);

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
        const observation = await fixture.supervisor.probe(recoverySpec);
        expect(observation).toMatchObject({
          kind: "registered-running-valid",
          managerPid: restarted.managerPid,
          scopeDigest: recoverySpec.scopeDigest,
          nonce: recoverySpec.nonce,
          name: recoverySpec.launchdLabel,
        });

        await fixture.supervisor.stopAndAwaitAbsent(recoverySpec);
        managerReady = false;
        expect(await fixture.supervisor.probe(recoverySpec)).toMatchObject({
          kind: "absent",
          name: recoverySpec.launchdLabel,
        });
        expect(existsSync(credentialFile)).toBe(false);
        expect(existsSync(credentialDirectory)).toBe(false);
        expect(existsSync(recoveryCredentialFile)).toBe(false);
        expect(existsSync(recoveryCredentialDirectory)).toBe(false);
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        await cleanupLaunchdFixture(fixture, managerReady, recoverySpec, primaryError);
      }
    },
  );

  it.runIf(integrationEnabled)(
    "recreates a prior-nonce terminal clean-exit registration exactly once and admits the replacement before cleanup",
    { timeout: 90_000 },
    async () => {
      const firstNonce = `launchd-integration-${process.pid}-first`;
      const recreatedNonce = `launchd-integration-${process.pid}-recreated`;
      const fixture = await createLaunchdFixture({ nonceSuffix: "-recreate" });
      const firstCredentialDirectory = createManagedCredentialDirectory(fixture.stateRoot, firstNonce);
      const firstCredentialFile = writeManagedCredentialFiles(firstCredentialDirectory, {
        OPENAI_API_KEY: "sk-proj-launchd-real-redaction-fixture-value",
      })[0];
      const firstSpec = fixture.buildSpec({
        nonce: firstNonce,
        credentialDirectory: firstCredentialDirectory,
        credentialFiles: [{ name: "OPENAI_API_KEY", path: firstCredentialFile }],
      });
      const recreatedCredentialDirectory = createManagedCredentialDirectory(fixture.stateRoot, recreatedNonce);
      const recreatedCredentialFile = writeManagedCredentialFiles(recreatedCredentialDirectory, {
        OPENAI_API_KEY: "sk-proj-launchd-real-redaction-fixture-value",
      })[0];
      const recreatedSpec = fixture.buildSpec({
        nonce: recreatedNonce,
        credentialDirectory: recreatedCredentialDirectory,
        credentialFiles: [{ name: "OPENAI_API_KEY", path: recreatedCredentialFile }],
      });

      let managerReady = true;
      let recreatedStarted: SupervisorStartResult | undefined;
      let primaryError: unknown;
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

        // The prior nonce is terminal but still manager-registered. Its
        // one-launch credentials remain until exact manager absence is proven;
        // deleting them earlier would violate the cleanup boundary.
        expect(existsSync(firstCredentialFile)).toBe(true);

        const restarted = await fixture.supervisor.stopAndStart(recreatedSpec);
        recreatedStarted = restarted;
        expect(restarted.kind).toBe("launchd-user");
        expect(restarted.managerPid).toBeGreaterThan(0);
        expect(restarted.nonce).toBe(recreatedSpec.nonce);
        await waitForExactHealth(recreatedSpec, restarted.managerPid!);
        expect(existsSync(firstCredentialFile)).toBe(false);
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
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        await cleanupLaunchdFixture(fixture, managerReady, recreatedSpec, primaryError);
      }
      if (recreatedStarted !== undefined) {
        expect(recreatedStarted.kind).toBe("launchd-user");
      }
    },
  );
});
