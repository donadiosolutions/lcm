import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import fastUri from "fast-uri";
import pkg from "../package.json";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function npmPackInventory(): string[] {
  const transcriptRuntime = resolve(
    repositoryRoot,
    "dist/src/storage/native-transcripts.js",
  );
  if (!existsSync(transcriptRuntime)) {
    execFileSync("npm", ["run", "build"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  const output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const metadata = JSON.parse(output) as Array<{
    files?: Array<{ path?: unknown }>;
  }>;
  expect(metadata).toHaveLength(1);
  return (metadata[0]?.files ?? []).flatMap((entry) =>
    typeof entry.path === "string" ? [entry.path] : [],
  );
}

describe("package.json", () => {
  it("has correct name", () => expect(pkg.name).toBe("@donadiosolutions/lcm"));
  it("uses the generated npm runtime as its executable", () => {
    expect(pkg.bin).toHaveProperty("lcm", "dist/lcm.mjs");
  });
  it("publishes the staged native-transcript API and its declarations", () => {
    expect(pkg.exports).toHaveProperty("./storage/native-transcripts", {
      types: "./dist/src/storage/native-transcripts.d.ts",
      import: "./dist/src/storage/native-transcripts.js",
    });
    expect(pkg.scripts).toHaveProperty(
      "verify:native-transcript-package",
      "node scripts/verify-native-transcript-package.mjs && tsc --project tsconfig.native-transcript-package.json",
    );
    expect(pkg.scripts.postbuild).toContain(
      "npm run verify:native-transcript-package",
    );
  });
  it("has anthropic sdk as optional peer dep", () => expect(pkg.peerDependencies).toHaveProperty("@anthropic-ai/sdk"));
  it("keeps the bundled MCP build graph out of published consumer dependencies", () => {
    expect(pkg.dependencies).not.toHaveProperty("@modelcontextprotocol/sdk");
    expect(pkg.dependencies).not.toHaveProperty("body-parser");
    expect(pkg.dependencies).not.toHaveProperty("fast-uri");
    expect(pkg.devDependencies).toHaveProperty("@modelcontextprotocol/sdk", "1.30.0");
    expect(pkg.devDependencies).toHaveProperty("body-parser", "2.3.0");
    expect(pkg.devDependencies).toHaveProperty("fast-uri", "3.1.5");
    expect(pkg.dependencies).toHaveProperty("@hono/node-server", "2.0.12");
    expect(pkg.scripts).toHaveProperty(
      "verify:consumer-topology",
      "node scripts/verify-consumer-topology.mjs",
    );
    expect(pkg.scripts["release:verify"]).toContain("npm run verify:consumer-topology");
  });
  it("rejects ambiguous URI authorities before Node URL consumers", () => {
    const base = "https://allowed.example/";
    const backslash = String.fromCharCode(92);
    const hostileReferences = [
      `${backslash}${backslash}evil.example/path`,
      `/${backslash}evil.example/path`,
      `${backslash}/evil.example/path`,
    ];
    const legitimateReference = "/safe/path";

    for (const hostileReference of hostileReferences) {
      expect(() => fastUri.resolve(base, hostileReference)).toThrow(
        "URI authority must not contain a literal backslash.",
      );
    }
    expect(fastUri.resolve(base, legitimateReference)).toBe(
      new URL(legitimateReference, base).href,
    );
  });
  it("does not have pi-ai", () => expect(pkg.dependencies).not.toHaveProperty("@mariozechner/pi-ai"));
  it("does not have pi-agent-core", () => expect(pkg.dependencies).not.toHaveProperty("@mariozechner/pi-agent-core"));

  it("does not use prepack (breaks npm install from git without node_modules)", () => {
    expect(pkg.scripts).not.toHaveProperty("prepack");
  });

  it("uses prepublishOnly for build (only runs during npm publish)", () => {
    expect(pkg.scripts).toHaveProperty("prepublishOnly", "npm run build");
  });

  it("uses exact, reproducible runtime bundle tooling", () => {
    expect(pkg.devDependencies.esbuild).toBe("0.28.1");
    expect(pkg.scripts).toHaveProperty("build:runtime", "node scripts/build-runtime.mjs");
    expect(pkg.scripts).not.toHaveProperty("check:plugin-bundles");
  });

  it("ships acknowledgments and npm-owned assets without Marketplace files", () => {
    expect(pkg.files).toContain("dist/");
    expect(pkg.files).toContain("ACKNOWLEDGMENTS.md");
    expect(pkg.files).not.toContain("lcm.mjs");
    expect(pkg.files).not.toContain("mcp.mjs");
    expect(pkg.files).not.toContain(".claude-plugin/");
  });

  it("packs native transcript exports without Rust or restart-helper artifacts", () => {
    const paths = npmPackInventory();
    expect(paths).toEqual(
      expect.arrayContaining([
        "dist/src/storage/native-transcripts.d.ts",
        "dist/src/storage/native-transcripts.js",
        "docs/postgresql-native-transcripts.md",
      ]),
    );

    const forbiddenArtifacts = paths.filter((path) =>
      /(^|\/)(?:native|target|rust)(?:\/|$)/iu.test(path)
      || /(?:cargo|rustc|daemon-restart-helper|native-helper)/iu.test(path)
      || /\.(?:rs|rlib|a|dylib|so|exe)$/iu.test(path),
    );
    expect(forbiddenArtifacts).toEqual([]);
  });

  it("generates only the dist runtime bundle", () => {
    const source = readFileSync(new URL("../scripts/build-runtime.mjs", import.meta.url), "utf8");
    expect(source).toContain('join(root, "dist", "lcm.mjs")');
    expect(source).not.toContain('join(root, "lcm.mjs")');
    expect(source).not.toContain("mcp.mjs");
    expect(source).toContain("bundle: true");
    expect(source).not.toMatch(/\bexternal\s*:/u);
    expect(source).toContain('startsWith("#!/usr/bin/env node\\n")');
    expect(source).toContain("chmod(output, 0o755)");
  });

  it("pins every direct dependency and development dependency exactly", () => {
    for (const dependencies of [pkg.dependencies, pkg.devDependencies]) {
      for (const version of Object.values(dependencies)) {
        expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
      }
    }
  });
});
