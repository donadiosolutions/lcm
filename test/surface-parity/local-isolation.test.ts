import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { LOCAL_ISOLATION_UNAVAILABLE, UNSHARE_FLAGS, findUnshare, probeUnshare, workerLaunchOptions } from "./local-isolation.mjs";

const stubs = mkdtempSync(join(tmpdir(), "lcm-local-isolation-"));
afterAll(() => rmSync(stubs, { recursive: true }));

function stub(name: string, script: string): string {
  const path = join(stubs, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

it("forks the worker directly when no user manager is visible", () => {
  const probe = vi.fn(() => true);
  expect(workerLaunchOptions({ findManager: () => null, probe })).toEqual({ execArgv: [] });
  expect(probe).not.toHaveBeenCalled();
});

it("wraps the worker in a private user, PID and mount namespace when a manager is visible", () => {
  const probe = vi.fn(() => true);
  expect(workerLaunchOptions({ findManager: () => 42, resolveUnshare: () => "/usr/bin/unshare", probe, nodePath: "/opt/node" }))
    .toEqual({ execPath: "/usr/bin/unshare", execArgv: [...UNSHARE_FLAGS, "/opt/node"] });
  expect(probe).toHaveBeenCalledExactlyOnceWith("/usr/bin/unshare");
});

it("names a missing unshare binary", () => {
  expect(() => workerLaunchOptions({ findManager: () => 42, resolveUnshare: () => undefined }))
    .toThrow(`${LOCAL_ISOLATION_UNAVAILABLE}:unshare-missing`);
});

it("names denied user namespaces", () => {
  expect(() => workerLaunchOptions({ findManager: () => 42, resolveUnshare: () => "/usr/bin/unshare", probe: () => false }))
    .toThrow(`${LOCAL_ISOLATION_UNAVAILABLE}:user-namespace-denied`);
});

it("finds an executable unshare on the supplied search path", () => {
  const directory = join(stubs, "bin");
  mkdirSync(directory);
  const path = join(directory, "unshare");
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  expect(findUnshare(`/nonexistent-lcm-path:${directory}`)).toBe(path);
});

it("probes by the command's exit status", () => {
  expect(probeUnshare(stub("pass", "exit 0"))).toBe(true);
  expect(probeUnshare(stub("fail", "exit 1"))).toBe(false);
  expect(probeUnshare("/nonexistent-lcm-unshare")).toBe(false);
});
