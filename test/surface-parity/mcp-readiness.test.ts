import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PrivateMutationLockContentionError, processStartTime } from "../../src/private-mutation-lock.js";
import { withBackendPublicationConsumerLock } from "../../src/storage/backend-publication.js";
import { invokeAfterConsumerAdmission } from "./mcp-readiness.mjs";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "surface-mcp-readiness-"));
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  const lock = join(home, ".lcm.backend-publication.lock");
  // A real live-owner record, validated by the production admission path.
  writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid, processStartTime: processStartTime(process.pid),
    nonce: "a".repeat(32), createdAtMs: Date.now() }), { mode: 0o600 });
  const expectedAuthority = { home: "owned", config: "fixed", publication: "fixed" };
  const invoke = vi.fn(() => {
    expect(existsSync(lock)).toBe(false);
    return "single tool result";
  });
  const options = { admit: (observe: () => void) => withBackendPublicationConsumerLock(home, observe),
    observeAuthority: () => expectedAuthority, expectedAuthority, invoke, ContentionError: PrivateMutationLockContentionError };
  return { home, lock, invoke, options, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

it("waits behind a real live owner, then releases admission before invoking exactly once", async () => {
  const f = fixture();
  try {
    const wait = vi.fn(async () => {
      expect(f.invoke).not.toHaveBeenCalled();
      rmSync(f.lock);
    });
    await expect(invokeAfterConsumerAdmission({ ...f.options, wait })).resolves.toBe("single tool result");
    expect(wait).toHaveBeenCalledExactlyOnceWith(10);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  } finally { f.cleanup(); }
});

it("preserves the two-second contention bound without invoking the tool", async () => {
  const f = fixture();
  try {
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(2000);
    const wait = vi.fn();
    await expect(invokeAfterConsumerAdmission({ ...f.options, now, wait })).rejects.toBeInstanceOf(PrivateMutationLockContentionError);
    expect(wait).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});

it("refuses changed authority and releases its token without invoking the tool", async () => {
  const f = fixture();
  try {
    rmSync(f.lock);
    await expect(invokeAfterConsumerAdmission({ ...f.options, observeAuthority: () => ({ config: "changed" }) }))
      .rejects.toThrow("surface-mcp:readiness-authority-changed");
    expect(f.invoke).not.toHaveBeenCalled();
    expect(existsSync(f.lock)).toBe(false);
  } finally { f.cleanup(); }
});

it("does not retry an unrelated error impersonating contention", async () => {
  const failure = new Error("unrelated admission failure");
  failure.name = "PrivateMutationLockContentionError";
  const wait = vi.fn();
  const invoke = vi.fn();
  await expect(invokeAfterConsumerAdmission({ admit: () => { throw failure; }, observeAuthority: () => ({}),
    expectedAuthority: {}, invoke, ContentionError: PrivateMutationLockContentionError, wait })).rejects.toBe(failure);
  expect(wait).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

it("never retries a tool failure, even when it is the actual contention class", async () => {
  const failure = new PrivateMutationLockContentionError("tool refused");
  const invoke = vi.fn(async () => { throw failure; });
  const admit = vi.fn((observe: () => void) => observe());
  const wait = vi.fn();
  await expect(invokeAfterConsumerAdmission({ admit, observeAuthority: () => ({}), expectedAuthority: {},
    invoke, ContentionError: PrivateMutationLockContentionError, wait })).rejects.toBe(failure);
  expect(admit).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
});
