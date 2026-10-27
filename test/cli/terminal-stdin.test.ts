import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readTerminalStdin, TERMINAL_STDIN_MAX_BYTES } from "../../src/cli/terminal-stdin.js";

function emitter() {
  const input = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  return input;
}

describe("terminal hook stdin reader", () => {
  it("assembles split chunks and requires EOF", async () => {
    const input = emitter();
    const result = readTerminalStdin(input, new AbortController().signal);
    input.emit("data", Buffer.from("{\"a\":"));
    input.emit("data", Buffer.from("1}"));
    input.emit("end");
    await expect(result).resolves.toEqual({ kind: "ok", text: "{\"a\":1}" });
    expect(input.destroy).not.toHaveBeenCalled();
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
  });

  it("reads a real stream to its end", async () => {
    const stream = new PassThrough();
    const result = readTerminalStdin(stream, new AbortController().signal);
    stream.end("hello");
    await expect(result).resolves.toEqual({ kind: "ok", text: "hello" });
  });

  it("destroys the input and discards partial data when the deadline passes", async () => {
    const input = emitter();
    const controller = new AbortController();
    const result = readTerminalStdin(input, controller.signal);
    input.emit("data", Buffer.from("{\"partial\":"));
    controller.abort();
    await expect(result).resolves.toEqual({ kind: "deadline-exhausted" });
    expect(input.destroy).toHaveBeenCalledOnce();
    input.emit("end");
    expect(input.listenerCount("end")).toBe(0);
  });

  it("does not read at all once the deadline has already passed", async () => {
    const input = emitter();
    const controller = new AbortController();
    controller.abort();
    await expect(readTerminalStdin(input, controller.signal)).resolves.toEqual({ kind: "deadline-exhausted" });
    expect(input.destroy).toHaveBeenCalledOnce();
    expect(input.listenerCount("data")).toBe(0);
  });

  it("refuses more than one MiB without parsing it", async () => {
    const input = emitter();
    const result = readTerminalStdin(input, new AbortController().signal);
    input.emit("data", Buffer.alloc(TERMINAL_STDIN_MAX_BYTES));
    input.emit("data", Buffer.from("x"));
    await expect(result).resolves.toEqual({ kind: "invalid-input" });
    expect(input.destroy).toHaveBeenCalledOnce();
  });

  it("accepts exactly one MiB", async () => {
    const input = emitter();
    const result = readTerminalStdin(input, new AbortController().signal);
    input.emit("data", Buffer.alloc(TERMINAL_STDIN_MAX_BYTES, "a"));
    input.emit("end");
    const read = await result;
    expect(read.kind).toBe("ok");
  });

  it("reports a stream error as invalid input", async () => {
    const input = emitter();
    const result = readTerminalStdin(input, new AbortController().signal);
    input.emit("error", new Error("boom"));
    await expect(result).resolves.toEqual({ kind: "invalid-input" });
    expect(input.destroy).toHaveBeenCalledOnce();
  });
});

