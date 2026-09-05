import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  clippedReads: 0,
  failReads: 0,
  failRemovals: 0,
  nlinkOverride: undefined as bigint | undefined,
  parentPath: undefined as string | undefined,
  invalidParent: false,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const originalLstat = actual.lstatSync;
  const originalRmdir = actual.rmdirSync;
  return {
    ...actual,
    lstatSync: vi.fn((path: Parameters<typeof originalLstat>[0], options?: Parameters<typeof originalLstat>[1]) => {
      if (fixture.failReads > 0 && typeof path === "string" && path.endsWith("/daemon-tmp")) {
        fixture.failReads -= 1;
        throw new Error("simulated lstat failure");
      }
      const stat = originalLstat(path, options as never) as Record<string, unknown>;
      if (fixture.parentPath !== undefined && path === fixture.parentPath) {
        if (fixture.invalidParent) {
          Object.defineProperty(stat, "isDirectory", { configurable: true, value: () => false });
        }
        else throw new Error("simulated parent lstat failure");
      }
      if (fixture.clippedReads > 0 && typeof path === "string" && path.endsWith("/daemon-tmp")) {
        fixture.clippedReads -= 1;
        Object.defineProperty(stat, "mode", {
          configurable: true,
          value: (stat.mode as bigint) & ~0o700n,
        });
        if (fixture.nlinkOverride !== undefined) Object.defineProperty(stat, "nlink", { configurable: true, value: fixture.nlinkOverride });
      }
      return stat;
    }),
    rmdirSync: vi.fn((path: Parameters<typeof originalRmdir>[0]) => {
      if (fixture.failRemovals > 0) {
        fixture.failRemovals -= 1;
        throw new Error("simulated rmdir failure");
      }
      return originalRmdir(path);
    }),
  };
});

const {
  createSupervisor,
  createSupervisorSpec,
} = await import("../../src/daemon/supervisor.js");

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lcm-umask-test-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function makeSpec(stateRoot: string) {
  return createSupervisorSpec({
    kind: "systemd-user",
    stateRoot,
    port: 3737,
    nonce: "umask-test",
    executable: "/usr/bin/node",
    args: ["/opt/lcm/dist/lcm.mjs", "daemon", "run-managed"],
  });
}

function runner() {
  const calls: string[] = [];
  const run = vi.fn(async (command: string) => {
    calls.push(command);
    return { code: 1, stderr: "Unit is not-found" };
  });
  return { calls, run };
}

describe("created daemon temporary directories under owner-clearing masks", () => {
  afterEach(() => {
    fixture.clippedReads = 0;
    fixture.failReads = 0;
    fixture.failRemovals = 0;
    fixture.nlinkOverride = undefined;
    fixture.parentPath = undefined;
    fixture.invalidParent = false;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("removes a newly created clipped leaf and preserves actionable guidance", async () => {
    const root = makeRoot();
    fixture.clippedReads = 2;
    const command = runner();
    const spec = makeSpec(root);
    await expect(createSupervisor("systemd-user", {
      run: command.run,
      platform: "linux",
      uid: 501,
    }).start(spec)).rejects.toThrow(
      "newly created daemon temp directory lacked required owner permissions, was removed, and retry should use an owner-preserving umask such as 0077",
    );
    expect(command.calls).not.toContain("systemd-run");
    expect(() => lstatSync(join(root, "daemon-tmp"))).toThrow();
  });

  it("keeps a replacement inode when the rollback witness changes", async () => {
    const root = makeRoot();
    fixture.clippedReads = 1;
    const command = runner();
    const spec = makeSpec(root);
    let replaced = false;
    await expect(createSupervisor("systemd-user", {
      run: command.run,
      platform: "linux",
      uid: 501,
      _daemonTempRaceForTesting: (path, phase) => {
        if (phase === "before-rollback" && !replaced) {
          replaced = true;
          rmSync(path, { recursive: true, force: true });
          mkdirSync(path, { mode: 0o700 });
        }
      },
    }).start(spec)).rejects.toThrow("supervisor manager command failed");
    expect(replaced).toBe(true);
    expect(command.calls).not.toContain("systemd-run");
    expect(lstatSync(join(root, "daemon-tmp")).isDirectory()).toBe(true);
  });

  it("removes a clipped leaf when the filesystem reports link count one", async () => {
    const root = makeRoot();
    fixture.clippedReads = 2;
    fixture.nlinkOverride = 1n;
    const command = runner();
    await expect(createSupervisor("systemd-user", {
      run: command.run,
      platform: "linux",
      uid: 501,
    }).start(makeSpec(root))).rejects.toThrow("owner-preserving umask");
    expect(command.calls).not.toContain("systemd-run");
    expect(() => lstatSync(join(root, "daemon-tmp"))).toThrow();
  });

  it("leaves the same clipped inode when rmdir rejects a nonempty directory", async () => {
    const root = makeRoot();
    fixture.clippedReads = 2;
    const command = runner();
    await expect(createSupervisor("systemd-user", {
      run: command.run,
      platform: "linux",
      uid: 501,
      _daemonTempRaceForTesting: (path, phase) => {
        if (phase === "before-rollback") writeFileSync(join(path, "child"), "content");
      },
    }).start(makeSpec(root))).rejects.toThrow("supervisor manager command failed");
    expect(command.calls).not.toContain("systemd-run");
    expect(lstatSync(join(root, "daemon-tmp", "child")).isFile()).toBe(true);
  });

  it("fails closed when the creation witness is unavailable", async () => {
    const root = makeRoot();
    fixture.failReads = 1;
    const command = runner();
    await expect(createSupervisor("systemd-user", {
      run: command.run,
      platform: "linux",
      uid: 501,
    }).start(makeSpec(root))).rejects.toThrow("supervisor manager command failed");
    expect(command.calls).not.toContain("systemd-run");
  });

  it("retains the clipped leaf when first canonical validation throws", async () => {
    const root = makeRoot();
    fixture.clippedReads = 1;
    fixture.parentPath = root;
    fixture.invalidParent = true;
    const command = runner();
    await expect(createSupervisor("systemd-user", {
      run: command.run,
      platform: "linux",
      uid: 501,
    }).start(makeSpec(root))).rejects.toThrow("supervisor manager command failed");
    expect(command.calls).not.toContain("systemd-run");
    expect(lstatSync(join(root, "daemon-tmp")).isDirectory()).toBe(true);
  });

  it("retains the leaf when bounded removal fails", async () => {
    const root = makeRoot();
    fixture.clippedReads = 2;
    fixture.failRemovals = 1;
    const command = runner();
    await expect(createSupervisor("systemd-user", {
      run: command.run,
      platform: "linux",
      uid: 501,
    }).start(makeSpec(root))).rejects.toThrow("supervisor manager command failed");
    expect(command.calls).not.toContain("systemd-run");
    expect(lstatSync(join(root, "daemon-tmp")).isDirectory()).toBe(true);
  });

  it("retains evidence when the parent changes before rollback", async () => {
    const root = makeRoot();
    const moved = `${root}-moved`;
    roots.push(moved);
    const outside = makeRoot();
    fixture.clippedReads = 1;
    const command = runner();
    await expect(createSupervisor("systemd-user", {
      run: command.run,
      platform: "linux",
      uid: 501,
      _daemonTempRaceForTesting: (path, phase) => {
        if (phase !== "before-rollback") return;
        rmSync(path, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
        mkdirSync(moved, { mode: 0o700 });
        symlinkSync(outside, root, "dir");
      },
    }).start(makeSpec(root))).rejects.toThrow("supervisor manager command failed");
    expect(command.calls).not.toContain("systemd-run");
  });

  it.each(["file", "symlink", "nonempty directory"] as const)(
    "retains a clipped leaf replaced by a %s",
    async (replacementKind) => {
      const root = makeRoot();
      const replacement = makeRoot();
      fixture.clippedReads = 1;
      const command = runner();
      await expect(createSupervisor("systemd-user", {
        run: command.run,
        platform: "linux",
        uid: 501,
        _daemonTempRaceForTesting: (path, phase) => {
          if (phase !== "before-rollback") return;
          rmSync(path, { recursive: true, force: true });
          if (replacementKind === "file") writeFileSync(path, "replacement");
          else if (replacementKind === "symlink") symlinkSync(replacement, path, "dir");
          else {
            mkdirSync(path, { mode: 0o700 });
            writeFileSync(join(path, "child"), "content");
          }
        },
      }).start(makeSpec(root))).rejects.toThrow("supervisor manager command failed");
      expect(command.calls).not.toContain("systemd-run");
      expect(lstatSync(join(root, "daemon-tmp")).isSymbolicLink()).toBe(replacementKind === "symlink");
      if (replacementKind === "nonempty directory") expect(lstatSync(join(root, "daemon-tmp", "child")).isFile()).toBe(true);
    },
  );

  it("proves real kernel umask behavior in isolated public-supervisor children", () => {
    const bundleRoot = makeRoot();
    const bundle = join(bundleRoot, "supervisor-umask-child.mjs");
    buildSync({
      bundle: true,
      entryPoints: [fileURLToPath(new URL("./supervisor-umask-child.ts", import.meta.url))],
      format: "esm",
      outfile: bundle,
      platform: "node",
    });
    const runChild = (mask: string, stateRoot = makeRoot()) => JSON.parse(execFileSync(
      process.execPath,
      [bundle],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", LCM_UMASK_MASK: mask, LCM_UMASK_STATE_ROOT: stateRoot },
      },
    )) as { calls: string[]; message: string; mode: string | null; outcome: string };
    for (const mask of ["0000", "0027", "0077"]) {
      const result = runChild(mask);
      expect(result.outcome).toBe("success");
      expect(result.mode).toBe("700");
      expect(result.calls).toContain("systemd-run");
    }
    for (const mask of ["0777", "0400", "0200", "0100"]) {
      const stateRoot = makeRoot();
      const result = runChild(mask, stateRoot);
      expect(result.outcome).toBe("failure");
      expect(result.message).toContain("owner-preserving umask");
      expect(result.mode).toBeNull();
      expect(result.calls).not.toContain("systemd-run");
    }

    const retryRoot = makeRoot();
    const firstFailure = runChild("0777", retryRoot);
    const secondFailure = runChild("0777", retryRoot);
    expect(firstFailure.mode).toBeNull();
    expect(secondFailure.mode).toBeNull();
    const recovered = runChild("0077", retryRoot);
    expect(recovered.outcome).toBe("success");
    expect(recovered.mode).toBe("700");

    for (const unsafeMode of [0o000, 0o755]) {
      const unsafeRoot = makeRoot();
      const unsafeLeaf = join(unsafeRoot, "daemon-tmp");
      mkdirSync(unsafeLeaf, { mode: unsafeMode });
      chmodSync(unsafeLeaf, unsafeMode);
      const before = lstatSync(unsafeLeaf);
      const refused = runChild("0077", unsafeRoot);
      const after = lstatSync(unsafeLeaf);
      expect(refused.outcome).toBe("failure");
      expect(refused.calls).not.toContain("systemd-run");
      expect(after.ino).toBe(before.ino);
      expect(after.mode & 0o777).toBe(unsafeMode);
      chmodSync(unsafeLeaf, 0o700);
      const repaired = runChild("0077", unsafeRoot);
      expect(repaired.outcome).toBe("success");
      expect(repaired.mode).toBe("700");
    }

    const removedRoot = makeRoot();
    const removedLeaf = join(removedRoot, "daemon-tmp");
    mkdirSync(removedLeaf, { mode: 0o755 });
    chmodSync(removedLeaf, 0o755);
    rmSync(removedLeaf, { recursive: true, force: true });
    const recreated = runChild("0077", removedRoot);
    expect(recreated.outcome).toBe("success");
    expect(recreated.mode).toBe("700");

    const safeRoot = makeRoot();
    const safeLeaf = join(safeRoot, "daemon-tmp");
    mkdirSync(safeLeaf, { mode: 0o700 });
    chmodSync(safeLeaf, 0o700);
    const safeBefore = lstatSync(safeLeaf);
    const safeResult = runChild("0777", safeRoot);
    const safeAfter = lstatSync(safeLeaf);
    expect(safeResult.outcome).toBe("success");
    expect(safeAfter.ino).toBe(safeBefore.ino);
    expect(safeResult.mode).toBe("700");
  });
});
