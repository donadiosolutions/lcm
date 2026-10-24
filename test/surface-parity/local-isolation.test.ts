import { expect, it, vi } from "vitest";
import { LOCAL_ISOLATION_UNAVAILABLE, UNSHARE_FLAGS, findUnshare, probeUnshare, workerLaunchOptions } from "./local-isolation.mjs";

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

it("falls back to the standard system directories when unshare is not on the search path", () => {
  expect(findUnshare("/nonexistent-lcm-path")).toMatch(/\/unshare$/u);
  expect(findUnshare("")).toMatch(/\/unshare$/u);
});

it("probes by the command's exit status", () => {
  expect(probeUnshare("/usr/bin/true")).toBe(true);
  expect(probeUnshare("/usr/bin/false")).toBe(false);
  expect(probeUnshare("/nonexistent-lcm-unshare")).toBe(false);
});
