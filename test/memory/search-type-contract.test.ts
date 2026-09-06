import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function compileSearchTypeFixture(): readonly ts.Diagnostic[] {
  const root = mkdtempSync(join(tmpdir(), "lcm-memory-search-type-contract-"));
  temporaryRoots.push(root);
  const fixture = join(root, "search-type-contract.ts");
  const sourcePath = resolve(process.cwd(), "src/memory/index.ts");
  const sourceModule = sourcePath.replace(/\.ts$/u, ".js");
  writeFileSync(fixture, `
import { createMemoryApi, memory } from ${JSON.stringify(sourceModule)};
import type { MemoryApi } from ${JSON.stringify(sourceModule)};

const client = { post: async () => ({ episodic: [], promoted: [] }), health: async () => ({}) } as never;
const created: MemoryApi = createMemoryApi(client);
const options: Parameters<MemoryApi["search"]>[1] = {
  limit: 3,
  threshold: 0.4,
  projectId: "project",
  layers: ["promoted"],
  cwd: "/tmp/project",
};

void created.search("query", options);
void memory.search("query", options);
void created.search("query");
void memory.search("query");
`);

  const config: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    types: ["node"],
    skipLibCheck: true,
    noEmit: true,
    strict: true,
  };
  const host = ts.createCompilerHost(config);
  const program = ts.createProgram([fixture], config, host);
  return ts.getPreEmitDiagnostics(program);
}

describe("MemoryApi search type contract", () => {
  it("accepts cwd with the existing search options for singleton and created APIs", () => {
    const diagnostics = compileSearchTypeFixture();
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
  });
});
