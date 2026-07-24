import { readAuthToken } from "./auth.js";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  daemonJsonRequest,
  daemonJsonResponse,
  daemonPortFromLoopbackUrl,
  normalizeDaemonPath,
} from "./http-url.js";
import { daemonTokenPath } from "../runtime-paths.js";
import type { StorageBackend } from "./config.js";

export type DaemonHealth = {
  status: string;
  version: string;
  storageBackend: StorageBackend;
  uptime: number;
  pid: number;
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

function isStagedPostgreSqlHealth(
  statusCode: number,
  health: DaemonHealthResponse,
): health is DaemonHealthResponse & { storageBackend: "postgresql" } {
  const error = health?.storage?.error;
  return statusCode === 503
    && health?.status === "unavailable"
    && health.storageBackend === "postgresql"
    && typeof health.version === "string"
    && typeof health.uptime === "number"
    && typeof health.pid === "number"
    && health.storage?.status === "unavailable"
    && error?.code === "STORAGE_INITIALIZATION_FAILED"
    && error.backend === "postgresql"
    && error.domain === "factory"
    && error.operation === "health";
}

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

  async health(): Promise<DaemonHealth | null> {
    try {
      const response = await daemonJsonResponse<DaemonHealthResponse>(this.port, "/health", {
        method: "GET",
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
    } catch { return null; }
  }

  async get<T = unknown>(path: string): Promise<T> {
    const route = normalizeDaemonPath(path);
    const token = this.getToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return await daemonJsonRequest<T>(this.port, route, {
      method: "GET",
      headers,
    });
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
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
    });
  }
}
