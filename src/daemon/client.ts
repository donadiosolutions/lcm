import { readAuthToken } from "./auth.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { daemonJsonRequest, daemonPortFromLoopbackUrl, normalizeDaemonPath } from "./http-url.js";

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
        this.tokenPath ?? join(homedir(), ".lossless-claude", "daemon.token"),
      );
      this.tokenLoaded = true;
    }
    return this.token;
  }

  async health(): Promise<{ status: string; uptime: number } | null> {
    try {
      return await daemonJsonRequest<{ status: string; uptime: number }>(this.port, "/health", {
        method: "GET",
      });
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
