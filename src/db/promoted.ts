import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { JsonObject, JsonValue } from "../storage/contracts.js";

// A fresh one-term fallback match clears the default prompt-search minimum of
// two while still leaving room for recency, affinity, and feedback penalties.
const FALLBACK_TERM_SCORE = 4;

export type PromotedRow = {
  id: string;
  content: string;
  tags: string;
  metadata: string;
  source_summary_id: string | null;
  project_id: string;
  session_id: string | null;
  depth: number;
  confidence: number;
  created_at: string;
  archived_at: string | null;
};

export type InsertParams = {
  content: string;
  tags?: string[];
  metadata?: JsonObject;
  sourceSummaryId?: string;
  projectId: string;
  sessionId?: string;
  depth?: number;
  confidence?: number;
};

export type SearchResult = {
  id: string;
  content: string;
  tags: string[];
  projectId: string;
  sessionId: string | null;
  confidence: number;
  createdAt: string;
  /** Native ranks are negative; fallback ranks are positive. Larger absolute values are stronger. */
  rank: number;
};

export function parsePromotedTags(serialized: string): string[] {
  try {
    const parsed: unknown = JSON.parse(serialized);
    return Array.isArray(parsed) && parsed.every((tag) => typeof tag === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function validatedJsonString(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) throw new TypeError("metadata contains an unsupported string");
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        throw new TypeError("metadata contains an unsupported string");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("metadata contains an unsupported string");
    }
  }
  return value;
}

function promotedJsonValue(
  value: unknown,
  seen = new Set<object>(),
  depth = 1,
): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return validatedJsonString(value);
  if (typeof value === "number") {
    if (
      !Number.isFinite(value)
      || Object.is(value, -0)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new TypeError("metadata contains an unsupported number");
    }
    return value;
  }
  if (typeof value !== "object" || depth > 100 || seen.has(value)) {
    throw new TypeError("metadata must be finite acyclic JSON");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((element) =>
        promotedJsonValue(element, seen, depth + 1))) as JsonValue[];
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("metadata must be a JSON object");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("metadata must not contain symbol keys");
    }
    const normalized: Record<string, JsonValue> = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) {
        throw new TypeError("metadata must not contain accessors");
      }
      validatedJsonString(key);
      Object.defineProperty(normalized, key, {
        enumerable: true,
        value: promotedJsonValue(descriptor.value, seen, depth + 1),
      });
    }
    return Object.freeze(normalized);
  } finally {
    seen.delete(value);
  }
}

export function normalizePromotedMetadata(value: unknown): JsonObject {
  const candidate = promotedJsonValue(value);
  if (candidate === null || Array.isArray(candidate) || typeof candidate !== "object") {
    throw new TypeError("metadata must be a JSON object");
  }
  return candidate;
}

export function serializePromotedMetadata(value: unknown): string {
  return JSON.stringify(normalizePromotedMetadata(value));
}

export function parsePromotedMetadata(serialized: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new TypeError("stored promoted metadata is malformed");
  }
  return normalizePromotedMetadata(parsed);
}

export class PromotedStore {
  constructor(
    private db: DatabaseSync,
    private readonly fts5Available = true,
  ) {}

  insert(params: InsertParams): string {
    const id = randomUUID();
    if (params.tags && (!Array.isArray(params.tags) || !params.tags.every((tag) => typeof tag === "string"))) {
      throw new TypeError("tags must be an array of strings");
    }
    const tags = JSON.stringify(params.tags ?? []);
    const metadata = serializePromotedMetadata(params.metadata ?? {});

    const insertRow = (): void => {
      this.db.prepare(
        `INSERT INTO promoted (id, content, tags, metadata, source_summary_id, project_id, session_id, depth, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        params.content,
        tags,
        metadata,
        params.sourceSummaryId ?? null,
        params.projectId,
        params.sessionId ?? null,
        params.depth ?? 0,
        params.confidence ?? 1.0,
      );
    };

    if (!this.fts5Available) {
      insertRow();
      return id;
    }

    // Keep the authoritative row and its FTS mirror atomic, including when an
    // outer repository transaction already owns the connection.
    this.withFtsSavepoint(() => {
      insertRow();
      const row = this.db.prepare("SELECT rowid FROM promoted WHERE id = ?").get(id) as { rowid: number } | undefined;
      if (!row) throw new Error("inserted promoted row is unavailable");
      this.db.prepare(
        "INSERT INTO promoted_fts (rowid, content, tags) VALUES (?, ?, ?)"
      ).run(row.rowid, params.content, tags);
    });

    return id;
  }

  getById(id: string): PromotedRow | null {
    return (this.db.prepare("SELECT * FROM promoted WHERE id = ?").get(id) as PromotedRow) ?? null;
  }

  search(query: string, limit: number, filterTags?: string[], projectId?: string): SearchResult[] {
    const terms = query
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);

    if (terms.length === 0) return [];

    if (!this.fts5Available) {
      return this.searchWithoutFts(terms, limit, filterTags, projectId);
    }

    const sanitized = terms.map((term) => `"${term}"`).join(" OR ");

    const projectFilter = projectId ? "AND p.project_id = ?" : "";
    const queryParams: (string | number)[] = [sanitized];
    if (projectId) queryParams.push(projectId);
    queryParams.push(limit);

    const rows = this.db.prepare(
      `SELECT p.id, p.content, p.tags, p.project_id, p.session_id, p.confidence, p.created_at, rank
       FROM promoted_fts fts
       JOIN promoted p ON p.rowid = fts.rowid
       WHERE promoted_fts MATCH ?
         AND p.archived_at IS NULL
         ${projectFilter}
       ORDER BY rank, p.confidence DESC, p.created_at ASC
       LIMIT ?`
    ).all(...queryParams) as Array<PromotedRow & { rank: number }>;

    let results = rows.map((r) => ({
      id: r.id,
      content: r.content,
      tags: parsePromotedTags(r.tags),
      projectId: r.project_id,
      sessionId: r.session_id,
      confidence: r.confidence,
      createdAt: r.created_at,
      rank: r.rank,
    }));

    if (filterTags && filterTags.length > 0) {
      results = results.filter((r) => filterTags.every((t) => r.tags.includes(t)));
    }

    return results;
  }

  getAll(opts?: { projectId?: string; since?: string; tags?: string[] }): PromotedRow[] {
    let sql = "SELECT * FROM promoted WHERE archived_at IS NULL";
    const params: (string | number)[] = [];

    if (opts?.projectId !== undefined) {
      sql += " AND project_id = ?";
      params.push(opts.projectId);
    }
    if (opts?.since !== undefined) {
      sql += " AND julianday(created_at) >= julianday(?)";
      params.push(opts.since);
    }
    sql += " ORDER BY created_at ASC";

    let rows = this.db.prepare(sql).all(...params) as PromotedRow[];

    if (opts?.tags && opts.tags.length > 0) {
      rows = rows.filter((r) => {
        const rowTags = parsePromotedTags(r.tags);
        return opts.tags!.every((t) => rowTags.includes(t));
      });
    }

    return rows;
  }

  listContentPrefixes(limit: number): string[] {
    const rows = this.db.prepare(
      "SELECT content FROM promoted WHERE archived_at IS NULL LIMIT ?"
    ).all(limit) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  }

  archive(id: string): void {
    if (!this.fts5Available) {
      this.db.prepare("UPDATE promoted SET archived_at = datetime('now') WHERE id = ?").run(id);
      return;
    }
    this.withFtsSavepoint(() => {
      const row = this.db.prepare("SELECT rowid FROM promoted WHERE id = ?").get(id) as
        | { rowid: number }
        | undefined;
      this.db.prepare("UPDATE promoted SET archived_at = datetime('now') WHERE id = ?").run(id);
      if (row) this.db.prepare("DELETE FROM promoted_fts WHERE rowid = ?").run(row.rowid);
    });
  }

  deleteById(id: string): void {
    if (!this.fts5Available) {
      this.db.prepare("DELETE FROM promoted WHERE id = ?").run(id);
      return;
    }
    this.withFtsSavepoint(() => {
      const row = this.db.prepare("SELECT rowid FROM promoted WHERE id = ?").get(id) as
        | { rowid: number }
        | undefined;
      if (row) this.db.prepare("DELETE FROM promoted_fts WHERE rowid = ?").run(row.rowid);
      this.db.prepare("DELETE FROM promoted WHERE id = ?").run(id);
    });
  }

  update(id: string, fields: { content?: string; confidence?: number; tags?: string[]; metadata?: JsonObject }): void {
    const serializedMetadata = fields.metadata === undefined
      ? undefined
      : serializePromotedMetadata(fields.metadata);
    const row = this.db.prepare("SELECT rowid, content, tags FROM promoted WHERE id = ?").get(id) as
      | { rowid: number; content: string; tags: string }
      | undefined;
    if (!row) return;

    // One update can touch the authoritative row more than once and replace
    // its FTS mirror. Keep every field in one composable operation savepoint so
    // a late metadata failure cannot retain tags, confidence, or FTS changes.
    this.withFtsSavepoint(() => {
      if (fields.content !== undefined) {
        const newTags = fields.tags !== undefined ? JSON.stringify(fields.tags) : row.tags;
        this.db.prepare(
          "UPDATE promoted SET content = ?, confidence = COALESCE(?, confidence), tags = ?, metadata = COALESCE(?, metadata) WHERE id = ?"
        ).run(fields.content, fields.confidence ?? null, newTags, serializedMetadata ?? null, id);
        if (this.fts5Available) {
          this.db.prepare("DELETE FROM promoted_fts WHERE rowid = ?").run(row.rowid);
          this.db.prepare("INSERT INTO promoted_fts (rowid, content, tags) VALUES (?, ?, ?)").run(
            row.rowid,
            fields.content,
            newTags,
          );
        }
        return;
      }

      if (fields.confidence !== undefined) {
        this.db.prepare("UPDATE promoted SET confidence = ? WHERE id = ?").run(fields.confidence, id);
      }
      if (fields.tags !== undefined) {
        const newTags = JSON.stringify(fields.tags);
        this.db.prepare("UPDATE promoted SET tags = ? WHERE id = ?").run(newTags, id);
        if (this.fts5Available) {
            this.db.prepare("DELETE FROM promoted_fts WHERE rowid = ?").run(row.rowid);
            this.db.prepare("INSERT INTO promoted_fts (rowid, content, tags) VALUES (?, ?, ?)").run(
              row.rowid,
              row.content,
              newTags,
            );
        }
      }
      if (serializedMetadata !== undefined) {
        this.db.prepare("UPDATE promoted SET metadata = ? WHERE id = ?").run(
          serializedMetadata,
          id,
        );
      }
    });
  }

  private withFtsSavepoint(operation: () => void): void {
    this.db.exec("SAVEPOINT promoted_fts_sync");
    try {
      operation();
      this.db.exec("RELEASE SAVEPOINT promoted_fts_sync");
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT promoted_fts_sync");
      this.db.exec("RELEASE SAVEPOINT promoted_fts_sync");
      throw error;
    }
  }

  /**
   * Find promoted memories that are candidates for staleness review.
   * A memory is stale when it is old enough AND has not been acted upon recently.
   */
  findStale(opts: {
    staleAfterDays: number;
    staleSurfacingWithoutUseLimit: number;
    projectId?: string;
  }): Array<PromotedRow & { surfacingCount: number; usageCount: number; daysSinceCreated: number }> {
    const cutoffMs = Date.now() - opts.staleAfterDays * 24 * 60 * 60 * 1000;
    // Use SQLite datetime format (YYYY-MM-DD HH:MM:SS) to match created_at,
    // which is stored via datetime('now'). ISO-8601 with T/Z sorts incorrectly.
    const cutoff = new Date(cutoffMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");

    let sql = `SELECT * FROM promoted WHERE archived_at IS NULL AND created_at < ?`;
    const params: (string | number)[] = [cutoff];

    if (opts.projectId !== undefined) {
      sql += " AND project_id = ?";
      params.push(opts.projectId);
    }
    sql += " ORDER BY created_at ASC";

    const rows = this.db.prepare(sql).all(...params) as PromotedRow[];
    if (rows.length === 0) return [];

    // Batch: get surfacing counts for all candidate IDs in one query
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");

    const surfacingRows = this.db.prepare(
      `SELECT memory_id, COUNT(*) as count FROM recall_surfacing
       WHERE memory_id IN (${placeholders})
       GROUP BY memory_id`
    ).all(...ids) as Array<{ memory_id: string; count: number }>;
    const surfacingMap = new Map(surfacingRows.map((r) => [r.memory_id, r.count]));

    // Batch: count usage via signal:memory_used tags in one query

    const usageRows = this.db.prepare(
      `SELECT tags FROM promoted
       WHERE archived_at IS NULL
       AND tags LIKE '%"signal:memory_used"%'`
    ).all() as Array<{ tags: string }>;
    const usageMap = new Map<string, number>();
    for (const row of usageRows) {
      for (const id of ids) {
        if (row.tags.includes(`"memory_id:${id}"`)) {
          usageMap.set(id, (usageMap.get(id) ?? 0) + 1);
        }
      }
    }

    const result: Array<PromotedRow & { surfacingCount: number; usageCount: number; daysSinceCreated: number }> = [];

    for (const row of rows) {
      const surfacingCount = surfacingMap.get(row.id) ?? 0;
      const usageCount = usageMap.get(row.id) ?? 0;
      const daysSinceCreated = Math.floor((Date.now() - Date.parse(row.created_at)) / (24 * 60 * 60 * 1000));

      const surfacedWithoutUse = surfacingCount >= opts.staleSurfacingWithoutUseLimit && usageCount === 0;
      const purelyOld = surfacingCount === 0 && usageCount === 0;

      if (surfacedWithoutUse || purelyOld) {
        result.push({ ...row, surfacingCount, usageCount, daysSinceCreated });
      }
    }

    return result;
  }

  /** Revive a previously archived memory back to active status. */
  revive(id: string): void {
    const row = this.db.prepare("SELECT rowid, content, tags FROM promoted WHERE id = ?").get(id) as
      | { rowid: number; content: string; tags: string }
      | undefined;
    if (!row) return;

    if (!this.fts5Available) {
      this.db.prepare("UPDATE promoted SET archived_at = NULL WHERE id = ?").run(id);
      return;
    }

    this.withFtsSavepoint(() => {
      this.db.prepare("UPDATE promoted SET archived_at = NULL WHERE id = ?").run(id);
      // Delete first so a stale or already-present mirror is replaced without
      // hiding unrelated SQLite failures behind a broad duplicate catch.
      this.db.prepare("DELETE FROM promoted_fts WHERE rowid = ?").run(row.rowid);
      this.db.prepare("INSERT INTO promoted_fts (rowid, content, tags) VALUES (?, ?, ?)").run(
        row.rowid, row.content, row.tags,
      );
    });
  }

  transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private searchWithoutFts(
    terms: string[],
    limit: number,
    filterTags?: string[],
    projectId?: string,
  ): SearchResult[] {
    const uniqueTerms = [...new Set(terms.map((term) => term.toLowerCase()))];
    // The public tokenizer emits ASCII word terms. Mirror those boundaries in
    // the fallback while reusing numbered parameters for filtering and score.
    const params: Array<string | number> = uniqueTerms.flatMap((term) => [
      term,
      `${term}[^a-z0-9_]*`,
      `*[^a-z0-9_]${term}`,
      `*[^a-z0-9_]${term}[^a-z0-9_]*`,
    ]);
    const matchClause = (termIndex: number): string => {
      const firstParameter = termIndex * 4 + 1;
      const columnMatch = (column: string): string =>
        `LOWER(${column}) = ?${firstParameter}
          OR LOWER(${column}) GLOB ?${firstParameter + 1}
          OR LOWER(${column}) GLOB ?${firstParameter + 2}
          OR LOWER(${column}) GLOB ?${firstParameter + 3}`;
      return `((${columnMatch("content")}) OR (${columnMatch("tags")}))`;
    };
    const termClauses = uniqueTerms.map((_term, index) => matchClause(index));
    const scoreClauses = uniqueTerms.map((_term, index) => `CASE WHEN ${matchClause(index)} THEN 1 ELSE 0 END`);
    let sql = `SELECT *, (${scoreClauses.join(" + ")}) AS matched_terms
      FROM promoted WHERE archived_at IS NULL AND (${termClauses.join(" OR ")})`;
    if (projectId) {
      sql += ` AND project_id = ?${params.length + 1}`;
      params.push(projectId);
    }
    sql += " ORDER BY matched_terms DESC, confidence DESC, created_at ASC";

    let results = (this.db.prepare(sql).all(...params) as Array<PromotedRow & { matched_terms: number }>).map((row) => ({
      id: row.id,
      content: row.content,
      tags: parsePromotedTags(row.tags),
      projectId: row.project_id,
      sessionId: row.session_id,
      confidence: row.confidence,
      createdAt: row.created_at,
      rank: FALLBACK_TERM_SCORE * row.matched_terms * (row.matched_terms / uniqueTerms.length),
    }));
    if (filterTags && filterTags.length > 0) {
      results = results.filter((result) => filterTags.every((tag) => result.tags.includes(tag)));
    }
    // Apply exact decoded-tag filtering before the caller's limit. Applying
    // LIMIT in SQL first can discard every qualifying tagged row when more
    // highly ranked untagged matches precede it.
    return limit < 0 ? results : results.slice(0, limit);
  }
}
