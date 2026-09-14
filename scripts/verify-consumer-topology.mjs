import { verifyPortablePackage } from "./portable-package-smoke.mjs";
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
import { load as loadYaml } from "js-yaml";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const buildDependencyNames = [
  "@modelcontextprotocol/sdk",
  "body-parser",
  "fast-uri",
  "esbuild",
];
const nestedBuildDependencyNames = ["ajv>fast-uri", "qs"];

function exactVersion(section, name, version) {
  if (typeof version !== "string" || !exactSemver.test(version)) {
    throw new Error(`${section}.${name} must be an exact semver pin`);
  }
  return version;
}

function versionMap(source, section) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`${section} must be a dependency map`);
  }
  return Object.fromEntries(Object.entries(source).map(([name, version]) => [
    name,
    exactVersion(section, name, version),
  ]));
}

function requiredVersion(source, section, name) {
  const version = source[name];
  if (version === undefined) throw new Error(`${section}.${name} is required`);
  return exactVersion(section, name, version);
}

/** Load the expected install topology solely from canonical source manifests. */
export function loadCanonicalDependencyTopology({
  packagePath = join(root, "package.json"),
  workspacePath = join(root, "pnpm-workspace.yaml"),
} = {}) {
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const runtimeDependencies = versionMap(pkg.dependencies, "dependencies");
  const developmentDependencies = versionMap(pkg.devDependencies, "devDependencies");
  const peerDependencies = versionMap(pkg.peerDependencies, "peerDependencies");
  const peerMetadata = pkg.peerDependenciesMeta;
  if (!peerMetadata || typeof peerMetadata !== "object" || Array.isArray(peerMetadata)) {
    throw new Error("peerDependenciesMeta must be a dependency map");
  }
  for (const [name, version] of Object.entries(peerDependencies)) {
    if (peerMetadata[name]?.optional !== true) {
      throw new Error(`optional peer ${name} must declare metadata as optional`);
    }
    if (developmentDependencies[name] !== version) {
      throw new Error(`optional peer ${name} must equal its development dependency`);
    }
  }
  for (const name of buildDependencyNames) {
    if (runtimeDependencies[name] !== undefined) {
      throw new Error(`${name} is build-only and must not be a runtime dependency`);
    }
    requiredVersion(developmentDependencies, "devDependencies", name);
  }

  const workspace = loadYaml(readFileSync(workspacePath, "utf8"));
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
    throw new Error("pnpm workspace configuration must be an object");
  }
  const overrides = versionMap(workspace.overrides, "overrides");
  const onlyBuiltDependencies = workspace.onlyBuiltDependencies;
  if (!Array.isArray(onlyBuiltDependencies) || !onlyBuiltDependencies.includes("esbuild")) {
    throw new Error("pnpm workspace must allow esbuild build scripts");
  }
  const buildDependencies = Object.fromEntries(buildDependencyNames.map((name) => [
    name,
    requiredVersion(developmentDependencies, "devDependencies", name),
  ]));
  const nestedBuildDependencies = Object.fromEntries(nestedBuildDependencyNames.map((name) => [
    name,
    requiredVersion(overrides, "overrides", name),
  ]));
  return { runtimeDependencies, buildDependencies, nestedBuildDependencies };
}

function dependencyManifest(parentRequire, dependency, expectedVersion, entry = dependency) {
  let manifestPath;
  try {
    const candidate = parentRequire.resolve(`${dependency}/package.json`);
    if (JSON.parse(readFileSync(candidate, "utf8")).name === dependency) manifestPath = candidate;
  } catch {
    // Packages may export a nested package.json; resolve an executable entry below.
  }
  if (manifestPath) {
    const version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
    if (version !== expectedVersion) {
      throw new Error(
        `${dependency} resolved to ${version} through ${parentRequire.resolve("./package.json")}; expected ${expectedVersion}`,
      );
    }
    return manifestPath;
  }
  const entryPath = parentRequire.resolve(entry);
  let directory = dirname(entryPath);
  while (directory !== dirname(directory)) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate) && JSON.parse(readFileSync(candidate, "utf8")).name === dependency) {
      manifestPath = candidate;
      break;
    }
    directory = dirname(directory);
  }
  if (!manifestPath) throw new Error(`${dependency} package manifest is not resolvable`);
  const version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
  if (version !== expectedVersion) {
    throw new Error(
      `${dependency} resolved to ${version} through ${parentRequire.resolve("./package.json")}; expected ${expectedVersion}`,
    );
  }
  return manifestPath;
}

/** Verify installed nested build paths against the independently loaded manifests. */
export function verifyNestedBuildDependencies(
  rootRequire,
  buildDependencies,
  nestedBuildDependencies,
) {
  const sdkManifest = dependencyManifest(
    rootRequire,
    "@modelcontextprotocol/sdk",
    buildDependencies["@modelcontextprotocol/sdk"],
    "@modelcontextprotocol/sdk/server/index.js",
  );
  dependencyManifest(rootRequire, "body-parser", buildDependencies["body-parser"]);
  dependencyManifest(rootRequire, "fast-uri", buildDependencies["fast-uri"]);
  dependencyManifest(rootRequire, "esbuild", buildDependencies.esbuild);
  const sdkRequire = createRequire(sdkManifest);
  const expressManifest = sdkRequire.resolve("express/package.json");
  const ajvManifest = sdkRequire.resolve("ajv/package.json");
  const bodyParserManifest = dependencyManifest(
    createRequire(expressManifest),
    "body-parser",
    buildDependencies["body-parser"],
  );
  const expressQsManifest = dependencyManifest(
    createRequire(expressManifest),
    "qs",
    nestedBuildDependencies.qs,
  );
  const bodyParserQsManifest = dependencyManifest(
    createRequire(bodyParserManifest),
    "qs",
    nestedBuildDependencies.qs,
  );
  const fastUriManifest = dependencyManifest(
    createRequire(ajvManifest),
    "fast-uri",
    nestedBuildDependencies["ajv>fast-uri"],
  );
  return { bodyParserManifest, expressQsManifest, bodyParserQsManifest, fastUriManifest };
}

/** Compare a packaged manifest with the canonical source runtime dependency map. */
export function verifyPackedRuntimeDependencies(packedDependencies, runtimeDependencies) {
  const packed = versionMap(packedDependencies, "packed dependencies");
  if (Object.keys(packed).length !== Object.keys(runtimeDependencies).length
      || Object.entries(runtimeDependencies).some(([name, version]) => packed[name] !== version)) {
    throw new Error("packed runtime dependencies differ from the canonical manifest");
  }
}

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
  const topology = loadCanonicalDependencyTopology();
  const rootRequire = createRequire(join(root, "package.json"));
  const {
    bodyParserManifest,
    expressQsManifest,
    bodyParserQsManifest,
    fastUriManifest,
  } = verifyNestedBuildDependencies(
    rootRequire,
    topology.buildDependencies,
    topology.nestedBuildDependencies,
  );
  console.log(
    `build: sdk-express-body-parser=${topology.buildDependencies["body-parser"]} @ ${bodyParserManifest} `
    + `sdk-express-qs=${topology.nestedBuildDependencies.qs} @ ${expressQsManifest} `
    + `sdk-body-parser-qs=${topology.nestedBuildDependencies.qs} @ ${bodyParserQsManifest} `
    + `sdk-ajv-fast-uri=${topology.nestedBuildDependencies["ajv>fast-uri"]} @ ${fastUriManifest}`,
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
    verifyPackedRuntimeDependencies(pkg.dependencies, topology.runtimeDependencies);
    verifyNoPublishedBuildDependencies(directory, label);
    verifyPostgreSqlApi(directory, spawn);
    verifyPortablePackage(directory, { spawn });
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
