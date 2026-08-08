import {
  captureBackendPublicationState,
  BackendPublicationCoordinator,
  assertBackendPublicationConsumerAccess,
  assertBackendPublicationPermit,
  assertBackendPublicationConfigAccess,
  assertBackendPublicationConfigMutation,
  assertBackendPublicationProjectMapAccess,
  assertBackendPublicationProjectMapMutation,
  backendPublicationCanonicalSha256,
  backendPublicationConfigSha256,
  backendPublicationDirectory,
  backendPublicationJournalPath,
  backendPublicationProjectMapSha256,
  readBackendPublicationJournal,
  withBackendPublicationConfigLock,
  withBackendPublicationConfigLockAsync,
  withBackendPublicationConsumerLock,
  withBackendPublicationConsumerLockAsync,
  withBackendPublicationPermit,
  type BackendPublicationDriver,
  type BackendPublicationFileMutationContext,
  type BackendPublicationRecoveryFile,
  type BackendPublicationRecoveryMaterial,
} from "../src/storage/backend-publication.js";
import { applyBackendPublicationConfigFile } from "../src/config-manager.js";
import { applyBackendPublicationProjectMapFile } from "../src/project-map.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrivateMutationPermit } from "../src/private-mutation-lock.js";

const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-consumer-publication-"));
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  homes.push(home);
  return home;
}

function file(content: string, mode = 0o600): BackendPublicationRecoveryFile {
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

function fixture(): {
  home: string;
  sourceConfig: string;
  sourceMap: string;
  targetConfig: string;
  targetMap: string;
  material: BackendPublicationRecoveryMaterial;
} {
  const home = makeHome();
  const project = join(home, "project");
  mkdirSync(project);
  const sourceConfig = '{"storage":{"backend":"sqlite"}}\n';
  const sourceMap = "{}\n";
  const targetConfig = '{"storage":{"backend":"postgresql"}}\n';
  const targetHash = "a".repeat(64);
  const targetMap = JSON.stringify({
    [targetHash]: { canonical: project, aliases: [] },
  }) + "\n";
  writeFileSync(join(home, ".lcm", "config.json"), sourceConfig, { mode: 0o600 });
  writeFileSync(join(home, ".lcm", "map.json"), sourceMap, { mode: 0o600 });
  return {
    home,
    sourceConfig,
    sourceMap,
    targetConfig,
    targetMap,
    material: {
      source: { config: file(sourceConfig), projectMap: file(sourceMap) },
      target: { config: file(targetConfig), projectMap: file(targetMap) },
    },
  };
}

function driverFor(
  home: string,
  failConfigOnce = false,
  hooks: Readonly<{
    beforeConfig?: (input: BackendPublicationFileMutationContext) => void | Promise<void>;
    beforeProjectMap?: (input: BackendPublicationFileMutationContext) => void | Promise<void>;
  }> = {},
): BackendPublicationDriver {
  let failConfig = failConfigOnce;
  return {
    observeLocalState: async () => captureBackendPublicationState(home),
    publishProjectMap: async (input) => {
      await hooks.beforeProjectMap?.(input);
      return applyBackendPublicationProjectMapFile(input);
    },
    publishConfig: async (input) => {
      await hooks.beforeConfig?.(input);
      const result = await applyBackendPublicationConfigFile(input);
      if (failConfig) {
        failConfig = false;
        throw new Error("injected config publication failure");
      }
      return result;
    },
    restoreConfig: (input) => applyBackendPublicationConfigFile(input),
    restoreProjectMap: (input) => applyBackendPublicationProjectMapFile(input),
  };
}

function rewriteJournal(
  home: string,
  mutate: (journal: Record<string, unknown>) => Record<string, unknown>,
): NonNullable<ReturnType<typeof readBackendPublicationJournal>> {
  const current = readBackendPublicationJournal(home);
  if (current === null) throw new Error("test fixture has no journal");
  const { checksumSha256: _checksum, ...payload } = current;
  const next = mutate({ ...payload });
  writeFileSync(
    backendPublicationJournalPath(home),
    JSON.stringify({
      ...next,
      checksumSha256: backendPublicationCanonicalSha256(next),
    }) + "\n",
    { mode: 0o600 },
  );
  const rewritten = readBackendPublicationJournal(home);
  if (rewritten === null) throw new Error("test fixture journal disappeared");
  return rewritten;
}

async function pendingFixture(): Promise<{
  home: string;
  sourceConfig: string;
  sourceMap: string;
  targetMap: string;
  journal: NonNullable<ReturnType<typeof readBackendPublicationJournal>>;
}> {
  const values = fixture();
  const coordinator = new BackendPublicationCoordinator({
    homeDir: values.home,
    driver: driverFor(values.home),
  });
  await coordinator.prepare({
    publicationId: "consumer-pending",
    sourceBackend: "sqlite",
    targetBackend: "postgresql",
    material: values.material,
    projects: [],
    now: new Date("2026-08-06T12:00:00.000Z"),
  });
  const journal = readBackendPublicationJournal(values.home);
  if (journal === null) throw new Error("test fixture did not create a publication journal");
  return {
    home: values.home,
    sourceConfig: values.sourceConfig,
    sourceMap: values.sourceMap,
    targetMap: values.targetMap,
    journal,
  };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("local backend-publication consumer seam", () => {
  it("publishes and preserves the exact authenticated config and project-map bytes", async () => {
    const { home, targetConfig, targetMap, material } = fixture();
    const coordinator = new BackendPublicationCoordinator({
      homeDir: home,
      driver: driverFor(home),
    });

    await coordinator.prepare({
      publicationId: "consumer-publication",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material,
      projects: [],
      now: new Date("2026-08-06T12:00:00.000Z"),
    });
    const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      await expect(coordinator.resume()).resolves.toMatchObject({ phase: "completed" });
    } finally {
      if (getuidDescriptor) Object.defineProperty(process, "getuid", getuidDescriptor);
    }

    expect(readFileSync(join(home, ".lcm", "config.json"), "utf8")).toBe(targetConfig);
    expect(readFileSync(join(home, ".lcm", "map.json"), "utf8")).toBe(targetMap);
    expect(() => assertBackendPublicationConsumerAccess({
      homeDir: home,
      backend: "postgresql",
    })).not.toThrow();
    expect(() => assertBackendPublicationConsumerAccess({
      homeDir: home,
      backend: "sqlite",
    })).toThrow("backend does not match");
    expect(() => assertBackendPublicationConfigAccess(
      join(home, ".lcm", "config.json"),
      "postgresql",
      targetConfig,
    )).not.toThrow();
    expect(() => assertBackendPublicationConfigAccess(
      join(home, ".lcm", "config.json"),
      "sqlite",
      targetConfig,
    )).toThrow("stored backend");
    expect(() => assertBackendPublicationConfigAccess(
      join(home, ".lcm", "config.json"),
      "postgresql",
    )).not.toThrow();
    expect(() => assertBackendPublicationConfigAccess(
      join(home, ".lcm", "config.json"),
      "postgresql",
      "wrong\n",
    )).toThrow("descriptor-bound witness");
    expect(() => assertBackendPublicationConfigMutation(
      join(home, ".lcm", "config.json"),
      "postgresql",
      "postgresql",
      targetConfig,
      targetConfig,
    )).not.toThrow();
    expect(() => assertBackendPublicationConfigMutation(
      join(home, ".lcm", "config.json"),
      "postgresql",
      "sqlite",
      "{}\n",
      targetConfig,
    )).toThrow("conflicts with publication evidence");
    expect(() => assertBackendPublicationConfigMutation(
      join(home, ".lcm", "config.json"),
      "postgresql",
      "postgresql",
      targetConfig,
    )).not.toThrow();
    expect(() => assertBackendPublicationProjectMapMutation(
      { ["a".repeat(64)]: { canonical: join(home, "project"), aliases: [] } },
      home,
      targetMap,
    )).not.toThrow();
  });

  it("rejects candidate bytes and semantics that do not match the coordinator witness", async () => {
    const values = fixture();
    const coordinator = new BackendPublicationCoordinator({
      homeDir: values.home,
      driver: driverFor(values.home, false, {
        beforeProjectMap: (input) => {
          expect(() => assertBackendPublicationProjectMapMutation(
            {},
            values.home,
            "{not-json",
            input.permit,
          )).toThrow("semantic JSON is invalid");
          expect(() => assertBackendPublicationProjectMapMutation(
            { ["a".repeat(64)]: { canonical: join(values.home, "wrong"), aliases: [] } },
            values.home,
            undefined,
            input.permit,
          )).toThrow("semantics");
        },
        beforeConfig: (input) => {
          expect(() => assertBackendPublicationConfigMutation(
            join(values.home, ".lcm", "config.json"),
            "sqlite",
            "postgresql",
            '{"storage":{"backend":"postgresql","extra":true}}\n',
            values.sourceConfig,
            input.permit,
          )).toThrow("bytes do not match");
        },
      }),
    });
    await coordinator.prepare({
      publicationId: "consumer-candidate-witness",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: values.material,
      projects: [],
    });
    await expect(coordinator.resume()).resolves.toMatchObject({ phase: "completed" });
  });

  it("rejects invalid coordinator access, UTF-8 material, and changed or mismatched witnesses", async () => {
    const values = fixture();
    const invalidAccessCoordinator = new BackendPublicationCoordinator({
      homeDir: values.home,
      driver: driverFor(values.home, false, {
        beforeConfig: async (input) => {
          await expect(applyBackendPublicationConfigFile({
            ...input,
            mutationAccess: "read-recovery",
          } as unknown as BackendPublicationFileMutationContext)).rejects.toThrow(
            "Invalid coordinator access",
          );
          if (input.expectedWitness.presence !== "present") throw new Error("test target witness is absent");
          await expect(applyBackendPublicationConfigFile({
            ...input,
            expectedWitness: {
              ...input.expectedWitness,
              rawSha256: "0".repeat(64),
            },
          })).rejects.toThrow("after publication");
        },
      }),
    });
    await invalidAccessCoordinator.prepare({
      publicationId: "consumer-config-witness",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: values.material,
      projects: [],
    });
    await expect(invalidAccessCoordinator.resume()).rejects.toThrow("changed before coordinator publication");

    const invalidMaterial = fixture();
    const invalidTargetConfig: BackendPublicationRecoveryFile = {
      ...file("placeholder"),
      content: Buffer.from([0xff]),
    };
    const invalidMaterialCoordinator = new BackendPublicationCoordinator({
      homeDir: invalidMaterial.home,
      driver: driverFor(invalidMaterial.home),
    });
    await invalidMaterialCoordinator.prepare({
      publicationId: "consumer-invalid-config-material",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: {
        ...invalidMaterial.material,
        target: { ...invalidMaterial.material.target, config: invalidTargetConfig },
      },
      projects: [],
    });
    await expect(invalidMaterialCoordinator.resume()).rejects.toThrow("not UTF-8");

    const invalidMapMaterial = fixture();
    const invalidTargetMap: BackendPublicationRecoveryFile = {
      ...file("placeholder"),
      content: Buffer.from([0xff]),
    };
    const invalidMapCoordinator = new BackendPublicationCoordinator({
      homeDir: invalidMapMaterial.home,
      driver: driverFor(invalidMapMaterial.home),
    });
    await invalidMapCoordinator.prepare({
      publicationId: "consumer-invalid-map-material",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: {
        ...invalidMapMaterial.material,
        target: { ...invalidMapMaterial.material.target, projectMap: invalidTargetMap },
      },
      projects: [],
    });
    await expect(invalidMapCoordinator.resume()).rejects.toThrow("not UTF-8");
  });

  it("rejects invalid and changed project-map coordinator witnesses", async () => {
    const values = fixture();
    const coordinator = new BackendPublicationCoordinator({
      homeDir: values.home,
      driver: driverFor(values.home, false, {
        beforeProjectMap: async (input) => {
          await expect(applyBackendPublicationProjectMapFile({
            ...input,
            mutationAccess: "read-recovery",
          } as unknown as BackendPublicationFileMutationContext)).rejects.toThrow(
            "invalid coordinator access",
          );
          if (input.expectedWitness.presence !== "present") throw new Error("test target witness is absent");
          await expect(applyBackendPublicationProjectMapFile({
            ...input,
            expectedWitness: {
              ...input.expectedWitness,
              rawSha256: "0".repeat(64),
            },
          })).rejects.toThrow("after publication");
        },
      }),
    });
    await coordinator.prepare({
      publicationId: "consumer-project-map-witness",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: values.material,
      projects: [],
    });
    await expect(coordinator.resume()).rejects.toThrow("changed before coordinator publication");
  });

  it("restores exact source bytes through the same seam after a config publication failure", async () => {
    const { home, sourceConfig, sourceMap, material } = fixture();
    const coordinator = new BackendPublicationCoordinator({
      homeDir: home,
      driver: driverFor(home, true),
    });
    await coordinator.prepare({
      publicationId: "consumer-abort",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material,
      projects: [],
      now: new Date("2026-08-06T12:00:00.000Z"),
    });

    await expect(coordinator.resume()).rejects.toThrow("injected config publication failure");
    await expect(coordinator.abort()).resolves.toMatchObject({ phase: "aborted" });
    expect(readFileSync(join(home, ".lcm", "config.json"), "utf8")).toBe(sourceConfig);
    expect(readFileSync(join(home, ".lcm", "map.json"), "utf8")).toBe(sourceMap);
  });

  it.each([0o400, 0o500, 0o600, 0o700])(
    "preserves authenticated owner-readable mode %o through config/map publish and abort replay",
    async (mode) => {
    const published = fixture();
    const publishedMaterial: BackendPublicationRecoveryMaterial = {
      ...published.material,
      target: {
        ...published.material.target,
        config: file(published.targetConfig, mode),
        projectMap: file(published.targetMap, mode),
      },
    };
    const publisher = new BackendPublicationCoordinator({
      homeDir: published.home,
      driver: driverFor(published.home),
    });
    await publisher.prepare({
      publicationId: "consumer-owner-readonly-publish",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: publishedMaterial,
      projects: [],
    });
    await expect(publisher.resume()).resolves.toMatchObject({ phase: "completed" });
    expect(statSync(join(published.home, ".lcm", "config.json")).mode & 0o777).toBe(mode);
    expect(statSync(join(published.home, ".lcm", "map.json")).mode & 0o777).toBe(mode);

    const aborted = fixture();
    const abortedMaterial: BackendPublicationRecoveryMaterial = {
      ...aborted.material,
      target: {
        ...aborted.material.target,
        config: file(aborted.targetConfig, mode),
        projectMap: file(aborted.targetMap, mode),
      },
    };
    const aborter = new BackendPublicationCoordinator({
      homeDir: aborted.home,
      driver: driverFor(aborted.home, true),
    });
    await aborter.prepare({
      publicationId: "consumer-owner-readonly-abort",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: abortedMaterial,
      projects: [],
    });
    await expect(aborter.resume()).rejects.toThrow("injected config publication failure");
    await expect(aborter.abort()).resolves.toMatchObject({ phase: "aborted" });
    expect(statSync(join(aborted.home, ".lcm", "config.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(aborted.home, ".lcm", "map.json")).mode & 0o777).toBe(0o600);
    },
  );

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
  ])("rejects recovery material %o mode before publication and leaves no journal", async (mode) => {
    const values = fixture();
    const invalidMaterial: BackendPublicationRecoveryMaterial = {
      ...values.material,
      source: {
        ...values.material.source,
        config: file(values.sourceConfig, mode),
        projectMap: file(values.sourceMap, mode),
      },
    };
    const coordinator = new BackendPublicationCoordinator({
      homeDir: values.home,
      driver: driverFor(values.home),
    });

    await expect(coordinator.prepare({
      publicationId: `consumer-invalid-mode-${mode}`,
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: invalidMaterial,
      projects: [],
    })).rejects.toMatchObject({ reason: "invalid-input" });
    expect(readBackendPublicationJournal(values.home)).toBeNull();
    expect(existsSync(join(values.home, ".lcm", "backend-publication", `consumer-invalid-mode-${mode}.material`)))
      .toBe(false);
  });

  it("fails closed when the map changes to unrelated content before abort restoration", async () => {
    const { home, material } = fixture();
    const coordinator = new BackendPublicationCoordinator({
      homeDir: home,
      driver: driverFor(home, true),
    });
    await coordinator.prepare({
      publicationId: "consumer-abort-map-mismatch",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material,
      projects: [],
    });
    await expect(coordinator.resume()).rejects.toThrow("injected config publication failure");
    writeFileSync(join(home, ".lcm", "map.json"), '{"unrelated":{"canonical":"/tmp/other","aliases":[]}}\n', { mode: 0o600 });
    await expect(coordinator.abort()).rejects.toThrow("project map before restore");
  });

  it("publishes authenticated absent target files without creating replacement bytes", async () => {
    const values = fixture();
    const sourceConfig = '{"storage":{"backend":"postgresql"}}\n';
    writeFileSync(join(values.home, ".lcm", "config.json"), sourceConfig, { mode: 0o600 });
    const material: BackendPublicationRecoveryMaterial = {
      source: {
        config: file(sourceConfig),
        projectMap: file(values.sourceMap),
      },
      target: {
        config: { presence: "absent" },
        projectMap: { presence: "absent" },
      },
    };
    const coordinator = new BackendPublicationCoordinator({
      homeDir: values.home,
      driver: driverFor(values.home),
    });
    await coordinator.prepare({
      publicationId: "consumer-absent-target",
      sourceBackend: "postgresql",
      targetBackend: "sqlite",
      material,
      projects: [],
      now: new Date("2026-08-06T12:00:00.000Z"),
    });
    const absentTargetUidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      await expect(coordinator.resume()).resolves.toMatchObject({ phase: "completed" });
    } finally {
      if (absentTargetUidDescriptor) Object.defineProperty(process, "getuid", absentTargetUidDescriptor);
    }
    expect(() => readFileSync(join(values.home, ".lcm", "config.json"))).toThrow();
    expect(() => readFileSync(join(values.home, ".lcm", "map.json"))).toThrow();
    expect(() => assertBackendPublicationConfigAccess(
      join(values.home, ".lcm", "config.json"),
      "sqlite",
      null,
    )).not.toThrow();
    expect(() => assertBackendPublicationProjectMapAccess({
      homeDir: values.home,
      content: null,
      map: {},
      present: false,
    })).not.toThrow();

    const normalDeletion = fixture();
    const normalSourceConfig = '{"storage":{"backend":"postgresql"}}\n';
    writeFileSync(join(normalDeletion.home, ".lcm", "config.json"), normalSourceConfig, { mode: 0o600 });
    const normalCoordinator = new BackendPublicationCoordinator({
      homeDir: normalDeletion.home,
      driver: driverFor(normalDeletion.home),
    });
    await normalCoordinator.prepare({
      publicationId: "consumer-absent-target-normal-uid",
      sourceBackend: "postgresql",
      targetBackend: "sqlite",
      material: {
        source: {
          config: file(normalSourceConfig),
          projectMap: file(normalDeletion.sourceMap),
        },
        target: {
          config: { presence: "absent" },
          projectMap: { presence: "absent" },
        },
      },
      projects: [],
    });
    await expect(normalCoordinator.resume()).resolves.toMatchObject({ phase: "completed" });
  });

  it("publishes authenticated target files when both source files are absent", async () => {
    const values = fixture();
    rmSync(join(values.home, ".lcm", "config.json"));
    rmSync(join(values.home, ".lcm", "map.json"));
    const targetConfig = '{"storage":{"backend":"sqlite"}}\n';
    const material: BackendPublicationRecoveryMaterial = {
      source: {
        config: { presence: "absent" },
        projectMap: { presence: "absent" },
      },
      target: {
        config: file(targetConfig),
        projectMap: file(values.targetMap),
      },
    };
    const coordinator = new BackendPublicationCoordinator({
      homeDir: values.home,
      driver: driverFor(values.home),
    });
    await coordinator.prepare({
      publicationId: "consumer-absent-source",
      sourceBackend: "postgresql",
      targetBackend: "sqlite",
      material,
      projects: [],
    });
    const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      await expect(coordinator.resume()).resolves.toMatchObject({ phase: "completed" });
    } finally {
      if (getuidDescriptor) Object.defineProperty(process, "getuid", getuidDescriptor);
    }
    expect(readFileSync(join(values.home, ".lcm", "config.json"), "utf8")).toBe(targetConfig);
    expect(readFileSync(join(values.home, ".lcm", "map.json"), "utf8")).toBe(values.targetMap);
  });

  it("handles an authenticated absent-to-absent config mutation", async () => {
    const values = fixture();
    rmSync(join(values.home, ".lcm", "config.json"));
    const material: BackendPublicationRecoveryMaterial = {
      source: {
        config: { presence: "absent" },
        projectMap: file(values.sourceMap),
      },
      target: {
        config: { presence: "absent" },
        projectMap: file(values.targetMap),
      },
    };
    const coordinator = new BackendPublicationCoordinator({
      homeDir: values.home,
      driver: driverFor(values.home),
    });
    await coordinator.prepare({
      publicationId: "consumer-absent-config-noop",
      sourceBackend: "postgresql",
      targetBackend: "sqlite",
      material,
      projects: [],
    });
    const journal = rewriteJournal(values.home, (current) => ({ ...current, phase: "map-published" }));
    await withBackendPublicationPermit({
      publicationId: journal.publicationId,
      expectedChecksumSha256: journal.checksumSha256,
      access: "publish-config",
      expectedWitness: journal.targetState.config,
      homeDir: values.home,
    }, async (permit) => {
      if (journal.recoveryReference === null) throw new Error("test journal reference is absent");
      await expect(applyBackendPublicationConfigFile({
        homeDir: values.home,
        journal,
        recoveryReference: journal.recoveryReference,
        material,
        file: material.target.config,
        expectedWitness: journal.targetState.config,
        permit,
        mutationAccess: "publish-config",
      })).resolves.toMatchObject({ presence: "absent" });
    });
  });

  it("handles an authenticated absent-to-absent project-map mutation", async () => {
    const values = fixture();
    rmSync(join(values.home, ".lcm", "map.json"));
    const material: BackendPublicationRecoveryMaterial = {
      source: {
        config: file(values.sourceConfig),
        projectMap: { presence: "absent" },
      },
      target: {
        config: file(values.targetConfig),
        projectMap: { presence: "absent" },
      },
    };
    const coordinator = new BackendPublicationCoordinator({
      homeDir: values.home,
      driver: driverFor(values.home),
    });
    await coordinator.prepare({
      publicationId: "consumer-absent-map-noop",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material,
      projects: [],
    });
    const journal = rewriteJournal(values.home, (current) => ({ ...current, phase: "guarded" }));
    await withBackendPublicationPermit({
      publicationId: journal.publicationId,
      expectedChecksumSha256: journal.checksumSha256,
      access: "publish-project-map",
      expectedWitness: journal.targetState.projectMap,
      homeDir: values.home,
    }, async (permit) => {
      if (journal.recoveryReference === null) throw new Error("test journal reference is absent");
      await expect(applyBackendPublicationProjectMapFile({
        homeDir: values.home,
        journal,
        recoveryReference: journal.recoveryReference,
        material,
        file: material.target.projectMap,
        expectedWitness: journal.targetState.projectMap,
        permit,
        mutationAccess: "publish-project-map",
      })).resolves.toMatchObject({ presence: "absent" });
    });
  });

  it("fails closed for an unresolved publication and for PostgreSQL without evidence", async () => {
    const pending = await pendingFixture();
    let callbackCalled = false;
    await expect(withBackendPublicationConsumerLockAsync(pending.home, async () => {
      callbackCalled = true;
    })).rejects.toMatchObject({ reason: "unresolved-publication" });
    expect(callbackCalled).toBe(false);

    const absent = makeHome();
    expect(() => assertBackendPublicationConsumerAccess({
      homeDir: absent,
      backend: "postgresql",
    })).toThrow("no completed backend publication evidence");
    const absentConfigPath = join(absent, ".lcm", "config.json");
    expect(() => assertBackendPublicationConfigAccess(
      absentConfigPath,
      "postgresql",
      null,
    )).toThrow("no completed backend publication evidence");
    expect(() => assertBackendPublicationConfigMutation(
      absentConfigPath,
      "sqlite",
      "postgresql",
      '{"storage":{"backend":"postgresql"}}\n',
      null,
    )).toThrow("requires publication control");
    expect(() => assertBackendPublicationConfigMutation(
      absentConfigPath,
      "sqlite",
      "sqlite",
      null,
      null,
    )).not.toThrow();
    expect(withBackendPublicationConfigLock(join(absent, "config.json"), () => "plain"))
      .toBe("plain");
    await expect(withBackendPublicationConfigLockAsync(join(absent, "config.json"), async () => "plain"))
      .resolves.toBe("plain");
    expect(() => assertBackendPublicationConfigAccess("config.json", "sqlite", null)).not.toThrow();
    expect(() => assertBackendPublicationConfigMutation("config.json", "sqlite", "sqlite", null, null))
      .not.toThrow();
  });

  it("serializes nested consumers with the exact lock token and rejects mismatches", async () => {
    const { home } = fixture();
    withBackendPublicationConsumerLock(home, (token) => {
      expect(() => assertBackendPublicationConsumerAccess({
        homeDir: home,
        lockToken: token,
      })).not.toThrow();
      expect(() => withBackendPublicationConsumerLock(
        home,
        (nestedToken) => expect(nestedToken).toBe(token),
        { lockToken: token },
      )).not.toThrow();
    });
    await withBackendPublicationConsumerLockAsync(home, async (token) => {
      await expect(withBackendPublicationConsumerLockAsync(
        home,
        async (nestedToken) => {
          expect(nestedToken).toBe(token);
        },
        { lockToken: token },
      )).resolves.toBeUndefined();
    });
    expect(() => assertBackendPublicationConsumerAccess({
      homeDir: home,
      lockToken: {} as never,
    })).toThrow("lock token is not active");

    let retainedToken: object | undefined;
    let lateCallback: Promise<void> | undefined;
    expect(() => withBackendPublicationConsumerLock(home, (token) => {
      retainedToken = token;
      lateCallback = Promise.resolve().then(() => assertBackendPublicationConsumerAccess({
        homeDir: home,
        lockToken: token,
      }));
      return lateCallback;
    })).toThrow("returned a promise");
    await expect(lateCallback).rejects.toThrow("lock token is not active");
    expect(() => assertBackendPublicationConsumerAccess({
      homeDir: home,
      lockToken: retainedToken,
    })).toThrow("lock token is not active");
  });

  it("uses the default home admission lock without creating publication roots", () => {
    const home = makeHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(withBackendPublicationConsumerLock(undefined, () => "default", { allowUnresolved: true }))
        .toBe("default");
      expect(readBackendPublicationJournal(home)).toBeNull();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("supports exact active permits for synchronous and asynchronous consumer/config callbacks", async () => {
    const pending = await pendingFixture();
    const { home, journal } = pending;
    const configPath = join(home, ".lcm", "config.json");
    const permitInput = {
      publicationId: journal.publicationId,
      expectedChecksumSha256: journal.checksumSha256,
      access: "read-recovery" as const,
      homeDir: home,
    };

    await withBackendPublicationPermit(permitInput, async (permit) => {
      withBackendPublicationConsumerLock(home, () => {
        permit.assertActive();
      }, { permit });
      await withBackendPublicationConsumerLockAsync(home, async () => {
        permit.assertActive();
      }, { permit });
      assertBackendPublicationConsumerAccess({ homeDir: home, permit });
      withBackendPublicationConfigLock(configPath, () => {
        permit.assertActive();
      }, permit);
      await expect(withBackendPublicationConfigLockAsync(configPath, async () => "config", permit))
        .resolves.toBe("config");
      assertBackendPublicationConfigAccess(
        configPath,
        "sqlite",
        pending.sourceConfig,
        permit,
      );
      assertBackendPublicationProjectMapAccess({
        homeDir: home,
        content: pending.sourceMap,
        map: {},
        present: true,
        permit,
      });
    });

    await expect(withBackendPublicationPermit({
      ...permitInput,
      expectedChecksumSha256: "0".repeat(64),
    }, () => undefined)).rejects.toMatchObject({ reason: "permit-mismatch" });

    expect(() => assertBackendPublicationPermit(undefined as never, home)).toThrow("permit is required");
    expect(() => assertBackendPublicationPermit(new PrivateMutationPermit("unregistered"), home))
      .toThrow("does not match durable state");

    const mapPublished = rewriteJournal(home, (current) => ({ ...current, phase: "map-published" }));
    await expect(withBackendPublicationPermit({
      publicationId: mapPublished.publicationId,
      expectedChecksumSha256: mapPublished.checksumSha256,
      access: "publish-project-map",
      expectedWitness: mapPublished.targetState.projectMap,
      homeDir: home,
    }, () => undefined)).rejects.toMatchObject({ reason: "permit-mismatch" });
    await expect(withBackendPublicationPermit({
      publicationId: mapPublished.publicationId,
      expectedChecksumSha256: mapPublished.checksumSha256,
      access: "publish-config",
      expectedWitness: mapPublished.targetState.config,
      stateSha256: "invalid",
      homeDir: home,
    }, () => undefined)).rejects.toMatchObject({ reason: "permit-mismatch" });
    await withBackendPublicationPermit({
      publicationId: mapPublished.publicationId,
      expectedChecksumSha256: mapPublished.checksumSha256,
      access: "read-recovery",
      homeDir: home,
    }, (permit) => {
      expect(() => assertBackendPublicationConfigMutation(
        configPath,
        "sqlite",
        "postgresql",
        '{"storage":{"backend":"postgresql"}}\n',
        pending.sourceConfig,
        permit,
      )).toThrow("not valid for publish-config");
    });
    await withBackendPublicationPermit({
      publicationId: mapPublished.publicationId,
      expectedChecksumSha256: mapPublished.checksumSha256,
      access: "publish-config",
      expectedWitness: mapPublished.targetState.config,
      homeDir: home,
    }, (permit) => {
      expect(() => assertBackendPublicationConfigMutation(
        configPath,
        "sqlite",
        "postgresql",
        '{"storage":{"backend":"postgresql"}}\n',
        pending.sourceConfig,
        permit,
      )).not.toThrow();
      expect(() => assertBackendPublicationConfigMutation(
        configPath,
        "sqlite",
        "sqlite",
        "{}\n",
        pending.sourceConfig,
        permit,
      )).toThrow("conflicts with publication evidence");
      expect(() => assertBackendPublicationConfigMutation(
        configPath,
        "sqlite",
        "postgresql",
        '{"storage":{"backend":"postgresql"}}\n',
        null,
        permit,
      )).toThrow("current config witness");
    });
    const prepared = rewriteJournal(home, (current) => ({ ...current, phase: "prepared" }));
    await expect(withBackendPublicationPermit({
      publicationId: prepared.publicationId,
      expectedChecksumSha256: prepared.checksumSha256,
      access: "read-recovery",
      homeDir: home,
    }, (permit) => {
      expect(() => assertBackendPublicationConfigMutation(
        configPath,
        "sqlite",
        "postgresql",
        '{"storage":{"backend":"postgresql"}}\n',
        pending.sourceConfig,
        permit,
      )).toThrow("not valid in the durable publication phase");
      expect(() => assertBackendPublicationProjectMapMutation(
        {},
        home,
        undefined,
        permit,
      )).toThrow("not valid in the durable publication phase");
    })).resolves.toBeUndefined();

    const restorePhases = await pendingFixture();
    const aborting = rewriteJournal(restorePhases.home, (current) => ({ ...current, phase: "aborting" }));
    await withBackendPublicationPermit({
      publicationId: aborting.publicationId,
      expectedChecksumSha256: aborting.checksumSha256,
      access: "restore-config",
      expectedWitness: aborting.sourceState.config,
      homeDir: restorePhases.home,
    }, (permit) => {
      expect(() => assertBackendPublicationConfigMutation(
        join(restorePhases.home, ".lcm", "config.json"),
        "sqlite",
        "sqlite",
        restorePhases.sourceConfig,
        restorePhases.sourceConfig,
        permit,
      )).not.toThrow();
    });
    const mapRestoring = rewriteJournal(restorePhases.home, (current) => ({ ...current, phase: "map-restoring" }));
    await withBackendPublicationPermit({
      publicationId: mapRestoring.publicationId,
      expectedChecksumSha256: mapRestoring.checksumSha256,
      access: "read-recovery",
      homeDir: restorePhases.home,
    }, (permit) => {
      expect(() => assertBackendPublicationConfigMutation(
        join(restorePhases.home, ".lcm", "config.json"),
        "sqlite",
        "sqlite",
        restorePhases.sourceConfig,
        restorePhases.sourceConfig,
        permit,
      )).toThrow("configuration mutation is not valid");
    });

    const guarded = await pendingFixture();
    const guardedJournal = rewriteJournal(guarded.home, (current) => ({ ...current, phase: "guarded" }));
    await withBackendPublicationPermit({
      publicationId: guardedJournal.publicationId,
      expectedChecksumSha256: guardedJournal.checksumSha256,
      access: "publish-project-map",
      expectedWitness: guardedJournal.targetState.projectMap,
      homeDir: guarded.home,
    }, (permit) => {
      expect(() => assertBackendPublicationProjectMapMutation(
        JSON.parse(guarded.targetMap) as unknown,
        guarded.home,
        undefined,
        permit,
      )).not.toThrow();
    });

    const missingJournal = await pendingFixture();
    await withBackendPublicationPermit({
      publicationId: missingJournal.journal.publicationId,
      expectedChecksumSha256: missingJournal.journal.checksumSha256,
      access: "read-recovery",
      homeDir: missingJournal.home,
    }, (permit) => {
      rmSync(backendPublicationJournalPath(missingJournal.home));
      rmSync(join(
        backendPublicationDirectory(missingJournal.home),
        `${missingJournal.journal.publicationId}.material`,
      ));
      expect(() => assertBackendPublicationConsumerAccess({
        homeDir: missingJournal.home,
        permit,
      })).toThrow("no durable journal");
    });

    let revokedPermit: PrivateMutationPermit | undefined;
    await expect(withBackendPublicationPermit(permitInput, (permit) => {
      revokedPermit = permit;
      expect(() => withBackendPublicationConsumerLock(
        home,
        () => Promise.resolve("late"),
        { permit },
      )).toThrow("returned a promise");
      expect(() => assertBackendPublicationConsumerAccess({ homeDir: home, permit }))
        .toThrow("no longer active");
    })).resolves.toBeUndefined();
    expect(revokedPermit?.active).toBe(false);
  });

  it("requires mutation permits to bind an exact authenticated expected witness", async () => {
    const pending = await pendingFixture();
    const mapPublished = rewriteJournal(pending.home, (current) => ({ ...current, phase: "map-published" }));
    const missingWitness = {
      publicationId: mapPublished.publicationId,
      expectedChecksumSha256: mapPublished.checksumSha256,
      access: "publish-config" as const,
      homeDir: pending.home,
    } as never;
    await expect(withBackendPublicationPermit(missingWitness, () => undefined))
      .rejects.toMatchObject({ reason: "permit-mismatch" });

    await expect(withBackendPublicationPermit({
      publicationId: mapPublished.publicationId,
      expectedChecksumSha256: mapPublished.checksumSha256,
      access: "publish-config",
      expectedWitness: {
        ...mapPublished.targetState.config,
        rawSha256: "0".repeat(64),
      },
      homeDir: pending.home,
    }, () => undefined)).rejects.toMatchObject({ reason: "permit-mismatch" });

    await withBackendPublicationPermit({
      publicationId: mapPublished.publicationId,
      expectedChecksumSha256: mapPublished.checksumSha256,
      access: "publish-config",
      expectedWitness: mapPublished.targetState.config,
      homeDir: pending.home,
    }, (permit) => {
      expect(() => assertBackendPublicationConfigMutation(
        join(pending.home, ".lcm", "config.json"),
        "sqlite",
        "postgresql",
        '{"storage":{"backend":"postgresql"}}\n',
        pending.sourceConfig,
        permit,
      )).not.toThrow();
    });
  });

  it("keeps ordinary SQLite mutations safe without evidence and rejects PostgreSQL activation", async () => {
    const values = fixture();
    const configPath = join(values.home, ".lcm", "config.json");
    expect(() => assertBackendPublicationConfigAccess(
      configPath,
      "sqlite",
      values.sourceConfig,
    )).not.toThrow();
    expect(() => assertBackendPublicationConfigMutation(
      configPath,
      "sqlite",
      "sqlite",
      values.sourceConfig,
      values.sourceConfig,
    )).not.toThrow();
    expect(() => assertBackendPublicationConfigMutation(
      configPath,
      "sqlite",
      "postgresql",
      '{"storage":{"backend":"postgresql"}}\n',
      values.sourceConfig,
    )).toThrow("requires publication control");
    expect(() => assertBackendPublicationProjectMapMutation(
      {},
      values.home,
      values.sourceMap,
    )).not.toThrow();
    expect(() => assertBackendPublicationProjectMapAccess({
      homeDir: values.home,
      content: null,
      map: {},
      present: false,
    })).not.toThrow();
    withBackendPublicationConsumerLock(values.home, (token) => {
      expect(() => assertBackendPublicationConfigAccess(
        configPath,
        "sqlite",
        values.sourceConfig,
        undefined,
        token,
      )).not.toThrow();
      expect(() => assertBackendPublicationConfigMutation(
        configPath,
        "sqlite",
        "sqlite",
        values.sourceConfig,
        values.sourceConfig,
        undefined,
        token,
      )).not.toThrow();
      expect(() => assertBackendPublicationProjectMapMutation(
        {},
        values.home,
        values.sourceMap,
        undefined,
        token,
      )).not.toThrow();
      expect(() => assertBackendPublicationProjectMapAccess({
        homeDir: values.home,
        content: values.sourceMap,
        map: {},
        present: true,
        lockToken: token,
      })).not.toThrow();
    });
    const missingRoot = mkdtempSync(join(tmpdir(), "lcm-consumer-publication-no-root-"));
    homes.push(missingRoot);
    expect(withBackendPublicationConsumerLock(missingRoot, () => "missing-root", { allowUnresolved: true }))
      .toBe("missing-root");
    await expect(withBackendPublicationConsumerLockAsync(
      missingRoot,
      async () => "missing-root-async",
      { allowUnresolved: true },
    )).resolves.toBe("missing-root-async");
  });

  it("fails closed for publication residue without a journal and for mismatched map witnesses", async () => {
    const values = fixture();
    const publicationDir = backendPublicationDirectory(values.home);
    mkdirSync(publicationDir, { mode: 0o700 });
    writeFileSync(join(publicationDir, "unexpected"), "residue", { mode: 0o600 });
    expect(() => assertBackendPublicationConfigAccess(
      join(values.home, ".lcm", "config.json"),
      "sqlite",
      values.sourceConfig,
    )).toThrow("unknown residue");

    rmSync(join(publicationDir, "unexpected"));
    const coordinator = new BackendPublicationCoordinator({
      homeDir: values.home,
      driver: driverFor(values.home),
    });
    await coordinator.prepare({
      publicationId: "consumer-map-witness",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: values.material,
      projects: [],
      now: new Date("2026-08-06T12:00:00.000Z"),
    });
    await coordinator.resume();
    expect(() => assertBackendPublicationProjectMapAccess({
      homeDir: values.home,
      content: values.targetMap,
      map: { ["a".repeat(64)]: { canonical: join(values.home, "wrong"), aliases: [] } },
      present: true,
    })).toThrow("semantics");
    expect(() => assertBackendPublicationProjectMapAccess({
      homeDir: values.home,
      content: null,
      map: {},
      present: true,
    })).toThrow("presence and content disagree");
  });

  it("validates terminal journal evidence before allowing local readers", async () => {
    const missingReference = fixture();
    const missingReferenceCoordinator = new BackendPublicationCoordinator({
      homeDir: missingReference.home,
      driver: driverFor(missingReference.home),
    });
    await missingReferenceCoordinator.prepare({
      publicationId: "consumer-terminal-reference",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: missingReference.material,
      projects: [],
    });
    await missingReferenceCoordinator.resume();
    rewriteJournal(missingReference.home, (journal) => ({
      ...journal,
      recoveryReference: null,
    }));
    expect(() => assertBackendPublicationConsumerAccess({
      homeDir: missingReference.home,
      backend: "postgresql",
    })).toThrow("no recovery reference");

    const activeFence = fixture();
    const activeFenceCoordinator = new BackendPublicationCoordinator({
      homeDir: activeFence.home,
      driver: driverFor(activeFence.home),
    });
    await activeFenceCoordinator.prepare({
      publicationId: "consumer-terminal-fence",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: activeFence.material,
      projects: [{
        localProjectId: "local",
        remoteProjectId: "remote",
        evidenceSha256: "a".repeat(64),
      }],
    });
    await activeFenceCoordinator.resume();
    rewriteJournal(activeFence.home, (journal) => ({
      ...journal,
      projects: [{
        ...((journal.projects as Record<string, unknown>[])[0]),
        fence: {
          projectId: "remote",
          machineId: "machine",
          publicationId: journal.publicationId,
          targetBackend: journal.targetBackend,
          evidenceSha256: "a".repeat(64),
          fencingToken: "1",
          acquiredAt: "2026-08-06T12:00:00.000Z",
          renewedAt: "2026-08-06T12:00:00.000Z",
          expiresAt: "2999-08-06T12:00:00.000Z",
          releasedAt: null,
          databaseExpired: false,
        },
      }],
    }));
    expect(() => assertBackendPublicationConsumerAccess({
      homeDir: activeFence.home,
      backend: "postgresql",
    })).toThrow("active remote fence");
    rewriteJournal(activeFence.home, (journal) => ({
      ...journal,
      projects: [{
        ...((journal.projects as Record<string, unknown>[])[0]),
        fence: {
          ...(((journal.projects as Record<string, unknown>[])[0]?.fence) as Record<string, unknown>),
          releasedAt: "2026-08-06T12:01:00.000Z",
        },
      }],
    }));
    expect(() => assertBackendPublicationConsumerAccess({
      homeDir: activeFence.home,
      backend: "postgresql",
    })).not.toThrow();

    const witnessMismatch = fixture();
    const witnessCoordinator = new BackendPublicationCoordinator({
      homeDir: witnessMismatch.home,
      driver: driverFor(witnessMismatch.home),
    });
    await witnessCoordinator.prepare({
      publicationId: "consumer-terminal-witness",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: witnessMismatch.material,
      projects: [],
    });
    await witnessCoordinator.resume();
    rewriteJournal(witnessMismatch.home, (journal) => ({
      ...journal,
      publishedConfigSha256: "0".repeat(64),
    }));
    expect(() => assertBackendPublicationConsumerAccess({
      homeDir: witnessMismatch.home,
      backend: "postgresql",
    })).toThrow("intended-state witnesses");

    const tamperedMaterial = fixture();
    const tamperedCoordinator = new BackendPublicationCoordinator({
      homeDir: tamperedMaterial.home,
      driver: driverFor(tamperedMaterial.home),
    });
    await tamperedCoordinator.prepare({
      publicationId: "consumer-terminal-tamper",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: tamperedMaterial.material,
      projects: [],
    });
    await tamperedCoordinator.resume();
    writeFileSync(
      join(backendPublicationDirectory(tamperedMaterial.home), "consumer-terminal-tamper.material"),
      "tampered",
      { mode: 0o600 },
    );
    expect(() => assertBackendPublicationConsumerAccess({
      homeDir: tamperedMaterial.home,
      backend: "postgresql",
    })).toThrow("checksum");

    const aborted = await pendingFixture();
    await new BackendPublicationCoordinator({
      homeDir: aborted.home,
      driver: driverFor(aborted.home),
    }).abort();
    expect(() => assertBackendPublicationConsumerAccess({
      homeDir: aborted.home,
      backend: "sqlite",
    })).not.toThrow();
    expect(() => assertBackendPublicationConfigAccess(
      join(aborted.home, ".lcm", "config.json"),
      "sqlite",
      aborted.sourceConfig,
    )).not.toThrow();
    expect(() => assertBackendPublicationConfigMutation(
      join(aborted.home, ".lcm", "config.json"),
      "sqlite",
      "sqlite",
      aborted.sourceConfig,
    )).not.toThrow();
  });

  it("distinguishes empty, orphaned, and unsafe publication directories", () => {
    const empty = fixture();
    mkdirSync(backendPublicationDirectory(empty.home), { mode: 0o700 });
    expect(() => assertBackendPublicationConfigMutation(
      join(empty.home, ".lcm", "config.json"),
      "sqlite",
      "sqlite",
      empty.sourceConfig,
      empty.sourceConfig,
    )).not.toThrow();
    expect(() => assertBackendPublicationProjectMapMutation(
      {},
      empty.home,
      empty.sourceMap,
    )).not.toThrow();

    const orphaned = fixture();
    mkdirSync(backendPublicationDirectory(orphaned.home), { mode: 0o700 });
    writeFileSync(join(backendPublicationDirectory(orphaned.home), "orphan.material"), "orphan", { mode: 0o600 });
    expect(() => assertBackendPublicationConfigAccess(
      join(orphaned.home, ".lcm", "config.json"),
      "sqlite",
      orphaned.sourceConfig,
    )).toThrow("evidence is incomplete");
    expect(() => assertBackendPublicationConfigMutation(
      join(orphaned.home, ".lcm", "config.json"),
      "sqlite",
      "sqlite",
      orphaned.sourceConfig,
      orphaned.sourceConfig,
    )).toThrow("evidence is incomplete");
    expect(() => assertBackendPublicationProjectMapMutation(
      {},
      orphaned.home,
      orphaned.sourceMap,
    )).toThrow("evidence is incomplete");

    const insertedAfterPreflight = fixture();
    expect(() => withBackendPublicationConsumerLock(insertedAfterPreflight.home, (token) => {
      const directory = backendPublicationDirectory(insertedAfterPreflight.home);
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(join(directory, "race.material"), "race", { mode: 0o600 });
      expect(() => assertBackendPublicationConfigAccess(
        join(insertedAfterPreflight.home, ".lcm", "config.json"),
        "sqlite",
        insertedAfterPreflight.sourceConfig,
        undefined,
        token,
      )).toThrow("evidence is incomplete");
      expect(() => assertBackendPublicationConfigMutation(
        join(insertedAfterPreflight.home, ".lcm", "config.json"),
        "sqlite",
        "sqlite",
        insertedAfterPreflight.sourceConfig,
        insertedAfterPreflight.sourceConfig,
        undefined,
        token,
      )).toThrow("evidence is incomplete");
      expect(() => assertBackendPublicationProjectMapMutation(
        {},
        insertedAfterPreflight.home,
        insertedAfterPreflight.sourceMap,
        undefined,
        token,
      )).toThrow("evidence is incomplete");
    })).toThrow("evidence is incomplete");

    const filePublication = fixture();
    writeFileSync(backendPublicationDirectory(filePublication.home), "not-a-directory", { mode: 0o600 });
    expect(() => withBackendPublicationConsumerLock(filePublication.home, () => undefined))
      .toThrow("publication directory cannot be opened");

    const fileRoot = fixture();
    rmSync(join(fileRoot.home, ".lcm"), { recursive: true, force: true });
    writeFileSync(join(fileRoot.home, ".lcm"), "not-a-directory", { mode: 0o600 });
    expect(() => withBackendPublicationConsumerLock(fileRoot.home, () => undefined))
      .toThrow("private LCM root cannot be opened");

    const unsafeRoot = fixture();
    chmodSync(join(unsafeRoot.home, ".lcm"), 0o755);
    mkdirSync(backendPublicationDirectory(unsafeRoot.home), { mode: 0o700 });
    expect(() => withBackendPublicationConsumerLock(unsafeRoot.home, () => undefined))
      .toThrow("publication root is not private");

    const unsafeRootWithoutPublication = fixture();
    chmodSync(join(unsafeRootWithoutPublication.home, ".lcm"), 0o755);
    expect(() => withBackendPublicationConsumerLock(unsafeRootWithoutPublication.home, () => undefined))
      .not.toThrow();

    const unsafeRootFilePublication = fixture();
    chmodSync(join(unsafeRootFilePublication.home, ".lcm"), 0o755);
    writeFileSync(backendPublicationDirectory(unsafeRootFilePublication.home), "not-a-directory", { mode: 0o600 });
    expect(() => withBackendPublicationConsumerLock(unsafeRootFilePublication.home, () => undefined))
      .toThrow("publication directory cannot be opened");

    const openFailure = fixture();
    const directory = backendPublicationDirectory(openFailure.home);
    mkdirSync(directory, { mode: 0o700 });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalOpen = nodeFs.openSync;
    const openError = Object.assign(new Error("publication open denied"), { code: "EACCES" });
    try {
      expect(() => withBackendPublicationConsumerLock(openFailure.home, (token) => {
        let directoryOpens = 0;
        try {
          nodeFs.openSync = ((path: string, ...args: unknown[]) => {
            if (path === directory) {
              directoryOpens += 1;
              if (directoryOpens === 2) throw openError;
            }
            return (originalOpen as (...input: unknown[]) => unknown)(path, ...args);
          });
          syncBuiltinESMExports();
          expect(() => assertBackendPublicationConfigAccess(
            join(openFailure.home, ".lcm", "config.json"),
            "sqlite",
            openFailure.sourceConfig,
            undefined,
            token,
          )).toThrow("publication directory cannot be opened");
        } finally {
          nodeFs.openSync = originalOpen;
          syncBuiltinESMExports();
        }
      })).not.toThrow();
    } finally {
      nodeFs.openSync = originalOpen;
      syncBuiltinESMExports();
    }
  });

  it("computes canonical project-map evidence without rewriting source bytes", () => {
    const values = fixture();
    expect(() => assertBackendPublicationProjectMapMutation(
      { ["a".repeat(64)]: { canonical: join(values.home, "project"), aliases: [] } },
      values.home,
      "{not-json",
    )).not.toThrow();
    expect(backendPublicationCanonicalSha256({})).toMatch(/^[a-f0-9]{64}$/);
    expect(backendPublicationJournalPath(values.home)).toContain(".lcm/backend-publication/journal.json");
    expect(backendPublicationConfigSha256(values.home)).toMatch(/^[a-f0-9]{64}$/);
    expect(backendPublicationProjectMapSha256(values.home)).toMatch(/^[a-f0-9]{64}$/);
    const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      expect(backendPublicationConfigSha256(values.home)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      if (getuidDescriptor) Object.defineProperty(process, "getuid", getuidDescriptor);
    }
    writeFileSync(join(values.home, ".lcm", "map.json"), "{not-json", { mode: 0o600 });
    expect(() => backendPublicationProjectMapSha256(values.home)).toThrow("cannot be bound");
    rmSync(join(values.home, ".lcm", "map.json"));
    mkdirSync(join(values.home, ".lcm", "map.json"), { mode: 0o700 });
    expect(() => backendPublicationProjectMapSha256(values.home)).toThrow();
    rmSync(join(values.home, ".lcm", "map.json"), { recursive: true });
    rmSync(join(values.home, ".lcm", "config.json"));
    expect(backendPublicationConfigSha256(values.home)).toBe(backendPublicationCanonicalSha256({}));
    expect(backendPublicationProjectMapSha256(values.home)).toBe(backendPublicationCanonicalSha256({}));
  });
});
