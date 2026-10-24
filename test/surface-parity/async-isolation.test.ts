import { expect, it, vi } from "vitest";
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

it.each([
  { status: 503, body: { status: "blocked", error: "canary-free-text" }, id: "503:blocked" },
  { status: 503, body: { code: "STORAGE_OPERATION_FAILED", message: "canary-free-text", projectId: "canary" }, id: "503:storage-STORAGE_OPERATION_FAILED" },
  { status: 409, body: { code: "STORAGE_IDENTITY_REQUIRED", reason: "canary-free-text" }, id: "409:storage-STORAGE_IDENTITY_REQUIRED" },
  { status: 500, body: { error: "canary-free-text" }, id: "500:other" },
  { status: 500, body: { code: "contains canary free text" }, id: "500:other" },
  { status: 500, body: { code: "A".repeat(41) }, id: "500:other" },
  { status: 500, body: null, id: "500:other" },
  { status: "503 canary", body: { code: "STORAGE_OPERATION_FAILED" }, id: "invalid:storage-STORAGE_OPERATION_FAILED" },
  { status: 1000, body: undefined, id: "invalid:other" },
])("reports a symbolic drain status without response text %#", async ({ status, body, id }) => {
  const f = fixture();
  f.operations.drain.mockResolvedValue({ status, body });
  const error = await isolateAsyncBoundary(f.operations).then(() => undefined, (caught: unknown) => caught as Error);
  // The worker relays only this symbolic prefix of the message (failure() in surface-parity-worker.mjs).
  const relayed = error?.message.match(/^(?:surface[-\w]*:)[a-zA-Z0-9:._-]+/u)?.[0];
  expect(relayed).toBe(`surface-isolation:drain-status:${id}`);
  expect(f.operations.stop).not.toHaveBeenCalled();
});

it("keeps the worst-case drain id inside the worker's 110-character failure slice", () => {
  const body = { status: "blocked", code: "A".repeat(40) };
  const worst = drainFailureId("surface-prepared:drain", { status: 503, body: { code: "A".repeat(40) } });
  expect(worst).toBe(`surface-prepared:drain:503:storage-${"A".repeat(40)}`);
  // The worker strips the "surface-prepared:" prefix and prepends "<case>:<phase>:".
  const prepared = `import-collisions:call12-before:${worst.replace(/^surface[-\w]*:/u, "")}`;
  expect(prepared.length).toBeLessThanOrEqual(110);
  expect(drainFailureId("surface-isolation:drain-status", { status: 503, body })).toBe("surface-isolation:drain-status:503:blocked");
  // The unprepared id keeps status and kind ahead of the worker's file:line frame suffix.
  expect(drainFailureId("surface-isolation:drain-status", { status: 503, body: { code: "A".repeat(40) } }).length).toBeLessThan(110 - 20);
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
