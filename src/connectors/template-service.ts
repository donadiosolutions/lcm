import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ConnectorType } from "./types.js";
import { LCM_MARKERS } from "./constants.js";
import { packageAsset, packageRootFor } from "../runtime-root.js";

const TEMPLATES_DIR = packageAsset(
  import.meta.url,
  packageRootFor(import.meta.url, 3),
  "dist/src/connectors/templates",
  "src/connectors/templates",
);

function loadFile(path: string): string {
  return readFileSync(join(TEMPLATES_DIR, path), "utf-8");
}

function substituteVariables(template: string, context: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(context)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function wrapWithMarkers(content: string, header?: string): string {
  const parts: string[] = [];
  if (header) parts.push(header);
  parts.push(LCM_MARKERS.START);
  parts.push(content.trim());
  parts.push(LCM_MARKERS.END);
  return parts.join('\n');
}

export function generateRulesContent(agent: Agent): string {
  const workflow = loadFile("sections/workflow.md");
  const commandRef = loadFile("sections/command-reference.md");
  const base = loadFile("base.md");
  const content = substituteVariables(base, {
    workflow: substituteVariables(workflow, { command_reference: commandRef }),
  });
  return wrapWithMarkers(content, agent.header);
}

export function generateMcpContent(agent: Agent): string {
  const mcpWorkflow = loadFile("sections/mcp-workflow.md");
  const base = loadFile("mcp-base.md");
  const content = substituteVariables(base, { mcp_workflow: mcpWorkflow });
  return wrapWithMarkers(content, agent.header);
}

export function generateSkillContent(_agent: Agent): string {
  return loadFile("skill/SKILL.md"); // Skills don't need markers — they're standalone files
}

export function generateContent(agent: Agent, type: ConnectorType): string {
  switch (type) {
    case 'rules': return generateRulesContent(agent);
    case 'mcp': return generateMcpContent(agent);
    case 'skill': return generateSkillContent(agent);
    case 'hook': throw new Error('Hook connectors are managed by the structured connector installer, not the template service');
  }
}
