import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ResolvedPostgreSqlConfig } from "../../src/daemon/config.js";
import {
  applyBackendPublicationConfigFile,
} from "../../src/config-manager.js";
import {
  BackendPublicationCoordinator,
  assertBackendPublicationConsumerAccess,
  captureBackendPublicationState,
  readBackendPublicationJournal,
  type BackendPublicationDriver,
  type BackendPublicationFileMutationContext,
  type BackendPublicationRecoveryFile,
} from "../../src/storage/backend-publication.js";
import { hashProjectPath } from "../../src/project-map.js";
import {
  createPostgreSqlStorageBackendFactoryForTesting,
} from "../../src/storage/postgresql/factory.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { verifyPostgreSqlRuntimeSchema } from "../../src/storage/postgresql/runtime-readiness.js";
import {
  PostgreSqlIdentityRepository,
  type RegisteredMachine,
  type RemoteProject,
} from "../../src/storage/postgresql/identity-repository.js";
import { applyBackendPublicationProjectMapFile } from "../../src/project-map.js";
import { withStorageBackendConsumerLockAsync } from "../../src/storage/backend.js";
import {
  assertHarnessReady,
  settings,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

const REQUIRED_GRANT_SCRIPTS = [
  "postgresql-runtime-readiness-grants.sql",
  "postgresql-runtime-identity-grants.sql",
  "postgresql-runtime-conversation-grants.sql",
  "postgresql-runtime-summary-context-grants.sql",
  "postgresql-runtime-memory-grants.sql",
  "postgresql-runtime-search-grants.sql",
  "postgresql-runtime-coordination-grants.sql",
] as const;

const TRANSCRIPT_GRANT_SCRIPT = "postgresql-runtime-transcript-grants.sql";

function recoveryFile(content: string): BackendPublicationRecoveryFile {
  const bytes = Buffer.from(content);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  return {
    presence: "present",
    content: bytes,
    mode: 0o600,
    uid,
    gid,
    nlink: "1",
    dev: "1",
    ino: "2",
    parentDev: "3",
    parentIno: "4",
  };
}

function publicationDriver(homeDir: string): BackendPublicationDriver {
  return {
    observeLocalState: async () => captureBackendPublicationState(homeDir),
    publishProjectMap: (input: BackendPublicationFileMutationContext) =>
      applyBackendPublicationProjectMapFile(input),
    publishConfig: (input: BackendPublicationFileMutationContext) =>
      applyBackendPublicationConfigFile(input),
    restoreConfig: (input: BackendPublicationFileMutationContext) =>
      applyBackendPublicationConfigFile(input),
    restoreProjectMap: (input: BackendPublicationFileMutationContext) =>
      applyBackendPublicationProjectMapFile(input),
  };
}

async function applyRuntimeGrantScript(
  administrator: PostgreSqlRuntime,
  fileName: string,
  operation: string,
): Promise<void> {
  const template = readFileSync(
    join(process.cwd(), "src/storage/postgresql/reference", fileName),
    "utf8",
  );
  const sql = template
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await administrator.query({ text: sql }, {
    domain: "factory",
    operation,
  });
}

async function applyAllRuntimeGrants(
  database: PostgreSqlTestDatabase,
  options: {
    readonly includeTranscript?: boolean;
    readonly omit?: readonly string[];
  } = {},
): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
  try {
    for (const fileName of REQUIRED_GRANT_SCRIPTS) {
      if (options.omit?.includes(fileName)) continue;
      await applyRuntimeGrantScript(
        administrator,
        fileName,
        `apply${fileName.replaceAll(/[^A-Za-z0-9]/gu, "")}`,
      );
    }
    if (options.includeTranscript === true) {
      await applyRuntimeGrantScript(
        administrator,
        TRANSCRIPT_GRANT_SCRIPT,
        "applyPostgresqlRuntimeTranscriptGrantScript",
      );
    }
  } finally {
    await administrator.close();
  }
}

async function readRuntimeDatabaseCreatePrivilege(
  database: PostgreSqlTestDatabase,
  operation: string,
): Promise<boolean> {
  const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl, { poolMax: 1 }));
  try {
    const result = await runtime.query<{ can_create: boolean }>({
      text: `SELECT pg_catalog.has_database_privilege(
                      CURRENT_USER,
                      pg_catalog.current_database(),
                      'CREATE'
                    ) AS can_create`,
    }, { domain: "factory", operation });
    const value = result.rows.length === 1 ? result.rows[0]?.can_create : undefined;
    if (typeof value !== "boolean") {
      throw new Error("invalid runtime database CREATE privilege fixture state");
    }
    return value;
  } finally {
    await runtime.close();
  }
}

async function readRuntimeSessionReplicationRoleSetPrivilege(
  database: PostgreSqlTestDatabase,
  operation: string,
): Promise<boolean> {
  const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl, { poolMax: 1 }));
  try {
    const result = await runtime.query<{ can_set: boolean }>({
      text: `SELECT pg_catalog.has_parameter_privilege(
                      CURRENT_USER,
                      'session_replication_role',
                      'SET'
                    ) AS can_set`,
    }, { domain: "factory", operation });
    const value = result.rows.length === 1 ? result.rows[0]?.can_set : undefined;
    if (typeof value !== "boolean") {
      throw new Error("invalid runtime session_replication_role SET privilege fixture state");
    }
    return value;
  } finally {
    await runtime.close();
  }
}

async function setRuntimeSessionReplicationRoleToReplica(
  database: PostgreSqlTestDatabase,
  operation: string,
): Promise<string> {
  const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl, { poolMax: 1 }));
  try {
    await runtime.query({
      text: "SET session_replication_role TO replica",
    }, { domain: "factory", operation: `${operation}Set` });
    const result = await runtime.query<{ session_replication_role: string }>({
      text: `SELECT pg_catalog.current_setting('session_replication_role')
                      AS session_replication_role`,
    }, { domain: "factory", operation: `${operation}Readback` });
    const value = result.rows.length === 1
      ? result.rows[0]?.session_replication_role
      : undefined;
    if (typeof value !== "string") {
      throw new Error("invalid runtime session_replication_role fixture state");
    }
    await runtime.query({
      text: "RESET session_replication_role",
    }, { domain: "factory", operation: `${operation}Reset` });
    return value;
  } finally {
    await runtime.close();
  }
}

interface ExtensionFunctionState {
  readonly oid: string;
  readonly definition: string;
  readonly extensionName: string | null;
  readonly languageName: string;
}

async function inspectExtensionFunctionState(
  administrator: PostgreSqlRuntime,
  functionIdentity: string,
  operation: string,
): Promise<ExtensionFunctionState> {
  const result = await administrator.query({
    text: `SELECT procedure.oid::pg_catalog.text AS oid,
                  pg_catalog.pg_get_functiondef(procedure.oid) AS definition,
                  language.lanname::pg_catalog.text AS language_name,
                  (
                    SELECT extension.extname::pg_catalog.text
                    FROM pg_catalog.pg_depend AS dependency
                    JOIN pg_catalog.pg_extension AS extension
                      ON extension.oid OPERATOR(pg_catalog.=) dependency.refobjid
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_proc')
                      AND dependency.objid OPERATOR(pg_catalog.=) procedure.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'e'
                  ) AS extension_name
           FROM pg_catalog.pg_proc AS procedure
           JOIN pg_catalog.pg_language AS language
             ON language.oid OPERATOR(pg_catalog.=) procedure.prolang
           WHERE procedure.oid OPERATOR(pg_catalog.=) $1::pg_catalog.regprocedure`,
    values: [functionIdentity],
  }, { domain: "factory", operation });
  const row = result.rows[0];
  if (
    typeof row?.oid !== "string"
    || typeof row.definition !== "string"
    || typeof row.language_name !== "string"
    || (typeof row.extension_name !== "string" && row.extension_name !== null)
  ) {
    throw new Error("invalid extension function fixture state");
  }
  return {
    oid: row.oid,
    definition: row.definition,
    extensionName: row.extension_name,
    languageName: row.language_name,
  };
}

async function restoreExtensionFunctionState(
  administrator: PostgreSqlRuntime,
  extensionName: "pgcrypto" | "pg_trgm",
  functionIdentity: string,
  authoritative: ExtensionFunctionState,
): Promise<void> {
  const current = await inspectExtensionFunctionState(
    administrator,
    functionIdentity,
    "inspectExtensionFunctionBeforeRestore",
  );
  if (current.extensionName === extensionName) {
    await administrator.query({
      text: `ALTER EXTENSION ${extensionName} DROP FUNCTION ${functionIdentity}`,
    }, { domain: "factory", operation: "detachExtensionFunctionBeforeRestore" });
  }
  await administrator.query({ text: authoritative.definition }, {
    domain: "factory",
    operation: "restoreAuthoritativeExtensionFunction",
  });
  if (authoritative.extensionName === extensionName) {
    await administrator.query({
      text: `ALTER EXTENSION ${extensionName} ADD FUNCTION ${functionIdentity}`,
    }, { domain: "factory", operation: "restoreExtensionFunctionMembership" });
  }
}

interface ExtensionOperatorDefinitionState {
  readonly schemaName: string;
  readonly operatorName: string;
  readonly operatorKind: string;
  readonly leftType: string;
  readonly rightType: string;
  readonly resultType: string;
  readonly ownerName: string;
  readonly extensionName: string | null;
  readonly extensionOwnerName: string | null;
  readonly implementationOid: string;
  readonly implementationIdentity: string;
  readonly commutatorMatchesSelf: boolean;
  readonly negatorAbsent: boolean;
  readonly restrictionOid: string;
  readonly joinOid: string;
  readonly canMerge: boolean;
  readonly canHash: boolean;
  readonly dependencyCount: number;
  readonly extensionDependencyCount: number;
  readonly implementationDependencyCount: number;
  readonly namespaceDependencyCount: number;
}

interface ExtensionOperatorState {
  readonly oid: string;
  readonly definition: ExtensionOperatorDefinitionState;
}

const REQUIRED_SIMILARITY_OPERATOR = "public.%(pg_catalog.text, pg_catalog.text)";
const FOREIGN_SIMILARITY_OPERATOR_FUNCTION =
  "public.lcm_test_foreign_similarity_operator(pg_catalog.text, pg_catalog.text)";

async function inspectExtensionOperatorState(
  administrator: PostgreSqlRuntime,
  operation: string,
): Promise<ExtensionOperatorState | null> {
  const result = await administrator.query({
    text: `SELECT catalog_operator.oid::pg_catalog.text AS oid,
                  namespace.nspname::pg_catalog.text AS schema_name,
                  catalog_operator.oprname::pg_catalog.text AS operator_name,
                  catalog_operator.oprkind::pg_catalog.text AS operator_kind,
                  catalog_operator.oprleft::pg_catalog.regtype::pg_catalog.text AS left_type,
                  catalog_operator.oprright::pg_catalog.regtype::pg_catalog.text AS right_type,
                  catalog_operator.oprresult::pg_catalog.regtype::pg_catalog.text AS result_type,
                  owner.rolname::pg_catalog.text AS owner_name,
                  extension.extname::pg_catalog.text AS extension_name,
                  extension_owner.rolname::pg_catalog.text AS extension_owner_name,
                  (catalog_operator.oprcode::pg_catalog.oid)::pg_catalog.text
                    AS implementation_oid,
                  pg_catalog.concat(
                    implementation_namespace.nspname,
                    '.',
                    implementation.proname,
                    '(',
                    pg_catalog.pg_get_function_identity_arguments(implementation.oid),
                    ')'
                  ) AS implementation_identity,
                  catalog_operator.oprcom OPERATOR(pg_catalog.=) catalog_operator.oid
                    AS commutator_matches_self,
                  catalog_operator.oprnegate OPERATOR(pg_catalog.=) 0::pg_catalog.oid
                    AS negator_absent,
                  (catalog_operator.oprrest::pg_catalog.oid)::pg_catalog.text AS restriction_oid,
                  (catalog_operator.oprjoin::pg_catalog.oid)::pg_catalog.text AS join_oid,
                  catalog_operator.oprcanmerge AS can_merge,
                  catalog_operator.oprcanhash AS can_hash,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_operator')
                      AND dependency.objid OPERATOR(pg_catalog.=) catalog_operator.oid
                  ) AS dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_operator')
                      AND dependency.objid OPERATOR(pg_catalog.=) catalog_operator.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_extension')
                      AND dependency.refobjid OPERATOR(pg_catalog.=) extension.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'e'
                  ) AS extension_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_operator')
                      AND dependency.objid OPERATOR(pg_catalog.=) catalog_operator.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_proc')
                      AND dependency.refobjid OPERATOR(pg_catalog.=) implementation.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'n'
                  ) AS implementation_dependency_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_depend AS dependency
                    WHERE dependency.classid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_operator')
                      AND dependency.objid OPERATOR(pg_catalog.=) catalog_operator.oid
                      AND dependency.objsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.refclassid OPERATOR(pg_catalog.=)
                        pg_catalog.to_regclass('pg_catalog.pg_namespace')
                      AND dependency.refobjid OPERATOR(pg_catalog.=) namespace.oid
                      AND dependency.refobjsubid OPERATOR(pg_catalog.=) 0
                      AND dependency.deptype OPERATOR(pg_catalog.=) 'n'
                  ) AS namespace_dependency_count
           FROM pg_catalog.pg_operator AS catalog_operator
           JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid OPERATOR(pg_catalog.=) catalog_operator.oprnamespace
           JOIN pg_catalog.pg_roles AS owner
             ON owner.oid OPERATOR(pg_catalog.=) catalog_operator.oprowner
           JOIN pg_catalog.pg_proc AS implementation
             ON implementation.oid OPERATOR(pg_catalog.=) catalog_operator.oprcode
           JOIN pg_catalog.pg_namespace AS implementation_namespace
             ON implementation_namespace.oid OPERATOR(pg_catalog.=) implementation.pronamespace
           LEFT JOIN pg_catalog.pg_depend AS extension_dependency
             ON extension_dependency.classid OPERATOR(pg_catalog.=)
                  pg_catalog.to_regclass('pg_catalog.pg_operator')
            AND extension_dependency.objid OPERATOR(pg_catalog.=) catalog_operator.oid
            AND extension_dependency.objsubid OPERATOR(pg_catalog.=) 0
            AND extension_dependency.refclassid OPERATOR(pg_catalog.=)
                  pg_catalog.to_regclass('pg_catalog.pg_extension')
            AND extension_dependency.refobjsubid OPERATOR(pg_catalog.=) 0
            AND extension_dependency.deptype OPERATOR(pg_catalog.=) 'e'
           LEFT JOIN pg_catalog.pg_extension AS extension
             ON extension.oid OPERATOR(pg_catalog.=) extension_dependency.refobjid
           LEFT JOIN pg_catalog.pg_roles AS extension_owner
             ON extension_owner.oid OPERATOR(pg_catalog.=) extension.extowner
           WHERE namespace.nspname OPERATOR(pg_catalog.=) 'public'
             AND catalog_operator.oprname OPERATOR(pg_catalog.=) '%'
             AND catalog_operator.oprleft OPERATOR(pg_catalog.=) 'pg_catalog.text'::pg_catalog.regtype
             AND catalog_operator.oprright OPERATOR(pg_catalog.=) 'pg_catalog.text'::pg_catalog.regtype`,
  }, { domain: "factory", operation });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || typeof row?.oid !== "string"
    || typeof row.schema_name !== "string"
    || typeof row.operator_name !== "string"
    || typeof row.operator_kind !== "string"
    || typeof row.left_type !== "string"
    || typeof row.right_type !== "string"
    || typeof row.result_type !== "string"
    || typeof row.owner_name !== "string"
    || (typeof row.extension_name !== "string" && row.extension_name !== null)
    || (typeof row.extension_owner_name !== "string" && row.extension_owner_name !== null)
    || typeof row.implementation_oid !== "string"
    || typeof row.implementation_identity !== "string"
    || typeof row.commutator_matches_self !== "boolean"
    || typeof row.negator_absent !== "boolean"
    || typeof row.restriction_oid !== "string"
    || typeof row.join_oid !== "string"
    || typeof row.can_merge !== "boolean"
    || typeof row.can_hash !== "boolean"
    || typeof row.dependency_count !== "number"
    || typeof row.extension_dependency_count !== "number"
    || typeof row.implementation_dependency_count !== "number"
    || typeof row.namespace_dependency_count !== "number"
  ) {
    throw new Error("invalid extension operator fixture state");
  }
  return {
    oid: row.oid,
    definition: {
      schemaName: row.schema_name,
      operatorName: row.operator_name,
      operatorKind: row.operator_kind,
      leftType: row.left_type,
      rightType: row.right_type,
      resultType: row.result_type,
      ownerName: row.owner_name,
      extensionName: row.extension_name,
      extensionOwnerName: row.extension_owner_name,
      implementationOid: row.implementation_oid,
      implementationIdentity: row.implementation_identity,
      commutatorMatchesSelf: row.commutator_matches_self,
      negatorAbsent: row.negator_absent,
      restrictionOid: row.restriction_oid,
      joinOid: row.join_oid,
      canMerge: row.can_merge,
      canHash: row.can_hash,
      dependencyCount: row.dependency_count,
      extensionDependencyCount: row.extension_dependency_count,
      implementationDependencyCount: row.implementation_dependency_count,
      namespaceDependencyCount: row.namespace_dependency_count,
    },
  };
}

async function restoreExtensionOperatorState(
  administrator: PostgreSqlRuntime,
  authoritative: ExtensionOperatorState,
): Promise<void> {
  const current = await inspectExtensionOperatorState(
    administrator,
    "inspectExtensionOperatorBeforeRestore",
  );
  if (current?.definition.extensionName === "pg_trgm") {
    await administrator.query({
      text: `ALTER EXTENSION pg_trgm DROP OPERATOR ${REQUIRED_SIMILARITY_OPERATOR}`,
    }, { domain: "factory", operation: "detachExtensionOperatorBeforeRestore" });
  }
  await administrator.query({
    text: `DROP OPERATOR IF EXISTS ${REQUIRED_SIMILARITY_OPERATOR}`,
  }, { domain: "factory", operation: "dropReplacedExtensionOperator" });
  await administrator.query({
    text: `DROP FUNCTION IF EXISTS ${FOREIGN_SIMILARITY_OPERATOR_FUNCTION}`,
  }, { domain: "factory", operation: "dropForeignSimilarityOperatorFunction" });
  await administrator.query({
    text: `CREATE OPERATOR public.% (
             LEFTARG = pg_catalog.text,
             RIGHTARG = pg_catalog.text,
             FUNCTION = public.similarity_op,
             COMMUTATOR = OPERATOR(public.%),
             RESTRICT = pg_catalog.matchingsel,
             JOIN = pg_catalog.matchingjoinsel
           )`,
  }, { domain: "factory", operation: "restoreAuthoritativeExtensionOperator" });
  if (authoritative.definition.extensionName === "pg_trgm") {
    await administrator.query({
      text: `ALTER EXTENSION pg_trgm ADD OPERATOR ${REQUIRED_SIMILARITY_OPERATOR}`,
    }, { domain: "factory", operation: "restoreExtensionOperatorMembership" });
  }
}

const REQUIRED_GIN_TRGM_INDEX_NAMES = [
  "messages_content_trgm_idx",
  "promoted_memories_content_trgm_idx",
  "promoted_memory_tags_tag_trgm_idx",
  "summaries_content_trgm_idx",
] as const;

interface GinTrgmIndexState {
  readonly name: string;
  readonly definition: string;
  readonly valid: boolean;
  readonly ready: boolean;
  readonly live: boolean;
}

interface GinTrgmGraphState {
  readonly operatorClassExtension: string;
  readonly operatorFamilyExtension: string;
  readonly comparatorIdentity: string;
  readonly operatorCount: number;
  readonly supportFunctionCount: number;
}

async function inspectGinTrgmIndexes(
  administrator: PostgreSqlRuntime,
  operation: string,
): Promise<readonly GinTrgmIndexState[]> {
  const result = await administrator.query({
    text: `SELECT relation.relname::pg_catalog.text AS name,
                  pg_catalog.pg_get_indexdef(relation.oid) AS definition,
                  index.indisvalid AS valid,
                  index.indisready AS ready,
                  index.indislive AS live
           FROM pg_catalog.pg_class AS relation
           JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
           JOIN pg_catalog.pg_index AS index
             ON index.indexrelid OPERATOR(pg_catalog.=) relation.oid
           WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
             AND relation.relname OPERATOR(pg_catalog.=) ANY ($1::pg_catalog.text[])
           ORDER BY relation.relname`,
    values: [[...REQUIRED_GIN_TRGM_INDEX_NAMES]],
  }, { domain: "factory", operation });
  if (
    result.rows.length !== REQUIRED_GIN_TRGM_INDEX_NAMES.length
    || result.rows.some((row) => (
      typeof row.name !== "string"
      || typeof row.definition !== "string"
      || typeof row.valid !== "boolean"
      || typeof row.ready !== "boolean"
      || typeof row.live !== "boolean"
    ))
  ) {
    throw new Error("invalid gin_trgm_ops index fixture state");
  }
  return result.rows.map((row) => ({
    name: row.name as string,
    definition: row.definition as string,
    valid: row.valid as boolean,
    ready: row.ready as boolean,
    live: row.live as boolean,
  }));
}

function ginTrgmIndexFingerprint(indexes: readonly GinTrgmIndexState[]): string {
  return createHash("sha256").update(indexes.map(({ name, definition }) => (
    `${name}\0${definition}`
  )).join("\n")).digest("hex");
}

async function inspectGinTrgmGraph(
  administrator: PostgreSqlRuntime,
  operation: string,
): Promise<GinTrgmGraphState> {
  const result = await administrator.query({
    text: `SELECT operator_class_extension.extname::pg_catalog.text
                    AS operator_class_extension,
                  operator_family_extension.extname::pg_catalog.text
                    AS operator_family_extension,
                  pg_catalog.concat(
                    comparator_namespace.nspname,
                    '.',
                    comparator.proname,
                    '(',
                    pg_catalog.pg_get_function_identity_arguments(comparator.oid),
                    ')'
                  ) AS comparator_identity,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_amop AS operator_mapping
                    WHERE operator_mapping.amopfamily OPERATOR(pg_catalog.=)
                        operator_family.oid
                  ) AS operator_count,
                  (
                    SELECT pg_catalog.count(*)::pg_catalog.int4
                    FROM pg_catalog.pg_amproc AS support_mapping
                    WHERE support_mapping.amprocfamily OPERATOR(pg_catalog.=)
                        operator_family.oid
                  ) AS support_function_count
           FROM pg_catalog.pg_opclass AS operator_class
           JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid OPERATOR(pg_catalog.=) operator_class.opcnamespace
           JOIN pg_catalog.pg_am AS access_method
             ON access_method.oid OPERATOR(pg_catalog.=) operator_class.opcmethod
           JOIN pg_catalog.pg_opfamily AS operator_family
             ON operator_family.oid OPERATOR(pg_catalog.=) operator_class.opcfamily
           JOIN pg_catalog.pg_amproc AS comparator_mapping
             ON comparator_mapping.amprocfamily OPERATOR(pg_catalog.=) operator_family.oid
            AND comparator_mapping.amprocnum OPERATOR(pg_catalog.=) 1
            AND comparator_mapping.amproclefttype OPERATOR(pg_catalog.=)
                'pg_catalog.text'::pg_catalog.regtype
            AND comparator_mapping.amprocrighttype OPERATOR(pg_catalog.=)
                'pg_catalog.text'::pg_catalog.regtype
           JOIN pg_catalog.pg_proc AS comparator
             ON comparator.oid OPERATOR(pg_catalog.=) comparator_mapping.amproc
           JOIN pg_catalog.pg_namespace AS comparator_namespace
             ON comparator_namespace.oid OPERATOR(pg_catalog.=) comparator.pronamespace
           JOIN pg_catalog.pg_depend AS operator_class_extension_dependency
             ON operator_class_extension_dependency.classid OPERATOR(pg_catalog.=)
                  pg_catalog.to_regclass('pg_catalog.pg_opclass')
            AND operator_class_extension_dependency.objid OPERATOR(pg_catalog.=)
                operator_class.oid
            AND operator_class_extension_dependency.refclassid OPERATOR(pg_catalog.=)
                  pg_catalog.to_regclass('pg_catalog.pg_extension')
            AND operator_class_extension_dependency.deptype OPERATOR(pg_catalog.=) 'e'
           JOIN pg_catalog.pg_extension AS operator_class_extension
             ON operator_class_extension.oid OPERATOR(pg_catalog.=)
                operator_class_extension_dependency.refobjid
           JOIN pg_catalog.pg_depend AS operator_family_extension_dependency
             ON operator_family_extension_dependency.classid OPERATOR(pg_catalog.=)
                  pg_catalog.to_regclass('pg_catalog.pg_opfamily')
            AND operator_family_extension_dependency.objid OPERATOR(pg_catalog.=)
                operator_family.oid
            AND operator_family_extension_dependency.refclassid OPERATOR(pg_catalog.=)
                  pg_catalog.to_regclass('pg_catalog.pg_extension')
            AND operator_family_extension_dependency.deptype OPERATOR(pg_catalog.=) 'e'
           JOIN pg_catalog.pg_extension AS operator_family_extension
             ON operator_family_extension.oid OPERATOR(pg_catalog.=)
                operator_family_extension_dependency.refobjid
           WHERE namespace.nspname OPERATOR(pg_catalog.=) 'public'
             AND operator_class.opcname OPERATOR(pg_catalog.=) 'gin_trgm_ops'
             AND access_method.amname OPERATOR(pg_catalog.=) 'gin'`,
  }, { domain: "factory", operation });
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || typeof row?.operator_class_extension !== "string"
    || typeof row.operator_family_extension !== "string"
    || typeof row.comparator_identity !== "string"
    || typeof row.operator_count !== "number"
    || typeof row.support_function_count !== "number"
  ) {
    throw new Error("invalid gin_trgm_ops graph fixture state");
  }
  return {
    operatorClassExtension: row.operator_class_extension,
    operatorFamilyExtension: row.operator_family_extension,
    comparatorIdentity: row.comparator_identity,
    operatorCount: row.operator_count,
    supportFunctionCount: row.support_function_count,
  };
}

async function replaceGinTrgmOperatorClass(
  administrator: PostgreSqlRuntime,
  authoritativeIndexes: readonly GinTrgmIndexState[],
): Promise<void> {
  await administrator.query({
    text: `${REQUIRED_GIN_TRGM_INDEX_NAMES.map((name) => (
      `DROP INDEX lcm.${name}`
    )).join(";\n")};
           ALTER EXTENSION pg_trgm
             DROP OPERATOR CLASS public.gin_trgm_ops USING gin;
           ALTER EXTENSION pg_trgm
             DROP OPERATOR FAMILY public.gin_trgm_ops USING gin;
           DROP OPERATOR CLASS public.gin_trgm_ops USING gin;
           DROP OPERATOR FAMILY public.gin_trgm_ops USING gin;
           CREATE FUNCTION public.lcm_test_foreign_btint4cmp(integer, integer)
           RETURNS integer
           LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
           AS $$ SELECT 0 $$;
           CREATE OPERATOR FAMILY public.gin_trgm_ops USING gin;
           CREATE OPERATOR CLASS public.gin_trgm_ops
           FOR TYPE pg_catalog.text USING gin
           FAMILY public.gin_trgm_ops AS
             OPERATOR 1 public.% (pg_catalog.text, pg_catalog.text),
             FUNCTION 1 public.lcm_test_foreign_btint4cmp(integer, integer),
             FUNCTION 2 public.gin_extract_value_trgm(text, internal),
             FUNCTION 3 public.gin_extract_query_trgm(
               text, internal, smallint, internal, internal, internal, internal
             ),
             FUNCTION 4 public.gin_trgm_consistent(
               internal, smallint, text, integer, internal, internal, internal, internal
             ),
             STORAGE pg_catalog.int4;
           ALTER OPERATOR FAMILY public.gin_trgm_ops USING gin
             DROP FUNCTION 4 (pg_catalog.text, pg_catalog.text);
           ALTER OPERATOR FAMILY public.gin_trgm_ops USING gin ADD
             OPERATOR 3 pg_catalog.~~ (pg_catalog.text, pg_catalog.text),
             OPERATOR 4 pg_catalog.~~* (pg_catalog.text, pg_catalog.text),
             OPERATOR 5 pg_catalog.~ (pg_catalog.text, pg_catalog.text),
             OPERATOR 6 pg_catalog.~* (pg_catalog.text, pg_catalog.text),
             OPERATOR 7 public.%> (pg_catalog.text, pg_catalog.text),
             OPERATOR 9 public.%>> (pg_catalog.text, pg_catalog.text),
             OPERATOR 11 pg_catalog.= (pg_catalog.text, pg_catalog.text),
             FUNCTION 4 (pg_catalog.text, pg_catalog.text)
               public.gin_trgm_consistent(
                 internal, smallint, text, integer, internal, internal, internal, internal
               ),
             FUNCTION 6 (pg_catalog.text, pg_catalog.text)
               public.gin_trgm_triconsistent(
                 internal, smallint, text, integer, internal, internal, internal
               );
           ALTER EXTENSION pg_trgm
             ADD OPERATOR FAMILY public.gin_trgm_ops USING gin;
           ALTER EXTENSION pg_trgm
             ADD OPERATOR CLASS public.gin_trgm_ops USING gin;
           ${authoritativeIndexes.map(({ definition }) => definition).join(";\n")}`,
  }, { domain: "factory", operation: "replaceGinTrgmOperatorClass" });
}

async function restorePackagedGinTrgmObjects(
  database: PostgreSqlTestDatabase,
  administrator: PostgreSqlRuntime,
  authoritativeIndexes: readonly GinTrgmIndexState[],
): Promise<void> {
  await administrator.query({
    text: `${REQUIRED_GIN_TRGM_INDEX_NAMES.map((name) => (
      `DROP INDEX IF EXISTS lcm.${name}`
    )).join(";\n")};
           DROP EXTENSION IF EXISTS pg_trgm CASCADE;
           DROP OPERATOR CLASS IF EXISTS public.gin_trgm_ops USING gin CASCADE;
           DROP OPERATOR FAMILY IF EXISTS public.gin_trgm_ops USING gin;
           DROP FUNCTION IF EXISTS public.lcm_test_foreign_btint4cmp(integer, integer);
           CREATE EXTENSION pg_trgm WITH SCHEMA public;
           ${authoritativeIndexes.map(({ definition }) => definition).join(";\n")}`,
  }, { domain: "factory", operation: "restorePackagedGinTrgmObjects" });
  await applyAllRuntimeGrants(database);
}

async function createIdentityFixture(
  database: PostgreSqlTestDatabase,
  label: string,
): Promise<{
  readonly machine: RegisteredMachine;
  readonly first: RemoteProject;
  readonly second: RemoteProject;
  readonly firstPath: string;
  readonly secondPath: string;
  readonly projectRoot: string;
}> {
  const projectRoot = mkdtempSync(join(tmpdir(), `lcm-pg-factory-${label}-`));
  const firstPath = join(projectRoot, "first");
  const secondPath = join(projectRoot, "second");
  mkdirSync(firstPath);
  mkdirSync(secondPath);
  const repository = new PostgreSqlIdentityRepository(database.migrator);
  const machine = await repository.registerMachine(
    `machine:${createHash("sha256").update(label).digest("hex")}`,
    `Factory ${label}`,
  );
  const first = await repository.createProject({
    machineId: machine.machineId,
    displayName: `Factory ${label} first`,
    path: firstPath,
    normalizedPath: resolve(firstPath),
  });
  const second = await repository.createProject({
    machineId: machine.machineId,
    displayName: `Factory ${label} second`,
    path: secondPath,
    normalizedPath: resolve(secondPath),
  });
  return { machine, first, second, firstPath, secondPath, projectRoot };
}

async function establishPublication(
  homeDir: string,
  machine: RegisteredMachine,
  projects: readonly [{ project: RemoteProject; path: string }, { project: RemoteProject; path: string }],
): Promise<void> {
  const lcmDir = join(homeDir, ".lcm");
  mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
  const sourceConfig = "{\"storage\":{\"backend\":\"sqlite\"}}\n";
  const sourceMap = "{}\n";
  const targetConfig = "{\"storage\":{\"backend\":\"postgresql\"}}\n";
  const targetMap = `${JSON.stringify(Object.fromEntries(projects.map(({ project, path }) => [
    hashProjectPath(path),
    { canonical: path, aliases: [], remoteProjectId: project.projectId },
  ])))}\n`;
  writeFileSync(join(lcmDir, "config.json"), sourceConfig, { mode: 0o600 });
  writeFileSync(join(lcmDir, "map.json"), sourceMap, { mode: 0o600 });
  const coordinator = new BackendPublicationCoordinator({
    homeDir,
    driver: publicationDriver(homeDir),
  });
  await coordinator.prepare({
    publicationId: `factory-${machine.machineId}`,
    sourceBackend: "sqlite",
    targetBackend: "postgresql",
    material: {
      source: {
        config: recoveryFile(sourceConfig),
        projectMap: recoveryFile(sourceMap),
      },
      target: {
        config: recoveryFile(targetConfig),
        projectMap: recoveryFile(targetMap),
      },
    },
    projects: projects.map(({ project, path }) => ({
      localProjectId: hashProjectPath(path),
      remoteProjectId: project.projectId,
      evidenceSha256: createHash("sha256").update(path).digest("hex"),
    })),
  });
  await expect(coordinator.resume()).resolves.toMatchObject({
    phase: "completed",
    targetBackend: "postgresql",
  });
  const journal = readBackendPublicationJournal(homeDir);
  expect(journal).toMatchObject({
    phase: "completed",
    targetBackend: "postgresql",
  });
  expect(() => assertBackendPublicationConsumerAccess({
    backend: "postgresql",
    homeDir,
  })).not.toThrow();
}

function factoryConfig(
  database: PostgreSqlTestDatabase,
  overrides: Partial<ResolvedPostgreSqlConfig["postgresql"]> = {},
): ResolvedPostgreSqlConfig {
  return {
    backend: "postgresql",
    postgresql: {
      url: database.runtimeUrl,
      caFile: process.env.LCM_TEST_POSTGRES_CA_FILE!,
      poolMax: 4,
      connectionTimeoutMs: 2_000,
      idleTimeoutMs: 1_000,
      statementTimeoutMs: 5_000,
      migrationRole: "lcm_test_migrator",
      ...overrides,
    },
  };
}

function identityContext(
  fixture: Awaited<ReturnType<typeof createIdentityFixture>>,
  project: "first" | "second" = "first",
  overrides: Partial<{
    id: string;
    localProjectId: string;
    canonical: string;
    remoteProjectId: string;
    machineId: string;
    selectedPath: string;
  }> = {},
) {
  const selectedProject = project === "first" ? fixture.first : fixture.second;
  const selectedPath = project === "first" ? fixture.firstPath : fixture.secondPath;
  return {
    id: selectedProject.projectId,
    localProjectId: hashProjectPath(selectedPath),
    canonical: selectedPath,
    remoteProjectId: selectedProject.projectId,
    machineId: fixture.machine.machineId,
    selectedPath,
    ...overrides,
  };
}

async function closeProjectAndFactory(
  factory: Awaited<ReturnType<typeof createPostgreSqlStorageBackendFactoryForTesting>>,
  projects: readonly (Awaited<ReturnType<typeof factory.openExistingProject>>)[],
): Promise<void> {
  await factory.close();
  await Promise.all(projects.filter((project): project is NonNullable<typeof project> => project !== null)
    .map((project) => project.close().catch(() => undefined)));
}

describe("PostgreSQL 18 project storage factory", () => {
  it("opens with supplied and self-acquired admission and composes all nine domains", async () => {
    await withPostgreSqlTestDatabase("factory-domains", async (database) => {
      await applyAllRuntimeGrants(database);
      const fixture = await createIdentityFixture(database, "factory-domains");
      const homeDir = mkdtempSync(join(tmpdir(), "lcm-pg-factory-home-"));
      const projects: Array<Awaited<ReturnType<
        Awaited<ReturnType<typeof createPostgreSqlStorageBackendFactoryForTesting>>["openExistingProject"]
      >>> = [];
      let factory: Awaited<ReturnType<
        typeof createPostgreSqlStorageBackendFactoryForTesting
      >> | undefined;
      try {
        await establishPublication(homeDir, fixture.machine, [
          { project: fixture.first, path: fixture.firstPath },
          { project: fixture.second, path: fixture.secondPath },
        ]);
        await expect(verifyPostgreSqlRuntimeSchema(database.runtime, {
          expectedOwner: "lcm_test_migrator",
        })).resolves.toMatchObject({
          expectedOwner: "lcm_test_migrator",
          runtimeRole: "lcm_test_runtime",
        });
        factory = await createPostgreSqlStorageBackendFactoryForTesting(
          factoryConfig(database),
          homeDir,
        );
        const first = await withStorageBackendConsumerLockAsync(
          homeDir,
          (token) => factory!.openProject(identityContext(fixture), token),
        );
        projects.push(first);
        const second = await factory.openExistingProject(
          identityContext(fixture, "second"),
        );
        expect(second).not.toBeNull();
        projects.push(second);

        const transactionResult = await first.transaction(async (repositories) => {
          const conversation = await repositories.conversations.createConversation({
            sessionId: "factory-session",
            title: "Factory transaction",
          });
          const message = await repositories.conversations.createMessage({
            conversationId: conversation.conversationId,
            seq: 0,
            role: "user",
            content: "factory needle",
            tokenCount: 2,
          });
          const largeFile = await repositories.largeFiles.insertLargeFile({
            fileId: "factory-file",
            conversationId: conversation.conversationId,
            storageUri: "lcm://factory/file",
          });
          const summary = await repositories.summaries.insertSummary({
            summaryId: "factory-summary",
            conversationId: conversation.conversationId,
            kind: "leaf",
            content: "factory needle summary",
            tokenCount: 3,
            fileIds: [largeFile.fileId],
          });
          await repositories.context.appendContextMessage(
            conversation.conversationId,
            message.messageId,
          );
          const memoryId = await repositories.promotedMemory.insert({
            content: "factory needle memory",
            tags: ["factory"],
          });
          await repositories.recall.logSurfacing([memoryId], "factory-session");
          await repositories.redactionAdmin.upsertCounts({
            gitleaks: 1,
            builtIn: 2,
            global: 3,
            project: 4,
          });
          await repositories.coordination.recordSessionIngest("factory-session", 1);
          expect(await repositories.lexicalSearch.searchMessages({
            query: "factory",
            mode: "full_text",
          })).toHaveLength(1);
          return { conversation, message, largeFile, summary, memoryId };
        });

        expect(await first.conversations.getConversation(
          transactionResult.conversation.conversationId,
        )).toMatchObject({ sessionId: "factory-session" });
        expect(await first.summaries.getSummary(transactionResult.summary.summaryId))
          .toMatchObject({ content: "factory needle summary" });
        expect(await first.context.getContextItems(
          transactionResult.conversation.conversationId,
        )).toMatchObject([{ messageId: transactionResult.message.messageId }]);
        expect(await first.largeFiles.getLargeFile(transactionResult.largeFile.fileId))
          .toMatchObject({ storageUri: "lcm://factory/file" });
        expect(await first.promotedMemory.getById(transactionResult.memoryId))
          .toMatchObject({ tags: ["factory"] });
        expect((await first.recall.getFeedback([transactionResult.memoryId]))
          .get(transactionResult.memoryId)).toMatchObject({ surfacingCount: 1 });
        expect(await first.redactionAdmin.getCounts()).toEqual({
          gitleaks: 1,
          builtIn: 2,
          global: 3,
          project: 4,
          total: 10,
        });
        expect(await first.lexicalSearch.searchSummaries({
          query: "factory",
          mode: "full_text",
        })).toHaveLength(1);
        expect(await first.coordination.getSessionIngest("factory-session"))
          .toMatchObject({ messageCount: 1 });

        const secondConversation = await second!.conversations.createConversation({
          sessionId: "factory-session",
          title: "Sibling project",
        });
        expect(secondConversation.conversationId)
          .not.toBe(transactionResult.conversation.conversationId);
        expect(await first.conversations.getConversation(secondConversation.conversationId))
          .toBeNull();
        expect(await second!.promotedMemory.getById(transactionResult.memoryId)).toBeNull();
        expect(await factory.health()).toMatchObject({
          status: "healthy",
          backend: "postgresql",
        });
      } finally {
        if (factory !== undefined) await closeProjectAndFactory(factory, projects);
        rmSync(homeDir, { recursive: true, force: true });
        rmSync(fixture.projectRoot, { recursive: true, force: true });
      }
    });
  });

  it("cancels active and pool-queued project work before factory shutdown completes", async () => {
    await withPostgreSqlTestDatabase("factory-close", async (database) => {
      await applyAllRuntimeGrants(database);
      const fixture = await createIdentityFixture(database, "factory-close");
      const homeDir = mkdtempSync(join(tmpdir(), "lcm-pg-factory-close-"));
      let releaseTransaction!: () => void;
      const held = new Promise<void>((resolve) => { releaseTransaction = resolve; });
      let factory: Awaited<ReturnType<
        typeof createPostgreSqlStorageBackendFactoryForTesting
      >> | undefined;
      let project: Awaited<ReturnType<
        Awaited<ReturnType<
          typeof createPostgreSqlStorageBackendFactoryForTesting
        >>["openProject"]
      >> | undefined;
      let transaction: Promise<void> | undefined;
      let queued: Promise<unknown> | undefined;
      try {
        await establishPublication(homeDir, fixture.machine, [
          { project: fixture.first, path: fixture.firstPath },
          { project: fixture.second, path: fixture.secondPath },
        ]);
        factory = await createPostgreSqlStorageBackendFactoryForTesting(
          factoryConfig(database, { poolMax: 1 }),
          homeDir,
        );
        project = await factory.openProject(identityContext(fixture));

        let markEntered!: () => void;
        const entered = new Promise<void>((resolve) => { markEntered = resolve; });
        transaction = project.transaction(async () => {
          markEntered();
          await held;
        });
        await entered;

        queued = project.conversations.listConversations();
        await Promise.resolve();
        const close = factory.close();

        await expect(queued).rejects.toMatchObject({
          backend: "postgresql",
          projectId: fixture.first.projectId,
        });
        releaseTransaction();
        await expect(transaction).rejects.toMatchObject({
          backend: "postgresql",
          projectId: fixture.first.projectId,
        });
        await expect(close).resolves.toBeUndefined();
        await expect(factory.health()).resolves.toEqual({
          status: "closed",
          backend: "postgresql",
        });
      } finally {
        releaseTransaction();
        await Promise.allSettled([
          ...(queued === undefined ? [] : [queued]),
          ...(transaction === undefined ? [] : [transaction]),
          ...(project === undefined ? [] : [project.close()]),
          ...(factory === undefined ? [] : [factory.close()]),
        ]);
        rmSync(homeDir, { recursive: true, force: true });
        rmSync(fixture.projectRoot, { recursive: true, force: true });
      }
    });
  });

  it.each([
    ["wrong migration owner", undefined, "lcm_harness_admin"],
    ["ledger drift", "ledger", "lcm_test_migrator"],
    ["schema definition drift", "schema", "lcm_test_migrator"],
    ["search-configuration drift", "search", "lcm_test_migrator"],
    ["overbroad ACL", "acl", "lcm_test_migrator"],
  ] as const)("fails construction for %s", async (_label, drift, migrationRole) => {
    await withPostgreSqlTestDatabase(`factory-${drift ?? "owner"}`, async (database) => {
      await applyAllRuntimeGrants(database);
      if (drift === "ledger") {
        await database.migrator.query({
          text: `INSERT INTO lcm.schema_migrations (id, checksum_sha256)
                 VALUES ('9999_untrusted', $1)`,
          values: ["f".repeat(64)],
        }, { domain: "factory", operation: "injectFactoryLedgerDrift" });
      } else if (drift === "schema") {
        await database.migrator.query({
          text: `ALTER TABLE lcm.projects
                 ALTER COLUMN identity_key DROP NOT NULL`,
        }, { domain: "factory", operation: "injectFactorySchemaDrift" });
      } else if (drift === "search") {
        await database.migrator.query({
          text: "ALTER TEXT SEARCH CONFIGURATION lcm.search_v1 DROP MAPPING FOR uint",
        }, { domain: "factory", operation: "injectFactorySearchDrift" });
      } else if (drift === "acl") {
        await database.migrator.query({
          text: "GRANT SELECT ON TABLE lcm.conversations TO PUBLIC",
        }, { domain: "factory", operation: "injectFactoryAclDrift" });
      }
      const homeDir = mkdtempSync(join(tmpdir(), "lcm-pg-factory-fail-"));
      try {
        await expect(createPostgreSqlStorageBackendFactoryForTesting(
          factoryConfig(database, { migrationRole }),
          homeDir,
        )).rejects.toMatchObject({
          code: "STORAGE_INITIALIZATION_FAILED",
          operation: "createFactory",
        });
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
  });

  it.each(REQUIRED_GRANT_SCRIPTS)(
    "fails construction when %s is absent",
    async (omittedScript) => {
      await withPostgreSqlTestDatabase("factory-grant", async (database) => {
        await applyAllRuntimeGrants(database, {
          omit: [omittedScript],
        });
        const homeDir = mkdtempSync(join(tmpdir(), "lcm-pg-factory-grant-"));
        try {
          await expect(createPostgreSqlStorageBackendFactoryForTesting(
            factoryConfig(database),
            homeDir,
          )).rejects.toMatchObject({
            code: "STORAGE_INITIALIZATION_FAILED",
            operation: "createFactory",
          });
        } finally {
          rmSync(homeDir, { recursive: true, force: true });
        }
      });
    },
  );

  it("fails construction when an extension is outside its required namespace", async () => {
    await withPostgreSqlTestDatabase("factory-extension", async (database) => {
      await applyAllRuntimeGrants(database);
      const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
      try {
        await administrator.query({
          text: `CREATE SCHEMA lcm_factory_extensions;
                 ALTER EXTENSION unaccent SET SCHEMA lcm_factory_extensions`,
        }, { domain: "factory", operation: "injectFactoryExtensionDrift" });
      } finally {
        await administrator.close();
      }
      const homeDir = mkdtempSync(join(tmpdir(), "lcm-pg-factory-extension-"));
      try {
        await expect(createPostgreSqlStorageBackendFactoryForTesting(
          factoryConfig(database),
          homeDir,
        )).rejects.toMatchObject({
          code: "STORAGE_INITIALIZATION_FAILED",
          operation: "createFactory",
        });
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
  });

  it("rejects database CREATE granted to the runtime role and accepts after revoke", async () => {
    await withPostgreSqlTestDatabase("factory-database-create", async (database) => {
      await applyAllRuntimeGrants(database);
      const homeDir = mkdtempSync(join(tmpdir(), "lcm-pg-factory-database-create-"));
      const administrator = new PostgreSqlRuntime(settings(database.adminUrl, { poolMax: 1 }));
      let canonicalFactory: Awaited<ReturnType<
        typeof createPostgreSqlStorageBackendFactoryForTesting
      >> | undefined;
      let grantedFactory: Awaited<ReturnType<
        typeof createPostgreSqlStorageBackendFactoryForTesting
      >> | undefined;
      let restoredFactory: Awaited<ReturnType<
        typeof createPostgreSqlStorageBackendFactoryForTesting
      >> | undefined;
      let factoryError: unknown;
      try {
        await expect(readRuntimeDatabaseCreatePrivilege(
          database,
          "readCanonicalRuntimeDatabaseCreatePrivilege",
        )).resolves.toBe(false);
        canonicalFactory = await createPostgreSqlStorageBackendFactoryForTesting(
          factoryConfig(database),
          homeDir,
        );
        await canonicalFactory.close();
        canonicalFactory = undefined;

        await administrator.query({
          text: `GRANT CREATE ON DATABASE "${database.name}" TO lcm_test_runtime`,
        }, { domain: "factory", operation: "grantRuntimeDatabaseCreate" });
        await expect(readRuntimeDatabaseCreatePrivilege(
          database,
          "readGrantedRuntimeDatabaseCreatePrivilege",
        )).resolves.toBe(true);

        grantedFactory = await createPostgreSqlStorageBackendFactoryForTesting(
          factoryConfig(database),
          homeDir,
        ).catch((error: unknown) => {
          factoryError = error;
          return undefined;
        });
        if (grantedFactory !== undefined) {
          await grantedFactory.close();
          grantedFactory = undefined;
        }
        expect(factoryError).toMatchObject({
          code: "STORAGE_INITIALIZATION_FAILED",
          backend: "postgresql",
          operation: "createFactory",
        });
        expect(JSON.stringify(factoryError)).not.toContain(database.name);

        await administrator.query({
          text: `REVOKE CREATE ON DATABASE "${database.name}" FROM lcm_test_runtime`,
        }, { domain: "factory", operation: "revokeRuntimeDatabaseCreate" });
        await expect(readRuntimeDatabaseCreatePrivilege(
          database,
          "readRestoredRuntimeDatabaseCreatePrivilege",
        )).resolves.toBe(false);
        restoredFactory = await createPostgreSqlStorageBackendFactoryForTesting(
          factoryConfig(database),
          homeDir,
        );
        await restoredFactory.close();
        restoredFactory = undefined;
      } finally {
        try {
          await Promise.allSettled([
            ...(canonicalFactory === undefined ? [] : [canonicalFactory.close()]),
            ...(grantedFactory === undefined ? [] : [grantedFactory.close()]),
            ...(restoredFactory === undefined ? [] : [restoredFactory.close()]),
          ]);
          await administrator.query({
            text: `REVOKE CREATE ON DATABASE "${database.name}" FROM lcm_test_runtime`,
          }, { domain: "factory", operation: "restoreRuntimeDatabaseCreatePrivilege" });
          await expect(readRuntimeDatabaseCreatePrivilege(
            database,
            "verifyRestoredRuntimeDatabaseCreatePrivilege",
          )).resolves.toBe(false);
        } finally {
          await administrator.close();
          rmSync(homeDir, { recursive: true, force: true });
        }
      }
    });
  });

  it("rejects runtime parameter SET privilege and recovers after revoke", async () => {
    await withPostgreSqlTestDatabase("factory-parameter-set", async (database) => {
      await applyAllRuntimeGrants(database);
      const homeDir = mkdtempSync(join(tmpdir(), "lcm-pg-factory-parameter-set-"));
      const administrator = new PostgreSqlRuntime(settings(database.adminUrl, { poolMax: 1 }));
      let grantedFactory: Awaited<ReturnType<
        typeof createPostgreSqlStorageBackendFactoryForTesting
      >> | undefined;
      let restoredFactory: Awaited<ReturnType<
        typeof createPostgreSqlStorageBackendFactoryForTesting
      >> | undefined;
      let factoryError: unknown;
      try {
        await expect(readRuntimeSessionReplicationRoleSetPrivilege(
          database,
          "readCanonicalRuntimeSessionReplicationRoleSetPrivilege",
        )).resolves.toBe(false);

        await administrator.query({
          text: "GRANT SET ON PARAMETER session_replication_role TO lcm_test_runtime",
        }, { domain: "factory", operation: "grantRuntimeSessionReplicationRoleSetPrivilege" });
        await expect(readRuntimeSessionReplicationRoleSetPrivilege(
          database,
          "readGrantedRuntimeSessionReplicationRoleSetPrivilege",
        )).resolves.toBe(true);
        await expect(setRuntimeSessionReplicationRoleToReplica(
          database,
          "probeGrantedRuntimeSessionReplicationRole",
        )).resolves.toBe("replica");

        grantedFactory = await createPostgreSqlStorageBackendFactoryForTesting(
          factoryConfig(database),
          homeDir,
        ).catch((error: unknown) => {
          factoryError = error;
          return undefined;
        });
        if (grantedFactory !== undefined) {
          await grantedFactory.close();
          grantedFactory = undefined;
        }
        expect(factoryError).toMatchObject({
          code: "STORAGE_INITIALIZATION_FAILED",
          backend: "postgresql",
          operation: "createFactory",
        });
        expect(JSON.stringify(factoryError)).not.toContain("session_replication_role");

        await administrator.query({
          text: "REVOKE SET ON PARAMETER session_replication_role FROM lcm_test_runtime",
        }, { domain: "factory", operation: "revokeRuntimeSessionReplicationRoleSetPrivilege" });
        await expect(readRuntimeSessionReplicationRoleSetPrivilege(
          database,
          "readRestoredRuntimeSessionReplicationRoleSetPrivilege",
        )).resolves.toBe(false);
        restoredFactory = await createPostgreSqlStorageBackendFactoryForTesting(
          factoryConfig(database),
          homeDir,
        );
        await restoredFactory.close();
        restoredFactory = undefined;
      } finally {
        try {
          await Promise.allSettled([
            ...(grantedFactory === undefined ? [] : [grantedFactory.close()]),
            ...(restoredFactory === undefined ? [] : [restoredFactory.close()]),
          ]);
          await administrator.query({
            text: "REVOKE SET ON PARAMETER session_replication_role FROM lcm_test_runtime",
          }, { domain: "factory", operation: "restoreRuntimeSessionReplicationRoleSetPrivilege" });
          await expect(readRuntimeSessionReplicationRoleSetPrivilege(
            database,
            "verifyRestoredRuntimeSessionReplicationRoleSetPrivilege",
          )).resolves.toBe(false);
        } finally {
          await administrator.close();
          rmSync(homeDir, { recursive: true, force: true });
        }
      }
    });
  });

  it("rejects replica-mode runtime sessions before factory writes and accepts origin", async () => {
    await withPostgreSqlTestDatabase("factory-replica", async (database) => {
      await applyAllRuntimeGrants(database);
      const homeDir = mkdtempSync(join(tmpdir(), "lcm-pg-factory-replica-"));
      const administrator = new PostgreSqlRuntime(settings(database.adminUrl, { poolMax: 1 }));
      let replicaFactory: Awaited<ReturnType<
        typeof createPostgreSqlStorageBackendFactoryForTesting
      >> | undefined;
      let originFactory: Awaited<ReturnType<
        typeof createPostgreSqlStorageBackendFactoryForTesting
      >> | undefined;
      let replicaError: unknown;
      let replicaSessionRole: unknown;
      let originSessionRole: unknown;
      let beforeConversationCount: unknown;
      let afterConversationCount: unknown;
      try {
        const before = await administrator.query({
          text: "SELECT pg_catalog.count(*)::pg_catalog.text AS count FROM lcm.conversations",
        }, { domain: "factory", operation: "readReplicaPreflightWriteCountBefore" });
        beforeConversationCount = before.rows[0]?.count;
        await administrator.query({
          text: `ALTER ROLE lcm_test_runtime IN DATABASE "${database.name}"
                 SET session_replication_role TO replica`,
        }, { domain: "factory", operation: "setReplicaRuntimeRoleDefault" });

        const replicaProbe = new PostgreSqlRuntime(settings(database.runtimeUrl, { poolMax: 1 }));
        try {
          const replicaState = await replicaProbe.query({
            text: `SELECT pg_catalog.current_setting('session_replication_role')
                            AS session_replication_role`,
          }, { domain: "factory", operation: "readReplicaRuntimeSessionState" });
          replicaSessionRole = replicaState.rows[0]?.session_replication_role;
        } finally {
          await replicaProbe.close();
        }

        replicaFactory = await createPostgreSqlStorageBackendFactoryForTesting(
          factoryConfig(database),
          homeDir,
        ).catch((error: unknown) => {
          replicaError = error;
          return undefined;
        });
        if (replicaFactory !== undefined) {
          await replicaFactory.close();
          replicaFactory = undefined;
        }

        await administrator.query({
          text: `ALTER ROLE lcm_test_runtime IN DATABASE "${database.name}"
                 RESET session_replication_role`,
        }, { domain: "factory", operation: "resetReplicaRuntimeRoleDefault" });

        const originProbe = new PostgreSqlRuntime(settings(database.runtimeUrl, { poolMax: 1 }));
        try {
          const originState = await originProbe.query({
            text: `SELECT pg_catalog.current_setting('session_replication_role')
                            AS session_replication_role`,
          }, { domain: "factory", operation: "readOriginRuntimeSessionState" });
          originSessionRole = originState.rows[0]?.session_replication_role;
        } finally {
          await originProbe.close();
        }
        originFactory = await createPostgreSqlStorageBackendFactoryForTesting(
          factoryConfig(database),
          homeDir,
        );
        const after = await administrator.query({
          text: "SELECT pg_catalog.count(*)::pg_catalog.text AS count FROM lcm.conversations",
        }, { domain: "factory", operation: "readReplicaPreflightWriteCountAfter" });
        afterConversationCount = after.rows[0]?.count;
      } finally {
        await Promise.allSettled([
          replicaFactory?.close(),
          originFactory?.close(),
        ].filter((operation): operation is Promise<void> => operation !== undefined));
        try {
          await administrator.query({
            text: `ALTER ROLE lcm_test_runtime IN DATABASE "${database.name}"
                   RESET session_replication_role`,
          }, { domain: "factory", operation: "restoreRuntimeRoleDefault" });
        } finally {
          await administrator.close();
          rmSync(homeDir, { recursive: true, force: true });
        }
      }

      expect(replicaSessionRole).toBe("replica");
      expect(replicaError).toMatchObject({
        code: "STORAGE_INITIALIZATION_FAILED",
        backend: "postgresql",
        operation: "createFactory",
      });
      expect(JSON.stringify(replicaError)).not.toContain("replica");
      expect(originSessionRole).toBe("origin");
      expect(originFactory).toBeDefined();
      expect(afterConversationCount).toBe(beforeConversationCount);
    });
  });

  it.each([
    {
      label: "pgcrypto digest",
      extensionName: "pgcrypto",
      functionIdentity: "public.digest(text, text)",
      replacement: `CREATE OR REPLACE FUNCTION public.digest(text, text)
                    RETURNS pg_catalog.bytea
                    LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
                    AS $$
                      SELECT CASE
                        WHEN $1 OPERATOR(pg_catalog.=) 'factory-corrupt-digest'
                          THEN pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex')
                        ELSE public.digest(pg_catalog.convert_to($1, 'UTF8'), $2)
                      END
                    $$`,
    },
    {
      label: "pg_trgm similarity",
      extensionName: "pg_trgm",
      functionIdentity: "public.similarity(text, text)",
      replacement: `CREATE OR REPLACE FUNCTION public.similarity(text, text)
                    RETURNS pg_catalog.float4
                    LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
                    AS $$ SELECT 1::pg_catalog.float4 $$`,
    },
  ] as const)(
    "rejects a replaced $label implementation despite restored extension membership",
    async ({ extensionName, functionIdentity, replacement }) => {
      await withPostgreSqlTestDatabase("factory-extension-function", async (database) => {
        await applyAllRuntimeGrants(database);
        const homeDir = mkdtempSync(join(tmpdir(), "lcm-pg-factory-extension-function-"));
        const administrator = new PostgreSqlRuntime(settings(database.adminUrl, { poolMax: 1 }));
        const authoritative = await inspectExtensionFunctionState(
          administrator,
          functionIdentity,
          "captureAuthoritativeExtensionFunction",
        );
        let factory: Awaited<ReturnType<
          typeof createPostgreSqlStorageBackendFactoryForTesting
        >> | undefined;
        let factoryError: unknown;
        let tampered: ExtensionFunctionState | undefined;
        let restored: ExtensionFunctionState | undefined;
        try {
          expect(authoritative).toMatchObject({
            extensionName,
            languageName: "c",
          });
          await administrator.query({
            text: `ALTER EXTENSION ${extensionName} DROP FUNCTION ${functionIdentity}`,
          }, { domain: "factory", operation: "detachExtensionFunctionForReplacement" });
          await administrator.query({ text: replacement }, {
            domain: "factory",
            operation: "replaceExtensionFunctionImplementation",
          });
          await administrator.query({
            text: `ALTER EXTENSION ${extensionName} ADD FUNCTION ${functionIdentity}`,
          }, { domain: "factory", operation: "reattachReplacedExtensionFunction" });
          tampered = await inspectExtensionFunctionState(
            administrator,
            functionIdentity,
            "inspectReplacedExtensionFunction",
          );

          factory = await createPostgreSqlStorageBackendFactoryForTesting(
            factoryConfig(database),
            homeDir,
          ).catch((error: unknown) => {
            factoryError = error;
            return undefined;
          });

          expect(tampered).toMatchObject({
            extensionName,
            languageName: "sql",
          });
          expect(factoryError).toMatchObject({
            code: "STORAGE_INITIALIZATION_FAILED",
            backend: "postgresql",
            operation: "createFactory",
          });
          expect(JSON.stringify(factoryError)).not.toContain(functionIdentity);

          await factory?.close();
          factory = undefined;
          await restoreExtensionFunctionState(
            administrator,
            extensionName,
            functionIdentity,
            authoritative,
          );
          restored = await inspectExtensionFunctionState(
            administrator,
            functionIdentity,
            "inspectRestoredExtensionFunction",
          );
        } finally {
          try {
            await factory?.close().catch(() => undefined);
            if (restored === undefined) {
              await restoreExtensionFunctionState(
                administrator,
                extensionName,
                functionIdentity,
                authoritative,
              );
            }
          } finally {
            await administrator.close();
            rmSync(homeDir, { recursive: true, force: true });
          }
        }

        expect(restored).toEqual(authoritative);
      });
    },
  );

  it("rejects a replaced pg_trgm percent operator while preserving the canonical implementation", async () => {
    await withPostgreSqlTestDatabase("factory-extension-operator", async (database) => {
      await applyAllRuntimeGrants(database);
      const homeDir = mkdtempSync(join(tmpdir(), "lcm-pg-factory-extension-operator-"));
      const administrator = new PostgreSqlRuntime(settings(database.adminUrl, { poolMax: 1 }));
      const authoritativeFunction = await inspectExtensionFunctionState(
        administrator,
        "public.similarity_op(text, text)",
        "captureAuthoritativeSimilarityOperatorFunction",
      );
      const authoritativeOperator = await inspectExtensionOperatorState(
        administrator,
        "captureAuthoritativeSimilarityOperator",
      );
      let baselineFactory: Awaited<ReturnType<
        typeof createPostgreSqlStorageBackendFactoryForTesting
      >> | undefined;
      let tamperedFactory: Awaited<ReturnType<
        typeof createPostgreSqlStorageBackendFactoryForTesting
      >> | undefined;
      let factoryError: unknown;
      let mutationStarted = false;
      let restoredOperator: ExtensionOperatorState | null | undefined;
      let restoredFunction: ExtensionFunctionState | undefined;
      try {
        expect(authoritativeFunction).toMatchObject({
          extensionName: "pg_trgm",
          languageName: "c",
        });
        expect(authoritativeOperator?.definition).toMatchObject({
          schemaName: "public",
          operatorName: "%",
          operatorKind: "b",
          leftType: "text",
          rightType: "text",
          resultType: "boolean",
          ownerName: "lcm_harness_admin",
          extensionName: "pg_trgm",
          extensionOwnerName: "lcm_harness_admin",
          implementationOid: authoritativeFunction.oid,
          implementationIdentity: "public.similarity_op(text, text)",
          commutatorMatchesSelf: true,
          negatorAbsent: true,
          canMerge: false,
          canHash: false,
          dependencyCount: 3,
          extensionDependencyCount: 1,
          implementationDependencyCount: 1,
          namespaceDependencyCount: 1,
        });
        if (authoritativeOperator === null) {
          throw new Error("missing authoritative extension operator fixture state");
        }

        baselineFactory = await createPostgreSqlStorageBackendFactoryForTesting(
          factoryConfig(database),
          homeDir,
        );
        await baselineFactory.close();
        baselineFactory = undefined;

        mutationStarted = true;
        await administrator.query({
          text: `ALTER EXTENSION pg_trgm DROP OPERATOR ${REQUIRED_SIMILARITY_OPERATOR}`,
        }, { domain: "factory", operation: "detachSimilarityOperatorForReplacement" });
        await administrator.query({
          text: `DROP OPERATOR ${REQUIRED_SIMILARITY_OPERATOR}`,
        }, { domain: "factory", operation: "dropAuthoritativeSimilarityOperator" });
        await administrator.query({
          text: `CREATE FUNCTION ${FOREIGN_SIMILARITY_OPERATOR_FUNCTION}
                 RETURNS pg_catalog.bool
                 LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
                 AS $$ SELECT true $$`,
        }, { domain: "factory", operation: "createForeignSimilarityOperatorFunction" });
        await administrator.query({
          text: `CREATE OPERATOR public.% (
                   LEFTARG = pg_catalog.text,
                   RIGHTARG = pg_catalog.text,
                   FUNCTION = public.lcm_test_foreign_similarity_operator,
                   COMMUTATOR = OPERATOR(public.%),
                   RESTRICT = pg_catalog.matchingsel,
                   JOIN = pg_catalog.matchingjoinsel
                 )`,
        }, { domain: "factory", operation: "createReplacedSimilarityOperator" });
        await administrator.query({
          text: `ALTER EXTENSION pg_trgm ADD OPERATOR ${REQUIRED_SIMILARITY_OPERATOR}`,
        }, { domain: "factory", operation: "reattachReplacedSimilarityOperator" });

        const tamperedOperator = await inspectExtensionOperatorState(
          administrator,
          "inspectReplacedSimilarityOperator",
        );
        const unchangedFunction = await inspectExtensionFunctionState(
          administrator,
          "public.similarity_op(text, text)",
          "inspectUnchangedSimilarityOperatorFunction",
        );
        expect(tamperedOperator).not.toBeNull();
        const {
          implementationOid: authoritativeImplementationOid,
          implementationIdentity: authoritativeImplementationIdentity,
          ...authoritativeMetadata
        } = authoritativeOperator.definition;
        const {
          implementationOid: tamperedImplementationOid,
          implementationIdentity: tamperedImplementationIdentity,
          ...tamperedMetadata
        } = tamperedOperator!.definition;
        expect(authoritativeImplementationIdentity).toBe("public.similarity_op(text, text)");
        expect(tamperedImplementationIdentity).toBe(
          "public.lcm_test_foreign_similarity_operator(text, text)",
        );
        expect(tamperedImplementationOid).not.toBe(authoritativeImplementationOid);
        expect(tamperedMetadata).toEqual(authoritativeMetadata);
        expect(unchangedFunction).toEqual(authoritativeFunction);

        tamperedFactory = await createPostgreSqlStorageBackendFactoryForTesting(
          factoryConfig(database),
          homeDir,
        ).catch((error: unknown) => {
          factoryError = error;
          return undefined;
        });

        expect(factoryError).toMatchObject({
          code: "STORAGE_INITIALIZATION_FAILED",
          backend: "postgresql",
          operation: "createFactory",
        });
        expect(JSON.stringify(factoryError)).not.toContain(
          "lcm_test_foreign_similarity_operator",
        );

        await tamperedFactory?.close();
        tamperedFactory = undefined;
        await restoreExtensionOperatorState(administrator, authoritativeOperator);
        restoredOperator = await inspectExtensionOperatorState(
          administrator,
          "inspectRestoredSimilarityOperator",
        );
        restoredFunction = await inspectExtensionFunctionState(
          administrator,
          "public.similarity_op(text, text)",
          "inspectRestoredSimilarityOperatorFunction",
        );
      } finally {
        try {
          await baselineFactory?.close().catch(() => undefined);
          await tamperedFactory?.close().catch(() => undefined);
          if (mutationStarted && restoredOperator === undefined && authoritativeOperator !== null) {
            await restoreExtensionOperatorState(administrator, authoritativeOperator);
            restoredOperator = await inspectExtensionOperatorState(
              administrator,
              "inspectFinallyRestoredSimilarityOperator",
            );
            restoredFunction = await inspectExtensionFunctionState(
              administrator,
              "public.similarity_op(text, text)",
              "inspectFinallyRestoredSimilarityOperatorFunction",
            );
          }
        } finally {
          await administrator.close();
          rmSync(homeDir, { recursive: true, force: true });
        }
      }

      expect(restoredOperator?.definition).toEqual(authoritativeOperator.definition);
      expect(restoredFunction).toEqual(authoritativeFunction);
    });
  });

  it("rejects a replaced gin_trgm_ops graph despite authoritative managed index fingerprints", async () => {
    await withPostgreSqlTestDatabase("factory-gin-trgm-opclass", async (database) => {
      await applyAllRuntimeGrants(database);
      const homeDir = mkdtempSync(join(tmpdir(), "lcm-pg-factory-gin-trgm-opclass-"));
      const administrator = new PostgreSqlRuntime(settings(database.adminUrl, { poolMax: 1 }));
      const authoritativeIndexes = await inspectGinTrgmIndexes(
        administrator,
        "captureAuthoritativeGinTrgmIndexes",
      );
      const authoritativeGraph = await inspectGinTrgmGraph(
        administrator,
        "captureAuthoritativeGinTrgmGraph",
      );
      let baselineFactory: Awaited<ReturnType<
        typeof createPostgreSqlStorageBackendFactoryForTesting
      >> | undefined;
      let tamperedFactory: Awaited<ReturnType<
        typeof createPostgreSqlStorageBackendFactoryForTesting
      >> | undefined;
      let restoredFactory: Awaited<ReturnType<
        typeof createPostgreSqlStorageBackendFactoryForTesting
      >> | undefined;
      let factoryError: unknown;
      let mutationStarted = false;
      let restored = false;
      try {
        expect(authoritativeIndexes).toHaveLength(REQUIRED_GIN_TRGM_INDEX_NAMES.length);
        expect(authoritativeIndexes.every(({ valid, ready, live }) => valid && ready && live))
          .toBe(true);
        expect(authoritativeGraph).toEqual({
          operatorClassExtension: "pg_trgm",
          operatorFamilyExtension: "pg_trgm",
          comparatorIdentity: "pg_catalog.btint4cmp(integer, integer)",
          operatorCount: 8,
          supportFunctionCount: 5,
        });

        baselineFactory = await createPostgreSqlStorageBackendFactoryForTesting(
          factoryConfig(database),
          homeDir,
        );
        await baselineFactory.close();
        baselineFactory = undefined;

        mutationStarted = true;
        await replaceGinTrgmOperatorClass(administrator, authoritativeIndexes);
        const tamperedIndexes = await inspectGinTrgmIndexes(
          administrator,
          "inspectReplacedGinTrgmIndexes",
        );
        const tamperedGraph = await inspectGinTrgmGraph(
          administrator,
          "inspectReplacedGinTrgmGraph",
        );
        expect(tamperedIndexes).toEqual(authoritativeIndexes);
        expect(ginTrgmIndexFingerprint(tamperedIndexes)).toBe(
          ginTrgmIndexFingerprint(authoritativeIndexes),
        );
        expect(tamperedGraph).toEqual({
          ...authoritativeGraph,
          comparatorIdentity: "public.lcm_test_foreign_btint4cmp(integer, integer)",
        });

        tamperedFactory = await createPostgreSqlStorageBackendFactoryForTesting(
          factoryConfig(database),
          homeDir,
        ).catch((error: unknown) => {
          factoryError = error;
          return undefined;
        });

        expect(factoryError).toMatchObject({
          code: "STORAGE_INITIALIZATION_FAILED",
          backend: "postgresql",
          operation: "createFactory",
        });
        expect(JSON.stringify(factoryError)).not.toContain("lcm_test_foreign_btint4cmp");

        await tamperedFactory?.close();
        tamperedFactory = undefined;
        await restorePackagedGinTrgmObjects(database, administrator, authoritativeIndexes);
        restored = true;
        const restoredIndexes = await inspectGinTrgmIndexes(
          administrator,
          "inspectRestoredGinTrgmIndexes",
        );
        const restoredGraph = await inspectGinTrgmGraph(
          administrator,
          "inspectRestoredGinTrgmGraph",
        );
        expect(restoredIndexes).toEqual(authoritativeIndexes);
        expect(restoredGraph).toEqual(authoritativeGraph);

        restoredFactory = await createPostgreSqlStorageBackendFactoryForTesting(
          factoryConfig(database),
          homeDir,
        );
      } finally {
        try {
          await baselineFactory?.close().catch(() => undefined);
          await tamperedFactory?.close().catch(() => undefined);
          await restoredFactory?.close().catch(() => undefined);
          if (mutationStarted && !restored) {
            await restorePackagedGinTrgmObjects(database, administrator, authoritativeIndexes);
            const finallyRestoredIndexes = await inspectGinTrgmIndexes(
              administrator,
              "inspectFinallyRestoredGinTrgmIndexes",
            );
            const finallyRestoredGraph = await inspectGinTrgmGraph(
              administrator,
              "inspectFinallyRestoredGinTrgmGraph",
            );
            expect(finallyRestoredIndexes).toEqual(authoritativeIndexes);
            expect(finallyRestoredGraph).toEqual(authoritativeGraph);
          }
        } finally {
          await administrator.close();
          rmSync(homeDir, { recursive: true, force: true });
        }
      }
    });
  });

  it("fails construction for wrong CA and wrong host without leaking connection data", async () => {
    await withPostgreSqlTestDatabase("factory-tls", async (database) => {
      const wrongHostUrl = new URL(database.runtimeUrl);
      wrongHostUrl.hostname = process.env.LCM_TEST_POSTGRES_WRONG_HOST!;
      const homeDir = mkdtempSync(join(tmpdir(), "lcm-pg-factory-tls-"));
      try {
        for (const config of [
          factoryConfig(database, {
            caFile: process.env.LCM_TEST_POSTGRES_WRONG_CA_FILE!,
          }),
          factoryConfig(database, { url: wrongHostUrl.toString() }),
        ]) {
          const error = await createPostgreSqlStorageBackendFactoryForTesting(
            config,
            homeDir,
          ).catch((caught: unknown) => caught);
          expect(error).toMatchObject({
            code: "STORAGE_INITIALIZATION_FAILED",
            operation: "createFactory",
          });
          expect(JSON.stringify(error)).not.toContain(new URL(database.runtimeUrl).password);
          expect(JSON.stringify(error)).not.toContain(config.postgresql.caFile);
        }
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
  });

  it("fails opens for unresolved publication and absent or mismatched identity", async () => {
    await withPostgreSqlTestDatabase("factory-admit", async (database) => {
      await applyAllRuntimeGrants(database);
      const fixture = await createIdentityFixture(database, "factory-admit");
      const homeDir = mkdtempSync(join(tmpdir(), "lcm-pg-factory-admit-"));
      const factory = await createPostgreSqlStorageBackendFactoryForTesting(
        factoryConfig(database),
        homeDir,
      );
      try {
        await expect(factory.openProject(identityContext(fixture))).rejects.toMatchObject({
          code: "STORAGE_INITIALIZATION_FAILED",
          operation: "openProject",
        });
        await establishPublication(homeDir, fixture.machine, [
          { project: fixture.first, path: fixture.firstPath },
          { project: fixture.second, path: fixture.secondPath },
        ]);
        await expect(factory.openProject(identityContext(fixture, "first", {
          selectedPath: fixture.secondPath,
        }))).rejects.toMatchObject({
          code: "STORAGE_INITIALIZATION_FAILED",
          operation: "openProject",
        });
        const identities = new PostgreSqlIdentityRepository(database.migrator);
        await identities.unlinkProject(
          fixture.machine.machineId,
          fixture.second.projectId,
        );
        await expect(identities.deleteProjectIfUnreferenced(fixture.second.projectId))
          .resolves.toBe(true);
        await expect(factory.openProject(identityContext(fixture, "second")))
          .rejects.toMatchObject({
            code: "STORAGE_INITIALIZATION_FAILED",
            operation: "openProject",
          });
      } finally {
        await factory.close();
        rmSync(homeDir, { recursive: true, force: true });
        rmSync(fixture.projectRoot, { recursive: true, force: true });
      }
    });
  });
});
