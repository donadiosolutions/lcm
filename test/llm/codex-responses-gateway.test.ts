import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter, once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __codexResponsesGatewayTestUtils,
  createCodexResponsesGateway,
  type CodexResponsesGateway,
} from "../../src/llm/codex-responses-gateway.js";

const PROMPT = "SYSTEM: summarize only\n\nUSER: transcript text";
const COMPLETED_SSE = [
  "event: response.completed",
  'data: {"type":"response.completed","response":{"status":"completed"}}',
  "",
  "",
].join("\n");
const FIRST_DELTA_SSE = [
  "event: response.output_text.delta",
  'data: {"type":"response.output_text.delta","delta":"first"}',
  "",
  "",
].join("\n");
const SECOND_DELTA_SSE = [
  "event: response.output_text.delta",
  'data: {"type":"response.output_text.delta","delta":"second"}',
  "",
  "",
].join("\n");
const LITE_DELTA_SSE = [
  "event: response.output_text.delta",
  'data: {"type":"response.output_text.delta","delta":"lite-ok"}',
  "",
  "",
].join("\n");

type Capture = {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url: string;
};

const gateways: CodexResponsesGateway[] = [];
const upstreams: ReturnType<typeof createServer>[] = [];

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("upstream did not expose a TCP address");
  return `http://127.0.0.1:${address.port}/v1/responses`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function validBody(model = "gpt-5.4"): string {
  return JSON.stringify({ model, input: [], tools: [], stream: true });
}

async function fetchGateway(
  gateway: CodexResponsesGateway,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${gateway.baseUrl}/responses`, {
    ...init,
    method: "POST",
    headers: { Authorization: "Bearer test-token", ...(init.headers ?? {}) },
    body: validBody(),
  });
}

async function listenSimpleUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const server = createServer(handler);
  upstreams.push(server);
  return { server, url: await listen(server) };
}

async function rawRequest(
  target: string,
  options: { method: string; headers?: Record<string, string | string[]>; body?: string | Buffer },
): Promise<{ status: number; body: string }> {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("error", reject);
    });
    request.on("error", reject);
    if (options.body !== undefined) request.end(options.body);
    else request.end();
  });
}

type FakeServer = EventEmitter & {
  listen: (options: unknown) => void;
  address: () => { address: string; family: string; port: number } | null;
  close: (callback?: (error?: Error) => void) => void;
  closeAllConnections: () => void;
};

type FakeResponse = EventEmitter & {
  writableEnded: boolean;
  destroyed: boolean;
  headersSent: boolean;
  statusCode?: number;
  write: (chunk: Uint8Array) => boolean;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
  destroy: () => void;
};

function makeFakeResponse(writeResult = true): FakeResponse {
  const response = new EventEmitter() as FakeResponse;
  response.writableEnded = false;
  response.destroyed = false;
  response.headersSent = false;
  response.write = vi.fn(() => writeResult);
  response.setHeader = vi.fn();
  response.end = vi.fn(() => { response.writableEnded = true; });
  response.destroy = vi.fn(() => { response.destroyed = true; });
  return response;
}

function makeFakeServer(options: {
  address?: { address: string; family: string; port: number } | null;
  listenError?: Error;
  closeError?: Error;
  closeAllError?: Error;
  calls?: string[];
} = {}): FakeServer {
  const server = new EventEmitter() as FakeServer;
  server.listen = () => {
    options.calls?.push("listen");
    setImmediate(() => {
      if (options.listenError) server.emit("error", options.listenError);
      else server.emit("listening");
    });
  };
  server.address = () => options.address === undefined
    ? { address: "127.0.0.1", family: "IPv4", port: 40123 }
    : options.address;
  server.close = (callback) => {
    options.calls?.push("close");
    callback?.(options.closeError);
  };
  server.closeAllConnections = () => {
    options.calls?.push("closeAllConnections");
    if (options.closeAllError) throw options.closeAllError;
  };
  return server;
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const upstream of upstreams.splice(0)) {
    if (upstream.listening) {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  }
});

describe("Codex Responses zero-tools gateway", () => {
  it("covers bounded parsing and allowlists at their explicit edges", async () => {
    const utils = __codexResponsesGatewayTestUtils;
    expect(utils.isPlainObject(null)).toBe(false);
    expect(utils.isPlainObject("text")).toBe(false);
    expect(utils.isPlainObject([])).toBe(false);
    expect(utils.isPlainObject({})).toBe(true);
    expect(utils.isPlainObject(Object.create(null))).toBe(true);
    expect(utils.boundedHeader(undefined, 4)).toBeUndefined();
    expect(utils.boundedHeader("", 4)).toBeUndefined();
    expect(utils.boundedHeader("12345", 4)).toBeUndefined();
    expect(utils.boundedHeader("é", 1)).toBeUndefined();
    expect(utils.boundedHeader("bad\nvalue", 20)).toBeUndefined();
    expect(utils.boundedHeader("good", 4)).toBe("good");
    expect(() => utils.parseRequestBody("bad")).toThrow();
    expect(() => utils.parseRequestBody("null")).toThrow();
    expect(() => utils.parseRequestBody("[]")).toThrow();
    expect(utils.parseRequestBody("{}"));
    expect(() => utils.boundedModel(undefined)).toThrow();
    expect(() => utils.boundedModel(42)).toThrow();
    expect(() => utils.boundedModel(" ")).toThrow();
    expect(() => utils.boundedModel("bad\nmodel")).toThrow();
    expect(() => utils.boundedModel("x".repeat(257))).toThrow();
    expect(utils.boundedModel(" gpt-5.4 ")).toBe("gpt-5.4");

    expect(utils.validatedReasoning(undefined)).toBeUndefined();
    expect(() => utils.validatedReasoning("bad")).toThrow();
    expect(utils.validatedReasoning({ unknown: "drop" })).toBeUndefined();
    expect(utils.validatedReasoning({ effort: "high" })).toEqual({ effort: "high" });
    expect(utils.validatedReasoning({ summary: "auto" })).toEqual({ summary: "auto" });
    expect(utils.validatedReasoning({ context: "current_turn" })).toEqual({ context: "current_turn" });
    expect(() => utils.validatedReasoning({ effort: "bad" })).toThrow();
    expect(() => utils.validatedReasoning({ summary: "bad" })).toThrow();
    expect(() => utils.validatedReasoning({ context: "bad" })).toThrow();
    expect(utils.validatedServiceTier(undefined)).toBeUndefined();
    expect(utils.validatedServiceTier("default")).toBe("default");
    expect(() => utils.validatedServiceTier("bad")).toThrow();
    expect(utils.buildPayload("prompt", { model: "gpt-5.4" })).toMatchObject({
      model: "gpt-5.4",
      tools: [],
      tool_choice: "none",
    });

    const headers = {
      authorization: "Bearer token",
      "chatgpt-account-id": "acct-1",
      "x-client-request-id": "request-1",
    };
    const chatAuthorization = { header: "Bearer token", token: "token", route: "chatgpt" as const };
    const apiAuthorization = { header: "Bearer sk-test", token: "sk-test", route: "api" as const };
    const outbound = utils.buildUpstreamHeaders(headers, chatAuthorization, "acct-1");
    expect(outbound).toMatchObject({
      Authorization: "Bearer token",
      "ChatGPT-Account-Id": "acct-1",
      "x-client-request-id": "request-1",
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
    });
    expect(utils.upstreamUrlFor(chatAuthorization, { prompt: "x", _upstreamUrl: "http://test/one" })).toBe("http://test/one");
    expect(utils.upstreamUrlFor(chatAuthorization, { prompt: "x", _upstreamUrls: { chatgpt: "http://test/chat" } })).toBe("http://test/chat");
    expect(utils.upstreamUrlFor(apiAuthorization, { prompt: "x", _upstreamUrls: { api: "http://test/api" } })).toBe("http://test/api");
    expect(utils.upstreamUrlFor(chatAuthorization, { prompt: "x" })).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(utils.upstreamUrlFor(apiAuthorization, { prompt: "x" })).toBe("https://api.openai.com/v1/responses");
    expect(utils.safeResponseHeader(null)).toBeUndefined();
    expect(utils.safeResponseHeader("")).toBeUndefined();
    expect(utils.safeResponseHeader("x".repeat(513))).toBeUndefined();
    expect(utils.safeResponseHeader("bad\nvalue")).toBeUndefined();
    expect(utils.safeResponseHeader("no-cache")).toBe("no-cache");
    expect(utils.isSseContentType("text/event-stream")).toBe(true);
    expect(utils.isSseContentType("text/event-stream; charset=utf-8")).toBe(true);
    expect(utils.isSseContentType("application/json")).toBe(false);

    const bodyRequest = (chunks: Array<string | Buffer>): IncomingMessage => {
      const request = new EventEmitter() as IncomingMessage;
      Object.assign(request, {
        resume: vi.fn(),
        [Symbol.asyncIterator]: async function* () {
          for (const chunk of chunks) yield chunk;
        },
      });
      return request;
    };
    await expect(utils.readRequestBody(bodyRequest(["{}"]) , 2)).resolves.toBe("{}");
    await expect(utils.readRequestBody(bodyRequest([]), 0)).rejects.toThrow();
    await expect(utils.readRequestBody(bodyRequest([]), undefined)).rejects.toThrow();
    await expect(utils.readRequestBody(bodyRequest(["{}"]), 3)).rejects.toThrow();
    const failingRequest = new EventEmitter() as IncomingMessage;
    Object.assign(failingRequest, {
      resume: vi.fn(),
      [Symbol.asyncIterator]: async function* () { throw new Error("stream failure"); },
    });
    await expect(utils.readRequestBody(failingRequest, undefined)).rejects.toThrow();
    expect(utils.validateContentLength({})).toBeUndefined();
    expect(() => utils.validateContentLength({ "content-length": "bad" })).toThrow();
    expect(() => utils.validateContentLength({ "content-length": "9007199254740992" })).toThrow();
    expect(utils.validateContentLength({ "content-length": "2" })).toBe(2);
    expect(() => utils.validateRequestEncoding({ "content-encoding": "gzip" })).toThrow();
    expect(() => utils.validateRequestEncoding({ "content-encoding": "identity" })).not.toThrow();
    expect(() => utils.buildUpstreamHeaders({ "x-client-request-id": "x".repeat(16 * 1024 + 1) }, chatAuthorization, undefined)).toThrow();
    expect(utils.responsesLiteEnabled({})).toBe(false);
    expect(utils.responsesLiteEnabled({ "x-openai-internal-codex-responses-lite": "true" })).toBe(true);
    expect(() => utils.responsesLiteEnabled({ "x-openai-internal-codex-responses-lite": "false" })).toThrow();
    expect(() => utils.responsesLiteEnabled({ "x-openai-internal-codex-responses-lite": ["true"] })).toThrow();
    expect(utils.buildPayload("prompt", { model: "gpt-5.4" }, true)).toMatchObject({
      input: [
        { type: "additional_tools", role: "developer", tools: [] },
        { type: "message", role: "user" },
      ],
    });
  });

  it("covers backpressure, abort, and safe error response paths", async () => {
    const utils = __codexResponsesGatewayTestUtils;
    const signal = new AbortController().signal;
    const direct = makeFakeResponse(true);
    await expect(utils.writeChunk(direct as unknown as ServerResponse, new Uint8Array([1]), signal)).resolves.toBeUndefined();
    const destroyed = makeFakeResponse(true);
    destroyed.destroyed = true;
    await expect(utils.writeChunk(destroyed as unknown as ServerResponse, new Uint8Array([1]), signal)).rejects.toThrow();
    const abortedController = new AbortController();
    abortedController.abort();
    await expect(utils.writeChunk(makeFakeResponse(true) as unknown as ServerResponse, new Uint8Array([1]), abortedController.signal)).rejects.toThrow();

    const draining = makeFakeResponse(false);
    const drainPromise = utils.writeChunk(draining as unknown as ServerResponse, new Uint8Array([1]), signal);
    draining.emit("drain");
    await expect(drainPromise).resolves.toBeUndefined();
    const closing = makeFakeResponse(false);
    const closePromise = utils.writeChunk(closing as unknown as ServerResponse, new Uint8Array([1]), signal);
    closing.emit("close");
    await expect(closePromise).rejects.toThrow();
    const abortingController = new AbortController();
    const aborting = makeFakeResponse(false);
    const abortPromise = utils.writeChunk(aborting as unknown as ServerResponse, new Uint8Array([1]), abortingController.signal);
    abortingController.abort();
    await expect(abortPromise).rejects.toThrow();
    const destroyedAfterWrite = makeFakeResponse(false);
    destroyedAfterWrite.write = vi.fn(() => {
      destroyedAfterWrite.destroyed = true;
      return false;
    });
    await expect(utils.writeChunk(destroyedAfterWrite as unknown as ServerResponse, new Uint8Array([1]), signal)).rejects.toThrow();

    const relayFailure = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("stream failure"));
      },
    });
    await expect(utils.relaySse(
      relayFailure,
      makeFakeResponse(true) as unknown as ServerResponse,
      signal,
    )).rejects.toThrow();
    const endedResponse = makeFakeResponse(true);
    endedResponse.writableEnded = true;
    const endedRelay = await utils.relaySse(
      new Response(new TextEncoder().encode(COMPLETED_SSE)).body as ReadableStream<Uint8Array>,
      endedResponse as unknown as ServerResponse,
      signal,
    );
    expect(endedRelay).toBeUndefined();

    await expect(utils.relaySse(
      new Response(COMPLETED_SSE).body as ReadableStream<Uint8Array>,
      makeFakeResponse(true) as unknown as ServerResponse,
      signal,
    )).resolves.toBeUndefined();
    const relayAbort = new AbortController();
    relayAbort.abort();
    await expect(utils.relaySse(
      new Response("ok").body as ReadableStream<Uint8Array>,
      makeFakeResponse(true) as unknown as ServerResponse,
      relayAbort.signal,
    )).rejects.toThrow();

    const untouched = makeFakeResponse(true);
    untouched.writableEnded = true;
    utils.sendError(untouched as unknown as ServerResponse, 400);
    const destroyedResponse = makeFakeResponse(true);
    destroyedResponse.destroyed = true;
    utils.sendError(destroyedResponse as unknown as ServerResponse, 400);
    const sent = makeFakeResponse(true);
    sent.headersSent = true;
    utils.sendError(sent as unknown as ServerResponse, 400);
    const normal = makeFakeResponse(true);
    utils.sendError(normal as unknown as ServerResponse, 400);
    expect(normal.statusCode).toBe(400);
    expect(normal.end).toHaveBeenCalledWith("codex responses gateway request failed\n");
  });

  it("covers settled startup events and non-Error lifecycle failures", async () => {
    const utils = __codexResponsesGatewayTestUtils;
    const server = makeFakeServer();
    await utils.listen(server as never);
    server.emit("error", new Error("late error"));
    server.emit("listening");
    const badListen = makeFakeServer();
    badListen.listen = () => { throw "bad listen"; };
    await expect(utils.listen(badListen as never)).rejects.toThrow("bad listen");
    const badListenError = makeFakeServer();
    badListenError.listen = () => { throw new Error("bad listen error"); };
    await expect(utils.listen(badListenError as never)).rejects.toThrow("bad listen error");
    const badClose = makeFakeServer();
    badClose.close = () => { throw "bad close"; };
    await expect(utils.closeServer(badClose as never)).rejects.toThrow("bad close");
    const badCloseError = makeFakeServer();
    badCloseError.close = () => { throw new Error("bad close error"); };
    await expect(utils.closeServer(badCloseError as never)).rejects.toThrow("bad close error");
    const callbackString = makeFakeServer();
    callbackString.close = (callback) => callback?.("close callback" as unknown as Error);
    await expect(utils.closeServer(callbackString as never)).rejects.toThrow("close callback");
  });

  it("parses semantic terminal SSE events across field variants and bounds buffered input", () => {
    const utils = __codexResponsesGatewayTestUtils;
    const encoder = new TextEncoder();
    expect(utils.classifyResponsesSseEvent("", "")).toBe("pending");
    expect(utils.classifyResponsesSseEvent("other", "not-json")).toBe("failed");
    expect(utils.classifyResponsesSseEvent("other", "[]")).toBe("failed");
    expect(utils.classifyResponsesSseEvent("other", '{"type":42}')).toBe("failed");
    expect(utils.classifyResponsesSseEvent(
      "",
      '{"type":"response.completed","response":{"status":"completed"}}',
    )).toBe("completed");
    expect(utils.classifyResponsesSseEvent(
      "response.completed",
      '{"type":"response.completed","response":{"status":"completed","error":null}}',
    )).toBe("completed");
    expect(utils.classifyResponsesSseEvent(
      "other",
      '{"type":"response.completed","response":{"status":"completed"}}',
    )).toBe("failed");
    expect(utils.classifyResponsesSseEvent(
      "response.completed",
      '{"type":"response.completed","response":[]}',
    )).toBe("failed");
    expect(utils.classifyResponsesSseEvent(
      "response.completed",
      '{"type":"response.completed","response":{"status":"failed"}}',
    )).toBe("failed");

    const multiline = utils.createResponsesSseObserver();
    multiline.observe(encoder.encode([
      "event:response.completed",
      'data:{"type":"response.completed",',
      'data:"response":{"status":"completed"}}',
      "",
      "",
    ].join("\n")));
    expect(multiline.terminalState).toBe("completed");

    const carriageReturns = utils.createResponsesSseObserver();
    carriageReturns.observe(encoder.encode(
      'event: response.completed\rdata: {"type":"response.completed","response":{"status":"completed"}}\r\r',
    ));
    expect(carriageReturns.terminalState).toBe("completed");

    const splitCrLf = utils.createResponsesSseObserver();
    splitCrLf.observe(encoder.encode(": first\r"));
    splitCrLf.observe(encoder.encode("\n"));
    expect(splitCrLf.finish()).toBe("pending");

    const splitCarriageReturn = utils.createResponsesSseObserver();
    splitCarriageReturn.observe(encoder.encode(": first\r"));
    splitCarriageReturn.observe(encoder.encode(": second\r\r"));
    expect(splitCarriageReturn.finish()).toBe("pending");

    const terminalSuffix = utils.createResponsesSseObserver();
    terminalSuffix.observe(encoder.encode(`${COMPLETED_SSE}post-terminal`));
    expect(terminalSuffix.terminalState).toBe("failed");

    const partial = utils.createResponsesSseObserver();
    partial.observe(encoder.encode(": ignored\n\n"));
    expect(partial.finish()).toBe("pending");

    const oversizedChunk = utils.createResponsesSseObserver();
    expect(() => oversizedChunk.observe(encoder.encode(`event:${"x".repeat(1024 * 1024 + 1)}`))).toThrow(
      "codex responses gateway did not complete",
    );

    const oversizedLine = utils.createResponsesSseObserver();
    const linePart = "x".repeat(600 * 1024);
    oversizedLine.observe(encoder.encode(`event:${linePart}`));
    expect(() => oversizedLine.observe(encoder.encode(linePart))).toThrow(
      "codex responses gateway did not complete",
    );

    const oversizedData = utils.createResponsesSseObserver();
    const dataPart = "x".repeat(512 * 1024);
    oversizedData.observe(encoder.encode(`event: response.completed\ndata: ${dataPart}\n`));
    expect(() => oversizedData.observe(encoder.encode(`data: ${dataPart}\n`))).toThrow(
      "codex responses gateway did not complete",
    );

    const invalidUtf8 = utils.createResponsesSseObserver();
    invalidUtf8.observe(new Uint8Array([0xc3]));
    expect(() => invalidUtf8.finish()).toThrow();
    expect(() => utils.flushResponsesSseDecoder({ decode: () => "post-terminal" })).toThrow(
      "codex responses gateway did not complete",
    );
  });

  it("ends terminal relay without entering ordinary backpressure or awaiting upstream cancellation", async () => {
    const utils = __codexResponsesGatewayTestUtils;
    const encoder = new TextEncoder();
    const signal = new AbortController().signal;

    const backpressured = makeFakeResponse(false);
    await expect(utils.relaySse(
      new Response(encoder.encode(COMPLETED_SSE)).body as ReadableStream<Uint8Array>,
      backpressured as unknown as ServerResponse,
      signal,
    )).resolves.toBeUndefined();
    expect(backpressured.write).not.toHaveBeenCalled();
    expect(backpressured.end).toHaveBeenCalledWith(encoder.encode(COMPLETED_SSE));

    let cancelCalled = false;
    let releaseCancel: (() => void) | undefined;
    const untrustedCancel = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(COMPLETED_SSE));
      },
      cancel() {
        cancelCalled = true;
        return new Promise<void>((resolve) => { releaseCancel = resolve; });
      },
    });
    let settled = false;
    const abortUpstream = vi.fn();
    const cancellationRelay = utils.relaySse(
      untrustedCancel,
      makeFakeResponse(true) as unknown as ServerResponse,
      signal,
      undefined,
      abortUpstream,
    ).then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(settled).toBe(true);
      expect(cancelCalled).toBe(true);
      expect(abortUpstream).toHaveBeenCalledOnce();
    } finally {
      releaseCancel?.();
    }
    await cancellationRelay;

    const rejectingCancel = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(COMPLETED_SSE));
      },
      cancel() {
        return Promise.reject(new Error("cancel rejected"));
      },
    });
    await expect(utils.relaySse(
      rejectingCancel,
      makeFakeResponse(true) as unknown as ServerResponse,
      signal,
    )).resolves.toBeUndefined();
    await new Promise<void>((resolve) => setImmediate(resolve));

    let queuedSuffixCancelled = false;
    const queuedSuffix = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(COMPLETED_SSE));
        controller.enqueue(new Uint8Array([0xc3]));
      },
      cancel() {
        queuedSuffixCancelled = true;
      },
    });
    const terminalOnlyResponse = makeFakeResponse(true);
    await expect(utils.relaySse(
      queuedSuffix,
      terminalOnlyResponse as unknown as ServerResponse,
      signal,
    )).resolves.toBeUndefined();
    expect(terminalOnlyResponse.end).toHaveBeenCalledWith(encoder.encode(COMPLETED_SSE));
    expect(queuedSuffixCancelled).toBe(true);
  });

  it("keeps semantic completion when downstream close fires synchronously during terminal end", async () => {
    let handler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
    const fakeServer = makeFakeServer();
    const gateway = await createCodexResponsesGateway({
      prompt: PROMPT,
      _fetch: async () => new Response(COMPLETED_SSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      _createServer: ((requestHandler) => {
        handler = requestHandler;
        return fakeServer;
      }) as unknown as typeof createServer,
    });
    gateways.push(gateway);
    const requestBody = validBody();
    const request = new EventEmitter() as IncomingMessage;
    Object.assign(request, {
      resume: vi.fn(),
      url: `${gateway.capabilityPath}/responses`,
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-length": String(Buffer.byteLength(requestBody)),
      },
      rawHeaders: [
        "Authorization", "Bearer test-token",
        "Content-Length", String(Buffer.byteLength(requestBody)),
      ],
      complete: true,
      [Symbol.asyncIterator]: async function* () { yield requestBody; },
    });
    const response = makeFakeResponse(true);
    response.end = vi.fn(() => {
      response.emit("close");
      response.writableEnded = true;
    });

    handler?.(request, response as unknown as ServerResponse);

    await expect(gateway.waitForCompletion()).resolves.toBeUndefined();
    expect(gateway.requestCompleted).toBe(true);
    expect(response.end).toHaveBeenCalledOnce();
  });

  it("rewrites a hostile Codex request to one exact zero-tools Responses payload and relays split SSE bytes", async () => {
    let capture: Capture | undefined;
    const upstream = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const raw = await readBody(req);
      capture = {
        body: JSON.parse(raw) as unknown,
        headers: req.headers,
        method: req.method ?? "",
        url: req.url ?? "",
      };
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Set-Cookie", "must-not-be-relayed");
      res.write(FIRST_DELTA_SSE);
      setTimeout(() => {
        res.write(SECOND_DELTA_SSE);
        res.write(COMPLETED_SSE);
        res.end();
      }, 5);
    });
    upstreams.push(upstream);
    const upstreamUrl = await listen(upstream);

    const gateway = await createCodexResponsesGateway({ prompt: PROMPT, _upstreamUrl: upstreamUrl });
    gateways.push(gateway);
    expect(new URL(gateway.baseUrl).hostname).toBe("127.0.0.1");
    expect(new URL(gateway.baseUrl).pathname).toMatch(/^\/[A-Za-z0-9_-]{40,}\/?$/);

    const response = await fetch(`${gateway.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer managed-token",
        "ChatGPT-Account-Id": "acct_test_123",
        "X-OpenAI-Fedramp": "false",
        Originator: "codex_cli_rs",
        "X-Client-Request-Id": "request-123",
        "Session-Id": "session-123",
        "Thread-Id": "thread-123",
        "X-Codex-Installation-Id": "installation-123",
        "X-Codex-Routing-Hint": "model=gpt-5.4;tier=fast",
        "X-Codex-Turn-State": "turn-state-123",
        "X-Codex-Turn-Metadata": '{"request_kind":"compact"}',
        "X-Codex-Parent-Thread-Id": "parent-thread-123",
        "X-Codex-Window-Id": "window-123",
        "X-Oai-Attestation": "attestation-123",
        "X-OpenAI-Subagent": "compact",
        "X-Codex-Beta-Features": "feature-a,feature-b",
        "OpenAI-Beta": "responses=experimental",
        "X-ResponsesAPI-Include-Timing-Metrics": "must-not-forward",
        "X-Api-Key": "hostile-api-key",
        Cookie: "hostile-cookie",
        "X-Forwarded-For": "198.51.100.7",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        instructions: "ATTACK-INSTRUCTIONS",
        input: [{ role: "user", content: [{ type: "input_text", text: "ATTACK-INPUT" }] }],
        tools: Array.from({ length: 12 }, (_, index) => ({ type: "function", name: `tool-${index}` })),
        tool_choice: "auto",
        parallel_tool_calls: true,
        previous_response_id: "previous-secret",
        client_metadata: { secret: "metadata-secret" },
        prompt_cache_key: "cache-secret",
        unknown_field: "unknown-secret",
        reasoning: { effort: "high", summary: "auto", unknown: "drop-me" },
        service_tier: "fast",
        stream_options: { include_usage: true },
        include: ["message.output_text"],
      }),
    });

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(Buffer.from(bytes).toString("utf8")).toBe(`${FIRST_DELTA_SSE}${SECOND_DELTA_SSE}${COMPLETED_SSE}`);
    expect(capture).toBeDefined();
    expect(gateway.requestAccepted).toBe(true);
    expect(gateway.requestCompleted).toBe(true);
    expect(capture?.method).toBe("POST");
    expect(capture?.url).toBe("/v1/responses");
    expect(capture?.headers.authorization).toBe("Bearer managed-token");
    expect(capture?.headers["chatgpt-account-id"]).toBe("acct_test_123");
    expect(capture?.headers["x-openai-fedramp"]).toBe("false");
    expect(capture?.headers.originator).toBe("codex_cli_rs");
    expect(capture?.headers["x-client-request-id"]).toBe("request-123");
    expect(capture?.headers["session-id"]).toBe("session-123");
    expect(capture?.headers["thread-id"]).toBe("thread-123");
    expect(capture?.headers["x-codex-installation-id"]).toBe("installation-123");
    expect(capture?.headers["x-codex-routing-hint"]).toBe("model=gpt-5.4;tier=fast");
    expect(capture?.headers["x-codex-turn-state"]).toBe("turn-state-123");
    expect(capture?.headers["x-codex-turn-metadata"]).toBe('{"request_kind":"compact"}');
    expect(capture?.headers["x-codex-parent-thread-id"]).toBe("parent-thread-123");
    expect(capture?.headers["x-codex-window-id"]).toBe("window-123");
    expect(capture?.headers["x-oai-attestation"]).toBe("attestation-123");
    expect(capture?.headers["x-openai-subagent"]).toBe("compact");
    expect(capture?.headers["x-codex-beta-features"]).toBe("feature-a,feature-b");
    expect(capture?.headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
    expect(capture?.headers["openai-beta"]).toBeUndefined();
    expect(capture?.headers["x-responsesapi-include-timing-metrics"]).toBeUndefined();
    expect(capture?.headers["x-api-key"]).toBeUndefined();
    expect(capture?.headers.cookie).toBeUndefined();
    expect(capture?.headers["x-forwarded-for"]).toBeUndefined();

    const body = capture?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "input",
      "model",
      "parallel_tool_calls",
      "reasoning",
      "service_tier",
      "store",
      "stream",
      "tool_choice",
      "tools",
    ]);
    expect(body.model).toBe("gpt-5.4");
    expect(body.input).toEqual([{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: PROMPT }],
    }]);
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(body.service_tier).toBe("fast");
    expect(body.tools).toEqual([]);
    expect(body.tool_choice).toBe("none");
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/ATTACK|secret|cache|unknown|tool-\d|additional_tools|lite-hostile/);
  });

  it.each([
    [429, "usage"],
    [401, "authentication"],
    [400, undefined],
    [403, undefined],
    [404, undefined],
  ] as const)("latches only the safe upstream category for HTTP %s", async (status, category) => {
    const { url: upstreamUrl } = await listenSimpleUpstream((_req, res) => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end("GPT-5.3-Codex-Spark 4:27 AM Bearer upstream-secret");
    });
    const gateway = await createCodexResponsesGateway({ prompt: PROMPT, _upstreamUrl: upstreamUrl });
    gateways.push(gateway);

    const response = await fetchGateway(gateway);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("codex responses gateway request failed\n");
    expect(gateway.upstreamFailureCategory).toBe(category);
    expect(JSON.stringify({ status: response.status, body: "codex responses gateway request failed\n" }))
      .not.toContain("upstream-secret");
  });

  it("does not classify a network-level upstream failure", async () => {
    const gateway = await createCodexResponsesGateway({
      prompt: PROMPT,
      _upstreamUrl: "http://127.0.0.1:1/v1/responses",
    });
    gateways.push(gateway);
    const response = await fetchGateway(gateway);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("codex responses gateway request failed\n");
    expect(gateway.upstreamFailureCategory).toBeUndefined();
  });

  it("preserves Responses Lite dialect while replacing its hostile additional_tools input", async () => {
    let capture: Capture | undefined;
    const upstream = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      capture = {
        body: JSON.parse(await readBody(req)) as unknown,
        headers: req.headers,
        method: req.method ?? "",
        url: req.url ?? "",
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`${LITE_DELTA_SSE}${COMPLETED_SSE}`);
    });
    upstreams.push(upstream);
    const upstreamUrl = await listen(upstream);
    const gateway = await createCodexResponsesGateway({ prompt: PROMPT, _upstreamUrl: upstreamUrl });
    gateways.push(gateway);

    const response = await fetch(`${gateway.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer managed-token",
        "X-OpenAI-Internal-Codex-Responses-Lite": "true",
      },
      body: JSON.stringify({
        model: "gpt-5.6",
        instructions: "HOSTILE-LITE-INSTRUCTIONS",
        input: [{
          type: "additional_tools",
          role: "developer",
          tools: Array.from({ length: 12 }, (_, index) => ({
            type: "function",
            name: `lite-hostile-tool-${index}`,
          })),
        }],
        tools: Array.from({ length: 12 }, (_, index) => ({ type: "function", name: `tool-${index}` })),
        tool_choice: "auto",
        parallel_tool_calls: true,
        previous_response_id: "lite-previous-secret",
        client_metadata: { secret: "lite-metadata-secret" },
        prompt_cache_key: "lite-cache-secret",
        unknown_field: "lite-unknown-secret",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`${LITE_DELTA_SSE}${COMPLETED_SSE}`);
    expect(capture?.headers["x-openai-internal-codex-responses-lite"]).toBe("true");
    expect(capture?.headers.authorization).toBe("Bearer managed-token");
    const body = capture?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "input",
      "model",
      "parallel_tool_calls",
      "store",
      "stream",
      "tool_choice",
    ]);
    expect(body.model).toBe("gpt-5.6");
    expect(body.input).toEqual([
      { type: "additional_tools", role: "developer", tools: [] },
      { type: "message", role: "user", content: [{ type: "input_text", text: PROMPT }] },
    ]);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBe("none");
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/HOSTILE|lite-hostile|previous|metadata|cache|unknown/);
  });

  it.each([
    ["GET", "method"],
    ["POST", "query"],
    ["POST", "encoded-path"],
    ["POST", "second-use"],
  ])("rejects a hostile capability boundary (%s %s)", async (method, variant) => {
    let upstreamCalls = 0;
    const { url: upstreamUrl } = await listenSimpleUpstream((_req, res) => {
      upstreamCalls += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(COMPLETED_SSE);
    });
    const gateway = await createCodexResponsesGateway({ prompt: PROMPT, _upstreamUrl: upstreamUrl });
    gateways.push(gateway);

    let url = `${gateway.baseUrl}/responses`;
    if (variant === "query") url += "?x=1";
    if (variant === "encoded-path") url = `${gateway.baseUrl}/%72esponses`;
    if (variant === "second-use") {
      await expect(fetchGateway(gateway)).resolves.toMatchObject({ status: 200 });
      url = `${gateway.baseUrl}/responses`;
    }
    const response = await fetch(url, {
      method,
      headers: { Authorization: "Bearer test-token" },
      body: method === "POST" ? validBody() : undefined,
    });
    expect(response.status).toBe(variant === "method" ? 405 : variant === "second-use" ? 409 : 404);
    expect(await response.text()).toBe("codex responses gateway request failed\n");
    expect(upstreamCalls).toBe(variant === "second-use" ? 1 : 0);
  });

  it("rejects missing, malformed, duplicate, and incomplete managed auth", async () => {
    const { url: upstreamUrl } = await listenSimpleUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(COMPLETED_SSE);
    });
    const cases: Array<Record<string, string>> = [
      {},
      { Authorization: "Basic token" },
      { Authorization: "Bearer " },
      { Authorization: "Bearer token,other" },
      { Authorization: "Bearer token", "ChatGPT-Account-Id": "acct with spaces" },
      { Authorization: "Bearer token", "X-OpenAI-Internal-Codex-Responses-Lite": "false" },
      { Authorization: "Bearer token", "X-OpenAI-Internal-Codex-Responses-Lite": "TRUE" },
    ];
    for (const headers of cases) {
      const gateway = await createCodexResponsesGateway({ prompt: PROMPT, _upstreamUrl: upstreamUrl });
      gateways.push(gateway);
      const response = await fetch(`${gateway.baseUrl}/responses`, {
        method: "POST",
        headers,
        body: validBody(),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("codex responses gateway request failed\n");
      expect(gateway.requestAccepted).toBe(false);
    }
  });

  it("rejects malformed, compressed, empty, oversized, and mismatched-length bodies", async () => {
    const { url: upstreamUrl } = await listenSimpleUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(COMPLETED_SSE);
    });
    const cases: Array<{ headers?: Record<string, string>; body: string; status?: number }> = [
      { body: "not json" },
      { body: "[]" },
      { body: "", status: 400 },
      { headers: { "Content-Encoding": "gzip" }, body: validBody() },
      {
        headers: { "Content-Length": String(1024 * 1024 + 1) },
        body: "x".repeat(1024 * 1024 + 1),
        status: 413,
      },
    ];
    for (const item of cases) {
      const gateway = await createCodexResponsesGateway({ prompt: PROMPT, _upstreamUrl: upstreamUrl });
      gateways.push(gateway);
      const response = await fetch(`${gateway.baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: "Bearer test-token", ...(item.headers ?? {}) },
        body: item.body,
      });
      expect(response.status).toBe(item.status ?? 400);
      expect(await response.text()).toBe("codex responses gateway request failed\n");
    }
  });

  it("bounds chunked bodies and rejects duplicate managed headers", async () => {
    const { url: upstreamUrl } = await listenSimpleUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(COMPLETED_SSE);
    });
    const oversized = await createCodexResponsesGateway({ prompt: PROMPT, _upstreamUrl: upstreamUrl });
    gateways.push(oversized);
    const oversizedBody = "x".repeat(1024 * 1024 + 1);
    const oversizedResponse = await rawRequest(`${oversized.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Transfer-Encoding": "chunked" },
      body: oversizedBody,
    });
    expect(oversizedResponse.status).toBe(413);
    expect(oversizedResponse.body).toBe("codex responses gateway request failed\n");

    for (const headers of [
      { Authorization: ["Bearer one", "Bearer two"] },
      { Authorization: "Bearer one", "ChatGPT-Account-Id": ["acct-one", "acct-two"] },
      { Authorization: "Bearer one", "X-OpenAI-Internal-Codex-Responses-Lite": ["true", "true"] },
    ]) {
      const gateway = await createCodexResponsesGateway({ prompt: PROMPT, _upstreamUrl: upstreamUrl });
      gateways.push(gateway);
      const response = await rawRequest(`${gateway.baseUrl}/responses`, {
        method: "POST",
        headers,
        body: validBody(),
      });
      expect(response.status).toBe(400);
      expect(response.body).toBe("codex responses gateway request failed\n");
    }
  });

  it("preserves only validated reasoning controls and service tiers", async () => {
    const captured: string[] = [];
    const { url: upstreamUrl } = await listenSimpleUpstream(async (req, res) => {
      captured.push(await readBody(req));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(COMPLETED_SSE);
    });
    const valid = await createCodexResponsesGateway({ prompt: PROMPT, _upstreamUrl: upstreamUrl });
    gateways.push(valid);
    const validResponse = await fetch(`${valid.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Encoding": "identity" },
      body: JSON.stringify({
        model: " gpt-5.4 ",
        reasoning: { effort: "minimal", summary: "none", context: "all_turns", unknown: "drop" },
        service_tier: "priority",
      }),
    });
    expect(validResponse.status).toBe(200);
    const body = JSON.parse(captured[0]) as Record<string, unknown>;
    expect(body.model).toBe("gpt-5.4");
    expect(body.reasoning).toEqual({ effort: "minimal", summary: "none", context: "all_turns" });
    expect(body.service_tier).toBe("priority");

    const max = await createCodexResponsesGateway({ prompt: PROMPT, _upstreamUrl: upstreamUrl });
    gateways.push(max);
    const maxResponse = await fetch(`${max.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
      body: JSON.stringify({ model: "gpt-5.4", reasoning: { effort: "max" } }),
    });
    expect(maxResponse.status).toBe(200);
    const maxBody = JSON.parse(captured[1]) as Record<string, unknown>;
    expect(maxBody.reasoning).toEqual({ effort: "max" });

    for (const invalid of [
      { model: "" },
      { model: "gpt-5.4", reasoning: "invalid" },
      { model: "gpt-5.4", reasoning: { effort: "unsupported" } },
      { model: "gpt-5.4", reasoning: { summary: "unsupported" } },
      { model: "gpt-5.4", reasoning: { context: "unsupported" } },
      { model: "gpt-5.4", service_tier: "unsupported" },
      { model: "gpt-5.4", service_tier: "auto" },
      { model: "gpt-5.4", service_tier: "scale" },
    ]) {
      const gateway = await createCodexResponsesGateway({ prompt: PROMPT, _upstreamUrl: upstreamUrl });
      gateways.push(gateway);
      const response = await fetch(`${gateway.baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: "Bearer test-token" },
        body: JSON.stringify(invalid),
      });
      expect(response.status).toBe(400);
    }
  });

  it("routes ChatGPT account requests and API-key requests only to their fixed destinations", async () => {
    const seen: string[] = [];
    const { url: upstreamUrl } = await listenSimpleUpstream((req, res) => {
      seen.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(COMPLETED_SSE);
    });
    const chatGateway = await createCodexResponsesGateway({ prompt: PROMPT, _upstreamUrl: upstreamUrl });
    const apiGateway = await createCodexResponsesGateway({ prompt: PROMPT, _upstreamUrl: upstreamUrl });
    gateways.push(chatGateway, apiGateway);
    await expect(fetchGateway(chatGateway, { headers: { "ChatGPT-Account-Id": "acct-1" } })).resolves.toMatchObject({ status: 200 });
    await expect(fetchGateway(apiGateway, { headers: { Authorization: "Bearer sk-test-token" } })).resolves.toMatchObject({ status: 200 });
    expect(seen).toEqual(["/v1/responses", "/v1/responses"]);
  });

  it("selects the fixed ChatGPT or API endpoint and redirect-error fetch policy", async () => {
    const destinations: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      destinations.push(String(input));
      expect(init?.redirect).toBe("error");
      expect(init?.method).toBe("POST");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(COMPLETED_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const chatGateway = await createCodexResponsesGateway({ prompt: PROMPT, _fetch: fetchImpl });
    const apiGateway = await createCodexResponsesGateway({ prompt: PROMPT, _fetch: fetchImpl });
    gateways.push(chatGateway, apiGateway);
    await expect(fetchGateway(chatGateway, { headers: { "ChatGPT-Account-Id": "acct-1" } })).resolves.toMatchObject({ status: 200 });
    await expect(fetchGateway(apiGateway, { headers: { Authorization: "Bearer sk-test-token" } })).resolves.toMatchObject({ status: 200 });
    expect(destinations).toEqual([
      "https://chatgpt.com/backend-api/codex/responses",
      "https://api.openai.com/v1/responses",
    ]);
    const noContentType = await createCodexResponsesGateway({
      prompt: PROMPT,
      _fetch: async () => new Response(new TextEncoder().encode(COMPLETED_SSE), { status: 200 }),
    });
    gateways.push(noContentType);
    const noContentTypeResponse = await fetchGateway(noContentType);
    expect(noContentTypeResponse.status).toBe(200);
    expect(noContentTypeResponse.headers.get("content-type")).toMatch(/^text\/event-stream/);
  });

  it("classifies bearer credentials by API-key syntax before selecting the fixed route", async () => {
    const destinations: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      destinations.push(String(input));
      return new Response(COMPLETED_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const accountlessOAuth = await createCodexResponsesGateway({ prompt: PROMPT, _fetch: fetchImpl });
    const projectKey = await createCodexResponsesGateway({ prompt: PROMPT, _fetch: fetchImpl });
    const accountWithOpaque = await createCodexResponsesGateway({ prompt: PROMPT, _fetch: fetchImpl });
    gateways.push(accountlessOAuth, projectKey, accountWithOpaque);

    await expect(fetchGateway(accountlessOAuth, {
      headers: { Authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.opaque-chatgpt-token" },
    })).resolves.toMatchObject({ status: 200 });
    await expect(fetchGateway(projectKey, {
      headers: { Authorization: "Bearer sk-proj-test-key" },
    })).resolves.toMatchObject({ status: 200 });
    await expect(fetchGateway(accountWithOpaque, {
      headers: {
        Authorization: "Bearer opaque-chatgpt-token",
        "ChatGPT-Account-Id": "acct-with-opaque-token",
      },
    })).resolves.toMatchObject({ status: 200 });
    expect(destinations).toEqual([
      "https://chatgpt.com/backend-api/codex/responses",
      "https://api.openai.com/v1/responses",
      "https://chatgpt.com/backend-api/codex/responses",
    ]);
  });

  it("drains a request once when exact-path prevalidation fails before body consumption", async () => {
    let handler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
    const upstreamFetch = vi.fn<typeof fetch>();
    const fakeServer = makeFakeServer();
    const gateway = await createCodexResponsesGateway({
      prompt: PROMPT,
      _fetch: upstreamFetch,
      _createServer: ((requestHandler) => {
        handler = requestHandler;
        return fakeServer;
      }) as unknown as typeof createServer,
    });
    const request = new EventEmitter() as IncomingMessage;
    Object.assign(request, {
      resume: vi.fn(),
      url: `${gateway.capabilityPath}/responses`,
      method: "POST",
      headers: { authorization: "Bearer one" },
      rawHeaders: ["Authorization", "Bearer one", "Authorization", "Bearer two"],
      [Symbol.asyncIterator]: async function* () { throw new Error("body must not be read"); },
    });
    const response = makeFakeResponse(true);
    handler?.(request, response as unknown as ServerResponse);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(response.statusCode).toBe(400);
    expect(request.resume).toHaveBeenCalledOnce();
    expect(upstreamFetch).not.toHaveBeenCalled();
    await gateway.close();
  });

  it.each([401, 503])("does not expose upstream error bodies and rejects a replay after upstream %s", async (status) => {
    let calls = 0;
    const { url: upstreamUrl } = await listenSimpleUpstream((_req, res) => {
      calls += 1;
      res.writeHead(status, { "content-type": "text/plain" });
      res.end("UPSTREAM-TOKEN-SECRET");
    });
    const gateway = await createCodexResponsesGateway({ prompt: PROMPT, _upstreamUrl: upstreamUrl });
    gateways.push(gateway);
    const first = await fetchGateway(gateway);
    expect(first.status).toBe(502);
    const firstText = await first.text();
    expect(firstText).toBe("codex responses gateway request failed\n");
    expect(firstText).not.toContain("UPSTREAM-TOKEN-SECRET");
    const second = await fetchGateway(gateway);
    expect(second.status).toBe(409);
    expect(calls).toBe(1);
  });

  it("rejects a null upstream body and relays only safe response headers", async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, {
      status: 200,
      headers: { "content-type": "text/event-stream", "content-length": "0" },
    });
    const gateway = await createCodexResponsesGateway({ prompt: PROMPT, _fetch: fetchImpl });
    gateways.push(gateway);
    const response = await fetchGateway(gateway);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("codex responses gateway request failed\n");
  });

  it.each([401, 503])("aborts and cancels an endless non-2xx upstream body (%s)", async (status) => {
    let cancelled = false;
    let upstreamSignal: AbortSignal | undefined;
    const endless = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("UPSTREAM-SECRET"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl: typeof fetch = async (_input, init) => {
      upstreamSignal = init?.signal;
      return new Response(endless, {
        status,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const gateway = await createCodexResponsesGateway({ prompt: PROMPT, _fetch: fetchImpl });
    gateways.push(gateway);
    const response = await fetchGateway(gateway);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toBe("codex responses gateway request failed\n");
    expect(text).not.toContain("UPSTREAM-SECRET");
    expect(cancelled).toBe(true);
    expect(upstreamSignal?.aborted).toBe(true);
    await gateway.close();
  });

  it("aborts and cancels an endless upstream body before rejecting invalid SSE", async () => {
    let cancelled = false;
    let upstreamSignal: AbortSignal | undefined;
    const endless = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("UPSTREAM-SECRET"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl: typeof fetch = async (_input, init) => {
      upstreamSignal = init?.signal;
      return new Response(endless, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const gateway = await createCodexResponsesGateway({ prompt: PROMPT, _fetch: fetchImpl });
    gateways.push(gateway);
    const response = await fetchGateway(gateway);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toBe("codex responses gateway request failed\n");
    expect(text).not.toContain("UPSTREAM-SECRET");
    expect(cancelled).toBe(true);
    expect(upstreamSignal?.aborted).toBe(true);
    await gateway.close();
  });

  it.each([
    ["fetch failure", async () => { throw new Error("UPSTREAM-SECRET"); }],
    ["redirect", async () => new Response("UPSTREAM-SECRET", { status: 302, headers: { location: "https://evil.invalid" } })],
    ["wrong content type", async () => new Response("UPSTREAM-SECRET", { status: 200, headers: { "content-type": "application/json" } })],
  ])("maps %s to a bounded generic failure", async (_label, fetchImpl) => {
    const gateway = await createCodexResponsesGateway({ prompt: PROMPT, _fetch: fetchImpl as typeof fetch });
    gateways.push(gateway);
    const response = await fetchGateway(gateway);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toBe("codex responses gateway request failed\n");
    expect(text).not.toContain("UPSTREAM-SECRET");
    await expect(gateway.waitForCompletion()).rejects.toThrow("codex responses gateway did not complete");
  });

  it("rejects a stream that fails after emitting partial bytes", async () => {
    const fetchImpl: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: partial\n\n"));
        controller.error(new Error("UPSTREAM-SECRET"));
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
    const gateway = await createCodexResponsesGateway({ prompt: PROMPT, _fetch: fetchImpl });
    gateways.push(gateway);
    const response = await fetchGateway(gateway);
    const text = await response.text();
    expect(text).toBe("codex responses gateway request failed\n");
    expect(text).not.toContain("UPSTREAM-SECRET");
    await expect(gateway.waitForCompletion()).rejects.toThrow("codex responses gateway did not complete");
  });

  it("rejects a clean upstream EOF before response.completed", async () => {
    const gateway = await createCodexResponsesGateway({
      prompt: PROMPT,
      _fetch: async () => new Response(
        "event: response.in_progress\ndata: {\"type\":\"response.in_progress\"}\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    });
    gateways.push(gateway);

    await fetchGateway(gateway)
      .then(async (response) => response.arrayBuffer())
      .catch(() => undefined);

    await expect(gateway.waitForCompletion()).rejects.toThrow("codex responses gateway did not complete");
    expect(gateway.requestCompleted).toBe(false);
  });

  it("rejects incomplete UTF-8 buffered after response.completed", async () => {
    const terminalWithTruncatedUtf8 = Buffer.concat([
      Buffer.from(COMPLETED_SSE, "utf8"),
      Buffer.from([0xc3]),
    ]);
    const gateway = await createCodexResponsesGateway({
      prompt: PROMPT,
      _fetch: async () => new Response(terminalWithTruncatedUtf8, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    });
    gateways.push(gateway);

    await fetchGateway(gateway)
      .then(async (response) => response.arrayBuffer())
      .catch(() => undefined);

    await expect(gateway.waitForCompletion()).rejects.toThrow("codex responses gateway did not complete");
    expect(gateway.requestCompleted).toBe(false);
  });

  it.each([
    ["malformed completion data", "event: response.completed\ndata: not-json\n\n"],
    [
      "mismatched completion data",
      "event: response.completed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\"}}\n\n",
    ],
    [
      "completion data with an error",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"error\":{\"code\":\"server_error\"}}}\n\n",
    ],
    [
      "failed terminal event",
      "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\"}}\n\n",
    ],
    [
      "incomplete terminal event",
      "event: response.incomplete\ndata: {\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\"}}\n\n",
    ],
    [
      "malformed non-terminal event before completion",
      `event: response.in_progress\ndata: not-json\n\n${COMPLETED_SSE}`,
    ],
  ])("rejects %s", async (_label, terminalEvent) => {
    const gateway = await createCodexResponsesGateway({
      prompt: PROMPT,
      _fetch: async () => new Response(terminalEvent, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    });
    gateways.push(gateway);

    await fetchGateway(gateway)
      .then(async (response) => response.arrayBuffer())
      .catch(() => undefined);

    await expect(gateway.waitForCompletion()).rejects.toThrow("codex responses gateway did not complete");
    expect(gateway.requestCompleted).toBe(false);
  });

  it("completes when the client closes after receiving a split response.completed event", async () => {
    let upstreamSignal: AbortSignal | undefined;
    let upstreamCancelled = false;
    const fetchImpl: typeof fetch = async (_input, init) => {
      upstreamSignal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: response.com"));
          controller.enqueue(new TextEncoder().encode(
            "pleted\r\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\r\n\r\n",
          ));
          init?.signal?.addEventListener("abort", () => {
            controller.error(new Error("downstream closed after terminal event"));
          }, { once: true });
        },
        cancel() {
          upstreamCancelled = true;
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const gateway = await createCodexResponsesGateway({ prompt: PROMPT, _fetch: fetchImpl });
    gateways.push(gateway);

    const response = await fetchGateway(gateway);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("response.completed")) {
      const chunk = await reader!.read();
      expect(chunk.done).toBe(false);
      received += decoder.decode(chunk.value, { stream: true });
    }
    await reader!.cancel();

    await expect(gateway.waitForCompletion()).resolves.toBeUndefined();
    expect(gateway.requestAccepted).toBe(true);
    expect(gateway.requestCompleted).toBe(true);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(upstreamCancelled).toBe(true);
  });

  it("fails completion when the upstream stream is aborted or the gateway closes", async () => {
    const { url: upstreamUrl } = await listenSimpleUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: response.in_progress\ndata: {\"type\":\"response.in_progress\"}\n\n");
      setTimeout(() => res.end(COMPLETED_SSE), 100);
    });
    const gateway = await createCodexResponsesGateway({ prompt: PROMPT, _upstreamUrl: upstreamUrl });
    gateways.push(gateway);
    const responsePromise = fetchGateway(gateway);
    const response = await responsePromise;
    await gateway.close();
    await expect(gateway.waitForCompletion()).rejects.toThrow("codex responses gateway did not complete");
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it("keeps concurrent prompts isolated across immutable per-call gateways", async () => {
    const captures: string[] = [];
    const { url: upstreamUrl } = await listenSimpleUpstream(async (req, res) => {
      captures.push(await readBody(req));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(COMPLETED_SSE);
    });
    const one = await createCodexResponsesGateway({ prompt: "prompt-one", _upstreamUrl: upstreamUrl });
    const two = await createCodexResponsesGateway({ prompt: "prompt-two", _upstreamUrl: upstreamUrl });
    gateways.push(one, two);
    await Promise.all([fetchGateway(one), fetchGateway(two)]);
    expect(captures).toHaveLength(2);
    expect(captures.join("\n")).toContain("prompt-one");
    expect(captures.join("\n")).toContain("prompt-two");
    expect(captures[0]).not.toContain("prompt-two");
    expect(captures[1]).not.toContain("prompt-one");
  });

  it("closes idempotently and makes the capability unreachable", async () => {
    const gateway = await createCodexResponsesGateway({ prompt: PROMPT });
    const first = gateway.close();
    const second = gateway.close();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    await expect(fetch(`${gateway.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
      body: validBody(),
    })).rejects.toThrow();
    await expect(gateway.waitForCompletion()).rejects.toThrow("codex responses gateway did not complete");
  });

  it("fails closed when startup or close encounters an error", async () => {
    await expect(createCodexResponsesGateway({ prompt: "" })).rejects.toThrow(
      "codex responses gateway startup failed",
    );
    const badRandom = (() => Buffer.from("short")) as unknown as typeof import("node:crypto").randomBytes;
    await expect(createCodexResponsesGateway({ prompt: PROMPT, _randomBytes: badRandom })).rejects.toThrow(
      "codex responses gateway startup failed",
    );
    const badCreateServer = (() => {
      throw new Error("bind failed");
    }) as unknown as typeof createServer;
    await expect(createCodexResponsesGateway({ prompt: PROMPT, _createServer: badCreateServer })).rejects.toThrow(
      "codex responses gateway startup failed",
    );

    const listenError = makeFakeServer({ listenError: new Error("listen failed") });
    await expect(createCodexResponsesGateway({
      prompt: PROMPT,
      _createServer: (() => listenError) as unknown as typeof createServer,
    })).rejects.toThrow("codex responses gateway startup failed");

    const noAddress = makeFakeServer({ address: null });
    await expect(createCodexResponsesGateway({
      prompt: PROMPT,
      _createServer: (() => noAddress) as unknown as typeof createServer,
    })).rejects.toThrow("codex responses gateway startup failed");

    const calls: string[] = [];
    const closeError = makeFakeServer({ calls, closeError: new Error("close failed"), closeAllError: new Error("all failed") });
    const closeGateway = await createCodexResponsesGateway({
      prompt: PROMPT,
      _createServer: (() => closeError) as unknown as typeof createServer,
    });
    const closePromise = closeGateway.close();
    await expect(closePromise).rejects.toThrow("close failed");
    expect(calls).toEqual(["listen", "close", "closeAllConnections"]);
    expect(closeGateway.close()).toBe(closePromise);
    await expect(closeGateway.waitForCompletion()).rejects.toThrow("codex responses gateway did not complete");

    const onlyConnectionsError = makeFakeServer({ closeAllError: new Error("all failed") });
    const onlyConnectionsGateway = await createCodexResponsesGateway({
      prompt: PROMPT,
      _createServer: (() => onlyConnectionsError) as unknown as typeof createServer,
    });
    await expect(onlyConnectionsGateway.close()).rejects.toThrow("all failed");
    const nonErrorClose = makeFakeServer();
    nonErrorClose.close = (callback) => callback?.("non-error close" as unknown as Error);
    const nonErrorGateway = await createCodexResponsesGateway({
      prompt: PROMPT,
      _createServer: (() => nonErrorClose) as unknown as typeof createServer,
    });
    await expect(nonErrorGateway.close()).rejects.toThrow("non-error close");

    const throwingListen = makeFakeServer();
    throwingListen.listen = () => { throw "listen failed"; };
    await expect(createCodexResponsesGateway({
      prompt: PROMPT,
      _createServer: (() => throwingListen) as unknown as typeof createServer,
    })).rejects.toThrow("codex responses gateway startup failed");

    const throwingClose = makeFakeServer();
    throwingClose.close = () => { throw "close failed"; };
    const throwingCloseGateway = await createCodexResponsesGateway({
      prompt: PROMPT,
      _createServer: (() => throwingClose) as unknown as typeof createServer,
    });
    await expect(throwingCloseGateway.close()).rejects.toThrow("close failed");

    let activeHandler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
    const pendingServer = makeFakeServer();
    const pendingFetch: typeof fetch = async (_input, init) => new Promise((resolve) => {
      init?.signal?.addEventListener("abort", () => {
        resolve(new Response("data: aborted\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }));
      }, { once: true });
    });
    const pendingGateway = await createCodexResponsesGateway({
      prompt: PROMPT,
      _fetch: pendingFetch,
      _createServer: ((handler) => {
        activeHandler = handler;
        return pendingServer;
      }) as unknown as typeof createServer,
    });
    const pendingRequestBody = validBody();
    const pendingRequest = new EventEmitter() as IncomingMessage;
    Object.assign(pendingRequest, {
      resume: vi.fn(),
      url: `${pendingGateway.capabilityPath}/responses`,
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-length": String(Buffer.byteLength(pendingRequestBody)),
      },
      rawHeaders: [
        "Authorization", "Bearer test-token",
        "Content-Length", String(Buffer.byteLength(pendingRequestBody)),
      ],
      complete: true,
      [Symbol.asyncIterator]: async function* () { yield pendingRequestBody; },
    });
    const pendingResponse = makeFakeResponse(true);
    pendingResponse.writableEnded = true;
    const pendingCall = activeHandler?.(pendingRequest, pendingResponse as unknown as ServerResponse);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pendingResponse.listenerCount("close")).toBeGreaterThan(0);
    pendingResponse.emit("close");
    await pendingGateway.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await pendingCall;

    const pendingRequestCloseServer = makeFakeServer();
    let pendingRequestHandler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
    const pendingRequestGateway = await createCodexResponsesGateway({
      prompt: PROMPT,
      _fetch: pendingFetch,
      _createServer: ((handler) => {
        pendingRequestHandler = handler;
        return pendingRequestCloseServer;
      }) as unknown as typeof createServer,
    });
    const requestCloseBody = validBody();
    const requestClose = new EventEmitter() as IncomingMessage;
    Object.assign(requestClose, {
      resume: vi.fn(),
      url: `${pendingRequestGateway.capabilityPath}/responses`,
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-length": String(Buffer.byteLength(requestCloseBody)),
      },
      rawHeaders: [
        "Authorization", "Bearer test-token",
        "Content-Length", String(Buffer.byteLength(requestCloseBody)),
      ],
      complete: false,
      [Symbol.asyncIterator]: async function* () { yield requestCloseBody; },
    });
    const requestCloseResponse = makeFakeResponse(true);
    const requestCloseCall = pendingRequestHandler?.(requestClose, requestCloseResponse as unknown as ServerResponse);
    await new Promise<void>((resolve) => setImmediate(resolve));
    requestCloseResponse.emit("close");
    requestClose.emit("close");
    await pendingRequestGateway.close();
    await requestCloseCall;

    let endedHandler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
    const endedServer = makeFakeServer();
    const endedGateway = await createCodexResponsesGateway({
      prompt: PROMPT,
      _fetch: async () => new Response(new TextEncoder().encode(COMPLETED_SSE), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      _createServer: ((handler) => {
        endedHandler = handler;
        return endedServer;
      }) as unknown as typeof createServer,
    });
    const endedBody = validBody();
    const endedRequest = new EventEmitter() as IncomingMessage;
    Object.assign(endedRequest, {
      resume: vi.fn(),
      url: `${endedGateway.capabilityPath}/responses`,
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-length": String(Buffer.byteLength(endedBody)),
      },
      rawHeaders: [
        "Authorization", "Bearer test-token",
        "Content-Length", String(Buffer.byteLength(endedBody)),
      ],
      complete: true,
      [Symbol.asyncIterator]: async function* () { yield endedBody; },
    });
    const endedResponse = makeFakeResponse(true);
    endedResponse.write = vi.fn(() => {
      endedResponse.writableEnded = true;
      return true;
    });
    endedHandler?.(endedRequest, endedResponse as unknown as ServerResponse);
    await endedGateway.waitForCompletion();
    expect(endedGateway.requestCompleted).toBe(true);
    await endedGateway.close();

    let requestHandler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
    const closedServer = makeFakeServer();
    const closedGateway = await createCodexResponsesGateway({
      prompt: PROMPT,
      _createServer: ((handler) => {
        requestHandler = handler;
        return closedServer;
      }) as unknown as typeof createServer,
    });
    await closedGateway.close();
    const request = new EventEmitter() as IncomingMessage;
    Object.assign(request, { resume: vi.fn(), url: "/ignored", method: "GET", headers: {}, rawHeaders: [] });
    const response = makeFakeResponse(true);
    requestHandler?.(request, response as unknown as ServerResponse);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(response.statusCode).toBe(503);
  });
});
