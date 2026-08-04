import { describe, expect, it, vi } from "vitest";
import {
  observeHttpHealth,
  type HealthClearTimeout,
  type HealthSetTimeout,
} from "../../src/daemon/health-observation.js";

type Timer = {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
};

function timerSeams(): {
  timers: Timer[];
  setTimeoutFn: HealthSetTimeout;
  clearTimeoutFn: HealthClearTimeout;
  fire: (index: number) => void;
} {
  const timers: Timer[] = [];
  const setTimeoutFn: HealthSetTimeout = (callback, delayMs): Timer => {
    const timer: Timer = { callback, delayMs, cleared: false };
    timers.push(timer);
    return timer;
  };
  const clearTimeoutFn: HealthClearTimeout = (handle): void => {
    (handle as Timer).cleared = true;
  };
  return {
    timers,
    setTimeoutFn,
    clearTimeoutFn,
    fire: (index: number): void => timers[index]!.callback(),
  };
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("observeHttpHealth", () => {
  it("returns a validated body and clears both phase timers and the abort listener", async () => {
    const timers = timerSeams();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return fakeResponse(200, { status: "ok", pid: 42 });
    });

    await expect(observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn,
      headerTimeoutMs: 20,
      bodyTimeoutMs: 30,
      signal: caller.signal,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      validateBody: (body) => {
        if (typeof body !== "object" || body === null || (body as { status?: unknown }).status !== "ok") {
          return undefined;
        }
        return { pid: (body as { pid: number }).pid };
      },
    })).resolves.toEqual({
      kind: "response",
      status: 200,
      body: "valid",
      parsedBody: { pid: 42 },
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(timers.timers.map((timer) => timer.delayMs)).toEqual([20, 30]);
    expect(timers.timers.every((timer) => timer.cleared)).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("uses the injected global fetch and native timer defaults when no seams are supplied", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(200, { status: "ok" }));
    vi.stubGlobal("fetch", fetchFn);
    try {
      await expect(observeHttpHealth({
        input: "http://127.0.0.1:3737/health",
      })).resolves.toEqual({
        kind: "response",
        status: 200,
        body: "valid",
        parsedBody: { status: "ok" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("accepts 503 staged-storage responses and parses them without a validator", async () => {
    const timers = timerSeams();
    await expect(observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn: vi.fn().mockResolvedValue(fakeResponse(503, { status: "unavailable" })),
      timeoutMs: 40,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    })).resolves.toEqual({
      kind: "response",
      status: 503,
      body: "valid",
      parsedBody: { status: "unavailable" },
    });
    expect(timers.timers.map((timer) => timer.delayMs)).toEqual([40, 40]);
  });

  it("keeps a non-2xx/non-503 status as a response without reading its body", async () => {
    const timers = timerSeams();
    const json = vi.fn(async () => ({ status: "bad" }));
    await expect(observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn: vi.fn().mockResolvedValue({ status: 401, json } as unknown as Response),
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    })).resolves.toEqual({
      kind: "response",
      status: 401,
      body: "invalid",
      reason: "unexpected-status",
    });
    expect(json).not.toHaveBeenCalled();
    expect(timers.timers).toHaveLength(1);
    expect(timers.timers[0]!.cleared).toBe(true);
  });

  it("classifies a malformed status getter as a response with bounded invalid status", async () => {
    const timers = timerSeams();
    const response = {
      get status(): number { throw new Error("secret status"); },
      json: vi.fn(),
    } as unknown as Response;
    await expect(observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn: vi.fn().mockResolvedValue(response),
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    })).resolves.toEqual({
      kind: "response",
      status: 0,
      body: "invalid",
      reason: "invalid-status",
    });
    expect(response.json).not.toHaveBeenCalled();
  });

  it("classifies a non-finite numeric status as invalid without reading the body", async () => {
    const timers = timerSeams();
    const response = { status: Number.NaN, json: vi.fn() } as unknown as Response;
    await expect(observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn: vi.fn().mockResolvedValue(response),
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    })).resolves.toEqual({
      kind: "response",
      status: 0,
      body: "invalid",
      reason: "invalid-status",
    });
  });

  it.each([
    ["fetch rejection", async () => Promise.reject(new Error("secret transport detail"))],
    ["fetch synchronous throw", () => { throw new Error("secret synchronous detail"); }],
  ])("returns no-response for %s and never leaks the thrown value", async (_name, makeFetch) => {
    const timers = timerSeams();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const result = await observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn: makeFetch as typeof globalThis.fetch,
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      signal: caller.signal,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    expect(result).toEqual({ kind: "no-response", reason: "fetch-rejected" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(timers.timers[0]!.cleared).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("returns no-response before fetch when the caller is already aborted", async () => {
    const caller = new AbortController();
    caller.abort();
    const fetchFn = vi.fn();
    const timers = timerSeams();
    await expect(observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn,
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      signal: caller.signal,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    })).resolves.toEqual({ kind: "no-response", reason: "aborted-before-headers" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(timers.timers).toHaveLength(0);
  });

  it("returns no-response on a caller abort before headers and removes its listener", async () => {
    const headers = deferred<Response>();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const timers = timerSeams();
    const run = observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn: vi.fn(() => headers.promise),
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      signal: caller.signal,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    caller.abort();
    await expect(run).resolves.toEqual({ kind: "no-response", reason: "aborted-before-headers" });
    expect(timers.timers[0]!.cleared).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    headers.resolve(fakeResponse(200, {}));
  });

  it("returns no-response when the header deadline fires before fetch resolves", async () => {
    const headers = deferred<Response>();
    const timers = timerSeams();
    let requestSignal!: AbortSignal;
    const run = observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init!.signal!;
        return headers.promise;
      }),
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    timers.fire(0);
    await expect(run).resolves.toEqual({ kind: "no-response", reason: "header-timeout" });
    expect(requestSignal.aborted).toBe(true);
    expect(timers.timers[0]!.cleared).toBe(true);
    headers.resolve(fakeResponse(200, {}));
  });

  it("keeps a post-header caller abort as a response", async () => {
    const body = deferred<unknown>();
    const caller = new AbortController();
    const timers = timerSeams();
    const run = observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn: vi.fn().mockResolvedValue({ status: 200, json: vi.fn(() => body.promise) } as unknown as Response),
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      signal: caller.signal,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    await settleMicrotasks();
    caller.abort();
    await expect(run).resolves.toEqual({
      kind: "response",
      status: 200,
      body: "invalid",
      reason: "aborted-after-headers",
    });
    expect(timers.timers[0]!.cleared).toBe(true);
    expect(timers.timers[1]!.cleared).toBe(true);
    body.resolve({ status: "ok" });
  });

  it("classifies a body timeout as a response and aborts the request body", async () => {
    const body = deferred<unknown>();
    const timers = timerSeams();
    let requestSignal!: AbortSignal;
    const run = observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init!.signal!;
        return Promise.resolve({ status: 200, json: vi.fn(() => body.promise) } as unknown as Response);
      }),
      headerTimeoutMs: 10,
      bodyTimeoutMs: 20,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    await settleMicrotasks();
    timers.fire(1);
    await expect(run).resolves.toEqual({
      kind: "response",
      status: 200,
      body: "timeout",
      reason: "body-timeout",
    });
    expect(requestSignal.aborted).toBe(true);
    expect(timers.timers[1]!.cleared).toBe(true);
    body.resolve({ status: "ok" });
  });

  it("keeps a JSON rejection as a response", async () => {
    const timers = timerSeams();
    const response = { status: 200, json: vi.fn(() => { throw new Error("secret body"); }) } as unknown as Response;
    await expect(observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn: vi.fn().mockResolvedValue(response),
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    })).resolves.toEqual({
      kind: "response",
      status: 200,
      body: "invalid",
      reason: "body-rejected",
    });
    expect(JSON.stringify(response)).not.toContain("secret");
    expect(timers.timers[1]!.cleared).toBe(true);
  });

  it("keeps a validator rejection and malformed body as bounded response outcomes", async () => {
    const invalid = timerSeams();
    await expect(observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn: vi.fn().mockResolvedValue(fakeResponse(200, { status: "not-ok" })),
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      setTimeoutFn: invalid.setTimeoutFn,
      clearTimeoutFn: invalid.clearTimeoutFn,
      validateBody: () => undefined,
    })).resolves.toEqual({
      kind: "response",
      status: 200,
      body: "invalid",
      reason: "body-invalid",
    });

    const rejected = timerSeams();
    await expect(observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn: vi.fn().mockResolvedValue(fakeResponse(200, {})),
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      setTimeoutFn: rejected.setTimeoutFn,
      clearTimeoutFn: rejected.clearTimeoutFn,
      validateBody: () => { throw new Error("secret validator detail"); },
    })).resolves.toEqual({
      kind: "response",
      status: 200,
      body: "invalid",
      reason: "body-rejected",
    });
  });

  it("uses a request-init signal when no explicit signal is supplied", async () => {
    const caller = new AbortController();
    const timers = timerSeams();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    await expect(observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      requestInit: { signal: caller.signal },
      fetchFn: vi.fn().mockResolvedValue(fakeResponse(200, {})),
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    })).resolves.toMatchObject({ kind: "response", body: "valid" });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));

    const noSignal = timerSeams();
    await expect(observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      requestInit: { signal: null },
      fetchFn: vi.fn().mockResolvedValue(fakeResponse(200, {})),
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      setTimeoutFn: noSignal.setTimeoutFn,
      clearTimeoutFn: noSignal.clearTimeoutFn,
    })).resolves.toMatchObject({ kind: "response", body: "valid" });
  });

  it("ignores an abort callback that runs after the response lifecycle is complete", async () => {
    const callbacks: Array<() => void> = [];
    const signal = {
      aborted: false,
      addEventListener: (_type: string, callback: () => void): void => { callbacks.push(callback); },
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const timers = timerSeams();
    await expect(observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      signal,
      fetchFn: vi.fn().mockResolvedValue(fakeResponse(200, {})),
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    })).resolves.toMatchObject({ kind: "response", body: "valid" });
    expect(callbacks).toHaveLength(1);
    callbacks[0]!();
  });

  it("keeps cleanup and timer-seam throws secret-free", async () => {
    const clearTimeoutFn: HealthClearTimeout = () => { throw new Error("secret cleanup"); };
    await expect(observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn: vi.fn().mockResolvedValue(fakeResponse(200, {})),
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      setTimeoutFn: ((callback) => ({ callback })) as HealthSetTimeout,
      clearTimeoutFn,
    })).resolves.toMatchObject({ kind: "response", body: "valid" });

    const headerTimerThrows: HealthSetTimeout = () => { throw new Error("secret timer"); };
    await expect(observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn: vi.fn(),
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      setTimeoutFn: headerTimerThrows,
      clearTimeoutFn,
    })).resolves.toEqual({ kind: "no-response", reason: "header-timeout" });

    let timerCount = 0;
    const bodyTimerThrows: HealthSetTimeout = (callback) => {
      timerCount++;
      if (timerCount === 2) throw new Error("secret body timer");
      return { callback };
    };
    await expect(observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn: vi.fn().mockResolvedValue(fakeResponse(200, {})),
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
      setTimeoutFn: bodyTimerThrows,
      clearTimeoutFn,
    })).resolves.toEqual({
      kind: "response",
      status: 200,
      body: "timeout",
      reason: "body-timeout",
    });
  });

  it("fails closed when a signal listener cannot be installed", async () => {
    const signal = {
      aborted: false,
      addEventListener: (): void => { throw new Error("secret listener"); },
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const fetchFn = vi.fn();
    await expect(observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      signal,
      fetchFn,
      headerTimeoutMs: 10,
      bodyTimeoutMs: 10,
    })).resolves.toEqual({ kind: "no-response", reason: "aborted-before-headers" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("keeps a throwing AbortController bounded when a timer requests cancellation", async () => {
    const OriginalAbortController = globalThis.AbortController;
    const actual = new OriginalAbortController();
    class ThrowingAbortController {
      readonly signal = actual.signal;
      abort(): void { throw new Error("secret abort detail"); }
    }
    vi.stubGlobal("AbortController", ThrowingAbortController);
    try {
      const headers = deferred<Response>();
      const timers = timerSeams();
      const run = observeHttpHealth({
        input: "http://127.0.0.1:3737/health",
        fetchFn: vi.fn(() => headers.promise),
        headerTimeoutMs: 10,
        bodyTimeoutMs: 10,
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
      });
      timers.fire(0);
      await expect(run).resolves.toEqual({ kind: "no-response", reason: "header-timeout" });
    } finally {
      vi.stubGlobal("AbortController", OriginalAbortController);
    }
  });

  it("ignores stale phase callbacks after the response has latched", async () => {
    const timers = timerSeams();
    const result = await observeHttpHealth({
      input: "http://127.0.0.1:3737/health",
      fetchFn: vi.fn().mockResolvedValue(fakeResponse(200, {})),
      headerTimeoutMs: -1,
      bodyTimeoutMs: Number.POSITIVE_INFINITY,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    expect(result).toMatchObject({ kind: "response", body: "valid" });
    expect(timers.timers.map((timer) => timer.delayMs)).toEqual([0, 0]);
    timers.fire(0);
    timers.fire(1);
    expect(result).toMatchObject({ kind: "response", body: "valid" });
  });
});
