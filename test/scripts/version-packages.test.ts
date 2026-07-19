import { describe, expect, it, vi } from "vitest";
import {
  executeChecked,
  planPrereleaseTransition,
  readPrereleaseState,
  runVersionPackages,
  validatePrereleaseState,
  validateReleaseChannel,
} from "../../scripts/version-packages.mjs";

describe("version-packages", () => {
  it("accepts only the supported release channels", () => {
    expect(validateReleaseChannel("auto")).toBe("auto");
    expect(validateReleaseChannel("beta")).toBe("beta");
    expect(validateReleaseChannel("stable")).toBe("stable");
    expect(() => validateReleaseChannel("alpha")).toThrow("expected auto, beta, or stable");
  });

  it("accepts only beta prerelease states with known modes", () => {
    expect(validatePrereleaseState({ mode: "pre", tag: "beta" })).toEqual({
      mode: "pre",
      tag: "beta",
    });
    expect(validatePrereleaseState({ mode: "exit", tag: "beta" })).toEqual({
      mode: "exit",
      tag: "beta",
    });
    expect(() => validatePrereleaseState(null)).toThrow("JSON object");
    expect(() => validatePrereleaseState([])).toThrow("JSON object");
    expect(() => validatePrereleaseState({ mode: "pre", tag: "alpha" })).toThrow(
      "only beta is allowed",
    );
    expect(() => validatePrereleaseState({ mode: "other", tag: "beta" })).toThrow(
      "expected pre or exit",
    );
  });

  it("reads, validates, and reports malformed prerelease state", () => {
    expect(readPrereleaseState("pre.json", { exists: () => false })).toBeUndefined();
    expect(
      readPrereleaseState("pre.json", {
        exists: () => true,
        readFile: () => JSON.stringify({ mode: "pre", tag: "beta" }),
      }),
    ).toEqual({ mode: "pre", tag: "beta" });
    expect(() =>
      readPrereleaseState("pre.json", {
        exists: () => true,
        readFile: () => "{",
      }),
    ).toThrow("Unable to read pre.json");
  });

  it("plans native beta entry, continuation, and stable exit", () => {
    expect(planPrereleaseTransition("auto", undefined)).toEqual([]);
    expect(planPrereleaseTransition("auto", { mode: "pre", tag: "beta" })).toEqual([]);
    expect(planPrereleaseTransition("beta", undefined)).toEqual(["pre", "enter", "beta"]);
    expect(planPrereleaseTransition("beta", { mode: "pre", tag: "beta" })).toEqual([]);
    expect(planPrereleaseTransition("stable", { mode: "pre", tag: "beta" })).toEqual([
      "pre",
      "exit",
    ]);
    expect(planPrereleaseTransition("stable", { mode: "exit", tag: "beta" })).toEqual([]);
  });

  it("rejects invalid beta and stable transitions", () => {
    expect(() =>
      planPrereleaseTransition("beta", { mode: "exit", tag: "beta" }),
    ).toThrow("finish the stable release first");
    expect(() => planPrereleaseTransition("stable", undefined)).toThrow(
      "prerelease mode is not active",
    );
  });

  it("runs the planned transition before versioning and manifest synchronization", () => {
    const execute = vi.fn();
    runVersionPackages({
      channel: "beta",
      cwd: "/repo",
      execute,
      exists: () => false,
    });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0][1]).toEqual([
      "/repo/node_modules/@changesets/cli/bin.js",
      "pre",
      "enter",
      "beta",
    ]);
    expect(execute.mock.calls[1][1]).toEqual([
      "/repo/node_modules/@changesets/cli/bin.js",
      "version",
    ]);
    expect(execute.mock.calls[2][1][0]).toMatch(/scripts\/sync-plugin-version\.mjs$/u);
  });

  it("uses the active beta without re-entering prerelease mode", () => {
    const execute = vi.fn();
    runVersionPackages({
      channel: "auto",
      cwd: "/repo",
      execute,
      exists: () => true,
      readFile: () => JSON.stringify({ mode: "pre", tag: "beta" }),
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][1]).toEqual([
      "/repo/node_modules/@changesets/cli/bin.js",
      "version",
    ]);
  });

  it("reports signal-terminated commands before the status fallback", () => {
    const spawn = vi.fn(() => ({ error: undefined, signal: "SIGTERM", status: null }));

    expect(() =>
      executeChecked("node", ["changeset", "version"], { cwd: "/repo" }, spawn),
    ).toThrow(
      "node changeset version was terminated by signal SIGTERM; check system resource limits and retry",
    );
    expect(spawn).toHaveBeenCalledWith("node", ["changeset", "version"], {
      cwd: "/repo",
      stdio: "inherit",
    });
  });
});
