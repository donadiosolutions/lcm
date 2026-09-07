import { execFileSync } from "node:child_process";
import {
  lstatSync,
  existsSync,
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

export function createChildAcceptanceEnvironment(
  parentEnvironment: NodeJS.ProcessEnv,
  fixture: string,
): NodeJS.ProcessEnv {
  const childEnvironment = { ...parentEnvironment };
  delete childEnvironment.LCM_TEST_VITEST_RUNTIME_ROOT_PARENT;
  delete childEnvironment.LCM_TEST_HARNESS_TMPDIR;
  delete childEnvironment.LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS;
  delete childEnvironment.LCM_TEST_ARTIFACT_ROOT;
  childEnvironment.TMPDIR = fixture;
  childEnvironment.TMP = fixture;
  childEnvironment.TEMP = fixture;
  return childEnvironment;
}

describe("Vitest runtime-home global lifecycle", () => {
  it("places each worker home beneath the run root", () => {
    const root = inject(RUNTIME_HOME_ROOT_CONTEXT);
    const home = process.env.LCM_TEST_HOME;

    expect(home).toBeDefined();
    expect(dirname(home!)).toBe(root);
    expect(process.env.LCM_TEST_HARNESS_TMPDIR).toBe(dirname(root));
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
    const environment: NodeJS.ProcessEnv = {};

    const teardown = createRuntimeHomeRun({ provide }, {
      createDirectory,
      secureDirectory,
      removeDirectory,
      environment,
      temporaryRoot: () => "/tmp",
      realpath: (path) => path,
      markerProbe: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    });

    expect(createDirectory).toHaveBeenCalledWith(
      expect.stringMatching(/lcm-vitest-run-$/u),
    );
    expect(secureDirectory).toHaveBeenCalledWith("/tmp/lcm-vitest-run-unique", 0o700);
    expect(provide).toHaveBeenCalledWith(
      RUNTIME_HOME_ROOT_CONTEXT,
      "/tmp/lcm-vitest-run-unique",
    );
    expect(environment.LCM_TEST_HARNESS_TMPDIR).toBe("/tmp");
    expect(removeDirectory).not.toHaveBeenCalled();

    teardown();
    expect(removeDirectory).toHaveBeenCalledWith("/tmp/lcm-vitest-run-unique");
  });

  it("captures original temporary parents before installing the harness handoff", () => {
    const environment: NodeJS.ProcessEnv = {};
    const teardown = createRuntimeHomeRun({ provide: vi.fn() }, {
      createDirectory: vi.fn(() => "/tmp/lcm-vitest-run-captured"),
      secureDirectory: vi.fn(),
      removeDirectory: vi.fn(),
      environment,
      temporaryRoot: () => "/tmp",
      realpath: (path) => path,
      markerProbe: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    });
    expect(environment.LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS).toBe(
      JSON.stringify({ version: 1, parents: ["/tmp", "/var/tmp"] }),
    );
    expect(environment.LCM_TEST_HARNESS_TMPDIR).toBe("/tmp");
    teardown();
  });

  it("does not recapture when a nested harness handoff already exists", () => {
    const environment: NodeJS.ProcessEnv = {
      LCM_TEST_HARNESS_TMPDIR: "/stable",
      TMPDIR: "/worker-scratch",
    };
    const teardown = createRuntimeHomeRun({ provide: vi.fn() }, {
      createDirectory: vi.fn(() => "/stable/lcm-vitest-run-nested"),
      secureDirectory: vi.fn(),
      removeDirectory: vi.fn(),
      environment,
      temporaryRoot: () => {
        throw new Error("nested setup must not inspect the ambient root");
      },
      realpath: (path) => path,
      markerProbe: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    });
    expect(environment.LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS).toBeUndefined();
    teardown();
  });

  it("removes the owned root and rethrows a provide failure", () => {
    const provideFailure = new Error("provide failed");
    const removeDirectory = vi.fn();
    const provide = vi.fn(() => { throw provideFailure; });

    let thrown: unknown;
    try {
      createRuntimeHomeRun({ provide }, {
        createDirectory: vi.fn(() => "/tmp/lcm-vitest-run-provide-failure"),
        secureDirectory: vi.fn(),
        removeDirectory,
        environment: {},
        temporaryRoot: () => "/tmp",
        realpath: (path) => path,
        markerProbe: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(provideFailure);
    expect(removeDirectory).toHaveBeenCalledWith("/tmp/lcm-vitest-run-provide-failure");
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
        LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS:
          JSON.stringify({ version: 1, parents: ["/private/original-temp"] }),
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

  it("preserves an existing stable harness parent", () => {
    const environment: NodeJS.ProcessEnv = {
      LCM_TEST_HARNESS_TMPDIR: "/stable-parent",
      LCM_TEST_VITEST_RUNTIME_ROOT_PARENT: "/private/harness",
    };
    const teardown = createRuntimeHomeRun({ provide: vi.fn() }, {
      createDirectory: vi.fn(() => "/private/harness/lcm-vitest-run-stable"),
      secureDirectory: vi.fn(),
      removeDirectory: vi.fn(),
      environment,
      realpath: (path) => path,
      markerProbe: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    });
    expect(environment.LCM_TEST_HARNESS_TMPDIR).toBe("/stable-parent");
    teardown();
  });

  it("fails clearly for an explicit contaminated parent without fallback", () => {
    expect(() => createRuntimeHomeRun({ provide: vi.fn() }, {
      environment: { LCM_TEST_VITEST_RUNTIME_ROOT_PARENT: "/private/harness" },
      realpath: (path) => path,
      markerProbe: () => ({}),
    })).toThrow(/LCM_TEST_VITEST_RUNTIME_ROOT_PARENT/iu);
  });

  it("clears inherited child-only overrides while redirecting all temp names", () => {
    const child = createChildAcceptanceEnvironment({
      LCM_TEST_ARTIFACT_ROOT: "/parent/report-root",
      LCM_TEST_VITEST_RUNTIME_ROOT_PARENT: "/parent/runtime",
      LCM_TEST_HARNESS_TMPDIR: "/parent/harness",
    }, "/private/fixture");
    expect(child.LCM_TEST_ARTIFACT_ROOT).toBeUndefined();
    expect(child.LCM_TEST_VITEST_RUNTIME_ROOT_PARENT).toBeUndefined();
    expect(child.LCM_TEST_HARNESS_TMPDIR).toBeUndefined();
    expect(child.TMPDIR).toBe("/private/fixture");
    expect(child.TMP).toBe("/private/fixture");
    expect(child.TEMP).toBe("/private/fixture");
  });

  it("proves a child Vitest run relocates all runtime scratch below a clean parent", { timeout: 45_000 }, () => {
    const fixture = mkdtempSync(join(tmpdir(), "lcm-bug-840-fixture-"));
    const marker = join(fixture, ".git");
    const markerBytes = "synthetic malformed marker\n";
    mkdirSync(marker, { mode: 0o755 });
    writeFileSync(join(marker, "sentinel"), markerBytes, { mode: 0o600 });
    const markerBefore = lstatSync(marker);
    const markerBytesBefore = readFileSync(join(marker, "sentinel"));
    const childSpec = join(process.cwd(), "test", `.bug840-acceptance-${process.pid}.test.ts`);
    const resultPath = join(fixture, "result.json");
    const artifactRoot = mkdtempSync(join(tmpdir(), "lcm-bug-840-artifact-"));
    writeFileSync(childSpec, `
import { existsSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from ${JSON.stringify(join(process.cwd(), "test/e2e/harness.ts"))};
import { readFileSync } from "node:fs";
const resultPath = ${JSON.stringify(resultPath)};
describe("Bug840 child acceptance", () => {
  let handle;
  afterEach(async () => { await handle?.cleanup(); });
  it("keeps the harness outside the malformed fixture", { timeout: 25_000 }, async () => {
    handle = await createHarness("mock");
    const tmpPath = handle.tmpDir;
    const rel = relative(resolve(${JSON.stringify(fixture)}), resolve(tmpPath));
    const health = await handle.client.health();
    const config = readFileSync(join(tmpPath, "config.json"), "utf8");
    await handle.cleanup();
    handle = undefined;
    writeFileSync(resultPath, JSON.stringify({
      health,
      config,
      tmpPath,
      outside: rel.startsWith(".."),
      cleaned: !existsSync(tmpPath),
    }));
    expect(health.status).toBe("ok");
    expect(config).toBe("{}\\n");
    expect(rel.startsWith("..")).toBe(true);
    expect(existsSync(tmpPath)).toBe(false);
  });
});
`, { mode: 0o600 });
    const previousArtifactRoot = process.env.LCM_TEST_ARTIFACT_ROOT;
    process.env.LCM_TEST_ARTIFACT_ROOT = artifactRoot;
    const liveParentArtifactRoot = process.env.LCM_TEST_ARTIFACT_ROOT;
    const parentEnvironment = { ...process.env };
    const childEnvironment = createChildAcceptanceEnvironment(parentEnvironment, fixture);
    expect(childEnvironment.LCM_TEST_ARTIFACT_ROOT).toBeUndefined();
    try {
      try {
        execFileSync(process.execPath, [
          "node_modules/vitest/vitest.mjs", "run", "--config", "vitest.config.ts", childSpec,
        ], { cwd: process.cwd(), env: childEnvironment, stdio: "pipe", timeout: 30_000 });
      } catch (error) {
        const stdout = String(error?.stdout ?? "");
        const stderr = String(error?.stderr ?? "");
        throw new Error(`Bug840 child Vitest failed\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error });
      }
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      expect(result).toMatchObject({ health: { status: "ok" }, outside: true });
      expect(result.config).toBe("{}\n");
      expect(result.cleaned).toBe(true);
      expect(existsSync(result.tmpPath)).toBe(false);
      if (liveParentArtifactRoot !== undefined) {
        expect(existsSync(liveParentArtifactRoot)).toBe(true);
      }
      const markerAfter = lstatSync(marker);
      expect(markerAfter.isDirectory()).toBe(markerBefore.isDirectory());
      expect(readFileSync(join(marker, "sentinel"))).toEqual(markerBytesBefore);
      expect([...readdirSync(fixture)].filter((entry) => entry.startsWith("lcm-") && entry !== ".git")).toEqual([]);
      expect(markerAfter.mode & 0o777).toBe(markerBefore.mode & 0o777);
    } finally {
      if (previousArtifactRoot === undefined) delete process.env.LCM_TEST_ARTIFACT_ROOT;
      else process.env.LCM_TEST_ARTIFACT_ROOT = previousArtifactRoot;
      rmSync(childSpec, { force: true });
      rmSync(fixture, { recursive: true, force: true });
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });
});
