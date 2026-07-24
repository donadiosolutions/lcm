import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensurePendingMachineIdentity,
  finalizeMachineIdentity,
  isUuidV7,
  machineIdentityPath,
  MachineIdentityFileError,
  oldMachineIdentitiesDir,
  readMachineIdentity,
  recoverMachineIdentity,
  requireMachineIdentity,
  type MachineIdentity,
} from "../src/machine-identity.js";

const MACHINE_A = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012";
const MACHINE_B = "018f22c4-6d2a-7f10-9a4c-6b8d3e5f9013";

describe("machine identity file", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-machine-identity-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it("uses the private LCM paths and recognizes UUIDv7 values", () => {
    expect(machineIdentityPath(home)).toBe(join(home, ".lcm", "machine.json"));
    expect(oldMachineIdentitiesDir(home)).toBe(join(home, ".lcm", "oldmachines"));
    expect(isUuidV7(MACHINE_A)).toBe(true);
    expect(isUuidV7("6ba7b810-9dad-41d1-80b4-00c04fd430c8")).toBe(false);
  });

  it("creates one race-safe pending identity and reuses it", () => {
    const first = ensurePendingMachineIdentity("Machine A", home);
    const second = ensurePendingMachineIdentity("ignored", home);

    expect(first.created).toBe(true);
    expect(first.identity).toMatchObject({
      version: 1,
      machineId: null,
      displayName: "Machine A",
    });
    expect(first.identity.identityKey).toMatch(/^machine:[a-f0-9]{64}$/u);
    expect(second).toEqual({ identity: first.identity, created: false });
    expect(statSync(machineIdentityPath(home)).mode & 0o777).toBe(0o600);
  });

  it("uses the hostname default and adopts the winner of an exclusive registration race", () => {
    const winner = ensurePendingMachineIdentity(undefined, home, {
      writeExclusive: (path, content) => {
        mkdirSync(join(home, ".lcm"), { recursive: true });
        writeFileSync(path, content, { mode: 0o600 });
        return false;
      },
    });
    expect(winner.created).toBe(false);
    expect(winner.identity.displayName.length).toBeGreaterThan(0);
    expect(winner.identity).toEqual(readMachineIdentity(home));
  });

  it("fails safely when the winner disappears during an exclusive registration race", () => {
    expect(() => ensurePendingMachineIdentity("Machine A", home, {
      writeExclusive: () => false,
    })).toThrow("disappeared during concurrent registration");
  });

  it("finalizes and requires a registered identity", () => {
    const pending = ensurePendingMachineIdentity("Machine A", home).identity;
    expect(() => requireMachineIdentity(home)).toThrow("registration is pending");

    const identity = finalizeMachineIdentity(pending, MACHINE_A, "Renamed A", home);

    expect(identity).toEqual({
      version: 1,
      identityKey: pending.identityKey,
      machineId: MACHINE_A,
      displayName: "Renamed A",
    });
    expect(requireMachineIdentity(home)).toEqual(identity);
  });

  it("rejects missing, unsafe, broad, and oversized files", () => {
    expect(readMachineIdentity(home)).toBeNull();
    expect(() => requireMachineIdentity(home)).toThrow("not registered");

    mkdirSync(join(home, ".lcm"), { recursive: true });
    const target = join(home, "target.json");
    writeFileSync(target, "{}");
    symlinkSync(target, machineIdentityPath(home));
    expect(() => readMachineIdentity(home)).toThrow("may not be a symbolic link");

    rmSync(machineIdentityPath(home));
    writeFileSync(machineIdentityPath(home), "{}");
    chmodSync(machineIdentityPath(home), 0o644);
    expect(() => readMachineIdentity(home)).toThrow("permissions are too broad");

    chmodSync(machineIdentityPath(home), 0o600);
    writeFileSync(machineIdentityPath(home), "x".repeat(64 * 1024 + 1));
    expect(() => readMachineIdentity(home)).toThrow("configured size limit");
  });

  it.each([
    ["invalid JSON", "{"],
    ["array", "[]"],
    ["version", JSON.stringify({ version: 2, identityKey: `machine:${"a".repeat(64)}`, machineId: null, displayName: "A" })],
    ["identity key", JSON.stringify({ version: 1, identityKey: "bad", machineId: null, displayName: "A" })],
    ["display type", JSON.stringify({ version: 1, identityKey: `machine:${"a".repeat(64)}`, machineId: null, displayName: 1 })],
    ["empty display", JSON.stringify({ version: 1, identityKey: `machine:${"a".repeat(64)}`, machineId: null, displayName: " " })],
    ["long display", JSON.stringify({ version: 1, identityKey: `machine:${"a".repeat(64)}`, machineId: null, displayName: "a".repeat(257) })],
    ["control display", JSON.stringify({ version: 1, identityKey: `machine:${"a".repeat(64)}`, machineId: null, displayName: "bad\u0000name" })],
    ["machine ID", JSON.stringify({ version: 1, identityKey: `machine:${"a".repeat(64)}`, machineId: "not-uuid", displayName: "A" })],
  ])("rejects %s machine identity content", (_label, content) => {
    mkdirSync(join(home, ".lcm"), { recursive: true });
    writeFileSync(machineIdentityPath(home), content, { mode: 0o600 });
    expect(() => readMachineIdentity(home)).toThrow(MachineIdentityFileError);
  });

  it("rejects invalid PostgreSQL IDs and concurrent identity replacement", () => {
    const pending = ensurePendingMachineIdentity("Machine A", home).identity;
    expect(() => finalizeMachineIdentity(pending, "not-v7", "Machine A", home))
      .toThrow("invalid machine ID");

    const replacement = {
      ...pending,
      identityKey: `machine:${"b".repeat(64)}`,
    };
    writeFileSync(machineIdentityPath(home), `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    expect(() => finalizeMachineIdentity(pending, MACHINE_A, "Machine A", home))
      .toThrow("changed during registration");
  });

  it("rejects a stale finalized ID", () => {
    const pending = ensurePendingMachineIdentity("Machine A", home).identity;
    finalizeMachineIdentity(pending, MACHINE_A, "Machine A", home);
    expect(() => finalizeMachineIdentity(pending, MACHINE_B, "Machine A", home))
      .toThrow(`recover ${MACHINE_B} --force`);
  });

  it("recovers missing identities and returns an existing identical identity", () => {
    const identity: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_A,
      displayName: "Machine A",
    };
    expect(recoverMachineIdentity(identity, { homeDir: home })).toEqual({ identity });
    expect(recoverMachineIdentity(identity, { homeDir: home })).toEqual({ identity });
    expect(readMachineIdentity(home)).toEqual(identity);
  });

  it("requires force for conflicts and privately backs up replacements", () => {
    const first: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_A,
      displayName: "Machine A",
    };
    const second: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"b".repeat(64)}`,
      machineId: MACHINE_B,
      displayName: "Machine B",
    };
    recoverMachineIdentity(first, { homeDir: home });
    expect(() => recoverMachineIdentity(second, { homeDir: home }))
      .toThrow(`recover ${MACHINE_B} --force`);

    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const recovered = recoverMachineIdentity(second, { homeDir: home, force: true });
    expect(recovered.backupPath).toBe(join(oldMachineIdentitiesDir(home), "machine-1700000000.json"));
    expect(existsSync(recovered.backupPath!)).toBe(true);
    expect(statSync(recovered.backupPath!).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(recovered.backupPath!, "utf8"))).toEqual(first);
    expect(readMachineIdentity(home)).toEqual(second);
  });

  it("uses an exclusive suffix when a forced-recovery backup name collides", () => {
    const first: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_A,
      displayName: "Machine A",
    };
    const second: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"b".repeat(64)}`,
      machineId: MACHINE_B,
      displayName: "Machine B",
    };
    recoverMachineIdentity(first, { homeDir: home });
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const firstRecovery = recoverMachineIdentity(second, { homeDir: home, force: true });
    const secondRecovery = recoverMachineIdentity(first, { homeDir: home, force: true });

    expect(firstRecovery.backupPath).toBe(
      join(oldMachineIdentitiesDir(home), "machine-1700000000.json"),
    );
    expect(secondRecovery.backupPath).toBe(
      join(oldMachineIdentitiesDir(home), "machine-1700000000-1.json"),
    );
    expect(JSON.parse(readFileSync(secondRecovery.backupPath!, "utf8"))).toEqual(second);
    expect(readMachineIdentity(home)).toEqual(first);
  });

  it("does not replace machine.json when no exclusive backup name is available", () => {
    const first: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_A,
      displayName: "Machine A",
    };
    const second: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"b".repeat(64)}`,
      machineId: MACHINE_B,
      displayName: "Machine B",
    };
    recoverMachineIdentity(first, { homeDir: home });
    const backupDir = oldMachineIdentitiesDir(home);
    mkdirSync(backupDir, { recursive: true });
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    for (let suffix = 0; suffix < 1_000; suffix += 1) {
      const discriminator = suffix === 0 ? "" : `-${suffix}`;
      writeFileSync(
        join(backupDir, `machine-1700000000${discriminator}.json`),
        "occupied",
        { mode: 0o600 },
      );
    }

    expect(() => recoverMachineIdentity(second, { homeDir: home, force: true }))
      .toThrow("could not create an exclusive backup");
    expect(readMachineIdentity(home)).toEqual(first);
  });

  it("force-recovers a corrupt regular file and preserves its bytes", () => {
    mkdirSync(join(home, ".lcm"), { recursive: true });
    writeFileSync(machineIdentityPath(home), "{broken", { mode: 0o600 });
    const identity: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_A,
      displayName: "Machine A",
    };

    const recovered = recoverMachineIdentity(identity, { homeDir: home, force: true });

    expect(readFileSync(recovered.backupPath!, "utf8")).toBe("{broken");
    expect(readMachineIdentity(home)).toEqual(identity);
  });

  it("requires force for a corrupt recovery file and rejects pending recovery input", () => {
    mkdirSync(join(home, ".lcm"), { recursive: true });
    writeFileSync(machineIdentityPath(home), "{broken", { mode: 0o600 });
    const identity: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_A,
      displayName: "Machine A",
    };
    expect(() => recoverMachineIdentity(identity, { homeDir: home }))
      .toThrow("invalid JSON");
    expect(() => recoverMachineIdentity({
      ...identity,
      machineId: null,
    } as unknown as MachineIdentity, { homeDir: home, force: true }))
      .toThrow("finalized machine identity");
  });
});
