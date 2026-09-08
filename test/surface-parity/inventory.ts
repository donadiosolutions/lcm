/** Test-owned discovery. Updating the file never classifies a new public surface implicitly. */
import { deepStrictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import ts from "typescript";
import { vi } from "vitest";
import { runCli } from "../../bin/lcm.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createDaemon, type DaemonInstance } from "../../src/daemon/server.js";
import { getMcpToolDefinitions } from "../../src/mcp/server.js";
import { EXPORT_VERSION } from "../../src/portable-knowledge.js";
import {
  PORTABLE_RECORD_DOMAIN_ORDER,
  PORTABLE_RECORD_SCHEMA_DESCRIPTOR,
  PORTABLE_RECORD_SCHEMA_SHA256,
} from "../../src/storage/portable-record.js";
import * as portableRuntime from "../../src/storage/portable.js";

export const matrixPath = fileURLToPath(new URL("./surface-matrix.json", import.meta.url));
const sourceText = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
export type SurfaceKind = "cli" | "daemon" | "mcp" | "native-import" | "knowledge" | "portable-domain" | "portable-api";
export type Expectation = "shared-data" | "backend-independent-control" | "architecture-specific" | "grammar";
export type Direction = "sqlite->sqlite" | "sqlite->postgresql" | "postgresql->sqlite" | "postgresql->postgresql";
export interface DiscoveredSurface {
  id: string;
  kind: SurfaceKind;
  registration: Record<string, unknown>;
  source: string;
}
export interface ScenarioOwner {
  scenario: string;
  assertions: readonly string[];
  expectation: Expectation;
  architectureReason?: string;
  directions?: readonly Direction[];
}
export interface SurfaceRow extends DiscoveredSurface, ScenarioOwner {}

/** Disjoint full paths, not Commander short-name matches. Root is in addition to the 59 rows. */
export const CLI_SCENARIO_PATHS = {
  control: ["<root>", "help", "daemon", "config", "events", "machine", "project", "postgres", "connectors", "daemon start", "daemon restart", "config get", "config set", "install", "uninstall", "mcp", "connectors list", "connectors install", "connectors remove", "connectors doctor"],
  memory: ["search", "grep", "describe", "expand", "store"],
  compaction: ["compact"],
  hooks: ["restore", "session-end", "user-prompt", "post-tool", "session-snapshot"],
  diagnostics: ["status", "stats", "doctor", "diagnose"],
  events: ["events promote", "events status", "events validate", "events quarantine", "events replay"],
  identity: ["machine register", "machine show", "machine recover", "project reconcile-worktrees", "project list", "project show", "project link", "project unlink", "project create"],
  admin: ["postgres migrate"],
  sensitive: ["sensitive", "sensitive list", "sensitive add", "sensitive remove", "sensitive test", "sensitive purge"],
  "native-import": ["import"],
  knowledge: ["export", "import-knowledge"],
  promotion: ["promote"],
} as const;

const GROUP_PATHS = new Set(["<root>", "help", "daemon", "config", "events", "machine", "project", "postgres", "connectors"]);
const ALL_DIRECTIONS: readonly Direction[] = ["sqlite->sqlite", "sqlite->postgresql", "postgresql->sqlite", "postgresql->postgresql"];
const EXPECTED_DOMAINS = [
  "machines", "project", "project-aliases", "conversations", "messages", "message-parts", "large-files", "summaries", "summary-file-links", "summary-message-links", "summary-parent-links", "context-items", "promoted-memories", "promoted-memory-tags", "recall-surfacings", "redaction-counters", "session-ingest", "session-instructions", "native-transcripts", "native-transcript-message-links", "native-transcript-checkpoints", "passive-events",
] as const;
const EXPECTED_PORTABLE_APIS = [
  "PORTABLE_LIMITS", "PORTABLE_RECORD_DOMAIN_ORDER", "PORTABLE_RECORD_SCHEMA_SHA256", "PortableStreamError", "canonicalJson", "canonicalSha256", "createPortableRecord", "createPortableRecordStream", "parsePortableCheckpoint", "parsePortableManifest", "parsePortableRecord", "serializePortableCheckpoint", "serializePortableManifest", "serializePortableRecord", "verifyPortableCheckpoint", "PortableTransferError", "runPortableTransfer", "openSqlitePortableSource", "sqlitePortableFileSha256", "openSqlitePortableDestination", "createPostgreSqlPortableDestination", "createPostgreSqlPortableSource",
] as const;
const DAEMON_SCENARIOS: Record<string, string> = {
  "GET /health": "diagnostics",
  "GET /health/observe": "diagnostics",
  "POST /compact": "compaction",
  "POST /promote": "promotion",
  "POST /restore": "memory",
  "POST /grep": "memory",
  "POST /search": "memory",
  "POST /expand": "memory",
  "POST /describe": "memory",
  "POST /store": "memory",
  "POST /recent": "memory",
  "POST /ingest": "memory",
  "POST /prompt-search": "memory",
  "POST /session-complete": "compaction",
  "POST /promote-events": "events",
  "POST /promote-events/all": "events",
  "POST /promote-events/notify": "events",
  "GET /stats": "diagnostics",
  "GET /stats/pool": "diagnostics",
  "POST /review-stale": "promotion",
  "POST /invocation-control": "compaction",
  "POST /status": "diagnostics",
};

/** Fault scenarios contribute assertion receipts to existing owners, never extra rows. */
export const FAULT_ASSERTION_OWNERS = {
  "fault-pool": [{ id: "daemon:POST /search", assertion: "pool-exhaustion" }],
  "fault-cancellation": [{ id: "daemon:POST /search", assertion: "cancellation" }, { id: "daemon:POST /compact", assertion: "cancellation" }],
  "fault-denial": [
    { id: "daemon:POST /search", assertion: "backend-denial" },
    { id: "cli:search", assertion: "backend-denial" },
    { id: "cli:stats", assertion: "backend-denial" },
    { id: "cli:doctor", assertion: "backend-denial" },
    { id: "mcp:lcm_search", assertion: "backend-denial" },
    { id: "mcp:lcm_stats", assertion: "backend-denial" },
    { id: "mcp:lcm_doctor", assertion: "backend-denial" },
  ],
  "fault-unavailable": [{ id: "daemon:GET /health", assertion: "startup-unavailable" }],
} as const;

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}
function exactKeys(actual: readonly string[], expected: readonly string[], label: string): void {
  unique(actual, label);
  unique(expected, label);
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`Inventory ${label} differs: missing=${expected.filter((id) => !actual.includes(id)).join(",")} extra=${actual.filter((id) => !expected.includes(id)).join(",")}`);
  }
}

function makeScenarioMap(): Record<string, ScenarioOwner> {
  const entries: Array<[string, ScenarioOwner]> = [];
  for (const [scenario, paths] of Object.entries(CLI_SCENARIO_PATHS)) {
    for (const path of paths) {
      let expectation: Expectation = scenario === "control" ? "backend-independent-control" : "shared-data";
      let architectureReason: string | undefined;
      if (GROUP_PATHS.has(path)) expectation = "grammar";
      if (path === "sensitive purge") {
        expectation = "architecture-specific";
        architectureReason = "src/sensitive.ts:sensitivePurge: SQLite purges the owned local project; PostgreSQL refuses with StorageBackendUnavailableError because a local purge cannot remove durable PostgreSQL data.";
      } else if (["identity", "events", "admin"].includes(scenario)) {
        expectation = "architecture-specific";
        architectureReason = "bin/lcm.ts identity/events/postgres handlers and docs/cli.md: PostgreSQL registration and event administration require configured PostgreSQL authority; assert the documented SQLite counterpart result or refusal.";
      } else if (scenario === "hooks") {
        expectation = "architecture-specific";
        architectureReason = "src/hooks/ and docs/cli.md: native hook capture uses the local SQLite outbox with either configured backend; durable project writes remain on the selected backend.";
      } else if (scenario === "diagnostics") {
        expectation = "architecture-specific";
        architectureReason = "src/storage/diagnostic-renderer.ts and docs/cli.md: assert shared sanitized diagnostic fields plus the declared backend identity and pool shape; no repair side effects.";
      }
      entries.push([`cli:${path}`, {
        scenario,
        assertions: scenario === "control" ? ["grammar", "result", "effects"] : ["arguments", "result", "effects"],
        expectation,
        ...(architectureReason ? { architectureReason } : {}),
      }]);
    }
  }
  for (const [route, scenario] of Object.entries(DAEMON_SCENARIOS)) {
    entries.push([`daemon:${route}`, {
      scenario,
      assertions: ["admission", "result", "effects"],
      expectation: scenario === "diagnostics" ? "architecture-specific" : "shared-data",
      ...(scenario === "diagnostics" ? { architectureReason: route === "GET /health"
        ? "src/daemon/server.ts and src/storage/sqlite/factory.ts: authenticated health is active storage readiness, distinct from read-only statistical snapshots. Compare logical data, schema, user_version, journal mode and authority while separately reporting authenticated existing-SQLite engine bookkeeping; missing databases remain missing. Public unauthenticated health is liveness only."
        : route === "GET /health/observe"
          ? "src/daemon/server.ts and src/daemon/client.ts: authenticated observation verifies process identity only and reports storage status unverified. Assert admission, stable selected-backend identity and the strict read-only contract; it neither probes nor certifies active storage readiness."
        : "src/daemon/server.ts and src/storage/diagnostic-renderer.ts: diagnostics expose the configured backend and backend-specific pool shape while preserving the shared sanitized result and read-only contract." } : {}),
    }]);
  }
  for (const name of ["lcm_grep", "lcm_expand", "lcm_describe", "lcm_search", "lcm_store", "lcm_stats", "lcm_doctor"]) {
    const local = name === "lcm_stats" || name === "lcm_doctor";
    entries.push([`mcp:${name}`, {
      scenario: local ? "diagnostics" : "memory",
      assertions: ["schema", "result"],
      expectation: local ? "architecture-specific" : "shared-data",
      ...(local ? { architectureReason: "src/mcp/server.ts local diagnostic handlers and src/storage/diagnostic-renderer.ts: report the configured backend snapshot and assert backend-specific pool fields without mutation." } : {}),
    }]);
  }
  for (const provider of ["claude", "codex", "all"]) {
    entries.push([`native-import:${provider}`, { scenario: "native-import", assertions: ["dispatch", "result", "effects"], expectation: "shared-data" }]);
  }
  entries.push(["knowledge:v1", { scenario: "knowledge", assertions: ["version", "result", "effects"], expectation: "shared-data" }]);
  for (const domain of EXPECTED_DOMAINS) {
    entries.push([`portable-domain:${domain}`, { scenario: "transfer", assertions: ["populated", "roundtrip", "native-readback"], expectation: "shared-data", directions: ALL_DIRECTIONS }]);
  }
  for (const name of EXPECTED_PORTABLE_APIS) {
    const applicable: Partial<Record<typeof EXPECTED_PORTABLE_APIS[number], readonly Direction[]>> = {
      openSqlitePortableSource: ["sqlite->sqlite", "sqlite->postgresql"],
      sqlitePortableFileSha256: ["sqlite->sqlite", "sqlite->postgresql"],
      openSqlitePortableDestination: ["sqlite->sqlite", "postgresql->sqlite"],
      createPostgreSqlPortableSource: ["postgresql->sqlite", "postgresql->postgresql"],
      createPostgreSqlPortableDestination: ["sqlite->postgresql", "postgresql->postgresql"],
    };
    const assertions = name === "runPortableTransfer"
      ? ["contract", "resume", "replay"]
      : name === "openSqlitePortableDestination" || name === "createPostgreSqlPortableDestination"
        ? ["contract", "mismatch-refusal"]
        : ["contract"];
    entries.push([`portable-api:${name}`, { scenario: "transfer", assertions, expectation: "shared-data", directions: applicable[name] ?? ALL_DIRECTIONS }]);
  }
  unique(entries.map(([id]) => id), "scenario ownership");
  const owners = Object.fromEntries(entries);
  for (const id of ["cli:grep", "daemon:POST /grep", "mcp:lcm_grep"]) {
    owners[id].expectation = "architecture-specific";
    owners[id].architectureReason = "src/storage/postgresql/reference/postgresql-search.md: PostgreSQL full-text snippets expose normalized search text while SQLite preserves source spelling. Assert each actual mode-specific counterpart, shared message membership and ordering, and exact canonical Unicode through native readback and regex retrieval.";
  }
  for (const id of ["cli:stats", "daemon:GET /stats", "mcp:lcm_stats"]) {
    const reason = "src/stats.ts and src/storage/postgresql/diagnostics.ts: PostgreSQL numeric metrics omit per-conversation details; SQLite statistics include native conversation detail. Assert the actual absent field or native detail membership and the corresponding rendered capability, while preserving exact common aggregate counters.";
    owners[id].architectureReason = [owners[id].architectureReason, reason].filter(Boolean).join(" ");
  }
  const faults = Object.values(FAULT_ASSERTION_OWNERS).flat();
  for (const { id, assertion } of faults) {
    const owner = owners[id];
    if (!owner) throw new Error(`Unclassified fault owner ${id}`);
    owner.assertions = [...owner.assertions, assertion];
    const reason = "src/storage/backend.ts, src/storage/postgresql/runtime.ts and src/daemon/server.ts: baseline data semantics remain shared; fault variants assert PostgreSQL pool/grant/unavailable outcomes and the explicit SQLite healthy or abort-aware counterpart. Cancellation is bounded and must release resources on both backends.";
    if (!owner.architectureReason?.includes(reason)) {
      owner.architectureReason = [owner.architectureReason, reason].filter(Boolean).join(" ");
    }
  }
  return owners;
}
export const scenarioMap = makeScenarioMap();

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, stableValue(item)]));
  }
  if (value === undefined) return null;
  if (["function", "symbol", "bigint"].includes(typeof value)) throw new Error("Non-JSON registration value");
  return value;
}
export function registrationFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}
export function renderMatrix(discovered: readonly DiscoveredSurface[], owners: Readonly<Record<string, ScenarioOwner>> = scenarioMap): string {
  exactKeys(discovered.map((row) => row.id), Object.keys(owners), "scenario coverage");
  const rows = discovered.map((row): SurfaceRow => {
    const owner = owners[row.id];
    if (!owner.scenario || owner.assertions.length === 0 || owner.assertions.some((id) => !id)) throw new Error(`Missing assertions for ${row.id}`);
    unique(owner.assertions, `assertions for ${row.id}`);
    if (owner.expectation === "architecture-specific" && !owner.architectureReason) throw new Error(`Missing architecture contract for ${row.id}`);
    if (owner.scenario === "transfer") {
      if (!owner.directions?.length || owner.directions.some((direction) => !ALL_DIRECTIONS.includes(direction))) throw new Error(`Invalid transfer directions for ${row.id}`);
      unique(owner.directions, `directions for ${row.id}`);
    }
    const aliases = row.kind === "cli" ? row.registration.aliases : undefined;
    const assertions = Array.isArray(aliases) && aliases.length > 0 && !owner.assertions.includes("alias-dispatch")
      ? [...owner.assertions, "alias-dispatch"]
      : owner.assertions;
    return { ...row, ...owner, assertions };
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return `${JSON.stringify(stableValue(rows), null, 2)}\n`;
}
export function assertMatrixMatches(discovered: readonly DiscoveredSurface[], matrix: readonly SurfaceRow[]): void {
  exactKeys(discovered.map((row) => row.id), matrix.map((row) => row.id), "aggregate");
  for (const kind of new Set([...discovered, ...matrix].map((row) => row.kind))) {
    exactKeys(discovered.filter((row) => row.kind === kind).map((row) => row.id), matrix.filter((row) => row.kind === kind).map((row) => row.id), kind);
  }
  deepStrictEqual(stableValue(matrix), JSON.parse(renderMatrix(discovered)));
}

function parseSource(text: string): ts.SourceFile {
  const source = ts.createSourceFile("inventory-source.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) throw new Error("Invalid inventory source syntax");
  return source;
}
function exported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}
function exportedFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const functions = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name && exported(node));
  if (functions.length !== 1 || !functions[0].body) throw new Error(`Missing or ambiguous exported ${name}`);
  return functions[0];
}
export function extractSensitiveOperations(text: string): string[] {
  const source = parseSource(text);
  const handler = exportedFunction(source, "handleSensitive");
  const switches = handler.body!.statements.filter(ts.isSwitchStatement);
  if (switches.length !== 1 || !ts.isIdentifier(switches[0].expression) || switches[0].expression.text !== "sub") throw new Error("Ambiguous sensitive dispatch");
  const selector = handler.body!.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]).find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "sub");
  if (selector?.initializer?.getText(source) !== "argv[0]") throw new Error("Unknown sensitive selector");
  const operations = switches[0].caseBlock.clauses.filter(ts.isCaseClause).map((clause) => {
    if (!ts.isStringLiteral(clause.expression)) throw new Error("Nonliteral sensitive dispatch");
    return clause.expression.text;
  });
  if (!operations.length) throw new Error("Missing sensitive operations");
  unique(operations, "sensitive operations");
  return operations;
}

export function extractNativeImportProviders(text: string): { providers: string[]; dispatch: string[][] } {
  const source = parseSource(text);
  const declarations = source.statements.filter((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === "ImportProvider" && exported(node));
  if (declarations.length !== 1 || !ts.isUnionTypeNode(declarations[0].type)) throw new Error("Unknown import provider declaration");
  const providers = declarations[0].type.types.map((node) => {
    if (!ts.isLiteralTypeNode(node) || !ts.isStringLiteral(node.literal)) throw new Error("Nonliteral import provider");
    return node.literal.text;
  });
  unique(providers, "import providers");
  const handler = exportedFunction(source, "importSessions");
  function referencesProvider(node: ts.Node): boolean {
    if (ts.isIdentifier(node) && node.text === "provider") return true;
    return ts.forEachChild(node, referencesProvider) ?? false;
  }
  function literals(node: ts.Expression): string[] {
    if (ts.isParenthesizedExpression(node)) return literals(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) return [...literals(node.left), ...literals(node.right)];
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && ts.isIdentifier(node.left) && node.left.text === "provider" && ts.isStringLiteral(node.right)) return [node.right.text];
    throw new Error("Unknown native import dispatch expression");
  }
  const dispatch = handler.body!.statements.filter(ts.isIfStatement).filter((node) => referencesProvider(node.expression)).map((node) => literals(node.expression));
  if (!dispatch.length) throw new Error("Missing native import dispatch");
  exactKeys([...new Set(dispatch.flat())], providers, "native import dispatch");
  dispatch.forEach((branch) => unique(branch, "native import branch"));
  return { providers, dispatch };
}

interface ExportEntry { name: string; imported: string; module: string | null }
export function extractPortableExports(text: string): { runtime: ExportEntry[]; declarations: ExportEntry[] } {
  const source = parseSource(text);
  const runtime: ExportEntry[] = [];
  const declarations: ExportEntry[] = [];
  for (const node of source.statements) {
    if (ts.isExportDeclaration(node)) {
      if (!node.exportClause || !ts.isNamedExports(node.exportClause)) throw new Error("Unclassified wildcard or namespace portable export");
      if (node.moduleSpecifier && !ts.isStringLiteral(node.moduleSpecifier)) throw new Error("Nonliteral portable export module");
      for (const item of node.exportClause.elements) {
        const entry = { name: item.name.text, imported: item.propertyName?.text ?? item.name.text, module: node.moduleSpecifier ? (node.moduleSpecifier as ts.StringLiteral).text : null };
        (node.isTypeOnly || item.isTypeOnly ? declarations : runtime).push(entry);
      }
    } else if (exported(node)) {
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) throw new Error("Unclassified destructured portable export");
          runtime.push({ name: declaration.name.text, imported: declaration.name.text, module: null });
        }
      } else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
        if (!node.name) throw new Error("Unnamed portable export");
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) ? declarations : runtime).push({ name: node.name.text, imported: node.name.text, module: null });
      } else {
        throw new Error("Unclassified public portable declaration");
      }
    } else if (ts.isExportAssignment(node)) {
      throw new Error("Unclassified portable default export");
    }
  }
  unique(runtime.map((entry) => entry.name), "portable runtime exports");
  unique(declarations.map((entry) => entry.name), "portable declarations");
  if (!runtime.length) throw new Error("Missing portable runtime exports");
  return { runtime, declarations };
}

export function extractCustomHelpGrammar(cliText: string, helpText: string): Record<string, unknown> {
  const cli = parseSource(cliText);
  const resolver = cli.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "resolveCustomHelpRequest");
  if (resolver.length !== 1 || !resolver[0].body) throw new Error("Missing custom help resolver");
  const literals: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) && node.text.startsWith("-")) literals.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(resolver[0]);
  const help = parseSource(helpText);
  const definitions = help.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]).filter((node) => ts.isIdentifier(node.name) && node.name.text === "HELP");
  if (definitions.length !== 1 || !definitions[0].initializer || !ts.isObjectLiteralExpression(definitions[0].initializer)) throw new Error("Missing custom help topics");
  const topics = definitions[0].initializer.properties.map((property) => {
    if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) throw new Error("Unclassified help topic");
    return property.name.text;
  });
  unique(topics, "help topics");
  const flags = [...new Set(literals)].sort();
  if (!flags.includes("--help") || !flags.includes("-h") || !flags.includes("--")) throw new Error("Unknown custom help grammar");
  return { flags, topics, resolverSha256: registrationFingerprint(ts.createPrinter({ removeComments: true }).printNode(ts.EmitHint.Unspecified, resolver[0], cli)) };
}

/** Observe final linked tree once; no parse, preAction, bootstrap or command action runs. */
export async function discoverCli(run: typeof runCli = runCli): Promise<DiscoveredSurface[]> {
  let root: Command | undefined;
  let calls = 0;
  const spy = vi.spyOn(Command.prototype, "parseAsync").mockImplementation(async function (this: Command) {
    calls += 1;
    root = this;
    return this;
  });
  try {
    await run(["node", "lcm", "__inventory__"]);
    if (calls !== 1 || !root) throw new Error("Commander observer must fire exactly once");
    return inspectCommanderTree(root);
  } finally {
    spy.mockRestore();
  }
}
export function inspectCommanderTree(root: Command): DiscoveredSurface[] {
  const rows: DiscoveredSurface[] = [];
  const seen = new Set<Command>();
  function visit(command: Command, ancestors: readonly string[]): void {
    if (seen.has(command)) throw new Error("Duplicate or cyclic Commander node");
    seen.add(command);
    const path = command === root ? "<root>" : [...ancestors, command.name()].join(" ");
    const internal = command as Command & { _actionHandler?: unknown; _defaultCommandName?: string };
    rows.push({
      id: `cli:${path}`, kind: "cli", source: "bin/lcm.ts:runCli",
      registration: {
        path,
        name: command.name(),
        aliases: command.aliases(),
        arguments: command.registeredArguments.map((argument) => ({ name: argument.name(), required: argument.required, variadic: argument.variadic, default: argument.defaultValue ?? null, choices: argument.argChoices ?? null })),
        options: command.options.map((option) => ({ flags: option.flags, short: option.short ?? null, long: option.long ?? null, required: option.required, optional: option.optional, mandatory: option.mandatory, negate: option.negate, variadic: option.variadic ?? false, default: option.defaultValue ?? null, preset: option.presetArg ?? null, choices: option.argChoices ?? null, hidden: option.hidden })),
        handler: typeof internal._actionHandler === "function",
        defaultCommand: internal._defaultCommandName ?? null,
        children: command.commands.map((child) => child.name()),
      },
    });
    for (const child of command.commands) {
      if (child.parent !== command) throw new Error("Detached Commander child");
      visit(child, command === root ? [] : [...ancestors, command.name()]);
    }
  }
  visit(root, []);
  unique(rows.map((row) => row.id), "Commander paths");
  return rows;
}

export async function discoverDaemonRoutes(): Promise<DiscoveredSurface[]> {
  const home = mkdtempSync(join(tmpdir(), "lcm-surface-inventory-"));
  const envKeys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR"];
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  let daemon: DaemonInstance | undefined;
  const rows: DiscoveredSurface[] = [];
  try {
    for (const key of envKeys) {
      const path = key === "HOME" || key === "USERPROFILE" ? home : join(home, key.toLowerCase());
      mkdirSync(path, { recursive: true, mode: 0o700 });
      process.env[key] = path;
    }
    const lcmDir = join(home, ".lcm");
    mkdirSync(lcmDir, { mode: 0o700 });
    const configPath = join(lcmDir, "config.json");
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    daemon = await createDaemon(loadDaemonConfig(configPath, { daemon: { port: 0, idleTimeoutMs: 0 } }), {
      publicationConfigPath: configPath,
      _onBuiltInRouteRegistered: (key, admission, publicationMode) => {
        rows.push({ id: `daemon:${key}`, kind: "daemon", source: "src/daemon/server.ts:createDaemon", registration: { key, admission, publicationMode } });
      },
    });
    unique(rows.map((row) => row.id), "daemon registrations");
    return rows;
  } finally {
    try {
      await daemon?.stop();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  }
}

export async function discoverInventory(): Promise<DiscoveredSurface[]> {
  const rows = await discoverCli();
  const customHelp = extractCustomHelpGrammar(sourceText("bin/lcm.ts"), sourceText("src/cli-help.ts"));
  for (const id of ["cli:<root>", "cli:help"]) {
    const row = rows.find((entry) => entry.id === id);
    if (!row) throw new Error(`Missing ${id}`);
    row.registration = { ...row.registration, customHelp };
  }
  rows.push(...extractSensitiveOperations(sourceText("src/sensitive.ts")).map((operation): DiscoveredSurface => ({ id: `cli:sensitive ${operation}`, kind: "cli", source: "src/sensitive.ts:handleSensitive", registration: { dispatcher: "sensitive", operation } })));
  rows.push(...await discoverDaemonRoutes());
  rows.push(...getMcpToolDefinitions().map((tool): DiscoveredSurface => ({ id: `mcp:${tool.name}`, kind: "mcp", source: "src/mcp/server.ts:getMcpToolDefinitions", registration: { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, inputSchemaSha256: registrationFingerprint(tool.inputSchema) } })));
  const imports = extractNativeImportProviders(sourceText("src/import.ts"));
  rows.push(...imports.providers.map((provider): DiscoveredSurface => ({ id: `native-import:${provider}`, kind: "native-import", source: "src/import.ts:importSessions", registration: { provider, format: provider === "all" ? "dispatch" : provider, dispatch: imports.dispatch.filter((branch) => branch.includes(provider)) } })));
  const knowledgeSource = parseSource(sourceText("src/portable-knowledge.ts"));
  exportedFunction(knowledgeSource, "exportKnowledge");
  exportedFunction(knowledgeSource, "importKnowledge");
  rows.push({ id: `knowledge:v${EXPORT_VERSION}`, kind: "knowledge", source: "src/portable-knowledge.ts", registration: { version: EXPORT_VERSION, export: "exportKnowledge", import: "importKnowledge" } });
  rows.push(...PORTABLE_RECORD_DOMAIN_ORDER.map((domain, ordinal): DiscoveredSurface => ({ id: `portable-domain:${domain}`, kind: "portable-domain", source: "src/storage/portable-record.ts:PORTABLE_RECORD_DOMAIN_ORDER", registration: { domain, ordinal, schemaSha256: PORTABLE_RECORD_SCHEMA_SHA256, descriptorSha256: registrationFingerprint(PORTABLE_RECORD_SCHEMA_DESCRIPTOR) } })));
  const portableExports = extractPortableExports(sourceText("src/storage/portable.ts"));
  exactKeys(portableExports.runtime.map((entry) => entry.name), Object.keys(portableRuntime), "portable AST/runtime exports");
  rows.push(...portableExports.runtime.map((entry): DiscoveredSurface => ({ id: `portable-api:${entry.name}`, kind: "portable-api", source: "src/storage/portable.ts", registration: { ...entry, ...(entry.name === "PORTABLE_RECORD_DOMAIN_ORDER" ? { declarations: portableExports.declarations } : {}) } })));
  unique(rows.map((row) => row.id), "complete discovery");
  return rows;
}
