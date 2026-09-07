import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendPublicationCoordinator, backendPublicationCanonicalSha256 as hash, withBackendPublicationAppendBarrierAsync, type BackendPublicationDriver, type BackendMaintenanceJournal } from "../../src/storage/backend-publication.js";
import { authenticateSqliteSnapshotSourceBytes, captureSqliteSnapshotArtifact, type AuthenticatedSqliteSnapshotAuthority, type SqliteSnapshotArtifactWitness } from "../../src/migration/sqlite-snapshot.js";
import { adoptMigrationReceiptEpoch, recordMigrationReceipt, type MigrationReceiptEnvelope, type MigrationQueueRecord } from "../../src/migration/receipts.js";
import { withMigrationQueueEvidence, sealMigrationQueueEvidence, inspectAuthenticatedSqliteMigrationSnapshot, type MigrationReceiptReference } from "../../src/migration/queue-evidence.js";

const faults = vi.hoisted(() => ({
  inventory: false,
  failDescriptorStat: false,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (String(args[0]) === "/dev/fd") faults.inventory = true;
      return actual.readdirSync(...args);
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      if (faults.inventory && faults.failDescriptorStat) throw Object.assign(new Error("inventory stat failed"), { code: "EIO" });
      return actual.fstatSync(...args);
    },
  };
});

const MACHINE = "018f0b5d-1234-4abc-8def-1234567890ab";
const FOREIGN = "118f0b5d-1234-4abc-8def-1234567890ab";
const EPOCH = "218f0b5d-1234-4abc-8def-1234567890ab";
const PROJECT = "a".repeat(64);
const roots: string[] = [];
afterEach(() => { faults.inventory = false; faults.failDescriptorStat = false; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sequence = (value: number) => value.toString().padStart(19, "0");
function envelope(index = 0): MigrationReceiptEnvelope {
  return { eventUuid: `318f0b5d-1234-4abc-8def-${index.toString(16).padStart(12, "0")}`, eventVersion: 1,
    machineId: MACHINE, machineSequence: sequence(index), sessionId: "session", sessionSequence: index,
    type: "decision", category: "decision", data: "exact payload", priority: 1, sourceHook: "SessionStart", createdAt: "2026-09-07 03:04:05" };
}
function insertEvent(db: DatabaseSync, event: MigrationReceiptEnvelope, processed: string | null = null): void {
  db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    event.eventUuid, event.eventVersion, event.machineId, event.machineSequence, event.sessionId, event.sessionSequence,
    event.type, event.category, event.data, event.priority, event.sourceHook, processed, event.createdAt);
}
type SourceDatabases = { project: DatabaseSync; events: DatabaseSync; counter: DatabaseSync };
async function fixture(options: { count?: number; first?: number; noEvents?: boolean; scope?: "local" | "shared"; configure?: (dbs: SourceDatabases) => void } = {}) {
  const home = mkdtempSync(join(tmpdir(), "lcm-queue-evidence-")); roots.push(home);
  const lcm = join(home, ".lcm"); mkdirSync(lcm, { mode: 0o700 });
  const source = join(lcm, "source"); mkdirSync(source, { mode: 0o700 });
  const projectPath = join(source, "project.sqlite"); const eventPath = join(source, "events.sqlite"); const counterPath = join(source, "sequence.sqlite");
  const dbs = { project: new DatabaseSync(projectPath), events: new DatabaseSync(eventPath), counter: new DatabaseSync(counterPath) };
  const count = options.count ?? 1;
  try {
    adoptMigrationReceiptEpoch(dbs.project, { projectId: PROJECT, machineId: MACHINE, epochId: EPOCH,
      firstMachineSequence: sequence(options.first ?? 0), establishedAt: "2026-09-07T03:04:05.123456Z" });
    dbs.events.exec(`CREATE TABLE events (event_uuid TEXT, event_version INTEGER, machine_id TEXT, machine_sequence TEXT,
      session_id TEXT, seq INTEGER, type TEXT, category TEXT, data TEXT, priority INTEGER, source_hook TEXT, processed_at TEXT, created_at TEXT)`);
    dbs.counter.exec("CREATE TABLE local_hook_sequence (singleton INTEGER, next_sequence)");
    dbs.counter.prepare("INSERT INTO local_hook_sequence VALUES (1, ?)").run(String(count));
    dbs.events.exec("BEGIN");
    for (let index = 0; index < count; index++) insertEvent(dbs.events, envelope(index));
    dbs.events.exec("COMMIT");
    options.configure?.(dbs);
  } finally { dbs.project.close(); dbs.events.close(); dbs.counter.close(); }
  for (const path of [projectPath, eventPath, counterPath]) chmodSync(path, 0o600);
  const body = { version: 1 as const, physicalProjectId: PROJECT, projectIdentity: { scope: options.scope ?? "local", projectId: "project" },
    canonicalPath: join(home, "worktree"), aliases: [], projectDbPath: projectPath, passiveEventsDbPath: options.noEvents ? null : eventPath,
    machineSequenceDbPath: counterPath, machineIdentity: { identityKey: `machine:${PROJECT}`, machineId: MACHINE },
    machineIdentitySha256: PROJECT, projectMapSha256: PROJECT, projectMapEntrySha256: PROJECT, projectMetadataSha256: PROJECT };
  const authority: AuthenticatedSqliteSnapshotAuthority = { ...body, sourceSelectionSha256: hash(body) };
  const bytes = await withBackendPublicationAppendBarrierAsync(home, (lockToken) => authenticateSqliteSnapshotSourceBytes(authority, { homeDir: home, lockToken }));
  const unexpected = async (): Promise<never> => { throw new Error("unexpected v2 driver"); };
  const driver: BackendPublicationDriver = { observeLocalState: unexpected, publishProjectMap: unexpected, publishConfig: unexpected,
    restoreConfig: unexpected, restoreProjectMap: unexpected };
  const maintenance = await new BackendPublicationCoordinator({ homeDir: home, driver }).enterMaintenance({
    publicationId: "publication", generationId: "generation-1", sourceSelectionSha256: authority.sourceSelectionSha256,
    queueEvidenceSha256: bytes.checksumSha256, roster: [{ machineId: MACHINE, queueCutoff: count === 0 ? null : sequence(count - 1), evidenceSha256: bytes.checksumSha256 }],
  });
  const artifact = await captureSqliteSnapshotArtifact(authority, { homeDir: home, generationId: "generation-1",
    maintenanceChecksumSha256: maintenance.checksumSha256, expectedSourceBytes: bytes });
  return { home, artifact, maintenance };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const read = (input: Fixture) => withMigrationQueueEvidence(input.home, input.artifact, input.maintenance,
  async (reference, records) => ({ reference, records: [...records] }));
async function seal(input: Fixture, revalidate = () => undefined) {
  const evidence = await read(input);
  return sealMigrationQueueEvidence(input.home, input.artifact, evidence.reference, evidence.records, revalidate);
}
const directory = (input: Fixture) => join(input.home, ".lcm", "migration-evidence", "generation-1");
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableWitness = { version: number; artifact: SqliteSnapshotArtifactWitness; receiptReference: Mutable<MigrationReceiptReference>;
  pages: { name: string; sha256: string; records: number; dev: string; ino: string }[];
  evidenceDirectory: { dev: string; ino: string }; checksumSha256: string };
function rewriteWitness(input: Fixture, change: (witness: MutableWitness) => void, checksum = true): void {
  const path = join(directory(input), "witness.json"); const value = JSON.parse(readFileSync(path, "utf8")) as MutableWitness;
  change(value); const { checksumSha256: _old, ...body } = value;
  if (checksum) value.checksumSha256 = hash(body);
  chmodSync(path, 0o600); writeFileSync(path, JSON.stringify(value)); chmodSync(path, 0o400);
}

describe("immutable migration queue evidence", () => {
  it("streams exact represented and retained records and authenticates retries", async () => {
    const input = await fixture({ count: 3, configure: ({ project, events }) => {
      project.exec("BEGIN IMMEDIATE");
      for (const index of [0, 1]) recordMigrationReceipt(project, { projectId: PROJECT, epochId: EPOCH, envelope: envelope(index),
        effectWitness: index === 0 ? { version: 1, outcome: "applied", promotedMemoryId: "memory" }
          : { version: 1, outcome: "no-effect", reason: "unreinforced-pattern" }, committedAt: "2026-09-07T03:05:06.123456Z" });
      project.exec("COMMIT"); events.exec("UPDATE events SET processed_at = 'processed' WHERE seq = 0");
    } });
    const evidence = await read(input);
    expect(evidence.records.map((record) => record.disposition)).toEqual(["represented", "represented", "retained"]);
    expect(evidence.records.map((record) => record.receiptChecksumSha256 === null)).toEqual([false, false, true]);
    const result = await seal(input); expect(result.receiptReference.queueSetSha256).toBe(hash(evidence.records));
    expect(await inspectAuthenticatedSqliteMigrationSnapshot("generation-1", input.home)).toEqual(result);
    expect(await seal(input)).toEqual(result);
  });
  it("seals empty input when the enrolled database is present", async () => {
    const input = await fixture({ count: 0 }); const result = await seal(input);
    expect(result.pages).toEqual([]); expect(result.receiptReference.queueCutoff).toBeNull();
    expect(result.receiptReference.queueSetSha256).toBe(hash([]));
  });
  it("refuses an absent enrolled database before evidence consumption", async () => {
    const input = await fixture({ count: 0, noEvents: true });
    const consume = vi.fn(async () => undefined);
    await expect(withMigrationQueueEvidence(
      input.home,
      input.artifact,
      input.maintenance,
      consume,
    )).rejects.toThrow("enrolled canonical outbox is missing");
    expect(consume).not.toHaveBeenCalled();
  });
  it("streams at least 129 ordered records into bounded pages", async () => {
    const input = await fixture({ count: 129 }); const evidence = await read(input); const result = await seal(input);
    expect(result.pages.map((page) => page.records)).toEqual([128, 1]);
    expect(result.receiptReference.queueSetSha256).toBe(hash(evidence.records));
    expect(evidence.records[128]!.machineSequence).toBe(sequence(128));
  });
  it.each([null, "processed"])("refuses ambiguous legacy input with processed_at=%s", async (processed) => {
    const input = await fixture({ first: 1, configure: ({ events }) => { events.prepare("UPDATE events SET processed_at = ?").run(processed); } });
    await expect(read(input)).rejects.toThrow("legacy-effect-ambiguous");
  });
  it("refuses a processed receipt-era row without an atomic receipt", async () => {
    const input = await fixture({ configure: ({ events }) => { events.exec("UPDATE events SET processed_at = 'processed'"); } });
    await expect(read(input)).rejects.toThrow("processed-without-receipt");
  });
  it.each([
    "DELETE FROM local_hook_sequence", "INSERT INTO local_hook_sequence VALUES (2, '1')", "UPDATE local_hook_sequence SET singleton=2",
    "UPDATE local_hook_sequence SET next_sequence=1", "UPDATE local_hook_sequence SET next_sequence='01'",
    "UPDATE local_hook_sequence SET next_sequence='9223372036854775809'",
  ])("refuses malformed immutable counter: %s", async (sql) => {
    const input = await fixture({ configure: ({ counter }) => { counter.exec(sql); } });
    await expect(read(input)).rejects.toThrow("cutoff is malformed");
  });
  it("refuses a maintenance cutoff differing from the actual private counter", async () => {
    const input = await fixture({ configure: ({ counter }) => { counter.exec("UPDATE local_hook_sequence SET next_sequence='2'"); } });
    await expect(read(input)).rejects.toThrow("cutoff differs");
  });
  it.each([
    "UPDATE events SET machine_id=NULL", `UPDATE events SET machine_id='${FOREIGN}'`, "UPDATE events SET machine_sequence=NULL",
    "UPDATE events SET machine_sequence='1'", "UPDATE events SET machine_sequence='000000000000000000x'", "UPDATE events SET machine_sequence='0000000000000000001'",
  ])("refuses unknown or unsealed queue identities: %s", async (sql) => {
    const input = await fixture({ configure: ({ events }) => { events.exec(sql); } });
    await expect(read(input)).rejects.toThrow("unknown identity or unsealed sequence");
  });
  it.each(["duplicate UUID", "duplicate sequence", "oversized"])("refuses %s queue rows", async (kind) => {
    const input = await fixture({ count: 2, configure: ({ events }) => {
      events.exec(kind === "duplicate UUID" ? "UPDATE events SET event_uuid=(SELECT event_uuid FROM events LIMIT 1)"
        : kind === "duplicate sequence" ? "UPDATE events SET machine_sequence='0000000000000000000'"
          : "UPDATE events SET data=zeroblob(1048577)");
    } });
    await expect(read(input)).rejects.toThrow(kind === "duplicate sequence" ? "sequence is duplicated" : "malformed or oversized");
  });
  it("refuses missing receipt epochs", async () => {
    const input = await fixture({ configure: ({ project }) => { project.exec("DELETE FROM migration_receipt_v1_epochs"); } });
    await expect(read(input)).rejects.toThrow("epoch is missing");
  });
  it("refuses receipts from an uncovered participant", async () => {
    const input = await fixture({ configure: ({ project }) => { project.prepare("UPDATE migration_receipt_v1_epochs SET machine_id=?").run(FOREIGN); } });
    await expect(read(input)).rejects.toThrow("uncovered participant");
  });
  it("refuses receipts beyond the sealed cutoff", async () => {
    const input = await fixture({ configure: ({ project }) => {
      project.exec("BEGIN IMMEDIATE"); recordMigrationReceipt(project, { projectId: PROJECT, epochId: EPOCH, envelope: envelope(1),
        effectWitness: { version: 1, outcome: "no-effect", reason: "unreinforced-pattern" }, committedAt: "2026-09-07T03:05:06.123456Z" }); project.exec("COMMIT");
    } });
    await expect(read(input)).rejects.toThrow("beyond the sealed cutoff");
  });
  it.each(["shared", "roster", "machine", "evidence", "selection", "maintenance"])("refuses incomplete %s authority", async (kind) => {
    const input = await fixture(kind === "shared" ? { scope: "shared" } : {}); let artifact = input.artifact; let maintenance: BackendMaintenanceJournal = input.maintenance;
    if (kind === "shared") artifact = { ...artifact, authority: { ...artifact.authority, projectIdentity: { scope: "shared", projectId: "project" } } };
    else if (kind === "roster") maintenance = { ...maintenance, roster: [] };
    else if (kind === "selection") maintenance = { ...maintenance, sourceSelectionSha256: "f".repeat(64) };
    else if (kind === "maintenance") maintenance = { ...maintenance, checksumSha256: "f".repeat(64) };
    else maintenance = { ...maintenance, roster: [{ ...maintenance.roster[0]!, ...(kind === "machine" ? { machineId: FOREIGN } : { evidenceSha256: "f".repeat(64) }) }] };
    await expect(withMigrationQueueEvidence(input.home, artifact, maintenance, async () => undefined)).rejects.toThrow("incomplete or disconnected");
  });
  it("preserves partial evidence and refuses retry after authority drift", async () => {
    const input = await fixture();
    await expect(seal(input, () => { throw new Error("authority changed"); })).rejects.toThrow("authority changed");
    expect(readdirSync(directory(input))).toEqual(["000000.json"]);
    await expect(seal(input)).rejects.toThrow();
  });
  it("refuses retry with conflicting queue commitments", async () => {
    const input = await fixture(); await seal(input); const evidence = await read(input);
    await expect(sealMigrationQueueEvidence(input.home, input.artifact, evidence.reference, [], () => undefined)).rejects.toThrow("retry identity conflict");
  });
  it.each([
    ["version", (value: MutableWitness) => { value.version = 2; }],
    ["checksum", (value: MutableWitness) => { value.checksumSha256 = "f".repeat(64); }],
    ["artifact", (value: MutableWitness) => { value.artifact = { ...value.artifact, capturedAt: "changed" }; }],
    ["directory device", (value: MutableWitness) => { value.evidenceDirectory.dev = "0"; }],
    ["directory inode", (value: MutableWitness) => { value.evidenceDirectory.ino = "0"; }],
    ["page count", (value: MutableWitness) => { value.pages = Array.from({ length: 783 }, () => value.pages[0]!); }],
  ] as const)("rejects a tampered witness %s", async (name, change) => {
    const input = await fixture(); await seal(input); rewriteWitness(input, change, name !== "checksum");
    await expect(inspectAuthenticatedSqliteMigrationSnapshot("generation-1", input.home)).rejects.toThrow("witness is invalid");
  });
  it.each([
    ["name", (page: MutableWitness["pages"][number]) => { page.name = "../escape"; }],
    ["empty", (page: MutableWitness["pages"][number]) => { page.records = 0; }],
    ["oversized", (page: MutableWitness["pages"][number]) => { page.records = 129; }],
  ] as const)("rejects a malformed page reference %s", async (_name, change) => {
    const input = await fixture(); await seal(input); rewriteWitness(input, (value) => change(value.pages[0]!));
    await expect(inspectAuthenticatedSqliteMigrationSnapshot("generation-1", input.home)).rejects.toThrow("page reference is invalid");
  });
  it.each(["bytes", "device", "inode", "version", "artifact", "ordinal", "records"])("rejects changed page %s", async (kind) => {
    const input = await fixture(); await seal(input);
    if (kind === "device" || kind === "inode") rewriteWitness(input, (value) => { value.pages[0]![kind === "device" ? "dev" : "ino"] = "0"; });
    else {
      const path = join(directory(input), "000000.json");
      const page = JSON.parse(readFileSync(path, "utf8")) as { version: number; artifactSha256: string; ordinal: number; records: MigrationQueueRecord[] };
      if (kind === "version") page.version = 2;
      else if (kind === "artifact") page.artifactSha256 = "f".repeat(64);
      else if (kind === "ordinal") page.ordinal = 1;
      else page.records = [];
      chmodSync(path, 0o600); writeFileSync(path, JSON.stringify(page)); chmodSync(path, 0o400);
      if (kind !== "bytes") rewriteWitness(input, (value) => { value.pages[0]!.sha256 = hash(page); });
    }
    await expect(inspectAuthenticatedSqliteMigrationSnapshot("generation-1", input.home)).rejects.toThrow("page is invalid");
  });
  it.each(["unexpected file", "queue hash", "artifact hash", "maintenance hash"])("rejects evidence root with %s", async (kind) => {
    const input = await fixture(); await seal(input);
    if (kind === "unexpected file") writeFileSync(join(directory(input), "extra"), "foreign");
    else rewriteWitness(input, (value) => { value.receiptReference[kind === "queue hash" ? "queueSetSha256" : kind === "artifact hash" ? "sourceArtifactSha256" : "maintenanceChecksumSha256"] = "f".repeat(64); });
    await expect(inspectAuthenticatedSqliteMigrationSnapshot("generation-1", input.home)).rejects.toThrow("root is invalid");
  });
  it.each(["directory", "page"])("rejects a byte-identical replaced evidence %s", async (kind) => {
    const input = await fixture(); await seal(input);
    const path = kind === "directory" ? directory(input) : join(directory(input), "000000.json");
    renameSync(path, `${path}.owned`);
    if (kind === "directory") {
      mkdirSync(path, { mode: 0o700 });
      for (const name of readdirSync(`${path}.owned`)) writeFileSync(join(path, name), readFileSync(join(`${path}.owned`, name)), { mode: 0o400 });
    } else writeFileSync(path, readFileSync(`${path}.owned`), { mode: 0o400 });
    await expect(inspectAuthenticatedSqliteMigrationSnapshot("generation-1", input.home)).rejects.toThrow(kind === "directory" ? "witness is invalid" : "page is invalid");
    expect(readFileSync(kind === "directory" ? join(`${path}.owned`, "witness.json") : `${path}.owned`)).toBeTruthy();
  });
  it("refuses more than 100000 source queue rows before iterating envelopes", async () => {
    const input = await fixture({ count: 0, configure: ({ events }) => {
      events.exec("WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<100000) INSERT INTO events(event_uuid) SELECT CAST(x AS TEXT) FROM n");
    } });
    await expect(read(input)).rejects.toThrow("bounded row capacity");
  });
  it("refuses a record exceeding its serialized byte limit", async () => {
    const input = await fixture(); const evidence = await read(input);
    const record = { ...evidence.records[0]!, eventUuid: "x".repeat(128 * 1024) };
    await expect(sealMigrationQueueEvidence(input.home, input.artifact, evidence.reference, [record], () => undefined)).rejects.toThrow("record exceeds bound");
    expect(readdirSync(directory(input))).toEqual([]);
  });
  it("refuses more than the bounded record capacity without publishing a witness", async () => {
    const input = await fixture(); const evidence = await read(input);
    function* records() { for (let index = 0; index < 783 * 128; index++) yield { ...evidence.records[0]!, eventUuid: envelope(index).eventUuid, machineSequence: sequence(index) }; }
    await expect(sealMigrationQueueEvidence(input.home, input.artifact, evidence.reference, records(), () => undefined)).rejects.toThrow("record exceeds bound");
    expect(readdirSync(directory(input))).toHaveLength(781);
    expect(() => readFileSync(join(directory(input), "witness.json"))).toThrow();
  }, 30_000);
  it("propagates evidence root creation failures", async () => {
    const input = await fixture(); const evidence = await read(input);
    const blocked = join(input.home, "blocked"); writeFileSync(blocked, "not a directory");
    await expect(sealMigrationQueueEvidence(blocked, input.artifact, evidence.reference, [], () => undefined)).rejects.toThrow();
  });
  it("refuses a mismatched source artifact at the final readback", async () => {
    const input = await fixture(); const evidence = await read(input);
    await expect(sealMigrationQueueEvidence(input.home, { ...input.artifact, checksumSha256: "f".repeat(64) }, evidence.reference,
      evidence.records, () => undefined)).rejects.toThrow("artifact changed before evidence seal");
    expect(() => readFileSync(join(directory(input), "witness.json"))).toThrow();
  });

  it.each(["epochId", "projectId", "machineId", "receiptSetSha256", "receiptSchemaSha256", "firstMachineSequence", "epochChecksumSha256"] as const)("refuses a rechecksummed forged receipt reference %s", async (field) => {
    const input = await fixture(); await seal(input);
    rewriteWitness(input, (value) => { value.receiptReference[field] = "forged"; });
    await expect(inspectAuthenticatedSqliteMigrationSnapshot("generation-1", input.home)).rejects.toThrow("differs from immutable receipt and queue authority");
  });
  it("refuses rechecksummed represented disposition without immutable receipt evidence", async () => {
    const input = await fixture(); await seal(input);
    const path = join(directory(input), "000000.json");
    const page = JSON.parse(readFileSync(path, "utf8")) as { records: MigrationQueueRecord[] };
    page.records[0] = { ...page.records[0]!, disposition: "represented", receiptChecksumSha256: "f".repeat(64) };
    chmodSync(path, 0o600); writeFileSync(path, JSON.stringify(page)); chmodSync(path, 0o400);
    rewriteWitness(input, (value) => { value.pages[0]!.sha256 = hash(page); value.receiptReference.queueSetSha256 = hash(page.records); });
    await expect(inspectAuthenticatedSqliteMigrationSnapshot("generation-1", input.home)).rejects.toThrow("differs from immutable receipt and queue authority");
  });
  it("refuses a supplied artifact with altered authority before reading SQLite", async () => {
    const input = await fixture();
    await expect(withMigrationQueueEvidence(input.home, { ...input.artifact, capturedAt: "forged" }, input.maintenance,
      async () => undefined)).rejects.toThrow("artifact authority is invalid");
  });
  it("refuses oversized page serialization even with each record individually bounded", async () => {
    const input = await fixture(); const evidence = await read(input);
    const base = evidence.records[0]!;
    const size = Buffer.byteLength(JSON.stringify(base));
    const records = Array.from({ length: 128 }, (_, index) => ({ ...base,
      eventUuid: envelope(index).eventUuid + "x".repeat(1024 - size) }));
    await expect(sealMigrationQueueEvidence(input.home, input.artifact, evidence.reference, records, () => undefined)).rejects.toThrow("page exceeds byte bound");
  });

  it("refuses artifact authority mutation while consuming evidence", async () => {
    const input = await fixture();
    await expect(withMigrationQueueEvidence(input.home, input.artifact, input.maintenance, async (_reference, records) => {
      expect([...records]).toHaveLength(1);
      Object.assign(input.artifact, { checksumSha256: "f".repeat(64) });
    })).rejects.toThrow("artifact changed during evidence read");
  });

  it.each(["generation", "root"])("preserves a replaced evidence %s at final authority validation", async (target) => {
    const input = await fixture(); let replaced = false; let sentinel: string | undefined;
    await expect(seal(input, () => {
      if (replaced) return;
      replaced = true;
      const path = target === "generation" ? directory(input) : join(directory(input), "..");
      renameSync(path, `${path}.owned`); mkdirSync(path, { mode: 0o700 });
      sentinel = join(path, "sentinel"); writeFileSync(sentinel, "unrelated", { mode: 0o600 });
    })).rejects.toThrow();
    expect(readFileSync(sentinel!, "utf8")).toBe("unrelated");
  });

  it("authenticates the actual immutable SQLite handle across an open ABA swap", async () => {
    const input = await fixture();
    const source = input.artifact.authority.projectDbPath;
    const originalBytes = readFileSync(source);
    let injected = false;
    const openDatabase = (uri: string) => {
      const open = () => new DatabaseSync(uri, { readOnly: true });
      if (injected) return open();
      injected = true;
      const path = fileURLToPath(uri);
      renameSync(path, `${path}.owned`);
      writeFileSync(path, originalBytes, { mode: 0o400 });
      const database = open();
      rmSync(path); renameSync(`${path}.owned`, path);
      return database;
    };
    await expect(withMigrationQueueEvidence(input.home, input.artifact, input.maintenance, async (_reference, records) => [...records],
      { openDatabase })).rejects.toThrow("immutable reader opened a replaced artifact");
    expect(injected).toBe(true);
    expect(readFileSync(source)).toEqual(originalBytes);
    expect(readdirSync(join(source, "..")).filter((name) => name.endsWith("-wal") || name.endsWith("-shm"))).toEqual([]);
  });
  it("fails closed on non-EBADF process descriptor inventory errors", async () => {
    const input = await fixture();
    faults.inventory = false;
    faults.failDescriptorStat = true;
    await expect(read(input)).rejects.toThrow("inventory stat failed");
    expect(faults.inventory).toBe(true);
  });

  it("refuses ambiguous descriptor inventory and closes the opened immutable reader", async () => {
    const input = await fixture(); let database: DatabaseSync | undefined;
    await expect(withMigrationQueueEvidence(input.home, input.artifact, input.maintenance, async () => undefined, {
      descriptors: () => [],
      openDatabase: (uri) => { database = new DatabaseSync(uri, { readOnly: true }); return database; },
    })).rejects.toThrow("immutable reader opened a replaced artifact");
    expect(() => database!.prepare("SELECT 1")).toThrow();
  });
  it.each(["witness", "directory", "page reference", "page content", "fractional records"])("refuses noncanonical %s shape even after rechecksumming", async (kind) => {
    const input = await fixture(); await seal(input);
    if (kind === "page content") {
      const path = join(directory(input), "000000.json");
      const content = { ...JSON.parse(readFileSync(path, "utf8")), extra: true };
      chmodSync(path, 0o600); writeFileSync(path, JSON.stringify(content)); chmodSync(path, 0o400);
      rewriteWitness(input, (value) => { value.pages[0]!.sha256 = hash(content); });
    } else rewriteWitness(input, (value) => {
      if (kind === "witness") Object.assign(value, { extra: true });
      else if (kind === "directory") Object.assign(value.evidenceDirectory, { extra: true });
      else if (kind === "page reference") Object.assign(value.pages[0]!, { extra: true });
      else value.pages[0]!.records = 1.5;
    });
    await expect(inspectAuthenticatedSqliteMigrationSnapshot("generation-1", input.home)).rejects.toThrow("invalid");
  });

});
