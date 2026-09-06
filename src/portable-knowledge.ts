/**
 * Portable knowledge: export and import promoted memory entries.
 *
 * Export format:
 *   {
 *     version: 1,
 *     exportedAt: "<ISO string>",
 *     projectCwd: "<string>",
 *     entries: [{ content, tags, confidence, createdAt, sessionId }]
 *   }
 *
 * Secrets are scrubbed on export via ScrubEngine.
 * Deduplication is performed on import via deduplicateAndInsert().
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { serializePromotedMetadata } from "./db/promoted.js";
import { deduplicateAndInsert } from "./promotion/dedup.js";
import { ScrubEngine } from "./scrub.js";
import { withCliProjectStorage } from "./cli-storage.js";
import type { JsonObject, ProjectStorage } from "./storage/contracts.js";
import type { PublicationConvergence } from "./storage/publication-convergence.js";

export const EXPORT_VERSION = 1;

export interface ExportEntry {
  content: string;
  tags: string[];
  confidence: number;
  createdAt: string;
  sessionId: string | null;
}

export interface ExportDocument {
  version: number;
  exportedAt: string;
  projectCwd: string;
  entries: ExportEntry[];
}

// ─── Export ──────────────────────────────────────────────────────────────────

export interface ExportOptions {
  /** Only include entries with these tags */
  tags?: string[];
  /** Only include entries created at or after this ISO date string */
  since?: string;
  /** Output file path (stdout if omitted) */
  output?: string;
  /** Output format — only "json" supported for now */
  format?: "json";
  /** Skip scrubbing secrets (not recommended; useful for tests) */
  skipScrub?: boolean;
  /** Override the ~/.lcm base directory (for testing) */
  _lcmBaseDir?: string;
  /** Override global sensitive patterns (tests only). */
  _globalPatterns?: string[];
  /** @internal Reuse the CLI's authenticated publication convergence. */
  _publicationConvergence?: PublicationConvergence;
}

export interface ExportResult {
  exported: number;
  projectCwd: string;
}

type GatheredExport = Readonly<{
  document: ExportDocument;
  result: ExportResult;
}>;

async function gatherExport(
  cwd: string,
  opts: ExportOptions,
): Promise<GatheredExport> {
  return withCliProjectStorage(cwd, {
    create: false,
    _lcmBaseDir: opts._lcmBaseDir,
    _publicationConvergence: opts._publicationConvergence,
  }, async ({ storage, project, config }) => {
    const rows = await storage.promotedMemory.getAll({
      sourceProjectId: project.id,
      since: opts.since,
      tags: opts.tags,
    });
    const scrubber = opts.skipScrub ? null : await ScrubEngine.forProject(
      opts._globalPatterns ?? config.security.sensitivePatterns, project.dir,
    );
    const entries = rows.map((row): ExportEntry => ({
      content: scrubber ? scrubber.scrub(row.content) : row.content,
      tags: row.tags.map((tag) => scrubber ? scrubber.scrub(tag) : tag),
      confidence: row.confidence,
      createdAt: row.createdAt,
      sessionId: null,
    }));
    return {
      document: {
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        projectCwd: project.canonical,
        entries,
      },
      result: { exported: entries.length, projectCwd: project.canonical },
    };
  });
}

function persistExport(document: ExportDocument, output: string | undefined): void {
  const json = JSON.stringify(document, null, 2);
  if (output) writeFileSync(output, json, "utf-8");
  else process.stdout.write(json + "\n");
}

export async function exportKnowledge(
  cwd: string,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const gathered = await gatherExport(cwd, opts);
  persistExport(gathered.document, opts.output);
  return gathered.result;
}

// ─── Import ──────────────────────────────────────────────────────────────────

export interface ImportOptions {
  /** Merge with existing entries, deduplicating (default behaviour) */
  merge?: boolean;
  /** Preview without writing anything */
  dryRun?: boolean;
  /** Override confidence for all imported entries */
  confidence?: number;
  /** Override the ~/.lcm base directory (for testing) */
  _lcmBaseDir?: string;
  /** Override global sensitive patterns (tests only). */
  _globalPatterns?: string[];
}

export interface ImportResult {
  total: number;
  imported: number;
  skipped: number;
  dryRun: boolean;
  /** Sanitized validation errors for entries skipped before storage work. */
  errors?: string[];
}

const DEFAULT_DEDUP_THRESHOLDS = {
  dedupBm25Threshold: 15,
  dedupCandidateLimit: 100,
};

// Namespaced local metadata is intentionally absent from the version 1 document.
const IMPORT_DIGESTS = "lcm.portableKnowledge.v1.entryDigests";

function retryDigests(metadata: JsonObject): string[] {
  const value = metadata[IMPORT_DIGESTS];
  return Array.isArray(value)
    ? value.filter((digest): digest is string => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest))
    : [];
}

type PreparedEntry = { entry: ExportEntry; digest: string; confidence: number };

function prepareEntries(doc: ExportDocument, opts: ImportOptions): { entries: PreparedEntry[]; errors: string[] } {
  if (!doc || typeof doc !== "object") throw new Error("Invalid knowledge document");
  if (doc.version !== EXPORT_VERSION) throw new Error(`Unsupported export version (expected ${EXPORT_VERSION})`);
  if (typeof doc.projectCwd !== "string" || typeof doc.exportedAt !== "string" || !Array.isArray(doc.entries)) {
    throw new Error("Invalid knowledge document");
  }
  if (opts.confidence !== undefined && (!Number.isFinite(opts.confidence) || opts.confidence < 0 || opts.confidence > 1)) {
    throw new Error("Invalid import confidence");
  }
  const entries: PreparedEntry[] = [];
  const errors: string[] = [];
  for (let ordinal = 0; ordinal < doc.entries.length; ordinal++) {
    try {
      const source = doc.entries[ordinal];
      const entry: ExportEntry = {
        content: source.content, tags: source.tags, confidence: source.confidence,
        createdAt: source.createdAt, sessionId: source.sessionId,
      };
      const confidence = opts.confidence ?? entry.confidence;
      if (typeof entry.content !== "string" || entry.content.length === 0 || !Array.isArray(entry.tags)
        || !entry.tags.every((tag) => typeof tag === "string")
        || !Number.isFinite(entry.confidence) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1
        || typeof entry.createdAt !== "string" || !Number.isFinite(Date.parse(entry.createdAt))
        || (entry.sessionId !== null && typeof entry.sessionId !== "string")) {
        throw new Error("Invalid entry");
      }
      // Shared JSON validation also rejects NUL/unpaired surrogates before PG SQL.
      serializePromotedMetadata({ content: entry.content, tags: entry.tags, sessionId: entry.sessionId });
      const digest = createHash("sha256").update(JSON.stringify([
        EXPORT_VERSION, doc.projectCwd, ordinal, entry.content, entry.tags,
        entry.confidence, entry.createdAt, entry.sessionId,
      ])).digest("hex");
      entries.push({ entry, confidence, digest });
    } catch {
      errors.push(`Invalid knowledge entry at index ${ordinal}`);
    }
  }
  return { entries, errors };
}

export async function importKnowledge(
  cwd: string,
  doc: ExportDocument,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const prepared = prepareEntries(doc, opts);
  if (opts.dryRun) {
    return {
      total: doc.entries.length,
      imported: 0,
      skipped: prepared.errors.length,
      dryRun: true,
      ...(prepared.errors.length ? { errors: prepared.errors } : {}),
    };
  }
  let scrubber: ScrubEngine;
  return withCliProjectStorage(cwd, {
    create: true,
    _lcmBaseDir: opts._lcmBaseDir,
    prepare: async ({ project, config }) => {
      scrubber = await ScrubEngine.forProject(opts._globalPatterns ?? config.security.sensitivePatterns, project.dir);
    },
  }, async ({ storage, project }) => storage.transaction(async (repositories) => {
    // One scan per transaction, indexed before any deduplication changes rows.
    const rows = await repositories.promotedMemory.getAll({ sourceProjectId: project.id });
    const metadataById = new Map(rows.map((row) => [row.id, row.metadata]));
    const importedDigests = new Set(rows.flatMap((row) => retryDigests(row.metadata)));
    let imported = 0;
    let skipped = prepared.errors.length;
    for (const { entry, digest, confidence } of prepared.entries) {
      if (importedDigests.has(digest)) { skipped++; continue; }
      const collapsed: JsonObject[] = [];
      // Dedup receives the already scoped repositories; it must not BEGIN again.
      const transaction: ProjectStorage["transaction"] = async (callback) => callback({
        ...repositories,
        promotedMemory: new Proxy(repositories.promotedMemory, {
          get(target, property) {
            if (property === "archive") return async (id: string) => {
              // Every active candidate came from the initial scan or this loop.
              collapsed.push(metadataById.get(id)!);
              await target.archive(id);
            };
            const method = Reflect.get(target, property) as (...args: unknown[]) => unknown;
            return method.bind(target);
          },
        }),
      });
      const id = await deduplicateAndInsert({
        transaction,
        content: scrubber.scrub(entry.content),
        tags: entry.tags.map((tag) => scrubber.scrub(tag)),
        sourceProjectId: project.id,
        sessionId: entry.sessionId ?? undefined,
        depth: 0, confidence, thresholds: DEFAULT_DEDUP_THRESHOLDS,
      });
      const canonical = metadataById.get(id) ?? {};
      const digests = [...new Set([...collapsed.flatMap(retryDigests), ...retryDigests(canonical), digest])];
      // Retain metadata from collapsed rows; canonical values win key conflicts.
      const metadata: JsonObject = Object.assign(Object.create(null) as JsonObject, ...collapsed, canonical, { [IMPORT_DIGESTS]: digests });
      await repositories.promotedMemory.update(id, { metadata });
      metadataById.set(id, metadata);
      for (const key of digests) importedDigests.add(key);
      imported++;
    }
    return {
      total: doc.entries.length,
      imported,
      skipped,
      dryRun: false,
      ...(prepared.errors.length ? { errors: prepared.errors } : {}),
    };
  }));
}
