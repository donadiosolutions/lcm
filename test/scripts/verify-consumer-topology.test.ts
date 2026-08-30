import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = resolve(repositoryRoot, "scripts/verify-consumer-topology.mjs");
const childEnvironmentKeys = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
] as const;
const xdgEnvironmentKeys = childEnvironmentKeys.slice(2);

type SpawnRecord = {
  command: string;
  args: string[];
  options: Record<string, unknown>;
  productionEnvironment: NodeJS.ProcessEnv | undefined;
  effectiveEnvironment: NodeJS.ProcessEnv;
};

function isolatedRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const containment = relative(tmpdir(), root);
  if (
    !containment
    || containment === ".."
    || containment.startsWith("../")
    || containment.startsWith("..\\")
    || containment.startsWith("/")
    || containment.startsWith("\\")
  ) {
    throw new Error(`fixture root escaped operating-system temp root: ${root}`);
  }
  return root;
}

function isStrictDescendant(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return Boolean(childRelative)
    && childRelative !== ".."
    && !childRelative.startsWith("../")
    && !childRelative.startsWith("..\\")
    && !childRelative.startsWith("/")
    && !childRelative.startsWith("\\");
}

function createFallbackEnvironment(
  operationRoot: string,
  inheritedEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const fallbackRoot = mkdtempSync(join(operationRoot, "test-owned-fallback-"));
  const home = mkdtempSync(join(fallbackRoot, "home-"));
  const xdg = Object.fromEntries(xdgEnvironmentKeys.map((key) => [
    key,
    mkdtempSync(join(home, `${key.toLowerCase()}-`)),
  ])) as Record<typeof xdgEnvironmentKeys[number], string>;
  if (process.platform !== "win32") {
    for (const path of [fallbackRoot, home, ...Object.values(xdg)]) chmodSync(path, 0o700);
  }
  return {
    ...inheritedEnvironment,
    HOME: home,
    USERPROFILE: home,
    ...xdg,
  };
}

function protectiveSpawn(
  operationRoot: string,
  inheritedEnvironment: NodeJS.ProcessEnv,
  records: SpawnRecord[],
) {
  return (
    command: string,
    args: string[],
    options: Record<string, unknown> = {},
  ) => {
    const productionEnvironment = options.env as NodeJS.ProcessEnv | undefined;
    const complete = productionEnvironment !== undefined
      && productionEnvironment !== null
      && typeof productionEnvironment === "object"
      && childEnvironmentKeys.every((key) => {
        const path = productionEnvironment[key];
        return typeof path === "string" && isStrictDescendant(operationRoot, path)
          && existsSync(path) && lstatSync(path).isDirectory();
      })
      && productionEnvironment.HOME === productionEnvironment.USERPROFILE
      && new Set(xdgEnvironmentKeys.map((key) => productionEnvironment[key])).size
        === xdgEnvironmentKeys.length
      && xdgEnvironmentKeys.every((key) => isStrictDescendant(
        productionEnvironment.HOME!,
        productionEnvironment[key]!,
      ));
    const effectiveEnvironment = complete
      ? productionEnvironment!
      : createFallbackEnvironment(operationRoot, inheritedEnvironment);
    records.push({ command, args, options, productionEnvironment, effectiveEnvironment });
    const effectiveOptions = complete
      ? options
      : { ...options, env: effectiveEnvironment };
    return spawnSync(command, args, effectiveOptions);
  };
}

function expectProductionEnvironment(
  record: SpawnRecord,
  operationRoot: string,
  inheritedEnvironment: NodeJS.ProcessEnv,
): asserts record is SpawnRecord & { productionEnvironment: NodeJS.ProcessEnv } {
  expect(record.productionEnvironment).toBeDefined();
  expect(Object.prototype.hasOwnProperty.call(record.options, "env")).toBe(true);
  const environment = record.productionEnvironment!;
  expect(childEnvironmentKeys.every((key) => typeof environment[key] === "string")).toBe(true);
  expect(environment.HOME).toBe(environment.USERPROFILE);
  expect(new Set(xdgEnvironmentKeys.map((key) => environment[key])).size)
    .toBe(xdgEnvironmentKeys.length);
  expect(isStrictDescendant(operationRoot, environment.HOME!)).toBe(true);
  for (const key of xdgEnvironmentKeys) {
    expect(isStrictDescendant(operationRoot, environment[key]!)).toBe(true);
    expect(isStrictDescendant(environment.HOME!, environment[key]!)).toBe(true);
    expect(existsSync(environment[key]!)).toBe(true);
    expect(environment[key]).not.toBe(inheritedEnvironment[key]);
  }
  expect(existsSync(environment.HOME!)).toBe(true);
  expect(environment.HOME).not.toBe(inheritedEnvironment.HOME);
  expect(environment.USERPROFILE).not.toBe(inheritedEnvironment.USERPROFILE);
}

function expectEffectiveEnvironment(record: SpawnRecord, operationRoot: string): void {
  const environment = record.effectiveEnvironment;
  expect(childEnvironmentKeys.every((key) => typeof environment[key] === "string")).toBe(true);
  expect(environment.HOME).toBe(environment.USERPROFILE);
  expect(isStrictDescendant(operationRoot, environment.HOME!)).toBe(true);
  for (const key of xdgEnvironmentKeys) {
    expect(isStrictDescendant(operationRoot, environment[key]!)).toBe(true);
    expect(isStrictDescendant(environment.HOME!, environment[key]!)).toBe(true);
    expect(existsSync(environment[key]!)).toBe(true);
  }
}

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const key = relative(root, path);
      if (entry.isDirectory()) visit(path);
      else snapshot[key] = readFileSync(path, "utf8");
    }
  };
  visit(root);
  return snapshot;
}

function makeDeveloperRoots(root: string): Record<string, string> {
  const names = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"];
  return Object.fromEntries(names.map((name) => {
    const path = join(root, name.toLowerCase());
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, `${name.toLowerCase()}-sentinel.txt`), `${name}-sentinel\n`);
    return [name, path];
  }));
}

function fakeConsumer(directory: string, observationPath: string): void {
  const executable = join(directory, "node_modules", "@donadiosolutions", "lcm", "dist");
  mkdirSync(executable, { recursive: true });
  writeFileSync(join(executable, "lcm.mjs"), `
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const keys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"];
const observed = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const paths = [homedir(), ...keys.slice(2).map((key) => process.env[key])];
for (const path of paths) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "child-marker.txt"), "child-marker\\n");
}
writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify({ observed, homedir: homedir(), tmpdir: process.env.TMPDIR, ordinary: process.env.ORDINARY_SENTINEL, database: process.env.LCM_DATABASE_PATH }));
process.stdout.write(" 9.8.7 \\n");
`);
  writeFileSync(join(executable, "../package.json"), JSON.stringify({ type: "module" }));
}

function unusableTempEnvironment(root: string): NodeJS.ProcessEnv {
  const file = join(root, "not-a-directory");
  writeFileSync(file, "regular file\n");
  return {
    ...process.env,
    TMPDIR: file,
    TMP: file,
    TEMP: file,
  };
}

describe("verify-consumer-topology", () => {
  it("does not execute verification when dynamically imported", () => {
    const root = isolatedRoot("verify-import-");
    try {
      const env = unusableTempEnvironment(root);
      const source = `await import(${JSON.stringify(scriptPath)});`;
      expect(() => execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
        cwd: repositoryRoot,
        env,
        encoding: "utf8",
        stdio: "pipe",
      })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs scratch setup only for direct execution", () => {
    const root = isolatedRoot("verify-direct-");
    try {
      const env = unusableTempEnvironment(root);
      expect(() => execFileSync(process.execPath, [scriptPath], {
        cwd: repositoryRoot,
        env,
        encoding: "utf8",
        stdio: "pipe",
      })).toThrow();
      const source = `await import(${JSON.stringify(scriptPath)});`;
      expect(() => execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
        cwd: repositoryRoot,
        env,
        encoding: "utf8",
        stdio: "pipe",
      })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports the runIfDirect guard without process mutation", async () => {
    const module = await import(scriptPath);
    const run = vi.fn();
    expect(module.runIfDirect({ invokedPath: undefined, moduleUrl: "file:///script.mjs", run })).toBe(false);
    expect(module.runIfDirect({ invokedPath: "/other.mjs", moduleUrl: "file:///script.mjs", run })).toBe(false);
    expect(module.runIfDirect({ invokedPath: scriptPath, moduleUrl: `file://${scriptPath}`, run })).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("isolates every packed CLI home and preserves unrelated environment", async () => {
    const module = await import(scriptPath);
    const root = isolatedRoot("verify-cli-");
    const developerRoot = isolatedRoot("developer-");
    const directory = join(root, "consumer");
    mkdirSync(directory, { recursive: true });
    const observationPath = join(root, "observation.json");
    fakeConsumer(directory, observationPath);
    const developer = makeDeveloperRoots(developerRoot);
    const before = snapshotTree(developerRoot);
    const inherited = {
      ...process.env,
      ...developer,
      TMPDIR: "/lane/private/tmp",
      ORDINARY_SENTINEL: "ordinary-value",
      LCM_DATABASE_PATH: "/developer/database.sqlite",
    };
    const records: SpawnRecord[] = [];
    try {
      const spawn = protectiveSpawn(root, inherited, records);
      const version = module.verifyCli(directory, root, {
        inheritedEnvironment: inherited,
        spawn,
      });
      expect(version).toBe("9.8.7");
      expect(records).toHaveLength(1);
      expectEffectiveEnvironment(records[0], root);
      const observation = JSON.parse(readFileSync(observationPath, "utf8")) as {
        observed: Record<string, string>;
        homedir: string;
        tmpdir: string;
        ordinary: string;
        database: string;
      };
      expect(observation.tmpdir).toBe(inherited.TMPDIR);
      expect(observation.ordinary).toBe("ordinary-value");
      expect(observation.database).toBe("/developer/database.sqlite");
      expect(observation.observed.HOME).toBe(observation.observed.USERPROFILE);
      expect(observation.homedir).toBe(observation.observed.HOME);
      const isolatedHome = observation.observed.HOME;
      expect(isolatedHome).not.toBe(developer.HOME);
      const homeRelative = relative(root, isolatedHome);
      expect(homeRelative).not.toMatch(/^\.\.(?:[\\/]|$)/u);
      expect(homeRelative).not.toMatch(/^[\\/]/u);
      const xdgKeys = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"];
      for (const key of xdgKeys) {
        const path = observation.observed[key];
        const childRelative = relative(isolatedHome, path);
        expect(childRelative).not.toBe("");
        expect(childRelative).not.toMatch(/^\.\.(?:[\\/]|$)/u);
        expect(childRelative).not.toMatch(/^[\\/]/u);
        expect(existsSync(path)).toBe(true);
        expect(path).not.toBe(developer[key]);
        expect(existsSync(join(path, "child-marker.txt"))).toBe(true);
      }
      expect(existsSync(join(isolatedHome, "child-marker.txt"))).toBe(true);
      for (const key of Object.keys(developer)) {
        expect(observation.observed[key]).not.toBe(developer[key]);
      }
      expect(snapshotTree(developerRoot)).toEqual(before);
      if (process.platform !== "win32") {
        for (const path of [isolatedHome, ...xdgKeys.map((key) => observation.observed[key])]) {
          expect(lstatSync(path).uid).toBe(process.getuid());
          expect(lstatSync(path).mode & 0o777).toBe(0o700);
        }
      }
      expectProductionEnvironment(records[0], root, inherited);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(developerRoot, { recursive: true, force: true });
    }
  });

  it("gives separate invocations distinct homes", async () => {
    const module = await import(scriptPath);
    const root = isolatedRoot("verify-distinct-");
    const directory = join(root, "consumer");
    mkdirSync(directory, { recursive: true });
    const firstObservation = join(root, "first.json");
    const secondObservation = join(root, "second.json");
    const developerRoot = isolatedRoot("verify-distinct-developer-");
    const inherited = {
      ...process.env,
      ...makeDeveloperRoots(developerRoot),
      TMPDIR: "/lane/private/tmp",
    };
    const records: SpawnRecord[] = [];
    try {
      const spawn = protectiveSpawn(root, inherited, records);
      fakeConsumer(directory, firstObservation);
      expect(module.verifyCli(directory, root, {
        inheritedEnvironment: inherited,
        spawn,
      })).toBe("9.8.7");
      fakeConsumer(directory, secondObservation);
      expect(module.verifyCli(directory, root, {
        inheritedEnvironment: inherited,
        spawn,
      })).toBe("9.8.7");
      const first = JSON.parse(readFileSync(firstObservation, "utf8"));
      const second = JSON.parse(readFileSync(secondObservation, "utf8"));
      expect(first.homedir).not.toBe(second.homedir);
      expect(records).toHaveLength(2);
      for (const record of records) {
        expectEffectiveEnvironment(record, root);
        expectProductionEnvironment(record, root, inherited);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(developerRoot, { recursive: true, force: true });
    }
  });

  it("preserves the packed CLI spawn contract and fails closed", async () => {
    const module = await import(scriptPath);
    const root = isolatedRoot("verify-spawn-");
    const directory = join(root, "consumer");
    mkdirSync(directory, { recursive: true });
    const calls: unknown[] = [];
    try {
      const result = module.verifyCli(directory, root, {
        inheritedEnvironment: { ...process.env, TMPDIR: "sentinel-tmp" },
        spawn: (...args: unknown[]) => {
          calls.push(args);
          return { status: 0, stdout: " 1.2.3 \n", stderr: "" };
        },
      });
      expect(result).toBe("1.2.3");
      expect(calls).toHaveLength(1);
      const [command, args, options] = calls[0] as [string, string[], Record<string, unknown>];
      expect(command).toBe(process.execPath);
      expect(args).toEqual([join(directory, "node_modules", "@donadiosolutions", "lcm", "dist", "lcm.mjs"), "--version"]);
      expect(options).toMatchObject({ cwd: directory, encoding: "utf8" });
      expect((options.env as Record<string, string>).TMPDIR).toBe("sentinel-tmp");
      const fileScratch = join(root, "not-a-directory");
      writeFileSync(fileScratch, "file");
      const spawn = vi.fn();
      expect(() => module.verifyCli(directory, fileScratch, { spawn })).toThrow();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconciles verification and cleanup failures", async () => {
    const module = await import(scriptPath);
    const executeError = new Error("execute failed");
    const cleanupError = new Error("cleanup failed");
    const cases: Array<[string, unknown, unknown, boolean, unknown]> = [
      ["success", undefined, undefined, false, undefined],
      ["cleanup", undefined, cleanupError, false, cleanupError],
      ["verification", executeError, undefined, false, executeError],
      ["both", executeError, cleanupError, true, executeError],
    ];
    for (const [, executeFailure, cleanupFailure, report, expected] of cases) {
      const createdScratchPaths: string[] = [];
      const cleanup = vi.fn(() => {
        if (cleanupFailure) throw cleanupFailure;
      });
      const reporter = vi.fn();
      const execute = vi.fn((scratch: string) => {
        createdScratchPaths.push(scratch);
        expect(existsSync(scratch)).toBe(true);
        if (executeFailure) throw executeFailure;
        return "ok";
      });
      const operation = () => module.runConsumerTopology({ execute, cleanup, reportCleanupFailure: reporter });
      try {
        if (expected) {
          try {
            operation();
            throw new Error("expected operation to fail");
          } catch (error) {
            expect(error).toBe(expected);
          }
        } else expect(operation()).toBe("ok");
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledWith(execute.mock.calls[0][0]);
        expect(reporter).toHaveBeenCalledTimes(report ? 1 : 0);
        if (report) expect(reporter).toHaveBeenCalledWith(execute.mock.calls[0][0], cleanupError);
      } finally {
        for (const scratch of createdScratchPaths) rmSync(scratch, { recursive: true, force: true });
      }
    }

    const reporterFailure = new Error("reporter failed");
    const primary = new Error("primary");
    const reporterFailureScratchPaths: string[] = [];
    try {
      try {
        module.runConsumerTopology({
          execute: (scratch: string) => {
            reporterFailureScratchPaths.push(scratch);
            expect(existsSync(scratch)).toBe(true);
            throw primary;
          },
          cleanup: () => { throw cleanupError; },
          reportCleanupFailure: () => { throw reporterFailure; },
        });
        throw new Error("expected operation to fail");
      } catch (error) {
        expect(error).toBe(primary);
      }
    } finally {
      for (const scratch of reporterFailureScratchPaths) {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  });

  it("keeps packed CLI failure diagnostics unchanged", async () => {
    const module = await import(scriptPath);
    const root = isolatedRoot("verify-errors-");
    const directory = join(root, "consumer");
    mkdirSync(directory, { recursive: true });
    try {
      for (const result of [
        { status: 2, stdout: "1.0.0", stderr: "bad" },
        { status: 0, stdout: "", stderr: "blank" },
      ]) {
        expect(() => module.verifyCli(directory, root, { spawn: () => result })).toThrowError(
          "packed LCM executable failed",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
