import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scanMocks = vi.hoisted(() => ({
  eventsDir: "",
  lstat: vi.fn(),
  open: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  scanMocks.lstat.mockImplementation(actual.lstatSync);
  scanMocks.readdir.mockImplementation(actual.readdirSync);
  return {
    ...actual,
    lstatSync: scanMocks.lstat,
    readdirSync: scanMocks.readdir,
  };
});
vi.mock("../../src/db/events-path.js", () => ({
  eventsDir: () => scanMocks.eventsDir,
}));
vi.mock("../../src/runtime-paths.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/runtime-paths.js")>(),
  projectsDir: () => join(scanMocks.eventsDir, "projects"),
}));
vi.mock("../../src/storage/local-hook-outbox.js", () => ({
  SQLiteLocalHookOutboxFactory: class {
    async open(path: string) {
      scanMocks.open(path);
      return {
        getHealthStats: async () => ({
          totalEvents: 0,
          unprocessed: 0,
          errors: 0,
          lastCapture: null,
          deliveryPending: 0,
          deliveryClaimed: 0,
          deliveryRetry: 0,
          deliveryReplicated: 0,
          deliveryAcknowledged: 0,
          deliveryAwaitingRemotePrune: 0,
          deliveryQuarantined: 0,
          oldestDeliveryAt: null,
        }),
      };
    }

    async close() {}
  },
}));

import { collectEventSidecars } from "../../src/db/event-sidecars.js";
import {
  serializeWorktreeReconciliationFence,
} from "../../src/worktree-reconciliation-fence.js";

describe("event sidecar discovery", () => {
  beforeEach(() => {
    scanMocks.eventsDir = mkdtempSync(join(tmpdir(), "event-sidecar-discovery-"));
    scanMocks.lstat.mockClear();
    scanMocks.open.mockClear();
    scanMocks.readdir.mockClear();
  });

  afterEach(() => {
    rmSync(scanMocks.eventsDir, { recursive: true, force: true });
  });

  it("does not pre-stat a known regular sidecar during discovery", async () => {
    const path = join(scanMocks.eventsDir, `${"a".repeat(64)}.db`);
    writeFileSync(path, "");

    const sidecars = await collectEventSidecars({ pruneOrphanSidecars: false });

    expect(sidecars).toHaveLength(1);
    expect(scanMocks.open).toHaveBeenCalledOnce();
    expect(scanMocks.open).toHaveBeenCalledWith(path);
    expect(scanMocks.lstat).toHaveBeenCalledOnce();
    expect(scanMocks.lstat).toHaveBeenCalledWith(path);
  });

  it("uses strict fence validation as the safe fallback for an unknown Dirent type", async () => {
    const hash = "b".repeat(64);
    const path = join(scanMocks.eventsDir, `${hash}.db`);
    mkdirSync(path);
    writeFileSync(
      join(path, "fence.json"),
      serializeWorktreeReconciliationFence(hash, "events"),
    );
    const [entry] = readdirSync(scanMocks.eventsDir, { withFileTypes: true });
    if (!entry) throw new Error("expected an event fence directory entry");
    scanMocks.readdir.mockReturnValueOnce([{
      ...entry,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isDirectory: () => false,
      isFIFO: () => false,
      isFile: () => false,
      isSocket: () => false,
      isSymbolicLink: () => false,
    }]);

    expect(await collectEventSidecars({ maxDbs: 0 })).toEqual([]);
    expect(scanMocks.open).not.toHaveBeenCalled();
    expect(scanMocks.lstat).toHaveBeenCalledWith(path);
  });

  it("stops fence authentication after the discovery deadline expires", async () => {
    const hash = "c".repeat(64);
    const path = join(scanMocks.eventsDir, `${hash}.db`);
    mkdirSync(path);
    writeFileSync(
      join(path, "fence.json"),
      serializeWorktreeReconciliationFence(hash, "events"),
    );

    const sidecars = await collectEventSidecars({ timeoutMs: -1 });

    expect(sidecars).toHaveLength(1);
    expect(sidecars[0].file).toBe(`${hash}.db`);
    expect(sidecars[0].scanSkipped).toContain("timeout");
    expect(scanMocks.lstat).not.toHaveBeenCalled();
    expect(scanMocks.open).not.toHaveBeenCalled();
  });
});
