import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf-8")).version;

function replaceVersion(path, pattern) {
  const input = readFileSync(path, "utf-8");
  if (!pattern.test(input)) {
    throw new Error(`No version field matched in ${path}`);
  }
  const output = input.replace(pattern, `$1${version}$3`);
  writeFileSync(path, output);
}

replaceVersion(".claude-plugin/plugin.json", /("version":\s*")([^"]+)(")/);
replaceVersion(".claude-plugin/marketplace.json", /("version":\s*")([^"]+)(")/);
replaceVersion("package-lock.json", /("version":\s*")([^"]+)(")/);
replaceVersion("package-lock.json", /("packages":\s*\{\s*"":\s*\{\s*"name":\s*"@donadiosolutions\/lcm",\s*"version":\s*")([^"]+)(")/);
