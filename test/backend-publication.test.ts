import { AsyncResource } from "node:async_hooks";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackendPublicationCoordinator,
  BackendPublicationAppendBarrierTimeoutError,
  BackendPublicationRetainedAppendAdmissionStoppedError,
  BackendPublicationJournalError,
  assertBackendPublicationConsumerAccess,
  assertBackendPublicationConfigReadAccess,
  backendPublicationDirectory,
  backendPublicationHistoryDirectory,
  backendPublicationJournalPath,
  backendPublicationCanonicalSha256,
  backendPublicationMaterialWitness,
  captureBackendPublicationFileWitness,
  readBackendPublicationJournal,
  readBackendMaintenanceJournal,
  withBackendPublicationConfigLock,
  withBackendPublicationConsumerLock,
  withBackendPublicationConsumerLockAsync,
  withBackendPublicationAppendBarrier,
  withBackendPublicationAppendBarrierAsync,
  withBackendPublicationRetainedAppendAdmissionAsync,
  type BackendPublicationDriver,
  type BackendPublicationJournal,
  type BackendMaintenanceJournal,
  type BackendPublicationFenceRecord,
  type BackendPublicationRecoveryFile,
  type BackendPublicationRecoveryMaterial,
  type BackendPublicationStateWitness,
} from "../src/storage/backend-publication.js";
import { PrivateMutationLockContentionError, PrivateMutationPermitRevokedError } from "../src/private-mutation-lock.js";
import { withRevocablePrivateMutationPermit } from "../src/private-mutation-lock.js";
import { PrivateDirectoryTopologyError } from "../src/security-files.js";
import {
  assertHomeLockTopology,
  closeHomeLockTopology,
  openHomeLockTopology,
  restoreHomeLockTopologyMode,
} from "../src/storage/home-lock-topology.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-backend-publication-"));
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  roots.push(home);
  return home;
}

function recoveryFile(content: string, mode = 0o600): BackendPublicationRecoveryFile {
  return {
    presence: "present",
    content: Buffer.from(content),
    mode,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
    nlink: "1",
    dev: "1",
    ino: "2",
    parentDev: "3",
    parentIno: "4",
  };
}

function material(): BackendPublicationRecoveryMaterial {
  return {
    source: {
      config: recoveryFile('{"backend":"sqlite"}'),
      projectMap: recoveryFile('{"projects":[]}'),
    },
    target: {
      config: recoveryFile('{"backend":"postgresql"}'),
      projectMap: recoveryFile('{"projects":["remote"]}'),
    },
  };
}

function targetState(input: BackendPublicationRecoveryMaterial): BackendPublicationStateWitness {
  return backendPublicationMaterialWitness({
    source: input.target,
    target: input.target,
  });
}

function sourceState(input: BackendPublicationRecoveryMaterial): BackendPublicationStateWitness {
  return backendPublicationMaterialWitness(input);
}

function projectInput() {
  return [{
    localProjectId: "local-project",
    remoteProjectId: "remote-project",
    evidenceSha256: "a".repeat(64),
  }] as const;
}

function makeDriver(input: BackendPublicationRecoveryMaterial): {
  driver: BackendPublicationDriver;
  getState: () => BackendPublicationStateWitness;
  setState: (state: BackendPublicationStateWitness) => void;
  calls: string[];
} {
  let state = sourceState(input);
  const expectedTarget = targetState(input);
  const calls: string[] = [];
  const driver: BackendPublicationDriver = {
    observeLocalState: vi.fn(async () => state),
    publishProjectMap: vi.fn(async ({ permit }) => {
      permit.assertActive();
      calls.push("publish-map");
      state = { ...state, projectMap: expectedTarget.projectMap };
      return expectedTarget.projectMap;
    }),
    publishConfig: vi.fn(async ({ permit }) => {
      permit.assertActive();
      calls.push("publish-config");
      state = { ...state, config: expectedTarget.config };
      return expectedTarget.config;
    }),
    restoreConfig: vi.fn(async ({ permit }) => {
      permit.assertActive();
      calls.push("restore-config");
      state = { ...state, config: sourceState(input).config };
      return sourceState(input).config;
    }),
    restoreProjectMap: vi.fn(async ({ permit }) => {
      permit.assertActive();
      calls.push("restore-map");
      state = { ...state, projectMap: sourceState(input).projectMap };
      return sourceState(input).projectMap;
    }),
  };
  return { driver, getState: () => state, setState: (next) => { state = next; }, calls };
}

function coordinator(
  homeDir: string,
  driver: BackendPublicationDriver,
  observer?: (event: string, path: string) => void,
): BackendPublicationCoordinator {
  return new BackendPublicationCoordinator({ homeDir, driver, observer });
}

async function withPatchedFsAsync<T>(
  name: string,
  replacement: unknown,
  callback: () => Promise<T>,
): Promise<T> {
  const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
  const original = nodeFs[name];
  nodeFs[name] = replacement;
  syncBuiltinESMExports();
  try {
    return await callback();
  } finally {
    nodeFs[name] = original;
    syncBuiltinESMExports();
  }
}

type PublicationDirectoryGeneration = {
  generation: number;
  directory: string;
  fd: number;
  closed: number;
  fstatPhases: string[];
};

type ArchiveDirectoryDescriptor = {
  path: string;
  fd: number;
  dev: string;
  ino: string;
  closed: number;
};

type ArchiveDirectoryEvent = Readonly<{
  operation: "assert" | "fsync" | "close";
  path: string;
  fd: number;
  dev: string;
  ino: string;
}>;

function archiveDirectoryIdentity(stat: unknown): Readonly<{ dev: string; ino: string }> {
  const identity = stat as Readonly<{ dev: number | bigint; ino: number | bigint }>;
  return { dev: String(identity.dev), ino: String(identity.ino) };
}

function assertExactArchiveDirectoryEvents(
  actual: readonly ArchiveDirectoryEvent[],
  expected: readonly ArchiveDirectoryEvent[],
): void {
  expect(actual).toEqual(expected);
}

function expectedArchiveDirectoryEvent(
  operation: ArchiveDirectoryEvent["operation"],
  descriptor: ArchiveDirectoryDescriptor,
): ArchiveDirectoryEvent {
  return {
    operation,
    path: descriptor.path,
    fd: descriptor.fd,
    dev: descriptor.dev,
    ino: descriptor.ino,
  };
}

async function withTrackedArchiveDirectoryDescriptors<T>(
  home: string,
  callback: (tracking: Readonly<{
    records: ArchiveDirectoryDescriptor[];
    events: ArchiveDirectoryEvent[];
    beginSyncOrder: () => void;
    completeSyncOrder: () => void;
    admitted: () => Readonly<{
      history: ArchiveDirectoryDescriptor;
      outer: ArchiveDirectoryDescriptor;
    }>;
    failNextSync: (path: string, error: Error) => void;
  }>) => Promise<T>,
): Promise<T> {
  const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
  const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
  const originalClose = nodeFs.closeSync as (fd: number) => void;
  const originalFstat = nodeFs.fstatSync as (...args: unknown[]) => unknown;
  const originalFsync = nodeFs.fsyncSync as (fd: number) => void;
  const publication = backendPublicationDirectory(home);
  const history = backendPublicationHistoryDirectory(home);
  const trackedPaths = new Set([publication, history]);
  const records: ArchiveDirectoryDescriptor[] = [];
  const events: ArchiveDirectoryEvent[] = [];
  const syncFailures = new Map<string, Error>();
  let recordSyncOrder = false;
  let admittedHistory: ArchiveDirectoryDescriptor | undefined;
  let admittedOuter: ArchiveDirectoryDescriptor | undefined;
  const activeRecord = (fd: number): ArchiveDirectoryDescriptor | undefined => (
    [...records].reverse().find((record) => record.fd === fd && record.closed === 0)
  );
  const eventFor = (
    operation: ArchiveDirectoryEvent["operation"],
    record: ArchiveDirectoryDescriptor,
    stat: unknown,
  ): ArchiveDirectoryEvent => ({
    operation,
    path: record.path,
    fd: record.fd,
    ...archiveDirectoryIdentity(stat),
  });

  return withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
    const fd = originalOpen(path, ...args);
    if (trackedPaths.has(path)) {
      records.push({
        path,
        fd,
        ...archiveDirectoryIdentity(originalFstat(fd, { bigint: true })),
        closed: 0,
      });
    }
    return fd;
  }) as never, async () => withPatchedFsAsync("closeSync", ((fd: number) => {
    const record = activeRecord(fd);
    const closeStat = recordSyncOrder && record !== undefined
      ? originalFstat(fd, { bigint: true })
      : undefined;
    originalClose(fd);
    if (record !== undefined) record.closed += 1;
    if (record !== undefined && closeStat !== undefined) {
      events.push(eventFor("close", record, closeStat));
    }
  }) as never, async () => withPatchedFsAsync("fstatSync", ((fd: number, ...args: unknown[]) => {
    const observed = originalFstat(fd, ...args);
    if (recordSyncOrder) {
      const record = activeRecord(fd);
      if (record !== undefined) events.push(eventFor("assert", record, observed));
    }
    return observed;
  }) as never, async () => withPatchedFsAsync("fsyncSync", ((fd: number) => {
    const record = activeRecord(fd);
    if (recordSyncOrder && record !== undefined) {
      events.push(eventFor("fsync", record, originalFstat(fd, { bigint: true })));
    }
    if (record !== undefined) {
      const failure = syncFailures.get(record.path);
      if (failure !== undefined) {
        syncFailures.delete(record.path);
        throw failure;
      }
    }
    originalFsync(fd);
  }) as never, async () => callback({
    records,
    events,
    beginSyncOrder: () => {
      admittedHistory = [...records].reverse().find(
        (record) => record.path === history && record.closed === 0,
      );
      admittedOuter = [...records].reverse().find(
        (record) => record.path === publication && record.closed === 0,
      );
      if (admittedHistory === undefined || admittedOuter === undefined) {
        throw new Error("archive directory descriptors were not admitted before sync");
      }
      recordSyncOrder = true;
    },
    completeSyncOrder: () => {
      if (!recordSyncOrder || admittedHistory === undefined || admittedHistory.closed !== 1) {
        throw new Error("archive directory operation completed before retained history cleanup");
      }
      recordSyncOrder = false;
    },
    admitted: () => {
      if (admittedHistory === undefined || admittedOuter === undefined) {
        throw new Error("archive directory descriptor admission was not recorded");
      }
      return { history: admittedHistory, outer: admittedOuter };
    },
    failNextSync: (path, error) => { syncFailures.set(path, error); },
  })))));
}

async function withTrackedPublicationDirectoryGenerations<T>(
  directories: readonly string[],
  callback: (tracking: Readonly<{
    records: PublicationDirectoryGeneration[];
    active: (directory: string) => PublicationDirectoryGeneration[];
    beginOperation: (directory: string) => void;
    setEnabled: (enabled: boolean) => void;
    setPhase: (directory: string, phase: string) => void;
  }>) => Promise<T>,
): Promise<T> {
  const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
  const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
  const originalClose = nodeFs.closeSync as (fd: number) => void;
  const originalFstat = nodeFs.fstatSync as (...args: unknown[]) => unknown;
  const trackedDirectories = new Set(directories);
  const phases = new Map<string, string>();
  const records: PublicationDirectoryGeneration[] = [];
  const journalDescriptors: { directory: string; fd: number; closed: boolean }[] = [];
  const pendingJournalPostFstats = new Map<string, number>();
  const captureNextJournalAttempt = new Map<string, boolean>();
  let enabled = true;
  let nextGeneration = 1;
  const active = (directory: string): PublicationDirectoryGeneration[] => records.filter(
    (record) => record.directory === directory && record.closed === 0,
  );

  await withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
    const journalDirectory = directories.find((directory) => path === join(directory, "journal.json"));
    const captureJournal = journalDirectory !== undefined
      && captureNextJournalAttempt.get(journalDirectory) === true;
    if (captureJournal) captureNextJournalAttempt.set(journalDirectory, false);
    const fd = originalOpen(path, ...args);
    if (enabled && trackedDirectories.has(path)) {
      records.push({
        generation: nextGeneration,
        directory: path,
        fd,
        closed: 0,
        fstatPhases: [],
      });
      nextGeneration += 1;
    } else if (captureJournal) {
      journalDescriptors.push({ directory: journalDirectory, fd, closed: false });
    }
    return fd;
  }) as never, async () => withPatchedFsAsync("closeSync", ((fd: number) => {
    const record = [...records].reverse().find((candidate) => (
      candidate.fd === fd && candidate.closed === 0
    ));
    const journal = [...journalDescriptors].reverse().find((candidate) => (
      candidate.fd === fd && !candidate.closed
    ));
    originalClose(fd);
    if (record !== undefined) record.closed += 1;
    if (journal !== undefined) {
      journal.closed = true;
      pendingJournalPostFstats.set(
        journal.directory,
        (pendingJournalPostFstats.get(journal.directory) ?? 0) + 1,
      );
    }
  }) as never, async () => withPatchedFsAsync("fstatSync", ((fd: number, ...args: unknown[]) => {
    const observed = originalFstat(fd, ...args);
    const record = [...records].reverse().find((candidate) => (
      candidate.fd === fd && candidate.closed === 0
    ));
    if (record !== undefined) {
      const pendingJournalPost = pendingJournalPostFstats.get(record.directory) ?? 0;
      if (pendingJournalPost > 0) {
        record.fstatPhases.push("journal");
        pendingJournalPostFstats.set(record.directory, pendingJournalPost - 1);
      } else {
        record.fstatPhases.push(phases.get(record.directory) ?? "setup");
      }
    }
    return observed;
  }) as never, async () => callback({
    records,
    active,
    beginOperation: (directory) => captureNextJournalAttempt.set(directory, true),
    setEnabled: (nextEnabled) => { enabled = nextEnabled; },
    setPhase: (directory, phase) => phases.set(directory, phase),
  }))));
}

async function withTemporaryReboundPublicationMaterial(
  home: string,
  callback: () => unknown | Promise<unknown>,
): Promise<Readonly<{ injected: boolean; restored: boolean; error: unknown }>> {
  const publicationDirectory = backendPublicationDirectory(home);
  const originalDirectory = `${publicationDirectory}.original`;
  const materialPath = join(publicationDirectory, "publication-1.material");
  const materialContent = readFileSync(materialPath);
  const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
  const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
  const originalClose = nodeFs.closeSync as (fd: number) => void;
  let materialFd: number | undefined;
  let injected = false;
  let restored = false;
  let error: unknown;
  const restore = (): void => {
    if (!injected || restored) return;
    rmSync(publicationDirectory, { recursive: true, force: true });
    renameSync(originalDirectory, publicationDirectory);
    restored = true;
  };

  try {
    nodeFs.openSync = ((path: string, ...args: unknown[]) => {
      if (path !== materialPath || injected) return originalOpen(path, ...args);
      injected = true;
      renameSync(publicationDirectory, originalDirectory);
      mkdirSync(publicationDirectory, { mode: 0o700 });
      writeFileSync(materialPath, materialContent, { mode: 0o600 });
      materialFd = originalOpen(path, ...args);
      return materialFd;
    }) as never;
    nodeFs.closeSync = ((fd: number) => {
      originalClose(fd);
      if (fd === materialFd) {
        materialFd = undefined;
        restore();
      }
    }) as never;
    syncBuiltinESMExports();
    try {
      await callback();
    } catch (caught) {
      error = caught;
    }
  } finally {
    nodeFs.openSync = originalOpen;
    nodeFs.closeSync = originalClose;
    syncBuiltinESMExports();
    restore();
  }
  return { injected, restored, error };
}

function rebindPublicationDirectoryWithEvidence(home: string): Readonly<{
  originalDirectory: string;
  journal: Buffer | undefined;
}> {
  const directory = backendPublicationDirectory(home);
  const originalDirectory = `${directory}.checkpoint-original`;
  const journalPath = backendPublicationJournalPath(home);
  const journal = existsSync(journalPath) ? readFileSync(journalPath) : undefined;
  renameSync(directory, originalDirectory);
  mkdirSync(directory, { mode: 0o700 });
  for (const name of ["journal.json", "publication-1.material"]) {
    const source = join(originalDirectory, name);
    if (existsSync(source)) writeFileSync(join(directory, name), readFileSync(source), { mode: 0o600 });
  }
  return { originalDirectory, journal };
}

function inputFor(materialInput: BackendPublicationRecoveryMaterial) {
  return {
    publicationId: "publication-1",
    sourceBackend: "sqlite" as const,
    targetBackend: "postgresql" as const,
    material: materialInput,
    projects: projectInput(),
    now: new Date("2026-08-06T12:00:00.000Z"),
  };
}

async function createMaintenanceState(
  home: string,
  driver: BackendPublicationDriver,
  phase: "maintenance-entering" | "maintenance-held" | "selection-prepared" | "selection-completed" | "maintenance-aborted",
  targetBackend: "sqlite" | "postgresql" = "postgresql",
): Promise<BackendMaintenanceJournal> {
  const active = coordinator(home, driver);
  const held = await active.enterMaintenance({
    publicationId: "maintenance-publication",
    generationId: "maintenance-generation",
    sourceSelectionSha256: "a".repeat(64),
    queueEvidenceSha256: "b".repeat(64),
    roster: [{
      machineId: "018f0b5d-1234-4abc-8def-1234567890ab",
      queueCutoff: null,
      evidenceSha256: "a".repeat(64),
    }],
  });
  if (phase === "maintenance-held") return held;
  if (phase === "maintenance-entering") {
    rewriteJournal(home, (journal) => ({ ...journal, phase }));
    return readBackendMaintenanceJournal(home)!;
  }
  if (phase === "maintenance-aborted") {
    return active.abortMaintenance({
      expectedChecksumSha256: held.checksumSha256,
      sourceSelectionSha256: held.sourceSelectionSha256,
      abortEvidenceSha256: "c".repeat(64),
    });
  }
  const prepared = await active.prepareMaintenanceSelection({
    expectedChecksumSha256: held.checksumSha256,
    generationId: held.generationId,
    targetBackend,
    terminalEvidenceSha256: "c".repeat(64),
  });
  if (phase === "selection-prepared") return prepared;
  return active.completeMaintenanceSelection({
    expectedChecksumSha256: prepared.checksumSha256,
    generationId: prepared.generationId,
    terminalEvidenceSha256: prepared.terminalEvidenceSha256!,
  });
}

function maintenanceArchivePath(home: string, journal: BackendMaintenanceJournal): string {
  return join(
    backendPublicationHistoryDirectory(home),
    `${journal.publicationId}.${journal.checksumSha256}.json`,
  );
}

type TerminalArchiveFixture = Readonly<{
  bytes: Buffer;
  journal: BackendPublicationJournal | BackendMaintenanceJournal;
  version: 2 | 3;
}>;

async function terminalArchiveFixture(
  home: string,
  version: 2 | 3,
): Promise<TerminalArchiveFixture> {
  const input = material();
  const fake = makeDriver(input);
  let journal: BackendPublicationJournal | BackendMaintenanceJournal;
  if (version === 2) {
    await coordinator(home, fake.driver).prepare(inputFor(input));
    journal = await coordinator(home, fake.driver).resume();
  } else {
    journal = await createMaintenanceState(home, fake.driver, "selection-completed");
  }
  return {
    bytes: readFileSync(backendPublicationJournalPath(home)),
    journal,
    version,
  };
}

function validJournalBytes(
  bytes: Buffer,
  mutate: (journal: Record<string, unknown>) => Record<string, unknown>,
): Buffer {
  const current = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const next = mutate(current);
  const { checksumSha256: _checksum, ...payload } = next;
  return Buffer.from(`${JSON.stringify({
    ...payload,
    checksumSha256: backendPublicationCanonicalSha256(payload),
  })}\n`);
}

function countingDriver(input: BackendPublicationRecoveryMaterial): Readonly<{
  calls: string[];
  driver: BackendPublicationDriver;
}> {
  const base = makeDriver(input).driver;
  const calls: string[] = [];
  return {
    calls,
    driver: {
      async observeLocalState(context) {
        calls.push("observe-local-state");
        return base.observeLocalState(context);
      },
      async publishProjectMap(context) {
        calls.push("publish-project-map");
        return base.publishProjectMap(context);
      },
      async publishConfig(context) {
        calls.push("publish-config");
        return base.publishConfig(context);
      },
      async restoreConfig(context) {
        calls.push("restore-config");
        return base.restoreConfig(context);
      },
      async restoreProjectMap(context) {
        calls.push("restore-project-map");
        return base.restoreProjectMap(context);
      },
    },
  };
}

type ArchiveRereadOperation = "prepare" | "enter-maintenance";

type ArchiveRereadReplacement =
  | "malformed-json"
  | "null"
  | "array"
  | "scalar"
  | "unsupported-version"
  | "unknown-field"
  | "malformed-checksum"
  | "payload-checksum-mismatch"
  | "cross-version"
  | "same-version-change";

const ARCHIVE_REREAD_REFUSALS = [
  { name: "malformed JSON after v2", version: 2, replacement: "malformed-json", reason: "malformed-journal", message: "backend publication journal is not valid JSON" },
  { name: "malformed JSON after v3", version: 3, replacement: "malformed-json", reason: "malformed-journal", message: "backend publication journal is not valid JSON" },
  { name: "null JSON", version: 2, replacement: "null", reason: "malformed-journal", message: "backend publication journal is not an object" },
  { name: "array JSON", version: 3, replacement: "array", reason: "malformed-journal", message: "backend publication journal is not an object" },
  { name: "scalar JSON", version: 2, replacement: "scalar", reason: "malformed-journal", message: "backend publication journal is not an object" },
  { name: "unsupported v2-shaped version", version: 2, replacement: "unsupported-version", reason: "malformed-journal", message: "backend publication journal fields are malformed" },
  { name: "unsupported v3-shaped version", version: 3, replacement: "unsupported-version", reason: "malformed-journal", message: "backend publication journal has unknown fields" },
  { name: "unknown v2 field", version: 2, replacement: "unknown-field", reason: "malformed-journal", message: "backend publication journal has unknown fields" },
  { name: "unknown v3 field", version: 3, replacement: "unknown-field", reason: "malformed-journal", message: "backend maintenance journal has unknown fields" },
  { name: "malformed v2 checksum", version: 2, replacement: "malformed-checksum", reason: "malformed-journal", message: "backend publication journal checksum is malformed" },
  { name: "malformed v3 checksum", version: 3, replacement: "malformed-checksum", reason: "checksum-mismatch", message: "backend maintenance journal checksum does not match" },
  { name: "v2 payload checksum mismatch", version: 2, replacement: "payload-checksum-mismatch", reason: "checksum-mismatch", message: "backend publication journal checksum does not match" },
  { name: "v3 payload checksum mismatch", version: 3, replacement: "payload-checksum-mismatch", reason: "checksum-mismatch", message: "backend maintenance journal checksum does not match" },
  { name: "v2-to-v3 substitution", version: 2, replacement: "cross-version", reason: "unexpected-state", message: "backend publication journal changed before archive" },
  { name: "v3-to-v2 substitution", version: 3, replacement: "cross-version", reason: "unexpected-state", message: "backend publication journal changed before archive" },
  { name: "valid changed v2 checksum", version: 2, replacement: "same-version-change", reason: "unexpected-state", message: "backend publication journal changed before archive" },
  { name: "valid changed v3 checksum", version: 3, replacement: "same-version-change", reason: "unexpected-state", message: "backend publication journal changed before archive" },
] as const satisfies readonly Readonly<{
  name: string;
  version: 2 | 3;
  replacement: ArchiveRereadReplacement;
  reason: BackendPublicationJournalError["reason"];
  message: string;
}>[];

async function runArchiveRereadOperation(
  operation: ArchiveRereadOperation,
  home: string,
  driver: BackendPublicationDriver,
  observer: (event: string, path: string) => void,
): Promise<BackendPublicationJournal | BackendMaintenanceJournal> {
  const active = coordinator(home, driver, observer);
  if (operation === "prepare") {
    return active.prepare({
      ...inputFor(material()),
      publicationId: "archive-reread-next",
    });
  }
  return active.enterMaintenance({
    publicationId: "archive-reread-maintenance",
    generationId: "archive-reread-generation",
    sourceSelectionSha256: "d".repeat(64),
    queueEvidenceSha256: "e".repeat(64),
    roster: [{
      machineId: "018f0b5d-1234-4abc-8def-1234567890ab",
      queueCutoff: null,
      evidenceSha256: "f".repeat(64),
    }],
  });
}

async function replacementArchiveBytes(
  fixture: TerminalArchiveFixture,
  replacement: ArchiveRereadReplacement,
): Promise<Buffer> {
  if (replacement === "malformed-json") return Buffer.from(`{"version":${fixture.version}`);
  if (replacement === "null") return Buffer.from("null\n");
  if (replacement === "array") return Buffer.from("[]\n");
  if (replacement === "scalar") return Buffer.from('"terminal"\n');
  if (replacement === "cross-version") {
    const otherHome = makeHome();
    return (await terminalArchiveFixture(otherHome, fixture.version === 2 ? 3 : 2)).bytes;
  }
  if (replacement === "unsupported-version") {
    return validJournalBytes(fixture.bytes, (journal) => ({ ...journal, version: 99 }));
  }
  if (replacement === "unknown-field") {
    return validJournalBytes(fixture.bytes, (journal) => ({ ...journal, unexpected: true }));
  }
  if (replacement === "same-version-change") {
    return validJournalBytes(fixture.bytes, (journal) => ({
      ...journal,
      updatedAt: "2026-09-16T12:00:00.000Z",
    }));
  }
  const journal = JSON.parse(fixture.bytes.toString("utf8")) as Record<string, unknown>;
  if (replacement === "malformed-checksum") journal.checksumSha256 = "not-a-checksum";
  else journal.updatedAt = "2026-09-16T12:00:00.000Z";
  return Buffer.from(`${JSON.stringify(journal)}\n`);
}

function fenceRecord(overrides: Partial<BackendPublicationFenceRecord> = {}): BackendPublicationFenceRecord {
  return {
    projectId: "remote-project",
    machineId: "machine-1",
    publicationId: "publication-1",
    targetBackend: "postgresql",
    evidenceSha256: "a".repeat(64),
    fencingToken: "1",
    acquiredAt: "2026-08-06T12:00:00.000Z",
    renewedAt: "2026-08-06T12:00:00.000Z",
    expiresAt: "2999-08-06T12:00:00.000Z",
    releasedAt: null,
    databaseExpired: false,
    ...overrides,
  };
}

async function releasingFixture(): Promise<{
  home: string;
  input: BackendPublicationRecoveryMaterial;
  fake: ReturnType<typeof makeDriver>;
  getFence: () => BackendPublicationFenceRecord | null;
  setFence: (fence: BackendPublicationFenceRecord | null) => void;
}> {
  const home = makeHome();
  const input = material();
  const fake = makeDriver(input);
  let currentFence: BackendPublicationFenceRecord | null = null;
  fake.driver.acquireRemoteGuard = vi.fn(async () => {
    currentFence = fenceRecord();
    return currentFence;
  });
  fake.driver.readRemoteGuard = vi.fn(async () => currentFence);
  fake.driver.releaseRemoteGuard = vi.fn(async () => {
    if (currentFence !== null) currentFence = fenceRecord({ releasedAt: "2026-08-06T12:01:00.000Z" });
  });
  await coordinator(home, fake.driver).prepare(inputFor(input));
  await expect(coordinator(home, fake.driver, (event) => {
    if (event === "before-release") throw new Error("crash:release-boundary");
  }).resume()).rejects.toThrow("crash:release-boundary");
  expect(readBackendPublicationJournal(home)?.phase).toBe("releasing");
  return {
    home,
    input,
    fake,
    getFence: () => currentFence,
    setFence: (fence) => { currentFence = fence; },
  };
}

function rewriteJournal(
  home: string,
  mutate: (journal: Record<string, unknown>) => Record<string, unknown>,
): void {
  const path = backendPublicationJournalPath(home);
  const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const next = mutate(current);
  const { checksumSha256: _checksum, ...payload } = next;
  writeFileSync(path, `${JSON.stringify({
    ...payload,
    checksumSha256: backendPublicationCanonicalSha256(payload),
  })}\n`, { mode: 0o600 });
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function configReadWitness(path: string): {
  presence: "absent" | "present";
  rawSha256: string | null;
  byteLength: number;
  dev: string | null;
  ino: string | null;
} {
  const witness = captureBackendPublicationFileWitness(path, join(path, ".."), 4 * 1024 * 1024).witness;
  return {
    presence: witness.presence,
    rawSha256: witness.rawSha256,
    byteLength: witness.byteLength,
    dev: witness.dev,
    ino: witness.ino,
  };
}

function rewriteMaterial(home: string, content: string): void {
  const path = join(backendPublicationDirectory(home), "publication-1.material");
  writeFileSync(path, content, { mode: 0o600 });
  rewriteJournal(home, (journal) => ({
    ...journal,
    recoveryReference: {
      relativePath: "publication-1.material",
      sealSha256: sha256(content),
      byteLength: Buffer.byteLength(content),
    },
  }));
}

async function preparedFixture(): Promise<{
  home: string;
  input: BackendPublicationRecoveryMaterial;
  fake: ReturnType<typeof makeDriver>;
}> {
  const home = makeHome();
  const input = material();
  const fake = makeDriver(input);
  await coordinator(home, fake.driver).prepare(inputFor(input));
  return { home, input, fake };
}

type CoordinatorDriftCheckpoint =
  | "preparing"
  | "guarded"
  | "map-publishing"
  | "map-published"
  | "config-publishing"
  | "aborting"
  | "config-restoring"
  | "map-restoring"
  | "abort-releasing"
  | "released-replay"
  | "released-forward";

async function coordinatorDriftFixture(checkpoint: CoordinatorDriftCheckpoint): Promise<{
  home: string;
  fake: ReturnType<typeof makeDriver>;
}> {
  const home = makeHome();
  const input = material();
  const fake = makeDriver(input);
  if (checkpoint === "preparing") {
    await expect(coordinator(home, fake.driver, (event) => {
      if (event === "after-material-seal") throw new Error("crash:park-preparing");
    }).prepare(inputFor(input))).rejects.toThrow("crash:park-preparing");
  } else {
    await coordinator(home, fake.driver).prepare(inputFor(input));
    if (checkpoint !== "released-forward") {
      if (checkpoint === "config-restoring") fake.setState(targetState(input));
      const aborting = ["aborting", "config-restoring", "map-restoring", "abort-releasing"].includes(checkpoint);
      const parkedPhase = checkpoint === "released-replay" ? "released" : checkpoint;
      const parked = coordinator(home, fake.driver, (event) => {
        if (
          event === "after-journal-write"
          && readBackendPublicationJournal(home)?.phase === parkedPhase
        ) throw new Error(`crash:park-${checkpoint}`);
      });
      await expect(aborting ? parked.abort() : parked.resume()).rejects.toThrow(`crash:park-${checkpoint}`);
    }
  }
  expect(readBackendPublicationJournal(home)?.phase).toBe(
    checkpoint === "released-forward"
      ? "prepared"
      : checkpoint === "released-replay" ? "released" : checkpoint,
  );
  fake.calls.length = 0;
  vi.mocked(fake.driver.observeLocalState).mockClear();
  vi.mocked(fake.driver.publishProjectMap).mockClear();
  vi.mocked(fake.driver.publishConfig).mockClear();
  vi.mocked(fake.driver.restoreConfig).mockClear();
  vi.mocked(fake.driver.restoreProjectMap).mockClear();
  return { home, fake };
}

function coordinatorDriverCallCounts(driver: BackendPublicationDriver): Record<string, number> {
  return {
    observeLocalState: vi.mocked(driver.observeLocalState).mock.calls.length,
    publishProjectMap: vi.mocked(driver.publishProjectMap).mock.calls.length,
    publishConfig: vi.mocked(driver.publishConfig).mock.calls.length,
    restoreConfig: vi.mocked(driver.restoreConfig).mock.calls.length,
    restoreProjectMap: vi.mocked(driver.restoreProjectMap).mock.calls.length,
    retainCompletedMaterial: vi.mocked(driver.retainCompletedMaterial!).mock.calls.length,
    cleanupAbortedMaterial: vi.mocked(driver.cleanupAbortedMaterial!).mock.calls.length,
  };
}

async function expectJournalReadFailure(
  mutate: (journal: Record<string, unknown>) => Record<string, unknown>,
  reason: BackendPublicationJournalError["reason"] = "malformed-journal",
): Promise<void> {
  const { home } = await preparedFixture();
  rewriteJournal(home, mutate);
  let thrown: unknown;
  try {
    readBackendPublicationJournal(home);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ reason });
}

async function expectMaterialReadFailure(
  content: string,
  reason: BackendPublicationJournalError["reason"] = "malformed-journal",
): Promise<void> {
  const { home, fake } = await preparedFixture();
  rewriteMaterial(home, content);
  await expect(coordinator(home, fake.driver).resume()).rejects.toMatchObject({ reason });
}

describe("BackendPublicationCoordinator", () => {
  it.each([
    { boundary: "before-journal-read", operation: "prepare" },
    { boundary: "before-journal-write", operation: "prepare" },
    { boundary: "after-material-authenticate", operation: "prepare-post-auth" },
    { boundary: "before-journal-read", operation: "resume" },
    { boundary: "before-journal-write", operation: "abort" },
    { boundary: "before-journal-read", operation: "recover" },
    { boundary: "before-journal-write", operation: "awaited-local" },
  ] as const)(
    "rejects a $operation directory rebind at $boundary before checkpoint mutation",
    async ({ boundary, operation }) => {
      let home: string;
      let fake: ReturnType<typeof makeDriver>;
      if (operation === "prepare" || operation === "prepare-post-auth") {
        home = makeHome();
        fake = makeDriver(material());
      } else if (operation === "resume" || operation === "abort") {
        ({ home, fake } = await preparedFixture());
      } else if (operation === "recover") {
        ({ home, fake } = await coordinatorDriftFixture("preparing"));
      } else {
        ({ home, fake } = await coordinatorDriftFixture("guarded"));
      }
      const mutationsBefore = [...fake.calls];
      const observationsBefore = vi.mocked(fake.driver.observeLocalState).mock.calls.length;
      let rebound: ReturnType<typeof rebindPublicationDirectoryWithEvidence> | undefined;
      const active = coordinator(home, fake.driver, (event) => {
        if (rebound === undefined && event === boundary) {
          rebound = rebindPublicationDirectoryWithEvidence(home);
        }
      });

      const action = operation === "prepare" || operation === "prepare-post-auth"
        ? active.prepare(inputFor(material()))
        : operation === "abort"
          ? active.abort()
          : operation === "recover"
            ? active.recoverPending()
            : active.resume();
      await expect(action).rejects.toMatchObject({
        name: "BackendPublicationJournalError",
        reason: "unsafe-storage",
        message: "backend publication directory changed during journal checkpoint: private directory changed during validation",
      });

      expect(rebound).toBeDefined();
      const replacementJournalPath = backendPublicationJournalPath(home);
      const originalJournalPath = join(rebound!.originalDirectory, "journal.json");
      if (rebound!.journal === undefined) {
        expect(existsSync(originalJournalPath)).toBe(false);
        expect(existsSync(replacementJournalPath)).toBe(false);
      } else {
        expect(readFileSync(originalJournalPath)).toEqual(rebound!.journal);
        expect(readFileSync(replacementJournalPath)).toEqual(rebound!.journal);
      }
      expect(fake.calls).toEqual(mutationsBefore);
      expect(vi.mocked(fake.driver.observeLocalState).mock.calls.length).toBe(
        observationsBefore + (operation === "awaited-local" ? 1 : operation.startsWith("prepare") ? 1 : 0),
      );
    },
  );

  it.each(["dev", "ino"] as const)(
    "binds a checkpoint CAS read to the retained directory parent %s",
    async (field) => {
    const { home, fake } = await preparedFixture();
    const directory = backendPublicationDirectory(home);
    const journalPath = backendPublicationJournalPath(home);
    const journalBefore = readFileSync(journalPath);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    const originalStat = nodeFs.statSync as (
      path: string,
      options?: { bigint?: boolean },
    ) => { dev: bigint; ino: bigint; [key: string]: unknown };
    let journalOpens = 0;
    let injected = false;

    await withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
      const fd = originalOpen(path, ...args);
      if (path === journalPath) journalOpens += 1;
      return fd;
    }) as never, async () => withPatchedFsAsync("statSync", ((
      path: string,
      options?: { bigint?: boolean },
    ) => {
      const observed = originalStat(path, options);
      if (!injected && journalOpens === 2 && path === directory && options?.bigint === true) {
        injected = true;
        return { ...observed, [field]: observed[field] + 1n };
      }
      return observed;
    }) as never, async () => {
      await expect(coordinator(home, fake.driver).resume()).rejects.toMatchObject({
        name: "BackendPublicationJournalError",
        reason: "unsafe-storage",
        message: "backend publication journal parent does not match the retained checkpoint directory",
      });
    }));

    expect(injected).toBe(true);
    expect(readFileSync(journalPath)).toEqual(journalBefore);
    expect(fake.calls).toEqual([]);
    },
  );

  it.each(["dev", "ino", "gid"] as const)(
    "rejects coherent checkpoint %s drift from the retained witness",
    async (field) => {
    const { home, fake } = await preparedFixture();
    const directory = backendPublicationDirectory(home);
    const journalPath = backendPublicationJournalPath(home);
    const journalBefore = readFileSync(journalPath);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    const originalFstat = nodeFs.fstatSync as (
      fd: number,
      options?: { bigint?: boolean },
    ) => { dev: bigint; ino: bigint; mode: bigint; uid: bigint; gid: bigint; [key: string]: unknown };
    const originalStat = nodeFs.statSync as (
      path: string,
      options?: { bigint?: boolean },
    ) => { dev: bigint; ino: bigint; mode: bigint; uid: bigint; gid: bigint; [key: string]: unknown };
    let directoryOpens = 0;
    let operationFd: number | undefined;
    let driftActive = false;
    let descriptorInjected = false;
    let pathInjected = false;

    await withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
      const fd = originalOpen(path, ...args);
      if (path === directory) {
        directoryOpens += 1;
        if (directoryOpens === 2) operationFd = fd;
      }
      return fd;
    }) as never, async () => withPatchedFsAsync("fstatSync", ((
      fd: number,
      options?: { bigint?: boolean },
    ) => {
      const observed = originalFstat(fd, options);
      if (driftActive && fd === operationFd && options?.bigint === true) {
        descriptorInjected = true;
        return Object.assign(observed, { [field]: observed[field] + 1n });
      }
      return observed;
    }) as never, async () => withPatchedFsAsync("statSync", ((
      path: string,
      options?: { bigint?: boolean },
    ) => {
      const observed = originalStat(path, options);
      if (driftActive && path === directory && options?.bigint === true) {
        pathInjected = true;
        return Object.assign(observed, { [field]: observed[field] + 1n });
      }
      return observed;
    }) as never, async () => {
      await expect(coordinator(home, fake.driver, (event) => {
        if (event === "before-journal-read") driftActive = true;
      }).resume()).rejects.toMatchObject({
        name: "BackendPublicationJournalError",
        reason: "unsafe-storage",
        message: "backend publication directory changed during journal checkpoint: private directory identity changed",
      });
    })));

    expect(operationFd).toBeDefined();
    expect(descriptorInjected).toBe(true);
    expect(pathInjected).toBe(true);
    expect(readFileSync(journalPath)).toEqual(journalBefore);
    expect(fake.calls).toEqual([]);
    },
  );

  it("rejects material whose parent identity diverges from the coordinator witness", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    const publicationDirectory = backendPublicationDirectory(home);
    const materialPath = join(publicationDirectory, "publication-1.material");
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    const originalStat = nodeFs.statSync as (
      path: string,
      options?: { bigint?: boolean },
    ) => { dev: bigint; [key: string]: unknown };
    let authenticationStarted = false;
    let materialOpened = false;
    let injected = false;
    let directoryStatsAfterMaterial = 0;

    await withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
      if (path === materialPath && authenticationStarted) materialOpened = true;
      return originalOpen(path, ...args);
    }) as never, async () => withPatchedFsAsync("statSync", ((path: string, options?: { bigint?: boolean }) => {
      const observed = originalStat(path, options);
      if (path === publicationDirectory && options?.bigint === true && materialOpened) {
        directoryStatsAfterMaterial += 1;
      }
      if (path === publicationDirectory && options?.bigint === true && materialOpened && directoryStatsAfterMaterial === 1 && !injected) {
        injected = true;
        return { ...observed, dev: observed.dev + 1n };
      }
      return observed;
    }) as never, async () => {
      await expect(coordinator(home, fake.driver, (event) => {
        if (event === "before-material-authenticate") authenticationStarted = true;
      }).prepare(inputFor(input))).rejects.toMatchObject({
        reason: "unsafe-storage",
      });
    }));

    expect(injected).toBe(true);
    expect(readBackendPublicationJournal(home)).toMatchObject({ phase: "preparing" });
    expect(fake.driver.publishProjectMap).not.toHaveBeenCalled();
    expect(fake.driver.publishConfig).not.toHaveBeenCalled();
  });

  it("keeps the operation witness open across awaited driver work and closes it once", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    const publicationDirectory = backendPublicationDirectory(home);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    const originalClose = nodeFs.closeSync as (fd: number) => void;
    const opened: { fd: number; closed: number }[] = [];
    const activeDescriptors = (): number => opened.filter(({ closed }) => closed === 0).length;
    fake.driver.observeLocalState = vi.fn(async () => {
      expect(activeDescriptors()).toBeGreaterThan(0);
      await Promise.resolve();
      expect(activeDescriptors()).toBeGreaterThan(0);
      return sourceState(input);
    });

    await withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
      const fd = originalOpen(path, ...args);
      if (path === publicationDirectory) opened.push({ fd, closed: 0 });
      return fd;
    }) as never, async () => withPatchedFsAsync("closeSync", ((fd: number) => {
      const descriptor = [...opened].reverse().find((entry) => entry.fd === fd && entry.closed === 0);
      if (descriptor !== undefined) descriptor.closed += 1;
      originalClose(fd);
    }) as never, async () => {
      await coordinator(home, fake.driver).prepare(inputFor(input));
    }));

    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every(({ closed }) => closed === 1)).toBe(true);
    expect(activeDescriptors()).toBe(0);
  });

  it("shares one live directory generation across journal and material authentication", async () => {
    const home = makeHome();
    const otherHome = makeHome();
    const input = material();
    const first = makeDriver(input);
    const second = makeDriver(input);
    const other = makeDriver(input);
    const publicationDirectory = backendPublicationDirectory(home);
    const otherPublicationDirectory = backendPublicationDirectory(otherHome);
    const operationGenerations = new Map<string, number>();
    const liveAcrossAwait = new Set<number>();
    let currentOperation: Readonly<{ label: string; directory: string }> | undefined;

    await withTrackedPublicationDirectoryGenerations(
      [publicationDirectory, otherPublicationDirectory],
      async (tracking) => {
        const captureOperationGeneration = (): PublicationDirectoryGeneration => {
          expect(currentOperation).toBeDefined();
          const active = tracking.active(currentOperation!.directory);
          expect(active).toHaveLength(1);
          const operation = active[0]!;
          const prior = operationGenerations.get(currentOperation!.label);
          if (prior === undefined) operationGenerations.set(currentOperation!.label, operation.generation);
          else expect(operation.generation).toBe(prior);
          return operation;
        };
        const instrumentDriver = (fake: ReturnType<typeof makeDriver>): void => {
          const observe = fake.driver.observeLocalState;
          fake.driver.observeLocalState = vi.fn(async (...args) => {
            const operation = captureOperationGeneration();
            expect(operation.closed).toBe(0);
            await Promise.resolve();
            expect(operation.closed).toBe(0);
            expect(tracking.active(operation.directory)).toContain(operation);
            liveAcrossAwait.add(operation.generation);
            return observe(...args);
          });
        };
        const runOperation = async <R>(
          label: string,
          directory: string,
          action: (observer: (event: string) => void) => Promise<R>,
        ): Promise<R> => {
          let materialWindowStart: number | undefined;
          currentOperation = { label, directory };
          tracking.beginOperation(directory);
          tracking.setPhase(directory, "operation");
          try {
            return await action((event) => {
              if (event === "before-material-authenticate") {
                captureOperationGeneration();
                materialWindowStart = tracking.records.length;
                tracking.setPhase(directory, "material");
              } else if (event === "after-material-authenticate") {
                expect(materialWindowStart, label).toBeDefined();
                expect(tracking.records.length, label).toBe(materialWindowStart);
                materialWindowStart = undefined;
                tracking.setPhase(directory, "operation");
              }
            });
          } finally {
            tracking.setPhase(directory, "setup");
            currentOperation = undefined;
          }
        };

        instrumentDriver(first);
        instrumentDriver(second);
        instrumentDriver(other);
        await runOperation("first-prepare", publicationDirectory, (observer) => (
          coordinator(home, first.driver, observer).prepare(inputFor(input))
        ));
        expect(tracking.active(publicationDirectory)).toHaveLength(0);
        await runOperation("first-resume", publicationDirectory, (observer) => (
          coordinator(home, first.driver, observer).resume()
        ));
        expect(tracking.active(publicationDirectory)).toHaveLength(0);
        await runOperation("second-prepare", publicationDirectory, (observer) => (
          coordinator(home, second.driver, observer).prepare({
            ...inputFor(input),
            publicationId: "publication-2",
          })
        ));
        expect(tracking.active(publicationDirectory)).toHaveLength(0);
        await runOperation("other-prepare", otherPublicationDirectory, (observer) => (
          coordinator(otherHome, other.driver, observer).prepare(inputFor(input))
        ));
        expect(tracking.active(otherPublicationDirectory)).toHaveLength(0);

        const assertionOrder = [
          "first-resume",
          "first-prepare",
          "second-prepare",
          "other-prepare",
        ] as const;
        for (const label of assertionOrder) {
          const generation = operationGenerations.get(label);
          expect(generation, label).toBeDefined();
          const record = tracking.records.find((candidate) => candidate.generation === generation);
          expect(record, label).toBeDefined();
          if (label === "first-resume") {
            expect(record!.fstatPhases, label).toContain("journal");
          } else if (label === "first-prepare" || label === "other-prepare") {
            expect(record!.fstatPhases, label).not.toContain("journal");
          }
          expect(record!.fstatPhases, label).toContain("material");
          expect(record!.closed, label).toBe(1);
          expect(liveAcrossAwait, label).toContain(generation);
        }
        expect(operationGenerations.get("first-resume")).not.toBe(
          operationGenerations.get("first-prepare"),
        );
        expect(operationGenerations.get("second-prepare")).not.toBe(
          operationGenerations.get("first-resume"),
        );
        const homeGenerations = new Set(
          tracking.records
            .filter((record) => record.directory === publicationDirectory)
            .map((record) => record.generation),
        );
        const otherHomeGenerations = tracking.records
          .filter((record) => record.directory === otherPublicationDirectory)
          .map((record) => record.generation);
        expect(otherHomeGenerations.every((generation) => !homeGenerations.has(generation))).toBe(true);
        expect(tracking.records.every((record) => record.closed === 1)).toBe(true);
      },
    );
  });

  it("rejects journal parent divergence before publication mutations", async () => {
    const { home, fake } = await preparedFixture();
    const publicationDirectory = backendPublicationDirectory(home);
    const journalPath = backendPublicationJournalPath(home);
    const journalBefore = readFileSync(journalPath);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    const originalStat = nodeFs.statSync as (
      path: string,
      options?: { bigint?: boolean },
    ) => { dev: bigint; [key: string]: unknown };
    let armed = false;
    let injected = false;
    vi.mocked(fake.driver.observeLocalState).mockClear();
    vi.mocked(fake.driver.publishProjectMap).mockClear();
    vi.mocked(fake.driver.publishConfig).mockClear();
    vi.mocked(fake.driver.restoreConfig).mockClear();
    vi.mocked(fake.driver.restoreProjectMap).mockClear();

    await withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
      const fd = originalOpen(path, ...args);
      if (path === journalPath && !injected) armed = true;
      return fd;
    }) as never, async () => withPatchedFsAsync("statSync", ((
      path: string,
      options?: { bigint?: boolean },
    ) => {
      const observed = originalStat(path, options);
      if (armed && path === publicationDirectory && options?.bigint === true) {
        armed = false;
        injected = true;
        return { ...observed, dev: observed.dev + 1n };
      }
      return observed;
    }) as never, async () => {
      await expect(coordinator(home, fake.driver).resume()).rejects.toMatchObject({
        name: "BackendPublicationJournalError",
        reason: "unsafe-storage",
        message: "backend publication journal parent does not match the authenticated directory",
      });
    }));

    expect(injected).toBe(true);
    expect(fake.driver.observeLocalState).not.toHaveBeenCalled();
    expect(fake.driver.publishProjectMap).not.toHaveBeenCalled();
    expect(fake.driver.publishConfig).not.toHaveBeenCalled();
    expect(fake.driver.restoreConfig).not.toHaveBeenCalled();
    expect(fake.driver.restoreProjectMap).not.toHaveBeenCalled();
    expect(readFileSync(journalPath)).toEqual(journalBefore);
  });

  it("rejects a coordinator material rebound before publication mutations", async () => {
    const { home, fake } = await preparedFixture();
    const publicationDirectory = backendPublicationDirectory(home);
    vi.mocked(fake.driver.observeLocalState).mockClear();
    vi.mocked(fake.driver.publishProjectMap).mockClear();
    vi.mocked(fake.driver.publishConfig).mockClear();
    vi.mocked(fake.driver.restoreConfig).mockClear();
    vi.mocked(fake.driver.restoreProjectMap).mockClear();
    let observed: Awaited<ReturnType<typeof withTemporaryReboundPublicationMaterial>> | undefined;

    await withTrackedPublicationDirectoryGenerations([publicationDirectory], async (tracking) => {
      tracking.setEnabled(false);
      tracking.setPhase(publicationDirectory, "journal");
      observed = await withTemporaryReboundPublicationMaterial(
        home,
        async () => {
          tracking.setEnabled(true);
          try {
            return await coordinator(home, fake.driver).resume();
          } finally {
            tracking.setEnabled(false);
          }
        },
      );
      expect(tracking.records.length).toBeGreaterThan(0);
      expect(tracking.records.every((record) => record.closed === 1)).toBe(true);
    });

    expect(observed).toMatchObject({ injected: true, restored: true });
    expect(observed?.error).toBeInstanceOf(BackendPublicationJournalError);
    expect(observed?.error).toMatchObject({
      reason: "unsafe-storage",
      message: "backend publication recovery material parent does not match the authenticated directory",
    });
    expect(fake.driver.observeLocalState).not.toHaveBeenCalled();
    expect(fake.driver.publishProjectMap).not.toHaveBeenCalled();
    expect(fake.driver.publishConfig).not.toHaveBeenCalled();
    expect(fake.driver.restoreConfig).not.toHaveBeenCalled();
    expect(fake.driver.restoreProjectMap).not.toHaveBeenCalled();
  });

  it("closes the operation witness when awaited driver work rejects", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    const publicationDirectory = backendPublicationDirectory(home);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    const originalClose = nodeFs.closeSync as (fd: number) => void;
    const opened: { fd: number; closed: number }[] = [];
    fake.driver.observeLocalState = vi.fn(async () => {
      await Promise.resolve();
      throw new Error("driver failed");
    });

    await withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
      const fd = originalOpen(path, ...args);
      if (path === publicationDirectory) opened.push({ fd, closed: 0 });
      return fd;
    }) as never, async () => withPatchedFsAsync("closeSync", ((fd: number) => {
      const descriptor = [...opened].reverse().find((entry) => entry.fd === fd && entry.closed === 0);
      if (descriptor !== undefined) descriptor.closed += 1;
      originalClose(fd);
    }) as never, async () => {
      await expect(coordinator(home, fake.driver).prepare(inputFor(input))).rejects.toThrow("driver failed");
    }));

    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every(({ closed }) => closed === 1)).toBe(true);
  });

  it("normalizes an operation witness open failure after directory setup", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    const publicationDirectory = backendPublicationDirectory(home);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    let publicationDirectoryOpens = 0;

    await withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
      if (path === publicationDirectory) {
        publicationDirectoryOpens += 1;
        if (publicationDirectoryOpens === 2) {
          throw Object.assign(new Error("operation descriptor unavailable"), { code: "EIO" });
        }
      }
      return originalOpen(path, ...args);
    }) as never, async () => {
      await expect(coordinator(home, fake.driver).prepare(inputFor(input))).rejects.toMatchObject({
        reason: "unsafe-storage",
      });
    });

    expect(publicationDirectoryOpens).toBe(2);
    expect(fake.driver.observeLocalState).not.toHaveBeenCalled();
  });

  it("rejects publication when the retained witness drifts at the return boundary", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    const publicationDirectory = backendPublicationDirectory(home);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalStat = nodeFs.statSync as (
      path: string,
      options?: { bigint?: boolean },
    ) => { dev: bigint; [key: string]: unknown };
    let returnBoundary = false;
    let injected = false;

    await withPatchedFsAsync("statSync", ((path: string, options?: { bigint?: boolean }) => {
      const observed = originalStat(path, options);
      if (path === publicationDirectory && options?.bigint === true && returnBoundary && !injected) {
        injected = true;
        return { ...observed, dev: observed.dev + 1n };
      }
      return observed;
    }) as never, async () => {
      await expect(coordinator(home, fake.driver, (event) => {
        if (event === "after-prepared") returnBoundary = true;
      }).prepare(inputFor(input))).rejects.toMatchObject({ reason: "unsafe-storage" });
    });

    expect(injected).toBe(true);
    expect(readBackendPublicationJournal(home)).toMatchObject({ phase: "prepared" });
  });

  it("rejects coordinator metadata drift at the return boundary", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    const publicationDirectory = backendPublicationDirectory(home);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    const originalFstat = nodeFs.fstatSync as (
      fd: number,
      options?: { bigint?: boolean },
    ) => { gid: bigint; [key: string]: unknown };
    let publicationDirectoryOpens = 0;
    let operationFd: number | undefined;
    let returnBoundary = false;

    await withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
      const fd = originalOpen(path, ...args);
      if (path === publicationDirectory) {
        publicationDirectoryOpens += 1;
        if (publicationDirectoryOpens === 2) operationFd = fd;
      }
      return fd;
    }) as never, async () => withPatchedFsAsync("fstatSync", ((fd: number, options?: { bigint?: boolean }) => {
      const observed = originalFstat(fd, options);
      if (returnBoundary && fd === operationFd && options?.bigint === true) {
        return Object.assign(observed, { gid: observed.gid + 1n });
      }
      return observed;
    }) as never, async () => {
      await expect(coordinator(home, fake.driver, (event) => {
        if (event === "after-prepared") returnBoundary = true;
      }).prepare(inputFor(input))).rejects.toMatchObject({ reason: "unsafe-storage" });
    }));

    expect(operationFd).toBeDefined();
  });

  it.each([
    "preparing",
    "abort-releasing",
  ] as const)("does not swallow material ENOENT with %s directory drift", async (phase) => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    if (phase === "preparing") {
      await expect(coordinator(home, fake.driver, (event) => {
        if (event === "after-material-seal") throw new Error("crash:sealed");
      }).prepare(inputFor(input))).rejects.toThrow("crash:sealed");
      expect(readBackendPublicationJournal(home)?.phase).toBe("preparing");
    } else {
      await coordinator(home, fake.driver).prepare(inputFor(input));
      await expect(coordinator(home, fake.driver, (event) => {
        if (
          event === "before-material-authenticate"
          && readBackendPublicationJournal(home)?.phase === "abort-releasing"
        ) throw new Error("crash:abort-releasing");
      }).abort()).rejects.toThrow("crash:abort-releasing");
      expect(readBackendPublicationJournal(home)?.phase).toBe("abort-releasing");
    }

    const publicationDirectory = backendPublicationDirectory(home);
    const materialPath = join(publicationDirectory, "publication-1.material");
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    const originalStat = nodeFs.statSync as (
      path: string,
      options?: { bigint?: boolean },
    ) => { dev: bigint; [key: string]: unknown };
    let materialOpenAttempted = false;
    let injected = false;

    await withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
      if (path === materialPath) {
        materialOpenAttempted = true;
        throw Object.assign(new Error("material missing"), { code: "ENOENT" });
      }
      return originalOpen(path, ...args);
    }) as never, async () => withPatchedFsAsync("statSync", ((path: string, options?: { bigint?: boolean }) => {
      const observed = originalStat(path, options);
      if (path === publicationDirectory && options?.bigint === true && materialOpenAttempted && !injected) {
        injected = true;
        return { ...observed, dev: observed.dev + 1n };
      }
      return observed;
    }) as never, async () => {
      await expect(coordinator(home, fake.driver).abort()).rejects.toMatchObject({ reason: "unsafe-storage" });
    }));

    expect(injected).toBe(true);
    expect(readBackendPublicationJournal(home)?.phase).toBe(phase);
  });

  it.each([
    { checkpoint: "preparing", targetPhase: "preparing", gate: "trailing", operation: "resume" },
    { checkpoint: "preparing", targetPhase: "preparing", gate: "trailing", operation: "abort" },
    { checkpoint: "guarded", targetPhase: "guarded", gate: "leading", operation: "resume" },
    { checkpoint: "map-publishing", targetPhase: "map-publishing", gate: "leading", operation: "recover" },
    { checkpoint: "map-published", targetPhase: "map-published", gate: "leading", operation: "resume" },
    { checkpoint: "config-publishing", targetPhase: "config-publishing", gate: "leading", operation: "recover" },
    { checkpoint: "aborting", targetPhase: "aborting", gate: "leading", operation: "abort" },
    { checkpoint: "config-restoring", targetPhase: "config-restoring", gate: "leading", operation: "recover-abort" },
    { checkpoint: "map-restoring", targetPhase: "map-restoring", gate: "leading", operation: "resume" },
    { checkpoint: "abort-releasing", targetPhase: "abort-releasing", gate: "leading", operation: "recover" },
    { checkpoint: "released-replay", targetPhase: "released", gate: "leading", operation: "resume" },
    { checkpoint: "released-forward", targetPhase: "released", gate: "leading", operation: "resume" },
  ] as const)(
    "rejects $checkpoint $operation material-authentication drift before later writes",
    async ({ checkpoint, targetPhase, gate, operation }) => {
      const { home, fake } = await coordinatorDriftFixture(checkpoint);
      const publicationDirectory = backendPublicationDirectory(home);
      const journalPath = backendPublicationJournalPath(home);
      const materialPath = join(publicationDirectory, "publication-1.material");
      const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
      const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
      const originalClose = nodeFs.closeSync as (fd: number) => void;
      const originalFstat = nodeFs.fstatSync as (
        fd: number,
        options?: { bigint?: boolean },
      ) => { dev: bigint; [key: string]: unknown };
      const originalStat = nodeFs.statSync as (
        path: string,
        options?: { bigint?: boolean },
      ) => { dev: bigint; [key: string]: unknown };
      const retained = vi.fn(async () => undefined);
      const cleanup = vi.fn(async () => undefined);
      fake.driver.retainCompletedMaterial = retained;
      fake.driver.cleanupAbortedMaterial = cleanup;
      const events: string[] = [];
      const publicationDirectoryFds = new Set<number>();
      let operationFd: number | undefined;
      let driftActive = false;
      let fstatInjected = false;
      let statInjected = false;
      let fstatDriftDev: bigint | undefined;
      let statDriftDev: bigint | undefined;
      let boundary: Readonly<{
        journal: string;
        checksumSha256: string;
        material: Buffer;
        calls: Record<string, number>;
        mutations: readonly string[];
        eventCount: number;
      }> | undefined;
      const captureBoundary = (): void => {
        const journal = readBackendPublicationJournal(home);
        if (journal === null) throw new Error("expected durable publication journal");
        boundary = {
          journal: readFileSync(journalPath, "utf8"),
          checksumSha256: journal.checksumSha256,
          material: readFileSync(materialPath),
          calls: coordinatorDriverCallCounts(fake.driver),
          mutations: [...fake.calls],
          eventCount: events.length,
        };
      };
      if (gate === "trailing") captureBoundary();

      const observer = (event: string): void => {
        events.push(event);
        if (
          gate === "leading"
          && !driftActive
          && event === "before-material-authenticate"
          && readBackendPublicationJournal(home)?.phase === targetPhase
        ) {
          captureBoundary();
          driftActive = true;
        }
      };
      const invoke = async (): Promise<unknown> => {
        const active = coordinator(home, fake.driver, observer);
        if (operation === "abort") return active.abort();
        if (operation === "recover") return active.recoverPending();
        if (operation === "recover-abort") return active.recoverPending({ disposition: "abort" });
        return active.resume();
      };

      let thrown: unknown;
      await withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
        const fd = originalOpen(path, ...args);
        if (path === publicationDirectory) {
          publicationDirectoryFds.add(fd);
          operationFd ??= fd;
        }
        if (gate === "trailing" && path === materialPath && !driftActive) driftActive = true;
        return fd;
      }) as never, async () => withPatchedFsAsync("closeSync", ((fd: number) => {
        publicationDirectoryFds.delete(fd);
        originalClose(fd);
      }) as never, async () => withPatchedFsAsync("fstatSync", ((fd: number, options?: { bigint?: boolean }) => {
        const observed = originalFstat(fd, options);
        if (driftActive && publicationDirectoryFds.has(fd) && options?.bigint === true) {
          fstatInjected = true;
          fstatDriftDev = observed.dev + 1n;
          return Object.assign(observed, { dev: fstatDriftDev });
        }
        return observed;
      }) as never, async () => withPatchedFsAsync("statSync", ((path: string, options?: { bigint?: boolean }) => {
        const observed = originalStat(path, options);
        if (driftActive && path === publicationDirectory && options?.bigint === true) {
          statInjected = true;
          statDriftDev = observed.dev + 1n;
          return Object.assign(observed, { dev: statDriftDev });
        }
        return observed;
      }) as never, async () => {
        try {
          await invoke();
        } catch (error) {
          thrown = error;
        }
      }))));

      expect(thrown).toBeInstanceOf(BackendPublicationJournalError);
      if (!(thrown instanceof BackendPublicationJournalError)) throw thrown;
      expect(thrown.reason).toBe("unsafe-storage");
      expect(fstatDriftDev).toBe(statDriftDev);
      expect(thrown.message).toBe(
        "backend publication directory changed during material authentication: private directory identity changed",
      );
      expect(operationFd).toBeDefined();
      expect(fstatInjected).toBe(true);
      expect(statInjected).toBe(true);
      if (boundary === undefined) throw new Error("target material-authentication boundary was not reached");
      expect(readFileSync(journalPath, "utf8")).toBe(boundary.journal);
      expect(readBackendPublicationJournal(home)?.checksumSha256).toBe(boundary.checksumSha256);
      expect(readFileSync(materialPath)).toEqual(boundary.material);
      expect(coordinatorDriverCallCounts(fake.driver)).toEqual(boundary.calls);
      expect(fake.calls).toEqual(boundary.mutations);
      expect(events).toHaveLength(boundary.eventCount);
      expect(retained).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
    },
  );

  it("journals preparing before sealing, authenticates material, and resumes to completion", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    const events: string[] = [];
    const prepared = await coordinator(home, fake.driver, (event) => events.push(event)).prepare(inputFor(input));

    expect(prepared.phase).toBe("prepared");
    expect(events.indexOf("before-journal-write")).toBeLessThan(events.indexOf("before-material-seal"));
    expect(readBackendPublicationJournal(home)).toMatchObject({ phase: "prepared", publicationId: "publication-1" });
    expect(readFileSync(join(backendPublicationDirectory(home), "publication-1.material"), "utf8")).toContain("cG9zdGdyZXNxbCJ9");

    const completed = await coordinator(home, fake.driver).resume();
    expect(completed.phase).toBe("completed");
    expect(fake.calls).toEqual(["publish-map", "publish-config"]);
    expect(fake.getState()).toEqual(targetState(input));
    expect(await coordinator(home, fake.driver).recoverPending()).toEqual(completed);
  });

  it.each([
    { phase: "maintenance-aborted", targetBackend: "postgresql" },
    { phase: "selection-completed", targetBackend: "sqlite" },
    { phase: "selection-completed", targetBackend: "postgresql" },
  ] as const)(
    "archives terminal v3 $phase for $targetBackend before ordinary prepare",
    async ({ phase, targetBackend }) => {
      const home = makeHome();
      const input = material();
      const fake = makeDriver(input);
      const terminal = await createMaintenanceState(home, fake.driver, phase, targetBackend);
      const terminalBytes = readFileSync(backendPublicationJournalPath(home));

      const prepared = await coordinator(home, fake.driver).prepare({
        ...inputFor(input),
        publicationId: "ordinary-after-maintenance",
      });

      expect(prepared).toMatchObject({
        version: 2,
        phase: "prepared",
        publicationId: "ordinary-after-maintenance",
      });
      expect(readFileSync(maintenanceArchivePath(home, terminal))).toEqual(terminalBytes);
      expect(readBackendMaintenanceJournal(home)).toBeNull();
      expect(readBackendPublicationJournal(home)).toEqual(prepared);
    },
  );

  it.each([
    { boundary: "observation", phase: "maintenance-aborted" },
    { boundary: "observation", phase: "selection-completed" },
    { boundary: "replacement", phase: "maintenance-aborted" },
    { boundary: "replacement", phase: "selection-completed" },
  ] as const)(
    "replays terminal v3 $phase after $boundary failure",
    async ({ boundary, phase }) => {
      const home = makeHome();
      const input = material();
      const first = makeDriver(input);
      const terminal = await createMaintenanceState(home, first.driver, phase);
      const terminalBytes = readFileSync(backendPublicationJournalPath(home));
      const archivePath = maintenanceArchivePath(home, terminal);
      const nextInput = { ...inputFor(input), publicationId: "ordinary-after-failure" };
      const failing = makeDriver(input);
      if (boundary === "observation") {
        failing.driver.observeLocalState = vi.fn(async () => {
          throw new Error("crash:observe-terminal-v3");
        });
      }
      const observer = (event: string): void => {
        if (boundary === "replacement" && event === "before-journal-write") {
          throw new Error("crash:replace-terminal-v3");
        }
      };

      await expect(coordinator(home, failing.driver, observer).prepare(nextInput))
        .rejects.toThrow(boundary === "observation"
          ? "crash:observe-terminal-v3"
          : "crash:replace-terminal-v3");
      expect(readFileSync(backendPublicationJournalPath(home))).toEqual(terminalBytes);
      expect(readFileSync(archivePath)).toEqual(terminalBytes);
      expect(readBackendMaintenanceJournal(home)).toEqual(terminal);

      const retry = makeDriver(input);
      await expect(coordinator(home, retry.driver).prepare(nextInput)).resolves.toMatchObject({
        version: 2,
        phase: "prepared",
        publicationId: "ordinary-after-failure",
      });
      expect(readFileSync(archivePath)).toEqual(terminalBytes);
    },
  );

  it.each([
    "maintenance-entering",
    "maintenance-held",
    "selection-prepared",
  ] as const)("refuses active terminal-v3 predecessor phase %s before effects", async (phase) => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    const active = await createMaintenanceState(home, fake.driver, phase);
    const journalBytes = readFileSync(backendPublicationJournalPath(home));

    await expect(coordinator(home, fake.driver).prepare({
      ...inputFor(input),
      publicationId: "ordinary-refused",
    })).rejects.toMatchObject({ reason: "unresolved-publication" });

    expect(readFileSync(backendPublicationJournalPath(home))).toEqual(journalBytes);
    expect(readBackendMaintenanceJournal(home)).toEqual(active);
    expect(existsSync(backendPublicationHistoryDirectory(home))).toBe(false);
    expect(fake.driver.observeLocalState).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "malformed", reason: "malformed-journal" },
    { kind: "checksum", reason: "checksum-mismatch" },
  ] as const)("refuses $kind terminal-v3 data before ordinary publication effects", async ({ kind, reason }) => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await createMaintenanceState(home, fake.driver, "maintenance-aborted");
    const path = backendPublicationJournalPath(home);
    if (kind === "malformed") {
      rewriteJournal(home, (journal) => ({ ...journal, unexpected: true }));
    } else {
      const journal = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      writeFileSync(path, `${JSON.stringify({ ...journal, checksumSha256: "0".repeat(64) })}\n`, {
        mode: 0o600,
      });
    }
    const bytes = readFileSync(path);

    await expect(coordinator(home, fake.driver).prepare({
      ...inputFor(input),
      publicationId: "ordinary-refused",
    })).rejects.toMatchObject({ reason });
    expect(readFileSync(path)).toEqual(bytes);
    expect(existsSync(backendPublicationHistoryDirectory(home))).toBe(false);
    expect(fake.driver.observeLocalState).not.toHaveBeenCalled();
  });

  it("returns a structured error for malformed terminal-v3 archive rereads", async () => {
    const home = makeHome();
    await terminalArchiveFixture(home, 3);
    const journalPath = backendPublicationJournalPath(home);
    const malformed = Buffer.from('{"version":3');
    const replacementPath = join(home, "malformed-terminal-v3.json");
    writeFileSync(replacementPath, malformed, { mode: 0o600 });
    const attempt = countingDriver(material());
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    let journalReads = 0;
    let thrown: unknown;

    await withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
      if (path === journalPath && ++journalReads === 2) renameSync(replacementPath, journalPath);
      return originalOpen(path, ...args);
    }) as never, async () => {
      try {
        await coordinator(home, attempt.driver).prepare({
          ...inputFor(material()),
          publicationId: "archive-reread-next",
        });
      } catch (error) {
        thrown = error;
      }
    });

    expect(journalReads).toBe(2);
    expect(thrown).toBeInstanceOf(BackendPublicationJournalError);
    expect(thrown).toMatchObject({
      name: "BackendPublicationJournalError",
      reason: "malformed-journal",
      message: "backend publication journal is not valid JSON",
    });
    expect(readFileSync(journalPath)).toEqual(malformed);
    expect(existsSync(backendPublicationHistoryDirectory(home))).toBe(false);
    expect(existsSync(join(backendPublicationDirectory(home), "archive-reread-next.material"))).toBe(false);
    expect(attempt.calls).toEqual([]);
  });

  it.each(([
    "prepare",
    "enter-maintenance",
  ] as const).flatMap((operation) => ARCHIVE_REREAD_REFUSALS.map((testCase) => ({
    ...testCase,
    operation,
  }))))(
    "$operation refuses $name before archive or successor effects",
    async ({ operation, version, replacement, reason, message }) => {
      const home = makeHome();
      const fixture = await terminalArchiveFixture(home, version);
      const journalPath = backendPublicationJournalPath(home);
      const replacementBytes = await replacementArchiveBytes(fixture, replacement);
      const directory = backendPublicationDirectory(home);
      const entriesBefore = readdirSync(directory).sort();
      const attempt = countingDriver(material());
      let injections = 0;
      let thrown: unknown;

      try {
        await runArchiveRereadOperation(operation, home, attempt.driver, (event, path) => {
          if (event !== "before-terminal-journal-archive-read") return;
          injections += 1;
          expect(path).toBe(journalPath);
          writeFileSync(path, replacementBytes, { mode: 0o600 });
        });
      } catch (error) {
        thrown = error;
      }

      expect(injections).toBe(1);
      expect(thrown).toBeInstanceOf(BackendPublicationJournalError);
      expect(thrown).toMatchObject({
        name: "BackendPublicationJournalError",
        reason,
        message,
      });
      expect(readFileSync(journalPath)).toEqual(replacementBytes);
      expect(readdirSync(directory).sort()).toEqual(entriesBefore);
      expect(existsSync(backendPublicationHistoryDirectory(home))).toBe(false);
      expect(existsSync(join(directory, "archive-reread-next.material"))).toBe(false);
      expect(attempt.calls).toEqual([]);
    },
  );

  it.each(([
    "prepare",
    "enter-maintenance",
  ] as const).flatMap((operation) => ([2, 3] as const).map((version) => ({ operation, version }))))(
    "$operation archives an exact terminal-v$version reread",
    async ({ operation, version }) => {
      const home = makeHome();
      const fixture = await terminalArchiveFixture(home, version);
      const journalPath = backendPublicationJournalPath(home);
      const attempt = countingDriver(material());
      let injections = 0;

      const result = await runArchiveRereadOperation(operation, home, attempt.driver, (event, path) => {
        if (event !== "before-terminal-journal-archive-read") return;
        injections += 1;
        expect(path).toBe(journalPath);
        writeFileSync(path, fixture.bytes, { mode: 0o600 });
      });

      expect(injections).toBe(1);
      expect(result).toMatchObject(operation === "prepare"
        ? { version: 2, phase: "prepared", publicationId: "archive-reread-next" }
        : { version: 3, phase: "maintenance-held", publicationId: "archive-reread-maintenance" });
      const archivePath = join(
        backendPublicationHistoryDirectory(home),
        `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`,
      );
      expect(readFileSync(archivePath)).toEqual(fixture.bytes);
      expect(attempt.calls).toEqual(operation === "prepare" ? ["observe-local-state"] : []);
    },
  );

  it.each(["resume", "abort", "recover", "recover-abort"] as const)(
    "keeps %s on the version-two-only recovery path",
    async (operation) => {
      const home = makeHome();
      const input = material();
      const fake = makeDriver(input);
      const terminal = await createMaintenanceState(home, fake.driver, "selection-completed");
      const active = coordinator(home, fake.driver);
      const attempt = operation === "resume"
        ? active.resume()
        : operation === "abort"
          ? active.abort()
          : operation === "recover-abort"
            ? active.recoverPending({ disposition: "abort" })
            : active.recoverPending();

      await expect(attempt).rejects.toMatchObject({ reason: "unresolved-publication" });
      expect(readBackendMaintenanceJournal(home)).toEqual(terminal);
      expect(fake.driver.observeLocalState).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "changed", "active", "version-two"] as const)(
    "refuses terminal-v3 %s drift at the initial preparing replacement checkpoint",
    async (kind) => {
      const home = makeHome();
      const input = material();
      const fake = makeDriver(input);
      const terminal = await createMaintenanceState(home, fake.driver, "selection-completed");
      const terminalBytes = readFileSync(backendPublicationJournalPath(home));
      const archivePath = maintenanceArchivePath(home, terminal);
      let versionTwoBytes: Buffer | undefined;
      if (kind === "version-two") {
        const otherHome = makeHome();
        const otherDriver = makeDriver(input);
        await coordinator(otherHome, otherDriver.driver).prepare(inputFor(input));
        await coordinator(otherHome, otherDriver.driver).resume();
        versionTwoBytes = readFileSync(backendPublicationJournalPath(otherHome));
      }
      let injected = false;
      const active = coordinator(home, fake.driver, (event) => {
        if (injected || event !== "before-journal-read") return;
        injected = true;
        if (kind === "missing") rmSync(backendPublicationJournalPath(home));
        else if (kind === "version-two") {
          writeFileSync(backendPublicationJournalPath(home), versionTwoBytes!, { mode: 0o600 });
        } else if (kind === "active") {
          rewriteJournal(home, (journal) => ({ ...journal, phase: "selection-prepared" }));
        } else {
          rewriteJournal(home, (journal) => ({
            ...journal,
            updatedAt: "2026-09-14T23:59:59.000Z",
          }));
        }
      });

      await expect(active.prepare({
        ...inputFor(input),
        publicationId: "ordinary-drifted",
      })).rejects.toMatchObject({ reason: "unexpected-state" });
      expect(injected).toBe(true);
      expect(readFileSync(archivePath)).toEqual(terminalBytes);
      expect(fake.driver.observeLocalState).toHaveBeenCalledOnce();
      if (kind === "missing") {
        expect(readBackendPublicationJournal(home)).toBeNull();
        expect(existsSync(backendPublicationJournalPath(home))).toBe(false);
      } else if (kind === "version-two") {
        expect(readBackendPublicationJournal(home)).toMatchObject({
          version: 2,
          phase: "completed",
        });
        expect(readBackendMaintenanceJournal(home)).toBeNull();
      } else {
        expect(() => readBackendPublicationJournal(home)).toThrow("migration maintenance");
        expect(readBackendMaintenanceJournal(home)?.phase).toBe(
          kind === "active" ? "selection-prepared" : "selection-completed",
        );
      }
    },
  );

  it("archives terminal journal evidence before starting the next publication", async () => {
    const home = makeHome();
    const input = material();
    const first = makeDriver(input);
    await coordinator(home, first.driver).prepare(inputFor(input));
    await expect(coordinator(home, first.driver).prepare(inputFor(input)))
      .rejects.toMatchObject({ reason: "unresolved-publication" });
    await coordinator(home, first.driver).resume();

    const second = makeDriver(input);
    const next = await coordinator(home, second.driver).prepare({
      ...inputFor(input),
      publicationId: "publication-2",
    });
    expect(next.phase).toBe("prepared");
    expect(existsSync(join(backendPublicationDirectory(home), "history"))).toBe(true);
    expect(readBackendPublicationJournal(home)?.publicationId).toBe("publication-2");
    await coordinator(home, second.driver).resume();
    const third = makeDriver(input);
    await expect(coordinator(home, third.driver).prepare({
      ...inputFor(input),
      publicationId: "publication-3",
    })).resolves.toMatchObject({ phase: "prepared" });
  });

  it("retains terminal journal evidence when observation fails after history is archived", async () => {
    const home = makeHome();
    const input = material();
    const first = makeDriver(input);
    await coordinator(home, first.driver).prepare(inputFor(input));
    const completed = await coordinator(home, first.driver).resume();
    const archivePath = join(
      backendPublicationDirectory(home),
      "history",
      completed.publicationId + "." + completed.checksumSha256 + ".json",
    );

    const second = makeDriver(input);
    second.driver.observeLocalState = vi.fn(async () => {
      throw new Error("crash:observe-after-archive");
    });
    const nextInput = { ...inputFor(input), publicationId: "publication-2" };
    await expect(coordinator(home, second.driver).prepare(nextInput))
      .rejects.toThrow("crash:observe-after-archive");

    expect(readBackendPublicationJournal(home)).toMatchObject({
      phase: "completed",
      publicationId: "publication-1",
    });
    expect(existsSync(archivePath)).toBe(true);
    expect(() => assertBackendPublicationConsumerAccess({ homeDir: home, backend: "postgresql" })).not.toThrow();

    second.driver.observeLocalState = vi.fn(async () => sourceState(input));
    await expect(coordinator(home, second.driver).prepare(nextInput))
      .resolves.toMatchObject({ phase: "prepared", publicationId: "publication-2" });
    expect(existsSync(archivePath)).toBe(true);
  });

  it("leaves the prior terminal journal active when replacement publication fails", async () => {
    const home = makeHome();
    const input = material();
    const first = makeDriver(input);
    await coordinator(home, first.driver).prepare(inputFor(input));
    const completed = await coordinator(home, first.driver).resume();
    const archivePath = join(
      backendPublicationDirectory(home),
      "history",
      completed.publicationId + "." + completed.checksumSha256 + ".json",
    );
    const second = makeDriver(input);
    const nextInput = { ...inputFor(input), publicationId: "publication-2" };

    await expect(coordinator(home, second.driver, (event) => {
      if (event === "before-journal-write") throw new Error("crash:before-replacement");
    }).prepare(nextInput)).rejects.toThrow("crash:before-replacement");

    expect(readBackendPublicationJournal(home)).toMatchObject({
      phase: "completed",
      publicationId: "publication-1",
    });
    expect(existsSync(archivePath)).toBe(true);
    await expect(coordinator(home, second.driver).prepare(nextInput))
      .resolves.toMatchObject({ phase: "prepared", publicationId: "publication-2" });
  });

  it("keeps a durably published preparing replacement after the post-write crash boundary", async () => {
    const home = makeHome();
    const input = material();
    const first = makeDriver(input);
    await coordinator(home, first.driver).prepare(inputFor(input));
    const completed = await coordinator(home, first.driver).resume();
    const archivePath = join(
      backendPublicationDirectory(home),
      "history",
      completed.publicationId + "." + completed.checksumSha256 + ".json",
    );
    const second = makeDriver(input);
    await expect(coordinator(home, second.driver, (event) => {
      if (event === "after-journal-write") throw new Error("crash:after-replacement");
    }).prepare({ ...inputFor(input), publicationId: "publication-2" }))
      .rejects.toThrow("crash:after-replacement");

    expect(readBackendPublicationJournal(home)).toMatchObject({
      phase: "preparing",
      publicationId: "publication-2",
    });
    expect(existsSync(archivePath)).toBe(true);
  });

  it("resumes idempotently from already-published local state and retains material", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    fake.driver.observeLocalState = vi.fn(async () => targetState(input));
    const retained = vi.fn(async () => undefined);
    fake.driver.retainCompletedMaterial = retained;
    const completed = await coordinator(home, fake.driver).resume();
    expect(completed.phase).toBe("completed");
    expect(fake.driver.publishProjectMap).not.toHaveBeenCalled();
    expect(fake.driver.publishConfig).not.toHaveBeenCalled();
    expect(retained).toHaveBeenCalledOnce();
  });

  it("finalizes a journal already at the released checkpoint", async () => {
    const { home, fake } = await preparedFixture();
    rewriteJournal(home, (journal) => ({ ...journal, phase: "released" }));
    expect((await coordinator(home, fake.driver).resume()).phase).toBe("completed");
  });

  it("binds logical checks to exact BigInt-derived identities and rejects changed evidence", async () => {
    const input = material();
    const exactSource: BackendPublicationStateWitness = {
      config: { ...sourceState(input).config, dev: "9007199254740993", ino: "9007199254740995", parentDev: "7", parentIno: "11" },
      projectMap: { ...sourceState(input).projectMap, dev: "9007199254740993", ino: "9007199254740997", parentDev: "7", parentIno: "11" },
    };
    const home = makeHome();
    let state = exactSource;
    const expected = targetState(input);
    const driver: BackendPublicationDriver = {
      observeLocalState: vi.fn(async () => state),
      publishProjectMap: vi.fn(async ({ permit }) => {
        permit.assertActive();
        state = { ...state, projectMap: expected.projectMap };
        return state.projectMap;
      }),
      publishConfig: vi.fn(async ({ permit }) => {
        permit.assertActive();
        state = { ...state, config: expected.config };
        return state.config;
      }),
      restoreConfig: vi.fn(async ({ permit }) => {
        permit.assertActive();
        state = { ...state, config: exactSource.config };
        return state.config;
      }),
      restoreProjectMap: vi.fn(async ({ permit }) => {
        permit.assertActive();
        state = { ...state, projectMap: exactSource.projectMap };
        return state.projectMap;
      }),
    };
    await coordinator(home, driver).prepare(inputFor(input));
    expect((await coordinator(home, driver).resume()).phase).toBe("completed");

    const mismatchHome = makeHome();
    let mismatchState = exactSource;
    const mismatchDriver: BackendPublicationDriver = {
      ...driver,
      observeLocalState: vi.fn(async () => mismatchState),
    };
    await coordinator(mismatchHome, mismatchDriver).prepare(inputFor(input));
    mismatchState = {
      ...exactSource,
      projectMap: { ...exactSource.projectMap, ino: "9007199254740999" },
    };
    await expect(coordinator(mismatchHome, mismatchDriver).resume()).rejects.toMatchObject({ reason: "unexpected-state" });
  });

  it("recovers from map and config publishing checkpoints", async () => {
    for (const checkpoint of ["map-publishing", "config-publishing"] as const) {
      const home = makeHome();
      const input = material();
      const fake = makeDriver(input);
      await coordinator(home, fake.driver).prepare(inputFor(input));
      let crashed = false;
      const observer = (event: string): void => {
        if (!crashed && event === "after-journal-write" && readBackendPublicationJournal(home)?.phase === checkpoint) {
          crashed = true;
          throw new Error(`crash:${checkpoint}`);
        }
      };
      await expect(coordinator(home, fake.driver, observer).resume()).rejects.toThrow(`crash:${checkpoint}`);
      expect(readBackendPublicationJournal(home)?.phase).toBe(checkpoint);
      expect((await coordinator(home, fake.driver).resume()).phase).toBe("completed");
    }
  });

  it("adopts an identity-changing map publication after a crash before its witness checkpoint", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const originalPublishMap = fake.driver.publishProjectMap;
    const changedTargetMap = {
      ...targetState(input).projectMap,
      dev: "101",
      ino: "102",
      parentDev: "103",
      parentIno: "104",
    };
    fake.driver.publishProjectMap = async (mutation) => {
      await originalPublishMap(mutation);
      fake.setState({ ...fake.getState(), projectMap: changedTargetMap });
      throw new Error("crash:after-map-identity");
    };

    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-map-identity");
    expect(readBackendPublicationJournal(home)?.phase).toBe("map-publishing");

    fake.driver.publishProjectMap = vi.fn(async () => {
      throw new Error("replayed map publication");
    });
    const completed = await coordinator(home, fake.driver).resume();
    expect(completed.phase).toBe("completed");
    expect(completed.targetState.projectMap).toMatchObject({
      dev: "101",
      ino: "102",
      parentDev: "103",
      parentIno: "104",
    });
    expect(fake.calls).toEqual(["publish-map", "publish-config"]);
  });

  it("aborts an identity-changing map publication before its witness checkpoint", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const originalPublishMap = fake.driver.publishProjectMap;
    const changedTargetMap = {
      ...targetState(input).projectMap,
      dev: "121",
      ino: "122",
      parentDev: "123",
      parentIno: "124",
    };
    fake.driver.publishProjectMap = async (mutation) => {
      await originalPublishMap(mutation);
      fake.setState({ ...fake.getState(), projectMap: changedTargetMap });
      throw new Error("crash:after-map-identity-abort");
    };

    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-map-identity-abort");
    const aborted = await coordinator(home, fake.driver).abort();
    expect(aborted.phase).toBe("aborted");
    expect(fake.calls).toEqual(["publish-map", "restore-map"]);
  });

  it("adopts an identity-changing config publication after a crash before its witness checkpoint", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const originalPublishConfig = fake.driver.publishConfig;
    const changedTargetConfig = {
      ...targetState(input).config,
      dev: "111",
      ino: "112",
      parentDev: "113",
      parentIno: "114",
    };
    fake.driver.publishConfig = async (mutation) => {
      await originalPublishConfig(mutation);
      fake.setState({ ...fake.getState(), config: changedTargetConfig });
      throw new Error("crash:after-config-identity");
    };

    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-config-identity");
    expect(readBackendPublicationJournal(home)?.phase).toBe("config-publishing");

    fake.driver.publishConfig = vi.fn(async () => {
      throw new Error("replayed config publication");
    });
    const completed = await coordinator(home, fake.driver).resume();
    expect(completed.phase).toBe("completed");
    expect(completed.targetState.config).toMatchObject({
      dev: "111",
      ino: "112",
      parentDev: "113",
      parentIno: "114",
    });
    expect(fake.calls).toEqual(["publish-map", "publish-config"]);
  });

  it("adopts an identity-changing config restoration after a crash before its witness checkpoint", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const originalPublishConfig = fake.driver.publishConfig;
    fake.driver.publishConfig = async (mutation) => {
      await originalPublishConfig(mutation);
      throw new Error("crash:after-config");
    };
    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-config");
    expect(readBackendPublicationJournal(home)?.phase).toBe("config-publishing");

    const originalRestoreConfig = fake.driver.restoreConfig;
    const changedSourceConfig = {
      ...sourceState(input).config,
      dev: "201",
      ino: "202",
      parentDev: "203",
      parentIno: "204",
    };
    fake.driver.restoreConfig = async (mutation) => {
      await originalRestoreConfig(mutation);
      fake.setState({ ...fake.getState(), config: changedSourceConfig });
      throw new Error("crash:after-config-restore-identity");
    };
    await expect(coordinator(home, fake.driver).abort()).rejects.toThrow("crash:after-config-restore-identity");
    expect(readBackendPublicationJournal(home)?.phase).toBe("config-restoring");

    fake.driver.restoreConfig = vi.fn(async () => {
      throw new Error("replayed config restoration");
    });
    const aborted = await coordinator(home, fake.driver).abort();
    expect(aborted.phase).toBe("aborted");
    expect(aborted.sourceState.config).toMatchObject({
      dev: "201",
      ino: "202",
      parentDev: "203",
      parentIno: "204",
    });
    expect(fake.calls).toEqual(["publish-map", "publish-config", "restore-config", "restore-map"]);
  });

  it("adopts an identity-changing project-map restoration after a crash before its witness checkpoint", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const originalPublishConfig = fake.driver.publishConfig;
    fake.driver.publishConfig = async (mutation) => {
      await originalPublishConfig(mutation);
      throw new Error("crash:after-config");
    };
    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-config");

    const originalRestoreMap = fake.driver.restoreProjectMap;
    const changedSourceMap = {
      ...sourceState(input).projectMap,
      dev: "211",
      ino: "212",
      parentDev: "213",
      parentIno: "214",
    };
    fake.driver.restoreProjectMap = async (mutation) => {
      await originalRestoreMap(mutation);
      fake.setState({ ...fake.getState(), projectMap: changedSourceMap });
      throw new Error("crash:after-map-restore-identity");
    };
    await expect(coordinator(home, fake.driver).abort()).rejects.toThrow("crash:after-map-restore-identity");
    expect(readBackendPublicationJournal(home)?.phase).toBe("map-restoring");

    fake.driver.restoreProjectMap = vi.fn(async () => {
      throw new Error("replayed map restoration");
    });
    const aborted = await coordinator(home, fake.driver).abort();
    expect(aborted.phase).toBe("aborted");
    expect(aborted.sourceState.projectMap).toMatchObject({
      dev: "211",
      ino: "212",
      parentDev: "213",
      parentIno: "214",
    });
    expect(fake.calls).toEqual(["publish-map", "publish-config", "restore-config", "restore-map"]);
  });

  it("rejects a third or tampered state at an identity-changing publication seam", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const originalPublishMap = fake.driver.publishProjectMap;
    fake.driver.publishProjectMap = async (mutation) => {
      await originalPublishMap(mutation);
      fake.setState({
        ...fake.getState(),
        projectMap: {
          ...targetState(input).projectMap,
          rawSha256: "f".repeat(64),
          semanticSha256: "e".repeat(64),
        },
      });
      throw new Error("crash:after-map-tamper");
    };

    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-map-tamper");
    await expect(coordinator(home, fake.driver).resume()).rejects.toMatchObject({ reason: "unexpected-state" });
  });

  it("checkpoints remote fences and resumes forward after a release crash", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    let fence: BackendPublicationFenceRecord | null = null;
    let releaseCrashed = false;
    const makeFence = (releasedAt: string | null): BackendPublicationFenceRecord => ({
      projectId: "remote-project",
      machineId: "machine-1",
      publicationId: "publication-1",
      targetBackend: "postgresql",
      evidenceSha256: "a".repeat(64),
      fencingToken: "1",
      acquiredAt: "2026-08-06T12:00:00.000Z",
      renewedAt: "2026-08-06T12:00:00.000Z",
      expiresAt: "2999-08-06T12:00:00.000Z",
      releasedAt,
      databaseExpired: false,
    });
    fake.driver.acquireRemoteGuard = async () => {
      fence = makeFence(null);
      return fence;
    };
    fake.driver.readRemoteGuard = async () => fence;
    fake.driver.releaseRemoteGuard = async () => {
      if (!releaseCrashed) releaseCrashed = true;
      fence = makeFence("2026-08-06T12:01:00.000Z");
    };
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const crashing = coordinator(home, fake.driver, (event) => {
      if (event === "before-release" && releaseCrashed === false) throw new Error("crash:release");
    });
    await expect(crashing.resume()).rejects.toThrow("crash:release");
    expect(readBackendPublicationJournal(home)?.phase).toBe("releasing");

    const recovered = await coordinator(home, fake.driver).recoverPending();
    expect(recovered?.phase).toBe("completed");
    expect(fence?.releasedAt).not.toBeNull();
  });

  it("handles optional remote admission seams and already-active fences", async () => {
    const absentReadHome = makeHome();
    const absentRead = makeDriver(material());
    absentRead.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord());
    await expect(coordinator(absentReadHome, absentRead.driver).prepare(inputFor(material())))
      .resolves.toMatchObject({ phase: "prepared" });
    await expect(coordinator(absentReadHome, absentRead.driver).resume()).resolves.toMatchObject({ phase: "completed" });
    expect(absentRead.driver.acquireRemoteGuard).not.toHaveBeenCalled();

    const activeHome = makeHome();
    const active = makeDriver(material());
    let current = fenceRecord();
    active.driver.acquireRemoteGuard = vi.fn(async () => current);
    active.driver.readRemoteGuard = vi.fn(async () => current);
    active.driver.releaseRemoteGuard = vi.fn(async () => {
      current = fenceRecord({ releasedAt: "2026-08-06T12:01:00.000Z" });
    });
    await coordinator(activeHome, active.driver).prepare(inputFor(material()));
    const completed = await coordinator(activeHome, active.driver).resume();
    expect(completed.phase).toBe("completed");
    expect(active.driver.acquireRemoteGuard).not.toHaveBeenCalled();
    expect(active.driver.releaseRemoteGuard).toHaveBeenCalledOnce();
  });

  it("acquires and releases projects in canonical order", async () => {
    const home = makeHome();
    const input = {
      ...inputFor(material()),
      projects: [
        { localProjectId: "z-project", remoteProjectId: "remote-z", evidenceSha256: "b".repeat(64) },
        { localProjectId: "a-project", remoteProjectId: "remote-a", evidenceSha256: "c".repeat(64) },
      ],
    } as const;
    const fake = makeDriver(material());
    const fences = new Map<string, BackendPublicationFenceRecord>();
    fake.driver.acquireRemoteGuard = vi.fn(async ({ project }) => {
      const next = fenceRecord({ projectId: project.remoteProjectId, evidenceSha256: project.evidenceSha256 });
      fences.set(project.remoteProjectId, next);
      return next;
    });
    fake.driver.readRemoteGuard = vi.fn(async ({ project }) => fences.get(project.remoteProjectId) ?? null);
    fake.driver.releaseRemoteGuard = vi.fn(async ({ project }) => {
      const current = fences.get(project.remoteProjectId);
      if (current !== undefined) fences.set(project.remoteProjectId, { ...current, releasedAt: "2026-08-06T12:01:00.000Z" });
    });
    await coordinator(home, fake.driver).prepare(input);
    const completed = await coordinator(home, fake.driver).resume();
    expect(completed.phase).toBe("completed");
    expect(fake.driver.acquireRemoteGuard).toHaveBeenCalledTimes(2);
    expect(fake.driver.releaseRemoteGuard).toHaveBeenCalledTimes(2);
    expect(fake.driver.acquireRemoteGuard.mock.calls.map(([call]) => call.project.remoteProjectId))
      .toEqual(["remote-a", "remote-z"]);
  });

  it("fails closed when remote acquisition cannot prove an active fence", async () => {
    const home = makeHome();
    const fake = makeDriver(material());
    let reads = 0;
    fake.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord());
    fake.driver.readRemoteGuard = vi.fn(async () => {
      reads += 1;
      return reads === 1 ? null : fenceRecord({ databaseExpired: true });
    });
    await coordinator(home, fake.driver).prepare(inputFor(material()));
    await expect(coordinator(home, fake.driver).resume()).rejects.toMatchObject({ reason: "unexpected-state" });

    const mismatchHome = makeHome();
    const mismatch = makeDriver(material());
    mismatch.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord());
    mismatch.driver.readRemoteGuard = vi.fn(async () => fenceRecord({ projectId: "other-project" }));
    await coordinator(mismatchHome, mismatch.driver).prepare(inputFor(material()));
    await expect(coordinator(mismatchHome, mismatch.driver).resume()).rejects.toMatchObject({ reason: "unexpected-state" });

    const tokenHome = makeHome();
    const token = makeDriver(material());
    token.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord());
    token.driver.readRemoteGuard = vi.fn(async () => fenceRecord({ fencingToken: "not-a-number" }));
    await coordinator(tokenHome, token.driver).prepare(inputFor(material()));
    await expect(coordinator(tokenHome, token.driver).resume()).rejects.toMatchObject({ reason: "unexpected-state" });
  });

  // This matrix performs repeated durable journal/fsync setup and exceeds Vitest's 5s
  // default under V8 coverage.
  it("fails closed for every uncertain or conflicting remote release witness", async () => {
    const missing = await releasingFixture();
    missing.fake.driver.readRemoteGuard = vi.fn(async () => null);
    await expect(coordinator(missing.home, missing.fake.driver).recoverPending()).rejects.toMatchObject({ reason: "unexpected-state" });

    const identity = await releasingFixture();
    identity.fake.driver.readRemoteGuard = vi.fn(async () => fenceRecord({ machineId: "other-machine" }));
    await expect(coordinator(identity.home, identity.fake.driver).recoverPending()).rejects.toMatchObject({ reason: "unexpected-state" });

    const regressed = await releasingFixture();
    regressed.fake.driver.readRemoteGuard = vi.fn(async () => fenceRecord({ fencingToken: "0" }));
    await expect(coordinator(regressed.home, regressed.fake.driver).recoverPending()).rejects.toMatchObject({ reason: "unexpected-state" });

    for (const successor of [
      fenceRecord({ fencingToken: "2", releasedAt: "2026-08-06T12:01:00.000Z" }),
      fenceRecord({ fencingToken: "2", databaseExpired: true }),
    ]) {
      const fixture = await releasingFixture();
      fixture.fake.driver.readRemoteGuard = vi.fn(async () => successor);
      await expect(coordinator(fixture.home, fixture.fake.driver).recoverPending()).rejects.toMatchObject({ reason: "unexpected-state" });
    }

    const activeSuccessor = await releasingFixture();
    let activeReads = 0;
    activeSuccessor.fake.driver.readRemoteGuard = vi.fn(async () => {
      activeReads += 1;
      return activeReads === 1
        ? fenceRecord({ fencingToken: "2" })
        : fenceRecord({ fencingToken: "2", releasedAt: "2026-08-06T12:01:00.000Z" });
    });
    const activeRecovered = await coordinator(activeSuccessor.home, activeSuccessor.fake.driver).recoverPending();
    expect(activeRecovered?.phase).toBe("completed");

    const expiredRecovered = await releasingFixture();
    let expiredReads = 0;
    expiredRecovered.fake.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord({ fencingToken: "2" }));
    expiredRecovered.fake.driver.readRemoteGuard = vi.fn(async () => {
      expiredReads += 1;
      if (expiredReads === 1) return fenceRecord({ databaseExpired: true });
      if (expiredReads === 2) return fenceRecord({ fencingToken: "2" });
      return fenceRecord({ fencingToken: "2", releasedAt: "2026-08-06T12:01:00.000Z" });
    });
    const expiredCompleted = await coordinator(expiredRecovered.home, expiredRecovered.fake.driver).recoverPending();
    expect(expiredCompleted?.phase).toBe("completed");

    const abortingRelease = await releasingFixture();
    const abortingCompleted = await coordinator(abortingRelease.home, abortingRelease.fake.driver).abort();
    expect(abortingCompleted.phase).toBe("aborted");

    const alreadyReleased = await releasingFixture();
    alreadyReleased.setFence(fenceRecord({ releasedAt: "2026-08-06T12:01:00.000Z" }));
    const alreadyReleasedResult = await coordinator(alreadyReleased.home, alreadyReleased.fake.driver).recoverPending();
    expect(alreadyReleasedResult?.phase).toBe("completed");
    expect(alreadyReleased.fake.driver.releaseRemoteGuard).not.toHaveBeenCalled();

    const expiredWithoutAcquire = await releasingFixture();
    expiredWithoutAcquire.fake.driver.acquireRemoteGuard = undefined;
    expiredWithoutAcquire.fake.driver.readRemoteGuard = vi.fn(async () => fenceRecord({ databaseExpired: true }));
    await expect(coordinator(expiredWithoutAcquire.home, expiredWithoutAcquire.fake.driver).recoverPending())
      .rejects.toMatchObject({ reason: "unexpected-state" });

    const reacquireMissing = await releasingFixture();
    let reacquireMissingReads = 0;
    reacquireMissing.fake.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord({ fencingToken: "2" }));
    reacquireMissing.fake.driver.readRemoteGuard = vi.fn(async () => {
      reacquireMissingReads += 1;
      return reacquireMissingReads === 1 ? fenceRecord({ databaseExpired: true }) : null;
    });
    await expect(coordinator(reacquireMissing.home, reacquireMissing.fake.driver).recoverPending())
      .rejects.toMatchObject({ reason: "unexpected-state" });

    const reacquireUnusable = await releasingFixture();
    let reacquireUnusableReads = 0;
    reacquireUnusable.fake.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord({ fencingToken: "2" }));
    reacquireUnusable.fake.driver.readRemoteGuard = vi.fn(async () => {
      reacquireUnusableReads += 1;
      return reacquireUnusableReads === 1
        ? fenceRecord({ databaseExpired: true })
        : fenceRecord({ fencingToken: "2", releasedAt: "2026-08-06T12:01:00.000Z" });
    });
    await expect(coordinator(reacquireUnusable.home, reacquireUnusable.fake.driver).recoverPending())
      .rejects.toMatchObject({ reason: "unexpected-state" });

    const reacquireSameToken = await releasingFixture();
    let reacquireSameReads = 0;
    reacquireSameToken.fake.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord());
    reacquireSameToken.fake.driver.readRemoteGuard = vi.fn(async () => {
      reacquireSameReads += 1;
      return reacquireSameReads === 1 ? fenceRecord({ databaseExpired: true }) : fenceRecord();
    });
    await expect(coordinator(reacquireSameToken.home, reacquireSameToken.fake.driver).recoverPending())
      .rejects.toMatchObject({ reason: "unexpected-state" });

    const noReadback = await releasingFixture();
    let noReadbackReads = 0;
    noReadback.fake.driver.readRemoteGuard = vi.fn(async () => {
      noReadbackReads += 1;
      return fenceRecord();
    });
    noReadback.fake.driver.releaseRemoteGuard = vi.fn(async () => undefined);
    await expect(coordinator(noReadback.home, noReadback.fake.driver).recoverPending())
      .rejects.toMatchObject({ reason: "unexpected-state" });

    for (const changed of [
      fenceRecord({ machineId: "other-machine", releasedAt: "2026-08-06T12:01:00.000Z" }),
      fenceRecord({ fencingToken: "0", releasedAt: "2026-08-06T12:01:00.000Z" }),
    ]) {
      const fixture = await releasingFixture();
      let releaseReads = 0;
      fixture.fake.driver.readRemoteGuard = vi.fn(async () => {
        releaseReads += 1;
        return releaseReads === 1 ? fenceRecord() : changed;
      });
      fixture.fake.driver.releaseRemoteGuard = vi.fn(async () => undefined);
      await expect(coordinator(fixture.home, fixture.fake.driver).recoverPending())
        .rejects.toMatchObject({ reason: "unexpected-state" });
    }

    const skipped = await releasingFixture();
    rewriteJournal(skipped.home, (journal) => ({
      ...journal,
      projects: [
        ...((journal.projects as Record<string, unknown>[])),
        {
          localProjectId: "local-project-z",
          remoteProjectId: "remote-project-z",
          evidenceSha256: "b".repeat(64),
          fence: null,
        },
      ],
    }));
    const skippedRecovered = await coordinator(skipped.home, skipped.fake.driver).recoverPending();
    expect(skippedRecovered?.phase).toBe("completed");

    const successor = await releasingFixture();
    rewriteJournal(successor.home, (journal) => ({
      ...journal,
      projects: [
        ...((journal.projects as Record<string, unknown>[])),
        {
          localProjectId: "local-project-z",
          remoteProjectId: "remote-project-z",
          evidenceSha256: "b".repeat(64),
          fence: fenceRecord({ projectId: "remote-project-z", evidenceSha256: "b".repeat(64) }),
        },
      ],
    }));
    let firstReads = 0;
    let secondReads = 0;
    successor.fake.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord({
      projectId: "remote-project-z",
      evidenceSha256: "b".repeat(64),
      fencingToken: "2",
    }));
    successor.fake.driver.readRemoteGuard = vi.fn(async ({ project }) => {
      if (project.remoteProjectId === "remote-project") {
        firstReads += 1;
        return firstReads === 1
          ? fenceRecord({ fencingToken: "2" })
          : fenceRecord({ fencingToken: "2", releasedAt: "2026-08-06T12:01:00.000Z" });
      }
      secondReads += 1;
      if (secondReads === 1) return fenceRecord({ projectId: "remote-project-z", evidenceSha256: "b".repeat(64), databaseExpired: true });
      if (secondReads === 2) return fenceRecord({ projectId: "remote-project-z", evidenceSha256: "b".repeat(64), fencingToken: "2" });
      return fenceRecord({ projectId: "remote-project-z", evidenceSha256: "b".repeat(64), fencingToken: "2", releasedAt: "2026-08-06T12:01:00.000Z" });
    });
    successor.fake.driver.releaseRemoteGuard = vi.fn(async () => undefined);
    expect((await coordinator(successor.home, successor.fake.driver).recoverPending())?.phase).toBe("completed");
  }, 15_000);

  it("releases remote fences while aborting before local publication", async () => {
    const home = makeHome();
    const input = inputFor(material());
    const fake = makeDriver(material());
    let current = fenceRecord();
    fake.driver.acquireRemoteGuard = vi.fn(async () => current);
    fake.driver.readRemoteGuard = vi.fn(async () => current);
    fake.driver.releaseRemoteGuard = vi.fn(async () => {
      current = fenceRecord({ releasedAt: "2026-08-06T12:01:00.000Z" });
    });
    await coordinator(home, fake.driver).prepare(input);
    await expect(coordinator(home, fake.driver, (event) => {
      if (event === "before-material-authenticate" && readBackendPublicationJournal(home)?.phase === "guarded") {
        throw new Error("crash:after-remote-acquire");
      }
    }).resume()).rejects.toThrow("crash:after-remote-acquire");
    const aborted = await coordinator(home, fake.driver).recoverPending({ disposition: "abort" });
    expect(aborted?.phase).toBe("aborted");
    expect(fake.driver.releaseRemoteGuard).toHaveBeenCalledOnce();
    expect(existsSync(join(backendPublicationDirectory(home), "publication-1.material"))).toBe(false);
  });

  it("captures exact descriptor and parent identities for consumer state witnesses", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const path = join(backendPublicationDirectory(home), "observed");
    writeFileSync(path, "observed", { mode: 0o600 });
    const captured = captureBackendPublicationFileWitness(path, backendPublicationDirectory(home));
    expect(captured.content).toBe("observed");
    expect(captured.witness.presence).toBe("present");
    if (captured.witness.presence === "present") {
      expect(captured.witness.dev).toMatch(/^\d+$/u);
      expect(captured.witness.ino).toMatch(/^\d+$/u);
      expect(captured.witness.parentDev).toMatch(/^\d+$/u);
      expect(captured.witness.parentIno).toMatch(/^\d+$/u);
    }
    expect(captureBackendPublicationFileWitness(join(backendPublicationDirectory(home), "missing"), backendPublicationDirectory(home)))
      .toEqual({ content: null, witness: expect.objectContaining({ presence: "absent" }) });
    const directoryPath = join(backendPublicationDirectory(home), "directory");
    mkdirSync(directoryPath, { mode: 0o700 });
    expect(() => captureBackendPublicationFileWitness(directoryPath, backendPublicationDirectory(home)))
      .toThrow("regular file");

    const uidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      expect(captureBackendPublicationFileWitness(path, backendPublicationDirectory(home)).content).toBe("observed");
    } finally {
      if (uidDescriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", uidDescriptor);
    }
  });

  it("rejects captured regular files outside the owner-readable mode domain", async () => {
    const home = makeHome();
    const directory = backendPublicationDirectory(home);
    mkdirSync(directory, { mode: 0o700 });
    const path = join(directory, "group-readable");
    writeFileSync(path, "observed", { mode: 0o640 });
    chmodSync(path, 0o640);
    expect(statSync(path).mode & 0o777).toBe(0o640);

    expect(() => captureBackendPublicationFileWitness(path, directory)).toThrow("mode is not trusted");
  });

  it.each([
    0o000,
    0o100,
    0o200,
    0o300,
    0o640,
    0o604,
    0o644,
    0o1000,
    0o2000,
    0o4000,
    0o7000,
  ])("rejects journal witness mode %o before authentication", async (mode) => {
    await expectJournalReadFailure((journal) => ({
      ...journal,
      sourceState: {
        ...(journal.sourceState as Record<string, unknown>),
        config: {
          ...((journal.sourceState as { config: Record<string, unknown> }).config),
          mode,
        },
      },
    }));
  });

  it("supports runtimes without a getuid syscall", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      await coordinator(home, fake.driver).prepare(inputFor(input));
      await expect(coordinator(home, fake.driver).resume()).resolves.toMatchObject({ phase: "completed" });
      await expect(coordinator(home, makeDriver(input).driver).prepare({
        ...inputFor(input),
        publicationId: "publication-2",
      })).resolves.toMatchObject({ phase: "prepared" });
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("recovers a crash after material seal without orphaning or overwriting the journal", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    let crashed = false;
    const crashObserver = (event: string): void => {
      if (event === "after-material-seal" && !crashed) {
        crashed = true;
        throw new Error("crash:material-seal");
      }
    };

    await expect(coordinator(home, fake.driver, crashObserver).prepare(inputFor(input)))
      .rejects.toThrow("crash:material-seal");
    expect(readBackendPublicationJournal(home)?.phase).toBe("preparing");
    expect(readFileSync(join(backendPublicationDirectory(home), "publication-1.material"), "utf8")).toContain("eyJiYWNrZW5kIjoic3FsaXRl");

    const recovered = await coordinator(home, fake.driver).recoverPending();
    expect(recovered?.phase).toBe("completed");
    expect(fake.calls).toEqual(["publish-map", "publish-config"]);
  });

  it("authenticates and cleans a sealed material file when aborting before prepared", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await expect(coordinator(home, fake.driver, (event) => {
      if (event === "after-material-seal") throw new Error("crash:before-prepared");
    }).prepare(inputFor(input))).rejects.toThrow("crash:before-prepared");

    const aborted = await coordinator(home, fake.driver).abort();
    expect(aborted.phase).toBe("aborted");
    expect(existsSync(join(backendPublicationDirectory(home), "publication-1.material"))).toBe(false);
  });

  it("fails closed and preserves tampered recovery material", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const path = join(backendPublicationDirectory(home), "publication-1.material");
    writeFileSync(path, "tampered", { mode: 0o600 });

    await expect(coordinator(home, fake.driver).resume()).rejects.toMatchObject<BackendPublicationJournalError>({
      reason: "checksum-mismatch",
    });
    expect(readFileSync(path, "utf8")).toBe("tampered");
    expect(readBackendPublicationJournal(home)?.phase).toBe("guarded");
  });

  it("rejects unsafe and oversized recovery input before creating a seal", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await expect(coordinator(home, fake.driver).prepare(inputFor({
      ...input,
      target: { ...input.target, config: recoveryFile("x", 0o644) },
    }))).rejects.toMatchObject({ reason: "invalid-input" });
    await expect(coordinator(home, fake.driver).prepare(inputFor({
      ...input,
      target: { ...input.target, config: { ...recoveryFile("x"), content: Buffer.alloc(4 * 1024 * 1024 + 1) } },
    }))).rejects.toMatchObject({ reason: "invalid-input" });
    expect(readBackendPublicationJournal(home)).toBeNull();
  });

  it("rejects recovery material that exceeds the sealed envelope bound", async () => {
    const home = makeHome();
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const gid = typeof process.getgid === "function" ? process.getgid() : 0;
    const huge: BackendPublicationRecoveryFile = {
      presence: "present",
      content: Buffer.alloc(4 * 1024 * 1024, 0x78),
      mode: 0o600,
      uid,
      gid,
      nlink: "1",
      dev: "1",
      ino: "2",
      parentDev: "3",
      parentIno: "4",
    };
    const hugeMaterial: BackendPublicationRecoveryMaterial = {
      source: { config: huge, projectMap: huge },
      target: { config: huge, projectMap: huge },
    };
    const fake = makeDriver(hugeMaterial);
    await expect(coordinator(home, fake.driver).prepare(inputFor(hugeMaterial)))
      .rejects.toMatchObject({ reason: "invalid-input" });
    expect(readBackendPublicationJournal(home)?.phase).toBe("preparing");
  });

  it("aborts a pre-release partial publication and restores source state", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const publishMap = fake.driver.publishProjectMap;
    fake.driver.publishProjectMap = async (mutation) => {
      await publishMap(mutation);
      throw new Error("crash:after-map");
    };
    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-map");
    expect(readBackendPublicationJournal(home)?.phase).toBe("map-publishing");

    const aborted = await coordinator(home, fake.driver).abort();
    expect(aborted.phase).toBe("aborted");
    expect(fake.getState()).toEqual(sourceState(input));
    expect(fake.calls).toContain("restore-map");
  });

  it("keeps a preparing journal fail-closed when sealing did not happen", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    const observer = (event: string): void => {
      if (event === "before-material-seal") throw new Error("crash:before-seal");
    };
    await expect(coordinator(home, fake.driver, observer).prepare(inputFor(input))).rejects.toThrow("crash:before-seal");
    await expect(coordinator(home, fake.driver).recoverPending()).rejects.toThrow();
    expect(readBackendPublicationJournal(home)?.phase).toBe("preparing");
    expect(readBackendPublicationJournal(home)?.recoveryReference).toBeNull();
  });

  it("aborts an unsealed journal and fails closed on an untrusted sealed journal", async () => {
    const missingHome = makeHome();
    const missingInput = material();
    const missingFake = makeDriver(missingInput);
    await expect(coordinator(missingHome, missingFake.driver, (event) => {
      if (event === "before-material-seal") throw new Error("crash:before-seal-abort");
    }).prepare(inputFor(missingInput))).rejects.toThrow("crash:before-seal-abort");
    await expect(coordinator(missingHome, missingFake.driver).abort()).resolves.toMatchObject({ phase: "aborted" });
    await expect(coordinator(missingHome, missingFake.driver).abort()).resolves.toMatchObject({ phase: "aborted" });

    const tamperedHome = makeHome();
    const tamperedInput = material();
    const tamperedFake = makeDriver(tamperedInput);
    await expect(coordinator(tamperedHome, tamperedFake.driver, (event) => {
      if (event === "after-material-seal") throw new Error("crash:sealed-abort");
    }).prepare(inputFor(tamperedInput))).rejects.toThrow("crash:sealed-abort");
    writeFileSync(join(backendPublicationDirectory(tamperedHome), "publication-1.material"), "tampered", { mode: 0o600 });
    await expect(coordinator(tamperedHome, tamperedFake.driver).abort()).rejects.toMatchObject({ reason: "malformed-journal" });
  });

  it("restores published files during abort and uses operator cleanup callbacks", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const originalPublishConfig = fake.driver.publishConfig;
    fake.driver.publishConfig = async (mutation) => {
      await originalPublishConfig(mutation);
      throw new Error("crash:after-config");
    };
    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-config");
    expect(readBackendPublicationJournal(home)?.phase).toBe("config-publishing");
    const cleanup = vi.fn(async () => undefined);
    fake.driver.cleanupAbortedMaterial = cleanup;
    const aborted = await coordinator(home, fake.driver).abort();
    expect(aborted.phase).toBe("aborted");
    expect(fake.getState()).toEqual(sourceState(input));
    expect(fake.calls).toEqual(["publish-map", "publish-config", "restore-config", "restore-map"]);
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(coordinator(home, fake.driver).abort()).resolves.toMatchObject({ phase: "aborted" });
  });

  it("retries config and map restoration checkpoints after recovery crashes", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const originalPublishConfig = fake.driver.publishConfig;
    fake.driver.publishConfig = async (mutation) => {
      await originalPublishConfig(mutation);
      throw new Error("crash:after-config-retry");
    };
    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-config-retry");
    let crashConfig = true;
    const configObserver = (event: string): void => {
      if (crashConfig && event === "after-journal-write" && readBackendPublicationJournal(home)?.phase === "config-restoring") {
        crashConfig = false;
        throw new Error("crash:config-restoring");
      }
    };
    await expect(coordinator(home, fake.driver, configObserver).abort()).rejects.toThrow("crash:config-restoring");
    expect(readBackendPublicationJournal(home)?.phase).toBe("config-restoring");
    let crashMap = true;
    const mapObserver = (event: string): void => {
      if (crashMap && event === "after-journal-write" && readBackendPublicationJournal(home)?.phase === "map-restoring") {
        crashMap = false;
        throw new Error("crash:map-restoring");
      }
    };
    await expect(coordinator(home, fake.driver, mapObserver).resume()).rejects.toThrow("crash:map-restoring");
    expect(readBackendPublicationJournal(home)?.phase).toBe("map-restoring");
    expect((await coordinator(home, fake.driver).abort()).phase).toBe("aborted");
  });

  it("covers canonical witness helpers and absent material shapes", () => {
    expect(() => backendPublicationCanonicalSha256(undefined)).toThrow(TypeError);
    expect(backendPublicationMaterialWitness({
      source: {
        config: recoveryFile("not-json"),
        projectMap: { presence: "absent" },
      },
      target: {
        config: { presence: "absent" },
        projectMap: recoveryFile("not-json"),
      },
    })).toMatchObject({
      config: { presence: "present" },
      projectMap: { presence: "absent" },
    });
    expect(backendPublicationDirectory()).toContain(".lcm/backend-publication");
  });

  it("fails closed for malformed observed state and witness mismatches", async () => {
    const malformedHome = makeHome();
    const malformed = makeDriver(material());
    malformed.driver.observeLocalState = vi.fn(async () => null as never);
    await expect(coordinator(malformedHome, malformed.driver).prepare(inputFor(material())))
      .rejects.toMatchObject({ reason: "malformed-journal" });

    const malformedAbsentHome = makeHome();
    const malformedAbsent = makeDriver(material());
    malformedAbsent.driver.observeLocalState = vi.fn(async () => ({
      config: { presence: "absent", rawSha256: "bad" } as never,
      projectMap: sourceState(material()).projectMap,
    }));
    await expect(coordinator(malformedAbsentHome, malformedAbsent.driver).prepare(inputFor(material())))
      .rejects.toMatchObject({ reason: "malformed-journal" });

    const mismatchHome = makeHome();
    const mismatch = makeDriver(material());
    await coordinator(mismatchHome, mismatch.driver).prepare(inputFor(material()));
    mismatch.driver.observeLocalState = vi.fn(async () => ({
      ...mismatch.getState(),
      projectMap: { ...mismatch.getState().projectMap, rawSha256: "b".repeat(64) },
    }));
    await expect(coordinator(mismatchHome, mismatch.driver).resume())
      .rejects.toMatchObject({ reason: "unexpected-state" });

    const contentHome = makeHome();
    const content = makeDriver(material());
    const altered = sourceState(material());
    content.driver.observeLocalState = vi.fn(async () => ({
      ...altered,
      config: { ...altered.config, uid: altered.config.presence === "present" ? altered.config.uid + 1 : 1 },
    }));
    await expect(coordinator(contentHome, content.driver).prepare(inputFor(material())))
      .rejects.toMatchObject({ reason: "unexpected-state" });

    const absentHome = makeHome();
    const absentMaterial: BackendPublicationRecoveryMaterial = {
      source: { config: { presence: "absent" }, projectMap: { presence: "absent" } },
      target: { config: { presence: "absent" }, projectMap: { presence: "absent" } },
    };
    const absent = makeDriver(absentMaterial);
    await expect(coordinator(absentHome, absent.driver).prepare(inputFor(absentMaterial)))
      .resolves.toMatchObject({ phase: "prepared", intendedConfigSha256: sha256("{}") });
  });

  it("rejects each top-level input and timestamp boundary", async () => {
    const valid = inputFor(material());
    const cases: readonly [string, unknown][] = [
      ["not an object", null],
      ["invalid publication id", { ...valid, publicationId: "bad id" }],
      ["invalid source backend", { ...valid, sourceBackend: "redis" }],
      ["invalid target backend", { ...valid, targetBackend: "redis" }],
      ["same backend", { ...valid, targetBackend: "sqlite" }],
      ["invalid material", { ...valid, material: null }],
      ["invalid source material", { ...valid, material: { ...valid.material, source: null } }],
      ["invalid target material", { ...valid, material: { ...valid.material, target: null } }],
      ["invalid projects", { ...valid, projects: null }],
      ["invalid date", { ...valid, now: new Date("invalid") }],
    ];
    for (const [label, candidate] of cases) {
      const home = makeHome();
      const fake = makeDriver(material());
      await expect(coordinator(home, fake.driver).prepare(candidate as never), label)
        .rejects.toMatchObject({ reason: "invalid-input" });
    }

    const noDate = makeHome();
    const noDateDriver = makeDriver(material());
    const { now: _now, ...withoutDate } = valid;
    await expect(coordinator(noDate, noDateDriver.driver).prepare(withoutDate))
      .resolves.toMatchObject({ phase: "prepared" });
  });

  it("rejects malformed recovery files, project coverage, and noncanonical project order", async () => {
    const valid = inputFor(material());
    const invalidMaterials: readonly [string, unknown][] = [
      ["invalid presence", { ...valid.material, source: { ...valid.material.source, config: {} } }],
      ["empty content", { ...valid.material, source: { ...valid.material.source, config: recoveryFile("") } }],
      ["broad mode", { ...valid.material, source: { ...valid.material.source, config: recoveryFile("x", 0o644) } }],
      ["negative uid", { ...valid.material, source: { ...valid.material.source, config: { ...recoveryFile("x"), uid: -1 } } }],
      ["negative gid", { ...valid.material, source: { ...valid.material.source, config: { ...recoveryFile("x"), gid: -1 } } }],
    ];
    for (const [label, candidate] of invalidMaterials) {
      const home = makeHome();
      const fake = makeDriver(material());
      await expect(coordinator(home, fake.driver).prepare({ ...valid, material: candidate as never }), label)
        .rejects.toMatchObject({ reason: "invalid-input" });
    }

    const invalidProjects: readonly [string, readonly Record<string, unknown>[]][] = [
      ["missing local id", [{ remoteProjectId: "remote", evidenceSha256: "a".repeat(64) }]],
      ["missing remote id", [{ localProjectId: "local", evidenceSha256: "a".repeat(64) }]],
      ["invalid evidence", [{ localProjectId: "local", remoteProjectId: "remote", evidenceSha256: "bad" }]],
      ["duplicate local id", [
        { localProjectId: "local", remoteProjectId: "remote-a", evidenceSha256: "a".repeat(64) },
        { localProjectId: "local", remoteProjectId: "remote-b", evidenceSha256: "b".repeat(64) },
      ]],
      ["duplicate remote id", [
        { localProjectId: "local-a", remoteProjectId: "remote", evidenceSha256: "a".repeat(64) },
        { localProjectId: "local-b", remoteProjectId: "remote", evidenceSha256: "b".repeat(64) },
      ]],
    ];
    for (const [label, projects] of invalidProjects) {
      const home = makeHome();
      const fake = makeDriver(material());
      await expect(coordinator(home, fake.driver).prepare({ ...valid, projects: projects as never }), label)
        .rejects.toMatchObject({ reason: "invalid-input" });
    }

    const sorted = makeHome();
    const sortedDriver = makeDriver(material());
    const prepared = await coordinator(sorted, sortedDriver.driver).prepare({
      ...valid,
      projects: [
        { localProjectId: "z", remoteProjectId: "remote-z", evidenceSha256: "b".repeat(64) },
        { localProjectId: "a", remoteProjectId: "remote-a", evidenceSha256: "c".repeat(64) },
      ],
    });
    expect(prepared.projects.map(({ localProjectId }) => localProjectId)).toEqual(["a", "z"]);
  });

  it("rejects every unsafe recovery-file boundary and project length boundary", async () => {
    const valid = inputFor(material());
    const invalidFiles: readonly [string, unknown][] = [
      ["non-byte content", { ...recoveryFile("x"), content: "x" }],
      ["oversized content", { ...recoveryFile("x"), content: Buffer.alloc(4 * 1024 * 1024 + 1) }],
      ["negative mode", { ...recoveryFile("x"), mode: -1 }],
      ["oversized mode", { ...recoveryFile("x"), mode: 0o10000 }],
      ["non-private mode", { ...recoveryFile("x"), mode: 0o644 }],
      ["fractional uid", { ...recoveryFile("x"), uid: 1.5 }],
      ["unsafe uid", { ...recoveryFile("x"), uid: Number.MAX_SAFE_INTEGER + 1 }],
      ["fractional gid", { ...recoveryFile("x"), gid: 1.5 }],
      ["unsafe gid", { ...recoveryFile("x"), gid: Number.MAX_SAFE_INTEGER + 1 }],
    ];
    for (const [label, file] of invalidFiles) {
      const home = makeHome();
      const fake = makeDriver(material());
      await expect(coordinator(home, fake.driver).prepare({
        ...valid,
        material: { ...valid.material, source: { ...valid.material.source, config: file as never } },
      }), label).rejects.toMatchObject({ reason: "invalid-input" });
    }

    for (const [label, projects] of [
      ["long local", [{ localProjectId: "l".repeat(257), remoteProjectId: "remote", evidenceSha256: "a".repeat(64) }]],
      ["long remote", [{ localProjectId: "local", remoteProjectId: "r".repeat(257), evidenceSha256: "a".repeat(64) }]],
    ] as const) {
      const home = makeHome();
      const fake = makeDriver(material());
      await expect(coordinator(home, fake.driver).prepare({ ...valid, projects: projects as never }), label)
        .rejects.toMatchObject({ reason: "invalid-input" });
    }
  });

  it("returns null for an empty recovery scan and fails closed without a journal", async () => {
    const home = makeHome();
    const fake = makeDriver(material());
    await expect(coordinator(home, fake.driver).recoverPending()).resolves.toBeNull();
    await expect(coordinator(home, fake.driver).resume()).rejects.toMatchObject({
      reason: "publication-evidence-missing",
    });
    await expect(coordinator(home, fake.driver).abort()).rejects.toMatchObject({
      reason: "publication-evidence-missing",
    });
  });

  it("fails closed for missing, replaced, and invalid publication roots", async () => {
    const missingHome = mkdtempSync(join(tmpdir(), "lcm-backend-publication-no-root-"));
    roots.push(missingHome);
    const missingFake = makeDriver(material());
    await expect(coordinator(missingHome, missingFake.driver).prepare(inputFor(material())))
      .rejects.toMatchObject({ reason: "unsafe-storage" });
    expect(readBackendPublicationJournal(missingHome)).toBeNull();

    const fileHome = makeHome();
    writeFileSync(join(fileHome, ".lcm", "backend-publication"), "not a directory", { mode: 0o600 });
    expect(() => readBackendPublicationJournal(fileHome)).toThrow("cannot be opened");
    await expect(coordinator(fileHome, makeDriver(material()).driver).prepare(inputFor(material())))
      .rejects.toMatchObject({ reason: "unsafe-storage" });

    const invalidJournalHome = makeHome();
    const invalidDirectory = backendPublicationDirectory(invalidJournalHome);
    mkdirSync(invalidDirectory, { mode: 0o700 });
    mkdirSync(join(invalidDirectory, "journal.json"), { mode: 0o700 });
    expect(() => readBackendPublicationJournal(invalidJournalHome)).toThrow("cannot be read");

    const mkdirFailureHome = makeHome();
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalMkdir = nodeFs.mkdirSync;
    const mkdirFailure = Object.assign(new Error("mkdir denied"), { code: "EACCES" });
    try {
      nodeFs.mkdirSync = ((path: string, options?: unknown) => {
        if (path === backendPublicationDirectory(mkdirFailureHome)) throw mkdirFailure;
        return (originalMkdir as (path: string, options?: unknown) => unknown)(path, options);
      });
      syncBuiltinESMExports();
      await expect(coordinator(mkdirFailureHome, makeDriver(material()).driver).prepare(inputFor(material())))
        .rejects.toMatchObject({ reason: "unsafe-storage" });
    } finally {
      nodeFs.mkdirSync = originalMkdir;
      syncBuiltinESMExports();
    }
  });

  it("detects journal races before initial and conditional writes", async () => {
    const occupied = await preparedFixture();
    const occupiedContent = readFileSync(backendPublicationJournalPath(occupied.home));
    const home = makeHome();
    const fake = makeDriver(material());
    await expect(coordinator(home, fake.driver, (event, path) => {
      if (event === "before-journal-read") writeFileSync(path, occupiedContent, { mode: 0o600 });
    }).prepare(inputFor(material()))).rejects.toMatchObject({ reason: "unresolved-publication" });

    const conditional = await preparedFixture();
    const journalPath = backendPublicationJournalPath(conditional.home);
    const observer = (event: string): void => {
      if (event === "after-journal-write" && readBackendPublicationJournal(conditional.home)?.phase === "acquiring") {
        rmSync(journalPath);
      }
    };
    await expect(coordinator(conditional.home, conditional.fake.driver, observer).resume())
      .rejects.toMatchObject({ reason: "unexpected-state" });

    const malformed = await preparedFixture();
    await expect(coordinator(malformed.home, malformed.fake.driver, (event, path) => {
      if (event === "before-journal-read") writeFileSync(path, "{", { mode: 0o600 });
    }).resume()).rejects.toMatchObject({ reason: "malformed-journal" });

    const historyHome = makeHome();
    const historyInput = material();
    const historyFirst = makeDriver(historyInput);
    await coordinator(historyHome, historyFirst.driver).prepare(inputFor(historyInput));
    await coordinator(historyHome, historyFirst.driver).resume();
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalMkdir = nodeFs.mkdirSync;
    const historyPath = join(backendPublicationDirectory(historyHome), "history");
    const historyFailure = Object.assign(new Error("history mkdir denied"), { code: "EACCES" });
    try {
      nodeFs.mkdirSync = ((path: string, options?: unknown) => {
        if (path === historyPath) throw historyFailure;
        return (originalMkdir as (path: string, options?: unknown) => unknown)(path, options);
      });
      syncBuiltinESMExports();
      await expect(coordinator(historyHome, makeDriver(historyInput).driver).prepare({
        ...inputFor(historyInput),
        publicationId: "publication-2",
      })).rejects.toMatchObject({
        reason: "unsafe-storage",
        message: "backend publication history directory cannot be created",
        cause: historyFailure,
      });
    } finally {
      nodeFs.mkdirSync = originalMkdir;
      syncBuiltinESMExports();
    }
  });

  it("aborts pending work through the recovery disposition option", async () => {
    const { home, fake } = await preparedFixture();
    await expect(coordinator(home, fake.driver).recoverPending({ disposition: "abort" }))
      .resolves.toMatchObject({ phase: "aborted" });

    const noUidHome = makeHome();
    const noUidInput = material();
    const noUidFake = makeDriver(noUidInput);
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      await coordinator(noUidHome, noUidFake.driver).prepare(inputFor(noUidInput));
      await expect(coordinator(noUidHome, noUidFake.driver).recoverPending({ disposition: "abort" }))
        .resolves.toMatchObject({ phase: "aborted" });
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("fails closed for malformed authenticated journal envelopes", async () => {
    const { home } = await preparedFixture();
    writeFileSync(backendPublicationJournalPath(home), "{", { mode: 0o600 });
    let thrown: unknown;
    try {
      readBackendPublicationJournal(home);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ reason: "malformed-journal" });

    const nonObject = await preparedFixture();
    writeFileSync(backendPublicationJournalPath(nonObject.home), "[]\n", { mode: 0o600 });
    expect(() => readBackendPublicationJournal(nonObject.home)).toThrow("not an object");

    await expectJournalReadFailure((journal) => ({ ...journal, extra: true }));
    const checksumMalformed = await preparedFixture();
    const checksumValue = JSON.parse(readFileSync(backendPublicationJournalPath(checksumMalformed.home), "utf8")) as Record<string, unknown>;
    checksumValue.checksumSha256 = "bad";
    writeFileSync(backendPublicationJournalPath(checksumMalformed.home), `${JSON.stringify(checksumValue)}\n`, { mode: 0o600 });
    expect(() => readBackendPublicationJournal(checksumMalformed.home)).toThrow("checksum is malformed");

    const checksumMismatch = await preparedFixture();
    const mismatchValue = JSON.parse(readFileSync(backendPublicationJournalPath(checksumMismatch.home), "utf8")) as Record<string, unknown>;
    mismatchValue.updatedAt = "2026-08-06T12:00:01.000Z";
    writeFileSync(backendPublicationJournalPath(checksumMismatch.home), `${JSON.stringify(mismatchValue)}\n`, { mode: 0o600 });
    let checksumError: unknown;
    try {
      readBackendPublicationJournal(checksumMismatch.home);
    } catch (error) {
      checksumError = error;
    }
    expect(checksumError).toMatchObject({ reason: "checksum-mismatch" });
  });

  it("fails closed for malformed recovery-material envelopes and fields", async () => {
    await expectMaterialReadFailure("{");
    await expectMaterialReadFailure("[]");
    await expectMaterialReadFailure(JSON.stringify({ version: 2 }));
    await expectMaterialReadFailure(JSON.stringify({
      version: 1,
      publicationId: "other",
      source: {},
      target: {},
    }));
    await expectMaterialReadFailure(JSON.stringify({
      version: 1,
      publicationId: "publication-1",
      source: null,
      target: {},
    }));
    await expectMaterialReadFailure(JSON.stringify({
      version: 1,
      publicationId: "publication-1",
      source: { config: {}, projectMap: {} },
      target: { config: {}, projectMap: {} },
    }));

    const envelope = {
      version: 1,
      publicationId: "publication-1",
      source: { config: { presence: "absent" }, projectMap: { presence: "absent" } },
      target: { config: { presence: "absent" }, projectMap: { presence: "absent" } },
    };
    await expectMaterialReadFailure(JSON.stringify({
      ...envelope,
      source: { config: { presence: "absent", extra: true }, projectMap: envelope.source.projectMap },
    }));
    await expectMaterialReadFailure(JSON.stringify({
      ...envelope,
      source: { config: null, projectMap: envelope.source.projectMap },
    }));

    const present = {
      contentBase64: "",
      mode: 0o600,
      uid: 0,
      gid: 0,
      nlink: "1",
      dev: "1",
      ino: "2",
      parentDev: "3",
      parentIno: "4",
      presence: "present",
    };
    for (const [label, value, reason] of [
      ["missing content", { mode: 0o600, uid: 0, gid: 0, presence: "present" }, "malformed-journal"],
      ["wrong presence", { ...present, presence: "other" }, "malformed-journal"],
      ["wrong base64 type", { ...present, contentBase64: 1 }, "malformed-journal"],
      ["fractional mode", { ...present, mode: 1.5 }, "malformed-journal"],
      ["fractional uid", { ...present, uid: 1.5 }, "malformed-journal"],
      ["fractional gid", { ...present, gid: 1.5 }, "malformed-journal"],
      ["empty decoded content", present, "invalid-input"],
    ] as const) {
      await expectMaterialReadFailure(JSON.stringify({
        ...envelope,
        source: { config: value, projectMap: envelope.source.projectMap },
      }), reason as BackendPublicationJournalError["reason"])
        .catch((error) => { throw new Error(`${label}: ${String(error)}`); });
    }
  });

  it("requires the deterministic recovery-material pathname during authentication", async () => {
    const { home, fake } = await preparedFixture();
    rewriteJournal(home, (journal) => ({
      ...journal,
      recoveryReference: {
        relativePath: "other-publication.material",
        sealSha256: "a".repeat(64),
        byteLength: 1,
      },
    }));
    await expect(coordinator(home, fake.driver).resume()).rejects.toMatchObject({ reason: "malformed-journal" });
  });

  describe("rejects malformed journal fields, witnesses, references, fences, and projects", () => {
    it("reports malformed source state", async () => {
      const explicit = await preparedFixture();
      rewriteJournal(explicit.home, (journal) => ({ ...journal, sourceState: null }));
      expect(() => readBackendPublicationJournal(explicit.home)).toThrow("source state is malformed");
    });

    const malformedCases: readonly [string, (journal: Record<string, unknown>) => Record<string, unknown>][] = [
      ["invalid fields", (journal) => ({ ...journal, version: 1 })],
      ["invalid phase", (journal) => ({ ...journal, phase: "unknown" })],
      ["invalid source backend", (journal) => ({ ...journal, sourceBackend: "redis" })],
      ["invalid target backend", (journal) => ({ ...journal, targetBackend: "redis" })],
      ["same backend", (journal) => ({ ...journal, targetBackend: journal.sourceBackend })],
      ["invalid timestamp", (journal) => ({ ...journal, createdAt: "invalid" })],
      ["invalid hash", (journal) => ({ ...journal, expectedConfigSha256: "bad" })],
      ["invalid projects", (journal) => ({ ...journal, projects: {} })],
      ["invalid source state", (journal) => ({ ...journal, sourceState: null })],
      ["invalid witness object", (journal) => ({
        ...journal,
        sourceState: { ...(journal.sourceState as Record<string, unknown>), config: null },
      })],
      ["absent witness extra field", (journal) => ({
        ...journal,
        sourceState: {
          config: {
            presence: "absent",
            rawSha256: null,
            semanticSha256: null,
            byteLength: 0,
            mode: null,
            uid: null,
            gid: null,
            nlink: null,
            dev: null,
            ino: null,
            parentDev: null,
            parentIno: null,
            extra: true,
          },
          projectMap: (journal.sourceState as { projectMap: unknown }).projectMap,
        },
      })],
      ["absent witness value", (journal) => ({
        ...journal,
        sourceState: {
          config: {
            presence: "absent",
            rawSha256: "bad",
            semanticSha256: null,
            byteLength: 0,
            mode: null,
            uid: null,
            gid: null,
            nlink: null,
            dev: null,
            ino: null,
            parentDev: null,
            parentIno: null,
          },
          projectMap: (journal.sourceState as { projectMap: unknown }).projectMap,
        },
      })],
      ["invalid presence", (journal) => ({
        ...journal,
        sourceState: { ...(journal.sourceState as Record<string, unknown>), config: { presence: "other" } },
      })],
      ["present witness extra field", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), extra: true },
        },
      })],
      ["present witness malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), rawSha256: "bad" },
        },
      })],
      ["present semantic hash malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), semanticSha256: "bad" },
        },
      })],
      ["present byte length malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), byteLength: 0 },
        },
      })],
      ["present mode malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), mode: -1 },
        },
      })],
      ["present uid malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), uid: -1 },
        },
      })],
      ["present gid malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), gid: -1 },
        },
      })],
      ["present nlink malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), nlink: "bad" },
        },
      })],
      ["present dev malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), dev: "bad" },
        },
      })],
      ["present ino malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), ino: "bad" },
        },
      })],
      ["present parent dev malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), parentDev: "bad" },
        },
      })],
      ["present parent ino malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), parentIno: "bad" },
        },
      })],
      ["invalid reference", (journal) => ({ ...journal, recoveryReference: { relativePath: "bad" } })],
      ["reference empty length", (journal) => ({
        ...journal,
        recoveryReference: { relativePath: "publication-1.material", sealSha256: "a".repeat(64), byteLength: 0 },
      })],
      ["reference oversized length", (journal) => ({
        ...journal,
        recoveryReference: { relativePath: "publication-1.material", sealSha256: "a".repeat(64), byteLength: 8 * 1024 * 1024 + 1 },
      })],
      ["invalid fence", (journal) => ({
        ...journal,
        projects: [{
          ...((journal.projects as Record<string, unknown>[])[0]),
          fence: { bad: true },
        }],
      })],
      ["invalid project", (journal) => ({ ...journal, projects: [{ localProjectId: "only-local" }] })],
      ["project invalid local", (journal) => ({
        ...journal,
        projects: [{
          ...((journal.projects as Record<string, unknown>[])[0]),
          localProjectId: 1,
        }],
      })],
      ["project invalid remote", (journal) => ({
        ...journal,
        projects: [{
          ...((journal.projects as Record<string, unknown>[])[0]),
          remoteProjectId: 1,
        }],
      })],
      ["project invalid evidence", (journal) => ({
        ...journal,
        projects: [{
          ...((journal.projects as Record<string, unknown>[])[0]),
          evidenceSha256: "bad",
        }],
      })],
      ["project invalid fence value", (journal) => ({
        ...journal,
        projects: [{
          ...((journal.projects as Record<string, unknown>[])[0]),
          fence: "bad",
        }],
      })],
    ];
    it.each(malformedCases)("%s", async (_label, mutate) => {
      await expectJournalReadFailure(mutate);
    });
  });

  it("rejects every malformed persisted fence field", async () => {
    const baseFence = {
      projectId: "remote-project",
      machineId: "machine-1",
      publicationId: "publication-1",
      targetBackend: "postgresql",
      evidenceSha256: "a".repeat(64),
      fencingToken: "1",
      acquiredAt: "2026-08-06T12:00:00.000Z",
      renewedAt: "2026-08-06T12:00:00.000Z",
      expiresAt: "2999-08-06T12:00:00.000Z",
      releasedAt: null,
      databaseExpired: false,
    };
    const malformed: readonly [string, Record<string, unknown>][] = [
      ["project id", { projectId: 1 }],
      ["machine id", { machineId: 1 }],
      ["publication id", { publicationId: 1 }],
      ["target backend", { targetBackend: "redis" }],
      ["evidence", { evidenceSha256: "bad" }],
      ["fencing token", { fencingToken: "bad" }],
      ["acquired timestamp", { acquiredAt: "bad" }],
      ["renewed timestamp", { renewedAt: "bad" }],
      ["expiry timestamp", { expiresAt: "bad" }],
      ["released type", { releasedAt: 1 }],
      ["released timestamp", { releasedAt: "bad" }],
      ["database expiry", { databaseExpired: "false" }],
    ];
    for (const [label, change] of malformed) {
      await expectJournalReadFailure((journal) => ({
        ...journal,
        projects: [{
          ...((journal.projects as Record<string, unknown>[])[0]),
          fence: { ...baseFence, ...change },
        }],
      })).catch((error) => { throw new Error(`${label}: ${String(error)}`); });
    }
  });

  it("rejects unsorted, duplicate, and empty project journal records", async () => {
    await expectJournalReadFailure((journal) => ({
      ...journal,
      projects: [
        ...(journal.projects as Record<string, unknown>[]),
        { ...(journal.projects as Record<string, unknown>[])[0], localProjectId: "" },
      ],
    }));

    const duplicateLocal = await preparedFixture();
    rewriteJournal(duplicateLocal.home, (journal) => ({
      ...journal,
      projects: [
        ...(journal.projects as Record<string, unknown>[]),
        { ...(journal.projects as Record<string, unknown>[])[0], remoteProjectId: "other" },
      ],
    }));
    expect(() => readBackendPublicationJournal(duplicateLocal.home)).toThrow("canonically sorted");

    const duplicateRemote = await preparedFixture();
    rewriteJournal(duplicateRemote.home, (journal) => ({
      ...journal,
      projects: [
        ...(journal.projects as Record<string, unknown>[]),
        { ...(journal.projects as Record<string, unknown>[])[0], localProjectId: "other" },
      ],
    }));
    expect(() => readBackendPublicationJournal(duplicateRemote.home)).toThrow("canonically sorted");
  });

  it("routes abort recovery through abort-release checkpoints after release crashes", async () => {
    for (const checkpoint of ["before-release", "after-release"] as const) {
      const home = makeHome();
      const input = material();
      const fake = makeDriver(input);
      let fence: BackendPublicationFenceRecord | null = null;
      fake.driver.acquireRemoteGuard = vi.fn(async () => {
        fence = fenceRecord();
        return fence;
      });
      fake.driver.readRemoteGuard = vi.fn(async () => fence);
      fake.driver.releaseRemoteGuard = vi.fn(async () => {
        if (fence !== null) fence = { ...fence, releasedAt: "2026-08-06T12:01:00.000Z" };
      });
      await coordinator(home, fake.driver).prepare(inputFor(input));
      await expect(coordinator(home, fake.driver, (event) => {
        if (event === "before-release") throw new Error("crash:initial-release");
      }).resume()).rejects.toThrow("crash:initial-release");
      expect(readBackendPublicationJournal(home)?.phase).toBe("releasing");

      const abortCall = checkpoint === "before-release"
        ? coordinator(home, fake.driver, (event) => {
          if (event === checkpoint) throw new Error("crash:abort-" + checkpoint);
        }).abort()
        : coordinator(home, fake.driver, (event) => {
          if (event === checkpoint) throw new Error("crash:abort-" + checkpoint);
        }).recoverPending({ disposition: "abort" });
      await expect(abortCall).rejects.toThrow("crash:abort-" + checkpoint);
      expect(readBackendPublicationJournal(home)?.phase).toBe("abort-releasing");

      const recovered = await coordinator(home, fake.driver).abort();
      expect(recovered.phase).toBe("aborted");
      expect(fence?.releasedAt).not.toBeNull();
      expect(existsSync(join(backendPublicationDirectory(home), "publication-1.material"))).toBe(false);
    }
  });

  it("keeps abort-releasing durable until sealed material cleanup completes", async () => {
    const { home, input, fake } = await preparedFixture();
    await expect(coordinator(home, fake.driver, (event) => {
      if (
        event === "before-material-authenticate"
        && readBackendPublicationJournal(home)?.phase === "abort-releasing"
      ) throw new Error("crash:abort-cleanup");
    }).abort()).rejects.toThrow("crash:abort-cleanup");
    expect(readBackendPublicationJournal(home)?.phase).toBe("abort-releasing");
    const materialPath = join(backendPublicationDirectory(home), "publication-1.material");
    expect(existsSync(materialPath)).toBe(true);

    const aborted = await coordinator(home, fake.driver).abort();
    expect(aborted.phase).toBe("aborted");
    expect(existsSync(materialPath)).toBe(false);
    expect(fake.getState()).toEqual(sourceState(input));
  });

  it("replays abort cleanup after material deletion before the aborted checkpoint", async () => {
    const { home, input, fake } = await preparedFixture();
    const materialPath = join(backendPublicationDirectory(home), "publication-1.material");
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalUnlink = nodeFs.unlinkSync as (path: string) => void;
    const crash = Object.assign(new Error("crash:after-material-delete"), { code: "EIO" });
    let injected = false;

    await expect(withPatchedFsAsync("unlinkSync", ((candidate: string) => {
      if (!injected && candidate === materialPath) {
        injected = true;
        originalUnlink(candidate);
        throw crash;
      }
      return originalUnlink(candidate);
    }) as never, async () => coordinator(home, fake.driver).abort()))
      .rejects.toThrow("crash:after-material-delete");
    expect(readBackendPublicationJournal(home)?.phase).toBe("abort-releasing");
    expect(existsSync(materialPath)).toBe(false);

    const aborted = await coordinator(home, fake.driver).abort();
    expect(aborted.phase).toBe("aborted");
    expect(existsSync(materialPath)).toBe(false);
    await expect(coordinator(home, fake.driver).recoverPending()).resolves.toEqual(aborted);
    expect(fake.getState()).toEqual(sourceState(input));
  });

  it("fails closed when abort material is missing or tampered before cleanup", async () => {
    const missing = await preparedFixture();
    const missingPath = join(backendPublicationDirectory(missing.home), "publication-1.material");
    rmSync(missingPath);
    await expect(coordinator(missing.home, missing.fake.driver).abort()).rejects.toThrow();
    expect(readBackendPublicationJournal(missing.home)?.phase).toBe("aborting");

    const tampered = await preparedFixture();
    const tamperedPath = join(backendPublicationDirectory(tampered.home), "publication-1.material");
    writeFileSync(tamperedPath, "tampered", { mode: 0o600 });
    await expect(coordinator(tampered.home, tampered.fake.driver).abort())
      .rejects.toMatchObject({ reason: "checksum-mismatch" });
  });

  it("resumes a parked active-fence abort-releasing journal to aborted", async () => {
    const { home, input, fake, getFence } = await releasingFixture();
    await expect(coordinator(home, fake.driver, (event) => {
      if (
        event === "before-release"
        && readBackendPublicationJournal(home)?.phase === "abort-releasing"
      ) throw new Error("crash:abort-before-release-resume");
    }).abort()).rejects.toThrow("crash:abort-before-release-resume");
    expect(readBackendPublicationJournal(home)?.phase).toBe("abort-releasing");
    expect(getFence()?.releasedAt).toBeNull();
    const materialPath = join(backendPublicationDirectory(home), "publication-1.material");
    expect(existsSync(materialPath)).toBe(true);

    const recovered = await coordinator(home, fake.driver).resume();
    expect(recovered.phase).toBe("aborted");
    expect(recovered.phase).not.toBe("completed");
    expect(getFence()?.releasedAt).not.toBeNull();
    expect(existsSync(materialPath)).toBe(false);
    expect(fake.getState()).toEqual(sourceState(input));
  });

  it("recovers a parked active-fence abort-releasing journal without a disposition", async () => {
    const { home, input, fake, getFence } = await releasingFixture();
    await expect(coordinator(home, fake.driver, (event) => {
      if (
        event === "before-release"
        && readBackendPublicationJournal(home)?.phase === "abort-releasing"
      ) throw new Error("crash:abort-before-release-default-recover");
    }).abort()).rejects.toThrow("crash:abort-before-release-default-recover");
    expect(readBackendPublicationJournal(home)?.phase).toBe("abort-releasing");
    expect(getFence()?.releasedAt).toBeNull();
    const materialPath = join(backendPublicationDirectory(home), "publication-1.material");
    expect(existsSync(materialPath)).toBe(true);

    const recovered = await coordinator(home, fake.driver).recoverPending();
    expect(recovered?.phase).toBe("aborted");
    expect(recovered?.phase).not.toBe("completed");
    expect(getFence()?.releasedAt).not.toBeNull();
    expect(existsSync(materialPath)).toBe(false);
    expect(fake.getState()).toEqual(sourceState(input));
  });

  it("does not emit target completion evidence after both publishes and restores", async () => {
    const { home, input, fake, getFence } = await releasingFixture();
    const retained = vi.fn(async () => undefined);
    fake.driver.retainCompletedMaterial = retained;
    await expect(coordinator(home, fake.driver, (event) => {
      if (
        event === "before-material-authenticate"
        && readBackendPublicationJournal(home)?.phase === "abort-releasing"
      ) throw new Error("crash:abort-post-publish");
    }).abort()).rejects.toThrow("crash:abort-post-publish");
    const parked = readBackendPublicationJournal(home);
    expect(parked?.phase).toBe("abort-releasing");
    expect(parked?.sourceState).toEqual(sourceState(input));
    expect(parked?.targetState).toEqual(targetState(input));
    expect(fake.getState()).toEqual(sourceState(input));

    const recovered = await coordinator(home, fake.driver).recoverPending();
    expect(recovered?.phase).toBe("aborted");
    expect(recovered?.phase).not.toBe("completed");
    expect(recovered?.sourceState).toEqual(sourceState(input));
    expect(recovered?.targetState).toEqual(targetState(input));
    expect(fake.getState()).toEqual(sourceState(input));
    expect(getFence()?.releasedAt).not.toBeNull();
    expect(existsSync(join(backendPublicationDirectory(home), "publication-1.material"))).toBe(false);
    expect(retained).not.toHaveBeenCalled();
    expect(() => assertBackendPublicationConsumerAccess({ homeDir: home, backend: "sqlite" })).not.toThrow();
    expect(() => assertBackendPublicationConsumerAccess({ homeDir: home, backend: "postgresql" }))
      .toThrow("stored backend does not match");
  });

  it("replays an exact terminal archive and rejects a symlinked history directory", async () => {
    const home = makeHome();
    const input = material();
    const first = makeDriver(input);
    await coordinator(home, first.driver).prepare(inputFor(input));
    const completed = await coordinator(home, first.driver).resume();
    const archivePath = join(
      backendPublicationDirectory(home),
      "history",
      completed.publicationId + "." + completed.checksumSha256 + ".json",
    );
    const second = makeDriver(input);
    await expect(coordinator(home, second.driver, (event) => {
      if (event === "before-journal-write") throw new Error("crash:before-replacement-replay");
    }).prepare({
      ...inputFor(input),
      publicationId: "publication-2",
    })).rejects.toThrow("crash:before-replacement-replay");
    expect(existsSync(archivePath)).toBe(true);
    expect(readBackendPublicationJournal(home)?.phase).toBe("completed");
    await expect(coordinator(home, second.driver).prepare({
      ...inputFor(input),
      publicationId: "publication-2",
    })).resolves.toMatchObject({ phase: "prepared" });

    const errorHome = makeHome();
    const errorInput = material();
    const errorFirst = makeDriver(errorInput);
    await coordinator(errorHome, errorFirst.driver).prepare(inputFor(errorInput));
    await coordinator(errorHome, errorFirst.driver).resume();
    const errorNodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalLink = errorNodeFs.linkSync as (from: string, to: string) => void;
    const archiveLinkFailure = new Error("archive link denied");
    await expect(withPatchedFsAsync("linkSync", (() => {
      throw archiveLinkFailure;
    }) as never, async () => coordinator(errorHome, makeDriver(errorInput).driver).prepare({
      ...inputFor(errorInput),
      publicationId: "publication-2",
    }))).rejects.toThrow(archiveLinkFailure);
    errorNodeFs.linkSync = originalLink;
    expect(readBackendPublicationJournal(errorHome)?.phase).toBe("completed");
    await expect(coordinator(errorHome, makeDriver(errorInput).driver).prepare({
      ...inputFor(errorInput),
      publicationId: "publication-2",
    })).resolves.toMatchObject({ phase: "prepared" });

    const symlinkHome = makeHome();
    const symlinkInput = material();
    const symlinkFirst = makeDriver(symlinkInput);
    await coordinator(symlinkHome, symlinkFirst.driver).prepare(inputFor(symlinkInput));
    await coordinator(symlinkHome, symlinkFirst.driver).resume();
    const history = join(backendPublicationDirectory(symlinkHome), "history");
    mkdirSync(history, { mode: 0o700 });
    rmSync(history, { recursive: true });
    const victim = join(symlinkHome, "history-victim");
    mkdirSync(victim, { mode: 0o755 });
    chmodSync(victim, 0o755);
    symlinkSync(victim, history, "dir");
    await expect(coordinator(symlinkHome, makeDriver(symlinkInput).driver).prepare({
      ...inputFor(symlinkInput),
      publicationId: "publication-2",
    })).rejects.toThrow();
    expect(statSync(victim).mode & 0o777).toBe(0o755);
  });

  it("refuses a rebound history directory after descriptor admission", async () => {
    const home = makeHome();
    const input = material();
    const first = makeDriver(input);
    await coordinator(home, first.driver).prepare(inputFor(input));
    const completed = await coordinator(home, first.driver).resume();
    const terminalBytes = readFileSync(backendPublicationJournalPath(home));
    const history = backendPublicationHistoryDirectory(home);
    const originalHistory = `${history}.retained`;
    mkdirSync(history, { mode: 0o700 });
    const archiveName = `${completed.publicationId}.${completed.checksumSha256}.json`;
    const next = countingDriver(input);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalStat = nodeFs.statSync as (...args: unknown[]) => unknown;
    let injected = false;

    await expect(withPatchedFsAsync("statSync", ((path: string, ...args: unknown[]) => {
      const observed = originalStat(path, ...args);
      if (!injected && path === history) {
        injected = true;
        renameSync(history, originalHistory);
        mkdirSync(history, { mode: 0o700 });
      }
      return observed;
    }) as never, async () => coordinator(home, next.driver).prepare({
      ...inputFor(input),
      publicationId: "publication-2",
    }))).rejects.toMatchObject({ reason: "unsafe-storage" });

    expect(injected).toBe(true);
    expect(readFileSync(backendPublicationJournalPath(home))).toEqual(terminalBytes);
    expect(existsSync(join(history, archiveName))).toBe(false);
    expect(existsSync(join(originalHistory, archiveName))).toBe(false);
    expect(next.calls).toEqual([]);
    expect(existsSync(join(backendPublicationDirectory(home), "publication-2.material"))).toBe(false);
  });

  it("rejects a same-UID history directory substituted immediately after creation", async () => {
    const home = makeHome();
    const fixture = await terminalArchiveFixture(home, 2);
    const history = backendPublicationHistoryDirectory(home);
    const attempt = countingDriver(material());
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalLstat = nodeFs.lstatSync as (...args: unknown[]) => unknown;
    let injected = false;

    // "history" is absent, so the coordinator takes the mkdirSync-then-open
    // creation branch. There is no public seam between mkdirSync returning
    // and the following openPrivateDirectory call, so this test injects the
    // closest reachable equivalent: a same-UID, same-mode real-directory
    // substitution observed at the very first lstat the new post-open entry
    // binding performs, which is the earliest point after open where a
    // substitution can possibly be detected.
    await expect(withPatchedFsAsync("lstatSync", ((path: string, ...args: unknown[]) => {
      if (!injected && path === history) {
        injected = true;
        rmSync(history, { recursive: true });
        mkdirSync(history, { mode: 0o700 });
      }
      return originalLstat(path, ...args);
    }) as never, async () => coordinator(home, attempt.driver).prepare({
      ...inputFor(material()),
      publicationId: "publication-2",
    }))).rejects.toMatchObject({
      reason: "unsafe-storage",
      // Pins the post-create binding specifically. Without it the substitution
      // is only caught later, by the archive write's own parent-entry check,
      // under a different message.
      message: "created backend publication history directory is unsafe",
    });

    expect(injected).toBe(true);
    expect(readFileSync(backendPublicationJournalPath(home))).toEqual(fixture.bytes);
    expect(existsSync(join(
      history,
      `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`,
    ))).toBe(false);
    expect(attempt.calls).toEqual([]);
  });

  it("rejects a history directory turned into a self-resolving symlink mid-archive", async () => {
    const home = makeHome();
    const fixture = await terminalArchiveFixture(home, 2);
    const history = backendPublicationHistoryDirectory(home);
    mkdirSync(history, { mode: 0o700 });
    const elsewhere = `${history}.elsewhere`;
    const attempt = countingDriver(material());
    let injected = false;

    // Renaming the retained directory to a new name and replacing "history"
    // with a symlink back to it leaves the retained descriptor's dev/ino
    // reachable again through realpath resolution, so the realpathSync-based
    // comparison in assertPrivateDirectory accepts it: that comparison only
    // checks resolved identity, not entry type. Before this change the
    // substitution was still refused, but later and by a different guard --
    // the retained-parent entry check inside the archive write. The added
    // assertPrivateDirectoryEntry lstat's the exact "history" component
    // without following symlinks and rejects it here instead, which is what
    // the asserted message pins.
    await expect(coordinator(home, attempt.driver, (event) => {
      if (!injected && event === "before-terminal-journal-archive-publication") {
        injected = true;
        renameSync(history, elsewhere);
        symlinkSync(elsewhere, history, "dir");
      }
    }).prepare({
      ...inputFor(material()),
      publicationId: "publication-2",
    })).rejects.toMatchObject({
      reason: "unsafe-storage",
      message: "backend publication history directory changed during terminal journal archive",
    });

    expect(injected).toBe(true);
    expect(readFileSync(backendPublicationJournalPath(home))).toEqual(fixture.bytes);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(attempt.calls).toEqual([]);
  });

  it("archives across a create-then-reuse history sequence on the ordinary happy path", async () => {
    const home = makeHome();
    const gen1 = await terminalArchiveFixture(home, 2);
    const history = backendPublicationHistoryDirectory(home);

    const gen2Driver = makeDriver(material());
    await coordinator(home, gen2Driver.driver).prepare({
      ...inputFor(material()),
      publicationId: "publication-2",
    });
    const gen2 = await coordinator(home, gen2Driver.driver).resume();

    const gen3Driver = makeDriver(material());
    const prepared3 = await coordinator(home, gen3Driver.driver).prepare({
      ...inputFor(material()),
      publicationId: "publication-3",
    });

    expect(prepared3).toMatchObject({ publicationId: "publication-3", phase: "prepared" });
    expect(statSync(history).mode & 0o777).toBe(0o700);
    expect(existsSync(join(
      history,
      `${gen1.journal.publicationId}.${gen1.journal.checksumSha256}.json`,
    ))).toBe(true);
    expect(existsSync(join(
      history,
      `${gen2.publicationId}.${gen2.checksumSha256}.json`,
    ))).toBe(true);
  });

  it.each([2, 3] as const)(
    "retains one history descriptor and syncs the v%s archive in fd order",
    async (version) => {
      const home = makeHome();
      const fixture = await terminalArchiveFixture(home, version);
      const attempt = countingDriver(material());
      const observed = await withTrackedArchiveDirectoryDescriptors(home, async (tracking) => {
        const prepared = await coordinator(home, attempt.driver, (event) => {
          if (event === "before-terminal-journal-history-sync") tracking.beginSyncOrder();
          if (event === "after-terminal-journal-history-operation") tracking.completeSyncOrder();
        }).prepare({
          ...inputFor(material()),
          publicationId: "publication-2",
        });
        const admitted = tracking.admitted();
        return {
          prepared,
          admitted,
          events: tracking.events,
          records: tracking.records,
        };
      });
      const history = backendPublicationHistoryDirectory(home);
      const archivePath = join(
        history,
        `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`,
      );
      const historyRecords = observed.records.filter((record) => record.path === history);

      expect(observed.prepared).toMatchObject({ publicationId: "publication-2", phase: "prepared" });
      expect(readFileSync(archivePath)).toEqual(fixture.bytes);
      expect(statSync(history).mode & 0o777).toBe(0o700);
      expect(statSync(archivePath).mode & 0o777).toBe(0o600);
      expect(attempt.calls).toEqual(["observe-local-state"]);
      expect(historyRecords).toHaveLength(1);
      expect(historyRecords[0]?.closed).toBe(1);
      const expectedEvents = [
        expectedArchiveDirectoryEvent("assert", observed.admitted.history),
        expectedArchiveDirectoryEvent("assert", observed.admitted.history),
        expectedArchiveDirectoryEvent("fsync", observed.admitted.history),
        expectedArchiveDirectoryEvent("assert", observed.admitted.history),
        expectedArchiveDirectoryEvent("assert", observed.admitted.history),
        expectedArchiveDirectoryEvent("assert", observed.admitted.outer),
        expectedArchiveDirectoryEvent("fsync", observed.admitted.outer),
        expectedArchiveDirectoryEvent("assert", observed.admitted.outer),
        expectedArchiveDirectoryEvent("close", observed.admitted.history),
      ];
      assertExactArchiveDirectoryEvents(observed.events, expectedEvents);
    },
  );

  it("captures and rejects a real post-close retained-outer fsync", async () => {
    const home = makeHome();
    await terminalArchiveFixture(home, 2);
    const attempt = countingDriver(material());
    let injected = false;
    const observed = await withTrackedArchiveDirectoryDescriptors(home, async (tracking) => {
      const prepared = await coordinator(home, attempt.driver, (event) => {
        if (event === "before-terminal-journal-history-sync") tracking.beginSyncOrder();
        if (event === "after-terminal-journal-history-operation") {
          fsyncSync(tracking.admitted().outer.fd);
          injected = true;
          tracking.completeSyncOrder();
        }
      }).prepare({
        ...inputFor(material()),
        publicationId: "publication-2",
      });
      return {
        prepared,
        admitted: tracking.admitted(),
        events: tracking.events,
        records: tracking.records,
      };
    });
    const expectedEvents = [
      expectedArchiveDirectoryEvent("assert", observed.admitted.history),
      expectedArchiveDirectoryEvent("assert", observed.admitted.history),
      expectedArchiveDirectoryEvent("fsync", observed.admitted.history),
      expectedArchiveDirectoryEvent("assert", observed.admitted.history),
      expectedArchiveDirectoryEvent("assert", observed.admitted.history),
      expectedArchiveDirectoryEvent("assert", observed.admitted.outer),
      expectedArchiveDirectoryEvent("fsync", observed.admitted.outer),
      expectedArchiveDirectoryEvent("assert", observed.admitted.outer),
      expectedArchiveDirectoryEvent("close", observed.admitted.history),
    ];

    expect(injected).toBe(true);
    expect(observed.prepared).toMatchObject({ phase: "prepared" });
    assertExactArchiveDirectoryEvents(observed.events, [
      ...expectedEvents,
      expectedArchiveDirectoryEvent("fsync", observed.admitted.outer),
    ]);
    expect(() => assertExactArchiveDirectoryEvents(observed.events, expectedEvents)).toThrow();
    expect(observed.records.filter(
      (record) => record.path === backendPublicationHistoryDirectory(home),
    )[0]?.closed).toBe(1);
  });

  it("treats post-open ENOENT as unsafe instead of recreating history", async () => {
    const home = makeHome();
    const fixture = await terminalArchiveFixture(home, 2);
    const history = backendPublicationHistoryDirectory(home);
    mkdirSync(history, { mode: 0o700 });
    const historyIdentity = statSync(history);
    const attempt = countingDriver(material());
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalStat = nodeFs.statSync as (...args: unknown[]) => unknown;
    let injected = false;

    await expect(withPatchedFsAsync("statSync", ((path: string, ...args: unknown[]) => {
      if (!injected && path === history) {
        injected = true;
        throw Object.assign(new Error("history vanished after open"), { code: "ENOENT" });
      }
      return originalStat(path, ...args);
    }) as never, async () => coordinator(home, attempt.driver).prepare({
      ...inputFor(material()),
      publicationId: "publication-2",
    }))).rejects.toMatchObject({ reason: "unsafe-storage" });

    expect(injected).toBe(true);
    expect(statSync(history).dev).toBe(historyIdentity.dev);
    expect(statSync(history).ino).toBe(historyIdentity.ino);
    expect(existsSync(join(
      history,
      `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`,
    ))).toBe(false);
    expect(attempt.calls).toEqual([]);
  });

  it("refuses a history create race without adopting the entrant", async () => {
    const home = makeHome();
    const fixture = await terminalArchiveFixture(home, 2);
    const history = backendPublicationHistoryDirectory(home);
    const attempt = countingDriver(material());
    let injected = false;

    await expect(coordinator(home, attempt.driver, (event) => {
      if (!injected && event === "before-terminal-journal-history-create") {
        injected = true;
        mkdirSync(history, { mode: 0o700 });
      }
    }).prepare({
      ...inputFor(material()),
      publicationId: "publication-2",
    })).rejects.toMatchObject({ reason: "unsafe-storage" });

    expect(injected).toBe(true);
    expect(statSync(history).mode & 0o777).toBe(0o700);
    expect(existsSync(join(
      history,
      `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`,
    ))).toBe(false);
    expect(attempt.calls).toEqual([]);
  });

  it.each(["file", "symlink", "non-private-directory"] as const)(
    "refuses an unsafe existing history %s without repairing it",
    async (kind) => {
      const home = makeHome();
      await terminalArchiveFixture(home, 2);
      const history = backendPublicationHistoryDirectory(home);
      if (kind === "file") writeFileSync(history, "unsafe", { mode: 0o600 });
      if (kind === "non-private-directory") mkdirSync(history, { mode: 0o755 });
      if (kind === "symlink") {
        const victim = join(home, "history-victim");
        mkdirSync(victim, { mode: 0o700 });
        symlinkSync(victim, history, "dir");
      }
      const attempt = countingDriver(material());

      await expect(coordinator(home, attempt.driver).prepare({
        ...inputFor(material()),
        publicationId: "publication-2",
      })).rejects.toMatchObject({ reason: "unsafe-storage" });

      expect(existsSync(history)).toBe(true);
      if (kind === "file") expect(readFileSync(history, "utf8")).toBe("unsafe");
      if (kind === "non-private-directory") expect(statSync(history).mode & 0o777).toBe(0o755);
      expect(attempt.calls).toEqual([]);
    },
  );

  it("refuses outer publication-directory drift during history admission", async () => {
    const home = makeHome();
    const fixture = await terminalArchiveFixture(home, 2);
    const attempt = countingDriver(material());
    let originalDirectory: string | undefined;

    await expect(coordinator(home, attempt.driver, (event) => {
      if (originalDirectory === undefined && event === "before-terminal-journal-history-open") {
        originalDirectory = rebindPublicationDirectoryWithEvidence(home).originalDirectory;
      }
    }).prepare({
      ...inputFor(material()),
      publicationId: "publication-2",
    })).rejects.toMatchObject({ reason: "unsafe-storage" });

    expect(originalDirectory).toBeDefined();
    expect(readFileSync(backendPublicationJournalPath(home))).toEqual(fixture.bytes);
    expect(existsSync(join(originalDirectory!, "history"))).toBe(false);
    expect(existsSync(backendPublicationHistoryDirectory(home))).toBe(false);
    expect(attempt.calls).toEqual([]);
  });

  it.each(["publication", "replay", "sync"] as const)(
    "refuses history replacement before archive %s",
    async (stage) => {
      const home = makeHome();
      const fixture = await terminalArchiveFixture(home, 2);
      const history = backendPublicationHistoryDirectory(home);
      const archiveName = `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`;
      if (stage === "publication") mkdirSync(history, { mode: 0o700 });
      if (stage === "replay") {
        const setup = countingDriver(material());
        await expect(coordinator(home, setup.driver, (event) => {
          if (event === "before-journal-write") throw new Error("stop after archive publication");
        }).prepare({
          ...inputFor(material()),
          publicationId: "publication-2",
        })).rejects.toThrow("stop after archive publication");
        expect(readFileSync(join(history, archiveName))).toEqual(fixture.bytes);
      }
      const originalHistory = `${history}.${stage}-retained`;
      const attempt = countingDriver(material());
      const boundary = stage === "publication"
        ? "before-terminal-journal-archive-publication"
        : stage === "replay"
          ? "before-terminal-journal-archive-replay"
          : "before-terminal-journal-history-sync";
      let injected = false;

      await expect(coordinator(home, attempt.driver, (event) => {
        if (!injected && event === boundary) {
          injected = true;
          renameSync(history, originalHistory);
          mkdirSync(history, { mode: 0o700 });
        }
      }).prepare({
        ...inputFor(material()),
        publicationId: "publication-2",
      })).rejects.toMatchObject({ reason: "unsafe-storage" });

      expect(injected).toBe(true);
      expect(readFileSync(backendPublicationJournalPath(home))).toEqual(fixture.bytes);
      expect(existsSync(join(history, archiveName))).toBe(false);
      expect(existsSync(join(originalHistory, archiveName))).toBe(stage === "publication" ? false : true);
      expect(attempt.calls).toEqual([]);
      expect(existsSync(join(backendPublicationDirectory(home), "publication-2.material"))).toBe(false);
    },
  );

  it.each(["different-bytes", "wrong-mode", "multiple-links", "oversize"] as const)(
    "refuses archive replay with %s",
    async (kind) => {
      const home = makeHome();
      const fixture = await terminalArchiveFixture(home, 2);
      const history = backendPublicationHistoryDirectory(home);
      mkdirSync(history, { mode: 0o700 });
      const archivePath = join(
        history,
        `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`,
      );
      const content = kind === "different-bytes"
        ? Buffer.from("different archive bytes\n")
        : kind === "oversize"
          ? Buffer.alloc((1024 * 1024) + 1, "x")
          : fixture.bytes;
      writeFileSync(archivePath, content, { mode: 0o600 });
      if (kind === "wrong-mode") chmodSync(archivePath, 0o640);
      if (kind === "multiple-links") linkSync(archivePath, join(history, "archive-alias"));
      const attempt = countingDriver(material());

      await expect(coordinator(home, attempt.driver).prepare({
        ...inputFor(material()),
        publicationId: "publication-2",
      })).rejects.toMatchObject({ reason: "unsafe-storage" });

      expect(readFileSync(backendPublicationJournalPath(home))).toEqual(fixture.bytes);
      expect(attempt.calls).toEqual([]);
      expect(existsSync(join(backendPublicationDirectory(home), "publication-2.material"))).toBe(false);
    },
  );

  it.each([2, 3] as const)(
    "replays an exact v%s archive through one retained history descriptor",
    async (version) => {
      const home = makeHome();
      const fixture = await terminalArchiveFixture(home, version);
      const initial = countingDriver(material());
      await expect(coordinator(home, initial.driver, (event) => {
        if (event === "before-journal-write") throw new Error("stop after exact archive");
      }).prepare({
        ...inputFor(material()),
        publicationId: "publication-2",
      })).rejects.toThrow("stop after exact archive");
      const history = backendPublicationHistoryDirectory(home);
      const archivePath = join(
        history,
        `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`,
      );
      const retry = countingDriver(material());
      const observed = await withTrackedArchiveDirectoryDescriptors(home, async (tracking) => {
        const prepared = await coordinator(home, retry.driver).prepare({
          ...inputFor(material()),
          publicationId: "publication-2",
        });
        return { prepared, records: tracking.records };
      });
      const historyRecords = observed.records.filter((record) => record.path === history);

      expect(observed.prepared).toMatchObject({ phase: "prepared" });
      expect(readFileSync(archivePath)).toEqual(fixture.bytes);
      expect(historyRecords).toHaveLength(1);
      expect(historyRecords[0]?.closed).toBe(1);
      expect(retry.calls).toEqual(["observe-local-state"]);
    },
  );

  it("refuses an exact replay reported from a different parent identity", async () => {
    const home = makeHome();
    const fixture = await terminalArchiveFixture(home, 2);
    const history = backendPublicationHistoryDirectory(home);
    mkdirSync(history, { mode: 0o700 });
    const archivePath = join(
      history,
      `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`,
    );
    writeFileSync(archivePath, fixture.bytes, { mode: 0o600 });
    const attempt = countingDriver(material());
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    const originalStat = nodeFs.statSync as (...args: unknown[]) => unknown;
    let archiveFd: number | undefined;

    await expect(withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
      const fd = originalOpen(path, ...args);
      if (path === archivePath) archiveFd = fd;
      return fd;
    }) as never, async () => withPatchedFsAsync("statSync", ((path: string, ...args: unknown[]) => {
      const observed = originalStat(path, ...args) as Record<PropertyKey, unknown>;
      if (archiveFd === undefined || path !== history || !((args[0] as { bigint?: boolean } | undefined)?.bigint)) {
        return observed;
      }
      return new Proxy(observed, {
        get(target, property, receiver) {
          if (property === "dev") return BigInt(Reflect.get(target, property, receiver) as bigint) + 1n;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as never, async () => coordinator(home, attempt.driver).prepare({
      ...inputFor(material()),
      publicationId: "publication-2",
    })))).rejects.toMatchObject({
      reason: "unsafe-storage",
      message: "backend publication archive replay does not match the retained history directory",
    });

    expect(readFileSync(backendPublicationJournalPath(home))).toEqual(fixture.bytes);
    expect(attempt.calls).toEqual([]);
  });

  it("refuses archive replay whose descriptor owner is not trusted", async () => {
    const home = makeHome();
    const fixture = await terminalArchiveFixture(home, 2);
    const history = backendPublicationHistoryDirectory(home);
    mkdirSync(history, { mode: 0o700 });
    const archivePath = join(
      history,
      `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`,
    );
    writeFileSync(archivePath, fixture.bytes, { mode: 0o600 });
    const attempt = countingDriver(material());
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    const originalFstat = nodeFs.fstatSync as (...args: unknown[]) => unknown;
    let archiveFd: number | undefined;

    await expect(withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
      const fd = originalOpen(path, ...args);
      if (path === archivePath) archiveFd = fd;
      return fd;
    }) as never, async () => withPatchedFsAsync("fstatSync", ((fd: number, ...args: unknown[]) => {
      const observed = originalFstat(fd, ...args) as Record<PropertyKey, unknown>;
      if (fd !== archiveFd) return observed;
      return new Proxy(observed, {
        get(target, property, receiver) {
          if (property === "uid") return Number(Reflect.get(target, property, receiver)) + 1;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as never, async () => coordinator(home, attempt.driver).prepare({
      ...inputFor(material()),
      publicationId: "publication-2",
    })))).rejects.toMatchObject({ reason: "unsafe-storage" });

    expect(readFileSync(backendPublicationJournalPath(home))).toEqual(fixture.bytes);
    expect(attempt.calls).toEqual([]);
  });

  it.each(["history", "outer"] as const)(
    "preserves an exact archive for retry when %s fsync fails",
    async (target) => {
      const home = makeHome();
      const fixture = await terminalArchiveFixture(home, 2);
      const history = backendPublicationHistoryDirectory(home);
      const archivePath = join(
        history,
        `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`,
      );
      const attempt = countingDriver(material());
      const failure = new Error(`${target} fsync failed`);
      let records: ArchiveDirectoryDescriptor[] = [];

      await expect(withTrackedArchiveDirectoryDescriptors(home, async (tracking) => {
        records = tracking.records;
        tracking.failNextSync(
          target === "history" ? history : backendPublicationDirectory(home),
          failure,
        );
        return coordinator(home, attempt.driver).prepare({
          ...inputFor(material()),
          publicationId: "publication-2",
        });
      })).rejects.toBe(failure);

      expect(readFileSync(backendPublicationJournalPath(home))).toEqual(fixture.bytes);
      expect(readFileSync(archivePath)).toEqual(fixture.bytes);
      expect(readdirSync(history)).toEqual([archivePath.split("/").at(-1)]);
      expect(records.filter((record) => record.path === history)).toHaveLength(1);
      expect(records.find((record) => record.path === history)?.closed).toBe(1);
      expect(attempt.calls).toEqual([]);
      expect(existsSync(join(backendPublicationDirectory(home), "publication-2.material"))).toBe(false);

      const retry = countingDriver(material());
      await expect(coordinator(home, retry.driver).prepare({
        ...inputFor(material()),
        publicationId: "publication-2",
      })).resolves.toMatchObject({ phase: "prepared" });
      expect(readFileSync(archivePath)).toEqual(fixture.bytes);
      expect(retry.calls).toEqual(["observe-local-state"]);
    },
  );

  it("fails on history cleanup alone, closes once, and replays the complete archive", async () => {
    const home = makeHome();
    const fixture = await terminalArchiveFixture(home, 2);
    const history = backendPublicationHistoryDirectory(home);
    const archivePath = join(
      history,
      `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`,
    );
    const attempt = countingDriver(material());
    const cleanupFailure = new Error("history close failed");
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    const originalClose = nodeFs.closeSync as (fd: number) => void;
    let historyFd: number | undefined;
    let historyCloseCalls = 0;

    await expect(withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
      const fd = originalOpen(path, ...args);
      if (path === history) historyFd = fd;
      return fd;
    }) as never, async () => withPatchedFsAsync("closeSync", ((fd: number) => {
      originalClose(fd);
      if (fd === historyFd) {
        historyCloseCalls += 1;
        throw cleanupFailure;
      }
    }) as never, async () => coordinator(home, attempt.driver).prepare({
      ...inputFor(material()),
      publicationId: "publication-2",
    })))).rejects.toBe(cleanupFailure);

    expect(historyCloseCalls).toBe(1);
    expect(readFileSync(archivePath)).toEqual(fixture.bytes);
    expect(readFileSync(backendPublicationJournalPath(home))).toEqual(fixture.bytes);
    expect(attempt.calls).toEqual([]);
    await expect(coordinator(home, countingDriver(material()).driver).prepare({
      ...inputFor(material()),
      publicationId: "publication-2",
    })).resolves.toMatchObject({ phase: "prepared" });
  });

  it("preserves a structured primary archive refusal when history cleanup also fails", async () => {
    const home = makeHome();
    const fixture = await terminalArchiveFixture(home, 2);
    const history = backendPublicationHistoryDirectory(home);
    mkdirSync(history, { mode: 0o700 });
    const retainedHistory = `${history}.primary-retained`;
    const attempt = countingDriver(material());
    const cleanupFailure = new Error("history close failed after refusal");
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    const originalClose = nodeFs.closeSync as (fd: number) => void;
    let historyFd: number | undefined;
    let historyCloseCalls = 0;
    let caught: unknown;

    try {
      await withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
        const fd = originalOpen(path, ...args);
        if (path === history) historyFd = fd;
        return fd;
      }) as never, async () => withPatchedFsAsync("closeSync", ((fd: number) => {
        originalClose(fd);
        if (fd === historyFd) {
          historyCloseCalls += 1;
          throw cleanupFailure;
        }
      }) as never, async () => coordinator(home, attempt.driver, (event) => {
        if (event === "before-terminal-journal-archive-publication") {
          renameSync(history, retainedHistory);
          mkdirSync(history, { mode: 0o700 });
        }
      }).prepare({
        ...inputFor(material()),
        publicationId: "publication-2",
      })));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackendPublicationJournalError);
    expect(caught).toMatchObject({
      reason: "unsafe-storage",
      message: "backend publication history directory changed during terminal journal archive",
      cause: expect.any(AggregateError),
    });
    const aggregate = (caught as BackendPublicationJournalError).cause as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toMatchObject({
      reason: "unsafe-storage",
      message: "backend publication history directory changed during terminal journal archive",
    });
    expect(aggregate.errors[1]).toBe(cleanupFailure);
    expect(historyCloseCalls).toBe(1);
    expect(readFileSync(backendPublicationJournalPath(home))).toEqual(fixture.bytes);
    expect(attempt.calls).toEqual([]);
  });

  /**
   * Report a drifted gid for one retained directory descriptor, leaving every
   * other field untouched. A live descriptor's dev and ino cannot change, and
   * its uid and mode are already refused inside assertPrivateDirectory, so a
   * gid change is the one way the retained witness and the descriptor's
   * current identity observably diverge.
   *
   * The drift follows the most recent open of trackedPath, which is the
   * descriptor the archive retains at the point each test arms it. A future
   * reopen after the arming event would drift the wrong descriptor, and the
   * guard would then see no drift and the test would fail loudly rather than
   * pass for the wrong reason.
   */
  async function withRetainedDirectoryGidDrift<T>(
    trackedPath: string,
    drifting: () => boolean,
    callback: () => Promise<T>,
  ): Promise<T> {
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    const originalFstat = nodeFs.fstatSync as (...args: unknown[]) => unknown;
    let trackedFd: number | undefined;

    return withPatchedFsAsync("openSync", ((path: unknown, ...args: unknown[]) => {
      const fd = originalOpen(path, ...args);
      if (path === trackedPath) trackedFd = fd;
      return fd;
    }) as never, async () => withPatchedFsAsync("fstatSync", ((fd: number, ...args: unknown[]) => {
      const stat = originalFstat(fd, ...args) as { gid: unknown };
      if (fd !== trackedFd || !drifting() || typeof stat.gid !== "bigint") return stat;
      return Object.create(stat as object, {
        gid: { value: stat.gid + 1n, enumerable: true },
      }) as unknown;
    }) as never, callback));
  }

  it("refuses a retained publication directory whose gid drifted mid-archive", async () => {
    const home = makeHome();
    const fixture = await terminalArchiveFixture(home, 2);
    const directory = backendPublicationDirectory(home);
    const history = backendPublicationHistoryDirectory(home);
    mkdirSync(history, { mode: 0o700 });
    const archivePath = join(
      history,
      `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`,
    );
    const attempt = countingDriver(material());
    let drifting = false;

    await expect(withRetainedDirectoryGidDrift(
      directory,
      () => drifting,
      async () => coordinator(home, attempt.driver, (event) => {
        if (event === "before-terminal-journal-history-open") drifting = true;
      }).prepare({
        ...inputFor(material()),
        publicationId: "publication-2",
      }),
    )).rejects.toMatchObject({
      reason: "unsafe-storage",
      message: "backend publication directory changed during terminal journal archive",
      cause: expect.objectContaining({ message: "private directory identity changed" }),
    });

    expect(drifting).toBe(true);
    expect(existsSync(archivePath)).toBe(false);
    expect(readFileSync(backendPublicationJournalPath(home))).toEqual(fixture.bytes);
    expect(attempt.calls).toEqual([]);
  });

  it("refuses a retained history directory whose gid drifted mid-archive", async () => {
    const home = makeHome();
    const fixture = await terminalArchiveFixture(home, 2);
    const history = backendPublicationHistoryDirectory(home);
    mkdirSync(history, { mode: 0o700 });
    const archivePath = join(
      history,
      `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`,
    );
    const attempt = countingDriver(material());
    let drifting = false;

    await expect(withRetainedDirectoryGidDrift(
      history,
      () => drifting,
      async () => coordinator(home, attempt.driver, (event) => {
        if (event === "before-terminal-journal-archive-publication") drifting = true;
      }).prepare({
        ...inputFor(material()),
        publicationId: "publication-2",
      }),
    )).rejects.toMatchObject({
      reason: "unsafe-storage",
      message: "backend publication history directory changed during terminal journal archive",
      cause: expect.objectContaining({ message: "private directory identity changed" }),
    });

    expect(drifting).toBe(true);
    expect(existsSync(archivePath)).toBe(false);
    expect(readFileSync(backendPublicationJournalPath(home))).toEqual(fixture.bytes);
    expect(attempt.calls).toEqual([]);
  });

  it("aggregates an unstructured archive failure with a history close failure", async () => {
    const home = makeHome();
    const fixture = await terminalArchiveFixture(home, 2);
    const history = backendPublicationHistoryDirectory(home);
    mkdirSync(history, { mode: 0o700 });
    const archivePath = join(
      history,
      `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`,
    );
    const attempt = countingDriver(material());
    const syncFailure = new Error("history fsync failed");
    const cleanupFailure = new Error("history close failed after fsync");
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    const originalFsync = nodeFs.fsyncSync as (fd: number) => void;
    const originalClose = nodeFs.closeSync as (fd: number) => void;
    let historyFd: number | undefined;
    let historyCloseCalls = 0;
    let caught: unknown;

    try {
      await withPatchedFsAsync("openSync", ((path: unknown, ...args: unknown[]) => {
        const fd = originalOpen(path, ...args);
        if (path === history) historyFd = fd;
        return fd;
      }) as never, async () => withPatchedFsAsync("fsyncSync", ((fd: number) => {
        if (fd === historyFd) throw syncFailure;
        originalFsync(fd);
      }) as never, async () => withPatchedFsAsync("closeSync", ((fd: number) => {
        originalClose(fd);
        if (fd === historyFd) {
          historyCloseCalls += 1;
          throw cleanupFailure;
        }
      }) as never, async () => coordinator(home, attempt.driver).prepare({
        ...inputFor(material()),
        publicationId: "publication-2",
      }))));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught).not.toBeInstanceOf(BackendPublicationJournalError);
    expect((caught as AggregateError).message).toBe(
      "backend publication archive operation and history cleanup failed",
    );
    expect((caught as AggregateError).errors).toHaveLength(2);
    expect((caught as AggregateError).errors[0]).toBe(syncFailure);
    expect((caught as AggregateError).errors[1]).toBe(cleanupFailure);
    expect((caught as AggregateError).cause).toBe(syncFailure);
    expect(historyCloseCalls).toBe(1);
    expect(readFileSync(archivePath)).toEqual(fixture.bytes);
    expect(readFileSync(backendPublicationJournalPath(home))).toEqual(fixture.bytes);
    expect(attempt.calls).toEqual([]);
  });

  it("refuses a created history directory widened before it is opened", async () => {
    const home = makeHome();
    const fixture = await terminalArchiveFixture(home, 2);
    const history = backendPublicationHistoryDirectory(home);
    const archivePath = join(
      history,
      `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`,
    );
    const attempt = countingDriver(material());
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalMkdir = nodeFs.mkdirSync as (...args: unknown[]) => unknown;
    let widened = false;

    // mkdir(2) returns no descriptor, so the archive has to open the
    // directory it just created as a separate step. This drives the exact
    // window that gap leaves open: another actor with write access to the
    // parent widens the new directory before the open lands. The open must
    // refuse the widened directory instead of retaining a descriptor to it,
    // and must leave the directory exactly as it found it.
    await expect(withPatchedFsAsync("mkdirSync", ((path: unknown, ...args: unknown[]) => {
      const created = originalMkdir(path, ...args);
      if (path === history) {
        widened = true;
        chmodSync(history, 0o755);
      }
      return created;
    }) as never, async () => coordinator(home, attempt.driver).prepare({
      ...inputFor(material()),
      publicationId: "publication-2",
    }))).rejects.toMatchObject({
      reason: "unsafe-storage",
      message: "created backend publication history directory is unsafe",
    });

    expect(widened).toBe(true);
    expect(statSync(history).mode & 0o777).toBe(0o755);
    expect(readdirSync(history)).toEqual([]);
    expect(existsSync(archivePath)).toBe(false);
    expect(readFileSync(backendPublicationJournalPath(home))).toEqual(fixture.bytes);
    expect(attempt.calls).toEqual([]);
  });

  it("cleans its known unpublished archive temp after exclusive link failure", async () => {
    const home = makeHome();
    const fixture = await terminalArchiveFixture(home, 2);
    const history = backendPublicationHistoryDirectory(home);
    const archivePath = join(
      history,
      `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`,
    );
    const attempt = countingDriver(material());
    const linkFailure = new Error("archive link failed before publication");
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalLink = nodeFs.linkSync as (...args: unknown[]) => void;

    await expect(withPatchedFsAsync("linkSync", ((source: string, destination: string, ...args: unknown[]) => {
      if (destination === archivePath) throw linkFailure;
      return originalLink(source, destination, ...args);
    }) as never, async () => coordinator(home, attempt.driver).prepare({
      ...inputFor(material()),
      publicationId: "publication-2",
    }))).rejects.toBe(linkFailure);

    expect(readdirSync(history)).toEqual([]);
    expect(readFileSync(backendPublicationJournalPath(home))).toEqual(fixture.bytes);
    expect(attempt.calls).toEqual([]);
    expect(existsSync(join(backendPublicationDirectory(home), "publication-2.material"))).toBe(false);
  });

  it("refuses archive replay when collision temp cleanup is incomplete", async () => {
    const home = makeHome();
    const fixture = await terminalArchiveFixture(home, 2);
    const history = backendPublicationHistoryDirectory(home);
    const archiveName = `${fixture.journal.publicationId}.${fixture.journal.checksumSha256}.json`;
    const archivePath = join(history, archiveName);
    const setup = countingDriver(material());
    await expect(coordinator(home, setup.driver, (event) => {
      if (event === "before-journal-write") throw new Error("stop after archive publication");
    }).prepare({
      ...inputFor(material()),
      publicationId: "publication-2",
    })).rejects.toThrow("stop after archive publication");
    expect(readFileSync(archivePath)).toEqual(fixture.bytes);

    const cleanupFailure = Object.assign(new Error("archive temp cleanup denied"), { code: "EACCES" });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalRemove = nodeFs.rmSync as (...args: unknown[]) => void;
    const attempt = countingDriver(material());
    const events: string[] = [];
    let cleanupAttempts = 0;
    await expect(withPatchedFsAsync("rmSync", ((path: string, ...args: unknown[]) => {
      if (path.startsWith(join(history, `.${archiveName}.`)) && path.endsWith(".tmp")) {
        cleanupAttempts += 1;
        throw cleanupFailure;
      }
      return originalRemove(path, ...args);
    }) as never, async () => coordinator(home, attempt.driver, (event) => {
      events.push(event);
    }).prepare({
      ...inputFor(material()),
      publicationId: "publication-2",
    }))).rejects.toMatchObject({
      reason: "unsafe-storage",
      message: "backend publication archive publication topology is unsafe",
      cause: expect.any(PrivateDirectoryTopologyError),
    });

    expect(cleanupAttempts).toBe(1);
    expect(readFileSync(backendPublicationJournalPath(home))).toEqual(fixture.bytes);
    expect(readFileSync(archivePath)).toEqual(fixture.bytes);
    expect(readdirSync(history).filter(name => name.startsWith(`.${archiveName}.`))).toHaveLength(1);
    expect(events).not.toContain("before-terminal-journal-archive-replay");
    expect(events).not.toContain("after-terminal-journal-archive-publication");
    expect(events).not.toContain("before-terminal-journal-history-sync");
    expect(attempt.calls).toEqual([]);
    expect(existsSync(join(backendPublicationDirectory(home), "publication-2.material"))).toBe(false);
  });

  it("covers archive replay with missing uid evidence and rejects an unsafe archive path", async () => {
    const home = makeHome();
    const input = material();
    const first = makeDriver(input);
    await coordinator(home, first.driver).prepare(inputFor(input));
    await coordinator(home, first.driver).resume();
    const second = makeDriver(input);
    await expect(coordinator(home, second.driver, (event) => {
      if (event === "before-journal-write") throw new Error("crash:archive-replay");
    }).prepare({
      ...inputFor(input),
      publicationId: "publication-2",
    })).rejects.toThrow("crash:archive-replay");

    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      await expect(coordinator(home, second.driver).prepare({
        ...inputFor(input),
        publicationId: "publication-2",
      })).resolves.toMatchObject({ phase: "prepared" });
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }

    const unsafeHome = makeHome();
    const unsafeInput = material();
    const unsafeFirst = makeDriver(unsafeInput);
    await coordinator(unsafeHome, unsafeFirst.driver).prepare(inputFor(unsafeInput));
    const unsafeCompleted = await coordinator(unsafeHome, unsafeFirst.driver).resume();
    const unsafeHistory = join(backendPublicationDirectory(unsafeHome), "history");
    mkdirSync(unsafeHistory, { mode: 0o700 });
    mkdirSync(join(
      unsafeHistory,
      unsafeCompleted.publicationId + "." + unsafeCompleted.checksumSha256 + ".json",
    ));
    await expect(coordinator(unsafeHome, makeDriver(unsafeInput).driver).prepare({
      ...inputFor(unsafeInput),
      publicationId: "publication-2",
    })).rejects.toMatchObject({ reason: "unsafe-storage" });
  });

  it("requires exact identities for persisted state and does not match unresolved targets", async () => {
    const input = material();
    const exactSource: BackendPublicationStateWitness = {
      config: { ...sourceState(input).config, dev: "9007199254740993", ino: "9007199254740995", parentDev: "7", parentIno: "11" },
      projectMap: { ...sourceState(input).projectMap, dev: "9007199254740993", ino: "9007199254740997", parentDev: "7", parentIno: "11" },
    };
    const malformedHome = makeHome();
    const malformed = makeDriver(input);
    malformed.driver.observeLocalState = vi.fn(async () => exactSource);
    await coordinator(malformedHome, malformed.driver).prepare(inputFor(input));
    rewriteJournal(malformedHome, (journal) => ({
      ...journal,
      sourceState: {
        ...(journal.sourceState as Record<string, unknown>),
        config: { ...((journal.sourceState as Record<string, unknown>).config as Record<string, unknown>), dev: null },
      },
    }));
    expect(() => readBackendPublicationJournal(malformedHome)).toThrow("present witness is malformed");

    const matchingHome = makeHome();
    const matching = makeDriver(input);
    matching.driver.observeLocalState = vi.fn(async () => exactSource);
    await coordinator(matchingHome, matching.driver).prepare(inputFor(input));
    matching.driver.observeLocalState = vi.fn(async () => ({
      config: { ...targetState(input).config, dev: "9007199254740993", ino: "9007199254740995", parentDev: "7", parentIno: "11" },
      projectMap: { ...targetState(input).projectMap, dev: "9007199254740993", ino: "9007199254740997", parentDev: "7", parentIno: "11" },
    }));
    await expect(coordinator(matchingHome, matching.driver).resume()).rejects.toMatchObject({ reason: "unexpected-state" });
  });

  it("admits lock-free SQLite config reads without publication evidence", () => {
    const home = makeHome();
    const configPath = join(home, ".lcm", "config.json");
    writeFileSync(configPath, "{}", { mode: 0o600 });
    const witness = configReadWitness(configPath);

    expect(() => assertBackendPublicationConfigReadAccess(configPath, "sqlite", witness)).not.toThrow();
    expect(() => assertBackendPublicationConfigReadAccess(configPath, "postgresql", witness))
      .toThrowError(expect.objectContaining({ reason: "publication-evidence-missing" }));

    const unscopedPath = join(home, "config.json");
    writeFileSync(unscopedPath, "{}", { mode: 0o600 });
    expect(() => assertBackendPublicationConfigReadAccess(
      unscopedPath,
      "sqlite",
      configReadWitness(unscopedPath),
    )).not.toThrow();
  });

  it("rejects lock-free reads when the publication directory exists without a journal", () => {
    const home = makeHome();
    const configPath = join(home, ".lcm", "config.json");
    writeFileSync(configPath, "{}", { mode: 0o600 });
    mkdirSync(backendPublicationDirectory(home), { mode: 0o700 });

    expect(() => assertBackendPublicationConfigReadAccess(
      configPath,
      "sqlite",
      configReadWitness(configPath),
    )).toThrowError(expect.objectContaining({ reason: "publication-evidence-missing" }));
  });

  it("rejects SQLite admission when publication directory authentication is interrupted", async () => {
    const home = makeHome();
    const configPath = join(home, ".lcm", "config.json");
    const publicationDirectory = backendPublicationDirectory(home);
    writeFileSync(configPath, "{}", { mode: 0o600 });
    mkdirSync(publicationDirectory, { mode: 0o700 });
    const witness = configReadWitness(configPath);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalRealpath = nodeFs.realpathSync as (...args: unknown[]) => unknown;
    let injected = false;
    let admissionError: unknown;

    await withPatchedFsAsync("realpathSync", ((path: string, ...args: unknown[]) => {
      if (path === publicationDirectory && !injected) {
        injected = true;
        rmSync(publicationDirectory, { recursive: true });
      }
      return originalRealpath(path, ...args);
    }) as never, async () => {
      try {
        assertBackendPublicationConfigReadAccess(configPath, "sqlite", witness);
      } catch (error) {
        admissionError = error;
      }
    });

    expect(injected).toBe(true);
    expect(admissionError).toBeInstanceOf(BackendPublicationJournalError);
    expect(admissionError).toMatchObject({ reason: "unsafe-storage" });
  });

  it.each(["removed", "rebound"] as const)(
    "retains the authenticated publication directory when it is %s between journal read and evidence enumeration",
    (replacement) => {
      const home = makeHome();
      const configPath = join(home, ".lcm", "config.json");
      const publicationDirectory = backendPublicationDirectory(home);
      writeFileSync(configPath, "{}", { mode: 0o600 });
      mkdirSync(publicationDirectory, { mode: 0o700 });
      const witness = configReadWitness(configPath);
      const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
      const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
      const originalReaddir = nodeFs.readdirSync as (...args: unknown[]) => unknown;
      let publicationDirectoryOpens = 0;
      let injected = false;
      const replacePublicationDirectory = (): void => {
        if (injected) return;
        injected = true;
        rmSync(publicationDirectory, { recursive: true });
        if (replacement === "rebound") mkdirSync(publicationDirectory, { mode: 0o700 });
      };

      try {
        // The current implementation reopens before enumeration; a corrected
        // implementation may enumerate through the retained handle instead.
        // Inject at whichever of those stable boundaries it reaches first.
        nodeFs.openSync = ((path: string, ...args: unknown[]) => {
          if (path === publicationDirectory) {
            publicationDirectoryOpens += 1;
            if (publicationDirectoryOpens > 1) replacePublicationDirectory();
          }
          return originalOpen(path, ...args);
        }) as never;
        nodeFs.readdirSync = ((...args: unknown[]) => {
          replacePublicationDirectory();
          return originalReaddir(...args);
        }) as never;
        syncBuiltinESMExports();

        expect(() => assertBackendPublicationConfigReadAccess(
          configPath,
          "sqlite",
          witness,
        )).toThrowError(expect.objectContaining({
          name: "BackendPublicationJournalError",
          reason: "unsafe-storage",
        }));
        expect(injected).toBe(true);
      } finally {
        nodeFs.openSync = originalOpen;
        nodeFs.readdirSync = originalReaddir;
        syncBuiltinESMExports();
      }
    },
  );

  it("binds a present journal to the retained publication directory identity", async () => {
    const { home } = await preparedFixture();
    const publicationDirectory = backendPublicationDirectory(home);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalStat = nodeFs.statSync as (
      path: string,
      options?: { bigint?: boolean },
    ) => { dev: bigint; ino: bigint; [key: string]: unknown };
    let publicationDirectoryStats = 0;

    await withPatchedFsAsync("statSync", ((path: string, options?: { bigint?: boolean }) => {
      const observed = originalStat(path, options);
      if (path === publicationDirectory && options?.bigint === true) {
        publicationDirectoryStats += 1;
        if (publicationDirectoryStats === 3) return { ...observed, dev: observed.dev + 1n };
      }
      return observed;
    }) as never, async () => {
      expect(() => readBackendPublicationJournal(home)).toThrowError(expect.objectContaining({
        name: "BackendPublicationJournalError",
        reason: "unsafe-storage",
      }));
    });
  });

  it("normalizes retained directory revalidation failures after a journal read", async () => {
    const { home } = await preparedFixture();
    const publicationDirectory = backendPublicationDirectory(home);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalStat = nodeFs.statSync as (
      path: string,
      options?: { bigint?: boolean },
    ) => { dev: bigint; ino: bigint; [key: string]: unknown };
    let publicationDirectoryStats = 0;

    await withPatchedFsAsync("statSync", ((path: string, options?: { bigint?: boolean }) => {
      const observed = originalStat(path, options);
      if (path === publicationDirectory && options?.bigint === true) {
        publicationDirectoryStats += 1;
        if (publicationDirectoryStats === 4) return { ...observed, dev: observed.dev + 1n };
      }
      return observed;
    }) as never, async () => {
      expect(() => readBackendPublicationJournal(home)).toThrowError(expect.objectContaining({
        name: "BackendPublicationJournalError",
        reason: "unsafe-storage",
        message: expect.stringContaining("backend publication directory changed during journal read"),
      }));
    });
  });

  it("binds terminal material to the journal directory for lock-free config reads", async () => {
    const { home, fake } = await preparedFixture();
    await coordinator(home, fake.driver).resume();
    const configPath = join(home, ".lcm", "config.json");
    const witness = configReadWitness(configPath);
    let admitted = false;

    const observed = await withTemporaryReboundPublicationMaterial(home, () => {
      assertBackendPublicationConfigReadAccess(configPath, "postgresql", witness);
      admitted = true;
    });

    expect(observed.injected).toBe(true);
    expect(observed.restored).toBe(true);
    expect(admitted).toBe(false);
    expect(observed.error).toBeInstanceOf(BackendPublicationJournalError);
    expect(observed.error).toMatchObject({ reason: "unsafe-storage" });
  });

  it("binds terminal material to the journal directory for locked consumers", async () => {
    const { home, fake } = await preparedFixture();
    await coordinator(home, fake.driver).resume();
    let callbackRan = false;

    const observed = await withTemporaryReboundPublicationMaterial(home, () => {
      withBackendPublicationConsumerLock(home, () => {
        callbackRan = true;
      });
    });

    expect(observed.injected).toBe(true);
    expect(observed.restored).toBe(true);
    expect(callbackRan).toBe(false);
    expect(observed.error).toBeInstanceOf(BackendPublicationJournalError);
    expect(observed.error).toMatchObject({ reason: "unsafe-storage" });
  });

  it("normalizes retained directory drift during terminal material authentication", async () => {
    const { home, fake } = await preparedFixture();
    await coordinator(home, fake.driver).resume();
    const configPath = join(home, ".lcm", "config.json");
    const witness = configReadWitness(configPath);
    const publicationDirectory = backendPublicationDirectory(home);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalStat = nodeFs.statSync as (
      path: string,
      options?: { bigint?: boolean },
    ) => { dev: bigint; ino: bigint; [key: string]: unknown };
    let publicationDirectoryStats = 0;

    await withPatchedFsAsync("statSync", ((path: string, options?: { bigint?: boolean }) => {
      const observed = originalStat(path, options);
      if (path === publicationDirectory && options?.bigint === true) {
        publicationDirectoryStats += 1;
        if (publicationDirectoryStats === 5) return { ...observed, dev: observed.dev + 1n };
      }
      return observed;
    }) as never, async () => {
      expect(() => assertBackendPublicationConfigReadAccess(
        configPath,
        "postgresql",
        witness,
      )).toThrowError(expect.objectContaining({
        name: "BackendPublicationJournalError",
        reason: "unsafe-storage",
        message: expect.stringContaining("changed during material authentication"),
      }));
    });
    expect(publicationDirectoryStats).toBeGreaterThanOrEqual(5);
  });

  it("validates lock-free reads against terminal evidence and the exact config witness", async () => {
    const { home, fake } = await preparedFixture();
    await coordinator(home, fake.driver).resume();
    const configPath = join(home, ".lcm", "config.json");
    const witness = configReadWitness(configPath);

    expect(() => assertBackendPublicationConfigReadAccess(configPath, "postgresql", witness)).not.toThrow();
    expect(() => assertBackendPublicationConfigReadAccess(configPath, "sqlite", witness))
      .toThrowError(expect.objectContaining({ reason: "backend-mismatch" }));

    writeFileSync(configPath, "{}", { mode: 0o600 });
    expect(() => assertBackendPublicationConfigReadAccess(configPath, "postgresql", witness))
      .toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
  });

  it("admits the source backend through an aborted terminal publication journal", async () => {
    const { home, fake } = await preparedFixture();
    await coordinator(home, fake.driver).abort();
    const configPath = join(home, ".lcm", "config.json");

    expect(() => assertBackendPublicationConfigReadAccess(
      configPath,
      "sqlite",
      configReadWitness(configPath),
    )).not.toThrow();
  });

});

describe("revocable mutation permits", () => {
  it("retains and authenticates an injected owner policy for a normal HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-home-lock-topology-"));
    roots.push(home);
    chmodSync(home, 0o755);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (expectedUid === undefined) throw new Error("HOME lock topology tests require process.getuid");

    const topology = openHomeLockTopology(home, expectedUid);
    try {
      expect(() => assertHomeLockTopology(topology)).not.toThrow();
      restoreHomeLockTopologyMode(topology);
      expect(statSync(home).mode & 0o7777).toBe(0o755);
    } finally {
      closeHomeLockTopology(topology);
    }

    expect(() => openHomeLockTopology(home, expectedUid + 1)).toThrow("trusted");

    const defaultTopology = openHomeLockTopology();
    try {
      expect(defaultTopology.homePath).toBe(resolve(homedir()));
      expect(() => assertHomeLockTopology(defaultTopology)).not.toThrow();
    } finally {
      closeHomeLockTopology(defaultTopology);
    }
  });

  it("authenticates a normal 0755 HOME without tightening it for first-boot admission", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-consumer-normal-home-"));
    roots.push(home);
    chmodSync(home, 0o755);

    withBackendPublicationConsumerLock(home, () => {
      expect(statSync(home).mode & 0o7777).toBe(0o755);
    });
    expect(statSync(home).mode & 0o7777).toBe(0o755);

    expect(() => withBackendPublicationConsumerLock(home, () => {
      throw new Error("callback failed");
    })).toThrow("callback failed");
    expect(statSync(home).mode & 0o7777).toBe(0o755);
  });

  it("keeps the backend publication lock valid across unrelated sibling entry churn", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-consumer-ctime-churn-parent-"));
    const home = join(parent, "home");
    mkdirSync(home, { mode: 0o755 });
    roots.push(parent);

    const beforeParent = statSync(parent, { bigint: true });
    const beforeHome = statSync(home, { bigint: true });
    const parentCanonical = resolve(realpathSync(parent));
    const homeCanonical = resolve(realpathSync(home));

    withBackendPublicationConsumerLock(home, () => {
      const sibling = join(parent, "unrelated-sibling");
      mkdirSync(sibling, { mode: 0o700 });
      rmSync(sibling, { recursive: true, force: true });

      const afterParent = statSync(parent, { bigint: true });
      const afterHome = statSync(home, { bigint: true });
      expect(afterParent.dev).toBe(beforeParent.dev);
      expect(afterParent.ino).toBe(beforeParent.ino);
      expect(afterParent.uid).toBe(beforeParent.uid);
      expect(afterParent.gid).toBe(beforeParent.gid);
      expect(Number(afterParent.mode & 0o7777n)).toBe(Number(beforeParent.mode & 0o7777n));
      expect(afterHome.dev).toBe(beforeHome.dev);
      expect(afterHome.ino).toBe(beforeHome.ino);
      expect(afterHome.uid).toBe(beforeHome.uid);
      expect(afterHome.gid).toBe(beforeHome.gid);
      expect(resolve(realpathSync(parent))).toBe(parentCanonical);
      expect(resolve(realpathSync(home))).toBe(homeCanonical);
    });

    const topology = openHomeLockTopology(home);
    try {
      expect(() => assertHomeLockTopology({
        ...topology,
        parentMode: topology.parentMode ^ 0o001,
      })).toThrow("topology changed during validation");
    } finally {
      closeHomeLockTopology(topology);
    }
  });

  it("rejects unsafe or non-canonical HOME lock parents", () => {
    const unsafeParent = mkdtempSync(join(tmpdir(), "lcm-consumer-unsafe-parent-"));
    roots.push(unsafeParent);
    chmodSync(unsafeParent, 0o755);
    const unsafe = join(unsafeParent, "home");
    mkdirSync(unsafe, { mode: 0o700 });
    chmodSync(unsafe, 0o775);
    expect(() => withBackendPublicationConsumerLock(unsafe, () => undefined)).toThrow();

    const missingParent = mkdtempSync(join(tmpdir(), "lcm-consumer-missing-parent-"));
    roots.push(missingParent);
    expect(() => withBackendPublicationConsumerLock(join(missingParent, "missing"), () => undefined)).toThrow();

    const actual = mkdtempSync(join(tmpdir(), "lcm-consumer-canonical-home-"));
    const linkParent = mkdtempSync(join(tmpdir(), "lcm-consumer-canonical-parent-"));
    const canonicalParent = mkdtempSync(join(tmpdir(), "lcm-consumer-canonical-target-"));
    roots.push(actual, linkParent, canonicalParent);
    const linked = join(linkParent, "home");
    symlinkSync(actual, linked, "dir");
    expect(() => withBackendPublicationConsumerLock(linked, () => undefined)).toThrow();
    const parentLink = join(linkParent, "parent");
    symlinkSync(canonicalParent, parentLink, "dir");
    const canonicalSub = join(canonicalParent, "sub");
    mkdirSync(canonicalSub, { mode: 0o700 });
    const nonCanonicalHome = join(parentLink, "sub", "home");
    mkdirSync(nonCanonicalHome, { mode: 0o700 });
    expect(() => withBackendPublicationConsumerLock(nonCanonicalHome, () => undefined))
      .toThrow("path is not canonical");

    // POSIX-only fixture: this must exercise the real root-owned sticky /tmp parent.
    const stickyParentHome = mkdtempSync("/tmp/lcm-consumer-sticky-parent-");
    roots.push(stickyParentHome);
    withBackendPublicationConsumerLock(stickyParentHome, () => undefined);
  });

  it("fails closed when a retained HOME lock parent changes during validation", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-consumer-race-home-"));
    roots.push(home);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalStat = nodeFs.statSync as (
      path: string,
      options?: { bigint?: boolean },
    ) => { dev: bigint; ino: bigint; [key: string]: unknown };

    await withPatchedFsAsync("statSync", ((candidate: string, options?: { bigint?: boolean }) => {
      const observed = originalStat(candidate, options);
      if (candidate === home) return { ...observed, dev: observed.dev + 1n };
      return observed;
    }) as never, async () => {
      expect(() => withBackendPublicationConsumerLock(home, () => undefined))
        .toThrow("changed during validation");
    });

    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: () => -1, configurable: true });
      expect(() => withBackendPublicationConsumerLock(home, () => undefined))
        .toThrow("lock parent is not trusted");
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }

    const nodeFsForOwner = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalFstat = nodeFsForOwner.fstatSync as (
      fd: number,
      options?: { bigint?: boolean },
    ) => { uid: bigint; [key: string]: unknown };
    let fstatCalls = 0;
    await withPatchedFsAsync("fstatSync", ((fd: number, options?: { bigint?: boolean }) => {
      const observed = originalFstat(fd, options);
      fstatCalls += 1;
      if (fstatCalls === 1) Object.defineProperty(observed, "uid", { value: observed.uid + 1n });
      return observed;
    }) as never, async () => {
      expect(() => withBackendPublicationConsumerLock(home, () => undefined))
        .toThrow("lock parent is not trusted");
    });
  });

  it("does not create a local publication root for an absent-root consumer preflight", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-consumer-absent-root-"));
    roots.push(home);
    let callbackCalled = false;

    withBackendPublicationConsumerLock(home, () => {
      callbackCalled = true;
      expect(existsSync(join(home, ".lcm"))).toBe(false);
    });

    expect(callbackCalled).toBe(true);
    expect(existsSync(join(home, ".lcm"))).toBe(false);
  });

  it("rejects a promise-returning synchronous consumer callback before releasing its token", async () => {
    const home = makeHome();
    let continuation: Promise<void> | undefined;

    expect(() => withBackendPublicationConsumerLock(home, (token) => {
      continuation = Promise.resolve().then(() => {
        assertBackendPublicationConsumerAccess({ homeDir: home, lockToken: token });
      });
      return continuation;
    })).toThrow("synchronous backend publication consumer callback returned a promise");

    await expect(continuation).rejects.toMatchObject({ reason: "permit-mismatch" });
  });

  it("rejects a promise returned through the synchronous config seam and revokes its token", async () => {
    const home = makeHome();
    const configPath = join(home, ".lcm", "config.json");
    let continuation: Promise<void> | undefined;

    expect(() => withBackendPublicationConfigLock(configPath, (token) => {
      continuation = Promise.resolve().then(() => {
        assertBackendPublicationConsumerAccess({ homeDir: home, lockToken: token });
      });
      return continuation;
    })).toThrow("synchronous backend publication consumer callback returned a promise");

    await expect(continuation).rejects.toMatchObject({ reason: "permit-mismatch" });
  });

  it("rejects inherited asynchronous work after the owning callback returns", async () => {
    let retained: { assertActive: () => void } | undefined;
    await withRevocablePrivateMutationPermit("test", (permit) => {
      retained = permit;
      permit.assertActive();
    });
    expect(() => retained?.assertActive()).toThrow(PrivateMutationPermitRevokedError);
  });

  it.each([
    { contentionWaitMs: -1 }, { contentionWaitMs: Infinity },
    { retryDelayMs: 0 }, { retryDelayMs: NaN },
  ])("rejects invalid append timing before effects: %j", async options => {
    const effect = vi.fn();
    await expect(withBackendPublicationAppendBarrierAsync(makeHome(), effect, undefined, options))
      .rejects.toThrow("must be");
    expect(effect).not.toHaveBeenCalled();
  });

  it("refuses admission when the predecessor completes exactly at the deadline", async () => {
    const home = makeHome();
    let release!: () => void;
    let enter!: () => void;
    let now = 0;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const owner = withBackendPublicationAppendBarrierAsync(home, async () => {
      enter();
      await new Promise<void>(resolve => { release = resolve; });
    });
    await entered;
    const effect = vi.fn();
    const follower = withBackendPublicationAppendBarrierAsync(home, effect, undefined, {
      contentionWaitMs: 10,
      _now: () => now,
      _wait: async () => {
        now = 10;
        release();
        await owner;
        await new Promise<void>(() => undefined);
      },
    });
    await expect(follower).rejects.toMatchObject({ name: "BackendPublicationAppendBarrierTimeoutError" });
    expect(effect).not.toHaveBeenCalled();
    await owner;
  });

  it("never retries caller effects that throw a contention-shaped error", async () => {
    const home = makeHome();
    const contention = new PrivateMutationLockContentionError("callback contention");
    let calls = 0;
    const waitingBarrier = withBackendPublicationAppendBarrierAsync as unknown as <T>(
      homeDir: string,
      callback: () => Promise<T>,
      token: undefined,
      options: Readonly<{ contentionWaitMs: number; retryDelayMs: number }>,
    ) => Promise<T>;

    await expect(waitingBarrier(home, async () => {
      calls += 1;
      throw contention;
    }, undefined, { contentionWaitMs: 50, retryDelayMs: 1 })).rejects.toBe(contention);
    expect(calls).toBe(1);
  });

  it("reuses only a live same-home append context", async () => {
    const home = makeHome();
    const other = makeHome();
    let releaseRetained!: () => void;
    let retained!: Promise<void>;
    await withBackendPublicationAppendBarrierAsync(home, async token => {
      expect(await withBackendPublicationAppendBarrierAsync(home, nested => nested)).toBe(token);
      expect(withBackendPublicationConsumerLock(home, nested => nested)).toBe(token);
      await expect(withBackendPublicationAppendBarrierAsync(other, async () => undefined))
        .rejects.toMatchObject({ reason: "permit-mismatch" });
      await expect(withBackendPublicationAppendBarrierAsync(home, async () => undefined, {}))
        .rejects.toMatchObject({ reason: "permit-mismatch" });
      const released = new Promise<void>(resolve => { releaseRetained = resolve; });
      retained = released.then(async () => {
        await Promise.resolve();
        await withBackendPublicationAppendBarrierAsync(home, async () => undefined);
      });
    });
    releaseRetained();
    await expect(retained).rejects.toMatchObject({ reason: "permit-mismatch" });
  });

  it("rejects detached append work after callback completion while the consumer token is still live", async () => {
    const home = makeHome();
    let task: AsyncResource | undefined;
    let observed = false;
    await withBackendPublicationAppendBarrierAsync(home, async () => {
      task = new AsyncResource("detached-append-work");
    }, undefined, {
      _appendLockObserver: event => {
        if (event === "before-main-lock-release-read") {
          task!.runInAsyncScope(() => {
            expect(() => withBackendPublicationConsumerLock(home, () => undefined))
              .toThrow("inherited append barrier token is no longer active");
            observed = true;
          });
        }
      },
    });
    task!.emitDestroy();
    expect(observed).toBe(true);
  });

  it("retries transient pre-callback contention using the default timer", async () => {
    let attempts = 0;
    const effect = vi.fn(() => "committed");
    await expect(withBackendPublicationAppendBarrierAsync(makeHome(), effect, undefined, {
      contentionWaitMs: 5_000, retryDelayMs: 1, _now: () => 0,
      _appendLockObserver: event => {
        if (event === "before-main-lock-publish" && ++attempts === 1) {
          throw new PrivateMutationLockContentionError("transient external append owner");
        }
      },
    })).resolves.toBe("committed");
    expect(attempts).toBe(2);
    expect(effect).toHaveBeenCalledOnce();
  });

  it("times out a queued caller through the default deadline timer", async () => {
    const home = makeHome();
    let release!: () => void;
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const owner = withBackendPublicationAppendBarrierAsync(home, async () => {
      enter();
      await new Promise<void>(resolve => { release = resolve; });
    });
    await entered;
    const effect = vi.fn();
    try {
      await expect(withBackendPublicationAppendBarrierAsync(home, effect, undefined, {
        contentionWaitMs: 1, _now: () => 0,
      })).rejects.toMatchObject({ name: "BackendPublicationAppendBarrierTimeoutError" });
      expect(effect).not.toHaveBeenCalled();
    } finally { release(); await owner; }
  });

  it("preserves immediate pre-callback contention for an unbounded caller", async () => {
    const error = new PrivateMutationLockContentionError("external append owner");
    const effect = vi.fn();
    await expect(withBackendPublicationAppendBarrierAsync(makeHome(), effect, undefined, {
      _appendLockObserver: event => { if (event === "before-main-lock-publish") throw error; },
    })).rejects.toBe(error);
    expect(effect).not.toHaveBeenCalled();
  });

  it("retries only pre-callback contention and releases its local tail", async () => {
    const home = makeHome();
    let now = 0;
    let waits = 0;
    let effects = 0;
    const owner = withBackendPublicationAppendBarrierAsync(home, async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    await Promise.resolve();
    const timeout = withBackendPublicationAppendBarrierAsync(home, async () => {
      effects += 1;
    }, undefined, {
      contentionWaitMs: 10,
      retryDelayMs: 1,
      _now: () => now,
      _wait: async milliseconds => { waits += 1; now += milliseconds; },
    });
    await expect(timeout).rejects.toMatchObject({
      name: "BackendPublicationAppendBarrierTimeoutError",
      retryRequired: true,
    });
    expect(effects).toBe(0);
    expect(waits).toBe(1);
    await owner;
    await expect(withBackendPublicationAppendBarrierAsync(home, async () => "released"))
      .resolves.toBe("released");
  });

  it("keeps a timed-out queued entry behind its live predecessor", async () => {
    const home = makeHome();
    let releaseOwner!: () => void;
    let ownerEntered!: () => void;
    const entered = new Promise<void>(resolve => { ownerEntered = resolve; });
    const owner = withBackendPublicationAppendBarrierAsync(home, async () => {
      ownerEntered();
      await new Promise<void>(resolve => { releaseOwner = resolve; });
    });
    await entered;

    await expect(withBackendPublicationAppendBarrierAsync(home, async () => {
      throw new Error("timed-out callback must not run");
    }, undefined, {
      contentionWaitMs: 1,
      _now: () => 0,
      _wait: async () => undefined,
    })).rejects.toMatchObject({ name: "BackendPublicationAppendBarrierTimeoutError" });

    let followerEntered = false;
    const follower = withBackendPublicationAppendBarrierAsync(home, async () => {
      followerEntered = true;
      return "followed";
    });
    await Promise.resolve();
    expect(followerEntered).toBe(false);
    releaseOwner();
    await owner;
    await expect(follower).resolves.toBe("followed");
  });

  it("releases its queued entry when the injected wait rejects", async () => {
    const home = makeHome();
    let releaseOwner!: () => void;
    let ownerEntered!: () => void;
    const entered = new Promise<void>(resolve => { ownerEntered = resolve; });
    const owner = withBackendPublicationAppendBarrierAsync(home, async () => {
      ownerEntered();
      await new Promise<void>(resolve => { releaseOwner = resolve; });
    });
    await entered;
    const waitFailure = new Error("injected local-tail wait failure");
    await expect(withBackendPublicationAppendBarrierAsync(home, async () => undefined, undefined, {
      contentionWaitMs: 1,
      _wait: async () => { throw waitFailure; },
    })).rejects.toBe(waitFailure);
    releaseOwner();
    await owner;

    await expect(withBackendPublicationAppendBarrierAsync(home, async () => "released", undefined, {
      contentionWaitMs: 50,
    })).resolves.toBe("released");
  });

  it("cancels the local-tail deadline timer when admission wins", async () => {
    const home = makeHome();
    let releaseOwner!: () => void;
    let ownerEntered!: () => void;
    const entered = new Promise<void>(resolve => { ownerEntered = resolve; });
    const owner = withBackendPublicationAppendBarrierAsync(home, async () => {
      ownerEntered();
      await new Promise<void>(resolve => { releaseOwner = resolve; });
    });
    await entered;

    vi.useFakeTimers();
    try {
      const follower = withBackendPublicationAppendBarrierAsync(
        home,
        async () => "admitted",
        undefined,
        { contentionWaitMs: 5_000 },
      );
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);
      releaseOwner();
      await owner;
      await expect(follower).resolves.toBe("admitted");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      releaseOwner();
      await owner;
    }
  });

  it("propagates post-callback append-lock cleanup without replaying effects", async () => {
    const home = makeHome();
    const cleanupFailure = new Error("append lock cleanup failed");
    let effects = 0;
    const barrierWithCleanupSeam = withBackendPublicationAppendBarrierAsync as unknown as <T>(
      homeDir: string,
      callback: () => Promise<T>,
      token: undefined,
      options: Readonly<{ _appendLockObserver: (event: string) => void }>,
    ) => Promise<T>;

    await expect(barrierWithCleanupSeam(home, async () => {
      effects += 1;
      return "committed";
    }, undefined, {
      _appendLockObserver: (event) => {
        if (event === "before-main-lock-release-read") throw cleanupFailure;
      },
    })).rejects.toBe(cleanupFailure);
    expect(effects).toBe(1);
    await expect(withBackendPublicationAppendBarrierAsync(home, async () => "next"))
      .resolves.toBe("next");
  });

  it("retains tail, consumer, and private-lock order without follower overtake", async () => {
    const home = makeHome();
    const order: string[] = [];
    let releaseOwner!: () => void;
    let ownerEntered!: () => void;
    const entered = new Promise<void>(resolve => { ownerEntered = resolve; });
    const owner = withBackendPublicationAppendBarrierAsync(home, async () => {
      order.push("owner");
      ownerEntered();
      await new Promise<void>(resolve => { releaseOwner = resolve; });
    });
    await entered;
    const retained = withBackendPublicationRetainedAppendAdmissionAsync(
      home,
      async token => {
        order.push("retained");
        expect(withBackendPublicationConsumerLock(
          home,
          nested => nested,
          { lockToken: token },
        )).toBe(token);
      },
      undefined,
      {
        contentionWaitMs: 5_000,
        externalLockAttempts: 1,
        _appendLockObserver: event => {
          if (event === "before-main-lock-publish") order.push("retained-lock");
        },
      },
    );
    const follower = withBackendPublicationAppendBarrierAsync(home, async () => {
      order.push("follower");
    });
    await Promise.resolve();
    expect(order).toEqual(["owner"]);
    releaseOwner();
    await Promise.all([owner, retained, follower]);
    expect(order).toEqual(["owner", "retained-lock", "retained", "follower"]);
  });

  it("grants retained append authority only to the exact explicit token", async () => {
    const home = makeHome();
    await withBackendPublicationRetainedAppendAdmissionAsync(home, async token => {
      expect(withBackendPublicationConsumerLock(
        home,
        nested => nested,
        { lockToken: token },
      )).toBe(token);
      await expect(withBackendPublicationAppendBarrierAsync(
        home,
        nested => nested,
        token,
      )).resolves.toBe(token);
      await expect(withBackendPublicationAppendBarrierAsync(
        home,
        async () => undefined,
        undefined,
        { contentionWaitMs: 0 },
      )).rejects.toBeInstanceOf(BackendPublicationAppendBarrierTimeoutError);
    }, undefined, { contentionWaitMs: 5_000, externalLockAttempts: 1 });
    await expect(withBackendPublicationAppendBarrierAsync(home, async () => "released"))
      .resolves.toBe("released");
  });

  it("suppresses active-token ambience and restores the outer append context", async () => {
    const home = makeHome();
    await withBackendPublicationAppendBarrierAsync(home, async token => {
      await withBackendPublicationRetainedAppendAdmissionAsync(
        home,
        async retainedToken => {
          expect(retainedToken).toBe(token);
          await expect(withBackendPublicationAppendBarrierAsync(
            home,
            async () => undefined,
            undefined,
            { contentionWaitMs: 0 },
          )).rejects.toBeInstanceOf(BackendPublicationAppendBarrierTimeoutError);
          await expect(withBackendPublicationAppendBarrierAsync(
            home,
            nested => nested,
            retainedToken,
          )).resolves.toBe(token);
        },
        token,
        { contentionWaitMs: 5_000, externalLockAttempts: 1 },
      );
      await expect(withBackendPublicationAppendBarrierAsync(home, nested => nested))
        .resolves.toBe(token);
    });
  });

  it("preserves borrowed consumer authority across every pre-effect outcome", async () => {
    const home = makeHome();
    await withBackendPublicationConsumerLockAsync(home, async token => {
      const assertBorrowed = (): void => {
        expect(withBackendPublicationConsumerLock(
          home,
          nested => nested,
          { lockToken: token },
        )).toBe(token);
      };
      await withBackendPublicationRetainedAppendAdmissionAsync(
        home,
        async nested => { expect(nested).toBe(token); },
        token,
        { contentionWaitMs: 5_000, externalLockAttempts: 1 },
      );
      assertBorrowed();

      const callbackFailure = new Error("retained callback failed");
      await expect(withBackendPublicationRetainedAppendAdmissionAsync(
        home,
        async () => { throw callbackFailure; },
        token,
        { contentionWaitMs: 5_000, externalLockAttempts: 1 },
      )).rejects.toBe(callbackFailure);
      assertBorrowed();

      const controller = new AbortController();
      controller.abort();
      await expect(withBackendPublicationRetainedAppendAdmissionAsync(
        home,
        async () => { throw new Error("pre-aborted callback ran"); },
        token,
        { contentionWaitMs: 5_000, signal: controller.signal, externalLockAttempts: 1 },
      )).rejects.toMatchObject({ reason: "aborted" });
      assertBorrowed();

      await expect(withBackendPublicationRetainedAppendAdmissionAsync(
        home,
        async () => { throw new Error("deadline callback ran"); },
        token,
        { contentionWaitMs: 0, externalLockAttempts: 1 },
      )).rejects.toMatchObject({ reason: "deadline" });
      assertBorrowed();

      await expect(withBackendPublicationAppendBarrierAsync(
        home,
        async () => undefined,
        undefined,
        { contentionWaitMs: 0 },
      )).rejects.toBeInstanceOf(BackendPublicationAppendBarrierTimeoutError);
      assertBorrowed();
    });
  });

  it("keeps borrowed tokens live after active-token callback failure", async () => {
    const home = makeHome();
    const callbackFailure = new Error("nested retained failure");
    await withBackendPublicationAppendBarrierAsync(home, async token => {
      await expect(withBackendPublicationRetainedAppendAdmissionAsync(
        home,
        async () => { throw callbackFailure; },
        token,
        { contentionWaitMs: 5_000, externalLockAttempts: 1 },
      )).rejects.toBe(callbackFailure);
      await expect(withBackendPublicationAppendBarrierAsync(home, nested => nested))
        .resolves.toBe(token);
    });
  });

  it("rejects revoked and wrong-home retained tokens", async () => {
    const home = makeHome();
    const other = makeHome();
    let revoked!: object;
    await withBackendPublicationConsumerLockAsync(home, async token => {
      revoked = token;
      await expect(withBackendPublicationRetainedAppendAdmissionAsync(
        other,
        async () => undefined,
        token,
        { contentionWaitMs: 5_000, externalLockAttempts: 1 },
      )).rejects.toMatchObject({ reason: "permit-mismatch" });
    });
    await expect(withBackendPublicationRetainedAppendAdmissionAsync(
      home,
      async () => undefined,
      revoked,
      { contentionWaitMs: 5_000, externalLockAttempts: 1 },
    )).rejects.toMatchObject({ reason: "permit-mismatch" });
  });

  it("aborts predecessor waiting, removes wait resources, and preserves queue order", async () => {
    vi.useFakeTimers();
    const home = makeHome();
    let releaseOwner!: () => void;
    let ownerEntered!: () => void;
    const entered = new Promise<void>(resolve => { ownerEntered = resolve; });
    const owner = withBackendPublicationAppendBarrierAsync(home, async () => {
      ownerEntered();
      await new Promise<void>(resolve => { releaseOwner = resolve; });
    });
    await entered;
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const effect = vi.fn();
    const retained = withBackendPublicationRetainedAppendAdmissionAsync(
      home,
      effect,
      undefined,
      { contentionWaitMs: 5_000, signal: controller.signal, externalLockAttempts: 1 },
    );
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await expect(retained).rejects.toMatchObject({ reason: "aborted" });
    expect(effect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();

    let followerEntered = false;
    const follower = withBackendPublicationAppendBarrierAsync(home, async () => {
      followerEntered = true;
    });
    await Promise.resolve();
    expect(followerEntered).toBe(false);
    releaseOwner();
    await Promise.all([owner, follower]);
    expect(followerEntered).toBe(true);
    vi.useRealTimers();
  });

  it("cleans the predecessor timer and listener when the predecessor wins", async () => {
    vi.useFakeTimers();
    const home = makeHome();
    let releaseOwner!: () => void;
    let ownerEntered!: () => void;
    const entered = new Promise<void>(resolve => { ownerEntered = resolve; });
    const owner = withBackendPublicationAppendBarrierAsync(home, async () => {
      ownerEntered();
      await new Promise<void>(resolve => { releaseOwner = resolve; });
    });
    await entered;
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const retained = withBackendPublicationRetainedAppendAdmissionAsync(
      home,
      async () => "admitted",
      undefined,
      { contentionWaitMs: 5_000, signal: controller.signal, externalLockAttempts: 1 },
    );
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    releaseOwner();
    await owner;
    await expect(retained).resolves.toBe("admitted");
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("refuses exact-deadline predecessor settlement without late effects", async () => {
    const home = makeHome();
    let releaseOwner!: () => void;
    let ownerEntered!: () => void;
    let now = 0;
    const entered = new Promise<void>(resolve => { ownerEntered = resolve; });
    const owner = withBackendPublicationAppendBarrierAsync(home, async () => {
      ownerEntered();
      await new Promise<void>(resolve => { releaseOwner = resolve; });
    });
    await entered;
    const effect = vi.fn();
    const retained = withBackendPublicationRetainedAppendAdmissionAsync(
      home,
      effect,
      undefined,
      {
        contentionWaitMs: 10,
        externalLockAttempts: 1,
        _now: () => now,
        _wait: async () => {
          now = 10;
          releaseOwner();
          await owner;
        },
      },
    );
    await expect(retained).rejects.toMatchObject({ reason: "deadline" });
    expect(effect).not.toHaveBeenCalled();
    await owner;
  });

  it("stops retained admission cancelled after its activity assertion", async () => {
    const home = makeHome();
    let releaseOwner!: () => void;
    let ownerEntered!: () => void;
    const entered = new Promise<void>(resolve => { ownerEntered = resolve; });
    const owner = withBackendPublicationAppendBarrierAsync(home, async () => {
      ownerEntered();
      await new Promise<void>(resolve => { releaseOwner = resolve; });
    });
    await entered;
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const effect = vi.fn();
    let nowCalls = 0;
    await expect(withBackendPublicationRetainedAppendAdmissionAsync(
      home,
      effect,
      undefined,
      {
        contentionWaitMs: 5_000,
        externalLockAttempts: 1,
        signal: controller.signal,
        _now: () => {
          nowCalls += 1;
          if (nowCalls === 2) controller.abort();
          return 0;
        },
      },
    )).rejects.toMatchObject({ reason: "aborted" });
    expect(effect).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    releaseOwner();
    await owner;
  });

  it("stops retained admission whose deadline expires before waiting", async () => {
    const home = makeHome();
    let releaseOwner!: () => void;
    let ownerEntered!: () => void;
    const entered = new Promise<void>(resolve => { ownerEntered = resolve; });
    const owner = withBackendPublicationAppendBarrierAsync(home, async () => {
      ownerEntered();
      await new Promise<void>(resolve => { releaseOwner = resolve; });
    });
    await entered;
    const effect = vi.fn();
    const waits = vi.fn(async () => undefined);
    let nowCalls = 0;
    await expect(withBackendPublicationRetainedAppendAdmissionAsync(
      home,
      effect,
      undefined,
      {
        contentionWaitMs: 10,
        externalLockAttempts: 1,
        _now: () => {
          nowCalls += 1;
          return nowCalls >= 3 ? 10 : 0;
        },
        _wait: waits,
      },
    )).rejects.toMatchObject({ reason: "deadline" });
    expect(effect).not.toHaveBeenCalled();
    expect(waits).not.toHaveBeenCalled();
    releaseOwner();
    await owner;
  });

  it("stops retained admission aborted while registering its listener", async () => {
    const home = makeHome();
    let releaseOwner!: () => void;
    let ownerEntered!: () => void;
    const entered = new Promise<void>(resolve => { ownerEntered = resolve; });
    const owner = withBackendPublicationAppendBarrierAsync(home, async () => {
      ownerEntered();
      await new Promise<void>(resolve => { releaseOwner = resolve; });
    });
    await entered;
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const effect = vi.fn();
    await expect(withBackendPublicationRetainedAppendAdmissionAsync(
      home,
      effect,
      undefined,
      {
        contentionWaitMs: 5_000,
        externalLockAttempts: 1,
        signal: controller.signal,
        _now: () => 0,
        _wait: async () => { controller.abort(); },
      },
    )).rejects.toMatchObject({ reason: "aborted" });
    expect(effect).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    releaseOwner();
    await owner;
  });

  it("attempts unrelated external contention once and preserves callback failures", async () => {
    const home = makeHome();
    const contention = new PrivateMutationLockContentionError("external append owner");
    let attempts = 0;
    const effect = vi.fn();
    await expect(withBackendPublicationRetainedAppendAdmissionAsync(
      home,
      effect,
      undefined,
      {
        contentionWaitMs: 5_000,
        externalLockAttempts: 1,
        _appendLockObserver: event => {
          if (event === "before-main-lock-publish") {
            attempts += 1;
            throw contention;
          }
        },
      },
    )).rejects.toBe(contention);
    expect(attempts).toBe(1);
    expect(effect).not.toHaveBeenCalled();

    let now = 0;
    const callbackFailure = new PrivateMutationLockContentionError("callback failure");
    let effects = 0;
    await expect(withBackendPublicationRetainedAppendAdmissionAsync(
      home,
      async () => {
        effects += 1;
        now = 10;
        throw callbackFailure;
      },
      undefined,
      { contentionWaitMs: 10, externalLockAttempts: 1, _now: () => now },
    )).rejects.toBe(callbackFailure);
    expect(effects).toBe(1);
  });

  it("cleans owned authority after callback and private-lock cleanup failures", async () => {
    const home = makeHome();
    const callbackFailure = new Error("callback failed");
    let callbackEffects = 0;
    await expect(withBackendPublicationRetainedAppendAdmissionAsync(
      home,
      async () => {
        callbackEffects += 1;
        throw callbackFailure;
      },
      undefined,
      { contentionWaitMs: 5_000, externalLockAttempts: 1 },
    )).rejects.toBe(callbackFailure);
    expect(callbackEffects).toBe(1);

    const cleanupFailure = new Error("retained append cleanup failed");
    let cleanupEffects = 0;
    await expect(withBackendPublicationRetainedAppendAdmissionAsync(
      home,
      async () => { cleanupEffects += 1; },
      undefined,
      {
        contentionWaitMs: 5_000,
        externalLockAttempts: 1,
        _appendLockObserver: event => {
          if (event === "before-main-lock-release-read") throw cleanupFailure;
        },
      },
    )).rejects.toBe(cleanupFailure);
    expect(cleanupEffects).toBe(1);
    await expect(withBackendPublicationAppendBarrierAsync(home, async () => "next"))
      .resolves.toBe("next");
  });

  it("validates the retained helper's one-shot acquisition contract", async () => {
    const effect = vi.fn();
    await expect(withBackendPublicationRetainedAppendAdmissionAsync(
      makeHome(),
      effect,
      undefined,
      { externalLockAttempts: 2 as 1 },
    )).rejects.toThrow("requires one external lock attempt");
    expect(effect).not.toHaveBeenCalled();
    expect(new BackendPublicationRetainedAppendAdmissionStoppedError("aborted"))
      .toMatchObject({ name: "BackendPublicationRetainedAppendAdmissionStoppedError" });
  });

  it("reuses exact-home append authority in the synchronous wrappers", () => {
    const home = makeHome();
    withBackendPublicationAppendBarrier(home, token => {
      expect(withBackendPublicationAppendBarrier(home, nested => nested)).toBe(token);
      expect(withBackendPublicationConsumerLock(home, nested => nested)).toBe(token);
    });
  });

  it("waits for an unbounded retained predecessor until it settles", async () => {
    const home = makeHome();
    const order: string[] = [];
    let releaseOwner!: () => void;
    let ownerEntered!: () => void;
    const entered = new Promise<void>(resolve => { ownerEntered = resolve; });
    const owner = withBackendPublicationAppendBarrierAsync(home, async () => {
      order.push("owner");
      ownerEntered();
      await new Promise<void>(resolve => { releaseOwner = resolve; });
    });
    await entered;

    let retainedSettled = false;
    const retained = withBackendPublicationRetainedAppendAdmissionAsync(home, () => {
      order.push("retained");
    }).then(() => { retainedSettled = true; });
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();

    expect(retainedSettled).toBe(false);
    expect(order).toEqual(["owner"]);

    releaseOwner();
    await Promise.all([owner, retained]);
    expect(order).toEqual(["owner", "retained"]);
  });

  it("keeps consumer gating while maintenance holds publication", async () => {
    const home = makeHome();
    await createMaintenanceState(home, makeDriver(material()).driver, "maintenance-held");
    const retained = vi.fn();

    await expect(withBackendPublicationRetainedAppendAdmissionAsync(
      home,
      retained,
      undefined,
      { contentionWaitMs: 5_000, externalLockAttempts: 1 },
    )).rejects.toMatchObject({ reason: "unresolved-publication" });
    expect(retained).not.toHaveBeenCalled();

    await expect(withBackendPublicationAppendBarrierAsync(home, async () => "appended"))
      .resolves.toBe("appended");
  });
});

describe("backend publication directory link-count policy", () => {
  type NlinkMutationEvidence = Readonly<{
    beforeNlink: bigint;
    afterNlink: bigint;
    injectionCount: number;
  }>;

  async function withOneShotMaterialDirectoryNlink<T>(
    home: string,
    callback: (controls: Readonly<{
      armAfterNextDirectoryFstat: () => void;
      armOnSuccessfulMaterialOpen: () => void;
    }>) => Promise<T>,
  ): Promise<Readonly<{ result: T; evidence: NlinkMutationEvidence | undefined }>> {
    const publicationDirectory = backendPublicationDirectory(home);
    const materialPath = join(publicationDirectory, "publication-1.material");
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
    const originalClose = nodeFs.closeSync as (fd: number) => void;
    const originalFstat = nodeFs.fstatSync as (
      fd: number,
      options?: { bigint?: boolean },
    ) => {
      dev: bigint;
      ino: bigint;
      mode: bigint;
      uid: bigint;
      gid: bigint;
      nlink: bigint;
      isDirectory: () => boolean;
      [key: string]: unknown;
    };
    const directoryFds = new Set<number>();
    let armMode: "idle" | "after-next-directory-fstat" | "on-material-open" | "armed" | "done" = "idle";
    let lastDirectoryFstatFd: number | undefined;
    let targetFd: number | undefined;
    let injectionCount = 0;
    let evidence: NlinkMutationEvidence | undefined;

    const controls = {
      armAfterNextDirectoryFstat: (): void => {
        expect(armMode).toBe("idle");
        armMode = "after-next-directory-fstat";
      },
      armOnSuccessfulMaterialOpen: (): void => {
        expect(armMode).toBe("idle");
        armMode = "on-material-open";
      },
    } as const;

    return withPatchedFsAsync("openSync", ((path: string, ...args: unknown[]) => {
      const fd = originalOpen(path, ...args);
      if (path === publicationDirectory) directoryFds.add(fd);
      if (path === materialPath && armMode === "on-material-open") {
        expect(lastDirectoryFstatFd).toBeDefined();
        expect(directoryFds.has(lastDirectoryFstatFd!)).toBe(true);
        targetFd = lastDirectoryFstatFd;
        armMode = "armed";
      }
      return fd;
    }) as never, async () => withPatchedFsAsync("closeSync", ((fd: number) => {
      originalClose(fd);
      directoryFds.delete(fd);
    }) as never, async () => withPatchedFsAsync("fstatSync", ((
      fd: number,
      options?: { bigint?: boolean },
    ) => {
      const observed = originalFstat(fd, options);
      if (!directoryFds.has(fd) || options?.bigint !== true) return observed;

      lastDirectoryFstatFd = fd;
      if (armMode === "after-next-directory-fstat") {
        targetFd = fd;
        armMode = "armed";
        return observed;
      }
      if (armMode !== "armed" || fd !== targetFd) return observed;

      const prototype = Object.getPrototypeOf(observed);
      const beforeDescriptors = Object.getOwnPropertyDescriptors(observed);
      const beforeNlink = observed.nlink;
      const pathStat = statSync(publicationDirectory, { bigint: true });
      expect(observed.isDirectory()).toBe(true);
      expect(observed.dev).toBe(pathStat.dev);
      expect(observed.ino).toBe(pathStat.ino);
      Object.defineProperty(observed, "nlink", { value: beforeNlink + 1n });
      const afterDescriptors = Object.getOwnPropertyDescriptors(observed);
      delete beforeDescriptors.nlink;
      delete afterDescriptors.nlink;
      expect(Object.getPrototypeOf(observed)).toBe(prototype);
      expect(afterDescriptors).toEqual(beforeDescriptors);
      injectionCount += 1;
      evidence = { beforeNlink, afterNlink: observed.nlink, injectionCount };
      armMode = "done";
      return observed;
    }) as never, async () => {
      const result = await callback(controls);
      return { result, evidence };
    })));
  }

  function expectNlinkMutation(evidence: NlinkMutationEvidence | undefined): void {
    expect(evidence).toBeDefined();
    expect(evidence?.afterNlink).toBe(evidence!.beforeNlink + 1n);
    expect(evidence?.injectionCount).toBe(1);
  }

  async function sealedPreparingFixture(): Promise<{
    home: string;
    input: BackendPublicationRecoveryMaterial;
    fake: ReturnType<typeof makeDriver>;
  }> {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await expect(coordinator(home, fake.driver, (event) => {
      if (event === "after-material-seal") throw new Error("crash:after-material-seal");
    }).prepare(inputFor(input))).rejects.toThrow("crash:after-material-seal");
    expect(readBackendPublicationJournal(home)?.phase).toBe("preparing");
    return { home, input, fake };
  }

  it("allows prepare to authenticate across directory nlink churn", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);

    const observed = await withOneShotMaterialDirectoryNlink(home, async (controls) => {
      const journal = await coordinator(home, fake.driver, (event) => {
        if (event === "before-material-authenticate") controls.armAfterNextDirectoryFstat();
      }).prepare(inputFor(input));
      return journal;
    });

    expect(observed.result.phase).toBe("prepared");
    expect(fake.calls).toEqual([]);
    expectNlinkMutation(observed.evidence);
  });

  it("allows prepared resume material context across directory nlink churn", async () => {
    const { home, fake } = await preparedFixture();

    const observed = await withOneShotMaterialDirectoryNlink(home, async (controls) => {
      controls.armOnSuccessfulMaterialOpen();
      return coordinator(home, fake.driver).resume();
    });

    expect(observed.result.phase).toBe("completed");
    expect(fake.calls).toEqual(["publish-map", "publish-config"]);
    expectNlinkMutation(observed.evidence);
  });

  it("allows preparing resume across directory nlink churn", async () => {
    const { home, fake } = await sealedPreparingFixture();

    const observed = await withOneShotMaterialDirectoryNlink(home, async (controls) => {
      controls.armOnSuccessfulMaterialOpen();
      return coordinator(home, fake.driver).resume();
    });

    expect(observed.result.phase).toBe("completed");
    expect(fake.calls).toEqual(["publish-map", "publish-config"]);
    expectNlinkMutation(observed.evidence);
  });

  it("allows preparing abort across directory nlink churn", async () => {
    const { home, fake } = await sealedPreparingFixture();

    const observed = await withOneShotMaterialDirectoryNlink(home, async (controls) => {
      controls.armOnSuccessfulMaterialOpen();
      return coordinator(home, fake.driver).abort();
    });

    expect(observed.result.phase).toBe("aborted");
    expect(fake.calls).toEqual([]);
    expect(existsSync(join(backendPublicationDirectory(home), "publication-1.material"))).toBe(false);
    expectNlinkMutation(observed.evidence);
  });

  it("keeps completed consumer material authentication strict", async () => {
    const { home, fake } = await preparedFixture();
    await coordinator(home, fake.driver).resume();
    let controlAdmitted = false;
    withBackendPublicationConsumerLock(home, () => {
      controlAdmitted = true;
    });
    expect(controlAdmitted).toBe(true);

    let mutatedAdmitted = false;
    const observed = await withOneShotMaterialDirectoryNlink(home, async (controls) => {
      controls.armOnSuccessfulMaterialOpen();
      expect(() => withBackendPublicationConsumerLock(home, () => {
        mutatedAdmitted = true;
      })).toThrowError(expect.objectContaining({
        name: "BackendPublicationJournalError",
        reason: "unsafe-storage",
        message: expect.stringContaining("changed during material authentication"),
      }));
    });

    expect(mutatedAdmitted).toBe(false);
    expectNlinkMutation(observed.evidence);
  });
});
