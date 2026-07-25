import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const path = "package-lock.json";
const input = readFileSync(path, "utf8");
const patterns = [
  /("version":\s*")([^"]+)(")/,
  /("packages":\s*\{\s*"":\s*\{\s*"name":\s*"@donadiosolutions\/lcm",\s*"version":\s*")([^"]+)(")/,
];

let output = input;
for (const pattern of patterns) {
  if (!pattern.test(output)) {
    throw new Error(`No package version field matched in ${path}`);
  }
  output = output.replace(pattern, `$1${version}$3`);
}
writeFileSync(path, output);
