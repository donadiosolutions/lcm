import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
    expect(process.env.TMPDIR).toBe(process.env.TMP);
    expect(process.env.TMP).toBe(process.env.TEMP);
    expect(dirname(process.env.TMPDIR!)).toBe(root);
    expect(basename(process.env.TMPDIR!)).toMatch(/^worker-tmp-[0-9]+-[A-Za-z0-9_-]+$/u);
    expect(lstatSync(process.env.TMPDIR!).mode & 0o777).toBe(0o700);
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
      realpath: (path) => path,
      markerProbe: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
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
      realpath: (path) => path,
      markerProbe: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
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

  it("fails clearly for an explicit contaminated parent without fallback", () => {
    expect(() => createRuntimeHomeRun({ provide: vi.fn() }, {
      environment: { LCM_TEST_VITEST_RUNTIME_ROOT_PARENT: "/private/harness" },
      realpath: (path) => path,
      markerProbe: () => ({}),
    })).toThrow(/LCM_TEST_VITEST_RUNTIME_ROOT_PARENT/iu);
  });

  it("proves a child Vitest run relocates all runtime scratch below a clean parent", () => {
    const fixture = mkdtempSync(join(tmpdir(), "lcm-bug-840-fixture-"));
    const marker = join(fixture, ".git");
    const markerBytes = "synthetic malformed marker\n";
    mkdirSync(marker, { mode: 0o755 });
    writeFileSync(join(marker, "sentinel"), markerBytes, { mode: 0o600 });
    const childSpec = join(process.cwd(), "test", `.bug840-acceptance-${process.pid}.test.ts`);
    const resultPath = join(fixture, "result.json");
    writeFileSync(childSpec, `
import { existsSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from ${JSON.stringify(join(process.cwd(), "test/e2e/harness.ts"))};
const resultPath = ${JSON.stringify(resultPath)};
describe("Bug840 child acceptance", () => {
  let handle;
  afterEach(async () => { await handle?.cleanup(); });
  it("keeps the harness outside the malformed fixture", async () => {
    handle = await createHarness("mock");
    const rel = relative(resolve(${JSON.stringify(fixture)}), resolve(handle.tmpDir));
    const health = await handle.client.health();
    writeFileSync(resultPath, JSON.stringify({ health, outside: !rel || rel.startsWith("..") }));
    expect(health.status).toBe("ok");
    expect(rel === "" || rel.startsWith("..")).toBe(true);
  });
});
`, { mode: 0o600 });
    const childEnvironment = { ...process.env };
    delete childEnvironment.LCM_TEST_VITEST_RUNTIME_ROOT_PARENT;
    delete childEnvironment.LCM_TEST_HARNESS_TMPDIR;
    childEnvironment.TMPDIR = fixture;
    childEnvironment.TMP = fixture;
    childEnvironment.TEMP = fixture;
    try {
      execFileSync(process.execPath, [
        "node_modules/vitest/vitest.mjs", "run", "--config", "vitest.config.ts", childSpec,
      ], { cwd: process.cwd(), env: childEnvironment, stdio: "pipe" });
      expect(JSON.parse(readFileSync(resultPath, "utf8"))).toMatchObject({ health: { status: "ok" }, outside: true });
      expect(lstatSync(marker).isDirectory()).toBe(true);
      expect(readFileSync(join(marker, "sentinel"), "utf8")).toBe(markerBytes);
      expect([...readdirSync(fixture)].filter((entry) => entry.startsWith("lcm-") && entry !== ".git")).toEqual([]);
    } finally {
      rmSync(childSpec, { force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
