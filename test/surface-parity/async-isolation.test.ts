import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
import { failure } from "../postgresql/fixtures/surface-parity-failure.mjs";
import { drainFailureId, isolateAsyncBoundary } from "./async-isolation.mjs";

it("retains real MCP connection and one-level network cause categories without private content", () => {
  const cause = Object.assign(new TypeError("PRIVATE_CANARY cause"), {
    code: "ECONNRESET", cause: Object.assign(new Error("PRIVATE_CANARY nested"), { code: "EPIPE" }),
  });
  const error = Object.assign(new McpError(ErrorCode.ConnectionClosed, "PRIVATE_CANARY message", { payload: "PRIVATE_CANARY" }), {
    cause, surfaceMcpStage: "connect", surfacePreparedField: "metadata",
    surfaceEvidence: { stdoutErrorDigest: "a".repeat(64), stderrDigest: "b".repeat(64) },
  });
  error.stack = "PRIVATE_CANARY stack\n at connect (file:///PRIVATE_CANARY/surface-parity-worker.mjs:390:9)";
  const result = failure(error, "import-collisions");
  expect(result.id).toContain(":e-McpError:c-mcp-closed:cause-TypeError-reset:mcp-connect");
  expect(result.id).toContain(":wk390");
  expect(result.id).toContain(":metadata");
  expect(result.digest).toBe("a".repeat(64));
  expect(Object.keys(result)).toEqual(["id", "digest"]);
  expect(result.id).toMatch(/^[a-zA-Z0-9_.:-]{1,110}$/u);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CANARY|payload|message|nested|EPIPE|file:/u);
});

it.each([
  [ErrorCode.RequestTimeout, "mcp-timeout"], ["ECONNREFUSED", "refused"],
  ["ECONNRESET", "reset"], ["EPIPE", "pipe"], ["ETIMEDOUT", "timeout"],
  ["ENOTFOUND", "dns"], ["EAI_AGAIN", "dns-again"],
  ["ERR_STREAM_DESTROYED", "stream-destroyed"], ["ERR_STREAM_PREMATURE_CLOSE", "stream-close"],
  ["ERR_SOCKET_CLOSED", "socket-closed"], ["ABORT_ERR", "aborted"],
])("retains fixed transport code %s", (code, label) => {
  const error = Object.assign(new Error("PRIVATE_CANARY"), { code });
  expect(failure(error).id).toContain(`:c-${label}`);
  expect(failure(error).digest).toBe(createHash("sha256").update(error.message).digest("hex"));
});

it.each(["connect", "list", "close"])("reserves class, code, cause and %s stage within the existing ID budget", stage => {
  const error = Object.assign(new McpError(ErrorCode.ConnectionClosed, `surface-worker:${"x".repeat(300)}`), {
    surfaceMcpStage: stage, surfacePreparedField: "metadata",
    cause: Object.assign(new SyntaxError("PRIVATE_CANARY"), { code: "ERR_STREAM_DESTROYED" }),
  });
  error.message = `surface-worker:${"x".repeat(300)}`;
  error.stack = " at connect (file:///PRIVATE_CANARY/surface-parity-worker.mjs:100000:9)";
  const result = failure(error, "import-collisions:call12-before");
  expect(result.id).toHaveLength(110);
  expect(result.id).toContain(":err:wk100000");
  expect(result.id).toContain(`:e-McpError:c-mcp-closed:cause-SyntaxError-stream-destroyed:mcp-${stage}`);
  expect(result.id).toMatch(/^[a-zA-Z0-9_.:-]{1,110}$/u);
  expect(result.digest).toBe(createHash("sha256").update(error.message).digest("hex"));
});

it("omits unknown class, code, cause, stage and payload values", () => {
  const error = Object.assign(new Error("PRIVATE_CANARY message"), {
    name: "PRIVATE_CANARY", code: "PRIVATE_CANARY", surfaceMcpStage: "PRIVATE_CANARY",
    payload: "PRIVATE_CANARY", cause: { name: "PRIVATE_CANARY", code: "PRIVATE_CANARY", message: "PRIVATE_CANARY" },
    surfaceEvidence: { stderrDigest: "b".repeat(64) },
  });
  error.stack = "PRIVATE_CANARY stack";
  const result = failure(error);
  expect(result.id).toBe("surface-worker:Error:err:e-Error");
  expect(result.digest).toBe("b".repeat(64));
  expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
});

it("retains a trusted prepared source label and classifies generic errors without raw content", () => {
  const error = new Error("PRIVATE_CANARY stderr SELECT secret FROM private");
  error.stack = `${error.message}\n at validate (file:///PRIVATE_CANARY/prepared-projects.mjs:123:9)`;
  const result = failure(error, "import-collisions:delta");
  expect(result.id).toBe("import-collisions:delta:Error:err:pp123:e-Error");
  expect(result.digest).toBe(createHash("sha256").update(error.message).digest("hex"));
  expect(Object.keys(result)).toEqual(["id", "digest"]);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CANARY|SELECT|stderr|file:|private/u);
});

it.each([[false, true, "01"], [true, false, "10"]] as const)("projects only genuine boolean assertion operands %#", (actual, expected, bits) => {
  const error = new assert.AssertionError({ actual, expected, operator: "strictEqual", message: "PRIVATE_CANARY body SQL" });
  error.stack = `${error.message}\n at validate (file:///PRIVATE_CANARY/prepared-projects.mjs:124:9)`;
  const result = failure(error, "import-collisions:delta");
  expect(result.id).toBe(`import-collisions:delta:assertion:a-seq:pp124:b${bits}`);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CANARY|body|SQL|file:/u);
});

it("omits unknown operators, nonboolean operands and untrusted source frames", () => {
  const error = new assert.AssertionError({ actual: 123456, expected: 654321, operator: "PRIVATE_CANARY", message: "PRIVATE_CANARY SQL" });
  error.stack = `${error.message}\n at validate (file:///PRIVATE_CANARY/untrusted.mjs:777:9)`;
  const result = failure(error, "import-collisions:delta");
  expect(result.id).toBe("import-collisions:delta:assertion:a-other");
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CANARY|123456|654321|777|untrusted|SQL/u);
  const forged = { name: "AssertionError", code: "ERR_ASSERTION", operator: "strictEqual", actual: true, expected: false,
    message: "PRIVATE_CANARY", stack: " at validate (file:///PRIVATE_CANARY/prepared-projects.mjs:1:1)" };
  expect(failure(forged, "import-collisions:delta").id).toBe("import-collisions:delta:assertion:err:pp1");
});

it.each(["0", "-1", "1.5", "100001", "9007199254740992"])("refuses an invalid trusted source line %s", line => {
  const error = new Error("PRIVATE_CANARY");
  error.stack = ` at validate (file:///PRIVATE_CANARY/prepared-projects.mjs:${line}:9)`;
  expect(failure(error, "import-collisions:delta").id).toBe("import-collisions:delta:Error:err:e-Error");
});

it("reserves bounded diagnostic space and preserves the existing failure schema and digest preference", () => {
  const error = new Error(`surface-prepared:${"x".repeat(300)}`);
  error.stack = " at validate (file:///PRIVATE_CANARY/prepared-journals.mjs:100000:9)";
  const result = failure(error, "import-collisions:delta");
  expect(result.id).toHaveLength(110);
  expect(result.id).toMatch(/^import-collisions:delta:/u);
  expect(result.id.endsWith(":err:pj100000:e-Error")).toBe(true);
  expect(result.id).toMatch(/^[a-zA-Z0-9_.:-]{1,110}$/u);
  expect(Object.keys(result)).toEqual(["id", "digest"]);
  const captured = Object.assign(new Error("PRIVATE_CANARY"), {
    surfaceEvidence: { stdoutErrorDigest: "a".repeat(64), stderrDigest: "b".repeat(64) },
  });
  expect(failure(captured).digest).toBe("a".repeat(64));
  const code = Object.assign(new Error("PRIVATE_CANARY"), { code: "EACCES" });
  expect(failure(code).id).toBe("surface-worker:EACCES:err:e-Error:c-denied");
});

function fixture() {
  const calls: string[] = [];
  const sidecar = { projectId: "fixture", cwd: "/owned/fixture", metadataMissing: false, captured: 2, unprocessed: 0,
    deliveryPending: 1, deliveryClaimed: 0, deliveryRetry: 0, deliveryReplicated: 0,
    deliveryAcknowledged: 0, deliveryAwaitingRemotePrune: 0, deliveryQuarantined: 1 };
  const state = { configWitness: "fixed", publication: "fixed", durableRows: "fixed" };
  const operations = {
    drain: vi.fn(async () => { calls.push("drain"); return { status: 200, body: { errors: 0, incomplete: false } }; }),
    readSidecars: vi.fn(async () => { calls.push("sidecars"); return [{ ...sidecar }]; }),
    captureState: vi.fn(async () => { calls.push("state"); return { ...state }; }),
    stop: vi.fn(async () => { calls.push("stop"); return { pid: 100, generation: "old", port: 3000 }; }),
    start: vi.fn(async (port: number) => { calls.push("start"); return { pid: 101, generation: "new", port }; }),
    assertStateUnchanged: vi.fn((after: unknown, before: unknown) => { calls.push("compare"); expect(after).toEqual(before); }),
  };
  operations.readSidecars.mockImplementationOnce(async () => { calls.push("sidecars"); return [{ ...sidecar, unprocessed: 1 }]; });
  return { calls, operations, sidecar };
}

it("isolates once after settlement and preserves independent pending/quarantined delivery", async () => {
  const f = fixture();
  await isolateAsyncBoundary(f.operations);
  expect(f.calls).toEqual(["sidecars", "drain", "sidecars", "stop", "sidecars", "state", "start", "sidecars", "state", "compare"]);
  expect(f.operations.drain).toHaveBeenCalledTimes(1);
  expect(f.operations.start).toHaveBeenCalledExactlyOnceWith(3000);
});

it("settles replication once, after drain and before the baseline stop", async () => {
  const f = fixture();
  const settleReplication = vi.fn(async () => { f.calls.push("settle"); });
  await isolateAsyncBoundary({ ...f.operations, settleReplication });
  expect(f.calls).toEqual(["sidecars", "drain", "sidecars", "settle", "stop", "sidecars", "state", "start", "sidecars", "state", "compare"]);
  expect(settleReplication).toHaveBeenCalledOnce();
});

it("does not restart or compare when replication settlement fails", async () => {
  const f = fixture();
  const failure = new Error("surface-isolation:replication-not-settled");
  await expect(isolateAsyncBoundary({ ...f.operations, settleReplication: vi.fn(async () => { throw failure; }) })).rejects.toBe(failure);
  expect(f.operations.stop).not.toHaveBeenCalled();
  expect(f.operations.start).not.toHaveBeenCalled();
});

it.each([
  { status: 503, body: { errors: 0, incomplete: false } },
  { status: 200, body: { errors: 1, incomplete: false } },
  { status: 200, body: { errors: 0, incomplete: true } },
])("refuses unsuccessful setup settlement without retrying or restarting %#", async result => {
  const f = fixture();
  f.operations.drain.mockResolvedValue(result);
  await expect(isolateAsyncBoundary(f.operations)).rejects.toThrow("surface-isolation:drain");
  expect(f.operations.drain).toHaveBeenCalledTimes(1);
  expect(f.operations.stop).not.toHaveBeenCalled();
  expect(f.operations.start).not.toHaveBeenCalled();
});

const CANARY = "canary-free-text";
const WORKER_FRAME = "at drain (file:///repo/test/postgresql/fixtures/surface-parity-worker.mjs:647:35)";

// The assertion error each drain site produces, relayed through the worker's real failure() formatter.
async function isolationError(result: { status: unknown; body: unknown }): Promise<Error> {
  const f = fixture();
  f.operations.drain.mockResolvedValue(result);
  const error = await isolateAsyncBoundary(f.operations).then(() => undefined, (caught: unknown) => caught as Error);
  expect(f.operations.stop).not.toHaveBeenCalled();
  return error as Error;
}
function preparedError(result: { status: unknown; body: unknown }): Error {
  try { assert.ok(false, drainFailureId("surface-prepared:drain", result)); } catch (caught) { return caught as Error; }
  throw new Error("unreachable");
}
// Node assertion stacks do not name the worker file; add the frame the worker's stack carries.
const inWorker = (error: Error): Error => { error.stack = `${error.message}\n    ${WORKER_FRAME}`; return error; };

const canaryBody = { message: CANARY, error: CANARY, operation: CANARY, projectId: CANARY, sqlState: CANARY, reason: CANARY };
it.each([
  { status: 503, body: { ...canaryBody, status: "blocked" }, kind: "blocked" },
  { status: 503, body: { ...canaryBody, code: "STORAGE_OPERATION_FAILED" }, kind: "storage-STORAGE_OPERATION_FAILED" },
  { status: 409, body: { ...canaryBody, code: "STORAGE_IDENTITY_REQUIRED" }, kind: "storage-STORAGE_IDENTITY_REQUIRED" },
  { status: 503, body: { ...canaryBody, code: "A".repeat(40) }, kind: `storage-${"A".repeat(40)}` },
  { status: 500, body: canaryBody, kind: "other" },
  { status: 500, body: { ...canaryBody, code: "contains canary free text" }, kind: "other" },
  { status: 500, body: { ...canaryBody, code: "A".repeat(41) }, kind: "other" },
  { status: 500, body: null, kind: "other" },
])("relays a bounded drain status and kind through failure() %#", async ({ status, body, kind }) => {
  const contexts = [undefined, "import-collisions:settle", "import-collisions:call12-before", "events-notify:settle"];
  for (const context of contexts) {
    const cases = [
      { site: "drain-status", error: inWorker(await isolationError({ status, body })) },
      { site: "drain", error: inWorker(preparedError({ status, body })) },
    ];
    for (const { site, error } of cases) {
      const { id, digest } = failure(error, context);
      expect(id.length).toBeLessThanOrEqual(110);
      expect(id).toContain(`${site}:${status}:${kind}`);
      expect(`${id} ${digest}`).not.toMatch(/canary|free text/u);
      expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    }
  }
});

it("rejects an invalid drain status without echoing it", async () => {
  const error = await isolationError({ status: `503 ${CANARY}`, body: { code: "STORAGE_OPERATION_FAILED" } });
  expect(failure(error).id).toContain("surface-isolation:drain-status:invalid:storage-STORAGE_OPERATION_FAILED");
  expect(failure(error).id).not.toContain("canary");
  expect(failure(await isolationError({ status: 1000, body: undefined })).id).toContain("drain-status:invalid:other");
});

it.each([{ unprocessed: 1 }, { scanError: "private diagnostic" }, { scanSkipped: "bounded scan" }])(
  "refuses incomplete passive-state observations %#", async patch => {
    const f = fixture();
    f.operations.readSidecars.mockResolvedValue([{ ...f.sidecar, ...patch }]);
    await expect(isolateAsyncBoundary(f.operations)).rejects.toThrow("surface-isolation:passive-work-not-settled");
    expect(f.operations.stop).not.toHaveBeenCalled();
  },
);

it("does not restart after graceful shutdown fails", async () => {
  const f = fixture();
  const failure = new Error("owned shutdown failed");
  f.operations.stop.mockRejectedValue(failure);
  await expect(isolateAsyncBoundary(f.operations)).rejects.toBe(failure);
  expect(f.operations.start).not.toHaveBeenCalled();
});

it.each([
  { pid: 100, generation: "new", port: 3000 },
  { pid: 101, generation: "old", port: 3000 },
  { pid: 101, generation: "new", port: 3001 },
])("rejects the wrong replacement identity or port %#", async replacement => {
  const f = fixture();
  f.operations.start.mockResolvedValue(replacement);
  await expect(isolateAsyncBoundary(f.operations)).rejects.toThrow("surface-isolation:daemon-generation");
});

it("rejects lost delivery state across restart", async () => {
  const f = fixture();
  f.operations.readSidecars.mockResolvedValueOnce([{ ...f.sidecar }]).mockResolvedValueOnce([{ ...f.sidecar }]).mockResolvedValueOnce([]);
  await expect(isolateAsyncBoundary(f.operations)).rejects.toThrow("surface-isolation:delivery-state-changed");
});

it("does not accept changed durable state", async () => {
  const f = fixture();
  const failure = new Error("durable state changed");
  f.operations.assertStateUnchanged.mockImplementation(() => { throw failure; });
  await expect(isolateAsyncBoundary(f.operations)).rejects.toBe(failure);
});

it("cancels an empty timer lifetime without inventing a drain operation", async () => {
  const f = fixture();
  f.operations.readSidecars.mockReset().mockResolvedValue([{ ...f.sidecar }]);
  await isolateAsyncBoundary(f.operations);
  expect(f.operations.drain).not.toHaveBeenCalled();
  expect(f.operations.stop).toHaveBeenCalledTimes(1);
  expect(f.operations.start).toHaveBeenCalledTimes(1);
});

it("refuses an unprocessed sidecar whose owner is missing before any drain", async () => {
  const f = fixture();
  f.operations.readSidecars.mockReset().mockResolvedValue([{ ...f.sidecar, unprocessed: 1, metadataMissing: true }]);
  await expect(isolateAsyncBoundary(f.operations)).rejects.toThrow("surface-isolation:pending-owner-missing");
  expect(f.operations.drain).not.toHaveBeenCalled();
  expect(f.operations.stop).not.toHaveBeenCalled();
});
