import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { writeHookOutput, type HookOutputStream } from "../../src/cli/hook-output.js";

type FakeStream = HookOutputStream & EventEmitter & {
  callbacks: Array<(error?: Error | null) => void>;
};

function fakeStream(write?: (callback: (error?: Error | null) => void) => void): FakeStream {
  const emitter = new EventEmitter();
  const callbacks: Array<(error?: Error | null) => void> = [];
  return Object.assign(emitter, {
    callbacks,
    write: (_chunk: string, callback: (error?: Error | null) => void): boolean => {
      callbacks.push(callback);
      write?.(callback);
      return true;
    },
  }) as FakeStream;
}

async function isPending(promise: Promise<void>): Promise<boolean> {
  const marker = Symbol("pending");
  return (await Promise.race([promise, new Promise(resolve => setImmediate(() => resolve(marker)))])) === marker;
}

describe("writeHookOutput", () => {
  it("resolves without touching the stream when there is nothing to write", async () => {
    const stream = fakeStream();
    await expect(writeHookOutput(stream, "")).resolves.toBeUndefined();
    expect(stream.callbacks).toEqual([]);
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("stays pending until the stream reports the write as flushed", async () => {
    const stream = fakeStream();
    const written = writeHookOutput(stream, "payload");
    expect(await isPending(written)).toBe(true);
    expect(stream.listenerCount("error")).toBe(1);
    stream.callbacks[0]?.();
    await expect(written).resolves.toBeUndefined();
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("resolves on a failed write once the stream has emitted its error", async () => {
    const stream = fakeStream();
    const written = writeHookOutput(stream, "payload");
    const failure = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    stream.callbacks[0]?.(failure);
    expect(stream.listenerCount("error")).toBe(1);
    stream.emit("error", failure);
    await expect(written).resolves.toBeUndefined();
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("resolves on a failed write even when no error event follows", async () => {
    const stream = fakeStream(callback => callback(new Error("write EPIPE")));
    await expect(writeHookOutput(stream, "payload")).resolves.toBeUndefined();
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("resolves when the error event arrives before the write callback", async () => {
    const stream = fakeStream();
    const written = writeHookOutput(stream, "payload");
    stream.emit("error", new Error("write EPIPE"));
    await expect(written).resolves.toBeUndefined();
    expect(stream.listenerCount("error")).toBe(0);
    stream.callbacks[0]?.(new Error("write EPIPE"));
    stream.callbacks[0]?.();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("resolves when the stream throws synchronously", async () => {
    const stream = fakeStream(() => { throw new Error("destroyed"); });
    await expect(writeHookOutput(stream, "payload")).resolves.toBeUndefined();
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("does not accumulate listeners across repeated calls", async () => {
    const stream = fakeStream(callback => callback());
    const warning = vi.fn();
    process.on("warning", warning);
    try {
      for (let index = 0; index < 25; index += 1) await writeHookOutput(stream, "payload");
      await new Promise<void>(resolve => setImmediate(resolve));
    } finally {
      process.off("warning", warning);
    }
    expect(stream.listenerCount("error")).toBe(0);
    expect(warning).not.toHaveBeenCalled();
  });

  it("waits for a real stream to flush before resolving", async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        setTimeout(() => { chunks.push(chunk.toString()); callback(); }, 20);
      },
    });
    await writeHookOutput(sink, "complete output");
    expect(chunks).toEqual(["complete output"]);
    expect(sink.listenerCount("error")).toBe(0);
  });

  it("absorbs the error a real failing stream emits after a failed write", async () => {
    const sink = new Writable({
      write(_chunk, _encoding, callback) { callback(new Error("write EPIPE")); },
    });
    await expect(writeHookOutput(sink, "payload")).resolves.toBeUndefined();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(sink.destroyed).toBe(true);
    expect(sink.listenerCount("error")).toBe(0);
  });
});
