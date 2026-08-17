import { describe, expect, it, vi } from "vitest";
import { daemonEntrypointMatches } from "../../src/daemon/lifecycle-scope.js";

describe("daemonEntrypointMatches", () => {
  it("fails closed for test workers and missing authenticated entrypoints", () => {
    expect(daemonEntrypointMatches(
      "/repo/node_modules/vitest/dist/workers/forks.js",
      undefined,
      "linux",
    )).toBe(false);
    expect(daemonEntrypointMatches(undefined, undefined, "linux")).toBe(true);
    expect(daemonEntrypointMatches(undefined, "/opt/lcm/lcm.mjs", "linux")).toBe(false);
  });

  it("accepts exact and canonical POSIX identities without inventing equality", () => {
    const realpath = vi.fn((path: string) => path === "/linked/lcm.mjs" ? "/opt/lcm/lcm.mjs" : path);
    expect(daemonEntrypointMatches("/opt/lcm/lcm.mjs", "/opt/lcm/lcm.mjs", "linux", realpath)).toBe(true);
    expect(daemonEntrypointMatches("/linked/lcm.mjs", "/opt/lcm/lcm.mjs", "linux", realpath)).toBe(true);
    expect(daemonEntrypointMatches("relative/a", "relative/b", "linux", realpath)).toBe(false);
  });

  it("normalizes Windows case and preserves direct comparison when paths disappear", () => {
    expect(daemonEntrypointMatches(
      "C:\\LCM\\LCM.MJS",
      "c:\\lcm\\lcm.mjs",
      "win32",
      path => path,
    )).toBe(true);
    expect(daemonEntrypointMatches(
      "/missing/a",
      "/missing/b",
      "linux",
      () => { throw new Error("missing"); },
    )).toBe(false);
  });
});
