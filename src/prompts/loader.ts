import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { packageAsset, packageRootFor } from "../runtime-root.js";

const PROMPTS_DIR = packageAsset(
  import.meta.url,
  packageRootFor(import.meta.url, 3),
  "dist/src/prompts",
  "src/prompts",
);

export type PromptTemplate = {
  name: string;
  description: string;
  variables: string[];
  template: string;
};

const cache = new Map<string, PromptTemplate>();

export function loadTemplate(name: string): PromptTemplate {
  if (name.includes("/") || name.includes("..") || name.includes("\0")) {
    throw new Error(`Invalid template name: ${name}`);
  }

  const cached = cache.get(name);
  if (cached) return cached;

  const filePath = join(PROMPTS_DIR, `${name}.yaml`);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`Prompt template not found: ${name} (looked at ${filePath})`);
  }

  const parsed = load(raw) as PromptTemplate;
  if (!parsed || typeof parsed.template !== "string") {
    throw new Error(`Invalid prompt template: ${name} — missing 'template' field`);
  }

  cache.set(name, parsed);
  return parsed;
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

export function renderTemplate(name: string, vars: Record<string, string>): string {
  const tpl = loadTemplate(name);
  return interpolate(tpl.template, vars);
}
