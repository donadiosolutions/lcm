import { basename, dirname } from "node:path";
import { describe, expect, inject, it, vi } from "vitest";
import {
  RUNTIME_HOME_ROOT_CONTEXT,
  createRuntimeHomeRun,
} from "./runtime-home-global.js";

describe("Vitest runtime-home global lifecycle", () => {
  it("places each worker home beneath the run root", () => {
    const root = inject(RUNTIME_HOME_ROOT_CONTEXT);
    const home = process.env.LCM_TEST_HOME;

    expect(home).toBeDefined();
    expect(dirname(home!)).toBe(root);
    expect(basename(home!)).toMatch(/^worker-[0-9]+-[A-Za-z0-9_-]+$/u);
  });

  it("provides one secure run root and removes it during global teardown", () => {
    const provide = vi.fn();
    const createDirectory = vi.fn(() => "/tmp/lcm-vitest-run-unique");
    const secureDirectory = vi.fn();
    const removeDirectory = vi.fn();

    const teardown = createRuntimeHomeRun({ provide }, {
      createDirectory,
      secureDirectory,
      removeDirectory,
      environment: {},
      temporaryRoot: () => "/tmp",
    });

    expect(createDirectory).toHaveBeenCalledWith(
      expect.stringMatching(/lcm-vitest-run-$/u),
    );
    expect(secureDirectory).toHaveBeenCalledWith("/tmp/lcm-vitest-run-unique", 0o700);
    expect(provide).toHaveBeenCalledWith(
      RUNTIME_HOME_ROOT_CONTEXT,
      "/tmp/lcm-vitest-run-unique",
    );
    expect(removeDirectory).not.toHaveBeenCalled();

    teardown();
    expect(removeDirectory).toHaveBeenCalledWith("/tmp/lcm-vitest-run-unique");
  });

  it("gives concurrent runs distinct secure roots and tears down only their own root", () => {
    const provide = vi.fn();
    const roots = [
      "/private/harness/lcm-vitest-run-first",
      "/private/harness/lcm-vitest-run-second",
    ];
    const createDirectory = vi.fn(() => roots.shift()!);
    const secureDirectory = vi.fn();
    const removeDirectory = vi.fn();
    const dependencies = {
      createDirectory,
      secureDirectory,
      removeDirectory,
      environment: { LCM_TEST_VITEST_RUNTIME_ROOT_PARENT: "/private/harness" },
    };

    const firstTeardown = createRuntimeHomeRun({ provide }, dependencies);
    const secondTeardown = createRuntimeHomeRun({ provide }, dependencies);

    expect(createDirectory).toHaveBeenNthCalledWith(
      1,
      "/private/harness/lcm-vitest-run-",
    );
    expect(createDirectory).toHaveBeenNthCalledWith(
      2,
      "/private/harness/lcm-vitest-run-",
    );
    expect(secureDirectory).toHaveBeenNthCalledWith(
      1,
      "/private/harness/lcm-vitest-run-first",
      0o700,
    );
    expect(secureDirectory).toHaveBeenNthCalledWith(
      2,
      "/private/harness/lcm-vitest-run-second",
      0o700,
    );
    expect(provide).toHaveBeenNthCalledWith(
      1,
      RUNTIME_HOME_ROOT_CONTEXT,
      "/private/harness/lcm-vitest-run-first",
    );
    expect(provide).toHaveBeenNthCalledWith(
      2,
      RUNTIME_HOME_ROOT_CONTEXT,
      "/private/harness/lcm-vitest-run-second",
    );

    firstTeardown();
    expect(removeDirectory).toHaveBeenCalledTimes(1);
    expect(removeDirectory).toHaveBeenCalledWith(
      "/private/harness/lcm-vitest-run-first",
    );
    expect(removeDirectory).not.toHaveBeenCalledWith(
      "/private/harness/lcm-vitest-run-second",
    );

    secondTeardown();
    expect(removeDirectory).toHaveBeenCalledTimes(2);
    expect(removeDirectory).toHaveBeenLastCalledWith(
      "/private/harness/lcm-vitest-run-second",
    );
  });

  it("nests a PostgreSQL run root beneath its harness-owned private directory", () => {
    const provide = vi.fn();
    const createDirectory = vi.fn(() => "/private/harness/lcm-vitest-run-unique");
    const teardown = createRuntimeHomeRun({ provide }, {
      createDirectory,
      secureDirectory: vi.fn(),
      removeDirectory: vi.fn(),
      environment: {
        LCM_TEST_VITEST_RUNTIME_ROOT_PARENT: "/private/harness",
      },
      temporaryRoot: () => {
        throw new Error("the ambient temporary root must not be used");
      },
    });

    expect(createDirectory).toHaveBeenCalledWith("/private/harness/lcm-vitest-run-");
    expect(provide).toHaveBeenCalledWith(
      RUNTIME_HOME_ROOT_CONTEXT,
      "/private/harness/lcm-vitest-run-unique",
    );
    expect(teardown).toBeTypeOf("function");
  });
});
