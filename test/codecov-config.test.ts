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
    paths: ["bin/", "src/cli/", "^src/cli-help\\.ts$"],
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
      "^src/generated-patterns\\.ts$",
      "^src/home-parent-auth\\.ts$",
      "^src/legacy-names\\.ts$",
      "^src/private-mutation-lock\\.ts$",
      "^src/runtime-paths\\.ts$",
      "^src/runtime-root\\.ts$",
      "^src/scrub\\.ts$",
      "^src/secret-key\\.ts$",
      "^src/security-files\\.ts$",
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
      "^src/daemon/project\\.ts$",
      // Monotonic proxy startup polling remains daemon-core-owned.
      "^src/daemon/proxy-manager\\.ts$",
      "^src/daemon/remediation\\.ts$",
      // Error sanitization, including #893 adjacent-path redaction, remains daemon-core-owned.
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
    paths: ["src/db/", "src/storage/sqlite/", "src/store/"],
  },
  {
    component_id: "unit-storage-abstractions",
    name: "Unit - Storage Abstractions",
    paths: [
      // #906 keeps bounded publication-convergence probe expiry and error
      // selection in this storage-abstractions owner.
      "^src/storage/backend\\.ts$",
      // #844 keeps coordinator directory-witness authentication in this owner.
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
      "^src/storage/portable-record\\.ts$",
      "^src/storage/portable-record-stream\\.ts$",
      "^src/storage/postgresql/project-storage\\.ts$",
    ],
  },
  {
    component_id: "unit-migration-cutover",
    name: "Unit - Migration and Cutover",
    paths: ["src/migration/"],
  },
  {
    component_id: "unit-local-event-storage",
    name: "Unit - Local Event Storage",
    paths: [
      "^src/storage/local-hook-event-sequence\\.ts$",
      "^src/storage/local-hook-outbox\\.ts$",
      "^src/storage/session-instructions\\.ts$",
    ],
  },
  {
    component_id: "unit-transcripts-import",
    name: "Unit - Transcripts and Import",
    paths: [
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
      // remain memory/retrieval-owned.
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
      "^src/batch-compact\\.ts$",
      "^src/compaction\\.ts$",
      "^src/large-files\\.ts$",
      "^src/summarize\\.ts$",
    ],
  },
  {
    component_id: "unit-promotion",
    name: "Unit - Promotion",
    paths: ["src/promotion/"],
  },
  {
    component_id: "unit-project-worktrees",
    name: "Unit - Projects and Worktrees",
    paths: [
      "^src/codex-project-resolution\\.ts$",
      "^src/git-project\\.ts$",
      "^src/machine-identity\\.ts$",
      "^src/portable-knowledge\\.ts$",
      "^src/project-map\\.ts$",
      "^src/worktree-reconciliation-fence\\.ts$",
      "^src/worktree-reconciliation\\.ts$",
    ],
  },
  {
    component_id: "unit-diagnostics",
    name: "Unit - Diagnostics",
    paths: ["^src/diagnose\\.ts$", "src/doctor/"],
  },
  {
    component_id: "integration-service-managers",
    name: "Integration - Service Managers and Legacy Migration",
    paths: [
      "^src/daemon/health-observation\\.ts$",
      // #865 convergence and #966 birth-sample budgeting remain lifecycle-owned.
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
      "^src/storage/postgresql\\.ts$",
    ],
  },
  {
    component_id: "integration-postgresql-schema",
    name: "Integration - PostgreSQL Schema",
    paths: [
      "^src/storage/postgresql/extensions\\.ts$",
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
  test("matches the literal 30-component ownership contract", () => {
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

    expect(components).toHaveLength(30);
    expect(new Set(componentIds).size).toBe(componentIds.length);
    expect(new Set(componentNames).size).toBe(componentNames.length);
    expect(new Set(ownershipPaths).size).toBe(ownershipPaths.length);

    for (const path of ownershipPaths) {
      expect(isSafeOwnershipPath(path)).toBe(true);
    }

    expect(productionFiles).toHaveLength(209);

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
    expect(ownershipCounts.size).toBe(209);
  });

  test("keeps response-fence and #681/#700/#701/#703/#705/#709/#710/#713/#756/#726/#734/#737/#742/#760/#763/#804/#805/#824/#825/#833/#888/#864/#866/#722/#786/#952/#814/#882/#930/#969/#1003 files in their intended components", () => {
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
    // #888 keeps private final ingest and compact metadata writes route-owned.
    // #890 keeps bounded best-effort status metadata reads route-owned.
    // #1003 keeps preliminary metadata admission daemon-core-owned.
    // #947 keeps promote metadata-parent resource handling and fail-closed
    // topology behavior in the existing daemon-routes component.
    // #948 keeps promote metadata parent-first admission, sampled read binding,
    // and retained identity revalidation in the daemon-routes component.
    // #763 manifest and #816 checkpoint negative-zero taxonomies stay storage-abstractions-owned.
    // #814 fresh-root descriptor and pre-handoff content checks remain
    // configuration-security-owned.
    const expectedOwners = [
      // #866 export admission failures and sensitive result emission stay CLI-owned.
      // #978 keeps compact replacement runtime-digest admission CLI-owned.
      ["bin/lcm.ts", "unit-cli"],
      ["src/config-manager.ts", "unit-configuration-security"],
      ["src/private-mutation-lock.ts", "unit-configuration-security"],
      ["src/home-parent-auth.ts", "unit-configuration-security"],
      ["src/runtime-paths.ts", "unit-configuration-security"],
      ["src/security-files.ts", "unit-configuration-security"],
      ["src/sensitive.ts", "unit-configuration-security"],
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
      ["src/daemon/client.ts", "unit-daemon-core"],
      ["src/daemon/config.ts", "unit-daemon-core"],
      ["src/daemon/project.ts", "unit-daemon-core"],
      ["src/daemon/routes/compact.ts", "unit-daemon-routes"],
      ["src/daemon/routes/describe.ts", "unit-daemon-routes"],
      ["src/daemon/routes/expand.ts", "unit-daemon-routes"],
      ["src/daemon/routes/ingest.ts", "unit-daemon-routes"],
      ["src/daemon/routes/store.ts", "unit-daemon-routes"],
      ["src/daemon/routes/status.ts", "unit-daemon-routes"],
      ["src/daemon/routes/session-complete.ts", "unit-daemon-routes"],
      ["src/daemon/routes/review-stale.ts", "unit-daemon-routes"],
      ["src/daemon/routes/restore.ts", "unit-daemon-routes"],
      ["src/daemon/routes/storage-lifecycle.ts", "unit-daemon-routes"],
      // #833 passive-event identity admission remains route-owned.
      ["src/daemon/routes/promote-events.ts", "unit-daemon-routes"],
      // #793 search-limit validation, #863 expand depth validation, and #864
      // search candidate recall remain owned by daemon routes.
      ["src/daemon/routes/search.ts", "unit-daemon-routes"],
      ["src/daemon/routes/grep.ts", "unit-daemon-routes"],
      ["src/daemon/routes/promote.ts", "unit-daemon-routes"],
      ["src/daemon/routes/recent.ts", "unit-daemon-routes"],
      ["src/daemon/passive-event-processor.ts", "unit-daemon-events"],
      ["src/daemon/server.ts", "unit-daemon-core"],
      ["src/daemon/version.ts", "unit-daemon-core"],
      // #885 keeps the shared missing-Codex diagnostic and its resolver
      // identity handling within the existing LLM component.
      ["src/llm/codex-process.ts", "unit-llm-prompts"],
      ["src/llm/codex-config.ts", "unit-llm-prompts"],
      ["src/llm/codex-responses-gateway.ts", "unit-llm-prompts"],
      ["src/llm/process-utils.ts", "unit-llm-prompts"],
      // #997 keeps doctor publication retry deadlines monotonic in this owner.
      ["src/doctor/doctor.ts", "unit-diagnostics"],
      // #944 keeps typed supervisor daemon-tmp diagnostic propagation within
      // the existing service-manager component.
      ["src/daemon/lifecycle-scope.ts", "integration-service-managers"],
      ["src/daemon/lifecycle.ts", "integration-service-managers"],
      ["src/daemon/supervisor.ts", "integration-service-managers"],
      // #837 consumer-admission descriptor cleanup remains storage-owned.
      ["src/storage/backend-publication.ts", "unit-storage-abstractions"],
      ["src/migration/manifest-store.ts", "unit-migration-cutover"],
      ["src/storage/contracts.ts", "unit-storage-abstractions"],
      ["src/storage/portable-record-stream.ts", "unit-storage-abstractions"],
      ["src/storage/postgresql/factory.ts", "integration-postgresql-runtime"],
      ["src/storage/postgresql/memory-repositories.ts", "integration-postgresql-memory"],
      ["src/storage/postgresql/summary-context-repositories.ts", "integration-postgresql-memory"],
      // #992 keeps pre-initialization SQLite leaf admission and final
      // opened-identity fencing local-persistence-owned.
      ["src/db/connection.ts", "unit-local-persistence"],
      ["src/db/database-parent.ts", "unit-local-persistence"],
      ["src/storage/sqlite/factory.ts", "unit-local-persistence"],
      ["src/hooks/event-scrubbing.ts", "unit-hooks"],
      ["src/hooks/post-tool.ts", "unit-hooks"],
      ["src/hooks/publication-fence.ts", "unit-hooks"],
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
