import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ status: undefined as number | undefined, body: "" }));
vi.mock("node:http", () => ({
  request: vi.fn((_options: unknown, callback: (response: EventEmitter & { statusCode?: number }) => void) => {
    const response = Object.assign(new EventEmitter(), { statusCode: state.status });
    const req = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn(), write: vi.fn(), end: vi.fn() });
    callback(response);
    queueMicrotask(() => { if (state.body) response.emit("data", state.body); response.emit("end"); });
    return req;
  }),
}));

import { daemonJsonRequest } from "../../src/daemon/http-url.js";

describe("mocked daemon HTTP response metadata", () => {
  it("falls back when Node omits a response status code", async () => {
    state.status = undefined; state.body = "";
    await expect(daemonJsonRequest(1, "/health", { method: "GET" })).rejects.toThrow("HTTP 500");
  });

  it("uses a structured daemon error", async () => {
    state.status = 400; state.body = '{"error":"structured"}';
    await expect(daemonJsonRequest(1, "/health", { method: "GET" })).rejects.toThrow("structured");
  });
});
