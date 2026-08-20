import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  generateContent,
  generateRulesContent,
  generateSkillContent,
  renderFeedback,
  renderGuidance,
  renderMemoryContext,
  renderTemplate,
} from "../../src/connectors/template-service.js";
import { LCM_MANAGED_SKILL_MARKER, LCM_MARKERS } from "../../src/connectors/constants.js";
import { findAgent } from "../../src/connectors/registry.js";
import type { Agent } from "../../src/connectors/types.js";

const mockAgent: Agent = {
  id: "test-agent",
  name: "Test Agent",
  category: "cli",
  defaultTransport: "cli",
  capabilities: { cli: { guidance: ["rules"] } },
  configPaths: { rules: "TEST.md" },
  header: "---\ntrigger: always_on\n---",
};

const durableStorageRequirement =
  "Agents **MUST** immediately store every newly recognized durable decision, preference, root cause, pattern, gotcha, solution, and reusable workflow, including its rationale.";
const sourceFiles = [
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

describe("strict guidance renderer", () => {
  it("rejects unknown supplied keys, missing values, and unresolved placeholders", () => {
    expect(() => renderTemplate("{{known}}", { known: "ok", extra: "no" })).toThrow(
      "Unknown template key: extra",
    );
    expect(() => renderTemplate("{{known}}", {})).toThrow("Missing template value: known");
    expect(renderTemplate("{{known}}", { known: "{{still_unresolved}}" })).toBe(
      "{{still_unresolved}}",
    );
  });

  it("requires own string values and rejects malformed placeholder syntax", () => {
    const inherited = Object.create({ known: "inherited" }) as Record<string, string>;
    expect(() => renderTemplate("{{known}}", inherited)).toThrow("Missing template value: known");
    expect(() => renderTemplate("{{known}}", { known: undefined as unknown as string })).toThrow(
      "Missing template value: known",
    );
    for (const malformed of ["{{}}", "{{ known}}", "{{known }}", "{{k n}}", "{{known"]) {
      expect(() => renderTemplate(malformed, { known: "value" })).toThrow(/Malformed template placeholder/u);
    }
    expect(() => renderTemplate("{{known}} {{", { known: "value" })).toThrow(
      /Malformed template placeholder/u,
    );
  });

  it("renders each canonical source with no unresolved placeholders", () => {
    const templateRoot = join(process.cwd(), "src/connectors/templates/guidance");
    expect(readdirSync(templateRoot).sort()).toEqual([...sourceFiles].sort());
    for (const file of sourceFiles) {
      const source = readFileSync(join(templateRoot, file), "utf8");
      const values = Object.fromEntries(
        [...source.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu)].map((match) => [match[1], "value"]),
      );
      expect(renderTemplate(source, values)).not.toMatch(/\{\{[^}]+\}\}/u);
    }
  });

  it("keeps recurring prose in Markdown sources rather than TypeScript", () => {
    const implementation = readFileSync(
      new URL("../../src/connectors/template-service.ts", import.meta.url),
      "utf8",
    );
    expect(implementation).not.toContain("Agents **MUST** immediately store");
    expect(implementation).not.toContain("memory-used feedback");
  });
});

describe("transport-pure guidance", () => {
  it("renders only the minimal always-on memory rule for Codex", () => {
    const codex = findAgent("codex")!;

    expect(generateRulesContent(codex, "cli")).toBe(
      "<!-- lcm -->\n"
      + "**Before doing any kind of work**, inspection or simply project understanding, **use the $lcm-memory skill** to recover project memories.\n"
      + "<!-- lcm -->\n",
    );
  });

  it("renders deterministic, byte-idempotent CLI skill and rules", () => {
    const first = renderGuidance("skill", "cli");
    const second = renderGuidance("skill", "cli");
    expect(second).toBe(first);
    expect(first).toContain('description: "Agents **MUST** immediately store');
    expect(first).toContain(LCM_MANAGED_SKILL_MARKER);
    expect(first).toContain("## When to retrieve");
    expect(first).toContain("## When to store");
    expect(first).toContain("## When to skip");
    expect(first).toContain("## Retrieval workflow");
    expect(first).toContain("## Storage classification");
    expect(first.match(new RegExp(durableStorageRequirement.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))).toHaveLength(2);
    expect(first).toContain("lcm grep '<pattern>' --mode regex");
    expect(first).toContain("Prefer single quotes");
    expect(first).toContain("lcm doctor --help");
    expect(first).not.toMatch(/lcm_(?:search|grep|describe|expand|store|doctor)/u);
    expect(first.match(/^description: .*$/mu)?.[0]).toBe(
      'description: "Agents **MUST** immediately store every newly recognized durable decision, preference, root cause, pattern, gotcha, solution, and reusable workflow, including its rationale."',
    );
    const whenToStore = first.match(/## When to store\n\n([\s\S]*?)(?=\n## |$)/u)?.[1] ?? "";
    expect(whenToStore.match(new RegExp(durableStorageRequirement.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))).toHaveLength(1);
    const searchExplanation = first.match(/## When to retrieve\n\n([\s\S]*?)(?=\n### CLI operations)/u)?.[1] ?? "";
    const captureWording = first.match(/[^\n]*(?:automatic|passive)[^\n]*/giu) ?? [];
    expect(captureWording).toHaveLength(1);
    expect(searchExplanation).toContain(captureWording[0]);
    for (const prohibited of ["Advanced Operations", "only on demand", "lcm import", "lcm diagnose", "lcm stats", "lcm_stats", "restart loop", "serialization", "availability fallback"]) {
      expect(first.toLowerCase()).not.toContain(prohibited.toLowerCase());
    }
  });

  it("renders deterministic, MCP-only skill and rules", () => {
    const skill = renderGuidance("skill", "mcp");
    const rules = renderGuidance("rules", "mcp");
    expect(skill).toBe(renderGuidance("skill", "mcp"));
    expect(skill).toContain("lcm_search");
    expect(skill).toContain("lcm_grep");
    expect(skill).toContain("lcm_describe");
    expect(skill).toContain("lcm_expand");
    expect(skill).toContain("lcm_store");
    expect(skill).toContain("lcm_doctor");
    expect(skill).not.toMatch(/\blcm\s+(?:search|grep|describe|expand|store|doctor)\b/iu);
    expect(skill).not.toMatch(/\bregex\b|\blayers\b/iu);
    expect(skill).toContain(
      "exactly one `type:<classification>` tag, literal `scope:project` or `scope:user`, `project:<repo>`, and optional `source:<actual-thread-uuid>`",
    );
    expect(skill).toContain("literal `scope:project` or `scope:user`, `project:<repo>`");
    expect(rules).toContain("# Workflow Instruction");
    expect(rules.slice(rules.indexOf(LCM_MARKERS.START))).toMatch(
      /^<!-- lcm -->\n# Workflow Instruction/u,
    );
    const cli = renderGuidance("skill", "cli");
    const classificationMapping = "`type:<classification>` uses one of `decision`, `preference`, `root-cause`, `pattern`, `gotcha`, `solution`, or `workflow`; `workflow` is a reusable procedure and `solution` is a concrete fix or answer";
    expect(cli).toContain(classificationMapping);
    expect(skill).toContain(classificationMapping);
    const readOnlyBoundary = "Read-only work still performs required LCM retrieval and durable storage unless the user explicitly forbids memory access or storage; LCM memory operations do not modify project files, Git, host configuration, or services.";
    expect(cli).toContain(readOnlyBoundary);
    expect(skill).toContain(readOnlyBoundary);
  });

  it("uses the exact memory header and emits feedback only for actual IDs", () => {
    expect(renderMemoryContext("cli", "", [])).toBe("");
    expect(renderMemoryContext("mcp", "", ["memory-1"])).toBe("");
    expect(renderMemoryContext("mcp", "- surfaced memory", ["memory-1"])).toContain(
      "Relevant context from previous sessions:",
    );
    expect(renderFeedback("cli", [])).toBe("");
    expect(renderFeedback("cli", ["memory-1", "memory-2"])).toContain(
      "one feedback memory per used memory",
    );
    expect(renderFeedback("cli", ["memory-1"])).toContain("memory_id:<id>");
    expect(renderFeedback("cli", ["memory-1", "memory-2"])).toBe(
      renderFeedback("cli", ["memory-1"]),
    );
    expect(renderFeedback("cli", ["memory-1"], { repository: "real-repo", threadId: "real-thread" })).toBe(
      renderFeedback("cli", ["memory-1"], { repository: "other-repo", threadId: "other-thread" }),
    );
    expect(renderFeedback("cli", ["memory-1"])).toContain("project:<repo>");
    expect(renderFeedback("cli", ["memory-1"])).toContain("source:<actual-thread-uuid>");
    expect(renderFeedback("mcp", ["memory-1"])).toContain("lcm_store");
    expect(renderFeedback("mcp", ["memory-1"])).not.toContain("lcm store");
    expect(renderFeedback("cli", ["memory-1"])).not.toContain("lcm_store");
    for (const tag of ["type:feedback", "scope:project", "project:<repo>", "source:<actual-thread-uuid>", "signal:memory_used", "memory_id:<id>"]) {
      expect(renderFeedback("cli", ["memory-1"])).toContain(tag);
      expect(renderFeedback("mcp", ["memory-1"])).toContain(tag);
    }
    const sourceGuidance = "Use `source:<actual-thread-uuid>` with the real UUID when available; omit that source tag when unavailable.";
    expect(renderFeedback("cli", ["memory-1"])).toContain(sourceGuidance);
    expect(renderFeedback("mcp", ["memory-1"])).toContain(sourceGuidance);
  });

  it("keeps balanced and unclosed braces in injected memory inert", () => {
    expect(renderMemoryContext("cli", "memory with {{name}}", [])).toContain(
      "memory with {{name}}",
    );
    expect(renderMemoryContext("cli", "memory with {{", [])).toContain("memory with {{");
  });

  it("renders the optional CLI source tag when a thread id is supplied", () => {
    const rules = renderGuidance("rules", "cli", { threadId: "thread-123" });

    expect(rules).toContain("--tag 'source:thread-123'");
  });
});

describe("legacy compatibility seams", () => {
  it("selects a transport while keeping the old default CLI call deterministic", () => {
    expect(generateSkillContent(mockAgent)).toBe(renderGuidance("skill", "cli"));
    expect(generateRulesContent(mockAgent)).toBe(renderGuidance("rules", "cli", mockAgent.header));
    expect(generateContent(mockAgent, "rules")).toBe(generateRulesContent(mockAgent));
    expect(generateContent(mockAgent, "skill")).toBe(generateSkillContent(mockAgent));
  });

  it("rejects hook content because hooks are managed by the structured installer", () => {
    expect(() => generateContent(mockAgent, "hook" as never)).toThrow(
      "Hook connectors are managed by the structured connector installer",
    );
  });
});
