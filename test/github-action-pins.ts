import { load as loadYaml } from "js-yaml";

export interface ActionReference {
  comment?: string;
  kind: "external" | "invalid-local" | "local" | "unsupported";
  line: number;
  repository?: string;
  sha?: string;
  source: string;
  target: string;
}

const externalAction = /^(?<repository>[^/@\s]+\/[^/@\s]+)(?:\/[^@\s]+)?@(?<sha>\S+)$/u;
const usesLine = /^\s*(?:-\s+)?uses:\s*(?<target>[^\s#]+)(?:\s+#\s*(?<comment>.*?))?\s*$/u;

interface EffectiveUse {
  target: string;
}

function effectiveUses(value: unknown, uses: EffectiveUse[] = []): EffectiveUse[] {
  if (Array.isArray(value)) {
    for (const item of value) effectiveUses(item, uses);
    return uses;
  }
  if (!value || typeof value !== "object") return uses;

  for (const [key, child] of Object.entries(value)) {
    if (key === "uses") {
      uses.push({ target: typeof child === "string" ? child : String(child) });
      continue;
    }
    effectiveUses(child, uses);
  }
  return uses;
}

function sourceLine(source: string, target: string): number {
  const index = source.split(/\r?\n/u).findIndex((line) => line.includes(target));
  return index + 1;
}

function rawActionReferences(source: string, sourceName: string): ActionReference[] {
  return source.split(/\r?\n/u).flatMap((line, index) => {
    const match = usesLine.exec(line);
    if (!match?.groups) return [];

    const { target, comment } = match.groups;
    const lineNumber = index + 1;
    if (target.startsWith("./")) {
      return [{ comment, kind: "local" as const, line: lineNumber, source: sourceName, target }];
    }

    const external = externalAction.exec(target);
    if (!external?.groups) {
      return [{ comment, kind: "invalid-local" as const, line: lineNumber, source: sourceName, target }];
    }

    return [{
      comment,
      kind: "external" as const,
      line: lineNumber,
      repository: external.groups.repository,
      sha: external.groups.sha,
      source: sourceName,
      target,
    }];
  });
}

export function parseActionReferences(source: string, sourceName: string): ActionReference[] {
  const rawReferences = rawActionReferences(source, sourceName);
  const rawByTarget = new Map<string, ActionReference[]>();
  for (const reference of rawReferences) {
    const matching = rawByTarget.get(reference.target) ?? [];
    matching.push(reference);
    rawByTarget.set(reference.target, matching);
  }

  const references = effectiveUses(loadYaml(source)).map((effective) => {
    const raw = rawByTarget.get(effective.target)?.shift();
    if (raw) return raw;
    return {
      kind: "unsupported" as const,
      line: sourceLine(source, effective.target),
      source: sourceName,
      target: effective.target,
    };
  });

  for (const remaining of rawByTarget.values()) {
    for (const reference of remaining) {
      references.push({
        kind: "unsupported",
        line: reference.line,
        source: sourceName,
        target: reference.target,
      });
    }
  }
  return references;
}

function location(reference: ActionReference): string {
  return `${reference.source}:${reference.line}`;
}

export function assertApprovedActionReferences(
  references: readonly ActionReference[],
  approvedRepositories: ReadonlySet<string>,
): void {
  for (const reference of references) {
    if (reference.kind === "local") continue;
    if (reference.kind === "invalid-local") {
      throw new Error(`${location(reference)} local actions must begin with ./: ${reference.target}`);
    }
    if (reference.kind === "unsupported") {
      throw new Error(`${location(reference)} uses unsupported raw syntax: ${reference.target}`);
    }
    if (!reference.repository || !approvedRepositories.has(reference.repository)) {
      throw new Error(`${location(reference)} uses an unapproved action repository: ${reference.target}`);
    }
    if (!reference.sha || !/^[0-9a-f]{40}$/u.test(reference.sha)) {
      throw new Error(`${location(reference)} must use a lowercase 40-hex SHA: ${reference.target}`);
    }
    if (!reference.comment || !/^v\d/u.test(reference.comment)) {
      throw new Error(`${location(reference)} must include a version comment: ${reference.target}`);
    }
  }
}

export function assertActionPinCoherence(references: readonly ActionReference[]): void {
  const pins = new Map<string, ActionReference>();
  for (const reference of references) {
    if (reference.kind !== "external" || !reference.repository || !reference.sha) continue;
    const identity = `${reference.source}\u0000${reference.repository}`;
    const existing = pins.get(identity);
    if (existing && existing.sha !== reference.sha) {
      throw new Error(
        `${location(reference)} must use the same SHA as ${location(existing)} for ${reference.repository}`,
      );
    }
    pins.set(identity, reference);
  }
}
