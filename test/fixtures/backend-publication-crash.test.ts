import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import {
  assertBackendPublicationConfigMutation,
  assertBackendPublicationProjectMapMutation,
  BackendPublicationCoordinator,
  backendPublicationMaterialWitness,
  captureBackendPublicationState,
  type BackendPublicationDriver,
  type BackendPublicationFenceRecord,
  type BackendPublicationFileMutationContext,
  type BackendPublicationRecoveryFile,
  type BackendPublicationRecoveryMaterial,
} from "../../src/storage/backend-publication.js";

const HOME = process.env.LCM_BACKEND_PUBLICATION_CRASH_HOME;
const MODE = process.env.LCM_BACKEND_PUBLICATION_CRASH_MODE;
const CRASH_EVENT = process.env.LCM_BACKEND_PUBLICATION_CRASH_EVENT;
const PUBLICATION = "child-process-generation";
const LOCAL_A = "a".repeat(64);
const LOCAL_B = "b".repeat(64);
const REMOTE_A = "018f0000-0000-7000-8000-000000000001";
const REMOTE_B = "018f0000-0000-7000-8000-000000000002";
const MACHINE = "018f0000-0000-7000-8000-000000000003";

function crashAt(event: string): void {
  if (MODE?.endsWith("crash") === true && CRASH_EVENT === event) {
    process.kill(process.pid, "SIGKILL");
  }
}

function recoveryFile(content: string): BackendPublicationRecoveryFile {
  return {
    presence: "present",
    content: Buffer.from(content),
    mode: 0o600,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
  };
}

function material(): BackendPublicationRecoveryMaterial {
  const absentSource = process.env.LCM_BACKEND_PUBLICATION_CRASH_SOURCE === "absent";
  return {
    source: absentSource
      ? { config: { presence: "absent" }, projectMap: { presence: "absent" } }
      : {
        config: recoveryFile('{"storage":{"backend":"sqlite"}}\n'),
        projectMap: recoveryFile("{}\n"),
      },
    target: {
      config: recoveryFile('{"storage":{"backend":"postgresql"}}\n'),
      projectMap: recoveryFile(`${JSON.stringify({
        [LOCAL_A]: {
          canonical: "/workspace/a",
          aliases: [],
          remoteProjectId: REMOTE_A,
        },
        [LOCAL_B]: {
          canonical: "/workspace/b",
          aliases: [],
          remoteProjectId: REMOTE_B,
        },
      }, null, 2)}\n`),
    },
  };
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function atomicStateWrite(path: string, content: string, prefix?: string): void {
  const directory = dirname(path);
  ensureDirectory(directory);
  const temporary = `${path}.pending`;
  if (existsSync(temporary)) {
    const stat = lstatSync(temporary);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    unlinkSync(temporary);
    syncDirectory(directory);
  }
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (prefix !== undefined) crashAt(`before-${prefix}-rename`);
  renameSync(temporary, path);
  if (prefix !== undefined) crashAt(`after-${prefix}-rename`);
  if (prefix !== undefined) crashAt(`before-${prefix}-directory-fsync`);
  syncDirectory(directory);
  if (prefix !== undefined) crashAt(`after-${prefix}-directory-fsync`);
}

function atomicStateRemove(path: string, prefix: string): void {
  const directory = dirname(path);
  ensureDirectory(directory);
  crashAt(`before-${prefix}-unlink`);
  if (existsSync(path)) unlinkSync(path);
  crashAt(`after-${prefix}-unlink`);
  crashAt(`before-${prefix}-directory-fsync`);
  syncDirectory(directory);
  crashAt(`after-${prefix}-directory-fsync`);
}

function materialContent(): string {
  const encode = (file: BackendPublicationRecoveryFile) => file.presence === "absent"
    ? file
    : { ...file, content: Buffer.from(file.content).toString("base64") };
  const value = material();
  return JSON.stringify({
    source: {
      config: encode(value.source.config),
      projectMap: encode(value.source.projectMap),
    },
    target: {
      config: encode(value.target.config),
      projectMap: encode(value.target.projectMap),
    },
  });
}

function fixtureDriver(homeDir: string): BackendPublicationDriver {
  const root = join(homeDir, ".lcm");
  const materialPath = join(root, "backend-publication-material", `${PUBLICATION}.json`);
  const remoteDirectory = join(root, "backend-publication-remote");
  const expiryInjected = new Set<string>();
  const referenceContent = materialContent();
  const reference = {
    relativePath: `backend-publication-material/${PUBLICATION}.json`,
    sealSha256: createHash("sha256").update(referenceContent).digest("hex"),
    byteLength: Buffer.byteLength(referenceContent),
  };
  const remotePath = (projectId: string) => join(remoteDirectory, `${projectId}.json`);
  const readRemote = (projectId: string): BackendPublicationFenceRecord | null => {
    try {
      return JSON.parse(readFileSync(remotePath(projectId), "utf8")) as BackendPublicationFenceRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const applyLocal = (
    input: BackendPublicationFileMutationContext,
    kind: "config" | "projectMap",
    prefix: string,
  ) => {
    const path = join(root, kind === "config" ? "config.json" : "map.json");
    const content = input.file.presence === "present"
      ? Buffer.from(input.file.content).toString("utf8")
      : null;
    if (kind === "config") {
      const currentContent = existsSync(path) ? readFileSync(path, "utf8") : null;
      const publishing = prefix.includes("publish");
      assertBackendPublicationConfigMutation(
        path,
        publishing ? input.journal.sourceBackend : input.journal.targetBackend,
        publishing ? input.journal.targetBackend : input.journal.sourceBackend,
        content,
        currentContent,
      );
    } else {
      assertBackendPublicationProjectMapMutation(
        content === null ? {} : JSON.parse(content),
        homeDir,
        content,
      );
    }
    if (content === null) atomicStateRemove(path, prefix);
    else atomicStateWrite(path, content, prefix);
    return captureBackendPublicationState(homeDir)[kind];
  };
  return {
    async sealRecoveryMaterial() {
      if (!existsSync(materialPath)) {
        atomicStateWrite(materialPath, referenceContent, "material");
      }
      expect(createHash("sha256").update(readFileSync(materialPath)).digest("hex"))
        .toBe(reference.sealSha256);
      return reference;
    },
    async authenticateRecoveryMaterial(input) {
      const content = readFileSync(join(root, input.recoveryReference.relativePath));
      expect(createHash("sha256").update(content).digest("hex"))
        .toBe(input.recoveryReference.sealSha256);
      return material();
    },
    async observeLocalState() {
      return captureBackendPublicationState(homeDir);
    },
    async publishProjectMap(input) {
      return applyLocal(input, "projectMap", "project-map-publish");
    },
    async publishConfig(input) {
      return applyLocal(input, "config", "config-publish");
    },
    async restoreConfig(input) {
      return applyLocal(input, "config", "config-restore");
    },
    async restoreProjectMap(input) {
      return applyLocal(input, "projectMap", "project-map-restore");
    },
    async acquireRemoteGuard({ journal, project }) {
      const existing = readRemote(project.remoteProjectId);
      if (existing !== null && existing.releasedAt === null && !existing.databaseExpired) {
        return existing;
      }
      const replacement = existing !== null;
      const next: BackendPublicationFenceRecord = {
        projectId: project.remoteProjectId,
        machineId: MACHINE,
        publicationId: journal.publicationId,
        targetBackend: journal.targetBackend,
        evidenceSha256: project.evidenceSha256,
        fencingToken: String(existing === null ? 1n : BigInt(existing.fencingToken) + 1n),
        acquiredAt: replacement
          ? "2026-08-01T00:01:01.000Z"
          : "2026-08-01T00:00:01.000Z",
        renewedAt: replacement
          ? "2026-08-01T00:01:01.000Z"
          : "2026-08-01T00:00:01.000Z",
        expiresAt: replacement
          ? "2026-08-01T00:11:01.000Z"
          : "2026-08-01T00:10:01.000Z",
        releasedAt: null,
        databaseExpired: false,
      };
      crashAt("before-remote-acquire");
      atomicStateWrite(remotePath(project.remoteProjectId), JSON.stringify(next));
      crashAt("after-remote-acquire");
      return next;
    },
    async readRemoteGuard({ journal, project }, operation) {
      const current = readRemote(project.remoteProjectId);
      if (
        MODE?.includes("expiry") === true
        && operation === "release"
        && (journal.phase === "releasing" || journal.phase === "abort-releasing")
        && current !== null
        && current.releasedAt === null
        && !expiryInjected.has(project.remoteProjectId)
      ) {
        expiryInjected.add(project.remoteProjectId);
        const expired = { ...current, databaseExpired: true };
        atomicStateWrite(remotePath(project.remoteProjectId), JSON.stringify(expired));
        return expired;
      }
      return current;
    },
    async releaseRemoteGuard({ journal, project, fence }) {
      const current = readRemote(project.remoteProjectId);
      expect(current).not.toBeNull();
      expect(current!.databaseExpired).toBe(false);
      expect(current!.releasedAt).toBeNull();
      expect(current!.fencingToken).toBe(fence.fencingToken);
      expect(current!.acquiredAt).toBe(fence.acquiredAt);
      const prefix = journal.phase === "abort-releasing"
        ? "abort-remote-release"
        : "remote-release";
      crashAt(`before-${prefix}`);
      atomicStateWrite(remotePath(project.remoteProjectId), JSON.stringify({
        ...current!,
        releasedAt: "2026-08-01T00:02:00.000Z",
      }));
      crashAt(`after-${prefix}`);
    },
    async retainCompletedMaterial() {
      atomicStateWrite(
        join(root, "backend-publication-retained"),
        PUBLICATION,
        "terminal-retain",
      );
    },
    async cleanupAbortedMaterial() {
      atomicStateWrite(
        join(root, "backend-publication-aborted"),
        PUBLICATION,
        "terminal-cleanup",
      );
      atomicStateRemove(materialPath, "material-cleanup");
    },
  };
}

it("recovers a backend publication after a real worker SIGKILL", async () => {
  if (HOME === undefined || MODE === undefined) {
    expect(true).toBe(true);
    return;
  }
  const root = join(HOME, ".lcm");
  ensureDirectory(root);
  const state = material();
  const initialized = join(root, "backend-publication-fixture-initialized");
  if (!existsSync(initialized)) {
    if (state.source.config.presence === "present") {
      writeFileSync(join(root, "config.json"), state.source.config.content, { mode: 0o600 });
    }
    if (state.source.projectMap.presence === "present") {
      writeFileSync(join(root, "map.json"), state.source.projectMap.content, { mode: 0o600 });
    }
    atomicStateWrite(initialized, "initialized");
  }
  const driver = fixtureDriver(HOME);
  const coordinator = new BackendPublicationCoordinator({
    homeDir: HOME,
    driver,
    observer: (event) => crashAt(event),
  });
  let journal = await coordinator.recoverPending(
    MODE?.includes("abort") === true ? { disposition: "abort" } : {},
  );
  if (journal === null) {
    journal = await coordinator.prepare({
      publicationId: PUBLICATION,
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: state,
      projects: [
        { localProjectId: LOCAL_B, remoteProjectId: REMOTE_B, evidenceSha256: "2".repeat(64) },
        { localProjectId: LOCAL_A, remoteProjectId: REMOTE_A, evidenceSha256: "1".repeat(64) },
      ],
    });
  }
  if (
    (MODE === "abort-crash" || MODE === "abort-expiry-crash")
    && journal.phase !== "aborted"
  ) {
    let stopped = false;
    const staging = new BackendPublicationCoordinator({
      homeDir: HOME,
      driver,
      observer: (event) => {
        crashAt(event);
        if (!stopped && event === "after-config-publish") {
          stopped = true;
          throw new Error("begin abort fixture");
        }
      },
    });
    try {
      await staging.resume();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "begin abort fixture") throw error;
    }
    journal = await staging.abort();
  } else if (MODE?.includes("abort") === true) {
    if (journal.phase !== "aborted") journal = await coordinator.abort();
  } else if (journal.phase !== "completed") {
    journal = await coordinator.resume();
  }
  const outcome = MODE?.includes("abort") === true ? "aborted" : "completed";
  expect(journal.phase).toBe(outcome);
  expect(captureBackendPublicationState(HOME)).toEqual(
    backendPublicationMaterialWitness(state)[outcome === "completed" ? "target" : "source"],
  );
  if (outcome === "completed") {
    expect(existsSync(join(root, "backend-publication-retained"))).toBe(true);
    expect(existsSync(join(root, "backend-publication-material", `${PUBLICATION}.json`))).toBe(true);
  } else {
    expect(existsSync(join(root, "backend-publication-aborted"))).toBe(true);
    expect(existsSync(join(root, "backend-publication-material", `${PUBLICATION}.json`))).toBe(false);
  }
  await coordinator.recoverPending(
    outcome === "aborted" ? { disposition: "abort" } : {},
  );
  const terminalBackend = outcome === "completed" ? "postgresql" : "sqlite";
  const configPath = join(root, "config.json");
  const configContent = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  expect(() => assertBackendPublicationConfigMutation(
    configPath,
    terminalBackend,
    terminalBackend,
    configContent,
    configContent,
  )).not.toThrow();
  const mapPath = join(root, "map.json");
  const mapContent = existsSync(mapPath) ? readFileSync(mapPath, "utf8") : null;
  expect(() => assertBackendPublicationProjectMapMutation(
    mapContent === null ? {} : JSON.parse(mapContent),
    HOME,
    mapContent,
  )).not.toThrow();
});
