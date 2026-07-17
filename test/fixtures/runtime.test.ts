import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";

const httpMocks = vi.hoisted((): { createServer: ReturnType<typeof vi.fn> } => ({
  createServer: vi.fn(),
}));

vi.mock("node:http", async (
  importOriginal: <T extends typeof import("node:http") = typeof import("node:http")>() => Promise<T>,
): Promise<typeof import("node:http")> => {
  const actual = await importOriginal<typeof import("node:http")>();
  httpMocks.createServer.mockImplementation(actual.createServer);
  return { ...actual, createServer: httpMocks.createServer };
});

import { captureProcessWrites, createTemporaryDatabase, withHttpHandler } from "./runtime.js";

describe("createTemporaryDatabase", (): void => {
  it("configures the production SQLite pragmas", (): void => {
    const database = createTemporaryDatabase();

    const journalMode = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const foreignKeys = database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    const busyTimeout = database.prepare("PRAGMA busy_timeout").get() as { timeout: number };

    expect(journalMode.journal_mode).toBe("wal");
    expect(foreignKeys.foreign_keys).toBe(1);
    expect(busyTimeout.timeout).toBe(5000);
  });
});

describe("captureProcessWrites", (): void => {
  it("preserves strings and decodes Uint8Array chunks as UTF-8", (): void => {
    const output = captureProcessWrites();

    process.stdout.write("direct string");
    process.stdout.write(new Uint8Array(Buffer.from("café", "utf8")));

    expect(output).toEqual(["direct string", "café"]);
  });
});

describe("withHttpHandler", (): void => {
  it("returns a deterministic 500 response when an async handler rejects", async (): Promise<void> => {
    await withHttpHandler(
      async (): Promise<void> => {
        await Promise.resolve();
        throw new Error("deterministic handler rejection");
      },
      async (baseUrl: string): Promise<void> => {
        const response = await fetch(baseUrl);

        expect(response.status).toBe(500);
        await expect(response.text()).resolves.toBe("Internal Server Error");
      },
    );
  });

  it("rejects when the server fails to start listening", async (): Promise<void> => {
    const startupError = new Error("address unavailable");
    const run = vi.fn<(baseUrl: string) => Promise<void>>();
    const fakeServer = Object.assign(new EventEmitter(), {
      listen: vi.fn(),
    });
    fakeServer.listen.mockImplementation((): typeof fakeServer => {
      queueMicrotask((): void => {
        fakeServer.emit("error", startupError);
      });
      return fakeServer;
    });
    httpMocks.createServer.mockReturnValueOnce(fakeServer as unknown as Server);

    await expect(withHttpHandler(vi.fn(), run)).rejects.toBe(startupError);
    expect(run).not.toHaveBeenCalled();
    expect(fakeServer.listenerCount("error")).toBe(0);
  });
});
