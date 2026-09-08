import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { appendLocalHookEvents } from "../src/hooks/local-enqueue.js";
import { eventSequenceDbPath, eventsDbPath } from "../src/db/events-path.js";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { withBackendPublicationAppendBarrierAsync } from "../src/storage/backend-publication.js";
import { SQLiteLocalHookOutboxFactory } from "../src/storage/local-hook-outbox.js";
import { SqliteStorageBackendFactory } from "../src/storage/sqlite/factory.js";

const workerMode = process.env.LCM_PHYSICAL_LIFECYCLE_WORKER;

if (workerMode === "barrier") {
  describe("physical lifecycle process fixture", () => {
    it("holds the real append barrier until released", async () => {
      const homeDir = process.env.LCM_PHYSICAL_LIFECYCLE_HOME!;
      const heldPath = process.env.LCM_PHYSICAL_LIFECYCLE_HELD!;
      const releasePath = process.env.LCM_PHYSICAL_LIFECYCLE_RELEASE!;
      await withBackendPublicationAppendBarrierAsync(homeDir, async () => {
        writeFileSync(heldPath, "held\n", { mode: 0o600 });
        const deadline = Date.now() + 10_000;
        while (!existsSync(releasePath)) {
          if (Date.now() >= deadline) throw new Error("parent did not release append barrier");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      });
    });
  });
} else {
  type Witness = Readonly<{
    main: string;
    wal: string | null;
    shm: string | null;
  }>;

  type HeldBarrier = Readonly<{
    child: ChildProcess;
    release: () => Promise<void>;
  }>;

  const roots: string[] = [];
  const originalHome = process.env.HOME;

  afterEach(() => {
    closeLcmConnection();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function digest(path: string): string | null {
    if (!existsSync(path)) return null;
    const stat = statSync(path, { bigint: true });
    return [
      stat.size,
      stat.mtimeNs,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ].join(":");
  }

  function witness(path: string): Witness {
    return { main: digest(path)!, wal: digest(`${path}-wal`), shm: digest(`${path}-shm`) };
  }

  function makeHome(label: string): { root: string; homeDir: string } {
    const root = mkdtempSync(join(tmpdir(), `lcm-physical-${label}-`));
    const homeDir = join(root, "home");
    mkdirSync(join(homeDir, ".lcm"), { recursive: true, mode: 0o700 });
    chmodSync(homeDir, 0o700);
    roots.push(root);
    process.env.HOME = homeDir;
    return { root, homeDir };
  }

  function makeProject(path: string): void {
    mkdirSync(path, { mode: 0o700 });
    execFileSync("git", ["init", "-q", path], { stdio: "ignore" });
  }

  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  async function processState(promise: Promise<unknown>): Promise<"pending" | "fulfilled" | "rejected"> {
    let state: "pending" | "fulfilled" | "rejected" = "pending";
    void promise.then(() => { state = "fulfilled"; }, () => { state = "rejected"; });
    await new Promise(resolve => setTimeout(resolve, 100));
    return state;
  }

  async function holdBarrier(root: string, homeDir: string): Promise<HeldBarrier> {
    const heldPath = join(root, "barrier-held");
    const releasePath = join(root, "barrier-release");
    const vitestPath = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
    const childEnvironment = { ...process.env };
    delete childEnvironment.LCM_TEST_ARTIFACT_ROOT;
    const child = spawn(process.execPath, [
      vitestPath,
      "run",
      fileURLToPath(import.meta.url),
      "--maxWorkers=1",
      "--reporter=dot",
    ], {
      cwd: process.cwd(),
      env: {
        ...childEnvironment,
        HOME: homeDir,
        LCM_PHYSICAL_LIFECYCLE_WORKER: "barrier",
        LCM_PHYSICAL_LIFECYCLE_HOME: homeDir,
        LCM_PHYSICAL_LIFECYCLE_HELD: heldPath,
        LCM_PHYSICAL_LIFECYCLE_RELEASE: releasePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", chunk => { output += String(chunk); });
    child.stderr?.on("data", chunk => { output += String(chunk); });
    await waitFor(() => existsSync(heldPath) || child.exitCode !== null, "child append barrier");
    if (!existsSync(heldPath)) throw new Error(`barrier worker exited early: ${output}`);
    return {
      child,
      release: async () => {
        writeFileSync(releasePath, "release\n", { mode: 0o600 });
        await new Promise<void>((resolve, reject) => {
          if (child.exitCode !== null) {
            if (child.exitCode === 0) resolve();
            else reject(new Error(`barrier worker failed: ${output}`));
            return;
          }
          child.once("error", reject);
          child.once("exit", code => {
            if (code === 0) resolve();
            else reject(new Error(`barrier worker failed: ${output}`));
          });
        });
      },
    };
  }

  describe("cross-process SQLite physical lifecycle", () => {
    it("waits for a live capture barrier before enqueuing the hook event", async () => {
      const { root, homeDir } = makeHome("append");
      const cwd = join(root, "project");
      makeProject(cwd);
      const held = await holdBarrier(root, homeDir);
      const append = appendLocalHookEvents({
        cwd,
        sessionId: "waiting-hook",
        events: [{ type: "decision", category: "decision", data: "waited", priority: 1 }],
        sourceHook: "PostToolUse",
      });
      try {
        await expect(processState(append)).resolves.toBe("pending");
        expect(held.child.exitCode).toBeNull();
      } finally {
        await held.release();
      }
      await expect(append).resolves.toEqual({ inserted: 1, pendingCount: 1 });
    });

    it("surfaces a retry-required timeout before the first hook insert", async () => {
      const { root, homeDir } = makeHome("append-timeout");
      const cwd = join(root, "project");
      makeProject(cwd);
      const held = await holdBarrier(root, homeDir);
      const controlledAppend = appendLocalHookEvents as unknown as (
        input: Parameters<typeof appendLocalHookEvents>[0],
        dependencies: Readonly<{
          appendBarrierOptions: Readonly<{ contentionWaitMs: number; retryDelayMs: number }>;
        }>,
      ) => ReturnType<typeof appendLocalHookEvents>;
      const startedAt = Date.now();
      try {
        await expect(controlledAppend({
          cwd,
          sessionId: "timed-out-hook",
          events: [{ type: "decision", category: "decision", data: "timeout", priority: 1 }],
          sourceHook: "PostToolUse",
        }, {
          appendBarrierOptions: { contentionWaitMs: 75, retryDelayMs: 10 },
        })).rejects.toMatchObject({
          name: "LocalHookDurabilityTimeoutError",
          retryRequired: true,
        });
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);
        expect(existsSync(eventsDbPath(cwd))).toBe(false);
      } finally {
        await held.release();
      }
    });

    it("keeps outbox and sequence teardown behind a live capture barrier", async () => {
      const { root, homeDir } = makeHome("outbox-close");
      const cwd = join(root, "project");
      makeProject(cwd);
      const dbPath = eventsDbPath(cwd);
      const factory = new SQLiteLocalHookOutboxFactory();
      const repository = await factory.open(dbPath);
      await repository.insertEvent("close-hook", {
        type: "decision", category: "decision", data: "close", priority: 1,
      }, "PostToolUse");
      const sequencePath = eventSequenceDbPath(homeDir);
      const before = { outbox: witness(dbPath), sequence: witness(sequencePath) };
      expect(before.outbox.wal).not.toBeNull();
      expect(before.sequence.wal).not.toBeNull();
      const held = await holdBarrier(root, homeDir);
      const close = factory.close();
      try {
        await expect(processState(close)).resolves.toBe("pending");
        expect({ outbox: witness(dbPath), sequence: witness(sequencePath) }).toEqual(before);
        expect(held.child.exitCode).toBeNull();
      } finally {
        await held.release();
      }
      await close;
      expect(witness(dbPath)).not.toEqual(before.outbox);
    });

    it("keeps final project teardown behind a live capture barrier", async () => {
      const { root, homeDir } = makeHome("project-close");
      const projectId = "c".repeat(64);
      const canonical = join(root, "project");
      const projectDirectory = join(homeDir, ".lcm", "projects", projectId);
      const dbPath = join(projectDirectory, "db.sqlite");
      makeProject(canonical);
      mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
      const factory = new SqliteStorageBackendFactory({
        resolveProject: () => ({ id: projectId, dbPath }),
      });
      const project = await factory.openProject({ id: projectId, canonical });
      const extraReference = getLcmConnection(dbPath);
      extraReference.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
      extraReference.exec("CREATE TABLE candidate9_close_probe (value TEXT NOT NULL)");
      extraReference.prepare("INSERT INTO candidate9_close_probe(value) VALUES (?)").run("pending");
      closeLcmConnection(dbPath, extraReference);
      const before = witness(dbPath);
      expect(before.wal).not.toBeNull();
      const held = await holdBarrier(root, homeDir);
      const close = project.close();
      try {
        await expect(processState(close)).resolves.toBe("pending");
        expect(witness(dbPath)).toEqual(before);
        expect(held.child.exitCode).toBeNull();
      } finally {
        await held.release();
      }
      await close;
      expect(witness(dbPath)).not.toEqual(before);
      await factory.close();
    });
  });
}
