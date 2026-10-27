import { readAuthToken } from "./auth.js";
import { dirname, resolve } from "node:path";
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
import { admitDaemonPeer, type DaemonPeerAdmission } from "./peer-admission.js";

/** Local ownership proof failed before a token or request body was sent. */
export class DaemonPeerRefusalError extends Error {
  constructor() {
    super("Daemon peer could not be verified");
    this.name = "DaemonPeerRefusalError";
  }
}

/** Production client: re-proves local ownership before each bearer request. */
export function verifiedLocalDaemonClient(
  port: number,
  tokenPath?: string,
  homeDir: string = tokenPath === undefined ? homedir() : dirname(dirname(tokenPath)),
): DaemonClient {
  const canonicalTokenPath = daemonTokenPath(homeDir);
  const path = tokenPath ?? canonicalTokenPath;
  return new DaemonClient(`http://127.0.0.1:${port}`, path,
    (budgetMs) => resolve(path) === resolve(canonicalTokenPath)
      ? admitDaemonPeer({ port, homeDir, deadline: performance.now() + Math.min(2_000, budgetMs ?? 2_000) })
      : null,
    true);
}

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

  constructor(
    baseUrl: string,
    private tokenPath?: string,
    private readonly admitPeer?: (budgetMs?: number) => DaemonPeerAdmission | null | Promise<DaemonPeerAdmission | null>,
    private readonly strictPeerRefusal = false,
  ) {
    this.port = daemonPortFromLoopbackUrl(baseUrl);
  }

  private async admission(options?: DaemonRequestOptions): Promise<DaemonPeerAdmission | undefined> {
    if (this.admitPeer === undefined) return undefined;
    const peer = await this.admitPeer(options?.timeoutMs);
    if (peer === null) throw new DaemonPeerRefusalError();
    return peer;
  }

  private remainingOptions(options: DaemonRequestOptions | undefined, started: number): DaemonRequestOptions | undefined {
    if (this.admitPeer === undefined || options?.timeoutMs === undefined) return options;
    const timeoutMs = Math.floor(options.timeoutMs - (performance.now() - started));
    if (timeoutMs <= 0) throw new DaemonPeerRefusalError();
    return { ...options, timeoutMs };
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
      const started = performance.now();
      const peer = await this.admission(options);
      const requestOptions = this.remainingOptions(options, started);
      throwIfAborted(options?.signal);
      const token = this.getToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await daemonJsonResponse<DaemonHealthResponse>(this.port, "/health", {
        method: "GET",
        headers,
        ...requestOptions,
      });
      const health = response.data;
      if (peer !== undefined && health.pid !== peer.pid) return null;
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
      if (isAbortError(error) || (this.strictPeerRefusal && error instanceof DaemonPeerRefusalError)) throw error;
      return null;
    }
  }

  async observe(options?: DaemonRequestOptions): Promise<DaemonObservation | null> {
    try {
      throwIfAborted(options?.signal);
      const started = performance.now();
      const peer = await this.admission(options);
      const requestOptions = this.remainingOptions(options, started);
      throwIfAborted(options?.signal);
      const token = this.getToken();
      if (!token) return null;
      const response = await daemonJsonResponse<unknown>(this.port, "/health/observe", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        ...requestOptions,
      });
      const observation = parseDaemonObservation(response.statusCode, response.data);
      return observation?.pid === peer?.pid || peer === undefined ? observation : null;
    } catch (error) {
      if (isAbortError(error) || (this.strictPeerRefusal && error instanceof DaemonPeerRefusalError)) throw error;
      return null;
    }
  }

  async get<T = unknown>(path: string, options?: DaemonRequestOptions): Promise<T> {
    throwIfAborted(options?.signal);
    const route = normalizeDaemonPath(path);
    const started = performance.now();
    await this.admission(options);
    const requestOptions = this.remainingOptions(options, started);
    throwIfAborted(options?.signal);
    const token = this.getToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return await daemonJsonRequest<T>(this.port, route, {
      method: "GET",
      headers,
      ...requestOptions,
    });
  }

  async post<T = unknown>(path: string, body: unknown, options?: DaemonRequestOptions): Promise<T> {
    throwIfAborted(options?.signal);
    const route = normalizeDaemonPath(path);
    const started = performance.now();
    await this.admission(options);
    const requestOptions = this.remainingOptions(options, started);
    throwIfAborted(options?.signal);
    const token = this.getToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return await daemonJsonRequest<T>(this.port, route, {
      method: "POST",
      headers,
      body,
      ...requestOptions,
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
