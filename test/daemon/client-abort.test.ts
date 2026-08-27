import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  request: undefined as FakeRequest | undefined,
  response: undefined as FakeResponse | undefined,
  throwRequest: undefined as unknown,
  abortDuringRequest: undefined as AbortController | undefined,
  repeatEnd: false,
}));

class FakeResponse extends EventEmitter {
  public statusCode = 200;
  public readonly destroy = vi.fn();
}

class FakeRequest extends EventEmitter {
  public readonly setTimeout = vi.fn((_ms: number, callback: () => void) => {
    this.timeoutCallback = callback;
  });
  public readonly write = vi.fn();
  public readonly end = vi.fn();
  public readonly destroy = vi.fn(() => {
    this.emit("error", Object.assign(new Error("late destroy"), { code: "ECONNRESET" }));
    this.emit("close");
  });
  public timeoutCallback: (() => void) | undefined;
}

vi.mock("node:http", () => ({
  request: vi.fn((_options: unknown, callback: (response: FakeResponse) => void) => {
    if (state.throwRequest !== undefined) throw state.throwRequest;
    const request = new FakeRequest();
    const response = new FakeResponse();
    state.request = request;
    state.response = response;
    if (state.repeatEnd) {
      const originalOnce = response.once.bind(response);
      response.once = ((event: string, listener: (...args: unknown[]) => void) => {
        if (event !== "end") return originalOnce(event, listener);
        const wrapper = (...args: unknown[]): void => {
          listener(...args);
          listener(...args);
          response.removeListener(event, wrapper);
        };
        return response.on(event, wrapper);
      }) as typeof response.once;
    }
    callback(response);
    state.abortDuringRequest?.abort();
    return request;
  }),
}));

import { daemonJsonResponse } from "../../src/daemon/http-url.js";
import { DaemonClient } from "../../src/daemon/client.js";

afterEach(() => {
  state.request = undefined;
  state.response = undefined;
  state.throwRequest = undefined;
  state.abortDuringRequest = undefined;
  state.repeatEnd = false;
  vi.restoreAllMocks();
});

describe("abortable daemon transport", () => {
  it("does not send a pre-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(daemonJsonResponse(1234, "/health", { method: "GET", signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(state.request).toBeUndefined();
  });

  it("handles a signal that aborts while request setup is in progress", async () => {
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get: (() => {
        let reads = 0;
        return () => reads++ > 0;
      })(),
    });
    await expect(daemonJsonResponse(1234, "/health", { method: "GET", signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(state.request).toBeUndefined();

    const requestController = new AbortController();
    state.abortDuringRequest = requestController;
    const pending = daemonJsonResponse(1234, "/health", {
      method: "GET",
      signal: requestController.signal,
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(state.request?.end).not.toHaveBeenCalled();
  });

  it("ignores a duplicate response end after settlement", async () => {
    state.repeatEnd = true;
    const pending = daemonJsonResponse(1234, "/health", { method: "GET" });
    state.response?.emit("end");
    await expect(pending).resolves.toMatchObject({ statusCode: 200 });
  });

  it("destroys request and response once on mid-request abort and cleans listeners", async () => {
    const controller = new AbortController();
    const pending = daemonJsonResponse(1234, "/health", { method: "GET", signal: controller.signal });
    const request = state.request!;
    const response = state.response!;
    const requestOff = vi.spyOn(request, "off");
    const responseOff = vi.spyOn(response, "off");
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(request.destroy).toHaveBeenCalledOnce();
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(requestOff).toHaveBeenCalled();
    expect(responseOff).toHaveBeenCalled();
    expect(response.listenerCount("error")).toBe(0);
    response.emit("aborted");
    response.emit("end");
  });

  it("keeps timeout as a transport error rather than AbortError", async () => {
    const pending = daemonJsonResponse(1234, "/health", { method: "GET", timeoutMs: 25 });
    const request = state.request!;
    request.timeoutCallback!();
    await expect(pending).rejects.toMatchObject({ message: "Daemon request timed out" });
    await expect(pending).rejects.not.toMatchObject({ name: "AbortError" });
    expect(request.destroy).toHaveBeenCalledOnce();
    request.timeoutCallback!();
  });

  it("cleans a synchronous request-construction failure", async () => {
    const failure = new Error("request setup failed");
    state.throwRequest = failure;
    await expect(daemonJsonResponse(1234, "/health", { method: "GET" })).rejects.toBe(failure);
    state.throwRequest = "non-error request failure";
    await expect(daemonJsonResponse(1234, "/health", { method: "GET" })).rejects.toThrow(/request failed/i);
  });

  it("uses removeListener when a transport has no off method", async () => {
    const controller = new AbortController();
    const pending = daemonJsonResponse(1234, "/health", { method: "GET", signal: controller.signal });
    const request = state.request!;
    const response = state.response!;
    Object.defineProperty(request, "off", { value: undefined });
    Object.defineProperty(response, "off", { value: undefined });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(request.listenerCount("error")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
  });

  it("threads optional signals through DaemonClient without changing legacy method calls", async () => {
    const client = new DaemonClient("http://127.0.0.1:1234");
    const post = vi.spyOn(client, "post").mockResolvedValue({ ok: true });
    const signal = new AbortController().signal;
    await expect(client.post("/status", {}, { signal })).resolves.toEqual({ ok: true });
    expect(post).toHaveBeenCalledWith("/status", {}, { signal });
    post.mockRestore();
  });

  it("rethrows intentional health cancellation and exposes typed control helpers", async () => {
    const client = new DaemonClient("http://127.0.0.1:1234");
    const controller = new AbortController();
    const health = client.health({ signal: controller.signal });
    controller.abort();
    await expect(health).rejects.toMatchObject({ name: "AbortError" });

    const post = vi.spyOn(client, "post").mockResolvedValue({
      invocationId: "22222222-2222-4222-8222-222222222222",
      command: "compact",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
      state: "active",
      activeCount: 0,
    });
    const input = {
      invocationId: "22222222-2222-4222-8222-222222222222",
      command: "compact" as const,
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    };
    await client.startInvocation(input);
    await client.heartbeatInvocation(input);
    await client.cancelInvocation(input);
    await client.finishInvocation(input);
    expect(post.mock.calls.map(call => (call[1] as Record<string, unknown>).action)).toEqual([
      "start",
      "heartbeat",
      "cancel",
      "finish",
    ]);
    post.mockRestore();
  });
});
