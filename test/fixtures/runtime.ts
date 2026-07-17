import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, vi } from "vitest";

const temporaryDirectories = new Set<string>();
const temporaryDatabases = new Set<DatabaseSync>();

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const database of temporaryDatabases) database.close();
  temporaryDatabases.clear();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

export function createTemporaryDirectory(prefix = "lcm-test-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

export function createIsolatedHome(): { home: string; lcmHome: string } {
  const home = createTemporaryDirectory("lcm-home-");
  return { home, lcmHome: join(home, ".lcm") };
}

export function createTemporaryDatabase(): DatabaseSync {
  const directory = createTemporaryDirectory("lcm-sqlite-");
  const database = new DatabaseSync(join(directory, "test.db"));
  temporaryDatabases.add(database);
  return database;
}

export function captureConsole(method: "log" | "error" = "log"): string[] {
  const output: string[] = [];
  vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
    output.push(values.map(String).join(" "));
  });
  return output;
}

export function captureProcessWrites(stream: "stdout" | "stderr" = "stdout"): string[] {
  const output: string[] = [];
  vi.spyOn(process[stream], "write").mockImplementation(((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return output;
}

export function useDeterministicTimers(now = new Date("2026-01-01T00:00:00.000Z")): void {
  vi.useFakeTimers();
  vi.setSystemTime(now);
}

export function injectedFailure(message = "deterministic failure", code?: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

export function createFakeProcess(): EventEmitter & {
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
} {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: vi.fn().mockReturnValue(true),
  });
}

export async function withHttpHandler(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void Promise.resolve()
      .then(() => handler(request, response))
      .catch((error: unknown) => {
        if (!response.headersSent) {
          response.statusCode = 500;
          response.end("Internal Server Error");
        } else if (!response.writableEnded) {
          response.destroy(error instanceof Error ? error : undefined);
        }
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a TCP port.");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}
