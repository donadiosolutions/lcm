import { readAuthToken } from "./auth.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { daemonHttpUrl, daemonPortFromLoopbackUrl, normalizeDaemonPath } from "./http-url.js";

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
      const res = await fetch(daemonHttpUrl(this.port, "/health"));
      return res.ok ? (await res.json() as { status: string; uptime: number }) : null;
    } catch { return null; }
  }

  async get<T = unknown>(path: string): Promise<T> {
    const route = normalizeDaemonPath(path);
    const token = this.getToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const res = await fetch(daemonHttpUrl(this.port, route), {
      method: "GET",
      headers,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return await res.json() as T;
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const route = normalizeDaemonPath(path);
    const token = this.getToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const res = await fetch(daemonHttpUrl(this.port, route), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return await res.json() as T;
  }
}
