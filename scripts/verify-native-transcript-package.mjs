import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const subpath = packageJson.exports?.["./storage/native-transcripts"];
if (
  typeof subpath?.import !== "string"
  || typeof subpath.types !== "string"
) {
  throw new Error("native transcript package subpath is incomplete");
}
const importPath = resolve(root, subpath.import);
const typesPath = resolve(root, subpath.types);
await Promise.all([access(importPath), access(typesPath)]);
const api = await import(pathToFileURL(importPath).href);
for (const name of [
  "PostgreSqlNativeTranscriptRepository",
  "openLocalTranscriptQuarantine",
  "runNativeTranscriptBackfill",
]) {
  if (typeof api[name] !== "function") {
    throw new Error(`native transcript package export is missing ${name}`);
  }
}
