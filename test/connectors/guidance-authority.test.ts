import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const guidanceRoot = join(repositoryRoot, "src/connectors/templates/guidance");
const guidanceFiles = [
  "codex-rules.md.tmpl",
  "skill.md.tmpl",
  "rules.md.tmpl",
  "body.md",
  "operations.cli.md",
  "operations.mcp.md",
  "feedback.cli.md",
  "feedback.mcp.md",
  "memory-context.md.tmpl",
] as const;

const policyAnchors = [
  "Agents **MUST** immediately store every newly recognized durable decision, preference, root cause, pattern, gotcha, solution, and reusable workflow, including its rationale.",
  "Classify every durable store with exactly one `type:<classification>` tag",
  "Store durable knowledge immediately with its rationale and classification.",
  "memory-used feedback",
  "one feedback memory per used memory",
] as const;

const guidanceOnlyAnchors = [
  "type:<classification>",
  "scope:project",
  "signal:memory_used",
  "memory_id:<id>",
] as const;

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

describe("guidance prose authority", () => {
  it("keeps recurring durable-memory policy anchors in the Markdown sources", () => {
    expect(readdirSync(guidanceRoot).sort()).toEqual([...guidanceFiles].sort());
    const guidance = guidanceFiles.map((file) => readFileSync(join(guidanceRoot, file), "utf8")).join("\n");
    const production = productionTypeScriptFiles(join(repositoryRoot, "src"))
      .map((file) => ({ file, source: readFileSync(file, "utf8") }));

    for (const anchor of policyAnchors) {
      expect(guidance, `guidance source missing ${anchor}`).toContain(anchor);
      for (const entry of production) {
        expect(entry.source, `${entry.file} owns recurring guidance: ${anchor}`).not.toContain(anchor);
      }
    }
    for (const anchor of guidanceOnlyAnchors) expect(guidance).toContain(anchor);
  });
});
