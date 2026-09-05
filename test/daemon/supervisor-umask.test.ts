import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  clippedReads: 0,
  failReads: 0,
  failRemovals: 0,
  modeOverride: undefined as bigint | undefined,
  uidOverride: undefined as bigint | undefined,
  directoryOverride: undefined as boolean | undefined,
  symlinkOverride: undefined as boolean | undefined,
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
      if (fixture.clippedReads > 0 && typeof path === "string" && path.endsWith("/daemon-tmp")) {
        fixture.clippedReads -= 1;
        Object.defineProperty(stat, "mode", {
          configurable: true,
          value: (stat.mode as bigint) & ~0o700n,
        });
        if (fixture.modeOverride !== undefined) Object.defineProperty(stat, "mode", { configurable: true, value: fixture.modeOverride });
        if (fixture.uidOverride !== undefined) Object.defineProperty(stat, "uid", { configurable: true, value: fixture.uidOverride });
        if (fixture.directoryOverride !== undefined) Object.defineProperty(stat, "isDirectory", { configurable: true, value: () => fixture.directoryOverride });
        if (fixture.symlinkOverride !== undefined) Object.defineProperty(stat, "isSymbolicLink", { configurable: true, value: () => fixture.symlinkOverride });
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
    fixture.modeOverride = undefined;
    fixture.uidOverride = undefined;
    fixture.directoryOverride = undefined;
    fixture.symlinkOverride = undefined;
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
    const replacement = makeRoot();
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

  it.each([
    ["extra permission bits", { modeOverride: 0o40750n }],
    ["wrong owner", { uidOverride: 1n }],
    ["unexpected type", { directoryOverride: false }],
  ] as const)("leaves a created %s for normal authentication", async (_label, override) => {
    const root = makeRoot();
    fixture.clippedReads = 1;
    Object.assign(fixture, override);
    const command = runner();
    await expect(createSupervisor("systemd-user", {
      run: command.run,
      platform: "linux",
      uid: 501,
    }).start(makeSpec(root))).rejects.toThrow("supervisor manager command failed");
    expect(command.calls).toContain("systemd-run");
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
});
