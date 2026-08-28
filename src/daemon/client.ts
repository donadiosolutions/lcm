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
  storageBackend: StorageBackend;
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

type DaemonHealthResponse = Omit<DaemonHealth, "storageBackend"> & {
  storageBackend?: StorageBackend;
};

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
      // Daemons predating backend identity were necessarily SQLite-only.
      return { ...health, storageBackend: health.storageBackend ?? "sqlite" };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return null;
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
