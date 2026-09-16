import { describe, expect, it, vi } from "vitest";

import {
  installTestRuntimeHomedir,
  resolveTestRuntimeHome,
} from "./runtime-home-authority.js";

describe("test runtime home authority", () => {
  it.each([
    [{ HOME: "/home", USERPROFILE: "/profile" }, "/home"],
    [{ HOME: "/home", USERPROFILE: "" }, "/home"],
    [{ HOME: "", USERPROFILE: "/profile" }, "/profile"],
    [{ USERPROFILE: "/profile" }, "/profile"],
  ] as const)("resolves current environment authority from %j", (environment, expected) => {
    const nativeHomedir = vi.fn(() => "/native");

    expect(resolveTestRuntimeHome(environment, nativeHomedir)).toBe(expected);
    expect(nativeHomedir).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { HOME: "" },
    { USERPROFILE: "" },
    { HOME: "", USERPROFILE: "" },
  ])("uses the pristine native fallback once for %j", (environment) => {
    const nativeHomedir = vi.fn(() => "/native");

    expect(resolveTestRuntimeHome(environment, nativeHomedir)).toBe("/native");
    expect(nativeHomedir).toHaveBeenCalledOnce();
  });

  it("installs one stable non-enumerable wrapper and reasserts it after replacement", () => {
    const environment: NodeJS.ProcessEnv = { HOME: "/first", USERPROFILE: "/profile" };
    const nativeHomedir = vi.fn(() => "/native");
    const osModule = { homedir: nativeHomedir };
    let exportedHomedir = osModule.homedir;
    const syncBuiltinExports = vi.fn(() => {
      exportedHomedir = osModule.homedir;
    });

    const first = installTestRuntimeHomedir(osModule, syncBuiltinExports, environment);
    expect(first).not.toBe(nativeHomedir);
    expect(osModule.homedir).toBe(first);
    expect(exportedHomedir).toBe(first);
    expect(first()).toBe("/first");

    environment.HOME = "/second";
    expect(first()).toBe("/second");
    const second = installTestRuntimeHomedir(osModule, syncBuiltinExports, environment);
    expect(second).toBe(first);
    expect(osModule.homedir).toBe(first);
    expect(syncBuiltinExports).toHaveBeenCalledOnce();

    const [stateKey] = Object.getOwnPropertySymbols(osModule);
    expect(stateKey).toBe(Symbol.for("lcm.vitest.runtimeHomedir"));
    expect(Object.getOwnPropertyDescriptor(osModule, stateKey)).toMatchObject({
      configurable: false,
      enumerable: false,
      writable: false,
    });
    expect(Object.getOwnPropertySymbols({ ...osModule })).not.toContain(stateKey);

    environment.HOME = "";
    environment.USERPROFILE = "";
    expect(first()).toBe("/native");
    expect(nativeHomedir).toHaveBeenCalledOnce();

    osModule.homedir = nativeHomedir;
    syncBuiltinExports();
    expect(exportedHomedir).toBe(nativeHomedir);

    const reasserted = installTestRuntimeHomedir(osModule, syncBuiltinExports, environment);
    expect(reasserted).toBe(first);
    expect(osModule.homedir).toBe(first);
    expect(exportedHomedir).toBe(first);
    expect(syncBuiltinExports).toHaveBeenCalledTimes(3);
  });
});
