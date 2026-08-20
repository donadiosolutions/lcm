import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ConnectorSurface, ConnectorTransport } from "./types.js";
import { LCM_MANAGED_SKILL_MARKER, LCM_MARKERS } from "./constants.js";
import { packageAsset, packageRootFor } from "../runtime-root.js";

const TEMPLATES_DIR = packageAsset(
  import.meta.url,
  packageRootFor(import.meta.url, 3),
  "dist/src/connectors/templates",
  "src/connectors/templates",
);
const GUIDANCE_DIR = join(TEMPLATES_DIR, "guidance");

export type GuidanceKind = "skill" | "rules";

export interface GuidanceRenderOptions {
  readonly repository?: string;
  readonly threadId?: string;
}

function loadGuidanceFile(name: string): string {
  return readFileSync(join(GUIDANCE_DIR, name), "utf-8");
}

const VALID_PLACEHOLDER = /^\{\{[A-Za-z][A-Za-z0-9_]*\}\}$/u;

function assertTemplateSyntax(template: string): void {
  const openings = /\{\{/gu;
  for (const opening of template.matchAll(openings)) {
    const start = opening.index!;
    const end = template.indexOf("}}", start + 2);
    if (end < 0) throw new Error(`Malformed template placeholder: ${template.slice(start)}`);
    const candidate = template.slice(start, end + 2);
    if (!VALID_PLACEHOLDER.test(candidate)) {
      throw new Error(`Malformed template placeholder: ${candidate}`);
    }
    openings.lastIndex = end + 2;
  }
}

function templateKeys(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu)].map(
    (match) => match[1]!,
  );
}

/** Render a guidance source with a closed, fail-fast placeholder contract. */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  assertTemplateSyntax(template);
  const keys = templateKeys(template);
  const expected = new Set(keys);
  for (const key of Object.keys(values)) {
    if (!expected.has(key)) throw new Error(`Unknown template key: ${key}`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(values, key) || typeof values[key] !== "string") {
      throw new Error(`Missing template value: ${key}`);
    }
  }

  const rendered = template.replace(
    /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu,
    (_match, key: string) => values[key]!,
  );
  return rendered;
}

function renderOperations(transport: ConnectorTransport, options: GuidanceRenderOptions): string {
  const source = loadGuidanceFile(transport === "cli" ? "operations.cli.md" : "operations.mcp.md");
  const sourceTag = options.threadId === undefined ? "" : ` --tag 'source:${options.threadId}'`;
  return transport === "cli" ? renderTemplate(source, { sourceTag }) : renderTemplate(source, {});
}

/** Render the conditional feedback block. Empty IDs produce no prose. */
export function renderFeedback(
  transport: ConnectorTransport,
  memoryIds: readonly string[],
  options: GuidanceRenderOptions = {},
): string {
  if (memoryIds.length === 0) return "";
  const template = loadGuidanceFile(transport === "cli" ? "feedback.cli.md" : "feedback.mcp.md");
  void options;
  return renderTemplate(template, {}).trim();
}

/** Render injected context and its single conditional feedback section. */
export function renderMemoryContext(
  transport: ConnectorTransport,
  context: string,
  memoryIds: readonly string[],
  options: GuidanceRenderOptions = {},
): string {
  if (context.trim().length === 0) return "";
  return renderTemplate(loadGuidanceFile("memory-context.md.tmpl"), {
    context,
    feedback: renderFeedback(transport, memoryIds, options),
  }).trim();
}

function renderBody(transport: ConnectorTransport, options: GuidanceRenderOptions): string {
  return renderTemplate(loadGuidanceFile("body.md"), {
    operations: renderOperations(transport, options),
    feedback: "",
  }).trim();
}

function renderCodexRules(): string {
  return renderTemplate(loadGuidanceFile("codex-rules.md.tmpl"), {
    marker: LCM_MARKERS.START,
    endMarker: LCM_MARKERS.END,
  }).trimEnd() + "\n";
}

/** Render canonical guidance for the selected transport. */
export function renderGuidance(
  kind: GuidanceKind,
  transport: ConnectorTransport,
  headerOrOptions: string | GuidanceRenderOptions = {},
): string {
  const options = typeof headerOrOptions === "string" ? {} : headerOrOptions;
  const body = renderBody(transport, options);
  if (kind === "skill") {
    return renderTemplate(loadGuidanceFile("skill.md.tmpl"), {
      marker: LCM_MANAGED_SKILL_MARKER,
      body: renderBody(transport, options),
    }).trimEnd() + "\n";
  }
  const header = typeof headerOrOptions === "string" ? headerOrOptions : "";
  return renderTemplate(loadGuidanceFile("rules.md.tmpl"), {
    header: header.length > 0 ? `${header}\n` : "",
    marker: LCM_MARKERS.START,
    body,
    endMarker: LCM_MARKERS.END,
  }).trimEnd() + "\n";
}

export function generateRulesContent(agent: Agent, transport: ConnectorTransport = "cli"): string {
  if (agent.id === "codex") return renderCodexRules();
  return renderGuidance("rules", transport, agent.header);
}

export function generateSkillContent(agent: Agent, transport: ConnectorTransport = "cli"): string {
  void agent;
  return renderGuidance("skill", transport);
}

export function generateContent(
  agent: Agent,
  type: Exclude<ConnectorSurface, "mcp">,
  transport: ConnectorTransport = "cli",
): string {
  switch (type) {
    case "rules": return generateRulesContent(agent, transport);
    case "skill": return generateSkillContent(agent, transport);
    case "hook": throw new Error("Hook connectors are managed by the structured connector installer, not the template service");
  }
}
