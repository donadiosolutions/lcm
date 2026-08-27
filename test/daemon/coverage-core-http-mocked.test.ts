import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  status: undefined as number | undefined,
  body: "",
  outcome: "end" as "end" | "aborted" | "error" | "aborted-error-end",
}));
vi.mock("node:http", () => ({
  request: vi.fn((_options: unknown, callback: (response: EventEmitter & { statusCode?: number }) => void) => {
    const response = Object.assign(new EventEmitter(), { statusCode: state.status });
    const req = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn(), write: vi.fn(), end: vi.fn() });
    callback(response);
    queueMicrotask(() => {
      if (state.body) response.emit("data", state.body);
      if (state.outcome === "aborted") {
        response.emit("aborted");
      } else if (state.outcome === "error") {
        response.emit("error", Object.assign(new Error("read failed"), { code: "EPIPE" }));
      } else if (state.outcome === "aborted-error-end") {
        response.emit("aborted");
        response.emit("error", Object.assign(new Error("late read failure"), { code: "EPIPE" }));
        response.emit("end");
      } else {
        response.emit("end");
      }
    });
    return req;
  }),
}));

import {
  daemonJsonRequest,
  isDaemonTransportFailure,
} from "../../src/daemon/http-url.js";

describe("mocked daemon HTTP response metadata", () => {
  it("classifies only bounded, known TypeError transport messages", () => {
    for (const message of [
      "fetch failed",
      "Failed to fetch",
      "network error",
      "network request failed",
      "load failed",
      "fetch failed: ECONNREFUSED",
      "fetch failed: connection refused",
    ]) {
      expect(isDaemonTransportFailure(new TypeError(message))).toBe(true);
    }

    for (const message of [
      "Cannot read properties of undefined",
      "connect parser bug",
      "socket hang up",
      "Daemon request timed out",
      "fetch failed: secret=/private/credential",
      "fetch failed".repeat(100),
    ]) {
    expect(isDaemonTransportFailure(new TypeError(message)), message).toBe(false);
    }

    expect(isDaemonTransportFailure(Object.assign(new Error("cancelled"), {
      name: "AbortError",
      code: "ECONNRESET",
    }))).toBe(false);
    expect(isDaemonTransportFailure(new Error("Daemon request timed out"))).toBe(true);

    const codedCause = new TypeError("programming failure", {
      cause: Object.assign(new Error("broken pipe"), { code: "EPIPE" }),
    });
    expect(isDaemonTransportFailure(codedCause)).toBe(true);
  });

  it("traverses bounded causes and AggregateError entries without trusting cycles", () => {
    expect(isDaemonTransportFailure(new Error("wrapper", {
      cause: new TypeError("load failed"),
    }))).toBe(true);

    const aggregate = new AggregateError([
      new Error("wrapper", {
        cause: Object.assign(new Error("broken pipe"), { code: "EPIPE" }),
      }),
    ], "request failed");
    expect(isDaemonTransportFailure(aggregate)).toBe(true);
    expect(isDaemonTransportFailure(new AggregateError([new Error("application failure")]))).toBe(false);

    const malformedAggregate = new AggregateError([], "not-an-array");
    Object.defineProperty(malformedAggregate, "errors", { value: "not-an-array" });
    expect(isDaemonTransportFailure(malformedAggregate)).toBe(false);

    const cycle = Object.assign(new Error("application failure"), { cause: undefined as unknown });
    cycle.cause = cycle;
    expect(isDaemonTransportFailure(cycle)).toBe(false);

    const deepRoot = new Error("too deep");
    let deepCursor = deepRoot as Error & { cause?: unknown };
    for (let depth = 0; depth < 9; depth += 1) {
      const nested = new Error("too deep") as Error & { cause?: unknown };
      deepCursor.cause = nested;
      deepCursor = nested;
    }
    deepCursor.cause = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    expect(isDaemonTransportFailure(deepRoot)).toBe(false);

    const boundedEntries = [
      Object.assign(new Error("hidden transport"), { code: "EPIPE" }),
      ...Array.from({ length: 32 }, () => new Error("application failure")),
    ];
    expect(isDaemonTransportFailure(new AggregateError(boundedEntries, "bounded"))).toBe(false);
  });

  it("falls back when Node omits a response status code", async () => {
    state.status = undefined; state.body = ""; state.outcome = "end";
    await expect(daemonJsonRequest(1, "/health", { method: "GET" })).rejects.toThrow("HTTP 500");
  });

  it("uses a structured daemon error", async () => {
    state.status = 400; state.body = '{"error":"structured"}'; state.outcome = "end";
    await expect(daemonJsonRequest(1, "/health", { method: "GET" })).rejects.toThrow("structured");
  });

  it("rejects a partial JSON response when IncomingMessage aborts", async () => {
    state.status = 200; state.body = '{"partial":'; state.outcome = "aborted";
    const error = await daemonJsonRequest(1, "/health", { method: "GET" }).catch(value => value as unknown);
    expect(error).toMatchObject({
      code: "ECONNRESET",
      cause: expect.objectContaining({ code: "ECONNRESET" }),
    });
    expect(isDaemonTransportFailure(error)).toBe(true);
  });

  it("rejects a partial JSON response error with its structured cause", async () => {
    state.status = 200; state.body = '{"partial":'; state.outcome = "error";
    const error = await daemonJsonRequest(1, "/health", { method: "GET" }).catch(value => value as unknown);
    expect(error).toMatchObject({
      code: "ECONNRESET",
      cause: expect.objectContaining({ code: "EPIPE" }),
    });
    expect(isDaemonTransportFailure(error)).toBe(true);
  });

  it("settles once when abort is followed by error and end", async () => {
    state.status = 200; state.body = '{"partial":'; state.outcome = "aborted-error-end";
    await expect(daemonJsonRequest(1, "/health", { method: "GET" })).rejects.toMatchObject({
      code: "ECONNRESET",
      cause: expect.objectContaining({ code: "ECONNRESET" }),
    });
  });
});
