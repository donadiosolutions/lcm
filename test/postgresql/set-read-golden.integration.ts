import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase, type PostgreSqlTestDatabase } from "./harness.js";
import { grantPortablePostgreSql, seedPortablePostgreSql } from "./portable-fixture.js";
import { readIdentityFingerprintOracle } from "./identity-fingerprint-oracle.js";
import {
  dropActivationRole, grantRuntimeActivationRole, provisionActivationRole, RUNTIME_ROLE, TRANSFER_ROLE,
} from "./migration-activation-fixture.js";
import type { StorageIdentityContext } from "../../src/storage/contracts.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { probePostgreSqlPortableDestination } from "../../src/storage/postgresql/portable-destination.js";
import { createPostgreSqlPortableSource } from "../../src/storage/postgresql/portable-source.js";
import { createPortableRecordStream } from "../../src/storage/portable-record-stream.js";
import { canonicalJson, sha256 } from "../../src/storage/portable-record.js";
import {
  PostgreSqlRuntimeReadinessError, verifyPostgreSqlRuntimeSchema, verifyPostgreSqlTransferSchema,
  type PostgreSqlRuntimeReadiness,
} from "../../src/storage/postgresql/runtime-readiness.js";
import {
  captureDestinationSchemaWitness, readFencedDestinationCensus, readSequenceSelfConsistencyMismatches,
} from "../../src/migration/verify-generation.js";

beforeAll(assertHarnessReady);

/**
 * Golden capture for #1869 slice 2. Every literal below was produced by the
 * code at 7790f1f3, before the statement fusion, and the fused code must keep
 * reproducing it. A legitimate schema or fixture change that moves one of
 * these values must update it here in the same change.
 */
const READY_MIGRATION_IDS = [
  "0001_migration_ledger", "0002_schema_baseline", "0003_machine_identity_key", "0004_machine_display_name",
  "0005_summary_context_integrity", "0006_transfer_ledger", "0007_promoted_content_digest",
  "0008_transfer_identity_content_digest", "0009_conversation_parent_session",
];
const ready = (runtimeRole: string) => ({
  readiness: {
    currentMigrationIds: READY_MIGRATION_IDS, expectedOwner: "lcm_test_migrator", runtimeRole,
    managedObjectCount: 40, definitionObjectCount: 888, privilegeManifestVersion: 1,
  },
});
const refused = (reason: string, operation: string) => ({ reason, operation });
const bothRefused = (reason: string, operation: string) => ({ runtime: refused(reason, operation), transfer: refused(reason, operation) });
const sequenceMismatch = (domain: string, identitySha256: string) => ({ domain, class: "sequence", identitySha256 });
const CONVERSATIONS_SEQUENCE_VIOLATION = sequenceMismatch("conversations", "452e7d5a4698a6eb4ad2ed2223235300c5cff507393dba9cf719abecc4363b8e");

const GOLDEN = {
  "G-ID": {
    singleton: "7f2d94a6771ccd46ea52d0eca10a96315b2475152364ddbc9793148c6b0c1cc0",
    collation: "dc70a7e8cb0ce24365284360565be7b5ee6e68664ac9072f7945a15f4f8bacd3",
    excluded: "b204285048294bcf0cd393f400a9c83c2078f730008171ac658cc66c0d059a74",
    "multi-page": "8dcc5f4888d8e7b13d1eb5acf8a6d9c14c39253987cfc4e522741a380a97113b",
    "long-path": "943929a7ec461e16d79a2bc8ffd80eb1b943ea01e3d543fb5ddcb539e5fd6482",
  },
  "G-CENSUS-fixture": {
    censusSha256: "65574be4b8e8fdb76b522c5f90efeaf6b410749ab7afb0c8bc9adf782fb3d052",
    dependencyEdgesSha256: "378460870931ecb1cc6ba2a613c510b873ea2c5882f7b8c8d52c9dc5e912b0ef",
    recordIdentitiesSha256: "544d13070175d221da6ba8c86838b6fe6e16b4905e7211fab2aaafdfb819ded5",
    recordSha256sSha256: "e180bcc238276773272d957d0d777652e0a79c2795d7dfb7317d4295c2f65510",
    streamContentSha256: "fa3617c29b88e7f176fa0f0c4d88f0aa30db594d3ef8b3baf7717ecb703f6754",
  },
  "G-CENSUS-bulk": {
    censusSha256: "64af847024eeaee23f6e9287fc69fed27b88faa93ee79f0f1d76f1066cd84729",
    dependencyEdgesSha256: "fcf79f386fe2b85ef300bb47907148e8147e1063edca929f3e8d8a4141d8877f",
    recordIdentitiesSha256: "956bb9a57d713e23967dd6a42ad7f5083e61416c224e9ffb4e453035185e7b92",
    recordSha256sSha256: "8a8f5ca8a1a3bf823ecf72b421de19d417cb01b1376ba8657568f6601c6b6c03",
    streamContentSha256: "4144c36bbffe66562b43c57cb87a6c147a902443175cf4651cc2cc6748b4afd9",
  },
  "G-SCHEMA": {
    version: 1,
    migrationsSha256: "40fb42c96263ac581971b6c1bbcb87ee7b8e721041d3f99a4bf0856c799802fa",
    searchConfigurationSha256: "2ffff1a443e48f12879e1fd2b6e47a05ba93d5cd0ae828171ffe84146f5e5dfc",
    collationSha256: "4ddc6c7192ccd875959aa97819534064cc524b18853a27f62f98b079e2dedb08",
    sequenceStateSha256: "2d8504e9f06cfc3c755732074ad3b1b2e62a3c53fa5183ade4e1d1514ea18230",
  },
  "G-READY-healthy": {
    runtime: ready("lcm_test_runtime"),
    transfer: ready("lcm_test_runtime"),
    runtimeWithPeer: ready("<runtime-role>"),
    transferWithPeer: ready("<transfer-role>"),
    runtimeWithoutPeer: refused("schema-fingerprint", "inspectSchemaDefinitions"),
    runtimeWithMissingPeer: refused("runtime-role-policy", "inspectAdmittedPeerRolePolicy"),
  },
  "G-READY-failures": {
    wrongExpectedOwnerAndMissingGrant: refused("runtime-role-policy", "inspectRuntimeRolePolicy"),
    objectOwnerAndMissingGrant: bothRefused("schema-ownership", "inspectSchemaOwnership"),
    peerMembershipAndMissingExtension: {
      withPeer: refused("runtime-role-policy", "inspectAdmittedPeerRolePolicy"),
      withoutPeer: refused("extension-preflight", "runtimeReadinessExtensions"),
    },
    missingDigestOverload: bothRefused("extension-preflight", "inspectRequiredExtensionFunctions"),
    missingDigestOverloadAndCollation: bothRefused("content-collation-preflight", "runtimeReadinessContentCollation"),
    missingLedger: bothRefused("server-preflight", "verifyRuntimeReadiness"),
    unreadableLedger: bothRefused("server-preflight", "verifyRuntimeReadiness"),
    wrongLedgerRows: bothRefused("migration-ledger", "readMigrations"),
  },
  "G-SEQ": {
    empty: [],
    emptyWithDegradedSequences: [],
    neverCalledCollision: [CONVERSATIONS_SEQUENCE_VIOLATION],
    healthy: [],
    oneOfFiveRevoked: [sequenceMismatch("session-instructions", "6a00924cb93e9f7d37e1807509db1210ecd43bea2fb051add2e17b4bc4513c86")],
    setvalBelowMax: [CONVERSATIONS_SEQUENCE_VIOLATION],
    mixed: [
      CONVERSATIONS_SEQUENCE_VIOLATION,
      sequenceMismatch("messages", "a9e8f46da2cc20d2dbeb85021fd8b17f85ca67ee425f807242ca2b0ca51fc8c0"),
      sequenceMismatch("recall-surfacings", "1a20f355deffda559f3c3c66688afc861d0e5a9dad877d15ec8dd3c39c307b76"),
    ],
  },
};

function golden(name: keyof typeof GOLDEN, actual: unknown): void {
  expect(actual).toEqual(GOLDEN[name]);
}

const EXPECTED_OWNER = "lcm_test_migrator";
const AT = "2026-01-02T03:04:05.123456Z";
const context = { domain: "factory", operation: "seedSetReadGolden" } as const;

function uuid7(index: number): string {
  return "01990000-0000-7000-8000-" + (0x186900000000 + index).toString(16);
}
function digestOf(value: unknown): string {
  return sha256(canonicalJson(value));
}

type AliasSpec = Readonly<{ normalizedPath: string; path?: string }>;
type MachineSpec = Readonly<{ machineId: string; label: string; aliases: readonly AliasSpec[] }>;
type ProjectSpec = Readonly<{ label: string; projectId: string; machines: readonly MachineSpec[]; selected: { machineId: string; path: string } }>;

async function seedIdentityProject(executor: PostgreSqlRuntime, spec: ProjectSpec): Promise<StorageIdentityContext> {
  const query = (text: string, values: unknown[]) => executor.query({ text, values }, context);
  await query("INSERT INTO lcm.projects (project_id, identity_key, display_name, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
    [spec.projectId, sha256("golden-project:" + spec.label), "Golden " + spec.label, AT]);
  const machineIds: string[] = [];
  const normalizedPaths: string[] = [];
  const paths: string[] = [];
  for (const machine of spec.machines) {
    await query("INSERT INTO lcm.machines (machine_id, identity_key, display_name, registered_at, last_seen_at) VALUES ($1, $2, NULL, $3, $3) ON CONFLICT (machine_id) DO NOTHING",
      [machine.machineId, "machine:" + sha256("golden-machine:" + machine.label), AT]);
    for (const alias of machine.aliases) {
      machineIds.push(machine.machineId);
      normalizedPaths.push(alias.normalizedPath);
      paths.push(alias.path ?? alias.normalizedPath);
    }
  }
  await query("INSERT INTO lcm.project_aliases (project_id, machine_id, path, normalized_path, linked_at) SELECT $1, alias.machine_id, alias.path, alias.normalized_path, $5 FROM unnest($2::uuid[], $3::text[], $4::text[]) AS alias(machine_id, path, normalized_path)",
    [spec.projectId, machineIds, paths, normalizedPaths, AT]);
  return {
    id: spec.projectId, remoteProjectId: spec.projectId, machineId: spec.selected.machineId,
    localProjectId: sha256("golden-local:" + spec.label), canonical: spec.selected.path, selectedPath: spec.selected.path,
  };
}

async function probeFingerprint(db: PostgreSqlTestDatabase, identity: StorageIdentityContext): Promise<string> {
  const probe = await probePostgreSqlPortableDestination({
    settings: settings(db.runtimeUrl), expectedOwner: EXPECTED_OWNER, expectedIdentity: identity,
  });
  return probe.identityFingerprintSha256;
}

const TRICKY_PATHS: readonly AliasSpec[] = [
  { normalizedPath: "/golden/Case", path: "/golden/Case/" },
  { normalizedPath: "/golden/case" },
  { normalizedPath: "/golden/under_score" },
  { normalizedPath: "/golden/under-score", path: "/golden/under-score/" },
  { normalizedPath: "/golden/caf\u00e9" },
  { normalizedPath: "/golden/cafe\u0301" },
  { normalizedPath: "/golden/quote'single" },
  { normalizedPath: "/golden/quote\"double" },
  { normalizedPath: "/golden/back\\slash" },
  { normalizedPath: "/golden/emoji-\u{1F600}" },
];

function goldenIdentityProjects(): readonly ProjectSpec[] {
  const machine = (index: number, label: string, aliases: readonly AliasSpec[]): MachineSpec => ({ machineId: uuid7(index), label, aliases });
  return [
    {
      label: "singleton", projectId: uuid7(0x100),
      machines: [machine(0x101, "singleton", [{ normalizedPath: "/lcm-golden-1869/a" }])],
      selected: { machineId: uuid7(0x101), path: "/lcm-golden-1869/a" },
    },
    {
      label: "collation", projectId: uuid7(0x200),
      machines: [
        machine(0x201, "collation-1", [{ normalizedPath: "/lcm-golden-1869/b" }, ...TRICKY_PATHS.slice(0, 3)]),
        machine(0x202, "collation-2", [...TRICKY_PATHS.slice(3, 6), { normalizedPath: "/golden/Case" }]),
        machine(0x203, "collation-3", TRICKY_PATHS.slice(6, 10)),
      ],
      selected: { machineId: uuid7(0x201), path: "/lcm-golden-1869/b" },
    },
    {
      label: "excluded-other", projectId: uuid7(0x3ff),
      machines: [machine(0x303, "excluded-linked-elsewhere", [{ normalizedPath: "/lcm-golden-1869/c-other" }])],
      selected: { machineId: uuid7(0x303), path: "/lcm-golden-1869/c-other" },
    },
    {
      label: "excluded", projectId: uuid7(0x300),
      machines: [
        machine(0x301, "excluded-expected", [{ normalizedPath: "/lcm-golden-1869/c" }, { normalizedPath: "/lcm-golden-1869/c/second" }]),
        machine(0x302, "excluded-without-alias", []),
      ],
      selected: { machineId: uuid7(0x301), path: "/lcm-golden-1869/c" },
    },
    {
      label: "multi-page", projectId: uuid7(0x400),
      machines: [0x401, 0x402, 0x403].map((index, position) => machine(index, "multi-page-" + position, [
        ...(position === 0 ? [{ normalizedPath: "/lcm-golden-1869/d" }] : []),
        ...Array.from({ length: 400 }, (_unused, alias) => ({ normalizedPath: "/lcm-golden-1869/d/" + position + "/" + String(alias).padStart(4, "0") })),
      ])),
      selected: { machineId: uuid7(0x401), path: "/lcm-golden-1869/d" },
    },
    {
      label: "long-path", projectId: uuid7(0x500),
      machines: [machine(0x501, "long-path", [
        { normalizedPath: "/lcm-golden-1869/e" },
        { normalizedPath: "/lcm-golden-1869/e/" + "x".repeat(2048), path: "/lcm-golden-1869/e/" + "x".repeat(2048) + "/" },
      ])],
      selected: { machineId: uuid7(0x501), path: "/lcm-golden-1869/e" },
    },
  ];
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fifty identity states from a fixed seed over a shared machine pool. */
function randomIdentityProjects(): readonly ProjectSpec[] {
  const random = mulberry32(1869);
  const pick = (count: number) => Math.floor(random() * count);
  const pool = Array.from({ length: 8 }, (_unused, index) => uuid7(0x2000 + index));
  return Array.from({ length: 50 }, (_unused, state): ProjectSpec => {
    const expected = pool[pick(pool.length)]!;
    const selectedPath = "/lcm-golden-1869/s" + state + "/selected";
    const aliasesFor = (count: number, machineIndex: number): AliasSpec[] => Array.from({ length: count }, (_alias, alias) => {
      const tricky = TRICKY_PATHS[pick(TRICKY_PATHS.length)]!;
      const normalizedPath = "/lcm-golden-1869/s" + state + "/m" + machineIndex + "/" + alias + tricky.normalizedPath;
      return random() < 0.3 ? { normalizedPath, path: normalizedPath + "/" } : { normalizedPath };
    });
    const machines: MachineSpec[] = [];
    pool.forEach((machineId, machineIndex) => {
      if (machineId === expected) {
        machines.push({ machineId, label: "pool-" + machineIndex, aliases: [{ normalizedPath: selectedPath }, ...aliasesFor(pick(4), machineIndex)] });
      } else if (random() < 0.3) {
        machines.push({ machineId, label: "pool-" + machineIndex, aliases: aliasesFor(1 + pick(4), machineIndex) });
      }
    });
    return { label: "random-" + state, projectId: uuid7(0x1000 + state), machines, selected: { machineId: expected, path: selectedPath } };
  });
}

async function seedBulkCensus(db: PostgreSqlTestDatabase, projectId: string): Promise<void> {
  // More than one 500-record page in conversations, messages and
  // message-parts, plus one conversation whose message closure spans pages.
  await db.migrator.query({
    text: "WITH bulk AS (INSERT INTO lcm.conversations (project_id, session_id, title, created_at, updated_at) "
      + "SELECT $1, 'golden-bulk-' || pg_catalog.lpad(g::text, 4, '0'), NULL, $2::timestamptz + pg_catalog.make_interval(secs => g), "
      + "$2::timestamptz + pg_catalog.make_interval(secs => g) FROM pg_catalog.generate_series(1, 510) AS g RETURNING conversation_id, session_id) "
      + "INSERT INTO lcm.messages (project_id, conversation_id, seq, role, content, token_count, created_at) "
      + "SELECT $1, bulk.conversation_id, 0, 'user', 'golden bulk message ' || bulk.session_id, 3, $2 FROM bulk",
    values: [projectId, AT],
  }, context);
  await db.migrator.query({
    text: "WITH closure AS (INSERT INTO lcm.conversations (project_id, session_id, title, created_at, updated_at) "
      + "VALUES ($1, 'golden-closure', 'Golden closure', $2, $2) RETURNING conversation_id) "
      + "INSERT INTO lcm.messages (project_id, conversation_id, seq, role, content, token_count, created_at) "
      + "SELECT $1, closure.conversation_id, s, CASE WHEN s % 2 = 0 THEN 'user' ELSE 'assistant' END, 'golden closure message ' || s, s, "
      + "$2::timestamptz + pg_catalog.make_interval(secs => s) FROM closure CROSS JOIN pg_catalog.generate_series(0, 599) AS s",
    values: [projectId, AT],
  }, context);
  await db.migrator.query({
    text: "INSERT INTO lcm.message_parts (part_id, project_id, conversation_id, message_id, session_id, part_type, ordinal, text_content) "
      + "SELECT pg_catalog.md5('golden-part:' || c.session_id || ':' || m.seq)::uuid, $1, m.conversation_id, m.message_id, c.session_id, 'text', 0, "
      + "'golden part ' || c.session_id || ':' || m.seq FROM lcm.messages m JOIN lcm.conversations c ON c.conversation_id = m.conversation_id "
      + "WHERE c.project_id = $1 AND c.session_id LIKE 'golden-%'",
    values: [projectId],
  }, context);
}

async function captureCensus(db: PostgreSqlTestDatabase, identity: StorageIdentityContext): Promise<Record<string, string>> {
  const scratchParent = mkdtempSync(join(tmpdir(), "lcm-pg-set-read-golden-"));
  const runtime = new PostgreSqlRuntime(settings(db.runtimeUrl));
  try {
    const session = await runtime.openReadOnlySnapshot({ projectId: identity.id });
    let read: Awaited<ReturnType<typeof readFencedDestinationCensus>>;
    try {
      read = await readFencedDestinationCensus(session, {
        settings: settings(db.runtimeUrl), expectedOwner: EXPECTED_OWNER, expectedIdentity: identity, scratchParent,
      });
    } finally {
      await session.close();
    }
    const sortedSets = (map: ReadonlyMap<string, ReadonlySet<string>>) => [...map].map(([domain, set]) => [domain, [...set].sort()]);
    const stream = await createPortableRecordStream(await createPostgreSqlPortableSource({
      settings: settings(db.runtimeUrl), expectedOwner: EXPECTED_OWNER, expectedIdentity: identity, scratchParent,
    }));
    try {
      const manifest = stream.describe();
      // Domain coverage evidence is bound to the run's source identity, so the
      // manifest domains are compared through their content: counts and
      // prefixes equal the pinned census.
      expect(manifest.domains.map(({ domain, recordCount, prefixSha256 }) => ({ domain, recordCount, prefixSha256 })))
        .toEqual(read.census.map(({ domain, recordCount, prefixSha256 }) => ({ domain, recordCount, prefixSha256 })));
      return {
        censusSha256: digestOf(read.census),
        dependencyEdgesSha256: digestOf(sortedSets(read.dependencyEdges)),
        recordIdentitiesSha256: digestOf(sortedSets(read.recordIdentities)),
        recordSha256sSha256: digestOf([...read.recordSha256s].map(([domain, records]) => [domain, [...records].sort(([a], [b]) => (a < b ? -1 : 1))])),
        streamContentSha256: manifest.contentSha256,
      };
    } finally {
      await stream.close();
    }
  } finally {
    await runtime.close();
  }
}

type ReadinessOutcome =
  | Readonly<{ reason: string; operation: string }>
  | Readonly<{ readiness: Record<string, unknown> }>
  | Readonly<{ unexpected: string }>;

async function readinessOutcome(run: () => Promise<PostgreSqlRuntimeReadiness>): Promise<ReadinessOutcome> {
  try {
    const readiness = await run();
    const role = readiness.runtimeRole === RUNTIME_ROLE ? "<runtime-role>" : readiness.runtimeRole === TRANSFER_ROLE ? "<transfer-role>" : readiness.runtimeRole;
    return { readiness: { ...readiness, currentMigrationIds: [...readiness.currentMigrationIds], runtimeRole: role } };
  } catch (error) {
    if (error instanceof PostgreSqlRuntimeReadinessError) return { reason: error.reason, operation: error.operation };
    return { unexpected: error instanceof Error ? error.name : String(error) };
  }
}

async function asAdministrator(db: PostgreSqlTestDatabase, statements: readonly string[]): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    for (const text of statements) await administrator.query({ text }, { domain: "factory", operation: "degradeSetReadGolden" });
  } finally {
    await administrator.close();
  }
}

async function bothManifests(db: PostgreSqlTestDatabase): Promise<Record<string, ReadinessOutcome>> {
  return {
    runtime: await readinessOutcome(() => verifyPostgreSqlRuntimeSchema(db.runtime, { expectedOwner: EXPECTED_OWNER })),
    transfer: await readinessOutcome(() => verifyPostgreSqlTransferSchema(db.runtime, { expectedOwner: EXPECTED_OWNER })),
  };
}

/** Recreate promoted_memories.content under a nondeterministic collation, as migrations.integration.ts does. */
async function makeContentCollationNondeterministic(db: PostgreSqlTestDatabase): Promise<void> {
  for (const text of [
    "CREATE COLLATION public.lcm_golden_nondeterministic (provider = icu, locale = 'und-u-ks-level2', deterministic = false)",
    "ALTER TABLE lcm.promoted_memories DROP COLUMN search_document",
    "ALTER TABLE lcm.promoted_memories DROP COLUMN content_sha256",
    "ALTER TABLE lcm.promoted_memories ALTER COLUMN content TYPE text COLLATE public.lcm_golden_nondeterministic",
    "ALTER TABLE lcm.promoted_memories ADD COLUMN search_document tsvector GENERATED ALWAYS AS (to_tsvector('lcm.search_v1'::regconfig, lcm.normalize_search_text(content))) STORED",
    "ALTER TABLE lcm.promoted_memories ADD COLUMN content_sha256 bytea GENERATED ALWAYS AS (public.digest(content, 'sha256')) STORED",
  ]) await db.migrator.query({ text }, context);
}

const DROP_DIGEST_BYTEA = [
  "ALTER EXTENSION pgcrypto DROP FUNCTION public.digest(bytea, text)",
  "DROP FUNCTION public.digest(bytea, text)",
];

async function sequenceName(db: PostgreSqlTestDatabase, table: string, column: string): Promise<string> {
  const result = await db.migrator.query<{ name: string }>({
    text: "SELECT pg_catalog.pg_get_serial_sequence($1, $2) AS name", values: [table, column],
  }, context);
  return result.rows[0]!.name;
}

async function sequenceMismatches(db: PostgreSqlTestDatabase, projectId: string): Promise<unknown> {
  const runtime = new PostgreSqlRuntime(settings(db.runtimeUrl));
  try {
    const session = await runtime.openReadOnlySnapshot({ projectId });
    try {
      return await readSequenceSelfConsistencyMismatches(session, projectId);
    } finally {
      await session.close();
    }
  } finally {
    await runtime.close();
  }
}

const SEQUENCES = [
  ["lcm.conversations", "conversation_id"],
  ["lcm.messages", "message_id"],
  ["lcm.recall_surfacing", "surfacing_id"],
  ["lcm.session_instructions", "instruction_id"],
  ["lcm.passive_event_inbox", "inbox_id"],
] as const;

describe("#1869 slice 2 golden capture (pre-fusion values)", () => {
  it("G-ID pins the identity fingerprint of five identity shapes", async () => {
    await withPostgreSqlTestDatabase("golden-identity", async (db) => {
      await grantPortablePostgreSql(db, { transfer: true });
      const fingerprints: Record<string, string> = {};
      for (const spec of goldenIdentityProjects()) {
        const identity = await seedIdentityProject(db.migrator, spec);
        if (spec.label === "excluded-other") continue;
        fingerprints[spec.label] = await probeFingerprint(db, identity);
        const oracle = await db.runtime.transaction((executor) => readIdentityFingerprintOracle(executor, identity), {
          domain: "factory", operation: "identityFingerprintOracle", projectId: identity.id, transactionMode: "read-committed-read-write",
        });
        expect(oracle).toBe(fingerprints[spec.label]);
      }
      golden("G-ID", fingerprints);
    });
  }, 180_000);

  it("G-ID matches the frozen pre-fusion algorithm on fifty seeded identity states", async () => {
    await withPostgreSqlTestDatabase("golden-identity-oracle", async (db) => {
      await grantPortablePostgreSql(db, { transfer: true });
      const identities: StorageIdentityContext[] = [];
      for (const spec of randomIdentityProjects()) identities.push(await seedIdentityProject(db.migrator, spec));
      const fingerprints = new Set<string>();
      for (const identity of identities) {
        const oracle = await db.runtime.transaction((executor) => readIdentityFingerprintOracle(executor, identity), {
          domain: "factory", operation: "identityFingerprintOracle", projectId: identity.id, transactionMode: "read-committed-read-write",
        });
        expect(await probeFingerprint(db, identity)).toBe(oracle);
        fingerprints.add(oracle);
      }
      expect(fingerprints.size).toBe(identities.length);
    });
  }, 300_000);

  it("G-CENSUS pins the census and stream digests of the portable fixture", async () => {
    await withPostgreSqlTestDatabase("golden-census", async (db) => {
      const seeded = await seedPortablePostgreSql(db.migrator);
      await grantPortablePostgreSql(db);
      golden("G-CENSUS-fixture", await captureCensus(db, seeded.expectedIdentity));
    });
  }, 180_000);

  it("G-CENSUS pins the census and stream digests across multi-page domains and closures", async () => {
    await withPostgreSqlTestDatabase("golden-census-bulk", async (db) => {
      const seeded = await seedPortablePostgreSql(db.migrator);
      await seedBulkCensus(db, seeded.expectedIdentity.id);
      await grantPortablePostgreSql(db);
      golden("G-CENSUS-bulk", await captureCensus(db, seeded.expectedIdentity));
    });
  }, 300_000);

  it("G-SCHEMA pins the destination schema witness", async () => {
    await withPostgreSqlTestDatabase("golden-schema", async (db) => {
      const seeded = await seedPortablePostgreSql(db.migrator);
      await grantPortablePostgreSql(db, { transfer: true });
      const first = await captureDestinationSchemaWitness(db.runtime);
      const session = await db.runtime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      try {
        expect(await captureDestinationSchemaWitness(session)).toEqual(first);
      } finally {
        await session.close();
      }
      golden("G-SCHEMA", first);
    });
  }, 120_000);

  it("G-READY pins healthy readiness with and without an admitted peer", async () => {
    const outcomes: Record<string, ReadinessOutcome> = {};
    await withPostgreSqlTestDatabase("golden-ready-runtime", async (db) => {
      await grantPortablePostgreSql(db);
      outcomes.runtime = await readinessOutcome(() => verifyPostgreSqlRuntimeSchema(db.runtime, { expectedOwner: EXPECTED_OWNER }));
    });
    await withPostgreSqlTestDatabase("golden-ready-transfer", async (db) => {
      await grantPortablePostgreSql(db, { transfer: true });
      outcomes.transfer = await readinessOutcome(() => verifyPostgreSqlTransferSchema(db.runtime, { expectedOwner: EXPECTED_OWNER }));
    });
    await withPostgreSqlTestDatabase("golden-ready-peer", async (db) => {
      try {
        const roles = await provisionActivationRole(db);
        await grantRuntimeActivationRole(db, roles.transfer);
        const runtime = new PostgreSqlRuntime(roles.runtime);
        const transfer = new PostgreSqlRuntime(roles.transfer);
        try {
          outcomes.runtimeWithPeer = await readinessOutcome(() => verifyPostgreSqlRuntimeSchema(runtime, {
            expectedOwner: EXPECTED_OWNER, admittedPeer: { role: TRANSFER_ROLE },
          }));
          outcomes.transferWithPeer = await readinessOutcome(() => verifyPostgreSqlTransferSchema(transfer, {
            expectedOwner: EXPECTED_OWNER, admittedPeer: { role: RUNTIME_ROLE },
          }));
          outcomes.runtimeWithoutPeer = await readinessOutcome(() => verifyPostgreSqlRuntimeSchema(runtime, { expectedOwner: EXPECTED_OWNER }));
          outcomes.runtimeWithMissingPeer = await readinessOutcome(() => verifyPostgreSqlRuntimeSchema(runtime, {
            expectedOwner: EXPECTED_OWNER, admittedPeer: { role: "lcm_golden_missing_peer" },
          }));
        } finally {
          await Promise.allSettled([runtime.close(), transfer.close()]);
        }
      } finally {
        await dropActivationRole(db);
      }
    });
    golden("G-READY-healthy", outcomes);
  }, 180_000);

  it("G-READY pins the reported check under combined readiness failures", async () => {
    const outcomes: Record<string, unknown> = {};
    await withPostgreSqlTestDatabase("golden-ready-owner", async (db) => {
      await grantPortablePostgreSql(db);
      await asAdministrator(db, ["REVOKE SELECT ON TABLE lcm.projects FROM lcm_test_runtime"]);
      outcomes.wrongExpectedOwnerAndMissingGrant = await readinessOutcome(() => verifyPostgreSqlRuntimeSchema(db.runtime, { expectedOwner: "lcm_harness_admin" }));
      await asAdministrator(db, ["ALTER TABLE lcm.machines OWNER TO lcm_harness_admin"]);
      outcomes.objectOwnerAndMissingGrant = await bothManifests(db);
    });
    await withPostgreSqlTestDatabase("golden-ready-peer-extension", async (db) => {
      try {
        const roles = await provisionActivationRole(db);
        await grantRuntimeActivationRole(db, roles.transfer);
        await asAdministrator(db, ["GRANT pg_read_all_settings TO " + TRANSFER_ROLE, "DROP EXTENSION pg_stat_statements"]);
        const runtime = new PostgreSqlRuntime(roles.runtime);
        try {
          outcomes.peerMembershipAndMissingExtension = {
            withPeer: await readinessOutcome(() => verifyPostgreSqlRuntimeSchema(runtime, { expectedOwner: EXPECTED_OWNER, admittedPeer: { role: TRANSFER_ROLE } })),
            withoutPeer: await readinessOutcome(() => verifyPostgreSqlRuntimeSchema(runtime, { expectedOwner: EXPECTED_OWNER })),
          };
        } finally {
          await runtime.close();
        }
      } finally {
        await dropActivationRole(db);
      }
    });
    await withPostgreSqlTestDatabase("golden-ready-digest", async (db) => {
      await grantPortablePostgreSql(db);
      await asAdministrator(db, DROP_DIGEST_BYTEA);
      outcomes.missingDigestOverload = await bothManifests(db);
    });
    await withPostgreSqlTestDatabase("golden-ready-digest-collation", async (db) => {
      await grantPortablePostgreSql(db);
      await makeContentCollationNondeterministic(db);
      await asAdministrator(db, DROP_DIGEST_BYTEA);
      outcomes.missingDigestOverloadAndCollation = await bothManifests(db);
    });
    await withPostgreSqlTestDatabase("golden-ready-ledger-missing", async (db) => {
      await grantPortablePostgreSql(db);
      await db.migrator.query({ text: "DROP TABLE lcm.schema_migrations" }, context);
      outcomes.missingLedger = await bothManifests(db);
    });
    await withPostgreSqlTestDatabase("golden-ready-ledger-unreadable", async (db) => {
      await grantPortablePostgreSql(db);
      await asAdministrator(db, ["REVOKE SELECT ON TABLE lcm.schema_migrations FROM lcm_test_runtime"]);
      outcomes.unreadableLedger = await bothManifests(db);
    });
    await withPostgreSqlTestDatabase("golden-ready-ledger-rows", async (db) => {
      await grantPortablePostgreSql(db);
      await db.migrator.query({
        text: "UPDATE lcm.schema_migrations SET checksum_sha256 = pg_catalog.repeat('0', 64) WHERE id = (SELECT pg_catalog.max(id) FROM lcm.schema_migrations)",
      }, context);
      outcomes.wrongLedgerRows = await bothManifests(db);
    });
    golden("G-READY-failures", outcomes);
  }, 300_000);

  it("G-SEQ pins sequence self-consistency mismatches across degraded sequence states", async () => {
    const outcomes: Record<string, unknown> = {};
    await withPostgreSqlTestDatabase("golden-seq-empty", async (db) => {
      const seeded = await seedPortablePostgreSql(db.migrator, { identityOnly: true });
      await grantPortablePostgreSql(db);
      outcomes.empty = await sequenceMismatches(db, seeded.expectedIdentity.id);
      const names = await Promise.all(SEQUENCES.map(([table, column]) => sequenceName(db, table, column)));
      await asAdministrator(db, [
        ...names.map((name) => "REVOKE USAGE ON SEQUENCE " + name + " FROM lcm_test_runtime"),
        "SELECT pg_catalog.setval('" + names[0] + "', 1, false)",
      ]);
      outcomes.emptyWithDegradedSequences = await sequenceMismatches(db, seeded.expectedIdentity.id);
    });
    await withPostgreSqlTestDatabase("golden-seq-never-called", async (db) => {
      const seeded = await seedPortablePostgreSql(db.migrator, { identityOnly: true });
      await grantPortablePostgreSql(db);
      await db.migrator.query({
        text: "INSERT INTO lcm.conversations (conversation_id, project_id, session_id, created_at, updated_at) OVERRIDING SYSTEM VALUE VALUES (1, $1, 'golden-never-called', $2, $2)",
        values: [seeded.expectedIdentity.id, AT],
      }, context);
      outcomes.neverCalledCollision = await sequenceMismatches(db, seeded.expectedIdentity.id);
    });
    await withPostgreSqlTestDatabase("golden-seq-revoked", async (db) => {
      const seeded = await seedPortablePostgreSql(db.migrator);
      await grantPortablePostgreSql(db);
      outcomes.healthy = await sequenceMismatches(db, seeded.expectedIdentity.id);
      await asAdministrator(db, ["REVOKE USAGE ON SEQUENCE " + await sequenceName(db, "lcm.session_instructions", "instruction_id") + " FROM lcm_test_runtime"]);
      outcomes.oneOfFiveRevoked = await sequenceMismatches(db, seeded.expectedIdentity.id);
    });
    await withPostgreSqlTestDatabase("golden-seq-mixed", async (db) => {
      const seeded = await seedPortablePostgreSql(db.migrator);
      await grantPortablePostgreSql(db);
      const conversations = await sequenceName(db, "lcm.conversations", "conversation_id");
      await asAdministrator(db, ["SELECT pg_catalog.setval('" + conversations + "', 1, true)"]);
      outcomes.setvalBelowMax = await sequenceMismatches(db, seeded.expectedIdentity.id);
      await asAdministrator(db, ["REVOKE USAGE ON SEQUENCE " + await sequenceName(db, "lcm.messages", "message_id") + " FROM lcm_test_runtime"]);
      await db.migrator.query({
        text: "INSERT INTO lcm.recall_surfacing (surfacing_id, project_id, memory_id, session_id, surfaced_at) OVERRIDING SYSTEM VALUE VALUES (1000000, $1, 'golden-memory', NULL, $2)",
        values: [seeded.expectedIdentity.id, AT],
      }, context);
      outcomes.mixed = await sequenceMismatches(db, seeded.expectedIdentity.id);
    });
    golden("G-SEQ", outcomes);
  }, 300_000);
});
