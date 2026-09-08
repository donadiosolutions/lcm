import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { BackendPublicationCoordinator, type BackendPublicationDriver } from "../../src/storage/backend-publication.js";
import { SQLiteLocalHookOutboxFactory } from "../../src/storage/local-hook-outbox.js";
import { eventsDbPath } from "../../src/db/events-path.js";
import { handleSessionStart } from "../../src/hooks/restore.js";
import { ensureDaemon } from "../../src/daemon/lifecycle.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({ ensureDaemon: vi.fn() }));
vi.mock("../../src/hooks/session-end.js", () => ({ firePromoteEventsRequest: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("preserves acknowledged remote-pruned events when maintenance enters during SessionStart daemon admission (#1155)", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "lcm-restore-held-")); roots.push(homeDir);
  vi.stubEnv("HOME", homeDir); vi.stubEnv("USERPROFILE", homeDir);
  mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
  const cwd = join(homeDir, "project"); mkdirSync(cwd, { mode: 0o700 });
  const path = eventsDbPath(cwd);
  const factory = new SQLiteLocalHookOutboxFactory();
  const outbox = await factory.open(path);
  const seed = async () => {
    const id = await outbox.insertEvent("old", { type: "decision", category: "decision", data: "preserved exact acknowledged envelope", priority: 1 }, "SessionStart");
    await outbox.markProcessed([id]);
    const db = new DatabaseSync(path);
    db.prepare(`UPDATE events SET delivery_state='acknowledged',remote_inbox_id='1',acknowledged_at=datetime('now'),
      remote_pruned_at=datetime('now'),processed_at=datetime('now','-40 days') WHERE event_id=?`).run(id);
    db.close(); return id;
  };
  await seed();
  expect(await outbox.pruneProcessed(7)).toBe(1); // Actual destructive control.
  const retained = await seed();
  const read = () => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare("SELECT * FROM events WHERE event_id=?").get(retained); } finally { db.close(); } };
  const before = read();
  await factory.close();
  let entered!: () => void; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = new Promise<void>((resolve) => { entered = resolve; });
  vi.mocked(ensureDaemon).mockImplementationOnce(async () => { entered(); await gate; return { connected: true, port: 3737, spawned: false }; });
  const restore = handleSessionStart(JSON.stringify({ cwd, session_id: "held-scavenge" }), { post: vi.fn() } as never, 3737);
  await pending;
  const unused = async (): Promise<never> => { throw new Error("unexpected v2 call"); };
  const driver: BackendPublicationDriver = { observeLocalState: unused, publishProjectMap: unused, publishConfig: unused, restoreConfig: unused, restoreProjectMap: unused };
  await new BackendPublicationCoordinator({ homeDir, driver }).enterMaintenance({
    publicationId: "restore-race", generationId: "restore-race", sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
    roster: [{ machineId: "018f0b5d-1234-7abc-8def-1234567890ab", queueCutoff: "0000000000000000001", evidenceSha256: "b".repeat(64) }],
  });
  release();
  await expect(restore).rejects.toMatchObject({ reason: "unresolved-publication" });
  expect(read()).toEqual(before);
});
