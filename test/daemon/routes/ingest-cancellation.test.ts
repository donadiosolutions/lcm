import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { createStorageBackendFactory } from "../../../src/storage/index.js";
import { createIngestHandler } from "../../../src/daemon/routes/ingest.js";
const logs = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../../../src/hooks/hook-errors.js", () => ({ safeLogError: logs.error }));
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
afterEach(() => vi.restoreAllMocks());
for (const boundary of ["parsed", "native", "tokens"] as const) {
  for (const cancel of [false, true]) {
    it(`drains real ${boundary} work before close, cancel=${cancel}`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "native-lifecycle-"));
      const source = join(cwd, "transcript.jsonl");
      writeFileSync(source, JSON.stringify({ message: { role: "user", content: "synthetic hello" } }) + "\n", { mode: 0o600 });
      const config = loadDaemonConfig(join(cwd, "nonexistent"));
      const factory = await createStorageBackendFactory(config.storage);
      const open = factory.openProject.bind(factory);
      const entered = gate();
      const release = gate();
      let closeCount = 0;
      vi.spyOn(factory, "openProject").mockImplementation(async (...args) => {
        const project = await open(...args);
        const wait = async () => { entered.resolve(); await release.promise; };
        if (boundary === "native") {
          const repository = project.nativeTranscripts!.repository;
          const original = repository.getCheckpoint.bind(repository);
          vi.spyOn(repository, "getCheckpoint").mockImplementation(async (...checkpointArgs) => {
            await wait(); return original(...checkpointArgs);
          });
        } else if (boundary === "parsed") {
          const original = project.transaction.bind(project);
          vi.spyOn(project, "transaction").mockImplementation(async operation => {
            const result = await original(operation); await wait(); return result;
          });
        } else {
          const original = project.context.getContextTokenCount.bind(project.context);
          vi.spyOn(project.context, "getContextTokenCount").mockImplementation(async (...tokenArgs) => {
            await wait(); return original(...tokenArgs);
          });
        }
        const close = project.close.bind(project);
        vi.spyOn(project, "close").mockImplementation(async () => { closeCount++; await close(); });
        return project;
      });
      const abort = new AbortController();
      let status = 0;
      let body = "";
      const res = { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; } };
      logs.error.mockClear();
      const handling = createIngestHandler(config, factory)({} as never, res as never,
        JSON.stringify({ cwd, session_id: "synthetic-session", transcript_path: source }), { signal: abort.signal });
      try {
        await entered.promise;
        if (cancel) {
          abort.abort(); abort.abort();
          await Promise.resolve();
          expect(closeCount).toBe(0);
        }
        release.resolve();
        await handling;
        expect(status).toBe(cancel ? 499 : 200);
        if (cancel) expect(JSON.parse(body)).toEqual({ status: "cancelled", error: "ingest cancelled" });
        expect(logs.error).not.toHaveBeenCalled();
        expect(closeCount).toBe(1);
      } finally {
        release.resolve();
        await handling;
        await factory.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
}
