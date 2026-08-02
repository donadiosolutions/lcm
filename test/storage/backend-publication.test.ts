import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceBackendPublication,
  assertBackendPublicationConfigAccess,
  assertBackendPublicationConfigMutation,
  assertBackendPublicationConsumerAccess,
  assertBackendPublicationProjectMapAccess,
  assertBackendPublicationProjectMapMutation,
  backendPublicationCanonicalSha256,
  backendPublicationConfigSha256,
  backendPublicationDirectory,
  backendPublicationFenceRecord,
  backendPublicationHistoryDirectory,
  backendPublicationJournalPath,
  backendPublicationProjectMapSha256,
  BackendPublicationJournalError,
  BackendPublicationCoordinator,
  backendPublicationMaterialWitness,
  captureBackendPublicationState,
  prepareBackendPublication,
  readBackendPublicationJournal,
  withBackendPublicationPermit,
  withBackendPublicationConfigLock,
  type BackendPublicationDriver,
  type BackendPublicationFenceRecord,
  type BackendPublicationRecoveryFile,
  type BackendPublicationRecoveryMaterial,
} from "../../src/storage/backend-publication.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import {
  applyBackendPublicationConfigFile,
  setConfigValue,
} from "../../src/config-manager.js";
import {
  loadStoredConfigProjection,
  loadStoredLlmRequestPolicyConfig,
} from "../../src/config-projection.js";
import {
  applyBackendPublicationProjectMapFile,
  readProjectMapSnapshot,
} from "../../src/project-map.js";
import { selectStorageBackend } from "../../src/storage/backend.js";
import { createStorageBackendFactory } from "../../src/storage/factory.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";

const LOCAL_A = "a".repeat(64);
const LOCAL_B = "b".repeat(64);
const REMOTE_A = "018f0000-0000-7000-8000-000000000001";
const REMOTE_B = "018f0000-0000-7000-8000-000000000002";
const REMOTE_C = "018f0000-0000-7000-8000-000000000004";
const MACHINE = "018f0000-0000-7000-8000-000000000003";
const EVIDENCE_A = "1".repeat(64);
const EVIDENCE_B = "2".repeat(64);
const CONFIG_AFTER_CONTENT = '{"storage":{"backend":"postgresql"}}\n';
const CONFIG_AFTER = createHash("sha256").update(CONFIG_AFTER_CONTENT).digest("hex");
const MAP_AFTER_CONTENT = '{"next":true}\n';
const MAP_AFTER = backendPublicationCanonicalSha256({ next: true });
const PUBLICATION = "migration-generation-1";
const CREATED = new Date("2026-08-01T00:00:00.000Z");

const homes: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "lcm-publication-test-"));
  homes.push(path);
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

function prepare(homeDir: string) {
  return prepareBackendPublication({
    publicationId: PUBLICATION,
    sourceBackend: "sqlite",
    targetBackend: "postgresql",
    expectedConfigSha256: backendPublicationConfigSha256(homeDir),
    expectedProjectMapSha256: backendPublicationProjectMapSha256(homeDir),
    intendedConfigSha256: CONFIG_AFTER,
    intendedProjectMapSha256: MAP_AFTER,
    projects: [
      { localProjectId: LOCAL_B, remoteProjectId: REMOTE_B, evidenceSha256: EVIDENCE_B },
      { localProjectId: LOCAL_A, remoteProjectId: REMOTE_A, evidenceSha256: EVIDENCE_A },
    ],
    now: CREATED,
    homeDir,
  });
}

function fence(
  remoteProjectId: string,
  evidenceSha256: string,
  token: string,
  releasedAt: string | null = null,
): BackendPublicationFenceRecord {
  return {
    projectId: remoteProjectId,
    machineId: MACHINE,
    publicationId: PUBLICATION,
    targetBackend: "postgresql",
    evidenceSha256,
    fencingToken: token,
    acquiredAt: "2026-08-01T00:00:01.000Z",
    renewedAt: "2026-08-01T00:00:01.000Z",
    expiresAt: "2026-08-01T00:10:01.000Z",
    releasedAt,
    databaseExpired: false,
  };
}

function guarded(homeDir: string) {
  const initial = prepare(homeDir);
  return guardedFrom(initial, homeDir);
}

function acquiringFrom(initial: ReturnType<typeof prepare>, homeDir: string) {
  return advanceBackendPublication({
    publicationId: PUBLICATION,
    expectedChecksumSha256: initial.checksumSha256,
    phase: "acquiring",
    projects: initial.projects.map((project, index) => ({
      ...project,
      fence: fence(project.remoteProjectId, project.evidenceSha256, String(index + 1)),
    })),
    now: new Date("2026-08-01T00:00:02.000Z"),
    homeDir,
  });
}

describe("backend publication journal", () => {
  it("binds raw config bytes and canonical recursive project-map semantics", () => {
    const homeDir = home();
    const root = join(homeDir, ".lcm");
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, "config.json"), "{ }\n", { mode: 0o600 });
    writeFileSync(join(root, "map.json"), '{"b":[2,{"d":null,"c":true}],"a":1}\n', {
      mode: 0o600,
    });
    expect(backendPublicationConfigSha256(homeDir)).toBe(
      createHash("sha256").update("{ }\n").digest("hex"),
    );
    expect(backendPublicationProjectMapSha256(homeDir)).toBe(
      backendPublicationCanonicalSha256({ a: 1, b: [2, { c: true, d: null }] }),
    );

    writeFileSync(join(root, "map.json"), "{", { mode: 0o600 });
    expect(() => backendPublicationProjectMapSha256(homeDir))
      .toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    rmSync(join(root, "map.json"));
    const outside = join(homeDir, "outside.json");
    writeFileSync(outside, "{}", { mode: 0o600 });
    rmSync(join(root, "config.json"));
    symlinkSync(outside, join(root, "config.json"));
    expect(() => backendPublicationConfigSha256(homeDir)).toThrow();
    expect(backendPublicationCanonicalSha256("scalar")).toMatch(/^[0-9a-f]{64}$/u);
    expect(backendPublicationFenceRecord({
      projectId: REMOTE_A,
      machineId: MACHINE,
      publicationId: PUBLICATION,
      targetBackend: "postgresql",
      evidenceSha256: EVIDENCE_A,
      fencingToken: 42n,
      acquiredAt: "2026-08-01T00:00:00.000Z",
      renewedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:01:00.000Z",
      releasedAt: null,
      databaseExpired: false,
    })).toMatchObject({ fencingToken: "42" });
  });

  it("creates one private checksummed sorted prepare record and fails consumers closed", async () => {
    const homeDir = home();
    const journal = prepare(homeDir);

    expect(journal.projects.map(({ localProjectId }) => localProjectId))
      .toEqual([LOCAL_A, LOCAL_B]);
    expect(journal.phase).toBe("prepared");
    expect(lstatSync(backendPublicationDirectory(homeDir)).mode & 0o777).toBe(0o700);
    expect(lstatSync(backendPublicationJournalPath(homeDir))).toMatchObject({ nlink: 1 });
    expect(lstatSync(backendPublicationJournalPath(homeDir)).mode & 0o777).toBe(0o600);
    expect(readBackendPublicationJournal(homeDir)).toEqual(journal);
    expect(() => prepare(homeDir))
      .toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    expect(() => assertBackendPublicationConsumerAccess({ homeDir }))
      .toThrowError(expect.objectContaining({ reason: "unresolved-publication" }));

    await expect(withBackendPublicationPermit({
      publicationId: PUBLICATION,
      expectedChecksumSha256: journal.checksumSha256,
      access: "read-recovery",
      homeDir,
    }, () => {
      assertBackendPublicationConsumerAccess({ homeDir });
      return "permitted";
    })).resolves.toBe("permitted");
    await expect(withBackendPublicationPermit({
      publicationId: PUBLICATION,
      expectedChecksumSha256: journal.checksumSha256,
      access: "read-recovery",
      homeDir,
    }, () => withBackendPublicationPermit({
      publicationId: PUBLICATION,
      expectedChecksumSha256: journal.checksumSha256,
      access: "read-recovery",
      homeDir,
    }, () => "nested"))).resolves.toBe("nested");
  });

  it("requires exact predecessor checksums and invalidates stale recovery permits", async () => {
    const homeDir = home();
    const initial = prepare(homeDir);
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: "0".repeat(64),
      phase: "guarded",
      homeDir,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    expect(readBackendPublicationJournal(homeDir)).toEqual(initial);

    const advanced = guardedFrom(initial, homeDir);
    await expect(withBackendPublicationPermit({
      publicationId: PUBLICATION,
      expectedChecksumSha256: initial.checksumSha256,
      access: "read-recovery",
      homeDir,
    }, () => undefined)).rejects.toMatchObject({
      reason: "permit-mismatch",
    });
    expect(readBackendPublicationJournal(homeDir)).toEqual(advanced);
  });

  it("freezes project coverage and rejects early local witnesses", () => {
    const homeDir = home();
    const initial = prepare(homeDir);
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: initial.checksumSha256,
      phase: "guarded",
      projects: [{
        ...initial.projects[0],
        fence: fence(REMOTE_A, initial.projects[0].evidenceSha256, "1"),
      }],
      homeDir,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: initial.checksumSha256,
      phase: "guarded",
      publishedProjectMapSha256: MAP_AFTER,
      homeDir,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    expect(readBackendPublicationJournal(homeDir)).toEqual(initial);
  });

  it("scopes mutation permits to one phase, digest, and awaited lifetime", async () => {
    const homeDir = home();
    const initial = prepare(homeDir);
    expect(() => assertBackendPublicationConfigMutation(
      join(homeDir, ".lcm", "config.json"),
      "sqlite",
      "sqlite",
      "{}",
    )).toThrowError(expect.objectContaining({ reason: "permit-mismatch" }));
    expect(() => assertBackendPublicationProjectMapMutation({}, homeDir))
      .toThrowError(expect.objectContaining({ reason: "permit-mismatch" }));
    await expect(withBackendPublicationPermit({
      publicationId: PUBLICATION,
      expectedChecksumSha256: initial.checksumSha256,
      access: "publish-project-map",
      stateSha256: MAP_AFTER,
      homeDir,
    }, () => undefined)).rejects.toMatchObject({ reason: "permit-mismatch" });

    const journal = guardedFrom(initial, homeDir);
    let detached!: () => void;
    await withBackendPublicationPermit({
      publicationId: PUBLICATION,
      expectedChecksumSha256: journal.checksumSha256,
      access: "publish-project-map",
      stateSha256: MAP_AFTER,
      homeDir,
    }, async () => {
      expect(() => assertBackendPublicationProjectMapMutation(
        { next: true },
        homeDir,
      )).not.toThrow();
      expect(() => assertBackendPublicationProjectMapMutation(
        { next: false },
        homeDir,
      )).toThrowError(expect.objectContaining({ reason: "permit-mismatch" }));
      detached = () => assertBackendPublicationProjectMapMutation(
        { next: true },
        homeDir,
      );
      await Promise.resolve();
    });
    expect(detached).toThrowError(expect.objectContaining({ reason: "permit-mismatch" }));

    const noJournalHome = home();
    await expect(withBackendPublicationPermit({
      publicationId: PUBLICATION,
      expectedChecksumSha256: initial.checksumSha256,
      access: "read-recovery",
      homeDir: noJournalHome,
    }, () => undefined)).rejects.toMatchObject({ reason: "permit-mismatch" });
  });

  it("keeps no-journal PostgreSQL parseable but untrusted and rejects config bypass", () => {
    const homeDir = home();
    const lcmRoot = join(homeDir, ".lcm");
    mkdirSync(lcmRoot, { mode: 0o700 });
    const configPath = join(lcmRoot, "config.json");
    writeFileSync(configPath, '{"storage":{"backend":"sqlite"}}\n', { mode: 0o600 });
    vi.stubEnv("HOME", homeDir);
    const before = readFileSync(configPath, "utf8");
    expect(() => setConfigValue({
      configPath,
      path: "storage.backend",
      value: "postgresql",
      env: {
        ...process.env,
        LCM_POSTGRES_URL: "postgresql://lcm:test@localhost/lcm",
        LCM_POSTGRES_CA_FILE: import.meta.filename,
      },
    })).toThrowError(expect.objectContaining({ reason: "publication-evidence-missing" }));
    expect(readFileSync(configPath, "utf8")).toBe(before);

    const manual = '{"storage":{"backend":"postgresql"}}\n';
    writeFileSync(configPath, manual, { mode: 0o600 });
    expect(() => loadStoredConfigProjection(configPath))
      .toThrowError(expect.objectContaining({ reason: "publication-evidence-missing" }));
    expect(() => assertBackendPublicationConfigAccess(
      configPath,
      "postgresql",
      manual,
    )).toThrowError(expect.objectContaining({ reason: "publication-evidence-missing" }));
    expect(() => selectStorageBackend({ backend: "postgresql" }))
      .toThrowError(expect.objectContaining({ reason: "publication-evidence-missing" }));
    expect(() => assertBackendPublicationConfigMutation(
      configPath,
      "postgresql",
      "sqlite",
      '{"storage":{"backend":"sqlite"}}\n',
    )).not.toThrow();
  });

  it("retains a durably renamed successor when a post-rename crash seam throws", () => {
    const homeDir = home();
    const initial = prepare(homeDir);
    const acquiring = acquiringFrom(initial, homeDir);
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: acquiring.checksumSha256,
      phase: "guarded",
      homeDir,
      observer: (event) => {
        if (event === "after-journal-rename") throw new Error("simulated crash");
      },
    })).toThrow("simulated crash");
    expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "guarded" });
    expect(() => assertBackendPublicationConsumerAccess({ homeDir }))
      .toThrowError(expect.objectContaining({ reason: "unresolved-publication" }));
  });

  it("distinguishes pre-rename, pre-directory-fsync, and post-fsync crash windows", () => {
    const homeDir = home();
    const initial = prepare(homeDir);
    const acquiring = acquiringFrom(initial, homeDir);

    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: acquiring.checksumSha256,
      phase: "guarded",
      homeDir,
      observer: (event) => {
        if (event === "before-journal-rename") throw new Error("before rename");
      },
    })).toThrow("before rename");
    expect(readBackendPublicationJournal(homeDir)).toEqual(acquiring);
    expect(readdirSync(backendPublicationDirectory(homeDir))).toEqual(["journal.json"]);

    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: acquiring.checksumSha256,
      phase: "guarded",
      homeDir,
      observer: (event) => {
        if (event === "before-journal-directory-fsync") {
          throw new Error("before directory fsync");
        }
      },
    })).toThrow("before directory fsync");
    const guardedJournal = readBackendPublicationJournal(homeDir)!;
    expect(guardedJournal.phase).toBe("guarded");

    writeFileSync(join(homeDir, ".lcm", "map.json"), MAP_AFTER_CONTENT, { mode: 0o600 });
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: guardedJournal.checksumSha256,
      phase: "map-published",
      publishedProjectMapSha256: MAP_AFTER,
      homeDir,
      observer: (event) => {
        if (event === "after-journal-directory-fsync") throw new Error("after fsync");
      },
    })).toThrow("after fsync");
    expect(readBackendPublicationJournal(homeDir)).toMatchObject({
      phase: "map-published",
      publishedProjectMapSha256: MAP_AFTER,
    });
  });

  it("recovers exact map and config successor crash gaps through the durable abort path", async () => {
    const mapGapHome = home();
    let mapGap = guarded(mapGapHome);
    await withBackendPublicationPermit({
      publicationId: PUBLICATION,
      expectedChecksumSha256: mapGap.checksumSha256,
      access: "publish-project-map",
      stateSha256: MAP_AFTER,
      homeDir: mapGapHome,
    }, () => {
      assertBackendPublicationProjectMapMutation({ next: true }, mapGapHome);
      writeFileSync(join(mapGapHome, ".lcm", "map.json"), MAP_AFTER_CONTENT, {
        mode: 0o600,
      });
    });
    mapGap = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: mapGap.checksumSha256,
      phase: "abort-prepared",
      homeDir: mapGapHome,
    });
    mapGap = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: mapGap.checksumSha256,
      phase: "config-restored",
      publishedConfigSha256: mapGap.expectedConfigSha256,
      homeDir: mapGapHome,
    });
    await withBackendPublicationPermit({
      publicationId: PUBLICATION,
      expectedChecksumSha256: mapGap.checksumSha256,
      access: "restore-project-map",
      stateSha256: mapGap.expectedProjectMapSha256,
      homeDir: mapGapHome,
    }, () => {
      assertBackendPublicationProjectMapMutation({}, mapGapHome);
      writeFileSync(join(mapGapHome, ".lcm", "map.json"), "{}\n", { mode: 0o600 });
    });
    mapGap = finishAbortFromConfigRestored(mapGap, mapGapHome);
    expect(mapGap.phase).toBe("aborted");

    const configGapHome = home();
    let configGap = guarded(configGapHome);
    writeFileSync(join(configGapHome, ".lcm", "map.json"), MAP_AFTER_CONTENT, {
      mode: 0o600,
    });
    configGap = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: configGap.checksumSha256,
      phase: "map-published",
      publishedProjectMapSha256: MAP_AFTER,
      homeDir: configGapHome,
    });
    await withBackendPublicationPermit({
      publicationId: PUBLICATION,
      expectedChecksumSha256: configGap.checksumSha256,
      access: "publish-config",
      stateSha256: CONFIG_AFTER,
      homeDir: configGapHome,
    }, () => {
      assertBackendPublicationConfigMutation(
        join(configGapHome, ".lcm", "config.json"),
        "sqlite",
        "postgresql",
        CONFIG_AFTER_CONTENT,
      );
      writeFileSync(join(configGapHome, ".lcm", "config.json"), CONFIG_AFTER_CONTENT, {
        mode: 0o600,
      });
    });
    configGap = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: configGap.checksumSha256,
      phase: "abort-prepared",
      homeDir: configGapHome,
    });
    await withBackendPublicationPermit({
      publicationId: PUBLICATION,
      expectedChecksumSha256: configGap.checksumSha256,
      access: "restore-config",
      stateSha256: configGap.expectedConfigSha256,
      homeDir: configGapHome,
    }, () => {
      assertBackendPublicationConfigMutation(
        join(configGapHome, ".lcm", "config.json"),
        "postgresql",
        "sqlite",
        "{}",
      );
      rmSync(join(configGapHome, ".lcm", "config.json"));
    });
    configGap = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: configGap.checksumSha256,
      phase: "config-restored",
      publishedConfigSha256: configGap.expectedConfigSha256,
      homeDir: configGapHome,
    });
    writeFileSync(join(configGapHome, ".lcm", "map.json"), "{}\n", { mode: 0o600 });
    configGap = finishAbortFromConfigRestored(configGap, configGapHome);
    expect(configGap.phase).toBe("aborted");
  });

  it("rejects a journal pathname replacement after descriptor-bound reading", () => {
    const terminalHome = home();
    let terminal = prepare(terminalHome);
    terminal = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: terminal.checksumSha256,
      phase: "abort-prepared",
      homeDir: terminalHome,
    });
    terminal = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: terminal.checksumSha256,
      phase: "config-restored",
      publishedConfigSha256: terminal.expectedConfigSha256,
      homeDir: terminalHome,
    });
    terminal = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: terminal.checksumSha256,
      phase: "map-restored",
      publishedProjectMapSha256: terminal.expectedProjectMapSha256,
      homeDir: terminalHome,
    });
    terminal = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: terminal.checksumSha256,
      phase: "abort-releasing",
      homeDir: terminalHome,
    });
    advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: terminal.checksumSha256,
      phase: "aborted",
      homeDir: terminalHome,
    });
    const unresolvedHome = home();
    prepare(unresolvedHome);

    expect(() => readBackendPublicationJournal(terminalHome, () => {
      renameSync(
        backendPublicationJournalPath(unresolvedHome),
        backendPublicationJournalPath(terminalHome),
      );
    })).toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));
    expect(() => assertBackendPublicationConsumerAccess({ homeDir: terminalHome }))
      .toThrowError(expect.objectContaining({ reason: "unresolved-publication" }));
  });

  it("rejects descriptor content drift and growth beyond the authenticated bound", () => {
    const changedHome = home();
    prepare(changedHome);
    expect(() => readBackendPublicationJournal(changedHome, () => {
      appendFileSync(backendPublicationJournalPath(changedHome), " ");
    })).toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));

    const grownHome = home();
    prepare(grownHome);
    expect(() => readBackendPublicationJournal(grownHome, undefined, () => {
      appendFileSync(
        backendPublicationJournalPath(grownHome),
        "x".repeat(1024 * 1024),
      );
    })).toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));
  });

  it("blocks config, projection, project-map, selector, and factory consumers until exact recovery", async () => {
    const homeDir = home();
    const lcmRoot = join(homeDir, ".lcm");
    mkdirSync(lcmRoot, { mode: 0o700 });
    const configPath = join(lcmRoot, "config.json");
    writeFileSync(configPath, '{"storage":{"backend":"sqlite"}}\n', { mode: 0o600 });
    writeFileSync(join(lcmRoot, "map.json"), "{}\n", { mode: 0o600 });
    const journal = prepare(homeDir);
    vi.stubEnv("HOME", homeDir);

    for (const consumer of [
      () => loadDaemonConfig(configPath),
      () => loadStoredConfigProjection(configPath),
      () => loadStoredLlmRequestPolicyConfig(configPath),
      () => setConfigValue({ configPath, path: "daemon.port", value: "3738", json: true }),
      () => readProjectMapSnapshot(homeDir),
      () => selectStorageBackend({ backend: "sqlite" }),
      () => createStorageBackendFactory({ backend: "sqlite" }),
    ]) {
      expect(consumer).toThrowError(expect.objectContaining({
        reason: "unresolved-publication",
      }));
    }

    await withBackendPublicationPermit({
      publicationId: PUBLICATION,
      expectedChecksumSha256: journal.checksumSha256,
      access: "read-recovery",
      homeDir,
    }, async () => {
      expect(loadDaemonConfig(configPath).storage.backend).toBe("sqlite");
      expect(loadStoredConfigProjection(configPath).storage.backend).toBe("sqlite");
      expect(readProjectMapSnapshot(homeDir)).toEqual({});
      expect(selectStorageBackend({ backend: "sqlite" })).toEqual({ backend: "sqlite" });
      expect(createStorageBackendFactory({ backend: "sqlite" }).backend).toBe("sqlite");
    });
  });

  it("completes and aborts only with released fences and enforces the selected backend", () => {
    const completedHome = home();
    let journal = guarded(completedHome);
    writeFileSync(join(completedHome, ".lcm", "map.json"), MAP_AFTER_CONTENT, {
      mode: 0o600,
    });
    journal = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: journal.checksumSha256,
      phase: "map-published",
      publishedProjectMapSha256: MAP_AFTER,
      homeDir: completedHome,
    });
    expect(() => assertBackendPublicationConfigMutation(
      join(completedHome, ".lcm", "config.json"),
      "sqlite",
      "postgresql",
      CONFIG_AFTER_CONTENT,
    )).toThrowError(expect.objectContaining({ reason: "permit-mismatch" }));
    writeFileSync(join(completedHome, ".lcm", "config.json"), CONFIG_AFTER_CONTENT, {
      mode: 0o600,
    });
    journal = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: journal.checksumSha256,
      phase: "config-published",
      publishedConfigSha256: CONFIG_AFTER,
      homeDir: completedHome,
    });
    const releasedAt = "2026-08-01T00:01:00.000Z";
    journal = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: journal.checksumSha256,
      phase: "releasing",
      homeDir: completedHome,
    });
    journal = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: journal.checksumSha256,
      phase: "released",
      projects: journal.projects.map((project) => ({
        ...project,
        fence: { ...project.fence!, releasedAt },
      })),
      homeDir: completedHome,
    });
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: journal.checksumSha256,
      phase: "completed",
      projects: journal.projects.map((project, index) => index === 0
        ? {
          ...project,
          fence: { ...project.fence!, releasedAt: "2026-08-01T00:03:00.000Z" },
        }
        : project),
      homeDir: completedHome,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    journal = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: journal.checksumSha256,
      phase: "completed",
      homeDir: completedHome,
    });
    expect(journal.phase).toBe("completed");
    expect(() => assertBackendPublicationConfigMutation(
      join(completedHome, ".lcm", "config.json"),
      "postgresql",
      "postgresql",
      CONFIG_AFTER_CONTENT,
    )).not.toThrow();
    expect(() => assertBackendPublicationProjectMapMutation(
      { next: true },
      completedHome,
    )).not.toThrow();
    expect(() => assertBackendPublicationConsumerAccess({
      backend: "postgresql",
      homeDir: completedHome,
    })).not.toThrow();
    expect(() => assertBackendPublicationConsumerAccess({
      backend: "sqlite",
      homeDir: completedHome,
    })).toThrowError(expect.objectContaining({ reason: "backend-mismatch" }));
    vi.stubEnv("HOME", completedHome);
    expect(() => selectStorageBackend({ backend: "postgresql" }))
      .toThrowError(expect.objectContaining({ name: "StorageBackendUnavailableError" }));
    expect(createStorageBackendFactory({
      backend: "postgresql",
      postgresql: {
        poolMax: 1,
        connectionTimeoutMs: 1,
        idleTimeoutMs: 1,
        statementTimeoutMs: 1,
        url: "postgresql://redacted@db.invalid/lcm",
        caFile: "/private/ca.pem",
      },
    }).backend).toBe("postgresql");

    const lcmRoot = join(completedHome, ".lcm");
    expect(() => setConfigValue({
      configPath: join(lcmRoot, "config.json"),
      path: "storage.backend",
      value: "sqlite",
    })).toThrowError(expect.objectContaining({ reason: "backend-mismatch" }));
    expect(readFileSync(join(lcmRoot, "config.json"), "utf8"))
      .toBe('{"storage":{"backend":"postgresql"}}\n');

    const abortedHome = home();
    let aborted = prepare(abortedHome);
    aborted = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: aborted.checksumSha256,
      phase: "abort-prepared",
      homeDir: abortedHome,
    });
    aborted = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: aborted.checksumSha256,
      phase: "config-restored",
      publishedConfigSha256: aborted.expectedConfigSha256,
      homeDir: abortedHome,
    });
    aborted = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: aborted.checksumSha256,
      phase: "map-restored",
      publishedProjectMapSha256: aborted.expectedProjectMapSha256,
      homeDir: abortedHome,
    });
    aborted = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: aborted.checksumSha256,
      phase: "abort-releasing",
      homeDir: abortedHome,
    });
    aborted = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: aborted.checksumSha256,
      phase: "aborted",
      homeDir: abortedHome,
    });
    expect(aborted.phase).toBe("aborted");
    expect(() => assertBackendPublicationConfigMutation(
      join(abortedHome, ".lcm", "config.json"),
      "sqlite",
      "sqlite",
      "{}",
    )).not.toThrow();
    expect(() => assertBackendPublicationConfigMutation(
      join(abortedHome, ".lcm", "config.json"),
      "sqlite",
      "postgresql",
      CONFIG_AFTER_CONTENT,
    )).toThrowError(expect.objectContaining({ reason: "backend-mismatch" }));
    expect(() => assertBackendPublicationProjectMapMutation({}, abortedHome))
      .not.toThrow();
    expect(() => assertBackendPublicationConsumerAccess({
      backend: "sqlite",
      homeDir: abortedHome,
    })).not.toThrow();

    const successor = prepareBackendPublication({
      publicationId: "migration-generation-2",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      expectedConfigSha256: backendPublicationConfigSha256(abortedHome),
      expectedProjectMapSha256: backendPublicationProjectMapSha256(abortedHome),
      intendedConfigSha256: CONFIG_AFTER,
      intendedProjectMapSha256: MAP_AFTER,
      projects: [
        { localProjectId: LOCAL_A, remoteProjectId: REMOTE_A, evidenceSha256: EVIDENCE_A },
      ],
      homeDir: abortedHome,
    });
    expect(successor.publicationId).toBe("migration-generation-2");
    expect(readdirSync(backendPublicationHistoryDirectory(abortedHome)))
      .toEqual([`${PUBLICATION}-${aborted.checksumSha256}.json`]);
  });

  it("rejects malformed, mode-unsafe, hard-linked, and symlink journals", () => {
    const malformedHome = home();
    prepare(malformedHome);
    writeFileSync(backendPublicationJournalPath(malformedHome), "{}\n", { mode: 0o600 });
    expect(() => readBackendPublicationJournal(malformedHome))
      .toThrowError(BackendPublicationJournalError);

    const modeHome = home();
    prepare(modeHome);
    chmodSync(backendPublicationJournalPath(modeHome), 0o644);
    expect(() => readBackendPublicationJournal(modeHome))
      .toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));

    const hardlinkHome = home();
    prepare(hardlinkHome);
    linkSync(
      backendPublicationJournalPath(hardlinkHome),
      join(backendPublicationDirectory(hardlinkHome), "other.json"),
    );
    expect(() => readBackendPublicationJournal(hardlinkHome))
      .toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));

    const symlinkHome = home();
    prepare(symlinkHome);
    const content = readFileSync(backendPublicationJournalPath(symlinkHome));
    rmSync(backendPublicationJournalPath(symlinkHome));
    const outside = join(symlinkHome, "outside.json");
    writeFileSync(outside, content, { mode: 0o600 });
    symlinkSync(outside, backendPublicationJournalPath(symlinkHome));
    expect(() => readBackendPublicationJournal(symlinkHome))
      .toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));
  });

  it("rejects unsafe roots without normalizing them and authenticates retained history", () => {
    const absentRootHome = home();
    expect(() => assertBackendPublicationConsumerAccess({
      backend: "sqlite",
      homeDir: absentRootHome,
    })).not.toThrow();
    expect(statSync(join(absentRootHome, ".lcm")).mode & 0o777).toBe(0o700);

    const wrongModeHome = home();
    const wrongModeRoot = join(wrongModeHome, ".lcm");
    mkdirSync(wrongModeRoot, { mode: 0o755 });
    chmodSync(wrongModeRoot, 0o755);
    expect(() => prepare(wrongModeHome))
      .toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));
    expect(statSync(wrongModeRoot).mode & 0o777).toBe(0o755);

    const legacyFileHome = home();
    writeFileSync(join(legacyFileHome, ".lcm"), "not a directory", { mode: 0o600 });
    expect(() => assertBackendPublicationConsumerAccess({ homeDir: legacyFileHome }))
      .toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));

    const fileHome = home();
    writeFileSync(join(fileHome, ".lcm"), "not a directory", { mode: 0o600 });
    expect(() => prepareBackendPublication({
      publicationId: PUBLICATION,
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      expectedConfigSha256: createHash("sha256").update("{}").digest("hex"),
      expectedProjectMapSha256: backendPublicationCanonicalSha256({}),
      intendedConfigSha256: CONFIG_AFTER,
      intendedProjectMapSha256: MAP_AFTER,
      projects: [{
        localProjectId: LOCAL_A,
        remoteProjectId: REMOTE_A,
        evidenceSha256: EVIDENCE_A,
      }],
      homeDir: fileHome,
    }))
      .toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));

    const actualHome = home();
    mkdirSync(join(actualHome, ".lcm"), { mode: 0o700 });
    const linkParent = home();
    const linkedHome = join(linkParent, "linked-home");
    symlinkSync(actualHome, linkedHome);
    expect(() => prepare(linkedHome))
      .toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));

    const unsafePublicationHome = home();
    mkdirSync(join(unsafePublicationHome, ".lcm", "backend-publication"), {
      mode: 0o755,
      recursive: true,
    });
    chmodSync(join(unsafePublicationHome, ".lcm"), 0o700);
    chmodSync(backendPublicationDirectory(unsafePublicationHome), 0o755);
    expect(() => readBackendPublicationJournal(unsafePublicationHome))
      .toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));

    const retryArchiveHome = home();
    const retryTerminal = abortPreparedPublication(retryArchiveHome);
    const retryHistory = backendPublicationHistoryDirectory(retryArchiveHome);
    mkdirSync(retryHistory, { mode: 0o700 });
    writeFileSync(
      join(retryHistory, `${PUBLICATION}-${retryTerminal.checksumSha256}.json`),
      readFileSync(backendPublicationJournalPath(retryArchiveHome)),
      { mode: 0o600 },
    );
    expect(() => prepareBackendPublication({
      publicationId: "migration-generation-2",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      expectedConfigSha256: backendPublicationConfigSha256(retryArchiveHome),
      expectedProjectMapSha256: backendPublicationProjectMapSha256(retryArchiveHome),
      intendedConfigSha256: CONFIG_AFTER,
      intendedProjectMapSha256: MAP_AFTER,
      projects: [{
        localProjectId: LOCAL_A,
        remoteProjectId: REMOTE_A,
        evidenceSha256: EVIDENCE_A,
      }],
      homeDir: retryArchiveHome,
    })).not.toThrow();

    const historyHome = home();
    const terminal = abortPreparedPublication(historyHome);
    prepareBackendPublication({
      publicationId: "migration-generation-2",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      expectedConfigSha256: backendPublicationConfigSha256(historyHome),
      expectedProjectMapSha256: backendPublicationProjectMapSha256(historyHome),
      intendedConfigSha256: CONFIG_AFTER,
      intendedProjectMapSha256: MAP_AFTER,
      projects: [{
        localProjectId: LOCAL_A,
        remoteProjectId: REMOTE_A,
        evidenceSha256: EVIDENCE_A,
      }],
      homeDir: historyHome,
    });
    const historyPath = join(
      backendPublicationHistoryDirectory(historyHome),
      `${PUBLICATION}-${terminal.checksumSha256}.json`,
    );
    expect(readBackendPublicationJournal(historyHome)?.publicationId)
      .toBe("migration-generation-2");
    writeFileSync(historyPath, "{}\n", { mode: 0o600 });
    expect(() => readBackendPublicationJournal(historyHome))
      .toThrowError(BackendPublicationJournalError);

    const nonTerminalHistoryHome = home();
    const nonTerminal = prepare(nonTerminalHistoryHome);
    const nonTerminalHistory = backendPublicationHistoryDirectory(nonTerminalHistoryHome);
    mkdirSync(nonTerminalHistory, { mode: 0o700 });
    writeFileSync(
      join(nonTerminalHistory, `${PUBLICATION}-${nonTerminal.checksumSha256}.json`),
      readFileSync(backendPublicationJournalPath(nonTerminalHistoryHome)),
      { mode: 0o600 },
    );
    expect(() => readBackendPublicationJournal(nonTerminalHistoryHome))
      .toThrowError(expect.objectContaining({ reason: "malformed-journal" }));

    const unknownHistoryHome = home();
    prepare(unknownHistoryHome);
    const unknownHistory = backendPublicationHistoryDirectory(unknownHistoryHome);
    mkdirSync(unknownHistory, { mode: 0o700 });
    writeFileSync(join(unknownHistory, "unknown"), "x", { mode: 0o600 });
    expect(() => readBackendPublicationJournal(unknownHistoryHome))
      .toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));

    const modeHistoryHome = home();
    prepare(modeHistoryHome);
    const modeHistory = backendPublicationHistoryDirectory(modeHistoryHome);
    mkdirSync(modeHistory, { mode: 0o755 });
    chmodSync(modeHistory, 0o755);
    expect(() => readBackendPublicationJournal(modeHistoryHome))
      .toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));

    const boundedHistoryHome = home();
    prepare(boundedHistoryHome);
    const boundedHistory = backendPublicationHistoryDirectory(boundedHistoryHome);
    mkdirSync(boundedHistory, { mode: 0o700 });
    for (let index = 0; index < 1025; index += 1) {
      writeFileSync(join(boundedHistory, String(index)), "", { mode: 0o600 });
    }
    expect(() => readBackendPublicationJournal(boundedHistoryHome))
      .toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));

    const missingActiveHome = home();
    const missingTerminal = abortPreparedPublication(missingActiveHome);
    prepareBackendPublication({
      publicationId: "migration-generation-2",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      expectedConfigSha256: backendPublicationConfigSha256(missingActiveHome),
      expectedProjectMapSha256: backendPublicationProjectMapSha256(missingActiveHome),
      intendedConfigSha256: CONFIG_AFTER,
      intendedProjectMapSha256: MAP_AFTER,
      projects: [{
        localProjectId: LOCAL_A,
        remoteProjectId: REMOTE_A,
        evidenceSha256: EVIDENCE_A,
      }],
      homeDir: missingActiveHome,
    });
    expect(missingTerminal.phase).toBe("aborted");
    rmSync(backendPublicationJournalPath(missingActiveHome));
    expect(() => prepareBackendPublication({
      publicationId: "migration-generation-3",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      expectedConfigSha256: backendPublicationConfigSha256(missingActiveHome),
      expectedProjectMapSha256: backendPublicationProjectMapSha256(missingActiveHome),
      intendedConfigSha256: CONFIG_AFTER,
      intendedProjectMapSha256: MAP_AFTER,
      projects: [{
        localProjectId: LOCAL_A,
        remoteProjectId: REMOTE_A,
        evidenceSha256: EVIDENCE_A,
      }],
      homeDir: missingActiveHome,
    })).toThrowError(expect.objectContaining({ reason: "publication-evidence-missing" }));
    expect(() => assertBackendPublicationConsumerAccess({ homeDir: missingActiveHome }))
      .toThrowError(expect.objectContaining({ reason: "publication-evidence-missing" }));
    expect(() => assertBackendPublicationConfigMutation(
      join(missingActiveHome, ".lcm", "config.json"),
      "sqlite",
      "sqlite",
      "{}",
    )).toThrowError(expect.objectContaining({ reason: "publication-evidence-missing" }));
    expect(() => assertBackendPublicationProjectMapMutation({}, missingActiveHome))
      .toThrowError(expect.objectContaining({ reason: "publication-evidence-missing" }));
    writeFileSync(
      join(backendPublicationDirectory(missingActiveHome), "unknown"),
      "residue",
      { mode: 0o600 },
    );
    expect(() => readBackendPublicationJournal(missingActiveHome))
      .toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));
  });

  it("preflights exact history capacity and permits only an idempotent archive at the bound", async () => {
    const homeDir = home();
    const material = coordinatorMaterial();
    installRecoveryState(homeDir, material, "source");
    const terminal = abortPreparedPublication(homeDir);
    const terminalContent = readFileSync(backendPublicationJournalPath(homeDir), "utf8");
    const history = backendPublicationHistoryDirectory(homeDir);
    mkdirSync(history, { mode: 0o700 });

    const terminalVariant = (publicationId: string) => {
      const journal = JSON.parse(terminalContent) as Record<string, unknown>;
      journal.publicationId = publicationId;
      delete journal.checksumSha256;
      const checksumSha256 = createHash("sha256")
        .update(JSON.stringify(journal))
        .digest("hex");
      journal.checksumSha256 = checksumSha256;
      return {
        content: `${JSON.stringify(journal, null, 2)}\n`,
        filename: `${publicationId}-${checksumSha256}.json`,
      };
    };
    const syntheticPaths: string[] = [];
    for (let index = 0; index < 1023; index += 1) {
      const archived = terminalVariant(`history-${index}`);
      const path = join(history, archived.filename);
      writeFileSync(path, archived.content, { mode: 0o600 });
      syntheticPaths.push(path);
    }

    const prepareSuccessor = (publicationId: string) => prepareBackendPublication({
      publicationId,
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      expectedConfigSha256: backendPublicationConfigSha256(homeDir),
      expectedProjectMapSha256: backendPublicationProjectMapSha256(homeDir),
      intendedConfigSha256: CONFIG_AFTER,
      intendedProjectMapSha256: MAP_AFTER,
      projects: [{
        localProjectId: LOCAL_A,
        remoteProjectId: REMOTE_A,
        evidenceSha256: EVIDENCE_A,
      }],
      homeDir,
    });

    const successor = prepareSuccessor("capacity-generation-2");
    expect(successor.phase).toBe("prepared");
    expect(readdirSync(history)).toHaveLength(1024);
    expect(readdirSync(history)).toContain(`${PUBLICATION}-${terminal.checksumSha256}.json`);

    const activeTerminal = terminalVariant(successor.publicationId);
    writeFileSync(
      backendPublicationJournalPath(homeDir),
      activeTerminal.content,
      { mode: 0o600 },
    );
    const beforeRejectedPrepare = readFileSync(backendPublicationJournalPath(homeDir), "utf8");
    expect(() => prepareSuccessor("capacity-generation-3"))
      .toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    expect(readFileSync(backendPublicationJournalPath(homeDir), "utf8"))
      .toBe(beforeRejectedPrepare);
    expect(readdirSync(history)).toHaveLength(1024);

    const fake = fakePublicationDriver(homeDir, material);
    await expect(new BackendPublicationCoordinator({
      homeDir,
      driver: fake.driver,
    }).prepare(coordinatorInput(material))).rejects.toMatchObject({ reason: "unexpected-state" });
    expect(fake.calls).toEqual([]);

    rmSync(syntheticPaths[0]!);
    writeFileSync(join(history, activeTerminal.filename), activeTerminal.content, { mode: 0o600 });
    expect(readdirSync(history)).toHaveLength(1024);
    expect(() => prepareSuccessor("capacity-generation-3")).not.toThrow();
    expect(readdirSync(history)).toHaveLength(1024);
  });

  it("rejects malformed headers, projects, fences, checksums, and phase semantics", {
    timeout: 15_000,
  }, () => {
    const rejectPreparedMutation = (
      mutate: (journal: Record<string, unknown>) => void,
      recomputeChecksum = true,
    ): void => {
      const homeDir = home();
      prepare(homeDir);
      rewriteJournal(homeDir, mutate, recomputeChecksum);
      expect(() => readBackendPublicationJournal(homeDir))
        .toThrowError(BackendPublicationJournalError);
    };
    const project = (journal: Record<string, unknown>, index = 0) =>
      (journal.projects as Record<string, unknown>[])[index]!;

    for (const mutate of [
      (journal: Record<string, unknown>) => { journal.extra = true; },
      (journal: Record<string, unknown>) => { journal.version = 2; },
      (journal: Record<string, unknown>) => { journal.publicationId = ""; },
      (journal: Record<string, unknown>) => { journal.projects = {}; },
      (journal: Record<string, unknown>) => { journal.sourceBackend = "other"; },
      (journal: Record<string, unknown>) => { journal.phase = "lost"; },
      (journal: Record<string, unknown>) => { journal.createdAt = 1; },
      (journal: Record<string, unknown>) => { journal.createdAt = "not-a-date"; },
      (journal: Record<string, unknown>) => { journal.expectedConfigSha256 = "short"; },
      (journal: Record<string, unknown>) => { journal.projects = []; },
      (journal: Record<string, unknown>) => { journal.projects = [null]; },
      (journal: Record<string, unknown>) => { project(journal).extra = true; },
      (journal: Record<string, unknown>) => { project(journal).localProjectId = "short"; },
      (journal: Record<string, unknown>) => { project(journal).remoteProjectId = "bad"; },
      (journal: Record<string, unknown>) => { project(journal).evidenceSha256 = "bad"; },
      (journal: Record<string, unknown>) => {
        journal.projects = [...(journal.projects as unknown[])].reverse();
      },
      (journal: Record<string, unknown>) => {
        project(journal, 1).localProjectId = project(journal).localProjectId;
      },
      (journal: Record<string, unknown>) => {
        project(journal, 1).remoteProjectId = project(journal).remoteProjectId;
      },
      (journal: Record<string, unknown>) => { project(journal).fence = {}; },
      (journal: Record<string, unknown>) => {
        project(journal).fence = { ...fence(REMOTE_A, EVIDENCE_A, "1"), extra: true };
      },
      (journal: Record<string, unknown>) => {
        project(journal).fence = { ...fence(REMOTE_A, EVIDENCE_A, "1"), projectId: REMOTE_B };
      },
      (journal: Record<string, unknown>) => {
        project(journal).fence = { ...fence(REMOTE_A, EVIDENCE_A, "1"), machineId: "bad" };
      },
      (journal: Record<string, unknown>) => {
        project(journal).fence = { ...fence(REMOTE_A, EVIDENCE_A, "1"), publicationId: "" };
      },
      (journal: Record<string, unknown>) => {
        project(journal).fence = { ...fence(REMOTE_A, EVIDENCE_A, "1"), fencingToken: "0" };
      },
      (journal: Record<string, unknown>) => {
        project(journal).fence = { ...fence(REMOTE_A, EVIDENCE_A, "1"), evidenceSha256: EVIDENCE_B };
      },
      (journal: Record<string, unknown>) => {
        project(journal).fence = { ...fence(REMOTE_A, EVIDENCE_A, "1"), targetBackend: "other" };
      },
      (journal: Record<string, unknown>) => {
        project(journal).fence = { ...fence(REMOTE_A, EVIDENCE_A, "1"), releasedAt: "bad" };
      },
      (journal: Record<string, unknown>) => { journal.targetBackend = "sqlite"; },
      (journal: Record<string, unknown>) => {
        journal.updatedAt = "2025-01-01T00:00:00.000Z";
      },
      (journal: Record<string, unknown>) => {
        project(journal).fence = fence(REMOTE_A, EVIDENCE_A, "1");
      },
    ]) rejectPreparedMutation(mutate);

    rejectPreparedMutation((journal) => {
      journal.checksumSha256 = "0".repeat(64);
    }, false);
    const invalidJsonHome = home();
    prepare(invalidJsonHome);
    writeFileSync(backendPublicationJournalPath(invalidJsonHome), "{", { mode: 0o600 });
    expect(() => readBackendPublicationJournal(invalidJsonHome))
      .toThrowError(BackendPublicationJournalError);
    const nonObjectHome = home();
    prepare(nonObjectHome);
    writeFileSync(backendPublicationJournalPath(nonObjectHome), "[]", { mode: 0o600 });
    expect(() => readBackendPublicationJournal(nonObjectHome))
      .toThrowError(BackendPublicationJournalError);

    for (const mutate of [
      (journal: Record<string, unknown>) => {
        const record = project(journal).fence as Record<string, unknown>;
        record.renewedAt = "2025-01-01T00:00:00.000Z";
      },
      (journal: Record<string, unknown>) => {
        const record = project(journal).fence as Record<string, unknown>;
        record.expiresAt = record.renewedAt;
      },
      (journal: Record<string, unknown>) => {
        const record = project(journal).fence as Record<string, unknown>;
        record.releasedAt = "2025-01-01T00:00:00.000Z";
      },
      (journal: Record<string, unknown>) => {
        const record = project(journal).fence as Record<string, unknown>;
        record.publicationId = "another-generation";
      },
      (journal: Record<string, unknown>) => {
        const record = project(journal).fence as Record<string, unknown>;
        record.targetBackend = "sqlite";
      },
      (journal: Record<string, unknown>) => {
        const record = project(journal).fence as Record<string, unknown>;
        record.releasedAt = "2026-08-01T00:02:00.000Z";
      },
      (journal: Record<string, unknown>) => {
        journal.publishedProjectMapSha256 = MAP_AFTER;
      },
    ]) {
      const homeDir = home();
      guarded(homeDir);
      rewriteJournal(homeDir, mutate);
      expect(() => readBackendPublicationJournal(homeDir))
        .toThrowError(BackendPublicationJournalError);
    }

    const abortingHome = home();
    let aborting = guarded(abortingHome);
    aborting = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: aborting.checksumSha256,
      phase: "abort-prepared",
      homeDir: abortingHome,
    });
    rewriteJournal(abortingHome, (journal) => {
      const record = project(journal).fence as Record<string, unknown>;
      record.releasedAt = "2026-08-01T00:02:00.000Z";
    });
    expect(() => readBackendPublicationJournal(abortingHome))
      .toThrowError(BackendPublicationJournalError);

    const releasedHome = home();
    let released = guarded(releasedHome);
    writeFileSync(join(releasedHome, ".lcm", "map.json"), MAP_AFTER_CONTENT, {
      mode: 0o600,
    });
    released = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: released.checksumSha256,
      phase: "map-published",
      publishedProjectMapSha256: MAP_AFTER,
      homeDir: releasedHome,
    });
    writeFileSync(join(releasedHome, ".lcm", "config.json"), CONFIG_AFTER_CONTENT, {
      mode: 0o600,
    });
    released = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: released.checksumSha256,
      phase: "config-published",
      publishedConfigSha256: CONFIG_AFTER,
      homeDir: releasedHome,
    });
    released = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: released.checksumSha256,
      phase: "releasing",
      homeDir: releasedHome,
    });
    released = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: released.checksumSha256,
      phase: "released",
      projects: released.projects.map((entry) => ({
        ...entry,
        fence: { ...entry.fence!, releasedAt: "2026-08-01T00:02:00.000Z" },
      })),
      homeDir: releasedHome,
    });
    rewriteJournal(releasedHome, (journal) => {
      const record = project(journal).fence as Record<string, unknown>;
      record.releasedAt = null;
    });
    expect(() => readBackendPublicationJournal(releasedHome))
      .toThrowError(BackendPublicationJournalError);

    const abortedFenceHome = home();
    abortPreparedPublication(abortedFenceHome);
    rewriteJournal(abortedFenceHome, (journal) => {
      const records = journal.projects as Record<string, unknown>[];
      records[0]!.fence = fence(REMOTE_A, EVIDENCE_A, "1");
    });
    expect(() => readBackendPublicationJournal(abortedFenceHome))
      .toThrowError(BackendPublicationJournalError);

    const abortedWitnessHome = home();
    abortPreparedPublication(abortedWitnessHome);
    rewriteJournal(abortedWitnessHome, (journal) => {
      journal.publishedConfigSha256 = CONFIG_AFTER;
    });
    expect(() => readBackendPublicationJournal(abortedWitnessHome))
      .toThrowError(BackendPublicationJournalError);
  });

  it("rejects identity, fence, witness, local-state, and transition regressions", () => {
    const identityHome = home();
    const initial = prepare(identityHome);
    const guardedProjects = initial.projects.map((entry, index) => ({
      ...entry,
      fence: fence(entry.remoteProjectId, entry.evidenceSha256, String(index + 1)),
    }));
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: initial.checksumSha256,
      phase: "guarded",
      projects: guardedProjects.map((entry, index) => index === 0
        ? { ...entry, remoteProjectId: REMOTE_B }
        : entry),
      homeDir: identityHome,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));

    let current = guardedFrom(initial, identityHome);
    for (const projects of [
      current.projects.map((entry, index) => index === 0 ? { ...entry, fence: null } : entry),
      current.projects.map((entry, index) => index === 0 ? {
        ...entry,
        fence: { ...entry.fence!, machineId: REMOTE_B },
      } : entry),
      current.projects.map((entry, index) => index === 0 ? {
        ...entry,
        fence: { ...entry.fence!, fencingToken: "0" },
      } : entry),
      current.projects.map((entry, index) => index === 0 ? {
        ...entry,
        fence: {
          ...entry.fence!,
          acquiredAt: "2026-08-01T00:00:00.000Z",
        },
      } : entry),
      current.projects.map((entry, index) => index === 0 ? {
        ...entry,
        fence: {
          ...entry.fence!,
          renewedAt: "2026-07-31T23:59:59.000Z",
        },
      } : entry),
    ]) {
      expect(() => advanceBackendPublication({
        publicationId: PUBLICATION,
        expectedChecksumSha256: current.checksumSha256,
        phase: "abort-prepared",
        projects,
        homeDir: identityHome,
      })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    }

    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: current.checksumSha256,
      phase: "map-published",
      publishedProjectMapSha256: MAP_AFTER,
      homeDir: identityHome,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    writeFileSync(join(identityHome, ".lcm", "map.json"), MAP_AFTER_CONTENT, {
      mode: 0o600,
    });
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: current.checksumSha256,
      phase: "map-published",
      homeDir: identityHome,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    current = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: current.checksumSha256,
      phase: "map-published",
      publishedProjectMapSha256: MAP_AFTER,
      homeDir: identityHome,
    });
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: current.checksumSha256,
      phase: "released",
      homeDir: identityHome,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: current.checksumSha256,
      phase: "config-published",
      publishedConfigSha256: "0".repeat(64),
      homeDir: identityHome,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));

    const partialHome = home();
    let partial = prepare(partialHome);
    partial = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: partial.checksumSha256,
      phase: "abort-prepared",
      projects: partial.projects.map((entry, index) => index === 0
        ? { ...entry, fence: fence(entry.remoteProjectId, entry.evidenceSha256, "1") }
        : entry),
      homeDir: partialHome,
    });
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: partial.checksumSha256,
      phase: "config-restored",
      projects: partial.projects.map((entry) => entry.fence === null
        ? { ...entry, fence: fence(entry.remoteProjectId, entry.evidenceSha256, "2") }
        : entry),
      publishedConfigSha256: partial.expectedConfigSha256,
      homeDir: partialHome,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));

    const mismatchHome = home();
    writeFileSync(join(mismatchHome, "unexpected"), "x");
    expect(() => prepareBackendPublication({
      publicationId: PUBLICATION,
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      expectedConfigSha256: "0".repeat(64),
      expectedProjectMapSha256: "0".repeat(64),
      intendedConfigSha256: CONFIG_AFTER,
      intendedProjectMapSha256: MAP_AFTER,
      projects: [{
        localProjectId: LOCAL_A,
        remoteProjectId: REMOTE_A,
        evidenceSha256: EVIDENCE_A,
      }],
      homeDir: mismatchHome,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));

    const configAbortHome = home();
    let configAbort = guarded(configAbortHome);
    writeFileSync(join(configAbortHome, ".lcm", "map.json"), MAP_AFTER_CONTENT, {
      mode: 0o600,
    });
    configAbort = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: configAbort.checksumSha256,
      phase: "map-published",
      publishedProjectMapSha256: MAP_AFTER,
      homeDir: configAbortHome,
    });
    writeFileSync(join(configAbortHome, ".lcm", "config.json"), CONFIG_AFTER_CONTENT, {
      mode: 0o600,
    });
    for (const witnesses of [
      { publishedConfigSha256: "0".repeat(64) },
      { publishedConfigSha256: CONFIG_AFTER, publishedProjectMapSha256: MAP_AFTER },
    ]) {
      expect(() => advanceBackendPublication({
        publicationId: PUBLICATION,
        expectedChecksumSha256: configAbort.checksumSha256,
        phase: "config-published",
        ...witnesses,
        homeDir: configAbortHome,
      })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    }
    configAbort = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: configAbort.checksumSha256,
      phase: "config-published",
      publishedConfigSha256: CONFIG_AFTER,
      homeDir: configAbortHome,
    });
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: configAbort.checksumSha256,
      phase: "abort-prepared",
      homeDir: configAbortHome,
    })).not.toThrow();

    const invalidAbortHome = home();
    const invalidAbort = guarded(invalidAbortHome);
    writeFileSync(join(invalidAbortHome, ".lcm", "config.json"), CONFIG_AFTER_CONTENT, {
      mode: 0o600,
    });
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: invalidAbort.checksumSha256,
      phase: "abort-prepared",
      homeDir: invalidAbortHome,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));

    const invalidRestoreHome = home();
    let invalidRestore = prepare(invalidRestoreHome);
    invalidRestore = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: invalidRestore.checksumSha256,
      phase: "abort-prepared",
      homeDir: invalidRestoreHome,
    });
    writeFileSync(join(invalidRestoreHome, ".lcm", "config.json"), CONFIG_AFTER_CONTENT, {
      mode: 0o600,
    });
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: invalidRestore.checksumSha256,
      phase: "config-restored",
      publishedConfigSha256: invalidRestore.expectedConfigSha256,
      homeDir: invalidRestoreHome,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    rmSync(join(invalidRestoreHome, ".lcm", "config.json"));
    for (const witnesses of [
      { publishedConfigSha256: "0".repeat(64) },
      {
        publishedConfigSha256: invalidRestore.expectedConfigSha256,
        publishedProjectMapSha256: invalidRestore.expectedProjectMapSha256,
      },
    ]) {
      expect(() => advanceBackendPublication({
        publicationId: PUBLICATION,
        expectedChecksumSha256: invalidRestore.checksumSha256,
        phase: "config-restored",
        ...witnesses,
        homeDir: invalidRestoreHome,
      })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    }
    invalidRestore = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: invalidRestore.checksumSha256,
      phase: "config-restored",
      publishedConfigSha256: invalidRestore.expectedConfigSha256,
      homeDir: invalidRestoreHome,
    });
    for (const witnesses of [
      { publishedProjectMapSha256: "0".repeat(64) },
      {
        publishedProjectMapSha256: invalidRestore.expectedProjectMapSha256,
        publishedConfigSha256: invalidRestore.expectedConfigSha256,
      },
    ]) {
      expect(() => advanceBackendPublication({
        publicationId: PUBLICATION,
        expectedChecksumSha256: invalidRestore.checksumSha256,
      phase: "map-restored",
        ...witnesses,
        homeDir: invalidRestoreHome,
      })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    }
  });
});

type FakePublicationDriver = {
  readonly driver: BackendPublicationDriver;
  readonly calls: string[];
  readonly remote: Map<string, BackendPublicationFenceRecord>;
  readonly terminal: { retained: number; cleaned: number };
  material: BackendPublicationRecoveryMaterial;
};

function recoveryFile(content: string): BackendPublicationRecoveryFile {
  return {
    presence: "present",
    content: Buffer.from(content),
    mode: 0o600,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
  };
}

function coordinatorMaterial(
  source: "absent" | "present" = "present",
): BackendPublicationRecoveryMaterial {
  return {
    source: source === "absent"
      ? { config: { presence: "absent" }, projectMap: { presence: "absent" } }
      : {
        config: recoveryFile('{"storage":{"backend":"sqlite"}}\n'),
        projectMap: recoveryFile('{}\n'),
      },
    target: {
      config: recoveryFile(CONFIG_AFTER_CONTENT),
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

function installRecoveryFile(path: string, file: BackendPublicationRecoveryFile): void {
  if (file.presence === "absent") {
    rmSync(path, { force: true });
    return;
  }
  writeFileSync(path, file.content, { mode: file.mode });
  chmodSync(path, file.mode);
}

function installRecoveryState(
  homeDir: string,
  material: BackendPublicationRecoveryMaterial,
  side: "source" | "target",
): void {
  const root = join(homeDir, ".lcm");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  installRecoveryFile(join(root, "config.json"), material[side].config);
  installRecoveryFile(join(root, "map.json"), material[side].projectMap);
}

function fakePublicationDriver(
  homeDir: string,
  initialMaterial: BackendPublicationRecoveryMaterial,
): FakePublicationDriver {
  const state: FakePublicationDriver = {
    calls: [],
    remote: new Map(),
    terminal: { retained: 0, cleaned: 0 },
    material: initialMaterial,
    driver: undefined as unknown as BackendPublicationDriver,
  };
  const reference = {
    relativePath: `operations/${PUBLICATION}/recovery.bin`,
    sealSha256: createHash("sha256").update(PUBLICATION).digest("hex"),
    byteLength: 128,
  };
  const mutate = (
    kind: "config" | "projectMap",
    file: BackendPublicationRecoveryFile,
  ) => {
    installRecoveryFile(
      join(homeDir, ".lcm", kind === "config" ? "config.json" : "map.json"),
      file,
    );
    return captureBackendPublicationState(homeDir)[kind];
  };
  state.driver = {
    async sealRecoveryMaterial(input) {
      state.calls.push("seal");
      expect(input.material).toBe(initialMaterial);
      return reference;
    },
    async authenticateRecoveryMaterial(input) {
      state.calls.push("authenticate");
      expect(input.recoveryReference).toEqual(reference);
      return state.material;
    },
    async observeLocalState() {
      state.calls.push("observe");
      return captureBackendPublicationState(homeDir);
    },
    async publishProjectMap(input) {
      state.calls.push("publish-map");
      const content = input.file.presence === "present"
        ? Buffer.from(input.file.content).toString("utf8")
        : null;
      assertBackendPublicationProjectMapMutation(
        content === null ? {} : JSON.parse(content),
        homeDir,
        content,
      );
      return mutate("projectMap", input.file);
    },
    async publishConfig(input) {
      state.calls.push("publish-config");
      const content = input.file.presence === "present"
        ? Buffer.from(input.file.content).toString("utf8")
        : null;
      const path = join(homeDir, ".lcm", "config.json");
      const current = existsSync(path) ? readFileSync(path, "utf8") : null;
      assertBackendPublicationConfigMutation(
        path,
        input.journal.sourceBackend,
        input.journal.targetBackend,
        content,
        current,
      );
      return mutate("config", input.file);
    },
    async restoreConfig(input) {
      state.calls.push("restore-config");
      const content = input.file.presence === "present"
        ? Buffer.from(input.file.content).toString("utf8")
        : null;
      const path = join(homeDir, ".lcm", "config.json");
      const current = existsSync(path) ? readFileSync(path, "utf8") : null;
      assertBackendPublicationConfigMutation(
        path,
        input.journal.targetBackend,
        input.journal.sourceBackend,
        content,
        current,
      );
      return mutate("config", input.file);
    },
    async restoreProjectMap(input) {
      state.calls.push("restore-map");
      const content = input.file.presence === "present"
        ? Buffer.from(input.file.content).toString("utf8")
        : null;
      assertBackendPublicationProjectMapMutation(
        content === null ? {} : JSON.parse(content),
        homeDir,
        content,
      );
      return mutate("projectMap", input.file);
    },
    async acquireRemoteGuard({ journal, project }) {
      state.calls.push(`acquire:${project.localProjectId}`);
      const previous = state.remote.get(project.remoteProjectId);
      const fencingToken = previous === undefined
        ? BigInt(state.remote.size + 1)
        : BigInt(previous.fencingToken) + 1n;
      let acquired = fence(
        project.remoteProjectId,
        project.evidenceSha256,
        fencingToken.toString(),
      );
      if (
        previous !== undefined
        && (project.fence === null
          || fencingToken > BigInt(project.fence.fencingToken))
      ) {
        acquired = {
          ...acquired,
          acquiredAt: "2026-08-01T00:01:01.000Z",
          renewedAt: "2026-08-01T00:01:01.000Z",
          expiresAt: "2026-08-01T00:11:01.000Z",
        };
      }
      expect(acquired.publicationId).toBe(journal.publicationId);
      state.remote.set(project.remoteProjectId, acquired);
      return acquired;
    },
    async readRemoteGuard({ project }, operation) {
      state.calls.push(`read-${operation}:${project.localProjectId}`);
      return state.remote.get(project.remoteProjectId) ?? null;
    },
    async releaseRemoteGuard({ project, fence: requested }) {
      state.calls.push(`release:${project.localProjectId}`);
      const current = state.remote.get(project.remoteProjectId);
      if (
        current === undefined
        || current.databaseExpired
        || current.releasedAt !== null
        || current.fencingToken !== requested.fencingToken
        || current.acquiredAt !== requested.acquiredAt
      ) {
        throw new Error("fake driver refuses an unusable release fence");
      }
      state.remote.set(project.remoteProjectId, {
        ...current,
        releasedAt: "2026-08-01T00:02:00.000Z",
      });
    },
    async retainCompletedMaterial() {
      state.calls.push("retain");
      state.terminal.retained += 1;
    },
    async cleanupAbortedMaterial() {
      state.calls.push("cleanup");
      state.terminal.cleaned += 1;
    },
  };
  return state;
}

function useProductionLocalFileDriver(fake: FakePublicationDriver): void {
  fake.driver.publishProjectMap = async (input) => {
    fake.calls.push("publish-map-production");
    return applyBackendPublicationProjectMapFile(input);
  };
  fake.driver.restoreProjectMap = async (input) => {
    fake.calls.push("restore-map-production");
    return applyBackendPublicationProjectMapFile(input);
  };
  fake.driver.publishConfig = async (input) => {
    fake.calls.push("publish-config-production");
    return applyBackendPublicationConfigFile(input);
  };
  fake.driver.restoreConfig = async (input) => {
    fake.calls.push("restore-config-production");
    return applyBackendPublicationConfigFile(input);
  };
}

function coordinatorInput(material: BackendPublicationRecoveryMaterial) {
  return {
    publicationId: PUBLICATION,
    sourceBackend: "sqlite" as const,
    targetBackend: "postgresql" as const,
    material,
    projects: [
      { localProjectId: LOCAL_B, remoteProjectId: REMOTE_B, evidenceSha256: EVIDENCE_B },
      { localProjectId: LOCAL_A, remoteProjectId: REMOTE_A, evidenceSha256: EVIDENCE_A },
    ],
    now: CREATED,
  };
}

describe("BackendPublicationCoordinator", () => {
  it("preflights durable evidence and source state before sealing recovery material", async () => {
    const expectRejectedWithoutSeal = async (
      homeDir: string,
      material: BackendPublicationRecoveryMaterial,
      fake: FakePublicationDriver,
      reason: string,
    ): Promise<void> => {
      await expect(new BackendPublicationCoordinator({
        homeDir,
        driver: fake.driver,
      }).prepare(coordinatorInput(material))).rejects.toMatchObject({ reason });
      expect(fake.calls).not.toContain("seal");
    };

    const emptyStorageHome = home();
    const emptyStorageMaterial = coordinatorMaterial();
    installRecoveryState(emptyStorageHome, emptyStorageMaterial, "source");
    mkdirSync(backendPublicationDirectory(emptyStorageHome), { mode: 0o700 });
    const emptyStorageFake = fakePublicationDriver(emptyStorageHome, emptyStorageMaterial);
    await expect(new BackendPublicationCoordinator({
      homeDir: emptyStorageHome,
      driver: emptyStorageFake.driver,
    }).prepare(coordinatorInput(emptyStorageMaterial))).resolves.toMatchObject({ phase: "prepared" });
    expect(emptyStorageFake.calls).toContain("seal");

    const unresolvedHome = home();
    const unresolvedMaterial = coordinatorMaterial();
    installRecoveryState(unresolvedHome, unresolvedMaterial, "source");
    prepare(unresolvedHome);
    await expectRejectedWithoutSeal(
      unresolvedHome,
      unresolvedMaterial,
      fakePublicationDriver(unresolvedHome, unresolvedMaterial),
      "unexpected-state",
    );

    const unsafeHome = home();
    const unsafeMaterial = coordinatorMaterial();
    installRecoveryState(unsafeHome, unsafeMaterial, "source");
    mkdirSync(backendPublicationDirectory(unsafeHome), { mode: 0o755 });
    chmodSync(backendPublicationDirectory(unsafeHome), 0o755);
    await expectRejectedWithoutSeal(
      unsafeHome,
      unsafeMaterial,
      fakePublicationDriver(unsafeHome, unsafeMaterial),
      "unsafe-storage",
    );

    const missingHome = home();
    const missingMaterial = coordinatorMaterial();
    installRecoveryState(missingHome, missingMaterial, "source");
    const terminal = abortPreparedPublication(missingHome);
    prepareBackendPublication({
      publicationId: "migration-generation-2",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      expectedConfigSha256: backendPublicationConfigSha256(missingHome),
      expectedProjectMapSha256: backendPublicationProjectMapSha256(missingHome),
      intendedConfigSha256: CONFIG_AFTER,
      intendedProjectMapSha256: MAP_AFTER,
      projects: [{
        localProjectId: LOCAL_A,
        remoteProjectId: REMOTE_A,
        evidenceSha256: EVIDENCE_A,
      }],
      homeDir: missingHome,
    });
    expect(readdirSync(backendPublicationHistoryDirectory(missingHome)))
      .toContain(`${PUBLICATION}-${terminal.checksumSha256}.json`);
    rmSync(backendPublicationJournalPath(missingHome));
    await expectRejectedWithoutSeal(
      missingHome,
      missingMaterial,
      fakePublicationDriver(missingHome, missingMaterial),
      "publication-evidence-missing",
    );

    const driftHome = home();
    const driftMaterial = coordinatorMaterial();
    installRecoveryState(driftHome, driftMaterial, "target");
    const driftFake = fakePublicationDriver(driftHome, driftMaterial);
    await expectRejectedWithoutSeal(
      driftHome,
      driftMaterial,
      driftFake,
      "unexpected-state",
    );
    expect(driftFake.calls).toEqual(["observe"]);
  });

  it("binds config backends, project coverage, and all input before driver callbacks", async () => {
    type MutableInput = Record<string, unknown>;
    const rejectBeforeCallbacks = async (
      mutate: (
        input: MutableInput,
        material: BackendPublicationRecoveryMaterial,
      ) => void,
      reason: "invalid-input" | "backend-mismatch" | "unexpected-state" = "invalid-input",
    ): Promise<void> => {
      const homeDir = home();
      const material = coordinatorMaterial();
      const input = coordinatorInput(material);
      mutate(input as unknown as MutableInput, material);
      installRecoveryState(homeDir, material, "source");
      const fake = fakePublicationDriver(homeDir, material);
      await expect(new BackendPublicationCoordinator({
        homeDir,
        driver: fake.driver,
      }).prepare(input)).rejects.toMatchObject({ reason });
      expect(fake.calls).toEqual([]);
      expect(fake.remote.size).toBe(0);
    };
    const mapFile = (value: unknown) => recoveryFile(`${JSON.stringify(value)}\n`);
    const entry = (remoteProjectId?: unknown) => ({
      canonical: "/workspace/project",
      aliases: [] as string[],
      ...(remoteProjectId === undefined ? {} : { remoteProjectId }),
    });

    await rejectBeforeCallbacks((_input, material) => {
      material.source.config = recoveryFile(CONFIG_AFTER_CONTENT);
    }, "backend-mismatch");
    await rejectBeforeCallbacks((_input, material) => {
      material.target.config = recoveryFile('{"storage":{"backend":"sqlite"}}\n');
    }, "backend-mismatch");
    await rejectBeforeCallbacks((_input, material) => {
      material.target.config = recoveryFile('{"storage":{"backend":42}}\n');
    });
    await rejectBeforeCallbacks((_input, material) => {
      material.source.config = recoveryFile('{"storage":[]}\n');
    });
    await rejectBeforeCallbacks((_input, material) => {
      material.source.config = recoveryFile("[]\n");
    });

    await rejectBeforeCallbacks((_input, material) => {
      material.target.projectMap = recoveryFile("{\n");
    }, "unexpected-state");
    await rejectBeforeCallbacks((_input, material) => {
      material.target.projectMap = mapFile([]);
    });
    await rejectBeforeCallbacks((_input, material) => {
      material.target.projectMap = mapFile({ invalid: entry(REMOTE_A) });
    });
    await rejectBeforeCallbacks((_input, material) => {
      material.target.projectMap = mapFile({ [LOCAL_A]: null });
    });
    await rejectBeforeCallbacks((_input, material) => {
      material.target.projectMap = mapFile({
        [LOCAL_A]: { ...entry(REMOTE_A), extra: true },
      });
    });
    for (const aliases of [[7], [""], ["relative"]]) {
      await rejectBeforeCallbacks((_input, material) => {
        material.target.projectMap = mapFile({
          [LOCAL_A]: {
            canonical: "/workspace/project",
            aliases,
            remoteProjectId: REMOTE_A,
          },
        });
      });
    }
    await rejectBeforeCallbacks((_input, material) => {
      material.target.projectMap = mapFile({ [LOCAL_A]: entry() });
    });
    await rejectBeforeCallbacks((_input, material) => {
      material.target.projectMap = mapFile({ [LOCAL_A]: entry(7) });
    });
    await rejectBeforeCallbacks((_input, material) => {
      material.target.projectMap = mapFile({ [LOCAL_A]: entry("bad") });
    });
    await rejectBeforeCallbacks((_input, material) => {
      material.target.projectMap = mapFile({
        [LOCAL_A]: entry(REMOTE_A),
        [LOCAL_B]: entry(REMOTE_A),
      });
    });
    await rejectBeforeCallbacks((_input, material) => {
      material.source.projectMap = material.target.projectMap;
      material.target.projectMap = mapFile({
        [LOCAL_A]: entry(REMOTE_C),
        [LOCAL_B]: entry(REMOTE_B),
      });
    }, "backend-mismatch");

    await rejectBeforeCallbacks((input) => {
      input.publicationId = 42;
    });
    await rejectBeforeCallbacks((input) => {
      input.extra = true;
    });
    await rejectBeforeCallbacks((input) => {
      input.publicationId = "";
    });
    await rejectBeforeCallbacks((input) => {
      input.sourceBackend = "postgresql";
    });
    await rejectBeforeCallbacks((input) => {
      input.targetBackend = "other";
    });
    await rejectBeforeCallbacks((input) => {
      input.now = new Date(Number.NaN);
    });
    await rejectBeforeCallbacks((input) => {
      input.material = { ...(input.material as object), extra: true };
    });
    await rejectBeforeCallbacks((input) => {
      const material = input.material as Record<string, unknown>;
      material.source = { ...(material.source as object), extra: true };
    });
    await rejectBeforeCallbacks((_input, material) => {
      material.source.config = { ...material.source.config, extra: true } as never;
    });
    await rejectBeforeCallbacks((_input, material) => {
      material.source.config = {
        presence: "present",
        content: "{}",
        mode: 0o600,
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
      } as never;
    });
    await rejectBeforeCallbacks((input) => {
      input.projects = [];
    });
    await rejectBeforeCallbacks((input) => {
      input.projects = {};
    });
    await rejectBeforeCallbacks((input) => {
      input.projects = [null];
    });
    await rejectBeforeCallbacks((input) => {
      const projects = input.projects as Record<string, unknown>[];
      projects[0]!.extra = true;
    });
    for (const field of ["localProjectId", "remoteProjectId", "evidenceSha256"] as const) {
      await rejectBeforeCallbacks((input) => {
        const projects = input.projects as Record<string, unknown>[];
        projects[0]![field] = field === "localProjectId" ? 7 : "bad";
      });
    }
    await rejectBeforeCallbacks((input) => {
      const projects = input.projects as Record<string, unknown>[];
      projects.pop();
    }, "backend-mismatch");
    await rejectBeforeCallbacks((input) => {
      const projects = input.projects as Record<string, unknown>[];
      projects.push({
        localProjectId: "c".repeat(64),
        remoteProjectId: REMOTE_C,
        evidenceSha256: "3".repeat(64),
      });
    }, "backend-mismatch");
    await rejectBeforeCallbacks((input) => {
      const projects = input.projects as Record<string, unknown>[];
      projects[1]!.localProjectId = projects[0]!.localProjectId;
    }, "backend-mismatch");
    await rejectBeforeCallbacks((input) => {
      const projects = input.projects as Record<string, unknown>[];
      projects[1]!.remoteProjectId = projects[0]!.remoteProjectId;
    }, "backend-mismatch");
    await rejectBeforeCallbacks((input) => {
      const projects = input.projects as Record<string, unknown>[];
      const first = projects[0]!.remoteProjectId;
      projects[0]!.remoteProjectId = projects[1]!.remoteProjectId;
      projects[1]!.remoteProjectId = first;
    }, "backend-mismatch");

    for (const sourceContent of ["{}\n", '{"storage":{}}\n']) {
      const homeDir = home();
      const material = coordinatorMaterial();
      material.source.config = recoveryFile(sourceContent);
      material.source.projectMap = material.target.projectMap;
      installRecoveryState(homeDir, material, "source");
      const fake = fakePublicationDriver(homeDir, material);
      await expect(new BackendPublicationCoordinator({
        homeDir,
        driver: fake.driver,
      }).prepare(coordinatorInput(material))).resolves.toMatchObject({ phase: "prepared" });
      expect(fake.calls).toEqual(["observe", "seal"]);
    }

    const localOnlyHome = home();
    const localOnlyMaterial = coordinatorMaterial();
    localOnlyMaterial.source.projectMap = mapFile({
      [LOCAL_A]: {
        canonical: "/workspace/a",
        aliases: ["/workspace/a-alias"],
      },
      [LOCAL_B]: {
        canonical: "/workspace/b",
        aliases: [],
      },
    });
    installRecoveryState(localOnlyHome, localOnlyMaterial, "source");
    const localOnlyFake = fakePublicationDriver(localOnlyHome, localOnlyMaterial);
    await expect(new BackendPublicationCoordinator({
      homeDir: localOnlyHome,
      driver: localOnlyFake.driver,
    }).prepare(coordinatorInput(localOnlyMaterial))).resolves.toMatchObject({ phase: "prepared" });
    expect(localOnlyFake.calls).toEqual(["observe", "seal"]);
  });

  it("seals sensitive material and completes in deterministic crash-safe phases", async () => {
    const homeDir = home();
    const material = coordinatorMaterial();
    installRecoveryState(homeDir, material, "source");
    const fake = fakePublicationDriver(homeDir, material);
    useProductionLocalFileDriver(fake);
    const phases: string[] = [];
    const coordinator = new BackendPublicationCoordinator({
      homeDir,
      driver: fake.driver,
      observer: (event) => {
        if (event === "after-journal-directory-fsync") {
          phases.push(readBackendPublicationJournal(homeDir)!.phase);
        }
      },
    });

    const prepared = await coordinator.prepare(coordinatorInput(material));
    expect(prepared).toMatchObject({
      phase: "prepared",
      recoveryReference: { relativePath: `operations/${PUBLICATION}/recovery.bin` },
    });
    expect(prepared.sourceState).toEqual(backendPublicationMaterialWitness(material).source);
    expect(prepared.projects.map(({ localProjectId }) => localProjectId))
      .toEqual([LOCAL_A, LOCAL_B]);

    const completed = await coordinator.resume();
    expect(completed.phase).toBe("completed");
    expect(captureBackendPublicationState(homeDir))
      .toEqual(backendPublicationMaterialWitness(material).target);
    expect(completed.projects.every(({ fence: entry }) => entry?.releasedAt !== null)).toBe(true);
    expect(fake.calls.filter((call) => call.startsWith("acquire:")))
      .toEqual([`acquire:${LOCAL_A}`, `acquire:${LOCAL_B}`]);
    expect(fake.calls.filter((call) => call.startsWith("release:")))
      .toEqual([`release:${LOCAL_A}`, `release:${LOCAL_B}`]);
    expect(phases).toEqual([
      "prepared", "acquiring", "acquiring", "acquiring", "guarded",
      "map-published", "config-published", "releasing", "releasing",
      "releasing", "released", "completed",
    ]);
    await expect(coordinator.recoverPending()).resolves.toEqual(completed);
    expect(fake.terminal.retained).toBe(2);
  });

  it.each([
    "after-remote-acquire",
    "after-map-publish",
    "after-config-publish",
    "after-remote-release",
    "after-material-retain",
  ] as const)("recovers idempotently after the %s crash boundary", async (crashEvent) => {
    const homeDir = home();
    const material = coordinatorMaterial("absent");
    installRecoveryState(homeDir, material, "source");
    const fake = fakePublicationDriver(homeDir, material);
    let crashed = false;
    const crashing = new BackendPublicationCoordinator({
      homeDir,
      driver: fake.driver,
      observer: (event) => {
        if (!crashed && event === crashEvent) {
          crashed = true;
          throw new Error(`crash:${crashEvent}`);
        }
      },
    });
    await crashing.prepare(coordinatorInput(material));
    await expect(crashing.resume()).rejects.toThrow(`crash:${crashEvent}`);

    const recovered = await new BackendPublicationCoordinator({
      homeDir,
      driver: fake.driver,
    }).recoverPending();
    expect(recovered?.phase).toBe("completed");
    expect(captureBackendPublicationState(homeDir))
      .toEqual(backendPublicationMaterialWitness(material).target);
  });

  it("aborts to exact source bytes or absence and cleans material", async () => {
    for (const source of ["present", "absent"] as const) {
      const homeDir = home();
      const material = coordinatorMaterial(source);
      installRecoveryState(homeDir, material, "source");
      const fake = fakePublicationDriver(homeDir, material);
      useProductionLocalFileDriver(fake);
      let crashed = false;
      const coordinator = new BackendPublicationCoordinator({
        homeDir,
        driver: fake.driver,
        observer: (event) => {
          if (!crashed && event === "after-config-publish") {
            crashed = true;
            throw new Error("stop before config checkpoint");
          }
        },
      });
      await coordinator.prepare(coordinatorInput(material));
      await expect(coordinator.resume()).rejects.toThrow("stop before config checkpoint");
      const aborted = await new BackendPublicationCoordinator({
        homeDir,
        driver: fake.driver,
      }).abort();
      expect(aborted.phase).toBe("aborted");
      expect(captureBackendPublicationState(homeDir))
        .toEqual(backendPublicationMaterialWitness(material).source);
      expect(fake.terminal.cleaned).toBe(1);
      await new BackendPublicationCoordinator({
        homeDir,
        driver: fake.driver,
      }).recoverPending();
      expect(fake.terminal.cleaned).toBe(2);
    }
  });

  it("reacquires an expired pre-publication fence but never rolls back after release begins", async () => {
    const expiringHome = home();
    const expiringMaterial = coordinatorMaterial();
    installRecoveryState(expiringHome, expiringMaterial, "source");
    const expiringFake = fakePublicationDriver(expiringHome, expiringMaterial);
    let stopped = false;
    const expiring = new BackendPublicationCoordinator({
      homeDir: expiringHome,
      driver: expiringFake.driver,
      observer: (event) => {
        if (!stopped && event === "after-remote-acquire") {
          stopped = true;
          throw new Error("lease gap");
        }
      },
    });
    await expiring.prepare(coordinatorInput(expiringMaterial));
    await expect(expiring.resume()).rejects.toThrow("lease gap");
    for (const [projectId, entry] of expiringFake.remote) {
      expiringFake.remote.set(projectId, { ...entry, databaseExpired: true });
    }
    const reacquired = await new BackendPublicationCoordinator({
      homeDir: expiringHome,
      driver: expiringFake.driver,
    }).recoverPending();
    expect(reacquired?.phase).toBe("completed");
    expect(expiringFake.calls.filter((call) => call.startsWith("acquire:")).length)
      .toBeGreaterThan(2);

    const forwardHome = home();
    const forwardMaterial = coordinatorMaterial();
    installRecoveryState(forwardHome, forwardMaterial, "source");
    const forwardFake = fakePublicationDriver(forwardHome, forwardMaterial);
    let releaseStopped = false;
    const forward = new BackendPublicationCoordinator({
      homeDir: forwardHome,
      driver: forwardFake.driver,
      observer: (event) => {
        if (!releaseStopped && event === "after-journal-directory-fsync") {
          if (readBackendPublicationJournal(forwardHome)?.phase === "releasing") {
            releaseStopped = true;
            throw new Error("release began");
          }
        }
      },
    });
    await forward.prepare(coordinatorInput(forwardMaterial));
    await expect(forward.resume()).rejects.toThrow("release began");
    const completed = await new BackendPublicationCoordinator({
      homeDir: forwardHome,
      driver: forwardFake.driver,
    }).abort();
    expect(completed.phase).toBe("completed");
    expect(forwardFake.calls).not.toContain("restore-config");
    expect(forwardFake.calls).not.toContain("restore-map");
  });

  it.each(["forward", "abort"] as const)(
    "checkpoints higher expired successors and rotates them before %s release",
    async (disposition) => {
      const homeDir = home();
      const material = coordinatorMaterial();
      installRecoveryState(homeDir, material, "source");
      const fake = fakePublicationDriver(homeDir, material);
      let staged = false;
      const staging = new BackendPublicationCoordinator({
        homeDir,
        driver: fake.driver,
        observer: (event) => {
          if (staged) return;
          if (disposition === "abort" && event === "after-config-publish") {
            staged = true;
            throw new Error("stage abort release");
          }
          if (
            disposition === "forward"
            && event === "after-journal-directory-fsync"
            && readBackendPublicationJournal(homeDir)?.phase === "releasing"
          ) {
            staged = true;
            throw new Error("stage forward release");
          }
        },
      });
      await staging.prepare(coordinatorInput(material));
      await expect(staging.resume()).rejects.toThrow(`stage ${disposition} release`);
      if (disposition === "abort") {
        let releaseStaged = false;
        await expect(new BackendPublicationCoordinator({
          homeDir,
          driver: fake.driver,
          observer: (event) => {
            if (
              !releaseStaged
              && event === "after-journal-directory-fsync"
              && readBackendPublicationJournal(homeDir)?.phase === "abort-releasing"
            ) {
              releaseStaged = true;
              throw new Error("stage abort-releasing");
            }
          },
        }).abort()).rejects.toThrow("stage abort-releasing");
      }

      const priorTokens = new Map([...fake.remote].map(([projectId, entry]) => [
        projectId,
        BigInt(entry.fencingToken),
      ]));
      for (const [projectId, entry] of fake.remote) {
        fake.remote.set(projectId, {
          ...entry,
          fencingToken: String(BigInt(entry.fencingToken) + 1n),
          acquiredAt: "2026-08-01T00:00:31.000Z",
          renewedAt: "2026-08-01T00:00:31.000Z",
          expiresAt: "2026-08-01T00:00:32.000Z",
          databaseExpired: true,
        });
      }
      const checkpointPhases: string[] = [];
      const recovering = new BackendPublicationCoordinator({
        homeDir,
        driver: fake.driver,
        observer: (event) => {
          if (event === "after-release-fence-checkpoint") {
            checkpointPhases.push(readBackendPublicationJournal(homeDir)!.phase);
          }
        },
      });
      const terminal = disposition === "abort"
        ? await recovering.recoverPending({ disposition: "abort" })
        : await recovering.resume();
      expect(terminal?.phase).toBe(disposition === "abort" ? "aborted" : "completed");
      expect(checkpointPhases).toEqual(Array(4).fill(
        disposition === "abort" ? "abort-releasing" : "releasing",
      ));
      expect(captureBackendPublicationState(homeDir)).toEqual(
        backendPublicationMaterialWitness(material)[disposition === "abort" ? "source" : "target"],
      );
      for (const [projectId, entry] of fake.remote) {
        expect(entry.databaseExpired).toBe(false);
        expect(entry.releasedAt).not.toBeNull();
        expect(BigInt(entry.fencingToken)).toBeGreaterThan(priorTokens.get(projectId)!);
      }
      expect(fake.calls.filter((call) => call.startsWith("acquire:"))).toHaveLength(4);
      expect(fake.calls.filter((call) => call.startsWith("release:"))).toHaveLength(2);
    },
  );

  it("repeats release-fence rotation after another checkpointed successor expires", async () => {
    const homeDir = home();
    const material = coordinatorMaterial();
    installRecoveryState(homeDir, material, "source");
    const fake = fakePublicationDriver(homeDir, material);
    let releaseStaged = false;
    const staging = new BackendPublicationCoordinator({
      homeDir,
      driver: fake.driver,
      observer: (event) => {
        if (
          !releaseStaged
          && event === "after-journal-directory-fsync"
          && readBackendPublicationJournal(homeDir)?.phase === "releasing"
        ) {
          releaseStaged = true;
          throw new Error("stage repeated rotation");
        }
      },
    });
    await staging.prepare(coordinatorInput(material));
    await expect(staging.resume()).rejects.toThrow("stage repeated rotation");
    const original = fake.remote.get(REMOTE_A)!;
    fake.remote.set(REMOTE_A, { ...original, databaseExpired: true });

    let successorCheckpointed = false;
    await expect(new BackendPublicationCoordinator({
      homeDir,
      driver: fake.driver,
      observer: (event, projectId) => {
        if (
          !successorCheckpointed
          && event === "after-release-fence-checkpoint"
          && projectId === REMOTE_A
        ) {
          successorCheckpointed = true;
          throw new Error("successor checkpointed");
        }
      },
    }).resume()).rejects.toThrow("successor checkpointed");
    const onceRotated = readBackendPublicationJournal(homeDir)!.projects[0]!.fence!;
    expect(BigInt(onceRotated.fencingToken)).toBeGreaterThan(BigInt(original.fencingToken));
    fake.remote.set(REMOTE_A, { ...onceRotated, databaseExpired: true });

    const completed = await new BackendPublicationCoordinator({
      homeDir,
      driver: fake.driver,
    }).resume();
    expect(completed.phase).toBe("completed");
    const twiceRotated = completed.projects[0]!.fence!;
    expect(BigInt(twiceRotated.fencingToken)).toBeGreaterThan(
      BigInt(onceRotated.fencingToken),
    );
    expect(twiceRotated.releasedAt).not.toBeNull();
    await expect(new BackendPublicationCoordinator({
      homeDir,
      driver: fake.driver,
    }).recoverPending()).resolves.toEqual(completed);
  });

  it("rejects unauthenticated recovery material, unsafe references, and witness drift", async () => {
    const homeDir = home();
    const material = coordinatorMaterial();
    installRecoveryState(homeDir, material, "source");
    const fake = fakePublicationDriver(homeDir, material);
    const coordinator = new BackendPublicationCoordinator({ homeDir, driver: fake.driver });
    await coordinator.prepare(coordinatorInput(material));
    fake.material = {
      ...material,
      target: { ...material.target, config: recoveryFile("{}\n") },
    };
    await expect(coordinator.resume()).rejects.toMatchObject({ reason: "unexpected-state" });

    const unsafeHome = home();
    const unsafeMaterial = coordinatorMaterial();
    installRecoveryState(unsafeHome, unsafeMaterial, "source");
    const unsafe = fakePublicationDriver(unsafeHome, unsafeMaterial);
    unsafe.driver.sealRecoveryMaterial = async () => ({
      relativePath: "../escape",
      sealSha256: "1".repeat(64),
      byteLength: 1,
    });
    await expect(new BackendPublicationCoordinator({
      homeDir: unsafeHome,
      driver: unsafe.driver,
    }).prepare(coordinatorInput(unsafeMaterial))).rejects.toMatchObject({
      reason: "malformed-journal",
    });

    const invalid = coordinatorMaterial();
    invalid.target.config = { ...recoveryFile("{}"), mode: 0o644 };
    expect(() => backendPublicationMaterialWitness(invalid)).toThrowError(
      expect.objectContaining({ reason: "invalid-input" }),
    );
    const invalidJson = coordinatorMaterial();
    invalidJson.target.config = recoveryFile("{");
    expect(() => backendPublicationMaterialWitness(invalidJson)).toThrowError(
      expect.objectContaining({ reason: "unexpected-state" }),
    );
  });

  it("descriptor-authenticates exact state files and rejects replacement or unsafe layout", () => {
    const replacedHome = home();
    const material = coordinatorMaterial();
    installRecoveryState(replacedHome, material, "source");
    const configPath = join(replacedHome, ".lcm", "config.json");
    const replacement = join(replacedHome, ".lcm", "replacement.json");
    writeFileSync(replacement, "{}\n", { mode: 0o600 });
    let replaced = false;
    expect(() => captureBackendPublicationState(replacedHome, (path) => {
      if (!replaced && path === configPath) {
        replaced = true;
        renameSync(replacement, configPath);
      }
    })).toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));

    const modeHome = home();
    installRecoveryState(modeHome, material, "source");
    chmodSync(join(modeHome, ".lcm", "config.json"), 0o644);
    expect(() => captureBackendPublicationState(modeHome))
      .toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));

    const linkHome = home();
    installRecoveryState(linkHome, material, "source");
    const outside = join(linkHome, "outside.json");
    writeFileSync(outside, "{}", { mode: 0o600 });
    rmSync(join(linkHome, ".lcm", "config.json"));
    symlinkSync(outside, join(linkHome, ".lcm", "config.json"));
    expect(() => captureBackendPublicationState(linkHome))
      .toThrowError(expect.objectContaining({ reason: "unsafe-storage" }));
  });

  it("authenticates and removes only crash-orphaned journal temporary files", async () => {
    const homeDir = home();
    const material = coordinatorMaterial();
    installRecoveryState(homeDir, material, "source");
    const fake = fakePublicationDriver(homeDir, material);
    const coordinator = new BackendPublicationCoordinator({ homeDir, driver: fake.driver });
    await coordinator.prepare(coordinatorInput(material));
    const temporary = join(
      backendPublicationDirectory(homeDir),
      `.journal.json.${"a".repeat(24)}.tmp`,
    );
    writeFileSync(temporary, readFileSync(backendPublicationJournalPath(homeDir)), {
      mode: 0o600,
    });
    await expect(coordinator.resume()).resolves.toMatchObject({ phase: "completed" });
    expect(existsSync(temporary)).toBe(false);

    const unsafeHome = home();
    const unsafeMaterial = coordinatorMaterial();
    installRecoveryState(unsafeHome, unsafeMaterial, "source");
    const unsafeFake = fakePublicationDriver(unsafeHome, unsafeMaterial);
    const unsafeCoordinator = new BackendPublicationCoordinator({
      homeDir: unsafeHome,
      driver: unsafeFake.driver,
    });
    await unsafeCoordinator.prepare(coordinatorInput(unsafeMaterial));
    chmodSync(backendPublicationDirectory(unsafeHome), 0o755);
    await expect(unsafeCoordinator.resume()).rejects.toMatchObject({
      reason: "unsafe-storage",
    });
  });

  it("strictly parses recovery references and source/target witnesses", async () => {
    const rejectMutation = async (
      mutate: (journal: Record<string, any>) => void,
    ): Promise<void> => {
      const homeDir = home();
      const material = coordinatorMaterial("absent");
      installRecoveryState(homeDir, material, "source");
      const fake = fakePublicationDriver(homeDir, material);
      await new BackendPublicationCoordinator({ homeDir, driver: fake.driver })
        .prepare(coordinatorInput(material));
      rewriteJournal(homeDir, mutate);
      expect(() => readBackendPublicationJournal(homeDir))
        .toThrowError(BackendPublicationJournalError);
    };

    await rejectMutation((journal) => { journal.recoveryReference.extra = true; });
    await rejectMutation((journal) => { journal.sourceState.extra = true; });
    await rejectMutation((journal) => { journal.sourceState = null; });
    await rejectMutation((journal) => { journal.targetState.config.extra = true; });
    await rejectMutation((journal) => { journal.sourceState.config.rawSha256 = "0".repeat(64); });
    await rejectMutation((journal) => { journal.targetState.config.presence = "other"; });
    await rejectMutation((journal) => { journal.targetState.config.nlink = 2; });
    await rejectMutation((journal) => { journal.targetState.config.mode = "0600"; });
    await rejectMutation((journal) => { journal.targetState.config.mode = 0o644; });
    await rejectMutation((journal) => { journal.targetState.config.uid = -1; });
    await rejectMutation((journal) => { journal.targetState.config.rawSha256 = "0".repeat(64); });
    await rejectMutation((journal) => { journal.recoveryReference.sealSha256 = "bad"; });
    await rejectMutation((journal) => { journal.recoveryReference.byteLength = -1; });
    for (const relativePath of ["", "/absolute", "../escape", "a/./b", "a//b", "a\\b"]) {
      await rejectMutation((journal) => { journal.recoveryReference.relativePath = relativePath; });
    }
  });

  it("handles empty, terminal, explicit-abort, and automatic-abort recovery entrypoints", async () => {
    const emptyHome = home();
    const empty = new BackendPublicationCoordinator({
      homeDir: emptyHome,
      driver: fakePublicationDriver(emptyHome, coordinatorMaterial("absent")).driver,
    });
    await expect(empty.recoverPending()).resolves.toBeNull();
    await expect(empty.resume()).rejects.toMatchObject({ reason: "publication-evidence-missing" });
    await expect(empty.abort()).rejects.toMatchObject({ reason: "publication-evidence-missing" });

    const abortHome = home();
    const abortMaterial = coordinatorMaterial("absent");
    installRecoveryState(abortHome, abortMaterial, "source");
    const abortFake = fakePublicationDriver(abortHome, abortMaterial);
    const abortCoordinator = new BackendPublicationCoordinator({
      homeDir: abortHome,
      driver: abortFake.driver,
    });
    await abortCoordinator.prepare(coordinatorInput(abortMaterial));
    const aborted = await abortCoordinator.recoverPending({ disposition: "abort" });
    expect(aborted?.phase).toBe("aborted");
    await expect(abortCoordinator.resume()).resolves.toMatchObject({ phase: "aborted" });
    await expect(abortCoordinator.abort()).resolves.toMatchObject({ phase: "aborted" });

    const completeHome = home();
    const completeMaterial = coordinatorMaterial();
    installRecoveryState(completeHome, completeMaterial, "source");
    const completeFake = fakePublicationDriver(completeHome, completeMaterial);
    const complete = new BackendPublicationCoordinator({
      homeDir: completeHome,
      driver: completeFake.driver,
    });
    await complete.prepare(coordinatorInput(completeMaterial));
    await complete.resume();
    await expect(complete.resume()).resolves.toMatchObject({ phase: "completed" });
    await expect(complete.abort()).resolves.toMatchObject({ phase: "completed" });

    const mismatchHome = home();
    const mismatchMaterial = coordinatorMaterial();
    installRecoveryState(mismatchHome, mismatchMaterial, "source");
    const mismatchFake = fakePublicationDriver(mismatchHome, mismatchMaterial);
    mismatchFake.driver.readRemoteGuard = async ({ project }) => ({
      ...fence(project.remoteProjectId, project.evidenceSha256, "1"),
      publicationId: "another-generation",
    });
    const mismatch = new BackendPublicationCoordinator({
      homeDir: mismatchHome,
      driver: mismatchFake.driver,
    });
    await mismatch.prepare(coordinatorInput(mismatchMaterial));
    await expect(mismatch.recoverPending()).resolves.toMatchObject({ phase: "aborted" });
  });

  it("fails closed on missing material and invalid remote readback", async () => {
    const legacyHome = home();
    prepare(legacyHome);
    const legacyFake = fakePublicationDriver(legacyHome, coordinatorMaterial("absent"));
    await expect(new BackendPublicationCoordinator({
      homeDir: legacyHome,
      driver: legacyFake.driver,
    }).resume()).rejects.toMatchObject({ reason: "publication-evidence-missing" });

    const nullReferenceHome = home();
    const nullMaterial = coordinatorMaterial("absent");
    installRecoveryState(nullReferenceHome, nullMaterial, "source");
    const nullFake = fakePublicationDriver(nullReferenceHome, nullMaterial);
    nullFake.driver.sealRecoveryMaterial = async () => null as never;
    await expect(new BackendPublicationCoordinator({
      homeDir: nullReferenceHome,
      driver: nullFake.driver,
    }).prepare(coordinatorInput(nullMaterial))).rejects.toMatchObject({
      reason: "invalid-input",
    });

    const observedHome = home();
    const observedMaterial = coordinatorMaterial();
    installRecoveryState(observedHome, observedMaterial, "source");
    const observedFake = fakePublicationDriver(observedHome, observedMaterial);
    const observed = new BackendPublicationCoordinator({
      homeDir: observedHome,
      driver: observedFake.driver,
    });
    await observed.prepare(coordinatorInput(observedMaterial));
    observedFake.driver.observeLocalState = async () => null as never;
    await expect(observed.resume()).rejects.toMatchObject({ reason: "unexpected-state" });

    const remoteHome = home();
    const remoteMaterial = coordinatorMaterial();
    installRecoveryState(remoteHome, remoteMaterial, "source");
    const remoteFake = fakePublicationDriver(remoteHome, remoteMaterial);
    remoteFake.driver.acquireRemoteGuard = async ({ project }) =>
      fence(project.remoteProjectId, project.evidenceSha256, "1");
    const remote = new BackendPublicationCoordinator({
      homeDir: remoteHome,
      driver: remoteFake.driver,
    });
    await remote.prepare(coordinatorInput(remoteMaterial));
    await expect(remote.resume()).rejects.toMatchObject({ reason: "unexpected-state" });

    const crossWiredHome = home();
    const crossWiredMaterial = coordinatorMaterial();
    installRecoveryState(crossWiredHome, crossWiredMaterial, "source");
    const crossWiredFake = fakePublicationDriver(crossWiredHome, crossWiredMaterial);
    crossWiredFake.driver.readRemoteGuard = async ({ project }) => ({
      ...fence(project.remoteProjectId, project.evidenceSha256, "1"),
      projectId: project.remoteProjectId === REMOTE_A ? REMOTE_B : REMOTE_A,
    });
    const crossWired = new BackendPublicationCoordinator({
      homeDir: crossWiredHome,
      driver: crossWiredFake.driver,
    });
    await crossWired.prepare(coordinatorInput(crossWiredMaterial));
    await expect(crossWired.resume()).rejects.toMatchObject({ reason: "malformed-journal" });

    const thrownHome = home();
    const thrownMaterial = coordinatorMaterial();
    installRecoveryState(thrownHome, thrownMaterial, "source");
    const thrownFake = fakePublicationDriver(thrownHome, thrownMaterial);
    thrownFake.driver.readRemoteGuard = async () => { throw new Error("remote unavailable"); };
    const thrown = new BackendPublicationCoordinator({
      homeDir: thrownHome,
      driver: thrownFake.driver,
    });
    await thrown.prepare(coordinatorInput(thrownMaterial));
    await expect(thrown.recoverPending()).rejects.toThrow("remote unavailable");
  });

  it("rejects invalid partial-acquire/release semantics and transition evidence", () => {
    const coverageHome = home();
    const initial = prepare(coverageHome);
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: initial.checksumSha256,
      phase: "acquiring",
      projects: initial.projects.slice(0, 1),
      homeDir: coverageHome,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: initial.checksumSha256,
      phase: "acquiring",
      projects: initial.projects.map((project, index) => index === 0
        ? { ...project, evidenceSha256: "3".repeat(64) }
        : project),
      homeDir: coverageHome,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));

    const invalidAcquiring = home();
    const acquiring = acquiringFrom(prepare(invalidAcquiring), invalidAcquiring);
    rewriteJournal(invalidAcquiring, (journal) => {
      journal.phase = "acquiring";
      const projects = journal.projects as Record<string, unknown>[];
      projects[0]!.fence = {
        ...(projects[0]!.fence as Record<string, unknown>),
        releasedAt: "2026-08-01T00:02:00.000Z",
      };
    });
    expect(acquiring.phase).toBe("acquiring");
    expect(() => readBackendPublicationJournal(invalidAcquiring))
      .toThrowError(expect.objectContaining({ reason: "malformed-journal" }));

    const invalidAbortRelease = home();
    let aborting = prepare(invalidAbortRelease);
    aborting = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: aborting.checksumSha256,
      phase: "abort-prepared",
      homeDir: invalidAbortRelease,
    });
    aborting = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: aborting.checksumSha256,
      phase: "config-restored",
      publishedConfigSha256: aborting.expectedConfigSha256,
      homeDir: invalidAbortRelease,
    });
    aborting = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: aborting.checksumSha256,
      phase: "map-restored",
      publishedProjectMapSha256: aborting.expectedProjectMapSha256,
      homeDir: invalidAbortRelease,
    });
    aborting = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: aborting.checksumSha256,
      phase: "abort-releasing",
      homeDir: invalidAbortRelease,
    });
    rewriteJournal(invalidAbortRelease, (journal) => {
      const projects = journal.projects as Record<string, unknown>[];
      projects[0]!.fence = {
        ...fence(REMOTE_A, EVIDENCE_A, "1", "2026-08-01T00:02:00.000Z"),
        publicationId: "another-generation",
      };
    });
    expect(aborting.phase).toBe("abort-releasing");
    expect(() => readBackendPublicationJournal(invalidAbortRelease))
      .toThrowError(expect.objectContaining({ reason: "malformed-journal" }));

    const invalidRelease = home();
    let releasing = guarded(invalidRelease);
    writeFileSync(join(invalidRelease, ".lcm", "map.json"), MAP_AFTER_CONTENT, { mode: 0o600 });
    releasing = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: releasing.checksumSha256,
      phase: "map-published",
      publishedProjectMapSha256: MAP_AFTER,
      homeDir: invalidRelease,
    });
    writeFileSync(join(invalidRelease, ".lcm", "config.json"), CONFIG_AFTER_CONTENT, { mode: 0o600 });
    releasing = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: releasing.checksumSha256,
      phase: "config-published",
      publishedConfigSha256: CONFIG_AFTER,
      homeDir: invalidRelease,
    });
    releasing = advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: releasing.checksumSha256,
      phase: "releasing",
      homeDir: invalidRelease,
    });
    rewriteJournal(invalidRelease, (journal) => {
      const projects = journal.projects as Record<string, unknown>[];
      projects[0]!.fence = null;
    });
    expect(releasing.phase).toBe("releasing");
    expect(() => readBackendPublicationJournal(invalidRelease))
      .toThrowError(expect.objectContaining({ reason: "malformed-journal" }));

    const wrongReleasePhase = home();
    const guardedJournal = guarded(wrongReleasePhase);
    writeFileSync(join(wrongReleasePhase, ".lcm", "map.json"), MAP_AFTER_CONTENT, { mode: 0o600 });
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: guardedJournal.checksumSha256,
      phase: "map-published",
      projects: guardedJournal.projects.map((project, index) => index === 0
        ? { ...project, fence: { ...project.fence!, releasedAt: "2026-08-01T00:02:00.000Z" } }
        : project),
      publishedProjectMapSha256: MAP_AFTER,
      homeDir: wrongReleasePhase,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
  });

  it("fails closed when authoritative release evidence is missing", async () => {
    const preparePaused = async () => {
      const homeDir = home();
      const material = coordinatorMaterial();
      installRecoveryState(homeDir, material, "source");
      const fake = fakePublicationDriver(homeDir, material);
      let stopped = false;
      const coordinator = new BackendPublicationCoordinator({
        homeDir,
        driver: fake.driver,
        observer: (event) => {
          if (!stopped && event === "after-journal-directory-fsync"
            && readBackendPublicationJournal(homeDir)?.phase === "releasing") {
            stopped = true;
            throw new Error("paused at release");
          }
        },
      });
      await coordinator.prepare(coordinatorInput(material));
      await expect(coordinator.resume()).rejects.toThrow("paused at release");
      return { homeDir, fake };
    };

    const missing = await preparePaused();
    missing.fake.driver.readRemoteGuard = async (_input, operation) =>
      operation === "release" ? null : null;
    await expect(new BackendPublicationCoordinator({
      homeDir: missing.homeDir,
      driver: missing.fake.driver,
    }).resume()).rejects.toMatchObject({ reason: "unexpected-state" });

    const expiredPaused = async () => {
      const paused = await preparePaused();
      const current = paused.fake.remote.get(REMOTE_A)!;
      paused.fake.remote.set(REMOTE_A, { ...current, databaseExpired: true });
      return paused;
    };

    const unchangedReacquire = await expiredPaused();
    unchangedReacquire.fake.driver.acquireRemoteGuard = async ({ project }) =>
      unchangedReacquire.fake.remote.get(project.remoteProjectId)!;
    await expect(new BackendPublicationCoordinator({
      homeDir: unchangedReacquire.homeDir,
      driver: unchangedReacquire.fake.driver,
    }).resume()).rejects.toMatchObject({ reason: "unexpected-state" });

    for (const inactive of ["released", "expired"] as const) {
      const inactiveSuccessor = await expiredPaused();
      inactiveSuccessor.fake.driver.acquireRemoteGuard = async ({ project }) => {
        const current = inactiveSuccessor.fake.remote.get(project.remoteProjectId)!;
        const successor = {
          ...current,
          fencingToken: String(BigInt(current.fencingToken) + 1n),
          acquiredAt: "2026-08-01T00:01:01.000Z",
          renewedAt: "2026-08-01T00:01:01.000Z",
          expiresAt: "2026-08-01T00:11:01.000Z",
          releasedAt: inactive === "released" ? "2026-08-01T00:02:00.000Z" : null,
          databaseExpired: inactive === "expired",
        };
        inactiveSuccessor.fake.remote.set(project.remoteProjectId, successor);
        return successor;
      };
      await expect(new BackendPublicationCoordinator({
        homeDir: inactiveSuccessor.homeDir,
        driver: inactiveSuccessor.fake.driver,
      }).resume()).rejects.toMatchObject({ reason: "unexpected-state" });
    }

    const missingSuccessor = await expiredPaused();
    let releaseReads = 0;
    const read = missingSuccessor.fake.driver.readRemoteGuard.bind(missingSuccessor.fake.driver);
    missingSuccessor.fake.driver.readRemoteGuard = async (input, operation) => {
      if (operation === "release" && releaseReads++ > 0) return null;
      return read(input, operation);
    };
    await expect(new BackendPublicationCoordinator({
      homeDir: missingSuccessor.homeDir,
      driver: missingSuccessor.fake.driver,
    }).resume()).rejects.toMatchObject({ reason: "unexpected-state" });

    const unresolved = await preparePaused();
    unresolved.fake.driver.releaseRemoteGuard = async () => undefined;
    await expect(new BackendPublicationCoordinator({
      homeDir: unresolved.homeDir,
      driver: unresolved.fake.driver,
    }).resume()).rejects.toMatchObject({ reason: "unexpected-state" });

    const successor = await preparePaused();
    const predecessor = successor.fake.remote.get(REMOTE_A)!;
    successor.fake.remote.set(REMOTE_A, {
      ...predecessor,
      fencingToken: String(BigInt(predecessor.fencingToken) + 1n),
      acquiredAt: "2026-08-01T00:01:01.000Z",
      renewedAt: "2026-08-01T00:01:01.000Z",
      expiresAt: "2026-08-01T00:11:01.000Z",
    });
    await expect(new BackendPublicationCoordinator({
      homeDir: successor.homeDir,
      driver: successor.fake.driver,
    }).resume()).resolves.toMatchObject({ phase: "completed" });

    const changedBefore = await preparePaused();
    const first = changedBefore.fake.remote.get(REMOTE_A)!;
    changedBefore.fake.remote.set(REMOTE_A, {
      ...first,
      machineId: REMOTE_B,
      fencingToken: String(BigInt(first.fencingToken) + 1n),
      acquiredAt: "2026-08-01T00:01:01.000Z",
      renewedAt: "2026-08-01T00:01:01.000Z",
      expiresAt: "2026-08-01T00:11:01.000Z",
    });
    const releasesBefore = changedBefore.fake.calls.filter((call) =>
      call.startsWith("release:")).length;
    await expect(new BackendPublicationCoordinator({
      homeDir: changedBefore.homeDir,
      driver: changedBefore.fake.driver,
    }).resume()).rejects.toMatchObject({ reason: "unexpected-state" });
    expect(changedBefore.fake.calls.filter((call) => call.startsWith("release:")).length)
      .toBe(releasesBefore);

    const changedAfter = await preparePaused();
    changedAfter.fake.driver.releaseRemoteGuard = async ({ project }) => {
      const current = changedAfter.fake.remote.get(project.remoteProjectId)!;
      changedAfter.fake.remote.set(project.remoteProjectId, {
        ...current,
        fencingToken: String(BigInt(current.fencingToken) + 1n),
        releasedAt: "2026-08-01T00:02:00.000Z",
      });
    };
    await expect(new BackendPublicationCoordinator({
      homeDir: changedAfter.homeDir,
      driver: changedAfter.fake.driver,
    }).resume()).rejects.toMatchObject({ reason: "unexpected-state" });

    const renewed = await preparePaused();
    const renewedFence = renewed.fake.remote.get(REMOTE_A)!;
    renewed.fake.remote.set(REMOTE_A, {
      ...renewedFence,
      renewedAt: "2026-08-01T00:01:00.000Z",
      expiresAt: "2026-08-01T00:11:00.000Z",
      databaseExpired: true,
    });
    await expect(new BackendPublicationCoordinator({
      homeDir: renewed.homeDir,
      driver: renewed.fake.driver,
    }).resume()).resolves.toMatchObject({ phase: "completed" });
  });

  it("binds exact config/map access and mutation error paths", async () => {
    expect(() => assertBackendPublicationConfigMutation(
      "/tmp/not-lcm-config.json", "sqlite", "sqlite", "{}",
    )).not.toThrow();
    expect(() => assertBackendPublicationConfigAccess(
      "/tmp/not-lcm-config.json", "sqlite", "{}",
    )).not.toThrow();

    const legacyHome = home();
    expect(() => assertBackendPublicationProjectMapMutation({}, legacyHome, "{}"))
      .not.toThrow();

    const terminalHome = home();
    const material = coordinatorMaterial();
    installRecoveryState(terminalHome, material, "source");
    const fake = fakePublicationDriver(terminalHome, material);
    const coordinator = new BackendPublicationCoordinator({
      homeDir: terminalHome,
      driver: fake.driver,
    });
    await coordinator.prepare(coordinatorInput(material));
    await coordinator.resume();
    const mapContent = Buffer.from(
      material.target.projectMap.presence === "present"
        ? material.target.projectMap.content
        : Buffer.from(""),
    ).toString("utf8");
    const map = JSON.parse(mapContent) as unknown;
    expect(() => assertBackendPublicationProjectMapAccess({
      homeDir: terminalHome,
      content: null,
      map: {},
      present: true,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    expect(() => assertBackendPublicationProjectMapAccess({
      homeDir: terminalHome,
      content: mapContent,
      map: {},
      present: true,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
    expect(() => assertBackendPublicationProjectMapAccess({
      homeDir: terminalHome,
      content: "{}\n",
      map: {},
      present: true,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));

    installRecoveryFile(join(terminalHome, ".lcm", "map.json"), recoveryFile("{}\n"));
    expect(() => assertBackendPublicationProjectMapAccess({
      homeDir: terminalHome,
      content: "{}\n",
      map: {},
      present: true,
    })).not.toThrow();
    installRecoveryFile(
      join(terminalHome, ".lcm", "config.json"),
      recoveryFile('{"storage":{"backend":"postgresql"},"changed":true}\n'),
    );
    const changedConfig = readFileSync(join(terminalHome, ".lcm", "config.json"), "utf8");
    expect(() => assertBackendPublicationConfigAccess(
      join(terminalHome, ".lcm", "config.json"),
      "postgresql",
      changedConfig,
    )).not.toThrow();
    expect(() => assertBackendPublicationConfigMutation(
      join(terminalHome, ".lcm", "config.json"),
      "postgresql",
      "postgresql",
      changedConfig,
      changedConfig,
    )).not.toThrow();

    const absentHome = home();
    const absentMaterial = coordinatorMaterial("absent");
    installRecoveryState(absentHome, absentMaterial, "source");
    const absentFake = fakePublicationDriver(absentHome, absentMaterial);
    const absentCoordinator = new BackendPublicationCoordinator({
      homeDir: absentHome,
      driver: absentFake.driver,
    });
    await absentCoordinator.prepare(coordinatorInput(absentMaterial));
    await absentCoordinator.abort();
    expect(() => assertBackendPublicationProjectMapAccess({
      homeDir: absentHome,
      content: null,
      map: {},
      present: false,
    })).not.toThrow();
    const postAbortConfig = '{"storage":{"backend":"sqlite"},"changed":true}\n';
    writeFileSync(join(absentHome, ".lcm", "config.json"), postAbortConfig, { mode: 0o600 });
    expect(() => assertBackendPublicationConfigMutation(
      join(absentHome, ".lcm", "config.json"),
      "sqlite",
      "sqlite",
      postAbortConfig,
      postAbortConfig,
    )).not.toThrow();
    expect(() => assertBackendPublicationConfigAccess(
      join(absentHome, ".lcm", "config.json"),
      "sqlite",
      postAbortConfig,
    )).not.toThrow();

    const guardedHome = home();
    const guardedMaterial = coordinatorMaterial();
    installRecoveryState(guardedHome, guardedMaterial, "source");
    const guardedFake = fakePublicationDriver(guardedHome, guardedMaterial);
    let guarded = false;
    const guardedCoordinator = new BackendPublicationCoordinator({
      homeDir: guardedHome,
      driver: guardedFake.driver,
      observer: (event) => {
        if (!guarded && event === "after-journal-directory-fsync"
          && readBackendPublicationJournal(guardedHome)?.phase === "guarded") {
          guarded = true;
          throw new Error("guarded");
        }
      },
    });
    await guardedCoordinator.prepare(coordinatorInput(guardedMaterial));
    await expect(guardedCoordinator.resume()).rejects.toThrow("guarded");
    const guardedJournal = readBackendPublicationJournal(guardedHome)!;
    await expect(withBackendPublicationPermit({
      publicationId: PUBLICATION,
      expectedChecksumSha256: guardedJournal.checksumSha256,
      access: "publish-project-map",
      stateSha256: backendPublicationCanonicalSha256({}),
      homeDir: guardedHome,
    }, () => assertBackendPublicationProjectMapMutation(
      {},
      guardedHome,
      null,
    ))).rejects.toMatchObject({ reason: "unexpected-state" });
    await expect(withBackendPublicationPermit({
      publicationId: PUBLICATION,
      expectedChecksumSha256: guardedJournal.checksumSha256,
      access: "publish-project-map",
      stateSha256: backendPublicationCanonicalSha256({}),
      homeDir: guardedHome,
    }, () => assertBackendPublicationProjectMapMutation(
      {},
      guardedHome,
      Buffer.from(guardedMaterial.target.projectMap.presence === "present"
        ? guardedMaterial.target.projectMap.content
        : Buffer.from(""),
      ).toString("utf8"),
    ))).rejects.toMatchObject({ reason: "unexpected-state" });
    expect(map).toBeTypeOf("object");
    expect(() => assertBackendPublicationConfigAccess(
      join(terminalHome, ".lcm", "config.json"),
      "postgresql",
    )).not.toThrow();
  });

  it("requires the declared backend inside exact config publication permits", async () => {
    const homeDir = home();
    const material = coordinatorMaterial();
    installRecoveryState(homeDir, material, "source");
    const fake = fakePublicationDriver(homeDir, material);
    useProductionLocalFileDriver(fake);
    const publishConfig = fake.driver.publishConfig.bind(fake.driver);
    const restoreConfig = fake.driver.restoreConfig.bind(fake.driver);
    let publishChecked = false;
    let restoreChecked = false;
    fake.driver.publishConfig = async (input) => {
      const path = join(homeDir, ".lcm", "config.json");
      const candidate = Buffer.from(
        input.file.presence === "present" ? input.file.content : Buffer.from(""),
      ).toString("utf8");
      const current = readFileSync(path, "utf8");
      expect(() => assertBackendPublicationConfigMutation(
        path,
        input.journal.sourceBackend,
        input.journal.sourceBackend,
        candidate,
        current,
      )).toThrowError(expect.objectContaining({ reason: "backend-mismatch" }));
      expect(() => assertBackendPublicationConfigMutation(
        path,
        input.journal.sourceBackend,
        input.journal.targetBackend,
        candidate,
        current,
      )).not.toThrow();
      publishChecked = true;
      return publishConfig(input);
    };
    fake.driver.restoreConfig = async (input) => {
      const path = join(homeDir, ".lcm", "config.json");
      const candidate = Buffer.from(
        input.file.presence === "present" ? input.file.content : Buffer.from(""),
      ).toString("utf8");
      const current = readFileSync(path, "utf8");
      expect(() => assertBackendPublicationConfigMutation(
        path,
        input.journal.targetBackend,
        input.journal.targetBackend,
        candidate,
        current,
      )).toThrowError(expect.objectContaining({ reason: "backend-mismatch" }));
      expect(() => assertBackendPublicationConfigMutation(
        path,
        input.journal.targetBackend,
        input.journal.sourceBackend,
        candidate,
        current,
      )).not.toThrow();
      restoreChecked = true;
      return restoreConfig(input);
    };
    let stopped = false;
    const publishing = new BackendPublicationCoordinator({
      homeDir,
      driver: fake.driver,
      observer: (event) => {
        if (!stopped && event === "after-config-publish") {
          stopped = true;
          throw new Error("abort after candidate checks");
        }
      },
    });
    await publishing.prepare(coordinatorInput(material));
    await expect(publishing.resume()).rejects.toThrow("abort after candidate checks");
    await expect(new BackendPublicationCoordinator({
      homeDir,
      driver: fake.driver,
    }).abort()).resolves.toMatchObject({ phase: "aborted" });
    expect({ publishChecked, restoreChecked }).toEqual({
      publishChecked: true,
      restoreChecked: true,
    });
  });

  it("serializes config setters and safely handles unsafe, stale, and failed locks", () => {
    const homeDir = home();
    const root = join(homeDir, ".lcm");
    const configPath = join(root, "config.json");
    const configLockPath = `${configPath}.lock`;
    const publicationLockPath = join(root, "backend-publication.lock");
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(configPath, "{}\n", { mode: 0o600 });

    expect(withBackendPublicationConfigLock(configPath, () => {
      expect(existsSync(configLockPath)).toBe(true);
      expect(() => setConfigValue({
        configPath,
        path: "daemon.enabled",
        value: true,
      })).toThrow(PrivateMutationLockContentionError);
      expect(readFileSync(configPath, "utf8")).toBe("{}\n");
      return "publication-held";
    })).toBe("publication-held");
    expect(existsSync(configLockPath)).toBe(false);
    expect(existsSync(publicationLockPath)).toBe(false);

    const callbackFailure = new Error("config callback failed");
    expect(() => withBackendPublicationConfigLock(configPath, () => {
      throw callbackFailure;
    })).toThrow(callbackFailure);
    expect(existsSync(configLockPath)).toBe(false);
    expect(existsSync(publicationLockPath)).toBe(false);

    writeFileSync(configLockPath, "not-json\n", { mode: 0o600 });
    let unsafeCallbackRan = false;
    expect(() => withBackendPublicationConfigLock(configPath, () => {
      unsafeCallbackRan = true;
    })).toThrowError(/config file lock is malformed/u);
    expect(unsafeCallbackRan).toBe(false);
    expect(existsSync(publicationLockPath)).toBe(false);
    rmSync(configLockPath);

    writeFileSync(configLockPath, `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      processStartTime: "definitely-stale",
      nonce: "f".repeat(32),
      createdAtMs: 1,
    })}\n`, { mode: 0o600 });
    expect(withBackendPublicationConfigLock(configPath, () => "reclaimed"))
      .toBe("reclaimed");
    expect(existsSync(configLockPath)).toBe(false);
    expect(existsSync(`${configLockPath}.reclaim-${"f".repeat(32)}`)).toBe(false);
    expect(existsSync(publicationLockPath)).toBe(false);
  });

  it("covers legacy normalization, reverse publication, default timestamps, and witnesses", async () => {
    const legacyModeHome = home();
    mkdirSync(join(legacyModeHome, ".lcm"), { mode: 0o755 });
    chmodSync(join(legacyModeHome, ".lcm"), 0o755);
    expect(() => assertBackendPublicationConsumerAccess({
      backend: "sqlite",
      homeDir: legacyModeHome,
    })).not.toThrow();
    expect(statSync(join(legacyModeHome, ".lcm")).mode & 0o777).toBe(0o700);

    const reverseHome = home();
    const forwardMaterial = coordinatorMaterial();
    const reverseMaterial: BackendPublicationRecoveryMaterial = {
      source: forwardMaterial.target,
      target: {
        config: forwardMaterial.source.config,
        projectMap: { presence: "absent" },
      },
    };
    installRecoveryState(reverseHome, reverseMaterial, "source");
    const reverseFake = fakePublicationDriver(reverseHome, reverseMaterial);
    const { now: _now, ...withoutNow } = coordinatorInput(reverseMaterial);
    await expect(new BackendPublicationCoordinator({
      homeDir: reverseHome,
      driver: reverseFake.driver,
    }).prepare({
      ...withoutNow,
      sourceBackend: "postgresql",
      targetBackend: "sqlite",
    })).resolves.toMatchObject({ phase: "prepared" });

    const defaultWitnessHome = home();
    const prepared = prepare(defaultWitnessHome);
    expect(() => advanceBackendPublication({
      publicationId: PUBLICATION,
      expectedChecksumSha256: prepared.checksumSha256,
      phase: "acquiring",
      publishedConfigSha256: prepared.expectedConfigSha256,
      homeDir: defaultWitnessHome,
    })).toThrowError(expect.objectContaining({ reason: "unexpected-state" }));

    expect(withBackendPublicationConfigLock("/tmp/config.json", () => "outside"))
      .toBe("outside");
    expect(withBackendPublicationConfigLock(
      join(defaultWitnessHome, ".lcm", "config.json"),
      () => "inside",
    )).toBe("inside");
    expect(() => assertBackendPublicationConfigAccess("/tmp/config.json", "sqlite", "{}"))
      .not.toThrow();
  });

  it("resumes partial acquisitions with authoritative identity and monotonic tokens", async () => {
    for (const drift of ["none", "machine", "token"] as const) {
      const homeDir = home();
      const material = coordinatorMaterial();
      installRecoveryState(homeDir, material, "source");
      const fake = fakePublicationDriver(homeDir, material);
      let paused = false;
      const coordinator = new BackendPublicationCoordinator({
        homeDir,
        driver: fake.driver,
        observer: (event) => {
          const journal = event === "after-journal-directory-fsync"
            ? readBackendPublicationJournal(homeDir)
            : null;
          if (!paused && journal?.phase === "acquiring"
            && journal.projects.every(({ fence: entry }) => entry !== null)) {
            paused = true;
            throw new Error("partial acquire checkpoint");
          }
        },
      });
      await coordinator.prepare(coordinatorInput(material));
      await expect(coordinator.resume()).rejects.toThrow("partial acquire checkpoint");
      if (drift !== "none") {
        const entry = fake.remote.get(REMOTE_B)!;
        fake.remote.set(REMOTE_B, drift === "machine"
          ? { ...entry, machineId: "018f0000-0000-7000-8000-000000000004" }
          : { ...entry, fencingToken: "1" });
      }
      await expect(new BackendPublicationCoordinator({
        homeDir,
        driver: fake.driver,
      }).resume()).resolves.toMatchObject({ phase: "completed" });
    }
  });

  it.each([
    "abort-prepared",
    "config-restored",
    "map-restored",
    "abort-releasing",
  ] as const)("resumes an abort interrupted in %s", async (abortPhase) => {
    const homeDir = home();
    const material = coordinatorMaterial();
    installRecoveryState(homeDir, material, "source");
    const fake = fakePublicationDriver(homeDir, material);
    let forwardStopped = false;
    const forward = new BackendPublicationCoordinator({
      homeDir,
      driver: fake.driver,
      observer: (event) => {
        if (!forwardStopped && event === "after-config-publish") {
          forwardStopped = true;
          throw new Error("start abort");
        }
      },
    });
    await forward.prepare(coordinatorInput(material));
    await expect(forward.resume()).rejects.toThrow("start abort");

    let abortStopped = false;
    const aborting = new BackendPublicationCoordinator({
      homeDir,
      driver: fake.driver,
      observer: (event) => {
        if (!abortStopped && event === "after-journal-directory-fsync"
          && readBackendPublicationJournal(homeDir)?.phase === abortPhase) {
          abortStopped = true;
          throw new Error(`abort:${abortPhase}`);
        }
      },
    });
    await expect(aborting.abort()).rejects.toThrow(`abort:${abortPhase}`);
    await expect(new BackendPublicationCoordinator({
      homeDir,
      driver: fake.driver,
    }).resume()).resolves.toMatchObject({ phase: "aborted" });
  });

  it("covers legacy and rich map/config witness optionality", async () => {
    const noEvidenceHome = home();
    expect(() => assertBackendPublicationProjectMapAccess({
      homeDir: noEvidenceHome,
      content: "{}",
      map: {},
      present: true,
    })).not.toThrow();

    const legacyGuardedHome = home();
    const legacyGuarded = guarded(legacyGuardedHome);
    await expect(withBackendPublicationPermit({
      publicationId: PUBLICATION,
      expectedChecksumSha256: legacyGuarded.checksumSha256,
      access: "publish-project-map",
      stateSha256: MAP_AFTER,
      homeDir: legacyGuardedHome,
    }, () => assertBackendPublicationProjectMapMutation(
      { next: true }, legacyGuardedHome, MAP_AFTER_CONTENT,
    ))).resolves.toBeUndefined();

    const richAbortedHome = home();
    const richAbortedMaterial = coordinatorMaterial("absent");
    installRecoveryState(richAbortedHome, richAbortedMaterial, "source");
    const richAbortedFake = fakePublicationDriver(richAbortedHome, richAbortedMaterial);
    const richAborted = new BackendPublicationCoordinator({
      homeDir: richAbortedHome,
      driver: richAbortedFake.driver,
    });
    await richAborted.prepare(coordinatorInput(richAbortedMaterial));
    await richAborted.abort();
    expect(() => assertBackendPublicationConfigAccess(
      join(richAbortedHome, ".lcm", "config.json"),
      "sqlite",
      null,
    )).not.toThrow();
  });

  it("survives real child-process SIGKILLs at durable publication boundaries", {
    timeout: 300_000,
  }, () => {
    const fixture = join(
      process.cwd(),
      "test/fixtures/backend-publication-crash.test.ts",
    );
    const vitest = join(process.cwd(), "node_modules/vitest/vitest.mjs");
    const forwardEvents = [
      "before-material-rename",
      "after-material-rename",
      "before-material-directory-fsync",
      "after-material-directory-fsync",
      "before-journal-rename",
      "after-journal-rename",
      "before-journal-directory-fsync",
      "after-journal-directory-fsync",
      "before-project-map-publish-rename",
      "after-project-map-publish-rename",
      "before-project-map-publish-directory-fsync",
      "after-project-map-publish-directory-fsync",
      "before-config-publish-rename",
      "after-config-publish-rename",
      "before-config-publish-directory-fsync",
      "after-config-publish-directory-fsync",
      "before-remote-acquire",
      "after-remote-acquire",
      "before-remote-release",
      "after-remote-release",
      "before-terminal-retain-rename",
      "after-terminal-retain-rename",
      "before-terminal-retain-directory-fsync",
      "after-terminal-retain-directory-fsync",
    ];
    const abortPresentEvents = [
      "before-config-restore-rename",
      "after-config-restore-rename",
      "before-config-restore-directory-fsync",
      "after-config-restore-directory-fsync",
      "before-project-map-restore-rename",
      "after-project-map-restore-rename",
      "before-project-map-restore-directory-fsync",
      "after-project-map-restore-directory-fsync",
      "before-abort-remote-release",
      "after-abort-remote-release",
      "before-terminal-cleanup-rename",
      "after-terminal-cleanup-rename",
      "before-terminal-cleanup-directory-fsync",
      "after-terminal-cleanup-directory-fsync",
      "before-material-cleanup-unlink",
      "after-material-cleanup-unlink",
      "before-material-cleanup-directory-fsync",
      "after-material-cleanup-directory-fsync",
    ];
    const abortAbsentEvents = [
      "before-config-restore-unlink",
      "after-config-restore-unlink",
      "before-config-restore-directory-fsync",
      "after-config-restore-directory-fsync",
      "before-project-map-restore-unlink",
      "after-project-map-restore-unlink",
      "before-project-map-restore-directory-fsync",
      "after-project-map-restore-directory-fsync",
    ];
    const releaseExpiryEvents = [
      "before-remote-reacquire",
      "after-remote-reacquire",
      "before-remote-successor-read",
      "after-remote-successor-read",
      "before-release-fence-checkpoint",
      "after-release-fence-checkpoint",
      "before-remote-release",
      "after-remote-release",
    ];
    const successorDowntimeExpiryEvents = [
      "after-remote-reacquire",
      "before-remote-successor-read",
      "after-remote-successor-read",
      "before-release-fence-checkpoint",
    ];
    const cases = [
      ...forwardEvents.map((event) => ({
        event,
        crashMode: "crash",
        recoverMode: "recover",
        source: "present",
        expireDuringDowntime: false,
      })),
      ...abortPresentEvents.map((event) => ({
        event,
        crashMode: "abort-crash",
        recoverMode: "recover-abort",
        source: "present",
        expireDuringDowntime: false,
      })),
      ...abortAbsentEvents.map((event) => ({
        event,
        crashMode: "abort-crash",
        recoverMode: "recover-abort",
        source: "absent",
        expireDuringDowntime: false,
      })),
      ...releaseExpiryEvents.map((event) => ({
        event,
        crashMode: "expiry-crash",
        recoverMode: "recover",
        source: "present",
        expireDuringDowntime: false,
      })),
      ...releaseExpiryEvents.map((event) => ({
        event,
        crashMode: "abort-expiry-crash",
        recoverMode: "recover-abort",
        source: "present",
        expireDuringDowntime: false,
      })),
      ...successorDowntimeExpiryEvents.map((event) => ({
        event,
        crashMode: "expiry-crash",
        recoverMode: "recover",
        source: "present",
        expireDuringDowntime: true,
      })),
      ...successorDowntimeExpiryEvents.map((event) => ({
        event,
        crashMode: "abort-expiry-crash",
        recoverMode: "recover-abort",
        source: "present",
        expireDuringDowntime: true,
      })),
    ];
    for (const {
      event: crashEvent,
      crashMode,
      recoverMode,
      source,
      expireDuringDowntime,
    } of cases) {
      const homeDir = home();
      const run = (mode: string) => spawnSync(
        process.execPath,
        [
          vitest,
          "run",
          fixture,
          "--coverage.enabled=false",
          "--pool=forks",
          "--maxWorkers=1",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            LCM_BACKEND_PUBLICATION_CRASH_HOME: homeDir,
            LCM_BACKEND_PUBLICATION_CRASH_MODE: mode,
            LCM_BACKEND_PUBLICATION_CRASH_EVENT: crashEvent,
            LCM_BACKEND_PUBLICATION_CRASH_SOURCE: source,
          },
          timeout: 30_000,
        },
      );
      const crashed = run(crashMode);
      expect(
        crashed.status,
        `${crashEvent} unexpectedly survived:\n${crashed.stdout}\n${crashed.stderr}`,
      ).not.toBe(0);
      if (expireDuringDowntime) {
        const journal = readBackendPublicationJournal(homeDir)!;
        let expired = 0;
        for (const project of journal.projects) {
          if (project.fence === null) continue;
          const path = join(
            homeDir,
            ".lcm",
            "backend-publication-remote",
            `${project.remoteProjectId}.json`,
          );
          const remote = JSON.parse(
            readFileSync(path, "utf8"),
          ) as BackendPublicationFenceRecord;
          if (
            remote.releasedAt === null
            && BigInt(remote.fencingToken) > BigInt(project.fence.fencingToken)
          ) {
            writeFileSync(path, JSON.stringify({ ...remote, databaseExpired: true }));
            expired += 1;
          }
        }
        expect(expired).toBeGreaterThan(0);
      }
      const recovered = run(recoverMode);
      expect(
        recovered.status,
        `${crashEvent} did not recover:\n${recovered.stdout}\n${recovered.stderr}`,
      ).toBe(0);
    }
  });
});

function guardedFrom(initial: ReturnType<typeof prepare>, homeDir: string) {
  const acquiring = acquiringFrom(initial, homeDir);
  return advanceBackendPublication({
    publicationId: PUBLICATION,
    expectedChecksumSha256: acquiring.checksumSha256,
    phase: "guarded",
    homeDir,
  });
}

function finishAbortFromConfigRestored(
  journal: ReturnType<typeof prepare>,
  homeDir: string,
) {
  let next = advanceBackendPublication({
    publicationId: PUBLICATION,
    expectedChecksumSha256: journal.checksumSha256,
      phase: "map-restored",
    publishedProjectMapSha256: journal.expectedProjectMapSha256,
    homeDir,
  });
  next = advanceBackendPublication({
    publicationId: PUBLICATION,
    expectedChecksumSha256: next.checksumSha256,
      phase: "abort-releasing",
    projects: next.projects.map((project) => ({
      ...project,
      fence: project.fence === null
        ? null
        : { ...project.fence, releasedAt: "2026-08-01T00:02:00.000Z" },
    })),
    homeDir,
  });
  return advanceBackendPublication({
    publicationId: PUBLICATION,
    expectedChecksumSha256: next.checksumSha256,
    phase: "aborted",
    homeDir,
  });
}

function abortPreparedPublication(homeDir: string) {
  let journal = prepare(homeDir);
  journal = advanceBackendPublication({
    publicationId: PUBLICATION,
    expectedChecksumSha256: journal.checksumSha256,
    phase: "abort-prepared",
    homeDir,
  });
  journal = advanceBackendPublication({
    publicationId: PUBLICATION,
    expectedChecksumSha256: journal.checksumSha256,
    phase: "config-restored",
    publishedConfigSha256: journal.expectedConfigSha256,
    homeDir,
  });
  return finishAbortFromConfigRestored(journal, homeDir);
}

function rewriteJournal(
  homeDir: string,
  mutate: (journal: Record<string, unknown>) => void,
  recomputeChecksum = true,
): void {
  const path = backendPublicationJournalPath(homeDir);
  const journal = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(journal);
  if (recomputeChecksum) {
    delete journal.checksumSha256;
    journal.checksumSha256 = createHash("sha256")
      .update(JSON.stringify(journal))
      .digest("hex");
  }
  writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
}
