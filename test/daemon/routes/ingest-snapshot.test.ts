import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ScrubEngine } from "../../../src/scrub.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { createStorageBackendFactory } from "../../../src/storage/index.js";
import { createIngestHandler } from "../../../src/daemon/routes/ingest.js";
import { projectIdentity, projectDbPath } from "../../../src/daemon/project.js";
import * as nativeSource from "../../../src/storage/native-transcript-ingest.js";
import { closeLcmConnection, getLcmConnection } from "../../../src/db/connection.js";
const logs = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../../../src/hooks/hook-errors.js", () => ({ safeLogError: logs.error }));
afterEach(() => vi.restoreAllMocks());

for (const client of ["claude", "codex"] as const) {
  for (const boundary of ["before-bind", "during-preparation", "during-admission", "after-parsed", "during-backfill", "continuous", "metadata-retry"] as const) {
    it(`${client} keeps one source epoch across ${boundary}`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "native-append-"));
      const source = join(cwd, "transcript.jsonl");
      const record = (role: string, content: string) => JSON.stringify(client === "claude"
        ? { message: { role, content } }
        : { type: "response_item", payload: { type: "message", role, content } }) + "\n";
      const first = record("user", "first SECRET");
      const second = record("assistant", "second SECRET");
      writeFileSync(source, first, { mode: 0o600 });
      const config = loadDaemonConfig(join(cwd, "nonexistent"), { security: { sensitivePatterns: ["SECRET"] } });
      const factory = await createStorageBackendFactory(config.storage);
      const open = factory.openProject.bind(factory);
      const createSource = nativeSource.createFileNativeTranscriptSource;
      let opens = 0;
      let closes = 0;
      vi.spyOn(nativeSource, "createFileNativeTranscriptSource").mockImplementation((...args) => {
        const byteSource = createSource(...args);
        return { openSnapshot: async () => {
          if (boundary === "before-bind" && opens === 0) appendFileSync(source, second);
          opens++;
          const snapshot = await byteSource.openSnapshot();
          const close = snapshot.close.bind(snapshot);
          snapshot.close = async () => { closes++; await close(); };
          return snapshot;
        } };
      });
      let appends = 0;
      let checkpoints = 0;
      if (boundary === "during-preparation") {
        const prepare = ScrubEngine.forProject.bind(ScrubEngine);
        vi.spyOn(ScrubEngine, "forProject").mockImplementation(async (...args) => {
          const scrubber = await prepare(...args);
          if (appends++ === 0) appendFileSync(source, second);
          return scrubber;
        });
      }
      vi.spyOn(factory, "openProject").mockImplementation(async (...args) => {
        const project = await open(...args);
        const append = () => {
          if (appends > 0 && boundary !== "continuous") return;
          appendFileSync(source, boundary === "metadata-retry" ? '{"type":"metadata"}\n' : second);
          appends++;
        };
        if (boundary === "during-admission") append();
        if (boundary === "after-parsed" || boundary === "metadata-retry") {
          const transaction = project.transaction.bind(project);
          vi.spyOn(project, "transaction").mockImplementation(async (operation) => {
            const result = await transaction(operation);
            append();
            return result;
          });
        }
        const repository = project.nativeTranscripts!.repository;
        const original = repository.getCheckpoint.bind(repository);
        vi.spyOn(repository, "getCheckpoint").mockImplementation(async (...checkpointArgs) => {
          checkpoints++;
          if (boundary === "during-backfill" || boundary === "continuous") append();
          return original(...checkpointArgs);
        });
        return project;
      });
      let status = 0;
      let body = "";
      const res = { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; } };
      logs.error.mockClear();
      try {
        const handler = createIngestHandler(config, factory);
        const payload = JSON.stringify({ cwd, client, session_id: "synthetic-append", transcript_path: source });
        await handler({} as never, res as never, payload);
        expect(opens).toBe(boundary === "before-bind" ? 1 : 2);
        expect(closes).toBe(opens);
        if (boundary === "continuous") {
          expect(status).toBe(500);
          expect(checkpoints).toBe(2);
          expect(logs.error).toHaveBeenCalledTimes(1);
          expect(logs.error.mock.calls[0][1]).toMatchObject({ name: "NativeTranscriptSourceChangedError" });
          vi.mocked(factory.openProject).mockImplementation(open);
          await handler({} as never, res as never, payload);
          expect(status).toBe(200);
        } else {
          expect(status).toBe(200);
          expect(logs.error).not.toHaveBeenCalled();
          const expectedMessages = boundary === "metadata-retry" ? 1 : 2;
          expect(JSON.parse(body)).toMatchObject({ ingested: expectedMessages, redacted: expectedMessages });
          expect(JSON.parse(body).totalTokens).toBeGreaterThan(0);
          expect(checkpoints).toBe(boundary === "during-backfill" ? 2 : 1);
        }
        const dbPath = projectDbPath(cwd);
        const db = getLcmConnection(dbPath);
        try {
          const expectedMessages = boundary === "metadata-retry" ? 1 : boundary === "continuous" ? 3 : 2;
          expect(db.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: expectedMessages });
          expect(db.prepare("SELECT count(*) AS n FROM runtime_native_transcript_messages").get()).toEqual({ n: expectedMessages });
          expect(db.prepare("SELECT source_locator FROM runtime_native_ingest_checkpoints").get()).toEqual({ source_locator: createHash("sha256").update(source).digest("hex") });
          expect(db.prepare("SELECT imported_count FROM runtime_native_ingest_checkpoints").get()).toEqual({ imported_count: boundary === "metadata-retry" ? 2 : expectedMessages });
        } finally { closeLcmConnection(dbPath); }
        vi.mocked(factory.openProject).mockImplementation(open);
        await handler({} as never, res as never, payload);
        expect(status).toBe(200);
        expect(JSON.parse(body)).toEqual({ ingested: 0, totalTokens: 0 });
        const project = await open(projectIdentity(cwd, config.storage));
        await project.close();
      } finally {
        await factory.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
}

for (const client of ["claude", "codex"] as const) {
for (const mutation of ["disappear", "replace", "truncate", "rewrite"] as const) {
  it(`${client} preserves exact bytes when a bound source can ${mutation}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "native-source-fence-"));
    const source = join(cwd, "transcript.jsonl");
    const record = (content: string) => JSON.stringify(client === "claude"
      ? { message: { role: "user", content } }
      : { type: "response_item", payload: { type: "message", role: "user", content } }) + "\n";
    const original = record("original");
    const replacement = record("replaced");
    writeFileSync(source, original, { mode: 0o600 });
    const config = loadDaemonConfig(join(cwd, "nonexistent"));
    const factory = await createStorageBackendFactory(config.storage);
    const open = factory.openProject.bind(factory);
    let changed = false;
    vi.spyOn(factory, "openProject").mockImplementation(async (...args) => {
      const project = await open(...args);
      if (mutation === "disappear") rmSync(source);
      else {
        const transaction = project.transaction.bind(project);
        vi.spyOn(project, "transaction").mockImplementation(async operation => {
          const result = await transaction(operation);
          if (!changed) {
            changed = true;
            if (mutation === "replace") rmSync(source);
            writeFileSync(source, mutation === "truncate" ? "" : replacement, { mode: 0o600 });
          }
          return result;
        });
      }
      return project;
    });
    let status = 0;
    const res = { writeHead: (code: number) => { status = code; }, end: () => undefined };
    logs.error.mockClear();
    try {
      await createIngestHandler(config, factory)({} as never, res as never,
        JSON.stringify({ cwd, client, session_id: "source-fence", transcript_path: source }));
      // Replacement can finish the unchanged old descriptor. Shrink/rewrite
      // must not acknowledge a retry that discards the original byte prefix.
      expect(status).toBe(mutation === "replace" ? 200 : 500);
      const dbPath = projectDbPath(cwd);
      const db = getLcmConnection(dbPath);
      try {
        expect(db.prepare("SELECT content FROM messages").all()).toEqual(mutation === "disappear" ? [] : [{ content: "original" }]);
        expect(db.prepare("SELECT count(*) AS n FROM runtime_native_transcript_messages").get()).toEqual({ n: mutation === "replace" ? 1 : 0 });
      } finally { closeLcmConnection(dbPath); }
    } finally {
      await factory.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
}
