import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { describe, expect, test } from "vitest";

type Component = {
  component_id: string;
  name: string;
  paths: string[];
};

type OwnershipPathDescriptor =
  | { kind: "directory-prefix"; path: string }
  | { kind: "exact-file-regex"; path: string };

type ValidatedOwnershipPath =
  | { kind: "directory-prefix"; path: string }
  | { kind: "exact-file-regex"; path: string; matcher: RegExp };

type ValidatedComponent = {
  component_id: string;
  name: string;
  ownershipPaths: readonly ValidatedOwnershipPath[];
};

type CodecovConfig = {
  comment?: {
    layout?: unknown;
  };
  component_management?: {
    individual_components?: unknown;
  };
  [key: string]: unknown;
};

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const codecovConfigPath = join(projectRoot, "codecov.yml");

const expectedComponents = [
  {
    component_id: "unit-cli",
    name: "Unit - CLI",
    // #1283 keeps renewal admission and bounded compact rendering CLI-owned.
    // #1132 keeps foreground PID publication at the CLI boundary.
    // #1233 keeps publication-contention restart recovery at the CLI boundary.
    paths: [
      // #1413 keeps the unbound-project remedy for promote and import, and
      // #1466 keeps per-project export failure attribution and the failed
      // project count, in this existing CLI owner.
      "bin/",
      "src/cli/",
      // #1393 keeps the project subcommand synopsis listing
      // renew-retired-identity in this existing CLI owner.
      "^src/cli-help\\.ts$",
      // #1430 keeps the bound-identity split for project enumeration in
      // this existing owner.
      "^src/cli-storage\\.ts$",
    ],
  },
  {
    component_id: "unit-installation",
    name: "Unit - Installation",
    paths: ["installer/", "src/installer/", "^src/bootstrap\\.ts$"],
  },
  {
    component_id: "unit-configuration-security",
    name: "Unit - Configuration, Security, and Filesystem Topology",
    paths: [
      "^src/config-manager\\.ts$",
      "^src/config-projection\\.ts$",
      // #1086/#1095/#1119 keep cleanup-error precedence in this existing
      // configuration-security owner without changing component topology.
      // #1134/#1135/#1136 preserve private-write failures while retaining
      // ordered descriptor, temporary-file, and parent cleanup evidence here.
      // #1223 keeps authenticated lock-owner disappearance recovery in this
      // existing configuration-security owner.
      // #1231 keeps exact intended enrollment identity construction here.
      // #1151 revalidates the journal temporary inode, single-link topology,
      // and retained parent after destination authorization in this owner.
      // PR #791 keeps generated Gitleaks hostname-literal normalization in
      // this existing configuration-security owner.
      "^src/generated-patterns\\.ts$",
      "^src/home-parent-auth\\.ts$",
      "^src/legacy-names\\.ts$",
      "^src/private-mutation-lock\\.ts$",
      "^src/runtime-paths\\.ts$",
      // #1195 keeps strict moduleAssetUrl resource resolution in this
      // existing configuration-security owner.
      "^src/runtime-root\\.ts$",
      "^src/scrub\\.ts$",
      "^src/secret-key\\.ts$",
      // #1032 keeps retained-parent atomic-write outcome hardening in this owner.
      // #1285 preserves ordered collision and task-owned temporary cleanup
      // evidence in the retained-parent exclusive private-file writer.
      "^src/security-files\\.ts$",
      // #1133 keeps project-pattern owner/single-link admission and authenticated
      // single-snapshot scrubbing in this existing configuration-security owner.
      "^src/sensitive\\.ts$",
      "^src/shell-quote\\.ts$",
      // #1283 keeps sanitize-then-bound terminal fields in this owner.
      "^src/terminal-sanitize\\.ts$",
      "^src/types\\.ts$",
      "^src/url-display\\.ts$",
    ],
  },
  {
    component_id: "unit-connectors",
    name: "Unit - Connectors",
    paths: ["src/connectors/"],
  },
  {
    component_id: "unit-hooks",
    name: "Unit - Hooks",
    // #1270 keeps retired-fence scrubbing and diagnostics hook-owned.
    // #1225 composes SessionStart pruning with append admission in this owner.
    // #1197 keeps independent SessionEnd background failure containment hook-owned.
    // #1259 keeps publication-fence error classification and ordered final
    // root-validation/descriptor-close evidence in the existing hooks owner.
    // #1229 forwards local-enqueue health diagnostics through its live
    // publication token in this existing hooks owner.
    // PreCompact initial unsafe-storage diagnostics remain in that same owner.
    paths: ["src/hooks/"],
  },
  {
    component_id: "unit-daemon-core",
    name: "Unit - Daemon Core",
    paths: [
      "^src/daemon/auth\\.ts$",
      "^src/daemon/client\\.ts$",
      // #1410 adds the validated, persisted snapshotIdleTimeoutMs
      // PostgreSQL tuning key here.
      "^src/daemon/config\\.ts$",
      "^src/daemon/content-fence\\.ts$",
      // #1413 keeps the typed unbound-project 409 reason discriminator in
      // this existing daemon-core owner.
      "^src/daemon/http-url\\.ts$",
      "^src/daemon/invocation-coordinator\\.ts$",
      "^src/daemon/cancellation\\.ts$",
      "^src/daemon/orientation\\.ts$",
      "^src/daemon/project-queue\\.ts$",
      "^src/daemon/publication-queue\\.ts$",
      // #1270/#1283 keep renewed hook identity selection daemon-core-owned.
      // #1430 keeps the bound-identity split for hook identity resolution
      // in this existing daemon-core owner.
      "^src/daemon/project\\.ts$",
      // #1106 keeps periodic transcript metadata admission daemon-core-owned.
      // Monotonic proxy startup polling remains daemon-core-owned.
      "^src/daemon/proxy-manager\\.ts$",
      "^src/daemon/remediation\\.ts$",
      // Error sanitization, including #893 adjacent-path, #903 prefixed
      // nested-file, #924 embedded-quote, #925/#1076 quoted-authority,
      // quoted/root-only backslash handoff, #1010 pathless-tail brackets,
      // #1060 adjacent nested-file schemes, #1113 doubled-colon drive tails,
      // #1117 glued authorities, #1111 bracketed nested-URL idempotence,
      // #1118/#1303 quoted query-tail handoff, #1128 active own-query and
      // IPv6 bracket-boundary backslash paths, #1294 retained-query syntax and
      // raw-marker collision handling, contextual Windows-root ownership, and
      // ampersand/quoted-public query/private-return lifetime, depth-bound
      // nested-file parent/query/public return, and pipe wrapper handoffs,
      // #1304 closed-bracket path handoff, #1312/#1313 repeated POSIX/Windows
      // nested-public delimiter handoff,
      // #1317 stable unquoted-wrapper public URLs, #1141 single-slash file
      // tails, and #1156 forced drive-after-content continuations remain
      // daemon-core-owned.
      "^src/daemon/safe-error\\.ts$",
      "^src/daemon/server\\.ts$",
      "^src/daemon/summarizer\\.ts$",
      "^src/daemon/validate-cwd\\.ts$",
      "^src/daemon/version\\.ts$",
    ],
  },
  {
    component_id: "unit-daemon-routes",
    name: "Unit - Daemon Routes",
    // #1230 keeps route project close on the live request token.
    // #1247 keeps local queue preparation, acknowledgement, and cleanup route-owned.
    // #1413 keeps the storage-identity-required reason discriminator on the
    // unbound-project and machine-identity 409 responses route-owned.
    paths: ["src/daemon/routes/"],
  },
  {
    component_id: "unit-daemon-events",
    name: "Unit - Daemon Passive Events",
    paths: [
      "^src/daemon/passive-event-processor\\.ts$",
      "^src/daemon/passive-event-replication-pass\\.ts$",
    ],
  },
  {
    component_id: "unit-mcp",
    name: "Unit - MCP",
    paths: ["src/mcp/"],
  },
  {
    component_id: "unit-llm-prompts",
    name: "Unit - LLM, Responses, and Prompts",
    paths: ["src/llm/", "src/prompts/"],
  },
  {
    component_id: "unit-local-persistence",
    name: "Unit - Local Persistence",
    // #898 applies required promoted tags before the caller result maximum while retaining local-persistence ownership.
    // #898's guarded dual-JSON eligibility keeps this search in the same owner.
    // #989 retains event-sidecar parent authentication in this owner.
    // #1191 retains publication admission through mutating sidecar reads,
    // close, stop rechecks, eligibility, and orphan pruning in this owner.
    // #1082 keeps SQLite promoted-content NUL admission and replay guards in
    // local persistence; this change does not alter component ownership.
    // #618 optional receipt schema admission stays local-persistence-owned.
    // #622 keeps registered-project outbox preparation and admitted sidecar discovery here.
    // #1140 fixed transfer-ledger control bounds stay local-persistence-owned.
    // #1231 prepares an intended enrollment epoch before identity publication.
    // #1196 serializes same-home factory health probes across overlapping sweeps.
    paths: ["src/db/", "src/storage/sqlite/", "src/store/"],
  },
  {
    component_id: "unit-storage-abstractions",
    name: "Unit - Storage Abstractions",
    paths: [
      // #906 keeps bounded publication-convergence probe expiry and error
      // selection in this storage-abstractions owner.
      "^src/storage/backend\\.ts$",
      // #844 and #942 keep coordinator evidence, material, and checkpoint
      // directory-witness authentication in this owner.
      // #1240 keeps authenticated terminal-maintenance configuration admission here.
      // #1292 preserves structured parser errors on terminal journal archive rereads.
      // #1285 retains terminal archive history identity through exclusive
      // publication, exact replay, and descriptor-bound durability flushes.
      "^src/storage/backend-publication\\.ts$",
      "^src/storage/backend-publication-driver\\.ts$",
      "^src/storage/backend-publication-material\\.ts$",
      // #910 keeps shared publication retry deadlines monotonic in this owner.
      "^src/storage/publication-convergence\\.ts$",
      "^src/storage/capabilities\\.ts$",
      "^src/storage/contracts\\.ts$",
      "^src/storage/errors\\.ts$",
      "^src/storage/factory\\.ts$",
      "^src/storage/home-lock-topology\\.ts$",
      // #1413 keeps the typed unbound-project transport error and 409
      // reason constants, and #1430 the bound-identity overloads, in this
      // existing storage-abstractions owner.
      "^src/storage/identity-context\\.ts$",
      "^src/storage/index\\.ts$",
      // Curated portable package API remains storage-abstractions-owned.
      "^src/storage/portable\\.ts$",
      // #1410 adds the optional, non-serialized PortableStreamError cause
      // here.
      "^src/storage/portable-record\\.ts$",
      // #1410 forwards the source's close cause here. #1442 classifies a
      // read-path source-unavailable as retryable only when the source
      // adapter marked it retryable, so the stream stays backend-neutral.
      "^src/storage/portable-record-stream\\.ts$",
      "^src/storage/portable-transfer\\.ts$",
      "^src/storage/portable-index\\.ts$",
      "^src/storage/postgresql/project-storage\\.ts$",
    ],
  },
  {
    component_id: "unit-migration-cutover",
    name: "Unit - Migration Capture, Copy and Cutover",
    // #622 keeps immutable capture, preparation, and receipt evidence here.
    // #1231 orders receipt epoch durability before machine identity visibility.
    // #622 seals private artifact modes before the final file sync.
    paths: ["src/migration/"],
  },
  {
    component_id: "unit-local-event-storage",
    name: "Unit - Local Event Storage",
    // #622 keeps outbox connection admission and current-schema validation here.
    // #1247 keeps explicit promotion queue admission in this component.
    // #1229 admits local outbox health, recent-error, and delivery diagnostics
    // through an optional live publication token here.
    paths: [
      "^src/storage/local-hook-event-sequence\\.ts$",
      "^src/storage/local-hook-outbox\\.ts$",
      "^src/storage/local-hook-outbox-schema\\.ts$",
      "^src/storage/session-instructions\\.ts$",
    ],
  },
  {
    component_id: "unit-transcripts-import",
    name: "Unit - Transcripts and Import",
    paths: [
      // #1106 bounded custom-directory metadata and #1286 Claude block
      // admission stay within this import owner.
      "^src/codex-transcript\\.ts$",
      "^src/import-summary\\.ts$",
      // #1413 keeps the unbound-project remedy for import in this existing
      // import owner.
      "^src/import\\.ts$",
      "^src/transcript-provider\\.ts$",
      "^src/transcript\\.ts$",
      "^src/storage/local-transcript-quarantine\\.ts$",
      "^src/storage/native-transcript-ingest\\.ts$",
      "^src/storage/native-transcripts\\.ts$",
    ],
  },
  {
    component_id: "unit-memory-retrieval",
    name: "Unit - Memory and Retrieval",
    paths: [
      // The #971 compact cwd client contract and #973 stats database admission
      // and #1146 metadata-only aggregate diagnostics remain memory/retrieval-owned.
      "src/memory/",
      "^src/expansion\\.ts$",
      "^src/retrieval\\.ts$",
      "^src/stats\\.ts$",
    ],
  },
  {
    component_id: "unit-compaction-summarization",
    name: "Unit - Compaction and Summarization",
    // #1283 keeps structured retired-fence discovery in this component.
    paths: [
      // #618 authenticated batch discovery remains within this compaction owner.
      // #1413 keeps the compact --all message separating enumeration failure
      // from per-project open failures in this existing compaction owner.
      "^src/batch-compact\\.ts$",
      "^src/compaction\\.ts$",
      "^src/large-files\\.ts$",
      "^src/summarize\\.ts$",
    ],
  },
  {
    component_id: "unit-promotion",
    name: "Unit - Promotion",
    // #1153 rank-independent exact deduplication remains promotion-owned.
    paths: ["src/promotion/"],
  },
  {
    component_id: "unit-project-worktrees",
    name: "Unit - Projects and Worktrees",
    paths: [
      // #1070 preserves post-commit topology diagnostics in this existing
      // reconciliation owner.
      // #974 keeps target-parent reconciliation hardening in this
      // existing component.
      "^src/codex-project-resolution\\.ts$",
      "^src/git-project\\.ts$",
      "^src/machine-identity\\.ts$",
      // #618 knowledge provenance scoping remains owned by project/worktree operations.
      "^src/portable-knowledge\\.ts$",
      // #1049 keeps project metadata owner and single-link admission in this
      // existing component; no taxonomy, status, or policy change.
      // #1270/#1283 retain exact fence classification and local successor
      // renewal in this existing project/worktree owner.
      // #1430 keeps the bound project identity type in this existing owner.
      "^src/project-map\\.ts$",
      "^src/worktree-reconciliation-fence\\.ts$",
      // #1044 keeps the existing owner; no taxonomy, status, or policy change.
      // #1048 keeps target metadata leaf authentication in this owner.
      // #1069 preserves completed reconciliation evidence after retained
      // directory cleanup failures in this existing component.
      // #1107 and #1109 keep pattern and journal leaf authentication in this
      // existing component; no taxonomy, status, or policy change.
      // #1059 keeps retained journal-parent publication in this existing owner.
      // #1087 bounds canonical metadata publication in this existing owner.
      // #1091 preserves completion evidence across publication failures here.
      // #1138/#1151/#1165/#1166 keep reconciliation lock, journal admission,
      // recovery, and listing hardening in this existing worktree owner.
      // #1173 keeps promoted-content reconciliation guards in this existing
      // project/worktree ownership component; no topology change.
      // #1178 listing-root authentication and #1245 retained journal-parent
      // witness stay in this existing unit-project-worktrees owner.
      // #1316 keeps SQLite message-byte admission in this existing
      // unit-project-worktrees owner; no taxonomy or topology change.
      // #1270/#1283 keep renewed-successor targeting and its fail-closed
      // fence authentication in this existing unit-project-worktrees owner.
      "^src/worktree-reconciliation\\.ts$",
    ],
  },
  {
    component_id: "unit-diagnostics",
    name: "Unit - Diagnostics",
    paths: [
      "^src/diagnose\\.ts$",
      // #1410 threads snapshotIdleTimeoutMs into the diagnostics probe's
      // connection settings here.
      "^src/storage/diagnostics\\.ts$",
      "^src/storage/diagnostic-renderer\\.ts$",
      "^src/storage/diagnostic-project\\.ts$",
      "^src/storage/postgresql/diagnostics\\.ts$",
      "^src/storage/postgresql/query-operations\\.ts$",
      "^src/storage/postgresql/query-statistics\\.ts$",
      "^src/storage/runtime-health\\.ts$",
      "^src/storage/postgresql/runtime-health\\.ts$",
      "src/doctor/",
    ],
  },
  {
    component_id: "integration-service-managers",
    name: "Integration - Service Managers and Legacy Migration",
    paths: [
      "^src/daemon/health-observation\\.ts$",
      // #865/#966 convergence and birth budgeting remain lifecycle-owned;
      // #1073 bounds legacy PID/token evidence within that same owner. #1132
      // keeps unscoped detached PID publication lifecycle-owned.
      // #1233 keeps publication-contention managed restart recovery lifecycle-owned.
      "^src/daemon/lifecycle-scope\\.ts$",
      "^src/daemon/lifecycle\\.ts$",
      "^src/daemon/peer-admission\\.ts$",
      "^src/daemon/peer-attribution\\.ts$",
      "^src/daemon/managed-credentials\\.ts$",
      // #1450 keeps stable managed PATH canonicalization and direct executable
      // admission in this existing service-manager owner.
      "^src/daemon/managed-path\\.ts$",
      "^src/daemon/supervisor\\.ts$",
    ],
  },
  {
    component_id: "integration-postgresql-runtime",
    name: "Integration - PostgreSQL Runtime",
    paths: [
      "^src/daemon/staged-postgresql\\.ts$",
      "^src/storage/postgresql/client-config\\.ts$",
      // #1410 adds the optional snapshotIdleTimeoutMs connection setting
      // here.
      "^src/storage/postgresql/contracts\\.ts$",
      // #1410 adds the snapshot-local termination predicate, covering a
      // captured async-diagnostic reattachment shape, here.
      "^src/storage/postgresql/errors\\.ts$",
      // #1410 threads snapshotIdleTimeoutMs through resolved connection
      // settings here.
      "^src/storage/postgresql/factory\\.ts$",
      "^src/storage/postgresql/index\\.ts$",
      // #1410 attaches the snapshot checkout's async-failure listener and
      // resolves the snapshot idle bound here. #1424 gives query and
      // transaction checkouts the same observer.
      "^src/storage/postgresql/runtime\\.ts$",
      // #1410 separates the snapshot's idle-in-transaction bound from
      // statementTimeoutMs and captures its async FATAL diagnostic here.
      "^src/storage/postgresql/snapshot-session\\.ts$",
      "^src/storage/postgresql\\.ts$",
    ],
  },
  {
    component_id: "integration-postgresql-portable",
    name: "Integration - PostgreSQL Portable Transfer",
    paths: [
      // #618 canonical self-provenance stays in PostgreSQL portable transfer.
      // #1410 narrows session-close tolerance to a real snapshot-
      // termination diagnostic here. #1442 marks a genuine termination
      // retryable on the source-unavailable it raises.
      "^src/storage/postgresql/portable-source\\.ts$",
      "^src/storage/postgresql/portable-destination\\.ts$",
      "^src/storage/postgresql/portable-mapping\\.ts$",
    ],
  },
  {
    component_id: "integration-postgresql-schema",
    name: "Integration - PostgreSQL Schema",
    paths: [
      "^src/storage/postgresql/extensions\\.ts$",
      // #1195 keeps packaged SQL loading and checksum verification in
      // the existing PostgreSQL schema owner.
      // #1306 adds the 0007 promoted-content digest migration and its
      // schema snapshot, keeping the packaged migration manifest here.
      "^src/storage/postgresql/migrations\\.ts$",
      "^src/storage/postgresql/provisioning\\.ts$",
      "^src/storage/postgresql/runtime-readiness\\.ts$",
    ],
  },
  {
    component_id: "integration-postgresql-conversations",
    name: "Integration - PostgreSQL Conversations",
    paths: ["^src/storage/postgresql/conversation-repository\\.ts$"],
  },
  {
    component_id: "integration-postgresql-coordination",
    name: "Integration - PostgreSQL Coordination",
    paths: [
      "^src/storage/postgresql/coordination\\.ts$",
      "^src/storage/postgresql/publication-guard\\.ts$",
      "^src/storage/postgresql/publication-remote-guard\\.ts$",
    ],
  },
  {
    component_id: "integration-postgresql-identity",
    name: "Integration - PostgreSQL Identity",
    paths: [
      "^src/identity-service\\.ts$",
      "^src/storage/postgresql/identity-repository\\.ts$",
    ],
  },
  {
    component_id: "integration-postgresql-memory",
    name: "Integration - PostgreSQL Memory",
    paths: [
      // #1306 indexes owner exact-content lookup by a generated SHA-256
      // digest, retaining the raw-equality residual it always used.
      "^src/storage/postgresql/memory-repositories\\.ts$",
      "^src/storage/postgresql/summary-context-repositories\\.ts$",
    ],
  },
  {
    component_id: "integration-postgresql-search",
    name: "Integration - PostgreSQL Search",
    paths: [
      "^src/storage/postgresql/lexical-search-repository\\.ts$",
      "^src/storage/postgresql/tsquery-evidence\\.ts$",
      "^src/storage/postgresql/search-configuration\\.ts$",
    ],
  },
  {
    component_id: "integration-postgresql-transcripts",
    name: "Integration - PostgreSQL Transcripts",
    paths: ["^src/storage/postgresql/native-transcript-repository\\.ts$"],
  },
  {
    component_id: "integration-postgresql-passive-events",
    name: "Integration - PostgreSQL Passive Events",
    paths: [
      "^src/daemon/passive-event-replication\\.ts$",
      "^src/storage/postgresql/passive-event-repository\\.ts$",
    ],
  },
] as const;

const forbiddenConfigKeys = new Set([
  "coverage",
  "coverage_exclusions",
  "exclusions",
  "flag_management",
  "flag_regex",
  "flag_regexes",
  "flags",
  "ignore",
  "status",
  "statuses",
]);

const safeDirectoryPrefixPattern = /^(?:bin|installer|src)(?:\/[A-Za-z0-9._-]+)*\/$/;
const safeExactFilePattern = /^\^(?:bin|installer|src)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\\\.ts\$$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCodecovConfig(): CodecovConfig | undefined {
  if (!existsSync(codecovConfigPath)) {
    return undefined;
  }

  const parsed = loadYaml(readFileSync(codecovConfigPath, "utf8"));
  return isRecord(parsed) ? parsed : undefined;
}

function configuredComponents(config: CodecovConfig): Component[] {
  const components = config.component_management?.individual_components;
  return Array.isArray(components) ? (components as Component[]) : [];
}

function collectRepositoryFiles(): string[] {
  const skippedDirectories = new Set([".git", "coverage", "dist", "node_modules"]);

  function visit(directory: string, relativeDirectory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        return skippedDirectories.has(entry.name)
          ? []
          : visit(join(directory, entry.name), relativePath);
      }
      return entry.isFile() ? [relativePath] : [];
    });
  }

  return visit(projectRoot, "").sort();
}

function isSafeOwnershipPath(path: string): boolean {
  return safeDirectoryPrefixPattern.test(path) || safeExactFilePattern.test(path);
}

function classifyOwnershipPath(path: string): OwnershipPathDescriptor {
  if (safeDirectoryPrefixPattern.test(path)) {
    return { kind: "directory-prefix", path };
  }
  if (safeExactFilePattern.test(path)) {
    return { kind: "exact-file-regex", path };
  }

  throw new Error(`Unsafe Codecov ownership path: ${path}`);
}

function validateComponents(components: readonly Component[]): ValidatedComponent[] {
  // Classify every raw path before compiling any exact-file regular expression.
  const classifiedComponents = components.map((component) => ({
    component_id: component.component_id,
    name: component.name,
    ownershipPaths: component.paths.map(classifyOwnershipPath),
  }));

  return classifiedComponents.map((component) => ({
    ...component,
    ownershipPaths: component.ownershipPaths.map((path) =>
      path.kind === "directory-prefix" ? path : { ...path, matcher: new RegExp(path.path) },
    ),
  }));
}

function matchesOwnershipPath(file: string, path: ValidatedOwnershipPath): boolean {
  return path.kind === "directory-prefix" ? file.startsWith(path.path) : path.matcher.test(file);
}

function filesMatchedByComponent(component: ValidatedComponent, files: readonly string[]): string[] {
  return files.filter((file) => component.ownershipPaths.some((path) => matchesOwnershipPath(file, path)));
}

const repositoryFiles = Object.freeze(collectRepositoryFiles());
const productionFiles = Object.freeze(
  repositoryFiles.filter((file) => /^(?:bin|installer|src)\/.*\.ts$/.test(file)),
);
const nonProductionTypeScript = Object.freeze(
  repositoryFiles.filter((file) => file.endsWith(".ts") && !productionFiles.includes(file)),
);

function forbiddenKeysIn(value: unknown, location = "config"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => forbiddenKeysIn(entry, `${location}[${index}]`));
  }
  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => [
    ...(forbiddenConfigKeys.has(key) ? [`${location}.${key}`] : []),
    ...forbiddenKeysIn(child, `${location}.${key}`),
  ]);
}

const ownershipFragmentDirectory = join(projectRoot, "test", "codecov-ownership");
const legacyLedgerName = "0000-legacy-ledger.yml";
const fragmentNamePattern = /^(\d+)-[a-z0-9]+(?:-[a-z0-9]+)*\.yml$/;
const referencePattern = /^(?:#\d+|PR #\d+|[A-Z]\d{3}|[a-z][a-z0-9-]*[a-z0-9])$/;
const fragmentKeys = "pins,rationale,references";

type OwnershipPin = { readonly file: string; readonly component: string };

type OwnershipFragment = {
  readonly name: string;
  readonly references: readonly string[];
  readonly rationale: string;
  readonly pins: readonly OwnershipPin[];
};

type FragmentContext = {
  readonly productionFiles: readonly string[];
  readonly componentIds: ReadonlySet<string>;
};

// <number>-<slug>.yml; an all-zero number is reserved for the legacy ledger.
function isValidFragmentName(name: string): boolean {
  const match = fragmentNamePattern.exec(name);
  if (match === null) {
    return false;
  }
  return /^0+$/.test(match[1]!) ? name === legacyLedgerName : true;
}

function fragmentNumber(name: string): number {
  return Number(fragmentNamePattern.exec(name)?.[1] ?? "0");
}

// Pure validation so malformed fragments can be exercised with inline objects.
function validateFragment(name: string, document: unknown, context: FragmentContext): string[] {
  const errors: string[] = [];
  if (!isValidFragmentName(name)) {
    errors.push(`${name}: file name must match <number>-<slug>.yml (0000- is reserved for ${legacyLedgerName})`);
  }
  if (!isRecord(document)) {
    return [...errors, `${name}: document must be a mapping`];
  }
  const keys = Object.keys(document).sort().join(",");
  if (keys !== fragmentKeys) {
    errors.push(`${name}: keys must be exactly references, rationale, pins (found ${keys})`);
  }
  const { references, rationale, pins } = document;
  if (!Array.isArray(references) || references.length === 0) {
    errors.push(`${name}: references must be a non-empty list`);
  } else {
    for (const reference of references) {
      if (typeof reference !== "string" || !referencePattern.test(reference)) {
        errors.push(`${name}: reference ${JSON.stringify(reference)} must be #<issue>, PR #<number>, a campaign code, or a kebab-case slug`);
      }
    }
    const issue = fragmentNumber(name);
    if (issue > 0 && !references.some((reference) => reference === `#${issue}` || reference === `PR #${issue}`)) {
      errors.push(`${name}: references must include #${issue} or PR #${issue}`);
    }
  }
  if (typeof rationale !== "string" || rationale.trim().length === 0) {
    errors.push(`${name}: rationale must be a non-empty string`);
  }
  if (!Array.isArray(pins) || pins.length === 0) {
    errors.push(`${name}: pins must be a non-empty list`);
  } else {
    pins.forEach((pin: unknown, index) => {
      if (!Array.isArray(pin) || pin.length !== 2 || pin.some((entry) => typeof entry !== "string")) {
        errors.push(`${name}: pin ${index} must be [file, component] with two strings`);
        return;
      }
      const [file, component] = pin as [string, string];
      if (!context.productionFiles.includes(file)) {
        errors.push(`${name}: pin ${index} names ${file}, which is not a production TypeScript file`);
      }
      if (!context.componentIds.has(component)) {
        errors.push(`${name}: pin ${index} names unknown component ${component}`);
      }
    });
  }
  return errors;
}

// Parse one fragment so a YAML error names the fragment instead of the loader.
function parseFragment(name: string, text: string): { document: unknown } | { error: string } {
  try {
    return { document: loadYaml(text) };
  } catch (error) {
    return { error: `${name}: YAML parse error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function readOwnershipFragments(context: FragmentContext): { fragments: OwnershipFragment[]; errors: string[] } {
  const errors: string[] = [];
  const fragments: OwnershipFragment[] = [];
  const entries = readdirSync(ownershipFragmentDirectory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  if (!entries.some((entry) => entry.name === legacyLedgerName)) {
    errors.push(`${legacyLedgerName} is missing`);
  }
  for (const entry of entries) {
    // Dirent reports a symlink as a symlink, so links and directories are rejected.
    if (!entry.isFile()) {
      errors.push(`${entry.name}: must be a regular file`);
      continue;
    }
    const parsed = parseFragment(entry.name, readFileSync(join(ownershipFragmentDirectory, entry.name), "utf8"));
    if ("error" in parsed) {
      errors.push(parsed.error);
      continue;
    }
    const { document } = parsed;
    const fragmentErrors = validateFragment(entry.name, document, context);
    if (fragmentErrors.length > 0) {
      errors.push(...fragmentErrors);
      continue;
    }
    const record = document as { references: string[]; rationale: string; pins: [string, string][] };
    fragments.push({
      name: entry.name,
      references: record.references,
      rationale: record.rationale,
      pins: record.pins.map(([file, component]) => ({ file, component })),
    });
  }
  return { fragments, errors };
}


describe("Codecov configuration", () => {
  test("matches the literal 31-component ownership contract", () => {
    const config = readCodecovConfig();
    expect(config).toBeDefined();
    if (config === undefined) {
      return;
    }

    expect(configuredComponents(config)).toEqual(expectedComponents);
  });

  test("uses unique, safe ownership paths with nonempty matches", () => {
    const config = readCodecovConfig();
    expect(config).toBeDefined();
    if (config === undefined) {
      return;
    }

    const components = configuredComponents(config);
    const componentIds = components.map((component) => component.component_id);
    const componentNames = components.map((component) => component.name);
    const ownershipPaths = components.flatMap((component) => component.paths);

    expect(components).toHaveLength(31);
    expect(new Set(componentIds).size).toBe(componentIds.length);
    expect(new Set(componentNames).size).toBe(componentNames.length);
    expect(new Set(ownershipPaths).size).toBe(ownershipPaths.length);

    for (const path of ownershipPaths) {
      expect(isSafeOwnershipPath(path)).toBe(true);
    }

    expect(productionFiles).toHaveLength(333);

    for (const component of validateComponents(components)) {
      expect(filesMatchedByComponent(component, productionFiles).length).toBeGreaterThan(0);
    }
  });

  test("owns every current production TypeScript file exactly once", () => {
    const config = readCodecovConfig();
    expect(config).toBeDefined();
    if (config === undefined) {
      return;
    }

    const components = validateComponents(configuredComponents(config));
    const ownershipCounts = new Map(
      productionFiles.map((file) => [
        file,
        components.filter((component) =>
          component.ownershipPaths.some((path) => matchesOwnershipPath(file, path)),
        ).length,
      ]),
    );
    const unownedFiles = productionFiles.filter((file) => ownershipCounts.get(file) === 0);
    const multiplyOwnedFiles = [...ownershipCounts.entries()]
      .filter(([, ownerCount]) => ownerCount > 1)
      .map(([file, ownerCount]) => ({ file, ownerCount }));

    expect(unownedFiles).toEqual([]);
    expect(multiplyOwnedFiles).toEqual([]);
    expect(ownershipCounts.size).toBe(333);
  });

  test("keeps every recorded ownership decision in its intended component", () => {
    const config = readCodecovConfig();
    expect(config).toBeDefined();
    if (config === undefined) {
      return;
    }

    const components = validateComponents(configuredComponents(config));
    const { fragments, errors } = readOwnershipFragments({
      productionFiles,
      componentIds: new Set(components.map((component) => component.component_id)),
    });
    expect(errors).toEqual([]);

    // Aggregate pins per file so competing owners report every fragment involved.
    const pinsByFile = new Map<string, { fragment: string; component: string }[]>();
    for (const fragment of fragments) {
      for (const pin of fragment.pins) {
        pinsByFile.set(pin.file, [...(pinsByFile.get(pin.file) ?? []), { fragment: fragment.name, component: pin.component }]);
      }
    }
    const competingPins = [...pinsByFile.entries()]
      .filter(([, pins]) => new Set(pins.map((pin) => pin.component)).size > 1)
      .map(([file, pins]) => ({ file, pins }));
    expect(competingPins).toEqual([]);

    for (const [file, pins] of pinsByFile) {
      const owners = components
        .filter((component) => component.ownershipPaths.some((path) => matchesOwnershipPath(file, path)))
        .map((component) => component.component_id);
      expect(owners, `${file} pinned by ${pins.map((pin) => pin.fragment).join(", ")}`).toEqual([pins[0]!.component]);
    }

    // Every production file is pinned somewhere, so a new file must bring its own fragment.
    expect([...pinsByFile.keys()].sort()).toEqual([...productionFiles]);
  });

  test("rejects malformed ownership fragments", () => {
    const context = { productionFiles: ["src/cli-help.ts"], componentIds: new Set(["unit-cli"]) };
    const valid = { references: ["#1403"], rationale: "Keeps help rendering CLI-owned.", pins: [["src/cli-help.ts", "unit-cli"]] };
    expect(validateFragment("1403-cli-help.yml", valid, context)).toEqual([]);
    expect(validateFragment("1403-cli-help.yml", { ...valid, references: ["PR #1403", "G007", "response-fence"] }, context)).toEqual([]);
    expect(isValidFragmentName(legacyLedgerName)).toBe(true);
    expect(parseFragment("1403-cli-help.yml", "references: [")).toMatchObject({ error: expect.stringMatching(/^1403-cli-help\.yml: YAML parse error: /) });
    expect(parseFragment("1403-cli-help.yml", "a: 1\na: 2\n")).toMatchObject({ error: expect.stringContaining("duplicated mapping key") });
    expect(parseFragment("1403-cli-help.yml", "references: [\"#1403\"]\n")).toEqual({ document: { references: ["#1403"] } });
    for (const name of ["0000-other.yml", "0-x.yml", "1403-Cli.yml", "1403-cli.yaml", "cli-1403.yml", "1403--cli.yml", ".1403-cli.yml", "1403-cli.yml.bak", "1403_cli.yml"]) {
      expect(isValidFragmentName(name), name).toBe(false);
    }

    const malformed: [string, unknown][] = [
      ["1403-cli-help.yml", "not a mapping"],
      ["1403-cli-help.yml", { ...valid, extra: true }],
      ["1403-cli-help.yml", { references: valid.references, pins: valid.pins }],
      ["1403-cli-help.yml", { ...valid, references: [] }],
      ["1403-cli-help.yml", { ...valid, references: [1403] }],
      ["1403-cli-help.yml", { ...valid, references: ["issue 1403"] }],
      ["1404-cli-help.yml", valid],
      ["1403-cli-help.yml", { ...valid, rationale: "  " }],
      ["1403-cli-help.yml", { ...valid, rationale: 2026 }],
      ["1403-cli-help.yml", { ...valid, pins: [] }],
      ["1403-cli-help.yml", { ...valid, pins: [["src/cli-help.ts"]] }],
      ["1403-cli-help.yml", { ...valid, pins: [["src/cli-help.ts", "unit-cli", "extra"]] }],
      ["1403-cli-help.yml", { ...valid, pins: [["src/cli-help.ts", 7]] }],
      ["1403-cli-help.yml", { ...valid, pins: [["test/cli-help.test.ts", "unit-cli"]] }],
      ["1403-cli-help.yml", { ...valid, pins: [["src/cli-help.ts", "unit-nope"]] }],
      ["1403_cli_help.yml", valid],
    ];
    for (const [name, document] of malformed) {
      expect(validateFragment(name, document, context).length, `${name}: ${JSON.stringify(document)}`).toBeGreaterThan(0);
    }
  });


  test("does not match non-production TypeScript files", () => {
    const config = readCodecovConfig();
    expect(config).toBeDefined();
    if (config === undefined) {
      return;
    }

    const components = validateComponents(configuredComponents(config));
    const nonProductionMatches = components.flatMap((component) =>
      filesMatchedByComponent(component, nonProductionTypeScript).map((file) => `${component.component_id}:${file}`),
    );

    expect(nonProductionMatches).toEqual([]);
  });

  test("keeps the required comment layout and disallowed controls absent", () => {
    const config = readCodecovConfig();
    expect(config).toBeDefined();
    if (config === undefined) {
      return;
    }

    expect(config.comment?.layout).toBe("header, diff, flags, components");
    expect(forbiddenKeysIn(config)).toEqual([]);
  });
});

describe("Codecov maintenance guidance", () => {
  test("requires the literal map, fragments, frozen comments, and reviewer duty in AGENTS.md", () => {
    const agents = readFileSync(join(projectRoot, "AGENTS.md"), "utf8");

    expect(agents).toMatch(
      /Update them atomically whenever production TypeScript, features, or components are added, removed, moved, or otherwise make classification stale/,
    );
    expect(agents).toMatch(
      /Record every ownership decision for a materially changed, added, removed, moved, or re-owned production TypeScript file as one new file in `test\/codecov-ownership\/`/,
    );
    expect(agents).toMatch(
      /Never append provenance to the test, its titles, or `codecov\.yml`: the comments already there are frozen history\./,
    );
    expect(agents).toMatch(/Reviewers confirm that every materially changed production TypeScript file gained a fragment pin/);
  });
});
