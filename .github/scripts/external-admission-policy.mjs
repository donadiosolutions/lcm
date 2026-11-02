import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const CHECK_IDENTITIES = Object.freeze({
  dco: Object.freeze({ name: "DCO", appId: 1861, appSlug: "dco" }),
  ci: Object.freeze({ name: "ci", appId: 15368, appSlug: "github-actions" }),
});

const WAITING_CHECK_STATES = new Set([
  "missing",
  "pending",
  "queued",
  "in_progress",
  "requested",
  "waiting",
]);

const WAITING_CI_RUN_STATES = new Set([
  "pending",
  "queued",
  "in_progress",
  "requested",
  "waiting",
]);

const MAINTENANCE_BASE = /^maintenance\/[0-9]+\.[0-9]+\.x$/u;
const WORKFLOW_RUN_ACTIONS = new Set(["requested", "in_progress", "completed"]);
const CHECK_RUN_ACTIONS = new Set(["created", "rerequested", "completed"]);
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const CONTROL_CONTEXT = "external-admission-control-authorized";
export const REVOCATION_CONTEXT = "external-admission-control-revoked";
const CONTROL_DOMAIN = "lcm/external-admission/authored-controls/v1";

function requireSha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new TypeError("invalid immutable SHA");
  }
  return value;
}

function requireRepository(repository) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new TypeError("invalid repository");
  }
  return repository;
}

export function parseOperation({ eventSource, action = "", senderId = "", prNumber = "", digest = "" }) {
  if (eventSource === "workflow_run" || eventSource === "check_run") return { operation: "reconcile" };
  if (eventSource !== "repository_dispatch") throw new TypeError("invalid event source");
  if (action === "external-admission-reconcile") return { operation: "reconcile" };
  const operation = {
    "external-admission-control-authorize": "authorize",
    "external-admission-control-revoke": "revoke",
  }[action];
  if (!operation || String(senderId) !== "1458878") throw new TypeError("untrusted operation");
  const number = positiveId(prNumber, "PR number").toString();
  if (operation === "authorize" && !/^[0-9a-f]{64}$/u.test(digest)) {
    throw new TypeError("invalid digest challenge");
  }
  return { operation, prNumber: number, digest };
}

// Full subtrees bind object identities; partial ancestors bind only their kind.
const FULL_CONTROL_ROOTS = [".github", "scripts", ".agents/skills", "test/setup"];
const PARTIAL_ANCESTORS = new Set([".agents", "test", "test/postgresql", "test/surface-parity"]);
function pythonPackageRoots(tree) {
  // Python's -m entrypoint and helper imports search the repository root.
  // A direct package entrypoint protects the whole root package. Nested
  // examples/fixtures alone do not define an entrypoint that shadows CI imports.
  return requireArray(tree?.tree, "tree entries")
    .flatMap((entry) => {
      if (typeof entry?.path !== "string") return [];
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\/(?:__init__|__main__)(?:\.[^/]+)?\.(?:py|pyc|pyo|so)$/u.exec(entry.path);
      return match ? [match[1]] : [];
    });
}

function protectedPath(path, mode, pythonRoots) {
  if (FULL_CONTROL_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))) return true;
  if (pythonRoots.some((root) => path === root || path.startsWith(`${root}/`))) return true;
  if (/^test\/postgresql\/[^/]+\.sh$/u.test(path)
    || path === "test/surface-parity/surface-matrix.json") return true;
  // Unknown root executables/configuration fail closed as the control graph grows.
  return mode !== "040000" && !path.includes("/") && (["100755", "120000", "160000"].includes(mode)
    || /(?:\.(?:[cm]?[jt]s|json|ya?ml|toml|sh|py|pyc|pyo|so|lock|cfg|conf|ini|xml|properties)|rc|config)$/u.test(path)
    || /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-.*|(?:tsconfig|vitest|vite|eslint|codecov)(?:\.|$)|\.gitattributes|\.gitmodules|\.gitignore|\.npmignore|\.pnpmfile.*|\.env(?:\..*)?|\.(?:node-version|python-version|tool-versions)|(?:GNUmakefile|Makefile|Dockerfile|justfile)(?:\..*)?|requirements(?:\.[^/]+)?\.txt)$/u.test(path));
}

export function projectControlTree(tree, expectedSha, pythonRoots = pythonPackageRoots(tree)) {
  requireSha(expectedSha);
  if (!tree || tree.sha !== expectedSha || tree.truncated !== false) {
    throw new TypeError("missing, inconsistent or truncated tree");
  }
  const entries = requireArray(tree.tree, "tree entries");
  const paths = new Map();
  for (const entry of entries) {
    const path = entry?.path;
    if (typeof path !== "string" || !path || /[\\\x00-\x1f\x7f]/u.test(path)
      || path.split("/").some((part) => !part || part === "." || part === "..")
      || paths.has(path)) throw new TypeError("invalid or duplicate tree path");
    requireSha(entry.sha);
    if (!({ "040000": "tree", "100644": "blob", "100755": "blob", "120000": "blob", "160000": "commit" })[entry.mode]
      || ({ "040000": "tree", "100644": "blob", "100755": "blob", "120000": "blob", "160000": "commit" })[entry.mode] !== entry.type) {
      throw new TypeError("invalid tree mode/type");
    }
    paths.set(path, entry);
  }
  for (const path of paths.keys()) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (paths.get(parts.slice(0, index).join("/"))?.type !== "tree") {
        throw new TypeError("invalid tree hierarchy");
      }
    }
  }
  return [...paths.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .flatMap(({ path, mode, type, sha }) => {
      if (PARTIAL_ANCESTORS.has(path) && !pythonRoots.includes(path)) {
        if (type !== "tree" || mode !== "040000") throw new TypeError("unsafe control ancestor");
        return [[path, mode, type, null]];
      }
      if (pythonRoots.includes(path) && (type !== "tree" || mode !== "040000")) {
        throw new TypeError("unsafe Python package ancestor");
      }
      return protectedPath(path, mode, pythonRoots) ? [[path, mode, type, sha]] : [];
    });
}

export function evaluateAuthoredControls({ repository, prNumber, headSha, baseRef, baseSha,
  compare, ancestorCommit, headCommit, ancestorTree, headTree }) {
  requireRepository(repository);
  requireSha(headSha);
  requireSha(baseSha);
  const number = positiveId(prNumber, "PR number").toString();
  if (baseRef !== "main" && !MAINTENANCE_BASE.test(baseRef)) throw new TypeError("unsupported base");
  // The compare API does not normally echo H. Its authenticated immutable
  // B...H request binds H; git/commits/H below must independently echo it.
  if (compare?.base_commit?.sha !== baseSha
    || (compare?.head_commit !== undefined && compare.head_commit?.sha !== headSha)) {
    throw new TypeError("compare identity mismatch");
  }
  const ancestorSha = requireSha(compare?.merge_base_commit?.sha);
  if (ancestorCommit?.sha !== ancestorSha || headCommit?.sha !== headSha) {
    throw new TypeError("commit identity mismatch");
  }
  const ancestorTreeSha = requireSha(ancestorCommit?.tree?.sha);
  const headTreeSha = requireSha(headCommit?.tree?.sha);
  const pythonRoots = [...new Set([...pythonPackageRoots(ancestorTree), ...pythonPackageRoots(headTree)])];
  const before = projectControlTree(ancestorTree, ancestorTreeSha, pythonRoots);
  const after = projectControlTree(headTree, headTreeSha, pythonRoots);
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  const digest = createHash("sha256").update(JSON.stringify([
    CONTROL_DOMAIN, repository, number, headSha, baseRef, ancestorSha, ancestorTreeSha, before, after,
  ])).digest("hex");
  return { changed, digest, ancestorSha, ancestorTreeSha, headTreeSha, before, after };
}

function trustedStatus(status, { repository, headSha, serverUrl }) {
  if (status?.creator?.id !== 41898282 || status?.creator?.login !== "github-actions[bot]") return false;
  const runId = parseActionsRunId(status.target_url, { repository, serverUrl });
  if (!runId || status.target_url !== `${serverUrl}/${repository}/actions/runs/${runId}`) return false;
  // List-status responses do not carry a head_sha field. Their authenticated URL does.
  const apiOrigin = serverUrl === "https://github.com" ? "https://api.github.com" : `${serverUrl}/api/v3`;
  return status.url === `${apiOrigin}/repos/${repository}/statuses/${headSha}`;
}

export function evaluateControlStatuses({ pages, repository, headSha, serverUrl = "https://github.com", digest = "", changed = false }) {
  requireRepository(repository);
  requireSha(headSha);
  if (!Array.isArray(pages) || pages.length === 0) throw new TypeError("missing status pages");
  const statuses = pages.flatMap((page, index) => {
    requireArray(page, "status page");
    if (page.length > 100 || (index < pages.length - 1 && page.length !== 100)
      || (index === pages.length - 1 && page.length === 100)) {
      throw new TypeError("incomplete status pages");
    }
    return page;
  });
  const ids = new Set();
  let previousId;
  for (const status of statuses) {
    if (!status || typeof status.context !== "string" || typeof status.state !== "string") {
      throw new TypeError("malformed status");
    }
    const id = positiveId(status.id, "status ID").toString();
    if (ids.has(id) || (previousId !== undefined && BigInt(id) >= previousId)) {
      throw new TypeError("duplicate or unordered status ID");
    }
    ids.add(id);
    previousId = BigInt(id);
  }
  const relevant = statuses.filter((status) => status.context === CONTROL_CONTEXT || status.context === REVOCATION_CONTEXT);
  for (const status of relevant) {
    const creator = status.creator;
    if (creator === null || typeof creator !== "object" || Array.isArray(creator)
      || typeof creator.id !== "number" || !Number.isSafeInteger(creator.id) || creator.id <= 0
      || typeof creator.login !== "string" || creator.login.length === 0) {
      throw new TypeError("malformed relevant status creator");
    }
  }
  const identity = { repository, headSha, serverUrl };
  const tombstone = relevant.filter((status) => status.context === REVOCATION_CONTEXT
      && trustedStatus(status, identity) && status.state === "failure")
    .sort((a, b) => positiveId(a.id, "status ID") < positiveId(b.id, "status ID") ? -1 : 1)[0];
  if (tombstone) {
    const latestAdmission = statuses.find((status) => status.context === "external-admission");
    return { revoked: true, ready: false, tombstoneId: String(tombstone.id), tombstoneRunUrl: tombstone.target_url,
      admissionFailed: latestAdmission !== undefined && latestAdmission.state === "failure"
        && trustedStatus(latestAdmission, identity),
      admissionRunUrl: latestAdmission?.target_url ?? null };
  }
  // Select before validating: a newer invalid/failure receipt must suppress an old success.
  const latest = relevant.filter((status) => status.context === CONTROL_CONTEXT)
    .sort((a, b) => positiveId(a.id, "status ID") < positiveId(b.id, "status ID") ? -1 : 1).at(-1);
  const authorized = latest !== undefined && trustedStatus(latest, identity)
    && latest.state === "success" && /^[0-9a-f]{64}$/u.test(digest)
    && latest.description === `controls-v1:${digest}`;
  return { revoked: false, ready: !changed || authorized, authorized,
    authorizationId: latest ? String(latest.id) : null,
    authorizationRunUrl: latest?.target_url ?? null };
}

export function validatePullRequestSelector({ pullRequest, prNumber, headSha, repository }) {
  requireSha(headSha);
  requireRepository(repository);
  if (positiveId(pullRequest?.number, "returned PR number") !== positiveId(prNumber, "PR number")
    || pullRequest.head?.sha !== headSha || pullRequest.base?.repo?.full_name !== repository) {
    throw new TypeError("PR selector mismatch");
  }
  return { valid: true };
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

export function evaluatePullRequestEligibility({
  pullRequest,
  headSha,
  repository,
  baseProtected,
}) {
  requireNonEmptyString(headSha, "head SHA");
  requireNonEmptyString(repository, "repository");
  if (pullRequest === null || typeof pullRequest !== "object" || Array.isArray(pullRequest)) {
    return { eligible: false, reason: "ineligible-pr" };
  }
  if (pullRequest.state !== "open" || pullRequest.draft !== false || pullRequest.head?.sha !== headSha) {
    return { eligible: false, reason: "ineligible-pr" };
  }
  if (pullRequest.base?.repo?.full_name !== repository) {
    return { eligible: false, reason: "repository-mismatch" };
  }
  const baseRef = pullRequest.base?.ref;
  if (baseRef !== "main" && !(typeof baseRef === "string" && MAINTENANCE_BASE.test(baseRef))) {
    return { eligible: false, reason: "unsupported-base" };
  }
  if (baseProtected !== true) return { eligible: false, reason: "unprotected-base" };
  return { eligible: true };
}

export function flattenCheckRunPages(pages) {
  return requireArray(pages, "check run pages").flatMap((page, index) => {
    if (page === null || typeof page !== "object" || Array.isArray(page)) {
      throw new TypeError(`check run page ${index} must be an object`);
    }
    return requireArray(page.check_runs, `check run page ${index}.check_runs`);
  });
}

function positiveId(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${label} must be a safe positive integer`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) return BigInt(value);
  throw new TypeError(`${label} must be a positive integer`);
}

function latestAuthenticatedCheck(checkRuns, identity, headSha) {
  const matches = requireArray(checkRuns, "check runs").filter((check) =>
    check !== null
      && typeof check === "object"
      && check.name === identity.name
      && check.head_sha === headSha
      && check.app?.id === identity.appId
      && check.app?.slug === identity.appSlug);
  return matches.map((check) => ({ check, id: positiveId(check.id, "check run ID") }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .at(-1)?.check;
}

function checkState(check) {
  if (check === undefined) return "missing";
  if (check.status !== "completed") {
    return typeof check.status === "string" && check.status.length > 0
      ? check.status
      : "missing";
  }
  return typeof check.conclusion === "string" && check.conclusion.length > 0
    ? check.conclusion
    : "missing";
}

export function parseActionsRunId(detailsUrl, { repository, serverUrl = "https://github.com" }) {
  requireNonEmptyString(repository, "repository");
  requireNonEmptyString(serverUrl, "server URL");
  if (typeof detailsUrl !== "string" || detailsUrl.length === 0) return undefined;

  let details;
  let server;
  try {
    details = new URL(detailsUrl);
    server = new URL(serverUrl);
  } catch {
    return undefined;
  }
  if (details.origin !== server.origin) return undefined;
  const prefix = `/${repository}/actions/runs/`;
  if (!details.pathname.startsWith(prefix)) return undefined;
  const value = details.pathname.slice(prefix.length).split("/", 1)[0];
  return /^[1-9][0-9]*$/u.test(value) ? value : undefined;
}

export function evaluateAdmissionChecks({
  checkRuns,
  headSha,
  repository,
  serverUrl = "https://github.com",
}) {
  requireNonEmptyString(headSha, "head SHA");
  const checks = {
    ci: latestAuthenticatedCheck(checkRuns, CHECK_IDENTITIES.ci, headSha),
    dco: latestAuthenticatedCheck(checkRuns, CHECK_IDENTITIES.dco, headSha),
  };
  const states = Object.fromEntries(
    Object.entries(checks).map(([name, check]) => [name, checkState(check)]),
  );
  const requiredNames = ["ci", "dco"];
  const terminalFailure = requiredNames.find((name) =>
    states[name] !== "success" && !WAITING_CHECK_STATES.has(states[name]));

  let ciRunId;
  let invalidCiRunUrl = false;
  if (states.ci === "success") {
    ciRunId = parseActionsRunId(checks.ci?.details_url, { repository, serverUrl });
    invalidCiRunUrl = ciRunId === undefined;
  }
  const ciCheckRunId = checks.ci === undefined
    ? undefined
    : positiveId(checks.ci.id, "check run ID").toString();
  const dcoCheckRunId = checks.dco === undefined
    ? undefined
    : positiveId(checks.dco.id, "check run ID").toString();

  return {
    states,
    requiredNames,
    ready: terminalFailure === undefined
      && !invalidCiRunUrl
      && requiredNames.every((name) => states[name] === "success"),
    terminalFailure: terminalFailure ?? (invalidCiRunUrl ? "ci-run-url" : undefined),
    ciCheckRunId,
    dcoCheckRunId,
    ciRunId,
  };
}

export function evaluateCiActionsRun(
  run,
  { runId, headSha, repository, workflowPath = CI_WORKFLOW_PATH },
) {
  const trustedProvenance = run !== null
    && typeof run === "object"
    && (() => {
      try {
        return positiveId(run.id, "Actions run ID") === positiveId(runId, "expected run ID");
      } catch {
        return false;
      }
    })()
    && run.event === "pull_request"
    && run.path === workflowPath
    && run.head_sha === headSha
    && run.repository?.full_name === repository;

  if (!trustedProvenance) {
    return { state: "invalid", ready: false, terminalFailure: "ci-run-metadata" };
  }

  const state = run.status === "completed"
    ? (typeof run.conclusion === "string" && run.conclusion.length > 0
      ? run.conclusion
      : "missing")
    : (typeof run.status === "string" && run.status.length > 0 ? run.status : "missing");
  const ready = run.status === "completed" && state === "success";
  return {
    state,
    ready,
    terminalFailure: ready || WAITING_CI_RUN_STATES.has(state) ? undefined : "ci-run",
  };
}

function pendingFreshness() {
  return { ready: false, pending: true, reason: "event-freshness" };
}

function invalidFreshness() {
  return { ready: false, terminalFailure: "event-freshness" };
}

function compareFreshness(eventId, visibleId, equalEventMayReconcile) {
  let event;
  let visible;
  try {
    event = positiveId(eventId, "event ID");
  } catch {
    return invalidFreshness();
  }
  if (visibleId === undefined || visibleId === null || visibleId === "") return pendingFreshness();
  try {
    visible = positiveId(visibleId, "visible evidence ID");
  } catch {
    return invalidFreshness();
  }
  if (event > visible || (event === visible && !equalEventMayReconcile)) {
    return pendingFreshness();
  }
  return { ready: true };
}

export function evaluateEventFreshness({
  eventSource,
  workflowRunAction = "",
  workflowRunId = "",
  workflowRunPath = "",
  checkRunAction = "",
  checkRunId = "",
  ciRunId,
  dcoCheckRunId,
}) {
  if (eventSource === "repository_dispatch") return { ready: true };
  if (eventSource === "workflow_run") {
    if (!WORKFLOW_RUN_ACTIONS.has(workflowRunAction)) return invalidFreshness();
    if (workflowRunPath !== CI_WORKFLOW_PATH) return invalidFreshness();
    return compareFreshness(
      workflowRunId,
      ciRunId,
      workflowRunAction === "completed",
    );
  }
  if (eventSource === "check_run") {
    if (!CHECK_RUN_ACTIONS.has(checkRunAction)) return invalidFreshness();
    return compareFreshness(
      checkRunId,
      dcoCheckRunId,
      checkRunAction === "completed",
    );
  }
  return invalidFreshness();
}

export function runPolicyCommand(command, args, input) {
  requireArray(args, "policy command arguments");
  requireNonEmptyString(input, "policy command input");
  if (command === "evaluate-control-snapshot" && args.length === 0) {
    const values = input.trim().split("\n").map((line) => JSON.parse(line));
    if (values.length !== 6) throw new TypeError("incomplete control snapshot");
    const [identity, compare, ancestorCommit, headCommit, ancestorTree, headTree] = values;
    return JSON.stringify(evaluateAuthoredControls({
      ...identity, compare, ancestorCommit, headCommit, ancestorTree, headTree,
    }));
  }
  const payload = JSON.parse(input);

  if (command === "parse-operation" && args.length === 0) {
    return JSON.stringify(parseOperation(payload));
  }
  if (command === "evaluate-controls" && args.length === 0) {
    return JSON.stringify(evaluateAuthoredControls(payload));
  }
  if (command === "evaluate-control-statuses" && args.length === 0) {
    return JSON.stringify(evaluateControlStatuses(payload));
  }
  if (command === "validate-pr-selector" && args.length === 0) {
    return JSON.stringify(validatePullRequestSelector(payload));
  }

  if (command === "evaluate-checks" && args.length === 3) {
    const [headSha, repository, serverUrl] = args;
    return JSON.stringify(evaluateAdmissionChecks({
      checkRuns: flattenCheckRunPages(payload),
      headSha,
      repository,
      serverUrl,
    }));
  }
  if (command === "evaluate-ci-run" && args.length === 3) {
    const [runId, headSha, repository] = args;
    return JSON.stringify(evaluateCiActionsRun(payload, { runId, headSha, repository }));
  }
  if (command === "evaluate-pr" && args.length === 3) {
    const [headSha, repository, baseProtected] = args;
    return JSON.stringify(evaluatePullRequestEligibility({
      pullRequest: payload,
      headSha,
      repository,
      baseProtected: baseProtected === "true",
    }));
  }
  if (command === "evaluate-freshness" && args.length === 8) {
    const [
      eventSource,
      workflowRunAction,
      workflowRunId,
      workflowRunPath,
      checkRunAction,
      checkRunId,
      ciRunId,
      dcoCheckRunId,
    ] = args;
    return JSON.stringify(evaluateEventFreshness({
      eventSource,
      workflowRunAction,
      workflowRunId,
      workflowRunPath,
      checkRunAction,
      checkRunId,
      ciRunId: ciRunId || undefined,
      dcoCheckRunId: dcoCheckRunId || undefined,
    }));
  }
  throw new TypeError("unknown policy command or invalid arguments");
}

function isMainModule() {
  return typeof process.argv[1] === "string"
    && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const output = runPolicyCommand(command, args, readFileSync(0, "utf8"));
    process.stdout.write(output);
  } catch {
    process.stderr.write("External admission policy rejected its input.\n");
    process.exitCode = 1;
  }
}
