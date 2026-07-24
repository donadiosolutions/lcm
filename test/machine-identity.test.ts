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
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensurePendingMachineIdentity,
  finalizeMachineIdentity,
  isUuidV7,
  machineIdentityPath,
  MachineIdentityFileError,
  normalizeMachineDisplayName,
  normalizeUuidV7,
  oldMachineIdentitiesDir,
  readMachineIdentity,
  recoverMachineIdentity,
  requireMachineIdentity,
  type MachineIdentity,
} from "../src/machine-identity.js";
import { quoteShellArgument } from "../src/shell-quote.js";

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
    expect(isUuidV7(MACHINE_A.toUpperCase())).toBe(true);
    expect(normalizeUuidV7(MACHINE_A.toUpperCase())).toBe(MACHINE_A);
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

  it.each([
    ["C1 lower boundary", "Machine\u0080name"],
    ["C1 upper boundary", "Machine\u009fname"],
    ["Arabic letter mark", "Machine\u061cname"],
    ["left-to-right mark", "Machine\u200ename"],
    ["right-to-left mark", "Machine\u200fname"],
    ["line separator", "Machine\u2028name"],
    ["trailing line separator", "Machine\u2028"],
    ["paragraph separator", "Machine\u2029name"],
    ["leading paragraph separator", "\u2029Machine"],
    ["bidi embedding lower boundary", "Machine\u202aname"],
    ["bidi override upper boundary", "Machine\u202ename"],
    ["bidi isolate lower boundary", "Machine\u2066name"],
    ["bidi isolate upper boundary", "Machine\u2069name"],
  ])("rejects terminal-unsafe %s display names", (_case, displayName) => {
    expect(() => normalizeMachineDisplayName(displayName))
      .toThrow("printable characters");
    expect(() => ensurePendingMachineIdentity(displayName, home))
      .toThrow("printable characters");
  });

  it.each([
    "Machine\u00a0name",
    "Machine\u061bname",
    "Machine\u061dname",
    "Machine\u201fname",
    "Machine\u202fname",
    "Machine\u2065name",
    "Machine\u206aname",
  ])("retains printable Unicode boundary display name %j", (displayName) => {
    expect(normalizeMachineDisplayName(displayName)).toBe(displayName);
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

  it("serializes differing-name finalizers and converges on the first completed registration", () => {
    const pending = ensurePendingMachineIdentity("Machine A", home).identity;
    let concurrentError: unknown;
    let attempted = false;
    const identity = finalizeMachineIdentity(pending, MACHINE_A, "Machine A", home, {
      _lockObserverForTesting: (event) => {
        if (event !== "before-main-lock-release-read" || attempted) return;
        attempted = true;
        try {
          finalizeMachineIdentity(pending, MACHINE_A, "Machine B", home);
        } catch (error) {
          concurrentError = error;
        }
      },
    });

    expect(concurrentError).toMatchObject({
      message: expect.stringContaining("machine identity mutation is already in progress"),
    });
    expect(finalizeMachineIdentity(pending, MACHINE_A, "Machine B", home)).toEqual(identity);
    expect(readMachineIdentity(home)).toEqual(identity);
  });

  it("does not let forced recovery overwrite an in-flight finalization", () => {
    const pending = ensurePendingMachineIdentity("Machine A", home).identity;
    const recoveredIdentity: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"b".repeat(64)}`,
      machineId: MACHINE_B,
      displayName: "Machine B",
    };
    let recoveryError: unknown;
    let attempted = false;
    const finalized = finalizeMachineIdentity(pending, MACHINE_A, "Machine A", home, {
      _lockObserverForTesting: (event) => {
        if (event !== "before-main-lock-release-read" || attempted) return;
        attempted = true;
        try {
          recoverMachineIdentity(recoveredIdentity, { homeDir: home, force: true });
        } catch (error) {
          recoveryError = error;
        }
      },
    });

    expect(recoveryError).toMatchObject({
      message: expect.stringContaining("machine identity mutation is already in progress"),
    });
    expect(readMachineIdentity(home)).toEqual(finalized);
    expect(existsSync(oldMachineIdentitiesDir(home))).toBe(false);
  });

  it("does not let pending registration publish over an in-flight recovery", () => {
    const recoveredIdentity: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"b".repeat(64)}`,
      machineId: MACHINE_B,
      displayName: "Machine B",
    };
    let registrationError: unknown;
    let attempted = false;
    const recovered = recoverMachineIdentity(recoveredIdentity, {
      homeDir: home,
      _lockObserverForTesting: (event) => {
        if (event !== "before-main-lock-release-read" || attempted) return;
        attempted = true;
        try {
          ensurePendingMachineIdentity("Machine A", home);
        } catch (error) {
          registrationError = error;
        }
      },
    });

    expect(registrationError).toMatchObject({
      message: expect.stringContaining("machine identity mutation is already in progress"),
    });
    expect(recovered).toEqual({ identity: recoveredIdentity });
    expect(readMachineIdentity(home)).toEqual(recoveredIdentity);
  });

  it("reclaims a crashed machine identity mutation owner before recovery", () => {
    const lockPath = `${machineIdentityPath(home)}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      processStartTime: "1",
      nonce: "c".repeat(32),
    })}\n`, { mode: 0o600 });
    const identity: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_A,
      displayName: "Machine A",
    };

    expect(recoverMachineIdentity(identity, { homeDir: home })).toEqual({ identity });
    expect(existsSync(lockPath)).toBe(false);
    expect(readMachineIdentity(home)).toEqual(identity);
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

  it("does not interpret compatibility mode bits as POSIX permissions on Windows", () => {
    const pending = ensurePendingMachineIdentity("Windows Machine", home);
    chmodSync(machineIdentityPath(home), 0o644);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    expect(readMachineIdentity(home)).toEqual(pending.identity);
  });

  it("shell-quotes a hostile machine identity path in permission remediation", () => {
    const hostileHome = join(home, "home with ' quote `tick` $(subshell) --");
    const path = machineIdentityPath(hostileHome);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}", { mode: 0o600 });
    chmodSync(path, 0o644);

    let error: unknown;
    try {
      readMachineIdentity(hostileHome);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      remediation: `Run \`chmod 600 -- ${quoteShellArgument(path)}\`, then retry.`,
    });
  });

  it.each([
    ["invalid JSON", "{"],
    ["array", "[]"],
    ["version", JSON.stringify({ version: 2, identityKey: `machine:${"a".repeat(64)}`, machineId: null, displayName: "A" })],
    ["identity key", JSON.stringify({ version: 1, identityKey: "bad", machineId: null, displayName: "A" })],
    ["newline identity key", JSON.stringify({ version: 1, identityKey: `machine:${"a".repeat(64)}\n`, machineId: null, displayName: "A" })],
    ["display type", JSON.stringify({ version: 1, identityKey: `machine:${"a".repeat(64)}`, machineId: null, displayName: 1 })],
    ["empty display", JSON.stringify({ version: 1, identityKey: `machine:${"a".repeat(64)}`, machineId: null, displayName: " " })],
    ["long display", JSON.stringify({ version: 1, identityKey: `machine:${"a".repeat(64)}`, machineId: null, displayName: "a".repeat(257) })],
    ["control display", JSON.stringify({ version: 1, identityKey: `machine:${"a".repeat(64)}`, machineId: null, displayName: "bad\u0000name" })],
    ["line-separator display", JSON.stringify({ version: 1, identityKey: `machine:${"a".repeat(64)}`, machineId: null, displayName: "bad\u2028name" })],
    ["paragraph-separator display", JSON.stringify({ version: 1, identityKey: `machine:${"a".repeat(64)}`, machineId: null, displayName: "bad\u2029name" })],
    ["machine ID", JSON.stringify({ version: 1, identityKey: `machine:${"a".repeat(64)}`, machineId: "not-uuid", displayName: "A" })],
    ["machine ID type", JSON.stringify({ version: 1, identityKey: `machine:${"a".repeat(64)}`, machineId: 7, displayName: "A" })],
  ])("rejects %s machine identity content", (_label, content) => {
    mkdirSync(join(home, ".lcm"), { recursive: true });
    writeFileSync(machineIdentityPath(home), content, { mode: 0o600 });
    expect(() => readMachineIdentity(home)).toThrow(MachineIdentityFileError);
  });

  it("uses file-recovery remediation for an unsafe persisted display name", () => {
    mkdirSync(join(home, ".lcm"), { recursive: true });
    writeFileSync(machineIdentityPath(home), JSON.stringify({
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_A,
      displayName: "unsafe\u0080name",
    }), { mode: 0o600 });

    const error = (() => {
      try {
        readMachineIdentity(home);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(MachineIdentityFileError);
    expect(error).toMatchObject({
      remediation: "Run `lcm machine recover <machine-id> --force` to replace the invalid file.",
    });
    expect((error as Error).message).not.toContain("machine register --name");
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

  it("rejects a pending identity changed immediately before finalization", () => {
    const pending = ensurePendingMachineIdentity("Machine A", home).identity;
    let changed = false;

    expect(() => finalizeMachineIdentity(pending, MACHINE_A, "Machine A", home, {
      _lockObserverForTesting: (event) => {
        if (event !== "before-main-lock-publish" || changed) return;
        changed = true;
        writeFileSync(
          machineIdentityPath(home),
          `${JSON.stringify({ ...pending, displayName: "Machine B" })}\n`,
          { mode: 0o600 },
        );
      },
    })).toThrow("changed during registration");
    expect(readMachineIdentity(home)).toMatchObject({
      machineId: null,
      displayName: "Machine B",
    });
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

  it("requires force and backs up a stale display name for the same identity", () => {
    const stale: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_A,
      displayName: "Stale Name",
    };
    const current = { ...stale, displayName: "Current Name" };
    recoverMachineIdentity(stale, { homeDir: home });
    expect(() => recoverMachineIdentity(current, { homeDir: home }))
      .toThrow(`recover ${MACHINE_A} --force`);

    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const recovered = recoverMachineIdentity(current, { homeDir: home, force: true });

    expect(JSON.parse(readFileSync(recovered.backupPath!, "utf8"))).toEqual(stale);
    expect(readMachineIdentity(home)).toEqual(current);
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

  it("force-recovers an oversized corrupt regular file and preserves its bytes", () => {
    mkdirSync(join(home, ".lcm"), { recursive: true });
    const corrupt = `{${"x".repeat(64 * 1024 + 1)}`;
    writeFileSync(machineIdentityPath(home), corrupt, { mode: 0o600 });
    const identity: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_A,
      displayName: "Machine A",
    };

    const recovered = recoverMachineIdentity(identity, { homeDir: home, force: true });

    expect(readFileSync(recovered.backupPath!, "utf8")).toBe(corrupt);
    expect(statSync(recovered.backupPath!).mode & 0o777).toBe(0o600);
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
