import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase, type PostgreSqlTestDatabase } from "./harness.js";
import { grantPortablePostgreSql } from "./portable-fixture.js";
import { prepareSqliteMigrationEnrollment } from "../../src/migration/maintenance.js";
import { PostgreSqlIdentityRepository } from "../../src/storage/postgresql/identity-repository.js";
import { resolveProjectIdentity, normalizeProjectPath, projectMapPath } from "../../src/project-map.js";
import { configPath } from "../../src/runtime-paths.js";
import { resolveMigrationExpectedIdentity, resolveMigrationPreflight } from "../../src/migration/cli-preflight.js";
import { performMigrationApplyThroughCapture } from "../../src/migration/apply.js";
import { performMigrationApplyGenesisAndCopy } from "../../src/migration/apply-genesis-copy.js";
import { performMigrationResumeCommand } from "../../src/migration/cli-resume.js";
import { performMigrationReportCommand } from "../../src/migration/cli-report.js";
import { performMigrationApply } from "../../src/migration/cli-apply.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { classifyMigrationRecovery } from "../../src/migration/protocol.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { readBackendMaintenanceJournal } from "../../src/storage/backend-publication.js";

beforeAll(assertHarnessReady);

/**
 * The one composition-level proof the owner required: `cli-apply.ts`'s
 * full orchestration -- preflight (target resolution, reachability,
 * section 4.10's real destination-identity resolution against
 * PostgreSQL, base identity, occupancy-probed candidate resolution), the
 * section 9 confirmation fence, capture through the hold, and manifest
 * genesis and copy -- run assembled, against real PostgreSQL, with only
 * the daemon-presence classifier seamed (the single dependency that needs
 * a live daemon process this test does not start). Every other piece
 * already has its own dedicated real-PostgreSQL proof
 * (target-reachability.integration.ts, migration-copy.integration.ts,
 * migration-apply-genesis-copy.integration.ts, target-identity.test.ts's
 * mocked unit proof); this file exists because per-piece proofs cannot
 * show the assembled path still works end to end, which is exactly the
 * shape of defect this item is built to catch.
 *
 * **No `setRemoteProjectBinding` anywhere in this fixture, deliberately.**
 * Section 4.10 requires the local project map to stay unbound through
 * capture, genesis and copy -- preflight resolves (and, on first use,
 * mints) the destination project id directly against PostgreSQL itself,
 * for real, in this test. That is the mechanism under test; pre-linking
 * the project here would both defeat the point and make capture refuse
 * `multi-machine-installation` (`maintenance.ts:126-190`).
 */
async function preparedApplyTarget(
  db: PostgreSqlTestDatabase,
  options: Readonly<{ aliases?: (home: string) => readonly string[] }> = {},
): Promise<{ home: string; cwd: string; pgSettings: ReturnType<typeof settings> }> {
  await grantPortablePostgreSql(db, { transfer: true });
  const home = mkdtempSync(join(tmpdir(), "cli-apply-roundtrip-"));
  const cwd = join(home, "project");
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const local = resolveProjectIdentity(cwd);
  vi.unstubAllEnvs();

  const projectDir = join(home, ".lcm", "projects", local.id);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".lcm", "events"), { mode: 0o700 });
  writeFileSync(join(projectDir, "meta.json"), `${JSON.stringify({ cwd })}\n`, { mode: 0o600 });

  if (options.aliases !== undefined) {
    // The project-map entry carries extra alias paths before enrollment (#1678).
    writeFileSync(projectMapPath(home), `${JSON.stringify({
      [local.id]: { canonical: local.canonical, aliases: [...options.aliases(home)] },
    })}\n`, { mode: 0o600 });
  }

  const pgSettings = settings(db.runtimeUrl);
  await prepareSqliteMigrationEnrollment({
    cwd, homeDir: home,
    targetConfig: { backend: "postgresql", postgresql: { ...pgSettings, migrationRole: "lcm_test_migrator" } },
  });

  // The real config.json a migration command reads for real, per the
  // root's ruling that target-config.ts resolves storage.postgresql
  // independent of the active storage.backend (still "sqlite" here,
  // proving that independence rather than assuming it). `url`/`caFile`
  // are deliberately NOT written here -- config.json's ordinary
  // (non-migration) load path validates storage.postgresql with
  // allowRuntimeSecrets=false and refuses a stored secret there by
  // design (confirmed by a real ConfigValidationError the first time
  // this fixture wrote them in), so a real operator supplies those two
  // through LCM_POSTGRES_URL / LCM_POSTGRES_CA_FILE instead, exactly as
  // this fixture does below.
  writeFileSync(configPath(home), `${JSON.stringify({
    storage: {
      backend: "sqlite",
      postgresql: {
        migrationRole: "lcm_test_migrator",
        poolMax: pgSettings.poolMax,
        connectionTimeoutMs: pgSettings.connectionTimeoutMs,
        idleTimeoutMs: pgSettings.idleTimeoutMs,
        statementTimeoutMs: pgSettings.statementTimeoutMs,
      },
    },
  })}\n`, { mode: 0o600 });

  return { home, cwd, pgSettings };
}

function presentPresence() {
  return { status: "present" as const, storageBackend: "sqlite", pid: 1, daemonInstanceId: "cli-apply-roundtrip" };
}

async function projectCounts(db: PostgreSqlTestDatabase): Promise<{ projects: string; aliases: string }> {
  const result = await db.migrator.query<{ projects: string; aliases: string }>({
    text: "SELECT (SELECT pg_catalog.count(*) FROM lcm.projects)::text AS projects, (SELECT pg_catalog.count(*) FROM lcm.project_aliases)::text AS aliases",
  }, { domain: "factory", operation: "diagnosticFixture" });
  return result.rows[0]!;
}

it(
  "drives a real end-to-end apply against real PostgreSQL: the preview and every refused fence leave lcm.projects, lcm.project_aliases and the local map untouched, and only a valid control mints the destination project after the fence",
  async () => {
    await withPostgreSqlTestDatabase("cli-apply-roundtrip", async (db) => {
      const { home, cwd, pgSettings } = await preparedApplyTarget(db);
      try {
        const mapBytes = () => readFileSync(projectMapPath(home), "utf8");
        const zero = { projects: "0", aliases: "0" };
        expect(await projectCounts(db)).toEqual(zero);

        // The read-only preview: target config, reachability, the persisted
        // local identity, a SELECT-only destination lookup, base identity and
        // the occupancy-probed candidate all run for real. Only presence is
        // seamed. Nothing is minted.
        const mapBefore = mapBytes();
        vi.stubEnv("LCM_POSTGRES_URL", pgSettings.url);
        vi.stubEnv("LCM_POSTGRES_CA_FILE", pgSettings.caFile);
        let planPreflight;
        try {
          planPreflight = await resolveMigrationPreflight({
            cwd, homeDir: home,
            _operationsForTesting: { classifyPresence: async () => presentPresence() },
          });
        } finally {
          vi.unstubAllEnvs();
        }
        expect(planPreflight.status).toBe("ready");
        if (planPreflight.status !== "ready") throw new Error("unreachable");
        expect(planPreflight.candidate.disposition).toBe("fresh");
        expect(planPreflight.presence).toEqual(presentPresence());
        expect(planPreflight.local.persisted).toBe(true);
        expect(planPreflight.destinationProjectId).toBeNull();
        expect(await projectCounts(db)).toEqual(zero);
        expect(mapBytes()).toBe(mapBefore);

        // A missing and a mismatched token each refuse at the fence, before
        // any identity is minted: no project or alias row, no map write.
        const missing = await performMigrationApply({ cwd, homeDir: home, _preflight: async () => planPreflight });
        expect(missing).toEqual({ status: "refuse", reason: "confirmation-missing" });
        const moved = await performMigrationApply({
          cwd, homeDir: home, confirmGenerationId: "generation-stale", _preflight: async () => planPreflight,
        });
        expect(moved).toEqual({ status: "refuse", reason: "confirmation-generation-moved" });
        expect(await projectCounts(db)).toEqual(zero);
        expect(mapBytes()).toBe(mapBefore);

        // --dry-run stops after the fence and still mints nothing.
        const dryRun = await performMigrationApply({
          cwd, homeDir: home, confirmGenerationId: planPreflight.candidate.generationId, dryRun: true,
          _preflight: async () => planPreflight,
        });
        expect(dryRun).toMatchObject({
          status: "ok", applied: false,
          identityPreview: { destinationProject: "will-be-created-at-apply", localProject: "persisted" },
        });
        expect(await projectCounts(db)).toEqual(zero);

        // `apply --confirm-generation <id>`: the id plan printed, re-supplied.
        const result = await performMigrationApply({
          cwd, homeDir: home,
          confirmGenerationId: planPreflight.candidate.generationId,
          _preflight: async () => planPreflight,
        });
        expect(result).toEqual({
          status: "ok", generationId: planPreflight.candidate.generationId, applied: true, phase: "copied",
          daemonPresence: presentPresence(),
        });

        // Positive control: the destination project exists now, minted by
        // apply after its fence at the (machine_id, normalized_path) key.
        expect(await projectCounts(db)).toEqual({ projects: "1", aliases: "1" });
        const remoteRepository = new PostgreSqlIdentityRepository(db.runtime);
        const bound = await remoteRepository.resolveProject(planPreflight.machineId, normalizeProjectPath(planPreflight.local.canonical));
        expect(bound?.projectId).toBeTypeOf("string");

        // Section 4.10: the local map never received a remote binding.
        expect(mapBytes()).not.toContain("remoteProjectId");

        // Positive control: genesis and copy really happened.
        const store = new MigrationManifestStore({ homeDir: home });
        const manifest = store.read(planPreflight.candidate.generationId);
        expect(manifest.phase).toBe("copied");
        expect(manifest.reports.some((report) => report.kind === "dry-run")).toBe(true);
        expect(classifyMigrationRecovery(manifest)).toEqual({ action: "ready" });

        // Re-applying is a real second invocation: its preflight now sees the
        // live hold (continue-held), reads the persisted local identity and
        // SELECTs the existing destination project instead of minting, and
        // the outcome is the same.
        vi.stubEnv("LCM_POSTGRES_URL", pgSettings.url);
        vi.stubEnv("LCM_POSTGRES_CA_FILE", pgSettings.caFile);
        let heldPreflight;
        try {
          heldPreflight = await resolveMigrationPreflight({
            cwd, homeDir: home,
            _operationsForTesting: { classifyPresence: async () => presentPresence() },
          });
        } finally {
          vi.unstubAllEnvs();
        }
        expect(heldPreflight).toMatchObject({
          status: "ready", candidate: { disposition: "continue-held", generationId: planPreflight.candidate.generationId },
          destinationProjectId: bound?.projectId,
        });
        const second = await performMigrationApply({
          cwd, homeDir: home,
          confirmGenerationId: planPreflight.candidate.generationId,
          _preflight: async () => heldPreflight,
        });
        expect(second).toEqual(result);
        expect(await projectCounts(db)).toEqual({ projects: "1", aliases: "1" });
      } finally {
        closeLcmConnection();
        rmSync(home, { recursive: true, force: true });
      }
    });
  },
  180000,
);


it(
  "resume continues a copy a real crash interrupted, with every callee real: the held identity is read (nothing minted), the copy stops at copied, and report then names verify",
  async () => {
    await withPostgreSqlTestDatabase("cli-resume-roundtrip", async (db) => {
      const { home, cwd, pgSettings } = await preparedApplyTarget(db);
      try {
        vi.stubEnv("LCM_POSTGRES_URL", pgSettings.url);
        vi.stubEnv("LCM_POSTGRES_CA_FILE", pgSettings.caFile);
        try {
          const preflight = await resolveMigrationPreflight({
            cwd, homeDir: home, _operationsForTesting: { classifyPresence: async () => presentPresence() },
          });
          expect(preflight.status).toBe("ready");
          if (preflight.status !== "ready") throw new Error("unreachable");
          const identity = await resolveMigrationExpectedIdentity({ preflight, cwd, homeDir: home });
          expect(identity.status).toBe("resolved");
          if (identity.status !== "resolved") throw new Error("unreachable");
          const generationId = preflight.candidate.generationId;

          // The first run: capture, then genesis and a copy that a simulated
          // crash interrupts after its first batch.
          const captured = await performMigrationApplyThroughCapture({
            cwd, homeDir: home, base: preflight.base, confirmGenerationId: generationId,
          });
          if (captured.status !== "captured") throw new Error("capture did not complete");
          let interrupted = false;
          const first = await performMigrationApplyGenesisAndCopy({
            homeDir: home, generationId: captured.generationId, maintenanceChecksumSha256: captured.maintenanceChecksumSha256,
            settings: preflight.targetConfig.postgresql, expectedOwner: preflight.targetConfig.postgresql.migrationRole,
            expectedIdentity: identity.expectedIdentity, ownerProcessId: "resume-first-run", maxRecords: 1, maxBytes: 150994944,
            testing: { observe: async (boundary) => {
              if (boundary === "after-batch-readback" && !interrupted) { interrupted = true; throw new Error("simulated crash"); }
            } },
          });
          expect(first).toMatchObject({ status: "refuse", reason: "copy-failed" });
          const store = new MigrationManifestStore({ homeDir: home });
          expect(store.read(generationId).pendingEffect?.kind).toBe("copy-batch");
          const projectsBefore = await projectCounts(db);

          // report is read-only and says resume owns this cell.
          const before = await performMigrationReportCommand({ homeDir: home });
          expect(before).toMatchObject({ next: "resume", evidence: { cell: 21, pendingEffect: "copy-batch" } });

          // resume: the real genesis/copy callee, the real held identity, no seams.
          const resumed = await performMigrationResumeCommand({
            cwd, homeDir: home, confirmGenerationId: generationId, maxRecords: 1,
          });
          expect(resumed).toEqual({
            status: "ok", generationId, manifestPhase: "copied", applied: true, next: "report", evidence: { cell: 21 },
          });
          expect(store.read(generationId).phase).toBe("copied");
          expect(classifyMigrationRecovery(store.read(generationId))).toEqual({ action: "ready" });
          // Resuming minted nothing.
          expect(await projectCounts(db)).toEqual(projectsBefore);

          const after = await performMigrationReportCommand({ homeDir: home });
          expect(after).toMatchObject({ next: "verify", evidence: { cell: 22, snapshot: "complete" } });
          expect(after.reason).toBeUndefined();
        } finally {
          vi.unstubAllEnvs();
        }
      } finally {
        closeLcmConnection();
        rmSync(home, { recursive: true, force: true });
      }
    });
  },
  180000,
);

async function projectAliasRows(db: PostgreSqlTestDatabase): Promise<Array<{ path: string; normalized_path: string }>> {
  const result = await db.migrator.query<{ path: string; normalized_path: string }>({
    text: "SELECT path, normalized_path FROM lcm.project_aliases ORDER BY path",
  }, { domain: "factory", operation: "diagnosticFixture" });
  return result.rows;
}

type AliasRowSet = Array<{ path: string; normalized_path: string }>;

function aliasRowSet(...paths: string[]): AliasRowSet {
  return paths.map((path) => ({ path, normalized_path: normalizeProjectPath(path) }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));
}

/**
 * Runs a real `apply` for a project whose map entry carries `aliases` (built from the home so each case owns
 * its paths). `seed` may create destination state first, from the same preflight apply will take its identity from.
 */
async function applyWithMapAliases(
  label: string,
  aliases: (home: string) => string[],
  scenario: (context: {
    db: PostgreSqlTestDatabase; home: string; cwd: string; canonical: string;
    preflight: Extract<Awaited<ReturnType<typeof resolveMigrationPreflight>>, { status: "ready" }>;
    apply: () => ReturnType<typeof performMigrationApply>;
  }) => Promise<void>,
  prepare: (home: string) => void = () => undefined,
): Promise<void> {
  await withPostgreSqlTestDatabase(label, async (db) => {
    const { home, cwd, pgSettings } = await preparedApplyTarget(db, { aliases });
    try {
      prepare(home);
      vi.stubEnv("LCM_POSTGRES_URL", pgSettings.url);
      vi.stubEnv("LCM_POSTGRES_CA_FILE", pgSettings.caFile);
      let preflight;
      try {
        preflight = await resolveMigrationPreflight({
          cwd, homeDir: home, _operationsForTesting: { classifyPresence: async () => presentPresence() },
        });
      } finally {
        vi.unstubAllEnvs();
      }
      expect(preflight.status).toBe("ready");
      if (preflight.status !== "ready") throw new Error("unreachable");
      await scenario({
        db, home, cwd, canonical: preflight.local.canonical, preflight,
        apply: () => performMigrationApply({
          cwd, homeDir: home, confirmGenerationId: preflight.candidate.generationId, _preflight: async () => preflight,
        }),
      });
    } finally {
      closeLcmConnection();
      rmSync(home, { recursive: true, force: true });
    }
  });
}

const ALIAS_CONFLICT_REFUSAL = {
  status: "refuse", reason: "migration-target-identity-unresolvable", evidence: "alias-conflict",
};

it.each([
  ["a non-existent path", (home: string) => join(home, "moved-project"), false],
  ["an existing empty directory", (home: string) => join(home, "empty-alias"), true],
])(
  "apply carries a project-map alias (%s) to the copied state and mints exactly the source alias set (#1678)",
  async (_label, aliasPath, createDirectory) => {
    await applyWithMapAliases("cli-apply-alias", (home) => [aliasPath(home)], async ({ db, home, canonical, preflight, apply }) => {
      const result = await apply();
      expect(result).toEqual({
        status: "ok", generationId: preflight.candidate.generationId, applied: true, phase: "copied",
        daemonPresence: presentPresence(),
      });
      expect(new MigrationManifestStore({ homeDir: home }).read(preflight.candidate.generationId).phase).toBe("copied");
      expect(await projectAliasRows(db)).toEqual(aliasRowSet(canonical, aliasPath(home)));
    }, (home) => { if (createDirectory) mkdirSync(aliasPath(home), { mode: 0o700 }); });
  },
  180000,
);

it(
  "apply stores an alias under a symlinked parent with its lexical path and its different real path (#1678)",
  async () => {
    const lexical = (home: string) => join(home, "link", "moved");
    await applyWithMapAliases("cli-apply-alias-parent", (home) => [lexical(home)], async ({ db, home, canonical, apply }) => {
      expect(await apply()).toMatchObject({ status: "ok", phase: "copied" });
      const rows = await projectAliasRows(db);
      expect(rows).toEqual(aliasRowSet(canonical, lexical(home)));
      const stored = rows.find((row) => row.path === lexical(home))!;
      expect(stored.normalized_path).toBe(join(normalizeProjectPath(home), "real", "moved"));
      expect(stored.path).not.toBe(stored.normalized_path);
    }, (home) => {
      mkdirSync(join(home, "real", "moved"), { recursive: true, mode: 0o700 });
      symlinkSync(join(home, "real"), join(home, "link"));
    });
  },
  180000,
);

it(
  "apply refuses before the hold, writing nothing, when an alias is a symlink to the canonical path (#1678)",
  async () => {
    await applyWithMapAliases("cli-apply-alias-collision", (home) => [join(home, "project-link")], async ({ db, home, apply }) => {
      const result = await apply();
      expect(result).toMatchObject(ALIAS_CONFLICT_REFUSAL);
      expect(await projectCounts(db)).toEqual({ projects: "0", aliases: "0" });
      expect(readBackendMaintenanceJournal(home)).toBeNull();
    }, (home) => { symlinkSync(join(home, "project"), join(home, "project-link")); });
  },
  180000,
);

describe("apply against a destination project that already exists (#1678)", () => {
  const moved = (home: string) => join(home, "moved-project");
  const create = async (db: PostgreSqlTestDatabase, machineId: string, paths: string[]) => {
    const [first, ...rest] = paths as [string, ...string[]];
    await new PostgreSqlIdentityRepository(db.runtime).createProject({
      machineId, displayName: "project", path: first, normalizedPath: normalizeProjectPath(first),
      aliases: [first, ...rest].map((path) => ({ path, normalizedPath: normalizeProjectPath(path) })),
    });
  };

  it("an equal alias set is reused unchanged and the copy completes", async () => {
    await applyWithMapAliases("cli-apply-alias-equal", (home) => [moved(home)], async ({ db, home, canonical, preflight, apply }) => {
      await create(db, preflight.machineId, [canonical, moved(home)]);
      expect(await apply()).toMatchObject({ status: "ok", phase: "copied" });
      expect(await projectAliasRows(db)).toEqual(aliasRowSet(canonical, moved(home)));
      expect((await projectCounts(db)).projects).toBe("1");
    });
  });

  it("a proper subset (a retry after the canonical alias alone was minted) gains the missing aliases and the copy completes", async () => {
    await applyWithMapAliases("cli-apply-alias-subset", (home) => [moved(home), join(home, "second")], async ({ db, home, canonical, preflight, apply }) => {
      await create(db, preflight.machineId, [canonical]);
      expect(await apply()).toMatchObject({ status: "ok", phase: "copied" });
      expect(await projectAliasRows(db)).toEqual(aliasRowSet(canonical, moved(home), join(home, "second")));
      expect((await projectCounts(db)).projects).toBe("1");
    });
  });

  it("a foreign extra alias refuses as alias-conflict and inserts nothing", async () => {
    await applyWithMapAliases("cli-apply-alias-foreign", (home) => [moved(home)], async ({ db, home, canonical, preflight, apply }) => {
      await create(db, preflight.machineId, [canonical, join(home, "stranger")]);
      expect(await apply()).toMatchObject(ALIAS_CONFLICT_REFUSAL);
      expect(await projectAliasRows(db)).toEqual(aliasRowSet(canonical, join(home, "stranger")));
      expect(readBackendMaintenanceJournal(home)).toBeNull();
    });
  });

  it("a map alias already bound to another project refuses as alias-conflict and inserts nothing", async () => {
    await applyWithMapAliases("cli-apply-alias-owned", (home) => [moved(home)], async ({ db, home, canonical, preflight, apply }) => {
      await create(db, preflight.machineId, [moved(home)]);
      expect(await apply()).toMatchObject(ALIAS_CONFLICT_REFUSAL);
      expect(await projectAliasRows(db)).toEqual(aliasRowSet(moved(home)));
      expect(canonical).not.toBe(moved(home));
    });
  });
});
