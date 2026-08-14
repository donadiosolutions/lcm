import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const subpath = packageJson.exports?.["./storage/postgresql"];
if (
  typeof subpath?.import !== "string"
  || typeof subpath.types !== "string"
) {
  throw new Error("PostgreSQL package subpath is incomplete");
}
const importPath = resolve(root, subpath.import);
const typesPath = resolve(root, subpath.types);
await Promise.all([access(importPath), access(typesPath)]);
const api = await import(pathToFileURL(importPath).href);
const exports = Object.keys(api).sort();
if (
  exports.length !== 1
  || exports[0] !== "createPostgreSqlStorageBackendFactory"
  || typeof api.createPostgreSqlStorageBackendFactory !== "function"
) {
  throw new Error(`unexpected PostgreSQL package exports: ${exports.join(", ")}`);
}
