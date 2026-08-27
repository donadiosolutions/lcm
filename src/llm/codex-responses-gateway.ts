import { randomBytes as defaultRandomBytes } from "node:crypto";
import {
  createServer as defaultCreateServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

const LOOPBACK_HOST = "127.0.0.1";
const CAPABILITY_BYTES = 32;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_HEADER_VALUE_BYTES = 16 * 1024;
const MAX_MODEL_BYTES = 256;
const MAX_AUTH_BYTES = 16 * 1024;
const MAX_ACCOUNT_BYTES = 256;
const GENERIC_ERROR = "codex responses gateway request failed\n";
const OUTCOME_ERROR = "codex responses gateway did not complete";
const CHATGPT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

const REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const REASONING_SUMMARIES = new Set(["none", "auto", "concise", "detailed"]);
const REASONING_CONTEXTS = new Set(["current_turn", "all_turns"]);
const SERVICE_TIERS = new Set(["default", "fast", "priority", "flex"]);

/**
 * Headers Codex 0.149.1 attaches to Responses requests.  This list is
 * intentionally explicit: arbitrary caller headers never cross the gateway.
 */
const CODEX_METADATA_HEADERS = [
  "x-openai-fedramp",
  "originator",
  "x-client-request-id",
  "session-id",
  "thread-id",
  "x-codex-installation-id",
  "x-codex-routing-hint",
  "x-codex-turn-state",
  "x-codex-turn-metadata",
  "x-codex-parent-thread-id",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-openai-subagent",
  "x-codex-beta-features",
  "x-openai-internal-codex-responses-lite",
] as const;

type FetchFn = typeof fetch;
type RandomBytesFn = typeof defaultRandomBytes;
type CreateServerFn = typeof defaultCreateServer;

export type CodexResponsesGatewayOptions = {
  /** The complete immutable LCM summarizer prompt for this compaction call. */
  prompt: string;
  /** @internal fixed local upstream used only by real HTTP tests. */
  _upstreamUrl?: string;
  /** @internal per-route fixed local upstreams used only by real HTTP tests. */
  _upstreamUrls?: Partial<{ chatgpt: string; api: string }>;
  /** @internal dependency seams used only by deterministic lifecycle tests. */
  _fetch?: FetchFn;
  /** @internal dependency seams used only by deterministic lifecycle tests. */
  _createServer?: CreateServerFn;
  /** @internal dependency seams used only by deterministic lifecycle tests. */
  _randomBytes?: RandomBytesFn;
};

export type CodexResponsesGateway = {
  /** Base URL ending at the private capability path; append `/responses`. */
  readonly baseUrl: string;
  /** Exact private capability path, without `/responses`. */
  readonly capabilityPath: string;
  /** True only after one route, body, and managed-auth request was accepted. */
  readonly requestAccepted: boolean;
  /** True only after the complete successful upstream SSE stream was relayed. */
  readonly requestCompleted: boolean;
  /** Wait for the one accepted request and complete upstream stream. */
  waitForCompletion(): Promise<void>;
  /** Stop listening, abort active upstream requests, and await closure. */
  close(): Promise<void>;
};

type PlainRecord = Record<string, unknown>;

type ManagedAuthorization = {
  header: string;
  token: string;
  route: "api" | "chatgpt";
};

class GatewayInputError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(GENERIC_ERROR.trim());
    this.statusCode = statusCode;
  }
}

function genericError(): Error {
  return new Error(OUTCOME_ERROR);
}

function isPlainObject(value: unknown): value is PlainRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasRawDuplicateHeader(request: IncomingMessage, name: string): boolean {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count > 1;
}

function rejectDuplicateRequestHeaders(request: IncomingMessage): void {
  const names = [
    "authorization",
    "chatgpt-account-id",
    "content-encoding",
    "content-length",
    ...CODEX_METADATA_HEADERS,
  ];
  if (names.some((name) => hasRawDuplicateHeader(request, name))) {
    throw new GatewayInputError(400);
  }
}

function boundedHeader(value: string | undefined, maxBytes: number): string | undefined {
  if (value === undefined || value.length === 0 || value.length > maxBytes) {
    return undefined;
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    return undefined;
  }
  return value;
}

function requireAuthorization(headers: IncomingHttpHeaders): ManagedAuthorization {
  const value = boundedHeader(
    typeof headers.authorization === "string" ? headers.authorization : undefined,
    MAX_AUTH_BYTES,
  );
  if (value === undefined || !/^Bearer [^\s,]+$/u.test(value)) {
    throw new GatewayInputError(400);
  }
  const token = value.slice("Bearer ".length);
  return {
    header: value,
    token,
    route: token.startsWith("sk-") ? "api" : "chatgpt",
  };
}

function optionalAccountId(headers: IncomingHttpHeaders): string | undefined {
  const raw = typeof headers["chatgpt-account-id"] === "string"
    ? headers["chatgpt-account-id"]
    : undefined;
  if (raw === undefined) return undefined;
  const value = boundedHeader(raw, MAX_ACCOUNT_BYTES);
  if (value === undefined || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new GatewayInputError(400);
  }
  return value;
}

function validateRequestEncoding(headers: IncomingHttpHeaders): void {
  const encoding = typeof headers["content-encoding"] === "string"
    ? headers["content-encoding"]
    : undefined;
  if (encoding !== undefined && encoding.toLowerCase() !== "identity") {
    throw new GatewayInputError(400);
  }
}

function responsesLiteEnabled(headers: IncomingHttpHeaders): boolean {
  const raw = headers["x-openai-internal-codex-responses-lite"];
  if (raw === undefined) return false;
  if (Array.isArray(raw) || raw !== "true") throw new GatewayInputError(400);
  return true;
}

function validateContentLength(headers: IncomingHttpHeaders): number | undefined {
  const raw = typeof headers["content-length"] === "string"
    ? headers["content-length"]
    : undefined;
  if (raw === undefined) return undefined;
  if (!/^\d+$/u.test(raw)) {
    throw new GatewayInputError(413);
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES) {
    throw new GatewayInputError(413);
  }
  return length;
}

async function readRequestBody(request: IncomingMessage, declaredLength: number | undefined): Promise<string> {
  if (declaredLength === 0) {
    request.resume();
    throw new GatewayInputError(400);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_BODY_BYTES) {
        request.resume();
        throw new GatewayInputError(413);
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof GatewayInputError) throw error;
    throw new GatewayInputError(400);
  }

  if (declaredLength !== undefined && total !== declaredLength) {
    throw new GatewayInputError(400);
  }
  const body = Buffer.concat(chunks);
  if (body.length === 0) {
    throw new GatewayInputError(400);
  }
  return body.toString("utf8");
}

function parseRequestBody(raw: string): PlainRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new GatewayInputError(400);
  }
  if (!isPlainObject(parsed)) {
    throw new GatewayInputError(400);
  }
  return parsed;
}

function boundedModel(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GatewayInputError(400);
  }
  const model = value.trim();
  if (Buffer.byteLength(model, "utf8") > MAX_MODEL_BYTES || /[\u0000-\u001f\u007f-\u009f]/u.test(model)) {
    throw new GatewayInputError(400);
  }
  return model;
}

function validatedReasoning(value: unknown): PlainRecord | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new GatewayInputError(400);

  const reasoning: PlainRecord = {};
  if (value.effort !== undefined) {
    if (typeof value.effort !== "string" || !REASONING_EFFORTS.has(value.effort)) {
      throw new GatewayInputError(400);
    }
    reasoning.effort = value.effort;
  }
  if (value.summary !== undefined) {
    if (typeof value.summary !== "string" || !REASONING_SUMMARIES.has(value.summary)) {
      throw new GatewayInputError(400);
    }
    reasoning.summary = value.summary;
  }
  if (value.context !== undefined) {
    if (typeof value.context !== "string" || !REASONING_CONTEXTS.has(value.context)) {
      throw new GatewayInputError(400);
    }
    reasoning.context = value.context;
  }
  return Object.keys(reasoning).length > 0 ? reasoning : undefined;
}

function validatedServiceTier(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SERVICE_TIERS.has(value)) {
    throw new GatewayInputError(400);
  }
  return value;
}

function buildPayload(prompt: string, input: PlainRecord, responsesLite = false): PlainRecord {
  const model = boundedModel(input.model);
  const reasoning = validatedReasoning(input.reasoning);
  const serviceTier = validatedServiceTier(input.service_tier);
  const payload: PlainRecord = {
    model,
    input: responsesLite
      ? [
          { type: "additional_tools", role: "developer", tools: [] },
          { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
        ]
      : [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        }],
    tool_choice: "none",
    parallel_tool_calls: false,
    store: false,
    stream: true,
  };
  if (!responsesLite) payload.tools = [];
  if (reasoning !== undefined) payload.reasoning = reasoning;
  if (serviceTier !== undefined) payload.service_tier = serviceTier;
  return payload;
}

function canonicalMetadataHeader(name: typeof CODEX_METADATA_HEADERS[number]): string {
  return name;
}

function buildUpstreamHeaders(
  headers: IncomingHttpHeaders,
  authorization: ManagedAuthorization,
  accountId: string | undefined,
): Record<string, string> {
  const outbound: Record<string, string> = {
    Authorization: authorization.header,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    "Accept-Encoding": "identity",
  };
  if (accountId !== undefined) outbound["ChatGPT-Account-Id"] = accountId;

  for (const name of CODEX_METADATA_HEADERS) {
    const raw = typeof headers[name] === "string" ? headers[name] : undefined;
    if (raw === undefined) continue;
    const value = boundedHeader(raw, MAX_HEADER_VALUE_BYTES);
    if (value === undefined) throw new GatewayInputError(400);
    outbound[canonicalMetadataHeader(name)] = value;
  }
  return outbound;
}

function upstreamUrlFor(
  authorization: ManagedAuthorization,
  options: CodexResponsesGatewayOptions,
): string {
  if (options._upstreamUrl !== undefined) return options._upstreamUrl;
  if (authorization.route === "chatgpt") return options._upstreamUrls?.chatgpt ?? CHATGPT_RESPONSES_URL;
  return options._upstreamUrls?.api ?? OPENAI_RESPONSES_URL;
}

function sendError(response: ServerResponse, statusCode: number): void {
  if (response.writableEnded || response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(GENERIC_ERROR);
}

function safeResponseHeader(value: string | null, maxBytes = 512): string | undefined {
  if (value === null || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) return undefined;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return undefined;
  return value;
}

function isSseContentType(value: string): boolean {
  return /^text\/event-stream(?:\s*;|\s*$)/iu.test(value);
}

async function writeChunk(
  response: ServerResponse,
  chunk: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed) throw genericError();
  if (response.write(chunk)) return;

  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      response.removeListener("drain", onDrain);
      response.removeListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve();
    };
    const onDrain = (): void => finish();
    const onClose = (): void => finish(genericError());
    const onAbort = (): void => finish(genericError());
    response.once("drain", onDrain);
    response.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted || response.destroyed) finish(genericError());
  });
}

async function relaySse(
  upstreamBody: ReadableStream<Uint8Array>,
  downstream: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  const reader = upstreamBody.getReader();
  try {
    while (true) {
      if (signal.aborted) throw genericError();
      const result = await reader.read();
      if (result.done) return;
      await writeChunk(downstream, result.value, signal);
    }
  } catch {
    throw genericError();
  } finally {
    reader.releaseLock();
  }
}

async function cancelUpstreamBody(body: ReadableStream<Uint8Array> | null | undefined): Promise<void> {
  if (body === null || body === undefined) return;
  try {
    await body.cancel();
  } catch {
    // The abort signal is the primary cancellation mechanism. A body that is
    // already errored or locked is safely discarded when its request closes.
  }
}

function listen(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.on("error", onError);
    server.on("listening", onListening);
    try {
      server.listen({ host: LOOPBACK_HOST, port: 0 });
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      server.close((error?: Error) => {
        if (error) reject(error); else resolve();
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Start one private, immutable loopback Responses gateway for one compaction call. */
export async function createCodexResponsesGateway(
  options: CodexResponsesGatewayOptions,
): Promise<CodexResponsesGateway> {
  if (typeof options.prompt !== "string" || options.prompt.length === 0) {
    throw new Error("codex responses gateway startup failed");
  }

  const createServer = options._createServer ?? defaultCreateServer;
  const randomBytes = options._randomBytes ?? defaultRandomBytes;
  const fetchImpl = options._fetch ?? fetch;
  let capability: string;
  try {
    capability = randomBytes(CAPABILITY_BYTES).toString("base64url");
    if (!/^[A-Za-z0-9_-]{40,}$/u.test(capability)) throw new Error("capability generation failed");
  } catch {
    throw new Error("codex responses gateway startup failed");
  }
  let server: Server;

  let requestSeen = false;
  let requestAccepted = false;
  let requestCompleted = false;
  let closed = false;
  let completionSettled = false;
  let closePromise: Promise<void> | undefined;
  const activeControllers = new Set<AbortController>();
  let settleCompletion!: (value?: void | PromiseLike<void>) => void;
  let rejectCompletion!: (reason?: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    settleCompletion = resolve;
    rejectCompletion = reject;
  });
  // The process path observes this promise through waitForCompletion(), but
  // malformed/replayed requests can fail before a caller has a chance to
  // await it. Keep the original promise rejectable while suppressing an
  // unhandled-rejection event for those early failures.
  void completion.catch(() => undefined);
  const failCompletion = (): void => {
    if (completionSettled) return;
    completionSettled = true;
    rejectCompletion(genericError());
  };
  const finishCompletion = (): void => {
    completionSettled = true;
    settleCompletion();
  };

  const endpointPath = `/${capability}/responses`;
  const capabilityPath = `/${capability}`;
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (closed) {
      request.resume();
      sendError(response, 503);
      return;
    }
    if (request.url !== endpointPath) {
      request.resume();
      sendError(response, 404);
      return;
    }
    if (request.method !== "POST") {
      request.resume();
      sendError(response, 405);
      return;
    }
    if (requestSeen) {
      request.resume();
      sendError(response, 409);
      return;
    }
    requestSeen = true;

    const controller = new AbortController();
    activeControllers.add(controller);
    const onResponseClose = (): void => {
      if (!response.writableEnded) controller.abort();
    };
    const onRequestClose = (): void => {
      if (!request.complete) controller.abort();
    };
    response.on("close", onResponseClose);
    request.on("aborted", onRequestClose);
    request.on("close", onRequestClose);

    let bodyReadAttempted = false;
    let upstreamBody: ReadableStream<Uint8Array> | null | undefined;
    try {
      rejectDuplicateRequestHeaders(request);
      validateRequestEncoding(request.headers);
      const declaredLength = validateContentLength(request.headers);
      const authorization = requireAuthorization(request.headers);
      const accountId = optionalAccountId(request.headers);
      const responsesLite = responsesLiteEnabled(request.headers);
      bodyReadAttempted = true;
      const body = parseRequestBody(await readRequestBody(request, declaredLength));
      const payload = buildPayload(options.prompt, body, responsesLite);
      const headers = buildUpstreamHeaders(request.headers, authorization, accountId);
      requestAccepted = true;

      let upstream: Response;
      try {
        upstream = await fetchImpl(upstreamUrlFor(authorization, options), {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw new GatewayInputError(502);
      }
      upstreamBody = upstream.body;
      if (!upstream.ok) {
        throw new GatewayInputError(502);
      }
      if (upstream.body === null) {
        throw new GatewayInputError(502);
      }

      const rawContentType = upstream.headers.get("content-type");
      const contentType = safeResponseHeader(rawContentType);
      if (rawContentType !== null && (contentType === undefined || !isSseContentType(contentType))) {
        throw new GatewayInputError(502);
      }
      response.statusCode = upstream.status;
      response.setHeader("Content-Type", contentType ?? "text/event-stream");
      const cacheControl = safeResponseHeader(upstream.headers.get("cache-control"));
      if (cacheControl !== undefined) response.setHeader("Cache-Control", cacheControl);
      await relaySse(upstream.body, response, controller.signal);
      upstreamBody = null;
      if (!response.writableEnded) response.end();
      requestCompleted = true;
      finishCompletion();
    } catch (error) {
      if (!bodyReadAttempted) {
        try {
          request.resume();
        } catch {
          // Keep the generic validation error even if draining the socket fails.
        }
      }
      controller.abort();
      await cancelUpstreamBody(upstreamBody);
      failCompletion();
      sendError(response, error instanceof GatewayInputError ? error.statusCode : 502);
    } finally {
      response.removeListener("close", onResponseClose);
      request.removeListener("aborted", onRequestClose);
      request.removeListener("close", onRequestClose);
      activeControllers.delete(controller);
    }
  };

  try {
    server = createServer((request, response) => {
      void handleRequest(request, response);
    });
  } catch {
    throw new Error("codex responses gateway startup failed");
  }

  try {
    await listen(server);
  } catch {
    try {
      server.close();
      server.closeAllConnections();
    } catch {
      // Startup is already failed; no credential or request data is exposed.
    }
    throw new Error("codex responses gateway startup failed");
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    try {
      server.close();
      server.closeAllConnections();
    } catch {
      // Startup is already failed.
    }
    throw new Error("codex responses gateway startup failed");
  }

  const gateway: CodexResponsesGateway = {
    baseUrl: `http://${LOOPBACK_HOST}:${address.port}${capabilityPath}`,
    capabilityPath,
    get requestAccepted() {
      return requestAccepted;
    },
    get requestCompleted() {
      return requestCompleted;
    },
    waitForCompletion: () => completion,
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closePromise = (async () => {
        closed = true;
        for (const controller of activeControllers) controller.abort();

        let connectionCloseError: unknown;
        // Call close before closeAllConnections; this is the required Node
        // lifecycle ordering while still preventing a stuck keep-alive.
        const serverClose = closeServer(server);
        try {
          server.closeAllConnections();
        } catch (error) {
          connectionCloseError = error;
        }
        let serverCloseError: unknown;
        try {
          await serverClose;
        } catch (error) {
          serverCloseError = error;
        }
        failCompletion();
        const closeError = serverCloseError ?? connectionCloseError;
        if (closeError !== undefined) {
          throw closeError instanceof Error ? closeError : new Error(String(closeError));
        }
      })();
      return closePromise;
    },
  };

  return gateway;
}

/** Compatibility alias for callers that describe startup as `start`. */
export const startCodexResponsesGateway = createCodexResponsesGateway;

/** Internal seams used by focused coverage tests; not part of the package API. */
export const __codexResponsesGatewayTestUtils = {
  boundedHeader,
  isPlainObject,
  hasRawDuplicateHeader,
  validateRequestEncoding,
  responsesLiteEnabled,
  validateContentLength,
  readRequestBody,
  parseRequestBody,
  boundedModel,
  validatedReasoning,
  validatedServiceTier,
  buildPayload,
  buildUpstreamHeaders,
  upstreamUrlFor,
  sendError,
  safeResponseHeader,
  isSseContentType,
  writeChunk,
  relaySse,
  listen,
  closeServer,
};
