import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "lcm-consumer-topology-"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function runNpm(args, cwd, ignoreScripts = true) {
  const result = spawnSync(npmCommand, args, {
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
      `npm ${args.join(" ")} failed in ${cwd}\n${result.stdout}\n${result.stderr}`,
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

function verifyCli(directory) {
  const executable = join(
    directory,
    "node_modules",
    "@donadiosolutions",
    "lcm",
    "dist",
    "lcm.mjs",
  );
  const result = spawnSync(process.execPath, [executable, "--version"], {
    cwd: directory,
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`packed LCM executable failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

try {
  const rootRequire = createRequire(join(root, "package.json"));
  const sdkServer = rootRequire.resolve("@modelcontextprotocol/sdk/server/index.js");
  const expressManifest = createRequire(sdkServer).resolve("express/package.json");
  const ajvManifest = createRequire(sdkServer).resolve("ajv/package.json");
  const bodyParserManifest = verifyBuildDependencyPath(
    expressManifest,
    "body-parser",
    "2.3.0",
  );
  const fastUriManifest = verifyBuildDependencyPath(ajvManifest, "fast-uri", "3.1.4");
  console.log(
    `build: sdk-express-body-parser=2.3.0 @ ${bodyParserManifest} `
    + `sdk-ajv-fast-uri=3.1.4 @ ${fastUriManifest}`,
  );

  runNpm(["run", "build"], root, false);
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
    console.log(
      `${label}: lcm=${pkg.version} external-sdk=absent cli=${verifyCli(directory)}`,
    );
  }

  console.log(
    "conflicting: "
    + `root-body-parser=${installedVersion(conflicting, "body-parser")} `
    + `root-fast-uri=${installedVersion(conflicting, "fast-uri")} `
    + "sdk-express-body-parser=absent sdk-ajv-fast-uri=absent",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
