import { expect } from "vitest";
import {
  PORTABLE_LIMITS, runPortableTransfer, type PortableRecordStream,
  type PortableRecordWriter, type PortableTransferResult,
} from "../../src/storage/portable.js";

/**
 * The caller owns the real immutable source until its outer finally. A PG
 * snapshot cannot be reopened with the same manifest after its connection
 * closes. These leases delegate every data operation to that actual snapshot;
 * runPortableTransfer closes each lease and the caller closes the snapshot.
 */
function borrowSnapshot(source: PortableRecordStream) {
  let closed = false;
  const active = () => expect(closed, "portable-snapshot-lease-active").toBe(false);
  const stream: PortableRecordStream = {
    describe() { active(); return source.describe(); },
    readBatch(input) { active(); return source.readBatch(input); },
    verify(checkpoint) { active(); return source.verify(checkpoint); },
    async close() { closed = true; },
  };
  return { stream, assertClosed: () => expect(closed, "portable-snapshot-lease-closed").toBe(true) };
}

/** Exercise the public transfer runner and actual durable destination reopen. */
export async function assertInterruptedPortableTransfer(input: {
  source: PortableRecordStream;
  destination: PortableRecordWriter;
  reopenDestination(): Promise<PortableRecordWriter>;
  openWrongDestination(): Promise<PortableRecordWriter>;
  readNativeProgress(): Promise<{ receipts: number; transferredMachines: number; nativeMachines: number }>;
  openDifferentSource?(): Promise<PortableRecordStream>;
}): Promise<PortableTransferResult> {
  const expected = input.source.describe();
  const first = await input.source.readBatch({ domain: "machines", maxRecords: 1, maxBytes: PORTABLE_LIMITS.maxBatchBytes });
  expect(first.checkpoint).toMatchObject({ recordCount: 1, complete: false });
  const handles: { close(): Promise<void> }[] = [input.destination];
  const own = <T extends { close(): Promise<void> }>(handle: T) => { handles.push(handle); return handle; };
  try {
    const lease = borrowSnapshot(input.source);
    const abort = new AbortController();
    const checkpoints: string[] = [];
    await expect(runPortableTransfer({ source: lease.stream, destination: input.destination,
      maxRecords: 1, signal: abort.signal,
      onProgress(progress) { checkpoints.push(progress.checkpointSha256); abort.abort(); },
    })).rejects.toMatchObject({ code: "aborted" });
    lease.assertClosed();
    expect(checkpoints).toEqual([first.checkpoint.checkpointSha256]);
    const partial = await input.readNativeProgress();
    expect(partial).toMatchObject({ receipts: 1, transferredMachines: 1 });
    // An unexpectedly accepted wrong opener remains owned for cleanup even
    // while this refusal assertion fails.
    await expect(input.openWrongDestination().then(own)).rejects.toMatchObject({ code: "destination-conflict" });
    expect(await input.readNativeProgress()).toEqual(partial);
    const resumed = own(await input.reopenDestination());
    const preflight = await resumed.preflight(expected, input.source);
    await expect(resumed.admit(expected, { ...preflight, destinationWitnessSha256: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "destination-conflict" });
    await resumed.admit(expected, preflight);
    expect((await resumed.readProgress(expected.manifestSha256)).checkpoints).toEqual([first.checkpoint]);
    await expect(resumed.applyBatch(first)).resolves.toEqual(first.checkpoint);
    await expect(resumed.applyBatch(first)).resolves.toEqual(first.checkpoint);
    await expect(resumed.applyBatch({ ...first, priorCheckpointSha256: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "checkpoint-mismatch" });
    expect(await input.readNativeProgress()).toEqual(partial);
    expect((await resumed.readProgress(expected.manifestSha256)).checkpoints).toEqual([first.checkpoint]);
    const resumedLease = borrowSnapshot(input.source);
    const result = await runPortableTransfer({ source: resumedLease.stream, destination: resumed, maxRecords: 2 });
    resumedLease.assertClosed();
    expect(result.manifestSha256).toBe(expected.manifestSha256);
    expect(result.contentSha256).toBe(expected.contentSha256);
    expect(result.checkpoints.map(({ domain, recordCount, prefixSha256, complete }) => ({ domain, recordCount, prefixSha256, complete })))
      .toEqual(expected.domains.map(({ domain, recordCount, prefixSha256 }) => ({ domain, recordCount, prefixSha256, complete: true })));
    const completed = await input.readNativeProgress();
    const replayLease = borrowSnapshot(input.source);
    const replayTarget = own(await input.reopenDestination());
    let appliedBatches = 0;
    expect(await runPortableTransfer({ source: replayLease.stream, destination: replayTarget, maxRecords: 1,
      onProgress() { appliedBatches++; },
    })).toEqual(result);
    replayLease.assertClosed();
    expect(appliedBatches).toBe(0);
    expect(await input.readNativeProgress()).toEqual(completed);
    if (input.openDifferentSource) {
      const different = own(await input.openDifferentSource());
      expect(different.describe().contentSha256).toBe(expected.contentSha256);
      expect(different.describe().manifestSha256).not.toBe(expected.manifestSha256);
      const mismatched = own(await input.reopenDestination());
      await expect(runPortableTransfer({ source: different, destination: mismatched, maxRecords: 2 }))
        .rejects.toMatchObject({ code: "destination-conflict" });
      expect(await input.readNativeProgress()).toEqual(completed);
    }
    return result;
  } finally {
    const closed = await Promise.allSettled(handles.reverse().map(handle => handle.close()));
    const failure = closed.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
