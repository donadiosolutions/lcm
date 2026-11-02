import { readAuthToken } from "./auth.js";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  daemonJsonRequest,
  daemonJsonResponse,
  daemonPortFromLoopbackUrl,
  normalizeDaemonPath,
} from "./http-url.js";
import { isAbortError, throwIfAborted } from "./cancellation.js";
import { daemonTokenPath } from "../runtime-paths.js";
import type { StorageBackend } from "./config.js";
import { isStagedPostgreSqlHealth } from "./staged-postgresql.js";

export type DaemonHealth = {
  status: string;
  version: string;
  /** Absent when the daemon did not report a recognized backend identity. */
  storageBackend?: StorageBackend;
  uptime: number;
  pid: number;
  entrypoint?: string;
  /** Present only on authenticated health responses from token-bearing daemons. */
  runtimeDigest?: string;
  /** Present only on authenticated health responses from this daemon generation. */
  daemonInstanceId?: string;
  storage?: {
    status: string;
    error?: {
      code?: string;
      backend?: string;
      domain?: string;
      operation?: string;
    };
  };
};

/** Process identity only: never evidence of active storage readiness. */
export type DaemonObservation = {
  status: "ok";
  observation: "identity-only";
  storage: { status: "unverified" };
  version: string;
  storageBackend: StorageBackend;
  uptime: number;
  pid: number;
  entrypoint: string;
  daemonInstanceId: string;
  runtimeDigest?: string;
  ownerId?: string;
};

export type DaemonObservationMismatchField = "version" | "storageBackend" | "entrypoint" | "runtimeDigest";

/**
 * Why an authenticated identity observation did not produce a verified
 * daemon. Carries only closed vocabulary, a numeric HTTP status and field
 * names: never error text, headers, tokens or response bodies.
 */
export type DaemonObservationFailure = Readonly<{
  reason:
    | "token-missing"
    | "connect-failed"
    | "headers-timeout"
    | "body-timeout"
    | "body-invalid"
    | "http-status"
    | "invalid-identity"
    | "identity-mismatch"
    | "local-identity-unavailable"
    | "config-changed";
  statusCode?: number;
  fields?: readonly DaemonObservationMismatchField[];
}>;

export function isDaemonObservationFailure(
  value: DaemonObservation | DaemonObservationFailure,
): value is DaemonObservationFailure {
  return "reason" in value;
}

/** Fixed sentence for a failure, without a trailing period. */
export function describeDaemonObservationFailure(failure: DaemonObservationFailure): string {
  switch (failure.reason) {
    case "token-missing":
      return "the daemon token is missing or empty";
    case "connect-failed":
      return "the connection to the daemon failed";
    case "headers-timeout":
      return "the daemon did not start responding before the deadline";
    case "body-timeout":
      return "the daemon started responding but did not finish before the deadline";
    case "body-invalid":
      return "the daemon response body could not be read as JSON";
    case "http-status":
      return `the daemon answered with HTTP ${failure.statusCode}`;
    case "invalid-identity":
      return "the daemon response is not a valid identity observation";
    case "identity-mismatch":
      return `the daemon identity differs from this installation (${failure.fields!.join(", ")})`;
    case "local-identity-unavailable":
      return "this installation could not determine the identity to expect";
    case "config-changed":
      return "the configuration changed during the observation";
  }
}

/** Carries a classified observation failure through refusal-only call paths. */
export class DaemonObservationError extends Error {
  constructor(readonly failure: DaemonObservationFailure) {
    super(describeDaemonObservationFailure(failure));
    this.name = "DaemonObservationError";
  }
}

function classifyObservationError(error: unknown): DaemonObservationFailure {
  const tagged = error as { daemonPhase?: unknown; daemonStatusCode?: unknown } | null | undefined;
  switch (tagged?.daemonPhase) {
    case "headers-timeout":
      return { reason: "headers-timeout" };
    case "body-timeout":
      return { reason: "body-timeout" };
    case "body-failed":
      return typeof tagged?.daemonStatusCode === "number" && tagged.daemonStatusCode !== 200
        ? { reason: "http-status", statusCode: tagged.daemonStatusCode }
        : { reason: "body-invalid" };
    default:
      return { reason: "connect-failed" };
  }
}

/** Shared, transport-independent admission for diagnostic identity responses. */
export function parseDaemonObservation(statusCode: number, value: unknown): DaemonObservation | null {
  if (statusCode !== 200 || typeof value !== "object" || value === null) return null;
  const identity = value as Partial<DaemonObservation>;
  if (
    identity.status !== "ok"
    || identity.observation !== "identity-only"
    || identity.storage?.status !== "unverified"
    || typeof identity.version !== "string" || identity.version.length === 0
    || (identity.storageBackend !== "sqlite" && identity.storageBackend !== "postgresql")
    || !Number.isSafeInteger(identity.uptime) || identity.uptime! < 0
    || !Number.isSafeInteger(identity.pid) || identity.pid! <= 0
    || typeof identity.entrypoint !== "string" || identity.entrypoint.length === 0
    || typeof identity.daemonInstanceId !== "string" || identity.daemonInstanceId.length === 0
    || (identity.runtimeDigest !== undefined && (typeof identity.runtimeDigest !== "string" || identity.runtimeDigest.length === 0))
    || (identity.ownerId !== undefined && (typeof identity.ownerId !== "string" || identity.ownerId.length === 0))
  ) return null;
  return identity as DaemonObservation;
}

type DaemonHealthResponse = Omit<DaemonHealth, "storageBackend"> & {
  storageBackend?: StorageBackend;
};

// #230 added storageBackend to /health after the last published release, so
// every release through 1.4.3 omits it and was SQLite-only.
const LAST_PRE_IDENTITY_RELEASE = [1, 4, 3] as const;

/**
 * Backend a daemon claims through /health. An omitted field is a SQLite claim
 * only for a strict release version that predates backend identity; any other
 * absence or unrecognized value is unknown.
 */
export function inferredHealthStorageBackend(
  health: { storageBackend?: unknown; version?: unknown },
): StorageBackend | undefined {
  if (health.storageBackend === "sqlite" || health.storageBackend === "postgresql") {
    return health.storageBackend;
  }
  if (health.storageBackend !== undefined || typeof health.version !== "string") return undefined;
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(health.version);
  if (match === null) return undefined;
  const parts = [match[1], match[2], match[3]].map(Number);
  if (!parts.every((part) => Number.isSafeInteger(part))) return undefined;
  for (const [index, limit] of LAST_PRE_IDENTITY_RELEASE.entries()) {
    if (parts[index]! !== limit) return parts[index]! < limit ? "sqlite" : undefined;
  }
  return "sqlite";
}

export type DaemonRequestOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type InvocationControlRequest = Readonly<{
  invocationId: string;
  command: "compact";
  daemonInstanceId: string;
}>;

export type InvocationControlResponse = Readonly<{
  invocationId: string;
  command: "compact";
  daemonInstanceId: string;
  state: string;
  activeCount: number;
  workCount?: number;
  commitCount?: number;
  leaseExpiresAt?: number | null;
}>;

export class DaemonClient {
  private token: string | null = null;
  private tokenLoaded = false;
  private readonly port: number;

  constructor(baseUrl: string, private tokenPath?: string) {
    this.port = daemonPortFromLoopbackUrl(baseUrl);
  }

  private getToken(): string | null {
    if (!this.tokenLoaded) {
      this.token = readAuthToken(
        this.tokenPath ?? daemonTokenPath(),
      );
      this.tokenLoaded = true;
    }
    return this.token;
  }

  async health(options?: DaemonRequestOptions): Promise<DaemonHealth | null> {
    try {
      throwIfAborted(options?.signal);
      const token = this.getToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await daemonJsonResponse<DaemonHealthResponse>(this.port, "/health", {
        method: "GET",
        headers,
        ...options,
      });
      const health = response.data;
      if (
        (response.statusCode < 200 || response.statusCode >= 300)
        && !isStagedPostgreSqlHealth(response.statusCode, health)
      ) {
        return null;
      }
      const { storageBackend: _reported, ...rest } = health;
      const storageBackend = inferredHealthStorageBackend(health);
      return storageBackend === undefined ? rest : { ...rest, storageBackend };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return null;
    }
  }

  async observe(options?: DaemonRequestOptions): Promise<DaemonObservation | null> {
    const observed = await this.observeClassified(options);
    return isDaemonObservationFailure(observed) ? null : observed;
  }

  async observeClassified(
    options?: DaemonRequestOptions,
  ): Promise<DaemonObservation | DaemonObservationFailure> {
    try {
      throwIfAborted(options?.signal);
      const token = this.getToken();
      if (!token) return { reason: "token-missing" };
      const response = await daemonJsonResponse<unknown>(this.port, "/health/observe", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        ...options,
      });
      if (response.statusCode !== 200) return { reason: "http-status", statusCode: response.statusCode };
      return parseDaemonObservation(response.statusCode, response.data) ?? { reason: "invalid-identity" };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return classifyObservationError(error);
    }
  }

  async get<T = unknown>(path: string, options?: DaemonRequestOptions): Promise<T> {
    throwIfAborted(options?.signal);
    const route = normalizeDaemonPath(path);
    const token = this.getToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return await daemonJsonRequest<T>(this.port, route, {
      method: "GET",
      headers,
      ...options,
    });
  }

  async post<T = unknown>(path: string, body: unknown, options?: DaemonRequestOptions): Promise<T> {
    throwIfAborted(options?.signal);
    const route = normalizeDaemonPath(path);
    const token = this.getToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return await daemonJsonRequest<T>(this.port, route, {
      method: "POST",
      headers,
      body,
      ...options,
    });
  }

  async invocationControl(
    action: "start" | "heartbeat" | "cancel" | "finish",
    input: InvocationControlRequest,
    options?: DaemonRequestOptions,
  ): Promise<InvocationControlResponse> {
    return await this.post<InvocationControlResponse>("/invocation-control", {
      action,
      invocation_id: input.invocationId,
      command: input.command,
      daemon_instance_id: input.daemonInstanceId,
    }, options);
  }

  async startInvocation(
    input: InvocationControlRequest,
    options?: DaemonRequestOptions,
  ): Promise<InvocationControlResponse> {
    return await this.invocationControl("start", input, options);
  }

  async heartbeatInvocation(
    input: InvocationControlRequest,
    options?: DaemonRequestOptions,
  ): Promise<InvocationControlResponse> {
    return await this.invocationControl("heartbeat", input, options);
  }

  async cancelInvocation(
    input: InvocationControlRequest,
    options?: DaemonRequestOptions,
  ): Promise<InvocationControlResponse> {
    return await this.invocationControl("cancel", input, options);
  }

  async finishInvocation(
    input: InvocationControlRequest,
    options?: DaemonRequestOptions,
  ): Promise<InvocationControlResponse> {
    return await this.invocationControl("finish", input, options);
  }
}
