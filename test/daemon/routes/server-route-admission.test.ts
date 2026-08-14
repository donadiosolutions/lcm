import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createDaemon,
  type DaemonInstance,
  type DaemonOptions,
  type RouteAdmission,
} from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { PrivateMutationLockContentionError } from "../../../src/private-mutation-lock.js";
import { SqliteProjectStorage } from "../../../src/storage/sqlite/project-storage.js";
import { withBackendPublicationConsumerLockAsync } from "../../../src/storage/backend-publication.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const EXPECTED_BUILT_IN_ROUTE_ADMISSIONS: readonly [string, RouteAdmission][] = [
  ["GET /health", "read"],
  ["POST /compact", "mutating"],
  ["POST /promote", "mutating"],
  ["POST /restore", "mutating"],
  ["POST /grep", "read"],
  ["POST /search", "read"],
  ["POST /expand", "read"],
  ["POST /describe", "read"],
  ["POST /store", "mutating"],
  ["POST /recent", "read"],
  ["POST /ingest", "mutating"],
  ["POST /prompt-search", "read"],
  ["POST /session-complete", "mutating"],
  ["POST /promote-events", "mutating"],
  ["POST /promote-events/all", "mutating"],
  ["POST /promote-events/notify", "read"],
  ["GET /stats", "read"],
  ["GET /stats/pool", "read"],
  ["POST /review-stale", "mutating"],
  ["POST /status", "read"],
];

describe("daemon route publication admission", () => {
  it("enumerates the built-in registry and preserves mutator admission on overrides", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-route-registry-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const lcmDir = join(tempHome, ".lcm");
    mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(tempHome, "project"), { recursive: true, mode: 0o700 });
    const configPath = join(lcmDir, "config.json");
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    const registrations: Array<[string, RouteAdmission]> = [];
    let daemon: DaemonInstance | undefined;

    try {
      daemon = await createDaemon(loadDaemonConfig(configPath, {
        daemon: { port: 0, idleTimeoutMs: 0 },
      }), {
        publicationConfigPath: configPath,
        _onBuiltInRouteRegistered: (key, admission) => registrations.push([key, admission]),
      });

      expect(registrations).toEqual(EXPECTED_BUILT_IN_ROUTE_ADMISSIONS);

      const mutatingRouteKeys = registrations
        .filter(([, admission]) => admission === "mutating")
        .map(([key]) => key);
      for (const routeKey of mutatingRouteKeys) {
        const [method, path] = routeKey.split(" ");
        const handlerStarted = deferred<void>();
        const releaseHandler = deferred<void>();
        daemon.registerRoute(method, path, async (_req, res) => {
          handlerStarted.resolve();
          await releaseHandler.promise;
          res.writeHead(200);
          res.end("{}");
        }, "read");

        const responsePromise = fetch(`http://127.0.0.1:${daemon.address().port}${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        await handlerStarted.promise;
        try {
          await expect(withBackendPublicationConsumerLockAsync(tempHome, async () => undefined))
            .rejects.toBeInstanceOf(PrivateMutationLockContentionError);
        } finally {
          releaseHandler.resolve();
          await expect(responsePromise).resolves.toMatchObject({ status: 200 });
        }
      }

      const customHandlerStarted = deferred<void>();
      const releaseCustomHandler = deferred<void>();
      daemon.registerRoute("POST", "/new-mutating", async (_req, res) => {
        customHandlerStarted.resolve();
        await releaseCustomHandler.promise;
        res.writeHead(200);
        res.end("{}");
      }, "mutating");
      const customResponsePromise = fetch(`http://127.0.0.1:${daemon.address().port}/new-mutating`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await customHandlerStarted.promise;
      try {
        await expect(withBackendPublicationConsumerLockAsync(tempHome, async () => undefined))
          .rejects.toBeInstanceOf(PrivateMutationLockContentionError);
      } finally {
        releaseCustomHandler.resolve();
        await expect(customResponsePromise).resolves.toMatchObject({ status: 200 });
      }
    } finally {
      if (daemon) await daemon.stop();
      rmSync(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("reuses the retained publication token for nested custom-route admission", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-route-nested-admission-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const lcmDir = join(tempHome, ".lcm");
    mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
    const configPath = join(lcmDir, "config.json");
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    let daemon: DaemonInstance | undefined;
    let outerToken: object | undefined;
    let nestedToken: object | undefined;

    try {
      daemon = await createDaemon(loadDaemonConfig(configPath, {
        daemon: { port: 0, idleTimeoutMs: 0 },
      }), { publicationConfigPath: configPath });
      daemon.registerRoute("POST", "/nested-admission", async (_req, res, _body, context) => {
        outerToken = context?.publicationLockToken;
        expect(outerToken).toBeDefined();
        const withPublicationAdmission = context?.withPublicationAdmission;
        expect(withPublicationAdmission).toBeDefined();
        nestedToken = await withPublicationAdmission!(token => {
          expect(token).toBe(outerToken);
          return token;
        });
        expect(nestedToken).toBe(outerToken);
        res.writeHead(200);
        res.end(JSON.stringify({ sameToken: nestedToken === outerToken }));
      }, "mutating");

      const response = await fetch(`http://127.0.0.1:${daemon.address().port}/nested-admission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ sameToken: true });
      expect(nestedToken).toBe(outerToken);
    } finally {
      if (daemon) await daemon.stop();
      rmSync(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("retains mutation admission in flight, releases it on every exit, and leaves reads concurrent", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-route-admission-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const lcmDir = join(tempHome, ".lcm");
    mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(tempHome, "project"), { recursive: true, mode: 0o700 });
    const configPath = join(lcmDir, "config.json");
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    let daemon: DaemonInstance | undefined;

    try {
      daemon = await createDaemon(loadDaemonConfig(configPath, {
        daemon: { port: 0, idleTimeoutMs: 0 },
      }), {
        publicationConfigPath: configPath,
      });

      const publicationCanEnter = async (): Promise<boolean> => {
        try {
          await withBackendPublicationConsumerLockAsync(tempHome, async () => undefined);
          return true;
        } catch (error) {
          expect(error).toBeInstanceOf(PrivateMutationLockContentionError);
          return false;
        }
      };

      const request = async (routeKey: string): Promise<Response> => {
        const [method, path] = routeKey.split(" ");
        return fetch(`http://127.0.0.1:${daemon!.address().port}${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: method === "GET" ? undefined : "{}",
        });
      };

      const mutatingRouteKeys = [
        "POST /compact",
        "POST /promote",
        "POST /restore",
        "POST /store",
        "POST /ingest",
        "POST /session-complete",
        "POST /promote-events",
        "POST /promote-events/all",
        "POST /review-stale",
      ] as const;

      for (const routeKey of mutatingRouteKeys) {
        const [method, path] = routeKey.split(" ");
        const handlerStarted = deferred<void>();
        const releaseHandler = deferred<void>();
        daemon.registerRoute(method, path, async (_req, res) => {
          handlerStarted.resolve();
          await releaseHandler.promise;
          res.writeHead(200);
          res.end("{}");
        }, "read");

        const responsePromise = request(routeKey);
        await Promise.race([
          handlerStarted.promise,
          responsePromise.then(async (response) => {
            throw new Error(`request completed before ${routeKey} handler started: ${response.status} ${await response.text()}`);
          }),
        ]);
        try {
          expect(await publicationCanEnter(), routeKey).toBe(false);
        } finally {
          releaseHandler.resolve();
          const response = await responsePromise;
          expect(response.status, routeKey).toBe(200);
        }

        expect(await publicationCanEnter(), `${routeKey} after completion`).toBe(true);
      }

      for (const [label, failure] of [
        ["failure", new Error("route failed")],
        ["cancellation", Object.assign(new Error("request aborted"), { name: "AbortError" })],
      ] as const) {
        const handlerStarted = deferred<void>();
        const releaseHandler = deferred<void>();
        daemon.registerRoute("POST", "/ingest", async () => {
          handlerStarted.resolve();
          await releaseHandler.promise;
          throw failure;
        }, "read");

        const responsePromise = request("POST /ingest");
        await Promise.race([
          handlerStarted.promise,
          responsePromise.then(async (response) => {
            throw new Error(`request completed before ${label} handler started: ${response.status} ${await response.text()}`);
          }),
        ]);
        try {
          expect(await publicationCanEnter(), `POST /ingest during ${label}`).toBe(false);
        } finally {
          releaseHandler.resolve();
          const response = await responsePromise;
          expect(response.status, `POST /ingest ${label} response`).toBe(500);
        }

        expect(await publicationCanEnter(), `POST /ingest after ${label}`).toBe(true);
      }

      const handlerStarted = deferred<void>();
      const releaseHandler = deferred<void>();
      daemon.registerRoute("GET", "/health", async (_req, res) => {
        handlerStarted.resolve();
        await releaseHandler.promise;
        res.writeHead(200);
        res.end("{}");
      }, "read");

      const responsePromise = request("GET /health");
      await handlerStarted.promise;
      try {
        expect(await publicationCanEnter(), "GET /health during read").toBe(true);
      } finally {
        releaseHandler.resolve();
        const response = await responsePromise;
        expect(response.status).toBe(200);
      }
    } finally {
      if (daemon) await daemon.stop();
      rmSync(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("flushes mutating status, headers, and body only after retained admission succeeds", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-route-response-buffer-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const lcmDir = join(tempHome, ".lcm");
    mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
    const configPath = join(lcmDir, "config.json");
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    let daemon: DaemonInstance | undefined;

    try {
      daemon = await createDaemon(loadDaemonConfig(configPath, {
        daemon: { port: 0, idleTimeoutMs: 0 },
      }), {
        publicationConfigPath: configPath,
      });
      daemon.registerRoute("POST", "/ingest", async (_req, res) => {
        res.setHeader("X-Buffered", "set-before-head");
        expect(res.getHeader("X-Buffered")).toBe("set-before-head");
        res.setHeader("X-Removed", "must-not-be-sent");
        res.removeHeader("X-Removed");
        expect(res.getHeader("X-Removed")).toBeUndefined();
        res.writeHead(201, {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Write-Head": "set-by-write-head",
        });
        expect(res.write("buffered-")).toBe(true);
        res.end("response");
      }, "read");

      const response = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(201);
      expect(response.headers.get("X-Buffered")).toBe("set-before-head");
      expect(response.headers.get("X-Write-Head")).toBe("set-by-write-head");
      expect(response.headers.get("X-Removed")).toBeNull();
      await expect(response.text()).resolves.toBe("buffered-response");
    } finally {
      if (daemon) await daemon.stop();
      rmSync(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("supports the implemented response header, body, encoding, and empty-chunk forms", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-route-response-forms-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const lcmDir = join(tempHome, ".lcm");
    mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
    const configPath = join(lcmDir, "config.json");
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    let daemon: DaemonInstance | undefined;

    try {
      daemon = await createDaemon(loadDaemonConfig(configPath, {
        daemon: { port: 0, idleTimeoutMs: 0 },
      }), { publicationConfigPath: configPath });
      daemon.registerRoute("POST", "/ingest", async (_req, res) => {
        res.setHeader("X-Number", 42);
        res.setHeader("X-Multiple", ["one", "two"]);
        expect(res.getHeader("x-number")).toBe(42);
        expect(res.getHeader("x-multiple")).toEqual(["one", "two"]);
        res.writeHead(202, {
          "X-Head-Multiple": ["head-one", "head-two"],
          "X-Head-Number": 7,
          "X-Head-Undefined": undefined,
        });
        res.write("", "utf8");
        res.write(new Uint8Array());
        res.write("prefix", "utf8");
        res.end(new Uint8Array([45, 115, 117, 102, 102, 105, 120]));
      }, "read");

      const response = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(202);
      expect(response.headers.get("X-Number")).toBe("42");
      expect(response.headers.get("X-Multiple")).toBe("one, two");
      expect(response.headers.get("X-Head-Multiple")).toBe("head-one, head-two");
      expect(response.headers.get("X-Head-Number")).toBe("7");
      expect(response.headers.get("X-Head-Undefined")).toBeNull();
      await expect(response.text()).resolves.toBe("prefix-suffix");

      daemon.registerRoute("POST", "/store", async (_req, res) => {
        res.writeHead(200);
        res.end();
      }, "read");
      const emptyResponse = await fetch(`http://127.0.0.1:${daemon.address().port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(emptyResponse.status).toBe(200);
      await expect(emptyResponse.text()).resolves.toBe("");
    } finally {
      if (daemon) await daemon.stop();
      rmSync(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("rejects duplicate response starts and writes after end through the buffered error path", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-route-response-duplicate-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const lcmDir = join(tempHome, ".lcm");
    mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
    const configPath = join(lcmDir, "config.json");
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    let daemon: DaemonInstance | undefined;

    try {
      daemon = await createDaemon(loadDaemonConfig(configPath, {
        daemon: { port: 0, idleTimeoutMs: 0 },
      }), { publicationConfigPath: configPath });
      for (const operation of ["setHeader", "removeHeader", "writeHead"] as const) {
        daemon.registerRoute("POST", "/ingest", async (_req, res) => {
          res.write("started");
          if (operation === "setHeader") res.setHeader("X-Late", "value");
          else if (operation === "removeHeader") res.removeHeader("X-Late");
          else res.writeHead(200);
        }, "read");
        const response = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        expect(response.status, operation).toBe(500);
        await expect(response.json(), operation).resolves.toEqual({
          error: "Cannot set headers after they are sent to the client",
        });
      }

      for (const operation of ["write", "end"] as const) {
        daemon.registerRoute("POST", "/ingest", async (_req, res) => {
          res.end();
          if (operation === "write") res.write("late");
          else res.end("late");
        }, "read");
        const response = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        expect(response.status, operation).toBe(500);
        await expect(response.json(), operation).resolves.toEqual({ error: "write after end" });
      }
    } finally {
      if (daemon) await daemon.stop();
      rmSync(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("rejects invalid status codes and overflows before flushing the transport", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-route-response-limit-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const lcmDir = join(tempHome, ".lcm");
    mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
    const configPath = join(lcmDir, "config.json");
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    let daemon: DaemonInstance | undefined;

    try {
      daemon = await createDaemon(loadDaemonConfig(configPath, {
        daemon: { port: 0, idleTimeoutMs: 0 },
      }), { publicationConfigPath: configPath });
      for (const [operation, invoke, expected] of [
        ["status", (res: Parameters<Exclude<import("../../../src/daemon/server.js").RouteHandler, never>>[1]) => res.writeHead(99), "Invalid status code: 99"],
        ["overflow", (res: Parameters<Exclude<import("../../../src/daemon/server.js").RouteHandler, never>>[1]) => res.write(new Uint8Array(10 * 1024 * 1024 + 1)), "mutating response exceeds the response size limit"],
      ] as const) {
        daemon.registerRoute("POST", "/ingest", async (_req, res) => {
          invoke(res);
        }, "read");
        const response = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        expect(response.status, operation).toBe(500);
        await expect(response.json(), operation).resolves.toEqual({ error: expected });
      }
    } finally {
      if (daemon) await daemon.stop();
      rmSync(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("maps buffered 413 and non-Error failures without leaking generated output", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-route-response-failure-shapes-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const lcmDir = join(tempHome, ".lcm");
    mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
    const configPath = join(lcmDir, "config.json");
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    let daemon: DaemonInstance | undefined;

    try {
      daemon = await createDaemon(loadDaemonConfig(configPath, {
        daemon: { port: 0, idleTimeoutMs: 0 },
      }), { publicationConfigPath: configPath });
      for (const [failure, status, body] of [
        [Object.assign(new Error("request too large"), { statusCode: 413 }), 413, { error: "payload too large" }],
        ["non-error failure", 500, { error: "internal error" }],
      ] as const) {
        daemon.registerRoute("POST", "/ingest", async (_req, res) => {
          res.end("must be discarded");
          throw failure;
        }, "read");
        const response = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        expect(response.status).toBe(status);
        await expect(response.json()).resolves.toEqual(body);
      }
    } finally {
      if (daemon) await daemon.stop();
      rmSync(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("returns a buffered read error when request config is not a regular file", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-route-config-read-error-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const lcmDir = join(tempHome, ".lcm");
    const configPath = join(lcmDir, "config.json");
    mkdirSync(configPath, { recursive: true, mode: 0o700 });
    let daemon: DaemonInstance | undefined;

    try {
      daemon = await createDaemon(loadDaemonConfig("/missing", {
        daemon: { port: 0, idleTimeoutMs: 0 },
      }), { publicationConfigPath: configPath });
      const response = await fetch(`http://127.0.0.1:${daemon.address().port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) });
    } finally {
      if (daemon) await daemon.stop();
      rmSync(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("discards mutating output on handler failure and post-validation corruption without unhandled rejections", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-route-response-failure-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const lcmDir = join(tempHome, ".lcm");
    const publicationDir = join(lcmDir, "backend-publication");
    mkdirSync(publicationDir, { recursive: true, mode: 0o700 });
    const configPath = join(lcmDir, "config.json");
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    let daemon: DaemonInstance | undefined;

    try {
      process.on("unhandledRejection", onUnhandledRejection);
      daemon = await createDaemon(loadDaemonConfig(configPath, {
        daemon: { port: 0, idleTimeoutMs: 0 },
      }), {
        publicationConfigPath: configPath,
      });

      for (const failure of [
        new Error("route failed after generating output"),
        Object.assign(new Error("request aborted after generating output"), { name: "AbortError" }),
      ]) {
        daemon.registerRoute("POST", "/ingest", async (_req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          throw failure;
        }, "read");

        const response = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({ error: failure.message });
        await expect(withBackendPublicationConsumerLockAsync(tempHome, async () => undefined))
          .resolves.toBeUndefined();
      }

      daemon.registerRoute("POST", "/ingest", async (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        chmodSync(publicationDir, 0o777);
      }, "read");

      const blockedResponse = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const blockedBody = await blockedResponse.json();
      expect(blockedResponse.status).toBe(500);
      expect(blockedBody).toMatchObject({ error: expect.any(String) });
      expect(JSON.stringify(blockedBody)).not.toContain("ok");
      chmodSync(publicationDir, 0o700);
      await expect(withBackendPublicationConsumerLockAsync(tempHome, async () => undefined))
        .resolves.toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      if (daemon) await daemon.stop();
      rmSync(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("holds the retained lock across a real SQLite mutating transaction", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-route-real-mutator-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const lcmDir = join(tempHome, ".lcm");
    mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
    const configPath = join(lcmDir, "config.json");
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    let daemon: DaemonInstance | undefined;
    const transactionStarted = deferred<void>();
    const releaseTransaction = deferred<void>();
    const originalTransaction = SqliteProjectStorage.prototype.transaction;
    const transactionSpy = vi.spyOn(SqliteProjectStorage.prototype, "transaction").mockImplementation(async function (callback) {
      transactionStarted.resolve();
      await releaseTransaction.promise;
      return originalTransaction.call(this, callback);
    });
    const projectPath = join(tempHome, "project");
    mkdirSync(projectPath, { recursive: true, mode: 0o700 });

    try {
      daemon = await createDaemon(loadDaemonConfig(configPath, {
        daemon: { port: 0, idleTimeoutMs: 0 },
      }), {
        publicationConfigPath: configPath,
      });
      const responsePromise = fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "route-admission-real-mutator",
          cwd: projectPath,
          messages: [{ role: "user", content: "commit this", tokenCount: 1 }],
        }),
      });
      await Promise.race([
        transactionStarted.promise,
        responsePromise.then(async (response) => {
          throw new Error(
            `real mutator completed before transaction barrier: ${response.status} ${await response.clone().text()}`,
          );
        }),
      ]);
      await expect(withBackendPublicationConsumerLockAsync(tempHome, async () => undefined))
        .rejects.toBeInstanceOf(PrivateMutationLockContentionError);

      releaseTransaction.resolve();
      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ingested: 1, totalTokens: 1 });
      expect(transactionSpy).toHaveBeenCalledOnce();
      const db = new DatabaseSync(projectDbPath(projectPath), { readOnly: true });
      try {
        expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE content = ?").get("commit this"))
          .toEqual({ count: 1 });
      } finally {
        db.close();
      }
    } finally {
      releaseTransaction.resolve();
      transactionSpy.mockRestore();
      if (daemon) await daemon.stop();
      rmSync(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("uses credential-projected storage selection for startup and request admission", async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const credentialEnvNames = [
      "LCM_CREDENTIAL_DIRECTORY",
      "LCM_CREDENTIAL_LCM_POSTGRES_URL_FILE",
      "LCM_POSTGRES_CA_FILE",
      "LCM_POSTGRES_URL",
      "LCM_POSTGRES_MIGRATION_ROLE",
    ] as const;
    const previousEnv = Object.fromEntries(credentialEnvNames.map((name) => [name, process.env[name]]));
    const tempHome = mkdtempSync(join(tmpdir(), "lcm-route-credential-admission-"));
    const credentialRoot = mkdtempSync(join(tmpdir(), "lcm-route-credential-root-"));
    const credentialDirectory = join(credentialRoot, "credentials");
    mkdirSync(credentialDirectory, { mode: 0o700 });
    chmodSync(credentialDirectory, 0o700);
    const credentialFile = join(credentialDirectory, "LCM_POSTGRES_URL");
    writeFileSync(credentialFile, "postgresql://credential-user:credential-password@db.example/lcm\n", { mode: 0o600 });
    chmodSync(credentialFile, 0o600);
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.LCM_CREDENTIAL_DIRECTORY = credentialDirectory;
    process.env.LCM_CREDENTIAL_LCM_POSTGRES_URL_FILE = credentialFile;
    delete process.env.LCM_POSTGRES_URL;
    process.env.LCM_POSTGRES_MIGRATION_ROLE = "lcm_test_migrator";
    const lcmDir = join(tempHome, ".lcm");
    mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
    const configPath = join(lcmDir, "config.json");
    const caPath = join(tempHome, "postgres-ca.pem");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\ncredential-test\n-----END CERTIFICATE-----\n", { mode: 0o600 });
    const storageConfig = {
      storage: { backend: "postgresql" },
    };
    process.env.LCM_POSTGRES_CA_FILE = caPath;
    writeFileSync(configPath, JSON.stringify(storageConfig) + "\n", { mode: 0o600 });
    let daemon: DaemonInstance | undefined;
    const admissionOptions: DaemonOptions = {
      publicationConfigPath: configPath,
      _assertBackendPublication: () => undefined,
    };

    try {
      const startupConfig = loadDaemonConfig("/nonexistent/startup-config.json", {
        storage: storageConfig.storage,
        daemon: { port: 0, idleTimeoutMs: 0 },
      });
      expect(startupConfig.storage.backend).toBe("postgresql");
      daemon = await createDaemon(startupConfig, admissionOptions);
      admissionOptions._assertBackendPublication = undefined;

      const response = await fetch(`http://127.0.0.1:${daemon.address().port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: tempHome, text: "credential backend" }),
      });
      const responseBody = await response.json();
      expect({ status: response.status, body: responseBody }).toEqual({
        status: 503,
        body: {
          status: "blocked",
          error: "backend publication admission blocked",
        },
      });

      rmSync(configPath);
      const missingContentResponse = await fetch(`http://127.0.0.1:${daemon.address().port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: tempHome, text: "missing config" }),
      });
      expect(missingContentResponse.status).toBe(503);
    } finally {
      if (daemon) await daemon.stop();
      rmSync(tempHome, { recursive: true, force: true });
      rmSync(credentialRoot, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      for (const name of credentialEnvNames) {
        const value = previousEnv[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
