import { DatabaseSync } from "node:sqlite";
import type { SearchResult } from "./promoted.js";
import type { PromotedRecallSearchResult } from "../storage/contracts.js";

const BATCH_SIZE = 256;
const invalidEvidence = (): never => { throw new TypeError("invalid promoted recall evidence"); };

/** Tokenize only query text. This owned ephemeral database never contains memory data. */
function nativeRepresentatives(surfaces: string[]): string[] {
  const tokenizer = new DatabaseSync(":memory:");
  try {
    tokenizer.exec("CREATE VIRTUAL TABLE tokens USING fts5(surface, tokenize='porter unicode61'); CREATE VIRTUAL TABLE vocabulary USING fts5vocab(tokens, 'instance')");
    tokenizer.exec("BEGIN");
    for (let offset = 0; offset < surfaces.length; offset += BATCH_SIZE) {
      const batch = surfaces.slice(offset, offset + BATCH_SIZE);
      tokenizer.prepare(`INSERT INTO tokens(rowid, surface) VALUES ${batch.map(() => "(?, ?)").join(",")}`)
        .run(...batch.flatMap((surface, index) => [offset + index + 1, surface]));
    }
    tokenizer.exec("COMMIT");
    const sequences = surfaces.map((): string[] => []);
    const rows = tokenizer.prepare("SELECT term, doc, offset FROM vocabulary ORDER BY doc, offset").all();
    for (const row of rows) {
      if (typeof row.doc !== "number" || !Number.isSafeInteger(row.doc)
        || row.doc < 1 || row.doc > surfaces.length
        || typeof row.offset !== "number" || !Number.isSafeInteger(row.offset)
        || typeof row.term !== "string" || row.term.length === 0) invalidEvidence();
      const sequence = sequences[(row.doc as number) - 1];
      if (row.offset !== sequence.length) invalidEvidence();
      sequence.push(row.term as string);
    }
    const seen = new Set<string>();
    return surfaces.filter((surface, index) => {
      const sequence = sequences[index];
      if (sequence.length === 0) {
        if (/[a-z0-9]/.test(surface)) invalidEvidence();
        return false;
      }
      const key = JSON.stringify(sequence);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } finally {
    tokenizer.close();
  }
}

function fallbackMatch(column: string): string {
  return `(LOWER(${column}) = terms.term
    OR LOWER(${column}) GLOB terms.term || '[^a-z0-9_]*'
    OR LOWER(${column}) GLOB '*[^a-z0-9_]' || terms.term
    OR LOWER(${column}) GLOB '*[^a-z0-9_]' || terms.term || '[^a-z0-9_]*')`;
}

/** The caller holds the selection's read snapshot throughout every evidence batch. */
export function collectPromotedRecallEvidence(
  db: DatabaseSync,
  selected: SearchResult[],
  query: string,
  fts5Available: boolean,
): PromotedRecallSearchResult {
  if (selected.length === 0) return { candidates: [] };
  const uniqueSurfaces = new Set<string>();
  for (const match of query.matchAll(/\w+/g)) uniqueSurfaces.add(match[0].toLowerCase());
  const surfaces = [...uniqueSurfaces];
  const terms = fts5Available ? nativeRepresentatives(surfaces).map((term) => `"${term}"`) : surfaces;
  const counts = selected.map(() => 0);
  const predicate = fts5Available
    ? "EXISTS (SELECT 1 FROM promoted_fts WHERE promoted_fts.rowid = p.rowid AND promoted_fts MATCH terms.term)"
    : `(${fallbackMatch("p.content")} OR ${fallbackMatch("p.tags")})`;
  for (let termOffset = 0; termOffset < terms.length; termOffset += BATCH_SIZE) {
    const termBatch = terms.slice(termOffset, termOffset + BATCH_SIZE);
    for (let idOffset = 0; idOffset < selected.length; idOffset += BATCH_SIZE) {
      const idBatch = selected.slice(idOffset, idOffset + BATCH_SIZE);
      const rows = db.prepare(`WITH terms(term) AS (VALUES ${termBatch.map(() => "(?)").join(",")}),
        selected(ordinal, id) AS (VALUES ${idBatch.map(() => "(?, ?)").join(",")})
        SELECT p.id, selected.ordinal,
          (SELECT count(*) FROM terms WHERE ${predicate}) AS matched_terms
        FROM selected JOIN promoted AS p ON p.id = selected.id
        WHERE p.archived_at IS NULL ORDER BY selected.ordinal`)
        .all(...termBatch, ...idBatch.flatMap((result, index) => [idOffset + index, result.id]));
      if (rows.length !== idBatch.length) invalidEvidence();
      rows.forEach((row, index) => {
        const ordinal = idOffset + index;
        const count = row.matched_terms;
        if (row.id !== idBatch[index].id || row.ordinal !== ordinal
          || typeof count !== "number" || !Number.isSafeInteger(count)
          || count < 0 || count > termBatch.length) invalidEvidence();
        counts[ordinal] += count as number;
      });
    }
  }
  return { candidates: selected.map((result, index) => ({
    result,
    evidence: { queryTermCount: terms.length, matchedTermCount: counts[index] },
  })) };
}
