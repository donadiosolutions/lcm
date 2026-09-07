import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scanMocks = vi.hoisted(() => ({
  eventsDir: "",
  closeDescriptor: vi.fn(),
  closeFactory: vi.fn(),
  closeFailureEnabled: false,
  descriptorGidChanged: false,
  open: vi.fn(),
  remove: vi.fn(),
  onClose: undefined as (() => void) | undefined,
  onHealth: undefined as (() => void) | undefined,
  onOpen: undefined as (() => void) | undefined,
  onReadDirectory: undefined as (() => void) | undefined,
  onRecentErrors: undefined as (() => void) | undefined,
  onRemove: undefined as ((path: string, remove: () => void) => void) | undefined,
  readDirectoryError: undefined as Error | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    closeSync: (fd: number) => {
      scanMocks.closeDescriptor(fd);
      actual.closeSync(fd);
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      const stat = actual.fstatSync(...args);
      if (!scanMocks.descriptorGidChanged || typeof stat.gid !== "bigint") return stat;
      return {
        isDirectory: () => stat.isDirectory(),
        mode: stat.mode,
        uid: stat.uid,
        gid: stat.gid + 1n,
        nlink: stat.nlink,
        dev: stat.dev,
        ino: stat.ino,
      };
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (scanMocks.readDirectoryError) throw scanMocks.readDirectoryError;
      const entries = actual.readdirSync(...args);
      scanMocks.onReadDirectory?.();
      return entries;
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      const path = String(args[0]);
      const remove = () => actual.rmSync(...args);
      scanMocks.remove(path);
      if (scanMocks.onRemove) return scanMocks.onRemove(path, remove);
      return remove();
    },
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
      scanMocks.onOpen?.();
      return {
        getHealthStats: async () => {
          scanMocks.onHealth?.();
          return {
            totalEvents: 0,
            unprocessed: 0,
            errors: 0,
            lastCapture: null,
            lastError: null,
            deliveryPending: 0,
            deliveryClaimed: 0,
            deliveryRetry: 0,
            deliveryReplicated: 0,
            deliveryAcknowledged: 0,
            deliveryAwaitingRemotePrune: 0,
            deliveryQuarantined: 0,
            oldestDeliveryAt: null,
          };
        },
        getRecentErrors: async () => {
          scanMocks.onRecentErrors?.();
          return [];
        },
      };
    }

    async close() {
      scanMocks.closeFactory();
      scanMocks.onClose?.();
      if (scanMocks.closeFailureEnabled) throw undefined;
    }
  },
}));

import { collectEventSidecars } from "../../src/db/event-sidecars.js";

const sidecarFile = `${"a".repeat(64)}.db`;
const laterSidecarFile = `${"b".repeat(64)}.db`;

describe("event sidecar parent authentication", () => {
  const cleanupPaths = new Set<string>();

  beforeEach(() => {
    scanMocks.eventsDir = temporaryDirectory("event-sidecar-parent-");
    scanMocks.closeDescriptor.mockClear();
    scanMocks.closeFactory.mockClear();
    scanMocks.closeFailureEnabled = false;
    scanMocks.descriptorGidChanged = false;
    scanMocks.open.mockClear();
    scanMocks.remove.mockClear();
    scanMocks.onClose = undefined;
    scanMocks.onHealth = undefined;
    scanMocks.onOpen = undefined;
    scanMocks.onReadDirectory = undefined;
    scanMocks.onRecentErrors = undefined;
    scanMocks.onRemove = undefined;
    scanMocks.readDirectoryError = undefined;
  });

  afterEach(() => {
    scanMocks.onRemove = undefined;
    for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true });
    cleanupPaths.clear();
  });

  function temporaryDirectory(prefix: string): string {
    const path = mkdtempSync(join(tmpdir(), prefix));
    cleanupPaths.add(path);
    return path;
  }

  function createPrunableSidecar(directory = scanMocks.eventsDir, file = sidecarFile): string {
    const path = join(directory, file);
    writeFileSync(path, `database:${file}`);
    writeFileSync(`${path}-wal`, `wal:${file}`);
    writeFileSync(`${path}-shm`, `shm:${file}`);
    return path;
  }

  function swapParent(): { attacker: string; displaced: string } {
    const attacker = temporaryDirectory("event-sidecar-attacker-");
    createPrunableSidecar(attacker);
    const displaced = `${scanMocks.eventsDir}.displaced`;
    cleanupPaths.add(displaced);
    renameSync(scanMocks.eventsDir, displaced);
    symlinkSync(attacker, scanMocks.eventsDir, "dir");
    return { attacker, displaced };
  }

  function expectSidecarFiles(directory: string): void {
    const path = join(directory, sidecarFile);
    expect(readFileSync(path, "utf8")).toBe(`database:${sidecarFile}`);
    expect(readFileSync(`${path}-wal`, "utf8")).toBe(`wal:${sidecarFile}`);
    expect(readFileSync(`${path}-shm`, "utf8")).toBe(`shm:${sidecarFile}`);
  }

  it("returns an empty scan for missing, unsafe, and same-inode alias parents", async () => {
    const missing = join(scanMocks.eventsDir, "missing");
    scanMocks.eventsDir = missing;
    expect(await collectEventSidecars()).toEqual([]);

    const unsafe = temporaryDirectory("event-sidecar-unsafe-");
    createPrunableSidecar(unsafe);
    chmodSync(unsafe, 0o755);
    scanMocks.eventsDir = unsafe;
    expect(await collectEventSidecars()).toEqual([]);
    expectSidecarFiles(unsafe);

    const target = temporaryDirectory("event-sidecar-alias-target-");
    createPrunableSidecar(target);
    const alias = join(temporaryDirectory("event-sidecar-alias-parent-"), "events");
    symlinkSync(target, alias, "dir");
    scanMocks.eventsDir = alias;
    expect(await collectEventSidecars()).toEqual([]);
    expectSidecarFiles(target);
  });

  it("closes the retained parent after admission, enumeration, empty, and limited scans", async () => {
    chmodSync(scanMocks.eventsDir, 0o755);
    expect(await collectEventSidecars()).toEqual([]);
    expect(scanMocks.closeDescriptor).toHaveBeenCalledOnce();

    chmodSync(scanMocks.eventsDir, 0o700);
    scanMocks.closeDescriptor.mockClear();
    scanMocks.readDirectoryError = new Error("enumeration failed");
    expect(await collectEventSidecars()).toEqual([]);
    expect(scanMocks.closeDescriptor).toHaveBeenCalledOnce();

    scanMocks.closeDescriptor.mockClear();
    scanMocks.readDirectoryError = undefined;
    expect(await collectEventSidecars()).toEqual([]);
    expect(scanMocks.closeDescriptor).toHaveBeenCalledOnce();

    scanMocks.closeDescriptor.mockClear();
    createPrunableSidecar();
    expect(await collectEventSidecars({ maxDbs: 0 })).toHaveLength(1);
    expect(scanMocks.closeDescriptor).toHaveBeenCalledOnce();
  });

  it("allows child-directory churn while retaining the same parent identity", async () => {
    scanMocks.onReadDirectory = () => mkdirSync(join(scanMocks.eventsDir, "new-child"));

    expect(await collectEventSidecars()).toEqual([]);
    expect(scanMocks.closeDescriptor).toHaveBeenCalledOnce();
  });

  it("rejects stable parent-witness drift even when its pathname identity remains", async () => {
    createPrunableSidecar();
    scanMocks.onReadDirectory = () => {
      scanMocks.descriptorGidChanged = true;
    };

    expect(await collectEventSidecars()).toEqual([]);
    expectSidecarFiles(scanMocks.eventsDir);
    expect(scanMocks.closeDescriptor).toHaveBeenCalledOnce();
  });

  it("prunes a sidecar under an unchanged private parent", async () => {
    const path = createPrunableSidecar();

    const [summary] = await collectEventSidecars();

    expect(summary).toMatchObject({ path, pruned: true, pruneReason: "empty orphan sidecar" });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(scanMocks.closeDescriptor).toHaveBeenCalledOnce();
  });

  it.each([
    ["open", "onOpen"],
    ["health read", "onHealth"],
    ["recent-error read", "onRecentErrors"],
    ["factory close", "onClose"],
  ] as const)("stops after parent drift during %s", async (_label, hook) => {
    createPrunableSidecar();
    createPrunableSidecar(scanMocks.eventsDir, laterSidecarFile);
    let swapped: ReturnType<typeof swapParent> | undefined;
    scanMocks[hook] = () => {
      swapped = swapParent();
      scanMocks[hook] = undefined;
    };

    const summaries = await collectEventSidecars({ includeRecentErrors: true });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ file: sidecarFile });
    expect(summaries[0].scanError).toBe("event sidecar parent changed during scan");
    expect(summaries[0].pruned).toBeUndefined();
    expect(scanMocks.open).toHaveBeenCalledOnce();
    expect(scanMocks.closeFactory).toHaveBeenCalledOnce();
    expectSidecarFiles(swapped!.attacker);
    expectSidecarFiles(swapped!.displaced);
  });

  it.each([
    ["database", ""],
    ["WAL", "-wal"],
    ["SHM", "-shm"],
  ] as const)(
    "detects parent drift after removing the %s file",
    async (_label, suffix) => {
      const path = createPrunableSidecar();
      let swapped: ReturnType<typeof swapParent> | undefined;
      scanMocks.onRemove = (removedPath, remove) => {
        remove();
        if (removedPath === `${path}${suffix}`) {
          swapped = swapParent();
          scanMocks.onRemove = undefined;
        }
      };

      const [summary] = await collectEventSidecars();

      expect(summary.scanError).toBe("event sidecar parent changed during scan");
      expect(summary.pruned).toBeUndefined();
      expectSidecarFiles(swapped!.attacker);
      const removedIndex = ["", "-wal", "-shm"].indexOf(suffix);
      for (const [index, remainingSuffix] of ["", "-wal", "-shm"].entries()) {
        expect(existsSync(join(swapped!.displaced, `${sidecarFile}${remainingSuffix}`)))
          .toBe(index > removedIndex);
      }
    },
  );

  it("never reports pruning when a sidecar removal fails", async () => {
    const path = createPrunableSidecar();
    scanMocks.onRemove = (removedPath, remove) => {
      if (removedPath === `${path}-wal`) throw new Error("refused removal");
      remove();
    };

    const [summary] = await collectEventSidecars();

    expect(summary.scanError).toBe("refused removal");
    expect(summary.pruned).toBeUndefined();
  });

  it("does not swallow a factory close rejection without an error value", async () => {
    const path = createPrunableSidecar();
    scanMocks.closeFailureEnabled = true;

    const [summary] = await collectEventSidecars();

    expect(summary.scanError).toBe("failed to scan sidecar");
    expect(summary.pruned).toBeUndefined();
    expect(existsSync(path)).toBe(true);
    expect(scanMocks.closeFactory).toHaveBeenCalledOnce();
  });
});
