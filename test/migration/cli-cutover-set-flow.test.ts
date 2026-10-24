import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  performSetAbort, performSetApply, performSetDryRun, performSetPlan, performSetReport, performSetResume, performSetVerify,
  type MigrationSetOperations, type MigrationSetOutcome,
} from "../../src/migration/cli-cutover-set.js";
import { renderMigrationSetEnvelope } from "../../src/migration/cli-render.js";
import { migrationCommandContract, type MigrationCommandName } from "../../src/migration/exit-classes.js";
import { prepareCutoverSet, resolveCutoverSetCandidate } from "../../src/migration/cutover-set-prepare.js";
import { heldJournal, makeEnv, memberIds, prepareInput, targetConfig, type Env } from "../fixtures/cutover-set-prepare.js";

/** The real preparation (with the PostgreSQL stand-ins) behind the real adapters, on a real private home. */
function operations(env: Env, extra: Partial<MigrationSetOperations> = {}): Partial<MigrationSetOperations> {
  return {
    resolveTargetConfig: () => ({ status: "resolved", config: targetConfig() }),
    classifyPresence: async () => ({ status: "authoritatively-absent" }),
    verifyReachability: async () => ({ status: "verified" }),
    prepare: async (input) => prepareCutoverSet({ ...prepareInput(env, input.confirmSetId), maxRecords: input.maxRecords, maxBytes: input.maxBytes }),
    ...extra,
  };
}

/** Renders the outcome and holds it to the command's frozen exit contract. */
function envelope(command: MigrationCommandName, outcome: MigrationSetOutcome) {
  const rendered = renderMigrationSetEnvelope(command, outcome);
  expect(migrationCommandContract(command).canEmit).toContain(rendered.exitCode);
  return rendered;
}

/** Every file under the LCM home but lock files, with its bytes. */
function snapshotHome(homeDir: string): Record<string, string> {
  const root = join(homeDir, ".lcm");
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (name.endsWith(".lock")) continue;
      files[relative(root, path)] = readFileSync(path).toString("base64");
    }
  };
  walk(root);
  return files;
}

describe("the set commands over a real home: plan, apply, verify, report and resume", () => {
  it("plans the set, prepares every member, confirms it from persisted evidence and reports it", async () => {
    const env = await makeEnv();
    const ops = operations(env);
    const plan = envelope("plan", await performSetPlan({ homeDir: env.homeDir, _operationsForTesting: ops }));
    expect(plan).toMatchObject({ outcome: "ok", exitCode: 0, applied: false, next: "apply --set" });
    const setId = plan.generation!;
    expect(plan.evidence).toMatchObject({ scope: "cutover-set", memberCount: 2, disposition: "fresh", daemonPresent: false });

    const preview = envelope("apply", await performSetApply({ homeDir: env.homeDir, confirmGenerationId: setId, dryRun: true, _operationsForTesting: ops }));
    expect(preview).toMatchObject({ exitCode: 0, applied: false });
    expect(env.calls).toEqual([]);

    const applied = envelope("apply", await performSetApply({ homeDir: env.homeDir, confirmGenerationId: setId, _operationsForTesting: ops }));
    expect(applied).toMatchObject({ outcome: "ok", exitCode: 0, applied: true, generation: setId, manifestPhase: "verified", next: "activate --set" });
    expect(applied.evidence).toMatchObject({ setState: "prepared", memberCount: 2, "member.0.state": "verified", "member.1.state": "verified" });

    const verified = envelope("verify", await performSetVerify({ homeDir: env.homeDir, generation: setId, confirmGenerationId: setId, _operationsForTesting: ops }));
    expect(verified).toMatchObject({ exitCode: 0, applied: false, manifestPhase: "verified" });

    const nonPredictive = envelope("verify", await performSetVerify({ homeDir: env.homeDir, generation: setId, confirmGenerationId: setId, dryRun: true, _operationsForTesting: ops }));
    expect(nonPredictive).toMatchObject({ exitCode: 5, refusal: { reason: "set-preview-not-predictive" }, applied: false });
    expect(nonPredictive.evidence).toMatchObject({ predictive: false });

    const report = envelope("report", await performSetReport({ homeDir: env.homeDir, generation: setId, _operationsForTesting: ops }));
    expect(report).toMatchObject({ exitCode: 0, applied: false, next: "activate --set", manifestPhase: "verified" });
    expect(report.evidence).toMatchObject({ rollbackSetId: expect.any(String), journalKind: "hold", journalPhase: "maintenance-held" });

    const resumed = envelope("resume", await performSetResume({ homeDir: env.homeDir, generation: setId, confirmGenerationId: setId, _operationsForTesting: ops }));
    expect(resumed).toMatchObject({ exitCode: 0, applied: false, next: "activate --set" });
    expect(heldJournal(env).phase).toBe("maintenance-held");
    expect(memberIds(env)).toHaveLength(2);
  }, 120000);

  it("reports a blocked preparation as incomplete work, resumes it, and aborts a held set", async () => {
    const env = await makeEnv();
    const ops = operations(env);
    const candidate = await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig() });
    if (candidate.status !== "candidate") throw new Error("expected a candidate");
    const setId = candidate.setId;
    env.failDryRun.add(candidate.members[1]!.generationId);
    const first = envelope("apply", await performSetApply({ homeDir: env.homeDir, confirmGenerationId: setId, _operationsForTesting: ops }));
    expect(first).toMatchObject({ exitCode: 7, applied: true, refusal: { reason: "set-operator-required" } });
    expect(first.evidence).toMatchObject({
      serviceCommand: "prepare", serviceReason: "genesis-inspection-failed", blockedProjectId: env.projects[1]!.id,
      "member.0.state": "verified", "member.1.state": "blocked", "member.1.reason": "genesis-inspection-failed",
    });
    env.failDryRun.clear();
    const resumed = envelope("resume", await performSetResume({ homeDir: env.homeDir, generation: setId, confirmGenerationId: setId, _operationsForTesting: ops }));
    expect(resumed).toMatchObject({ exitCode: 0, applied: true, next: "activate --set" });
    const aborted = envelope("abort", await performSetAbort({ homeDir: env.homeDir, generation: setId, confirmGenerationId: setId, _operationsForTesting: ops }));
    expect(aborted).toMatchObject({ exitCode: 0, applied: true, next: "plan --set" });
    expect(aborted.evidence).toMatchObject({ scope: "cutover-set", setId, memberCount: 2, journalPhase: "maintenance-aborted" });
    expect(aborted.evidence["member.0.state"]).toBe("aborted");
    const settled = envelope("resume", await performSetResume({ homeDir: env.homeDir, generation: setId, confirmGenerationId: setId, _operationsForTesting: ops }));
    expect(settled).toMatchObject({ exitCode: 0, applied: false, next: "plan --set" });
  }, 120000);

  it("plans, previews and refuses a confirmation without publishing the project-map backfill (#1670)", async () => {
    const env = await makeEnv();
    const ops = operations(env);
    const before = snapshotHome(env.homeDir);
    const plan = envelope("plan", await performSetPlan({ homeDir: env.homeDir, _operationsForTesting: ops }));
    const setId = plan.generation!;
    expect(snapshotHome(env.homeDir)).toEqual(before);
    for (const input of [{}, { confirmGenerationId: "moved-set" }, { confirmGenerationId: setId, dryRun: true }]) {
      await performSetApply({ homeDir: env.homeDir, ...input, _operationsForTesting: ops });
      expect(snapshotHome(env.homeDir)).toEqual(before);
    }
    const source = { sourceSelectionSha256: "a".repeat(64), sourceByteWitnessSha256: "b".repeat(64), checksumSha256: "c".repeat(64), roles: [], inspectedAt: "2026-01-01T00:00:00.000Z" };
    const dry = envelope("dry-run", await performSetDryRun({ homeDir: env.homeDir, _operationsForTesting: { dryRunSource: async () => source } }));
    expect(dry).toMatchObject({ exitCode: 0, evidence: { memberCount: 2 } });
    expect(snapshotHome(env.homeDir)).toEqual(before);
    expect(env.calls).toEqual([]);
  }, 120000);
});
