import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { platform as hostPlatform } from "node:os";
import { readBoundedRegularFileWithStat } from "../security-files.js";
import {
  cleanupManagedCredentialDirectory,
  managedCredentialPath,
  MANAGED_CREDENTIAL_NAMES,
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

/**
 * Return whether a read-only manager preflight proved that compatibility
 * detached launch is safe.  A timeout, command failure, or any identity/state
 * concern is deliberately not a compatibility signal: those observations
 * mean that a manager was selected but its authority is unresolved.
 */
export function isSupervisorPreflightUnavailableReason(reason: SupervisorReason): boolean {
  switch (reason) {
    case "manager-unavailable":
    case "manager-not-found":
      return true;
    case "unsupported-platform":
    case "manager-timeout":
    case "manager-command-failed":
    case "metadata-missing":
    case "metadata-mismatch":
    case "foreign-job":
    case "pid-missing":
    case "pid-invalid":
    case "state-conflict":
    case "credential-invalid":
    case "cleanup-failed":
      return false;
  }
  return false;
}

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
  credentialDirectory?: string;
  credentialFiles?: readonly CredentialFileReference[];
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
  /** @internal Deterministic launchd plist race seam for coverage tests. */
  readonly _plistRaceForTesting?: (
    path: string,
    phase: "before-open" | "after-read" | "before-unlink",
  ) => void;
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
/**
 * Bound path-shaped manager metadata by bytes, not JavaScript code units.  The
 * service-manager metadata is not a filesystem API, but keeping this aligned
 * with a conservative platform path budget prevents a manager response from
 * becoming an unbounded path carrier while still admitting long valid paths.
 */
const MAX_PATH_METADATA_BYTES = 4 * 1024;
const MAX_COMMAND_OUTPUT_LENGTH = 64 * 1024;
const MAX_PLIST_BYTES = 64 * 1024;
const MAX_ARGUMENT_COUNT = 128;
const MAX_ARGUMENT_BYTES = 64 * 1024;
/**
 * JSON.stringify may expand each allowed argument code unit to a six-character
 * escape (for example, a control character).  This is deliberately a bound on
 * the serialized metadata, separate from the raw argument-byte budget enforced
 * by createSupervisorSpec.  Array brackets, commas, and string delimiters add
 * three characters per argument plus one final delimiter.
 */
const MAX_ARGUMENT_JSON_BYTES = MAX_ARGUMENT_BYTES * 6 + MAX_ARGUMENT_COUNT * 3 + 1;
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

function assertRuntimeDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("supervisor runtime digest is invalid");
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

function assertPathMetadataValue(value: string, label: string): void {
  if (
    value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_PATH_METADATA_BYTES
    || /[\u0000\r\n]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function validSupervisorArguments(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ARGUMENT_COUNT) return false;
  let bytes = 0;
  for (const argument of value) {
    if (
      typeof argument !== "string"
      || argument.length > MAX_METADATA_VALUE_LENGTH
      || /[\u0000\r\n]/u.test(argument)
    ) return false;
    bytes += Buffer.byteLength(argument, "utf8");
    if (bytes > MAX_ARGUMENT_BYTES) return false;
  }
  return true;
}

function assertSupervisorArguments(value: readonly unknown[]): asserts value is readonly string[] {
  if (!validSupervisorArguments(value)) throw new Error("supervisor argument is invalid");
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
  assertPathMetadataValue(canonical, "supervisor state root");
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
  assertPathMetadataValue(executable, "supervisor executable");
  const args = [...(input.args ?? input.argv ?? [])];
  assertSupervisorArguments(args);
  if (input.cwd !== undefined) {
    if (!isAbsolute(input.cwd)) throw new Error("supervisor working directory is invalid");
    assertPathMetadataValue(input.cwd, "supervisor working directory");
    assertPathMetadataValue(resolve(input.cwd), "supervisor working directory");
  }
  if (input.entrypoint !== undefined) assertPathMetadataValue(input.entrypoint, "supervisor metadata");
  if (input.runtimeDigest !== undefined) assertRuntimeDigest(input.runtimeDigest);
  if (input.storageBackend !== undefined) assertMetadataValue(input.storageBackend, "supervisor metadata");
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
      assertPathMetadataValue(credential.path, "supervisor credential path");
      const resolvedPath = resolve(credential.path);
      assertPathMetadataValue(resolvedPath, "supervisor credential path");
      return Object.freeze({ name: credential.name, path: resolvedPath });
    }));
  const stopTimeoutMs = input.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  if (!Number.isInteger(stopTimeoutMs) || stopTimeoutMs < 1 || stopTimeoutMs > 60_000) {
    throw new Error("supervisor stop timeout is invalid");
  }
  const credentialDirectory = input.credentialDirectory === undefined
    ? undefined
    : (() => {
      assertPathMetadataValue(input.credentialDirectory!, "supervisor credential directory");
      const resolved = resolve(input.credentialDirectory!);
      assertPathMetadataValue(resolved, "supervisor credential directory");
      return resolved;
    })();
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
    ...(credentialDirectory === undefined ? {} : { credentialDirectory }),
  };
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
  if (result.code === 127 || /enoent|command not found|systemctl not found|launchctl not found|no such file/u.test(text)) {
    return "manager-not-found";
  }
  if (/failed to connect|connection refused|not running|no session|no user manager|no medium/u.test(text)) {
    return "manager-unavailable";
  }
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
    const match = /^\s*([A-Za-z][A-Za-z0-9_.-]*(?:\s+[A-Za-z][A-Za-z0-9_.-]*){0,3})\s*(?:=>|=|:)\s*(.*?)\s*$/u.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = parseScalar(match[2]);
    // systemd serializes all assignments into one Environment= line.  It can
    // legitimately exceed the per-field metadata cap once credential paths
    // and launch arguments are included; the assignment parser below applies
    // the tighter bound to each decoded value.
    const maxValueLength = /^environment$/iu.test(key) || /^env$/iu.test(key)
      ? MAX_COMMAND_OUTPUT_LENGTH
      : environmentAssignmentValueLimit(key);
    if (Buffer.byteLength(value, "utf8") <= maxValueLength) values.set(key, value);
  }
  return values;
}

function environmentAssignmentValueLimit(key: string): number {
  const upper = key.toUpperCase();
  if (upper === "LCM_SUPERVISOR_ARGS") return MAX_ARGUMENT_JSON_BYTES;
  if (
    upper === "LCM_SUPERVISOR_STATE_ROOT"
    || upper === "LCM_SUPERVISOR_EXECUTABLE"
    || upper === "LCM_SUPERVISOR_CWD"
    || upper === "LCM_SUPERVISOR_ENTRYPOINT"
    || upper === "LCM_CREDENTIAL_DIRECTORY"
    || /^LCM_CREDENTIAL_[A-Z0-9_]+_FILE$/u.test(upper)
  ) return MAX_PATH_METADATA_BYTES;
  if (upper === "LCM_SUPERVISOR_MARKER") return MARKER.length;
  if (upper === "LCM_SUPERVISOR_SCOPE" || upper === "LCM_SUPERVISOR_RUNTIME_DIGEST") return SHA256_HEX_LENGTH;
  if (upper === "LCM_SUPERVISOR_PORT") return 5;
  if (upper === "LCM_SUPERVISOR_NONCE") return MAX_NONCE_LENGTH;
  return MAX_METADATA_VALUE_LENGTH;
}

function isWithinEnvironmentAssignmentLimit(value: string, limit: number): boolean {
  return Buffer.byteLength(value, "utf8") <= limit;
}

/** Parse systemd's bounded shell-like Environment= serialization. */
function parseEnvironmentAssignments(value: string): Map<string, string> | undefined {
  const assignments = new Map<string, string>();
  let index = 0;
  let count = 0;
  const maxTokenBytes = MAX_ARGUMENT_JSON_BYTES + MAX_PATH_METADATA_BYTES;
  const decodeEscape = (): string | undefined => {
    if (index >= value.length) return undefined;
    const escaped = value[index]!;
    index += 1;
    if (escaped === "x") {
      const hex = value.slice(index, index + 2);
      if (!/^[0-9A-Fa-f]{2}$/u.test(hex)) return undefined;
      index += 2;
      return String.fromCharCode(Number.parseInt(hex, 16));
    }
    switch (escaped) {
      case "a": return "\u0007";
      case "b": return "\b";
      case "e": return "\u001b";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "s": return " ";
      case "t": return "\t";
      case "v": return "\u000b";
      default: return escaped;
    }
  };
  const readQuoted = (quote: string): string | undefined => {
    index += 1;
    let decoded = "";
    let decodedBytes = 0;
    while (index < value.length) {
      const character = value[index]!;
      if (character === "\\") {
        index += 1;
        const escaped = decodeEscape();
        if (escaped === undefined) return undefined;
        decoded += escaped;
        decodedBytes += Buffer.byteLength(escaped, "utf8");
        if (decodedBytes > maxTokenBytes) return undefined;
        continue;
      }
      if (character === quote) {
        index += 1;
        return decoded;
      }
      decoded += character;
      index += 1;
      decodedBytes += Buffer.byteLength(character, "utf8");
      if (decodedBytes > maxTokenBytes) return undefined;
    }
    return undefined;
  };
  const addAssignment = (token: string): boolean => {
    const separator = token.indexOf("=");
    if (separator <= 0) return false;
    const key = token.slice(0, separator);
    const decoded = token.slice(separator + 1);
    const limit = environmentAssignmentValueLimit(key);
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(key)
      || !isWithinEnvironmentAssignmentLimit(decoded, limit)
      || assignments.has(key)) return false;
    assignments.set(key, decoded);
    return true;
  };
  while (index < value.length) {
    while (index < value.length && /\s/u.test(value[index]!)) index += 1;
    if (index >= value.length) break;
    // systemd may quote the complete assignment token when the value contains
    // spaces or shell-significant characters. Decode that token first, then
    // apply the same strict key/value and duplicate bounds as unquoted forms.
    if (value[index] === "\"" || value[index] === "'") {
      const token = readQuoted(value[index]!);
      if (token === undefined || (index < value.length && !/\s/u.test(value[index]!))) return undefined;
      if (!addAssignment(token)) return undefined;
      count += 1;
      if (count > MAX_ARGUMENT_COUNT) return undefined;
      continue;
    }
    const keyStart = index;
    if (!/[A-Za-z]/u.test(value[index]!)) return undefined;
    index += 1;
    while (index < value.length && /[A-Za-z0-9_.-]/u.test(value[index]!)) index += 1;
    const key = value.slice(keyStart, index);
    if (value[index] !== "=") return undefined;
    index += 1;
    let decoded = "";
    let decodedBytes = 0;
    const quote = value[index] === "\"" || value[index] === "'" ? value[index] : undefined;
    if (quote !== undefined) index += 1;
    let closedQuote = quote === undefined;
    while (index < value.length) {
      const character = value[index]!;
      if (character === "\\") {
        index += 1;
        const escaped = decodeEscape();
        if (escaped === undefined) return undefined;
        decoded += escaped;
        decodedBytes += Buffer.byteLength(escaped, "utf8");
        if (decodedBytes > maxTokenBytes) return undefined;
        continue;
      }
      if (quote !== undefined && character === quote) {
        index += 1;
        closedQuote = true;
        break;
      }
      if (quote === undefined && /\s/u.test(character)) break;
      decoded += character;
      index += 1;
      decodedBytes += Buffer.byteLength(character, "utf8");
      if (decodedBytes > maxTokenBytes) return undefined;
    }
    if (!closedQuote || assignments.has(key)) return undefined;
    if (quote !== undefined && index < value.length && !/\s/u.test(value[index]!)) return undefined;
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(key)) return undefined;
    const limit = environmentAssignmentValueLimit(key);
    if (!isWithinEnvironmentAssignmentLimit(decoded, limit)) return undefined;
    assignments.set(key, decoded);
    count += 1;
    if (count > MAX_ARGUMENT_COUNT) return undefined;
  }
  return assignments;
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
  const direct = lookup(values, name, ...(aliases[name] ?? []), `environment.${name}`, `environment[${name}]`, `env.${name}`);
  if (direct !== undefined) return direct;
  for (const [key, value] of values) {
    // systemd's Environment= field is a space-separated list of assignments;
    // launchctl print uses `KEY => VALUE` entries under environment = { ... }.
    if (key.toLowerCase() === "environment" || key.toLowerCase() === "env") {
      const assignments = parseEnvironmentAssignments(value);
      const assignment = assignments?.get(name);
      if (assignment !== undefined) return assignment;
    }
  }
  return undefined;
}

function validSerializedSupervisorArguments(value: string | undefined): boolean {
  if (value === undefined || Buffer.byteLength(value, "utf8") > MAX_ARGUMENT_JSON_BYTES) return false;
  try {
    return validSupervisorArguments(JSON.parse(value));
  } catch {
    return false;
  }
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

function isNotFoundOutput(
  kind: SupervisorKind,
  code: number | null,
  text: string,
): boolean {
  const lower = text.toLowerCase();
  if (/(?:systemctl|launchctl)\s+(?:command )?not found|enoent/u.test(lower)) return false;
  if (kind === "launchd-user") {
    // launchctl uses EX_NOINPUT (36) for a missing job on current macOS
    // releases.  Exit 113 is also used by `print`, but only its bounded,
    // service-specific diagnostics establish an absent registration; a bare
    // transport or permission failure must remain unresolved.
    if (code === 36) return true;
    if (code !== 113) return false;
    return /\b(?:no such process|could not find\b[^\r\n]{0,256}\bservice\b|service\b[^\r\n]{0,256}\b(?:not found|does not exist)\b)/u.test(lower);
  }
  return /unit\b[^\r\n]{0,256}\b(?:not[- ]found|not loaded)\b|could not (?:find|be found)|(?:unknown|no such|does not exist) service\b|service\b[^\r\n]{0,256}\b(?:not found|does not exist)\b/u.test(lower);
}

function isRunningState(value: string | undefined): boolean {
  return value !== undefined && /^(active|running|started|launching)$/iu.test(value);
}

function isTerminalState(value: string | undefined): "inactive" | "failed" | "last-exit" | undefined {
  if (value === undefined) return undefined;
  if (/^(inactive|stopped|dead|exited|not[ -]running)$/iu.test(value)) return "inactive";
  if (/^(failed|crashed)$/iu.test(value)) return "failed";
  if (/^(last-exit|terminated|exit)$/iu.test(value)) return "last-exit";
  return undefined;
}

function isLaunchdTerminalExitCode(value: string | undefined): boolean {
  // launchctl print reports the terminal bootstrap state as an exit code of
  // 36 on supported macOS releases, sometimes without a separate state line.
  return value !== undefined && /^36$/u.test(value.trim());
}

function observationBase(spec: SupervisorSpec, values: Map<string, string>): SupervisorObservationBase {
  const scopeDigest = metadata(values, "LCM_SUPERVISOR_SCOPE");
  const marker = metadata(values, "LCM_SUPERVISOR_MARKER");
  const stateRoot = metadata(values, "LCM_SUPERVISOR_STATE_ROOT");
  const port = parsePort(metadata(values, "LCM_SUPERVISOR_PORT"));
  const nonce = metadata(values, "LCM_SUPERVISOR_NONCE");
  const executable = metadata(values, "LCM_SUPERVISOR_EXECUTABLE");
  const serializedArgs = metadata(values, "LCM_SUPERVISOR_ARGS");
  const args = validSerializedSupervisorArguments(serializedArgs) ? serializedArgs : undefined;
  const cwd = metadata(values, "LCM_SUPERVISOR_CWD");
  const entrypoint = metadata(values, "LCM_SUPERVISOR_ENTRYPOINT");
  const runtimeDigest = metadata(values, "LCM_SUPERVISOR_RUNTIME_DIGEST");
  const storageBackend = metadata(values, "LCM_SUPERVISOR_STORAGE_BACKEND");
  const credentialDirectory = metadata(values, "LCM_CREDENTIAL_DIRECTORY");
  const credentialFiles = MANAGED_CREDENTIAL_NAMES.flatMap((name) => {
    const path = metadata(values, `LCM_CREDENTIAL_${name}_FILE`);
    return path === undefined ? [] : [{ name, path }];
  });
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
    ...(credentialDirectory === undefined ? {} : { credentialDirectory }),
    ...(credentialFiles.length === 0 ? {} : { credentialFiles: Object.freeze(credentialFiles) }),
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
  const activeState = lookup(values, "ActiveState", "state", "State", "status");
  const subState = lookup(values, "SubState", "subState", "substate");
  const active = isRunningState(activeState);
  const activeStateTerminal = isTerminalState(activeState);
  const subStateTerminal = isTerminalState(subState);
  if (
    (active && subState !== undefined && !isRunningState(subState))
    || (activeStateTerminal !== undefined && subState !== undefined && subStateTerminal === undefined)
    || (subStateTerminal !== undefined && isRunningState(activeState))
  ) {
    return Object.freeze({ kind: "ambiguous", reason: "state-conflict", ...base });
  }
  const terminal = activeStateTerminal
    ?? subStateTerminal
    ?? (spec.kind === "launchd-user" && isLaunchdTerminalExitCode(lookup(values, "last exit code", "lastExitCode", "exit code", "ExitCode"))
      ? "last-exit"
      : undefined);
  const pidValue = lookup(values, "MainPID", "pid", "PID", "process.pid", "ProcessID");
  if (active) {
    const managerPid = parsePid(pidValue);
    if (managerPid === undefined) return Object.freeze({ kind: "ambiguous", reason: "pid-missing", ...base });
    if (commandCode !== null && commandCode !== 0) return Object.freeze({ kind: "ambiguous", reason: "state-conflict", ...base });
    return Object.freeze({ kind: "registered-running-valid", managerPid, ...base });
  }
  if (terminal !== undefined) {
    if (pidValue !== undefined && pidValue !== "0") {
      if (parsePid(pidValue) !== undefined) {
        return Object.freeze({ kind: "ambiguous", reason: "state-conflict", ...base });
      }
      return Object.freeze({ kind: "ambiguous", reason: "pid-invalid", ...base });
    }
    if (commandCode !== null && commandCode !== 0 && !isNotFoundOutput(spec.kind, commandCode, JSON.stringify([...values]))) {
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

type PrivatePlistRead = ReturnType<typeof readBoundedRegularFileWithStat>;
type PlistRacePhase = "before-open" | "after-read" | "before-unlink";
type PlistRaceFault = (path: string, phase: PlistRacePhase) => void;

function readPrivatePlist(
  path: string,
  spec: SupervisorSpec,
  expectedUid?: number,
  plistRaceFault?: PlistRaceFault,
): PrivatePlistRead {
  return readBoundedRegularFileWithStat(path, {
    allowedRoot: spec.stateRoot,
    maxBytes: MAX_PLIST_BYTES,
    expectedUid,
    allowedModes: [0o600],
    requireSingleLink: true,
    _beforeOpenForTesting: plistRaceFault === undefined
      ? undefined
      : () => plistRaceFault(path, "before-open"),
    _beforePostStatForTesting: plistRaceFault === undefined
      ? undefined
      : () => plistRaceFault(path, "after-read"),
  });
}

function assertPrivatePlistLeafIdentity(
  path: string,
  descriptor: PrivatePlistRead,
  expectedUid?: number,
  plistRaceFault?: PlistRaceFault,
): void {
  plistRaceFault?.(path, "before-unlink");
  const stats = lstatSync(path);
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || stats.nlink !== 1
    || (expectedUid !== undefined && stats.uid !== expectedUid)
    || (stats.mode & 0o777) !== 0o600
    || stats.dev !== descriptor.dev
    || stats.ino !== descriptor.ino
    || stats.mtimeMs !== descriptor.mtimeMs
  ) throw new Error("supervisor plist collision");
}

function writePrivatePlist(spec: SupervisorSpec, plistRaceFault?: PlistRaceFault): string {
  const path = plistPath(spec);
  if (existsSync(path)) {
    let descriptor: PrivatePlistRead;
    try {
      descriptor = readPrivatePlist(path, spec, undefined, plistRaceFault);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      if ((error as NodeJS.ErrnoException).code !== undefined && (error as NodeJS.ErrnoException).code !== "ELOOP") {
        throw error;
      }
      throw new Error("supervisor plist collision");
    }
    if (descriptor.content !== plistDocument(spec)) throw new Error("supervisor plist collision");
    // The descriptor-bound read cannot make a future pathname consumer
    // atomic. Recheck the leaf before handing the exact plist to launchctl.
    assertPrivatePlistLeafIdentity(path, descriptor, undefined, plistRaceFault);
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

function cleanupPrivatePlist(spec: SupervisorSpec, plistRaceFault?: PlistRaceFault): void {
  const path = plistPath(spec);
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    let descriptor: PrivatePlistRead;
    try {
      descriptor = readPrivatePlist(path, spec, uid, plistRaceFault);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if ((error as NodeJS.ErrnoException).code !== undefined && (error as NodeJS.ErrnoException).code !== "ELOOP") {
        throw error;
      }
      throw new Error("supervisor plist collision");
    }
    if (descriptor.content !== plistDocument(spec)) throw new Error("supervisor plist collision");
    assertPrivatePlistLeafIdentity(path, descriptor, uid, plistRaceFault);
    unlinkSync(path);
  } catch (error) {
    // Idempotent cleanup: an absent plist is already clean. Any present but
    // changed, linked, or otherwise unsafe file is preserved as evidence.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function plistSpecFromObservation(
  spec: SupervisorSpec,
  observation: SupervisorObservation,
): SupervisorSpec | undefined {
  if (
    observation.kind !== "registered-stale-config"
    || observation.scopeDigest !== spec.scopeDigest
    || observation.name !== spec.name
    || observation.nonce === undefined
    || observation.port === undefined
    || observation.executable === undefined
    || observation.args === undefined
  ) return undefined;
  let args: readonly string[];
  try {
    const parsed: unknown = JSON.parse(observation.args);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) return undefined;
    args = Object.freeze([...parsed]);
  } catch {
    return undefined;
  }
  try {
    assertNonce(observation.nonce);
    const candidate: SupervisorSpec = {
      ...spec,
      nonce: observation.nonce,
      port: observation.port,
      executable: observation.executable,
      args,
      ...(observation.cwd === undefined || observation.cwd === "" ? { cwd: undefined } : { cwd: observation.cwd }),
      ...(observation.entrypoint === undefined ? { entrypoint: undefined } : { entrypoint: observation.entrypoint }),
      ...(observation.runtimeDigest === undefined ? { runtimeDigest: undefined } : { runtimeDigest: observation.runtimeDigest }),
      ...(observation.storageBackend === undefined ? { storageBackend: undefined } : { storageBackend: observation.storageBackend }),
      ...(observation.credentialDirectory === undefined ? {} : { credentialDirectory: observation.credentialDirectory }),
      ...(observation.credentialFiles === undefined ? {} : { credentialFiles: observation.credentialFiles }),
    };
    if (
      (spec.cwd !== undefined && candidate.cwd === undefined)
      || (spec.entrypoint !== undefined && candidate.entrypoint === undefined)
      || (spec.runtimeDigest !== undefined && candidate.runtimeDigest === undefined)
      || (spec.storageBackend !== undefined && candidate.storageBackend === undefined)
      || (spec.credentialDirectory !== undefined && candidate.credentialDirectory === undefined)
      || (spec.credentialFiles !== undefined && candidate.credentialFiles === undefined)
    ) return undefined;
    return Object.freeze(candidate);
  } catch {
    return undefined;
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

/**
 * Remove credentials authenticated by an earlier manager observation only
 * after the manager has proved that its registration is absent.  The
 * observation is not allowed to broaden cleanup outside the requested scope:
 * the stable scope identity must match and the managed-credential validator
 * re-checks the canonical directory, ownership, modes, link counts, and
 * allow-listed leaves before removing anything.
 */
function safeObservedCredentialCleanup(
  observation: SupervisorObservation | undefined,
  spec: SupervisorSpec,
): void {
  if (
    observation === undefined
    || observation.scopeDigest !== spec.scopeDigest
    || observation.name !== spec.name
    || observation.credentialDirectory === undefined
  ) return;
  if (observation.stateRoot !== undefined && observation.stateRoot !== spec.stateRoot) return;
  try {
    cleanupManagedCredentialDirectory(observation.credentialDirectory, spec.stateRoot);
  } catch {
    // Preserve tampered or otherwise unresolved credential evidence.
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
  readonly kind: SupervisorKind;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): boolean {
  return isNotFoundOutput(result.kind, result.code, `${result.stdout}\n${result.stderr}`);
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
    if (result.code !== 0 && isLikelyAbsent({ kind, ...result })) return Object.freeze({ kind: "absent", name: spec.name });
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

  const start = async (spec: SupervisorSpec, terminalRecreated = false): Promise<SupervisorStartResult> => {
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
      if (terminalRecreated) {
        // A replacement that immediately exits must not recurse indefinitely;
        // preserve the terminal evidence for the caller and bound this API to
        // one manager recreation attempt.
        throw commandFailedError();
      }
      // A terminal manager registration is retained intentionally (there is no
      // --collect/KeepAlive policy). Recreate it only after an exact manager
      // stop and an observed absent state; never race systemd-run/bootstrap
      // against the old terminal unit.
      await stopAndAwaitAbsent(spec);
      return start(spec, true);
    }
    if (current.kind === "registered-stale-config" || current.kind === "registered-invalid-collision" || current.kind === "ambiguous") {
      throw commandFailedError();
    }
    if (!credentialsAreSafe(spec)) {
      throw new Error("supervisor credential validation failed");
    }
    let launchPath: string | undefined;
    try {
      if (kind === "launchd-user") launchPath = writePrivatePlist(spec, dependencies._plistRaceForTesting);
      const args = kind === "systemd-user"
        ? systemdStartArgs(spec)
        : ["bootstrap", launchdDomain(runner.uid), launchPath!];
      const result = await runner.invoke(kind === "systemd-user" ? "systemd-run" : "launchctl", args);
      if (result.timedOut || result.code !== 0) throw commandFailedError();

      // systemd-run --no-block acknowledges the job submission before the
      // transient unit is active.  Poll the exact stable unit for a bounded
      // interval so a legitimate activation race cannot become a spurious
      // startup failure, while terminal/ambiguous observations remain
      // authoritative and fail closed.
      const maxPollIntervals = Math.max(
        1,
        Math.min(
          MAX_POLL_INTERVALS,
          Math.ceil((dependencies.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS) / DEFAULT_POLL_INTERVAL_MS),
        ),
      );
      let after: SupervisorObservation = Object.freeze({ kind: "absent", name: spec.name });
      for (let attempt = 0; attempt < maxPollIntervals; attempt += 1) {
        after = await probe(spec);
        if (after.kind !== "absent") break;
        if (attempt + 1 < maxPollIntervals) {
          if (dependencies.sleep !== undefined) await dependencies.sleep(DEFAULT_POLL_INTERVAL_MS);
          else await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, DEFAULT_POLL_INTERVAL_MS));
        }
      }
      if (after.kind === "registered-running-valid") {
        return Object.freeze({ kind, name: spec.name, scopeDigest: spec.scopeDigest, port: spec.port, nonce: spec.nonce, managerPid: after.managerPid });
      }
      // A successful manager mutation that is still absent, terminal, stale,
      // colliding, unavailable, or ambiguous is not an authenticated running
      // daemon; preserve exact evidence for caller.
      throw commandFailedError();
    } catch (error) {
      // Never clean a concurrent winner. Only remove this nonce's private
      // launch files when the manager proves that the exact spec is absent.
      try {
        const after = await probe(spec);
        if (after.kind === "absent") {
          if (kind === "launchd-user") cleanupPrivatePlist(spec, dependencies._plistRaceForTesting);
          safeCredentialCleanup(spec);
        } else if (
          after.kind === "registered-not-running-valid"
          && after.scopeDigest === spec.scopeDigest
          && after.name === spec.name
          && after.nonce === spec.nonce
        ) {
          // A transient service may acknowledge submission and then exit
          // immediately.  This terminal state is still owned by the exact
          // nonce, so retire it through the manager and prove absence before
          // deleting its one-launch credentials or private launch plist.
          try {
            await stopAndAwaitAbsent(spec);
          } catch {
            // Preserve terminal evidence when stop/absence cannot be proven.
            throw error;
          }
        }
      } catch {
        // Preserve unresolved manager evidence.
      }
      throw commandFailedError();
    }
  };

  const stopAndAwaitAbsentInternal = async (
    spec: SupervisorSpec,
    allowStaleConfig = false,
    staleObservation?: SupervisorObservation,
    cleanupCredentials = true,
  ): Promise<void> => {
    const current = await probe(spec);
    // Keep the first authenticated stale observation as the source of the old
    // launchd nonce.  A registration may disappear between the initial probe
    // and this fresh probe; cleanup still needs to remove that exact old plist
    // after an absent proof, never only the replacement's plist.
    const staleSource = staleObservation?.kind === "registered-stale-config"
      ? staleObservation
      : current.kind === "registered-stale-config" ? current : undefined;
    const stalePlistSpec = allowStaleConfig && staleSource !== undefined
      ? plistSpecFromObservation(spec, staleSource)
      : undefined;
    if (allowStaleConfig && staleSource !== undefined && stalePlistSpec === undefined) {
      throw commandFailedError();
    }
    if (current.kind === "absent") {
      if (kind === "launchd-user") {
        if (stalePlistSpec !== undefined) cleanupPrivatePlist(stalePlistSpec, dependencies._plistRaceForTesting);
        else cleanupPrivatePlist(spec, dependencies._plistRaceForTesting);
      }
      safeObservedCredentialCleanup(staleSource ?? current, spec);
      if (cleanupCredentials) safeCredentialCleanup(spec);
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
    const exactPriorObservation = current.kind === "registered-running-valid"
      || current.kind === "registered-not-running-valid"
      || (
        allowStaleConfig
        && current.kind === "registered-stale-config"
        && current.scopeDigest === spec.scopeDigest
        && current.name === spec.name
      );
    const stopResultIsNotFound = result.code !== 0
      && isNotFoundOutput(kind, result.code, `${result.stdout}\n${result.stderr}`);
    // A manager may race a registration disappearing between the authenticated
    // probe and stop.  Treat that specific not-found result as idempotent only
    // when the exact job was observed first; a permission/transport failure
    // must not become cleanup authority merely because a later probe is absent.
    const stopResultAllowsAbsent = result.code === 0
      || (exactPriorObservation && stopResultIsNotFound);
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
    const now = dependencies.now ?? Date.now;
    const stopDeadline = now() + spec.stopTimeoutMs;
    for (let attempt = 0; attempt < maxPollIntervals; attempt += 1) {
      const observed = await probe(spec);
      if (observed.kind === "absent") {
        if (!stopResultAllowsAbsent) {
          const reason = unavailableReason(result);
          if (reason === "manager-not-found" || reason === "manager-unavailable") {
            throw managerUnavailableError(reason);
          }
          throw commandFailedError();
        }
        if (kind === "launchd-user") {
          if (stalePlistSpec !== undefined) cleanupPrivatePlist(stalePlistSpec, dependencies._plistRaceForTesting);
          else cleanupPrivatePlist(spec, dependencies._plistRaceForTesting);
        }
        safeObservedCredentialCleanup(staleSource ?? current, spec);
        if (cleanupCredentials) safeCredentialCleanup(spec);
        return;
      }
      if (observed.kind === "unavailable") throw managerUnavailableError(observed.reason);
      if (observed.kind === "registered-invalid-collision" || observed.kind === "ambiguous") throw commandFailedError();
      if (result.code !== 0 && attempt === 0) throw commandFailedError();
      const remaining = stopDeadline - now();
      if (remaining <= 0) break;
      const delay = Math.min(DEFAULT_POLL_INTERVAL_MS, remaining);
      if (dependencies.sleep !== undefined) await dependencies.sleep(delay);
      else await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, delay));
    }
    throw commandFailedError();
  };

  const stopAndAwaitAbsent = async (spec: SupervisorSpec): Promise<void> => stopAndAwaitAbsentInternal(spec);

  const stopAndStart = async (spec: SupervisorSpec): Promise<SupervisorStartResult> => {
    if (!credentialsAreSafe(spec)) throw new Error("supervisor credential validation failed");
    const observed = await probe(spec);
    if (observed.kind === "unavailable") throw managerUnavailableError(observed.reason);
    if (observed.kind === "registered-invalid-collision" || observed.kind === "ambiguous") throw commandFailedError();
    if (observed.kind === "registered-stale-config") await stopAndAwaitAbsentInternal(spec, true, observed, false);
    else if (observed.kind !== "absent") await stopAndAwaitAbsentInternal(spec, false, undefined, false);
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
  if (spec.credentialDirectory !== undefined) values.push(["LCM_CREDENTIAL_DIRECTORY", spec.credentialDirectory]);
  if (spec.credentialFiles !== undefined && spec.credentialFiles.length > 0) {
    values.push(["LCM_SYSTEMD_CRED_IDS", spec.credentialFiles.map(({ name }) => name).join(",")]);
  }
  return values.map(([key, value]) => `--setenv=${key}=${value}`);
}

function systemdStartArgs(spec: SupervisorSpec): readonly string[] {
  const loadCredentials = (spec.credentialFiles ?? []).map((credential) => `--property=LoadCredential=${credential.name}:${credential.path}`);
  return [
    "--user",
    "--no-block",
    "--quiet",
    `--unit=${spec.systemdUnit}`,
    "--property=KillMode=control-group",
    `--property=TimeoutStopSec=${spec.stopTimeoutMs}ms`,
    ...loadCredentials,
    ...metadataEnvironmentArgs(spec),
    ...(spec.cwd === undefined ? [] : [`--working-directory=${spec.cwd}`]),
    spec.executable,
    ...spec.args,
  ];
}
