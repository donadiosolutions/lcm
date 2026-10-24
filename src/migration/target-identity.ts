import {
  PostgreSqlIdentityAliasNormalizedPathConflictError,
  PostgreSqlIdentityAliasPathConflictError,
  PostgreSqlIdentityConflictError,
  type PostgreSqlIdentityRepository,
} from "../storage/postgresql/identity-repository.js";
import { normalizeProjectPath } from "../project-map.js";

/**
 * Resolves (or, on first use, mints) the destination PostgreSQL project id
 * for a migration's `expectedIdentity`, per the root's ruling (plan-v2
 * section 4.10): **never** derived from the local project map's
 * `remoteProjectId` binding, which must stay unset until #625's
 * activation publishes it (that field means "already shared/multi-machine"
 * to `authenticateSqliteMigrationSource` and `openMigrationCopySource`,
 * and setting it here would make capture refuse
 * `multi-machine-installation` on every migration).
 *
 * **The key, reused rather than invented:** `(machine_id, normalized_path)`
 * -- `lcm.project_aliases`'s own `PRIMARY KEY`
 * (`migrations/0002_schema_baseline.sql:93-101`).
 *
 * **The input constraint, fixed in code, not by convention (the
 * normalization hazard #625's owner found).** `authorityCanonicalPath`
 * MUST be `resolveProjectIdentity`'s own `local.canonical`
 * (`project-map.ts`) -- the exact same value `cli-preflight.ts` already
 * carries into `computeMigrationGenerationBase`'s own `canonicalPath`
 * input (section 4.1's base identity) -- **never** a raw `cwd` or any
 * other path.
 *
 * This module normalizes that input with `normalizeProjectPath`
 * (`project-map.ts:176-183`: `resolve()` then `realpathSync()`), which is
 * correct here **only** because `resolveProjectIdentity`'s own
 * `local.canonical` has already passed through git-worktree anchoring:
 * `resolveProjectIdentityUnlocked` computes
 * `gitAnchor?.canonical ?? normalizeProjectPath(cwd)`, the same
 * `resolveGitProjectAnchor` call that `normalizeProjectIdentityPath`
 * (`project-map.ts:185-188`, used at `daemon/project.ts:138` to compute
 * `authenticateSqliteMigrationSource`'s own `canonicalPath`) itself
 * performs, and both read the identical persisted `canonical` from
 * `project-map.json` when an entry already exists. So
 * `resolveProjectIdentity`'s `local.canonical` and
 * `authenticateSqliteMigrationSource`'s `canonicalPath` are the same
 * value **by construction**, not by coincidence -- applying
 * `realpathSync` to an already-anchored realpath is idempotent, so this
 * module's alias key and #625's `projectMapWitnessSha256` (which covers
 * the map entry's `canonical`, itself computed through
 * `normalizeProjectIdentityPath`) converge on the same string. **That
 * convergence is a property of this specific input, not of
 * `normalizeProjectPath` itself.** A derivation taking a raw `cwd`
 * instead would stop at the worktree while the map entry's `canonical`
 * anchors at the repository; for a linked Git worktree those are two
 * different strings, and the two items would disagree about which remote
 * project this is -- a failure profile that appears only for users with
 * linked worktrees, and that every test suite not deliberately built
 * against one will miss. See
 * `test/migration/target-identity.test.ts`'s real `git worktree add`
 * fixture for the convergence proof this module's own correctness rests
 * on; do not change this function's input to a plain `cwd` without
 * re-reading that test.
 *
 * **The atomicity, reused rather than invented.**
 * `PostgreSqlIdentityRepository.createProject` allocates a fresh project
 * id and, inside one transaction, inserts the project row and calls its
 * private `linkWithExecutor`, which does `INSERT INTO
 * lcm.project_aliases ... ON CONFLICT DO NOTHING RETURNING ...`. A
 * concurrent winner claiming the same primary key makes that insert a
 * no-op; `linkWithExecutor` then re-reads and, finding a row that belongs
 * to a different (this transaction's own, not-yet-committed) project id,
 * throws `PostgreSqlIdentityConflictError` -- which propagates out of
 * `createProject`'s transaction and rolls the whole thing back
 * atomically, including the just-inserted, now-orphaned project row.
 * Nothing partial ever commits; this module adds no locking of its own.
 *
 * **Why the leading `resolveProject` read below is not the lookup-then-
 * create race the ruling forbids.** The ruling forbids a design whose
 * correctness *depends on* the lookup's answer still being true at insert
 * time. This one does not: the leading read is an optimisation only, and
 * correctness rests entirely on the atomic insert against the primary key
 * plus the conflict-driven re-read that follows it. If the leading read
 * is stale -- another writer commits between the read and the insert --
 * the insert simply conflicts and this function adopts the winner exactly
 * as it would on a genuinely fresh key. Do not "simplify" this by
 * skipping the insert when the leading read finds nothing more attractive
 * to check; the insert's own conflict handling is what makes this correct
 * under concurrency, not the leading read.
 *
 * **Already-exists means reuse, unconditionally.** The existence of a
 * remote project is not evidence of a prior local binding and must not be
 * read as one -- this module's fast path treats presence at this exact
 * key as the only fact that counts.
 *
 * **No `expectedProjectId` carry-and-compare parameter.** One was
 * considered, matching section 4.9 exposure 2's carry-and-compare
 * discipline, but no durable production value exists yet to carry: the
 * manifest's `destination.identitySha256` (`protocol.ts`) is not a hash
 * of the project id alone -- it is `readPostgreSqlPortableWitness`'s own
 * live probe result (`portable-destination.ts`), keyed by the project id
 * but requiring a real PostgreSQL round-trip to interpret, so comparing
 * against it here would mean a second live probe purely to validate this
 * one, before genesis has even decided whether to run. A parameter no
 * production caller supplies is a decorative check (v3.4's captured-but-
 * never-compared shape), so it is not built. The database's own
 * immutability of `(machine_id, normalized_path)` -> `project_id`
 * (no production path in `identity-repository.ts` updates an existing
 * alias's `project_id`; only `replaceProjectAlias`/`restoreProjectAlias`
 * can, and those are #625/rollback-owned operations outside this
 * candidate) is what actually prevents a moved id under normal operation.
 * If #625's activation or rollback work needs this candidate to carry and
 * compare a durable prior value, that is new scope for that item to
 * specify, not something to fabricate here.
 */

/**
 * The SELECT-only half of the resolution above (plan-v5 Part B (3), preview
 * and held paths): the destination project id at the alias key, or `null`
 * when none exists. It never inserts, so `plan`, `apply --dry-run` and a
 * held continuation cannot create a PostgreSQL project or alias row. The same
 * input constraint applies: `authorityCanonicalPath` is the local identity's
 * canonical path, never a raw cwd.
 */
export async function lookupMigrationTargetProjectId(input: Readonly<{
  repository: PostgreSqlIdentityRepository;
  machineId: string;
  authorityCanonicalPath: string;
}>): Promise<string | null> {
  const existing = await input.repository.resolveProject(
    input.machineId,
    normalizeProjectPath(input.authorityCanonicalPath),
  );
  return existing === null ? null : existing.projectId;
}

export type MigrationTargetIdentityResolution =
  | Readonly<{
    status: "resolved";
    projectId: string;
    /** What this call did: `created` the row, or `reused` one that existed (including a concurrent winner's). */
    effect: "created" | "reused";
  }>
  | Readonly<{ status: "refuse"; reason: "migration-target-identity-unresolvable"; evidence?: string }>;

export type MigrationTargetIdentityOperations = Readonly<{
  resolveProject: PostgreSqlIdentityRepository["resolveProject"];
  createProject: PostgreSqlIdentityRepository["createProject"];
  ensureProjectAliases: PostgreSqlIdentityRepository["ensureProjectAliases"];
}>;

const ALIAS_CONFLICT = Object.freeze({
  status: "refuse",
  reason: "migration-target-identity-unresolvable",
  evidence: "alias-conflict",
} as const);

function isAliasConflict(error: unknown): boolean {
  return error instanceof PostgreSqlIdentityConflictError
    || error instanceof PostgreSqlIdentityAliasPathConflictError
    || error instanceof PostgreSqlIdentityAliasNormalizedPathConflictError;
}

/**
 * The destination alias rows the source stream carries for this project: the
 * canonical path first, then every authorized map alias, each with the
 * normalized path the source derives for it (#1678).
 */
function authorizedAliasRows(canonicalPath: string, aliases: readonly string[]) {
  return [canonicalPath, ...aliases].map((path) => ({ path, normalizedPath: normalizeProjectPath(path) }));
}

export async function resolveMigrationTargetProjectId(input: Readonly<{
  repository: PostgreSqlIdentityRepository;
  machineId: string;
  displayName: string;
  /**
   * MUST be `resolveProjectIdentity`'s own `local.canonical` -- see this
   * module's own doc comment for exactly why no other input is safe.
   */
  authorityCanonicalPath: string;
  /**
   * The project-map aliases the source stream will carry besides the
   * canonical path (`authorizedMapAliasPaths`). They are minted with the
   * project so the destination holds exactly the source's alias set; a
   * collision between two of them, or with a row already bound elsewhere,
   * refuses as `alias-conflict`.
   */
  aliases?: readonly string[];
  /**
   * @internal Deterministic failure-injection seam for tests only,
   * matching the `_operationsForTesting` convention used elsewhere in
   * `src/migration/`.
   */
  _operationsForTesting?: Partial<MigrationTargetIdentityOperations>;
}>): Promise<MigrationTargetIdentityResolution> {
  const resolveProject = input._operationsForTesting?.resolveProject
    ?? input.repository.resolveProject.bind(input.repository);
  const createProject = input._operationsForTesting?.createProject
    ?? input.repository.createProject.bind(input.repository);
  const ensureProjectAliases = input._operationsForTesting?.ensureProjectAliases
    ?? input.repository.ensureProjectAliases.bind(input.repository);
  const normalizedPath = normalizeProjectPath(input.authorityCanonicalPath);
  const rows = authorizedAliasRows(input.authorityCanonicalPath, input.aliases ?? []);
  if (new Set(rows.map((row) => row.normalizedPath)).size !== rows.length
    || new Set(rows.map((row) => row.path)).size !== rows.length) return ALIAS_CONFLICT;

  // An existing project must hold exactly the authorized alias set: missing
  // rows are added in one transaction, anything else is a conflict.
  const adopt = async (projectId: string): Promise<MigrationTargetIdentityResolution> => {
    try {
      if (await ensureProjectAliases({ machineId: input.machineId, projectId, aliases: rows }) === null) return ALIAS_CONFLICT;
    } catch (error) {
      if (!isAliasConflict(error)) throw error;
      return ALIAS_CONFLICT;
    }
    return { status: "resolved", projectId, effect: "reused" };
  };

  const existing = await resolveProject(input.machineId, normalizedPath);
  if (existing !== null) return adopt(existing.projectId);

  try {
    const created = await createProject({
      machineId: input.machineId,
      displayName: input.displayName,
      path: input.authorityCanonicalPath,
      normalizedPath,
      aliases: rows,
    });
    return { status: "resolved", projectId: created.projectId, effect: "created" };
  } catch (error) {
    if (!isAliasConflict(error)) throw error;
    if (!(error instanceof PostgreSqlIdentityConflictError)) return ALIAS_CONFLICT;
    // The losing side of a real concurrent race: createProject's own
    // transaction has already rolled back cleanly. Re-read rather than
    // refuse -- the winner's commit is what "resolved" means here.
    const resolved = await resolveProject(input.machineId, normalizedPath);
    if (resolved !== null) return adopt(resolved.projectId);
    // Without extra aliases a conflict proves a row exists at the canonical
    // key, so an absent re-read is unresolvable evidence, never a signal to
    // guess or retry blindly. With extra aliases the conflicting row is one
    // of them, bound to another project.
    return rows.length === 1
      ? { status: "refuse", reason: "migration-target-identity-unresolvable", evidence: "post-conflict-reread-absent" }
      : ALIAS_CONFLICT;
  }
}

