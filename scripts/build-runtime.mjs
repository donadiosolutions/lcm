import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist", "lcm.mjs");

await mkdir(dirname(output), { recursive: true });
await build({
  entryPoints: [join(root, "dist", "bin", "lcm.js")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  charset: "utf8",
  legalComments: "none",
  sourcemap: false,
  treeShaking: true,
  minifyWhitespace: true,
  banner: {
    js: 'import { createRequire as __lcmCreateRequire } from "node:module"; const require = __lcmCreateRequire(import.meta.url);',
  },
});
const generated = await readFile(output, "utf8");
if (!generated.startsWith("#!/usr/bin/env node\n")) {
  throw new Error("Generated runtime is missing the Node.js shebang");
}
await chmod(output, 0o755);
