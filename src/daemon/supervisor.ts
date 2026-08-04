import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { platform as hostPlatform } from "node:os";
import {
  cleanupManagedCredentialDirectory,
  managedCredentialPath,
  validateManagedCredentialDirectory,
} from "./managed-credentials.js";

/** Operating-system service-manager kinds supported by the supervisor layer. */
export type SupervisorKind = "systemd-user" | "launchd-user";

/** Stable, bounded reasons used by observations and diagnostics. */
export type SupervisorReason =
  | "manager-unavailable"
  | "manager-timeout"
  | "manager-command-failed"
  | "manager-not-found"
  | "metadata-missing"
  | "metadata-mismatch"
  | "metadata-malformed"
  | "foreign-job"
  | "pid-missing"
  | "pid-invalid"
  | "state-conflict"
  | "credential-invalid"
  | "cleanup-failed"
  | "unsupported-platform";

type CredentialFileReference = Readonly<{
  name: string;
  path: string;
}>;

/** Canonical metadata and launch arguments for one manager-owned daemon. */
export interface SupervisorSpec {
  readonly kind: SupervisorKind;
  readonly stateRoot: string;
  readonly scopeDigest: string;
  readonly shortDigest: string;
  readonly systemdUnit: string;
  readonly launchdLabel: string;
  readonly name: string;
  readonly marker: "lcm-supervisor-v1";
  readonly port: number;
  readonly nonce: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly entrypoint?: string;
  readonly runtimeDigest?: string;
  readonly storageBackend?: string;
  readonly credentialFiles?: readonly CredentialFileReference[];
  readonly credentialDirectory?: string;
  readonly stopTimeoutMs: number;
}

type SupervisorObservationBase = Readonly<{
  scopeDigest?: string;
  marker?: string;
  stateRoot?: string;
  port?: number;
  nonce?: string;
  executable?: string;
  args?: string;
  cwd?: string;
  entrypoint?: string;
  runtimeDigest?: string;
  storageBackend?: string;
  managerPid?: number;
  name?: string;
}>;

/** Strict manager observations; raw manager output is intentionally absent. */
export type SupervisorObservation =
  | (SupervisorObservationBase & {
    readonly kind: "unavailable";
    readonly reason: SupervisorReason;
  })
  | (SupervisorObservationBase & {
    readonly kind: "absent";
    readonly reason?: SupervisorReason;
  })
  | (SupervisorObservationBase & {
    readonly kind: "registered-running-valid";
    readonly managerPid: number;
  })
  | (SupervisorObservationBase & {
    readonly kind: "registered-not-running-valid";
    readonly terminal: "inactive" | "failed" | "last-exit";
  })
  | (SupervisorObservationBase & {
    readonly kind: "registered-stale-config";
    readonly reason: SupervisorReason;
  })
  | (SupervisorObservationBase & {
    readonly kind: "registered-invalid-collision";
    readonly reason: SupervisorReason;
  })
  | (SupervisorObservationBase & {
    readonly kind: "ambiguous";
    readonly reason: SupervisorReason;
  });

/** Result returned after a manager-owned launch has been adopted or started. */
export interface SupervisorStartResult {
  readonly kind: SupervisorKind;
  readonly name: string;
  readonly scopeDigest: string;
  readonly port: number;
  readonly nonce: string;
  readonly managerPid?: number;
}

type SupervisorCommandResult = Readonly<{
  code?: number | null;
  status?: number | null;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}>;

type SupervisorCommandOptions = Readonly<{
  timeoutMs: number;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}>;

type SupervisorCommandRunner = (
  command: string,
  args: readonly string[],
  options: SupervisorCommandOptions,
) => Promise<SupervisorCommandResult> | SupervisorCommandResult;

/** Injected command/filesystem seams used to keep manager operations bounded and testable. */
export interface SupervisorDependencies {
  readonly run: SupervisorCommandRunner;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly commandTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void> | void;
  readonly now?: () => number;
}

/** Public supervisor operations. */
export interface Supervisor {
  readonly probe: (spec: SupervisorSpec) => Promise<SupervisorObservation>;
  readonly start: (spec: SupervisorSpec) => Promise<SupervisorStartResult>;
  readonly stopAndStart: (spec: SupervisorSpec) => Promise<SupervisorStartResult>;
  readonly stopAndAwaitAbsent: (spec: SupervisorSpec) => Promise<void>;
}

const MARKER = "lcm-supervisor-v1" as const;
const SHA256_HEX_LENGTH = 64;
const SCOPE_NAME_HEX_LENGTH = 20;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const MAX_POLL_INTERVALS = 100;
const MAX_NONCE_LENGTH = 128;
const MAX_METADATA_VALUE_LENGTH = 512;
const MAX_COMMAND_OUTPUT_LENGTH = 64 * 1024;
const MAX_PLIST_BYTES = 64 * 1024;
const MAX_ARGUMENT_COUNT = 128;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const XML_HEADER = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>";

type Realpath = (path: string) => string;

function defaultRealpath(path: string): string {
  return realpathSync(path);
}

function assertFinitePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("supervisor port is invalid");
  }
}

function assertNonce(nonce: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(nonce)
    || nonce.length > MAX_NONCE_LENGTH
  ) {
    throw new Error("supervisor nonce is invalid");
  }
}

function assertMetadataValue(value: string, label: string): void {
  if (
    value.length === 0
    || value.length > MAX_METADATA_VALUE_LENGTH
    || /[\u0000\r\n]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function digestScope(stateRoot: string): string {
  return createHash("sha256").update(stateRoot, "utf8").digest("hex");
}

/**
 * Canonicalize a state root and derive the stable manager identity. The digest
 * is intentionally based only on the real state-root path; port and nonce are
 * launch metadata and cannot change the service-manager name.
 */
export function canonicalSupervisorScope(
  stateRoot: string,
  realpath: Realpath = defaultRealpath,
): {
  readonly stateRoot: string;
  readonly scopeDigest: string;
  readonly shortDigest: string;
  readonly systemdUnit: string;
  readonly launchdLabel: string;
} {
  if (typeof stateRoot !== "string" || !isAbsolute(stateRoot)) {
    throw new Error("supervisor state root must be absolute");
  }
  let canonical: string;
  try {
    canonical = realpath(resolve(stateRoot));
  } catch {
    throw new Error("supervisor state root is unavailable");
  }
  if (!isAbsolute(canonical)) throw new Error("supervisor state root is not canonical");
  canonical = resolve(canonical);
  const scopeDigest = digestScope(canonical);
  const shortDigest = scopeDigest.slice(0, SCOPE_NAME_HEX_LENGTH);
  return Object.freeze({
    stateRoot: canonical,
    scopeDigest,
    shortDigest,
    systemdUnit: `lcm-daemon-${shortDigest}.service`,
    launchdLabel: `com.donadiosolutions.lcm.daemon.${shortDigest}`,
  });
}

type SupervisorSpecInput = Readonly<{
  kind: SupervisorKind;
  stateRoot: string;
  port: number;
  nonce?: string;
  executable?: string;
  command?: string;
  args?: readonly string[];
  argv?: readonly string[];
  cwd?: string;
  entrypoint?: string;
  runtimeDigest?: string;
  storageBackend?: string;
  credentialFiles?: readonly CredentialFileReference[];
  credentialDirectory?: string;
  stopTimeoutMs?: number;
  realpath?: Realpath;
}>;

/** Construct a fully validated manager specification from a canonical state root. */
export function createSupervisorSpec(input: SupervisorSpecInput): SupervisorSpec {
  if (input.kind !== "systemd-user" && input.kind !== "launchd-user") {
    throw new Error("supervisor kind is invalid");
  }
  assertFinitePort(input.port);
  const nonce = input.nonce ?? randomBytes(16).toString("hex");
  assertNonce(nonce);
  const scope = canonicalSupervisorScope(input.stateRoot, input.realpath);
  const executable = input.executable ?? input.command;
  if (typeof executable !== "string" || !isAbsolute(executable)) {
    throw new Error("supervisor executable must be absolute");
  }
  const args = [...(input.args ?? input.argv ?? [])];
  if (
    args.length > MAX_ARGUMENT_COUNT
    || args.reduce((total, arg) => total + (typeof arg === "string" ? Buffer.byteLength(arg, "utf8") : MAX_ARGUMENT_BYTES), 0) > MAX_ARGUMENT_BYTES
    || args.some((arg) => typeof arg !== "string" || arg.length > MAX_METADATA_VALUE_LENGTH || /[\u0000\r\n]/u.test(arg))
  ) {
    throw new Error("supervisor argument is invalid");
  }
  if (input.cwd !== undefined && (!isAbsolute(input.cwd) || /[\u0000\r\n]/u.test(input.cwd))) {
    throw new Error("supervisor working directory is invalid");
  }
  for (const value of [input.entrypoint, input.runtimeDigest, input.storageBackend]) {
    if (value !== undefined) assertMetadataValue(value, "supervisor metadata");
  }
  const credentialFiles = input.credentialFiles === undefined
    ? undefined
    : Object.freeze(input.credentialFiles.map((credential) => {
      if (
        typeof credential.name !== "string"
        || typeof credential.path !== "string"
        || !isAbsolute(credential.path)
        || /[\u0000\r\n]/u.test(credential.name)
        || /[\u0000\r\n]/u.test(credential.path)
      ) throw new Error("supervisor credential reference is invalid");
      assertMetadataValue(credential.name, "supervisor credential name");
      assertMetadataValue(credential.path, "supervisor credential path");
      return Object.freeze({ name: credential.name, path: resolve(credential.path) });
    }));
  const stopTimeoutMs = input.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  if (!Number.isInteger(stopTimeoutMs) || stopTimeoutMs < 1 || stopTimeoutMs > 60_000) {
    throw new Error("supervisor stop timeout is invalid");
  }
  const name = input.kind === "systemd-user" ? scope.systemdUnit : scope.launchdLabel;
  const result: SupervisorSpec = {
    ...scope,
    kind: input.kind,
    name,
    marker: MARKER,
    port: input.port,
    nonce,
    executable,
    args: Object.freeze(args),
    stopTimeoutMs,
    ...(input.cwd === undefined ? {} : { cwd: resolve(input.cwd) }),
    ...(input.entrypoint === undefined ? {} : { entrypoint: input.entrypoint }),
    ...(input.runtimeDigest === undefined ? {} : { runtimeDigest: input.runtimeDigest }),
    ...(input.storageBackend === undefined ? {} : { storageBackend: input.storageBackend }),
    ...(credentialFiles === undefined ? {} : { credentialFiles }),
    ...(input.credentialDirectory === undefined ? {} : { credentialDirectory: resolve(input.credentialDirectory) }),
  };
  assertMetadataValue(result.stateRoot, "supervisor state root");
  return Object.freeze(result);
}

function resultCode(result: SupervisorCommandResult): number | null {
  if (typeof result.code === "number" || result.code === null) return result.code ?? null;
  if (typeof result.status === "number" || result.status === null) return result.status ?? null;
  if (typeof result.exitCode === "number" || result.exitCode === null) return result.exitCode ?? null;
  return 0;
}

function boundedText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_COMMAND_OUTPUT_LENGTH) : "";
}

function commandResult(result: SupervisorCommandResult): {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
} {
  return Object.freeze({
    code: resultCode(result),
    stdout: boundedText(result.stdout),
    stderr: boundedText(result.stderr),
    timedOut: result.timedOut === true,
  });
}

function unavailableReason(result: {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}): SupervisorReason {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (
    result.code === 127
    || /enoent|not found|failed to connect|connection refused|no such file|permission denied|not running/u.test(text)
  ) return "manager-unavailable";
  return "manager-command-failed";
}

function commandFailedError(): Error {
  return new Error("supervisor manager command failed");
}

function managerUnavailableError(reason: SupervisorReason): Error {
  const error = new Error("supervisor manager unavailable");
  error.name = "SupervisorManagerError";
  Object.defineProperty(error, "reason", { value: reason, enumerable: true });
  return error;
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_.-]*)\s*(?:=>|=|:)\s*(.*?)\s*$/u.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = parseScalar(match[2]);
    if (value.length <= MAX_METADATA_VALUE_LENGTH) values.set(key, value);
  }
  return values;
}

function flattenJsonValues(value: unknown, output: Map<string, string>, prefix = ""): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    output.set(prefix.toLowerCase(), String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) flattenJsonValues(child, output, `${prefix}[${index}]`);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    flattenJsonValues(child, output, prefix ? `${prefix}.${key}` : key);
  }
}

function parseManagerOutput(text: string): Map<string, string> {
  const values = parseKeyValues(text);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const jsonValues = new Map<string, string>();
      flattenJsonValues(JSON.parse(trimmed), jsonValues);
      for (const [key, value] of jsonValues) values.set(key, value);
    } catch {
      // The key/value parser remains authoritative for ordinary manager output.
    }
  }
  return values;
}

function lookup(values: Map<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const direct = values.get(key);
    if (direct !== undefined) return direct;
    const lower = key.toLowerCase();
    for (const [candidate, value] of values) {
      if (candidate.toLowerCase() === lower || candidate.toLowerCase().endsWith(`.${lower}`)) return value;
    }
  }
  return undefined;
}

function metadata(values: Map<string, string>, name: string): string | undefined {
  const aliases: Record<string, readonly string[]> = {
    LCM_SUPERVISOR_SCOPE: ["scopeDigest", "scope", "ScopeDigest"],
    LCM_SUPERVISOR_MARKER: ["marker", "Marker"],
    LCM_SUPERVISOR_STATE_ROOT: ["stateRoot", "StateRoot"],
    LCM_SUPERVISOR_PORT: ["port", "Port"],
    LCM_SUPERVISOR_NONCE: ["nonce", "Nonce"],
    LCM_SUPERVISOR_EXECUTABLE: ["executable", "Executable"],
    LCM_SUPERVISOR_ARGS: ["args", "Args"],
    LCM_SUPERVISOR_CWD: ["cwd", "Cwd"],
    LCM_SUPERVISOR_ENTRYPOINT: ["entrypoint", "Entrypoint"],
    LCM_SUPERVISOR_RUNTIME_DIGEST: ["runtimeDigest", "RuntimeDigest"],
    LCM_SUPERVISOR_STORAGE_BACKEND: ["storageBackend", "StorageBackend"],
  };
  const direct = lookup(values, name, ...aliases[name], `environment.${name}`, `environment[${name}]`, `env.${name}`);
  if (direct !== undefined) return direct;
  for (const [key, value] of values) {
    // systemd's Environment= field is a space-separated list of assignments;
    // launchctl print uses `KEY => VALUE` entries under environment = { ... }.
    if (key.toLowerCase() === "environment" || key.toLowerCase() === "env") {
      const assignment = new RegExp(`(?:^|\\s)${name}=((?:"[^"\\n]*")|(?:[^\\s]*))`, "u").exec(value);
      if (assignment) return parseScalar(assignment[1]);
    }
  }
  return undefined;
}

function parsePid(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 0 && port <= 65_535 ? port : undefined;
}

function isNotFoundOutput(text: string): boolean {
  const lower = text.toLowerCase();
  if (/(?:systemctl|launchctl)\s+(?:command )?not found|enoent/u.test(lower)) return false;
  return /unit .*not[- ]found|could not (?:find|be found)|no such service|unit .* not loaded|unknown service|does not exist/u.test(lower);
}

function isRunningState(value: string | undefined): boolean {
  return value !== undefined && /^(active|running|started|launching)$/iu.test(value);
}

function isTerminalState(value: string | undefined): "inactive" | "failed" | "last-exit" | undefined {
  if (value === undefined) return undefined;
  if (/^(inactive|stopped|dead|exited|not-running)$/iu.test(value)) return "inactive";
  if (/^(failed|crashed)$/iu.test(value)) return "failed";
  if (/^(last-exit|terminated|exit)$/iu.test(value)) return "last-exit";
  return undefined;
}

function observationBase(spec: SupervisorSpec, values: Map<string, string>): SupervisorObservationBase {
  const scopeDigest = metadata(values, "LCM_SUPERVISOR_SCOPE");
  const marker = metadata(values, "LCM_SUPERVISOR_MARKER");
  const stateRoot = metadata(values, "LCM_SUPERVISOR_STATE_ROOT");
  const port = parsePort(metadata(values, "LCM_SUPERVISOR_PORT"));
  const nonce = metadata(values, "LCM_SUPERVISOR_NONCE");
  const executable = metadata(values, "LCM_SUPERVISOR_EXECUTABLE");
  const args = metadata(values, "LCM_SUPERVISOR_ARGS");
  const cwd = metadata(values, "LCM_SUPERVISOR_CWD");
  const entrypoint = metadata(values, "LCM_SUPERVISOR_ENTRYPOINT");
  const runtimeDigest = metadata(values, "LCM_SUPERVISOR_RUNTIME_DIGEST");
  const storageBackend = metadata(values, "LCM_SUPERVISOR_STORAGE_BACKEND");
  return {
    ...(scopeDigest === undefined ? {} : { scopeDigest }),
    ...(marker === undefined ? {} : { marker }),
    ...(stateRoot === undefined ? {} : { stateRoot }),
    ...(port === undefined ? {} : { port }),
    ...(nonce === undefined ? {} : { nonce }),
    ...(executable === undefined ? {} : { executable }),
    ...(args === undefined ? {} : { args }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(entrypoint === undefined ? {} : { entrypoint }),
    ...(runtimeDigest === undefined ? {} : { runtimeDigest }),
    ...(storageBackend === undefined ? {} : { storageBackend }),
    name: spec.name,
  };
}

function staleReason(
  spec: SupervisorSpec,
  base: SupervisorObservationBase,
): SupervisorReason | "foreign" {
  if (base.marker === undefined && base.scopeDigest === undefined) return "foreign";
  if (base.marker !== undefined && base.marker !== spec.marker) return "foreign";
  if (base.scopeDigest !== undefined && base.scopeDigest !== spec.scopeDigest) return "metadata-mismatch";
  if (base.stateRoot !== undefined && base.stateRoot !== spec.stateRoot) return "metadata-mismatch";
  if (base.port !== undefined && base.port !== spec.port) return "metadata-mismatch";
  if (base.nonce !== undefined && base.nonce !== spec.nonce) return "metadata-mismatch";
  const expectedArgs = JSON.stringify(spec.args);
  if (base.executable !== undefined && base.executable !== spec.executable) return "metadata-mismatch";
  if (base.args !== undefined && base.args !== expectedArgs) return "metadata-mismatch";
  if (base.cwd !== undefined && base.cwd !== (spec.cwd ?? "")) return spec.cwd === undefined && base.cwd === "" ? "metadata-missing" : "metadata-mismatch";
  if (base.entrypoint !== undefined && base.entrypoint !== (spec.entrypoint ?? "")) return "metadata-mismatch";
  if (base.runtimeDigest !== undefined && base.runtimeDigest !== (spec.runtimeDigest ?? "")) return "metadata-mismatch";
  if (base.storageBackend !== undefined && base.storageBackend !== (spec.storageBackend ?? "")) return "metadata-mismatch";
  if (base.executable === undefined || base.args === undefined || base.cwd === undefined) return "metadata-missing";
  if (spec.entrypoint !== undefined && base.entrypoint === undefined) return "metadata-missing";
  if (spec.runtimeDigest !== undefined && base.runtimeDigest === undefined) return "metadata-missing";
  if (spec.storageBackend !== undefined && base.storageBackend === undefined) return "metadata-missing";
  // The canonical state root is not required to be repeated by every manager;
  // full scope and launch identity are checked by classifyRegistered below.
  return "metadata-missing";
}

function classifyRegistered(
  spec: SupervisorSpec,
  values: Map<string, string>,
  commandCode: number | null,
): SupervisorObservation {
  const base = observationBase(spec, values);
  const reason = staleReason(spec, base);
  if (reason === "foreign") {
    return Object.freeze({ kind: "registered-invalid-collision", reason: "foreign-job", ...base });
  }
  if (reason !== "metadata-missing") {
    return Object.freeze({ kind: "registered-stale-config", reason, ...base });
  }
  if (
    base.marker === undefined
    || base.scopeDigest === undefined
    || base.port === undefined
    || base.nonce === undefined
    || base.executable === undefined
    || base.args === undefined
    || base.cwd === undefined
    || (spec.cwd !== undefined && base.cwd === "")
    || (spec.entrypoint !== undefined && base.entrypoint === undefined)
    || (spec.runtimeDigest !== undefined && base.runtimeDigest === undefined)
    || (spec.storageBackend !== undefined && base.storageBackend === undefined)
  ) {
    return Object.freeze({ kind: "registered-stale-config", reason: "metadata-missing", ...base });
  }
  const state = lookup(values, "ActiveState", "SubState", "state", "State", "status");
  const active = isRunningState(state) || isRunningState(lookup(values, "ActiveState", "state"));
  const terminal = isTerminalState(state) ?? isTerminalState(lookup(values, "ActiveState", "SubState"));
  const pidValue = lookup(values, "MainPID", "pid", "PID", "process.pid", "ProcessID");
  if (active) {
    const managerPid = parsePid(pidValue);
    if (managerPid === undefined) return Object.freeze({ kind: "ambiguous", reason: "pid-missing", ...base });
    if (commandCode !== null && commandCode !== 0) return Object.freeze({ kind: "ambiguous", reason: "state-conflict", ...base });
    return Object.freeze({ kind: "registered-running-valid", managerPid, ...base });
  }
  if (terminal !== undefined) {
    if (pidValue !== undefined && pidValue !== "0" && parsePid(pidValue) !== undefined) {
      return Object.freeze({ kind: "ambiguous", reason: "state-conflict", ...base });
    }
    if (commandCode !== null && commandCode !== 0 && !isNotFoundOutput(JSON.stringify([...values]))) {
      return Object.freeze({ kind: "ambiguous", reason: "state-conflict", ...base });
    }
    return Object.freeze({ kind: "registered-not-running-valid", terminal, ...base });
  }
  return Object.freeze({ kind: "ambiguous", reason: "metadata-malformed", ...base });
}

function launchdDomain(uid: number): string {
  if (!Number.isInteger(uid) || uid < 0) throw new Error("launchd uid is invalid");
  return `gui/${uid}`;
}

function plistPath(spec: SupervisorSpec): string {
  return resolve(spec.stateRoot, `daemon.${spec.shortDigest}.${spec.nonce}.plist`);
}

function xmlEscape(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function plistArray(values: readonly string[]): string {
  return `<array>${values.map((value) => `<string>${xmlEscape(value)}</string>`).join("")}</array>`;
}

function plistEnvironment(spec: SupervisorSpec): string {
  const values: Array<readonly [string, string]> = [
    ["LCM_SUPERVISOR_MARKER", spec.marker],
    ["LCM_SUPERVISOR_SCOPE", spec.scopeDigest],
    ["LCM_SUPERVISOR_STATE_ROOT", spec.stateRoot],
    ["LCM_SUPERVISOR_PORT", String(spec.port)],
    ["LCM_SUPERVISOR_NONCE", spec.nonce],
    ["LCM_SUPERVISOR_EXECUTABLE", spec.executable],
    ["LCM_SUPERVISOR_ARGS", JSON.stringify(spec.args)],
    ["LCM_SUPERVISOR_CWD", spec.cwd ?? ""],
  ];
  if (spec.entrypoint !== undefined) values.push(["LCM_SUPERVISOR_ENTRYPOINT", spec.entrypoint]);
  if (spec.runtimeDigest !== undefined) values.push(["LCM_SUPERVISOR_RUNTIME_DIGEST", spec.runtimeDigest]);
  if (spec.storageBackend !== undefined) values.push(["LCM_SUPERVISOR_STORAGE_BACKEND", spec.storageBackend]);
  if (spec.credentialDirectory !== undefined) values.push(["LCM_CREDENTIAL_DIRECTORY", spec.credentialDirectory]);
  if (spec.credentialFiles !== undefined && spec.credentialFiles.length > 0) {
    values.push(["LCM_SYSTEMD_CRED_IDS", spec.credentialFiles.map(({ name }) => name).join(",")]);
  }
  for (const credential of spec.credentialFiles ?? []) {
    values.push([`LCM_CREDENTIAL_${credential.name}_FILE`, credential.path]);
  }
  return `<dict>${values.map(([key, value]) => `<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`).join("")}</dict>`;
}

function plistDocument(spec: SupervisorSpec): string {
  // KeepAlive is deliberately absent: terminal idle exit is recreated by the
  // next explicit ensure, not by an independent manager restart policy.
  const workingDirectory = spec.cwd === undefined ? "" : `<key>WorkingDirectory</key><string>${xmlEscape(spec.cwd)}</string>`;
  return [
    XML_HEADER,
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\"><dict>",
    `<key>Label</key><string>${xmlEscape(spec.launchdLabel)}</string>`,
    `<key>ProgramArguments</key>${plistArray([spec.executable, ...spec.args])}`,
    `<key>EnvironmentVariables</key>${plistEnvironment(spec)}`,
    `<key>RunAtLoad</key><true/>`,
    workingDirectory,
    "</dict></plist>\n",
  ].join("");
}

function writePrivatePlist(spec: SupervisorSpec): string {
  const path = plistPath(spec);
  if (existsSync(path)) {
    const stats = lstatSync(path);
    if (
      stats.isSymbolicLink()
      || !stats.isFile()
      || stats.nlink !== 1
      || stats.size > MAX_PLIST_BYTES
      || (stats.mode & 0o777) !== 0o600
    ) {
      throw new Error("supervisor plist collision");
    }
    const existing = readFileSync(path, "utf8");
    if (existing !== plistDocument(spec)) throw new Error("supervisor plist collision");
    return path;
  }
  const document = plistDocument(spec);
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    chmodSync(path, 0o600);
    const bytes = Buffer.from(document, "utf8");
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
  } catch {
    if (created) {
      try {
        unlinkSync(path);
      } catch {
        // Preserve any partial evidence when deletion is unavailable.
      }
    }
    throw new Error("supervisor plist cannot be created");
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best effort descriptor cleanup.
      }
    }
  }
  return path;
}

function cleanupPrivatePlist(spec: SupervisorSpec): void {
  const path = plistPath(spec);
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o777) !== 0o600) return;
    unlinkSync(path);
  } catch {
    // Idempotent cleanup: an absent plist is already clean.
  }
}

function credentialsAreSafe(spec: SupervisorSpec): boolean {
  if (spec.credentialDirectory === undefined) return spec.credentialFiles === undefined || spec.credentialFiles.length === 0;
  try {
    validateManagedCredentialDirectory(spec.credentialDirectory, spec.stateRoot);
    for (const credential of spec.credentialFiles ?? []) {
      if (managedCredentialPath(spec.credentialDirectory, credential.name) !== resolve(credential.path)) return false;
      const stats = lstatSync(credential.path);
      if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o777) !== 0o600) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function safeCredentialCleanup(spec: SupervisorSpec): void {
  if (spec.credentialDirectory === undefined) return;
  try {
    cleanupManagedCredentialDirectory(spec.credentialDirectory, spec.stateRoot);
  } catch {
    // A credential validation failure is preserved by the caller's manager
    // observation; cleanup never broadens its deletion scope.
  }
}

function systemdProbeArgs(spec: SupervisorSpec): readonly string[] {
  return [
    "--user",
    "show",
    "--no-pager",
    `--property=LoadState,ActiveState,SubState,MainPID,Environment,ExecMainStartTimestamp,FragmentPath`,
    spec.systemdUnit,
  ];
}

function launchdProbeArgs(spec: SupervisorSpec, uid: number): readonly string[] {
  return ["print", `${launchdDomain(uid)}/${spec.launchdLabel}`];
}

function managerPlatform(kind: SupervisorKind): NodeJS.Platform {
  return kind === "systemd-user" ? "linux" : "darwin";
}

function validMetadata(spec: SupervisorSpec, values: Map<string, string>): boolean {
  const base = observationBase(spec, values);
  return base.marker === spec.marker
    && base.scopeDigest === spec.scopeDigest
    && base.port === spec.port
    && base.nonce === spec.nonce;
}

function managerPidFrom(values: Map<string, string>): number | undefined {
  return parsePid(lookup(values, "MainPID", "pid", "PID", "process.pid", "ProcessID"));
}

function isLikelyAbsent(result: {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): boolean {
  return isNotFoundOutput(`${result.stdout}\n${result.stderr}`);
}

function createObservationRunner(
  kind: SupervisorKind,
  dependencies: SupervisorDependencies,
): {
  readonly invoke: (command: string, args: readonly string[], timeoutMs?: number) => Promise<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
  }>;
  readonly uid: number;
} {
  const commandTimeoutMs = dependencies.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const uid = dependencies.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const invoke = async (
    command: string,
    args: readonly string[],
    timeoutMs = commandTimeoutMs,
  ) => {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      return Object.freeze({ code: null, stdout: "", stderr: "", timedOut: true });
    }
    if (dependencies.platform !== undefined && dependencies.platform !== managerPlatform(kind)) {
      return Object.freeze({ code: 127, stdout: "", stderr: "", timedOut: false });
    }
    // The injected runner owns the child-process deadline and must settle
    // before returning. Avoid racing a still-live mutation against a local
    // timer: a late systemd/launchd command could otherwise create or stop a
    // service after the caller has already entered cleanup.
    try {
      return commandResult(await Promise.resolve(dependencies.run(command, args, { timeoutMs })));
    } catch {
      return Object.freeze({ code: null, stdout: "", stderr: "", timedOut: false });
    }
  };
  return { invoke, uid };
}

/** Construct a pure TypeScript user-service supervisor for one manager kind. */
export function createSupervisor(
  kind: SupervisorKind,
  dependencies: SupervisorDependencies,
): Supervisor {
  if (kind !== "systemd-user" && kind !== "launchd-user") throw new Error("supervisor kind is invalid");
  if (typeof dependencies.run !== "function") throw new Error("supervisor command runner is required");
  const runner = createObservationRunner(kind, dependencies);

  const probe = async (spec: SupervisorSpec): Promise<SupervisorObservation> => {
    if (spec.kind !== kind) return Object.freeze({ kind: "ambiguous", reason: "metadata-mismatch", name: spec.name });
    if (dependencies.platform === undefined && hostPlatform() !== managerPlatform(kind)) {
      return Object.freeze({ kind: "unavailable", reason: "unsupported-platform", name: spec.name });
    }
    if (kind === "launchd-user" && runner.uid < 0) {
      return Object.freeze({ kind: "unavailable", reason: "manager-unavailable", name: spec.name });
    }
    const result = kind === "systemd-user"
      ? await runner.invoke("systemctl", systemdProbeArgs(spec))
      : await runner.invoke("launchctl", launchdProbeArgs(spec, runner.uid));
    if (result.timedOut) return Object.freeze({ kind: "unavailable", reason: "manager-timeout", name: spec.name });
    const parsed = parseManagerOutput(`${result.stdout}\n${result.stderr}`);
    if (result.code !== 0 && isLikelyAbsent(result)) return Object.freeze({ kind: "absent", name: spec.name });
    if (result.code !== 0 && parsed.size === 0) {
      return Object.freeze({ kind: "unavailable", reason: unavailableReason(result), name: spec.name });
    }
    if (parsed.size === 0) return Object.freeze({ kind: "ambiguous", reason: "metadata-malformed", name: spec.name });
    // systemd explicitly reports LoadState=not-found; launchctl does not need a
    // second command because print's not-found response is stable and bounded.
    const loadState = lookup(parsed, "LoadState", "loadState");
    if (loadState !== undefined && /^(not-found|notloaded)$/iu.test(loadState)) {
      return Object.freeze({ kind: "absent", name: spec.name });
    }
    if (!validMetadata(spec, parsed)) return classifyRegistered(spec, parsed, result.code);
    const classified = classifyRegistered(spec, parsed, result.code);
    if (classified.kind === "registered-running-valid") {
      return Object.freeze({ ...classified, managerPid: managerPidFrom(parsed)! });
    }
    return classified;
  };

  const start = async (spec: SupervisorSpec): Promise<SupervisorStartResult> => {
    const current = await probe(spec);
    if (current.kind === "unavailable") throw managerUnavailableError(current.reason);
    if (current.kind === "registered-running-valid") {
      return Object.freeze({
        kind,
        name: spec.name,
        scopeDigest: spec.scopeDigest,
        port: spec.port,
        nonce: spec.nonce,
        managerPid: current.managerPid,
      });
    }
    if (current.kind === "registered-not-running-valid") {
      // A terminal manager registration is retained intentionally (there is no
      // --collect/KeepAlive policy). Recreate it only after an exact manager
      // stop and an observed absent state; never race systemd-run/bootstrap
      // against the old terminal unit.
      await stopAndAwaitAbsent(spec);
      return start(spec);
    }
    if (current.kind === "registered-stale-config" || current.kind === "registered-invalid-collision" || current.kind === "ambiguous") {
      throw commandFailedError();
    }
    if (!credentialsAreSafe(spec)) {
      throw new Error("supervisor credential validation failed");
    }
    let launchPath: string | undefined;
    try {
      if (kind === "launchd-user") launchPath = writePrivatePlist(spec);
      const args = kind === "systemd-user"
        ? systemdStartArgs(spec)
        : ["bootstrap", launchdDomain(runner.uid), launchPath!];
      const result = await runner.invoke(kind === "systemd-user" ? "systemd-run" : "launchctl", args);
      const after = await probe(spec);
      if (after.kind === "registered-running-valid") {
        return Object.freeze({ kind, name: spec.name, scopeDigest: spec.scopeDigest, port: spec.port, nonce: spec.nonce, managerPid: after.managerPid });
      }
      if (after.kind === "registered-not-running-valid") {
        // A successful manager mutation that exited immediately is not an
        // authenticated running daemon; preserve exact evidence for caller.
        throw commandFailedError();
      }
      if (result.timedOut || after.kind === "unavailable") throw commandFailedError();
      throw commandFailedError();
    } catch (error) {
      // Never clean a concurrent winner. Only remove this nonce's private
      // launch files when the manager proves that the exact spec is absent.
      try {
        const after = await probe(spec);
        if (after.kind === "absent") {
          if (kind === "launchd-user") cleanupPrivatePlist(spec);
          safeCredentialCleanup(spec);
        }
      } catch {
        // Preserve unresolved manager evidence.
      }
      throw commandFailedError();
    }
  };

  const stopAndAwaitAbsentInternal = async (spec: SupervisorSpec, allowStaleConfig = false): Promise<void> => {
    const current = await probe(spec);
    if (current.kind === "absent") {
      if (kind === "launchd-user") cleanupPrivatePlist(spec);
      safeCredentialCleanup(spec);
      return;
    }
    if (current.kind === "unavailable") throw managerUnavailableError(current.reason);
    if (
      current.kind === "registered-invalid-collision"
      || current.kind === "ambiguous"
      || (current.kind === "registered-stale-config" && !allowStaleConfig)
    ) throw commandFailedError();
    const stopArgs = kind === "systemd-user"
      ? ["--user", "stop", spec.systemdUnit]
      : ["bootout", `${launchdDomain(runner.uid)}/${spec.launchdLabel}`];
    const result = await runner.invoke(kind === "systemd-user" ? "systemctl" : "launchctl", stopArgs, spec.stopTimeoutMs);
    if (result.timedOut) throw commandFailedError();
    if (
      kind === "systemd-user"
      && current.kind === "registered-not-running-valid"
      && current.terminal === "failed"
      && result.code === 0
    ) {
      const resetFailed = await runner.invoke("systemctl", ["--user", "reset-failed", spec.systemdUnit], spec.stopTimeoutMs);
      if (resetFailed.timedOut || resetFailed.code !== 0) throw commandFailedError();
    }
    const maxPollIntervals = Math.max(1, Math.ceil(spec.stopTimeoutMs / DEFAULT_POLL_INTERVAL_MS));
    for (let attempt = 0; attempt < Math.min(MAX_POLL_INTERVALS, maxPollIntervals); attempt += 1) {
      const observed = await probe(spec);
      if (observed.kind === "absent") {
        if (kind === "launchd-user") cleanupPrivatePlist(spec);
        safeCredentialCleanup(spec);
        return;
      }
      if (observed.kind === "unavailable") throw managerUnavailableError(observed.reason);
      if (observed.kind === "registered-invalid-collision" || observed.kind === "ambiguous") throw commandFailedError();
      if (result.code !== 0 && attempt === 0) throw commandFailedError();
      if (dependencies.sleep !== undefined) await dependencies.sleep(DEFAULT_POLL_INTERVAL_MS);
      else await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, DEFAULT_POLL_INTERVAL_MS));
    }
    throw commandFailedError();
  };

  const stopAndAwaitAbsent = async (spec: SupervisorSpec): Promise<void> => stopAndAwaitAbsentInternal(spec);

  const stopAndStart = async (spec: SupervisorSpec): Promise<SupervisorStartResult> => {
    if (!credentialsAreSafe(spec)) throw new Error("supervisor credential validation failed");
    const observed = await probe(spec);
    if (observed.kind === "unavailable") throw managerUnavailableError(observed.reason);
    if (observed.kind === "registered-invalid-collision" || observed.kind === "ambiguous") throw commandFailedError();
    if (observed.kind === "registered-stale-config") await stopAndAwaitAbsentInternal(spec, true);
    else if (observed.kind !== "absent") await stopAndAwaitAbsent(spec);
    return start(spec);
  };

  return Object.freeze({ probe, start, stopAndStart, stopAndAwaitAbsent });
}

function metadataEnvironmentArgs(spec: SupervisorSpec): string[] {
  const values = [
    ["LCM_SUPERVISOR_MARKER", spec.marker],
    ["LCM_SUPERVISOR_SCOPE", spec.scopeDigest],
    ["LCM_SUPERVISOR_STATE_ROOT", spec.stateRoot],
    ["LCM_SUPERVISOR_PORT", String(spec.port)],
    ["LCM_SUPERVISOR_NONCE", spec.nonce],
    ["LCM_SUPERVISOR_EXECUTABLE", spec.executable],
    ["LCM_SUPERVISOR_ARGS", JSON.stringify(spec.args)],
    ["LCM_SUPERVISOR_CWD", spec.cwd ?? ""],
  ];
  if (spec.entrypoint !== undefined) values.push(["LCM_SUPERVISOR_ENTRYPOINT", spec.entrypoint]);
  if (spec.runtimeDigest !== undefined) values.push(["LCM_SUPERVISOR_RUNTIME_DIGEST", spec.runtimeDigest]);
  if (spec.storageBackend !== undefined) values.push(["LCM_SUPERVISOR_STORAGE_BACKEND", spec.storageBackend]);
  if (spec.credentialFiles !== undefined && spec.credentialFiles.length > 0) {
    values.push(["LCM_SYSTEMD_CRED_IDS", spec.credentialFiles.map(({ name }) => name).join(",")]);
  }
  return values.map(([key, value]) => `--setenv=${key}=${value}`);
}

function systemdStartArgs(spec: SupervisorSpec): readonly string[] {
  const loadCredentials = (spec.credentialFiles ?? []).map((credential) => `--property=LoadCredential=${credential.name}:${credential.path}`);
  return [
    "--user",
    "--unit",
    spec.systemdUnit,
    "--property=KillMode=control-group",
    `--property=TimeoutStopSec=${spec.stopTimeoutMs}ms`,
    ...loadCredentials,
    ...metadataEnvironmentArgs(spec),
    ...(spec.cwd === undefined ? [] : [`--working-directory=${spec.cwd}`]),
    spec.executable,
    ...spec.args,
  ];
}
