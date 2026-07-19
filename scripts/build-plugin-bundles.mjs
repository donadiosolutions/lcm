import { build } from "esbuild";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const tempDir = await mkdtemp(join(tmpdir(), "lcm-plugin-bundles-"));

const bundles = [
  { entry: join(root, "dist", "bin", "lcm.js"), output: join(root, "lcm.mjs") },
  { entry: join(root, "scripts", "plugin-mcp-entry.mjs"), output: join(root, "mcp.mjs") },
];

try {
  for (const bundle of bundles) {
    const candidate = join(tempDir, basename(bundle.output));
    await build({
      entryPoints: [bundle.entry],
      outfile: candidate,
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
    const generated = Buffer.from((await readFile(candidate, "utf8")).replace(/[ \t]+$/gm, ""));
    if (check) {
      let committed;
      try {
        committed = await readFile(bundle.output);
      } catch {
        committed = Buffer.alloc(0);
      }
      if (!generated.equals(committed)) {
        throw new Error(`${basename(bundle.output)} is stale; run npm run build`);
      }
    } else {
      const staged = `${bundle.output}.new`;
      await writeFile(staged, generated, { mode: 0o755 });
      await rename(staged, bundle.output);
    }
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
