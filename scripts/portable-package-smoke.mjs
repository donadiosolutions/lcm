import { copyFileSync, cpSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));

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
  const fixture = join(directory, "portable-package.mts");
  copyFileSync(new URL("../test/types/portable-package.ts", import.meta.url), fixture);
  const typed = spawn(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
    "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext",
    "--typeRoots", join(root, "node_modules/@types"), fixture], { cwd: directory, encoding: "utf8", env: environment });
  if (typed.status !== 0) throw new Error(`portable package consumer declarations failed\n${typed.stdout}\n${typed.stderr}`);
}

/** Offline artifact topology: actual tarball plus private copies of locked dependencies. */
export function stagePortableArtifact(tarball, directory) {
  const packageRoot = join(directory, "node_modules", "@donadiosolutions", "lcm");
  mkdirSync(packageRoot, { recursive: true });
  const extracted = spawnSync("tar", ["-xzf", tarball, "--strip-components=1", "-C", packageRoot], { encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(`portable artifact extraction failed: ${extracted.stderr}`);
  const copyDependencies = (sourceRoot, targetRoot, ancestors = new Set()) => {
    const manifest = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
    const require = createRequire(join(sourceRoot, "package.json"));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      let dependencyRoot = dirname(require.resolve(name));
      while (!existsSync(join(dependencyRoot, "package.json"))
        || JSON.parse(readFileSync(join(dependencyRoot, "package.json"), "utf8")).name !== name) {
        const parent = dirname(dependencyRoot);
        if (parent === dependencyRoot) throw new Error(`cannot locate installed dependency ${name}`);
        dependencyRoot = parent;
      }
      if (ancestors.has(dependencyRoot)) throw new Error(`unexpected dependency cycle ${name}`);
      const target = join(targetRoot, "node_modules", name);
      cpSync(dependencyRoot, target, { recursive: true, dereference: true,
        filter: path => path !== join(dependencyRoot, "node_modules") });
      copyDependencies(dependencyRoot, target, new Set([...ancestors, dependencyRoot]));
    }
  };
  copyDependencies(root, packageRoot);
}
