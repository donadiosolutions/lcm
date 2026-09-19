import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CHECK_IDENTITIES = Object.freeze({
  dco: Object.freeze({ name: "DCO", appId: 1861, appSlug: "dco" }),
  ci: Object.freeze({ name: "ci", appId: 15368, appSlug: "github-actions" }),
  review: Object.freeze({
    name: "copilot-pull-request-reviewer",
    appId: 15368,
    appSlug: "github-actions",
  }),
});

export const ADMISSION_CLASSIFICATIONS = Object.freeze({
  sensitive: "sensitive",
  nonSensitive: "non-sensitive",
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
const REVIEW_WORKFLOW_PATH = "dynamic/agents/copilot-pull-request-reviewer";
const PULL_REQUEST_FILE_STATUSES = new Set([
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
]);
const SENSITIVE_PATHS = [
  /^\.github\/(?:actions|codeql|scripts|workflows)\//u,
  /^(?:bin|installer|scripts|src)\//u,
  /^test\/setup\//u,
  /^test\/postgresql\/(?:template-init\.sh|cached-run-init\.sh|init\.sh)$/u,
  /^test\/postgresql\/(?:harness|operational-fixture|portable-fixture)\.ts$/u,
  /^\.agents\/skills\/tests\//u,
  /^\.agents\/skills\/[^/]+\/scripts\//u,
  /^(?:package\.json|pnpm-lock\.yaml|\.npmrc|pnpm-workspace\.yaml|codecov\.yml|install\.sh|\.pnpmfile\.cjs)$/u,
  /^vitest[^/]*\.config\.[^/]+$/u,
  /^tsconfig[^/]*\.json$/u,
];

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

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireSafePositiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a safe positive integer no greater than ${maximum}`);
  }
  return value;
}

export function flattenPullRequestFilePages(pages) {
  return requireArray(pages, "pull request file pages").flatMap((page, index) =>
    requireArray(page, `pull request file page ${index}`));
}

function isSensitivePath(path) {
  return SENSITIVE_PATHS.some((pattern) => pattern.test(path));
}

export function classifyPullRequestFiles(files, changedFileCount) {
  const records = requireArray(files, "pull request files");
  const expectedCount = requireSafePositiveInteger(
    changedFileCount,
    "pull request changed_files",
    3000,
  );
  if (records.length !== expectedCount) {
    throw new TypeError("pull request file audit count does not match changed_files");
  }

  const destinationNames = new Set();
  const auditedPaths = [];
  for (const [index, value] of records.entries()) {
    const file = requireObject(value, `pull request file ${index}`);
    const filename = requireNonEmptyString(file.filename, `pull request file ${index}.filename`);
    const status = requireNonEmptyString(file.status, `pull request file ${index}.status`);
    if (!PULL_REQUEST_FILE_STATUSES.has(status)) {
      throw new TypeError(`pull request file ${index}.status is unsupported`);
    }
    if (destinationNames.has(filename)) {
      throw new TypeError(`pull request file ${index} has a duplicate destination filename`);
    }
    destinationNames.add(filename);
    auditedPaths.push(filename);

    const hasPreviousName = file.previous_filename !== undefined
      && file.previous_filename !== null;
    const statusRequiresPreviousName = status === "renamed" || status === "copied";
    if (statusRequiresPreviousName !== hasPreviousName) {
      throw new TypeError(`pull request file ${index} has incompatible status and previous_filename`);
    }
    if (hasPreviousName) {
      auditedPaths.push(requireNonEmptyString(
        file.previous_filename,
        `pull request file ${index}.previous_filename`,
      ));
    }
  }

  const matchedPaths = [...new Set(auditedPaths.filter(isSensitivePath))];
  const sensitive = matchedPaths.length > 0;
  return {
    classification: sensitive
      ? ADMISSION_CLASSIFICATIONS.sensitive
      : ADMISSION_CLASSIFICATIONS.nonSensitive,
    sensitive,
    auditedPaths,
    matchedPaths,
  };
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

export function evaluateReviewCheck({
  checkRuns,
  headSha,
  repository,
  serverUrl = "https://github.com",
}) {
  requireNonEmptyString(headSha, "head SHA");
  const review = latestAuthenticatedCheck(checkRuns, CHECK_IDENTITIES.review, headSha);
  const state = checkState(review);
  const pending = WAITING_CHECK_STATES.has(state);
  if (state !== "success") {
    return {
      state,
      ready: false,
      pending,
      terminalFailure: pending ? undefined : "review-run",
      checkRunId: review === undefined
        ? undefined
        : positiveId(review.id, "review check run ID").toString(),
      runId: undefined,
    };
  }
  const checkRunId = positiveId(review.id, "review check run ID").toString();
  const runId = parseActionsRunId(review.details_url, { repository, serverUrl });
  return {
    state,
    ready: runId !== undefined,
    pending: false,
    terminalFailure: runId === undefined ? "review-run-url" : undefined,
    checkRunId,
    runId,
  };
}

export function evaluateCiActionsRun(
  run,
  { runId, headSha, repository, workflowPath = ".github/workflows/ci.yml" },
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

export function evaluateReviewActionsRun(run, { runId, headSha, repository }) {
  const trustedProvenance = run !== null
    && typeof run === "object"
    && !Array.isArray(run)
    && (() => {
      try {
        return positiveId(run.id, "Actions run ID") === positiveId(runId, "expected run ID");
      } catch {
        return false;
      }
    })()
    && run.event === "dynamic"
    && run.path === REVIEW_WORKFLOW_PATH
    && run.head_sha === headSha
    && run.repository?.full_name === repository;
  if (!trustedProvenance) {
    return { state: "invalid", ready: false, terminalFailure: "review-run-metadata" };
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
    terminalFailure: ready || WAITING_CI_RUN_STATES.has(state) ? undefined : "review-run",
  };
}

export function evaluateSensitiveAdmission({ sensitive, review }) {
  if (sensitive !== true) return { ready: true, evidenceClass: "ci-dco", evidenceIds: [] };
  if (review?.ready === true) {
    return {
      ready: true,
      evidenceClass: "copilot",
      evidenceIds: [
        requireNonEmptyString(review.checkRunId, "review check run ID"),
        requireNonEmptyString(review.runId, "review run ID"),
      ],
    };
  }
  if (review?.pending === true) {
    return { ready: false, pending: true, terminalFailure: undefined };
  }
  return { ready: false, pending: false, terminalFailure: "trusted-automation" };
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
  checkRunAction = "",
  checkRunId = "",
  ciRunId,
  dcoCheckRunId,
}) {
  if (eventSource === "repository_dispatch") return { ready: true };
  if (eventSource === "workflow_run") {
    if (!WORKFLOW_RUN_ACTIONS.has(workflowRunAction)) return invalidFreshness();
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
  const payload = JSON.parse(input);

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
  if (command === "classify-files" && args.length === 1) {
    return JSON.stringify(classifyPullRequestFiles(
      flattenPullRequestFilePages(payload),
      Number(args[0]),
    ));
  }
  if (command === "evaluate-review-check" && args.length === 3) {
    const [headSha, repository, serverUrl] = args;
    return JSON.stringify(evaluateReviewCheck({
      checkRuns: flattenCheckRunPages(payload),
      headSha,
      repository,
      serverUrl,
    }));
  }
  if (command === "evaluate-review-run" && args.length === 3) {
    const [runId, headSha, repository] = args;
    return JSON.stringify(evaluateReviewActionsRun(payload, { runId, headSha, repository }));
  }
  if (command === "evaluate-sensitive-admission" && args.length === 0) {
    return JSON.stringify(evaluateSensitiveAdmission(payload));
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
  if (command === "evaluate-freshness" && args.length === 7) {
    const [eventSource, workflowRunAction, workflowRunId, checkRunAction, checkRunId, ciRunId, dcoCheckRunId] = args;
    return JSON.stringify(evaluateEventFreshness({
      eventSource,
      workflowRunAction,
      workflowRunId,
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
