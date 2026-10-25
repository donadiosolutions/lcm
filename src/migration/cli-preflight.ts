import { basename } from "node:path";
import { configPath } from "../runtime-paths.js";
import { hashProjectPath, normalizeProjectPath, readProjectMapIdentity, resolveProjectIdentity } from "../project-map.js";
import { resolveGitProjectAnchor } from "../git-project.js";
import type { StorageIdentityContext } from "../storage/contracts.js";
import type { ResolvedPostgreSqlConfig } from "../daemon/config.js";
import type { BackendPublicationLockToken } from "../storage/backend-publication.js";
import { PostgreSqlRuntime } from "../storage/postgresql/runtime.js";
import { PostgreSqlIdentityRepository } from "../storage/postgresql/identity-repository.js";
import { requireMachineIdentity, MachineIdentityFileError } from "../machine-identity.js";
import { resolveMigrationTargetConfig } from "./target-config.js";
import { classifyMigrationDaemonPresence, type MigrationDaemonPresence } from "./daemon-presence.js";
import { verifyMigrationTargetReachability } from "./target-reachability.js";
import { lookupMigrationTargetProjectId, resolveMigrationTargetProjectId } from "./target-identity.js";
import { readAuthorizedMapAliasPaths } from "./map-aliases.js";
import { unexpectedFailureEvidence } from "./boundary.js";
import {
  computeMigrationGenerationBase,
  nonSecretPostgreSqlTargetCoordinates,
  MigrationIdentityError,
} from "./generation-identity.js";
import {
  resolveMigrationApplyCandidate,
  type MigrationApplyCandidateResolution,
} from "./candidate.js";

/**
 * The shared preflight both `plan` and `apply` compose identically (section
 * 3: `plan` "owns" preconditions, target reachability, roster, daemon
 * presence, and computing the candidate generation id -- exactly this
 * function's job). Built as one shared function specifically so the two
 * commands cannot silently diverge in composition order: `plan`'s preview
 * and `apply`'s real precondition check must reach the same generation id
 * from the same live state for the section 9 confirmation fence to guard
 * anything (see `candidate.ts`'s own agreement tests, which this function
 * calls the same `resolveMigrationApplyCandidate` those tests hold to that
 * standard).
 *
 * **Never collapses a three-valued primitive into a boolean at this call
 * site.** `classifyMigrationDaemonPresence`'s three outcomes are handled as
 * three distinct branches below, not `if (present) ... else refuse`. Only
 * `unresolvable` refuses (exit 5: evidence could not be established).
 * `present` and `authoritatively-absent` both proceed -- they are two
 * different positively-established facts, carried through to the caller
 * distinctly, but neither is a refusal.
 *
 * **Why a positively confirmed absence proceeds rather than refuses.**
 * Section 7 says `apply` "must positively establish daemon presence ...
 * and refuses exit 5 when it cannot" -- "cannot establish" means
 * `unresolvable`, not "established the answer is none". A confirmed
 * absence *is* establishing presence; the established answer happens to be
 * "no daemon". Refusing on absence would also be actively harmful: nothing
 * in this migration needs a daemon (the daemon is a *consumer* of storage,
 * not a participant in the copy), and section 7's policy already treats a
 * running daemon as merely *permitted*, not required -- refusing here would
 * force an operator to start a daemon purely to pass this check,
 * immediately before a maintenance hold that makes that very daemon's
 * passive-event sweeps fail for the whole capture-and-copy window. That is
 * precisely the condition this check exists to warn about, not require.
 * Section 6's restart-requirement precedent treats the identical
 * observation (no pid file, no live process) as authoritative absence
 * yielding exit 0 "no daemon to restart" -- this contract must not disagree
 * with itself between sections 6 and 7.
 *
 * **Section 4.10: the destination project identity is never derived from
 * the local project map.** `openMigrationCopySource` refuses unless the
 * capture authority's `projectIdentity.scope` is `"local"`
 * (`copy-source.ts:38-40`), and `authenticateSqliteMigrationSource` sets
 * that scope to `"shared"` the moment the local project-map entry carries
 * a `remoteProjectId` (`maintenance.ts:126-128`) -- so if this function
 * bound the map (the way `resolveStorageIdentityContext` does for every
 * *other* production caller), capture would refuse
 * `multi-machine-installation` on every migration, unconditionally. The
 * destination project id is instead resolved directly against PostgreSQL
 * (`resolveMigrationTargetProjectId`, `target-identity.ts`, which also
 * documents the exact input constraint this function must honour). The
 * local map stays unbound through capture, genesis and copy; #625's
 * activation publishes it for the first time, per the root's ruling. This
 * is why `unbound-postgresql-project` no longer exists as a refusal here:
 * the remedy it used to name (`lcm project create`/`lcm project link`,
 * both of which call `setRemoteProjectBinding`) would have told an
 * operator to write the exact field that must stay unset.
 */

/** The local project as the preview saw it: a persisted map entry, or the deterministic derivation labelled as not persisted. */
export type MigrationLocalProject = Readonly<{ id: string; canonical: string; persisted: boolean }>;

/**
 * The preview context (plan-v5 Part B (3)): every read, no write. It is what
 * `plan`, `apply --dry-run` and `apply`'s fence consume. Minting the local
 * map entry and the destination project is a separate step
 * (`resolveMigrationExpectedIdentity`) that only `apply` takes, after its
 * fence.
 */
export type MigrationPreflightResult =
  | Readonly<{
    status: "ready";
    targetConfig: ResolvedPostgreSqlConfig;
    presence: Extract<MigrationDaemonPresence, { status: "present" } | { status: "authoritatively-absent" }>;
    candidate: Extract<MigrationApplyCandidateResolution, { status: "candidate" }>;
    local: MigrationLocalProject;
    machineId: string;
    /** The destination project at the alias key, or `null`: it will be created at apply. */
    destinationProjectId: string | null;
    base: string;
  }>
  | Readonly<{ status: "refuse"; reason: string; evidence?: string }>;

/** What the preview can say about the two things apply would mint, without minting either. */
export type MigrationIdentityPreview = Readonly<{
  destinationProject: "exists" | "will-be-created-at-apply";
  localProject: "persisted" | "not-persisted";
}>;

export function migrationIdentityPreview(
  preflight: Extract<MigrationPreflightResult, { status: "ready" }>,
): MigrationIdentityPreview {
  return {
    destinationProject: preflight.destinationProjectId === null ? "will-be-created-at-apply" : "exists",
    localProject: preflight.local.persisted ? "persisted" : "not-persisted",
  };
}

function deriveLocalProject(cwd: string): Pick<MigrationLocalProject, "id" | "canonical"> {
  const anchor = resolveGitProjectAnchor(cwd);
  const canonical = anchor?.canonical ?? normalizeProjectPath(cwd);
  return { id: hashProjectPath(canonical), canonical };
}

async function closeQuietly(runtime: PostgreSqlRuntime): Promise<void> {
  try {
    await runtime.close();
  } catch {
    // Preserve whichever outcome was already determined; a close failure
    // after a classified resolution is not itself new evidence.
  }
}

export type MigrationPreflightOperations = Readonly<{
  resolveTargetConfig: typeof resolveMigrationTargetConfig;
  classifyPresence: typeof classifyMigrationDaemonPresence;
  verifyReachability: typeof verifyMigrationTargetReachability;
  requireMachine: typeof requireMachineIdentity;
  createIdentityRuntime: (settings: ResolvedPostgreSqlConfig["postgresql"]) => PostgreSqlRuntime;
  readLocalIdentity: typeof readProjectMapIdentity;
  lookupTargetProject: typeof lookupMigrationTargetProjectId;
  resolveCandidate: typeof resolveMigrationApplyCandidate;
  resolveTargetCoordinates: typeof nonSecretPostgreSqlTargetCoordinates;
  computeBase: typeof computeMigrationGenerationBase;
}>;

export async function resolveMigrationPreflight(input: Readonly<{
  cwd: string;
  homeDir: string;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/`. Each composed step can be overridden independently
   * so a test can prove this function refuses at exactly the step it
   * claims to, without needing a real PostgreSQL connection or a real
   * daemon for every branch.
   */
  _operationsForTesting?: Partial<MigrationPreflightOperations>;
}>): Promise<MigrationPreflightResult> {
  const resolveTargetConfig = input._operationsForTesting?.resolveTargetConfig ?? resolveMigrationTargetConfig;
  const classifyPresence = input._operationsForTesting?.classifyPresence ?? classifyMigrationDaemonPresence;
  const verifyReachability = input._operationsForTesting?.verifyReachability ?? verifyMigrationTargetReachability;
  const requireMachine = input._operationsForTesting?.requireMachine ?? requireMachineIdentity;
  const createIdentityRuntime = input._operationsForTesting?.createIdentityRuntime
    ?? ((settings) => new PostgreSqlRuntime(settings));
  const readLocalIdentity = input._operationsForTesting?.readLocalIdentity ?? readProjectMapIdentity;
  const lookupTargetProject = input._operationsForTesting?.lookupTargetProject ?? lookupMigrationTargetProjectId;
  const resolveCandidate = input._operationsForTesting?.resolveCandidate ?? resolveMigrationApplyCandidate;
  const resolveTargetCoordinates = input._operationsForTesting?.resolveTargetCoordinates ?? nonSecretPostgreSqlTargetCoordinates;
  const computeBase = input._operationsForTesting?.computeBase ?? computeMigrationGenerationBase;

  // 1. Target config: storage.postgresql (plus LCM_POSTGRES_* fallbacks),
  // independent of the active backend, per the root's ruling.
  const targetResolution = resolveTargetConfig(configPath(input.homeDir));
  if (targetResolution.status === "refuse") {
    return { status: "refuse", reason: targetResolution.reason, evidence: targetResolution.evidence };
  }

  // 2. Daemon presence: three-valued, never collapsed.
  const presence = await classifyPresence({ homeDir: input.homeDir });
  if (presence.status === "unresolvable") {
    return { status: "refuse", reason: "daemon-presence-unresolvable", evidence: presence.evidence };
  }
  // `present` and `authoritatively-absent` both proceed from here: neither
  // is a refusal (see this module's own doc comment for why absence is not
  // treated as a precondition failure). `presence` is now typed as exactly
  // those two remaining variants and is carried through unchanged.

  // 3. Target reachability: a real connection, TLS and role verified.
  const verification = await verifyReachability({
    settings: targetResolution.config.postgresql,
    expectedOwner: targetResolution.config.postgresql.migrationRole,
  });
  if (verification.status === "refuse") {
    return { status: "refuse", reason: verification.reason, evidence: verification.evidence };
  }

  // 4a. This local project's own identity, read without writing anything
  // (plan-v5 Part B (3)). A persisted map entry is used; with none, the
  // deterministic derivation is reported as not persisted. `local.id` and
  // `local.canonical` are also section 4.1's base-identity input below and
  // the destination lookup's required input.
  let persistedLocal: ReturnType<typeof readProjectMapIdentity>;
  try {
    persistedLocal = readLocalIdentity({ homeDir: input.homeDir, cwd: input.cwd });
  } catch (error) {
    return { status: "refuse", reason: "local-identity-unresolvable", evidence: unexpectedFailureEvidence(error) };
  }
  const local: MigrationLocalProject = persistedLocal === null
    ? { ...deriveLocalProject(input.cwd), persisted: false }
    : { id: persistedLocal.id, canonical: persistedLocal.canonical, persisted: true };

  // 4b. This machine's own registered identity.
  let machineId: string;
  try {
    machineId = requireMachine(input.homeDir).machineId;
  } catch (error) {
    if (error instanceof MachineIdentityFileError) {
      return { status: "refuse", reason: "machine-identity-unregistered" };
    }
    throw error;
  }

  // 4c. The destination PostgreSQL project, by SELECT only. An absent alias
  // key is reported, not created: only apply, after its fence, may mint.
  let destinationProjectId: string | null;
  const identityRuntime = createIdentityRuntime(targetResolution.config.postgresql);
  try {
    destinationProjectId = await lookupTargetProject({
      repository: new PostgreSqlIdentityRepository(identityRuntime),
      machineId,
      authorityCanonicalPath: local.canonical,
    });
  } finally {
    await closeQuietly(identityRuntime);
  }

  // 5. The stable narrow base identity (section 4.1).
  const targetCoordinates = resolveTargetCoordinates(targetResolution.config.postgresql.url);
  let base: string;
  try {
    base = computeBase({
      physicalProjectId: local.id,
      canonicalPath: local.canonical,
      target: targetCoordinates,
    });
  } catch (error) {
    if (error instanceof MigrationIdentityError) {
      return { status: "refuse", reason: `generation-${error.reason}`, evidence: error.evidence ?? undefined };
    }
    throw error;
  }

  // 6. The candidate generation id preview (section 9's genesis repair).
  const candidate = await resolveCandidate({ cwd: input.cwd, homeDir: input.homeDir, base });
  if (candidate.status === "refuse") {
    return candidate;
  }

  return {
    status: "ready", targetConfig: targetResolution.config, presence, candidate, local, machineId,
    destinationProjectId, base,
  };
}

export type MigrationExpectedIdentityOperations = Readonly<{
  createIdentityRuntime: (settings: ResolvedPostgreSqlConfig["postgresql"]) => PostgreSqlRuntime;
  resolveLocalIdentity: typeof resolveProjectIdentity;
  readLocalIdentity: typeof readProjectMapIdentity;
  resolveTargetIdentity: typeof resolveMigrationTargetProjectId;
  lookupTargetProject: typeof lookupMigrationTargetProjectId;
  readAuthorizedAliases: typeof readAuthorizedMapAliasPaths;
}>;

export type MigrationExpectedIdentityResult =
  | Readonly<{ status: "resolved"; expectedIdentity: StorageIdentityContext; effects: MigrationIdentityEffects }>
  | Readonly<{ status: "refuse"; reason: string; evidence?: string }>;

/**
 * What the identity step actually did at each of its two write boundaries,
 * reported from the step itself rather than inferred from the preview the
 * preflight took earlier: a concurrent actor may have persisted the entry
 * or created the destination in between, and the step then reuses it.
 * `local` is decided by a read under the caller's own token immediately
 * before the write, so nothing can change the map between the two. A held
 * step reads only and reports `reused` for both.
 */
export type MigrationIdentityEffect =
  | Readonly<{ stage: "local"; outcome: "persisted" | "reused" }>
  | Readonly<{ stage: "destination"; outcome: "created" | "reused" }>;
export type MigrationIdentityEffects = Readonly<{
  localProject: "persisted" | "reused";
  destinationProject: "created" | "reused";
}>;

/**
 * The identity `apply` takes after its fence (plan-v5 Part B (3)), split on
 * the candidate disposition the preview already classified:
 *
 * - **fresh**: no hold exists, so this is the only place anything is minted.
 *   The local map entry is written with the home passed through
 *   (`resolveProjectIdentity` with `homeDir`), then the destination project
 *   is resolved or created. `apply` runs this inside its capture span, under
 *   the span's own publication token, only after the span re-checked the
 *   confirmed candidate, so a moved candidate refuses before either mint.
 * - **recover-entering** and **continue-held**: a hold is live, so nothing is
 *   minted under it. The local identity must already be persisted
 *   (`readProjectMapIdentity`: no consumer lock, no write, no backfill), and
 *   the destination project must already exist (a SELECT). Either missing is
 *   exit 5; neither is created.
 */
export async function resolveMigrationExpectedIdentity(input: Readonly<{
  /**
   * What the identity step reads of a preflight: the target, the machine and
   * the disposition. `resume` has no candidate to resolve and passes the
   * held disposition directly.
   */
  preflight: Pick<Extract<MigrationPreflightResult, { status: "ready" }>, "targetConfig" | "machineId">
    & Readonly<{ candidate: Pick<Extract<MigrationPreflightResult, { status: "ready" }>["candidate"], "disposition"> }>;
  cwd: string;
  homeDir: string;
  /**
   * The publication token of a caller already inside the append barrier
   * (`apply`'s capture span). The fresh mint then reuses that admission
   * instead of taking the consumer lock the barrier already holds.
   */
  publicationLockToken?: BackendPublicationLockToken;
  /**
   * Called once per write boundary as soon as that boundary has succeeded,
   * so a caller whose step later throws still knows what was written.
   */
  observe?: (effect: MigrationIdentityEffect) => void;
  /** @internal Deterministic failure-injection seam for tests only. */
  _operationsForTesting?: Partial<MigrationExpectedIdentityOperations>;
}>): Promise<MigrationExpectedIdentityResult> {
  const createIdentityRuntime = input._operationsForTesting?.createIdentityRuntime
    ?? ((settings) => new PostgreSqlRuntime(settings));
  const resolveLocalIdentity = input._operationsForTesting?.resolveLocalIdentity ?? resolveProjectIdentity;
  const readLocalIdentity = input._operationsForTesting?.readLocalIdentity ?? readProjectMapIdentity;
  const resolveTargetIdentity = input._operationsForTesting?.resolveTargetIdentity ?? resolveMigrationTargetProjectId;
  const lookupTargetProject = input._operationsForTesting?.lookupTargetProject ?? lookupMigrationTargetProjectId;
  const readAuthorizedAliases = input._operationsForTesting?.readAuthorizedAliases ?? readAuthorizedMapAliasPaths;
  const { preflight } = input;
  const fresh = preflight.candidate.disposition === "fresh";

  let local: Readonly<{ id: string; canonical: string }>;
  let localEffect: MigrationIdentityEffects["localProject"];
  if (fresh) {
    // Read before the write, under the same admission as the write: the
    // answer is the actual effect of the mint, never the preflight's preview.
    let existing: ReturnType<typeof readProjectMapIdentity>;
    try {
      existing = readLocalIdentity({ homeDir: input.homeDir, cwd: input.cwd });
    } catch (error) {
      return { status: "refuse", reason: "local-identity-unresolvable", evidence: unexpectedFailureEvidence(error) };
    }
    local = resolveLocalIdentity(input.cwd, {
      homeDir: input.homeDir,
      ...(input.publicationLockToken === undefined ? {} : { _publicationLockToken: input.publicationLockToken }),
    });
    localEffect = existing === null ? "persisted" : "reused";
  } else {
    let persisted: ReturnType<typeof readProjectMapIdentity>;
    try {
      persisted = readLocalIdentity({ homeDir: input.homeDir, cwd: input.cwd });
    } catch (error) {
      return { status: "refuse", reason: "local-identity-unresolvable", evidence: unexpectedFailureEvidence(error) };
    }
    if (persisted === null) return { status: "refuse", reason: "local-identity-not-persisted" };
    local = persisted;
    localEffect = "reused";
  }
  input.observe?.({ stage: "local", outcome: localEffect });

  let projectId: string;
  let destinationEffect: MigrationIdentityEffects["destinationProject"];
  const runtime = createIdentityRuntime(preflight.targetConfig.postgresql);
  try {
    const repository = new PostgreSqlIdentityRepository(runtime);
    if (fresh) {
      const resolution = await resolveTargetIdentity({
        repository,
        machineId: preflight.machineId,
        displayName: basename(local.canonical),
        authorityCanonicalPath: local.canonical,
        // The map entry the fresh step just resolved, under the same admission.
        aliases: readAuthorizedAliases({
          homeDir: input.homeDir,
          localProjectId: local.id,
          canonicalPath: local.canonical,
          ...(input.publicationLockToken === undefined ? {} : { publicationLockToken: input.publicationLockToken }),
        }),
      });
      if (resolution.status === "refuse") {
        return { status: "refuse", reason: resolution.reason, evidence: resolution.evidence };
      }
      projectId = resolution.projectId;
      destinationEffect = resolution.effect;
    } else {
      const found = await lookupTargetProject({
        repository, machineId: preflight.machineId, authorityCanonicalPath: local.canonical,
      });
      if (found === null) return { status: "refuse", reason: "destination-project-absent" };
      projectId = found;
      destinationEffect = "reused";
    }
  } finally {
    await closeQuietly(runtime);
  }
  input.observe?.({ stage: "destination", outcome: destinationEffect });

  return {
    status: "resolved",
    expectedIdentity: {
      id: projectId,
      remoteProjectId: projectId,
      localProjectId: local.id,
      machineId: preflight.machineId,
      canonical: local.canonical,
      selectedPath: local.canonical,
    },
    effects: { localProject: localEffect, destinationProject: destinationEffect },
  };
}
