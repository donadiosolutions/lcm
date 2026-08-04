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
  it("classifies TypeError and AggregateError transport causes", () => {
    expect(isDaemonTransportFailure(new TypeError("fetch failed"))).toBe(true);

    const aggregate = new AggregateError([
      new Error("wrapper", {
        cause: Object.assign(new Error("broken pipe"), { code: "EPIPE" }),
      }),
    ], "request failed");
    expect(isDaemonTransportFailure(aggregate)).toBe(true);

    expect(isDaemonTransportFailure(new AggregateError([new Error("application failure")]))).toBe(false);
    expect(isDaemonTransportFailure({ code: 42, errors: "not-an-array" })).toBe(false);
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
