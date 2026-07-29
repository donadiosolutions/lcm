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
