import { expect, vi } from "vitest";
import * as preflightApi from "../../src/migration/cli-preflight.js";
import * as genesisApi from "../../src/migration/apply-genesis-copy.js";
import * as cliVerifyApi from "../../src/migration/cli-verify.js";
import * as verifyApi from "../../src/migration/verify-generation.js";
import type { ResolvedPostgreSqlConfig } from "../../src/daemon/config.js";
import { readBackendMaintenanceJournal, type BackendMaintenanceJournal } from "../../src/storage/backend-publication.js";
import {
  prepareCutoverSet,
  resolveCutoverSetCandidate,
  type CutoverSetPrepareInput,
  type CutoverSetPrepareOperations,
} from "../../src/migration/cutover-set-prepare.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { beginMigrationEffect, completeMigrationEffect } from "../../src/migration/protocol.js";
import { SET_HOME_MACHINE, setHome } from "./cutover-set-home.js";
import {
  FIXTURE_AT,
  createFixtureManifest,
  fixtureVerificationReport,
  persistFixtureReport,
} from "../migration/existing-fixtures.js";
import { migrationVerificationEffectId } from "../../src/migration/verify-generation.js";

export function targetConfig(host = "db.example"): ResolvedPostgreSqlConfig {
  return {
    backend: "postgresql",
    postgresql: {
      url: "postgresql://" + host + ":5432/lcm", caFile: "/unused", migrationRole: "lcm_test_migrator",
      poolMax: 1, connectionTimeoutMs: 100, idleTimeoutMs: 100, statementTimeoutMs: 100,
    },
  } as unknown as ResolvedPostgreSqlConfig;
}

type Project = Awaited<ReturnType<typeof setHome>>["projects"][number];

export type Env = {
  homeDir: string;
  projects: Project[];
  store: MigrationManifestStore;
  calls: string[];
  /** Generation ids whose genesis refuses. */
  failDryRun: Set<string>;
  failCopy: Set<string>;
  ineligible: Set<string>;
};

export async function makeEnv(count = 2): Promise<Env> {
  const { homeDir, projects } = await setHome(count);
  return {
    homeDir, projects, store: new MigrationManifestStore({ homeDir }), calls: [],
    failDryRun: new Set(), failCopy: new Set(), ineligible: new Set(),
  };
}

function stepEffect(env: Env, generationId: string, kind: Parameters<typeof beginMigrationEffect>[1]["kind"], effectId: string, evidence: Omit<Parameters<typeof completeMigrationEffect>[1], "effectId" | "completedAt"> = {}): void {
  let manifest = env.store.read(generationId);
  manifest = env.store.update(generationId, manifest.checksumSha256, (current) =>
    beginMigrationEffect(current, { kind, effectId, inputSha256: "a".repeat(64), startedAt: FIXTURE_AT }));
  env.store.update(generationId, manifest.checksumSha256, (current) =>
    completeMigrationEffect(current, { effectId, completedAt: FIXTURE_AT, ...evidence }));
}

function completeCarried(env: Env, generationId: string, effectId: string, evidence: Omit<Parameters<typeof completeMigrationEffect>[1], "effectId" | "completedAt">): void {
  const manifest = env.store.read(generationId);
  env.store.update(generationId, manifest.checksumSha256, (current) =>
    completeMigrationEffect(current, { effectId, completedAt: FIXTURE_AT, ...evidence }));
}

const DRY_RUN_REPORT = { report: { kind: "dry-run" as const, reportId: "dry-run-effect", reportSha256: "a".repeat(64), createdAt: FIXTURE_AT } };

/** Deterministic stand-ins for the operations that need PostgreSQL; everything else is the real production code. */
export type PostgreSqlFakes = {
  resolveIdentity: typeof preflightApi.resolveMigrationExpectedIdentity;
  genesisDryRun: typeof genesisApi.performMigrationGenesisDryRun;
  genesisAndCopy: typeof genesisApi.performMigrationApplyGenesisAndCopy;
  buildVerificationInputs: typeof cliVerifyApi.buildVerificationInputs;
  verify: typeof verifyApi.verifyMigrationGeneration;
};
export type FakeOps = Partial<CutoverSetPrepareOperations> & Partial<PostgreSqlFakes>;

export function fakeOps(env: Env, extra: FakeOps = {}): FakeOps & PostgreSqlFakes {
  return {
    resolveIdentity: async (input) => {
      const project = env.projects.find((candidate) => candidate.cwd === input.cwd)!;
      env.calls.push("identity:" + project.id.slice(0, 4) + ":" + input.preflight.candidate.disposition);
      input.observe?.({ stage: "local", outcome: "reused" });
      input.observe?.({ stage: "destination", outcome: "created" });
      return {
        status: "resolved",
        expectedIdentity: {
          id: "remote-" + project.id.slice(0, 8), remoteProjectId: "remote-" + project.id.slice(0, 8), localProjectId: project.id,
          machineId: SET_HOME_MACHINE, canonical: project.cwd, selectedPath: project.cwd,
        },
        effects: { localProject: "reused", destinationProject: "created" },
      };
    },
    genesisDryRun: async (input) => {
      env.calls.push("dry-run:" + input.generationId + (input.carriedEffectId === undefined ? "" : ":carried=" + input.carriedEffectId));
      if (env.failDryRun.has(input.generationId)) return { status: "refuse", reason: "genesis-inspection-failed", evidence: "Error" };
      if (input.manifestStore!.probeManifestPresence(input.generationId).status === "absent") {
        createFixtureManifest(input.manifestStore!, "dry-run-verified", { generationId: input.generationId });
      } else if (input.carriedEffectId === undefined) {
        stepEffect(env, input.generationId, "verify-dry-run", "dry-run-effect", DRY_RUN_REPORT);
      } else {
        completeCarried(env, input.generationId, input.carriedEffectId, DRY_RUN_REPORT);
      }
      return { status: "ready" };
    },
    genesisAndCopy: async (input) => {
      env.calls.push("copy:" + input.generationId);
      if (env.failCopy.has(input.generationId)) return { status: "refuse", reason: "copy-failed", evidence: "Error" };
      if (env.store.read(input.generationId).phase === "dry-run-verified") {
        stepEffect(env, input.generationId, "copy-batch", "copy-effect", {
          checkpoint: { domain: "conversation", ordinal: 1, recordCount: 1, sourceCheckpointSha256: "a".repeat(64), destinationCommitSha256: "b".repeat(64) },
        });
      }
      stepEffect(env, input.generationId, "complete-copy", "complete-copy-effect");
      return { status: "copied", result: { phase: "copied" } as never };
    },
    buildVerificationInputs: async (input) => {
      env.calls.push("inputs:" + input.generationId);
      return { status: "ready", input: { generationId: input.generationId } as never };
    },
    verify: async (input) => {
      env.calls.push("verify:" + input.generationId);
      if (env.ineligible.has(input.generationId)) {
        return { report: { activationEligible: false, clean: false } as never, outcome: "mismatches", effectId: "x", inputSha256: "y" };
      }
      const report = fixtureVerificationReport(input.generationId);
      persistFixtureReport(env.homeDir, report);
      const effectId = migrationVerificationEffectId(report.reportSha256);
      const manifest = env.store.read(input.generationId);
      const begun = env.store.update(input.generationId, manifest.checksumSha256, (current) =>
        beginMigrationEffect(current, { kind: "verify-generation", effectId, inputSha256: report.reportSha256, startedAt: FIXTURE_AT }));
      env.store.update(input.generationId, begun.checksumSha256, (current) => completeMigrationEffect(current, {
        effectId, completedAt: FIXTURE_AT, activationEligible: true,
        report: { kind: "verification", reportId: report.reportId, reportSha256: report.reportSha256, createdAt: FIXTURE_AT },
      }));
      return { report, outcome: "clean", effectId, inputSha256: report.reportSha256 };
    },
    ...extra,
  };
}

/** Install the PostgreSQL stand-ins as module spies (the production code calls the real exports) and return the input. */
export function prepareInput(env: Env, setId: string, overrides: Partial<CutoverSetPrepareInput> = {}, ops: FakeOps = {}): CutoverSetPrepareInput {
  const { resolveIdentity, genesisDryRun, genesisAndCopy, buildVerificationInputs, verify, ...seams } = fakeOps(env, ops);
  vi.spyOn(preflightApi, "resolveMigrationExpectedIdentity").mockImplementation(resolveIdentity);
  vi.spyOn(genesisApi, "performMigrationGenesisDryRun").mockImplementation(genesisDryRun);
  vi.spyOn(genesisApi, "performMigrationApplyGenesisAndCopy").mockImplementation(genesisAndCopy);
  vi.spyOn(cliVerifyApi, "buildVerificationInputs").mockImplementation(buildVerificationInputs);
  vi.spyOn(verifyApi, "verifyMigrationGeneration").mockImplementation(verify);
  return {
    homeDir: env.homeDir, confirmSetId: setId, targetConfig: targetConfig(), maxRecords: 10, maxBytes: 1_000_000,
    ownerProcessId: "owner", _operationsForTesting: seams, ...overrides,
  };
}

export async function candidateSetId(env: Env, config = targetConfig()): Promise<string> {
  const candidate = await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: config });
  if (candidate.status !== "candidate") throw new Error("expected a candidate: " + JSON.stringify(candidate));
  return candidate.setId;
}

export function heldJournal(env: Env): BackendMaintenanceJournal {
  return readBackendMaintenanceJournal(env.homeDir)!;
}

export function memberIds(env: Env): string[] {
  return heldJournal(env).cutoverSet!.manifest.members.map((member) => member.generationId);
}

/** Enter a real set hold and capture member 1 only, then block at its genesis: the state every resume starts from. */
export async function blockedAtFirstGenesis(env: Env): Promise<{ setId: string; ids: string[] }> {
  const setId = await candidateSetId(env);
  const ids = (await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig() }) as { members: { generationId: string }[] }).members.map((member) => member.generationId);
  env.failDryRun.add(ids[0]!);
  const blocked = await prepareCutoverSet(prepareInput(env, setId));
  expect(blocked.status).toBe("blocked");
  env.failDryRun.delete(ids[0]!);
  env.calls.length = 0;
  return { setId, ids };
}

