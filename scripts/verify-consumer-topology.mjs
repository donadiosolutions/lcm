import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runPackageManager(manager, args, cwd, spawn, ignoreScripts = true) {
  const command = process.platform === "win32" ? `${manager}.cmd` : manager;
  const result = spawn(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_ignore_scripts: String(ignoreScripts),
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `${manager} ${args.join(" ")} failed in ${cwd}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function writeConsumer(directory, name) {
  mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name,
    version: "1.0.0",
    private: true,
  }, null, 2));
}

function installedPackage(directory) {
  return JSON.parse(readFileSync(
    join(directory, "node_modules", "@donadiosolutions", "lcm", "package.json"),
    "utf8",
  ));
}

function installedVersion(directory, packageName) {
  return JSON.parse(readFileSync(
    join(directory, "node_modules", packageName, "package.json"),
    "utf8",
  )).version;
}

function verifyBuildDependencyPath(parentModule, dependency, expectedVersion) {
  const parentRequire = createRequire(parentModule);
  const dependencyManifest = parentRequire.resolve(`${dependency}/package.json`);
  const version = JSON.parse(readFileSync(dependencyManifest, "utf8")).version;
  if (version !== expectedVersion) {
    throw new Error(
      `${dependency} resolved to ${version} through ${parentModule}; expected ${expectedVersion}`,
    );
  }
  return dependencyManifest;
}

function verifyNoPublishedBuildDependencies(directory, label) {
  const nodeModules = join(directory, "node_modules");
  const lcmNodeModules = join(nodeModules, "@donadiosolutions", "lcm", "node_modules");
  const forbidden = [
    join(nodeModules, "@modelcontextprotocol", "sdk"),
    join(lcmNodeModules, "@modelcontextprotocol", "sdk"),
    join(lcmNodeModules, "body-parser"),
    join(lcmNodeModules, "fast-uri"),
  ];
  if (label === "ordinary") {
    forbidden.push(join(nodeModules, "body-parser"), join(nodeModules, "fast-uri"));
  }
  const retained = forbidden.find((path) => existsSync(path));
  if (retained) {
    throw new Error(`${label} consumer retained a build-only dependency path: ${retained}`);
  }
}

export function verifyCli(directory, scratchRoot, {
  inheritedEnvironment = process.env,
  spawn = spawnSync,
} = {}) {
  const home = mkdtempSync(join(scratchRoot, "lcm-packed-cli-home-"));
  const xdg = {
    XDG_CONFIG_HOME: mkdtempSync(join(home, "config-")),
    XDG_STATE_HOME: mkdtempSync(join(home, "state-")),
    XDG_CACHE_HOME: mkdtempSync(join(home, "cache-")),
    XDG_DATA_HOME: mkdtempSync(join(home, "data-")),
    XDG_RUNTIME_DIR: mkdtempSync(join(home, "runtime-")),
  };
  if (process.platform !== "win32") {
    for (const path of [home, ...Object.values(xdg)]) chmodSync(path, 0o700);
  }
  const env = {
    ...inheritedEnvironment,
    HOME: home,
    USERPROFILE: home,
    ...xdg,
  };
  const executable = join(
    directory,
    "node_modules",
    "@donadiosolutions",
    "lcm",
    "dist",
    "lcm.mjs",
  );
  const result = spawn(process.execPath, [executable, "--version"], {
    cwd: directory,
    encoding: "utf8",
    env,
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`packed LCM executable failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function verifyPostgreSqlApi(directory, spawn) {
  const source = `
    const api = await import("@donadiosolutions/lcm/storage/postgresql");
    if (typeof api.createPostgreSqlStorageBackendFactory !== "function") process.exit(2);
    if ("createPostgreSqlStorageBackendFactoryForTesting" in api) process.exit(3);
  `;
  const result = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: directory,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `packed PostgreSQL API failed in ${directory}\n${result.stdout}\n${result.stderr}`,
    );
  }
}

export function executeConsumerTopology(scratch, { spawn = spawnSync } = {}) {
  const runNpm = (args, cwd) => runPackageManager("npm", args, cwd, spawn);
  const rootRequire = createRequire(join(root, "package.json"));
  const sdkServer = rootRequire.resolve("@modelcontextprotocol/sdk/server/index.js");
  const expressManifest = createRequire(sdkServer).resolve("express/package.json");
  const ajvManifest = createRequire(sdkServer).resolve("ajv/package.json");
  const bodyParserManifest = verifyBuildDependencyPath(
    expressManifest,
    "body-parser",
    "2.3.0",
  );
  const fastUriManifest = verifyBuildDependencyPath(ajvManifest, "fast-uri", "3.1.5");
  console.log(
    `build: sdk-express-body-parser=2.3.0 @ ${bodyParserManifest} `
    + `sdk-ajv-fast-uri=3.1.5 @ ${fastUriManifest}`,
  );

  runPackageManager("pnpm", ["run", "build"], root, spawn, false);
  const packOutput = runNpm([
    "pack",
    "--json",
    "--pack-destination",
    scratch,
  ], root);
  const [{ filename }] = JSON.parse(packOutput);
  const tarball = join(scratch, filename);

  const ordinary = join(scratch, "ordinary");
  const conflicting = join(scratch, "conflicting");
  writeConsumer(ordinary, "lcm-ordinary-consumer");
  writeConsumer(conflicting, "lcm-conflicting-consumer");

  runNpm(["install", "--save-exact", tarball], ordinary);
  runNpm([
    "install",
    "--save-exact",
    "body-parser@2.2.2",
    "fast-uri@3.1.0",
    tarball,
  ], conflicting);

  for (const [directory, label] of [[ordinary, "ordinary"], [conflicting, "conflicting"]]) {
    const pkg = installedPackage(directory);
    if (pkg.dependencies?.["@modelcontextprotocol/sdk"]
        || pkg.dependencies?.["body-parser"]
        || pkg.dependencies?.["fast-uri"]) {
      throw new Error(`${label} packed package exposes build-only SDK dependencies`);
    }
    if (pkg.dependencies?.["@hono/node-server"] !== "2.0.12") {
      throw new Error(`${label} packed package changed the independently pinned Hono dependency`);
    }
    verifyNoPublishedBuildDependencies(directory, label);
    verifyPostgreSqlApi(directory, spawn);
    console.log(
      `${label}: lcm=${pkg.version} external-sdk=absent cli=${verifyCli(directory, scratch, { spawn })}`,
    );
  }

  console.log(
    "conflicting: "
    + `root-body-parser=${installedVersion(conflicting, "body-parser")} `
    + `root-fast-uri=${installedVersion(conflicting, "fast-uri")} `
    + "sdk-express-body-parser=absent sdk-ajv-fast-uri=absent",
  );
}

function defaultCleanupFailureReporter(scratchPath, cleanupError) {
  console.error(
    `verify-consumer-topology cleanup failed for ${scratchPath}\n${cleanupError}`,
  );
}

export function runConsumerTopology({
  execute = executeConsumerTopology,
  temporaryRoot = tmpdir(),
  cleanup = (path) => rmSync(path, { recursive: true, force: true }),
  reportCleanupFailure = defaultCleanupFailureReporter,
} = {}) {
  const relativeRoot = relative(realpathSync(root), realpathSync(temporaryRoot));
  if (relativeRoot !== ".." && !relativeRoot.startsWith(`..${sep}`)
      && !isAbsolute(relativeRoot)) {
    throw new Error("Consumer temporary root must be outside the repository");
  }
  const scratch = mkdtempSync(join(temporaryRoot, "lcm-consumer-topology-"));
  let verificationError;
  let verificationFailed = false;
  let result;
  try {
    result = execute(scratch);
  } catch (error) {
    verificationError = error;
    verificationFailed = true;
  }

  let cleanupError;
  let cleanupFailed = false;
  try {
    cleanup(scratch);
  } catch (error) {
    cleanupError = error;
    cleanupFailed = true;
  }

  if (verificationFailed) {
    if (cleanupFailed) {
      try {
        reportCleanupFailure(scratch, cleanupError);
      } catch {
        // Preserve the primary verification failure if reporting also fails.
      }
    }
    throw verificationError;
  }
  if (cleanupFailed) throw cleanupError;
  return result;
}

export function runIfDirect({
  invokedPath = process.argv[1],
  moduleUrl = import.meta.url,
  run = runConsumerTopology,
} = {}) {
  const invokedUrl = invokedPath ? pathToFileURL(resolve(invokedPath)).href : undefined;
  if (invokedUrl !== moduleUrl) return false;
  run();
  return true;
}

runIfDirect();
