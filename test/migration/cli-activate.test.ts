import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  MigrationActivationError,
  type MigrationActivationOutcome,
} from "../../src/migration/activate-generation.js";
import type { ActivationRestartCheckResult } from "../../src/migration/activation-restart-check.js";
import {
  performMigrationActivateCommand,
  resolveMigrationActivationRuntimeSettings,
  type MigrationActivateCommandOperations,
} from "../../src/migration/cli-activate.js";
import type { MigrationDaemonPresence } from "../../src/migration/daemon-presence.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import type { MigrationJournalObservation } from "../../src/migration/journal-observation.js";
import {
  createFixtureManifest,
  FIXTURE_GENERATION,
  heldFixtureJournal,
  makeFixtureHome,
  removeFixtureHomes,
  snapshotHome,
} from "./existing-fixtures.js";

const roots: string[] = [];
afterEach(() => removeFixtureHomes(roots));

const H = (c: string): string => c.repeat(64);
const IDENTITY = {
  id: "0190aaaa-0000-7000-8000-000000000001", remoteProjectId: "0190aaaa-0000-7000-8000-000000000001",
  localProjectId: H("a"), machineId: "m-1", canonical: "/work/project", selectedPath: "/work/project",
};
const SETTINGS = { url: "postgresql://t", caFile: "/ca.pem", poolMax: 1, connectionTimeoutMs: 1, idleTimeoutMs: 1, statementTimeoutMs: 1, snapshotIdleTimeoutMs: 1 };
const RUNTIME_SETTINGS = { ...SETTINGS, url: "postgresql://runtime" };
const complete = async () => ({ state: "complete" as const, witness: {} as never });
const link = (publicationId: string) => ({
  state: "resolved" as const, path: "/ignored",
  link: { version: 1, generationId: FIXTURE_GENERATION, publicationId, identityDigest: H("d"), epochManifestRevision: 4, epochManifestChecksumSha256: H("e") },
}) as never;
const PUBLICATION_ID = "publication-1";

function verdict(status: ActivationRestartCheckResult["status"]): ActivationRestartCheckResult {
  return {
    status, reason: status === "satisfied" ? "backend-matches" : status === "unsatisfied" ? "backend-stale" : "health-unreachable",
    detail: "x", pid: 7, observedBackend: null, selectedBackend: "postgresql",
  };
}
const present = (storageBackend: string): MigrationDaemonPresence => ({ status: "present", storageBackend, pid: 7, daemonInstanceId: "d" });
const ABSENT: MigrationDaemonPresence = { status: "authoritatively-absent" };
const UNRESOLVABLE: MigrationDaemonPresence = { status: "unresolvable", evidence: "pidfile-live-no-answer" };

/** Router row 24: held, verified, nothing pending. */
async function verified() {
  const home = makeFixtureHome(roots);
  await heldFixtureJournal(home);
  createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "verified");
  return { home, resolution: { _operationsForTesting: { classifySnapshot: complete } } };
}

/** Router row 10: this generation's own completed v2 publication and an active manifest. */
function settledActive() {
  const home = makeFixtureHome(roots);
  createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "active");
  const observation: MigrationJournalObservation = { kind: "publication", publicationId: PUBLICATION_ID, phase: "completed" };
  return { home, resolution: { _operationsForTesting: { observeJournal: () => observation, classifySnapshot: complete, readLink: () => link(PUBLICATION_ID) } } };
}

const IDENTITY_OF_RUN = { generationId: FIXTURE_GENERATION, publicationId: PUBLICATION_ID, manifestRevision: 9 };
const REPORT = { kind: "activation" as const, reportId: "activation-report", reportSha256: H("b"), createdAt: "2026-08-12T12:00:00.000Z" };

const activated = (overrides: Record<string, unknown> = {}): MigrationActivationOutcome => ({
  status: "activated", identity: IDENTITY_OF_RUN, report: REPORT, restart: verdict("satisfied"),
  resumedFrom: "fresh", successorFencingToken: null, ...overrides,
}) as never;

function ops(overrides: Partial<MigrationActivateCommandOperations> = {}): Partial<MigrationActivateCommandOperations> {
  return {
    resolveDestination: async () => ({ status: "resolved", settings: SETTINGS, expectedOwner: "lcm_migration", expectedIdentity: IDENTITY }),
    resolveRuntimeSettings: () => ({ status: "resolved", settings: RUNTIME_SETTINGS }),
    classifyPresence: async () => ABSENT,
    ...overrides,
  };
}

type RunInput = Parameters<typeof performMigrationActivateCommand>[0];
const run = (
  home: string, resolution: object, extra: Partial<RunInput> = {},
) => performMigrationActivateCommand({
  cwd: "/work/project", homeDir: home, generation: FIXTURE_GENERATION, confirmGenerationId: FIXTURE_GENERATION, confirmBackend: "postgresql",
  _resolution: resolution as never, ...extra,
});

describe("activate: admission and the two fences (exit 3, nothing read beyond the router)", () => {
  it("names the owner of a cell it does not own (exit 2) and calls nothing", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "planned");
    const resolveDestination = vi.fn();
    const result = await run(home, { _operationsForTesting: { classifySnapshot: complete } }, { _operationsForTesting: ops({ resolveDestination }) });
    expect(result).toEqual({ status: "refuse", reason: "route-not-owner", generationId: FIXTURE_GENERATION, next: "resume" });
    expect(resolveDestination).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing generation token", { confirmGenerationId: undefined }, "existing-confirmation-missing"],
    ["a mismatched generation token", { confirmGenerationId: "generation-2" }, "existing-confirmation-moved"],
    ["a missing backend token", { confirmBackend: undefined }, "backend-confirmation-missing"],
    ["a mismatched backend token (sqlite)", { confirmBackend: "sqlite" }, "backend-confirmation-moved"],
  ])("%s refuses at the fence, never reaches the destination or the call, and leaves the home byte-identical", async (_name, extra, reason) => {
    const { home, resolution } = await verified();
    const before = snapshotHome(home);
    const resolveDestination = vi.fn();
    const resolveRuntimeSettings = vi.fn();
    const runActivation = vi.fn();
    const result = await run(home, resolution, { ...extra, _operationsForTesting: ops({ resolveDestination, resolveRuntimeSettings, run: runActivation }) });
    expect(result).toEqual({ status: "refuse", reason, generationId: FIXTURE_GENERATION });
    expect(resolveDestination).not.toHaveBeenCalled();
    expect(resolveRuntimeSettings).not.toHaveBeenCalled();
    expect(runActivation).not.toHaveBeenCalled();
    expect(snapshotHome(home)).toEqual(before);
  });

  it("resolves the live hold when --generation is omitted", async () => {
    const { home, resolution } = await verified();
    const result = await run(home, resolution, { generation: undefined, _operationsForTesting: ops({ run: async () => ({ status: "refused", step: "S0", reason: "manifest-not-eligible", detail: "x", effectBegun: false }) as never }) });
    expect(result).toMatchObject({ status: "refuse", reason: "activation-refused-precondition", generationId: FIXTURE_GENERATION });
  });

  it("passes a resolver refusal through unchanged (an id nothing knows)", async () => {
    const home = makeFixtureHome(roots);
    expect(await run(home, {})).toEqual({ status: "refuse", reason: "generation-unknown" });
  });
});

describe("activate --dry-run: previewMigrationActivation, which is never predictive and so never exits 0", () => {
  it("lists what the preview read and what it did not evaluate, takes no destination, and writes nothing", async () => {
    const { home, resolution } = await verified();
    const before = snapshotHome(home);
    const resolveDestination = vi.fn();
    const resolveRuntimeSettings = vi.fn();
    const preview = vi.fn(async () => ({
      predictive: false as const,
      checks: [{ name: "manifest" as const, status: "ok" as const, detail: "phase verified" }, { name: "link" as const, status: "unresolvable" as const, detail: "/secret/path" }],
      notEvaluated: ["quiescence", "coverage", "g8", "lease", "health", "census"] as const,
    }));
    const result = await run(home, resolution, { dryRun: true, _operationsForTesting: ops({ preview, resolveDestination, resolveRuntimeSettings }) });
    expect(result).toEqual({
      status: "refuse", reason: "activation-dry-run-not-predictive", generationId: FIXTURE_GENERATION,
      next: "activate (drop --dry-run to run it)",
      sections: {
        cell: 24, predictive: false, notEvaluated: "quiescence,coverage,g8,lease,health,census",
        "check.manifest": "ok", "check.link": "unresolvable",
      },
    });
    expect(preview).toHaveBeenCalledWith({ homeDir: home, generationId: FIXTURE_GENERATION });
    expect(resolveDestination).not.toHaveBeenCalled();
    expect(resolveRuntimeSettings).not.toHaveBeenCalled();
    expect(snapshotHome(home)).toEqual(before);
  });

  it("uses the real preview when none is injected: it still refuses, with the persisted checks it can read", async () => {
    const { home, resolution } = await verified();
    const before = snapshotHome(home);
    const result = await run(home, resolution, { dryRun: true });
    expect(result).toMatchObject({
      status: "refuse", reason: "activation-dry-run-not-predictive",
      sections: { predictive: false, "check.manifest": "ok", "check.maintenance-journal": "ok" },
    });
    expect(snapshotHome(home)).toEqual(before);
  });
});

describe("activate: the inputs of runMigrationActivation", () => {
  it("passes distinct transfer and runtime settings with the resolved identity and owner", async () => {
    const { home, resolution } = await verified();
    const controller = new AbortController();
    const runActivation = vi.fn(async (_input: unknown) => ({ status: "refused", step: "S0", reason: "manifest-not-eligible", detail: "x", effectBegun: false }) as never);
    await run(home, resolution, { signal: controller.signal, _operationsForTesting: ops({ run: runActivation }) });
    const input = runActivation.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toEqual({
      homeDir: home, generationId: FIXTURE_GENERATION, transferSettings: SETTINGS, ordinarySettings: RUNTIME_SETTINGS,
      expectedIdentity: IDENTITY, expectedOwner: "lcm_migration", signal: controller.signal,
    });
    expect(input.ordinarySettings).not.toBe(input.transferSettings);
  });

  it("omits the signal when none is given", async () => {
    const { home, resolution } = await verified();
    const runActivation = vi.fn(async (_input: unknown) => ({ status: "refused", step: "S0", reason: "manifest-not-eligible", detail: "x", effectBegun: false }) as never);
    await run(home, resolution, { _operationsForTesting: ops({ run: runActivation }) });
    expect(Object.keys(runActivation.mock.calls[0]![0] as object)).not.toContain("signal");
  });

  it.each([
    ["with evidence", { status: "refuse" as const, reason: "migration-target-missing", evidence: "config-validation-error" }, { evidence: "config-validation-error" }],
    ["without evidence", { status: "refuse" as const, reason: "destination-project-absent" }, {}],
  ])("refuses before the call when the destination cannot be resolved (%s)", async (_name, refusal, extra) => {
    const { home, resolution } = await verified();
    const runActivation = vi.fn();
    const result = await run(home, resolution, { _operationsForTesting: ops({ resolveDestination: async () => refusal, run: runActivation }) });
    expect(result).toEqual({ status: "refuse", reason: refusal.reason, generationId: FIXTURE_GENERATION, ...extra });
    expect(runActivation).not.toHaveBeenCalled();
  });

  it("refuses a missing or invalid runtime URL before activation without exposing its value", async () => {
    const { home, resolution } = await verified();
    const secret = "postgresql://runtime:do-not-echo@example.invalid/lcm?sslmode=disable";
    const runActivation = vi.fn();
    const result = await run(home, resolution, {
      _operationsForTesting: ops({
        resolveRuntimeSettings: () => ({
          status: "refuse",
          reason: "activation-runtime-target-missing",
        }),
        run: runActivation,
      }),
    });

    expect(result).toEqual({
      status: "refuse",
      reason: "activation-runtime-target-missing",
      generationId: FIXTURE_GENERATION,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(runActivation).not.toHaveBeenCalled();
  });

  it("strictly resolves the activate-only runtime URL while reusing destination TLS and tuning", async () => {
    const { home } = await verified();
    const caFile = join(home, "runtime-ca.pem");
    writeFileSync(caFile, "test-ca\n", { mode: 0o600 });
    const transferSettings = { ...SETTINGS, caFile };
    const secret = "postgresql://runtime:secret@example.invalid/lcm";

    expect(resolveMigrationActivationRuntimeSettings({
      transferSettings,
      expectedOwner: "lcm_migration",
      env: { LCM_POSTGRES_RUNTIME_URL: secret },
    })).toEqual({
      status: "resolved",
      settings: { ...transferSettings, url: secret },
    });
    const { snapshotIdleTimeoutMs: _snapshotIdleTimeoutMs, ...withoutSnapshotIdleTimeout } = transferSettings;
    expect(resolveMigrationActivationRuntimeSettings({
      transferSettings: withoutSnapshotIdleTimeout,
      expectedOwner: "lcm_migration",
      env: { LCM_POSTGRES_RUNTIME_URL: secret },
    })).toMatchObject({
      status: "resolved",
      settings: { snapshotIdleTimeoutMs: 300_000 },
    });
    for (const value of [
      undefined,
      "not-a-url",
      `${secret}?sslmode=disable`,
      `${secret}#fragment`,
    ]) {
      const resolution = resolveMigrationActivationRuntimeSettings({
        transferSettings,
        expectedOwner: "lcm_migration",
        env: { LCM_POSTGRES_RUNTIME_URL: value },
      });
      expect(resolution).toEqual({
        status: "refuse",
        reason: "activation-runtime-target-missing",
      });
      expect(JSON.stringify(resolution)).not.toContain(secret);
    }
  });

  it("does not misclassify an unexpected runtime-settings failure as missing input", () => {
    const failure = new RangeError("injected resolver failure");
    const transferSettings = new Proxy(SETTINGS, {
      get() { throw failure; },
    });
    expect(() => resolveMigrationActivationRuntimeSettings({
      transferSettings,
      expectedOwner: "lcm_migration",
      env: { LCM_POSTGRES_RUNTIME_URL: "postgresql://runtime:secret@example.invalid/lcm" },
    })).toThrow(failure);
  });

  it("uses the real activate-only resolver and process environment when no seam is supplied", async () => {
    const { home, resolution } = await verified();
    const caFile = join(home, "runtime-process-ca.pem");
    writeFileSync(caFile, "test-ca\n", { mode: 0o600 });
    const runtimeUrl = "postgresql://runtime:secret@example.invalid/lcm";
    vi.stubEnv("LCM_POSTGRES_RUNTIME_URL", runtimeUrl);
    try {
      const runActivation = vi.fn(async () => ({
        status: "refused",
        step: "S0",
        reason: "manifest-not-eligible",
        detail: "x",
        effectBegun: false,
      }) as never);
      await run(home, resolution, {
        _operationsForTesting: {
          resolveDestination: async () => ({
            status: "resolved",
            settings: { ...SETTINGS, caFile },
            expectedOwner: "lcm_migration",
            expectedIdentity: IDENTITY,
          }),
          run: runActivation,
        },
      });
      expect(runActivation.mock.calls[0]![0]).toMatchObject({
        ordinarySettings: { url: runtimeUrl, caFile },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses the real destination resolution and the real call when none are injected (an empty home has no target)", async () => {
    const { home, resolution } = await verified();
    expect(await run(home, resolution)).toMatchObject({ status: "refuse", reason: "migration-target-missing" });
    // The real call, pre-cancelled, refuses or fails closed at its first step; it never reads as success.
    const real = await run(home, resolution, {
      signal: AbortSignal.abort(),
      _operationsForTesting: {
        resolveDestination: ops().resolveDestination!,
        resolveRuntimeSettings: ops().resolveRuntimeSettings!,
      },
    });
    expect(real.status).toBe("refuse");
  });
});

describe("activate: refused outcomes (S0-S8, effectBegun false) map to a class by reason", () => {
  const EXPECTED: ReadonlyArray<readonly [string, string]> = [
    ["manifest-absent", "precondition"], ["manifest-not-eligible", "precondition"], ["manifest-unresolvable", "evidence"],
    ["maintenance-not-held", "precondition"], ["maintenance-unresolvable", "evidence"],
    ["lease-conflict", "contention"], ["lease-unresolvable", "evidence"],
    ["quiescence-unsatisfied", "precondition"], ["quiescence-unresolvable", "evidence"],
    ["coverage-unsatisfied", "precondition"], ["coverage-unresolvable", "evidence"], ["uncovered-projects", "precondition"],
    ["verification-stale", "precondition"], ["verification-unresolvable", "evidence"],
    ["identity-drift", "precondition"], ["project-map-drift", "precondition"],
    ["target-unhealthy", "precondition"], ["target-unresolvable", "evidence"],
    ["census-drift", "precondition"], ["class-coverage-incomplete", "precondition"], ["verification-mismatch", "precondition"],
    ["evidence-unresolvable", "evidence"], ["state-unresolvable", "evidence"],
  ];
  const refused = (reason: string, extra: Record<string, unknown> = {}): MigrationActivationOutcome =>
    ({ status: "refused", step: "S4", reason, detail: "x", effectBegun: false, ...extra }) as never;

  it.each([
    ["target-unhealthy", "activation-refused-precondition"],
    ["target-unresolvable", "activation-refused-evidence"],
  ])("maps a fresh S6 %s identity failure through the closed activation class", async (reason, expected) => {
    const { home, resolution } = await verified();
    const result = await run(home, resolution, {
      _operationsForTesting: ops({
        run: async () => ({
          status: "refused",
          step: "S6",
          reason,
          detail: "ordinary identity probe failed",
          effectBegun: false,
        }) as never,
      }),
    });
    expect(result).toMatchObject({ status: "refuse", reason: expected });
    expect(result.reason).not.toBe("unexpected-failure");
  });

  it.each(EXPECTED)("%s is class %s, never applied, with the step and reason as evidence", async (reason, refusalClass) => {
    const { home, resolution } = await verified();
    const result = await run(home, resolution, { _operationsForTesting: ops({ run: async () => refused(reason) }) });
    expect(result).toEqual({
      status: "refuse", reason: `activation-refused-${refusalClass}`, generationId: FIXTURE_GENERATION,
      sections: { cell: 24, activationStep: "S4", activationReason: reason, effectBegun: false },
    });
  });

  it("pending-effect-foreign is exit 6 (resume) only when the router, asked again, says resume owns it; otherwise exit 2", async () => {
    const { home, resolution } = await verified();
    const resumeOwned = vi.fn(async () => ({ status: "refuse" as const, reason: "route-resume-required", generationId: FIXTURE_GENERATION, next: "resume" }));
    let calls = 0;
    const admit = vi.fn(async (input: Parameters<NonNullable<MigrationActivateCommandOperations["admit"]>>[0]) => {
      calls += 1;
      if (calls === 1) return (await import("../../src/migration/cli-existing.js")).admitExistingMigrationCommand(input);
      return resumeOwned();
    });
    const owned = await run(home, resolution, { _operationsForTesting: ops({ admit, run: async () => refused("pending-effect-foreign") }) });
    expect(owned).toMatchObject({ status: "refuse", reason: "activation-refused-resume" });
    const notOwned = await run(home, resolution, { _operationsForTesting: ops({ run: async () => refused("pending-effect-foreign") }) });
    expect(notOwned).toMatchObject({ status: "refuse", reason: "activation-refused-precondition" });
    // An admission that now admits activate (it is simply the owner again) is not a resume cell either.
    let again = 0;
    const admitsAgain = await run(home, resolution, {
      _operationsForTesting: ops({
        admit: async (input) => { again += 1; return (await import("../../src/migration/cli-existing.js")).admitExistingMigrationCommand(input); },
        run: async () => refused("pending-effect-foreign"),
      }),
    });
    expect(admitsAgain).toMatchObject({ reason: "activation-refused-precondition" });
    expect(again).toBe(2);
  });

  it("renders a failed best-effort lease release as a fact about the release only", async () => {
    const { home, resolution } = await verified();
    const result = await run(home, resolution, {
      _operationsForTesting: ops({ run: async () => refused("lease-conflict", { detail: "busy; the activation lease was not released: connection reset at /secret/path" }) }),
    });
    expect(result).toMatchObject({ sections: { leaseReleaseFailed: true } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it.each([
    ["an unknown reason", refused("brand-new-reason")],
    ["an unknown step", refused("lease-conflict", { step: "S99" })],
    ["a refusal that claims an effect began", refused("lease-conflict", { effectBegun: true })],
    ["an unknown status", { status: "brand-new-status" } as never],
  ])("%s reaches the boundary as unexpected-failure (exit 5), never a guessed class", async (_name, outcome) => {
    const { home, resolution } = await verified();
    const result = await run(home, resolution, { _operationsForTesting: ops({ run: async () => outcome }) });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "Error", applied: true });
  });
});

describe("activate: interrupted outcomes (S9-S16)", () => {
  const interrupted = (overrides: Record<string, unknown> = {}): MigrationActivationOutcome => ({
    status: "interrupted", step: "S13a", cause: "lease-lost", detail: "x", effectBegun: true, applied: "unknown", reportStored: "no",
    identity: IDENTITY_OF_RUN, ...overrides,
  }) as never;

  it("effectBegun true is exit 6 (activate again): step, cause, applied and reportStored are rendered, and the home was written", async () => {
    const { home, resolution } = await verified();
    const result = await run(home, resolution, { _operationsForTesting: ops({ run: async () => interrupted() }) });
    expect(result).toEqual({
      status: "refuse", reason: "activation-interrupted", generationId: FIXTURE_GENERATION, applied: true, next: "activate",
      sections: {
        cell: 24, activationStep: "S13a", activationCause: "lease-lost", effectBegun: true, activationApplied: "unknown",
        activationReportStored: "no", publicationId: PUBLICATION_ID, manifestRevision: 9,
      },
    });
  });

  it("effectBegun false is exit 2 (activate again): never inferred from the step label, and a failed release is not claimed as a release", async () => {
    const { home, resolution } = await verified();
    for (const step of ["S9", "S13b", "S16"]) {
      const result = await run(home, resolution, {
        _operationsForTesting: ops({ run: async () => interrupted({ step, effectBegun: false, applied: "no", detail: "x; the activation lease was not released: boom" }) }),
      });
      expect(result).toMatchObject({
        status: "refuse", reason: "activation-not-begun", next: "activate",
        sections: { activationStep: step, effectBegun: false, activationApplied: "no", leaseReleaseFailed: true },
      });
      expect(result).not.toHaveProperty("applied");
    }
  });

  it("renders an identity with only the fields it evidenced", async () => {
    const { home, resolution } = await verified();
    const result = await run(home, resolution, { _operationsForTesting: ops({ run: async () => interrupted({ identity: { generationId: FIXTURE_GENERATION } }) }) });
    expect((result as { sections: Record<string, unknown> }).sections).not.toHaveProperty("publicationId");
    expect((result as { sections: Record<string, unknown> }).sections).not.toHaveProperty("manifestRevision");
  });

  it.each([
    ["S14, which does not exist", { step: "S14" }],
    ["S8, which is a refusal step", { step: "S8" }],
    ["an unknown cause", { cause: "brand-new-cause" }],
    ["an unknown applied state", { applied: "maybe" }],
    ["an unknown reportStored state", { reportStored: "maybe" }],
  ])("%s reaches the boundary as unexpected-failure", async (_name, overrides) => {
    const { home, resolution } = await verified();
    const result = await run(home, resolution, { _operationsForTesting: ops({ run: async () => interrupted(overrides) }) });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "Error", applied: true });
  });
});

describe("activate: an identity other than the confirmed one is never accepted", () => {
  it.each([
    ["activated", activated({ identity: { ...IDENTITY_OF_RUN, generationId: "generation-2" } })],
    ["interrupted", { status: "interrupted", step: "S9", cause: "lease-lost", detail: "x", effectBegun: true, applied: "no", reportStored: "no", identity: { generationId: "generation-2" } } as never],
    ["publication-failed", { status: "publication-failed", publication: { status: "aborted" }, identity: { generationId: "generation-2" } } as never],
    ["post-publication-unhealthy", { status: "post-publication-unhealthy", health: { status: "healthy" }, restart: verdict("satisfied"), identity: { generationId: "generation-2" } } as never],
  ])("%s with another generation's identity is exit 5, applied", async (status, outcome) => {
    const { home, resolution } = await verified();
    const result = await run(home, resolution, { _operationsForTesting: ops({ run: async () => outcome }) });
    expect(result).toEqual({
      status: "refuse", reason: "activation-identity-mismatch", generationId: FIXTURE_GENERATION, applied: true,
      sections: { cell: 24, outcome: status },
    });
  });
});

describe("activate: publication-failed and post-publication-unhealthy are exit 5", () => {
  it.each(["completed", "aborted", "publication-collision", "fence-unsatisfied", "fence-unresolvable", "artifact-missing",
    "artifact-unresolvable", "artifact-identity-mismatch", "duplicate-publication-input", "publication-unresolvable", "maintenance-in-flight"])(
    "publication-failed with status %s renders the status and exits 5", async (publicationStatus) => {
      const { home, resolution } = await verified();
      const result = await run(home, resolution, {
        _operationsForTesting: ops({ run: async () => ({ status: "publication-failed", publication: { status: publicationStatus }, identity: IDENTITY_OF_RUN }) as never }),
      });
      expect(result).toEqual({
        status: "refuse", reason: "activation-publication-failed", generationId: FIXTURE_GENERATION, applied: true,
        sections: { cell: 24, publicationStatus, publicationId: PUBLICATION_ID, manifestRevision: 9 },
      });
    },
  );

  it("an unknown publication status reaches the boundary", async () => {
    const { home, resolution } = await verified();
    const result = await run(home, resolution, {
      _operationsForTesting: ops({ run: async () => ({ status: "publication-failed", publication: { status: "brand-new" }, identity: IDENTITY_OF_RUN }) as never }),
    });
    expect(result).toMatchObject({ reason: "unexpected-failure" });
  });

  it("post-publication-unhealthy renders the health and the restart observation, exits 5 (never 8), and says to activate again", async () => {
    const { home, resolution } = await verified();
    const outcome = (health: unknown) => ({ status: "post-publication-unhealthy", health, restart: verdict("satisfied"), identity: IDENTITY_OF_RUN }) as never;
    const unhealthy = await run(home, resolution, {
      _operationsForTesting: ops({ run: async () => outcome({ status: "unhealthy", reason: "server-preflight", detail: "x", sqlState: null }) }),
    });
    expect(unhealthy).toEqual({
      status: "refuse", reason: "activation-post-publication-unhealthy", generationId: FIXTURE_GENERATION, applied: true, next: "activate",
      restart: { answer: "satisfied", presence: "absent" },
      sections: {
        cell: 24, healthStatus: "unhealthy", healthReason: "server-preflight", selectedBackend: "postgresql",
        restartCheckReason: "backend-matches", publicationId: PUBLICATION_ID, manifestRevision: 9,
      },
    });
    const healthy = await run(home, resolution, { _operationsForTesting: ops({ run: async () => outcome({ status: "healthy" }) }) });
    expect((healthy as { sections: Record<string, unknown> }).sections).not.toHaveProperty("healthReason");
    // A presence that cannot be observed leaves the restart null and the exit unchanged.
    const blind = await run(home, resolution, {
      _operationsForTesting: ops({ classifyPresence: async () => { throw new TypeError("boom"); }, run: async () => outcome({ status: "healthy" }) }),
    });
    expect(blind).toMatchObject({ reason: "activation-post-publication-unhealthy", restart: null });
  });
});

describe("activate: the activated outcome (exit 0 needs identity, manifest read-back and the restart cell)", () => {
  const okOps = (outcome = activated(), presence: MigrationDaemonPresence = ABSENT) =>
    ops({ run: async () => outcome, classifyPresence: async () => presence });

  it("exits 0 with the report, the identity, the transfer-revoke instruction and the restart observation", async () => {
    const { home, resolution } = settledActive();
    const result = await run(home, resolution, { _operationsForTesting: okOps() });
    expect(result).toEqual({
      status: "ok", generationId: FIXTURE_GENERATION, manifestPhase: "active", applied: true, next: "revoke-transfer-grants-then-start-daemon",
      restart: { answer: "satisfied", presence: "absent" },
      evidence: {
        cell: 10, publicationId: PUBLICATION_ID, manifestRevision: 9, reportId: "activation-report", reportSha256: H("b"),
        resumedFrom: "fresh", successorFencingTokenAdvanced: false, transferGrantRevocation: "required-before-daemon-start",
        selectedBackend: "postgresql", restartCheckReason: "backend-matches",
      },
    });
  });

  it("a settled re-entry applied nothing, and an advanced fencing token is reported only as a fact", async () => {
    const { home, resolution } = settledActive();
    const result = await run(home, resolution, {
      _operationsForTesting: okOps(activated({ resumedFrom: "settled-active", successorFencingToken: "7" })),
    });
    expect(result).toMatchObject({ status: "ok", applied: false, evidence: { resumedFrom: "settled-active", successorFencingTokenAdvanced: true } });
    expect(JSON.stringify(result)).not.toContain('"7"');
  });

  it("a live daemon already on the selected backend is satisfied", async () => {
    const { home, resolution } = settledActive();
    const result = await run(home, resolution, { _operationsForTesting: okOps(activated(), present("postgresql")) });
    expect(result).toMatchObject({ status: "ok", restart: { answer: "satisfied", presence: "running" } });
  });

  it.each([
    ["an unsatisfied verdict with a stale live daemon is exit 8", verdict("unsatisfied"), present("sqlite"), "cutover-restart-required"],
    ["a satisfied verdict with a stale live daemon contradicts", verdict("satisfied"), present("sqlite"), "cutover-restart-contradiction"],
    ["a satisfied verdict with unresolvable presence contradicts", verdict("satisfied"), UNRESOLVABLE, "cutover-restart-contradiction"],
    ["an unsatisfied verdict with no daemon contradicts", verdict("unsatisfied"), ABSENT, "cutover-restart-contradiction"],
    ["an unresolvable verdict is unresolvable", verdict("unresolvable"), ABSENT, "cutover-restart-unresolvable"],
  ])("%s", async (_name, restartVerdict, presence, reason) => {
    const { home, resolution } = settledActive();
    const result = await run(home, resolution, { _operationsForTesting: okOps(activated({ restart: restartVerdict, resumedFrom: "fresh" }), presence) });
    expect(result).toMatchObject({
      status: "refuse", reason, generationId: FIXTURE_GENERATION, applied: true,
      next: reason === "cutover-restart-required" ? "revoke-transfer-grants-then-start-daemon" : "report",
    });
    expect((result as { restart: unknown }).restart).not.toBeNull();
  });

  it("an unobservable presence fails closed (exit 5), never as success", async () => {
    const { home, resolution } = settledActive();
    const result = await run(home, resolution, {
      _operationsForTesting: ops({ run: async () => activated(), classifyPresence: async () => { throw new TypeError("boom"); } }),
    });
    expect(result).toMatchObject({ status: "refuse", reason: "cutover-restart-unresolvable", restart: null, sections: { restartObservation: "TypeError" } });
  });

  it("a restart refusal after a settled re-entry applied nothing", async () => {
    const { home, resolution } = settledActive();
    const result = await run(home, resolution, {
      _operationsForTesting: okOps(activated({ resumedFrom: "settled-active", restart: verdict("unresolvable") })),
    });
    expect(result).toMatchObject({ status: "refuse", reason: "cutover-restart-unresolvable" });
    expect(result).not.toHaveProperty("applied");
  });

  it("refuses activation-readback-mismatch when the call claims success but the manifest is not active", async () => {
    const { home, resolution } = await verified();
    const result = await run(home, resolution, { _operationsForTesting: okOps() });
    expect(result).toEqual({ status: "refuse", reason: "activation-readback-mismatch", evidence: "manifest-verified", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("refuses activation-readback-mismatch when the manifest cannot be read back", async () => {
    const { home, resolution } = settledActive();
    const store = new MigrationManifestStore({ homeDir: home });
    let reads = 0;
    const flaky = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "read") return (id: string) => { reads += 1; if (reads > 1) throw new Error("gone"); return target.read(id); };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const result = await run(home, resolution, { manifestStore: flaky, _operationsForTesting: okOps() });
    expect(result).toEqual({ status: "refuse", reason: "activation-readback-mismatch", evidence: "manifest-unreadable", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("uses the real presence classifier when none is injected: a home with no daemon is absent", async () => {
    const { home, resolution } = settledActive();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP listener");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    writeFileSync(join(home, ".lcm", "config.json"), JSON.stringify({ daemon: { port: address.port } }), { mode: 0o600 });
    const result = await run(home, resolution, {
      _operationsForTesting: {
        resolveDestination: ops().resolveDestination!,
        resolveRuntimeSettings: ops().resolveRuntimeSettings!,
        run: async () => activated(),
      },
    });
    expect(result).toMatchObject({ status: "ok", restart: { answer: "satisfied", presence: "absent" } });
  });
});

describe("activate: thrown errors", () => {
  it.each([
    ["invalid-input", "activation-invalid-input"],
    ["unexpected-state", "activation-unexpected-state"],
  ] as const)("MigrationActivationError %s is exit 5 and claims no write when the manifest did not move", async (errorReason, reason) => {
    const { home, resolution } = await verified();
    const result = await run(home, resolution, {
      _operationsForTesting: ops({ run: async () => { throw new MigrationActivationError(errorReason, "boom at /secret/path"); } }),
    });
    expect(result).toEqual({ status: "refuse", reason, generationId: FIXTURE_GENERATION });
  });

  it("claims a write when the manifest moved (or cannot be read) after the error", async () => {
    const { home, resolution } = await verified();
    const store = new MigrationManifestStore({ homeDir: home });
    const result = await run(home, resolution, {
      _operationsForTesting: ops({
        run: async () => {
          const manifest = store.read(FIXTURE_GENERATION);
          const { beginMigrationEffect } = await import("../../src/migration/protocol.js");
          store.update(FIXTURE_GENERATION, manifest.checksumSha256, (current) =>
            beginMigrationEffect(current, { kind: "prepare-activation", effectId: "e", inputSha256: H("a"), startedAt: "2026-08-12T12:00:00.000Z" }));
          throw new MigrationActivationError("unexpected-state", "boom");
        },
      }),
    });
    expect(result).toEqual({ status: "refuse", reason: "activation-unexpected-state", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("any other error is the boundary's unexpected-failure (exit 5, applied), never success or exit 6", async () => {
    const { home, resolution } = await verified();
    const result = await run(home, resolution, {
      _operationsForTesting: ops({ run: async () => { throw new RangeError("boom"); } }),
    });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "RangeError", applied: true });
  });
});

