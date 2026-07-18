import { existsSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function packageRootFor(moduleUrl: string, compiledParentLevels: number): string {
  const modulePath = fileURLToPath(moduleUrl);
  if (["lcm.mjs", "mcp.mjs"].includes(basename(modulePath))) return dirname(modulePath);
  const inDist = modulePath.split(sep).includes("dist");
  const parentLevels = inDist ? compiledParentLevels : compiledParentLevels - 1;
  let root = dirname(modulePath);
  for (let level = 0; level < parentLevels; level += 1) root = dirname(root);
  return root;
}

export function packageAsset(root: string, builtPath: string, sourcePath: string): string {
  const built = join(root, builtPath);
  return existsSync(built) ? built : join(root, sourcePath);
}

export function packageEntrypoint(moduleUrl: string, root: string, defaultPath: string): string {
  return ["lcm.mjs", "mcp.mjs"].includes(basename(fileURLToPath(moduleUrl)))
    ? join(root, "lcm.mjs")
    : defaultPath;
}
