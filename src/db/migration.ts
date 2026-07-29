import type { DatabaseSync } from "node:sqlite";
import { getLcmDbFeatures } from "./features.js";

type SummaryColumnInfo = {
  name?: string;
};

type SummaryDepthRow = {
  summary_id: string;
  conversation_id: number;
  kind: "leaf" | "condensed";
  depth: number;
  token_count: number;
  created_at: string;
};

type SummaryMessageTimeRangeRow = {
  summary_id: string;
  earliest_at: string | null;
  latest_at: string | null;
  source_message_token_count: number | null;
};

type SummaryParentEdgeRow = {
  summary_id: string;
  parent_summary_id: string;
};

type InstructionCacheMigrationStage =
  | "after-begin"
  | "after-drop"
  | "after-create";

type SqliteColumnInfo = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type SqliteSchemaObject = {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
};

type InstructionCacheSchema = "missing" | "legacy" | "current";

const LEGACY_SESSION_INSTRUCTIONS_SQL = `
  CREATE TABLE session_instructions (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

const LEGACY_INSTRUCTION_CACHE_SQL = `
  CREATE TABLE session_instruction_cache (
    id INTEGER PRIMARY KEY,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

const CURRENT_INSTRUCTION_CACHE_SQL = `
  CREATE TABLE session_instruction_cache (
    project_id TEXT NOT NULL,
    scope_hash TEXT NOT NULL CHECK (
      length(scope_hash) = 64
      AND scope_hash NOT GLOB '*[^a-f0-9]*'
    ),
    client_name TEXT NOT NULL CHECK (client_name IN ('claude', 'codex')),
    session_id TEXT NOT NULL CHECK (session_id <> ''),
    worktree_path TEXT NOT NULL CHECK (worktree_path <> ''),
    cwd_path TEXT NOT NULL CHECK (cwd_path <> ''),
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, scope_hash)
  )
`;

const LEGACY_INSTRUCTION_COLUMNS = [
  ["id", "INTEGER", 0, 1],
  ["content", "TEXT", 1, 0],
  ["content_hash", "TEXT", 1, 0],
  ["updated_at", "TEXT", 1, 0],
] as const;

const CURRENT_INSTRUCTION_COLUMNS = [
  ["project_id", "TEXT", 1, 1],
  ["scope_hash", "TEXT", 1, 2],
  ["client_name", "TEXT", 1, 0],
  ["session_id", "TEXT", 1, 0],
  ["worktree_path", "TEXT", 1, 0],
  ["cwd_path", "TEXT", 1, 0],
  ["content", "TEXT", 1, 0],
  ["content_hash", "TEXT", 1, 0],
  ["updated_at", "TEXT", 1, 0],
] as const;

function instructionColumnsMatch(
  actual: SqliteColumnInfo[],
  expected: readonly (readonly [string, string, number, number])[],
): boolean {
  return actual.length === expected.length
    && actual.every((column, index) => {
      const wanted = expected[index]!;
      return column.cid === index
        && column.name === wanted[0]
        && column.type.toUpperCase() === wanted[1]
        && column.notnull === wanted[2]
        && column.pk === wanted[3]
        && (
          column.name !== "updated_at"
          || column.dflt_value === "datetime('now')"
        );
    });
}

function instructionTableColumns(
  db: DatabaseSync,
  table: string,
): {
  columns: SqliteColumnInfo[];
  sql: string;
  auxiliaryObjects: SqliteSchemaObject[];
} | null {
  const relation = db.prepare(
    "SELECT type, sql FROM sqlite_schema WHERE name = ?",
  ).get(table) as { type?: string; sql?: string } | undefined;
  if (!relation) return null;
  if (relation.type !== "table") {
    throw new Error(`unsupported ${table} schema: expected a table`);
  }
  return {
    columns: db.prepare(`PRAGMA table_info(${table})`).all() as SqliteColumnInfo[],
    sql: relation.sql as string,
    auxiliaryObjects: db.prepare(
      `SELECT type, name, tbl_name, sql
         FROM sqlite_schema
         WHERE tbl_name = ? AND name <> ?
         ORDER BY type, name`,
    ).all(table, table) as SqliteSchemaObject[],
  };
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim().toLowerCase();
}

function hasNoAuxiliaryInstructionObjects(
  auxiliaryObjects: SqliteSchemaObject[],
): boolean {
  return auxiliaryObjects.length === 0;
}

function hasOnlyCurrentInstructionAutoindex(
  auxiliaryObjects: SqliteSchemaObject[],
): boolean {
  return JSON.stringify(auxiliaryObjects) === JSON.stringify([{
    type: "index",
    name: "sqlite_autoindex_session_instruction_cache_1",
    tbl_name: "session_instruction_cache",
    sql: null,
  }]);
}

function unexpectedInstructionSchemaReferences(
  db: DatabaseSync,
): SqliteSchemaObject[] {
  return (db.prepare(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE sql IS NOT NULL
         AND name NOT IN ('session_instructions', 'session_instruction_cache')
       ORDER BY type, name`,
  ).all() as SqliteSchemaObject[]).filter(({ sql }) => (
    /\bsession_(?:instructions|instruction_cache)\b/iu.test(sql as string)
  ));
}

function inspectInstructionCacheSchema(db: DatabaseSync): {
  cache: InstructionCacheSchema;
  hasLegacySource: boolean;
} {
  const cache = instructionTableColumns(db, "session_instruction_cache");
  const legacySource = instructionTableColumns(db, "session_instructions");
  if (unexpectedInstructionSchemaReferences(db).length > 0) {
    throw new Error(
      "unsupported instruction-cache schema dependencies; database was not modified",
    );
  }
  if (
    legacySource
    && (
      !instructionColumnsMatch(legacySource.columns, LEGACY_INSTRUCTION_COLUMNS)
      || normalizedSql(legacySource.sql)
        !== normalizedSql(LEGACY_SESSION_INSTRUCTIONS_SQL)
      || !hasNoAuxiliaryInstructionObjects(legacySource.auxiliaryObjects)
    )
  ) {
    throw new Error("unsupported session_instructions schema; database was not modified");
  }
  if (!cache) {
    return { cache: "missing", hasLegacySource: legacySource !== null };
  }
  if (
    instructionColumnsMatch(cache.columns, LEGACY_INSTRUCTION_COLUMNS)
    && normalizedSql(cache.sql) === normalizedSql(LEGACY_INSTRUCTION_CACHE_SQL)
    && hasNoAuxiliaryInstructionObjects(cache.auxiliaryObjects)
  ) {
    if (!legacySource) {
      throw new Error(
        "unsupported partial legacy instruction-cache schema; database was not modified",
      );
    }
    return { cache: "legacy", hasLegacySource: true };
  }
  if (
    instructionColumnsMatch(cache.columns, CURRENT_INSTRUCTION_COLUMNS)
    && normalizedSql(cache.sql) === normalizedSql(CURRENT_INSTRUCTION_CACHE_SQL)
    && hasOnlyCurrentInstructionAutoindex(cache.auxiliaryObjects)
  ) {
    if (legacySource) {
      throw new Error(
        "unsupported ambiguous instruction-cache schema; database was not modified",
      );
    }
    return { cache: "current", hasLegacySource: false };
  }
  throw new Error("unsupported session_instruction_cache schema; database was not modified");
}

function migrateInstructionCache(
  db: DatabaseSync,
  observer?: (stage: InstructionCacheMigrationStage) => void,
): void {
  // Preflight runs before any other migration statement so unknown, partial,
  // or ambiguous cache schemas leave the complete original database intact.
  const schema = inspectInstructionCacheSchema(db);
  if (schema.cache === "current" && !schema.hasLegacySource) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    observer?.("after-begin");
    if (schema.cache === "legacy") {
      db.exec("DROP TABLE session_instruction_cache");
    }
    if (schema.hasLegacySource) {
      db.exec("DROP TABLE session_instructions");
    }
    observer?.("after-drop");
    if (schema.cache !== "current") {
      db.exec(CURRENT_INSTRUCTION_CACHE_SQL);
    }
    observer?.("after-create");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ensureSummaryDepthColumn(db: DatabaseSync): void {
  const summaryColumns = db.prepare(`PRAGMA table_info(summaries)`).all() as SummaryColumnInfo[];
  const hasDepth = summaryColumns.some((col) => col.name === "depth");
  if (!hasDepth) {
    db.exec(`ALTER TABLE summaries ADD COLUMN depth INTEGER NOT NULL DEFAULT 0`);
  }
}

function ensureSummaryMetadataColumns(db: DatabaseSync): void {
  const summaryColumns = db.prepare(`PRAGMA table_info(summaries)`).all() as SummaryColumnInfo[];
  const hasEarliestAt = summaryColumns.some((col) => col.name === "earliest_at");
  const hasLatestAt = summaryColumns.some((col) => col.name === "latest_at");
  const hasDescendantCount = summaryColumns.some((col) => col.name === "descendant_count");
  const hasDescendantTokenCount = summaryColumns.some((col) => col.name === "descendant_token_count");
  const hasSourceMessageTokenCount = summaryColumns.some(
    (col) => col.name === "source_message_token_count",
  );

  if (!hasEarliestAt) {
    db.exec(`ALTER TABLE summaries ADD COLUMN earliest_at TEXT`);
  }
  if (!hasLatestAt) {
    db.exec(`ALTER TABLE summaries ADD COLUMN latest_at TEXT`);
  }
  if (!hasDescendantCount) {
    db.exec(`ALTER TABLE summaries ADD COLUMN descendant_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasDescendantTokenCount) {
    db.exec(`ALTER TABLE summaries ADD COLUMN descendant_token_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasSourceMessageTokenCount) {
    db.exec(`ALTER TABLE summaries ADD COLUMN source_message_token_count INTEGER NOT NULL DEFAULT 0`);
  }
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isoStringOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function backfillSummaryDepths(db: DatabaseSync): void {
  // Leaves are always depth 0, even if legacy rows had malformed values.
  db.exec(`UPDATE summaries SET depth = 0 WHERE kind = 'leaf'`);

  const conversationRows = db
    .prepare(`SELECT DISTINCT conversation_id FROM summaries WHERE kind = 'condensed'`)
    .all() as Array<{ conversation_id: number }>;
  if (conversationRows.length === 0) {
    return;
  }

  const updateDepthStmt = db.prepare(`UPDATE summaries SET depth = ? WHERE summary_id = ?`);

  for (const row of conversationRows) {
    const conversationId = row.conversation_id;
    const summaries = db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, token_count, created_at
         FROM summaries
         WHERE conversation_id = ?`,
      )
      .all(conversationId) as SummaryDepthRow[];

    const depthBySummaryId = new Map<string, number>();
    const unresolvedCondensedIds = new Set<string>();
    for (const summary of summaries) {
      if (summary.kind === "leaf") {
        depthBySummaryId.set(summary.summary_id, 0);
        continue;
      }
      unresolvedCondensedIds.add(summary.summary_id);
    }

    const edges = db
      .prepare(
        `SELECT summary_id, parent_summary_id
         FROM summary_parents
         WHERE summary_id IN (
           SELECT summary_id FROM summaries
           WHERE conversation_id = ? AND kind = 'condensed'
         )`,
      )
      .all(conversationId) as SummaryParentEdgeRow[];
    const parentsBySummaryId = new Map<string, string[]>();
    for (const edge of edges) {
      const existing = parentsBySummaryId.get(edge.summary_id) ?? [];
      existing.push(edge.parent_summary_id);
      parentsBySummaryId.set(edge.summary_id, existing);
    }

    while (unresolvedCondensedIds.size > 0) {
      let progressed = false;

      for (const summaryId of [...unresolvedCondensedIds]) {
        const parentIds = parentsBySummaryId.get(summaryId) ?? [];
        if (parentIds.length === 0) {
          depthBySummaryId.set(summaryId, 1);
          unresolvedCondensedIds.delete(summaryId);
          progressed = true;
          continue;
        }

        let maxParentDepth = -1;
        let allParentsResolved = true;
        for (const parentId of parentIds) {
          const parentDepth = depthBySummaryId.get(parentId);
          if (parentDepth == null) {
            allParentsResolved = false;
            break;
          }
          if (parentDepth > maxParentDepth) {
            maxParentDepth = parentDepth;
          }
        }

        if (!allParentsResolved) {
          continue;
        }

        depthBySummaryId.set(summaryId, maxParentDepth + 1);
        unresolvedCondensedIds.delete(summaryId);
        progressed = true;
      }

      // Guard against malformed cycles/cross-conversation references.
      if (!progressed) {
        for (const summaryId of unresolvedCondensedIds) {
          depthBySummaryId.set(summaryId, 1);
        }
        unresolvedCondensedIds.clear();
      }
    }

    for (const summary of summaries) {
      updateDepthStmt.run(depthBySummaryId.get(summary.summary_id)!, summary.summary_id);
    }
  }
}

function backfillSummaryMetadata(db: DatabaseSync): void {
  const conversationRows = db
    .prepare(`SELECT DISTINCT conversation_id FROM summaries`)
    .all() as Array<{ conversation_id: number }>;
  if (conversationRows.length === 0) {
    return;
  }

  const updateMetadataStmt = db.prepare(
    `UPDATE summaries
     SET earliest_at = ?, latest_at = ?, descendant_count = ?,
         descendant_token_count = ?, source_message_token_count = ?
     WHERE summary_id = ?`,
  );

  for (const conversationRow of conversationRows) {
    const conversationId = conversationRow.conversation_id;
    const summaries = db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, token_count, created_at
         FROM summaries
         WHERE conversation_id = ?
         ORDER BY depth ASC, created_at ASC`,
      )
      .all(conversationId) as SummaryDepthRow[];
    const leafRanges = db
      .prepare(
        `SELECT
           sm.summary_id,
           MIN(m.created_at) AS earliest_at,
           MAX(m.created_at) AS latest_at,
           COALESCE(SUM(m.token_count), 0) AS source_message_token_count
         FROM summary_messages sm
         JOIN messages m ON m.message_id = sm.message_id
         JOIN summaries s ON s.summary_id = sm.summary_id
         WHERE s.conversation_id = ? AND s.kind = 'leaf'
         GROUP BY sm.summary_id`,
      )
      .all(conversationId) as SummaryMessageTimeRangeRow[];
    const leafRangeBySummaryId = new Map(
      leafRanges.map((row) => [
        row.summary_id,
        {
          earliestAt: row.earliest_at,
          latestAt: row.latest_at,
          sourceMessageTokenCount: row.source_message_token_count,
        },
      ]),
    );

    const edges = db
      .prepare(
        `SELECT summary_id, parent_summary_id
         FROM summary_parents
         WHERE summary_id IN (
           SELECT summary_id FROM summaries WHERE conversation_id = ?
         )`,
      )
      .all(conversationId) as SummaryParentEdgeRow[];
    const parentsBySummaryId = new Map<string, string[]>();
    for (const edge of edges) {
      const existing = parentsBySummaryId.get(edge.summary_id) ?? [];
      existing.push(edge.parent_summary_id);
      parentsBySummaryId.set(edge.summary_id, existing);
    }

    const metadataBySummaryId = new Map<
      string,
      {
        earliestAt: Date | null;
        latestAt: Date | null;
        descendantCount: number;
        descendantTokenCount: number;
        sourceMessageTokenCount: number;
      }
    >();
    const tokenCountBySummaryId = new Map(
      summaries.map((summary) => [summary.summary_id, Math.max(0, Math.floor(summary.token_count))]),
    );

    for (const summary of summaries) {
      const fallbackDate = parseTimestamp(summary.created_at);
      if (summary.kind === "leaf") {
        const range = leafRangeBySummaryId.get(summary.summary_id);
        const earliestAt = parseTimestamp(range?.earliestAt ?? summary.created_at) ?? fallbackDate;
        const latestAt = parseTimestamp(range?.latestAt ?? summary.created_at) ?? fallbackDate;

        metadataBySummaryId.set(summary.summary_id, {
          earliestAt,
          latestAt,
          descendantCount: 0,
          descendantTokenCount: 0,
          sourceMessageTokenCount: Math.max(
            0,
            Math.floor(range?.sourceMessageTokenCount ?? 0),
          ),
        });
        continue;
      }

      const parentIds = parentsBySummaryId.get(summary.summary_id) ?? [];
      if (parentIds.length === 0) {
        metadataBySummaryId.set(summary.summary_id, {
          earliestAt: fallbackDate,
          latestAt: fallbackDate,
          descendantCount: 0,
          descendantTokenCount: 0,
          sourceMessageTokenCount: 0,
        });
        continue;
      }

      let earliestAt: Date | null = null;
      let latestAt: Date | null = null;
      let descendantCount = 0;
      let descendantTokenCount = 0;
      let sourceMessageTokenCount = 0;

      for (const parentId of parentIds) {
        const parentMetadata = metadataBySummaryId.get(parentId);
        if (!parentMetadata) {
          continue;
        }

        const parentEarliest = parentMetadata.earliestAt;
        if (parentEarliest && (!earliestAt || parentEarliest < earliestAt)) {
          earliestAt = parentEarliest;
        }

        const parentLatest = parentMetadata.latestAt;
        if (parentLatest && (!latestAt || parentLatest > latestAt)) {
          latestAt = parentLatest;
        }

        descendantCount += Math.max(0, parentMetadata.descendantCount) + 1;
        const parentTokenCount = tokenCountBySummaryId.get(parentId)!;
        descendantTokenCount +=
          Math.max(0, parentTokenCount) + Math.max(0, parentMetadata.descendantTokenCount);
        sourceMessageTokenCount += Math.max(0, parentMetadata.sourceMessageTokenCount);
      }

      metadataBySummaryId.set(summary.summary_id, {
        earliestAt: earliestAt ?? fallbackDate,
        latestAt: latestAt ?? fallbackDate,
        descendantCount: Math.max(0, descendantCount),
        descendantTokenCount: Math.max(0, descendantTokenCount),
        sourceMessageTokenCount: Math.max(0, sourceMessageTokenCount),
      });
    }

    for (const summary of summaries) {
      const metadata = metadataBySummaryId.get(summary.summary_id)!;
      updateMetadataStmt.run(
        isoStringOrNull(metadata.earliestAt),
        isoStringOrNull(metadata.latestAt),
        Math.max(0, metadata.descendantCount),
        Math.max(0, metadata.descendantTokenCount),
        Math.max(0, metadata.sourceMessageTokenCount),
        summary.summary_id,
      );
    }
  }
}

export function runLcmMigrations(
  db: DatabaseSync,
  options?: {
    fts5Available?: boolean;
    /** @internal Deterministic rollback seam for cache-migration tests. */
    _instructionCacheMigrationObserver?: (
      stage: InstructionCacheMigrationStage,
    ) => void;
  },
): void {
  migrateInstructionCache(db, options?._instructionCacheMigrationObserver);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      title TEXT,
      bootstrapped_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      message_id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (conversation_id, seq)
    );

    CREATE TABLE IF NOT EXISTS summaries (
      summary_id TEXT PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('leaf', 'condensed')),
      depth INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      earliest_at TEXT,
      latest_at TEXT,
      descendant_count INTEGER NOT NULL DEFAULT 0,
      descendant_token_count INTEGER NOT NULL DEFAULT 0,
      source_message_token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      file_ids TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS message_parts (
      part_id TEXT PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      part_type TEXT NOT NULL CHECK (part_type IN (
        'text', 'reasoning', 'tool', 'patch', 'file',
        'subtask', 'compaction', 'step_start', 'step_finish',
        'snapshot', 'agent', 'retry'
      )),
      ordinal INTEGER NOT NULL,
      text_content TEXT,
      is_ignored INTEGER,
      is_synthetic INTEGER,
      tool_call_id TEXT,
      tool_name TEXT,
      tool_status TEXT,
      tool_input TEXT,
      tool_output TEXT,
      tool_error TEXT,
      tool_title TEXT,
      patch_hash TEXT,
      patch_files TEXT,
      file_mime TEXT,
      file_name TEXT,
      file_url TEXT,
      subtask_prompt TEXT,
      subtask_desc TEXT,
      subtask_agent TEXT,
      step_reason TEXT,
      step_cost REAL,
      step_tokens_in INTEGER,
      step_tokens_out INTEGER,
      snapshot_hash TEXT,
      compaction_auto INTEGER,
      metadata TEXT,
      UNIQUE (message_id, ordinal)
    );

    CREATE TABLE IF NOT EXISTS summary_messages (
      summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL REFERENCES messages(message_id) ON DELETE RESTRICT,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (summary_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS summary_parents (
      summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
      parent_summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE RESTRICT,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (summary_id, parent_summary_id)
    );

    CREATE TABLE IF NOT EXISTS context_items (
      conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('message', 'summary')),
      message_id INTEGER REFERENCES messages(message_id) ON DELETE RESTRICT,
      summary_id TEXT REFERENCES summaries(summary_id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (conversation_id, ordinal),
      CHECK (
        (item_type = 'message' AND message_id IS NOT NULL AND summary_id IS NULL) OR
        (item_type = 'summary' AND summary_id IS NOT NULL AND message_id IS NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS large_files (
      file_id TEXT PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      file_name TEXT,
      mime_type TEXT,
      byte_size INTEGER,
      storage_uri TEXT NOT NULL,
      exploration_summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS messages_conv_seq_idx ON messages (conversation_id, seq);
    CREATE INDEX IF NOT EXISTS summaries_conv_created_idx ON summaries (conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS message_parts_message_idx ON message_parts (message_id);
    CREATE INDEX IF NOT EXISTS message_parts_type_idx ON message_parts (part_type);
    CREATE INDEX IF NOT EXISTS context_items_conv_idx ON context_items (conversation_id, ordinal);
    CREATE INDEX IF NOT EXISTS large_files_conv_idx ON large_files (conversation_id, created_at);
  `);

  // Forward-compatible conversations migration for existing DBs.
  const conversationColumns = db.prepare(`PRAGMA table_info(conversations)`).all() as Array<{
    name?: string;
  }>;
  const hasBootstrappedAt = conversationColumns.some((col) => col.name === "bootstrapped_at");
  if (!hasBootstrappedAt) {
    db.exec(`ALTER TABLE conversations ADD COLUMN bootstrapped_at TEXT`);
  }

  ensureSummaryDepthColumn(db);
  ensureSummaryMetadataColumns(db);
  backfillSummaryDepths(db);
  backfillSummaryMetadata(db);

  // Redaction stats (counts of secrets scrubbed per project per category).
  // v0.7.0 created this table with CHECK(category IN ('built_in', 'global', 'project')).
  // v0.8.0 adds 'gitleaks' to the enum. CREATE TABLE IF NOT EXISTS silently skips creation
  // on existing DBs, so we must detect the stale constraint and recreate.
  // redaction_stats is a pure counter table (no user data) — DROP/RECREATE is safe.
  const redactionStatsRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='redaction_stats'")
    .get() as { sql?: string } | undefined;
  const needsRedactionStatsMigration =
    !redactionStatsRow ||
    (redactionStatsRow.sql !== undefined && !redactionStatsRow.sql.includes("'gitleaks'"));
  if (needsRedactionStatsMigration) {
    db.exec(`
      DROP TABLE IF EXISTS redaction_stats;
      CREATE TABLE redaction_stats (
        project_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('built_in', 'global', 'project', 'gitleaks')),
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, category)
      );
    `);
  }

  // Promoted memories (cross-session, agent-stored)
  db.exec(`
    CREATE TABLE IF NOT EXISTS promoted (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      source_summary_id TEXT,
      project_id TEXT NOT NULL,
      session_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS promoted_project_idx ON promoted (project_id, created_at);
  `);

  // Add post-baseline promoted fields for existing databases.
  const promotedColumns = db.prepare(`PRAGMA table_info(promoted)`).all() as Array<{ name?: string }>;
  const hasPromotedMetadata = promotedColumns.some((col) => col.name === "metadata");
  if (!hasPromotedMetadata) {
    db.exec(`ALTER TABLE promoted ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`);
  }
  const hasArchivedAt = promotedColumns.some((col) => col.name === "archived_at");
  if (!hasArchivedAt) {
    db.exec(`ALTER TABLE promoted ADD COLUMN archived_at TEXT DEFAULT NULL`);
  }

  // Session ingest log — tracks which sessions are fully ingested
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_ingest_log (
      session_id TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL DEFAULT (datetime('now')),
      message_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Recall surfacing log — tracks when promoted memories are shown in user-prompt context
  db.exec(`
    CREATE TABLE IF NOT EXISTS recall_surfacing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      session_id TEXT,
      surfaced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS recall_surfacing_memory_idx ON recall_surfacing (memory_id);
  `);

  const fts5Available = options?.fts5Available ?? getLcmDbFeatures(db).fts5Available;
  if (!fts5Available) {
    return;
  }

  // Promoted FTS5
  const hasPromotedFts = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='promoted_fts'")
    .get();

  if (!hasPromotedFts) {
    db.exec(`
      CREATE VIRTUAL TABLE promoted_fts USING fts5(
        content,
        tags,
        tokenize='porter unicode61'
      );
    `);
  }

  // FTS5 virtual tables for full-text search (cannot use IF NOT EXISTS, so check manually)
  const hasFts = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'")
    .get();

  if (hasFts) {
    // Check for stale schema: external-content FTS tables with content_rowid cause errors.
    // Drop and recreate as standalone FTS if the old schema is detected.
    const ftsSchema = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts'")
        .get() as { sql: string } | undefined
    )?.sql;
    if (ftsSchema && ftsSchema.includes("content_rowid")) {
      db.exec("BEGIN");
      try {
        db.exec(`
          CREATE TEMP TABLE messages_fts_migration (
            rowid INTEGER PRIMARY KEY,
            content TEXT NOT NULL
          );
          INSERT INTO messages_fts_migration(rowid, content)
            SELECT rowid, content FROM messages_fts;
          DROP TABLE messages_fts;
          CREATE VIRTUAL TABLE messages_fts USING fts5(
            content,
            tokenize='porter unicode61'
          );
          INSERT INTO messages_fts(rowid, content)
            SELECT rowid, content FROM messages_fts_migration;
          DROP TABLE messages_fts_migration;
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  } else {
    db.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        tokenize='porter unicode61'
      );
    `);
  }

  const summariesFtsInfo = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='summaries_fts'")
    .get() as { sql?: string } | undefined;
  const summariesFtsSql = summariesFtsInfo?.sql ?? "";
  const summariesFtsColumns = db.prepare(`PRAGMA table_info(summaries_fts)`).all() as Array<{
    name?: string;
  }>;
  const hasSummaryIdColumn = summariesFtsColumns.some((col) => col.name === "summary_id");
  const shouldRecreateSummariesFts =
    !summariesFtsInfo ||
    !hasSummaryIdColumn ||
    summariesFtsSql.includes("content_rowid='summary_id'") ||
    summariesFtsSql.includes('content_rowid="summary_id"');
  if (shouldRecreateSummariesFts) {
    db.exec(`
      DROP TABLE IF EXISTS summaries_fts;
      CREATE VIRTUAL TABLE summaries_fts USING fts5(
        summary_id UNINDEXED,
        content,
        tokenize='porter unicode61'
      );
      INSERT INTO summaries_fts(summary_id, content)
      SELECT summary_id, content FROM summaries;
    `);
  }
}
