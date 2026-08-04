/**
 * The transport-level result of a bounded health request.
 *
 * This type is intentionally independent of the daemon's private health body
 * shape. Callers provide a validator/extractor for their own body type and
 * therefore do not have to make that type part of this transport module.
 */

export type HealthObservationBodyState = "valid" | "invalid" | "timeout";

/** Reasons that are safe to expose in lifecycle diagnostics. */
export type HealthNoResponseReason =
  | "fetch-rejected"
  | "header-timeout"
  | "aborted-before-headers";

/** Reasons for a response whose body could not be admitted as valid. */
export type HealthResponseReason =
  | "unexpected-status"
  | "body-rejected"
  | "body-invalid"
  | "body-timeout"
  | "aborted-after-headers"
  | "invalid-status";

/**
 * A monotonic observation of whether an HTTP response existed.
 *
 * `no-response` is deliberately narrow: it is only returned when the fetch
 * operation rejects or the request is interrupted before fetch resolves. Once
 * fetch resolves, this value can never be changed back to `no-response`.
 */
export type HealthObservation<T = unknown> =
  | {
    kind: "no-response";
    reason: HealthNoResponseReason;
  }
  | {
    kind: "response";
    status: number;
    body: HealthObservationBodyState;
    parsedBody?: T;
    reason?: HealthResponseReason;
  };

/** A caller-owned body validator and optional extractor. */
export type HealthBodyValidator<T> = (
  body: unknown,
  response: Response,
) => T | undefined;

/** Timer seams are intentionally handle-agnostic for deterministic tests. */
export type HealthSetTimeout = (callback: () => void, delayMs: number) => unknown;
export type HealthClearTimeout = (handle: unknown) => void;

export type ObserveHealthOptions<T = unknown> = Readonly<{
  /** URL or Request passed to the injected fetch implementation. */
  input: RequestInfo | URL;
  /** Fetch seam. Defaults to the global fetch implementation. */
  fetchFn?: typeof globalThis.fetch;
  /** Bounded time waiting for fetch to resolve with response headers. */
  headerTimeoutMs?: number;
  /** Bounded time waiting for the response body to complete. */
  bodyTimeoutMs?: number;
  /** Optional shorthand used for both phases when phase-specific bounds match. */
  timeoutMs?: number;
  /** Request options; its signal is observed when `signal` is omitted. */
  requestInit?: RequestInit;
  /** Optional caller interruption signal. */
  signal?: AbortSignal;
  /** Timer seams used for both phases. */
  setTimeoutFn?: HealthSetTimeout;
  clearTimeoutFn?: HealthClearTimeout;
  /**
   * Validates and/or extracts the parsed JSON body. Returning `undefined` or
   * throwing marks the response body invalid; thrown values are never exposed.
   */
  validateBody?: HealthBodyValidator<T>;
}>;

/** Maximum delay accepted by the Node timer API without overflow. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const ALLOWED_STATUS_MIN = 200;
const ALLOWED_STATUS_MAX = 299;
const STAGED_STORAGE_UNAVAILABLE_STATUS = 503;

const DEFAULT_SET_TIMEOUT: HealthSetTimeout = (callback, delayMs) => setTimeout(callback, delayMs);
const DEFAULT_CLEAR_TIMEOUT: HealthClearTimeout = (handle) => {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
};

const DEFAULT_TIMEOUT_MS = 5_000;

const HEADER_TIMEOUT = Symbol("health-header-timeout");
const HEADER_ABORT = Symbol("health-header-abort");
const BODY_TIMEOUT = Symbol("health-body-timeout");
const BODY_ABORT = Symbol("health-body-abort");

type HeaderRace<T> =
  | { kind: "response"; response: T }
  | { kind: "rejected" }
  | typeof HEADER_TIMEOUT
  | typeof HEADER_ABORT;

type BodyRace<T> =
  | { kind: "body"; body: T }
  | { kind: "rejected" }
  | typeof BODY_TIMEOUT
  | typeof BODY_ABORT;

function boundedDelay(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_TIMER_DELAY_MS);
}

function safeStatus(response: Response): number {
  try {
    const status = response.status;
    return Number.isFinite(status) && Number.isInteger(status) && status >= 0
      ? status
      : 0;
  } catch {
    return 0;
  }
}

function statusAllowsBody(status: number): boolean {
  return (status >= ALLOWED_STATUS_MIN && status <= ALLOWED_STATUS_MAX)
    || status === STAGED_STORAGE_UNAVAILABLE_STATUS;
}

function requestSignal(requestInit: RequestInit | undefined): AbortSignal | undefined {
  return requestInit?.signal ?? undefined;
}

/**
 * Observe a bounded HTTP health exchange without collapsing body failures into
 * a transport/no-response result.
 */
export async function observeHttpHealth<T = unknown>(
  options: ObserveHealthOptions<T>,
): Promise<HealthObservation<T>> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const setTimeoutFn = options.setTimeoutFn ?? DEFAULT_SET_TIMEOUT;
  const clearTimeoutFn = options.clearTimeoutFn ?? DEFAULT_CLEAR_TIMEOUT;
  const requestInit = options.requestInit;
  const callerSignal = options.signal ?? requestSignal(requestInit);
  const headerTimeoutMs = options.headerTimeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // A pre-aborted caller must not invoke fetch. This check also ensures a
  // caller cannot turn an already-cancelled request into a competing process
  // admission attempt.
  if (callerSignal?.aborted) {
    return { kind: "no-response", reason: "aborted-before-headers" };
  }

  const controller = new AbortController();
  let phase: "headers" | "body" | "complete" = "headers";
  let headerTimer: unknown;
  let bodyTimer: unknown;
  let callerListenerRemoved = false;

  const clearHeaderTimer = (): void => {
    try {
      clearTimeoutFn(headerTimer);
    } catch {
      // Cleanup is best effort; never let a hostile timer seam change the
      // already-latched transport outcome.
    }
  };
  const clearBodyTimer = (): void => {
    try {
      clearTimeoutFn(bodyTimer);
    } catch {
      // See clearHeaderTimer: bounded diagnostics must not expose seam errors.
    }
  };
  const abortRequest = (): void => {
    try {
      controller.abort();
    } catch {
      // Abort is an internal cancellation hint. The phase outcome remains
      // authoritative even if a test seam replaces the controller behavior.
    }
  };

  let resolveHeaderAbort!: (value: typeof HEADER_ABORT) => void;
  const headerAbort = new Promise<typeof HEADER_ABORT>((resolve) => {
    resolveHeaderAbort = resolve;
  });

  let resolveBodyAbort!: (value: typeof BODY_ABORT) => void;
  const bodyAbort = new Promise<typeof BODY_ABORT>((resolve) => {
    resolveBodyAbort = resolve;
  });

  const onCallerAbort = (): void => {
    if (phase === "headers") {
      abortRequest();
      resolveHeaderAbort(HEADER_ABORT);
    } else if (phase === "body") {
      abortRequest();
      resolveBodyAbort(BODY_ABORT);
    }
  };

  const removeCallerListener = (): void => {
    if (callerListenerRemoved || callerSignal === undefined) return;
    callerListenerRemoved = true;
    try {
      callerSignal.removeEventListener("abort", onCallerAbort);
    } catch {
      // Listener cleanup is best effort and cannot alter the already-latched
      // transport outcome.
    }
  };

  try {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  } catch {
    // A malformed signal cannot provide a reliable cancellation seam. Treat it
    // as a pre-header interruption and avoid invoking fetch.
    phase = "complete";
    return { kind: "no-response", reason: "aborted-before-headers" };
  }

  let resolveHeaderTimeout!: (value: typeof HEADER_TIMEOUT) => void;
  const headerTimeout = new Promise<typeof HEADER_TIMEOUT>((resolve) => {
    resolveHeaderTimeout = resolve;
  });
  try {
    headerTimer = setTimeoutFn((): void => {
      // The phase check makes this callback harmless if a fake timer delivers a
      // stale callback after fetch has already resolved.
      if (phase !== "headers") return;
      abortRequest();
      resolveHeaderTimeout(HEADER_TIMEOUT);
    }, boundedDelay(headerTimeoutMs));
  } catch {
    phase = "complete";
    abortRequest();
    removeCallerListener();
    return { kind: "no-response", reason: "header-timeout" };
  }

  let fetchPromise: Promise<Response>;
  try {
    // Calling the seam inside the try block distinguishes synchronous throws
    // from a normal rejected fetch without exposing the thrown value.
    fetchPromise = Promise.resolve(fetchFn(options.input, {
      ...requestInit,
      signal: controller.signal,
    }));
  } catch {
    // The assignment above cannot throw in normal JavaScript, but retaining a
    // rejected promise here keeps the synchronous seam fail-closed.
    fetchPromise = Promise.reject(new Error("fetch invocation failed"));
  }

  const fetched: Promise<HeaderRace<Response>> = fetchPromise.then(
    (response) => ({ kind: "response", response }),
    () => ({ kind: "rejected" }),
  );

  const headerResult: HeaderRace<Response> = await Promise.race([fetched, headerTimeout, headerAbort]);

  if (headerResult === HEADER_TIMEOUT) {
    phase = "complete";
    clearHeaderTimer();
    removeCallerListener();
    return { kind: "no-response", reason: "header-timeout" };
  }
  if (headerResult === HEADER_ABORT) {
    phase = "complete";
    clearHeaderTimer();
    removeCallerListener();
    return { kind: "no-response", reason: "aborted-before-headers" };
  }
  if (headerResult.kind === "rejected") {
    phase = "complete";
    clearHeaderTimer();
    removeCallerListener();
    return {
      kind: "no-response",
      reason: "fetch-rejected",
    };
  }

  // This is the monotonic latch. It occurs before status/body inspection and
  // before any caller abort or timer callback can reinterpret the outcome.
  phase = "body";
  clearHeaderTimer();
  const response = headerResult.response;
  const status = safeStatus(response);

  if (!statusAllowsBody(status)) {
    phase = "complete";
    removeCallerListener();
    return {
      kind: "response",
      status,
      body: "invalid",
      reason: status === 0 ? "invalid-status" : "unexpected-status",
    };
  }

  let resolveBodyTimeout!: (value: typeof BODY_TIMEOUT) => void;
  const bodyTimeout = new Promise<typeof BODY_TIMEOUT>((resolve) => {
    resolveBodyTimeout = resolve;
  });
  try {
    bodyTimer = setTimeoutFn((): void => {
      if (phase !== "body") return;
      abortRequest();
      resolveBodyTimeout(BODY_TIMEOUT);
    }, boundedDelay(bodyTimeoutMs));
  } catch {
    phase = "complete";
    abortRequest();
    removeCallerListener();
    return { kind: "response", status, body: "timeout", reason: "body-timeout" };
  }

  let bodyPromise: Promise<unknown>;
  try {
    // Calling `.json()` inside the try block captures a synchronous throw from
    // a fake Response object, while a real Response remains fully supported.
    bodyPromise = Promise.resolve(response.json());
  } catch {
    bodyPromise = Promise.reject(new Error("response body failed"));
  }
  const parsed: Promise<BodyRace<unknown>> = bodyPromise.then(
    (body) => ({ kind: "body", body }),
    () => ({ kind: "rejected" }),
  );

  const bodyResult: BodyRace<unknown> = await Promise.race([parsed, bodyTimeout, bodyAbort]);

  if (bodyResult === BODY_TIMEOUT) {
    phase = "complete";
    clearBodyTimer();
    removeCallerListener();
    return { kind: "response", status, body: "timeout", reason: "body-timeout" };
  }
  if (bodyResult === BODY_ABORT) {
    phase = "complete";
    clearBodyTimer();
    removeCallerListener();
    return { kind: "response", status, body: "invalid", reason: "aborted-after-headers" };
  }
  if (bodyResult.kind === "rejected") {
    phase = "complete";
    clearBodyTimer();
    removeCallerListener();
    return {
      kind: "response",
      status,
      body: "invalid",
      reason: "body-rejected",
    };
  }

  clearBodyTimer();
  removeCallerListener();
  phase = "complete";

  if (options.validateBody === undefined) {
    return { kind: "response", status, body: "valid", parsedBody: bodyResult.body as T };
  }

  try {
    const parsedBody = options.validateBody(bodyResult.body, response);
    if (parsedBody === undefined) {
      return { kind: "response", status, body: "invalid", reason: "body-invalid" };
    }
    return { kind: "response", status, body: "valid", parsedBody };
  } catch {
    return { kind: "response", status, body: "invalid", reason: "body-rejected" };
  }
}
