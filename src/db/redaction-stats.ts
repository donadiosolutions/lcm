import type { DatabaseSync } from "node:sqlite";
import type { RedactionCounts } from "../storage/contracts.js";

const REDACTION_CATEGORIES = [
  ["gitleaks", "gitleaks"],
  ["builtIn", "built_in"],
  ["global", "global"],
  ["project", "project"],
] as const;

export function validateRedactionCounts(counts: RedactionCounts): RedactionCounts {
  const normalized = { ...counts };
  for (const [field] of REDACTION_CATEGORIES) {
    if (!Number.isSafeInteger(normalized[field]) || normalized[field] < 0) {
      throw new TypeError(`${field} count must be a nonnegative safe integer`);
    }
  }
  return normalized;
}

export function upsertRedactionCounts(
  db: DatabaseSync,
  projectId: string,
  counts: RedactionCounts,
): void {
  const normalized = validateRedactionCounts(counts);
  if (
    normalized.gitleaks === 0
    && normalized.builtIn === 0
    && normalized.global === 0
    && normalized.project === 0
  ) return;
  const current = getRedactionCounts(db, projectId);
  const next = validateRedactionCounts({
    gitleaks: current.gitleaks + normalized.gitleaks,
    builtIn: current.builtIn + normalized.builtIn,
    global: current.global + normalized.global,
    project: current.project + normalized.project,
  });
  redactionTotal(next);
  const upsert = db.prepare(`
    INSERT INTO redaction_stats (project_id, category, count)
    VALUES (?, ?, ?)
    ON CONFLICT(project_id, category) DO UPDATE SET count = count + excluded.count
  `);
  for (const [field, category] of REDACTION_CATEGORIES) {
    if (normalized[field] > 0) {
      upsert.run(projectId, category, normalized[field]);
    }
  }
}

function redactionTotal(counts: RedactionCounts): number {
  const total = counts.gitleaks
    + counts.builtIn
    + counts.global
    + counts.project;
  if (!Number.isSafeInteger(total)) {
    throw new TypeError("total count must be a nonnegative safe integer");
  }
  return total;
}

export function getRedactionCounts(
  db: DatabaseSync,
  projectId: string,
): RedactionCounts & { total: number } {
  const rows = db.prepare(
    `SELECT category, count
     FROM redaction_stats
     WHERE project_id = ?`,
  ).all(projectId) as Array<{ category: string; count: number }>;
  const counts: RedactionCounts = {
    gitleaks: 0,
    builtIn: 0,
    global: 0,
    project: 0,
  };
  for (const [field, category] of REDACTION_CATEGORIES) {
    const row = rows.find((candidate) => candidate.category === category);
    if (row) counts[field] = row.count;
  }
  const normalized = validateRedactionCounts(counts);
  const total = redactionTotal(normalized);
  return {
    ...normalized,
    total,
  };
}
