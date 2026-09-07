import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  comparePortableOrder,
  PORTABLE_LIMITS,
  PORTABLE_RECORD_DOMAIN_ORDER,
  type PortableDomain,
  type PortableOrderScalar,
  type PortableRecord,
} from "./portable-record.js";
import { PortableTransferError } from "./portable-transfer.js";

export interface PortableIndexOptions {
  readonly scratchParent?: string;
  readonly maxScratchBytes?: number;
  readonly maxMetadataBytes?: number;
  readonly signal?: AbortSignal;
}

/** Source locators are private metadata, never canonical identity preimages. */
export interface PortableIndexEntry {
  readonly domain: PortableDomain;
  readonly locator: string;
  /** -1 until the domain has been finalized; zero based thereafter. */
  readonly ordinal: number;
  readonly order: readonly PortableOrderScalar[];
  readonly identitySha256: string;
  /** Digest at insertion time. Rebuild source records at their final ordinal. */
  readonly recordSha256: string;
}

export interface PortableIndexPageOptions {
  readonly afterOrdinal: number;
  readonly limit: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

/**
 * A binary key with the codec's exact scalar ordering. Text uses escaped UTF8,
 * terminated before the next scalar; integers use biased signed 64-bit bytes.
 * SQLite BLOB comparison therefore does not depend on database text encoding.
 */
export function encodePortableIndexOrder(order: readonly PortableOrderScalar[]): Buffer {
  comparePortableOrder(order, order);
  const chunks: Buffer[] = [];
  for (const value of order) {
    if (value === null) {
      chunks.push(Buffer.from([0]));
    } else if (typeof value === "string") {
      const bytes = Buffer.from(value, "utf8");
      const escaped = Buffer.allocUnsafe(bytes.length * 2 + 3);
      escaped[0] = 1;
      let offset = 1;
      for (const byte of bytes) {
        // Each byte occupies two nonzero bytes; 0 is the string terminator.
        escaped[offset++] = (byte >> 4) + 1;
        escaped[offset++] = (byte & 15) + 1;
      }
      escaped[offset++] = 0;
      chunks.push(escaped.subarray(0, offset));
    } else {
      const bytes = Buffer.allocUnsafe(9);
      bytes[0] = 2;
      bytes.writeBigUInt64BE(BigInt(value.$integer) + (1n << 63n), 1);
      chunks.push(bytes);
    }
  }
  return Buffer.concat(chunks);
}

type SqlRow = Record<string, unknown>;
function entry(row: SqlRow): PortableIndexEntry {
  return {
    domain: row.domain as PortableDomain,
    locator: row.locator as string,
    ordinal: row.ordinal as number,
    order: JSON.parse(row.order_json as string) as PortableOrderScalar[],
    identitySha256: row.identity_sha as string,
    recordSha256: row.record_sha as string,
  };
}
function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
function hash(value: string): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/**
 * Disposable bounded metadata, not a portable-record blob store. It retains
 * only keys, digests, foreign identity references and physical source locators.
 * No journal is required: any failed mutation poisons this disposable index.
 */
export class PortableIndex {
  readonly #db: DatabaseSync;
  readonly #directory: string;
  readonly #maxMetadataBytes: number;
  readonly #signal?: AbortSignal;
  #closed = false;
  #failed = false;
  #conversationsFinalized = false;

  constructor(options: PortableIndexOptions = {}) {
    const maxScratchBytes = options.maxScratchBytes ?? 1024 * 1024 * 1024;
    const maxMetadataBytes = options.maxMetadataBytes ?? PORTABLE_LIMITS.maxRecordBytes;
    if (!positive(maxScratchBytes) || maxScratchBytes < 128 * 1024
      || !positive(maxMetadataBytes) || maxMetadataBytes > PORTABLE_LIMITS.maxBatchBytes) {
      throw new PortableTransferError("invalid-input");
    }
    if (options.signal?.aborted) throw new PortableTransferError("aborted", true);
    this.#maxMetadataBytes = maxMetadataBytes;
    this.#signal = options.signal;
    let directory: string | undefined;
    let db: DatabaseSync | undefined;
    try {
      directory = mkdtempSync(join(options.scratchParent ?? tmpdir(), "lcm-portable-index-"));
      chmodSync(directory, 0o700);
      db = new DatabaseSync(join(directory, "index.sqlite"));
      chmodSync(join(directory, "index.sqlite"), 0o600);
      db.exec(`
        PRAGMA page_size=4096;
        PRAGMA max_page_count=${Math.floor(maxScratchBytes / 4096)};
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        PRAGMA cache_size=-1024;
        PRAGMA temp_store=FILE;
        CREATE TABLE domains(domain TEXT PRIMARY KEY, finalized INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE records(
          domain TEXT NOT NULL, locator TEXT NOT NULL, ordinal INTEGER NOT NULL DEFAULT -1,
          sort_key BLOB NOT NULL, order_json TEXT NOT NULL, identity_sha TEXT NOT NULL,
          record_sha TEXT NOT NULL, PRIMARY KEY(domain,locator),
          UNIQUE(domain,identity_sha), UNIQUE(domain,sort_key));
        CREATE INDEX records_ordinals ON records(domain,ordinal);
        CREATE TABLE dependencies(domain TEXT NOT NULL, identity_sha TEXT NOT NULL);
        CREATE TABLE conversations(locator TEXT PRIMARY KEY, header BLOB NOT NULL,
          closure_sha TEXT NOT NULL, occurrence INTEGER NOT NULL DEFAULT -1);
        CREATE INDEX conversation_order ON conversations(header,closure_sha,locator);
        CREATE TABLE unique_keys(namespace TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(namespace,key));
        CREATE TABLE scopes(namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
          PRIMARY KEY(namespace,key));
        CREATE TABLE required_scopes(namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE graph_edges(namespace TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL,
          PRIMARY KEY(namespace,source,target));
        CREATE INDEX graph_incoming ON graph_edges(namespace,target);
        CREATE TABLE graph_nodes(namespace TEXT NOT NULL, key TEXT NOT NULL,
          degree INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(namespace,key));
        CREATE INDEX graph_roots ON graph_nodes(removed,degree);
        CREATE TABLE budgets(namespace TEXT NOT NULL, key TEXT NOT NULL, used INTEGER NOT NULL,
          PRIMARY KEY(namespace,key));
        CREATE TABLE occurrences(namespace TEXT NOT NULL, key TEXT NOT NULL,
          next INTEGER NOT NULL, PRIMARY KEY(namespace,key));
      `);
      this.#db = db;
      this.#directory = directory;
    } catch {
      try {
        db?.close();
      } catch {
        // Cleanup never replaces the sanitized initialization failure.
      }
      try {
        if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
      } catch {
        // The owner receives the initialization failure, without private paths.
      }
      throw new PortableTransferError("source-failed");
    }
  }

  #check(signal?: AbortSignal): void {
    if (this.#closed || this.#failed) throw new PortableTransferError("source-failed");
    if (this.#signal?.aborted || signal?.aborted) throw new PortableTransferError("aborted", true);
  }

  #sql<T>(action: () => T): T {
    this.#check();
    try {
      return action();
    } catch (error) {
      this.#failed = true;
      if (error instanceof PortableTransferError) throw new PortableTransferError(error.code, error.retryable);
      const code = typeof error === "object" && error !== null && "errcode" in error
        ? Number(error.errcode) & 255 : 0;
      throw new PortableTransferError(code === 13 ? "unsupported-capability"
        : code === 19 ? "invalid-input" : "source-failed");
    }
  }

  #metadata(...values: unknown[]): void {
    if (Buffer.byteLength(JSON.stringify(values), "utf8") > this.#maxMetadataBytes) {
      throw new PortableTransferError("unsupported-capability");
    }
  }

  #domain(domain: PortableDomain): void {
    if (!PORTABLE_RECORD_DOMAIN_ORDER.includes(domain)) throw new PortableTransferError("invalid-input");
  }

  add(locator: string, record: PortableRecord): void {
    this.#check();
    this.#domain(record.domain);
    if (typeof locator !== "string" || !hash(record.identitySha256) || !hash(record.recordSha256)) {
      throw new PortableTransferError("invalid-input");
    }
    this.#metadata(locator, record.order, record.dependencies);
    const sortKey = encodePortableIndexOrder(record.order);
    this.#sql(() => {
      const status = this.#db.prepare("SELECT finalized FROM domains WHERE domain=?").get(record.domain);
      if (status?.finalized === 1) throw new PortableTransferError("invalid-input");
      this.#db.prepare("INSERT OR IGNORE INTO domains(domain) VALUES(?)").run(record.domain);
      this.#db.prepare(`INSERT INTO records(domain,locator,sort_key,order_json,identity_sha,record_sha)
        VALUES(?,?,?,?,?,?)`).run(record.domain, locator, sortKey, JSON.stringify(record.order), record.identitySha256, record.recordSha256);
      for (const dependency of record.dependencies) {
        this.#domain(dependency.domain);
        if (!hash(dependency.identitySha256)) throw new PortableTransferError("invalid-input");
        this.#db.prepare("INSERT INTO dependencies(domain,identity_sha) VALUES(?,?)")
          .run(dependency.domain, dependency.identitySha256);
      }
    });
  }

  finalizeDomain(domain: PortableDomain): void {
    this.#domain(domain);
    this.#sql(() => {
      let ordinal = 0;
      for (const row of this.#db.prepare("SELECT locator FROM records WHERE domain=? ORDER BY sort_key").iterate(domain)) {
        this.#check();
        this.#db.prepare("UPDATE records SET ordinal=? WHERE domain=? AND locator=?").run(ordinal++, domain, row.locator);
      }
      this.#db.prepare("INSERT INTO domains(domain,finalized) VALUES(?,1) ON CONFLICT(domain) DO UPDATE SET finalized=1").run(domain);
    });
  }

  lookup(domain: PortableDomain, locator: string): PortableIndexEntry | null {
    return this.#sql(() => {
      const row = this.#db.prepare("SELECT * FROM records WHERE domain=? AND locator=?").get(domain, locator);
      return row === undefined ? null : entry(row);
    });
  }

  lookupIdentity(domain: PortableDomain, identitySha256: string): PortableIndexEntry | null {
    return this.#sql(() => {
      const row = this.#db.prepare("SELECT * FROM records WHERE domain=? AND identity_sha=?").get(domain, identitySha256);
      return row === undefined ? null : entry(row);
    });
  }

  entries(domain: PortableDomain, options: PortableIndexPageOptions): readonly PortableIndexEntry[] {
    this.#check(options.signal);
    if (!Number.isSafeInteger(options.afterOrdinal) || options.afterOrdinal < -1
      || Object.is(options.afterOrdinal, -0) || !positive(options.limit) || options.limit > 500
      || !positive(options.maxBytes) || options.maxBytes > PORTABLE_LIMITS.maxBatchBytes) {
      throw new PortableTransferError("invalid-input");
    }
    return this.#sql(() => {
      if (this.#db.prepare("SELECT finalized FROM domains WHERE domain=?").get(domain)?.finalized !== 1) {
        throw new PortableTransferError("invalid-input");
      }
      const result: PortableIndexEntry[] = [];
      let bytes = 0;
      for (const row of this.#db.prepare("SELECT * FROM records WHERE domain=? AND ordinal>? ORDER BY ordinal LIMIT ?")
        .iterate(domain, options.afterOrdinal, options.limit)) {
        this.#check(options.signal);
        const value = entry(row);
        const nextBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
        if (bytes + nextBytes > options.maxBytes) {
          if (result.length === 0) throw new PortableTransferError("unsupported-capability");
          break;
        }
        result.push(value);
        bytes += nextBytes;
      }
      return result;
    });
  }

  verifyDependencies(): void {
    this.#sql(() => {
      const missing = this.#db.prepare(`SELECT 1 FROM dependencies d WHERE NOT EXISTS
        (SELECT 1 FROM records r WHERE r.domain=d.domain AND r.identity_sha=d.identity_sha) LIMIT 1`).get();
      if (missing !== undefined) throw new PortableTransferError("invalid-input");
    });
  }

  claimUnique(namespace: string, key: string): void {
    this.#check();
    this.#metadata(namespace, key);
    this.#sql(() => {
      if (this.#db.prepare("SELECT 1 FROM unique_keys WHERE namespace=? AND key=?").get(namespace, key)) {
        throw new PortableTransferError("unsupported-capability");
      }
      this.#db.prepare("INSERT INTO unique_keys(namespace,key) VALUES(?,?)").run(namespace, key);
    });
  }

  allocateOccurrence(namespace: string, key: string): number {
    this.#check();
    this.#metadata(namespace, key);
    return this.#sql(() => {
      const row = this.#db.prepare(`INSERT INTO occurrences(namespace,key,next) VALUES(?,?,1)
        ON CONFLICT(namespace,key) DO UPDATE SET next=next+1 RETURNING next-1 AS occurrence`).get(namespace, key)!;
      return row.occurrence as number;
    });
  }

  bindScope(namespace: string, key: string, value: string): void {
    this.#check();
    this.#metadata(namespace, key, value);
    this.#sql(() => this.#db.prepare("INSERT INTO scopes(namespace,key,value) VALUES(?,?,?)").run(namespace, key, value));
  }

  getScope(namespace: string, key: string): string | null {
    return this.#sql(() => {
      const row = this.#db.prepare("SELECT value FROM scopes WHERE namespace=? AND key=?").get(namespace, key);
      return row === undefined ? null : row.value as string;
    });
  }

  requireScope(namespace: string, key: string, value: string): void {
    this.#check();
    this.#metadata(namespace, key, value);
    this.#sql(() => this.#db.prepare("INSERT INTO required_scopes(namespace,key,value) VALUES(?,?,?)").run(namespace, key, value));
  }

  addEdge(namespace: string, from: string, to: string): void {
    this.#check();
    this.#metadata(namespace, from, to);
    this.#sql(() => {
      const node = this.#db.prepare("INSERT OR IGNORE INTO graph_nodes(namespace,key) VALUES(?,?)");
      node.run(namespace, from);
      node.run(namespace, to);
      this.#db.prepare("INSERT OR IGNORE INTO graph_edges(namespace,source,target) VALUES(?,?,?)").run(namespace, from, to);
    });
  }

  /** Indexed disk topological elimination avoids an unbounded transitive closure. */
  verifyScopesAndAcyclic(): void {
    this.#sql(() => {
      const mismatch = this.#db.prepare(`SELECT 1 FROM required_scopes r LEFT JOIN scopes s
        ON r.namespace=s.namespace AND r.key=s.key WHERE s.value IS NULL OR s.value<>r.value LIMIT 1`).get();
      if (mismatch !== undefined) throw new PortableTransferError("unsupported-capability");
      const reset = this.#db.prepare(`UPDATE graph_nodes SET removed=0,degree=(SELECT count(*) FROM graph_edges e
        WHERE e.namespace=graph_nodes.namespace AND e.target=graph_nodes.key) WHERE namespace=? AND key=?`);
      for (const row of this.#db.prepare("SELECT namespace,key FROM graph_nodes").iterate()) {
        this.#check();
        reset.run(row.namespace, row.key);
      }
      const root = this.#db.prepare("SELECT namespace,key FROM graph_nodes WHERE removed=0 AND degree=0 LIMIT 1");
      const remove = this.#db.prepare("UPDATE graph_nodes SET removed=1 WHERE namespace=? AND key=?");
      const children = this.#db.prepare("SELECT target FROM graph_edges WHERE namespace=? AND source=?");
      const decrement = this.#db.prepare("UPDATE graph_nodes SET degree=degree-1 WHERE namespace=? AND key=?");
      for (let row = root.get(); row !== undefined; row = root.get()) {
        this.#check();
        remove.run(row.namespace, row.key);
        for (const child of children.iterate(row.namespace, row.key)) {
          this.#check();
          decrement.run(row.namespace, child.target);
        }
      }
      if (this.#db.prepare("SELECT 1 FROM graph_nodes WHERE removed=0 LIMIT 1").get()) {
        throw new PortableTransferError("unsupported-capability");
      }
    });
  }

  /** Bound reconstructed JSON arrays without keeping owner counters in memory. */
  consumeBudget(namespace: string, key: string, bytes: number, maxBytes: number): void {
    this.#check();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || Object.is(bytes, -0)
      || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || Object.is(maxBytes, -0)) {
      throw new PortableTransferError("invalid-input");
    }
    this.#metadata(namespace, key);
    this.#sql(() => {
      const row = this.#db.prepare("SELECT used FROM budgets WHERE namespace=? AND key=?").get(namespace, key);
      const used = row === undefined ? 0 : row.used as number;
      // Subtract before adding so safe integer overflow cannot bypass the cap.
      if (used > maxBytes || bytes > maxBytes - used) throw new PortableTransferError("unsupported-capability");
      this.#db.prepare(`INSERT INTO budgets(namespace,key,used) VALUES(?,?,?)
        ON CONFLICT(namespace,key) DO UPDATE SET used=excluded.used`).run(namespace, key, used + bytes);
    });
  }

  addConversation(input: Readonly<{
    locator: string; headerOrder: readonly PortableOrderScalar[]; closureSha256: string;
  }>): void {
    this.#check();
    if (this.#conversationsFinalized || input.headerOrder.length !== 5 || !hash(input.closureSha256)) {
      throw new PortableTransferError("invalid-input");
    }
    this.#metadata(input.locator, input.headerOrder);
    const header = encodePortableIndexOrder(input.headerOrder);
    this.#sql(() => this.#db.prepare("INSERT INTO conversations(locator,header,closure_sha) VALUES(?,?,?)")
      .run(input.locator, header, input.closureSha256));
  }

  async finalizeConversations(equalClosures: (leftLocator: string, rightLocator: string) => Promise<boolean>): Promise<void> {
    this.#check();
    let previous: { header: Buffer; closure: string; locator: string } | undefined;
    let occurrence = 0;
    // The covering index provides order directly: no whole-corpus JS grouping or SQL sort.
    try {
      for (const row of this.#db.prepare("SELECT locator,header,closure_sha FROM conversations ORDER BY header,closure_sha,locator").iterate()) {
        this.#check();
        const header = Buffer.from(row.header as Uint8Array);
        const locator = row.locator as string;
        const closure = row.closure_sha as string;
        if (previous === undefined || !header.equals(previous.header)) occurrence = 0;
        else if (closure === previous.closure && !await equalClosures(previous.locator, locator)) {
          throw new PortableTransferError("invalid-input");
        }
        this.#check();
        this.#sql(() => this.#db.prepare("UPDATE conversations SET occurrence=? WHERE locator=?").run(occurrence++, locator));
        previous = { header, closure, locator };
      }
      this.#conversationsFinalized = true;
    } catch (error) {
      this.#failed = true;
      if (error instanceof PortableTransferError) throw new PortableTransferError(error.code, error.retryable);
      throw new PortableTransferError("source-failed");
    }
  }

  conversation(locator: string): Readonly<{ occurrenceOrdinal: number }> | null {
    return this.#sql(() => {
      if (!this.#conversationsFinalized) throw new PortableTransferError("invalid-input");
      const row = this.#db.prepare("SELECT occurrence FROM conversations WHERE locator=?").get(locator);
      return row === undefined ? null : { occurrenceOrdinal: row.occurrence as number };
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#db.close();
    } catch {
      throw new PortableTransferError("close-failed");
    } finally {
      try {
        rmSync(this.#directory, { recursive: true, force: true });
      } catch {
        throw new PortableTransferError("close-failed");
      }
    }
  }
}

export function createPortableIndex(options: PortableIndexOptions = {}): PortableIndex {
  return new PortableIndex(options);
}
