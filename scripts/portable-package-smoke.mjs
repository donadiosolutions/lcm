import { copyFileSync, cpSync, mkdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const declarationFixtures = [
  ["root-package.ts", "root-package.mts"],
  ["native-transcript-package.ts", "native-transcript-package.mts"],
  ["postgresql-package.ts", "postgresql-package.mts"],
  ["portable-package.ts", "portable-package.mts"],
];

function installedPackageRoot(parentRequire, name) {
  let entryPath;
  try {
    entryPath = parentRequire.resolve(`${name}/package.json`);
  } catch {
    entryPath = parentRequire.resolve(name);
  }
  let directory = dirname(entryPath);
  while (directory !== dirname(directory)) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)
        && JSON.parse(readFileSync(manifestPath, "utf8")).name === name) {
      return directory;
    }
    directory = dirname(directory);
  }
  throw new Error(`cannot locate installed package ${name}`);
}

function copyDependencyTree(sourceRoot, targetRoot, ancestors = new Set()) {
  const manifest = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
  const parentRequire = createRequire(join(sourceRoot, "package.json"));
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const dependencyRoot = installedPackageRoot(parentRequire, name);
    if (ancestors.has(dependencyRoot)) throw new Error(`unexpected dependency cycle ${name}`);
    const target = join(targetRoot, "node_modules", name);
    cpSync(dependencyRoot, target, {
      recursive: true,
      dereference: true,
      filter: path => path !== join(dependencyRoot, "node_modules"),
    });
    copyDependencyTree(dependencyRoot, target, new Set([...ancestors, dependencyRoot]));
  }
}

/** Stage only the exact Node ambient package needed by strict consumers. */
export function stageConsumerNodeTypes(directory) {
  const parentRequire = createRequire(join(root, "package.json"));
  const sourceRoot = installedPackageRoot(parentRequire, "@types/node");
  const targetRoot = join(directory, "node_modules", "@types", "node");
  if (!existsSync(targetRoot) || realpathSync(targetRoot) !== realpathSync(sourceRoot)) {
    cpSync(sourceRoot, targetRoot, { recursive: true, dereference: true });
  }
  copyDependencyTree(sourceRoot, targetRoot, new Set([sourceRoot]));
}

/** Compile every published package entry with strict, package-local resolution. */
export function verifyConsumerDeclarations(directory, { spawn = spawnSync } = {}) {
  stageConsumerNodeTypes(directory);
  const fixtures = declarationFixtures.map(([source, targetName]) => {
    const target = join(directory, targetName);
    copyFileSync(new URL(`../test/types/${source}`, import.meta.url), target);
    return target;
  });
  const typed = spawn(process.execPath, [join(root, "node_modules/typescript/bin/tsc"),
    "--ignoreConfig", "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext",
    "--moduleResolution", "NodeNext", "--types", "node", ...fixtures], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: "" },
  });
  if (typed.status !== 0) {
    throw new Error(`package consumer declarations failed\n${typed.stdout}\n${typed.stderr}`);
  }
}

/** Resolve through the installed export map; importing must not open storage. */
export function verifyPortablePackage(directory, { spawn = spawnSync, checkTypes = true } = {}) {
  const source = `
    import assert from "node:assert/strict";
    const api = await import("@donadiosolutions/lcm/storage/portable");
    const functions = ["canonicalJson", "canonicalSha256", "createPortableRecord", "createPortableRecordStream",
      "parsePortableCheckpoint", "parsePortableManifest", "parsePortableRecord", "serializePortableCheckpoint",
      "serializePortableManifest", "serializePortableRecord", "verifyPortableCheckpoint", "runPortableTransfer",
      "openSqlitePortableSource", "sqlitePortableFileSha256", "openSqlitePortableDestination",
      "createPostgreSqlPortableSource", "createPostgreSqlPortableDestination", "PortableStreamError", "PortableTransferError"];
    const constants = ["PORTABLE_LIMITS", "PORTABLE_RECORD_DOMAIN_ORDER", "PORTABLE_RECORD_SCHEMA_SHA256"];
    assert.deepEqual(Object.keys(api).sort(), [...functions, ...constants].sort());
    for (const name of functions) assert.equal(typeof api[name], "function", name);
    assert.equal(api.PORTABLE_RECORD_DOMAIN_ORDER.length, 22);
    assert.equal(api.canonicalJson({b:2,a:1}), '{"a":1,"b":2}');
    assert.equal(api.canonicalSha256({a:1}), "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
    for (const subpath of ["storage", "storage/index", "dist/src/storage/index.js"]) {
      await assert.rejects(import("@donadiosolutions/lcm/" + subpath), {code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});
    }
  `;
  const environment = { ...process.env };
  delete environment.NODE_PATH;
  const runtime = spawn(process.execPath, ["--input-type=module", "--eval", source], { cwd: directory, encoding: "utf8", env: environment });
  if (runtime.status !== 0) throw new Error(`portable package runtime import failed\n${runtime.stdout}\n${runtime.stderr}`);
  if (!checkTypes) return;
  verifyConsumerDeclarations(directory, { spawn });
}

/** Offline artifact topology: actual tarball plus private copies of locked dependencies. */
export function stagePortableArtifact(tarball, directory) {
  const packageRoot = join(directory, "node_modules", "@donadiosolutions", "lcm");
  mkdirSync(packageRoot, { recursive: true });
  const extracted = spawnSync("tar", ["-xzf", tarball, "--strip-components=1", "-C", packageRoot], { encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(`portable artifact extraction failed: ${extracted.stderr}`);
  copyDependencyTree(root, packageRoot);
}
