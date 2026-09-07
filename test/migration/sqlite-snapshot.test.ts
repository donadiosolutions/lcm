import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackendPublicationCoordinator,
  backendPublicationCanonicalSha256,
  withBackendPublicationAppendBarrierAsync,
  withBackendPublicationConsumerLockAsync,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import {
  captureSqliteSnapshotArtifact,
  authenticateSqliteSnapshotCaptureBinding,
  classifySqliteSnapshotArtifact,
  authenticateSqliteSnapshotSourceBytes,
  dryRunSqliteSnapshotArtifact,
  inspectSqliteSnapshotArtifact,
  SqliteSnapshotError,
  type AuthenticatedSqliteSnapshotAuthority,
  type SqliteSnapshotOperations,
  type SqliteSnapshotSourceByteWitness,
} from "../../src/migration/sqlite-snapshot.js";

const HASH = "a".repeat(64);
const MACHINE_ID = "018f0b5d-1234-4abc-8def-1234567890ab";
const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    try { database.close(); } catch { /* already closed by a test */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function createWalDatabase(path: string, table: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE ${table} (value TEXT NOT NULL); INSERT INTO ${table} VALUES ('captured')`);
  chmodSync(path, 0o600);
  chmodSync(`${path}-wal`, 0o600);
  chmodSync(`${path}-shm`, 0o600);
  databases.push(database);
  return database;
}

function coordinator(homeDir: string): BackendPublicationCoordinator {
  const unexpected = async (): Promise<never> => { throw new Error("v2 driver must not run"); };
  const driver: BackendPublicationDriver = {
    observeLocalState: unexpected,
    publishProjectMap: unexpected,
    publishConfig: unexpected,
    restoreConfig: unexpected,
    restoreProjectMap: unexpected,
  };
  return new BackendPublicationCoordinator({ homeDir, driver });
}

function sourceFixture(): Readonly<{
  homeDir: string;
  authority: AuthenticatedSqliteSnapshotAuthority;
  openDatabases: readonly DatabaseSync[];
}> {
  const homeDir = mkdtempSync(join(tmpdir(), "lcm-snapshot-v1-"));
  roots.push(homeDir);
  privateDirectory(join(homeDir, ".lcm"));
  const sourceDir = join(homeDir, ".lcm", "source");
  privateDirectory(sourceDir);
  const projectDbPath = join(sourceDir, "project.sqlite");
  const passiveEventsDbPath = join(sourceDir, "events.sqlite");
  const machineSequenceDbPath = join(sourceDir, "sequence.sqlite");
  const openDatabases = [
    createWalDatabase(projectDbPath, "project_data"),
    createWalDatabase(passiveEventsDbPath, "event_data"),
    createWalDatabase(machineSequenceDbPath, "sequence_data"),
  ];
  const body = {
    version: 1 as const,
    physicalProjectId: "physical-project",
    projectIdentity: { scope: "local" as const, projectId: "project-1" },
    canonicalPath: join(homeDir, "worktree"),
    aliases: [join(homeDir, "alias-a"), join(homeDir, "alias-b")] as const,
    projectDbPath,
    passiveEventsDbPath,
    machineSequenceDbPath,
    machineIdentity: { identityKey: `machine:${HASH}`, machineId: MACHINE_ID },
    machineIdentitySha256: HASH,
    projectMapSha256: "b".repeat(64),
    projectMapEntrySha256: "c".repeat(64),
    projectMetadataSha256: "d".repeat(64),
  };
  return {
    homeDir,
    authority: { ...body, sourceSelectionSha256: backendPublicationCanonicalSha256(body) },
    openDatabases,
  };
}

function maintenanceInput(authority: AuthenticatedSqliteSnapshotAuthority, generationId = "generation-1") {
  return {
    publicationId: "snapshot-publication",
    generationId,
    sourceSelectionSha256: authority.sourceSelectionSha256,
    queueEvidenceSha256: HASH,
    roster: [{ machineId: MACHINE_ID, queueCutoff: null, evidenceSha256: HASH }],
  } as const;
}

function withAuthority(
  authority: AuthenticatedSqliteSnapshotAuthority,
  updates: Partial<Omit<AuthenticatedSqliteSnapshotAuthority, "sourceSelectionSha256">>,
): AuthenticatedSqliteSnapshotAuthority {
  const { sourceSelectionSha256: _old, ...oldBody } = authority;
  const body = { ...oldBody, ...updates };
  return { ...body, sourceSelectionSha256: backendPublicationCanonicalSha256(body) };
}

function sourceState(authority: AuthenticatedSqliteSnapshotAuthority): unknown {
  const paths = [authority.projectDbPath, authority.passiveEventsDbPath!, authority.machineSequenceDbPath];
  return paths.map((path) => ({
    path,
    parentEntries: readdirSync(join(path, "..")).sort(),
    files: [path, `${path}-wal`, `${path}-shm`].map((file) => ({
      file,
      mode: statSync(file).mode & 0o7777,
      sha256: sha256(file),
    })),
  }));
}

function generationDirectory(homeDir: string): string {
  return join(homeDir, ".lcm", "migration-snapshots", "generations", "generation-1");
}

function checkedRecord(value: Record<string, unknown>): Record<string, unknown> {
  const { checksumSha256: _old, ...body } = value;
  return { ...body, checksumSha256: backendPublicationCanonicalSha256(body) };
}

function rewriteWitness(
  homeDir: string,
  mutate: (value: Record<string, unknown>) => void,
): void {
  const path = join(generationDirectory(homeDir), "witness.json");
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(value);
  writeFileSync(path, `${JSON.stringify(checkedRecord(value))}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function rewriteCheckedPath(path: string, mutate: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(value);
  writeFileSync(path, `${JSON.stringify(checkedRecord(value))}\n`, { mode: 0o600 });
}

async function heldFixture(): Promise<ReturnType<typeof sourceFixture> & Readonly<{
  maintenanceChecksumSha256: string;
  expectedSourceBytes: SqliteSnapshotSourceByteWitness;
}>> {
  const fixture = sourceFixture();
  return prepareFixture(fixture);
}

async function prepareFixture(fixture: ReturnType<typeof sourceFixture>): Promise<ReturnType<typeof sourceFixture> & Readonly<{
  maintenanceChecksumSha256: string;
  expectedSourceBytes: SqliteSnapshotSourceByteWitness;
}>> {
  const expectedSourceBytes = await withBackendPublicationAppendBarrierAsync(
    fixture.homeDir,
    (lockToken) => authenticateSqliteSnapshotSourceBytes(fixture.authority, { homeDir: fixture.homeDir, lockToken }),
  );
  const maintenance = await coordinator(fixture.homeDir).enterMaintenance({
    ...maintenanceInput(fixture.authority),
    queueEvidenceSha256: expectedSourceBytes.checksumSha256,
  });
  return { ...fixture, maintenanceChecksumSha256: maintenance.checksumSha256, expectedSourceBytes };
}

async function captureFixture(
  fixture: Awaited<ReturnType<typeof heldFixture>>,
  operations?: Partial<SqliteSnapshotOperations>,
) {
  return captureSqliteSnapshotArtifact(fixture.authority, {
    homeDir: fixture.homeDir,
    generationId: "generation-1",
    maintenanceChecksumSha256: fixture.maintenanceChecksumSha256,
    expectedSourceBytes: fixture.expectedSourceBytes,
    ...(operations === undefined ? {} : { _operationsForTesting: operations }),
  });
}

describe("authenticated SQLite snapshot artifacts", () => {
  it.each(["0", "9223372036854775808"])("samples private sequence cutoff %s without source writes", async (next) => {
    const fixture = sourceFixture();
    fixture.openDatabases[2]!.exec(`CREATE TABLE local_hook_sequence(singleton, next_sequence); INSERT INTO local_hook_sequence VALUES(1, '${next}')`);
    const before = sha256(fixture.authority.machineSequenceDbPath + "-wal");
    const binding = await withBackendPublicationAppendBarrierAsync(fixture.homeDir, (lockToken) =>
      authenticateSqliteSnapshotCaptureBinding(fixture.authority, { homeDir: fixture.homeDir, lockToken }));
    expect(binding.queueCutoff).toBe(next === "0" ? null : "9223372036854775807");
    expect(sha256(fixture.authority.machineSequenceDbPath + "-wal")).toBe(before);
  });
  it.each(["", "01", "-1", "9223372036854775809", "empty", "number", "singleton", "duplicate"])("refuses malformed private cutoff %s", async (kind) => {
    const fixture = sourceFixture();
    const sequence = fixture.openDatabases[2]!;
    sequence.exec("CREATE TABLE local_hook_sequence(singleton, next_sequence)");
    if (kind !== "empty") sequence.prepare("INSERT INTO local_hook_sequence VALUES(?, ?)").run(kind === "singleton" ? 2 : 1, kind === "number" ? 1 : kind);
    if (kind === "duplicate") sequence.exec("INSERT INTO local_hook_sequence VALUES(1, '2')");
    await expect(withBackendPublicationAppendBarrierAsync(fixture.homeDir, (lockToken) =>
      authenticateSqliteSnapshotCaptureBinding(fixture.authority, { homeDir: fixture.homeDir, lockToken }))).rejects.toThrow();
  });
  it.each(["before-cutoff-read", "after-cutoff-read", "descriptor"])("refuses private cutoff replacement at %s", async (point) => {
    const fixture = sourceFixture();
    fixture.openDatabases[2]!.exec("CREATE TABLE local_hook_sequence(singleton, next_sequence); INSERT INTO local_hook_sequence VALUES(1, '1')");
    const before = sha256(fixture.authority.machineSequenceDbPath + "-wal");
    let reading = false; let reads = 0;
    await expect(withBackendPublicationAppendBarrierAsync(fixture.homeDir, (lockToken) =>
      authenticateSqliteSnapshotCaptureBinding(fixture.authority, { homeDir: fixture.homeDir, lockToken, _operationsForTesting: {
        observe: (boundary, path) => {
          if (boundary === "before-cutoff-read") reading = true;
          if (boundary === point) { chmodSync(path, 0o600); appendFileSync(path, "tampered"); chmodSync(path, 0o400); }
        },
        readdir: (path) => point === "descriptor" && reading && path === "/dev/fd" && ++reads === 2 ? [] : readdirSync(path),
      } }))).rejects.toThrow();
    expect(sha256(fixture.authority.machineSequenceDbPath + "-wal")).toBe(before);
  });
  it("authenticates source bytes under a live token without writing an artifact", async () => {
    const fixture = sourceFixture();
    const before = sourceState(fixture.authority);
    const witness = await withBackendPublicationAppendBarrierAsync(
      fixture.homeDir,
      (lockToken) => authenticateSqliteSnapshotSourceBytes(fixture.authority, {
        homeDir: fixture.homeDir,
        lockToken,
      }),
    );
    expect(witness.roles.map((role) => role.role)).toEqual(["project", "passive-events", "machine-sequence"]);
    expect(sourceState(fixture.authority)).toEqual(before);
    expect(() => statSync(join(fixture.homeDir, ".lcm", "migration-snapshots"))).toThrow();
  });
  it("captures stable main and WAL bytes without changing source files", async () => {
    const fixture = await heldFixture();
    const before = sourceState(fixture.authority);
    const witness = await captureSqliteSnapshotArtifact(fixture.authority, {
      homeDir: fixture.homeDir,
      generationId: "generation-1",
      maintenanceChecksumSha256: fixture.maintenanceChecksumSha256,
      expectedSourceBytes: fixture.expectedSourceBytes,
    });
    expect(witness.roles.map((role) => role.role)).toEqual(["project", "passive-events", "machine-sequence"]);
    expect(witness.roles.every((role) => role.rawWal !== null)).toBe(true);
    expect(witness.queueEvidenceSha256).toBe(fixture.expectedSourceBytes.checksumSha256);
    expect(witness.roles.every((role) => role.encoding === "UTF-8" && role.userVersion === 0 && role.quickCheck === "ok")).toBe(true);
    expect(sourceState(fixture.authority)).toEqual(before);
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: fixture.homeDir }))
      .toEqual({ state: "complete", witness });
  });

  it("uses temporary private storage for dry-run and leaves no captured generation", async () => {
    const fixture = sourceFixture();
    const before = sourceState(fixture.authority);
    const result = await dryRunSqliteSnapshotArtifact(fixture.authority, {
      homeDir: fixture.homeDir,
      _operationsForTesting: { nonce: () => "1".repeat(48) },
    });
    expect(result.roles).toHaveLength(3);
    expect(sourceState(fixture.authority)).toEqual(before);
    expect(readdirSync(join(fixture.homeDir, ".lcm", "migration-snapshots", "inspections"))).toEqual([]);
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: fixture.homeDir })).toEqual({ state: "absent" });
    await dryRunSqliteSnapshotArtifact(fixture.authority, { homeDir: fixture.homeDir });
  });

  it("propagates a live lock token through pre-journal dry-run", async () => {
    const fixture = sourceFixture();
    const result = await withBackendPublicationAppendBarrierAsync(
      fixture.homeDir,
      (lockToken) => dryRunSqliteSnapshotArtifact(fixture.authority, { homeDir: fixture.homeDir, lockToken }),
    );
    expect(result.sourceSelectionSha256).toBe(fixture.authority.sourceSelectionSha256);
  });

  it("refuses capture when source bytes drift from the pre-journal commitment", async () => {
    const fixture = await heldFixture();
    fixture.openDatabases[0]!.exec("INSERT INTO project_data VALUES ('after-commitment')");
    await expect(captureFixture(fixture)).rejects.toMatchObject({ reason: "source-changed" });
    expect(() => statSync(join(generationDirectory(fixture.homeDir), "witness.committed"))).toThrow();
  });

  it("requires a valid source-byte witness and its exact held queue digest", async () => {
    const invalid = await heldFixture();
    await expect(captureSqliteSnapshotArtifact(invalid.authority, {
      homeDir: invalid.homeDir,
      generationId: "generation-1",
      maintenanceChecksumSha256: invalid.maintenanceChecksumSha256,
      expectedSourceBytes: { ...invalid.expectedSourceBytes, checksumSha256: HASH },
    })).rejects.toMatchObject({ reason: "invalid-input" });
    await expect(captureSqliteSnapshotArtifact(invalid.authority, {
      homeDir: invalid.homeDir,
      generationId: "generation-1",
      maintenanceChecksumSha256: invalid.maintenanceChecksumSha256,
      expectedSourceBytes: {} as SqliteSnapshotSourceByteWitness,
    })).rejects.toMatchObject({ reason: "invalid-input" });

    const mismatch = sourceFixture();
    const expected = await withBackendPublicationConsumerLockAsync(
      mismatch.homeDir,
      (lockToken) => authenticateSqliteSnapshotSourceBytes(mismatch.authority, { homeDir: mismatch.homeDir, lockToken }),
      { allowUnresolved: true },
    );
    const maintenance = await coordinator(mismatch.homeDir).enterMaintenance(maintenanceInput(mismatch.authority));
    await expect(captureSqliteSnapshotArtifact(mismatch.authority, {
      homeDir: mismatch.homeDir,
      generationId: "generation-1",
      maintenanceChecksumSha256: maintenance.checksumSha256,
      expectedSourceBytes: expected,
    })).rejects.toMatchObject({ reason: "maintenance-mismatch" });
  });

  it("detects dry-run drift between source authentication and private capture", async () => {
    const fixture = sourceFixture();
    let sourceOpenCount = 0;
    await expect(dryRunSqliteSnapshotArtifact(fixture.authority, {
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        observe: (boundary, _path, role) => {
          if (boundary !== "before-source-open") return;
          sourceOpenCount += 1;
          if (sourceOpenCount === 4 && role === "project") {
            fixture.openDatabases[0]!.exec("INSERT INTO project_data VALUES ('dry-run-race')");
          }
        },
      },
    })).rejects.toMatchObject({ reason: "source-changed" });
  });

  it("rejects malformed authority shapes and overlapping source roles", async () => {
    const fixture = sourceFixture();
    const base = fixture.authority as unknown as Record<string, unknown>;
    const invalid: unknown[] = [
      null,
      {},
      { ...base, extra: true },
      { ...base, version: 2 },
      { ...base, physicalProjectId: "" },
      { ...base, projectIdentity: null },
      { ...base, projectIdentity: { scope: "local" } },
      { ...base, projectIdentity: { scope: "invalid", projectId: "project-1" } },
      { ...base, projectIdentity: { scope: "local", projectId: "" } },
      { ...base, canonicalPath: "relative" },
      { ...base, aliases: "invalid" },
      { ...base, aliases: Array.from({ length: 1025 }, (_, index) => join(fixture.homeDir, `alias-${index}`)) },
      { ...base, aliases: ["relative"] },
      { ...base, aliases: [fixture.authority.aliases[0], fixture.authority.aliases[0]] },
      { ...base, aliases: [fixture.authority.canonicalPath] },
      { ...base, aliases: [...fixture.authority.aliases].reverse() },
      { ...base, projectDbPath: "relative" },
      { ...base, passiveEventsDbPath: "relative" },
      { ...base, machineSequenceDbPath: "relative" },
      { ...base, machineIdentity: null },
      { ...base, machineIdentity: { ...fixture.authority.machineIdentity, extra: true } },
      { ...base, machineIdentity: { identityKey: "", machineId: MACHINE_ID } },
      { ...base, machineIdentity: { identityKey: "machine", machineId: "not-a-uuid" } },
      { ...base, machineIdentitySha256: "invalid" },
      { ...base, projectMapSha256: "invalid" },
      { ...base, projectMapEntrySha256: "invalid" },
      { ...base, projectMetadataSha256: "invalid" },
      { ...base, sourceSelectionSha256: "invalid" },
      withAuthority(fixture.authority, { machineSequenceDbPath: fixture.authority.projectDbPath }),
      withAuthority(fixture.authority, { machineSequenceDbPath: `${fixture.authority.projectDbPath}-wal` }),
    ];
    for (const authority of invalid) {
      await expect(authenticateSqliteSnapshotSourceBytes(authority as AuthenticatedSqliteSnapshotAuthority, {
        homeDir: fixture.homeDir,
        lockToken: {} as never,
      })).rejects.toMatchObject({ reason: "invalid-input" });
    }
  });

  it("rejects unsafe home and source-directory topology", async () => {
    await expect(classifySqliteSnapshotArtifact("generation-1", { homeDir: "relative" }))
      .rejects.toMatchObject({ reason: "invalid-input" });

    const mode = sourceFixture();
    chmodSync(join(mode.authority.projectDbPath, ".."), 0o755);
    await expect(withBackendPublicationConsumerLockAsync(
      mode.homeDir,
      (lockToken) => authenticateSqliteSnapshotSourceBytes(mode.authority, { homeDir: mode.homeDir, lockToken }),
      { allowUnresolved: true },
    )).rejects.toMatchObject({ reason: "source-unsafe" });

    const alias = sourceFixture();
    const sourceParent = join(alias.authority.projectDbPath, "..");
    await expect(withBackendPublicationConsumerLockAsync(
      alias.homeDir,
      (lockToken) => authenticateSqliteSnapshotSourceBytes(alias.authority, {
        homeDir: alias.homeDir,
        lockToken,
        _operationsForTesting: {
          realpath: (path) => path === sourceParent ? alias.homeDir : realpathSync(path),
        },
      }),
      { allowUnresolved: true },
    )).rejects.toMatchObject({ reason: "source-unsafe" });
  });

  it("fails closed on zero-length reads, growth after EOF, and pathname replacement", async () => {
    const shortRead = sourceFixture();
    await expect(withBackendPublicationConsumerLockAsync(
      shortRead.homeDir,
      (lockToken) => authenticateSqliteSnapshotSourceBytes(shortRead.authority, {
        homeDir: shortRead.homeDir,
        lockToken,
        _operationsForTesting: { read: () => 0 },
      }),
      { allowUnresolved: true },
    )).rejects.toMatchObject({ reason: "source-changed" });

    const growth = sourceFixture();
    let injected = false;
    await expect(withBackendPublicationConsumerLockAsync(
      growth.homeDir,
      (lockToken) => authenticateSqliteSnapshotSourceBytes(growth.authority, {
        homeDir: growth.homeDir,
        lockToken,
        _operationsForTesting: {
          read: (fd, buffer, offset, length, position) => {
            const actual = readSync(fd, buffer, offset, length, position);
            if (!injected && length === 1 && actual === 0) {
              injected = true;
              return 1;
            }
            return actual;
          },
        },
      }),
      { allowUnresolved: true },
    )).rejects.toMatchObject({ reason: "source-changed" });

    const replacement = sourceFixture();
    let replaced = false;
    await expect(withBackendPublicationConsumerLockAsync(
      replacement.homeDir,
      (lockToken) => authenticateSqliteSnapshotSourceBytes(replacement.authority, {
        homeDir: replacement.homeDir,
        lockToken,
        _operationsForTesting: {
          observe: (boundary, path, role) => {
            if (replaced || boundary !== "before-source-revalidate" || role !== "project") return;
            replaced = true;
            const moved = `${path}.moved`;
            renameSync(path, moved);
            symlinkSync(moved, path);
          },
        },
      }),
      { allowUnresolved: true },
    )).rejects.toMatchObject({ reason: "source-changed" });
  });

  it("fails closed on copy write and descriptor cleanup failures", async () => {
    const zeroWrite = await heldFixture();
    let copying = false;
    await expect(captureFixture(zeroWrite, {
      open: (path, flags, mode) => {
        if (path.endsWith("project.raw.sqlite")) copying = true;
        return mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
      },
      write: (fd, buffer, offset, length, position) => copying ? 0 : writeSync(fd, buffer, offset, length, position),
    })).rejects.toMatchObject({ reason: "snapshot-io" });

    const multipleClose = await heldFixture();
    let failingCloses = 0;
    await expect(captureFixture(multipleClose, {
      observe: (boundary) => { if (boundary === "before-source-close") failingCloses = 2; },
      close: (fd) => {
        closeSync(fd);
        if (failingCloses > 0) {
          failingCloses -= 1;
          throw new Error("close failed");
        }
      },
    })).rejects.toMatchObject({ reason: "snapshot-io" });

    const writeAndClose = await heldFixture();
    let failedWrite = false;
    await expect(captureFixture(writeAndClose, {
      write: (fd, buffer, offset, length, position) => {
        if (!failedWrite) { failedWrite = true; throw new Error("write failed"); }
        return writeSync(fd, buffer, offset, length, position);
      },
      close: (fd) => {
        closeSync(fd);
        if (failedWrite) throw new Error("close failed");
      },
    })).rejects.toMatchObject({ reason: "snapshot-io" });
  });

  it("fails closed on control publication and commit marker failures", async () => {
    const zeroControlWrite = await heldFixture();
    await expect(captureFixture(zeroControlWrite, { write: () => 0 }))
      .rejects.toMatchObject({ reason: "snapshot-io" });

    const closeAfterControl = await heldFixture();
    let controlFd: number | undefined;
    await expect(captureFixture(closeAfterControl, {
      open: (path, flags, mode) => {
        const fd = mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
        if (path.endsWith("generation-1.intent.json")) controlFd = fd;
        return fd;
      },
      close: (fd) => {
        closeSync(fd);
        if (fd === controlFd) throw new Error("control close failed");
      },
    })).rejects.toMatchObject({ reason: "snapshot-io" });

    const badCommitNonce = await heldFixture();
    let nonceCalls = 0;
    await expect(captureFixture(badCommitNonce, {
      nonce: () => ++nonceCalls === 1 ? "1".repeat(48) : "invalid",
    })).rejects.toMatchObject({ reason: "snapshot-io" });
    expect(() => statSync(join(generationDirectory(badCommitNonce.homeDir), "witness.committed"))).toThrow();
  });

  it("rejects oversized sources and mismatched parent descriptors", async () => {
    const oversized = sourceFixture();
    let fstatCalls = 0;
    await expect(withBackendPublicationConsumerLockAsync(
      oversized.homeDir,
      (lockToken) => authenticateSqliteSnapshotSourceBytes(oversized.authority, {
        homeDir: oversized.homeDir,
        lockToken,
        _operationsForTesting: {
          fstat: (fd) => {
            const actual = fstatSync(fd, { bigint: true });
            fstatCalls += 1;
            return fstatCalls === 2 ? new Proxy(actual, {
              get: (target, property) => property === "size" ? 9n * 1024n * 1024n * 1024n : Reflect.get(target, property, target),
            }) : actual;
          },
        },
      }),
      { allowUnresolved: true },
    )).rejects.toMatchObject({ reason: "source-unsafe" });

    const parent = sourceFixture();
    let first = true;
    await expect(withBackendPublicationConsumerLockAsync(
      parent.homeDir,
      (lockToken) => authenticateSqliteSnapshotSourceBytes(parent.authority, {
        homeDir: parent.homeDir,
        lockToken,
        _operationsForTesting: {
          fstat: (fd) => {
            const actual = fstatSync(fd, { bigint: true });
            if (!first) return actual;
            first = false;
            return new Proxy(actual, {
              get: (target, property) => property === "ino" ? target.ino + 1n : Reflect.get(target, property, target),
            });
          },
        },
      }),
      { allowUnresolved: true },
    )).rejects.toMatchObject({ reason: "source-changed" });
  });

  it("rejects corrupt SQLite bytes and excessive schema inventories", async () => {
    const corrupt = sourceFixture();
    corrupt.openDatabases[0]!.close();
    writeFileSync(corrupt.authority.projectDbPath, "not sqlite", { mode: 0o600 });
    const corruptPrepared = await prepareFixture(corrupt);
    await expect(captureFixture(corruptPrepared)).rejects.toMatchObject({ reason: "unsupported-sqlite" });

    const excessive = sourceFixture();
    const ddl = ["BEGIN", ...Array.from({ length: 4097 }, (_, index) => `CREATE TABLE t${index} (v INTEGER)`), "COMMIT"].join(";");
    excessive.openDatabases[0]!.exec(ddl);
    const excessivePrepared = await prepareFixture(excessive);
    await expect(captureFixture(excessivePrepared)).rejects.toMatchObject({ reason: "unsupported-sqlite" });
  });

  it("rejects private artifact mode and descriptor identity changes", async () => {
    const mode = await heldFixture();
    const witness = await captureFixture(mode);
    chmodSync(join(generationDirectory(mode.homeDir), witness.roles[0]!.rawMain.relativePath), 0o600);
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: mode.homeDir }))
      .toEqual({ state: "tampered", generationId: "generation-1" });

    const identity = await heldFixture();
    const stable = await captureFixture(identity);
    const target = join(generationDirectory(identity.homeDir), stable.roles[0]!.rawMain.relativePath);
    expect(await classifySqliteSnapshotArtifact("generation-1", {
      homeDir: identity.homeDir,
      _operationsForTesting: {
        lstat: (path) => {
          const actual = lstatSync(path, { bigint: true });
          return path === target ? new Proxy(actual, {
            get: (stat, property) => property === "ino" ? stat.ino + 1n : Reflect.get(stat, property, stat),
          }) : actual;
        },
      },
    })).toEqual({ state: "tampered", generationId: "generation-1" });
  });

  it("fails closed across raw and normalized copy races", async () => {
    const operationCases: readonly Readonly<{
      name: string;
      operations: () => Partial<SqliteSnapshotOperations>;
      reason: string;
    }>[] = [
      {
        name: "raw source short read",
        reason: "source-changed",
        operations: () => {
          let rawCopy = false;
          return {
            open: (path, flags, mode) => {
              if (path.endsWith("project.raw.sqlite")) rawCopy = true;
              return mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
            },
            read: (fd, buffer, offset, length, position) => rawCopy ? 0 : readSync(fd, buffer, offset, length, position),
          };
        },
      },
      {
        name: "raw source growth",
        reason: "source-changed",
        operations: () => {
          let rawCopy = false;
          return {
            open: (path, flags, mode) => {
              if (path.endsWith("project.raw.sqlite")) rawCopy = true;
              return mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
            },
            read: (fd, buffer, offset, length, position) => rawCopy && length === 1 ? 1 : readSync(fd, buffer, offset, length, position),
          };
        },
      },
      {
        name: "raw destination size",
        reason: "snapshot-io",
        operations: () => ({
          lstat: (path) => {
            const actual = lstatSync(path, { bigint: true });
            return path.endsWith("project.raw.sqlite") ? new Proxy(actual, {
              get: (stat, property) => property === "size" ? stat.size + 1n : Reflect.get(stat, property, stat),
            }) : actual;
          },
        }),
      },
      {
        name: "normalized source shape",
        reason: "source-unsafe",
        operations: () => {
          let rawSourceFd: number | undefined;
          return {
            open: (path, flags, mode) => {
              const fd = mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
              if (path.endsWith("project.raw.sqlite") && mode === undefined) rawSourceFd = fd;
              return fd;
            },
            fstat: (fd) => {
              const actual = fstatSync(fd, { bigint: true });
              return fd === rawSourceFd ? new Proxy(actual, {
                get: (stat, property) => property === "isFile" ? () => false : Reflect.get(stat, property, stat),
              }) : actual;
            },
          };
        },
      },
      {
        name: "normalized read",
        reason: "source-changed",
        operations: () => {
          let normalizedCopy = false;
          return {
            open: (path, flags, mode) => {
              if (path.endsWith("project.sqlite") && mode !== undefined) normalizedCopy = true;
              return mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
            },
            read: (fd, buffer, offset, length, position) => normalizedCopy ? 0 : readSync(fd, buffer, offset, length, position),
          };
        },
      },
      {
        name: "normalized write",
        reason: "snapshot-io",
        operations: () => {
          let normalizedCopy = false;
          return {
            open: (path, flags, mode) => {
              if (path.endsWith("project.sqlite") && mode !== undefined) normalizedCopy = true;
              return mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
            },
            write: (fd, buffer, offset, length, position) => normalizedCopy ? 0 : writeSync(fd, buffer, offset, length, position),
          };
        },
      },
      {
        name: "normalized destination open",
        reason: "snapshot-io",
        operations: () => ({
          open: (path, flags, mode) => {
            if (path.endsWith("project.sqlite") && mode !== undefined) throw new Error("destination open failed");
            return mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
          },
        }),
      },
      {
        name: "sidecar cleanup",
        reason: "snapshot-io",
        operations: () => ({ unlink: () => { throw Object.assign(new Error("unlink"), { code: "EIO" }); } }),
      },
    ];
    for (const operationCase of operationCases) {
      const fixture = await heldFixture();
      await expect(captureFixture(fixture, operationCase.operations()), operationCase.name)
        .rejects.toMatchObject({ reason: operationCase.reason });
    }
  });

  it("rejects a normalized leaf replaced by a hard link before writable SQLite inspection", async () => {
    const fixture = await heldFixture();
    let inspectionCalled = false;
    let replaced = false;
    await expect(captureFixture(fixture, {
      observe: (boundary, path, role) => {
        if (replaced || boundary !== "before-private-inspection" || role !== "project") return;
        replaced = true;
        rmSync(path);
        linkSync(fixture.authority.projectDbPath, path);
      },
      inspectDatabase: () => {
        inspectionCalled = true;
        throw new Error("writable SQLite inspection must not be reached");
      },
    })).rejects.toMatchObject({ reason: "source-unsafe" });
    expect(inspectionCalled).toBe(false);
    expect(() => statSync(join(generationDirectory(fixture.homeDir), "witness.committed"))).toThrow();
  });

  it.each(["before-open", "opened-aba"])("preserves real source bytes and sidecars after private %s replacement", async (point) => {
    const fixture = await heldFixture();
    const source = fixture.authority.projectDbPath;
    const original = [source, `${source}-wal`, `${source}-shm`].map((path) => ({
      path, bytes: readFileSync(path), mode: statSync(path).mode,
    }));
    let replaced = false;
    await expect(captureFixture(fixture, {
      observe: (boundary, path, role) => {
        if (point !== "before-open" || replaced || boundary !== "before-private-inspection" || role !== "project") return;
        replaced = true;
        renameSync(path, `${path}.owned`);
        linkSync(source, path);
      },
      openDatabase: (path) => {
        if (replaced) return new DatabaseSync(path);
        replaced = true;
        renameSync(path, `${path}.owned`);
        linkSync(source, path);
        const opened = new DatabaseSync(path);
        rmSync(path);
        renameSync(`${path}.owned`, path);
        return opened;
      },
    })).rejects.toMatchObject({ reason: "source-unsafe" });
    for (const item of original) {
      expect(readFileSync(item.path)).toEqual(item.bytes);
      expect(statSync(item.path).mode).toBe(item.mode);
    }
  });

  it("preserves a late replaced scratch tree while cleanup follows its retained directory", async () => {
    const fixture = sourceFixture();
    let replacement: string | undefined;
    await expect(dryRunSqliteSnapshotArtifact(fixture.authority, {
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        remove: (path, options) => {
          if (replacement === undefined) {
            const inspections = join(fixture.homeDir, ".lcm", "migration-snapshots", "inspections");
            const scratch = join(inspections, readdirSync(inspections)[0]!);
            renameSync(scratch, `${scratch}.owned`);
            mkdirSync(scratch, { mode: 0o700 });
            replacement = join(scratch, "sentinel");
            writeFileSync(replacement, "unrelated", { mode: 0o600 });
          }
          rmSync(path, options);
        },
      },
    })).rejects.toMatchObject({ reason: "source-changed" });
    expect(readFileSync(replacement!, "utf8")).toBe("unrelated");
  });

  it.each(["ancestor", "leaf"])("preserves a late replacement %s during nonrecursive dry-run cleanup", async (target) => {
    const fixture = sourceFixture();
    let sentinel: string | undefined;
    await expect(dryRunSqliteSnapshotArtifact(fixture.authority, {
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        remove: (path, options) => {
          if (sentinel === undefined) {
            const inspections = join(fixture.homeDir, ".lcm", "migration-snapshots", "inspections");
            const scratchName = readdirSync(inspections)[0]!;
            if (target === "ancestor") {
              renameSync(inspections, `${inspections}.owned`);
              mkdirSync(inspections, { mode: 0o700 });
              const replacement = join(inspections, scratchName);
              mkdirSync(replacement, { mode: 0o700 });
              sentinel = join(replacement, "sentinel");
            } else {
              rmSync(path);
              mkdirSync(path, { mode: 0o700 });
              sentinel = join(inspections, scratchName, path.split("/").at(-1)!, "sentinel");
            }
            writeFileSync(sentinel, "replacement", { mode: 0o600 });
          }
          rmSync(path, options);
        },
      },
    })).rejects.toMatchObject({ reason: target === "ancestor" ? "source-changed" : "snapshot-io" });
    expect(readFileSync(sentinel!, "utf8")).toBe("replacement");
  });

  it("refuses cleanup of a replaced private leaf directory without traversing it", async () => {
    const fixture = sourceFixture();
    let sentinel: string | undefined;
    await expect(dryRunSqliteSnapshotArtifact(fixture.authority, {
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        now: () => {
          const inspections = join(fixture.homeDir, ".lcm", "migration-snapshots", "inspections");
          const scratch = join(inspections, readdirSync(inspections)[0]!);
          const path = join(scratch, "project.sqlite");
          rmSync(path);
          mkdirSync(path, { mode: 0o700 });
          sentinel = join(path, "sentinel");
          writeFileSync(sentinel, "unrelated", { mode: 0o600 });
          return new Date("2026-09-07T12:00:00.000Z");
        },
      },
    })).rejects.toMatchObject({ reason: "source-changed" });
    expect(readFileSync(sentinel!, "utf8")).toBe("unrelated");
  });

  it.each([
    { boundary: "before-private-inspection", target: "parent", reason: "source-changed" },
    { boundary: "before-private-inspection", target: "main", reason: "source-changed" },
    { boundary: "before-private-inspection", target: "-shm", reason: "source-unsafe" },
    { boundary: "after-private-inspection", target: "parent", reason: "source-changed" },
    { boundary: "after-private-inspection", target: "-wal", reason: "source-unsafe" },
    { boundary: "before-private-fsync", target: "parent", reason: "source-changed" },
    { boundary: "before-private-fsync", target: "main", reason: "source-changed" },
  ] as const)("refuses $target replacement at $boundary without changing the source", async (scenario) => {
    const fixture = await heldFixture();
    const before = sourceState(fixture.authority);
    let changed = false;
    let replacement: string | undefined;
    await expect(captureFixture(fixture, {
      observe: (boundary, path, role) => {
        if (changed || boundary !== scenario.boundary || role !== "project") return;
        changed = true;
        if (scenario.target === "parent") {
          const parent = join(path, "..");
          renameSync(parent, `${parent}.owned`);
          mkdirSync(parent, { mode: 0o700 });
          replacement = join(parent, "sentinel");
          writeFileSync(replacement, "replacement", { mode: 0o600 });
        } else if (scenario.target === "main") {
          renameSync(path, `${path}.owned`);
          replacement = path;
          writeFileSync(path, "replacement", { mode: 0o600 });
        } else {
          replacement = `${path}${scenario.target}`;
          writeFileSync(replacement, "replacement", { mode: 0o600 });
        }
      },
    })).rejects.toMatchObject({ reason: scenario.reason });
    expect(changed).toBe(true);
    expect(readFileSync(replacement!, "utf8")).toBe("replacement");
    expect(sourceState(fixture.authority)).toEqual(before);
  });

  it("refuses a sealed artifact inode replacement before constructing its witness", async () => {
    const fixture = await heldFixture();
    let replacement: string | undefined;
    const ownedPath = join(fixture.homeDir, "sealed-original.sqlite");
    await expect(captureFixture(fixture, {
      observe: (boundary, path, role) => {
        if (replacement !== undefined || boundary !== "after-private-fsync" || role !== "project" || !path.endsWith("project.sqlite")) return;
        renameSync(path, ownedPath);
        writeFileSync(path, readFileSync(ownedPath), { mode: 0o400 });
        replacement = path;
      },
    })).rejects.toMatchObject({ reason: "source-changed" });
    expect(replacement).toBeDefined();
    expect(readFileSync(replacement!)).toEqual(readFileSync(ownedPath));
    expect(() => statSync(join(generationDirectory(fixture.homeDir), "witness.committed"))).toThrow();
  });

  it.each(["migration-snapshots", "migration-snapshots/registrations"])("refuses an exact retry through unsafe %s permissions", async (relative) => {
    const fixture = await heldFixture();
    await captureFixture(fixture);
    chmodSync(join(fixture.homeDir, ".lcm", relative), 0o755);
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: fixture.homeDir }))
      .toEqual({ state: "tampered", generationId: "generation-1" });
    await expect(captureFixture(fixture)).rejects.toMatchObject({ reason: "snapshot-tampered" });
  });

  it("refuses ambiguous SQLite-open descriptor evidence before running SQL", async () => {
    const fixture = await heldFixture();
    const before = sourceState(fixture.authority);
    let extra: number | undefined;
    try {
      await expect(captureFixture(fixture, {
        openDatabase: (path) => {
          const database = new DatabaseSync(path);
          extra = openSync(path, "r");
          return database;
        },
      })).rejects.toMatchObject({ reason: "source-unsafe" });
      expect(sourceState(fixture.authority)).toEqual(before);
    } finally { if (extra !== undefined) closeSync(extra); }
  });

  it("refuses non-EBADF descriptor inspection failures before opening SQLite", async () => {
    const fixture = await heldFixture();
    let inventory = false;
    let opened = false;
    await expect(captureFixture(fixture, {
      readdir: (path) => {
        if (path === "/dev/fd") inventory = true;
        return readdirSync(path);
      },
      fstat: (fd) => {
        if (inventory) throw Object.assign(new Error("descriptor stat failed"), { code: "EIO" });
        return fstatSync(fd, { bigint: true });
      },
      openDatabase: () => { opened = true; throw new Error("unexpected SQLite open"); },
    })).rejects.toMatchObject({ reason: "snapshot-io" });
    expect(inventory).toBe(true);
    expect(opened).toBe(false);
  });

  it.each(["scratch", "parent"])("refuses a replaced %s during dry-run descriptor initialization", async (target) => {
    const fixture = sourceFixture();
    let replaced = false;
    let scratchOpened = false;
    let sentinel: string | undefined;
    await expect(dryRunSqliteSnapshotArtifact(fixture.authority, {
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        open: (path, flags, mode) => {
          const shouldReplace = target === "scratch" ? /\/dry-run\.[0-9a-f]+$/u.test(path)
            : path.endsWith("/inspections") && scratchOpened;
          if (!replaced && shouldReplace) {
            replaced = true;
            renameSync(path, `${path}.owned`);
            mkdirSync(path, { mode: 0o700 });
            sentinel = join(path, "sentinel");
            writeFileSync(sentinel, "replacement", { mode: 0o600 });
          }
          const fd = mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
          if (/\/dry-run\.[0-9a-f]+$/u.test(path)) scratchOpened = true;
          return fd;
        },
      },
    })).rejects.toMatchObject({ reason: "source-changed" });
    expect(replaced).toBe(true);
    expect(readFileSync(sentinel!, "utf8")).toBe("replacement");
  });

  it.each(["raw-stat", "scratch-stat", "parent-open", "parent-stat"])("closes every owned descriptor after %s failure", async (failure) => {
    const fixture = sourceFixture();
    const descriptors = new Map<number, string>();
    let rejected = false;
    await expect(dryRunSqliteSnapshotArtifact(fixture.authority, {
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        open: (path, flags, mode) => {
          if (!rejected && failure === "parent-open" && path.endsWith("/inspections")
            && [...descriptors.values()].some((value) => value.includes("/dry-run."))) {
            rejected = true;
            throw new Error("parent open failed");
          }
          const fd = mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
          descriptors.set(fd, path);
          return fd;
        },
        fstat: (fd) => {
          const path = descriptors.get(fd)!;
          if (!rejected && ((failure === "raw-stat" && path.endsWith("project.raw.sqlite"))
            || (failure === "scratch-stat" && /\/dry-run\.[0-9a-f]+$/u.test(path))
            || (failure === "parent-stat" && path.endsWith("/inspections")))) {
            rejected = true;
            throw new Error("stat failed");
          }
          return fstatSync(fd, { bigint: true });
        },
        close: (fd) => { closeSync(fd); descriptors.delete(fd); },
      },
    })).rejects.toMatchObject({ reason: "snapshot-io" });
    expect(rejected).toBe(true);
    const leaked = [...descriptors.values()];
    for (const fd of descriptors.keys()) closeSync(fd);
    expect(leaked).toEqual([]);
  });

  it("fails closed when a source open fails and its descriptor cannot close", async () => {
    const fixture = sourceFixture();
    let fstatCalls = 0;
    let rejectedFd: number | undefined;
    await expect(withBackendPublicationConsumerLockAsync(
      fixture.homeDir,
      (lockToken) => authenticateSqliteSnapshotSourceBytes(fixture.authority, {
        homeDir: fixture.homeDir,
        lockToken,
        _operationsForTesting: {
          fstat: (fd) => {
            const actual = fstatSync(fd, { bigint: true });
            fstatCalls += 1;
            if (fstatCalls !== 2) return actual;
            rejectedFd = fd;
            return new Proxy(actual, { get: (stat, property) => property === "mode" ? 0o644n : Reflect.get(stat, property, stat) });
          },
          close: (fd) => {
            closeSync(fd);
            if (fd === rejectedFd) throw new Error("close failed");
          },
        },
      }),
      { allowUnresolved: true },
    )).rejects.toMatchObject({ reason: "snapshot-io" });
  });

  it("detects retained parent identity change after source reads", async () => {
    const fixture = sourceFixture();
    const sourceParent = join(fixture.authority.projectDbPath, "..");
    let parentFd: number | undefined;
    let armed = false;
    await expect(withBackendPublicationConsumerLockAsync(
      fixture.homeDir,
      (lockToken) => authenticateSqliteSnapshotSourceBytes(fixture.authority, {
        homeDir: fixture.homeDir,
        lockToken,
        _operationsForTesting: {
          open: (path, flags, mode) => {
            const fd = mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
            if (path === sourceParent) parentFd = fd;
            return fd;
          },
          observe: (boundary) => { if (boundary === "before-source-revalidate") armed = true; },
          fstat: (fd) => {
            const actual = fstatSync(fd, { bigint: true });
            return armed && fd === parentFd ? new Proxy(actual, {
              get: (stat, property) => property === "ino" ? stat.ino + 1n : Reflect.get(stat, property, stat),
            }) : actual;
          },
        },
      }),
      { allowUnresolved: true },
    )).rejects.toMatchObject({ reason: "source-changed" });
  });

  it("rejects unexpected filesystem and malformed control read failures", async () => {
    const mkdir = sourceFixture();
    await expect(dryRunSqliteSnapshotArtifact(mkdir.authority, {
      homeDir: mkdir.homeDir,
      _operationsForTesting: { mkdir: () => { throw Object.assign(new Error("mkdir"), { code: "EIO" }); } },
    })).rejects.toMatchObject({ reason: "snapshot-io" });

    const controlRead = await heldFixture();
    await captureFixture(controlRead);
    let targetRead = false;
    expect(await classifySqliteSnapshotArtifact("generation-1", {
      homeDir: controlRead.homeDir,
      _operationsForTesting: {
        open: (path, flags, mode) => {
          targetRead = path.endsWith("generation-1.intent.json");
          return mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
        },
        read: (fd, buffer, offset, length, position) => targetRead ? 0 : readSync(fd, buffer, offset, length, position),
      },
    })).toEqual({ state: "tampered", generationId: "generation-1" });

    const unexpectedStat = sourceFixture();
    expect(await classifySqliteSnapshotArtifact("generation-1", {
      homeDir: unexpectedStat.homeDir,
      _operationsForTesting: { lstat: () => { throw Object.assign(new Error("stat"), { code: "EIO" }); } },
    })).toEqual({ state: "tampered", generationId: "generation-1" });
  });

  it("rejects malformed checked controls at every recovery layer", async () => {
    const mutations: readonly Readonly<{ relative: string; mutate: (value: Record<string, unknown>) => void }>[] = [
      { relative: join("registrations", "generation-1.intent.json"), mutate: (value) => { value.version = 2; } },
      { relative: join("registrations", "generation-1.identity.json"), mutate: (value) => { value.generationDev = "invalid"; } },
      { relative: join("generations", "generation-1", "intent.json"), mutate: (value) => { value.nonce = "invalid"; } },
    ];
    for (const mutation of mutations) {
      const fixture = await heldFixture();
      await captureFixture(fixture);
      rewriteCheckedPath(join(fixture.homeDir, ".lcm", "migration-snapshots", mutation.relative), mutation.mutate);
      expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: fixture.homeDir }))
        .toEqual({ state: "tampered", generationId: "generation-1" });
    }

    const requestMismatch = await heldFixture();
    await captureFixture(requestMismatch);
    const root = join(requestMismatch.homeDir, ".lcm", "migration-snapshots");
    for (const path of [
      join(root, "registrations", "generation-1.intent.json"),
      join(root, "registrations", "generation-1.identity.json"),
      join(root, "generations", "generation-1", "intent.json"),
    ]) rewriteCheckedPath(path, (value) => { value.requestSha256 = "f".repeat(64); });
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: requestMismatch.homeDir }))
      .toEqual({ state: "tampered", generationId: "generation-1" });
  });

  it("rejects missing and invalid checksums in committed controls", async () => {
    const missing = await heldFixture();
    await captureFixture(missing);
    writeFileSync(join(generationDirectory(missing.homeDir), "witness.json"), "{}\n", { mode: 0o600 });
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: missing.homeDir }))
      .toEqual({ state: "tampered", generationId: "generation-1" });

    const invalid = await heldFixture();
    await captureFixture(invalid);
    writeFileSync(join(generationDirectory(invalid.homeDir), "witness.json"), `${JSON.stringify({ checksumSha256: HASH })}\n`, { mode: 0o600 });
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: invalid.homeDir }))
      .toEqual({ state: "tampered", generationId: "generation-1" });
  });

  it("rejects invalid dry-run nonce and clock", async () => {
    const nonce = sourceFixture();
    await expect(dryRunSqliteSnapshotArtifact(nonce.authority, {
      homeDir: nonce.homeDir,
      _operationsForTesting: { nonce: () => "invalid" },
    })).rejects.toMatchObject({ reason: "snapshot-io" });

    const clock = sourceFixture();
    await expect(dryRunSqliteSnapshotArtifact(clock.authority, {
      homeDir: clock.homeDir,
      _operationsForTesting: { now: () => new Date(Number.NaN) },
    })).rejects.toMatchObject({ reason: "snapshot-io" });
  });

  it("preserves a replacement of dry-run scratch storage and fails closed", async () => {
    const fixture = sourceFixture();
    let replacement: string | undefined;
    await expect(dryRunSqliteSnapshotArtifact(fixture.authority, {
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        now: () => {
          const inspections = join(fixture.homeDir, ".lcm", "migration-snapshots", "inspections");
          const scratchName = readdirSync(inspections)[0]!;
          const scratch = join(inspections, scratchName);
          renameSync(scratch, `${scratch}.owned`);
          mkdirSync(scratch, { mode: 0o700 });
          replacement = join(scratch, "sentinel");
          writeFileSync(replacement, "unrelated", { mode: 0o600 });
          return new Date("2026-09-07T12:00:00.000Z");
        },
      },
    })).rejects.toMatchObject({ reason: "source-changed" });
    expect(replacement).toBeDefined();
    expect(readFileSync(replacement!, "utf8")).toBe("unrelated");
  });

  it("refuses a complete generation under a different held request", async () => {
    const fixture = await heldFixture();
    await captureFixture(fixture);
    const journalPath = join(fixture.homeDir, ".lcm", "backend-publication", "journal.json");
    const current = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    const { checksumSha256: _checksum, ...body } = current;
    body.publicationId = "replacement-publication";
    body.updatedAt = "2026-09-07T12:00:00.000Z";
    const replacement = {
      ...body,
      checksumSha256: backendPublicationCanonicalSha256(body),
    };
    writeFileSync(journalPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

    await expect(captureSqliteSnapshotArtifact(fixture.authority, {
      homeDir: fixture.homeDir,
      generationId: "generation-1",
      maintenanceChecksumSha256: replacement.checksumSha256,
      expectedSourceBytes: fixture.expectedSourceBytes,
    })).rejects.toMatchObject({ reason: "snapshot-replaced" });
  });

  it("returns the immutable witness on an exact retry and through inspect", async () => {
    const fixture = await heldFixture();
    const first = await captureFixture(fixture);
    expect(await captureFixture(fixture)).toEqual(first);
    expect(await inspectSqliteSnapshotArtifact("generation-1", { homeDir: fixture.homeDir })).toEqual(first);
  });

  it("propagates an already active publication lock token", async () => {
    const fixture = await heldFixture();
    const witness = await withBackendPublicationAppendBarrierAsync(fixture.homeDir, async (lockToken) =>
      captureSqliteSnapshotArtifact(fixture.authority, {
        homeDir: fixture.homeDir,
        generationId: "generation-1",
        maintenanceChecksumSha256: fixture.maintenanceChecksumSha256,
        expectedSourceBytes: fixture.expectedSourceBytes,
        lockToken,
      }));
    expect(witness.generationId).toBe("generation-1");
  });

  it("rejects a forged source-selection digest before creating artifact storage", async () => {
    const fixture = sourceFixture();
    const forged = { ...fixture.authority, sourceSelectionSha256: HASH };
    await expect(captureSqliteSnapshotArtifact(forged, {
      homeDir: fixture.homeDir,
      generationId: "generation-1",
      maintenanceChecksumSha256: HASH,
      expectedSourceBytes: {} as SqliteSnapshotSourceByteWitness,
    })).rejects.toMatchObject({ reason: "invalid-input" });
    expect(() => statSync(join(fixture.homeDir, ".lcm", "migration-snapshots"))).toThrow();
  });

  it("requires the exact held source selection and maintenance checksum", async () => {
    const fixture = await heldFixture();
    await expect(captureSqliteSnapshotArtifact(fixture.authority, {
      homeDir: fixture.homeDir,
      generationId: "generation-1",
      maintenanceChecksumSha256: "f".repeat(64),
      expectedSourceBytes: fixture.expectedSourceBytes,
    })).rejects.toMatchObject({ reason: "maintenance-mismatch" });
    const changedAuthority = withAuthority(fixture.authority, { projectMetadataSha256: "e".repeat(64) });
    const changedSourceBytes = await withBackendPublicationConsumerLockAsync(
      fixture.homeDir,
      (lockToken) => authenticateSqliteSnapshotSourceBytes(changedAuthority, { homeDir: fixture.homeDir, lockToken }),
      { allowUnresolved: true },
    );
    await expect(captureSqliteSnapshotArtifact(changedAuthority, {
      homeDir: fixture.homeDir,
      generationId: "generation-1",
      maintenanceChecksumSha256: fixture.maintenanceChecksumSha256,
      expectedSourceBytes: changedSourceBytes,
    })).rejects.toMatchObject({ reason: "maintenance-mismatch" });
  });

  it("leaves a durable partial generation when capture fails and refuses exact retry", async () => {
    const fixture = await heldFixture();
    let failed = false;
    await expect(captureFixture(fixture, {
      observe: (boundary, _path, role) => {
        if (!failed && boundary === "after-source-copy" && role === "project") {
          failed = true;
          throw new Error("injected capture failure");
        }
      },
    })).rejects.toMatchObject({ reason: "snapshot-io" });
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: fixture.homeDir }))
      .toEqual({ state: "partial", generationId: "generation-1" });
    await expect(captureFixture(fixture)).rejects.toMatchObject({ reason: "snapshot-partial" });
    expect(() => statSync(join(generationDirectory(fixture.homeDir), "witness.committed"))).toThrow();
  });

  it("classifies a replaced generation directory without adopting it", async () => {
    const fixture = await heldFixture();
    await captureFixture(fixture);
    const generation = generationDirectory(fixture.homeDir);
    renameSync(generation, `${generation}.original`);
    mkdirSync(generation, { mode: 0o700 });
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: fixture.homeDir }))
      .toEqual({ state: "replaced", generationId: "generation-1" });
    await expect(captureFixture(fixture)).rejects.toMatchObject({ reason: "snapshot-replaced" });
    expect(readdirSync(`${generation}.original`)).toContain("witness.committed");
  });

  it("classifies committed artifact mutation as tampering", async () => {
    const fixture = await heldFixture();
    const witness = await captureFixture(fixture);
    const rawMain = join(generationDirectory(fixture.homeDir), witness.roles[0]!.rawMain.relativePath);
    chmodSync(rawMain, 0o600);
    appendFileSync(rawMain, "tampered");
    chmodSync(rawMain, 0o400);
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: fixture.homeDir }))
      .toEqual({ state: "tampered", generationId: "generation-1" });
    await expect(inspectSqliteSnapshotArtifact("generation-1", { homeDir: fixture.homeDir }))
      .rejects.toMatchObject({ reason: "snapshot-tampered" });
    await expect(captureFixture(fixture)).rejects.toMatchObject({ reason: "snapshot-tampered" });
  });

  it("keeps crash-prefix states partial and missing registered generations replaced", async () => {
    const beforeIntent = await heldFixture();
    await expect(captureFixture(beforeIntent, { nonce: () => "invalid" }))
      .rejects.toMatchObject({ reason: "snapshot-io" });
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: beforeIntent.homeDir }))
      .toEqual({ state: "partial", generationId: "generation-1" });

    const registered = await heldFixture();
    await expect(captureFixture(registered, {
      observe: (boundary) => { if (boundary === "before-source-open") throw new Error("stop after registration"); },
    })).rejects.toMatchObject({ reason: "snapshot-io" });
    rmSync(generationDirectory(registered.homeDir), { recursive: true });
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: registered.homeDir }))
      .toEqual({ state: "replaced", generationId: "generation-1" });

    const registrationOnly = await heldFixture();
    await expect(captureFixture(registrationOnly, { nonce: () => "invalid" }))
      .rejects.toMatchObject({ reason: "snapshot-io" });
    rmSync(generationDirectory(registrationOnly.homeDir), { recursive: true });
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: registrationOnly.homeDir }))
      .toEqual({ state: "partial", generationId: "generation-1" });
  });

  it("classifies missing intent, malformed marker, and unknown residue as tampering", async () => {
    const missingIntent = await heldFixture();
    await captureFixture(missingIntent);
    rmSync(join(missingIntent.homeDir, ".lcm", "migration-snapshots", "registrations", "generation-1.intent.json"));
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: missingIntent.homeDir }))
      .toEqual({ state: "tampered", generationId: "generation-1" });

    const marker = await heldFixture();
    await captureFixture(marker);
    writeFileSync(join(generationDirectory(marker.homeDir), "witness.committed"), `${"f".repeat(64)}\n`, { mode: 0o600 });
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: marker.homeDir }))
      .toEqual({ state: "tampered", generationId: "generation-1" });

    const residue = await heldFixture();
    await captureFixture(residue);
    writeFileSync(join(generationDirectory(residue.homeDir), "unknown"), "residue", { mode: 0o600 });
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: residue.homeDir }))
      .toEqual({ state: "tampered", generationId: "generation-1" });
  });

  it("rejects malformed and internally inconsistent committed witnesses", async () => {
    const mutations: readonly Readonly<{
      name: string;
      mutate: (value: Record<string, unknown>) => void;
    }>[] = [
      { name: "unknown top key", mutate: (value) => { value.extra = true; } },
      { name: "version", mutate: (value) => { value.version = 2; } },
      { name: "generation", mutate: (value) => { value.generationId = "other"; } },
      { name: "hash shape", mutate: (value) => { value.artifactSha256 = "invalid"; } },
      { name: "captured time", mutate: (value) => { value.capturedAt = "invalid"; } },
      { name: "authority", mutate: (value) => { value.authority = { ...(value.authority as object), extra: true }; } },
      { name: "roles type", mutate: (value) => { value.roles = {}; } },
      { name: "roles length", mutate: (value) => { (value.roles as unknown[]).pop(); } },
      { name: "schema root", mutate: (value) => { value.schemaSha256 = "f".repeat(64); } },
      { name: "request root", mutate: (value) => { value.requestSha256 = "f".repeat(64); } },
      {
        name: "role shape",
        mutate: (value) => {
          const role = (value.roles as Record<string, unknown>[])[0]!;
          role.extra = true;
          (value.roles as Record<string, unknown>[])[0] = checkedRecord(role);
        },
      },
      {
        name: "role encoding",
        mutate: (value) => {
          const role = (value.roles as Record<string, unknown>[])[0]!;
          role.encoding = "UTF-16le";
          (value.roles as Record<string, unknown>[])[0] = checkedRecord(role);
        },
      },
      {
        name: "private witness",
        mutate: (value) => {
          const role = (value.roles as Record<string, unknown>[])[0]!;
          (role.rawMain as Record<string, unknown>).relativePath = "../escape";
          (value.roles as Record<string, unknown>[])[0] = checkedRecord(role);
        },
      },
      {
        name: "source shape",
        mutate: (value) => {
          const role = (value.roles as Record<string, unknown>[])[0]!;
          const source = role.source as Record<string, unknown>;
          source.extra = true;
          role.source = checkedRecord(source);
          (value.roles as Record<string, unknown>[])[0] = checkedRecord(role);
        },
      },
      {
        name: "source parent",
        mutate: (value) => {
          const role = (value.roles as Record<string, unknown>[])[0]!;
          const source = role.source as Record<string, unknown>;
          (source.parent as Record<string, unknown>).mode = 0o755;
          role.source = checkedRecord(source);
          (value.roles as Record<string, unknown>[])[0] = checkedRecord(role);
        },
      },
      {
        name: "source main identity",
        mutate: (value) => {
          const role = (value.roles as Record<string, unknown>[])[0]!;
          const source = role.source as Record<string, unknown>;
          (source.mainAfter as Record<string, unknown>).sha256 = "f".repeat(64);
          role.source = checkedRecord(source);
          (value.roles as Record<string, unknown>[])[0] = checkedRecord(role);
        },
      },
      {
        name: "malformed source identity",
        mutate: (value) => {
          const role = (value.roles as Record<string, unknown>[])[0]!;
          const source = role.source as Record<string, unknown>;
          (source.mainBefore as Record<string, unknown>).extra = true;
          role.source = checkedRecord(source);
          (value.roles as Record<string, unknown>[])[0] = checkedRecord(role);
        },
      },
      {
        name: "source WAL pair",
        mutate: (value) => {
          const role = (value.roles as Record<string, unknown>[])[0]!;
          const source = role.source as Record<string, unknown>;
          source.walAfter = null;
          role.source = checkedRecord(source);
          (value.roles as Record<string, unknown>[])[0] = checkedRecord(role);
        },
      },
      {
        name: "source WAL identity",
        mutate: (value) => {
          const role = (value.roles as Record<string, unknown>[])[0]!;
          const source = role.source as Record<string, unknown>;
          (source.walAfter as Record<string, unknown>).sha256 = "f".repeat(64);
          role.source = checkedRecord(source);
          (value.roles as Record<string, unknown>[])[0] = checkedRecord(role);
        },
      },
    ];
    for (const mutation of mutations) {
      const fixture = await heldFixture();
      await captureFixture(fixture);
      rewriteWitness(fixture.homeDir, mutation.mutate);
      expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: fixture.homeDir }), mutation.name)
        .toEqual({ state: "tampered", generationId: "generation-1" });
    }
  });

  it("rejects malformed committed control bytes and modes", async () => {
    const invalidJson = await heldFixture();
    await captureFixture(invalidJson);
    writeFileSync(join(generationDirectory(invalidJson.homeDir), "witness.json"), "not-json\n", { mode: 0o600 });
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: invalidJson.homeDir }))
      .toEqual({ state: "tampered", generationId: "generation-1" });

    const carriageReturn = await heldFixture();
    await captureFixture(carriageReturn);
    const witnessPath = join(generationDirectory(carriageReturn.homeDir), "witness.json");
    const witnessBytes = readFileSync(witnessPath, "utf8");
    const firstNewline = witnessBytes.indexOf("\n");
    expect(firstNewline).toBeGreaterThanOrEqual(0);
    const carriageReturnBytes = witnessBytes.slice(0, firstNewline) + "\r" + witnessBytes.slice(firstNewline);
    writeFileSync(witnessPath, carriageReturnBytes, { mode: 0o600 });
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: carriageReturn.homeDir }))
      .toEqual({ state: "tampered", generationId: "generation-1" });

    const mode = await heldFixture();
    await captureFixture(mode);
    chmodSync(join(generationDirectory(mode.homeDir), "witness.json"), 0o644);
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: mode.homeDir }))
      .toEqual({ state: "tampered", generationId: "generation-1" });
  });

  it("revalidates private schema evidence during historical inspection", async () => {
    const fixture = await heldFixture();
    await captureFixture(fixture);
    expect(await classifySqliteSnapshotArtifact("generation-1", {
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        inspectDatabase: () => ({
          encoding: "UTF-8",
          userVersion: 0,
          quickCheck: "ok",
          schemaSha256: "f".repeat(64),
        }),
      },
    })).toEqual({ state: "tampered", generationId: "generation-1" });
  });

  it("reports absent inspection and validates generation input", async () => {
    const fixture = sourceFixture();
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: fixture.homeDir })).toEqual({ state: "absent" });
    await expect(inspectSqliteSnapshotArtifact("generation-1", { homeDir: fixture.homeDir }))
      .rejects.toMatchObject({ reason: "snapshot-absent" });
    await expect(classifySqliteSnapshotArtifact("../escape", { homeDir: fixture.homeDir }))
      .rejects.toBeInstanceOf(SqliteSnapshotError);
  });

  it("rejects source hard links and unsafe permissions", async () => {
    const hardlinked = await heldFixture();
    linkSync(hardlinked.authority.projectDbPath, `${hardlinked.authority.projectDbPath}.alias`);
    await expect(captureFixture(hardlinked)).rejects.toMatchObject({ reason: "source-unsafe" });
    const permissive = await heldFixture();
    chmodSync(permissive.authority.projectDbPath, 0o644);
    await expect(captureFixture(permissive)).rejects.toMatchObject({ reason: "source-unsafe" });
  });

  it("rejects symlink replacement and source-sidecar membership races", async () => {
    const symlinked = await heldFixture();
    const project = symlinked.authority.projectDbPath;
    symlinked.openDatabases[0]!.close();
    const moved = `${project}.moved`;
    renameSync(project, moved);
    symlinkSync(moved, project);
    await expect(captureFixture(symlinked)).rejects.toMatchObject({ reason: "snapshot-io" });

    const raced = await heldFixture();
    let changed = false;
    await expect(captureFixture(raced, {
      observe: (boundary, path, role) => {
        if (!changed && boundary === "before-source-revalidate" && role === "project") {
          changed = true;
          writeFileSync(`${path}-journal`, "unexpected");
        }
      },
    })).rejects.toMatchObject({ reason: "source-changed" });
  });

  it("detects in-place WAL changes after the raw copy", async () => {
    const fixture = await heldFixture();
    let changed = false;
    await expect(captureFixture(fixture, {
      observe: (boundary, _path, role) => {
        if (!changed && boundary === "before-source-revalidate" && role === "project") {
          changed = true;
          fixture.openDatabases[0]!.exec("INSERT INTO project_data VALUES ('raced')");
        }
      },
    })).rejects.toMatchObject({ reason: "source-changed" });
  });

  it("refuses a rollback journal source topology", async () => {
    const fixture = await heldFixture();
    writeFileSync(`${fixture.authority.projectDbPath}-journal`, "active", { mode: 0o600 });
    await expect(captureFixture(fixture)).rejects.toMatchObject({ reason: "unsupported-sqlite" });
  });

  it("does not commit after maintenance evidence changes before publication", async () => {
    const fixture = await heldFixture();
    let changed = false;
    await expect(captureFixture(fixture, {
      observe: (boundary) => {
        if (changed || boundary !== "before-commit-marker") return;
        changed = true;
        const journalPath = join(fixture.homeDir, ".lcm", "backend-publication", "journal.json");
        const current = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
        const { checksumSha256: _checksum, ...body } = current;
        body.updatedAt = "2026-09-07T23:59:59.000Z";
        writeFileSync(journalPath, `${JSON.stringify({
          ...body,
          checksumSha256: backendPublicationCanonicalSha256(body),
        })}\n`, { mode: 0o600 });
      },
    })).rejects.toMatchObject({ reason: "maintenance-mismatch" });
    expect(() => statSync(join(generationDirectory(fixture.homeDir), "witness.committed"))).toThrow();
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: fixture.homeDir }))
      .toEqual({ state: "partial", generationId: "generation-1" });
  });

  it("rejects invalid capture clocks and post-marker readback loss", async () => {
    const invalidClock = await heldFixture();
    await expect(captureFixture(invalidClock, { now: () => new Date(Number.NaN) }))
      .rejects.toMatchObject({ reason: "invalid-input" });

    const lostMarker = await heldFixture();
    await expect(captureFixture(lostMarker, {
      observe: (boundary, path) => {
        if (boundary === "after-commit-marker") rmSync(join(path, "witness.committed"));
      },
    })).rejects.toMatchObject({ reason: "snapshot-io" });
    expect(await classifySqliteSnapshotArtifact("generation-1", { homeDir: lostMarker.homeDir }))
      .toEqual({ state: "partial", generationId: "generation-1" });
  });

  it("rejects invalid maintenance hashes and oversized immutable controls", async () => {
    const invalidHash = await heldFixture();
    await expect(captureSqliteSnapshotArtifact(invalidHash.authority, {
      homeDir: invalidHash.homeDir,
      generationId: "generation-1",
      maintenanceChecksumSha256: "invalid",
      expectedSourceBytes: invalidHash.expectedSourceBytes,
    })).rejects.toMatchObject({ reason: "invalid-input" });

    const base = sourceFixture();
    const aliases = Array.from({ length: 300 }, (_, index) => `/${"a".repeat(3800)}-${String(index).padStart(3, "0")}`).sort();
    const authority = withAuthority(base.authority, { aliases });
    const oversized = await prepareFixture({ ...base, authority });
    await expect(captureFixture(oversized)).rejects.toMatchObject({ reason: "invalid-input" });
    expect(() => statSync(join(generationDirectory(base.homeDir), "witness.committed"))).toThrow();
  });

  it("does not publish a marker after injected read, close, or fsync failure", async () => {
    const cases: readonly Readonly<{ name: string; operations: () => Partial<SqliteSnapshotOperations> }>[] = [
      {
        name: "read",
        operations: () => {
          let armed = false;
          return {
            observe: (boundary) => { if (boundary === "after-source-open") armed = true; },
            read: (fd, buffer, offset, length, position) => {
              if (armed) { armed = false; throw new Error("read failed"); }
              return readSync(fd, buffer, offset, length, position);
            },
          };
        },
      },
      {
        name: "close",
        operations: () => {
          let armed = false;
          return {
            observe: (boundary) => { if (boundary === "before-source-close") armed = true; },
            close: (fd) => {
              closeSync(fd);
              if (armed) { armed = false; throw new Error("close failed"); }
            },
          };
        },
      },
      {
        name: "fsync",
        operations: () => {
          let armed = false;
          return {
            observe: (boundary) => { if (boundary === "before-private-fsync") armed = true; },
            fsync: () => {
              if (armed) { armed = false; throw new Error("fsync failed"); }
            },
          };
        },
      },
    ];
    for (const testCase of cases) {
      const fixture = await heldFixture();
      await expect(captureFixture(fixture, testCase.operations()), testCase.name)
        .rejects.toMatchObject({ reason: "snapshot-io" });
      expect(() => statSync(join(generationDirectory(fixture.homeDir), "witness.committed"))).toThrow();
    }
  });

  it("refuses non-UTF-8 and nonzero-user-version private copies", async () => {
    const utf16 = await heldFixture();
    const sequence = utf16.authority.machineSequenceDbPath;
    utf16.openDatabases[2]!.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${sequence}${suffix}`, { force: true });
    const utf16Db = new DatabaseSync(sequence);
    databases.push(utf16Db);
    utf16Db.exec("PRAGMA encoding = 'UTF-16le'; CREATE TABLE sequence_data (value TEXT)");
    chmodSync(sequence, 0o600);
    await expect(captureFixture(utf16)).rejects.toMatchObject({ reason: "unsupported-sqlite" });

    const versioned = await heldFixture();
    versioned.openDatabases[1]!.exec("PRAGMA user_version = 1");
    await expect(captureFixture(versioned)).rejects.toMatchObject({ reason: "unsupported-sqlite" });
  });

  it("captures required roles without WAL or an optional passive database", async () => {
    const fixture = sourceFixture();
    for (const database of fixture.openDatabases) database.close();
    const authority = withAuthority(fixture.authority, { passiveEventsDbPath: null });
    const expectedSourceBytes = await withBackendPublicationConsumerLockAsync(
      fixture.homeDir,
      (lockToken) => authenticateSqliteSnapshotSourceBytes(authority, { homeDir: fixture.homeDir, lockToken }),
      { allowUnresolved: true },
    );
    const maintenance = await coordinator(fixture.homeDir).enterMaintenance({
      ...maintenanceInput(authority),
      queueEvidenceSha256: expectedSourceBytes.checksumSha256,
    });
    const witness = await captureSqliteSnapshotArtifact(authority, {
      homeDir: fixture.homeDir,
      generationId: "generation-1",
      maintenanceChecksumSha256: maintenance.checksumSha256,
      expectedSourceBytes,
    });
    expect(witness.roles.map((role) => role.role)).toEqual(["project", "machine-sequence"]);
    expect(witness.roles.every((role) => role.rawWal === null && role.source.shmBefore === null)).toBe(true);
  });

  it("fails dry-run when private cleanup fails, including after a capture error", async () => {
    const cleanupOnly = await heldFixture();
    await expect(dryRunSqliteSnapshotArtifact(cleanupOnly.authority, {
      homeDir: cleanupOnly.homeDir,
      _operationsForTesting: { remove: () => { throw new Error("cleanup failed"); } },
    })).rejects.toMatchObject({ reason: "snapshot-io" });

    const combined = await heldFixture();
    await expect(dryRunSqliteSnapshotArtifact(combined.authority, {
      homeDir: combined.homeDir,
      _operationsForTesting: {
        observe: (boundary) => { if (boundary === "after-source-copy") throw new Error("capture failed"); },
        remove: () => { throw new Error("cleanup failed"); },
      },
    })).rejects.toMatchObject({ reason: "snapshot-io" });
  });
});
