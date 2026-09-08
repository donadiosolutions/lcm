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
    // #1132 keeps foreground PID publication at the CLI boundary.
    paths: ["bin/", "src/cli/", "^src/cli-help\\.ts$", "^src/cli-storage\\.ts$"],
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
      "^src/security-files\\.ts$",
      // #1133 keeps project-pattern owner/single-link admission and authenticated
      // single-snapshot scrubbing in this existing configuration-security owner.
      "^src/sensitive\\.ts$",
      "^src/shell-quote\\.ts$",
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
    // #1225 composes SessionStart pruning with append admission in this owner.
    paths: ["src/hooks/"],
  },
  {
    component_id: "unit-daemon-core",
    name: "Unit - Daemon Core",
    paths: [
      "^src/daemon/auth\\.ts$",
      "^src/daemon/client\\.ts$",
      "^src/daemon/config\\.ts$",
      "^src/daemon/content-fence\\.ts$",
      "^src/daemon/http-url\\.ts$",
      "^src/daemon/invocation-coordinator\\.ts$",
      "^src/daemon/cancellation\\.ts$",
      "^src/daemon/orientation\\.ts$",
      "^src/daemon/project-queue\\.ts$",
      "^src/daemon/publication-queue\\.ts$",
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
      // #1118 quoted query-tail handoff, #1128 active file-URL own-query
      // backslash paths, #1141 single-slash file tails, and #1156 forced
      // drive-after-content continuations remain
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
    paths: ["src/daemon/routes/"],
  },
  {
    component_id: "unit-daemon-events",
    name: "Unit - Daemon Passive Events",
    paths: ["^src/daemon/passive-event-processor\\.ts$"],
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
    // #1082 keeps SQLite promoted-content NUL admission and replay guards in
    // local persistence; this change does not alter component ownership.
    // #618 optional receipt schema admission stays local-persistence-owned.
    // #622 keeps registered-project outbox preparation and admitted sidecar discovery here.
    // #1140 fixed transfer-ledger control bounds stay local-persistence-owned.
    // #1231 prepares an intended enrollment epoch before identity publication.
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
      "^src/storage/backend-publication\\.ts$",
      // #910 keeps shared publication retry deadlines monotonic in this owner.
      "^src/storage/publication-convergence\\.ts$",
      "^src/storage/capabilities\\.ts$",
      "^src/storage/contracts\\.ts$",
      "^src/storage/errors\\.ts$",
      "^src/storage/factory\\.ts$",
      "^src/storage/home-lock-topology\\.ts$",
      "^src/storage/identity-context\\.ts$",
      "^src/storage/index\\.ts$",
      // Curated portable package API remains storage-abstractions-owned.
      "^src/storage/portable\\.ts$",
      "^src/storage/portable-record\\.ts$",
      "^src/storage/portable-record-stream\\.ts$",
      "^src/storage/portable-transfer\\.ts$",
      "^src/storage/portable-index\\.ts$",
      "^src/storage/postgresql/project-storage\\.ts$",
    ],
  },
  {
    component_id: "unit-migration-cutover",
    name: "Unit - Migration and Cutover",
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
      // #1106 bounded custom-directory metadata stays within this import owner.
      "^src/codex-transcript\\.ts$",
      "^src/import-summary\\.ts$",
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
    paths: [
      // #618 authenticated batch discovery remains within this compaction owner.
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
      "^src/worktree-reconciliation\\.ts$",
    ],
  },
  {
    component_id: "unit-diagnostics",
    name: "Unit - Diagnostics",
    paths: ["^src/diagnose\\.ts$", "^src/storage/diagnostics\\.ts$", "^src/storage/diagnostic-renderer\\.ts$", "^src/storage/diagnostic-project\\.ts$", "^src/storage/postgresql/diagnostics\\.ts$", "src/doctor/"],
  },
  {
    component_id: "integration-service-managers",
    name: "Integration - Service Managers and Legacy Migration",
    paths: [
      "^src/daemon/health-observation\\.ts$",
      // #865/#966 convergence and birth budgeting remain lifecycle-owned;
      // #1073 bounds legacy PID/token evidence within that same owner. #1132
      // keeps unscoped detached PID publication lifecycle-owned.
      "^src/daemon/lifecycle-scope\\.ts$",
      "^src/daemon/lifecycle\\.ts$",
      "^src/daemon/managed-credentials\\.ts$",
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
      "^src/storage/postgresql/contracts\\.ts$",
      "^src/storage/postgresql/errors\\.ts$",
      "^src/storage/postgresql/factory\\.ts$",
      "^src/storage/postgresql/index\\.ts$",
      "^src/storage/postgresql/runtime\\.ts$",
      "^src/storage/postgresql/snapshot-session\\.ts$",
      "^src/storage/postgresql\\.ts$",
    ],
  },
  {
    component_id: "integration-postgresql-portable",
    name: "Integration - PostgreSQL Portable Transfer",
    paths: [
      // #618 canonical self-provenance stays in PostgreSQL portable transfer.
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

    expect(productionFiles).toHaveLength(240);

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
    expect(ownershipCounts.size).toBe(240);
  });

  test("keeps response-fence and #681/#700/#701/#703/#705/#709/#710/#713/#756/#726/#734/#737/#742/#760/#763/#804/#805/#824/#825/#833/#888/#864/#866/#722/#786/#952/#814/#882/#930/#969/#989/#1003/#1049/#964/#1106 files in their intended components", () => {
    const config = readCodecovConfig();
    expect(config).toBeDefined();
    if (config === undefined) {
      return;
    }

    const components = validateComponents(configuredComponents(config));
    // #792 keeps grep session filtering and #794 grep-since validation in the
    // existing route component. #862 keeps recent limit validation, #863
    // keeps expand depth validation in the same daemon-routes component.
    // #930 keeps expand body-shape validation in that component as well.
    // #969 keeps the route-family and passive notification body-shape
    // validation in their existing route and daemon-events components.
    // #1217 keeps native snapshot retries, preparation/admission and attempt lifetime route-owned.
    // #888 keeps private final ingest and compact metadata writes route-owned.
    // #890 keeps bounded best-effort status metadata reads route-owned.
    // #1003 keeps preliminary metadata admission daemon-core-owned.
    // #1050 keeps bounded preliminary metadata serialization there too.
    // #1032 keeps the shared private-file writer's retained-parent checks and
    // publication outcomes configuration-security-owned.
    // #947 keeps promote metadata-parent resource handling and fail-closed
    // topology behavior in the existing daemon-routes component.
    // #948 keeps promote metadata parent-first admission, sampled read binding,
    // and retained identity revalidation in the daemon-routes component.
    // #964 keeps the path-bound root/projects/leaf metadata lifetime there too.
    // #1062 keeps retained-parent create-if-absent filesystem semantics in
    // configuration-security and promote collision handling in daemon-routes.
    // #763 manifest and #816 checkpoint negative-zero taxonomies stay storage-abstractions-owned.
    // #814 fresh-root descriptor and pre-handoff content checks remain
    // configuration-security-owned.
    const expectedOwners = [
      // #866 export admission failures and sensitive result emission stay CLI-owned.
      // #1081 keeps unsupported export-format admission CLI-owned.
      // #1088 keeps unsupported connector-list-format admission CLI-owned.
      // #978 keeps compact replacement runtime-digest admission CLI-owned.
      // #1018 keeps bounded canonical lifecycle refusal warnings CLI-owned.
      // #1201 keeps diagnostic identity admission CLI-owned.
      ["bin/lcm.ts", "unit-cli"],
      ["src/config-manager.ts", "unit-configuration-security"],
      ["src/private-mutation-lock.ts", "unit-configuration-security"],
      ["src/home-parent-auth.ts", "unit-configuration-security"],
      // #1041 preserves bootstrap directory authentication errors when
      // descriptor cleanup also fails in this existing owner.
      // #1144 preserves admission callback failures while retaining ordered
      // bootstrap-lock, home, and parent descriptor cleanup evidence here.
      ["src/runtime-paths.ts", "unit-configuration-security"],
      // #1195 strict module-relative asset resolution retains this owner.
      ["src/runtime-root.ts", "unit-configuration-security"],
      ["src/security-files.ts", "unit-configuration-security"],
      ["src/sensitive.ts", "unit-configuration-security"],
      // #1049 keeps project metadata owner and single-link admission here.
      ["src/project-map.ts", "unit-project-worktrees"],
      // #889 keeps private import metadata publication in this owner.
      ["src/portable-knowledge.ts", "unit-project-worktrees"],
      // #866 stats config retries and journal failures, plus #973 project
      // database admission, retain this owner.
      ["src/stats.ts", "unit-memory-retrieval"],
      ["src/connectors/codex-hooks.ts", "unit-connectors"],
      ["src/connectors/installer.ts", "unit-connectors"],
      // #881 absent-config journal admission and #882 post-health identity
      // fencing remain installer-owned.
      ["installer/install.ts", "unit-installation"],
      // #1201 observation parser/client, allowlist and server retain daemon-core ownership.
      ["src/daemon/client.ts", "unit-daemon-core"],
      ["src/daemon/http-url.ts", "unit-daemon-core"],
      ["src/daemon/config.ts", "unit-daemon-core"],
      ["src/daemon/project.ts", "unit-daemon-core"],
      // Compact forwards current operation tokens; SQLite validates handle admission.
      ["src/daemon/routes/compact.ts", "unit-daemon-routes"],
      ["src/daemon/routes/describe.ts", "unit-daemon-routes"],
      ["src/daemon/routes/expand.ts", "unit-daemon-routes"],
      ["src/daemon/routes/ingest.ts", "unit-daemon-routes"],
      ["src/daemon/routes/store.ts", "unit-daemon-routes"],
      ["src/daemon/routes/status.ts", "unit-daemon-routes"],
      ["src/daemon/routes/session-complete.ts", "unit-daemon-routes"],
      ["src/daemon/routes/review-stale.ts", "unit-daemon-routes"],
      // #1148 keeps promoted created_at UTC parsing in the existing daemon
      // routes owner; prompt-search and restore retain their route ownership.
      // #1203 adds native recall evidence without changing component topology.
      ["src/db/promoted-recall-evidence.ts", "unit-local-persistence"],
      ["src/storage/postgresql/tsquery-evidence.ts", "integration-postgresql-search"],
      ["src/storage/contracts.ts", "unit-storage-abstractions"],
      ["src/storage/sqlite/repositories.ts", "unit-local-persistence"],
      ["src/storage/postgresql/lexical-search-repository.ts", "integration-postgresql-search"],
      ["src/daemon/routes/restore.ts", "unit-daemon-routes"],
      ["src/daemon/routes/storage-lifecycle.ts", "unit-daemon-routes"],
      // #833 passive-event identity admission remains route-owned.
      // #1158 keeps passive PostgreSQL promotion route behavior here; its
      // deduplication helper remains owned by unit-promotion.
      ["src/daemon/routes/promote-events.ts", "unit-daemon-routes"],
      // #793 search-limit validation, #863 expand depth validation, and #864
      // search candidate recall remain owned by daemon routes.
      ["src/daemon/routes/search.ts", "unit-daemon-routes"],
      ["src/daemon/routes/grep.ts", "unit-daemon-routes"],
      ["src/daemon/routes/promote.ts", "unit-daemon-routes"],
      ["src/daemon/routes/recent.ts", "unit-daemon-routes"],
      ["src/daemon/passive-event-processor.ts", "unit-daemon-events"],
      // #1153 exact identity and #1158 backend-guarded owner scope remain
      // within the existing promotion component.
      ["src/promotion/dedup.ts", "unit-promotion"],
      // #1106/#618 keep discovery-related files in their established owners.
      ["src/daemon/server.ts", "unit-daemon-core"],
      ["src/import.ts", "unit-transcripts-import"],
      ["src/batch-compact.ts", "unit-compaction-summarization"],
      ["src/daemon/version.ts", "unit-daemon-core"],
      // #885 keeps the shared missing-Codex diagnostic and its resolver
      // identity handling within the existing LLM component. #934 keeps
      // caller-cancellation handling during resolver teardown in this owner.
      // #1154/#1157 retain Spark protocol normalization, bounded upstream
      // classification, and terminal sentinel handling in this owner.
      // #1168 retains accepted HTTP body and SSE failure classification in
      // this LLM-owned component.
      ["src/llm/codex-process.ts", "unit-llm-prompts"],
      ["src/llm/codex-config.ts", "unit-llm-prompts"],
      ["src/llm/codex-responses-gateway.ts", "unit-llm-prompts"],
      ["src/llm/process-utils.ts", "unit-llm-prompts"],
      // #997 keeps doctor publication retry deadlines monotonic in this owner.
      // #619 keeps observational doctor refusal guidance in this owner.
      // #1201 identity observation and unverified queue readiness retain this owner.
      ["src/doctor/doctor.ts", "unit-diagnostics"],
      // #944/#950/#966 keep typed daemon-tmp diagnostics, authenticated restart
      // convergence, and bounded birth samples in the service-manager component.
      ["src/daemon/lifecycle-scope.ts", "integration-service-managers"],
      ["src/daemon/lifecycle.ts", "integration-service-managers"],
      ["src/daemon/supervisor.ts", "integration-service-managers"],
      // #837 consumer-admission descriptor cleanup remains storage-owned.
      // #1042 consumer descriptor cleanup and typed error classification remain storage-owned.
      ["src/storage/backend-publication.ts", "unit-storage-abstractions"],
      ["src/storage/local-hook-outbox-schema.ts", "unit-local-event-storage"],
      ["src/migration/manifest-store.ts", "unit-migration-cutover"],
      ["src/migration/maintenance.ts", "unit-migration-cutover"],
      ["src/migration/receipts.ts", "unit-migration-cutover"],
      ["src/migration/queue-evidence.ts", "unit-migration-cutover"],
      ["src/migration/sqlite-snapshot.ts", "unit-migration-cutover"],
      ["src/storage/contracts.ts", "unit-storage-abstractions"],
      ["src/storage/portable-record-stream.ts", "unit-storage-abstractions"],
      ["src/storage/postgresql/factory.ts", "integration-postgresql-runtime"],
      // #1195 checksummed packaged migration loading remains schema-owned.
      ["src/storage/postgresql/migrations.ts", "integration-postgresql-schema"],
      ["src/storage/postgresql/memory-repositories.ts", "integration-postgresql-memory"],
      ["src/storage/postgresql/summary-context-repositories.ts", "integration-postgresql-memory"],
      // #989 event-sidecar parent authentication stays local-persistence-owned.
      // #1101 numeric skipped-sidecar counts stay local-persistence-owned.
      ["src/db/event-sidecars.ts", "unit-local-persistence"],
      ["src/db/diagnostic-sqlite.ts", "unit-local-persistence"],
      ["src/db/diagnostic-sqlite-worker.ts", "unit-local-persistence"],
      // #619 retained daemon pool observations stay diagnostics-owned.
      ["src/storage/diagnostics.ts", "unit-diagnostics"],
      ["src/storage/diagnostic-renderer.ts", "unit-diagnostics"],
      ["src/storage/diagnostic-project.ts", "unit-diagnostics"],
      ["src/storage/postgresql/diagnostics.ts", "unit-diagnostics"],
      // #992 keeps pre-initialization SQLite leaf admission and final
      // opened-identity fencing local-persistence-owned.
      ["src/db/connection.ts", "unit-local-persistence"],
      ["src/db/database-parent.ts", "unit-local-persistence"],
      // Retained-handle token scopes and fresh factory health remain local persistence.
      ["src/storage/sqlite/factory.ts", "unit-local-persistence"],
      ["src/storage/sqlite/project-storage.ts", "unit-local-persistence"],
      // #1020 keeps message timestamp mapping in the existing local-persistence
      // component; conversation timestamps remain on their existing mapper.
      ["src/store/conversation-store.ts", "unit-local-persistence"],
      ["src/db/stored-timestamp.ts", "unit-local-persistence"],
      ["src/hooks/event-scrubbing.ts", "unit-hooks"],
      ["src/hooks/post-tool.ts", "unit-hooks"],
      ["src/hooks/publication-fence.ts", "unit-hooks"],
      // #1155 retains SessionStart outbox pruning admission in the hook owner.
      ["src/hooks/restore.ts", "unit-hooks"],
      // Bounded Claude completion delivery remains within the hook component.
      ["src/hooks/session-end.ts", "unit-hooks"],
      // #793 search-limit schema remains owned by MCP tools.
      ["src/mcp/tools/lcm-search.ts", "unit-mcp"],
      ["src/mcp/tools/lcm-grep.ts", "unit-mcp"],
      // #863 expand-depth schema remains owned by MCP tools.
      ["src/mcp/tools/lcm-expand.ts", "unit-mcp"],
      // #972 search cwd client typing remains memory/retrieval-owned.
      ["src/memory/index.ts", "unit-memory-retrieval"],
      // #793 shared search-limit contract remains retrieval-owned.
      ["src/retrieval.ts", "unit-memory-retrieval"],
    ] as const;

    for (const [file, expectedOwner] of expectedOwners) {
      expect(productionFiles).toContain(file);
      const owners = components
        .filter((component) => component.ownershipPaths.some((path) => matchesOwnershipPath(file, path)))
        .map((component) => component.component_id);
      expect(owners).toEqual([expectedOwner]);
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
  test("requires the Codecov files to be updated atomically when classification can become stale", () => {
    const agents = readFileSync(join(projectRoot, "AGENTS.md"), "utf8");

    expect(agents).toMatch(
      /Update `codecov\.yml` and `test\/codecov-config\.test\.ts` atomically whenever\s+production TypeScript, features, or components are added, removed, moved,\s+materially changed, or otherwise make classification stale\./,
    );
  });
});
