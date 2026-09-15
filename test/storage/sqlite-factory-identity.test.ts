import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeLcmConnection,
  isLcmConnectionOpen,
} from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import {
  ensurePendingMachineIdentity,
  recoverMachineIdentity,
  type MachineIdentity,
} from "../../src/machine-identity.js";
import {
  adoptMigrationReceiptEpoch,
  getMigrationReceiptEpoch,
  MIGRATION_RECEIPT_EPOCHS_DDL,
  MIGRATION_RECEIPT_EVENTS_DDL,
} from "../../src/migration/receipts.js";
import * as publication from "../../src/storage/backend-publication.js";
import { LocalHookEventSequenceAllocator } from "../../src/storage/local-hook-event-sequence.js";
import { SqliteStorageBackendFactory } from "../../src/storage/sqlite/factory.js";

const PROJECT_ID = "a".repeat(64);
const MACHINE_ID = "018f0b5d-1234-7abc-8def-1234567890ab";
const OTHER_MACHINE_ID = "118f0b5d-1234-7abc-8def-1234567890ab";

type FactoryFixture = ReturnType<typeof factoryFixture>;

function factoryFixture(options: { existing?: boolean } = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), "lcm-sqlite-factory-identity-"));
  const projectDirectory = join(homeDir, ".lcm", "projects", PROJECT_ID);
  mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
  const dbPath = join(projectDirectory, "db.sqlite");
  if (options.existing !== false) {
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    db.close();
    chmodSync(dbPath, 0o644);
  }
  const identity = { id: PROJECT_ID, canonical: homeDir };
  const createFactory = (
    factoryOptions: ConstructorParameters<typeof SqliteStorageBackendFactory>[0] = {},
  ) => new SqliteStorageBackendFactory({
    resolveProject: () => ({ id: PROJECT_ID, dbPath }),
    ...factoryOptions,
  });
  return { homeDir, projectDirectory, dbPath, identity, createFactory };
}

function withDatabase<T>(context: FactoryFixture, callback: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(context.dbPath);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function machinePath(context: FactoryFixture): string {
  return join(context.homeDir, ".lcm", "machine.json");
}

function writePrivateMachine(context: FactoryFixture, content: string): void {
  mkdirSync(join(context.homeDir, ".lcm"), { recursive: true, mode: 0o700 });
  writeFileSync(machinePath(context), content, { mode: 0o600 });
}

function registerMachine(
  context: FactoryFixture,
  machineId = MACHINE_ID,
): MachineIdentity {
  const machine = {
    version: 1 as const,
    identityKey: `machine:${"d".repeat(64)}`,
    machineId,
    displayName: "Factory identity test",
  };
  recoverMachineIdentity(machine, { homeDir: context.homeDir });
  return machine;
}

type MachineState = "missing" | "corrupt" | "malformed" | "symlink" | "broad" | "pending";

function setMachineState(context: FactoryFixture, state: MachineState): void {
  if (state === "missing") return;
  if (state === "corrupt") {
    writePrivateMachine(context, "{not-json\n");
    return;
  }
  if (state === "malformed") {
    writePrivateMachine(context, '{"version":1,"identityKey":"bad","machineId":null,"displayName":"test"}\n');
    return;
  }
  if (state === "symlink") {
    const target = join(context.homeDir, "machine-target.json");
    writeFileSync(target, '{"version":1}\n', { mode: 0o600 });
    mkdirSync(join(context.homeDir, ".lcm"), { recursive: true, mode: 0o700 });
    symlinkSync(target, machinePath(context));
    return;
  }
  ensurePendingMachineIdentity("Factory identity test", context.homeDir);
  if (state === "broad") chmodSync(machinePath(context), 0o644);
}

function machineEvidence(context: FactoryFixture): { bytes: Buffer; mode: number } | null {
  if (!existsSync(machinePath(context))) return null;
  return {
    bytes: readFileSync(machinePath(context)),
    mode: statSync(machinePath(context)).mode & 0o777,
  };
}

function namespaceRows(context: FactoryFixture): readonly Record<string, unknown>[] {
  if (!existsSync(context.dbPath)) return [];
  return withDatabase(context, db => (
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
      .all() as Record<string, unknown>[]
  ).filter(row => (
    String(row.name).toLowerCase().startsWith("migration_receipt_v1_")
    || String(row.tbl_name).toLowerCase().startsWith("migration_receipt_v1_")
  )));
}

function enrollmentPaths(context: FactoryFixture) {
  return {
    outbox: join(context.homeDir, ".lcm", "events", `${PROJECT_ID}.db`),
    allocator: join(context.homeDir, ".lcm", "events", ".machine-sequence.sqlite"),
  };
}

function expectNoPreparation(context: FactoryFixture): void {
  const paths = enrollmentPaths(context);
  expect(existsSync(paths.outbox)).toBe(false);
  expect(existsSync(paths.allocator)).toBe(false);
}

function createEpoch(context: FactoryFixture, machineId = MACHINE_ID): void {
  withDatabase(context, db => {
    adoptMigrationReceiptEpoch(db, {
      projectId: PROJECT_ID,
      machineId,
      epochId: "018f0b5d-1234-7abc-8def-2234567890ab",
      firstMachineSequence: "0000000000000000001",
      establishedAt: "2026-09-14T12:00:00.000000Z",
    });
  });
}

function namespaceEvidence(context: FactoryFixture): string {
  const namespace = namespaceRows(context);
  const tableNames = new Set(namespace.filter(row => row.type === "table").map(row => row.name));
  return JSON.stringify({
    namespace,
    epochs: tableNames.has("migration_receipt_v1_epochs")
      ? withDatabase(context, db => db.prepare(
        "SELECT * FROM migration_receipt_v1_epochs ORDER BY project_id, machine_id",
      ).all())
      : null,
    events: tableNames.has("migration_receipt_v1_events")
      ? withDatabase(context, db => db.prepare(
        "SELECT * FROM migration_receipt_v1_events ORDER BY project_id, machine_id, machine_sequence",
      ).all())
      : null,
  });
}

async function expectRefused(context: FactoryFixture, factory = context.createFactory()): Promise<void> {
  try {
    const outcome = await factory.openProject(context.identity).then(
      async project => {
        await project.close();
        return { opened: true as const };
      },
      (error: unknown) => ({ opened: false as const, error }),
    );
    expect(outcome).toMatchObject({
      opened: false,
      error: { code: "STORAGE_INITIALIZATION_FAILED" },
    });
    expect(isLcmConnectionOpen(context.dbPath)).toBe(false);
  } finally {
    await factory.close();
  }
}

function configureNamespace(context: FactoryFixture, shape: string): void {
  withDatabase(context, db => {
    if (shape === "partial-epochs") db.exec(MIGRATION_RECEIPT_EPOCHS_DDL);
    else if (shape === "partial-events") db.exec(MIGRATION_RECEIPT_EVENTS_DDL);
    else if (shape === "view") {
      db.exec(`CREATE VIEW migration_receipt_v1_epochs AS SELECT 1; ${MIGRATION_RECEIPT_EVENTS_DDL}`);
    } else if (shape === "empty-canonical") {
      db.exec(`${MIGRATION_RECEIPT_EPOCHS_DDL}; ${MIGRATION_RECEIPT_EVENTS_DDL}`);
    } else if (shape === "namespace-index") {
      db.exec("CREATE TABLE ordinary(value TEXT); CREATE INDEX migration_receipt_v1_stray ON ordinary(value)");
    } else if (shape === "namespace-trigger") {
      db.exec(`CREATE TABLE ordinary(value TEXT);
        CREATE TRIGGER MIGRATION_RECEIPT_V1_Stray AFTER INSERT ON ordinary BEGIN SELECT 1; END`);
    } else if (shape === "target-trigger") {
      db.exec(`${MIGRATION_RECEIPT_EPOCHS_DDL}; ${MIGRATION_RECEIPT_EVENTS_DDL};
        CREATE TRIGGER ordinary_name AFTER INSERT ON migration_receipt_v1_epochs BEGIN SELECT 1; END`);
    } else if (shape === "user-index") {
      db.exec(`${MIGRATION_RECEIPT_EPOCHS_DDL}; ${MIGRATION_RECEIPT_EVENTS_DDL};
        CREATE INDEX ordinary_name ON migration_receipt_v1_epochs(established_at)`);
    } else {
      throw new Error(`unknown namespace shape: ${shape}`);
    }
  });
}

afterEach(() => {
  closeLcmConnection();
  vi.restoreAllMocks();
});

describe("SQLite factory optional identity enrollment", () => {
  it.each([
    ["openProject", "corrupt"],
    ["openProject", "malformed"],
    ["openProject", "symlink"],
    ["openProject", "broad"],
    ["openExistingProject", "corrupt"],
    ["openExistingProject", "malformed"],
    ["openExistingProject", "symlink"],
    ["openExistingProject", "broad"],
  ] as const)("lets %s open proven-unenrolled storage with %s optional identity", async (operation, state) => {
    const context = factoryFixture();
    const factory = context.createFactory();
    setMachineState(context, state);
    const before = machineEvidence(context);
    try {
      const project = await factory[operation](context.identity);
      expect(project).not.toBeNull();
      await project!.close();
      expect(machineEvidence(context)).toEqual(before);
      expect(namespaceRows(context)).toEqual([]);
      expectNoPreparation(context);
    } finally {
      await factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it("creates proven-unenrolled storage with corrupt optional identity", async () => {
    const context = factoryFixture({ existing: false });
    const factory = context.createFactory();
    setMachineState(context, "corrupt");
    const before = machineEvidence(context);
    try {
      const project = await factory.openProject(context.identity);
      await project.close();
      expect(machineEvidence(context)).toEqual(before);
      expect(namespaceRows(context)).toEqual([]);
      expectNoPreparation(context);
    } finally {
      await factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it.each(["missing", "pending"] as const)(
    "keeps a proven-unenrolled project unenrolled with %s identity", async state => {
      const context = factoryFixture();
      const factory = context.createFactory();
      setMachineState(context, state);
      const before = machineEvidence(context);
      try {
        const project = await factory.openProject(context.identity);
        await project.close();
        expect(machineEvidence(context)).toEqual(before);
        expect(namespaceRows(context)).toEqual([]);
        expectNoPreparation(context);
      } finally {
        await factory.close();
        rmSync(context.homeDir, { recursive: true, force: true });
      }
    },
  );

  it("automatically enrolls a valid registered identity and reopens its canonical autoindexes", async () => {
    const context = factoryFixture();
    const factory = context.createFactory();
    const machine = registerMachine(context);
    try {
      const first = await factory.openProject(context.identity);
      await first.close();
      const initialEpoch = withDatabase(context, db => getMigrationReceiptEpoch(db, PROJECT_ID, machine.machineId));
      expect(initialEpoch).not.toBeNull();
      expect(namespaceRows(context).filter(row => row.type === "index")).not.toEqual([]);

      const reopened = await factory.openExistingProject(context.identity);
      expect(reopened).not.toBeNull();
      await reopened!.close();
      expect(withDatabase(context, db => getMigrationReceiptEpoch(db, PROJECT_ID, machine.machineId)))
        .toEqual(initialEpoch);
    } finally {
      await factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it("propagates an oversized bounded identity read even when the namespace is absent", async () => {
    const context = factoryFixture();
    writePrivateMachine(context, "x".repeat(64 * 1024 + 1));
    try {
      await expectRefused(context);
      expect(namespaceRows(context)).toEqual([]);
      expectNoPreparation(context);
    } finally {
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });
});

describe("SQLite factory conservative receipt namespace", () => {
  it.each(["missing", "corrupt", "pending"] as const)(
    "refuses %s identity when a complete enrolled epoch exists", async state => {
      const context = factoryFixture();
      createEpoch(context);
      setMachineState(context, state);
      const before = namespaceEvidence(context);
      const identityBefore = machineEvidence(context);
      try {
        await expectRefused(context);
        expect(namespaceEvidence(context)).toBe(before);
        expect(machineEvidence(context)).toEqual(identityBefore);
        expectNoPreparation(context);
      } finally {
        rmSync(context.homeDir, { recursive: true, force: true });
      }
    },
  );

  it("reopens a matching enrolled epoch without moving it", async () => {
    const context = factoryFixture();
    registerMachine(context);
    createEpoch(context);
    const before = namespaceEvidence(context);
    const factory = context.createFactory();
    try {
      const project = await factory.openProject(context.identity);
      await project.close();
      expect(namespaceEvidence(context)).toBe(before);
    } finally {
      await factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it("refuses a conflicting registered identity without changing the enrolled epoch", async () => {
    const context = factoryFixture();
    registerMachine(context, OTHER_MACHINE_ID);
    createEpoch(context);
    const before = namespaceEvidence(context);
    const identityBefore = machineEvidence(context);
    try {
      await expectRefused(context);
      expect(namespaceEvidence(context)).toBe(before);
      expect(machineEvidence(context)).toEqual(identityBefore);
      expectNoPreparation(context);
    } finally {
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  const ambiguousShapes = [
    "partial-epochs",
    "partial-events",
    "view",
    "empty-canonical",
    "namespace-index",
    "namespace-trigger",
    "target-trigger",
    "user-index",
  ] as const;

  it.each(ambiguousShapes.flatMap(shape => (
    shape === "empty-canonical" ? ["missing", "corrupt", "pending"] as const : ["missing", "corrupt"] as const
  ).map(state => [shape, state] as const)))(
    "refuses %s receipt evidence with %s identity", async (shape, state) => {
      const context = factoryFixture();
      configureNamespace(context, shape);
      setMachineState(context, state);
      const before = namespaceEvidence(context);
      const identityBefore = machineEvidence(context);
      try {
        await expectRefused(context);
        expect(namespaceEvidence(context)).toBe(before);
        expect(machineEvidence(context)).toEqual(identityBefore);
        expectNoPreparation(context);
      } finally {
        rmSync(context.homeDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    "partial-epochs",
    "view",
    "namespace-index",
    "namespace-trigger",
    "target-trigger",
    "user-index",
  ] as const)("refuses registered identity against noncanonical %s before preparation", async shape => {
    const context = factoryFixture();
    configureNamespace(context, shape);
    registerMachine(context);
    const before = namespaceEvidence(context);
    const identityBefore = machineEvidence(context);
    try {
      await expectRefused(context);
      expect(namespaceEvidence(context)).toBe(before);
      expect(machineEvidence(context)).toEqual(identityBefore);
      expectNoPreparation(context);
    } finally {
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it("establishes the first epoch from canonical empty tables for a registered identity", async () => {
    const context = factoryFixture();
    configureNamespace(context, "empty-canonical");
    const machine = registerMachine(context);
    const factory = context.createFactory();
    try {
      const project = await factory.openProject(context.identity);
      await project.close();
      expect(withDatabase(context, db => getMigrationReceiptEpoch(db, PROJECT_ID, machine.machineId)))
        .not.toBeNull();
    } finally {
      await factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it("propagates failure from only the factory namespace query", async () => {
    const context = factoryFixture();
    setMachineState(context, "corrupt");
    const originalPrepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
      if (sql.includes("substr(lower(name), 1, 21)")) {
        throw new Error("factory namespace inspection failed");
      }
      return originalPrepare.call(this, sql);
    });
    try {
      await expectRefused(context);
      expect(namespaceRows(context)).toEqual([]);
      expectNoPreparation(context);
    } finally {
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it("rechecks namespace drift before enrollment preparation", async () => {
    const context = factoryFixture();
    registerMachine(context);
    const originalBarrier = publication.withBackendPublicationAppendBarrierAsync;
    vi.spyOn(publication, "withBackendPublicationAppendBarrierAsync").mockImplementationOnce(
      async (homeDir, callback, ...options) => originalBarrier(homeDir, token => {
        configureNamespace(context, "namespace-index");
        return callback(token);
      }, ...options),
    );
    const factory = context.createFactory();
    try {
      await expectRefused(context, factory);
      expect(namespaceRows(context).map(row => row.name)).toContain("migration_receipt_v1_stray");
      expectNoPreparation(context);
    } finally {
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it("rechecks late namespace drift before epoch adoption", async () => {
    const context = factoryFixture();
    registerMachine(context);
    const originalPeek = LocalHookEventSequenceAllocator.prototype.peekNextSequence;
    vi.spyOn(LocalHookEventSequenceAllocator.prototype, "peekNextSequence")
      .mockImplementationOnce(function () {
        const next = originalPeek.call(this);
        configureNamespace(context, "namespace-index");
        return next;
      });
    try {
      await expectRefused(context);
      expect(namespaceRows(context).map(row => row.name)).toContain("migration_receipt_v1_stray");
      expect(withDatabase(context, db => db.prepare(
        "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'migration_receipt_v1_epochs'",
      ).get())).toEqual({ count: 0 });
      const paths = enrollmentPaths(context);
      expect(existsSync(paths.outbox)).toBe(true);
      expect(existsSync(paths.allocator)).toBe(true);
    } finally {
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it("keeps explicit migration enrollment strict when machine.json is missing", async () => {
    const context = factoryFixture();
    const pending = ensurePendingMachineIdentity("Factory identity test", context.homeDir).identity;
    const intended = { ...pending, machineId: MACHINE_ID };
    rmSync(machinePath(context));
    const factory = context.createFactory({ _migrationEnrollmentIdentity: intended });
    try {
      await publication.withBackendPublicationConsumerLockAsync(context.homeDir, async token => {
        await expect(factory.openProject(context.identity, token)).rejects.toMatchObject({
          code: "STORAGE_INITIALIZATION_FAILED",
        });
      });
      expect(namespaceRows(context)).toEqual([]);
      expectNoPreparation(context);
    } finally {
      await factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });
});
