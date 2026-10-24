import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { failure } from "../postgresql/fixtures/surface-parity-failure.mjs";
import { drainFailureId, isolateAsyncBoundary } from "./async-isolation.mjs";

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
