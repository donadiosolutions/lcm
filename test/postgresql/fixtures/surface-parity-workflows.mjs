import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertSemanticEqual as compareSemantic, assertSnapshotUnchanged as compareSnapshot, assertLogicalSnapshotUnchanged as compareLogicalSnapshot } from "../../surface-parity/assertions.mjs";
import { runImportScenario } from "./surface-parity-imports.mjs";
import { runIdentityScenario, expectedIdentityObservations } from "./surface-parity-identity.mjs";
import { runHookScenario, expectedHookObservations, runCompactHook } from "./surface-parity-hooks.mjs";

const PRIVATE = "SURFACEPRIVATE";
const MEMORY = [
  "Amber orchard irrigation architecture decision café 東京 🪴",
  "Indigo telescope calibration protocol naïve résumé 🌌",
];
const CLI_ASSERTIONS = ["arguments", "result", "effects"];
const DAEMON_ASSERTIONS = ["admission", "result", "effects"];
const MCP_ASSERTIONS = ["schema", "result"];
const SURFACE_STATE_PATHS = ["config.json", "map.json", "machine.json", "backend-publication", "projects", "events"];

function assertSemanticEqual(actual, expected, id) {
  try { compareSemantic(actual, expected, id); }
  catch (cause) {
    // Preserve the call-site identity even when canonical validation rejects a
    // value before comparison; never put the rejected payload in IPC output.
    const category = ["invalid-observation", "observation-limit", "invalid-assertion-id"].find(value => cause.message === `surface-parity:${value}`) ?? "mismatch";
    throw new Error(`surface-parity:${id}:${category}`, { cause });
  }
}
const OWNED_ROWS = {
  memory: ["cli:store", "cli:search", "cli:grep", "cli:describe", "cli:expand",
    "daemon:POST /store", "daemon:POST /search", "daemon:POST /grep", "daemon:POST /describe", "daemon:POST /expand",
    "daemon:POST /ingest", "daemon:POST /recent", "daemon:POST /restore", "daemon:POST /prompt-search",
    "mcp:lcm_store", "mcp:lcm_search", "mcp:lcm_grep", "mcp:lcm_describe", "mcp:lcm_expand"],
  compaction: ["cli:compact", "daemon:POST /compact", "daemon:POST /session-complete", "daemon:POST /invocation-control"],
  diagnostics: ["cli:stats", "cli:status", "cli:doctor", "cli:diagnose", "daemon:GET /stats", "daemon:GET /stats/pool",
    "daemon:POST /status", "daemon:GET /health", "daemon:GET /health/observe", "mcp:lcm_stats", "mcp:lcm_doctor"],
};

function executedAssertions(id) {
  check(Object.values(OWNED_ROWS).flat().includes(id), "unknown-executed-row");
  return id.startsWith("cli:") ? CLI_ASSERTIONS : id.startsWith("daemon:") ? DAEMON_ASSERTIONS : MCP_ASSERTIONS;
}

function check(condition, name) {
  assert.equal(Boolean(condition), true, `surface-parity:${name}`);
}

function receipt(context, observations) {
  return context.matrix.map(row => {
    check(Object.hasOwn(observations, row.id), `missing-observation:${row.id}`);
    const executed = executedAssertions(row.id);
    assertSemanticEqual(row.assertions, executed, "executed-assertion-denominator");
    return { id: row.id, assertions: [...executed], verdict: "passed", observation: observations[row.id] };
  });
}

function jsonOutput(result, label) {
  check(result.code === 0, `${label}:exit`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`surface-parity:${label}:json`); }
}

async function cliJson(context, args, options) {
  return jsonOutput(await context.cli(args, options), `cli:${args[0]}`);
}

async function request(context, path, body, status = 200, method = "POST") {
  const result = await context.request(method, path, body);
  const action = path === "/invocation-control" && typeof body?.action === "string" ? `:${body.action}` : "";
  check(result.status === status, `http:${path.replaceAll("/", ".")}${action}:expected-${status}:actual-${result.status}`);
  return result.body;
}

async function mcpJson(context, name, args) {
  const result = await context.mcp(name, args);
  if (result.isError === true) {
    const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    const category = /file changed during validation/u.test(text) ? "file-changed"
      : /mutation is already in progress/u.test(text) ? "busy"
      : /backend publication admission blocked/u.test(text) ? "publication"
      : "error";
    const publisher = context.observePublisher();
    const failure = new Error(`surface-parity:mcp:${name}:${category}:${publisher}`);
    failure.surfaceEvidence = { stderrDigest: createHash("sha256").update(text).digest("hex") };
    throw failure;
  }
  const content = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  try { return JSON.parse(content); }
  catch { throw new Error(`surface-parity:mcp:${name}:json`); }
}

function messages(label, count = 12) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${label} observation ${index}: decided to preserve café 東京 and independent message provenance. ${"Detailed reproducible context. ".repeat(20)}`,
    tokenCount: 256,
  }));
}

async function ingest(context, session, corpus, cwd = context.projectPath) {
  const result = await request(context, "/ingest", { cwd, session_id: session, messages: corpus });
  check(result.ingested === corpus.length, "ingest:exact-count");
  check(result.totalTokens === corpus.reduce((sum, message) => sum + message.tokenCount, 0), "ingest:exact-tokens");
  return result;
}

async function compact(context, session, cwd = context.projectPath) {
  const result = await request(context, "/compact", { cwd, session_id: session, skip_ingest: true });
  check(result.actionTaken === true, "compact:action");
  check(result.tokensBefore > result.tokensAfter && result.tokensAfter >= 0, "compact:reduction");
  check(typeof result.latestSummaryContent === "string" && result.latestSummaryContent.includes("[Mock Summary"), "compact:deterministic-summary");
  return result;
}

function contents(rows) { return rows.map(row => row.content).sort(); }

/** Only the existing mock summarizer's generated digest and UTC minute vary. */
export function normalizeMockSummaryForParity(content) {
  check(typeof content === "string", "mock-summary:string");
  const match = /^\[Mock Summary ([a-f0-9]{1,6})\] \[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC\]$/u.exec(content);
  check(match !== null, "mock-summary:exact-generated-format");
  const timestamp = `${match[2]}T${match[3]}:00.000Z`;
  check(Number.isFinite(Date.parse(timestamp)) && new Date(timestamp).toISOString() === timestamp, "mock-summary:valid-generated-minute");
  return "[Mock Summary <generated-digest>] [<generated-utc-minute> UTC]";
}

async function memory(context) {
  const cwd = context.projectPath;
  const observations = {};
  const stored = await cliJson(context, ["store", MEMORY[0], "--tag", "parity:memory", "--tags", "parity:amber"]);
  check(stored.stored === true && typeof stored.id === "string", "store:identity");
  const storedHttp = await request(context, "/store", { cwd, text: MEMORY[1], tags: ["parity:memory", "parity:indigo"] });
  check(storedHttp.stored === true && storedHttp.id !== stored.id, "store:distinct-identity");
  const scrubbed = await mcpJson(context, "lcm_store", { text: `Quartz kiln ${PRIVATE} guidelines`, tags: ["parity:scrub"] });
  check(scrubbed.stored === true && typeof scrubbed.id === "string", "mcp-store:identity");
  const first = await cliJson(context, ["search", "Amber", "--layer", "promoted", "--tag", "parity:memory", "--tag", "parity:amber", "--limit", "1"]);
  assertSemanticEqual(contents(first.promoted), [MEMORY[0]], "search:exact-membership");
  check(first.episodic.length === 0 && first.promoted[0].id === stored.id, "search:layers-and-identity");
  check(first.promoted[0].tags.includes("parity:amber") && first.promoted[0].tags.includes("parity:memory"), "search:tags");
  const second = await request(context, "/search", { cwd, query: "Indigo", layers: ["promoted"], limit: 1, tags: ["parity:indigo"] });
  assertSemanticEqual(contents(second.promoted), [MEMORY[1]], "http-search:exact-membership");
  const remote = await mcpJson(context, "lcm_search", { query: "Quartz", layers: ["promoted"], tags: ["parity:scrub"], limit: 1 });
  assertSemanticEqual(contents(remote.promoted), ["Quartz kiln [REDACTED] guidelines"], "mcp-search:redaction");
  check(!JSON.stringify(remote).includes(PRIVATE), "mcp-search:no-secret");
  const absent = await request(context, "/search", { cwd, query: "parityabsentlexeme", limit: 2 });
  assertSemanticEqual(absent, { episodic: [], promoted: [] }, "search:empty");
  const unrelated = await request(context, "/search", { cwd: context.secondaryProjectPath, query: "Amber" });
  assertSemanticEqual(unrelated, { episodic: [], promoted: [] }, "search:project-isolation");
  await request(context, "/store", { cwd, text: "", tags: [] }, 400);
  await request(context, "/store", { cwd, text: "invalid tags", tags: [3] }, 400);
  await request(context, "/search", { cwd, query: "Amber", limit: 0 }, 400);
  await request(context, "/search", { cwd, query: "Amber", layers: ["invalid"] }, 400);
  check((await context.cli(["search", "Amber", "--limit", "0"])).code !== 0, "cli-search:invalid-limit");
  check((await context.cli(["store"])).code !== 0, "cli-store:required-text");
  const invalidMcp = await context.mcp("lcm_search", { query: "Amber", limit: 0 });
  check(invalidMcp.isError === true, "mcp-search:invalid-schema");
  check((await context.mcp("lcm_store", {})).isError === true, "mcp-store:required-text");
  observations["cli:store"] = { stored: stored.stored, tags: ["parity:memory", "parity:amber"] };
  observations["daemon:POST /store"] = { stored: storedHttp.stored, content: second.promoted[0].content };
  observations["mcp:lcm_store"] = { stored: scrubbed.stored, content: remote.promoted[0].content };
  observations["cli:search"] = { content: contents(first.promoted), limit: first.promoted.length, isolated: unrelated.promoted.length };
  observations["daemon:POST /search"] = { content: contents(second.promoted), empty: absent };
  observations["mcp:lcm_search"] = { content: contents(remote.promoted), schemaRefused: invalidMcp.isError };

  const corpus = messages("Parityepisodic");
  await ingest(context, "parity-memory-first", corpus);
  await ingest(context, "parity-memory-second", messages("Paritysecond", 2));
  const retry = await request(context, "/ingest", { cwd, session_id: "parity-memory-first", messages: corpus });
  check(retry.ingested === 0, "ingest:deduplicated-retry");
  await request(context, "/ingest", { cwd }, 400);
  observations["daemon:POST /ingest"] = { messages: corpus.length + 2, replay: retry.ingested };
  const canonicalMessages = await context.readProject(context.projectId, async storage => {
    const conversation = await storage.conversations.getConversationBySessionId("parity-memory-first");
    check(conversation !== null, "grep:native-conversation");
    return storage.conversations.getMessages(conversation.conversationId);
  });
  assertSemanticEqual(canonicalMessages.map(({ role, content, tokenCount }) => ({ role, content, tokenCount })), corpus, "grep:native-canonical-transcript");
  const grep = await cliJson(context, ["grep", "Parityepisodic", "--scope", "messages"]);
  check(grep.messages.length === corpus.length && grep.summaries.length === 0 && grep.totalMatches === corpus.length, "grep:exact-membership");
  assertSemanticEqual(grep.messages.map(row => row.messageId).sort((a, b) => a - b), canonicalMessages.map(row => row.messageId).sort((a, b) => a - b), "grep:native-message-membership");
  const nativeById = new Map(canonicalMessages.map(row => [row.messageId, row]));
  check(grep.messages.every((row, index) => index === 0 ||
    nativeById.get(grep.messages[index - 1].messageId).createdAt.getTime() >= nativeById.get(row.messageId).createdAt.getTime()), "grep:chronological-order");
  // PostgreSQL ts_headline uses lcm.normalize_search_text(content); SQLite
  // FTS5 retains source spelling. Canonical Unicode is proved above and by
  // the regex result below, rather than inferred from a full-text excerpt.
  const snippetNeedles = context.backend === "postgresql" ? ["parityepisodic", "cafe"] : ["Parityepisodic", "café"];
  check(grep.messages.every(row => typeof row.snippet === "string" && snippetNeedles.every(needle => row.snippet.includes(needle))), "grep:keyword-snippets");
  const httpFullText = await request(context, "/grep", { cwd, query: "Parityepisodic", mode: "full_text", scope: "messages" });
  assertSemanticEqual(httpFullText, grep, "http-grep:fulltext-transport-equivalence");
  const unicode = await request(context, "/grep", { cwd, query: "café 東京", mode: "regex", scope: "messages", sessionId: "parity-memory-first" });
  assertSemanticEqual(unicode.messages.map(row => row.snippet), Array(corpus.length).fill("café 東京"), "grep:content-unicode");
  const regex = await request(context, "/grep", { cwd, query: "Parityepisodic observation [01]:", mode: "regex", scope: "messages", sessionId: "parity-memory-first" });
  check(regex.totalMatches === 2 && regex.messages.length === 2, "grep:regex-membership");
  const mcpGrep = await mcpJson(context, "lcm_grep", { query: "Paritysecond", mode: "full_text", scope: "messages" });
  check(mcpGrep.totalMatches === 2 && mcpGrep.messages.length === 2 && mcpGrep.summaries.length === 0, "mcp-grep:membership");
  const mcpSnippetNeedles = context.backend === "postgresql" ? ["paritysecond", "cafe"] : ["Paritysecond", "café"];
  check(mcpGrep.messages.every(row => typeof row.snippet === "string" && mcpSnippetNeedles.every(needle => row.snippet.includes(needle))), "mcp-grep:keyword-snippets");
  check((await context.mcp("lcm_grep", {})).isError === true, "mcp-grep:required-query");
  await request(context, "/grep", { cwd, query: "Parityepisodic", since: "yesterday" }, 400);
  check((await context.cli(["grep", "Parityepisodic", "--mode", "unsupported"])).code !== 0, "cli-grep:invalid-mode");
  observations["cli:grep"] = { messages: grep.messages.length, summaries: grep.summaries.length, total: grep.totalMatches, fullTextNeedles: snippetNeedles };
  observations["daemon:POST /grep"] = { matches: regex.totalMatches, scope: "messages", mode: "regex", fullTextNeedles: snippetNeedles };
  observations["mcp:lcm_grep"] = { matches: mcpGrep.totalMatches, scope: "messages", fullTextNeedles: mcpSnippetNeedles };

  await compact(context, "parity-memory-first");
  const recent = await request(context, "/recent", { cwd, limit: 1 });
  check(recent.summaries.length === 1, "recent:limit");
  const summaryId = recent.summaries[0].summary_id;
  check(typeof summaryId === "string" && summaryId.startsWith("sum_"), "recent:summary-identity");
  await request(context, "/recent", { cwd, limit: 0 }, 400);
  const described = await cliJson(context, ["describe", summaryId]);
  const httpDescribed = await request(context, "/describe", { cwd, nodeId: summaryId });
  const mcpDescribed = await mcpJson(context, "lcm_describe", { nodeId: summaryId });
  for (const result of [described, httpDescribed, mcpDescribed]) {
    check(result.node.id === summaryId && result.node.type === "summary", "describe:identity-type");
    check(result.node.summary.content === recent.summaries[0].content, "describe:exact-content");
    check(result.node.summary.tokenCount > 0 && result.node.summary.sourceMessageTokenCount > 0, "describe:token-provenance");
  }
  assertSemanticEqual(httpDescribed, described, "describe:http-content-lineage");
  assertSemanticEqual(mcpDescribed, described, "describe:mcp-content-lineage");
  const durableSummary = await context.readProject(context.projectId, storage => storage.summaries.getSummary(summaryId));
  check(durableSummary !== null && durableSummary.content === described.node.summary.content, "describe:native-content");
  check(durableSummary.tokenCount === described.node.summary.tokenCount && durableSummary.depth === described.node.summary.depth, "describe:native-metadata");
  const stableSummary = normalizeMockSummaryForParity(described.node.summary.content);
  assertSemanticEqual(await request(context, "/describe", { cwd, nodeId: "sum_parity_absent" }), { node: null }, "describe:missing");
  await request(context, "/describe", { cwd }, 400);
  check((await context.cli(["describe"])).code !== 0, "cli-describe:required-node");
  check((await context.mcp("lcm_describe", {})).isError === true, "mcp-describe:required-node");
  const expanded = await cliJson(context, ["expand", summaryId, "--depth", "5"]);
  const httpExpanded = await request(context, "/expand", { cwd, nodeId: summaryId, depth: 5 });
  const mcpExpanded = await mcpJson(context, "lcm_expand", { nodeId: summaryId, depth: 5 });
  for (const result of [expanded, httpExpanded, mcpExpanded]) {
    check(result.expansions.length > 0 && result.expansions[0].summaryId === summaryId, "expand:identity");
    check(result.citedIds.includes(summaryId), "expand:provenance");
    if (described.node.summary.kind === "leaf") {
      // The public CLI/HTTP/MCP contract leaves includeMessages disabled. A
      // leaf therefore retains its citation but does not expose raw messages.
      assertSemanticEqual(result, { expansions: [{ summaryId, children: [], messages: [] }], citedIds: [summaryId], totalTokens: 0, truncated: false }, "expand:leaf-contract");
      check(described.node.summary.messageIds.length > 0, "expand:leaf-source-provenance");
    } else {
      check(result.totalTokens > 0 && result.expansions.some(item => item.children.length > 0), "expand:condensed-source-detail");
    }
  }
  assertSemanticEqual(httpExpanded, expanded, "expand:http-content-lineage");
  assertSemanticEqual(mcpExpanded, expanded, "expand:mcp-content-lineage");
  await request(context, "/expand", { cwd, nodeId: summaryId, depth: 0 }, 400);
  check((await context.cli(["expand", summaryId, "--depth", "0"])).code !== 0, "cli-expand:invalid-depth");
  check((await context.mcp("lcm_expand", { nodeId: summaryId, depth: 0 })).isError === true, "mcp-expand:invalid-depth");
  for (const id of ["cli:describe", "daemon:POST /describe", "mcp:lcm_describe"]) observations[id] = {
    type: described.node.type, content: stableSummary, kind: described.node.summary.kind,
    depth: described.node.summary.depth, tokenCount: described.node.summary.tokenCount, sourceMessageCount: described.node.summary.messageIds.length,
  };
  for (const id of ["cli:expand", "daemon:POST /expand", "mcp:lcm_expand"]) observations[id] = {
    sources: expanded.expansions.map(item => ({ messages: item.messages.map(message => message.snippet), children: item.children.map(child => child.snippet) })),
    totalTokens: expanded.totalTokens, truncated: expanded.truncated,
  };
  observations["daemon:POST /recent"] = { content: stableSummary, count: recent.summaries.length };
  const restorationInstruction = "Parity restoration instruction: preserve the amber irrigation schedule.";
  mkdirSync(join(cwd, ".claude"), { recursive: true, mode: 0o700 });
  writeFileSync(join(cwd, ".claude", "CLAUDE.md"), restorationInstruction + "\n", { mode: 0o600 });
  const restore = await request(context, "/restore", { cwd, session_id: "parity-memory-second", source: "startup", client: "claude" });
  check(typeof restore.context === "string" && restore.context.includes(restorationInstruction), "restore:context");
  const restoredInstructions = await context.readProject(context.projectId, storage => storage.coordination.getSessionInstructions({
    clientName: "claude", sessionId: "parity-memory-second", worktreePath: cwd, cwdPath: cwd,
  }));
  check(restoredInstructions?.content.includes(restorationInstruction), "restore:instructions-persisted");
  await request(context, "/restore", { cwd, session_id: "" }, 400);
  observations["daemon:POST /restore"] = { contextPresent: restore.context.length > 0 };
  const hints = await request(context, "/prompt-search", { cwd, query: "Amber orchard irrigation architecture decision", session_id: "parity-memory-second", logSurfacing: false });
  check(Array.isArray(hints.hints) && hints.hints.length > 0, "prompt-search:hint-membership");
  check(hints.ids.includes(stored.id), "prompt-search:stored-identity");
  assertSemanticEqual(await request(context, "/prompt-search", {}), { hints: [] }, "prompt-search:invalid-contract");
  observations["daemon:POST /prompt-search"] = { hints: hints.hints.length, storedIdentityIncluded: hints.ids.includes(stored.id) };
  // The accepted promoted-memory NUL guard rejects scalar content on both
  // backends. It must never acknowledge a write whose public read is truncated.
  const beforeNul = await context.readProject(context.projectId, storage => storage.promotedMemory.getAll());
  const nul = await context.request("POST", "/store", { cwd, text: "Paritysclalar\u0000suffix", tags: ["parity:nul"] });
  if (context.backend === "postgresql") {
    check(nul.status === 503 && nul.body.backend === "postgresql" && nul.body.code === "STORAGE_OPERATION_FAILED", "nul:postgresql-explicit-refusal");
  } else check(nul.status === 500 && typeof nul.body.error === "string", "nul:sqlite-explicit-refusal");
  const afterNul = await context.readProject(context.projectId, storage => storage.promotedMemory.getAll());
  assert.deepEqual(afterNul, beforeNul, "surface-parity:nul:no-write");
  const nulRead = await request(context, "/search", { cwd, query: "Paritysclalar", layers: ["promoted"] });
  assertSemanticEqual(contents(nulRead.promoted), [], "nul:no-truncated-memory");
  return receipt(context, observations);
}

function compactPreviewFailure(result) {
  // Emit only bounded status and source-defined categories, never captured
  // output, fixture paths, database identities, or provider diagnostics.
  const exit = Number.isInteger(result.code) && result.code >= 0 && result.code <= 255 ? result.code : "abnormal";
  const category = [
    ["project-storage-discovery", "project storage discovery failed"],
    ["project-discovery", "project discovery failed"],
    ["no-eligible-sessions", "Nothing to compact — no sessions are currently eligible."],
    ["preview-emitted", "[dry-run] would compact:"],
  ].find(([, marker]) => result.stderr.includes(marker))?.[0] ?? "unclassified";
  return `exit-${exit}:${category}`;
}

async function compaction(context) {
  const cwd = context.projectPath;
  const corpus = messages("Paritycompaction", 16);
  await ingest(context, "parity-compaction", corpus);
  const first = await compact(context, "parity-compaction");
  const second = await request(context, "/compact", { cwd, session_id: "parity-compaction", skip_ingest: true });
  check(second.actionTaken === false, "compact:second-invocation-idempotent");
  const done = await request(context, "/session-complete", { cwd, session_id: "parity-compaction" });
  check(done.recorded === true, "session-complete:recorded");
  const repeated = await request(context, "/session-complete", { cwd, session_id: "parity-compaction" });
  assertSemanticEqual(repeated, done, "session-complete:idempotent");
  await request(context, "/session-complete", { cwd }, 400);
  await request(context, "/compact", { cwd, session_id: "" }, 400);
  const health = await request(context, "/health/observe", undefined, 200, "GET");
  const target = { invocation_id: randomUUID(), command: "compact", daemon_instance_id: health.daemonInstanceId };
  check(typeof target.daemon_instance_id === "string", "invocation:daemon-identity");
  const started = await request(context, "/invocation-control", { ...target, action: "start" });
  const heartbeat = await request(context, "/invocation-control", { ...target, action: "heartbeat" });
  check(started.invocationId === target.invocation_id && heartbeat.invocationId === target.invocation_id, "invocation:ownership");
  await request(context, "/invocation-control", { ...target, daemon_instance_id: randomUUID(), action: "heartbeat" }, 409);
  await request(context, "/invocation-control", { ...target, action: "unknown" }, 400);
  await request(context, "/invocation-control", { ...target, action: "finish" });
  const finished = await context.request("POST", "/invocation-control", { ...target, action: "heartbeat" });
  check(finished.status === 409, "invocation:finished-refusal");
  await ingest(context, "parity-batch-discovery", messages("Paritybatch", 12), context.secondaryProjectPath);
  const before = await context.snapshot();
  const dry = await context.cli(["compact", "--all", "--dry-run", "--no-promote"]);
  check(dry.code === 0 && /would compact/u.test(dry.stderr), `compact:batch-dry-run-discovery:${compactPreviewFailure(dry)}`);
  const previewBookkeeping = assertLogicalSnapshotUnchanged(await context.snapshot(), before, "compact:dry-run");
  context.recordBookkeeping("compact-preview", previewBookkeeping);
  const batch = await context.cli(["compact", "--all", "--no-promote"]);
  check(batch.code === 0 && /Batch compact complete/u.test(batch.stderr), "compact:batch-complete");
  const batchSummary = await request(context, "/recent", { cwd: context.secondaryProjectPath, limit: 1 });
  check(batchSummary.summaries.length === 1 && batchSummary.summaries[0].content.includes("[Mock Summary"), "compact:remote-only-discovery-effect");
  check((await context.cli(["compact", "--max-concurrency", "0"])).code !== 0, "compact:invalid-concurrency");
  await runCompactHook(context);
  return receipt(context, {
    "cli:compact": { batchSummaries: batchSummary.summaries.length, dryRunDiscovered: true, hookDispatched: true },
    "daemon:POST /compact": { actionTaken: first.actionTaken, reduction: first.tokensBefore - first.tokensAfter, repeatAction: second.actionTaken },
    "daemon:POST /session-complete": { recorded: done.recorded, idempotent: repeated.recorded },
    "daemon:POST /invocation-control": { ownership: true, finishedRefusal: finished.status },
  });
}

function diagnosticShape(snapshot, backend) {
  check(snapshot.backend === backend, "diagnostics:selected-backend");
  check(snapshot.classification === "healthy", "diagnostics:healthy");
  check(snapshot.schema === "ready" && snapshot.search === (backend === "postgresql" ? "ready" : "not-applicable"), "diagnostics:readiness");
  check(snapshot.pool.status === "ready", "diagnostics:pool-ready");
  check(Number.isInteger(snapshot.pool.total) && Number.isInteger(snapshot.pool.idle), "diagnostics:pool-counts");
  if (backend === "postgresql") {
    check(snapshot.tls === "ready" && snapshot.extensions === "ready", "diagnostics:postgresql-tls-extensions");
    check(Number.isInteger(snapshot.pool.configuredMax) && snapshot.pool.configuredMax > 0 && snapshot.pool.waiting === 0 && snapshot.pool.failed === false, "diagnostics:postgresql-pool");
  } else {
    check(snapshot.tls === "not-applicable" && snapshot.extensions === "not-applicable", "diagnostics:sqlite-capabilities");
    check(!Object.hasOwn(snapshot.pool, "configuredMax") && !Object.hasOwn(snapshot.pool, "waiting"), "diagnostics:sqlite-pool");
  }
  return { backend: snapshot.backend, classification: snapshot.classification, schema: snapshot.schema,
    search: snapshot.search, tls: snapshot.tls, extensions: snapshot.extensions, poolStatus: snapshot.pool.status };
}

function coldFilesystemWitness(directory, paths = [""]) {
  const entries = {};
  function read(relative) {
    const path = relative === "" ? directory : join(directory, relative);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined) { entries[relative] = { missing: true }; return; }
    const identity = { inode: stat.ino, dev: stat.dev, mode: stat.mode, uid: stat.uid, gid: stat.gid, nlink: stat.nlink };
    if (stat.isDirectory()) {
      const children = readdirSync(path).sort();
      entries[relative] = { ...identity, kind: "directory", children };
      for (const child of children) read(join(relative, child));
    } else if (stat.isFile()) {
      // Filesystem-only: in particular, never open the source through SQLite.
      const bytes = readFileSync(path);
      entries[relative] = { ...identity, kind: "file", bytes: stat.size, sha256: createHash("sha256").update(bytes).digest("hex"),
        ...(bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) ? { sqliteFile: true } : {}) };
    } else check(false, "diagnostics:cold-unexpected-leaf");
  }
  for (const path of paths) read(path);
  return entries;
}

function identityObservation(context, result) {
  check(result.status === "ok" && result.observation === "identity-only", "observer:identity-only");
  check(result.storageBackend === context.backend, "observer:selected-backend");
  assertSemanticEqual(result.storage, { status: "unverified" }, "observer:unverified-storage");
  check(result.pid === context.daemonPid && result.daemonInstanceId === context.daemonInstanceId, "observer:owned-generation");
  check(typeof result.entrypoint === "string" && result.entrypoint.length > 0
    && typeof result.version === "string" && result.version.length > 0
    && typeof result.runtimeDigest === "string" && result.runtimeDigest.length > 0, "observer:authenticated-identity");
  return { status: result.status, observation: result.observation, storage: result.storage,
    backend: result.storageBackend, authenticatedIdentity: true };
}

async function coldDiagnosticStage(context) {
  const coldPath = join(context.homeDir, "surface-diagnostic-cold");
  const coldId = createHash("sha256").update(coldPath).digest("hex");
  const coldDirectory = join(context.homeDir, ".lcm", "projects", coldId);
  check(lstatSync(coldDirectory, { throwIfNoEntry: false }) === undefined, "diagnostics:cold-fixture-new");
  mkdirSync(coldPath, { recursive: true, mode: 0o700 });
  mkdirSync(coldDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(coldDirectory, "meta.json"), JSON.stringify({ cwd: coldPath }), { mode: 0o600 });
  const databasePath = join(coldDirectory, "db.sqlite");
  if (context.backend === "sqlite") {
    // Real initialization is laboratory setup. Close the exact owned connection
    // before observing cold public diagnostics; no native oracle opens it yet.
    const { getLcmConnection, closeLcmConnection } = await import("../../../dist/src/db/connection.js");
    const { runLcmMigrations } = await import("../../../dist/src/db/migration.js");
    const database = getLcmConnection(databasePath);
    try { runLcmMigrations(database); }
    finally { closeLcmConnection(databasePath, database); }
  }
  const stateRoot = join(context.homeDir, ".lcm");
  const coldRelative = `projects/${coldId}`;
  const before = coldFilesystemWitness(stateRoot, SURFACE_STATE_PATHS);
  assertSemanticEqual(before[coldRelative].children, context.backend === "sqlite" ? ["db.sqlite", "meta.json"] : ["meta.json"], "diagnostics:cold-initial-files");
  const operations = [
    ["http-observe", async () => identityObservation(context, await request(context, "/health/observe", undefined, 200, "GET"))],
    ["http-stats", () => request(context, "/stats", undefined, 200, "GET")],
    ["http-pool", () => request(context, "/stats/pool", undefined, 200, "GET")],
    ["http-status", () => request(context, "/status", { cwd: context.projectPath })],
    ...[["stats", "--json"], ["stats", "--pool", "--json"], ["status", "--json"], ["diagnose", "--all", "--json"]]
      .map(args => [`cli-${args[0]}${args.includes("--pool") ? "-pool" : ""}`, () => cliJson(context, args)]),
    ["cli-doctor", async () => {
      const result = await context.cli(["doctor", "--verbose"]);
      check([0, 1].includes(result.code) && /\d+ passed · \d+ failed/u.test(result.stdout + result.stderr), "diagnostics:cold-doctor-contract");
    }],
    ...["lcm_stats", "lcm_doctor"].map(name => [`mcp-${name}`, async () => {
      const result = await context.mcp(name, {});
      check(result.isError !== true, `diagnostics:cold-${name}-contract`);
    }]),
  ];
  let previous = before;
  const createdCoordination = new Set();
  for (const [label, operation] of operations) {
    await operation();
    const after = coldFilesystemWitness(stateRoot, SURFACE_STATE_PATHS);
    const added = assertSnapshotUnchanged({ entries: after }, { entries: previous }, `diagnostics:cold-${label}`, {
      allowedNewCoordinationBases: context.backend === "sqlite" && label !== "http-observe" ? [`${coldRelative}/db.sqlite`] : [],
    });
    for (const path of added) createdCoordination.add(path.endsWith("-wal") ? "wal" : "shm");
    previous = after;
  }
  return [...createdCoordination].sort();
}

async function diagnostics(context) {
  // Authenticated health is the factory's active readiness probe. It has the
  // logical/authority contract; it is not a read-only statistics collection.
  const beforeHealth = await context.snapshot();
  const health = await request(context, "/health", undefined, 200, "GET");
  check(health.status === "ok" && health.storageBackend === context.backend, "diagnostics:health-selected-backend");
  const healthBookkeeping = assertLogicalSnapshotUnchanged(await context.snapshot(), beforeHealth, "diagnostics:health-readiness");
  context.recordBookkeeping("health-readiness", healthBookkeeping);
  // Fresh declared warm setup for OTHER existing databases precedes creation
  // of the distinct cold target. No stale unlinked SHM reader crosses stages.
  context.resetSnapshotReaders();
  await context.snapshot();

  // These metadata-only and malformed children are part of the observation
  // boundary; a diagnostic may classify them but must not repair or create DBs.
  const projects = join(context.homeDir, ".lcm", "projects");
  const metadataOnly = join(projects, "parity-metadata-only");
  const malformed = join(projects, "parity-malformed-metadata");
  mkdirSync(metadataOnly, { recursive: true, mode: 0o700 });
  mkdirSync(malformed, { recursive: true, mode: 0o700 });
  writeFileSync(join(metadataOnly, "meta.json"), JSON.stringify({ cwd: context.secondaryProjectPath }), { mode: 0o600 });
  writeFileSync(join(malformed, "meta.json"), "{truncated", { mode: 0o600 });
  const coldCoordinationAdded = await coldDiagnosticStage(context);
  // Only after every cold file-only check passed may the retained oracle prime
  // the new database and begin the warm semantic observation stage.
  const before = await context.snapshot();
  const observedIdentity = identityObservation(context, await request(context, "/health/observe", undefined, 200, "GET"));
  assertSnapshotUnchanged(await context.snapshot(), before, "diagnostics:identity-observer");
  const native = before.nativeCounts;
  check(native !== undefined && native.counts.messages > 0 && native.counts.summaries > 0 && native.counts.promotedCount > 0,
    "diagnostics:nonempty-native-corpus");
  const stats = await request(context, "/stats", undefined, 200, "GET");
  const cliStats = await cliJson(context, ["stats", "--json"]);
  for (const field of ["projects", "conversations", "messages", "summaries", "promotedCount"]) {
    check(Number.isInteger(stats[field]) && stats[field] >= 0, `diagnostics:count:${field}`);
    assertSemanticEqual(cliStats[field], stats[field], `diagnostics:count-parity:${field}`);
    assertSemanticEqual(stats[field], native.counts[field], `diagnostics:native-count:${field}`);
  }
  const conversationDetails = context.backend === "postgresql" ? "omitted" : "native-membership-verified";
  for (const [label, result] of [["http", stats], ["cli", cliStats]]) {
    if (context.backend === "postgresql") {
      check(!Object.hasOwn(result, "conversationDetails"), `diagnostics:${label}:conversation-details-absent`);
      const metrics = result.backendDiagnostics.metrics;
      assertSemanticEqual(Object.keys(metrics).sort(), ["projects", "conversations", "compactedConversations", "messages", "summaries", "maxDepth", "rawTokens", "summaryTokens", "ratio", "promotedCount", "redactionCounts", "recallStats"].sort(), "diagnostics:numeric-metrics-fields");
      assertSemanticEqual(Object.keys(metrics.redactionCounts).sort(), ["builtIn", "global", "project", "total"].sort(), "diagnostics:numeric-redaction-fields");
      assertSemanticEqual(Object.keys(metrics.recallStats).sort(), ["memoriesSurfaced", "memoriesActedUpon", "recallPrecision"].sort(), "diagnostics:numeric-recall-fields");
      for (const [key, value] of Object.entries(metrics)) {
        if (key === "redactionCounts" || key === "recallStats") continue;
        check(typeof value === "number" && Number.isFinite(value) && value >= 0, "diagnostics:numeric-metrics-value");
      }
      for (const value of Object.values(metrics.redactionCounts)) check(Number.isSafeInteger(value) && value >= 0, "diagnostics:numeric-redaction-value");
      for (const [key, value] of Object.entries(metrics.recallStats)) check((key === "recallPrecision" && value === null)
        || (typeof value === "number" && Number.isFinite(value) && value >= 0), "diagnostics:numeric-recall-value");
    } else {
      check(Array.isArray(result.conversationDetails), `diagnostics:${label}:conversation-details-array`);
      assertSemanticEqual(result.conversationDetails.map(row => String(row.conversationId)).sort(), native.conversationIds.map(String).sort(), "diagnostics:native-conversation-membership");
      check(result.conversationDetails.length === native.counts.conversations, "diagnostics:native-conversation-count");
    }
  }
  const status = await request(context, "/status", { cwd: context.projectPath });
  const cliStatus = await cliJson(context, ["status", "--json"]);
  assertSemanticEqual(cliStatus.project, status.project, "diagnostics:status-counts");
  assertSemanticEqual(status.project, native.projectCounts[context.remoteProjectId ?? context.projectId], "diagnostics:selected-native-counts");
  check(cliStatus.daemon.status === "up", `diagnostics:daemon-status:${cliStatus.daemon.status}`);
  check(cliStatus.diagnosticSource === "daemon", `diagnostics:status-source:${cliStatus.diagnosticSource}`);
  const pool = await request(context, "/stats/pool", undefined, 200, "GET");
  const cliPool = await cliJson(context, ["stats", "--pool", "--json"]);
  const shape = diagnosticShape(stats.backendDiagnostics, context.backend);
  for (const result of [cliStats, status, cliStatus, pool, cliPool]) {
    assertSemanticEqual(diagnosticShape(result.backendDiagnostics, context.backend), shape, "diagnostics:common-contract");
  }

  await request(context, "/status", {}, 400);
  const doctor = await context.cli(["doctor", "--verbose", "--events-max-dbs", "all"]);
  const doctorText = doctor.stdout + doctor.stderr;
  const totals = doctorText.match(/(\d+) passed · (\d+) failed · (\d+) warnings · (\d+) skipped/u);
  check(totals !== null, "doctor:summary-contract");
  check(doctor.code === (Number(totals[2]) > 0 ? 1 : 0), "doctor:exit-matches-failures");
  check(new RegExp(context.backend, "iu").test(doctorText), "doctor:selected-backend");
  check((await context.cli(["doctor", "--events-max-dbs", "0"])).code !== 0, "doctor:invalid-limit");
  const diagnose = await cliJson(context, ["diagnose", "--all", "--days", "7", "--json"]);
  check(diagnose !== null && typeof diagnose === "object" && Array.isArray(diagnose.sessions), "diagnose:hook-history-json");
  for (const field of ["sessionsScanned", "sessionsWithErrors", "totalErrors", "totalWarnings"]) {
    check(Number.isInteger(diagnose[field]) && diagnose[field] >= 0, `diagnose:history-count:${field}`);
  }
  check(diagnose.sessionsScanned >= diagnose.sessionsWithErrors && diagnose.sessions.length === diagnose.sessionsWithErrors, "diagnose:session-membership");
  check((await context.cli(["diagnose", "--days", "0"])).code !== 0, "diagnose:invalid-days");
  const mcpStats = await context.mcp("lcm_stats", { verbose: true });
  const statsText = mcpStats.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  check(mcpStats.isError !== true && statsText.includes("| Messages |") && new RegExp(context.backend, "iu").test(statsText), "mcp-stats:local-diagnostics");
  const count = stats.messages >= 1_000_000 ? `${(stats.messages / 1_000_000).toFixed(1)}M`
    : stats.messages >= 1_000 ? `${(stats.messages / 1_000).toFixed(1)}k` : String(stats.messages);
  check(statsText.includes(`| Messages | ${count} |`), "mcp-stats:message-count");
  if (context.backend === "postgresql") {
    check(!statsText.includes("## Per Conversation"), "mcp-stats:conversation-details-absent");
  } else {
    const detailTable = statsText.split("## Per Conversation\n")[1]?.split("\n## ")[0];
    check(typeof detailTable === "string", "mcp-stats:conversation-table-present");
    const renderedDetails = [...detailTable.matchAll(/^\| (\d+) \| (\d+) \| (\d+) \|/gmu)]
      .map(match => ({ conversationId: Number(match[1]), messages: Number(match[2]), summaries: Number(match[3]) }));
    assertSemanticEqual(renderedDetails, stats.conversationDetails.filter(row => row.summaries > 0)
      .map(({ conversationId, messages, summaries }) => ({ conversationId, messages, summaries })), "mcp-stats:conversation-table-membership");
  }
  for (const [label, field] of [["Projects", "projects"], ["Conversations", "conversations"], ["Summaries", "summaries"], ["Promoted memories", "promotedCount"]]) {
    const rendered = field === "summaries" && stats[field] >= 1000 ? `${(stats[field] / 1000).toFixed(1)}k` : String(stats[field]);
    check(statsText.includes(`| ${label} | ${rendered} |`), `mcp-stats:native-count:${field}`);
  }
  const mcpDoctor = await context.mcp("lcm_doctor", {});
  const mcpDoctorText = mcpDoctor.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  check(mcpDoctor.isError !== true && /\d+ passed · \d+ failed/u.test(mcpDoctorText), "mcp-doctor:report-contract");
  check(new RegExp(context.backend, "iu").test(mcpDoctorText), "mcp-doctor:selected-backend");
  assertSnapshotUnchanged(await context.snapshot(), before, "diagnostics");
  const observations = {};
  for (const id of ["cli:stats", "cli:status", "daemon:GET /stats", "daemon:GET /stats/pool", "daemon:POST /status"]) observations[id] = { ...shape, countsMatchNative: true };
  for (const id of ["cli:stats", "daemon:GET /stats"]) observations[id].conversationDetails = conversationDetails;
  for (const id of ["cli:status", "daemon:POST /status"]) observations[id].projectCountsMatchNative = true;
  observations["daemon:GET /health"] = { status: health.status, backend: health.storageBackend, readinessLogicalStatePreserved: true };
  observations["daemon:GET /health/observe"] = observedIdentity;
  observations["cli:doctor"] = { backend: context.backend, exitMatchesFailures: true, mutation: false };
  observations["cli:diagnose"] = { jsonHistory: true, mutation: false };
  observations["mcp:lcm_stats"] = { backend: context.backend, countMatches: true, mutation: false, conversationDetails };
  observations["mcp:lcm_doctor"] = { backend: context.backend, reportPresent: true, mutation: false };
  for (const [rowId, observation] of Object.entries(observations)) {
    if (rowId === "daemon:GET /health") continue;
    observation.coldReadOnlyContract = true;
    observation.coldCoordinationAdded = rowId === "daemon:GET /health/observe" ? [] : coldCoordinationAdded;
  }
  return receipt(context, observations);
}

/** Static architecture alternatives, independent of observed worker results. */
export function expectedSurfaceObservations(backend) {
  const shape = { backend, classification: "healthy", schema: "ready", search: backend === "postgresql" ? "ready" : "not-applicable", tls: backend === "postgresql" ? "ready" : "not-applicable",
    extensions: backend === "postgresql" ? "ready" : "not-applicable", poolStatus: "ready", countsMatchNative: true };
  const result = { ...expectedIdentityObservations(backend), ...expectedHookObservations(backend) };
  const fullTextNeedles = backend === "postgresql" ? ["parityepisodic", "cafe"] : ["Parityepisodic", "café"];
  result["cli:grep"] = { messages: 12, summaries: 0, total: 12, fullTextNeedles };
  result["daemon:POST /grep"] = { matches: 2, scope: "messages", mode: "regex", fullTextNeedles };
  result["mcp:lcm_grep"] = { matches: 2, scope: "messages", fullTextNeedles: backend === "postgresql" ? ["paritysecond", "cafe"] : ["Paritysecond", "café"] };
  for (const id of ["cli:stats", "cli:status", "daemon:GET /stats", "daemon:GET /stats/pool", "daemon:POST /status"]) result[id] = { ...shape };
  const conversationDetails = backend === "postgresql" ? "omitted" : "native-membership-verified";
  for (const id of ["cli:stats", "daemon:GET /stats"]) result[id].conversationDetails = conversationDetails;
  for (const id of ["cli:status", "daemon:POST /status"]) result[id].projectCountsMatchNative = true;
  result["daemon:GET /health"] = { status: "ok", backend, readinessLogicalStatePreserved: true };
  result["daemon:GET /health/observe"] = { status: "ok", observation: "identity-only", storage: { status: "unverified" }, backend, authenticatedIdentity: true };
  result["cli:doctor"] = { backend, exitMatchesFailures: true, mutation: false };
  result["cli:diagnose"] = { jsonHistory: true, mutation: false };
  result["mcp:lcm_stats"] = { backend, countMatches: true, mutation: false, conversationDetails };
  result["mcp:lcm_doctor"] = { backend, reportPresent: true, mutation: false };
  for (const id of OWNED_ROWS.diagnostics) {
    if (id === "daemon:GET /health") continue;
    result[id].coldReadOnlyContract = true;
    result[id].coldCoordinationAdded = backend === "sqlite" && id !== "daemon:GET /health/observe" ? ["shm", "wal"] : [];
  }
  return result;
}

function stableSqliteValue(value) {
  if (typeof value === "bigint") return { integer: String(value) };
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("hex") };
  return value;
}

/** Retain only test-owned, existing read-only DB handles until worker teardown. */
export function createSurfaceSnapshotReaders() {
  const readers = new Map();
  let closed = false;
  return {
    open(path) {
      check(!closed, "snapshot-readers:closed");
      const stat = lstatSync(path, { throwIfNoEntry: false });
      check(stat?.isFile(), "snapshot-readers:existing-regular-file");
      const existing = readers.get(path);
      if (existing !== undefined) {
        check(existing.dev === stat.dev && existing.ino === stat.ino, "snapshot-readers:replaced-file");
        return existing.db;
      }
      check(readers.size < 128, "snapshot-readers:handle-bound");
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        // Opening alone is lazy: force SQLite to initialize its WAL read index
        // during the declared warm setup, before filesystem witnesses exist.
        db.prepare("SELECT count(*) FROM sqlite_schema").get();
        readers.set(path, { db, dev: stat.dev, ino: stat.ino });
        return db;
      } catch (error) { db.close(); throw error; }
    },
    close() {
      if (closed) return;
      closed = true;
      const failures = [];
      for (const { db } of [...readers.values()].reverse()) {
        try { db.close(); } catch (error) { failures.push(error); }
      }
      readers.clear();
      check(failures.length === 0, "snapshot-readers:cleanup");
    },
  };
}

export function assertSnapshotUnchanged(actual, expected, id = "snapshot", options = {}) {
  return compareSnapshot(actual, expected, id, { ...options, owner: process.getuid?.() });
}

export function assertLogicalSnapshotUnchanged(actual, expected, id = "snapshot", options = {}) {
  return compareLogicalSnapshot(actual, expected, id, { ...options, owner: process.getuid?.() });
}

function sqliteSnapshot(db) {
  // Native SELECT-only readback includes all executable schema and every table,
  // including FTS shadow tables and sidecar delivery/diagnostic records.
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
    const tables = {};
    const conversationIds = [];
    for (const row of schema.filter(row => row.type === "table")) {
      const quoted = `"${row.name.replaceAll('"', '""')}"`;
      const statement = db.prepare(`SELECT * FROM ${quoted}`);
      statement.setReadBigInts(true);
      const records = statement.all();
      if (row.name === "conversations") {
        for (const record of records) {
          check(typeof record.conversation_id === "bigint" && record.conversation_id >= 0n, "snapshot:sqlite-conversation-integer");
          conversationIds.push(record.conversation_id.toString());
        }
      }
      tables[row.name] = records.map(record => JSON.stringify(record, (_key, value) => stableSqliteValue(value))).sort();
    }
    const tableDigests = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, {
      rows: rows.length, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    }]));
    const counts = ["conversations", "messages", "summaries", "promoted"].every(name => Array.isArray(tables[name]))
      ? { conversations: tables.conversations.length, messages: tables.messages.length, summaries: tables.summaries.length,
          promotedCount: tables.promoted.length, conversationIds }
      : null;
    return { schemaSha256: createHash("sha256").update(JSON.stringify(schema)).digest("hex"), tables: tableDigests, counts,
      userVersion: db.prepare("PRAGMA user_version").get().user_version,
      journalMode: db.prepare("PRAGMA journal_mode").get().journal_mode };
}

function sqliteHeader(path) {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(16);
    return readSync(fd, header, 0, 16, 0) === 16 && header.equals(Buffer.from("SQLite format 3\0"));
  } finally { closeSync(fd); }
}

/** Read-only native data and protected filesystem witness for a single home. */
export async function snapshotSurfaceState(context) {
  const root = join(context.homeDir, ".lcm");
  const entries = {};
  check(typeof context.snapshotReaders?.open === "function", "snapshot:owned-readers-required");
  const roots = SURFACE_STATE_PATHS;
  let visited = 0;
  function prime(relative, depth = 0) {
    check(++visited <= 4096 && depth <= 24, "snapshot:filesystem-bound");
    const path = join(root, relative);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      for (const child of readdirSync(path).sort()) prime(join(relative, child), depth + 1);
    } else if (stat?.isFile() && !relative.endsWith("-wal") && !relative.endsWith("-shm") && sqliteHeader(path)) {
      context.snapshotReaders.open(path);
    }
  }
  // This is explicitly a warm semantic oracle. The diagnostic scenario runs
  // its independent cold filesystem-only stage before reaching this prepass.
  for (const relative of roots) prime(relative);
  function visit(relative) {
    const path = join(root, relative);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined) { entries[relative] = { missing: true }; return; }
    const witness = { mode: stat.mode, uid: stat.uid, gid: stat.gid, inode: stat.ino, dev: stat.dev, nlink: stat.nlink };
    if (stat.isSymbolicLink()) { entries[relative] = { ...witness, symlink: readlinkSync(path) }; return; }
    if (stat.isDirectory()) {
      const children = readdirSync(path).sort();
      entries[relative] = { ...witness, kind: "directory", children };
      for (const child of children) visit(join(relative, child));
      return;
    }
    if (!stat.isFile()) { entries[relative] = { ...witness, special: true }; return; }
    const bytes = readFileSync(path);
    const file = { ...witness, kind: "file", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
    if (bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) {
      entries[relative] = { ...file, sqliteFile: true, database: sqliteSnapshot(context.snapshotReaders.open(path)) };
    } else entries[relative] = file;
  }
  for (const relative of roots) visit(relative);
  if (context.backend === "postgresql") {
    check(typeof context.snapshotPostgreSql === "function", "snapshot:postgresql-native-oracle");
    const postgresql = await context.snapshotPostgreSql();
    return { entries, postgresql, nativeCounts: {
      counts: postgresql.counts, projectCounts: postgresql.projectCounts, conversationIds: postgresql.conversationIds,
    } };
  }
  const counts = { projects: 0, conversations: 0, messages: 0, summaries: 0, promotedCount: 0 };
  const projectCounts = {};
  const conversationIds = [];
  for (const [path, entry] of Object.entries(entries)) {
    if (!/^projects\/[^/]+\/db\.sqlite$/u.test(path) || entry.database === undefined) continue;
    const native = entry.database.counts;
    check(native !== null, "snapshot:sqlite-native-tables");
    counts.projects++;
    counts.conversations += native.conversations;
    counts.messages += native.messages;
    counts.summaries += native.summaries;
    counts.promotedCount += native.promotedCount;
    projectCounts[path.split("/")[1]] = { messageCount: native.messages, summaryCount: native.summaries, promotedCount: native.promotedCount };
    conversationIds.push(...native.conversationIds);
  }
  return { entries, nativeCounts: { counts, projectCounts, conversationIds } };
}

/** Execute one complete manifest-owned scenario against one fixed backend. */
export async function runSurfaceScenario(scenario, context) {
  const owned = { ...context, matrix: context.matrix.filter(row => row.scenario === scenario) };
  check(owned.matrix.length > 0, `scenario:${scenario}:inventory`);
  if (Object.hasOwn(OWNED_ROWS, scenario)) {
    assertSemanticEqual(owned.matrix.map(row => row.id).sort(), [...OWNED_ROWS[scenario]].sort(), "scenario-row-denominator");
    for (const row of owned.matrix) {
      assertSemanticEqual(row.assertions, executedAssertions(row.id), "scenario-assertion-denominator");
    }
    for (const row of owned.matrix) {
      if (row.id.startsWith("daemon:")) {
        const [method, path] = row.id.slice("daemon:".length).split(" ");
        const response = await owned.request(method, path, method === "POST" ? {} : undefined, { auth: false });
        if (path === "/health") {
          check(response.status === 200 && response.body.status === "ok" && response.body.storageBackend === context.backend, "health:public-admission");
          check(!Object.hasOwn(response.body, "runtimeDigest") && !Object.hasOwn(response.body, "entrypoint"), "health:public-no-private-runtime");
        } else {
          check(response.status === 401, `admission:${path}:unauthenticated`);
          assertSemanticEqual(response.body, { error: "unauthorized" }, "admission:public-refusal");
        }
      } else if (row.id.startsWith("cli:")) {
        const invalid = await owned.cli([row.id.slice(4), "--surface-parity-invalid-option"]);
        check(invalid.code !== 0 && /unknown option/u.test(invalid.stderr), "cli:argument-admission");
      }
    }
  }
  if (scenario === "memory") return memory(owned);
  if (scenario === "compaction") return compaction(owned);
  if (scenario === "diagnostics") return diagnostics(owned);
  if (["native-import", "knowledge"].includes(scenario)) return runImportScenario(scenario, owned);
  if (["identity", "admin", "events", "sensitive"].includes(scenario)) return runIdentityScenario(scenario, owned);
  if (["hooks", "promotion"].includes(scenario)) return runHookScenario(scenario, owned);
  throw new Error(`surface-parity:unknown-scenario:${scenario}`);
}
